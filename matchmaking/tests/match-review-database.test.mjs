import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { makeProfile } from '../src/profile.js';

test('private match reviews require membership and release, validate ratings, and preserve counterpart privacy', async t => {
  const db = new PGlite(); t.after(() => db.close());
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create table auth.users(id uuid primary key,email text);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema public,auth to anon,authenticated,service_role; grant execute on function auth.uid() to authenticated;`);
  const dir = new URL('../../supabase/migrations/', import.meta.url);
  for (const file of (await readdir(dir)).filter(f => f.endsWith('.sql')).sort()) await db.exec(await readFile(new URL(file,dir),'utf8'));
  const [A,B,C] = [1,2,3].map(i => `42000000-0000-4000-8000-00000000000${i}`);
  await db.exec("insert into public.matchmaking_books(work_id,title,author) values('OL4201W','Favorite','Author'),('OL4202W','Shared read','Author'),('OL4203W','New shared read','Author')");
  for (const [i,id] of [A,B,C].entries()) {
    await db.query('insert into auth.users values($1,$2)',[id,`reader${i}@example.invalid`]);
    const p={user_id:id,...makeProfile({display_name:`Reader ${i}`,birth_date:'1994-06-15',city_id:5378538,city:'Oakland',country:'United States',intents:['friends'],favorite_book_id:'OL4201W',location_preference:'anywhere',friendship_interests:'Books and walks',instagram_handle:`reader${i}`})};
    await db.query(`insert into public.matchmaking_profiles(${Object.keys(p).join(',')}) values(${Object.keys(p).map((_,j)=>`$${j+1}`).join(',')})`,Object.values(p));
  }
  async function asUser(id,run) {
    await db.exec('set role authenticated'); await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id||'']);
    try{return await run()}finally{await db.exec('reset role')}
  }
  const get=(u,id)=>asUser(u,async()=> (await db.query('select public.get_my_matchmaking_match_review($1) data',[id])).rows[0].data);
  const save=(u,id,a=4,b=5,book='OL4202W')=>asUser(u,async()=> (await db.query('select public.save_matchmaking_match_review($1,$2,$3,$4) data',[id,a,b,book])).rows[0].data);
  async function pair(at) {
    const id=(await db.query("insert into public.matchmaking_matches(week_start,intent,reason,recommended_book_id,recommendation_reason) values('2026-11-02','friends','Shared shelves','OL4202W','A new shared read') returning id")).rows[0].id;
    for(const u of [A,B])await db.query("insert into public.matchmaking_match_members(match_id,week_start,user_id) values($1,'2026-11-02',$2)",[id,u]);
    if(at)await db.query('update public.matchmaking_matches set released_at=$2 where id=$1',[id,at]);return id;
  }
  const released=await pair('2000-01-01'),draft=await pair(null),future=await pair('2999-01-01');
  await t.test('anonymous, outsiders, drafts, future and malformed pairs cannot read or write',async()=>{
    for(const [u,id] of [[null,released],[C,released],[A,draft],[A,future]]){
      await assert.rejects(get(u,id),e=>e.code==='42501');await assert.rejects(save(u,id),e=>e.code==='42501');
    }
    await db.exec('set role anon');try{await assert.rejects(db.query('select public.get_my_matchmaking_match_review($1)',[released]),e=>e.code==='42501')}finally{await db.exec('reset role')}
    const invalid=await pair('2000-01-01');await db.query('delete from public.matchmaking_match_members where match_id=$1 and user_id=$2',[invalid,B]);
    await assert.rejects(get(A,invalid),e=>e.code==='42501');await assert.rejects(save(A,invalid),e=>e.code==='42501');
  });
  await t.test('one editable review per member, never their counterpart’s ratings',async()=>{
    assert.equal(await get(A,released),null);const first=await save(A,released);assert.equal(first.compatibility_rating,4);assert.equal(first.book_rating,5);
    assert.equal(await get(B,released),null);await save(B,released,1,2);assert.equal((await get(A,released)).compatibility_rating,4);
    assert.deepEqual(await save(A,released),first,'identical retry preserves timestamp');await save(A,released,3,4);
    assert.equal((await get(A,released)).compatibility_rating,3);assert.equal((await get(B,released)).compatibility_rating,1);
    assert.equal((await db.query('select count(*)::int n from public.matchmaking_match_reviews where match_id=$1',[released])).rows[0].n,2);
    const response=await asUser(B,async()=> (await db.query('select public.get_my_matchmaking_introductions() data')).rows[0].data);
    assert.ok(!JSON.stringify(response).includes('compatibility_rating'));assert.ok(!JSON.stringify(response).includes('book_rating'));
  });
  await t.test('ratings reject invalid values and a stale or fabricated recommendation',async()=>{
    for(const [a,b]of [[0,3],[6,3],[null,3],[4,0],[4,6],[4,null]])await assert.rejects(save(A,released,a,b),/INVALID_MATCH_REVIEW_RATING/);
    await assert.rejects(save(A,released,3,3,'OL4203W'),/MATCH_RECOMMENDATION_CHANGED/);
    await db.query("update public.matchmaking_matches set recommended_book_id='OL4203W' where id=$1",[released]);
    await assert.rejects(save(A,released),/MATCH_RECOMMENDATION_CHANGED/);assert.equal((await save(A,released,4,2,'OL4203W')).recommended_book_id,'OL4203W');
  });
  await t.test('raw table access denied even to participants and records cascade with memberships',async()=>{
    for(const sql of ['select * from public.matchmaking_match_reviews','delete from public.matchmaking_match_reviews','update public.matchmaking_match_reviews set compatibility_rating=5'])await assert.rejects(asUser(A,()=>db.query(sql)),e=>e.code==='42501');
    await db.query('delete from public.matchmaking_match_members where match_id=$1 and user_id=$2',[released,A]);
    assert.equal((await db.query('select count(*)::int n from public.matchmaking_match_reviews where user_id=$1',[A])).rows[0].n,0);
    await assert.rejects(get(B,released),/MATCH_REVIEW_NOT_AVAILABLE/);
    await db.query('delete from public.matchmaking_matches where id=$1',[released]);assert.equal((await db.query('select count(*)::int n from public.matchmaking_match_reviews')).rows[0].n,0);
  });
});
