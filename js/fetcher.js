import { SEED_REPOS, MOCK_BOUNTIES } from './data.js';
import { parseIssue } from './ai-parser.js';
import { isCacheFresh, setFetchMeta, mergeLiveBounties } from './storage.js';

// When running via Vite dev server, /xrpc and /plc are proxied.
// When served directly (no proxy), we hit tangled.org directly and rely on CORS headers.
const TANGLED_BASE = window.location.hostname === 'localhost' ? '' : 'https://tangled.org';
const PLC_BASE     = window.location.hostname === 'localhost' ? '/plc' : 'https://plc.directory';

let liveDataAvailable = true;

// ── Core XRPC helpers ─────────────────────────────────────────────────────

async function xrpc(endpoint, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const url = `${TANGLED_BASE}/xrpc/${endpoint}${qs ? '?' + qs : ''}`;
  const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!res.ok) throw new Error(`XRPC ${endpoint} → ${res.status}`);
  return res.json();
}

export async function resolveHandle(handle) {
  const data = await xrpc('com.atproto.identity.resolveHandle', { handle });
  return data.did;
}

async function getPdsEndpoint(did) {
  const res = await fetch(`${PLC_BASE}/${encodeURIComponent(did)}`, {
    headers: { 'Accept': 'application/json' },
  });
  if (!res.ok) throw new Error(`PLC lookup failed for ${did}`);
  const doc = await res.json();
  const svc = doc.service?.find(s => s.id === '#atproto_pds' || s.type === 'AtprotoPersonalDataServer');
  return svc?.serviceEndpoint || TANGLED_BASE;
}

async function listRecords(pdsEndpoint, did, collection, limit = 100) {
  const base = pdsEndpoint || TANGLED_BASE;
  const qs = new URLSearchParams({ repo: did, collection, limit: String(limit) }).toString();
  const res = await fetch(`${base}/xrpc/com.atproto.repo.listRecords?${qs}`, {
    headers: { 'Accept': 'application/json' },
  });
  if (!res.ok) throw new Error(`listRecords ${collection} → ${res.status}`);
  const data = await res.json();
  return data.records || [];
}

// ── Issue fetching ────────────────────────────────────────────────────────

function isBountyIssue(record) {
  const v = record.value || {};
  const text = `${v.title || ''} ${v.body || ''} ${(v.labels || []).join(' ')}`;
  return text.toLowerCase().includes('#bounty');
}

function issueRecordToBounty(record, repoMeta) {
  const v = record.value || {};
  const title = v.title || '(Untitled issue)';
  const body  = v.body  || '';
  const parsed = parseIssue(title, body);
  const id = `live-${record.uri.split('/').pop()}`;

  return {
    id,
    issueTitle: title,
    issueBody: body,
    issueUri: record.uri,
    issueCid: record.cid,
    issueUrl: `https://tangled.org/${repoMeta.handle}/${repoMeta.repo}/issues/${record.uri.split('/').pop()}`,
    repo: {
      name: repoMeta.repo,
      handle: repoMeta.handle,
      ownerDid: repoMeta.did,
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

// ── Fetch bounties from a single tangled.org repo ─────────────────────────

async function fetchBountiesFromRepo(seedRepo) {
  const cacheKey = `${seedRepo.handle}/${seedRepo.repo}`;
  if (isCacheFresh(cacheKey)) return [];

  // 1. Resolve handle → DID
  const did = await resolveHandle(seedRepo.handle);

  // 2. Get PDS endpoint
  let pds;
  try { pds = await getPdsEndpoint(did); } catch { pds = TANGLED_BASE; }

  // 3. List issue records
  const records = await listRecords(pds, did, 'sh.tangled.repo.issue', 100);

  // 4. Filter for #bounty
  const bountyRecords = records.filter(isBountyIssue);

  // 5. Parse each one
  const repoMeta = { ...seedRepo, did };
  const bounties = bountyRecords.map(r => issueRecordToBounty(r, repoMeta));

  setFetchMeta(cacheKey);
  return bounties;
}

// ── Public: fetch all live bounties ──────────────────────────────────────

export async function fetchLiveBounties(onProgress) {
  const allLive = [];
  for (const repo of SEED_REPOS) {
    try {
      const bounties = await fetchBountiesFromRepo(repo);
      allLive.push(...bounties);
      if (onProgress) onProgress({ repo, count: bounties.length, error: null });
    } catch (err) {
      liveDataAvailable = false;
      if (onProgress) onProgress({ repo, count: 0, error: err.message });
    }
  }

  if (allLive.length > 0) {
    mergeLiveBounties(allLive);
  }
  return allLive;
}

export function isLiveDataAvailable() { return liveDataAvailable; }

// ── Fetch a single issue by tangled.org URL ───────────────────────────────

export async function fetchIssueByUrl(issueUrl) {
  // Expected format: https://tangled.org/{handle}/{repo}/issues/{id}
  const match = issueUrl.match(/tangled\.org\/([^/]+)\/([^/]+)\/issues\/([^/?#]+)/);
  if (!match) throw new Error('Not a valid tangled.org issue URL');
  const [, handle, repoName, issueKey] = match;

  const did = await resolveHandle(handle);
  let pds;
  try { pds = await getPdsEndpoint(did); } catch { pds = TANGLED_BASE; }

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

// ── Fetch user profile / social graph ────────────────────────────────────

export async function fetchUserProfile(handle) {
  const did = await resolveHandle(handle);
  let pds;
  try { pds = await getPdsEndpoint(did); } catch { pds = TANGLED_BASE; }

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

  return {
    did,
    handle,
    displayName,
    avatar,
    pdsEndpoint: pds,
    following,
    starredRepos,
    bountyProfile: {
      totalCompleted: 0,
      skillBreakdown: {},
      avgDifficulty: 0,
      completionStreak: 0,
      totalPoints: 0,
      public: true,
      lastUpdated: new Date().toISOString(),
    },
    awards: [],
  };
}
