// Optional native PostgreSQL integration suite. Never targets an existing app database:
// requires a loopback test-only admin account, creates and drops its own random DB.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync,readdirSync,mkdirSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {build} from 'esbuild';
import pg from 'pg';
import {PrismaPg} from '@prisma/adapter-pg';

async function concurrent(tasks) {
  const results=await Promise.allSettled(tasks);
  const failed=results.find(r=>r.status==='rejected');
  if(failed)throw failed.reason;
  return results.map(r=>r.value);
}
const url=process.env.TEST_POSTGRES_ADMIN_URL;
test('native PostgreSQL: concurrent comment likes, bookmarks, Explore refresh and signal replays', {skip:!url}, async()=>{
  const parsed=new URL(url);
  assert.ok(['127.0.0.1','localhost','[::1]'].includes(parsed.hostname),'Only loopback test servers are allowed');
  assert.equal(parsed.username,'social_test','Requires a dedicated test-only admin role');
  const admin=new pg.Pool({connectionString:url});const name=`social_test_${randomUUID().replaceAll('-','')}`;
  await admin.query(`CREATE DATABASE "${name}"`);
  parsed.pathname=`/${name}`;
  let tearingDown=false;
  const pool=new pg.Pool({connectionString:parsed.toString(),max:16});
  pool.on('error',error=>{if(!tearingDown)throw error;});let client;
  try{
    for(const dir of readdirSync('prisma/migrations').filter(d=>!d.endsWith('.toml')).sort())await pool.query(readFileSync(`prisma/migrations/${dir}/migration.sql`,'utf8'));
    mkdirSync('.cache',{recursive:true});
    writeFileSync('.cache/native-schema.prisma',readFileSync('prisma/schema.prisma','utf8').replace('provider = "prisma-client-js"','provider = "prisma-client-js"\n engineType = "client"\n output = "./native-client"'));
    execFileSync('node_modules/.bin/prisma',['generate','--schema','.cache/native-schema.prisma'],{env:{...process.env,PRISMA_SCHEMA_ENGINE_BINARY:'/bin/true',PRISMA_QUERY_ENGINE_LIBRARY:'/bin/true'}});
    const {PrismaClient}=await import('../.cache/native-client/index.js');client=new PrismaClient({adapter:new PrismaPg(pool)});
    globalThis.__socialNative={prisma:client,kafkaEvents:new Proxy({},{get:()=>async()=>{}})};
    await build({entryPoints:['src/services/post.service.ts','src/services/explore.service.ts','src/services/social-interaction.service.ts'],bundle:true,platform:'node',format:'esm',outdir:'.cache/native-bundles',packages:'external',plugins:[{name:'boundaries',setup(b){
      b.onResolve({filter:/config\/database\.js$/},()=>({path:'db',namespace:'native'}));
      b.onResolve({filter:/kafka\/producer\.js$/},()=>({path:'kafka',namespace:'native'}));
      b.onResolve({filter:/config\/logger\.js$/},()=>({path:'logger',namespace:'native'}));
      b.onLoad({filter:/.*/,namespace:'native'},({path})=>({contents:path==='db'?'export const prisma=globalThis.__socialNative.prisma;':path==='kafka'?'export const kafkaEvents=globalThis.__socialNative.kafkaEvents;':'export const logger={info(){},debug(){},warn(){},error(){}};'}));
    }}]});
    const {postService}=await import('../.cache/native-bundles/post.service.js');
    const {exploreService}=await import('../.cache/native-bundles/explore.service.js');
    const {processSocialInteraction}=await import('../.cache/native-bundles/social-interaction.service.js');
    const ids=Array.from({length:12},()=>randomUUID());
    for(const id of ids)await client.user.create({data:{id,username:id,email:`${id}@native.test`,passwordHash:'test-only'}});
    const [author,actor,viewer]=ids;const post=await postService.createPost(author,{content:'#native concurrency'});const comment=await postService.addComment(post.id,actor,'native comment');
    await concurrent(Array.from({length:24},()=>postService.setCommentLike(post.id,comment.id,actor,true)));
    assert.equal(await client.commentLike.count({where:{commentId:comment.id}}),1);
    await concurrent(ids.slice(3).map(id=>postService.setCommentLike(post.id,comment.id,id,true)));
    assert.equal((await postService.commentEngagement(post.id,comment.id,actor)).likesCount,10);
    await concurrent(Array.from({length:24},()=>postService.setCommentLike(post.id,comment.id,actor,false)));
    assert.equal(await client.commentLike.count({where:{commentId:comment.id}}),9);
    await concurrent(Array.from({length:20},()=>postService.savePost(post.id,actor)));
    assert.equal(await client.savedPost.count({where:{userId:actor,postId:post.id}}),1);
    const event={version:1,eventId:randomUUID(),type:'post.bookmarked',actorId:actor,postId:post.id};
    await concurrent(Array.from({length:16},()=>processSocialInteraction(event)));
    assert.equal((await client.postInterest.findUnique({where:{userId_postId:{userId:actor,postId:post.id}}})).weight,7);
    for(const id of ids.slice(3))await postService.createPost(id,{content:'#native explore'});
    const pages=await concurrent([exploreService.get(viewer,3),exploreService.get(viewer,3,undefined,true)]);
    assert.ok(pages[0].posts.length>0&&pages[1].posts.length>0);
    assert.ok(pages[0].posts.every(p=>!pages[1].posts.some(other=>other.id===p.id)));
    const race=await Promise.allSettled([postService.setCommentLike(post.id,comment.id,viewer,true),postService.deleteComment(post.id,comment.id,actor)]);
    assert.equal(race[1].status,'fulfilled');await assert.rejects(postService.commentEngagement(post.id,comment.id,actor),e=>e.statusCode===404);
    const plan=await pool.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT * FROM comment_likes WHERE comment_id=$1`,[comment.id]);
    const savedPlan=await pool.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT * FROM saved_posts WHERE user_id=$1 ORDER BY created_at DESC,post_id DESC LIMIT 20`,[actor]);
    const explorePlan=await pool.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
      SELECT p.id FROM posts p JOIN users u ON u.id=p.author_id
      WHERE p.deleted_at IS NULL AND u.deleted_at IS NULL AND u.account_status='ACTIVE' AND NOT u.is_private
      AND NOT EXISTS(SELECT 1 FROM follows f WHERE f.follower_id=$1 AND f.following_id=p.author_id)
      AND NOT EXISTS(SELECT 1 FROM explore_seen s WHERE s.user_id=$1 AND s.post_id=p.id AND s.seen_at>now()-interval '7 days')
      ORDER BY p.created_at DESC,p.id DESC LIMIT 300`,[viewer]);
    writeFileSync('.cache/social-query-plans.json',JSON.stringify({commentLikes:plan.rows,savedPosts:savedPlan.rows,explore:explorePlan.rows},null,2));
    assert.ok(plan.rows[0]['QUERY PLAN']);
  }finally{
    tearingDown=true;
    if(client)await client.$disconnect();await pool.end();
    await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);await admin.end();
  }
});
