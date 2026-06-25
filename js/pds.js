// Authenticated writes to the logged-in user's AT Protocol PDS.
//
// These write real records (com.atproto.repo.createRecord) into the user's own
// repository. The records use our standalone sh.tangled.bounty.* overlay
// collections — they live on the real network but are only meaningful to this
// app until a merge with tangled.org's appview.

import { authedFetch, getSession, isLoggedIn } from './auth.js';

export { isLoggedIn };

// Create a record in the logged-in user's repo. Returns { uri, cid }.
export async function createRecord(collection, record, rkey) {
  const session = getSession();
  if (!session) throw new Error('Must be logged in to write records.');

  const body = {
    repo: session.did,
    collection,
    record: { $type: collection, ...record },
  };
  if (rkey) body.rkey = rkey;

  return authedFetch('com.atproto.repo.createRecord', { method: 'POST', body });
}

// Upload a binary blob to the logged-in user's PDS. Returns the blob ref
// (the object you embed in a record's blob field).
export async function uploadBlob(bytes, mimeType) {
  const res = await authedFetch('com.atproto.repo.uploadBlob', {
    method: 'POST',
    rawBody: bytes,
    contentType: mimeType,
  });
  return res.blob;
}

// gzip a UTF-8 string in the browser via the Compression Streams API.
async function gzipString(text) {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

// Create a REAL tangled pull request (sh.tangled.repo.pull) on the hunter's PDS.
// The patch is a git-format-patch text; tangled stores it gzipped as a blob.
// Returns { uri, cid }.
export async function submitPullRecord({ repoDid, branch = 'main', title, body = '', references = [], patchText }) {
  if (!repoDid) throw new Error('submitPullRecord requires a target repo DID');
  const gz = await gzipString(patchText);
  const patchBlob = await uploadBlob(gz, 'application/gzip');
  const now = new Date().toISOString();
  // Match what tangled's "Paste Patch" flow writes EXACTLY: NO `source` (that's
  // only for branch/fork PRs), target with repoDid, the patch round — and omit
  // `references` entirely when empty (the working record has no such key).
  const record = {
    target: { repo: repoDid, branch, repoDid },
    title,
    body,
    rounds: [{ patchBlob, createdAt: now }],
    createdAt: now,
  };
  if (references && references.length) record.references = references;
  return createRecord('sh.tangled.repo.pull', record);
}

// Write a submission record (sh.tangled.bounty.submission) when a hunter accepts
// a bounty and is issued a token. Lets any viewer (not just the hunter's own
// device) see who is on the hunt for a given bounty, and lets us update the
// record's status when the PR resolves. Returns { uri, cid }.
export async function publishSubmissionRecord(submission) {
  return createRecord('sh.tangled.bounty.submission', {
    bounty: submission.bountyUri,
    bountyId: submission.bountyId,
    token: submission.token,
    repo: {
      handle: submission.ownerHandle,
      name: submission.repoName,
      repoDid: submission.repoDid,
    },
    status: submission.status || 'pending',
    startedAt: submission.startedAt || new Date().toISOString(),
  });
}

// Overwrite an existing submission record (rkey-keyed) when its status flips —
// e.g. the hunter's PR was merged (awarded) or closed (declined). Pass the
// full record fields; this is a putRecord, not a partial patch.
export async function updateSubmissionRecord(submissionUri, record) {
  const session = getSession();
  if (!session) throw new Error('Must be logged in to update records.');
  const m = String(submissionUri || '').match(/^at:\/\/([^/]+)\/([^/]+)\/([^/]+)$/);
  if (!m) throw new Error('updateSubmissionRecord: bad at-uri');
  const [, repoDid, collection, rkey] = m;
  if (repoDid !== session.did) throw new Error('Can only update own submission records.');
  const body = {
    repo: session.did,
    collection,
    rkey,
    record: { $type: collection, ...record },
  };
  return authedFetch('com.atproto.repo.putRecord', { method: 'POST', body });
}

// Write a bounty post (sh.tangled.bounty.post) from a parsed bounty object.
export async function publishBountyRecord(bounty) {
  return createRecord('sh.tangled.bounty.post', {
    issue: bounty.issueUri,
    title: bounty.issueTitle,
    summary: bounty.summary || '',
    keywords: (bounty.keywords || []).slice(0, 10),
    topKeywords: (bounty.topKeywords || []).slice(0, 3),
    difficulty: bounty.difficulty,
    status: bounty.status || 'open',
    createdAt: bounty.createdAt || new Date().toISOString(),
  });
}

// Write an award record (sh.tangled.bounty.award) for a completed bounty.
// `award` is the signed award object produced by signer.createSignedAward.
//
// We persist the full award (including display fields and the public key) so it
// round-trips: re-reading from the PDS reconstructs the profile exactly, and
// the signature still verifies after a new login (verification uses the stored
// publicKeyJwk, not the current session key). The core lexicon fields come
// first; the rest are extra fields our overlay relies on.
export async function publishAwardRecord(award) {
  return createRecord('sh.tangled.bounty.award', {
    // Core sh.tangled.bounty.award fields
    bounty: award.bountyUri,
    repo: award.repoUrl,
    pullRequest: award.pullRequestUri,
    skills: (award.skills || []).slice(0, 10),
    difficulty: award.difficulty,
    points: award.points,
    awardedAt: award.awardedAt,
    awardedBy: award.awardedBy,
    signature: award.signature,
    // Overlay extras (display + verification round-trip)
    bountyId: award.bountyId,
    bountyTitle: award.bountyTitle,
    repoHandle: award.repoHandle,
    repoName: award.repo,
    hunterDid: award.hunterDid,
    hunterHandle: award.hunterHandle,
    awardedByHandle: award.awardedByHandle,
    authorityWeight: award.authorityWeight,
    publicKeyJwk: award.publicKeyJwk,
  });
}
