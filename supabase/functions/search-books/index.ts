import { createClient } from "npm:@supabase/supabase-js@2.118.0";
import { createBookSearchHandler } from "./handler.ts";

const keys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}");
const admin = createClient(Deno.env.get("SUPABASE_URL")!, keys.default || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

Deno.serve(createBookSearchHandler({
  async authenticate(token) {
    const { data, error } = await admin.auth.getUser(token);
    return !error && Boolean(data.user);
  },
  async cached(query) {
    const { data, error } = await admin.from("matchmaking_book_search_cache").select("results")
      .eq("query", query).gt("expires_at", new Date().toISOString()).maybeSingle();
    if (error) throw error;
    return data?.results ?? null;
  },
  async reserve() {
    const { data, error } = await admin.rpc("reserve_matchmaking_book_search");
    if (error) throw error;
    return data === true;
  },
  async search(query) {
    const url = new URL("https://openlibrary.org/search.json");
    url.search = new URLSearchParams({ q: query, fields: "key,title,author_name,cover_i", limit: "8", lang: "en" }).toString();
    const response = await fetch(url, { headers: { "User-Agent": "ZebraBookClub/1.0 (henry@zebrabookclub.com)", "email": "henry@zebrabookclub.com" }, signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error("Book service unavailable");
    return response.json();
  },
  async save(query, books) {
    if (books.length) {
      const catalog = books.map(({ work_id, title, author }) => ({ work_id, title, author }));
      const { error } = await admin.from("matchmaking_books").upsert(catalog, { onConflict: "work_id" });
      if (error) throw error;
    }
    const { error } = await admin.from("matchmaking_book_search_cache").upsert({ query, results: books, expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() });
    if (error) throw error;
  },
}));
