// Pull-request lifecycle (token-gated link-and-track).
//
// We can't create or merge PRs (that needs knot/git access app-passwords lack).
// So the hunter opens the PR on tangled themselves, and we OBSERVE its real
// status. To stop someone claiming a reward with an unrelated/other person's PR,
// each submission issues a unique token the hunter must put in their PR title.
// We then auto-discover the PR by scanning the repo's pulls for that token —
// no number to paste, and it can't be spoofed with someone else's PR.
//
//   PR title contains our token AND is merged  → award the hunter
//   …closed                                    → declined
// The award is gated on the real, owner-performed merge.

import { getSession, isLoggedIn } from './auth.js';
import { publishAwardRecord, publishSubmissionRecord, updateSubmissionRecord } from './pds.js';
import { createSignedAward } from './signer.js';
import { fetchPullStatuses } from './fetcher.js';
import {
  addSubmission, getSubmissions, updateSubmission, getSubmissionForBounty,
  getBountyById, addAward, markBountyCompleted, addSubmissionToPool,
} from './storage.js';

export { getSubmissionForBounty };

// A bounty is trackable if it maps to a real tangled repo (has a repoDid).
export function canTrackPR(bounty) {
  return isLoggedIn() && !!bounty?.repo?.repoDid && !!bounty?.repo?.handle && !!bounty?.repo?.name;
}

// The repo's pulls page (where the hunter opens their PR).
export function pullsUrl(bounty) {
  return `https://tangled.org/${bounty.repo?.handle}/${bounty.repo?.name}/pulls`;
}

// Unguessable, thematic token tied to one (bounty, hunter) submission. The
// hunter puts it in their PR title; we match it case-insensitively (both sides
// are lowercased), so the pretty casing is purely cosmetic. ~48 bits of entropy.
function makeToken() {
  const b = new Uint8Array(6);
  crypto.getRandomValues(b);
  const code = [...b].map(x => x.toString(16).padStart(2, '0')).join('').toUpperCase();
  return `HuntRequest#${code}`; // e.g. HuntRequest#7F3A9C2E1B4D
}

// Begin a submission: issue (or reuse) the token the hunter puts in their PR title.
export function startSubmission(bounty) {
  if (!isLoggedIn()) throw new Error('Sign in to start a submission.');
  if (!canTrackPR(bounty)) throw new Error('This is a demo/mock bounty with no real tangled repo.');

  const session = getSession();
  const existing = getSubmissionForBounty(bounty.id, session.did);
  if (existing && existing.status === 'pending') return existing.token;

  const token = makeToken();
  const startedAt = new Date().toISOString();
  const sub = {
    token,
    bountyId: bounty.id,
    authorDid: session.did,
    authorHandle: session.handle,
    ownerHandle: bounty.repo.handle,
    repoName: bounty.repo.name,
    repoDid: bounty.repo.repoDid,
    bountyUri: bounty.issueUri,
    status: 'pending',
    startedAt,
  };
  addSubmission(sub);
  addSubmissionToPool(sub);

  // Best-effort: also publish a sh.tangled.bounty.submission record so other
  // viewers see this hunt. If it fails (e.g. session expired) the local copy
  // is enough for the hunter's own tracking; we just won't appear network-wide.
  publishSubmissionRecord(sub).then(({ uri, cid }) => {
    updateSubmission(token, { uri, cid });
    addSubmissionToPool({ ...sub, uri, cid });
  }).catch((e) => {
    console.warn('Submission PDS write failed, kept local copy:', e.message);
  });

  return token;
}

// Find the hunter's token-bearing PR in the scraped statuses (merged>closed>open).
// Returns { state, number, authorOk } or null.
function findMatch(status, sub) {
  const token = sub.token.toLowerCase();
  for (const st of ['merged', 'closed', 'open']) {
    const page = status[st];
    if (!page) continue;
    const entry = page.entries.find(e => e.title.includes(token));
    if (entry) return { state: st, number: entry.number, authorOk: page.dids.has(sub.authorDid) };
  }
  return null;
}

// Overwrite the hunter's sh.tangled.bounty.submission record with the new
// terminal status so the network sees the resolution. Best-effort: a missing
// uri (initial PDS write failed) or a transient error is logged and ignored.
async function persistSubmissionStatus(sub, patch) {
  if (!sub.uri) return;
  try {
    await updateSubmissionRecord(sub.uri, {
      bounty: sub.bountyUri,
      bountyId: sub.bountyId,
      token: sub.token,
      repo: { handle: sub.ownerHandle, name: sub.repoName, repoDid: sub.repoDid },
      status: patch.status,
      startedAt: sub.startedAt,
      resolvedAt: patch.resolvedAt,
      prNumber: patch.prNumber,
    });
  } catch (e) {
    console.warn('Submission PDS update failed:', e.message);
  }
}

async function awardForSubmission(sub, prNumber) {
  const session = getSession();
  const bounty = getBountyById(sub.bountyId);
  if (!bounty) return;

  const prUrl = `${pullsUrl(bounty)}/${prNumber}`;
  const award = await createSignedAward({
    bounty,
    hunterDid: session.did,
    hunterHandle: session.handle,
    pullRequestUri: prUrl, // the real merged PR
  });
  try {
    const { uri } = await publishAwardRecord(award);
    award.uri = uri;
  } catch (e) {
    console.warn('Award PDS write failed, kept local copy:', e.message);
  }
  addAward(award);
  markBountyCompleted(bounty.id, session.handle);
}

// Check pending submissions against tangled and apply awards/declines.
export async function reconcileSubmissions() {
  if (!isLoggedIn()) return { changed: false };
  const session = getSession();
  const pending = getSubmissions().filter(s => s.authorDid === session.did && s.status === 'pending');
  if (!pending.length) return { changed: false };

  // Scrape each repo's pulls pages once, then resolve all its submissions.
  const byRepo = new Map();
  for (const s of pending) {
    const key = `${s.ownerHandle} ${s.repoName}`;
    if (!byRepo.has(key)) byRepo.set(key, []);
    byRepo.get(key).push(s);
  }

  let changed = false;
  for (const [key, list] of byRepo) {
    const [ownerHandle, repoName] = key.split(' ');
    let status;
    try { status = await fetchPullStatuses(ownerHandle, repoName); }
    catch { status = null; }
    if (!status) continue; // unavailable (prod) → leave pending

    for (const sub of list) {
      const match = findMatch(status, sub);
      if (!match) continue; // token not found yet → still pending
      // Defense in depth: the token-bearing PR's repo page must list the
      // hunter as an author (a token alone is already per-hunter & unguessable).
      if (match.state === 'merged' && match.authorOk) {
        await awardForSubmission(sub, match.number);
        const patch = { status: 'awarded', prNumber: match.number, resolvedAt: new Date().toISOString() };
        updateSubmission(sub.token, patch);
        addSubmissionToPool({ ...sub, ...patch });
        await persistSubmissionStatus(sub, patch);
        changed = true;
      } else if (match.state === 'closed') {
        const patch = { status: 'declined', prNumber: match.number, resolvedAt: new Date().toISOString() };
        updateSubmission(sub.token, patch);
        addSubmissionToPool({ ...sub, ...patch });
        await persistSubmissionStatus(sub, patch);
        changed = true;
      }
    }
  }
  return { changed };
}
