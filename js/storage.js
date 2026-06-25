import { MOCK_BOUNTIES, DEMO_USERS } from './data.js';

const KEYS = {
  BOUNTIES:     'bh_bounties',
  USER_HANDLE:  'bh_user_handle',
  USER_PROFILE: 'bh_user_profile',
  CACHE_META:   'bh_cache_meta',
  LAST_FETCH:   'bh_last_fetch',
  SUBMISSIONS:  'bh_submissions',
};

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function readJSON(key) {
  try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; }
}

function writeJSON(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {
    console.warn('localStorage write failed:', e);
  }
}

// ── Bounties ──────────────────────────────────────────────────────────────

export function getBounties() {
  const stored = readJSON(KEYS.BOUNTIES);
  if (stored && stored.length > 0) return stored;
  // Seed with mock data on first load
  writeJSON(KEYS.BOUNTIES, MOCK_BOUNTIES);
  return MOCK_BOUNTIES;
}

export function setBounties(bounties) {
  writeJSON(KEYS.BOUNTIES, bounties);
}

export function addBounty(bounty) {
  const bounties = getBounties();
  const existing = bounties.findIndex(b => b.id === bounty.id || b.issueUri === bounty.issueUri);
  if (existing !== -1) {
    bounties[existing] = { ...bounties[existing], ...bounty };
  } else {
    bounties.unshift(bounty);
  }
  writeJSON(KEYS.BOUNTIES, bounties);
}

export function getBountyById(id) {
  return getBounties().find(b => b.id === id) || null;
}

export function markBountyCompleted(bountyId, hunterHandle) {
  const bounties = getBounties();
  const b = bounties.find(b => b.id === bountyId);
  if (b) {
    b.status = 'completed';
    b.completedAt = new Date().toISOString();
    b.completedBy = hunterHandle;
    writeJSON(KEYS.BOUNTIES, bounties);
  }
}

// Remove a bounty by its source issue URI (e.g. when the issue is closed).
// Returns true if something was removed.
export function removeBountyByUri(issueUri) {
  const bounties = getBounties();
  const next = bounties.filter(b => b.issueUri !== issueUri);
  if (next.length === bounties.length) return false;
  writeJSON(KEYS.BOUNTIES, next);
  return true;
}

// Merge freshly fetched live bounties into the store, keeping local additions
export function mergeLiveBounties(liveBounties) {
  const current = getBounties();
  const byUri = new Map(current.map(b => [b.issueUri, b]));
  for (const b of liveBounties) {
    byUri.set(b.issueUri, { ...(byUri.get(b.issueUri) || {}), ...b });
  }
  const merged = Array.from(byUri.values());
  writeJSON(KEYS.BOUNTIES, merged);
  return merged;
}

// ── User / Auth ───────────────────────────────────────────────────────────

export function getUserHandle() {
  return localStorage.getItem(KEYS.USER_HANDLE) || null;
}

export function setUserHandle(handle) {
  localStorage.setItem(KEYS.USER_HANDLE, handle.trim().toLowerCase());
}

export function clearUserHandle() {
  localStorage.removeItem(KEYS.USER_HANDLE);
  localStorage.removeItem(KEYS.USER_PROFILE);
}

export function getUserProfile() {
  const handle = getUserHandle();
  if (!handle) return null;
  const stored = readJSON(KEYS.USER_PROFILE);
  if (stored) return stored;
  // Return demo profile if handle matches
  if (DEMO_USERS[handle]) return DEMO_USERS[handle];
  return null;
}

export function setUserProfile(profile) {
  writeJSON(KEYS.USER_PROFILE, profile);
}

export function updateUserProfile(updates) {
  const profile = getUserProfile() || {};
  const updated = { ...profile, ...updates };
  updated.bountyProfile = { ...profile.bountyProfile, ...updates.bountyProfile };
  writeJSON(KEYS.USER_PROFILE, updated);
  return updated;
}

// ── Awards ────────────────────────────────────────────────────────────────

export function getAwards() {
  const profile = getUserProfile();
  return profile?.awards || [];
}

