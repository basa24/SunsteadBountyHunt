// Real AT Protocol session handling via app passwords.
//
// Prototype path (per plan): the user pastes an app password (generated in their
// PDS / Bluesky account settings — NOT their main password), and we exchange it
// for a real session with com.atproto.server.createSession. The returned
// accessJwt authenticates real writes to the user's own PDS.
//
// SECURITY NOTE: app-password bearer tokens are stored in localStorage for the
// prototype. They are device-scoped and user-revocable, but a full product
// should move to atproto OAuth (PKCE + DPoP) so tokens are device-bound and
// never persisted in clear. See plan: "Both, phased" → OAuth later.

import { resolveHandle, getPdsEndpoint } from './fetcher.js';

const SESSION_KEY = 'bh_session';

let _session = null; // in-memory cache of the persisted session

// ── Persistence ─────────────────────────────────────────────────────────────

function readSession() {
  if (_session) return _session;
  try {
    _session = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
  } catch {
    _session = null;
  }
  return _session;
}

function writeSession(session) {
  _session = session;
  if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  else localStorage.removeItem(SESSION_KEY);
}

export function getSession() {
  return readSession();
}

export function isLoggedIn() {
  const s = readSession();
  return !!(s && s.accessJwt && s.did);
}

export function logout() {
  writeSession(null);
}

// ── Login ─────────────────────────────────────────────────────────────────

// identifier: a handle (e.g. name.tngl.sh) or DID. appPassword: an app password.
export async function login(identifier, appPassword) {
  const id = identifier.trim().replace(/^@/, '');

  // Resolve identity → DID → PDS so createSession hits the user's real PDS,
  // wherever their account is hosted.
  const did = id.startsWith('did:') ? id : await resolveHandle(id);
  const pdsEndpoint = await getPdsEndpoint(did);

  const res = await fetch(`${pdsEndpoint}/xrpc/com.atproto.server.createSession`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ identifier: id, password: appPassword }),
  });

  if (!res.ok) {
    let detail = `${res.status}`;
    try {
      const err = await res.json();
      detail = err.message || err.error || detail;
    } catch { /* non-JSON error body */ }
    if (res.status === 401) {
      throw new Error('Invalid handle or app password. Generate an app password in your account settings (not your main password).');
    }
    throw new Error(`Login failed: ${detail}`);
  }

  const data = await res.json();
  const session = {
    did: data.did,
    handle: data.handle,
    accessJwt: data.accessJwt,
    refreshJwt: data.refreshJwt,
    pdsEndpoint,
  };
  writeSession(session);
  return session;
}

// ── Token refresh ───────────────────────────────────────────────────────────

export async function refreshSession() {
  const s = readSession();
  if (!s?.refreshJwt) throw new Error('No refresh token — please log in again.');

  const res = await fetch(`${s.pdsEndpoint}/xrpc/com.atproto.server.refreshSession`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${s.refreshJwt}`, 'Accept': 'application/json' },
  });

  if (!res.ok) {
    // Refresh token expired/revoked — force re-login.
    logout();
    throw new Error('Session expired — please log in again.');
  }

  const data = await res.json();
  const updated = {
    ...s,
    did: data.did || s.did,
    handle: data.handle || s.handle,
    accessJwt: data.accessJwt,
    refreshJwt: data.refreshJwt || s.refreshJwt,
  };
  writeSession(updated);
  return updated;
}

// ── Authenticated XRPC ──────────────────────────────────────────────────────

// Call an XRPC method on the logged-in user's PDS with the bearer token.
// Retries once via refreshSession() on a 401 (expired accessJwt).
// `endpoint` is an NSID, e.g. 'com.atproto.repo.createRecord'.
export async function authedFetch(endpoint, { method = 'POST', body } = {}, _retried = false) {
  const s = readSession();
  if (!s?.accessJwt) throw new Error('Not logged in.');

  const res = await fetch(`${s.pdsEndpoint}/xrpc/${endpoint}`, {
    method,
    headers: {
      'Authorization': `Bearer ${s.accessJwt}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: body != null ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401 && !_retried) {
    await refreshSession();
    return authedFetch(endpoint, { method, body }, true);
  }

  if (!res.ok) {
    let detail = `${res.status}`;
    try {
      const err = await res.json();
      detail = err.message || err.error || detail;
    } catch { /* ignore */ }
    throw new Error(`${endpoint} failed: ${detail}`);
  }

  return res.json();
}
