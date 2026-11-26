import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { Window } from "happy-dom";
import { createMatchmakingApp } from "../src/ui.js";
import { makeProfile } from "../src/profile.js";

test("the web bookshelf reads and edits the app's private quarter-star library", async t => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create table auth.users(id uuid primary key, email text);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema public,auth to anon,authenticated,service_role; grant execute on function auth.uid() to authenticated;`);
  const dir = new URL("../../supabase/migrations/", import.meta.url);
  for (const file of (await readdir(dir)).filter(f => f.endsWith(".sql")).sort()) await db.exec(await readFile(new URL(file, dir), "utf8"));
  const member = { id: "00000000-0000-4000-8000-000000000001", email: "reader@example.invalid" };
  const profile = { user_id: member.id, ...makeProfile({ display_name: "Reader", birth_date: "1994-06-15", instagram_handle: "fixture.books",
    city_id: 5378538, city: "Oakland", country: "United States", intent: "friends", friendship_interests: "Quiet bookshops",
    location_preference: "anywhere", favorite_book_id: "OL1001W", favorite_book: "Fixture 1", favorite_author: "F. Writer" }) };
  await db.query("insert into auth.users values ($1,$2)", [member.id, member.email]);
  await db.exec(`insert into public.matchmaking_books(work_id,title,author)
    select 'OL'||(1000+i)||'W','Fixture '||i,'F. Writer' from generate_series(1,26) i;`);
  const keys = Object.keys(profile);
  await db.query(`insert into public.matchmaking_profiles (${keys.join(",")}) values (${keys.map((_,i)=>"$"+(i+1)).join(",")})`, Object.values(profile));
  await db.query(`insert into public.matchmaking_library_books(user_id,work_id,rating,updated_at)
    select $1,'OL'||(1000+i)||'W',3.75,'2026-10-01'::timestamptz+i*interval '1 minute' from generate_series(1,26) i`, [member.id]);
  await db.exec("set role authenticated");
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [member.id]);
  const favorite = () => db.query("select favorite_book_id,books_updated_at,current_book_updated_at from public.matchmaking_profiles");
  const before = (await favorite()).rows;
  const window = new Window({ url: "http://localhost/matchmaking/", settings: { disableCSSFileLoading: true, disableJavaScriptFileLoading: true, enableJavaScriptEvaluation: false } });
  window.document.write(await readFile(new URL("../index.html", import.meta.url), "utf8"));
  const rpcCalls = [];
  let failNext = "", interceptList, authListener;
  const client = {
    auth: { getSession: async () => ({ data: { session: { user: member } } }),
      onAuthStateChange(callback) { authListener = callback; return { data: { subscription: { unsubscribe() {} } } }; } },
    from(table) {
      let id;
      const query = { select() { return query; }, eq(key, value) { if (key === "work_id") id = value; return query; },
        async maybeSingle() { return { data: table === "matchmaking_profiles" ? profile :
          (await db.query("select rating from public.matchmaking_library_books where work_id=$1", [id])).rows[0] || null }; } };
      return query;
    },
    async rpc(name, args) {
      rpcCalls.push(name);
      if (failNext === name) { failNext = ""; return { error: Error("Network unavailable") }; }
      if (name === "get_my_matchmaking_library") {
        const response = { data: (await db.query("select * from public.get_my_matchmaking_library($1,$2)", [args.p_offset, args.p_limit])).rows };
        if (interceptList) await interceptList();
        return response;
      }
      if (name === "save_my_matchmaking_library_book") return { data: (await db.query("select public.save_my_matchmaking_library_book($1,$2,$3,$4) as item",
        [args.p_work_id,args.p_title,args.p_author,args.p_rating])).rows[0].item };
      if (name === "add_my_unrated_matchmaking_library_book") return { data: await db.query("select public.add_my_unrated_matchmaking_library_book($1,$2,$3)", [args.p_work_id,args.p_title,args.p_author]) };
      if (name === "remove_my_matchmaking_library_book") return { data: await db.query("select public.remove_my_matchmaking_library_book($1)", [args.p_work_id]) };
      if (name === "get_matchmaking_community") return { data: { total_members: 1, cities: [], countries: [], top_books: [], rising_books: [] } };
      return { data: { items: [], total_count: 0, next_cursor: null } };
    },
  };
  const app = createMatchmakingApp({ client, window, document: window.document,
    fetch: async path => ({ ok: true, text: async () => "", json: async () => path.includes("/books.") ?
      { version: 1, books: [["OL1001W","Fixture 1","F. Writer"]] } : { external: { google: true } } }) });
  t.after(async () => { app.destroy(); await window.happyDOM.close(); });
  const $ = selector => window.document.querySelector(selector);
  const fire = (selector, name) => $(selector).dispatchEvent(new window.Event(name, { bubbles: true, cancelable: true }));
  const event = async (selector, name = "click") => { fire(selector,name); await app.settled(); };
  const next = () => event("#bookshelf-form","submit");
  async function manual(name, author) {
    await event("#bookshelf-add"); $("#bookshelf-book").value = name; $("#bookshelf-author").value = author; await next();
  }
  await app.start();
  assert.ok(!rpcCalls.includes("get_my_matchmaking_library"), "load private books only when opened");
  await event("#edit-bookshelf");
  assert.equal($("#bookshelf-view").hidden, false);
  assert.equal($("#bookshelf-list").childElementCount, 24);
  await event("#bookshelf-more"); assert.equal($("#bookshelf-list").childElementCount, 26);
  await event('[data-work-id="OL1001W"]'); assert.equal($("#bookshelf-rating").textContent, "3.75 out of 5 stars");
  await event('#bookshelf-stars button[value="4"]'); await next();
  assert.equal(Number((await db.query("select rating from public.get_my_matchmaking_library() where work_id='OL1001W'")).rows[0].rating), 4);
  await manual("An unlisted novel", "A. Writer");
  for (let i = 0; i < 3; i++) await event('#bookshelf-stars button[value="5"]');
  assert.equal($("#bookshelf-rating").textContent, "4.75 out of 5 stars");
  failNext = "save_my_matchmaking_library_book"; await next();
  assert.ok($("#bookshelf-dialog").open); assert.equal($("#bookshelf-error").hidden, false);
  await next();
  assert.equal($("#bookshelf-dialog").open, false);
  let entry = (await db.query("select * from public.get_my_matchmaking_library() where title='An unlisted novel'")).rows[0];
  assert.match(entry.work_id, /^ZB/); assert.equal(Number(entry.rating), 4.75);
  await manual("An unlisted novel", "A. Writer"); await next();
  const saved = (await db.query("select * from public.get_my_matchmaking_library() where title='An unlisted novel'")).rows;
  assert.equal(saved.length, 1); assert.equal(Number(saved[0].rating), 4.75);
  await event(`[data-work-id="${entry.work_id}"]`); await event("#bookshelf-clear"); await next();
  assert.equal((await db.query("select rating from public.get_my_matchmaking_library() where work_id=$1", [entry.work_id])).rows[0].rating, null);
  await event(`[data-work-id="${entry.work_id}"]`); await event("#bookshelf-remove"); await event("#bookshelf-keep");
  await event("#bookshelf-remove"); await event("#bookshelf-confirm-remove");
  assert.equal((await db.query("select count(*)::int as n from public.get_my_matchmaking_library() where work_id=$1", [entry.work_id])).rows[0].n, 0);
  assert.deepEqual((await favorite()).rows, before);
  await event("#bookshelf-back"); assert.equal($("#dashboard-view").hidden, false);
  failNext = "get_my_matchmaking_library"; await event("#edit-bookshelf");
  assert.equal($("#bookshelf-more").textContent, "Try again"); await event("#bookshelf-more");
  assert.equal($("#bookshelf-list").childElementCount, 24);
  let unblock, started;
  const pending = new Promise(resolve => { unblock = resolve; });
  const requestStarted = new Promise(resolve => { started = resolve; });
  interceptList = async () => { started(); await pending; };
  fire("#bookshelf-more","click"); await requestStarted;
  authListener("SIGNED_OUT", null);
  for (let i = 0; i < 50 && $("#welcome-view").hidden; i++) await new Promise(resolve => setTimeout(resolve, 5));
  unblock(); await app.settled();
  assert.equal($("#welcome-view").hidden, false);
  assert.equal($("#bookshelf-list").childElementCount, 0); assert.equal($("#bookshelf-dialog").open, false);
});
