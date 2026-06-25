import { parseIssue } from './ai-parser.js';
import {
  isCacheFresh, setFetchMeta, mergeLiveBounties, computeBountyProfile,
  getDiscoveredOwners, addDiscoveredOwners, setLeaderboardEntry,
} from './storage.js';

// tangled.org does NOT expose public XRPC (tangled.org/xrpc 404s). Tangled data lives
// on standard AT Protocol PDSes, so we read it the normal atproto way:
//   1. resolve handle → DID via the Bluesky public identity API (sends CORS *)
//   2. DID → PDS endpoint via plc.directory (sends CORS *)
//   3. listRecords / getRecord directly against the owner's PDS (sends CORS *)
// No dev proxy is required — every host below is CORS-enabled.
export const IDENTITY_BASE = 'https://public.api.bsky.app';
export const PLC_BASE      = 'https://plc.directory';

let liveDataAvailable = true;

// ── Core XRPC helpers ─────────────────────────────────────────────────────

async function xrpc(endpoint, params = {}, base = IDENTITY_BASE) {
  const qs = new URLSearchParams(params).toString();
  const url = `${base}/xrpc/${endpoint}${qs ? '?' + qs : ''}`;
  const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!res.ok) throw new Error(`XRPC ${endpoint} → ${res.status}`);
  return res.json();
}

export async function resolveHandle(handle) {
  const data = await xrpc('com.atproto.identity.resolveHandle', { handle });
  return data.did;
}

// Resolve a DID's PDS endpoint, exported so auth/pds layers can reuse it.
export { getPdsEndpoint };

async function getPdsEndpoint(did) {
  const res = await fetch(`${PLC_BASE}/${encodeURIComponent(did)}`, {
    headers: { 'Accept': 'application/json' },
  });
  if (!res.ok) throw new Error(`PLC lookup failed for ${did}`);
  const doc = await res.json();
  const svc = doc.service?.find(s => s.id === '#atproto_pds' || s.type === 'AtprotoPersonalDataServer');
  if (!svc?.serviceEndpoint) throw new Error(`No PDS endpoint in DID document for ${did}`);
  return svc.serviceEndpoint;
}

async function listRecords(pdsEndpoint, did, collection, limit = 100) {
  if (!pdsEndpoint) throw new Error('listRecords requires a PDS endpoint');
  const base = pdsEndpoint;
  const qs = new URLSearchParams({ repo: did, collection, limit: String(limit) }).toString();
  const res = await fetch(`${base}/xrpc/com.atproto.repo.listRecords?${qs}`, {
    headers: { 'Accept': 'application/json' },
  });
  if (!res.ok) throw new Error(`listRecords ${collection} → ${res.status}`);
  const data = await res.json();
  return data.records || [];
}

// ── Issue fetching ────────────────────────────────────────────────────────

// Our overlay convention: an issue is a bounty if "#bounty" appears in its
// title, body, or labels. (Real tangled issues don't use it yet — this is the
// 3rd-party minigame's tag, which repo owners opt into until a merge.)
export function isBountyIssue(record) {
  const v = record.value || {};
  const labels = Array.isArray(v.labels) ? v.labels : [];
  const text = `${v.title || ''} ${v.body || ''} ${labels.join(' ')}`;
  return text.toLowerCase().includes('#bounty');
}

// Last path segment of an at-uri (the record key).
function rkeyOf(uri) {
  return String(uri || '').split('/').pop() || '';
}

