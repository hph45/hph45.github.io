// The publishable key is public. Database grants and RLS protect member data.
// Never add a Supabase secret key, Google client secret, or email API key here.
export const SUPABASE_URL = "https://nvgwfygusjwjgqtlpnyf.supabase.co";
export const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_-Z0UxgUw3aVdJw0AnKmXeQ_vR_bIhS3";
export const PROFILE_TABLE = "matchmaking_profiles";

export function getAuthRedirect(location) {
  return new URL("/matchmaking/", location.origin).href;
}
