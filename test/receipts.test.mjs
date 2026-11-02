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
const query = async (q, values) => {
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
const kafkaEvents = Object.fromEntries(['messageRead','messageDelivered','chatMessage','notification','notificationUpdated','notificationState','messageDeleted','messageDeletedForMe','conversationDeleted'].map(name => [name, async payload => {
  if (kafkaFails) throw Error('Kafka unavailable');
  events.push({ name, payload });
}]));
const deliveryValues = new Map();
let deliveryRedisFails = false;
const deliveryRedis = {
  async get(key) { if(deliveryRedisFails) throw Error('Redis unavailable'); const v=deliveryValues.get(key); if(v && v.expires>Date.now()) return v.value; deliveryValues.delete(key); return null; },
  async set(key,value,ex,ttl,nx) { if(nx==='NX' && deliveryValues.get(key)?.expires>Date.now()) return null; if(deliveryRedisFails) throw Error('Redis unavailable'); deliveryValues.set(key,{value,expires:Date.now()+ttl*1000}); return 'OK'; },
  async eval(script,n,key,value) { if(deliveryRedisFails) throw Error('Redis unavailable'); if(await this.get(key)===value) return deliveryValues.delete(key)?1:0; return 0; },
};
globalThis.__receiptTest = { prisma, kafkaEvents, deliveryRedis };
await build({ entryPoints: ['src/services/push-device.service.ts', 'src/services/push-delivery.service.ts', 'src/services/expo-push.provider.ts', 'src/services/delivery-state.service.ts', 'src/routes/push.routes.ts', 'src/socket/push.handler.ts', 'src/config/push.ts', 'src/socket/authenticate.ts', 'src/config/media.ts', 'src/services/post.service.ts', 'src/services/user.service.ts', 'src/services/activity.service.ts', 'src/services/media.service.ts', 'src/routes/media.routes.ts', 'src/routes/post.routes.ts', 'src/routes/activity.routes.ts', 'src/middlewares/media-access.ts', 'src/middlewares/upload.ts', 'src/services/message.service.ts', 'src/services/receipt-outbox.service.ts', 'src/socket/chat.handler.ts', 'src/kafka/consumer.ts', 'src/routes/message.routes.ts'],
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
  return prisma.conversation.create({ data: { isGroup, participants: { create: (isGroup ? ids.slice(0,3) : ids.slice(0,2)).map(userId => ({userId})) } } });
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
    for (const url of ['http://localhost:3000/uploads','https://127.0.0.1/uploads','http://api.example.com/uploads','https://app/uploads']) {
      process.env.PUBLIC_MEDIA_BASE_URL = url; assert.throws(mediaBaseUrl);
    }
    for (const url of ['file:///phone/image.jpg','content://device/media','http://127.0.0.1/a','https://localhost/a']) assert.equal(isSharedMediaUrl(url),false);
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
test('additive media/activity migration preserves legacy comments and dangling navigation references', async () => {
  const legacy = new PGlite();
  try {
    const directories = readdirSync('prisma/migrations').filter(d => !d.endsWith('.toml')).sort();
    const added = ['20261031000000_media_comments_activity', '20261031010000_notification_lifecycle'];
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