// repoMeta may come from a seed repo ({handle, repo, did}) or be derived live
// from a firehose event (only did + the issue's repo at-uri known).
export function issueRecordToBounty(record, repoMeta = {}) {
  const v = record.value || {};
  const title = v.title || '(Untitled issue)';
  const body  = v.body  || '';
  const parsed = parseIssue(title, body);
  const id = `live-${rkeyOf(record.uri)}`;

  // Repo name: prefer an explicit seed name. The issue's `repo` field may be a
  // bare repo DID (newer tangled repos) or an at-uri — only the at-uri form
  // carries a usable record key; a bare DID has no human name in the record.
  const repoRef = v.repo || '';
  const repoFromRef = repoRef.includes('/') ? rkeyOf(repoRef) : '';
  const repoName = repoMeta.repo || repoFromRef || 'repo';
  const handle   = repoMeta.handle || repoMeta.did || 'unknown';
  // The PR target needs the REPO's DID. Newer tangled repos reference it as a
  // bare DID in the issue's `repo` field; that's the real `target.repo`.
  const repoDid  = repoMeta.repoDid || (repoRef.startsWith('did:') ? repoRef : undefined);

  return {
    id,
    issueTitle: title,
    issueBody: body,
    issueUri: record.uri,
    issueCid: record.cid,
    issueUrl: `https://tangled.org/${handle}/${repoName}/issues/${rkeyOf(record.uri)}`,
    repo: {
      name: repoName,
      handle,
      ownerDid: repoMeta.did,
      repoDid,
      stars: repoMeta.stars || 0,
      language: repoMeta.language || parsed.topKeywords[0] || 'unknown',
      authorityWeight: repoMeta.authorityWeight || computeAuthorityWeight({ stars: repoMeta.stars || 0 }),
    },
    ...parsed,
    status: v.state === 'closed' ? 'completed' : 'open',
    createdAt: v.createdAt || record.value?.createdAt || new Date().toISOString(),
    fetchedAt: new Date().toISOString(),
  };
}

function computeAuthorityWeight({ stars = 0, ageInDays = 180, contributorCount = 3 }) {
  const starScore  = Math.min(Math.log10(Math.max(stars, 1)) / 4, 1);
  const ageScore   = Math.min(ageInDays / 365, 1);
  const contribs   = Math.min(contributorCount / 20, 1);
  return +((0.5 * starScore) + (0.3 * ageScore) + (0.2 * contribs)).toFixed(3);
}

// ── Repo names & issue state ──────────────────────────────────────────────

// Map a repo reference (bare repoDid, at-uri, or rkey) → human repo name, from
// the owner's sh.tangled.repo records ({ name, repoDid, ... }).
function buildRepoNameMap(repoRecords) {
  const m = new Map();
  for (const r of repoRecords) {
    const v = r.value || {};
    const name = v.name || rkeyOf(r.uri);
    if (v.repoDid) m.set(v.repoDid, name); // newer repos referenced by DID
    m.set(r.uri, name);                    // at-uri reference form
    m.set(rkeyOf(r.uri), name);            // rkey reference form
  }
  return m;
}

// A state value is the full NSID ("sh.tangled.repo.issue.state.closed") or
// possibly a bare token ("closed"); match on the final dotted segment.
export function isClosedState(state) {
  return String(state || '').split('.').pop() === 'closed';
}

// Set of issue at-uris whose latest sh.tangled.repo.issue.state is "…closed".
// Record keys are TIDs (time-ordered), so the highest rkey is the newest state.
function buildClosedIssueSet(stateRecords) {
  const latest = new Map(); // issueUri → { rkey, closed }
  for (const s of stateRecords) {
    const v = s.value || {};
    if (!v.issue) continue;
    const rkey = rkeyOf(s.uri);
    const prev = latest.get(v.issue);
    if (!prev || rkey > prev.rkey) {
      latest.set(v.issue, { rkey, closed: isClosedState(v.state) });
    }
  }
  const closed = new Set();
  for (const [uri, st] of latest) if (st.closed) closed.add(uri);
  return closed;
}

