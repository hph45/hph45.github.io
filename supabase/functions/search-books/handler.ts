type Book = { work_id: string; title: string; author: string; cover_id: number | null };
type SearchActions = {
  authenticate: (token: string) => Promise<boolean>;
  cached: (query: string) => Promise<Book[] | null>;
  reserve: () => Promise<boolean>;
  search: (query: string) => Promise<unknown>;
  save: (query: string, books: Book[]) => Promise<void>;
};

export function normalizeBooks(response: unknown): Book[] {
  const docs = (response as { docs?: unknown[] })?.docs;
  if (!Array.isArray(docs)) throw new Error("Invalid book response");
  const books = new Map<string, Book>();
  for (const raw of docs.slice(0, 12)) {
    const doc = raw as { key?: string; title?: string; author_name?: string[]; cover_i?: number };
    const work_id = typeof doc.key === "string" ? doc.key.replace(/^\/works\//, "") : "";
    if (!/^OL\d+W$/.test(work_id) || typeof doc.title !== "string" || !doc.title.trim()) continue;
    const names = Array.isArray(doc.author_name) ? doc.author_name.filter(name => typeof name === "string") : [];
    const cover_id = Number.isSafeInteger(doc.cover_i) && doc.cover_i! > 0 ? doc.cover_i! : null;
    books.set(work_id, { work_id, title: doc.title.trim().slice(0, 300), author: (names.join(", ").trim() || "Unknown author").slice(0, 300), cover_id });
  }
  return [...books.values()].slice(0, 8);
}

export function createBookSearchHandler(actions: SearchActions) {
  return async (request: Request): Promise<Response> => {
    const origin = request.headers.get("origin");
    const allowed = ["https://zebrabookclub.com", "http://127.0.0.1:8080", "http://localhost:8080"];
    const headers: Record<string, string> = { "Content-Type": "application/json", "Cache-Control": "no-store", "Vary": "Origin", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
    if (origin && allowed.includes(origin)) headers["Access-Control-Allow-Origin"] = origin;
    const respond = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers });
    if (origin && !allowed.includes(origin)) return respond(403, { error: "Origin not allowed" });
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    if (request.method !== "POST") return respond(405, { error: "Use POST" });
    const token = request.headers.get("authorization")?.match(/^Bearer (\S+)$/i)?.[1];
    if (!token) return respond(401, { error: "Sign in first" });
    try {
      if (!await actions.authenticate(token)) return respond(401, { error: "Sign in again" });
      let body;
      try { body = await request.json(); } catch { return respond(400, { error: "Invalid request" }); }
      if (body?.work_id !== undefined && (typeof body.work_id !== "string" || !/^OL\d+W$/.test(body.work_id))) return respond(400, { error: "Choose a valid book" });
      const query = body?.work_id ? `key:/works/${body.work_id}`
        : typeof body?.query === "string" ? body.query.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase() : "";
      if (query.length < 2 || query.length > 120) return respond(400, { error: "Enter 2–120 characters" });
      const cached = await actions.cached(query);
      if (cached) return respond(200, { books: cached });
      if (!await actions.reserve()) return respond(429, { error: "Search is busy. Please try again.", retry_after: 1 });
      const books = normalizeBooks(await actions.search(query));
      await actions.save(query, books);
      return respond(200, { books });
    } catch { return respond(503, { error: "Book search is temporarily unavailable" }); }
  };
}
