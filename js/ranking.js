import { getUserProfile } from './storage.js';
import { DIFFICULTY_LABELS } from './data.js';

// Score = 0.4×social + 0.4×skill + 0.1×freshness + 0.1×difficultyFit

function socialProximity(bounty, user) {
  if (!user) return 0;
  let score = 0;
  const ownerDid = bounty.repo?.ownerDid;
  const repoUri  = bounty.issueUri?.split('/sh.tangled.repo.issue/')[0]?.replace('repo.issue', 'repo');

  if (ownerDid && user.following?.includes(ownerDid)) score += 0.4;
  if (repoUri  && user.starredRepos?.includes(repoUri))  score += 0.3;
  // Mutual follow heuristic: if they follow us back (we approximate with mutual in following list)
  if (ownerDid && user.following?.includes(ownerDid) && score > 0) score += 0.2;

  return Math.min(score, 1.0);
}

function skillMatch(bounty, user) {
  if (!user?.bountyProfile?.skillBreakdown) return 0.3; // neutral for new users
  const skills = user.bountyProfile.skillBreakdown;
  if (Object.keys(skills).length === 0) return 0.3;

  const top = bounty.topKeywords || [];
  const all = bounty.keywords || [];

  // Top keyword matches: 1/3 per match
  const topMatch = top.filter(k => skills[k]).length / Math.max(top.length, 1);

  // Bonus from full keyword list
  const bonusCount = all.filter(k => skills[k] && !top.includes(k)).length;
  const bonus = Math.min(bonusCount * 0.1, 0.3);

  return Math.min(topMatch + bonus, 1.0);
}

function freshness(bounty) {
  const createdAt = new Date(bounty.createdAt || bounty.fetchedAt);
  const hoursAgo = (Date.now() - createdAt) / 3600000;
  return Math.max(0, 1 - hoursAgo / 168); // decays to 0 at 7 days
}

function difficultyFit(bounty, user) {
  if (!user?.bountyProfile?.avgDifficulty || user.bountyProfile.totalCompleted === 0) return 0.5;
  const diff = Math.abs(bounty.difficulty - user.bountyProfile.avgDifficulty);
  return Math.max(0, 1 - diff / 4);
}

// Gold Knots reward for a bounty (must match app.js `points()`).
export function gkReward(bounty) {
  return Math.round(bounty.difficulty * 20 * (bounty.repo?.authorityWeight || 0.5));
}

function repoPopularity(bounty) {
  const stars = bounty.repo?.stars || 0;
  return Math.min(Math.log10(Math.max(stars, 1)) / 4, 1);
}

function personalizedScore(bounty, user) {
  const social    = socialProximity(bounty, user);
  const skill     = skillMatch(bounty, user);
  const fresh     = freshness(bounty);
  const diff      = difficultyFit(bounty, user);
  return (0.4 * social) + (0.4 * skill) + (0.1 * fresh) + (0.1 * diff);
}

// Deterministic [0,1) jitter derived from the bounty's identity, so the
// "relevance" order stays stable across re-renders (the feed re-ranks on every
// firehose/poll update — Math.random() here would reshuffle it each time).
function stableJitter(bounty) {
  const key = bounty.issueUri || bounty.id || '';
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  return (Math.abs(h) % 1000) / 1000;
}

function anonScore(bounty) {
  const fresh  = freshness(bounty);
  const popular = repoPopularity(bounty);
  const jitter  = stableJitter(bounty);
  return (0.5 * fresh) + (0.3 * popular) + (0.2 * jitter);
}

// Build a human-readable reason label for why this bounty ranked well
function buildReason(bounty, user, social, skill) {
  if (!user) return null;
  if (social >= 0.4 && skill >= 0.5) return '👥 You follow the owner · 🎯 Skill match';
  if (social >= 0.4) return '👥 You follow this repo owner';
  if (social >= 0.3) return '⭐ You starred this repo';
  if (skill >= 0.6)  return `🎯 Matches your ${bounty.topKeywords[0]} skills`;
  if (skill >= 0.3)  return '🎯 Partial skill match';
  return null;
}

// A bounty is "real" (live-parsed from an actual tangled issue) vs. demo data —
// the bundled MOCK_BOUNTIES seed (mock DIDs) or manually-entered/example bounties.
export function isLiveBounty(b) {
  const did = b?.repo?.ownerDid || '';
  const uri = b?.issueUri || '';
  // Demo/placeholder identities used by mock seed + manual entry.
  if (/did:plc:(mock|user|unknown|local)/i.test(did + ' ' + uri)) return false;
  // Real: a live-parsed id, a resolved repo DID, or a real issue at-uri.
  return String(b?.id || '').startsWith('live-')
    || !!b?.repo?.repoDid
    || /^at:\/\/did:plc:[a-z2-7]{20,}\/sh\.tangled\.repo\.issue\//.test(uri);
}

export function rankBounties(bounties, { limit = 10, filterSkill = null, filterDiff = null, sortMode = 'relevance', liveOnly = false } = {}) {
  const user = getUserProfile();

  let list = bounties.filter(b => b.status !== 'completed');

  // Real-world only: drop demo/mock/manual bounties.
  if (liveOnly) list = list.filter(isLiveBounty);

  // Apply filters
  if (filterSkill) {
    list = list.filter(b =>
      b.keywords?.includes(filterSkill) || b.topKeywords?.includes(filterSkill)
    );
  }
  if (filterDiff) {
    list = list.filter(b => b.difficulty === Number(filterDiff));
  }

  // Score
  list = list.map(bounty => {
    const social = socialProximity(bounty, user);
    const skill  = skillMatch(bounty, user);
    const score  = user ? personalizedScore(bounty, user) : anonScore(bounty);
    const reason = buildReason(bounty, user, social, skill);
    return { ...bounty, _score: score, _reason: reason };
  });

  // Sort
  if (sortMode === 'newest') {
    list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  } else if (sortMode === 'difficulty-asc') {
    list.sort((a, b) => a.difficulty - b.difficulty);
  } else if (sortMode === 'difficulty-desc') {
    list.sort((a, b) => b.difficulty - a.difficulty);
  } else if (sortMode === 'reward-desc') {
    list.sort((a, b) => gkReward(b) - gkReward(a));
  } else {
    list.sort((a, b) => b._score - a._score);
  }

  return list.slice(0, limit);
}

// Collect unique skill names from all bounties (for filter dropdown)
export function extractAllSkills(bounties) {
  const skills = new Set();
  for (const b of bounties) {
    (b.keywords || []).forEach(k => skills.add(k));
  }
  return [...skills].sort();
}

export { DIFFICULTY_LABELS };