// Read a repo owner's OPEN #bounty issues, with real repo names attached.
// Pulls issues, repo metadata, and issue-state records together so we can
// resolve names and exclude closed issues.
async function readOpenBountyIssues(pds, did, handle) {
  const [issues, repos, states] = await Promise.all([
    listRecords(pds, did, 'sh.tangled.repo.issue', 100),
    listRecords(pds, did, 'sh.tangled.repo', 100).catch(() => []),
    // Forward-compatible: if tangled ever federates issue state as records,
    // this excludes closed ones for free. Currently empty.
    listRecords(pds, did, 'sh.tangled.repo.issue.state', 100).catch(() => []),
  ]);
  const repoNames = buildRepoNameMap(repos);
  const closed = buildClosedIssueSet(states);

  // Candidate #bounty issues with their resolved repo name.
  const candidates = issues
    .filter(isBountyIssue)
    .filter(r => !closed.has(r.uri))
    .map(r => ({ r, repoName: repoNames.get(r.value?.repo) }));

  // Authoritative open/closed comes from the appview. Fetch the open at-uri set
  // once per distinct repo (dev-only; null = couldn't determine → keep all).
  const repoNamesNeeded = [...new Set(candidates.map(c => c.repoName).filter(Boolean))];
  const openSets = new Map();
  await Promise.all(repoNamesNeeded.map(async (name) => {
    openSets.set(name, await fetchOpenIssueUris(handle, name));
  }));

  return candidates
    .filter(({ r, repoName }) => {
      const openSet = repoName ? openSets.get(repoName) : null;
      return openSet ? openSet.has(r.uri) : true; // unknown state → keep
    })
    .map(({ r, repoName }) => issueRecordToBounty(r, {
      did, handle, repo: repoName || undefined,
    }));
}

// Scrape tangled's appview for the set of OPEN issue at-uris in a repo.
//
// Issue open/closed state lives ONLY in the appview (server-rendered HTML, no
// CORS, no JSON API, not in any PDS record). We read ?state=open to get the
// open issue numbers, then each issue's detail page to recover its atproto
// at-uri (the list HTML doesn't expose it). Dev-only — goes through the Vite
// proxy to bypass CORS. Returns a Set of at-uris, or null if it can't be
// determined (production build / fetch failure), which callers treat as
// "state unknown, don't filter".
export async function fetchOpenIssueUris(ownerHandle, repoName) {
  if (!import.meta.env?.DEV) return null;   // proxy only exists under `npm run dev`
  if (!ownerHandle || !repoName) return null;

  const base = `/tnglweb/${encodeURIComponent(ownerHandle)}/${encodeURIComponent(repoName)}/issues`;
  try {
    const listHtml = await (await fetch(`${base}?state=open`)).text();
    const numbers = [...new Set(
      [...listHtml.matchAll(/\/issues\/(\d+)\b/g)].map(m => m[1])
    )];
    // tangled's issue LIST page is client-rendered, so an empty number list
    // means "couldn't determine state", NOT "zero open issues". Return null so
    // callers keep all #bounty issues instead of filtering them all out.
    if (!numbers.length) return null;

    const open = new Set();
    await Promise.all(numbers.map(async (n) => {
      try {
        const html = await (await fetch(`${base}/${n}`)).text();
        const m = html.match(/at:\/\/did:plc:[a-z0-9]+\/sh\.tangled\.repo\.issue\/[a-z0-9]+/i);
        if (m) open.add(m[0]);
      } catch { /* skip this issue */ }
    }));
    return open;
  } catch {
    return null;
  }
}

