import { SignJWT, jwtVerify } from "jose";
import bcrypt from "bcryptjs";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DATA_DIR } from "@/lib/dataDir";
import { getSettings } from "@/lib/localDb";
import { sessionSubject, getVersion } from "@/lib/auth/sessionVersions";

// Default password and strict 24h maximum session lifetime.
const DEFAULT_PASSWORD = "xrouter123";
const SESSION_MAX_AGE_SEC = 24 * 60 * 60;

function loadJwtSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  const file = path.join(DATA_DIR, "jwt-secret");
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {}
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const generated = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(file, generated, { mode: 0o600 });
  return generated;
}

const SECRET = new TextEncoder().encode(loadJwtSecret());

// Server-side revocation list (fix: logout must kill the JWT itself, not just
// the cookie). Every verify checks the token's jti against this file; entries
// expire naturally with the token and are pruned on write.
const REVOKED_FILE = path.join(DATA_DIR, "revoked-sessions.json");

function loadRevoked() {
  try {
    return JSON.parse(fs.readFileSync(REVOKED_FILE, "utf8")) || {};
  } catch {
    return {};
  }
}

function isRevoked(jti) {
  if (!jti) return false;
  const map = loadRevoked();
  const exp = map[jti];
  if (exp === undefined) return false;
  const now = Math.floor(Date.now() / 1000);
  if (exp <= now) {
    delete map[jti];
    try { fs.writeFileSync(REVOKED_FILE, JSON.stringify(map), { mode: 0o600 }); } catch {}
    return false;
  }
  return true;
}

function tokenVersionMatches(payload) {
  const subject = sessionSubject(payload);
  if (!subject) return true;
  // Strict: a token minted before versioning (no sv claim) never matches.
  return payload.sv === getVersion(subject);
}

export function revokeDashboardSession(session) {
  if (!session?.jti) return false;
  const now = Math.floor(Date.now() / 1000);
  const map = loadRevoked();
  for (const [k, v] of Object.entries(map)) if (v <= now) delete map[k];
  map[session.jti] = session.exp || now + SESSION_MAX_AGE_SEC;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(REVOKED_FILE, JSON.stringify(map), { mode: 0o600 });
  return true;
}

export function shouldUseSecureCookie(request) {
  const forceSecureCookie = process.env.AUTH_COOKIE_SECURE === "true";
  const forwardedProto = request?.headers?.get?.("x-forwarded-proto");
  const isHttpsRequest = forwardedProto === "https";
  return forceSecureCookie || isHttpsRequest;
}

export async function createDashboardAuthToken(claims = {}) {
  const subject = sessionSubject(claims);
  const sv = subject ? getVersion(subject) : 0;
  return new SignJWT({ authenticated: true, ...claims, sv })
    .setProtectedHeader({ alg: "HS256" })
    .setJti(crypto.randomUUID())
    .setIssuedAt()
    .setExpirationTime("24h")
    .sign(SECRET);
}

export async function verifyDashboardAuthToken(token) {
  if (!token) return false;
  try {
    const { payload } = await jwtVerify(token, SECRET);
    if (isRevoked(payload.jti)) return false;
    if (!tokenVersionMatches(payload)) return false;
    return true;
  } catch {
    return false;
  }
}

export async function getDashboardAuthSession(token) {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, SECRET);
    if (isRevoked(payload.jti)) return null;
    if (!tokenVersionMatches(payload)) return null;
    return payload;
  } catch {
    return null;
  }
}

export async function setDashboardAuthCookie(cookieStore, request, claims = {}) {
  const token = await createDashboardAuthToken(claims);
  cookieStore.set("auth_token", token, {
    httpOnly: true,
    secure: shouldUseSecureCookie(request),
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_SEC,
  });
}

export function clearDashboardAuthCookie(cookieStore) {
  cookieStore.delete("auth_token");
}

// Verify the current dashboard password (re-auth for sensitive actions).
export async function verifyDashboardPassword(password) {
  if (typeof password !== "string" || !password) return false;
  const settings = await getSettings();
  const storedHash = settings?.password;
  if (storedHash) return bcrypt.compare(password, storedHash);
  const initialPassword = process.env.INITIAL_PASSWORD || DEFAULT_PASSWORD;
  return password === initialPassword;
}
