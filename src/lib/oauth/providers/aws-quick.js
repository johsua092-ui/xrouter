import crypto from "crypto";
import { assertValidAwsRegion } from "../constants/oauth.js";

// ───────────────────────────────────────────────────────────────────────────
// Amazon Quick (AWS Quick Work) — native browser OAuth, two loopback hops.
// Ported from the magpie-aws-quick reference implementation (lib/oauth.mjs):
//
//   https://quick.aws.com/sn?qwSurface=desktop:<nonce>:<port>:<appVersion>
//     → browser login (Amazon resolves the account/tenant)
//     → GET 127.0.0.1:<port>/callback?nonce&issuerUrl&tenantUrl&idcRegion…   (hop 1)
//     → POST oidc.<idcRegion>.amazonaws.com/client/register  (dynamic client)
//     → 302 → oidc.<idcRegion>.amazonaws.com/authorize (PKCE)
//     → GET 127.0.0.1:<port>/?code&state                                     (hop 2)
//     → POST oidc.<idcRegion>.amazonaws.com/token          (code exchange)
//     → POST <data-plane>/integration/quick-work/user-info
//
// AWS OIDC endpoints use camelCase JSON keys (grantType, codeVerifier, …).
// The refresh_token grant ROTATES the refresh token on every refresh — the
// rotated token must be persisted by the caller.
// ───────────────────────────────────────────────────────────────────────────

export const AWS_QUICK_CONFIG = {
  // Sign-in (hop 1) entry points per build stage.
  socialDiscovery: {
    prod: "https://quick.aws.com/sn",
    beta: "https://devtest.quicksuite.aws.dev/sn",
    integ: "https://devtest.quicksuite.aws.dev/sn",
    dev: "https://devtest.quicksuite.aws.dev/sn",
  },
  // Data-plane fallback for user-info when the tenant URL is not a
  // dp.appintegrations host (magpie's SOCIAL_DATA_PLANE).
  socialDataPlane: {
    prod: "https://cell001.dp.appintegrations.us-east-1.prod.plato.ai.aws.dev",
    beta: "https://cell001.dp.appintegrations.us-west-2.beta.plato.ai.aws.dev",
    integ: "https://cell001.dp.appintegrations.us-west-2.beta.plato.ai.aws.dev",
    dev: "https://cell001.dp.appintegrations.us-west-2.beta.plato.ai.aws.dev",
  },
  scopes: {
    prod: "quicksight:read_write",
    beta: "quicksight_test:read_write",
    integ: "quicksight_test:read_write",
    dev: "quicksight_test:read_write",
  },
  surface: "QUICK_WORK_DESKTOP_WINDOWS",
  appVersion: "1.2.4660",
  clientName: "AmazonQuick-Desktop",
  clientType: "public",
  grantTypes: ["authorization_code", "refresh_token"],
  // Saved hop-1 discovery (rememberDiscovery/takeDiscovery) stays valid for
  // one paste-back retry window; a stale entry must not lend one account's
  // identity-center data to a different account's sign-in.
  discoveryMaxAgeMs: 15 * 60 * 1000,
  oauthTimeoutMs: 600_000,
};

const b64url = (buf) => Buffer.from(buf).toString("base64url");
const rand = () => b64url(crypto.randomBytes(32));

function pkce() {
  const verifier = rand();
  return { verifier, challenge: b64url(crypto.createHash("sha256").update(verifier).digest()) };
}

export function decodeAwsQuickJwt(token) {
  try {
    const part = String(token || "").split(".")[1];
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  } catch {
    return {};
  }
}

const oneLine = (v) => String(v ?? "").split(/\s+/).join(" ").trim();

async function postJson(url, body, headers = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} from ${new URL(url).host}: ${text.slice(0, 300)}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`invalid JSON from ${new URL(url).host}: ${e?.message}`);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`unexpected JSON from ${new URL(url).host}`);
  }
  return parsed;
}

function normalizeUserInfo(raw) {
  if (raw && typeof raw.userInfo === "object") raw = raw.userInfo;
  const pick = (...keys) => {
    for (const k of keys) {
      const v = raw?.[k];
      if (v != null && v !== "") return oneLine(v);
    }
    return "";
  };
  return {
    email: pick("email", "emailAddress"),
    user_name: pick("userName", "user_name", "username"),
    first_name: pick("firstName", "first_name"),
    last_name: pick("lastName", "last_name"),
    display_name: pick("displayName", "display_name"),
    user_arn: pick("userArn", "user_arn"),
    quicksight_external_user_arn: pick("quicksightExternalUserArn", "quicksight_external_user_arn"),
    role: pick("role"),
    identity_type: pick("identityType", "identity_type"),
    aws_account_id: pick("awsAccountId", "aws_account_id", "accountId"),
    account_name: pick("accountName", "account_name"),
    external_id: pick("externalId", "external_id"),
    account_ownership: pick("accountOwnership", "account_ownership"),
  };
}