// Normalize a PR/issue title for matching across the appview HTML and our
// stored submission (unescape basic entities, collapse whitespace, lowercase).
export function normalizeTitle(s) {
  return String(s || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ').trim().toLowerCase();
}

// Read a repo's pull requests grouped by state from tangled's appview. The
// pulls list is server-rendered with no API/CORS, so (dev-only) we scrape it
// through the /tnglweb proxy — same approach as issue state. For each of
// open/merged/closed we collect the set of PR titles and author DIDs present,
// which is enough to resolve the state of a PR we created (match by title +
// author DID). Returns { open:{titles,dids}, merged:{...}, closed:{...} } or
// null when it can't be determined (production build / fetch failure).
export async function fetchPullStatuses(ownerHandle, repoName) {
  if (!import.meta.env?.DEV) return null;
  if (!ownerHandle || !repoName) return null;

  const base = `/tnglweb/${encodeURIComponent(ownerHandle)}/${encodeURIComponent(repoName)}/pulls`;
  const out = {};
  for (const state of ['open', 'merged', 'closed']) {
    try {
      const html = await (await fetch(`${base}?state=${state}`)).text();
      // (PR number, normalized title) per row — lets us match a PR by an
      // embedded token and recover its number for the award link.
      const entries = [...html.matchAll(/\/pulls\/(\d+)"[^>]*class="dark:text-white"[^>]*>\s*([^<]+)/g)]
        .map(m => ({ number: Number(m[1]), title: normalizeTitle(m[2]) }));
      const dids = new Set(
        [...html.matchAll(/avatar\.tangled\.sh\/[a-f0-9]+\/(did:plc:[a-z0-9]+)/g)].map(m => m[1])
      );
      out[state] = { entries, dids };
    } catch {
      out[state] = { entries: [], dids: new Set() };
    }
  }
  return out;
}

// Resolve repoDid/at-uri → name for a single owner DID (cached by callers).
export async function getRepoNamesForDid(did) {
  const pds = await getPdsEndpoint(did);
  const repos = await listRecords(pds, did, 'sh.tangled.repo', 100).catch(() => []);
  return buildRepoNameMap(repos);
}

// ── Fetch bounties from a single tangled.org repo ─────────────────────────

// Scan one owner for all their OPEN #bounty issues (across every repo they own).
// Cached per owner with the 5-min TTL so repeated cycles are cheap.
async function fetchBountiesFromOwner(handle) {
  const cacheKey = `owner:${handle}`;
  if (isCacheFresh(cacheKey)) return [];

  const did = await resolveHandle(handle);
  const pds = await getPdsEndpoint(did);
  const bounties = await readOpenBountyIssues(pds, did, handle);

  // Piggyback: tally this owner's Gold Knots for the network leaderboard.
  // (Awards live on the hunter's own PDS; most discovered owners have none → 0.)
  try {
    const awards = await listRecords(pds, did, 'sh.tangled.bounty.award', 100);
    const gk = awards.reduce((s, r) => s + (r.value?.points || 0), 0);
    setLeaderboardEntry(handle, { gk, count: awards.length });
  } catch { /* no awards / unreadable → leave leaderboard untouched */ }

  setFetchMeta(cacheKey);
  return bounties;
}

// ── Auto-discovery ────────────────────────────────────────────────────────

// tangled has no public XRPC / global API, but its home + timeline pages are
// server-rendered and link every recently-active repo as /{handle}/{repo}.
// We scrape those (dev-only, via the /tnglweb proxy — the pages have no CORS)
// to discover owners to scan, instead of relying solely on the seed list.
// Returns a de-duplicated list of { handle, repo }. Best-effort: covers what's
// surfaced on the timeline, not literally every repo on the network.
const NON_REPO_SEGMENTS = new Set([
  'issues', 'pulls', 'settings', 'tags', 'branches', 'blob', 'tree',
  'commits', 'login', 'register', 'timeline', 'knots', 'strands',
]);

export async function discoverRepos(limit = 60) {
  if (!import.meta.env?.DEV) return []; // needs the dev proxy; prod has no CORS path
  const found = new Map();
  for (const page of ['/tnglweb/', '/tnglweb/timeline']) {
    try {
      const html = await (await fetch(page)).text();
      for (const m of html.matchAll(/href="\/([a-z0-9-]+(?:\.[a-z0-9-]+)+)\/([a-z0-9._-]+)"/gi)) {
        const handle = m[1];
        const repo = m[2];
        if (NON_REPO_SEGMENTS.has(repo.toLowerCase())) continue;
        found.set(`${handle}/${repo}`, { handle, repo });
      }
    } catch { /* page unavailable — fall back to whatever else we found */ }
  }
  return [...found.values()].slice(0, limit);
}

// ── Public: fetch all live bounties ──────────────────────────────────────

// How many owners to scan over the network per load (the rest are either
// cache-fresh from a recent scan or picked up on a later cycle). Bounds first-
// load cost as the discovered set grows.
const SCAN_BUDGET = 25;

export async function fetchLiveBounties(onProgress) {
  // 1. Discover currently-active repos from the appview feed and fold their
  //    owners into the PERSISTED, growing set (replaces the hardcoded seeds).
  const discovered = await discoverRepos().catch(() => []);
  if (discovered.length) addDiscoveredOwners(discovered.map(r => r.handle));

  // 2. Scan the accumulated owner set. Cache-fresh owners return instantly;
  //    spend the network budget on owners we haven't scanned recently
  //    (newest discoveries first — addDiscoveredOwners prepends).
  const owners = getDiscoveredOwners();
  const stale = owners.filter(h => !isCacheFresh(`owner:${h}`)).slice(0, SCAN_BUDGET);

  const allLive = [];
  await Promise.all(stale.map(async (handle) => {
    try {
      const bounties = await fetchBountiesFromOwner(handle);
      allLive.push(...bounties);
      if (onProgress) onProgress({ repo: { handle }, count: bounties.length, error: null });
    } catch (err) {
      liveDataAvailable = false;
      if (onProgress) onProgress({ repo: { handle }, count: 0, error: err.message });
    }
  }));

  if (allLive.length > 0) {
    mergeLiveBounties(allLive);
  }
  return allLive;
}

export function isLiveDataAvailable() { return liveDataAvailable; }

// Back-fill a specific user's own #bounty issues straight from their PDS.
//
// This is the reliable discovery path for accounts on tangled-hosted PDSes
// (e.g. tngl.sh), which the Bluesky relay/Jetstream does not index — the
// firehose only carries relay-indexed repos and only events created after the
// socket connects. listRecords works directly against any CORS-enabled PDS.
export async function fetchUserBounties(handle) {
  const did = handle.startsWith('did:') ? handle : await resolveHandle(handle);
  const pds = await getPdsEndpoint(did);
  return readOpenBountyIssues(pds, did, handle);
}

// ── Fetch a single issue by tangled.org URL ───────────────────────────────

export async function fetchIssueByUrl(issueUrl) {
  // Expected format: https://tangled.org/{handle}/{repo}/issues/{id}
  const match = issueUrl.match(/tangled\.org\/([^/]+)\/([^/]+)\/issues\/([^/?#]+)/);
  if (!match) throw new Error('Not a valid tangled.org issue URL');
  const [, handle, repoName, issueKey] = match;

  const did = await resolveHandle(handle);
  let pds;
  pds = await getPdsEndpoint(did);

  // Try to get the record directly by rkey
  try {
    const qs = new URLSearchParams({
      repo: did,
      collection: 'sh.tangled.repo.issue',
      rkey: issueKey,
    }).toString();
    const res = await fetch(`${pds}/xrpc/com.atproto.repo.getRecord?${qs}`, {
      headers: { 'Accept': 'application/json' },
    });
    if (res.ok) {
      const record = await res.json();
      const repoMeta = { handle, repo: repoName, did };
      return issueRecordToBounty({ uri: record.uri, cid: record.cid, value: record.value }, repoMeta);
    }
  } catch { /* fall through to list-and-search */ }

  // Fall back: list all issues and find by number or content match
  const records = await listRecords(pds, did, 'sh.tangled.repo.issue', 100);
  const found = records.find(r =>
    r.uri.endsWith(`/${issueKey}`) ||
    (r.value?.number && String(r.value.number) === issueKey)
  );
  if (!found) throw new Error(`Issue ${issueKey} not found in ${handle}/${repoName}`);

  const repoMeta = { handle, repo: repoName, did };
  return issueRecordToBounty(found, repoMeta);
}

// ── Awards (persisted on the user's PDS) ──────────────────────────────────

// Map a stored sh.tangled.bounty.award record back into the award object shape
// the UI and signer.verifyAward expect. Falls back gracefully for older records
// written before the extra display fields were persisted.
function awardRecordToObject(rec) {
  const v = rec.value || {};
  // repo url form: https://tangled.org/{handle}/{name}
  const urlParts = String(v.repo || '').replace(/^https?:\/\/tangled\.org\//, '').split('/');
  const repoHandle = v.repoHandle || urlParts[0] || '';
  const repoName   = v.repoName   || urlParts[1] || '';
  const bountyId   = v.bountyId || (v.bounty ? `live-${rkeyOf(v.bounty)}` : undefined);

  return {
    uri:            rec.uri,
    bountyUri:      v.bounty,
    bountyId,
    bountyTitle:    v.bountyTitle || (v.bounty ? rkeyOf(v.bounty) : 'Bounty'),
    pullRequestUri: v.pullRequest,
    hunterDid:      v.hunterDid || v.awardedBy,
    hunterHandle:   v.hunterHandle,
    awardedAt:      v.awardedAt,
    awardedBy:      v.awardedBy,
    awardedByHandle: v.awardedByHandle,
    repo:           repoName,
    repoHandle,
    repoUrl:        /^https?:\/\//.test(v.repo || '') ? v.repo : undefined,
    skills:         v.skills || [],
    difficulty:     v.difficulty,
    authorityWeight: v.authorityWeight,
    points:         v.points,
    publicKeyJwk:   v.publicKeyJwk,
    signature:      v.signature,
    verified:       !!v.publicKeyJwk, // verifiable only if the public key round-tripped
  };
}

// Read all of a user's award records from their PDS, newest first.
export async function fetchUserAwards(handle) {
  const did = handle.startsWith('did:') ? handle : await resolveHandle(handle);
  const pds = await getPdsEndpoint(did);
  const records = await listRecords(pds, did, 'sh.tangled.bounty.award', 100).catch(() => []);
  return records
    .map(awardRecordToObject)
    .sort((a, b) => new Date(b.awardedAt || 0) - new Date(a.awardedAt || 0));
}

// ── Fetch user profile / social graph ────────────────────────────────────

export async function fetchUserProfile(handle) {
  const did = await resolveHandle(handle);
  let pds;
  pds = await getPdsEndpoint(did);

  // Fetch follows
  let following = [];
  try {
    const follows = await listRecords(pds, did, 'app.bsky.graph.follow', 100);
    following = follows.map(r => r.value?.subject?.did).filter(Boolean);
  } catch { /* follows not available */ }

  // Fetch starred repos (tangled-specific collection)
  let starredRepos = [];
  try {
    const stars = await listRecords(pds, did, 'sh.tangled.repo.star', 100);
    starredRepos = stars.map(r => r.value?.subject || r.value?.repo).filter(Boolean);
  } catch { /* stars not available */ }

  // Try to get display name from DID document
  let displayName = handle.split('.')[0];
  let avatar = null;
  try {
    const plcRes = await fetch(`${PLC_BASE}/${encodeURIComponent(did)}`, {
      headers: { 'Accept': 'application/json' },
    });
    if (plcRes.ok) {
      const doc = await plcRes.json();
      displayName = doc.alsoKnownAs?.[0]?.replace('at://', '') || displayName;
    }
  } catch { /* ignore */ }

  // Hydrate awards from the PDS so progress persists across logout/login —
  // the PDS is the source of truth, localStorage is just a cache.
  let awards = [];
  try {
    const records = await listRecords(pds, did, 'sh.tangled.bounty.award', 100);
    awards = records
      .map(awardRecordToObject)
      .sort((a, b) => new Date(b.awardedAt || 0) - new Date(a.awardedAt || 0));
  } catch { /* no awards yet / collection absent */ }

  return {
    did,
    handle,
    displayName,
    avatar,
    pdsEndpoint: pds,
    following,
    starredRepos,
    bountyProfile: computeBountyProfile(awards, true),
    awards,
  };
}