// Recompute the aggregate bountyProfile stats from a full award list. Used both
// when adding a new award and when hydrating awards back from the PDS, so the
// numbers are always derived from the same source of truth (the award list).
export function computeBountyProfile(awards, prevPublic = true) {
  const skillBreakdown = {};
  for (const a of awards) {
    for (const skill of (a.skills || [])) {
      skillBreakdown[skill] = (skillBreakdown[skill] || 0) + 1;
    }
  }
  const totalCompleted = awards.length;
  const totalPoints = awards.reduce((s, a) => s + (a.points || 0), 0);
  const avgDifficulty = totalCompleted
    ? +(awards.reduce((s, a) => s + (a.difficulty || 0), 0) / totalCompleted).toFixed(1)
    : 0;
  return {
    skillBreakdown,
    totalCompleted,
    totalPoints,
    avgDifficulty,
    completionStreak: computeStreak(awards),
    public: prevPublic,
    lastUpdated: new Date().toISOString(),
  };
}

export function addAward(award) {
  const profile = getUserProfile();
  if (!profile) return;

  const awards = profile.awards || [];
  // Avoid duplicates if the same award (by PDS uri or bountyId) is re-added.
  const exists = awards.some(a =>
    (award.uri && a.uri === award.uri) ||
    (award.bountyId && a.bountyId === award.bountyId));
  if (!exists) awards.unshift(award);

  const updated = {
    ...profile,
    awards,
    bountyProfile: computeBountyProfile(awards, profile.bountyProfile?.public ?? true),
  };
  writeJSON(KEYS.USER_PROFILE, updated);
  return updated;
}

function computeStreak(awards) {
  if (!awards.length) return 0;
  const sorted = [...awards].sort((a, b) => new Date(b.awardedAt) - new Date(a.awardedAt));
  let streak = 1;
  let prev = new Date(sorted[0].awardedAt);
  prev.setHours(0, 0, 0, 0);
  for (let i = 1; i < sorted.length; i++) {
    const d = new Date(sorted[i].awardedAt);
    d.setHours(0, 0, 0, 0);
    const diff = (prev - d) / 86400000;
    if (diff === 1) { streak++; prev = d; }
    else if (diff === 0) continue;
    else break;
  }
  return streak;
}

// ── Pull-request submissions ────────────────────────────────────────────────
// Tracks bounties the user has opened a real PR for, and the PR's observed
// state on tangled: 'pending' → 'awarded' (merged) | 'declined' (closed).
// Keyed by prUri; tagged with authorDid so we never mix accounts.

export function getSubmissions() {
  return readJSON(KEYS.SUBMISSIONS) || [];
}

export function addSubmission(sub) {
  const subs = getSubmissions();
  if (!subs.some(s => s.prUri === sub.prUri)) subs.unshift(sub);
  writeJSON(KEYS.SUBMISSIONS, subs);
}

export function updateSubmission(prUri, patch) {
  const subs = getSubmissions();
  const i = subs.findIndex(s => s.prUri === prUri);
  if (i !== -1) {
    subs[i] = { ...subs[i], ...patch };
    writeJSON(KEYS.SUBMISSIONS, subs);
  }
}

// Latest submission for a bounty by a given author (the logged-in hunter).
export function getSubmissionForBounty(bountyId, authorDid) {
  return getSubmissions().find(s =>
    s.bountyId === bountyId && (!authorDid || s.authorDid === authorDid)) || null;
}

// ── Fetch cache metadata ──────────────────────────────────────────────────

export function getFetchMeta(repoKey) {
  const meta = readJSON(KEYS.CACHE_META) || {};
  return meta[repoKey] || null;
}

export function setFetchMeta(repoKey) {
  const meta = readJSON(KEYS.CACHE_META) || {};
  meta[repoKey] = { fetchedAt: Date.now() };
  writeJSON(KEYS.CACHE_META, meta);
}

export function isCacheFresh(repoKey) {
  const m = getFetchMeta(repoKey);
  return m && (Date.now() - m.fetchedAt) < CACHE_TTL_MS;
}

// ── Reset (for dev/testing) ───────────────────────────────────────────────

export function resetAll() {
  Object.values(KEYS).forEach(k => localStorage.removeItem(k));
}
