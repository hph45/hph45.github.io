import { AppleRevocationError } from './handler.ts';

export type AppleConfiguration = { clientID: string; teamID: string; keyID: string; privateKey: string };
const encoder = new TextEncoder();
function base64url(bytes: Uint8Array): string {
  return btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join('')).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
}
function unbase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value.replace(/-/g,'+').replace(/_/g,'/')), char => char.charCodeAt(0));
}
function jsonPart(value: unknown): string { return base64url(encoder.encode(JSON.stringify(value))); }
function unavailable(): never { throw new AppleRevocationError('APPLE_REVOCATION_UNAVAILABLE'); }

export async function appleClientSecret(config: AppleConfiguration, now = Math.floor(Date.now()/1000)): Promise<string> {
  const keyBytes = unbase64(config.privateKey.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g,''));
  const key = await crypto.subtle.importKey('pkcs8',keyBytes,{name:'ECDSA',namedCurve:'P-256'},false,['sign']);
  const payload = `${jsonPart({alg:'ES256',kid:config.keyID,typ:'JWT'})}.${jsonPart({iss:config.teamID,iat:now,exp:now+300,aud:'https://appleid.apple.com',sub:config.clientID})}`;
  const signature = await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},key,encoder.encode(payload));
  return `${payload}.${base64url(new Uint8Array(signature))}`;
}

// The token comes from Apple's HTTPS code exchange, and is still signature- and
// claim-checked before a linked account can be revoked. A supplied Apple subject
// or client-decoded JWT is never accepted as identity.
export async function verifiedAppleSubject(token: string, clientID: string, fetcher: typeof fetch = fetch,
                                          now = Math.floor(Date.now()/1000)): Promise<string> {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return unavailable();
    const header = JSON.parse(new TextDecoder().decode(unbase64(parts[0])));
    const claims = JSON.parse(new TextDecoder().decode(unbase64(parts[1])));
    if (header.alg !== 'RS256' || typeof header.kid !== 'string' || header.kid.length > 200
      || claims.iss !== 'https://appleid.apple.com' || claims.aud !== clientID
      || typeof claims.exp !== 'number' || claims.exp <= now
      || typeof claims.iat !== 'number' || claims.iat > now+60
      || typeof claims.sub !== 'string' || !claims.sub) return unavailable();
    const response = await fetcher('https://appleid.apple.com/auth/keys',{signal:AbortSignal.timeout(10000)});
    if (!response.ok) return unavailable();
    const body = await response.json();
    const jwk = Array.isArray(body.keys) && body.keys.find((key: JsonWebKey & {kid?:string})=>key.kty==='RSA'&&key.alg==='RS256'&&key.kid===header.kid);
    if (!jwk) return unavailable();
    const key = await crypto.subtle.importKey('jwk',jwk,{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['verify']);
    if (!await crypto.subtle.verify('RSASSA-PKCS1-v1_5',key,unbase64(parts[2]),encoder.encode(`${parts[0]}.${parts[1]}`))) return unavailable();
    return claims.sub;
  } catch { return unavailable(); }
}

export function createAppleRevoker(config: AppleConfiguration, fetcher: typeof fetch = fetch) {
  return async (code: string, subjects: string[]): Promise<void> => {
    try {
      const secret = await appleClientSecret(config);
      const response = await fetcher('https://appleid.apple.com/auth/token',{
        method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},
        body:new URLSearchParams({client_id:config.clientID,client_secret:secret,code,grant_type:'authorization_code'}),
        signal:AbortSignal.timeout(10000),
      });
      const result = await response.json();
      if (!response.ok) {
        if (result.error === 'invalid_grant') throw new AppleRevocationError('APPLE_AUTHORIZATION_EXPIRED');
        return unavailable();
      }
      if (typeof result.id_token !== 'string') return unavailable();
      const subject = await verifiedAppleSubject(result.id_token,config.clientID,fetcher);
      if (!subjects.includes(subject)) throw new AppleRevocationError('APPLE_ACCOUNT_MISMATCH');
      const token = result.refresh_token || result.access_token;
      if (typeof token !== 'string' || !token) return unavailable();
      const revoked = await fetcher('https://appleid.apple.com/auth/revoke',{
        method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},
        body:new URLSearchParams({client_id:config.clientID,client_secret:secret,token,
          token_type_hint:result.refresh_token?'refresh_token':'access_token'}),
        signal:AbortSignal.timeout(10000),
      });
      if (!revoked.ok) return unavailable();
    } catch (error) {
      if (error instanceof AppleRevocationError) throw error;
      return unavailable();
    }
  };
}
