import { createClient } from 'npm:@supabase/supabase-js@2.118.0';
import { createDeleteAccountHandler } from './handler.ts';
import { createAppleRevoker } from './apple.ts';

// Supabase injects privileged keys on the server. Never bundle these in iOS.
const keys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}');
const admin = createClient(Deno.env.get('SUPABASE_URL')!,
  keys.default || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  {auth:{persistSession:false,autoRefreshToken:false}});
const apple = {
  clientID:Deno.env.get('APPLE_CLIENT_ID') || 'com.zebrabookclub.ios',
  teamID:Deno.env.get('APPLE_TEAM_ID') || '',
  keyID:Deno.env.get('APPLE_KEY_ID') || '',
  privateKey:(Deno.env.get('APPLE_PRIVATE_KEY') || '').replace(/\\n/g,'\n'),
};
const appleReady = Boolean(apple.teamID && apple.keyID && apple.privateKey);
Deno.serve(createDeleteAccountHandler({
  async getUser(token) {
    const {data,error} = await admin.auth.getUser(token);
    return error ? null : data.user;
  },
  async deleteUser(id) {
    const {error} = await admin.auth.admin.deleteUser(id);
    if (error) throw error;
  },
  appleRevocationConfigured:()=>appleReady,
  revokeApple:createAppleRevoker(apple),
}));