/** The five hop-1 discovery fields, under whichever alias the callback used. */
export function discoveryOfQuery(searchParams) {
  const q = searchParams;
  return {
    issuer_url: q.get("issuerUrl") || q.get("issuer_url") || q.get("issuer") || "",
    tenant_url: q.get("tenantUrl") || q.get("tenant_url") || "",
    account: q.get("account") || "",
    idc_instance_id: q.get("idcInstanceId") || q.get("idc_instance_id") || "",
    idc_region: q.get("idcRegion") || q.get("idc_region") || "",
  };
}

/**
 * The hop-1 sign-in URL. `port` is the local callback port; `nonce` binds the
 * discovery callback to this login attempt.
 */
export function buildSigninUrl({ port, nonce, appVersion, stage }) {
  const discoverBase = AWS_QUICK_CONFIG.socialDiscovery[stage] || AWS_QUICK_CONFIG.socialDiscovery.prod;
  const version = appVersion || AWS_QUICK_CONFIG.appVersion;
  const surface = encodeURIComponent(`desktop:${nonce}:${port}:${version}`);
  return `${discoverBase}?qwSurface=${surface}`;
}

/**
 * Dynamic OIDC client registration against the tenant's IDP region.
 * @returns {Promise<{clientId: string, clientSecret: string, idcRegion: string}>}
 */
export async function registerAwsQuickClient({ discovery, redirectUri, stage }) {
  const idcRegion = discovery?.idc_region || "us-east-1";
  assertValidAwsRegion(idcRegion);
  const scopes = AWS_QUICK_CONFIG.scopes[stage] || AWS_QUICK_CONFIG.scopes.prod;
  // AWS OIDC rejects loopback redirect URIs that carry a path ("Requested
  // client type must use loopback interface for redirect") — register the
  // bare http://127.0.0.1:<port> form, exactly like the desktop client.
  const bareRedirectUri = String(redirectUri || "").replace(/\/+$/, "");
  const client = await postJson(`https://oidc.${idcRegion}.amazonaws.com/client/register`, {
    clientName: AWS_QUICK_CONFIG.clientName,
    clientType: AWS_QUICK_CONFIG.clientType,
    scopes: [scopes],
    grantTypes: AWS_QUICK_CONFIG.grantTypes,
    redirectUris: [bareRedirectUri],
    issuerUrl: discovery.issuer_url,
  });
  const clientId = client.clientId || client.client_id || "";
  const clientSecret = client.clientSecret || client.client_secret || "";
  if (!clientId) throw new Error("client registration returned no clientId");
  return { clientId, clientSecret, idcRegion };
}

/**
 * Build the OIDC authorize URL the browser is sent to after client
 * registration (skips the discovery hop when saved discovery is reused).
 */
export function buildAuthorizeUrl({ clientId, redirectUri, state, codeChallenge, idcRegion, stage }) {
  const scopes = AWS_QUICK_CONFIG.scopes[stage] || AWS_QUICK_CONFIG.scopes.prod;
  const authUrl = new URL(`https://oidc.${idcRegion}.amazonaws.com/authorize`);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("scope", scopes);
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge", codeChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  return authUrl.toString();
}

/**
 * Exchange the hop-2 authorization code at the AWS OIDC token endpoint.
 * AWS OIDC uses camelCase JSON keys.
 */
export async function exchangeAuthorizationCode({ code, clientId, clientSecret, codeVerifier, redirectUri, idcRegion }) {
  const region = idcRegion || "us-east-1";
  assertValidAwsRegion(region);
  const tok = await postJson(`https://oidc.${region}.amazonaws.com/token`, {
    clientId,
    clientSecret,
    grantType: "authorization_code",
    code,
    redirectUri,
    codeVerifier,
  });
  const tokens = {
    access_token: tok.accessToken || tok.access_token || "",
    refresh_token: tok.refreshToken || tok.refresh_token || "",
    id_token: tok.idToken || tok.id_token || "",
    expires_in: Number(tok.expiresIn ?? tok.expires_in ?? 0),
  };
  if (!tokens.id_token && !tokens.access_token) {
    throw new Error("token response has no idToken/accessToken");
  }
  return tokens;
}

