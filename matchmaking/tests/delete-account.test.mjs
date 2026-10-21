import test from "node:test";
import assert from "node:assert/strict";
import { createDeleteAccountHandler } from "../../supabase/functions/delete-matchmaking-account/handler.ts";

test("deletion requires a verified session and explicit confirmation", async () => {
  const deleted = [];
  const handle = createDeleteAccountHandler({ getUser: async token => token === "valid" ? { id: "owner" } : null, deleteUser: async id => deleted.push(id) });
  const call = (body, token, origin = "https://zebrabookclub.com") => handle(new Request("https://example.test/delete", { method: "POST", headers: { origin, ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) }));
  assert.equal((await call({ confirmation: "DELETE" })).status, 401);
  assert.equal((await call({ confirmation: "DELETE" }, "forged")).status, 401);
  assert.equal((await call({ confirmation: "delete" }, "valid")).status, 400);
  assert.equal((await call({ confirmation: "DELETE" }, "valid", "https://untrusted.example")).status, 403);
  assert.deepEqual(deleted, []);
  const response = await call({ confirmation: "DELETE", user_id: "someone-else" }, "valid");
  assert.equal(response.status, 200);
  assert.deepEqual(deleted, ["owner"]);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "https://zebrabookclub.com");
});

test("preflight is permitted and server failures do not report a successful deletion", async () => {
  const handle = createDeleteAccountHandler({ getUser: async () => ({ id: "owner" }), deleteUser: async () => { throw new Error("private internal details"); } });
  assert.equal((await handle(new Request("https://example.test", { method: "OPTIONS", headers: { origin: "http://127.0.0.1:8080" } }))).status, 204);
  const response = await handle(new Request("https://example.test", { method: "POST", headers: { authorization: "Bearer valid" }, body: JSON.stringify({ confirmation: "DELETE" }) }));
  assert.equal(response.status, 500);
  assert.ok(!(await response.text()).includes("private internal details"));
});
