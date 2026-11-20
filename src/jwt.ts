// JWT bearer minting for the packaged TuBot Channel API execution client.
// Panel holds the RSA private key (TUBOT_JWT_PRIVATE_KEY secret); the public
// certificate is registered on the packaged ECA. Tokens are minted on demand
// with a 3-minute assertion lifetime and verified against userinfo by the
// caller. No client secret exists on this path and no refresh dance is needed.

export const TUBOT_CHANNEL_API_CLIENT_ID =
  "3MVG9TuqpTxXuFqOGY8XYVMvxYy25XqDsyH3T4PZbR_jDVL0oc0pehtiyhTCimRTkEyJOlj1RdHVH2jRWwP8P";
export const JWT_BEARER_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:jwt-bearer";
const ASSERTION_LIFETIME_SECONDS = 180;

export function jwtAudience(isSandbox: boolean): string {
  return isSandbox ? "https://test.salesforce.com" : "https://login.salesforce.com";
}

function base64UrlEncode(data: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < data.length; i++) binary += String.fromCharCode(data[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pemToDer(pem: string): Uint8Array {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  const binary = atob(body);
  const der = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) der[i] = binary.charCodeAt(i);
  return der;
}

export async function buildJwtAssertion(
  privateKeyPem: string,
  subjectUsername: string,
  isSandbox: boolean,
  nowSeconds = Math.floor(Date.now() / 1000),
  clientId?: string
): Promise<string> {
  if (!privateKeyPem || !privateKeyPem.includes("PRIVATE KEY")) {
    throw new Error("jwt_private_key_misconfigured");
  }
  if (!subjectUsername || subjectUsername.length > 254) {
    throw new Error("jwt_subject_invalid");
  }
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToDer(privateKeyPem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const encoder = new TextEncoder();
  const header = base64UrlEncode(encoder.encode(JSON.stringify({ alg: "RS256" })));
  const payload = base64UrlEncode(
    encoder.encode(
      JSON.stringify({
        iss: clientId || TUBOT_CHANNEL_API_CLIENT_ID,
        sub: subjectUsername,
        aud: jwtAudience(isSandbox),
        exp: nowSeconds + ASSERTION_LIFETIME_SECONDS,
      })
    )
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, encoder.encode(`${header}.${payload}`))
  );
  return `${header}.${payload}.${base64UrlEncode(signature)}`;
}