/**
 * Fetch the Quick Work user-info descriptor (email/display_name/account).
 * Uses the tenant data-plane URL when the tenant URL is not a
 * dp.appintegrations host (magpie parity).
 */
export async function fetchQuickWorkUserInfo({ accessToken, tenantUrl, stage }) {
  const base = String(tenantUrl || "").replace(/\/+$/, "") || AWS_QUICK_CONFIG.socialDataPlane[stage] || AWS_QUICK_CONFIG.socialDataPlane.prod;
  const infoBase = base.includes("dp.appintegrations") ? base : (AWS_QUICK_CONFIG.socialDataPlane[stage] || AWS_QUICK_CONFIG.socialDataPlane.prod);
  const raw = await postJson(`${infoBase}/integration/quick-work/user-info`, {}, {
    Authorization: `Bearer ${accessToken}`,
  });
  return normalizeUserInfo(raw);
}

/**
 * Complete the second hop: validate state/error, exchange the code, fetch
 * user-info. Shared by the loopback proxy (hop 2) and the paste-back flow.
 * @returns {Promise<{tokens: object, userInfo: object}>}
 */
export async function completeAwsQuickExchange({ query, session }) {
  // Idempotent: a replay (duplicate hop-2 landing, re-pasted address) must not
  // re-run the token exchange against an already-settled session — AWS rotates
  // the refresh token, and the code is single-use.
  if (session?.status === "done" && session.result) return session.result;
  const q = query;
  const state = q.get("state");
  if (!state || !session || state !== session.state) {
    throw Object.assign(new Error("OAuth state mismatch"), { kind: "mismatch" });
  }
  if (q.get("error")) {
    throw new Error(`Sign-in failed: ${q.get("error")} ${q.get("error_description") || ""}`.trim());
  }
  const code = q.get("code");
  if (!code) {
    throw Object.assign(new Error("OAuth callback has no code"), { kind: "mismatch" });
  }
  const tokens = await exchangeAuthorizationCode({
    code,
    clientId: session.clientId,
    clientSecret: session.clientSecret,
    codeVerifier: session.verifier,
    redirectUri: session.redirectUri,
    idcRegion: session.discovery?.idc_region || "us-east-1",
  });
  const userInfo = await fetchQuickWorkUserInfo({
    accessToken: tokens.access_token,
    tenantUrl: session.discovery?.tenant_url || "",
    stage: session.stage,
  });
  return { tokens, userInfo };
}

/**
 * Search params of a pasted sign-in address: a full URL (any scheme, or none),
 * a scheme-less host/path, or a bare query string ("?code=…&state=…" or
 * "code=…&state=…"). Returns null when the text carries no query at all.
 */
export function parsePastedQuery(pasted) {
  const s = String(pasted ?? "").trim();
  if (!s) return null;
  const noHash = s.split("#", 1)[0];
  const qi = noHash.indexOf("?");
  let query = null;
  if (qi >= 0) query = noHash.slice(qi + 1);
  else if (/^[^\s/?#]*=/.test(noHash)) query = noHash;
  if (query == null) return null;
  return new URLSearchParams(query);
}

/**
 * Map a completed token exchange to the connection-creation shape.
 * `extra` carries { userInfo, discovery, stage } from the login attempt.
 * accessToken is the OIDC id_token (the Quick chat WS credential).
 */
export const mapTokens = (tokens, extra) => {
  const userInfo = extra?.userInfo || {};
  const discovery = extra?.discovery || {};
  const stage = extra?.stage || "prod";
  return {
    accessToken: tokens.id_token || tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresIn: tokens.expires_in,
    email: userInfo.email || undefined,
    displayName: userInfo.display_name || undefined,
    providerSpecificData: {
      tenantUrl: discovery.tenant_url || "",
      wsHost: discovery.tenant_url ? new URL(discovery.tenant_url).host : "",
      actorArn: userInfo.user_arn || "",
      awsAccountId: userInfo.aws_account_id || "",
      accountName: userInfo.account_name || "",
      region: discovery.idc_region || "us-east-1",
      issuerUrl: discovery.issuer_url || "",
      clientId: extra?.clientId || "",
      clientSecret: extra?.clientSecret || "",
      stage,
      appVersion: AWS_QUICK_CONFIG.appVersion,
      userInfo,
    },
  };
};

// Provider module shape (mirrors kiro/zed) — registered by the OAuth layer.
const awsQuick = {
  config: AWS_QUICK_CONFIG,
  flowType: "authorization_code",
  callbackPath: "/",
  mapTokens,
};

export default awsQuick;
