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
const kafkaEvents = Object.fromEntries(['messageRead','messageDelivered','chatMessage','conversationDeleted'].map(name => [name, async payload => {
  if (kafkaFails) throw Error('Kafka unavailable');
  events.push({ name, payload });
}]));
globalThis.__receiptTest = { prisma, kafkaEvents };
await build({ entryPoints: ['src/services/message.service.ts', 'src/services/receipt-outbox.service.ts', 'src/socket/chat.handler.ts', 'src/kafka/consumer.ts', 'src/routes/message.routes.ts'],
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
