type AccountActions = {
  getUser: (token: string) => Promise<{ id: string } | null>;
  deleteUser: (id: string) => Promise<void>;
};

const origins = new Set([
  "https://zebrabookclub.com",
  "http://localhost:8080",
  "http://127.0.0.1:8080",
]);

export function createDeleteAccountHandler(actions: AccountActions) {
  return async (request: Request): Promise<Response> => {
    const origin = request.headers.get("origin");
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Vary": "Origin",
      "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
    };
    if (origin && origins.has(origin)) headers["Access-Control-Allow-Origin"] = origin;
    const respond = (status: number, body: Record<string, unknown>) => new Response(JSON.stringify(body), { status, headers });
    if (origin && !origins.has(origin)) return respond(403, { error: "Origin not allowed" });
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    if (request.method !== "POST") return respond(405, { error: "Use POST" });
    const token = request.headers.get("authorization")?.match(/^Bearer (\S+)$/i)?.[1];
    if (!token) return respond(401, { error: "Sign in first" });

    try {
      // Always validate with Supabase Auth. Never trust a user_id from the body,
      // an unverified JWT payload, or the public publishable key as identity.
      const user = await actions.getUser(token);
      if (!user) return respond(401, { error: "Sign in again" });
      let body;
      try { body = await request.json(); } catch { return respond(400, { error: "Invalid request" }); }
      if (body?.confirmation !== "DELETE") return respond(400, { error: "Confirmation required" });
      await actions.deleteUser(user.id);
      return respond(200, { deleted: true });
    } catch {
      return respond(500, { error: "Account deletion is temporarily unavailable" });
    }
  };
}
