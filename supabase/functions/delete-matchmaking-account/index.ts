import { createClient } from "npm:@supabase/supabase-js@2.118.0";
import { createDeleteAccountHandler } from "./handler.ts";

// Supabase injects these on the server. Nothing privileged is bundled into the site.
const keys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}");
const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  keys.default || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

Deno.serve(createDeleteAccountHandler({
  async getUser(token) {
    const { data, error } = await admin.auth.getUser(token);
    return error ? null : data.user;
  },
  async deleteUser(id) {
    const { error } = await admin.auth.admin.deleteUser(id);
    if (error) throw error;
  },
}));
