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
const kafkaEvents = Object.fromEntries(['messageRead','messageDelivered','chatMessage','notification','messageDeleted','messageDeletedForMe','conversationDeleted'].map(name => [name, async payload => {
  if (kafkaFails) throw Error('Kafka unavailable');
  events.push({ name, payload });
}]));
globalThis.__receiptTest = { prisma, kafkaEvents };
await build({ entryPoints: ['src/config/media.ts', 'src/services/post.service.ts', 'src/services/user.service.ts', 'src/services/activity.service.ts', 'src/services/media.service.ts', 'src/routes/media.routes.ts', 'src/routes/post.routes.ts', 'src/routes/activity.routes.ts', 'src/middlewares/media-access.ts', 'src/middlewares/upload.ts', 'src/services/message.service.ts', 'src/services/receipt-outbox.service.ts', 'src/socket/chat.handler.ts', 'src/kafka/consumer.ts', 'src/routes/message.routes.ts'],
  bundle: true, platform: 'node', format: 'esm', outdir: '.cache/bundles', packages: 'external',
  plugins: [{ name: 'boundaries', setup(b) {
    b.onResolve({ filter: /config\/redis\.js$/ }, () => ({ path: 'redis', namespace: 'test' }));
    b.onResolve({ filter: /config\/database\.js$/ }, () => ({ path: 'db', namespace: 'test' }));
    b.onResolve({ filter: /kafka\/producer\.js$|^\.\/producer\.js$/ }, () => ({ path: 'kafka', namespace: 'test' }));
    b.onResolve({ filter: /config\/logger\.js$/ }, () => ({ path: 'logger', namespace: 'test' }));
    b.onLoad({ filter: /.*/, namespace: 'test' }, ({path}) => ({ contents: path === 'redis' ? 'export const redisClient={set:async()=>null};' : path === 'db' ? 'export const prisma=globalThis.__receiptTest.prisma;' : path === 'kafka' ? 'export const kafkaEvents=globalThis.__receiptTest.kafkaEvents;' : 'export const logger={info(){},debug(){},error(){},warn(){}};' }));
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
  assert.equal(emitted.filter(e => e.name === 'message:new').length, 2);
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
  assert.equal((await activityService.list(sender, 1, 200)).items.find(i => i.id === item.id).post, null);
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
    for (const dir of directories.slice(0,-1)) await legacy.exec(readFileSync(`prisma/migrations/${dir}/migration.sql`,'utf8'));
    await legacy.exec(`INSERT INTO users(id,username,email,password_hash,updated_at) VALUES ('legacy','legacy','legacy@test.dev','hash',now());
      INSERT INTO posts(id,content,image_urls,author_id,updated_at) VALUES ('post','retained',ARRAY['https://example.com/image.png'],'legacy',now());
      INSERT INTO comments(id,content,author_id,post_id,replied_to_id) VALUES ('comment','retained','legacy','post','missing');
      INSERT INTO notifications(id,type,content,user_id,actor_id) VALUES ('notification','COMMENT','retained','legacy','missing');`);
    await legacy.exec(readFileSync(`prisma/migrations/${directories.at(-1)}/migration.sql`,'utf8'));
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
