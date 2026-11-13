export type AccountUser = {
  id: string;
  identities?: Array<{ provider: string; identity_data?: { [key: string]: unknown } }>;
};
export class AppleRevocationError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.code = code; }
}
type AccountActions = {
  getUser: (token: string) => Promise<AccountUser | null>;
  deleteUser: (id: string) => Promise<void>;
  appleRevocationConfigured?: () => boolean;
  revokeApple?: (code: string, subjects: string[]) => Promise<void>;
};
const origins = new Set(['https://zebrabookclub.com','http://localhost:8080','http://127.0.0.1:8080']);

export function createDeleteAccountHandler(actions: AccountActions) {
  return async (request: Request): Promise<Response> => {
    const origin = request.headers.get('origin');
    const headers: Record<string,string> = {
      'Content-Type':'application/json','Cache-Control':'no-store','Vary':'Origin',
      'Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type',
      'Access-Control-Allow-Methods':'POST, OPTIONS',
    };
    if (origin && origins.has(origin)) headers['Access-Control-Allow-Origin'] = origin;
    const respond = (status: number, body: Record<string,unknown>) => new Response(JSON.stringify(body), {status,headers});
    if (origin && !origins.has(origin)) return respond(403,{error:'ORIGIN_NOT_ALLOWED'});
    if (request.method === 'OPTIONS') return new Response(null,{status:204,headers});
    if (request.method !== 'POST') return respond(405,{error:'POST_REQUIRED'});
    const token = request.headers.get('authorization')?.match(/^Bearer (\S+)$/i)?.[1];
    if (!token) return respond(401,{error:'SIGN_IN_REQUIRED'});
    try {
      // Supabase Auth validates the token. Body IDs/claims never select an account.
      const user = await actions.getUser(token);
      if (!user) return respond(401,{error:'SIGN_IN_REQUIRED'});
      if (Number(request.headers.get('content-length')) > 8192) return respond(413,{error:'REQUEST_TOO_LARGE'});
      const raw = await request.text();
      if (raw.length > 8192) return respond(413,{error:'REQUEST_TOO_LARGE'});
      let body;
      try { body = JSON.parse(raw); } catch { return respond(400,{error:'INVALID_REQUEST'}); }
      if (body?.confirmation !== 'DELETE') return respond(400,{error:'CONFIRMATION_REQUIRED'});
      const code = body.apple_authorization_code;
      if (code != null && (typeof code !== 'string' || !code.trim() || code.length > 2048)) {
        return respond(400,{error:'INVALID_APPLE_AUTHORIZATION'});
      }
      let appleRevocation = 'not_applicable';
      const appleIdentities = user.identities?.filter(identity => identity.provider === 'apple') || [];
      if (appleIdentities.length) {
        appleRevocation = 'manual_required';
        if (code && actions.revokeApple && actions.appleRevocationConfigured?.()) {
          const subjects = appleIdentities.map(identity => identity.identity_data?.sub)
            .filter((subject): subject is string => typeof subject === 'string' && subject.length > 0);
          if (!subjects.length) return respond(409,{error:'APPLE_IDENTITY_UNAVAILABLE'});
          await actions.revokeApple(code,subjects);
          appleRevocation = 'revoked';
        }
        // Existing web clients have no native Apple authorization code. Apple's
        // TN3194 requires fulfilling deletion, then explaining manual revocation
        // when tokens cannot be obtained. Never claim revocation in that case.
      }
      await actions.deleteUser(user.id);
      return respond(200,{deleted:true,apple_revocation:appleRevocation});
    } catch (error) {
      if (error instanceof AppleRevocationError) {
        const allowed = new Set(['APPLE_ACCOUNT_MISMATCH','APPLE_AUTHORIZATION_EXPIRED','APPLE_REVOCATION_UNAVAILABLE']);
        const code = allowed.has(error.code) ? error.code : 'APPLE_REVOCATION_UNAVAILABLE';
        return respond(code === 'APPLE_REVOCATION_UNAVAILABLE' ? 503 : 409,{error:code});
      }
      return respond(500,{error:'ACCOUNT_DELETION_UNAVAILABLE'});
    }
  };
}
