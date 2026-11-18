import sharp from 'sharp';
import { rmSync } from 'node:fs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { PGlite } from '@electric-sql/pglite';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import express from 'express';
import jwt from 'jsonwebtoken';
import { Server } from 'socket.io';
import { io as clientIO } from 'socket.io-client';

process.env.JWT_SECRET = 'test-only-secret';
process.env.UPLOADS_PATH = '.cache/test-uploads';
rmSync(process.env.UPLOADS_PATH, { recursive: true, force: true });
process.env.PUBLIC_MEDIA_BASE_URL = 'https://media.example.com/uploads';
mkdirSync('.cache', { recursive: true });
writeFileSync('.cache/schema.prisma', readFileSync('prisma/schema.prisma', 'utf8').replace('provider = "prisma-client-js"', 'provider = "prisma-client-js"\n engineType = "client"\n output = "./test-client"'));
execFileSync('node_modules/.bin/prisma', ['generate', '--schema', '.cache/schema.prisma'], {
  env: { ...process.env, PRISMA_SCHEMA_ENGINE_BINARY: '/bin/true', PRISMA_QUERY_ENGINE_LIBRARY: '/bin/true' },
});
const { PrismaClient } = await import('../.cache/test-client/index.js');
const db = new PGlite();
for (const dir of readdirSync('prisma/migrations').filter(d => !d.endsWith('.toml')).sort()) {
  await db.exec(readFileSync(`prisma/migrations/${dir}/migration.sql`, 'utf8'));
}
// Adapt only the driver transport: actual Prisma queries/transactions run in PostgreSQL WASM.
let driverQueries=0;
const query = async (q, values) => {
  driverQueries++;
  const sql = typeof q === 'string' ? q : q.text;
  const r = await db.query(sql, values ?? q.values ?? [], { parsers: {
    1114: v => v, 1184: v => v, 1082: v => v, 114: v => v, 3802: v => v,
  } });
  return { ...r, rowCount: r.affectedRows, rows: r.rows.map(row => r.fields.map(f => row[f.name])) };
};
const pool = new pg.Pool();
pool.query = query;
pool.connect = async () => Object.assign(new EventEmitter(), { query, release() {} });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
const events = [];
let kafkaFails = false;
const kafkaEvents = Object.fromEntries(['socialInteraction','messageRead','messageDelivered','chatMessage','notification','notificationUpdated','notificationState','messageDeleted','messageDeletedForMe','conversationDeleted','messageEdited','conversationMembership','stickerPackChanged'].map(name => [name, async payload => {
  if (kafkaFails) throw Error('Kafka unavailable');
  events.push({ name, payload });
}]));
const deliveryValues = new Map();
let deliveryRedisFails = false;
function liveRedisValue(key) {
  const value=deliveryValues.get(key);
  if(value && value.expires>Date.now())return value;
  deliveryValues.delete(key);return null;
}
function storeRedisValue(key,value,ttlMs) { deliveryValues.set(key,{value,expires:Date.now()+ttlMs}); }
const deliveryRedis = {
  async get(key) { if(deliveryRedisFails) throw Error('Redis unavailable'); return liveRedisValue(key)?.value ?? null; },
  async set(key,value,ex,ttl,nx) {
    if(deliveryRedisFails) throw Error('Redis unavailable');
    if(nx==='NX' && liveRedisValue(key)) return null;
    storeRedisValue(key,value,ex==='PX'?Number(ttl):Number(ttl)*1000);return 'OK';
  },
  async eval(script,n,...args) {
    if(deliveryRedisFails) throw Error('Redis unavailable');
    if(n===4 && script.includes('ip_cooldown')) {
      const [ipKey,userKey,ipCooldownKey,userCooldownKey,ipMax,userMax,windowMs,cooldownMs]=args;
      const ttl=key=>{const value=liveRedisValue(key);return value?Math.max(1,value.expires-Date.now()):-2;};
      const ipCooldown=ttl(ipCooldownKey),userCooldown=ttl(userCooldownKey);
      if(ipCooldown>0||userCooldown>0)return [1,Math.max(ipCooldown,userCooldown),0,0];
      const increment=(key)=>{const value=liveRedisValue(key);const count=Number(value?.value??0)+1;storeRedisValue(key,String(count),value?value.expires-Date.now():Number(windowMs));return count;};
      const ipCount=increment(ipKey);let userCount=0;
      if(Number(userMax)>0)userCount=increment(userKey);
      let retry=0;
      if(ipCount>Number(ipMax)){if(!liveRedisValue(ipCooldownKey))storeRedisValue(ipCooldownKey,'1',Number(cooldownMs));retry=Math.max(retry,ttl(ipCooldownKey));}
      if(Number(userMax)>0&&userCount>Number(userMax)){if(!liveRedisValue(userCooldownKey))storeRedisValue(userCooldownKey,'1',Number(cooldownMs));retry=Math.max(retry,ttl(userCooldownKey));}
      return retry>0?[1,retry,ipCount,userCount]:[0,Math.max(ttl(ipKey),Number(userMax)>0?ttl(userKey):-2),ipCount,userCount];
    }
    if(n===1&&script.includes("ARGV[2] == ''")) {
      const [key,claim,replacement,ttlMs]=args;
      if(liveRedisValue(key)?.value!==claim)return 0;
      if(replacement===''){deliveryValues.delete(key);return 1;}
      storeRedisValue(key,replacement,Number(ttlMs));return 'OK';
    }
    const [key,value]=args;
    if(await this.get(key)===value)return deliveryValues.delete(key)?1:0;
    return 0;
  },
};
globalThis.__receiptTest = { prisma, kafkaEvents, deliveryRedis };
await build({ entryPoints: ['src/services/explore.service.ts', 'src/services/social-interaction.service.ts', 'src/services/push-device.service.ts', 'src/services/push-delivery.service.ts', 'src/services/expo-push.provider.ts', 'src/services/delivery-state.service.ts', 'src/services/google-auth.service.ts', 'src/services/community.service.ts', 'src/services/sticker.service.ts', 'src/routes/push.routes.ts', 'src/routes/community.routes.ts', 'src/routes/sticker.routes.ts', 'src/socket/push.handler.ts', 'src/config/push.ts', 'src/socket/authenticate.ts', 'src/config/media.ts', 'src/services/post.service.ts', 'src/services/user.service.ts', 'src/services/activity.service.ts', 'src/services/media.service.ts', 'src/routes/media.routes.ts', 'src/routes/post.routes.ts', 'src/routes/activity.routes.ts', 'src/routes/user.routes.ts', 'src/middlewares/abuse-protection.ts', 'src/middlewares/media-access.ts', 'src/middlewares/upload.ts', 'src/services/message.service.ts', 'src/services/receipt-outbox.service.ts', 'src/socket/chat.handler.ts', 'src/kafka/consumer.ts', 'src/routes/message.routes.ts', 'src/routes/channel-compat.routes.ts'],
  bundle: true, platform: 'node', format: 'esm', outdir: '.cache/bundles', packages: 'external',
  plugins: [{ name: 'boundaries', setup(b) {
    b.onResolve({ filter: /config\/redis\.js$/ }, () => ({ path: 'redis', namespace: 'test' }));
    b.onResolve({ filter: /config\/database\.js$/ }, () => ({ path: 'db', namespace: 'test' }));
    b.onResolve({ filter: /kafka\/producer\.js$|^\.\/producer\.js$/ }, () => ({ path: 'kafka', namespace: 'test' }));
    b.onResolve({ filter: /config\/logger\.js$/ }, () => ({ path: 'logger', namespace: 'test' }));
    b.onLoad({ filter: /.*/, namespace: 'test' }, ({path}) => ({ contents: path === 'redis' ? 'export const redisClient={set:async()=>null}; export const deliveryRedis=globalThis.__receiptTest.deliveryRedis;' : path === 'db' ? 'export const prisma=globalThis.__receiptTest.prisma;' : path === 'kafka' ? 'export const kafkaEvents=globalThis.__receiptTest.kafkaEvents;' : 'export const logger={info(){},debug(){},error(){},warn(){}};' }));
  } }],
});
const { messageService: service } = await import('../.cache/bundles/services/message.service.js');
const { publishReceipts, startReceiptPublisher } = await import('../.cache/bundles/services/receipt-outbox.service.js');
const { registerChatHandlers } = await import('../.cache/bundles/socket/chat.handler.js');
const { handleMessageRead, routeEvent } = await import('../.cache/bundles/kafka/consumer.js');
const { default: router } = await import('../.cache/bundles/routes/message.routes.js');
const ids = Array.from({length:4}, () => randomUUID());
for (const id of ids) await prisma.user.create({ data: { id, username: id, email: `${id}@test.dev`, passwordHash: 'unused' } });
const [sender, reader, third, stranger] = ids;
async function conversation(isGroup = false) {
  return prisma.conversation.create({ data: { isGroup, kind: isGroup ? 'GROUP' : 'DIRECT', participants: { create: (isGroup ? ids.slice(0,3) : ids.slice(0,2)).map(userId => ({userId})) } } });
}
const dm = await conversation();
const group = await conversation(true);
async function send(c = dm) { return service.sendMessage(c.id, sender, 'hello', reader); }
const message = await send();

