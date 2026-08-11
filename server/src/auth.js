// Password login + signed-cookie sessions for the console.
//
// - Credentials live in an auth.json next to the console config:
//     { password_hash, password_salt, session_secret }
//   created on first boot with a default password ("aisix", override with
//   AISIX_CONSOLE_DEFAULT_PASSWORD) and a random session secret.
// - Passwords are hashed with scrypt (Node built-in — no native deps).
// - Sessions are stateless signed cookies (HMAC over exp with the session
//   secret), so a logged-in browser stays logged in across restarts.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;
const COOKIE_NAME = 'aisix_session';
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;

let state = null; // { authFile, password_hash, password_salt, session_secret }
const loginFails = new Map(); // ip -> { fails, lockUntil }

function scryptHash(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString('hex');
}

function timingSafeEqualHex(a, b) {
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function persist() {
  const dir = path.dirname(state.authFile);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const payload = {
    password_hash: state.password_hash,
    password_salt: state.password_salt,
    session_secret: state.session_secret,
  };
  const tmp = `${state.authFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, state.authFile);
}

export function initAuth(cfg) {
  const authFile = cfg.authFile;
  if (fs.existsSync(authFile)) {
    const raw = JSON.parse(fs.readFileSync(authFile, 'utf8'));
    state = { authFile, ...raw };
  } else {
    const passwordSalt = crypto.randomBytes(16).toString('hex');
    const defaultPassword = process.env.AISIX_CONSOLE_DEFAULT_PASSWORD || 'aisix';
    state = {
      authFile,
      password_salt: passwordSalt,
      password_hash: scryptHash(defaultPassword, passwordSalt),
      session_secret: crypto.randomBytes(32).toString('hex'),
    };
    persist();
    console.log(`AISIX Console 首次启动：已创建认证文件 ${authFile}`);
    console.log(`  默认密码: ${defaultPassword} —— 请登录后在「设置」中修改`);
  }
  return {
    verifyPassword,
    setPassword,
    requireAuth,
    loginHandler,
    logoutHandler,
    statusHandler,
    changePasswordHandler,
  };
}

export function verifyPassword(password) {
  return timingSafeEqualHex(scryptHash(password, state.password_salt), state.password_hash);
}

export function setPassword(newPassword) {
  const salt = crypto.randomBytes(16).toString('hex');
  state.password_salt = salt;
  state.password_hash = scryptHash(newPassword, salt);
  persist();
}

// ---- sessions ----
function issueSessionToken() {
  const exp = Date.now() + SESSION_TTL_MS;
  const payload = Buffer.from(JSON.stringify({ exp })).toString('base64url');
  const sig = crypto.createHmac('sha256', state.session_secret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verifySessionToken(token) {
  if (!token) return false;
  const dot = token.indexOf('.');
  if (dot <= 0) return false;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = crypto.createHmac('sha256', state.session_secret).update(payload).digest('base64url');
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
  try {
    const { exp } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return typeof exp === 'number' && exp > Date.now();
  } catch {
    return false;
  }
}

function setSessionCookie(res) {
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=${issueSessionToken()}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1000}`,
  );
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
}

function readSessionToken(req) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === COOKIE_NAME) return rest.join('=');
  }
  return null;
}

// ---- middleware / handlers ----
export function requireAuth(req, res, next) {
  if (verifySessionToken(readSessionToken(req))) return next();
  res.status(401).json({ error: 'unauthorized' });
}

export async function loginHandler(req, res) {
  const ip = req.socket?.remoteAddress || 'unknown';
  const record = loginFails.get(ip) || { fails: 0, lockUntil: 0 };
  if (record.lockUntil > Date.now()) {
    return res.status(429).json({ error: 'locked_out' });
  }
  const { password } = req.body ?? {};
  if (typeof password !== 'string' || !password) {
    return res.status(400).json({ error: 'missing_password' });
  }
  if (!verifyPassword(password)) {
    record.fails += 1;
    if (record.fails >= MAX_FAILS) {
      record.lockUntil = Date.now() + LOCK_MS;
      record.fails = 0;
    }
    loginFails.set(ip, record);
    return res.status(401).json({ error: 'invalid_password' });
  }
  loginFails.delete(ip);
  setSessionCookie(res);
  res.json({ ok: true });
}

export function logoutHandler(_req, res) {
  clearSessionCookie(res);
  res.json({ ok: true });
}

export function statusHandler(req, res) {
  res.json({ authed: verifySessionToken(readSessionToken(req)) });
}

export async function changePasswordHandler(req, res) {
  const { current_password, new_password } = req.body ?? {};
  if (typeof current_password !== 'string' || typeof new_password !== 'string') {
    return res.status(400).json({ error: 'invalid_params' });
  }
  if (new_password.length < 6) {
    return res.status(400).json({ error: 'password_too_short' });
  }
  if (!verifyPassword(current_password)) {
    return res.status(401).json({ error: 'wrong_current_password' });
  }
  setPassword(new_password);
  clearSessionCookie(res); // force re-login with the new password
  res.json({ ok: true });
}
