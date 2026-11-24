import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "./config.js";
import { createMatchmakingApp } from "./ui.js";
import { openGuestCommunity } from "./guest-community.js";

const communityPage = document.querySelector("[data-community-page]");
const client = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: { flowType: "pkce", detectSessionInUrl: !communityPage, persistSession: true, autoRefreshToken: true },
});

if (communityPage) {
  openGuestCommunity(client.auth, communityPage, window);
} else {
  const app = createMatchmakingApp({ client, document, window });
  void app.start();
}