test('history is read-only, stable at tied timestamps, rejects foreign cursor', async () => {
  const other = await send(group);
  const tied = await send();
  await prisma.message.update({where:{id:tied.id},data:{createdAt:message.createdAt}});
  events.length = 0;
  const history = await service.getMessages(dm.id, reader, 1, 1);
  const next = await service.getMessages(dm.id, reader, 1, 1, history.nextCursor);
  assert.notEqual(history.messages[0].id, next.messages[0].id);
  assert.equal(events.length, 0);
  assert.equal((await prisma.conversationParticipant.findUnique({where:{conversationId_userId:{conversationId:dm.id,userId:reader}}})).lastReadAt, null);
  assert.equal((await prisma.message.findUnique({where:{id:message.id}})).isRead,false);
  await assert.rejects(service.getMessages(dm.id, reader, 1, 20, other.id));
});
test('explicit reads commit; duplicate keeps timestamp and republishes confirmation', async () => {
  const first = await service.markMessageRead(dm.id, reader, message.id);
  const second = await service.markMessageRead(dm.id, reader, message.id);
  assert.equal(first.readAt, second.readAt);
  assert.equal(events.filter(e => e.name==='messageRead' && e.payload.messageId===message.id).length,2);
  assert.equal((await prisma.message.findUnique({where:{id:message.id}})).status,'READ');
});
test('self, foreign, unauthorized and deleted targets rejected', async () => {
  for (const [c,u,m] of [[dm.id,sender,message.id],[dm.id,stranger,message.id],[group.id,reader,message.id]]) {
    await assert.rejects(service.markMessageRead(c,u,m));
  }
  const m = await send();
  await prisma.message.update({where:{id:m.id},data:{deletedAt:new Date()}});
  await assert.rejects(service.markMessageRead(dm.id,reader,m.id));
});
test('late delivery cannot regress READ, including mark-all', async () => {
  await service.markMessagesDelivered([message.id],reader);
  await service.markAllMessagesDelivered(reader);
  assert.equal((await prisma.message.findUnique({where:{id:message.id}})).status,'READ');
});
test('three-member group: any-reader aggregate, independent personal read/delivery/unread', async () => {
  const m = await send(group);
  assert.equal(events.filter(e=>e.name==='chatMessage' && e.payload.messageId===m.id).length,2);
  await service.markMessageRead(group.id,reader,m.id);
  assert.equal((await prisma.message.findUnique({where:{id:m.id}})).status,'READ');
  const h = await service.getMessages(group.id,third,1,50);
  assert.equal(h.messages.find(x=>x.id===m.id).readByMe,false);
  assert.equal(h.messages.find(x=>x.id===m.id).isGroup,true);
  assert.ok((await service.getPendingDeliveryMessages(third)).some(x=>x.id===m.id));
  assert.ok((await service.getUserConversations(third)).find(x=>x.id===group.id).unreadCount>0);
  await service.markMessagesDelivered([m.id],third);
  assert.equal((await prisma.messageReceipt.findUnique({where:{messageId_userId:{messageId:m.id,userId:third}}})).readAt,null);
  await service.markMessageRead(group.id,third,m.id);
});
test('invalid recipient rejected before message insertion', async () => {
  const count=await prisma.message.count();
  await assert.rejects(service.sendMessage(dm.id,sender,'bad',stranger));
  assert.equal(await prisma.message.count(),count);
});
test('transaction rollback leaves neither receipt nor outbox intent', async () => {
  const m=await send();
  await db.exec(`CREATE FUNCTION fail_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected'; END $$; CREATE TRIGGER fail_outbox BEFORE INSERT ON receipt_outbox FOR EACH ROW EXECUTE FUNCTION fail_receipt();`);
  await assert.rejects(service.markMessageRead(dm.id,reader,m.id));
  await db.exec('DROP TRIGGER fail_outbox ON receipt_outbox; DROP FUNCTION fail_receipt();');
  assert.equal((await prisma.message.findUnique({where:{id:m.id}})).status,'SENT');
  assert.equal((await prisma.messageReceipt.findUnique({where:{messageId_userId:{messageId:m.id,userId:reader}}})).readAt,null);
  assert.equal(await prisma.receiptOutbox.count(),0);
});
test('Kafka failure retained; backoff, active leases and expired leases recover', async () => {
  const m=await send(); kafkaFails=true;
  await service.markMessageRead(dm.id,reader,m.id);
  kafkaFails=false;
  assert.equal((await prisma.message.findUnique({where:{id:m.id}})).status,'READ');
  assert.equal(await prisma.receiptOutbox.count(),1);
  await publishReceipts(); assert.equal(await prisma.receiptOutbox.count(),1);
  await prisma.receiptOutbox.updateMany({data:{availableAt:new Date(0),leaseUntil:new Date(Date.now()+60000)}});
  await publishReceipts(); assert.equal(await prisma.receiptOutbox.count(),1);
  await prisma.receiptOutbox.updateMany({data:{leaseUntil:new Date(0)}});
  await publishReceipts(); assert.equal(await prisma.receiptOutbox.count(),0);
});
test('exact-ID sync includes old messages, only outgoing authorized and read-only', async () => {
  await prisma.message.update({where:{id:message.id},data:{createdAt:new Date(0)}});
  const before = await prisma.message.findUnique({where:{id:message.id}});
  assert.deepEqual(await service.syncReceipts(sender,[message.id]),[{messageId:message.id,conversationId:dm.id,status:'READ'}]);
  assert.deepEqual(await service.syncReceipts(reader,[message.id]),[]);
  assert.deepEqual(await service.syncReceipts(stranger,[message.id]),[]);
  assert.deepEqual(await prisma.message.findUnique({where:{id:message.id}}),before);
});
test('real Socket.IO: required target, authenticated identity; sender and reader get durable event', async () => {
  const http=createServer(); const io=new Server(http);
  io.use((socket,next)=>{socket.userId=socket.handshake.auth.userId;next();}); // adapted identity boundary, not production auth
  io.on('connection',socket=>{socket.join(`user:${socket.userId}`);registerChatHandlers(io,socket);});
  await new Promise(resolve=>http.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${http.address().port}`;
  const clients=await Promise.all([sender,reader].map(userId=>new Promise(resolve=>{const c=clientIO(url,{auth:{userId}});c.on('connect',()=>resolve(c));})));
  try {
    const m=await send();
    const invalid=await clients[1].emitWithAck('message:read',{conversationId:dm.id});assert.equal(invalid.success,false);
    const ack=await clients[1].emitWithAck('message:read',{conversationId:dm.id,messageId:m.id,userId:sender});assert.equal(ack.success,true);
    const confirmations=clients.map(c=>new Promise(resolve=>c.once('message:read',resolve)));
    handleMessageRead(io,events.findLast(e=>e.name==='messageRead').payload);
    const results=await Promise.all(confirmations);
    assert.equal(results[0].userId,reader);assert.deepEqual(results[0],results[1]);
  } finally { clients.forEach(c=>c.disconnect()); await new Promise(resolve=>io.close(resolve)); }
});

test('stale delivery SELECT cannot overwrite concurrent committed READ', async () => {
  const m=await send();
  const findMany=prisma.message.findMany.bind(prisma.message);
  let intercepted=false;
  prisma.message.findMany=async args=>{
    const result=await findMany(args);
    if (!intercepted && args.where?.id?.in?.includes(m.id)) {
      intercepted=true;
      await service.markMessageRead(dm.id,reader,m.id);
    }
    return result;
  };
  try { await service.markAllMessagesDelivered(reader); }
  finally { prisma.message.findMany=findMany; }
  assert.ok(intercepted);
  assert.equal((await prisma.message.findUnique({where:{id:m.id}})).status,'READ');
});
test('overlapping outbox publishers exclude active claims and shutdown drains active work', async () => {
  const payload={messageId:message.id,conversationId:dm.id,senderId:sender,userId:reader,readAt:new Date().toISOString()};
  await prisma.receiptOutbox.createMany({data:Array.from({length:51},()=>({id:randomUUID(),payload}))});
  const publish=kafkaEvents.messageRead;
  let release, entered;
  const gate=new Promise(resolve=>{release=resolve;});
  const started=new Promise(resolve=>{entered=resolve;});
  let count=0;
  kafkaEvents.messageRead=async p=>{count++;if(count===1){entered();await gate;}await publish(p);};
  const stop=startReceiptPublisher();
  await started;
  await publishReceipts();
  assert.equal(count,2); // first worker claimed 50, second claimed the remaining one
  assert.equal(await prisma.receiptOutbox.count(),50);
  let stopped=false;
  const stopping=stop().then(()=>{stopped=true;});
  await Promise.resolve();assert.equal(stopped,false);
  release();await stopping;
  kafkaEvents.messageRead=publish;
  assert.equal(await prisma.receiptOutbox.count(),0);
});
test('receipt consumer processing failure rejects rather than acknowledging', async () => {
  const TOPICS={MESSAGE_READ:'chat.message-read'};
  await assert.rejects(routeEvent({},TOPICS.MESSAGE_READ,{}));
  await assert.rejects(routeEvent({to(){throw Error('adapter failed');}},TOPICS.MESSAGE_READ,{
    messageId:message.id,conversationId:dm.id,senderId:sender,userId:reader,readAt:new Date().toISOString(),
  }), /adapter failed/);
});
test('HTTP recovery: authentication, max 200 UUIDs, exact old outgoing IDs, no receipt mutation', async () => {
  const app=express();app.use(express.json());app.use('/api/v1/messages',router);
  app.use((err,req,res,next)=>res.status(err.statusCode??500).json({error:err.message}));
  const server=createServer(app);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${server.address().port}/api/v1/messages/receipts/sync`;
  const token=jwt.sign({userId:sender,email:`${sender}@test.dev`,username:sender},process.env.JWT_SECRET??'changeme');
  const request=(body,auth=true)=>fetch(url,{method:'POST',headers:{'content-type':'application/json',...(auth?{authorization:`Bearer ${token}`}:{})},body:JSON.stringify(body)});
  try {
    assert.equal((await request({messageIds:[message.id]},false)).status,401);
    assert.equal((await request({messageIds:Array(201).fill(message.id)})).status,400);
    assert.equal((await request({messageIds:['invalid']})).status,400);
    const before=await prisma.messageReceipt.findMany();
    const response=await request({messageIds:[message.id]});assert.equal(response.status,200);
    assert.deepEqual((await response.json()).data,[{messageId:message.id,conversationId:dm.id,status:'READ'}]);
    assert.deepEqual(await prisma.messageReceipt.findMany(),before);
    await prisma.conversationParticipant.update({where:{conversationId_userId:{conversationId:dm.id,userId:sender}},data:{deletedAt:new Date()}});
    assert.deepEqual((await (await request({messageIds:[message.id]})).json()).data,[]);
    await assert.rejects(service.markMessageRead(dm.id,sender,message.id));
  } finally {await new Promise(resolve=>server.close(resolve));}
});
test('additive migration backfills identifiable legacy DM, not fictional group readers; retains history', async () => {
  const legacyDM=await prisma.message.create({data:{content:'legacy',conversationId:dm.id,senderId:sender,receiverId:reader,status:'READ',isRead:true}});
  const legacyGroup=await prisma.message.create({data:{content:'legacy group',conversationId:group.id,senderId:sender,status:'READ',isRead:true}});
  const count=await prisma.message.count();
  await db.exec('DROP TABLE receipt_outbox; DROP TABLE message_receipts;');
  await db.exec(readFileSync('prisma/migrations/20261030000000_reliable_message_receipts/migration.sql','utf8'));
  assert.equal(await prisma.message.count(),count);
  assert.ok((await prisma.messageReceipt.findUnique({where:{messageId_userId:{messageId:legacyDM.id,userId:reader}}})).readAt);
  const groupReceipts=await prisma.messageReceipt.findMany({where:{messageId:legacyGroup.id}});
  assert.equal(groupReceipts.length,2);assert.ok(groupReceipts.every(r=>r.readAt===null));
});
after(async()=>{await prisma.$disconnect();await pool.end();await db.close();});

for (const type of ['TEXT','IMAGE','VIDEO','AUDIO','DOCUMENT','SHARED_POST','SHARED_STORY']) {
  test(`complete ${type} reply across history, send and Kafka`, async () => {
    const dm = await conversation();
    const original = await service.sendMessage(dm.id, sender, type === 'TEXT' ? 'text' : '', reader, {
      type, mediaUrl: 'https://example.com/media', thumbnailUrl: 'https://example.com/thumb',
      duration: 12, fileName: 'file', fileMimeType: 'application/test', fileSize: 123,
      sharedReference: { id: 'reference', preview: 'preview' },
    });
    const reply = await service.replyMessage(dm.id, reader, 'reply', original.id, sender);
    const history = await service.getMessages(dm.id, reader, 1, 200);
    const fromHistory = history.messages.find(m => m.id === reply.id);
    assert.deepEqual(fromHistory.repliedTo, reply.repliedTo);
    assert.equal(reply.repliedTo.mediaUrl, 'https://example.com/media');
    assert.equal(reply.repliedTo.fileSize, 123);
    assert.deepEqual(events.find(e => e.name === 'chatMessage' && e.payload.messageId === reply.id).payload.message.repliedTo,
      JSON.parse(JSON.stringify(reply.repliedTo)));
    await assert.rejects(service.sendMessage(group.id, reader, 'bad', sender, { repliedToId: original.id }));
  });
}
test('persistent personal deletion, mixed batch permissions, tombstone replies and pagination', async () => {
  const dm = await conversation();
  const own = await service.sendMessage(dm.id, reader, 'mine', sender);
  const other = await send(dm);
  const foreign = await send(group);
  await service.deleteMessage(other.id, reader, 'me');
  await service.deleteMessage(other.id, reader, 'me');
  assert.equal(await prisma.messageDeletion.count({ where: { messageId: other.id, userId: reader } }), 1);
  assert.ok(!(await service.getMessages(dm.id, reader, 1, 200)).messages.some(m => m.id === other.id));
  assert.ok((await service.getMessages(dm.id, sender, 1, 200)).messages.some(m => m.id === other.id));
  assert.ok(!(await service.getPendingDeliveryMessages(reader, 200)).some(m => m.id === other.id));
  const result = await service.deleteMessages(dm.id, reader, [own.id, other.id, foreign.id, own.id], 'everyone');
  assert.deepEqual(result.results.map(r => r.success), [true, false, false]);
  const reply = await service.replyMessage(dm.id, sender, 'deleted original', own.id, reader);
  assert.ok(reply.repliedTo.deletedAt);
  assert.equal(reply.repliedTo.content, '');
  assert.equal(reply.repliedTo.mediaUrl, null);
  await assert.rejects(service.editMessage(own.id, reader, 'resurrect'));
  assert.ok((await service.syncReceipts(reader, [own.id]))[0].deletedAt);
});
test('message creation survives Kafka failure with durable retry and personal-room reply delivery', async () => {
  const dm = await conversation();
  kafkaFails = true;
  const m = await send(dm);
  kafkaFails = false;
  assert.ok(await prisma.receiptOutbox.count());
  await prisma.receiptOutbox.updateMany({ data: { availableAt: new Date(0) } });
  await publishReceipts();
  const event = events.find(e => e.name === 'chatMessage' && e.payload.messageId === m.id);
  assert.ok(event);
  const emitted = [];
  const io = { to: room => ({ emit: (name, payload) => emitted.push({room,name,payload}) }) };
  await routeEvent(io, 'chat.messages', event.payload);
  await routeEvent(io, 'chat.messages', event.payload);
  assert.equal(emitted.filter(e => e.name === 'message:new').length, 1);
  assert.ok(emitted.every(e => e.room === `user:${reader}`));
  assert.equal(emitted[0].payload.id, m.id);
});

const { postService } = await import('../.cache/bundles/services/post.service.js');
const { userService } = await import('../.cache/bundles/services/user.service.js');
const { activityService } = await import('../.cache/bundles/services/activity.service.js');
const { default: postRouter } = await import('../.cache/bundles/routes/post.routes.js');
const { default: activityRouter } = await import('../.cache/bundles/routes/activity.routes.js');
const { default: mediaRouter } = await import('../.cache/bundles/routes/media.routes.js');
const { authorizeMedia } = await import('../.cache/bundles/middlewares/media-access.js');
const { ensureUploadDirs } = await import('../.cache/bundles/middlewares/upload.js');
const { validateFile } = await import('../.cache/bundles/services/media.service.js');

test('comments: retry, pagination, parent validation, ownership, counts and activity', async () => {
  const post = await postService.createPost(sender, { content: 'post' });
  const key = randomUUID();
  const a = await postService.addComment(post.id, reader, 'hello', null, key);
  const retry = await postService.addComment(post.id, reader, 'hello', null, key);
  assert.equal(a.id, retry.id);
  await assert.rejects(postService.addComment(post.id, reader, 'different', null, key));
  const b = await postService.addComment(post.id, third, 'reply', a.id);
  assert.equal((await postService.getComments(post.id, reader, 1, 1)).total, 2);
  assert.equal((await postService.getComments(post.id, reader, 2, 1)).comments[0].id, b.id);
  assert.equal((await postService.getPost(post.id))._count.comments, 2);
  await assert.rejects(postService.deleteComment(post.id, a.id, stranger));
  await postService.deleteComment(post.id, a.id, reader);
  assert.equal((await postService.getPost(post.id))._count.comments, 1);
  const other = await postService.createPost(sender, { content: 'other' });
  await assert.rejects(postService.addComment(other.id, reader, 'wrong parent', b.id));
  await postService.deletePost(post.id, sender);
  await assert.rejects(postService.addComment(post.id, reader, 'deleted'));
  await assert.rejects(postService.getComments(post.id, reader, 1, 10));
});
test('activity: like/follow retries, self suppression, recipients, pagination and scoped reads', async () => {
  const post = await postService.createPost(sender, { content: 'activity' });
  await postService.likePost(post.id, reader);
  await postService.likePost(post.id, reader);
  await postService.likePost(post.id, sender);
  await userService.follow(reader, sender);
  await userService.follow(reader, sender);
  assert.equal(await prisma.notification.count({ where: { dedupeKey: `like:${post.id}:${reader}` } }), 1);
  assert.equal(await prisma.notification.count({ where: { dedupeKey: `follow:${reader}:${sender}` } }), 1);
  assert.equal(await prisma.notification.count({ where: { dedupeKey: `like:${post.id}:${sender}` } }), 0);
  const list = await activityService.list(sender, 1, 1);
  assert.equal(list.items.length, 1);
  assert.ok(list.items[0].actor);
  const item = await prisma.notification.findUnique({ where: { dedupeKey: `like:${post.id}:${reader}` } });
  await activityService.read(stranger, [item.id]);
  assert.equal((await prisma.notification.findUnique({ where: { id: item.id } })).isRead, false);
  await activityService.read(sender, [item.id]);
  assert.equal((await prisma.notification.findUnique({ where: { id: item.id } })).isRead, true);
  await postService.savePost(post.id, reader);
  await postService.deletePost(post.id, sender);
  assert.ok(!(await postService.getSavedPosts(reader, 1, 100)).posts.some(p => p.id === post.id));
  assert.ok(!(await activityService.list(sender, 1, 200)).items.some(i => i.id === item.id));
  assert.ok((await prisma.notification.findUnique({where:{id:item.id}})).withdrawnAt);
});
test('real HTTP uploads: private/group recipient access, ranges, posts, invalid MIME, limits and cleanup', async () => {
  ensureUploadDirs();
  const app = express(); app.use(express.json());
  app.use('/media', mediaRouter); app.use('/posts', postRouter); app.use('/activity', activityRouter);
  // Authenticate test media GETs with the real middleware, as in app.ts.
  // Identity for this static test mount is set from the signed test token; upload/API auth remains real.
  app.use('/uploads', (req, res, next) => {
    try { const token = req.headers.authorization?.slice(7); if (token) req.user = jwt.verify(token, process.env.JWT_SECRET); next(); } catch { res.sendStatus(401); }
  }, authorizeMedia, express.static(process.env.UPLOADS_PATH));
  app.use((err, req, res, next) => res.status(err.statusCode ?? 400).json({ error: err.message }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.on('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const token = id => ({ Authorization: `Bearer ${jwt.sign({ userId: id, username: id }, process.env.JWT_SECRET)}` });
  const fixtures = [
    ['IMAGE','image/png','picture.png', await sharp({create:{width:2,height:2,channels:3,background:'red'}}).png().toBuffer()],
    ['VIDEO','video/mp4','clip.mp4', Buffer.from([0,0,0,24,...Buffer.from('ftypisom'),0,0,0,0,...Buffer.from('isommp42')])],
    ['AUDIO','audio/mp4','voice.m4a', Buffer.from([0,0,0,24,...Buffer.from('ftypM4A '),0,0,0,0,...Buffer.from('M4A isom')])],
  ];
  const dm = await conversation(); const group = await conversation(true);
  try {
    assert.equal((await fetch(`${base}/activity`)).status, 401);
    const commentPost = await postService.createPost(sender, {content:'HTTP comments'});
    const key = randomUUID();
    const body = {content:'HTTP comment',clientRequestId:key};
    const request = () => fetch(`${base}/posts/${commentPost.id}/comments`, {method:'POST',headers:{...token(reader),'Content-Type':'application/json'},body:JSON.stringify(body)});
    const first = await request(); assert.equal(first.status,201); const added = (await first.json()).data;
    const repeated = await request(); assert.equal((await repeated.json()).data.id,added.id);
    const comments = await fetch(`${base}/posts/${commentPost.id}/comments?limit=1`, {headers:token(reader)});
    assert.equal(comments.status,200); assert.equal((await comments.json()).data[0].id,added.id);
    assert.equal((await fetch(`${base}/posts/${commentPost.id}/comments/${added.id}`,{method:'DELETE',headers:token(stranger)})).status,403);
    assert.equal((await fetch(`${base}/posts/${commentPost.id}/comments/${added.id}`,{method:'DELETE',headers:token(reader)})).status,200);
    const activities = await fetch(`${base}/activity`,{headers:token(sender)}); assert.equal(activities.status,200);
    assert.ok((await activities.json()).data.items.every(i => i.userId === sender));
    for (const [type, mime, name, bytes] of fixtures) {
      const form = new FormData(); form.set('file', new Blob([bytes], {type:mime}), name);
      const response = await fetch(`${base}/media/upload`, { method:'POST', headers:token(sender), body:form });
      assert.equal(response.status, 201);
      const { data: media } = await response.json();
      if (type === 'IMAGE') assert.ok(media.thumbnailUrl.endsWith('.jpg'));
      assert.ok(media.url.startsWith('https://media.example.com/uploads/'));
      assert.equal(media.fileMimeType, mime);
      const url = `${base}${new URL(media.url).pathname}`;
      assert.equal((await fetch(url, {headers:token(reader)})).status, 403);
      for (const c of [dm, group]) {
        const msg = await service.sendMessage(c.id, sender, '', reader, {type, mediaUrl:media.url, fileMimeType:media.mimeType, fileSize:media.size, fileName:media.fileName});
        assert.equal((await service.getMessages(c.id, reader, 1, 200)).messages.find(m => m.id === msg.id).mediaUrl, media.url);
      }
      if (media.thumbnailUrl) { const thumb = await fetch(`${base}${new URL(media.thumbnailUrl).pathname}`, {headers:token(reader)}); assert.equal(thumb.status,200); assert.equal(thumb.headers.get('content-type'),'image/jpeg'); }
      const served = await fetch(url, {headers:{...token(reader), Range:'bytes=0-7'}});
      assert.equal(served.status, 206);
      assert.equal(served.headers.get('content-type'), mime);
      assert.equal((await fetch(url, {headers:token(stranger)})).status, 403);
      if (type !== 'AUDIO') {
        const post = await postService.createPost(sender, {content:'', ...(type === 'IMAGE' ? {imageUrls:[media.url]} : {videoUrl:media.url})});
        assert.equal((await fetch(url)).status, 200);
        assert.equal((await postService.getPost(post.id)).videoUrl, post.videoUrl);
        assert.ok(post.mediaMetadata.some(m => m.url === media.url && m.mimeType === mime));
        assert.ok((await postService.getUserPosts(sender, reader, 1, 200)).posts.some(p => p.id === post.id));
      }
    }
    const before = await prisma.mediaAsset.count();
    const bad = new FormData(); bad.set('file', new Blob(['not png'], {type:'image/png'}), 'evil.html');
    assert.equal((await fetch(`${base}/media/upload`, {method:'POST', headers:token(sender), body:bad})).status, 400);
    assert.equal(await prisma.mediaAsset.count(), before);
    const tooBig = new FormData(); tooBig.set('file', new Blob([Buffer.alloc(10*1024*1024+1)],{type:'image/png'}),'large.png');
    assert.equal((await fetch(`${base}/media/upload`, {method:'POST',headers:token(sender),body:tooBig})).status, 400);
    const files = ['images','videos','audio'].flatMap(folder => readdirSync(`${process.env.UPLOADS_PATH}/${folder}`).map(f => `${folder}/${f}`));
    assert.equal(files.length, await prisma.mediaAsset.count());
    await assert.rejects(postService.createPost(sender, {content:'', imageUrls:['file:///device.jpg']}));
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('production media configuration rejects localhost, device URIs and non-HTTPS origins', async () => {
  const { mediaBaseUrl, isSharedMediaUrl } = await import('../.cache/bundles/config/media.js');
  const saved = { env: process.env.NODE_ENV, base: process.env.PUBLIC_MEDIA_BASE_URL };
  try {
    process.env.NODE_ENV = 'production';
    for (const url of ['http://localhost:3000/uploads','https://127.0.0.1/uploads','http://api.example.com/uploads',
      'https://app/uploads','https://10.0.0.5/uploads','https://192.168.1.2/uploads','https://[fd00::1]/uploads',
      'https://user:pass@api.example.com/uploads']) {
      process.env.PUBLIC_MEDIA_BASE_URL = url; assert.throws(mediaBaseUrl, undefined, url);
    }
    for (const url of ['file:///phone/image.jpg','content://device/media','http://127.0.0.1/a','https://localhost/a',
      'https://10.0.0.5/a','https://[fe80::1]/a','https://api.example.com/uploads/../a.png',
      'https://api.example.com/uploads/%2e%2e/a.png']) assert.equal(isSharedMediaUrl(url),false,url);
    // Development keeps LAN origins usable for on-device uploads.
    process.env.NODE_ENV = 'development';
    process.env.PUBLIC_MEDIA_BASE_URL = 'http://192.168.1.20:3000/uploads';
    assert.equal(mediaBaseUrl(), 'http://192.168.1.20:3000/uploads');
    assert.equal(isSharedMediaUrl('http://192.168.1.20:3000/uploads/images/a.webp'), true);
    process.env.PUBLIC_MEDIA_BASE_URL = 'http://127.0.0.1:3000/uploads';
    assert.throws(mediaBaseUrl);
  } finally {
    if (saved.env === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = saved.env;
    process.env.PUBLIC_MEDIA_BASE_URL = saved.base;
  }
});
test('media registration failure cleans original and generated thumbnails', async () => {
  const { processUploadedFile } = await import('../.cache/bundles/services/media.service.js');
  const name = `${randomUUID()}.png`;
  const path = `${process.env.UPLOADS_PATH}/images/${name}`;
  const buffer = await sharp({create:{width:2,height:2,channels:3,background:'blue'}}).png().toBuffer();
  writeFileSync(path,buffer);
  await assert.rejects(processUploadedFile({path, filename:name, originalname:'file.png', mimetype:'image/png', size:buffer.length}, randomUUID()));
  assert.ok(!readdirSync(`${process.env.UPLOADS_PATH}/images`).some(f => f.includes(name.split('.')[0])));
});
test('avatar uploads accept image MIME, decode bytes, normalize to WebP, and clean staged files', async () => {
  ensureUploadDirs();
  const previousAbuseLimits = {
    ip: process.env.ABUSE_MEDIA_IP_MAX,
    user: process.env.ABUSE_MEDIA_USER_MAX,
  };
  process.env.ABUSE_MEDIA_IP_MAX = '200';
  process.env.ABUSE_MEDIA_USER_MAX = '200';
  const imagesDir = `${process.env.UPLOADS_PATH}/images`;
  const filesBefore = new Set(readdirSync(imagesDir));
  const mediaAssetsBefore = await prisma.mediaAsset.count();
  const app = express();
  app.use('/media', mediaRouter);
  app.use('/uploads', (req, res, next) => {
    try {
      const value = req.headers.authorization?.slice(7);
      if (value) req.user = jwt.verify(value, process.env.JWT_SECRET);
      next();
    } catch { res.sendStatus(401); }
  }, authorizeMedia, express.static(process.env.UPLOADS_PATH));
  app.use((err, req, res, next) => res.status(err.statusCode ?? 500).json({success:false,message:err.message}));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.on('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const auth = {Authorization:`Bearer ${jwt.sign({userId:sender,username:sender},process.env.JWT_SECRET)}`};
  const sendFile = async (route, field, mime, name, bytes, headers = auth) => {
    const form = new FormData();
    form.set(field, new Blob([bytes], {type:mime}), name);
    return fetch(`${base}${route}`, {method:'POST',headers,body:form});
  };
  const oldAvatar = (await prisma.user.findUnique({where:{id:sender},select:{avatarUrl:true}})).avatarUrl;

  try {
    assert.equal((await fetch(`${base}/media/upload/avatar`,{method:'POST'})).status,401);
    assert.equal((await fetch(`${base}/media/upload/avatar`,{method:'POST',headers:auth})).status,400);
    assert.equal((await sendFile('/media/upload/avatar','avatar','text/plain','note.txt',Buffer.from('not an image'))).status,415);
    assert.equal((await sendFile('/media/upload/avatar','avatar','image/jpeg','fake.jpg',Buffer.from('plain text'))).status,415);
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><image href="file:///etc/passwd"/></svg>');
    assert.equal((await sendFile('/media/upload/avatar','avatar','image/svg+xml','avatar.svg',svg)).status,415);
    // A client cannot bypass the SVG policy by lying about the part MIME.
    assert.equal((await sendFile('/media/upload/avatar','avatar','image/jpeg','avatar.jpg',svg)).status,415);

    const tooBig = Buffer.alloc(5 * 1024 * 1024 + 1);
    assert.equal((await sendFile('/media/upload/avatar','avatar','image/jpeg','large.jpg',tooBig)).status,413);

    // The generic chat upload remains restricted to the shared MIME allowlist.
    for (const mime of ['image/heic','image/avif','image/svg+xml']) {
      assert.equal((await sendFile('/media/upload','file',mime,'not-allowed.bin',Buffer.from('not decoded'))).status,400);
    }
    assert.equal(await prisma.mediaAsset.count(),mediaAssetsBefore);

    const canvas = () => sharp({create:{width:2048,height:1024,channels:3,background:'#3567ab'}});
    const samples = [
      ['image/png','source.png',await canvas().png().toBuffer()],
      ['image/jpeg','source.jpg',await canvas().jpeg().withMetadata({orientation:6}).toBuffer()],
      ['image/gif','source.gif',await canvas().gif().toBuffer()],
      ['image/webp','source.webp',await canvas().webp().toBuffer()],
      ['image/tiff','source.tif',await canvas().tiff().toBuffer()],
      ['image/vnd.phone+camera','provider.raw',await canvas().jpeg().toBuffer()],
    ];
    if (sharp.format.heif?.input?.file && sharp.format.heif.output?.file) {
      samples.push(['image/avif','source.avif',await canvas().avif().toBuffer()]);
    }

    let firstAvatar;
    let orientedAvatar;
    for (const [mime,name,bytes] of samples) {
      const response = await sendFile('/media/upload/avatar','avatar',mime,name,bytes);
      assert.equal(response.status,201,`${mime}: ${await response.clone().text()}`);
      const {data} = await response.json();
      assert.match(data.url,/\.webp$/);
      assert.equal(typeof data.width,'number');
      assert.equal(typeof data.height,'number');
      assert.ok(data.width <= 1024 && data.height <= 1024);
      assert.ok(data.width > 0 && data.height > 0);
      if (mime === 'image/jpeg') {
        // EXIF orientation 6 turns the landscape source into portrait before resize.
        assert.ok(data.height > data.width);
      }
      if (data.thumbnailUrl) assert.match(data.thumbnailUrl,/\.webp$/);
      if (!firstAvatar) firstAvatar = data;
      if (mime === 'image/jpeg') orientedAvatar = data;
    }

    // BMP is not built into this deployment's Sharp/libvips. It is rejected as
    // an unsupported decoder format rather than being stored in its original form.
    const bmp = Buffer.alloc(70);
    bmp.write('BM',0,'ascii'); bmp.writeUInt32LE(70,2); bmp.writeUInt32LE(54,10);
    bmp.writeUInt32LE(40,14); bmp.writeInt32LE(2,18); bmp.writeInt32LE(2,22);
    bmp.writeUInt16LE(1,26); bmp.writeUInt16LE(24,28); bmp.writeUInt32LE(16,34); bmp.fill(255,54);
    if (!sharp.format.bmp?.input?.file) {
      assert.equal((await sendFile('/media/upload/avatar','avatar','image/bmp','photo.bmp',bmp)).status,415);
    }

    assert.ok(firstAvatar);
    const avatarForRead = orientedAvatar ?? firstAvatar;
    await prisma.user.update({where:{id:sender},data:{avatarUrl:avatarForRead.url}});
    const publicImage = await fetch(`${base}${new URL(avatarForRead.url).pathname}`);
    assert.equal(publicImage.status,200);
    assert.match(publicImage.headers.get('content-type') ?? '',/^image\/webp/);
    const normalizedMetadata = await sharp(Buffer.from(await publicImage.arrayBuffer())).metadata();
    assert.equal(normalizedMetadata.format,'webp');
    assert.equal(normalizedMetadata.width,avatarForRead.width);
    assert.equal(normalizedMetadata.height,avatarForRead.height);
    assert.equal(normalizedMetadata.orientation,undefined);
    if (avatarForRead.thumbnailUrl) {
      const publicThumbnail = await fetch(`${base}${new URL(avatarForRead.thumbnailUrl).pathname}`);
      assert.equal(publicThumbnail.status,200);
      assert.match(publicThumbnail.headers.get('content-type') ?? '',/^image\/webp/);
    }

    const addedFiles = readdirSync(imagesDir).filter(file => !filesBefore.has(file));
    assert.ok(addedFiles.length > 0);
    assert.ok(addedFiles.every(file => file.endsWith('.webp')));
    assert.deepEqual(readdirSync(imagesDir).filter(file => file.endsWith('.upload')),[]);
  } finally {
    await prisma.user.update({where:{id:sender},data:{avatarUrl:oldAvatar}});
    await new Promise(resolve => server.close(resolve));
    if (previousAbuseLimits.ip === undefined) delete process.env.ABUSE_MEDIA_IP_MAX;
    else process.env.ABUSE_MEDIA_IP_MAX = previousAbuseLimits.ip;
    if (previousAbuseLimits.user === undefined) delete process.env.ABUSE_MEDIA_USER_MAX;
    else process.env.ABUSE_MEDIA_USER_MAX = previousAbuseLimits.user;
  }
});
test('additive media/activity migration preserves legacy comments and dangling navigation references', async () => {
  const legacy = new PGlite();
  try {
    const directories = readdirSync('prisma/migrations').filter(d => !d.endsWith('.toml')).sort();
    const added = ['20261031000000_media_comments_activity', '20261031010000_notification_lifecycle', '20261104000000_google_channels_stickers_abuse'];
    for (const dir of directories.filter(d => !added.includes(d))) await legacy.exec(readFileSync(`prisma/migrations/${dir}/migration.sql`,'utf8'));
    await legacy.exec(`INSERT INTO users(id,username,email,password_hash,updated_at) VALUES ('legacy','legacy','legacy@test.dev','hash',now());
      INSERT INTO posts(id,content,image_urls,author_id,updated_at) VALUES ('post','retained',ARRAY['https://example.com/image.png'],'legacy',now());
      INSERT INTO comments(id,content,author_id,post_id,replied_to_id) VALUES ('comment','retained','legacy','post','missing');
      INSERT INTO notifications(id,type,content,user_id,actor_id) VALUES ('notification','COMMENT','retained','legacy','missing');`);
    for (const dir of added) await legacy.exec(readFileSync(`prisma/migrations/${dir}/migration.sql`,'utf8'));
    assert.equal((await legacy.query('SELECT content FROM comments')).rows[0].content,'retained');
    assert.equal((await legacy.query('SELECT actor_id FROM notifications')).rows[0].actor_id,'missing');
    assert.equal((await legacy.query('SELECT image_urls FROM posts')).rows[0].image_urls[0],'https://example.com/image.png');
  } finally { await legacy.close(); }
});

test('activity publication failure retains one durable intent and retries with stable notification ID', async () => {
  const post = await postService.createPost(sender,{content:'retry activity'});
  kafkaFails = true;
  try { await postService.likePost(post.id,reader); } finally { kafkaFails = false; }
  const item = await prisma.notification.findUnique({where:{dedupeKey:`like:${post.id}:${reader}`}});
  assert.ok(item);
  await prisma.receiptOutbox.updateMany({data:{availableAt:new Date(0)}});
  await publishReceipts();
  const published = events.filter(e => e.name === 'notification' && e.payload.id === item.id);
  assert.equal(published.length,1);
  await postService.likePost(post.id,reader);
  assert.equal(events.filter(e => e.name === 'notification' && e.payload.id === item.id).length,1);
});


test('notifications: explicit reply metadata, recipients, atomic self suppression and retry keys', async () => {
  const post = await postService.createPost(sender, {content:'notification replies'});
  const parent = await postService.addComment(post.id, reader, 'parent');
  const key = randomUUID();
  const reply = await postService.addComment(post.id, third, 'reply', parent.id, key);
  await postService.addComment(post.id, third, 'reply', parent.id, key);
  const rows = await prisma.notification.findMany({where:{commentId:reply.id}});
  assert.equal(rows.length,2);
  assert.deepEqual(new Set(rows.map(n=>n.userId)),new Set([sender,reader]));
  assert.ok(rows.every(n=>n.actorId===third && n.postId===post.id && n.type==='COMMENT'));
  assert.equal(rows.find(n=>n.userId===reader).metadata.interaction,'COMMENT_REPLY');
  assert.equal(rows.find(n=>n.userId===sender).metadata.interaction,'POST_COMMENT');
  const own = await postService.addComment(post.id,sender,'self');
  assert.equal(await prisma.notification.count({where:{commentId:own.id}}),0);
});

test('notifications: stable keyset pagination at ties, insertion and dismissal between pages', async () => {
  const recipient = await prisma.user.create({data:{username:randomUUID(),email:`${randomUUID()}@test.dev`,passwordHash:'unused'}});
  const stamp = new Date('2026-10-31T12:00:00.000Z');
  const rows = [];
  for(let i=0;i<5;i++) rows.push(await prisma.notification.create({data:{userId:recipient.id,actorId:sender,type:'FOLLOW',content:'pagination',createdAt:stamp}}));
  const first = await activityService.listCursor(recipient.id,2);
  assert.equal(first.items.length,2); assert.equal(first.pagination.hasNext,true);
  assert.ok(first.items[0].id > first.items[1].id);
  await activityService.dismiss(recipient.id,first.items.at(-1).id);
  const newer = await prisma.notification.create({data:{userId:recipient.id,type:'FOLLOW',content:'newer',createdAt:new Date('2026-10-31T12:01:00Z')}});
  const second = await activityService.listCursor(recipient.id,2,first.pagination.nextCursor);
  const thirdPage = await activityService.listCursor(recipient.id,2,second.pagination.nextCursor);
  const ids = [...first.items,...second.items,...thirdPage.items].map(n=>n.id);
  assert.equal(new Set(ids).size,5); assert.ok(!ids.includes(newer.id));
  assert.equal(thirdPage.pagination.hasNext,false); assert.equal(thirdPage.pagination.nextCursor,null);
  await assert.rejects(activityService.listCursor(recipient.id,2,'not-json'));
  // Cursor only supplies a boundary, never an authorization scope.
  const other = await activityService.listCursor(stranger,10,first.pagination.nextCursor);
  assert.ok(other.items.every(n=>n.userId===stranger));
});

test('notifications: unlike/unfollow withdraw; redo reuses ID; dismissed rows do not resurrect', async () => {
  const post = await postService.createPost(sender,{content:'lifecycle'});
  await postService.likePost(post.id,reader);
  const item = await prisma.notification.findUnique({where:{dedupeKey:`like:${post.id}:${reader}`}});
  await activityService.readOne(sender,item.id);
  await postService.unlikePost(post.id,reader);
  assert.ok(!(await activityService.listCursor(sender,100)).items.some(n=>n.id===item.id));
  await postService.likePost(post.id,reader);
  const restored = await prisma.notification.findUnique({where:{id:item.id}});
  assert.equal(restored.withdrawnAt,null); assert.equal(restored.isRead,false); assert.equal(restored.version,3);
  await activityService.dismiss(sender,item.id);
  await postService.unlikePost(post.id,reader); await postService.likePost(post.id,reader);
  assert.ok(!(await activityService.listCursor(sender,100)).items.some(n=>n.id===item.id));
  await userService.follow(third,sender);
  const follow = await prisma.notification.findUnique({where:{dedupeKey:`follow:${third}:${sender}`}});
  await userService.unfollow(third,sender);
  assert.ok((await prisma.notification.findUnique({where:{id:follow.id}})).withdrawnAt);
  await userService.follow(third,sender);
  assert.equal(await prisma.notification.count({where:{dedupeKey:`follow:${third}:${sender}`}}),1);
  assert.equal((await prisma.notification.findUnique({where:{id:follow.id}})).withdrawnAt,null);
});

test('notifications: single/all read timestamps are idempotent, counts and queries scoped', async () => {
  const post = await postService.createPost(sender,{content:'read notifications'});
  await postService.likePost(post.id,reader);
  const item = await prisma.notification.findUnique({where:{dedupeKey:`like:${post.id}:${reader}`}});
  await assert.rejects(activityService.readOne(stranger,item.id),/not found/);
  await assert.rejects(activityService.dismiss(stranger,item.id),/not found/);
  const first = await activityService.readOne(sender,item.id);
  const again = await activityService.readOne(sender,item.id);
  assert.equal(first.isRead,true); assert.equal(first.readAt.getTime(),again.readAt.getTime());
  const countMethod = prisma.notification.count.bind(prisma.notification);
  let queries=0;
  prisma.notification.count = args => {queries++; return countMethod(args);};
  try { await activityService.unreadCount(sender); assert.equal(queries,1); } finally {prisma.notification.count=countMethod;}
  await activityService.read(sender);
  assert.equal(await activityService.unreadCount(sender),0);
  assert.equal((await activityService.read(sender)).count,0);
});

test('notifications HTTP: JWT auth, cursor contract, validation, single read, dismiss and legacy activity', async () => {
  const {createActivityRouter} = await import('../.cache/bundles/routes/activity.routes.js');
  const { ZodError } = await import('zod');
  const app=express(); app.use(express.json());
  app.use('/notifications',createActivityRouter(true)); app.use('/activity',createActivityRouter());
  app.use((err,req,res,next)=>res.status(err.statusCode??(err instanceof ZodError?400:500)).json({success:false,message:err.message}));
  const http=app.listen(0,'127.0.0.1'); await new Promise(resolve=>http.on('listening',resolve));
  const base=`http://127.0.0.1:${http.address().port}`;
  const headers=id=>({Authorization:`Bearer ${jwt.sign({userId:id,username:id},process.env.JWT_SECRET)}`,'Content-Type':'application/json'});
  const post=await postService.createPost(sender,{content:'API'}); await postService.likePost(post.id,reader);
  const item=await prisma.notification.findUnique({where:{dedupeKey:`like:${post.id}:${reader}`}});
  try {
    assert.equal((await fetch(`${base}/notifications`)).status,401);
    for(const suffix of ['?limit=201','?limit=-1','?cursor=broken']) assert.equal((await fetch(`${base}/notifications${suffix}`,{headers:headers(sender)})).status,400);
    const list=await (await fetch(`${base}/notifications?limit=2`,{headers:headers(sender)})).json();
    assert.equal(list.success,true); assert.equal(list.meta.limit,2); assert.equal(typeof list.meta.hasNext,'boolean');
    assert.ok(list.data.items.every(n=>n.userId===sender && !('dedupeKey' in n)));
    assert.equal((await fetch(`${base}/notifications/${item.id}/read`,{method:'POST',headers:headers(stranger)})).status,404);
    assert.equal((await fetch(`${base}/notifications/not-a-uuid/read`,{method:'POST',headers:headers(sender)})).status,400);
    assert.equal((await fetch(`${base}/notifications/read`,{method:'POST',headers:headers(sender),body:JSON.stringify({ids:['invalid']})})).status,400);
    assert.equal((await fetch(`${base}/notifications/${item.id}/read`,{method:'POST',headers:headers(sender)})).status,200);
    assert.equal((await fetch(`${base}/notifications/${item.id}`,{method:'DELETE',headers:headers(stranger)})).status,404);
    assert.equal((await fetch(`${base}/notifications/${item.id}`,{method:'DELETE',headers:headers(sender)})).status,200);
    assert.equal((await fetch(`${base}/notifications/${item.id}`,{method:'DELETE',headers:headers(sender)})).status,200);
    const legacy=await(await fetch(`${base}/activity?page=1&limit=2`,{headers:headers(sender)})).json();
    assert.ok(Array.isArray(legacy.data.items)); assert.equal(typeof legacy.meta.total,'number');
    assert.equal((await fetch(`${base}/notifications/read-all`,{method:'POST',headers:headers(sender)})).status,200);
    assert.equal((await(await fetch(`${base}/notifications/unread-count`,{headers:headers(sender)})).json()).data.unreadCount,0);
  } finally { await new Promise(resolve=>http.close(resolve)); }
});

test('notifications consumer: persisted DTOs, recipient rooms, duplicate IDs and suppressed stale events', async () => {
  const post=await postService.createPost(sender,{content:'consumer'}); await postService.likePost(post.id,reader);
  const item=await prisma.notification.findUnique({where:{dedupeKey:`like:${post.id}:${reader}`}});
  const event=events.find(e=>e.name==='notification'&&e.payload.id===item.id).payload;
  const emitted=[]; const io={to:room=>({emit:(name,payload)=>emitted.push({room,name,payload})})};
  await routeEvent(io,'chat.notifications',event); await routeEvent(io,'chat.notifications',event);
  assert.equal(emitted.length,2); assert.ok(emitted.every(e=>e.room===`user:${sender}` && e.payload.id===item.id));
  assert.ok(emitted.every(e=>!JSON.stringify(e.payload).includes('passwordHash') && !('dedupeKey' in e.payload)));
  assert.equal(await prisma.notification.count({where:{id:item.id}}),1);
  await routeEvent(io,'chat.notifications',{...event,userId:stranger}); assert.equal(emitted.length,2);
  await postService.unlikePost(post.id,reader);
  await routeEvent(io,'chat.notifications',event); assert.equal(emitted.length,2);
  await routeEvent(io,'chat.notifications',{...event,operation:'updated'});
  assert.equal(emitted.at(-1).name,'notification:removed');
  await assert.rejects(routeEvent(io,'chat.notifications',{userId:'bad'}));
});

test('notifications: deleted content and actors are safe; transactional share notifications use outbox', async () => {
  const post=await postService.createPost(sender,{content:'share'});
  const c=await conversation();
  await postService.sharePost(post.id,reader,c.id);
  await postService.sharePost(post.id,reader,c.id);
  assert.equal(await prisma.notification.count({where:{dedupeKey:`share:${post.id}:${reader}`}}),1);
  const share=await prisma.notification.findUnique({where:{dedupeKey:`share:${post.id}:${reader}`}});
  assert.ok(events.some(e=>e.name==='notification'&&e.payload.id===share.id));
  const comment=await postService.addComment(post.id,third,'delete me');
  const n=await prisma.notification.findFirst({where:{commentId:comment.id,userId:sender}});
  await postService.deleteComment(post.id,comment.id,third);
  assert.ok((await prisma.notification.findUnique({where:{id:n.id}})).withdrawnAt);
  // Legacy/admin soft-deletion may not withdraw: previews still redact missing entities.
  await prisma.user.update({where:{id:reader},data:{deletedAt:new Date()}});
  try { assert.equal((await activityService.forDelivery(sender,share.id)).actor,null); }
  finally { await prisma.user.update({where:{id:reader},data:{deletedAt:null}}); }
  await postService.deletePost(post.id,sender);
  assert.equal(await activityService.forDelivery(sender,share.id),null);
});


test('notification real Socket.IO delivery: production JWT middleware, personal rooms and reconnect recovery', async () => {
  const { authenticateSocket } = await import('../.cache/bundles/socket/authenticate.js');
  const http=createServer(); const io=new Server(http); io.use(authenticateSocket);
  io.on('connection',socket=>socket.join(`user:${socket.userId}`));
  await new Promise(resolve=>http.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${http.address().port}`;
  const token=id=>jwt.sign({userId:id,username:id},process.env.JWT_SECRET);
  const clients=[];
  const connect=auth=>new Promise((resolve,reject)=>{const c=clientIO(url,{auth,reconnection:false,timeout:1500}); clients.push(c); c.once('connect',()=>resolve(c));c.once('connect_error',reject);});
  try {
    await assert.rejects(connect({token:'invalid'}));
    const [recipient,actor,other]=await Promise.all([sender,reader,stranger].map(id=>connect({token:token(id)})));
    const leaked=[]; actor.on('notification:new',n=>leaked.push(n)); other.on('notification:new',n=>leaked.push(n));
    const post=await postService.createPost(sender,{content:'socket notification'}); await postService.likePost(post.id,reader);
    const item=await prisma.notification.findUnique({where:{dedupeKey:`like:${post.id}:${reader}`}});
    const event=events.find(e=>e.name==='notification'&&e.payload.id===item.id).payload;
    const received=new Promise(resolve=>recipient.once('notification:new',resolve));
    await routeEvent(io,'chat.notifications',event);
    const result=await received; assert.equal(result.id,item.id); assert.equal(result.actorId,reader); assert.equal(result.userId,sender);
    assert.equal(leaked.length,0);
    recipient.disconnect();
    const comment=await postService.addComment(post.id,reader,'offline comment');
    const pending=await prisma.notification.findFirst({where:{commentId:comment.id,userId:sender}});
    await routeEvent(io,'chat.notifications',events.find(e=>e.name==='notification'&&e.payload.id===pending.id).payload);
    const reconnected=await connect({token:token(sender)}); assert.ok(reconnected.connected);
    assert.ok((await activityService.listCursor(sender,100)).items.some(n=>n.id===pending.id));
  } finally { clients.forEach(c=>c.disconnect()); await new Promise(resolve=>io.close(resolve)); }
});

test('notifications migration and persisted outbox survive database close/reopen and service reload', async () => {
  const root='.cache/notification-persistence'; rmSync(root,{recursive:true,force:true});
  let store=new PGlite(root);
  for(const dir of readdirSync('prisma/migrations').filter(d=>!d.endsWith('.toml')).sort()) await store.exec(readFileSync(`prisma/migrations/${dir}/migration.sql`,'utf8'));
  const persistentQuery=async(q,values)=>{
    const r=await store.query(typeof q==='string'?q:q.text,values??q.values??[],{parsers:{1114:v=>v,1184:v=>v,1082:v=>v,114:v=>v,3802:v=>v}});
    return {...r,rowCount:r.affectedRows,rows:r.rows.map(row=>r.fields.map(f=>row[f.name]))};
  };
  const pool=new pg.Pool(); pool.query=persistentQuery; pool.connect=async()=>Object.assign(new EventEmitter(),{query:persistentQuery,release(){}});
  let client=new PrismaClient({adapter:new PrismaPg(pool)});
  const recipient=randomUUID(); const actor=randomUUID(); const n=randomUUID(); const outbox=randomUUID();
  const durableMessage=randomUUID(); const durablePush=randomUUID(); const durableAction=randomUUID();
  try {
    for(const id of [recipient,actor]) await client.user.create({data:{id,username:id,email:`${id}@persist.dev`,passwordHash:'unused'}});
    await client.$transaction(async tx=>{
      await tx.notification.create({data:{id:n,userId:recipient,actorId:actor,type:'FOLLOW',content:'persisted',dedupeKey:`follow:${actor}:${recipient}`}});
      await tx.receiptOutbox.create({data:{id:outbox,payload:{kind:'notification',event:{id:n,userId:recipient,actorId:actor,type:'FOLLOW'}}}});
    });
    const chat=await client.conversation.create({data:{participants:{create:[{userId:recipient},{userId:actor}]}}});
    const device=await client.pushDevice.create({data:{userId:recipient,deviceId:randomUUID(),token:'ExpoPushToken[persistent_device]'}});
    await client.message.create({data:{id:durableMessage,content:'persisted message',senderId:actor,receiverId:recipient,conversationId:chat.id,receipts:{create:{userId:recipient}}}});
    await client.pushDelivery.create({data:{id:durablePush,messageId:durableMessage,deviceId:device.id,tokenVersion:1}});
    await client.notificationReplyAction.create({data:{userId:recipient,actionId:durableAction,requestHash:'persisted-fingerprint',messageId:durableMessage}});
    await client.$disconnect(); await store.close();
    store=new PGlite(root); client=new PrismaClient({adapter:new PrismaPg(pool)});
    globalThis.__receiptTest.prisma=client;
    const {activityService: restarted}=await import(`../.cache/bundles/services/activity.service.js?restart=${randomUUID()}`);
    assert.equal((await client.notificationReplyAction.findUnique({where:{userId_actionId:{userId:recipient,actionId:durableAction}}})).messageId,durableMessage);
    assert.equal((await client.pushDelivery.findUnique({where:{id:durablePush}})).status,'QUEUED');
    assert.equal((await client.pushDevice.findFirst({where:{userId:recipient}})).token,'ExpoPushToken[persistent_device]');
    const page=await restarted.listCursor(recipient,20);
    assert.equal(page.items[0].id,n); assert.equal(page.unreadCount,1);
    assert.equal(await client.receiptOutbox.count({where:{id:outbox}}),1);
    await restarted.readOne(recipient,n);
    assert.equal(await restarted.unreadCount(recipient),0);
    assert.equal(await client.notification.count({where:{dedupeKey:`follow:${actor}:${recipient}`}}),1);
  } finally { globalThis.__receiptTest.prisma=prisma; await client.$disconnect(); await store.close(); }
});


test('notification outbox insertion failure rolls back the interaction, comment and share message', async () => {
  const post=await postService.createPost(sender,{content:'transaction rollback'});
  const c=await conversation(); const before=await prisma.message.count({where:{conversationId:c.id}});
  await db.exec(`CREATE FUNCTION fail_notification_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.payload->>'kind'='notification' THEN RAISE EXCEPTION 'injected notification failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER fail_notification BEFORE INSERT ON receipt_outbox FOR EACH ROW EXECUTE FUNCTION fail_notification_outbox();`);
  try {
    await assert.rejects(postService.likePost(post.id,reader));
    assert.equal(await prisma.like.count({where:{postId:post.id,userId:reader}}),0);
    await assert.rejects(postService.addComment(post.id,reader,'rollback comment'));
    assert.equal(await prisma.comment.count({where:{postId:post.id}}),0);
    await assert.rejects(postService.sharePost(post.id,reader,c.id));
    assert.equal(await prisma.message.count({where:{conversationId:c.id}}),before);
    assert.equal((await prisma.post.findUnique({where:{id:post.id}})).shareCount,0);
    assert.equal(await prisma.notification.count({where:{postId:post.id}}),0);
  } finally { await db.exec('DROP TRIGGER fail_notification ON receipt_outbox; DROP FUNCTION fail_notification_outbox();'); }
});

test('notification lifecycle migration preserves legacy read state and backfills identifiable retry keys', async () => {
  const old=new PGlite();
  try {
    for(const dir of readdirSync('prisma/migrations').filter(d=>!d.endsWith('.toml')&&d!=='20261031010000_notification_lifecycle').sort()) await old.exec(readFileSync(`prisma/migrations/${dir}/migration.sql`,'utf8'));
    await old.exec(`INSERT INTO users(id,username,email,password_hash,updated_at) VALUES ('recipient','recipient','recipient@test.dev','unused',now()),('actor','actor','actor@test.dev','unused',now());
      INSERT INTO notifications(id,type,content,user_id,actor_id,is_read,created_at) VALUES
      ('older','FOLLOW','old','recipient','actor',true,'2026-10-30'),('newer','FOLLOW','new','recipient','actor',false,'2026-10-31');`);
    await old.exec(readFileSync('prisma/migrations/20261031010000_notification_lifecycle/migration.sql','utf8'));
    const result=await old.query('SELECT * FROM notifications ORDER BY created_at');
    assert.equal(result.rows.length,2); assert.equal(result.rows[0].is_read,true); assert.equal(result.rows[0].read_at,null);
    assert.equal(result.rows[1].dedupe_key,'follow:actor:recipient'); assert.equal(result.rows[0].dedupe_key,null);
    assert.equal(result.rows[1].version,1);
  } finally { await old.close(); }
});

const {pushDeviceService,enqueueMessagePush}=await import('../.cache/bundles/services/push-device.service.js');
const {processPushDeliveries}=await import('../.cache/bundles/services/push-delivery.service.js');
const {setDeviceView,clearDeviceView}=await import('../.cache/bundles/services/delivery-state.service.js');
const {default:pushRouter}=await import('../.cache/bundles/routes/push.routes.js');
const pushProject=randomUUID();
function registration(deviceId=randomUUID(), token=`ExpoPushToken[token_${randomUUID().replaceAll('-','')}]`) {
  return {deviceId,token,projectId:pushProject,platform:'android'};
}
async function withPush(run) {
  const fetchBefore=globalThis.fetch;
  process.env.PUSH_ENABLED='true'; process.env.EXPO_PROJECT_ID=pushProject;
  await prisma.user.updateMany({where:{id:{in:ids}},data:{messagePushEnabled:true,pushPreviewsEnabled:false}});
  const sends=[]; const lookups=[]; let responder;
  globalThis.fetch=async(url,init)=>{
    if(!String(url).startsWith('https://exp.host/')) return fetchBefore(url,init);
    const body=JSON.parse(init.body);
    if(String(url).endsWith('/send')) sends.push(body); else lookups.push(body);
    if(responder) return responder(String(url),body);
    return new Response(JSON.stringify({data:String(url).endsWith('/send')?{status:'ok',id:`ticket-${sends.length}-${randomUUID()}`}:
      Object.fromEntries(body.ids.map(id=>[id,{status:'ok'}]))}),{status:200,headers:{'Content-Type':'application/json'}});
  };
  try { await run({sends,lookups,setResponder:fn=>{responder=fn;}}); }
  finally {
    globalThis.fetch=fetchBefore; process.env.PUSH_ENABLED='false'; kafkaFails=false; deliveryRedisFails=false; deliveryValues.clear();
    await prisma.pushDelivery.updateMany({where:{status:{in:['QUEUED','SENDING','RECEIPT_PENDING']}},data:{status:'CANCELLED',claimToken:null,leaseUntil:null}});
    await prisma.pushDevice.deleteMany({where:{userId:{in:ids}}});
  }
}
async function duePush(messageId) { await prisma.pushDelivery.updateMany({where:{messageId},data:{availableAt:new Date(0)}}); }

 test('push devices HTTP: authentication, token ownership, project validation, privacy and logout', async()=>withPush(async()=>{
  const app=express();app.use(express.json());app.use('/push',pushRouter);
  const {ZodError}=await import('zod');
  app.use((err,req,res,next)=>res.status(err.statusCode??(err instanceof ZodError?400:500)).json({success:false,message:err.message}));
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.on('listening',resolve));
  const base=`http://127.0.0.1:${server.address().port}/push`;
  const headers=id=>({Authorization:`Bearer ${jwt.sign({userId:id,username:id},process.env.JWT_SECRET)}`,'Content-Type':'application/json'});
  const input=registration();
  const register=(id,body)=>fetch(`${base}/devices`,{method:'POST',headers:headers(id),body:JSON.stringify(body)});
  try {
    assert.equal((await fetch(`${base}/devices`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)})).status,401);
    const response=await register(reader,{...input,userId:sender});assert.equal(response.status,200);
    const returned=await response.json();assert.equal(returned.data.deviceId,input.deviceId);assert.ok(!JSON.stringify(returned).includes(input.token));
    assert.equal((await prisma.pushDevice.findUnique({where:{deviceId:input.deviceId}})).userId,reader);
    assert.equal((await register(reader,input)).status,200);
    assert.equal(await prisma.pushDevice.count({where:{deviceId:input.deviceId}}),1);
    assert.equal((await register(stranger,input)).status,409);
    assert.equal((await register(reader,{...registration(),projectId:randomUUID()})).status,409);
    assert.equal((await register(reader,{...registration(),token:'not-a-token'})).status,400);
    assert.equal((await register(reader,{...registration(),deliveryMode:'unsupported'})).status,400);
    await fetch(`${base}/devices/${input.deviceId}`,{method:'DELETE',headers:headers(stranger)});
    assert.equal(await prisma.pushDevice.count({where:{deviceId:input.deviceId}}),1);
    const prefs=await(await fetch(`${base}/preferences`,{headers:headers(reader)})).json();assert.equal(prefs.data.pushPreviewsEnabled,false);
    await fetch(`${base}/preferences`,{method:'PATCH',headers:headers(reader),body:JSON.stringify({pushPreviewsEnabled:true})});
    assert.equal((await pushDeviceService.preferences(reader)).pushPreviewsEnabled,true);
    await fetch(`${base}/devices/${input.deviceId}`,{method:'DELETE',headers:headers(reader)});
    assert.equal(await prisma.pushDevice.count({where:{deviceId:input.deviceId}}),0);
  } finally {await new Promise(resolve=>server.close(resolve));}
}));

for(const groupMode of [false,true]) for(const type of ['TEXT','IMAGE','VIDEO','AUDIO','DOCUMENT','SHARED_POST','SHARED_STORY']) {
  test(`push ${groupMode?'group':'private'} ${type}: committed job, navigation, independent devices and privacy`,async()=>withPush(async({sends})=>{
    const a=registration();const b=registration();await pushDeviceService.register(reader,a);await pushDeviceService.register(reader,b);
    await pushDeviceService.register(sender,registration());
    if(groupMode) await pushDeviceService.register(third,registration());
    const c=await conversation(groupMode);if(groupMode) await prisma.conversation.update({where:{id:c.id},data:{groupName:'Study group'}});
    const m=await service.sendMessage(c.id,sender,'private text must not leak',reader,{type,mediaUrl:type==='TEXT'?undefined:'https://example.com/media'});
    const expected=groupMode?3:2;assert.equal(await prisma.pushDelivery.count({where:{messageId:m.id}}),expected);
    await prisma.$transaction(tx=>enqueueMessagePush(tx,m.id,groupMode?[reader,third]:[reader]));
    assert.equal(await prisma.pushDelivery.count({where:{messageId:m.id}}),expected);
    await duePush(m.id);await processPushDeliveries();await processPushDeliveries();
    assert.equal(sends.length,expected);assert.ok(!sends.some(s=>s.to.includes('undefined')));
    for(const p of sends) {
      assert.equal(p.title,'New message');assert.equal(p.body,'You have a new message');
      assert.deepEqual(Object.keys(p.data).sort(),['contractVersion','recipientUserId','deviceId','groupKey','categoryIdentifier','deliveryMode','conversationId','conversationType','messageId','notificationId','notificationType','senderId'].sort());
      assert.equal(p.data.messageId,m.id);assert.equal(p.data.senderId,sender);assert.equal(p.data.conversationId,c.id);
      assert.equal(p.data.conversationType,groupMode?'group':'private');assert.equal(p.channelId,'messages');
      assert.ok(!JSON.stringify(p).includes('private text must not leak'));
    }
    assert.equal(await prisma.pushDelivery.count({where:{messageId:m.id,status:'RECEIPT_PENDING'}}),expected);
    await duePush(m.id);await processPushDeliveries();assert.equal(sends.length,expected);
    assert.equal(await prisma.pushDelivery.count({where:{messageId:m.id,status:'RECEIPT_OK'}}),expected);
  }));
}

test('push previews: opt-in sender/group labels and voice/image/video preview text',async()=>withPush(async({sends})=>{
  await pushDeviceService.register(reader,registration());await pushDeviceService.updatePreferences(reader,{pushPreviewsEnabled:true});
  const c=await conversation(true);await prisma.conversation.update({where:{id:c.id},data:{groupName:'Friends'}});
  for(const [type,body] of [['IMAGE','Sent a photo'],['VIDEO','Sent a video'],['AUDIO','Sent a voice message']]) {
    const m=await service.sendMessage(c.id,sender,'',reader,{type,mediaUrl:'https://example.com/file'});
    await duePush(m.id);await processPushDeliveries();assert.equal(sends.at(-1).body,body);assert.ok(sends.at(-1).title.includes('Friends'));
  }
}));

test('push: Kafka and provider rejection do not roll back messages; safe backoff and retries',async()=>withPush(async({sends,setResponder})=>{
  await pushDeviceService.register(reader,registration());const c=await conversation();kafkaFails=true;
  const m=await service.sendMessage(c.id,sender,'persist despite Kafka outage',reader);
  assert.ok(await prisma.message.findUnique({where:{id:m.id}}));assert.ok(await prisma.receiptOutbox.count());
  setResponder(()=>new Response('',{status:429}));await duePush(m.id);await processPushDeliveries();
  const retry=await prisma.pushDelivery.findFirst({where:{messageId:m.id}});assert.equal(retry.status,'QUEUED');assert.ok(retry.availableAt>Date.now());
  setResponder(()=>new Response(JSON.stringify({data:{status:'ok',id:'retry-ticket'}}),{status:200}));
  await duePush(m.id);await Promise.all([processPushDeliveries(),processPushDeliveries()]);
  assert.equal(sends.length,2);assert.equal((await prisma.pushDelivery.findFirst({where:{messageId:m.id}})).status,'RECEIPT_PENDING');
  kafkaFails=false;await prisma.receiptOutbox.updateMany({data:{availableAt:new Date(0)}});await publishReceipts();
  assert.ok(events.some(e=>e.name==='chatMessage'&&e.payload.messageId===m.id));
}));

test('push: transport uncertainty and expired send lease never blindly duplicate sends',async()=>withPush(async({sends,setResponder})=>{
  await pushDeviceService.register(reader,registration());const c=await conversation();const m=await service.sendMessage(c.id,sender,'uncertain',reader);
  setResponder(()=>{throw Error('timeout after provider may have accepted');});await duePush(m.id);await processPushDeliveries();await duePush(m.id);await processPushDeliveries();
  assert.equal(sends.length,1);assert.equal((await prisma.pushDelivery.findFirst({where:{messageId:m.id}})).status,'UNKNOWN');
  const m2=await service.sendMessage(c.id,sender,'claimed before crash',reader);
  await prisma.pushDelivery.updateMany({where:{messageId:m2.id},data:{status:'SENDING',claimToken:'lost-worker',leaseUntil:new Date(0)}});
  await processPushDeliveries();assert.equal((await prisma.pushDelivery.findFirst({where:{messageId:m2.id}})).status,'UNKNOWN');assert.equal(sends.length,1);
}));

test('push: token refresh retargets unsent jobs and old receipt errors cannot invalidate a new token',async()=>withPush(async({sends,setResponder})=>{
  const input=registration();await pushDeviceService.register(reader,input);const c=await conversation();const first=await service.sendMessage(c.id,sender,'first',reader);
  await duePush(first.id);await processPushDeliveries();
  const second=await service.sendMessage(c.id,sender,'refresh before send',reader);
  const updated={...input,token:registration().token};await pushDeviceService.register(reader,updated);
  setResponder((url,body)=>new Response(JSON.stringify({data:url.endsWith('/send')?{status:'ok',id:'new-ticket'}:
    Object.fromEntries(body.ids.map(id=>[id,{status:'error',details:{error:'DeviceNotRegistered'}}]))}),{status:200}));
  await duePush(first.id);await processPushDeliveries();
  assert.equal((await prisma.pushDevice.findUnique({where:{deviceId:input.deviceId}})).enabled,true);
  await duePush(second.id);await processPushDeliveries();assert.equal(sends.at(-1).to,updated.token);
  await duePush(second.id);await processPushDeliveries();
  const invalid=await prisma.pushDevice.findUnique({where:{deviceId:input.deviceId}});assert.equal(invalid.enabled,false);assert.equal(invalid.token,null);
}));

test('push: read, hidden, deleted, opted-out and departed recipients are suppressed',async()=>withPush(async({sends})=>{
  await pushDeviceService.register(reader,registration());
  for(const mode of ['read','hidden','deleted','optout','departed']) {
    await pushDeviceService.updatePreferences(reader,{messagePushEnabled:true});
    const c=await conversation();const m=await service.sendMessage(c.id,sender,'suppression',reader);
    if(mode==='read') await service.markMessageRead(c.id,reader,m.id);
    if(mode==='hidden') await service.deleteMessage(m.id,reader,'me');
    if(mode==='deleted') await service.deleteMessage(m.id,sender,'everyone');
    if(mode==='optout') await pushDeviceService.updatePreferences(reader,{messagePushEnabled:false});
    if(mode==='departed') await prisma.conversationParticipant.update({where:{conversationId_userId:{conversationId:c.id,userId:reader}},data:{deletedAt:new Date()}});
    await duePush(m.id);await processPushDeliveries();assert.equal((await prisma.pushDelivery.findFirst({where:{messageId:m.id}})).status,'CANCELLED');
  }
  assert.equal(sends.length,0);
}));

test('push visibility: per-device foreground suppression, background/terminated delivery and Redis fail-open',async()=>withPush(async({sends})=>{
  const a=registration();const b=registration();await pushDeviceService.register(reader,a);await pushDeviceService.register(reader,b);
  const active=await prisma.pushDevice.findUnique({where:{deviceId:a.deviceId}});const c=await conversation();
  await setDeviceView(active.id,'foreground-socket',c.id);
  const m=await service.sendMessage(c.id,sender,'active device',reader);await duePush(m.id);await processPushDeliveries();
  assert.equal(sends.length,1);assert.equal(sends[0].to,b.token);
  await clearDeviceView(active.id,'older-socket');assert.ok(deliveryValues.has(`push:view:${active.id}`));
  await clearDeviceView(active.id,'foreground-socket');
  const background=await service.sendMessage(c.id,sender,'background',reader);await duePush(background.id);await processPushDeliveries();assert.equal(sends.length,3);
  await setDeviceView(active.id,'stale-socket',c.id);deliveryValues.get(`push:view:${active.id}`).expires=0;
  const terminated=await service.sendMessage(c.id,sender,'terminated lease expired',reader);await duePush(terminated.id);await processPushDeliveries();assert.equal(sends.length,5);
  deliveryRedisFails=true;const failed=await service.sendMessage(c.id,sender,'redis unavailable',reader);await duePush(failed.id);await processPushDeliveries();assert.equal(sends.length,7);
}));


test('message:new canonical media/reply DTO, sender exclusion, forged routing and concurrent Kafka retries',async()=>{
  const c=await conversation(true);
  const original=await service.sendMessage(c.id,sender,'original',reader,{type:'IMAGE',mediaUrl:'https://example.com/original.jpg',thumbnailUrl:'https://example.com/thumb.jpg',duration:2,fileName:'original.jpg',fileMimeType:'image/jpeg',fileSize:20});
  const reply=await service.replyMessage(c.id,third,'reply',original.id,reader,{type:'AUDIO',mediaUrl:'https://example.com/voice.m4a',duration:4});
  const event=events.find(e=>e.name==='chatMessage'&&e.payload.messageId===reply.id&&e.payload.receiverId===reader).payload;
  const received=[];const io={to:room=>({emit:(name,payload)=>received.push({room,name,payload})})};
  const attempts=await Promise.allSettled([routeEvent(io,'chat.messages',event),routeEvent(io,'chat.messages',event)]);
  for(const result of attempts) if(result.status==='rejected') await routeEvent(io,'chat.messages',event);
  await routeEvent(io,'chat.messages',event);
  assert.equal(received.filter(e=>e.name==='message:new').length,1);
  assert.ok(received.every(e=>e.room===`user:${reader}`));
  const history=(await service.getMessages(c.id,reader,1,100)).messages.find(m=>m.id===reply.id);
  const live=received.find(e=>e.name==='message:new').payload;
  for(const key of ['id','conversationId','senderId','type','content','mediaUrl','thumbnailUrl','duration','fileName','fileMimeType','fileSize','repliedTo','sender','status','readByMe']) {
    assert.deepEqual(JSON.parse(JSON.stringify(live[key])),JSON.parse(JSON.stringify(history[key])));
  }
  await routeEvent(io,'chat.messages',{...event,receiverId:third});
  await routeEvent(io,'chat.messages',{...event,receiverId:stranger});
  assert.equal(received.filter(e=>e.name==='message:new').length,1);
});

test('visibility socket contract: real JWT, member/device ownership and background clears lease',async()=>withPush(async()=>{
  const {authenticateSocket}=await import('../.cache/bundles/socket/authenticate.js');
  const {registerPushHandlers}=await import('../.cache/bundles/socket/push.handler.js');
  const input=registration();await pushDeviceService.register(reader,input);
  const device=await prisma.pushDevice.findUnique({where:{deviceId:input.deviceId}});
  const c=await conversation();const foreign=await prisma.conversation.create({data:{participants:{create:[{userId:sender},{userId:stranger}]}}});
  const server=createServer();const io=new Server(server);io.use(authenticateSocket);io.on('connection',socket=>registerPushHandlers(socket));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const clients=[];const connect=id=>new Promise((resolve,reject)=>{const client=clientIO(`http://127.0.0.1:${server.address().port}`,{auth:{token:jwt.sign({userId:id,username:id},process.env.JWT_SECRET)}});clients.push(client);client.once('connect',()=>resolve(client));client.once('connect_error',reject);});
  try {
    const client=await connect(reader);const wrong=await connect(stranger);
    assert.equal((await wrong.emitWithAck('conversation:visibility',{deviceId:input.deviceId,state:'foreground',conversationId:c.id})).success,false);
    assert.equal((await client.emitWithAck('conversation:visibility',{deviceId:input.deviceId,state:'foreground',conversationId:foreign.id})).success,false);
    assert.equal((await client.emitWithAck('conversation:visibility',{deviceId:input.deviceId,state:'foreground',conversationId:c.id})).success,true);
    assert.ok(await deliveryRedis.get(`push:view:${device.id}`));
    assert.equal((await client.emitWithAck('conversation:visibility',{deviceId:input.deviceId,state:'background'})).success,true);
    assert.equal(await deliveryRedis.get(`push:view:${device.id}`),null);
    deliveryRedisFails=true;
    assert.equal((await client.emitWithAck('conversation:visibility',{deviceId:input.deviceId,state:'foreground',conversationId:c.id})).success,false);
    deliveryRedisFails=false;
  } finally {clients.forEach(client=>client.disconnect());await new Promise(resolve=>io.close(resolve));}
}));

test('Expo provider errors: invalid token cleanup, permanent credentials failure, missing receipt and receipt retries',async()=>withPush(async({sends,setResponder})=>{
  const input=registration();await pushDeviceService.register(reader,input);const c=await conversation();
  setResponder(()=>new Response(JSON.stringify({data:{status:'error',details:{error:'DeviceNotRegistered'}}}),{status:200}));
  const invalid=await service.sendMessage(c.id,sender,'invalid token',reader);await duePush(invalid.id);await processPushDeliveries();
  assert.equal((await prisma.pushDevice.findUnique({where:{deviceId:input.deviceId}})).token,null);
  assert.equal((await prisma.pushDelivery.findFirst({where:{messageId:invalid.id}})).status,'FAILED');
  await pushDeviceService.register(reader,{...input,token:registration().token});
  setResponder(()=>new Response('',{status:401}));const badCredentials=await service.sendMessage(c.id,sender,'bad credentials',reader);await duePush(badCredentials.id);await processPushDeliveries();
  assert.equal((await prisma.pushDelivery.findFirst({where:{messageId:badCredentials.id}})).errorCode,'InvalidCredentials');
  setResponder((url)=>new Response(JSON.stringify({data:url.endsWith('/send')?{status:'ok',id:'waiting-ticket'}:{}}),{status:200}));
  const waiting=await service.sendMessage(c.id,sender,'receipt pending',reader);await duePush(waiting.id);await processPushDeliveries();
  const count=sends.length;await duePush(waiting.id);await processPushDeliveries();assert.equal(sends.length,count);
  assert.equal((await prisma.pushDelivery.findFirst({where:{messageId:waiting.id}})).status,'RECEIPT_PENDING');
  setResponder(()=>{throw Error('receipt outage');});await duePush(waiting.id);await processPushDeliveries();assert.equal(sends.length,count);
  assert.equal((await prisma.pushDelivery.findFirst({where:{messageId:waiting.id}})).errorCode,'ReceiptLookupFailed');
}));

test('push disabled explicitly rejects registration and production configuration requires credentials',async()=>{
  const {validatePushConfig}=await import('../.cache/bundles/config/push.js');
  const old={enabled:process.env.PUSH_ENABLED,env:process.env.NODE_ENV,project:process.env.EXPO_PROJECT_ID,token:process.env.EXPO_ACCESS_TOKEN};
  try {
    process.env.PUSH_ENABLED='false';await assert.rejects(pushDeviceService.register(reader,registration()),/not enabled/);
    process.env.PUSH_ENABLED='true';process.env.NODE_ENV='production';process.env.EXPO_PROJECT_ID=pushProject;delete process.env.EXPO_ACCESS_TOKEN;
    assert.throws(validatePushConfig,/EXPO_ACCESS_TOKEN/);
    process.env.EXPO_ACCESS_TOKEN='not-a-real-provider-credential';assert.doesNotThrow(validatePushConfig);
  } finally {
    for(const [key,value] of Object.entries({PUSH_ENABLED:old.enabled,NODE_ENV:old.env,EXPO_PROJECT_ID:old.project,EXPO_ACCESS_TOKEN:old.token})) {
      if(value===undefined) delete process.env[key];else process.env[key]=value;
    }
  }
});

test('push registration errors do not expose tokens or database details',async()=>withPush(async()=>{
  const input=registration();
  await db.exec(`CREATE FUNCTION fail_push_device() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'internal database error with %',NEW.token; END $$; CREATE TRIGGER fail_device BEFORE INSERT ON push_devices FOR EACH ROW EXECUTE FUNCTION fail_push_device();`);
  try {await assert.rejects(pushDeviceService.register(reader,input),error=>error.message==='Device registration failed'&&!error.message.includes(input.token));}
  finally {await db.exec('DROP TRIGGER fail_device ON push_devices; DROP FUNCTION fail_push_device();');}
}));

test('push retry budget stops confirmed rejections and does not loop indefinitely',async()=>withPush(async({sends,setResponder})=>{
  await pushDeviceService.register(reader,registration());const c=await conversation();const m=await service.sendMessage(c.id,sender,'rate limited',reader);
  setResponder(()=>new Response('',{status:429}));
  for(let i=0;i<6;i++){await duePush(m.id);await processPushDeliveries();}
  assert.equal(sends.length,5);const job=await prisma.pushDelivery.findFirst({where:{messageId:m.id}});assert.equal(job.status,'FAILED');assert.equal(job.attempts,5);
}));

async function notificationReplyFixture(isGroup=false) {
  const input=registration(); await pushDeviceService.register(reader,input);
  const c=await conversation(isGroup);
  const original=await service.sendMessage(c.id,sender,'incoming',reader);
  const job=await prisma.pushDelivery.findFirst({where:{messageId:original.id,device:{deviceId:input.deviceId}}});
  const action={contractVersion:2,actionId:randomUUID(),recipientUserId:reader,deviceId:input.deviceId,notificationId:job.id};
  const reply=(text='response',overrides={})=>service.replyMessage(c.id,reader,text,original.id,undefined,{notificationAction:{...action,...overrides}});
  return {input,c,original,job,action,reply};
}
for(const groupMode of [false,true]) test(`notification reply ${groupMode?'group':'private'}: idempotent persistence, routing and not read`,async()=>withPush(async()=>{
  await pushDeviceService.register(sender,registration()); if(groupMode) await pushDeviceService.register(third,registration());
  const f=await notificationReplyFixture(groupMode);
  const first=await f.reply();const jobs=await prisma.pushDelivery.count({where:{messageId:first.id}});
  const outbox=await prisma.receiptOutbox.count();
  assert.equal((await f.reply()).id,first.id);
  assert.equal(await prisma.message.count({where:{conversationId:f.c.id,senderId:reader}}),1);
  assert.equal(await prisma.notificationReplyAction.count({where:{userId:reader,actionId:f.action.actionId}}),1);
  assert.equal(await prisma.receiptOutbox.count(),outbox);
  assert.equal(await prisma.pushDelivery.count({where:{messageId:first.id}}),jobs);
  assert.equal(jobs,groupMode?2:1);
  const receipts=await prisma.messageReceipt.findMany({where:{messageId:first.id}});
  assert.deepEqual(receipts.map(r=>r.userId).sort(),(groupMode?[sender,third]:[sender]).sort());
  assert.equal((await prisma.messageReceipt.findUnique({where:{messageId_userId:{messageId:f.original.id,userId:reader}}})).readAt,null);
  assert.equal((await prisma.conversationParticipant.findUnique({where:{conversationId_userId:{conversationId:f.c.id,userId:reader}}})).lastReadAt,null);
  await assert.rejects(f.reply('different'),e=>e.statusCode===409);
  await assert.rejects(prisma.notificationReplyAction.create({data:{userId:reader,actionId:f.action.actionId,requestHash:'other',messageId:randomUUID()}}),e=>e.code==='P2002');
}));

test('notification reply HTTP: lost post-commit response, retry same action and validation/authentication',async()=>withPush(async()=>{
  const f=await notificationReplyFixture();const app=express();app.use(express.json());
  let drop=true;
  app.use((req,res,next)=>{if(drop){drop=false;res.json=()=>{res.socket.destroy();return res;};}next();});
  app.use('/messages',router);
  const {ZodError}=await import('zod');
  app.use((err,req,res,next)=>res.status(err.statusCode??(err instanceof ZodError?400:500)).json({success:false,message:'Rejected'}));
  const http=app.listen(0,'127.0.0.1');await new Promise(resolve=>http.on('listening',resolve));
  const url=`http://127.0.0.1:${http.address().port}/messages/conversations/${f.c.id}/reply`;
  const body={content:'sent after lost response',type:'TEXT',repliedToId:f.original.id,notificationAction:f.action};
  const headers={Authorization:`Bearer ${jwt.sign({userId:reader,username:reader},process.env.JWT_SECRET)}`,'Content-Type':'application/json'};
  const post=(data=body,auth=headers)=>fetch(url,{method:'POST',headers:auth,body:JSON.stringify(data)});
  try {
    await assert.rejects(post());
    const ledger=await prisma.notificationReplyAction.findUnique({where:{userId_actionId:{userId:reader,actionId:f.action.actionId}}});assert.ok(ledger);
    const response=await post();assert.equal(response.status,201);assert.equal((await response.json()).data.id,ledger.messageId);
    assert.equal(await prisma.message.count({where:{conversationId:f.c.id,senderId:reader}}),1);
    assert.equal((await post({...body,notificationAction:{...f.action,actionId:'bad'}})).status,400);
    assert.equal((await post({...body,mediaUrl:'https://example.com/photo.jpg'})).status,400);
    assert.equal((await post(body,{'Content-Type':'application/json'})).status,401);
  } finally {await new Promise(resolve=>http.close(resolve));}
}));

test('notification reply: rollback includes action key, message, receipts and push/outbox intents',async()=>withPush(async()=>{
  const f=await notificationReplyFixture();const before=await prisma.receiptOutbox.count();
  await assert.rejects(service.sendMessage(f.c.id,reader,'response',undefined,{repliedToId:f.original.id,notificationAction:f.action},async()=>{throw new Error('injected transaction failure');}));
  assert.equal(await prisma.notificationReplyAction.count({where:{userId:reader,actionId:f.action.actionId}}),0);
  assert.equal(await prisma.message.count({where:{conversationId:f.c.id,senderId:reader}}),0);
  assert.equal(await prisma.receiptOutbox.count(),before);
  assert.ok((await f.reply()).id);
}));

test('notification reply: account/device/notification binding, logout, rotation and membership changes',async()=>withPush(async()=>{
  const f=await notificationReplyFixture(true);
  await assert.rejects(f.reply('response',{recipientUserId:sender}),e=>e.statusCode===403);
  await assert.rejects(f.reply('response',{deviceId:randomUUID()}),e=>e.statusCode===403);
  await assert.rejects(f.reply('response',{notificationId:randomUUID()}),e=>e.statusCode===403);
  await assert.rejects(service.replyMessage(f.c.id,stranger,'attack',f.original.id,undefined,{notificationAction:{...f.action,recipientUserId:stranger}}));
  const another=await conversation();const foreign=await service.sendMessage(another.id,sender,'other',reader);
  await assert.rejects(service.replyMessage(another.id,reader,'attack',foreign.id,undefined,{notificationAction:f.action}),e=>e.statusCode===403);
  await pushDeviceService.register(reader,{...f.input,token:registration().token});
  const sent=await f.reply();assert.ok(sent.id);assert.equal((await f.reply()).id,sent.id);
  await prisma.conversationParticipant.update({where:{conversationId_userId:{conversationId:f.c.id,userId:third}},data:{deletedAt:new Date()}});
  const afterRemoval=await f.reply('second',{actionId:randomUUID()});
  assert.deepEqual((await prisma.messageReceipt.findMany({where:{messageId:afterRemoval.id}})).map(r=>r.userId),[sender]);
  await prisma.conversationParticipant.update({where:{conversationId_userId:{conversationId:f.c.id,userId:reader}},data:{deletedAt:new Date()}});
  await assert.rejects(f.reply(),e=>e.statusCode===403);
  await prisma.conversationParticipant.update({where:{conversationId_userId:{conversationId:f.c.id,userId:reader}},data:{deletedAt:null}});
  await pushDeviceService.unregister(reader,f.input.deviceId);await assert.rejects(f.reply(),e=>e.statusCode===403);
}));

test('notification reply: deleted/hidden original rejected; deleted sent reply never recreated',async()=>withPush(async()=>{
  const f=await notificationReplyFixture();const sent=await f.reply();
  await prisma.message.delete({where:{id:sent.id}});
  await assert.rejects(f.reply(),e=>e.statusCode===410);
  assert.equal(await prisma.notificationReplyAction.count({where:{userId:reader,actionId:f.action.actionId}}),1);
  await service.deleteMessage(f.original.id,reader,'me');
  await assert.rejects(f.reply('new',{actionId:randomUUID()}),e=>e.statusCode===403);
  await prisma.conversation.delete({where:{id:f.c.id}});
  await assert.rejects(f.reply());
  assert.equal(await prisma.notificationReplyAction.count({where:{userId:reader,actionId:f.action.actionId}}),1);
}));

test('push v2: opt-in data-only wire shape, per-conversation/account grouping, privacy, multiple devices and rollback to alerts',async()=>withPush(async({sends})=>{
  const a={...registration(),deliveryMode:'android-data-v2'},b=registration();
  await pushDeviceService.register(reader,a);await pushDeviceService.register(reader,b);await pushDeviceService.register(third,{...registration(),deliveryMode:'android-data-v2'});
  const group=await conversation(true),dm=await conversation();
  const messages=[];
  for(const c of [group,group,dm]){const m=await service.sendMessage(c.id,sender,'secret preview',reader);messages.push(m);await duePush(m.id);await processPushDeliveries();}
  const own=sends.filter(p=>p.data.recipientUserId===reader&&p.data.deviceId===a.deviceId);
  assert.equal(own.length,3);assert.equal(own[0].data.groupKey,own[1].data.groupKey);assert.notEqual(own[0].data.groupKey,own[2].data.groupKey);
  const other=sends.find(p=>p.data.recipientUserId===third);assert.notEqual(other.data.groupKey,own[0].data.groupKey);
  for(const p of own){
    assert.deepEqual(Object.keys(p).sort(),['_contentAvailable','data','priority','to','ttl'].sort());assert.equal(p._contentAvailable,true);
    assert.equal(p.data.contractVersion,2);assert.equal(p.data.categoryIdentifier,'MESSAGE_REPLY_V2');
    assert.equal(p.data.groupKey,`socialapp:v2:${reader}:${p.data.conversationId}`);
    assert.deepEqual(p.data.display,{title:'New message',body:'You have a new message',channelId:'messages'});
    assert.ok(!JSON.stringify(p).includes('secret preview'));assert.ok(!('collapseId' in p)&&!('tag' in p));
    const peer=sends.find(s=>s.data.deviceId===b.deviceId&&s.data.messageId===p.data.messageId);
    assert.equal(peer.data.groupKey,p.data.groupKey);assert.notEqual(peer.data.notificationId,p.data.notificationId);assert.equal(peer.data.deliveryMode,'expo-alert');
  }
  await pushDeviceService.updatePreferences(reader,{pushPreviewsEnabled:true});
  const preview=await service.sendMessage(dm.id,sender,'opted in',reader);await duePush(preview.id);await processPushDeliveries();
  assert.equal(sends.find(p=>p.data.messageId===preview.id&&p.data.deviceId===a.deviceId).data.display.body,'opted in');
  await pushDeviceService.register(reader,a);assert.equal((await prisma.pushDevice.findUnique({where:{deviceId:a.deviceId}})).deliveryMode,'android-data-v2');
  await pushDeviceService.register(reader,{...a,deliveryMode:undefined});
  const fallback=await service.sendMessage(dm.id,sender,'fallback',reader);await duePush(fallback.id);await processPushDeliveries();
  assert.equal(sends.find(p=>p.data.messageId===fallback.id&&p.data.deviceId===a.deviceId).data.deliveryMode,'expo-alert');
  await pushDeviceService.updatePreferences(reader,{messagePushEnabled:false});
  const optedOut=await service.sendMessage(dm.id,sender,'no push',reader);
  assert.equal(await prisma.pushDelivery.count({where:{messageId:optedOut.id}}),0);
}));

test('notification reply: same-account second device cannot reuse action; distinct accounts can use same action UUID',async()=>withPush(async()=>{
  const f=await notificationReplyFixture(true);const first=await f.reply();
  const second=registration();await pushDeviceService.register(reader,second);
  await assert.rejects(f.reply('response',{deviceId:second.deviceId}),e=>e.statusCode===409);
  await pushDeviceService.register(third,registration());
  const next=await service.sendMessage(f.c.id,sender,'second incoming',reader);
  const job=await prisma.pushDelivery.findFirst({where:{messageId:next.id,device:{userId:third}} ,include:{device:true}});
  const theirs=await service.replyMessage(f.c.id,third,'their response',next.id,undefined,{notificationAction:{...f.action,deviceId:job.device.deviceId,notificationId:job.id,recipientUserId:third}});
  assert.notEqual(first.id,theirs.id);
  assert.equal(await prisma.notificationReplyAction.count({where:{actionId:f.action.actionId}}),2);
}));

test('notification reply migration preserves legacy device/token and defaults to alert mode',async()=>{
  const old=new PGlite();
  try{
    for(const dir of readdirSync('prisma/migrations').filter(d=>!d.endsWith('.toml')&&d!=='20261102000000_notification_reply_contract').sort())await old.exec(readFileSync(`prisma/migrations/${dir}/migration.sql`,'utf8'));
    await old.exec(`INSERT INTO users(id,username,email,password_hash,updated_at) VALUES ('legacy','legacy','legacy@test.dev','unused',now());
      INSERT INTO push_devices(id,user_id,device_id,token,token_version,updated_at) VALUES ('row','legacy','device','ExpoPushToken[legacy]',7,now());`);
    await old.exec(readFileSync('prisma/migrations/20261102000000_notification_reply_contract/migration.sql','utf8'));
    const {rows}=await old.query('SELECT * FROM push_devices');assert.equal(rows.length,1);assert.equal(rows[0].token,'ExpoPushToken[legacy]');assert.equal(rows[0].token_version,7);assert.equal(rows[0].delivery_mode,'expo-alert');
    assert.equal((await old.query('SELECT * FROM notification_reply_actions')).rows.length,0);
  }finally{await old.close();}
});

test('notification reply: actual HTTP timeout after commit safely retries the same action',async()=>withPush(async()=>{
  const f=await notificationReplyFixture();const app=express();app.use(express.json());let stall=true;
  app.use((req,res,next)=>{if(stall){stall=false;res.json=()=>res;}next();});app.use('/messages',router);
  const http=app.listen(0,'127.0.0.1');await new Promise(resolve=>http.on('listening',resolve));
  const url=`http://127.0.0.1:${http.address().port}/messages/conversations/${f.c.id}/reply`;
  const init={method:'POST',headers:{Authorization:`Bearer ${jwt.sign({userId:reader,username:reader},process.env.JWT_SECRET)}`,'Content-Type':'application/json'},body:JSON.stringify({content:'timeout response',repliedToId:f.original.id,notificationAction:f.action})};
  try{
    await assert.rejects(fetch(url,{...init,signal:AbortSignal.timeout(1000)}),e=>e.name==='TimeoutError');
    const ledger=await prisma.notificationReplyAction.findUnique({where:{userId_actionId:{userId:reader,actionId:f.action.actionId}}});assert.ok(ledger);
    const retry=await fetch(url,init);assert.equal(retry.status,201);assert.equal((await retry.json()).data.id,ledger.messageId);
    assert.equal(await prisma.message.count({where:{conversationId:f.c.id,senderId:reader}}),1);
  }finally{http.closeAllConnections();await new Promise(resolve=>http.close(resolve));}
}));

const {exploreService,exploreScore,topics}=await import('../.cache/bundles/services/explore.service.js');
const {processSocialInteraction}=await import('../.cache/bundles/services/social-interaction.service.js');

test('comment likes: idempotent transitions, unique constraint, reply counts and deletion authorization',async()=>{
  const post=await postService.createPost(sender,{content:'comment engagement'});
  const comment=await postService.addComment(post.id,reader,'root');await postService.addComment(post.id,third,'reply',comment.id);
  assert.equal((await postService.setCommentLike(post.id,comment.id,reader,true)).likesCount,1);
  assert.equal((await postService.setCommentLike(post.id,comment.id,reader,true)).likesCount,1);
  assert.equal((await postService.setCommentLike(post.id,comment.id,third,true)).likesCount,2);
  await assert.rejects(prisma.commentLike.create({data:{commentId:comment.id,userId:reader}}),e=>e.code==='P2002');
  const info=await postService.commentEngagement(post.id,comment.id,reader);assert.equal(info.likesCount,2);assert.equal(info.repliesCount,1);assert.equal(info.isLikedByCurrentUser,true);
  assert.equal((await postService.getComments(post.id,stranger,1,20)).comments.find(c=>c.id===comment.id).isLikedByCurrentUser,false);
  assert.equal((await postService.setCommentLike(post.id,comment.id,reader,false)).likesCount,1);
  assert.equal((await postService.setCommentLike(post.id,comment.id,reader,false)).likesCount,1);
  const foreign=await postService.createPost(third,{content:'other'});
  await assert.rejects(postService.setCommentLike(foreign.id,comment.id,reader,true),e=>e.statusCode===404);
  await postService.deleteComment(post.id,comment.id,reader);
  await assert.rejects(postService.setCommentLike(post.id,comment.id,stranger,true),e=>e.statusCode===404);
  await assert.rejects(postService.commentEngagement(post.id,comment.id,reader),e=>e.statusCode===404);
  assert.equal((await postService.getPost(post.id,reader)).commentsCount,1);
});

test('post engagement: canonical fields and legacy aliases consistent across detail/feed/profile/liked/saved',async()=>{
  const post=await postService.createPost(sender,{content:'engagement fields'});
  await postService.likePost(post.id,reader);await postService.savePost(post.id,reader);await postService.savePost(post.id,reader);
  await postService.addComment(post.id,third,'counted');
  const read=await postService.getPost(post.id,reader);
  for(const p of [read,(await postService.getUserPosts(sender,reader,1,100)).posts.find(p=>p.id===post.id)].filter(Boolean)) {
    assert.equal(p.likesCount,1);assert.equal(p.commentsCount,1);assert.equal(p.isLikedByCurrentUser,true);assert.equal(p.isBookmarkedByCurrentUser,true);assert.equal(p.isLiked,true);assert.equal(p.isSaved,true);
  }
  // getUserPosts takes username, not UUID; test the actual account username explicitly.
  const account=await prisma.user.findUnique({where:{id:sender}});
  const profile=(await postService.getUserPosts(account.username,reader,1,100)).posts.find(p=>p.id===post.id);assert.equal(profile.isSaved,true);
  const saved=(await postService.getSavedPosts(reader,1,100)).posts.find(p=>p.id===post.id);assert.equal(saved.id,post.id);assert.equal(saved.likesCount,1);assert.ok(saved.author);assert.ok('mediaMetadata' in saved);assert.ok(!('commentId' in saved));
  const liked=(await postService.getLikedPosts(reader,1,100)).posts.find(p=>p.id===post.id);assert.equal(liked.isBookmarkedByCurrentUser,true);
  assert.equal((await postService.getPost(post.id)).isLikedByCurrentUser,false);
  await postService.unlikePost(post.id,reader);await postService.unsavePost(post.id,reader);await postService.unsavePost(post.id,reader);
  const after=await postService.getPost(post.id,reader);assert.equal(after.likesCount,0);assert.equal(after.isSaved,false);
});

test('comments and bookmarks: timestamp/id cursors, stable navigation and unavailable filtering',async()=>{
  const user=randomUUID();await prisma.user.create({data:{id:user,username:user,email:`${user}@test.dev`,passwordHash:'unused'}});
  const posts=[];for(let i=0;i<3;i++){const p=await postService.createPost(sender,{content:`saved ${i}`});posts.push(p);await postService.savePost(p.id,user);}
  const tied=new Date('2026-01-01');await prisma.savedPost.updateMany({where:{userId:user},data:{createdAt:tied}});
  const first=await postService.getSavedPosts(user,1,1);const second=await postService.getSavedPosts(user,1,1,first.nextCursor);assert.notEqual(first.posts[0].id,second.posts[0].id);assert.ok(first.nextCursor);
  const comments=[];for(let i=0;i<3;i++)comments.push(await postService.addComment(posts[0].id,reader,`comment ${i}`));
  await prisma.comment.updateMany({where:{postId:posts[0].id},data:{createdAt:tied}});
  const a=await postService.getComments(posts[0].id,reader,1,1),b=await postService.getComments(posts[0].id,reader,1,1,a.nextCursor);assert.notEqual(a.comments[0].id,b.comments[0].id);
  await postService.deletePost(posts[1].id,sender);
  const saved=await postService.getSavedPosts(user,1,50);assert.equal(saved.total,2);assert.ok(saved.posts.every(p=>p.id!==posts[1].id));
  await assert.rejects(postService.getSavedPosts(user,1,10,'bad'),e=>e.statusCode===400);
});

test('post visibility: private owner-only, suspended/deleted authors and media access filter',async()=>{
  const owner=randomUUID();await prisma.user.create({data:{id:owner,username:owner,email:`${owner}@test.dev`,passwordHash:'unused'}});
  const p=await postService.createPost(owner,{content:'private account post'});await postService.savePost(p.id,reader);
  await prisma.user.update({where:{id:owner},data:{isPrivate:true}});
  assert.equal((await postService.getPost(p.id,owner)).id,p.id);
  for(const read of [()=>postService.getPost(p.id,reader),()=>postService.getComments(p.id,reader,1,10),()=>postService.likePost(p.id,reader),()=>postService.savePost(p.id,reader)])await assert.rejects(read(),e=>e.statusCode===404);
  assert.ok(!(await postService.getSavedPosts(reader,1,100)).posts.some(post=>post.id===p.id));
  await prisma.user.update({where:{id:owner},data:{isPrivate:false,accountStatus:'SUSPENDED'}});await assert.rejects(postService.getPost(p.id),e=>e.statusCode===404);
  await prisma.user.update({where:{id:owner},data:{accountStatus:'ACTIVE',deletedAt:new Date()}});await assert.rejects(postService.getPost(p.id),e=>e.statusCode===404);
});

test('social outbox: Kafka outage cannot fail committed engagement; retries and duplicate/reordered signals converge',async()=>{
  const post=await postService.createPost(sender,{content:'#photography durable signal'});const comment=await postService.addComment(post.id,reader,'one');
  events.length=0;kafkaFails=true;
  try{await postService.setCommentLike(post.id,comment.id,reader,true);await postService.savePost(post.id,reader);}
  finally{kafkaFails=false;}
  assert.equal((await postService.commentEngagement(post.id,comment.id,reader)).likesCount,1);
  const pending=(await prisma.receiptOutbox.findMany()).filter(r=>r.payload.kind==='socialInteraction'&&r.payload.event.postId===post.id);assert.ok(pending.length>=2);
  await prisma.receiptOutbox.updateMany({where:{id:{in:pending.map(p=>p.id)}},data:{availableAt:new Date(0)}});await publishReceipts();
  const emitted=events.filter(e=>e.name==='socialInteraction'&&e.payload.postId===post.id);assert.ok(emitted.length>=2);
  await processSocialInteraction(emitted[0].payload);
  const beforeReplay=await prisma.postInterest.findUnique({where:{userId_postId:{userId:reader,postId:post.id}}});
  await processSocialInteraction(emitted[0].payload);
  assert.equal((await prisma.postInterest.findUnique({where:{userId_postId:{userId:reader,postId:post.id}}})).updatedAt.getTime(),beforeReplay.updatedAt.getTime());
  assert.equal((await prisma.postInterest.findUnique({where:{userId_postId:{userId:reader,postId:post.id}}})).weight,8);
  await postService.unsavePost(post.id,reader);await postService.setCommentLike(post.id,comment.id,reader,false);
  for(const e of emitted.reverse())await processSocialInteraction(e.payload);
  assert.equal((await prisma.postInterest.findUnique({where:{userId_postId:{userId:reader,postId:post.id}}})).weight,2);
  await assert.rejects(processSocialInteraction({type:'bad'}));
});

async function exploreFixture() {
  const viewer=randomUUID();await prisma.user.create({data:{id:viewer,username:viewer,email:`${viewer}@test.dev`,passwordHash:'unused'}});
  const old=await prisma.post.findMany({distinct:['authorId'],select:{authorId:true}});
  if(old.length)await prisma.follow.createMany({data:old.map(p=>({followerId:viewer,followingId:p.authorId})),skipDuplicates:true});
  const authors=[];for(let i=0;i<8;i++){const id=randomUUID();authors.push(id);await prisma.user.create({data:{id,username:id,email:`${id}@test.dev`,passwordHash:'unused'}});}
  const posts=[];for(let i=0;i<8;i++)posts.push(await prisma.post.create({data:{authorId:authors[i],content:`#topic${i} discovery`,imageUrls:[]}}));
  return {viewer,authors,posts};
}

test('Explore scoring: popularity, comments, recency, bounded engagement rate and hashtag affinity',()=>{
  assert.ok(exploreScore(10,5,100,1,0)>exploreScore(0,0,100,1,0));
  assert.ok(exploreScore(1,1,100,1,0)>exploreScore(1,1,100,100,0));
  assert.ok(exploreScore(1,1,100,1,5)>exploreScore(1,1,100,1,0));
  assert.ok(exploreScore(10,1,10,1,0)>exploreScore(10,1,10000,1,0));
  assert.deepEqual(topics('Hello #Tokyo #TOKYO #写真 #music'),['#tokyo','#写真','#music']);
});

test('Explore snapshot: rank order, unique pages, retry cursor, refresh excludes served and account-bound expiry',async()=>{
  const f=await exploreFixture();
  for(const userId of ids)await prisma.like.create({data:{userId,postId:f.posts[7].id}});
  const first=await exploreService.get(f.viewer,2);assert.equal(first.posts[0].id,f.posts[7].id);assert.equal(first.posts.length,2);assert.ok(first.nextCursor);
  const next=await exploreService.get(f.viewer,2,first.nextCursor);const retry=await exploreService.get(f.viewer,2,first.nextCursor);assert.deepEqual(next.posts.map(p=>p.id),retry.posts.map(p=>p.id));
  assert.ok(next.posts.every(p=>!first.posts.some(a=>a.id===p.id)));
  const refresh=await exploreService.get(f.viewer,2,undefined,true);assert.ok(refresh.posts.every(p=>![...first.posts,...next.posts].some(a=>a.id===p.id)));
  await assert.rejects(exploreService.get(reader,2,first.nextCursor),e=>e.statusCode===400);
  await assert.rejects(exploreService.get(f.viewer,2,first.nextCursor,true),e=>e.statusCode===400);
  const parsed=JSON.parse(Buffer.from(first.nextCursor,'base64url').toString());await prisma.exploreSession.update({where:{id:parsed.sessionId},data:{expiresAt:new Date(0)}});
  await assert.rejects(exploreService.get(f.viewer,2,first.nextCursor),e=>e.statusCode===400);
});

test('Explore: affinity fallback during Kafka outage, author diversity and post/follow/privacy revalidation',async()=>{
  const f=await exploreFixture();await prisma.like.create({data:{userId:f.viewer,postId:f.posts[0].id}});
  const target=await prisma.post.create({data:{authorId:f.authors[1],content:'#topic0 related',imageUrls:[]}});
  const first=await exploreService.get(f.viewer,1);assert.ok([target.id,f.posts[0].id].includes(first.posts[0].id));
  const parsed=JSON.parse(Buffer.from(first.nextCursor,'base64url').toString());const session=await prisma.exploreSession.findUnique({where:{id:parsed.sessionId}});
  const hiddenId=session.postIds[1];const hidden=await prisma.post.findUnique({where:{id:hiddenId}});await prisma.user.update({where:{id:hidden.authorId},data:{isPrivate:true}});
  const last=await exploreService.get(f.viewer,50,first.nextCursor);assert.ok(last.posts.every(p=>p.author.id!==hidden.authorId));
  const g=await exploreFixture();for(let i=0;i<12;i++)await prisma.post.create({data:{authorId:g.authors[0],content:'#dominant',imageUrls:[]}});
  const diverse=await exploreService.get(g.viewer,10);const counts=new Map();for(const p of diverse.posts)counts.set(p.author.id,(counts.get(p.author.id)??0)+1);
  assert.ok([...counts.values()].every(n=>n<=2));assert.ok(counts.size>1);
  const h=await exploreFixture();const page=await exploreService.get(h.viewer,1);
  const decoded=JSON.parse(Buffer.from(page.nextCursor,'base64url').toString());const snapshot=await prisma.exploreSession.findUnique({where:{id:decoded.sessionId}});
  const blocked=await prisma.post.findUnique({where:{id:snapshot.postIds[1]}});await prisma.follow.create({data:{followerId:h.viewer,followingId:blocked.authorId}});
  await prisma.post.update({where:{id:snapshot.postIds[2]},data:{deletedAt:new Date()}});
  const rest=await exploreService.get(h.viewer,50,page.nextCursor);assert.ok(rest.posts.every(p=>p.id!==blocked.id&&p.id!==snapshot.postIds[2]));
});

test('social API HTTP: authentication, validation, comment engagement and Explore/bookmark envelopes',async()=>{
  const {default:postRouter}=await import('../.cache/bundles/routes/post.routes.js');const {ZodError}=await import('zod');
  const app=express();app.use(express.json());app.use('/posts',postRouter);app.use((err,req,res,next)=>res.status(err.statusCode??(err instanceof ZodError?400:500)).json({success:false,message:'Rejected'}));
  const http=app.listen(0,'127.0.0.1');await new Promise(resolve=>http.on('listening',resolve));
  const base=`http://127.0.0.1:${http.address().port}/posts`;const headers={Authorization:`Bearer ${jwt.sign({userId:reader,username:reader},process.env.JWT_SECRET)}`,'Content-Type':'application/json'};
  try{
    assert.equal((await fetch(`${base}/explore`)).status,401);assert.equal((await fetch(`${base}/explore?limit=999`,{headers})).status,400);
    const p=await postService.createPost(sender,{content:'HTTP post'});const c=await postService.addComment(p.id,reader,'HTTP comment');
    const response=await fetch(`${base}/${p.id}/comments/${c.id}/like`,{method:'POST',headers});assert.equal(response.status,200);assert.equal((await response.json()).data.likesCount,1);
    const commentInfo=await(await fetch(`${base}/${p.id}/comments/${c.id}/likes`,{headers})).json();assert.equal(commentInfo.data.isLikedByCurrentUser,true);
    const postInfo=await(await fetch(`${base}/${p.id}/engagement`,{headers})).json();assert.equal(postInfo.data.commentsCount,1);assert.equal(postInfo.data.isLikedByCurrentUser,false);
    assert.equal((await fetch(`${base}/${p.id}/comments/bad/like`,{method:'POST',headers})).status,400);
    await fetch(`${base}/${p.id}/save`,{method:'POST',headers});const saved=await(await fetch(`${base}/saved`,{headers})).json();assert.ok(saved.data.some(post=>post.id===p.id&&post.isBookmarkedByCurrentUser));
    const detail=await(await fetch(`${base}/${p.id}`,{headers})).json();assert.equal(detail.data.isSaved,true);
    const explore=await(await fetch(`${base}/explore?limit=2`,{headers})).json();assert.equal(explore.success,true);assert.equal(explore.meta.algorithmVersion,1);
    assert.equal((await fetch(`${base}/saved?cursor=invalid`,{headers})).status,400);
  }finally{await new Promise(resolve=>http.close(resolve));}
});

test('private post media authorization follows post visibility and prevents public caching',async()=>{
  const owner=randomUUID();await prisma.user.create({data:{id:owner,username:owner,email:`${owner}@test.dev`,passwordHash:'unused',isPrivate:true}});
  const key=`images/${randomUUID()}.jpg`,url=`https://media.example.com/uploads/${key}`;
  await prisma.mediaAsset.create({data:{ownerId:owner,key,url,mimeType:'image/jpeg',size:10}});
  await postService.createPost(owner,{content:'private media',imageUrls:[url]});
  const check=async userId=>{const headers={};let failure;await authorizeMedia({path:`/${key}`,user:userId?{userId}:undefined},{type(){},set(k,v){headers[k]=v;}},error=>{failure=error;});return {failure,headers};};
  assert.equal((await check()).failure.statusCode,403);assert.equal((await check(reader)).failure.statusCode,403);
  const own=await check(owner);assert.equal(own.failure,undefined);assert.equal(own.headers['Cache-Control'],'private, no-store');
  await prisma.user.update({where:{id:owner},data:{isPrivate:false}});assert.equal((await check()).failure,undefined);
});

test('Explore/comment-like migration preserves old post, comment, like and bookmark rows',async()=>{
  const old=new PGlite();
  try{
    for(const dir of readdirSync('prisma/migrations').filter(d=>!d.endsWith('.toml')&&d!=='20261103000000_explore_comment_engagement').sort())await old.exec(readFileSync(`prisma/migrations/${dir}/migration.sql`,'utf8'));
    await old.exec(`INSERT INTO users(id,username,email,password_hash,updated_at) VALUES ('legacy','legacy','legacy@social.test','test',now());
      INSERT INTO posts(id,author_id,content,image_urls,updated_at) VALUES ('post','legacy','existing',ARRAY[]::text[],now());
      INSERT INTO comments(id,author_id,post_id,content) VALUES ('comment','legacy','post','existing comment');
      INSERT INTO likes(user_id,post_id) VALUES ('legacy','post'); INSERT INTO saved_posts(user_id,post_id) VALUES ('legacy','post');`);
    await old.exec(readFileSync('prisma/migrations/20261103000000_explore_comment_engagement/migration.sql','utf8'));
    for(const table of ['posts','comments','likes','saved_posts'])assert.equal((await old.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n,1);
    assert.equal((await old.query('SELECT is_private FROM users')).rows[0].is_private,false);
    assert.equal((await old.query('SELECT count(*)::int AS n FROM comment_likes')).rows[0].n,0);
  }finally{await old.close();}
});

test('engagement batching: SQL call count does not grow per returned bookmark/comment',async()=>{
  const user=randomUUID();await prisma.user.create({data:{id:user,username:user,email:`${user}@test.dev`,passwordHash:'unused'}});
  const posts=[];for(let i=0;i<12;i++)posts.push(await prisma.post.create({data:{authorId:sender,content:`batch ${i}`,imageUrls:[]}}));
  await prisma.savedPost.createMany({data:posts.map(p=>({userId:user,postId:p.id}))});
  for(let i=0;i<12;i++)await prisma.comment.create({data:{authorId:reader,postId:posts[0].id,content:`batch comment ${i}`}});
  async function calls(fn){const before=driverQueries;await fn();return driverQueries-before;}
  const savedSmall=await calls(()=>postService.getSavedPosts(user,1,1));const savedLarge=await calls(()=>postService.getSavedPosts(user,1,20));
  const commentsSmall=await calls(()=>postService.getComments(posts[0].id,user,1,1));const commentsLarge=await calls(()=>postService.getComments(posts[0].id,user,1,20));
  assert.ok(savedLarge<=savedSmall+1);assert.ok(commentsLarge<=commentsSmall+1);
  writeFileSync('.cache/social-query-counts.json',JSON.stringify({savedSmall,savedLarge,commentsSmall,commentsLarge},null,2));
});

test('private profile setting and activity hydration obey post visibility and engagement contract',async()=>{
  const {userService}=await import('../.cache/bundles/services/user.service.js');
  const {default:userRouter}=await import('../.cache/bundles/routes/user.routes.js');
  const owner=randomUUID();await prisma.user.create({data:{id:owner,username:owner,email:`${owner}@test.dev`,passwordHash:'unused'}});
  const post=await postService.createPost(owner,{content:'#private activity'});const parent=await postService.addComment(post.id,reader,'parent');await postService.addComment(post.id,third,'reply',parent.id);
  const before=(await activityService.list(reader,1,20)).items.find(n=>n.comment?.repliedToId===parent.id);assert.equal(before.post.likesCount,0);assert.equal(before.comment.repliesCount,0);
  await userService.updateProfile(owner,{isPrivate:true});
  const privateActivity=(await activityService.list(reader,1,20)).items.find(n=>n.commentId!==null&&n.commentId!==parent.id);assert.equal(privateActivity.post,null);assert.equal(privateActivity.comment,null);
  const profile=await userService.getProfile(owner,reader);assert.equal(profile.isPrivate,true);
  await assert.rejects(userService.follow(reader,owner),e=>e.statusCode===403);
  const storyUrl=`https://media.example.com/uploads/images/${randomUUID()}.jpg`;
  await postService.createStory(owner,{mediaUrl:storyUrl,mediaType:'IMAGE'});
  const story=(await prisma.story.findFirst({where:{userId:owner,mediaUrl:storyUrl}}));assert.ok(story);
  assert.ok(!(await postService.getStories(reader)).some(item=>item.id===story.id));
  assert.ok((await postService.getStories(owner)).some(item=>item.id===story.id));
  await assert.rejects(postService.markStoryViewed(reader,story.id),e=>e.statusCode===404);
  await postService.markStoryViewed(owner,story.id);
  await assert.rejects(postService.shareStory(story.id,reader,randomUUID()),e=>e.statusCode===404);
  const mediaKey=new URL(storyUrl).pathname.split('/uploads/')[1];
  await prisma.mediaAsset.create({data:{ownerId:owner,key:mediaKey,url:storyUrl,mimeType:'image/jpeg',size:10}});
  const mediaCheck=async userId=>{let failure;await authorizeMedia({path:`/${mediaKey}`,user:userId?{userId}:undefined},{type(){},set(){}},error=>{failure=error;});return failure;};
  assert.equal((await mediaCheck(reader)).statusCode,403);assert.equal(await mediaCheck(owner),undefined);
  await assert.rejects(postService.getPost(post.id,reader),e=>e.statusCode===404);
  assert.equal((await postService.getPost(post.id,owner)).id,post.id);
  const app=express();app.use(express.json());app.use('/users',userRouter);app.use((err,req,res,next)=>res.status(err.statusCode??400).json({success:false}));
  const http=app.listen(0,'127.0.0.1');await new Promise(resolve=>http.on('listening',resolve));
  try{
    const auth={Authorization:`Bearer ${jwt.sign({userId:owner,username:owner},process.env.JWT_SECRET)}`,'Content-Type':'application/json'};
    const response=await fetch(`http://127.0.0.1:${http.address().port}/users/me`,{method:'PATCH',headers:auth,body:JSON.stringify({isPrivate:false})});assert.equal(response.status,200);assert.equal((await response.json()).data.isPrivate,false);
    const invalid=await fetch(`http://127.0.0.1:${http.address().port}/users/me`,{method:'PATCH',headers:auth,body:JSON.stringify({isPrivate:'false'})});assert.equal(invalid.status,400);
  }finally{await new Promise(resolve=>http.close(resolve));}
});

test('Redis abuse gates are atomic, category-scoped, per-user and per-IP, return Retry-After and fail closed', async()=>{
  const {createAbuseProtection,socketClientIp}=await import('../.cache/bundles/middlewares/abuse-protection.js');
  const oldTrustProxy=process.env.TRUST_PROXY_HOPS;
  process.env.TRUST_PROXY_HOPS='0';assert.equal(socketClientIp('203.0.113.8','198.51.100.8'),'203.0.113.8');
  process.env.TRUST_PROXY_HOPS='1';assert.equal(socketClientIp('203.0.113.8','198.51.100.8'),'198.51.100.8');
  process.env.TRUST_PROXY_HOPS='2';assert.equal(socketClientIp('203.0.113.8','198.51.100.8, 192.0.2.8'),'198.51.100.8');
  assert.equal(socketClientIp('203.0.113.8','spoofed'),'203.0.113.8');
  if(oldTrustProxy===undefined)delete process.env.TRUST_PROXY_HOPS;else process.env.TRUST_PROXY_HOPS=oldTrustProxy;
  const app=express();app.set('trust proxy',true);app.use((req,res,next)=>{req.user={userId:req.get('x-test-user')};next();});
  app.get('/limited',createAbuseProtection()('stickers'),(req,res)=>res.json({ok:true}));
  app.use((err,req,res,next)=>res.status(err.statusCode??500).json({error:'unavailable'}));
  const http=app.listen(0,'127.0.0.1');await new Promise(resolve=>http.on('listening',resolve));
  const url=`http://127.0.0.1:${http.address().port}/limited`;
  const before={ip:process.env.ABUSE_STICKERS_IP_MAX,user:process.env.ABUSE_STICKERS_USER_MAX};
  const request=(user,ip)=>fetch(url,{headers:{'x-test-user':user,'x-forwarded-for':ip}});
  try{
    process.env.ABUSE_STICKERS_IP_MAX='100';process.env.ABUSE_STICKERS_USER_MAX='2';
    const u1=randomUUID(),u2=randomUUID(),ip1='198.51.100.31',ip2='198.51.100.32';
    assert.equal((await request(u1,ip1)).status,200);assert.equal((await request(u1,ip2)).status,200);
    const blockedUser=await request(u1,'198.51.100.33');assert.equal(blockedUser.status,429);assert.ok(Number(blockedUser.headers.get('retry-after'))>=1);
    assert.equal((await request(u2,ip1)).status,200,'the same IP may use a different user budget');
    process.env.ABUSE_STICKERS_IP_MAX='2';process.env.ABUSE_STICKERS_USER_MAX='100';
    const ip3='198.51.100.34';assert.equal((await request(randomUUID(),ip3)).status,200);assert.equal((await request(randomUUID(),ip3)).status,200);
    const blockedIp=await request(randomUUID(),ip3);assert.equal(blockedIp.status,429);assert.ok(blockedIp.headers.get('retry-after'));
    process.env.ABUSE_STICKERS_IP_MAX='100';process.env.ABUSE_STICKERS_USER_MAX='8';
    const parallelUser=randomUUID(),parallelIp='198.51.100.35';
    const concurrent=await Promise.all(Array.from({length:24},()=>request(parallelUser,parallelIp)));
    assert.equal(concurrent.filter(r=>r.status===200).length,8);assert.equal(concurrent.filter(r=>r.status===429).length,16);
    deliveryRedisFails=true;const unavailable=await request(randomUUID(),'198.51.100.36');assert.equal(unavailable.status,503);assert.equal(unavailable.headers.get('retry-after'),'1');
  }finally{
    deliveryRedisFails=false;
    for(const [key,value] of Object.entries({ABUSE_STICKERS_IP_MAX:before.ip,ABUSE_STICKERS_USER_MAX:before.user}))if(value===undefined)delete process.env[key];else process.env[key]=value;
    await new Promise(resolve=>http.close(resolve));
  }
});

test('Idempotency-Key prevents replay and body substitution without consuming failed requests',async()=>{
  const {createIdempotencyGuard}=await import('../.cache/bundles/middlewares/abuse-protection.js');
  const app=express();app.use(express.json());app.use((req,res,next)=>{req.user={userId:sender};next();});let mutations=0;
  app.post('/mutate',createIdempotencyGuard()({required:true}), (req,res)=>{mutations++;res.status(201).json({mutations,body:req.body});});
  app.post('/fail',createIdempotencyGuard()({required:true}), (req,res)=>res.status(400).json({error:'business validation'}));
  app.use((err,req,res,next)=>res.status(err.statusCode??500).json({error:'unavailable'}));
  const http=app.listen(0,'127.0.0.1');await new Promise(resolve=>http.on('listening',resolve));const base=`http://127.0.0.1:${http.address().port}`;
  const key=randomUUID();const send=(path,body,requestKey=key)=>fetch(`${base}${path}`,{method:'POST',headers:{'Content-Type':'application/json',...(requestKey?{'Idempotency-Key':requestKey}:{})},body:JSON.stringify(body)});
  try{
    assert.equal((await send('/mutate',{value:1},null)).status,400);
    assert.equal((await send('/mutate',{value:1})).status,201);
    assert.equal((await send('/mutate',{value:1})).status,409);
    assert.equal((await send('/mutate',{value:2})).status,409);assert.equal(mutations,1);
    const retryKey=randomUUID();assert.equal((await send('/fail',{value:1},retryKey)).status,400);
    assert.equal((await send('/mutate',{value:3},retryKey)).status,201,'non-success responses release their claim for a legitimate retry');
  }finally{await new Promise(resolve=>http.close(resolve));}
});

test('Google ID tokens are claim-checked; signup, existing-account linking, sessions and unique identity ownership',async()=>{
  const {createGoogleAuthService,validateGoogleClaims}=await import('../.cache/bundles/services/google-auth.service.js');
  const saved=process.env.GOOGLE_CLIENT_ID;process.env.GOOGLE_CLIENT_ID='test-google-client.apps.googleusercontent.com';
  const good=(sub,email)=>({sub,email,email_verified:true,iss:'https://accounts.google.com',aud:process.env.GOOGLE_CLIENT_ID,exp:Math.floor(Date.now()/1000)+300,name:'Verified Person'});
  assert.equal(validateGoogleClaims(good('claim-check','CLAIM@EXAMPLE.TEST'),process.env.GOOGLE_CLIENT_ID).email,'claim@example.test');
  for(const payload of [undefined,{...good('bad','x@example.test'),iss:'https://evil.example'}, {...good('bad','x@example.test'),aud:'other-client'}, {...good('bad','x@example.test'),exp:1}, {...good('bad','x@example.test'),email_verified:false}])
    assert.throws(()=>validateGoogleClaims(payload,process.env.GOOGLE_CLIENT_ID),e=>e.statusCode===401);
  const claims=new Map([['signup',good('google-sub-signup',`${randomUUID()}@google.test`)]]);
  const verifier={async verifyIdToken({idToken,audience}){assert.equal(audience,process.env.GOOGLE_CLIENT_ID);if(idToken==='bad-signature')throw Error('bad signature');return {getPayload:()=>claims.get(idToken)};}};
  const service=createGoogleAuthService({verifier,db:prisma,registrationEnabled:async()=>true});
  try{
    const created=await service.signIn('signup');assert.equal(created.user.email,claims.get('signup').email);assert.ok(created.accessToken&&created.refreshToken);assert.ok(!('passwordHash'in created.user));
    assert.equal(jwt.verify(created.accessToken,process.env.JWT_SECRET).userId,created.user.id);
    const identity=await prisma.googleIdentity.findUnique({where:{provider_providerSubject:{provider:'GOOGLE',providerSubject:'google-sub-signup'}}});assert.equal(identity.userId,created.user.id);
    const again=await service.signIn('signup');assert.equal(again.user.id,created.user.id);assert.equal(await prisma.googleIdentity.count({where:{userId:created.user.id}}),1);
    const existing=await prisma.user.create({data:{id:randomUUID(),username:randomUUID(),email:`${randomUUID()}@existing.test`,passwordHash:'unused'}});
    claims.set('link-existing',good('google-sub-existing',existing.email.toUpperCase()));
    await assert.rejects(service.signIn('link-existing'),e=>e.statusCode===409);
    assert.equal(await prisma.googleIdentity.count({where:{providerSubject:'google-sub-existing'}}),0);
    const linked=await service.linkAccount(existing.id,'link-existing');assert.equal(linked.linked,true);
    const signedIn=await service.signIn('link-existing');assert.equal(signedIn.user.id,existing.id);
    await assert.rejects(service.linkAccount(created.user.id,'link-existing'),e=>e.statusCode===409);
    await assert.rejects(service.signIn('bad-signature'),e=>e.statusCode===401);
  }finally{if(saved===undefined)delete process.env.GOOGLE_CLIENT_ID;else process.env.GOOGLE_CLIENT_ID=saved;}
});

test('groups and channels enforce member/admin permissions, paginate membership and retain durable events',async()=>{
  const {communityService}=await import('../.cache/bundles/services/community.service.js');
  const makeUser=async()=>{const id=randomUUID();return prisma.user.create({data:{id,username:id,email:`${id}@community.test`,passwordHash:'unused'}});};
  const owner=await makeUser(),member=await makeUser(),third=await makeUser(),outsider=await makeUser(),extra=await makeUser();
  await assert.rejects(communityService.createGroup(owner.id,{name:'Oversized group',memberIds:Array.from({length:500},()=>randomUUID())}),e=>e.statusCode===400);
  const group=await communityService.createGroup(owner.id,{name:'Private group',description:'members only',memberIds:[member.id,third.id]});
  assert.equal(group.kind,'GROUP');assert.equal(group.ownerId,owner.id);assert.equal(group.participants.find(p=>p.userId===owner.id).role,'ADMIN');
  await assert.rejects(communityService.getGroup(group.id,outsider.id),e=>e.statusCode===403);
  await assert.rejects(communityService.addGroupMembers(group.id,member.id,[extra.id]),e=>e.statusCode===403);
  const groupMessage=await service.sendMessage(group.id,owner.id,'group persistence');assert.equal(groupMessage.isGroup,true);
  await communityService.setGroupRole(group.id,owner.id,member.id,'ADMIN');
  await communityService.addGroupMembers(group.id,member.id,[extra.id]);
  assert.ok((await communityService.getGroup(group.id,extra.id)).participants.some(p=>p.userId===extra.id));
  await assert.rejects(communityService.removeGroupMember(group.id,member.id,owner.id),e=>e.statusCode===403);
  await communityService.removeGroupMember(group.id,owner.id,member.id);
  await assert.rejects(service.requireMember(group.id,member.id),e=>e.statusCode===403);
  await assert.rejects(communityService.removeGroupMember(group.id,owner.id,owner.id),e=>e.statusCode===403);
  const second=await communityService.createGroup(owner.id,{name:'Second group',memberIds:[member.id]});
  const firstPage=await communityService.listGroups(owner.id,1);assert.equal(firstPage.items.length,1);assert.equal(firstPage.hasMore,true);
  const secondPage=await communityService.listGroups(owner.id,1,firstPage.nextCursor);assert.equal(secondPage.items.length,1);assert.notEqual(firstPage.items[0].id,secondPage.items[0].id);

  const privateChannel=await communityService.createChannel(owner.id,{name:'Private channel',isPublic:false});
  assert.ok(privateChannel.inviteToken);assert.equal('inviteTokenHash'in privateChannel.channel,false);
  await assert.rejects(communityService.getChannel(privateChannel.channel.id,outsider.id),e=>e.statusCode===404);
  await assert.rejects(communityService.joinChannel(privateChannel.channel.id,member.id,'wrong_invite_token_that_is_long_enough_123456'),e=>e.statusCode===404);
  assert.equal((await communityService.joinChannel(privateChannel.channel.id,member.id,privateChannel.inviteToken)).joined,true);
  assert.equal((await communityService.getChannel(privateChannel.channel.id,member.id)).role,'MEMBER');
  await assert.rejects(service.sendMessage(privateChannel.channel.id,member.id,'not allowed'),e=>e.statusCode===403);
  const rotate=await communityService.rotateChannelInvite(privateChannel.channel.id,owner.id);assert.notEqual(rotate.inviteToken,privateChannel.inviteToken);
  await assert.rejects(communityService.joinChannel(privateChannel.channel.id,outsider.id,privateChannel.inviteToken),e=>e.statusCode===404);
  await communityService.joinChannel(privateChannel.channel.id,outsider.id,rotate.inviteToken);
  const announced=await service.sendMessage(privateChannel.channel.id,owner.id,'channel announcement');assert.equal(announced.isGroup,true);
  const history=await service.getMessages(privateChannel.channel.id,member.id,1,20);assert.ok(history.messages.some(m=>m.id===announced.id));
  await communityService.setChannelRole(privateChannel.channel.id,owner.id,member.id,'ADMIN');
  const adminPost=await service.sendMessage(privateChannel.channel.id,member.id,'admin post');assert.equal(adminPost.senderId,member.id);
  await assert.rejects(communityService.updateChannel(privateChannel.channel.id,member.id,{name:'not owner'}),e=>e.statusCode===403);

  const publicChannel=await communityService.createChannel(owner.id,{name:'Public channel',isPublic:true,slug:`public-${randomUUID().slice(0,8)}`});
  await communityService.createChannel(owner.id,{name:'Another public channel',isPublic:true,slug:`public-${randomUUID().slice(0,8)}`});
  const publicView=await communityService.getChannel(publicChannel.channel.id,outsider.id);assert.equal(publicView.isMember,false);assert.equal('participants'in publicView,false);
  assert.equal((await communityService.joinChannel(publicChannel.channel.id,outsider.id)).joined,true);
  const publicPages=await communityService.listPublicChannels(1);assert.equal(publicPages.items.length,1);assert.equal(publicPages.hasMore,true);

  kafkaFails=true;
  try{
    const durable=await communityService.createGroup(owner.id,{name:'Kafka outage still commits',memberIds:[third.id]});
    await new Promise(resolve=>setTimeout(resolve,30));
    const pending=await prisma.receiptOutbox.findMany();assert.ok(pending.some(row=>row.payload?.kind==='conversationMembership'&&row.payload?.event?.conversationId===durable.id));
    kafkaFails=false;await prisma.receiptOutbox.updateMany({data:{availableAt:new Date(0)}});await publishReceipts();
    assert.ok(events.some(e=>e.name==='conversationMembership'&&e.payload.conversationId===durable.id));
  }finally{kafkaFails=false;}
  assert.ok(second.id);
});

test('sticker packs enforce asset ownership and visibility; install, favorite, recent, and message flows',async()=>{
  const {stickerService}=await import('../.cache/bundles/services/sticker.service.js');
  const {authorizeMedia}=await import('../.cache/bundles/middlewares/media-access.js');
  const makeUser=async()=>{const id=randomUUID();return prisma.user.create({data:{id,username:id,email:`${id}@stickers.test`,passwordHash:'unused'}});};
  const owner=await makeUser(),senderUser=await makeUser(),outsider=await makeUser();
  const media=async(userId)=>{const key=`images/${randomUUID()}.png`,url=`https://media.example.com/uploads/${key}`;return prisma.mediaAsset.create({data:{ownerId:userId,key,url,mimeType:'image/png',size:2048}});};
  const firstAsset=await media(owner.id),secondAsset=await media(owner.id),privateAsset=await media(owner.id),foreignAsset=await media(outsider.id);
  const pack=await stickerService.createPack(owner.id,{shortName:'tiny-friends',title:'Tiny Friends',description:'Original assets',isPublic:true,stickers:[{mediaUrl:firstAsset.url,emoji:'🙂'},{mediaUrl:secondAsset.url,emoji:'🎉'}]});
  assert.equal(pack.stickers.length,2);assert.equal(pack.stickers[0].asset.url,firstAsset.url);
  const strangerPacks=await stickerService.listPacks(outsider.id,10);assert.ok(strangerPacks.items.some(p=>p.id===pack.id));
  const installed=await stickerService.installPack(senderUser.id,pack.id);assert.equal(installed.installed,true);assert.equal((await stickerService.installPack(senderUser.id,pack.id)).alreadyInstalled,true);
  assert.equal((await stickerService.getPack(senderUser.id,pack.id)).installed,true);
  const stickerId=pack.stickers[0].id;
  assert.equal((await stickerService.favorite(senderUser.id,stickerId)).favorite,true);assert.equal((await stickerService.favorite(senderUser.id,stickerId)).alreadyFavorite,true);
  assert.equal(await prisma.stickerFavorite.count({where:{userId:senderUser.id,stickerId}}),1);
  const favoritePage=await stickerService.listFavorites(senderUser.id,10);assert.equal(favoritePage.items[0].id,stickerId);
  const privatePack=await stickerService.createPack(owner.id,{shortName:'owner-private',title:'Owner private',isPublic:false,stickers:[{mediaUrl:privateAsset.url,emoji:'🫥'}]});
  await assert.rejects(stickerService.getPack(senderUser.id,privatePack.id),e=>e.statusCode===404);
  await assert.rejects(stickerService.installPack(senderUser.id,privatePack.id),e=>e.statusCode===404);
  await assert.rejects(stickerService.createPack(senderUser.id,{shortName:'forged-asset',title:'No',isPublic:true,stickers:[{mediaUrl:foreignAsset.url}]}),e=>e.statusCode===400);
  const dm=await prisma.conversation.create({data:{isGroup:false,kind:'DIRECT',participants:{create:[{userId:owner.id},{userId:senderUser.id}]}}});
  const message=await service.sendMessage(dm.id,senderUser.id,'',owner.id,{type:'STICKER',stickerId});
  assert.equal(message.type,'STICKER');assert.equal(message.stickerId,stickerId);assert.equal(message.mediaUrl,firstAsset.url);assert.equal(message.sticker.emoji,'🙂');
  const recents=await stickerService.listRecents(senderUser.id,10);assert.equal(recents.items[0].id,stickerId);
  await assert.rejects(service.sendMessage(dm.id,outsider.id,'',owner.id,{type:'STICKER',stickerId}),e=>e.statusCode===403);
  await assert.rejects(service.sendMessage(dm.id,senderUser.id,'',owner.id,{type:'STICKER',stickerId:privatePack.stickers[0].id}),e=>e.statusCode===404);
  const mediaCheck=async(userId,key)=>{let failure;await authorizeMedia({path:`/${key}`,user:userId?{userId}:undefined},{type(){},set(){}},error=>{failure=error;});return failure;};
  assert.equal(await mediaCheck(undefined,firstAsset.key),undefined,'public pack media may be fetched without exposing owner uploads');
  assert.equal((await mediaCheck(senderUser.id,privateAsset.key)).statusCode,403);
  await stickerService.unfavorite(senderUser.id,stickerId);assert.equal(await prisma.stickerFavorite.count({where:{userId:senderUser.id,stickerId}}),0);
  await stickerService.uninstallPack(senderUser.id,pack.id);assert.equal((await stickerService.getPack(senderUser.id,pack.id)).installed,false);
  await service.deleteMessage(message.id,senderUser.id,'everyone');
  const deleted=(await service.getMessages(dm.id,owner.id,1,20)).messages.find(row=>row.id===message.id);assert.equal(deleted.stickerId,null);assert.equal(deleted.sticker,null);
});

test('community HTTP requires authenticated identity and idempotency keys on resource creation',async()=>{
  const {default:communityRouter}=await import('../.cache/bundles/routes/community.routes.js');
  const makeUser=async()=>{const id=randomUUID();return prisma.user.create({data:{id,username:id,email:`${id}@community-http.test`,passwordHash:'unused'}});};
  const owner=await makeUser(),member=await makeUser();const app=express();app.use(express.json());app.use('/communities',communityRouter);
  app.use((err,req,res,next)=>res.status(err.statusCode??500).json({success:false,message:'Rejected'}));
  const http=app.listen(0,'127.0.0.1');await new Promise(resolve=>http.on('listening',resolve));const base=`http://127.0.0.1:${http.address().port}/communities/groups`;
  const headers={Authorization:`Bearer ${jwt.sign({userId:owner.id,email:owner.email,username:owner.username},process.env.JWT_SECRET)}`,'Content-Type':'application/json'};
  const body={name:'HTTP group',memberIds:[member.id]};
  try{
    assert.equal((await fetch(base,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})).status,401);
    assert.equal((await fetch(base,{method:'POST',headers,body:JSON.stringify(body)})).status,400);
    const key=randomUUID();const request=()=>fetch(base,{method:'POST',headers:{...headers,'Idempotency-Key':key},body:JSON.stringify(body)});
    const created=await request();assert.equal(created.status,201);const group=(await created.json()).data;assert.equal(group.ownerId,owner.id);
    assert.equal((await request()).status,409);
    const list=await(await fetch(base,{headers})).json();assert.ok(list.data.items.some(item=>item.id===group.id));
  }finally{await new Promise(resolve=>http.close(resolve));}
});

test('frontend group/channel API aliases enforce auth, contracts, permissions, pagination and private-channel safety',async()=>{
  const {default:channelRouter}=await import('../.cache/bundles/routes/channel-compat.routes.js');
  const {ZodError}=await import('zod');
  const makeUser=async()=>{const id=randomUUID();return prisma.user.create({data:{id,username:id,email:`${id}@compat-http.test`,passwordHash:'unused'}});};
  const owner=await makeUser(),member=await makeUser(),admin=await makeUser(),outsider=await makeUser();
  const app=express();app.use(express.json());app.use('/api/v1/messages',router);app.use('/api/v1/channels',channelRouter);
  app.use((err,req,res,next)=>res.status(err.statusCode??(err instanceof ZodError?400:500)).json({success:false,message:err.message??'Rejected'}));
  const http=app.listen(0,'127.0.0.1');await new Promise(resolve=>http.on('listening',resolve));
  const base=`http://127.0.0.1:${http.address().port}/api/v1`;
  const headersFor=user=>({Authorization:`Bearer ${jwt.sign({userId:user.id,email:user.email,username:user.username},process.env.JWT_SECRET)}`});
  const api=async(path,{user=owner,method='GET',body,headers={}}={})=>{
    const init={method,headers:{...headersFor(user),...headers}};
    if(body!==undefined){init.headers['Content-Type']='application/json';init.body=JSON.stringify(body);}
    const response=await fetch(`${base}${path}`,init);return {response,json:await response.json()};
  };
  try{
    const unauth=await fetch(`${base}/messages/groups`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'No auth',memberIds:[member.id]})});
    assert.equal(unauth.status,401);
    assert.equal((await fetch(`${base}/channels`)).status,401);

    const groupAvatar='https://media.example.com/uploads/groups/group-avatar.webp';
    const createdGroup=await api('/messages/groups',{method:'POST',body:{name:'Compatibility group',memberIds:[member.id],avatarUrl:groupAvatar,description:'Initial'}});
    assert.equal(createdGroup.response.status,201);assert.equal(createdGroup.json.success,true);
    const group=createdGroup.json.data;assert.equal(group.name,'Compatibility group');assert.equal(group.avatarUrl,groupAvatar);
    assert.equal(group.memberCount,2);assert.equal(group.myRole,'owner');assert.equal(group.canManage,true);assert.equal(group.managementAvailable,true);
    assert.deepEqual(group.members.map(item=>item.role).sort(),['member','owner']);assert.equal(group.members.find(item=>item.userId===member.id).username,member.username);
    assert.ok(group.members.every(item=>Object.hasOwn(item,'joinedAt')));
    assert.equal('inviteTokenHash'in group,false);

    const groupId=group.id;
    const updatedGroup=await api(`/messages/groups/${groupId}`,{method:'PATCH',body:{description:'Updated'}});
    assert.equal(updatedGroup.response.status,200);assert.equal(updatedGroup.json.data.description,'Updated');assert.equal(updatedGroup.json.data.avatarUrl,groupAvatar);
    const memberView=await api(`/messages/groups/${groupId}`,{user:member});
    assert.equal(memberView.response.status,200);assert.equal(memberView.json.data.myRole,'member');assert.equal(memberView.json.data.canManage,false);

    const added=await api(`/messages/groups/${groupId}/members`,{method:'POST',body:{userIds:[admin.id]}});
    assert.equal(added.response.status,200);assert.equal(added.json.data.memberCount,3);
    assert.ok(added.json.data.members.some(item=>item.userId===admin.id));
    assert.equal((await api(`/messages/groups/${groupId}/members`,{user:member,method:'POST',body:{userIds:[outsider.id]}})).response.status,403);
    const promoted=await api(`/messages/groups/${groupId}/members/${admin.id}/role`,{method:'PATCH',body:{role:'admin'}});
    assert.equal(promoted.response.status,200);assert.equal(promoted.json.data.members.find(item=>item.userId===admin.id).role,'admin');
    assert.equal((await api(`/messages/groups/${groupId}/members/${member.id}/role`,{user:admin,method:'PATCH',body:{role:'admin'}})).response.status,403);
    assert.equal((await api(`/messages/groups/${groupId}/members/${owner.id}`,{user:admin,method:'DELETE'})).response.status,403);
    assert.equal((await api(`/messages/groups/${groupId}/members/${member.id}`,{method:'DELETE'})).response.status,200);
    assert.equal((await api(`/messages/groups/${groupId}/leave`,{user:admin,method:'POST',body:{userId:owner.id}})).response.status,200,
      'leave uses authenticated identity, not the body userId');
    assert.equal((await api(`/messages/groups/${groupId}/leave`,{method:'POST',body:{}})).response.status,403,
      'group owner is not allowed to leave');
    assert.equal((await api(`/messages/groups/${groupId}`,{user:member})).response.status,403);

    const channelAvatar='https://media.example.com/uploads/channels/channel-avatar.webp';
    const createdChannel=await api('/channels',{method:'POST',body:{name:'Compatibility Product',description:'Release notes',avatarUrl:channelAvatar,isPrivate:false}});
    assert.equal(createdChannel.response.status,201);const channel=createdChannel.json.data;
    assert.equal(channel.name,'Compatibility Product');assert.equal(channel.avatarUrl,channelAvatar);assert.equal(channel.isPrivate,false);
    assert.equal(channel.subscriberCount,1);assert.equal(channel.isSubscribed,true);assert.equal(channel.role,'owner');assert.equal(channel.canPost,true);
    assert.ok(Array.isArray(channel.admins));assert.equal(channel.admins[0].role,'owner');assert.equal('channel'in channel,false);
    assert.equal('inviteTokenHash'in channel,false);
    const dbChannel=await prisma.conversation.findUnique({where:{id:channel.id}});
    assert.match(dbChannel.slug,/^compatibility-product-[a-f0-9]{12}$/);assert.equal(dbChannel.groupAvatar,channelAvatar);

    const discovery=await api('/channels?query=compatibility&scope=discover&page=1&limit=20');
    assert.equal(discovery.response.status,200);assert.ok(Array.isArray(discovery.json.data));assert.ok(discovery.json.data.some(item=>item.id===channel.id));
    const outsiderDetail=await api(`/channels/${channel.id}`,{user:outsider});
    assert.equal(outsiderDetail.response.status,200);assert.equal(outsiderDetail.json.data.isSubscribed,false);
    assert.equal(outsiderDetail.json.data.role,'subscriber');assert.equal(outsiderDetail.json.data.canPost,false);
    const subscribed=await api(`/channels/${channel.id}/subscribe`,{user:outsider,method:'POST',body:{}});
    assert.equal(subscribed.response.status,200);assert.equal(subscribed.json.data.isSubscribed,true);assert.equal(subscribed.json.data.role,'member');
    assert.equal(subscribed.json.data.canPost,false);assert.equal(subscribed.json.data.subscriberCount,2);
    assert.equal((await api(`/channels/${channel.id}/posts`,{user:outsider,method:'POST',body:{content:'not allowed',type:'TEXT'}})).response.status,403);

    const textPost=await api(`/channels/${channel.id}/posts`,{method:'POST',body:{content:'Release notes',type:'TEXT'}});
    assert.equal(textPost.response.status,201);assert.equal(textPost.json.data.channelId,channel.id);
    assert.equal(textPost.json.data.content,'Release notes');assert.equal(textPost.json.data.type,'TEXT');assert.equal(textPost.json.data.author.id,owner.id);
    assert.equal(textPost.json.data.pinned,false);assert.equal(textPost.json.data.mediaUrl,null);assert.equal(textPost.json.data.fileName,null);
    const mediaKey=`images/${randomUUID()}.png`,mediaUrl=`https://media.example.com/uploads/${mediaKey}`;
    await prisma.mediaAsset.create({data:{ownerId:owner.id,key:mediaKey,url:mediaUrl,mimeType:'image/png',size:4096}});
    const mediaPost=await api(`/channels/${channel.id}/posts`,{method:'POST',body:{content:'Diagram',type:'IMAGE',mediaUrl}});
    assert.equal(mediaPost.response.status,201);assert.equal(mediaPost.json.data.mediaUrl,mediaUrl);
    assert.equal(mediaPost.json.data.fileName,mediaKey.split('/').pop());assert.equal(mediaPost.json.data.fileMimeType,'image/png');
    assert.equal(mediaPost.json.data.fileSize,4096);assert.equal(mediaPost.json.data.duration,null);

    assert.equal((await api(`/channels/${channel.id}/posts/${textPost.json.data.id}`,{user:outsider,method:'PATCH',body:{pinned:true}})).response.status,403);
    const pinned=await api(`/channels/${channel.id}/posts/${textPost.json.data.id}`,{method:'PATCH',body:{content:'Updated notes',pinned:true}});
    assert.equal(pinned.response.status,200);assert.equal(pinned.json.data.content,'Updated notes');assert.equal(pinned.json.data.pinned,true);
    assert.equal((await prisma.message.findUnique({where:{id:textPost.json.data.id}})).pinned,true,'pin state is persisted');
    assert.equal((await api(`/channels/${channel.id}/posts/${textPost.json.data.id}`,{user:outsider,method:'DELETE'})).response.status,403);

    const firstPage=await api(`/channels/${channel.id}/posts?limit=1`);
    assert.equal(firstPage.response.status,200);assert.equal(firstPage.json.data.length,1);assert.equal(firstPage.json.meta.hasNext,true);
    assert.ok(firstPage.json.meta.nextCursor);
    const secondPage=await api(`/channels/${channel.id}/posts?limit=1&cursor=${encodeURIComponent(firstPage.json.meta.nextCursor)}`);
    assert.equal(secondPage.response.status,200);assert.equal(secondPage.json.data.length,1);assert.notEqual(secondPage.json.data[0].id,firstPage.json.data[0].id);
    assert.equal(secondPage.json.meta.hasNext,false);

    const stickerKey=`images/${randomUUID()}.webp`,stickerUrl=`https://media.example.com/uploads/${stickerKey}`;
    await prisma.mediaAsset.create({data:{ownerId:owner.id,key:stickerKey,url:stickerUrl,mimeType:'image/webp',size:8192}});
    const {stickerService}=await import('../.cache/bundles/services/sticker.service.js');
    await stickerService.createPack(owner.id,{shortName:`channel-${randomUUID().slice(0,8)}`,title:'Channel sticker',isPublic:true,stickers:[{mediaUrl:stickerUrl,emoji:'🌸'}]});
    const stickerPost=await api(`/channels/${channel.id}/posts`,{method:'POST',body:{type:'STICKER',mediaUrl:stickerUrl}});
    assert.equal(stickerPost.response.status,201);assert.equal(stickerPost.json.data.type,'STICKER');assert.equal(stickerPost.json.data.mediaUrl,stickerUrl);

    let outagePost;
    kafkaFails=true;
    try{
      const response=await api(`/channels/${channel.id}/posts`,{method:'POST',body:{content:'Persist through Kafka outage',type:'TEXT'}});
      assert.equal(response.response.status,201);outagePost=response.json.data;
      const pending=await prisma.receiptOutbox.findMany();
      assert.ok(pending.some(row=>row.payload?.kind==='chatMessage'&&row.payload?.event?.messageId===outagePost.id));
    }finally{kafkaFails=false;}
    await prisma.receiptOutbox.updateMany({data:{availableAt:new Date(0)}});await publishReceipts();
    assert.ok(events.some(event=>event.name==='chatMessage'&&event.payload.messageId===outagePost.id));

    const privateResponse=await api('/channels',{method:'POST',body:{name:'Private Compatibility',isPrivate:true}});
    assert.equal(privateResponse.response.status,201);assert.equal(privateResponse.json.data.isPrivate,true);
    assert.ok(privateResponse.json.data.inviteToken);assert.equal('inviteTokenHash'in privateResponse.json.data,false);
    const privateChannel=await prisma.conversation.findUnique({where:{id:privateResponse.json.data.id}});
    assert.ok(privateChannel.inviteTokenHash);assert.notEqual(privateResponse.json.data.inviteToken,privateChannel.inviteTokenHash);
    assert.equal((await api(`/channels/${privateChannel.id}/subscribe`,{user:outsider,method:'POST',body:{}})).response.status,404,
      'private channel joins still require an invite token');
    assert.equal((await api(`/channels/${privateChannel.id}`,{user:outsider})).response.status,404);
    assert.equal((await api(`/channels/${privateChannel.id}/posts`,{user:outsider})).response.status,404);
    const invited=await api(`/channels/${privateChannel.id}/subscribe`,{user:outsider,method:'POST',body:{inviteToken:privateResponse.json.data.inviteToken}});
    assert.equal(invited.response.status,200);assert.equal(invited.json.data.isSubscribed,true);
    assert.equal((await api(`/channels?scope=discover&page=1&limit=20`,{user:outsider})).json.data.some(item=>item.id===privateChannel.id),false);
    assert.equal((await api(`/channels?scope=subscribed&page=1&limit=20`,{user:outsider})).json.data.some(item=>item.id===privateChannel.id),true);

    const otherChannel=(await api('/channels',{method:'POST',body:{name:'Other public channel',isPrivate:false}})).json.data;
    const channelPage=await api('/channels?scope=discover&page=2&limit=1');
    assert.equal(channelPage.response.status,200);assert.equal(channelPage.json.data.length,1);assert.equal(channelPage.json.meta.page,2);assert.ok(channelPage.json.meta.total>1);
    const subscribedChannels=await api('/channels?scope=subscribed&page=1&limit=20',{user:outsider});
    assert.ok(subscribedChannels.json.data.some(item=>item.id===channel.id));assert.ok(subscribedChannels.json.data.some(item=>item.id===privateChannel.id));
    assert.equal((await api(`/channels/${otherChannel.id}/posts/${textPost.json.data.id}`,{method:'PATCH',body:{pinned:false}})).response.status,404,
      'post IDs cannot be used through another channel path');
    const {communityService}=await import('../.cache/bundles/services/community.service.js');
    await communityService.setChannelRole(channel.id,owner.id,outsider.id,'ADMIN');
    const adminDetail=await api(`/channels/${channel.id}`,{user:outsider});
    assert.equal(adminDetail.json.data.role,'admin');assert.equal(adminDetail.json.data.canPost,true);
    assert.equal((await api(`/channels/${channel.id}/posts/${mediaPost.json.data.id}`,{user:outsider,method:'PATCH',body:{content:'Admin moderation'}})).response.status,200);
    assert.equal((await api(`/channels/${channel.id}/posts/${textPost.json.data.id}`,{user:outsider,method:'DELETE'})).response.status,200);
    const unsubscribed=await api(`/channels/${channel.id}/subscribe`,{user:outsider,method:'DELETE'});
    assert.equal(unsubscribed.response.status,200);assert.equal(unsubscribed.json.data.isSubscribed,false);
    assert.equal(unsubscribed.json.data.role,'subscriber');assert.equal(unsubscribed.json.data.canPost,false);
    assert.equal(unsubscribed.json.data.subscriberCount,1);

    const conversations=await api('/messages/conversations');assert.equal(conversations.response.status,200);
    const conversation=conversations.json.data.find(item=>item.id===channel.id);
    assert.ok(conversation);assert.equal(conversation.groupAvatar,channelAvatar);
    assert.deepEqual(conversation.participants.map(item=>item.user.id),[owner.id],'channel roster is not exposed in conversations');
    assert.equal(JSON.stringify(conversations.json.data).includes('inviteTokenHash'),false,'invite hash never serializes');
    const listedGroup=conversations.json.data.find(item=>item.id===groupId);assert.equal(listedGroup.groupAvatar,groupAvatar);
  }finally{await new Promise(resolve=>http.close(resolve));}
});

test('new migration adds identity, channel and sticker structures while preserving legacy conversation membership',async()=>{
  const legacy=new PGlite();
  try{
    const directories=readdirSync('prisma/migrations').filter(d=>!d.endsWith('.toml')).sort();
    const last='20261104000000_google_channels_stickers_abuse';
    const channelPostPin='20261105000000_channel_post_pinning';
    for(const dir of directories.filter(d=>d!==last&&d!==channelPostPin))await legacy.exec(readFileSync(`prisma/migrations/${dir}/migration.sql`,'utf8'));
    await legacy.exec(`INSERT INTO users(id,username,email,password_hash,updated_at) VALUES
      ('owner','owner','owner@migration.test','hash',now()),('member','member','member@migration.test','hash',now());
      INSERT INTO conversations(id,is_group,group_name,created_at,updated_at) VALUES
      ('legacy-group',true,'Preserve group',now(),now()),('legacy-dm',false,NULL,now(),now());
      INSERT INTO conversation_participants(conversation_id,user_id,joined_at) VALUES
      ('legacy-group','owner',now()-interval '2 minutes'),('legacy-group','member',now()-interval '1 minute'),
      ('legacy-dm','owner',now()),('legacy-dm','member',now());`);
    await legacy.exec(readFileSync(`prisma/migrations/${last}/migration.sql`,'utf8'));
    await legacy.exec(readFileSync(`prisma/migrations/${channelPostPin}/migration.sql`,'utf8'));
    const pinColumn=(await legacy.query(`SELECT column_default FROM information_schema.columns WHERE table_name='messages' AND column_name='pinned'`)).rows[0];
    assert.equal(pinColumn.column_default,'false');
    const group=(await legacy.query(`SELECT kind::text,owner_id FROM conversations WHERE id='legacy-group'`)).rows[0];
    assert.deepEqual(group,{kind:'GROUP',owner_id:'owner'});
    assert.equal((await legacy.query(`SELECT role::text FROM conversation_participants WHERE conversation_id='legacy-group' AND user_id='owner'`)).rows[0].role,'ADMIN');
    assert.equal((await legacy.query(`SELECT kind::text FROM conversations WHERE id='legacy-dm'`)).rows[0].kind,'DIRECT');
    assert.equal((await legacy.query('SELECT count(*)::int AS n FROM google_identities')).rows[0].n,0);
    assert.equal((await legacy.query('SELECT count(*)::int AS n FROM stickers')).rows[0].n,0);
    await assert.rejects(legacy.exec(`INSERT INTO conversations(id,is_group,kind,created_at,updated_at) VALUES ('mismatch',false,'GROUP',now(),now())`));
  }finally{await legacy.close();}
});

test('Kafka consumer validates and routes durable group/channel membership and sticker events',async()=>{
  const emitted=[],left=[];const io={
    to(room){return{emit:(name,event)=>emitted.push({room,name,event})};},
    in(room){return{socketsLeave:async target=>left.push({room,target})};},
  };
  const membership={eventId:randomUUID(),conversationId:randomUUID(),kind:'CHANNEL',action:'member-removed',actorId:sender,memberIds:[reader],occurredAt:new Date().toISOString()};
  await routeEvent(io,'chat.membership',membership);
  assert.deepEqual(left,[{room:`user:${reader}`,target:`conversation:${membership.conversationId}`}]);
  assert.ok(emitted.some(e=>e.room===`conversation:${membership.conversationId}`&&e.name==='channel:membership'));
  assert.ok(emitted.some(e=>(e.room===`user:${reader}`||(Array.isArray(e.room)&&e.room.includes(`user:${reader}`)))&&e.name==='channel:membership'));
  await routeEvent(io,'chat.stickers',{eventId:randomUUID(),action:'created',actorId:sender,packId:randomUUID(),isPublic:true});
  assert.ok(emitted.some(e=>e.room===`user:${sender}`&&e.name==='stickers:pack-changed'));
  await assert.rejects(routeEvent(io,'chat.membership',{...membership,conversationId:'invalid'}));
});

test('message edits and direct-conversation deletion commit with durable outbox retries during Kafka failure',async()=>{
  const c=await conversation();const original=await service.sendMessage(c.id,sender,'before',reader);
  events.length=0;kafkaFails=true;
  try{
    const edited=await service.editMessage(original.id,sender,'after');assert.equal(edited.content,'after');
    const deleted=await service.deleteConversation(c.id,sender);assert.equal(deleted.conversationId,c.id);
  }finally{kafkaFails=false;}
  assert.equal((await prisma.message.findUnique({where:{id:original.id}})).content,'after');
  assert.ok((await prisma.conversationParticipant.findUnique({where:{conversationId_userId:{conversationId:c.id,userId:sender}}})).deletedAt);
  await prisma.receiptOutbox.updateMany({data:{availableAt:new Date(0)}});await publishReceipts();
  assert.ok(events.some(e=>e.name==='messageEdited'&&e.payload.messageId===original.id));
  assert.ok(events.some(e=>e.name==='conversationDeleted'&&e.payload.conversationId===c.id));
});

test('profile counts exclude soft-deleted posts and owned media URLs stay canonical across client origins', async () => {
  const { default: userRouter } = await import('../.cache/bundles/routes/user.routes.js');
  const { default: postRouter } = await import('../.cache/bundles/routes/post.routes.js');
  const { default: messageRouter } = await import('../.cache/bundles/routes/message.routes.js');
  const { createActivityRouter } = await import('../.cache/bundles/routes/activity.routes.js');
  const { default: mediaRouter } = await import('../.cache/bundles/routes/media.routes.js');
  const { canonicalUploadUrl } = await import('../.cache/bundles/config/media.js');
  ensureUploadDirs();

  const previousLimits = Object.fromEntries(['ABUSE_MEDIA_IP_MAX','ABUSE_MEDIA_USER_MAX','ABUSE_SOCIAL_IP_MAX','ABUSE_SOCIAL_USER_MAX']
    .map(name => [name, process.env[name]]));
  process.env.ABUSE_MEDIA_IP_MAX = '500'; process.env.ABUSE_MEDIA_USER_MAX = '500';
  process.env.ABUSE_SOCIAL_IP_MAX = '5000'; process.env.ABUSE_SOCIAL_USER_MAX = '5000';

  const app = express();
  app.use(express.json());
  app.use('/api/v1/users', userRouter);
  app.use('/api/v1/posts', postRouter);
  app.use('/api/v1/messages', messageRouter);
  app.use('/api/v1/notifications', createActivityRouter(true));
  app.use('/api/v1/media', mediaRouter);
  // Mirrors app.ts: optional identity, then the real ACL, then static media.
  app.use('/uploads', (req, _res, next) => {
    try {
      const value = req.headers.authorization?.slice(7);
      if (value) req.user = jwt.verify(value, process.env.JWT_SECRET);
    } catch { /* anonymous read */ }
    next();
  }, authorizeMedia, express.static(process.env.UPLOADS_PATH));
  app.use((err, req, res, _next) => res.status(err.statusCode ?? 400).json({ success: false, message: err.message }));

  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.on('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const base = `${origin}/api/v1`;
  const auth = id => ({ Authorization: `Bearer ${jwt.sign({ userId: id, username: id }, process.env.JWT_SECRET)}` });
  const jsonAuth = id => ({ ...auth(id), 'Content-Type': 'application/json' });
  const upload = async (route, field, mime, name, bytes, headers) => {
    const form = new FormData(); form.set(field, new Blob([bytes], {type: mime}), name);
    return fetch(`${base}/media${route}`, { method: 'POST', headers, body: form });
  };
  const publicPath = url => new URL(url).pathname;
  const account = await prisma.user.findUnique({ where: { id: sender }, select: { username: true } });
  const senderName = account.username;
  const beforeAvatar = (await prisma.user.findUnique({ where: { id: reader }, select: { avatarUrl: true } })).avatarUrl;
  const beforeBase = process.env.PUBLIC_MEDIA_BASE_URL;

  try {
    // 1. Soft-deleted posts disappear from profile and search counts and the author feed.
    const pub = await fetch(`${base}/posts`, { method: 'POST', headers: jsonAuth(sender), body: JSON.stringify({ content: 'counted post' }) });
    assert.equal(pub.status, 201);
    const pubId = (await pub.json()).data.id;
    const profileBefore = await (await fetch(`${base}/users/${senderName}`, { headers: auth(reader) })).json();
    const searchBefore = await (await fetch(`${base}/users/search?q=${senderName}`, { headers: auth(reader) })).json();
    assert.equal(searchBefore.data.find(u => u.username === senderName)._count.posts, profileBefore.data._count.posts);
    assert.equal((await fetch(`${base}/posts/${pubId}`, { method: 'DELETE', headers: auth(sender) })).status, 200);
    const profileAfter = await (await fetch(`${base}/users/${senderName}`, { headers: auth(reader) })).json();
    const searchAfter = await (await fetch(`${base}/users/search?q=${senderName}`, { headers: auth(reader) })).json();
    assert.equal(profileAfter.data._count.posts, profileBefore.data._count.posts - 1);
    assert.equal(searchAfter.data.find(u => u.username === senderName)._count.posts, profileAfter.data._count.posts);
    const authorFeed = await (await fetch(`${base}/posts/user/${senderName}?limit=50`, { headers: auth(reader) })).json();
    assert.ok(!authorFeed.data.posts.some(post => post.id === pubId));
    assert.equal(authorFeed.data.total, profileAfter.data._count.posts);

    // 2. Uploaded avatar is fetchable anonymously, including when the stored origin
    // differs from the origin the API was exercised on.
    const avatarBytes = await sharp({ create: { width: 320, height: 240, channels: 3, background: '#123456' } }).png().toBuffer();
    const avatarUpload = await upload('/upload/avatar', 'avatar', 'image/png', 'avatar.png', avatarBytes, auth(sender));
    assert.equal(avatarUpload.status, 201);
    const avatar = (await avatarUpload.json()).data;
    assert.match(avatar.url, /^https:\/\/media\.example\.com\/uploads\/images\/[a-zA-Z0-9_-]+\.webp$/);
    const patched = await fetch(`${base}/users/me`, { method: 'PATCH', headers: jsonAuth(sender), body: JSON.stringify({ avatarUrl: avatar.url }) });
    assert.equal(patched.status, 200);
    assert.equal((await patched.json()).data.avatarUrl, avatar.url);
    const anonymousAvatar = await fetch(`${origin}${publicPath(avatar.url)}`);
    assert.equal(anonymousAvatar.status, 200);
    assert.equal(anonymousAvatar.headers.get('content-type'), 'image/webp');
    assert.deepEqual(Buffer.from(await anonymousAvatar.arrayBuffer()).subarray(0, 4).toString('latin1'), 'RIFF');

    process.env.PUBLIC_MEDIA_BASE_URL = 'https://mobile-origin.example/uploads';
    const remoteUpload = await upload('/upload/avatar', 'avatar', 'image/png', 'avatar2.png', avatarBytes, auth(sender));
    assert.equal(remoteUpload.status, 201, await remoteUpload.clone().text());
    const remote = (await remoteUpload.json()).data;
    assert.match(remote.url, /^https:\/\/mobile-origin\.example\/uploads\/images\//);
    const remotePatch = await fetch(`${base}/users/me`, { method: 'PATCH', headers: jsonAuth(sender), body: JSON.stringify({ avatarUrl: remote.url }) });
    assert.equal(remotePatch.status, 200);
    assert.equal((await remotePatch.json()).data.avatarUrl, remote.url);
    assert.equal((await fetch(`${origin}${publicPath(remote.url)}`)).status, 200);
    process.env.PUBLIC_MEDIA_BASE_URL = beforeBase;

    // 3. Post images keep publicly reachable canonical URLs in every feed.
    const postImage = await upload('/upload', 'file', 'image/png', 'post.png', avatarBytes, auth(sender));
    assert.equal(postImage.status, 201);
    const image = (await postImage.json()).data;
    const created = await fetch(`${base}/posts`, { method: 'POST', headers: jsonAuth(sender), body: JSON.stringify({ content: '', imageUrls: [image.url] }) });
    assert.equal(created.status, 201);
    const createdPost = (await created.json()).data;
    assert.equal(createdPost.content, '');
    assert.deepEqual(createdPost.imageUrls, [image.url]);
    assert.equal(image.url, canonicalUploadUrl(new URL(image.url).pathname.split('/uploads/')[1]));
    const publicImage = await fetch(`${origin}${publicPath(image.url)}`);
    assert.equal(publicImage.status, 200);
    assert.equal(publicImage.headers.get('content-type'), 'image/png');
    assert.equal((await fetch(`${base}/posts/${createdPost.id}/save`, { method: 'POST', headers: auth(reader) })).status, 201);
    const viewer = randomUUID();
    await prisma.user.create({ data: { id: viewer, username: `v${viewer.replace(/-/g, '')}`, email: `${viewer}@test.dev`, passwordHash: 'unused' } });
    // Mark every pre-existing post as already seen by this fresh viewer so the
    // recommendation snapshot is deterministic: only the new image post qualifies.
    const otherPosts = await prisma.post.findMany({ where: { id: { not: createdPost.id } }, select: { id: true } });
    if (otherPosts.length) await prisma.exploreSeen.createMany({
      data: otherPosts.map(post => ({ sessionId: randomUUID(), userId: viewer, postId: post.id })), skipDuplicates: true,
    });
    const explore = await (await fetch(`${base}/posts/explore?limit=50`, { headers: auth(viewer) })).json();
    const feed = await (await fetch(`${base}/posts/feed?limit=50`, { headers: auth(reader) })).json();
    const saved = await (await fetch(`${base}/posts/saved`, { headers: auth(reader) })).json();
    const authorListing = await (await fetch(`${base}/posts/user/${senderName}?limit=50`, { headers: auth(reader) })).json();
    for (const [label, listing] of [['feed', feed.data], ['explore', explore.data], ['saved', saved.data], ['author', authorListing.data.posts]]) {
      const found = listing.find(post => post.id === createdPost.id);
      assert.ok(found, `${label} contains the image post`);
      assert.deepEqual(found.imageUrls, [image.url], `${label} exposes the canonical image URL`);
    }

    // 4. A fresh avatar is reflected immediately in profile, search, conversations and notifications.
    const freshBytes = await sharp({ create: { width: 200, height: 200, channels: 3, background: '#abcdef' } }).png().toBuffer();
    const freshUpload = await upload('/upload/avatar', 'avatar', 'image/png', 'fresh.png', freshBytes, auth(reader));
    assert.equal(freshUpload.status, 201);
    const fresh = (await freshUpload.json()).data;
    const freshPatch = await fetch(`${base}/users/me`, { method: 'PATCH', headers: jsonAuth(reader), body: JSON.stringify({ avatarUrl: fresh.url }) });
    assert.equal(freshPatch.status, 200);
    assert.equal((await freshPatch.json()).data.avatarUrl, fresh.url);
    const readerAccount = await prisma.user.findUnique({ where: { id: reader }, select: { username: true } });
    const freshProfile = await (await fetch(`${base}/users/${readerAccount.username}`, { headers: auth(reader) })).json();
    assert.equal(freshProfile.data.avatarUrl, fresh.url);
    const freshSearch = await (await fetch(`${base}/users/search?q=${readerAccount.username}`, { headers: auth(reader) })).json();
    assert.equal(freshSearch.data.find(user => user.username === readerAccount.username).avatarUrl, fresh.url);

    const reaction = await fetch(`${base}/posts/${createdPost.id}/like`, { method: 'POST', headers: auth(reader) });
    assert.equal(reaction.status, 201);
    const notifications = await (await fetch(`${base}/notifications`, { headers: auth(sender) })).json();
    const notification = notifications.data.items.find(item => item.actorId === reader && item.postId === createdPost.id);
    assert.ok(notification, 'the like notification exists');
    assert.equal(notification.actor.avatarUrl, fresh.url);

    const conversations = await (await fetch(`${base}/messages/conversations`, { headers: auth(reader) })).json();
    const participantRows = conversations.data.flatMap(conversation => conversation.participants)
      .filter(participant => participant.user.id === reader);
    assert.ok(participantRows.length > 0);
    assert.ok(participantRows.every(participant => participant.user.avatarUrl === fresh.url));

    // 5. Files without a public or authorized reference stay private.
    const orphan = await upload('/upload', 'file', 'image/png', 'orphan.png', avatarBytes, auth(sender));
    assert.equal(orphan.status, 201);
    const orphanUrl = (await orphan.json()).data.url;
    assert.equal((await fetch(`${origin}${publicPath(orphanUrl)}`)).status, 403);
    assert.equal((await fetch(`${origin}${publicPath(orphanUrl)}`, { headers: auth(reader) })).status, 403);

    // 6. Private hosts and device URIs are still rejected for public media.
    // LAN origins are allowed in development (device testing), but loopback,
    // link-local and device URIs are never accepted as public media.
    for (const invalid of ['http://localhost:3000/uploads/images/a.png', 'http://127.0.0.5/uploads/images/a.png',
      'https://[::1]/uploads/images/a.png', 'https://169.254.10.1/uploads/images/a.png',
      'file:///tmp/a.png', 'https://media.example.com/uploads/../secrets.png']) {
      const rejected = await fetch(`${base}/users/me`, { method: 'PATCH', headers: jsonAuth(sender), body: JSON.stringify({ avatarUrl: invalid }) });
      assert.equal(rejected.status, 400, invalid);
    }
  } finally {
    await prisma.user.update({ where: { id: reader }, data: { avatarUrl: beforeAvatar } });
    await new Promise(resolve => server.close(resolve));
    for (const [name, value] of Object.entries(previousLimits)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    process.env.PUBLIC_MEDIA_BASE_URL = beforeBase;
  }
});
