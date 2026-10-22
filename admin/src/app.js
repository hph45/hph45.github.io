import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "../../matchmaking/src/config.js";
import { createAdminApp } from "./ui.js";

// The same origin and Auth storage as /matchmaking/ reuse the Google session.
// The database checks admin access for every statistics request.
const client = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: { flowType: "pkce", detectSessionInUrl: false, persistSession: true, autoRefreshToken: true },
});
const app = createAdminApp({ client, document, window });
void app.start();
