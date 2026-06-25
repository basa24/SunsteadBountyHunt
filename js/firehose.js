// Live discovery via the AT Protocol firehose (Jetstream).
//
// Jetstream is a JSON wrapper over the raw CBOR firehose. It works in the
// browser over a plain WebSocket (no CORS, no auth) and supports server-side
// filtering by collection. We subscribe to newly-created sh.tangled.repo.issue
// records network-wide and surface any that carry our #bounty tag.

import { isBountyIssue, issueRecordToBounty, getRepoNamesForDid, isClosedState, PLC_BASE } from './fetcher.js';
import { addSubmissionToPool } from './storage.js';

const JETSTREAM_HOSTS = [
  'wss://jetstream2.us-east.bsky.network/subscribe',
  'wss://jetstream1.us-east.bsky.network/subscribe',
  'wss://jetstream2.us-west.bsky.network/subscribe',
];
const ISSUE_COLLECTION      = 'sh.tangled.repo.issue';
const STATE_COLLECTION      = 'sh.tangled.repo.issue.state';
const SUBMISSION_COLLECTION = 'sh.tangled.bounty.submission';
const AWARD_COLLECTION      = 'sh.tangled.bounty.award';
const WANTED_COLLECTIONS = [
  ISSUE_COLLECTION, STATE_COLLECTION,
  SUBMISSION_COLLECTION, AWARD_COLLECTION,
];

// Cache did → handle so we don't re-resolve for every event from the same repo.
const _handleCache = new Map();
// Cache did → repoName map so we don't re-fetch repo records per event.
const _repoNameCache = new Map();

export async function resolveHandleForDid(did) {
  if (_handleCache.has(did)) return _handleCache.get(did);
  let handle = did;
  try {
    const res = await fetch(`${PLC_BASE}/${encodeURIComponent(did)}`, {
      headers: { 'Accept': 'application/json' },
    });
    if (res.ok) {
      const doc = await res.json();
      const aka = doc.alsoKnownAs?.[0];
      if (aka) handle = aka.replace(/^at:\/\//, '');
    }
  } catch { /* fall back to did */ }
  _handleCache.set(did, handle);
  return handle;
}

async function resolveRepoName(did, repoRef) {
  if (!repoRef) return undefined;
  if (!_repoNameCache.has(did)) {
    try { _repoNameCache.set(did, await getRepoNamesForDid(did)); }
    catch { _repoNameCache.set(did, new Map()); }
  }
  return _repoNameCache.get(did).get(repoRef);
}

// connectFirehose(onBounty, { onStatus, onClose, onSubmission, onAward }) →
// streams newly-created #bounty issues to onBounty(bounty); calls
// onClose(issueUri) when an issue is closed; calls onSubmission(submission)
// and onAward(award) when bounty submission/award records appear network-wide.
// Returns { disconnect }.
export function connectFirehose(onBounty, { onStatus, onClose, onSubmission, onAward } = {}) {
  let ws = null;
  let closed = false;
  let attempt = 0;
  let reconnectTimer = null;

  const status = (s) => { try { onStatus?.(s); } catch { /* ignore */ } };

  function connect() {
    if (closed) return;
    const host = JETSTREAM_HOSTS[attempt % JETSTREAM_HOSTS.length];
    const params = WANTED_COLLECTIONS
      .map(c => `wantedCollections=${encodeURIComponent(c)}`)
      .join('&');
    const url = `${host}?${params}`;

    try {
      ws = new WebSocket(url);
    } catch (e) {
      scheduleReconnect();
      return;
    }

    ws.onopen = () => {
      attempt = 0; // reset backoff on a successful connection
      status('connected');
    };

    ws.onmessage = (evt) => {
      let msg;
      try { msg = JSON.parse(evt.data); } catch { return; }
      handleEvent(msg);
    };

    ws.onerror = () => { status('error'); };

    ws.onclose = () => {
      if (!closed) { status('reconnecting'); scheduleReconnect(); }
    };
  }

  function scheduleReconnect() {
    if (closed) return;
    attempt += 1;
    // Exponential backoff, capped at 30s.
    const delay = Math.min(1000 * 2 ** Math.min(attempt, 5), 30000);
    reconnectTimer = setTimeout(connect, delay);
  }

  async function handleEvent(msg) {
    if (msg.kind !== 'commit') return;
    const c = msg.commit;
    if (!c) return;
    // Accept both 'create' and 'update' for submission/award so a status flip
    // (pending→awarded) propagates. Issues are create-only.
    const op = c.operation;

    // Issue closed → tell the app to drop it from the feed.
    if (c.collection === STATE_COLLECTION) {
      if (op !== 'create') return;
      const v = c.record || {};
      if (v.issue && isClosedState(v.state)) {
        try { onClose?.(v.issue); } catch { /* ignore */ }
      }
      return;
    }

    // Bounty submission record (any hunter, any device).
    if (c.collection === SUBMISSION_COLLECTION) {
      if (op !== 'create' && op !== 'update') return;
      const v = c.record || {};
      if (!v.bounty || !v.bountyId) return;
      let handle = msg.did;
      try { handle = await resolveHandleForDid(msg.did); } catch { /* fallback */ }
      const sub = {
        uri: `at://${msg.did}/${c.collection}/${c.rkey}`,
        cid: c.cid,
        bountyId: v.bountyId,
        bountyUri: v.bounty,
        token: v.token,
        authorDid: msg.did,
        authorHandle: handle,
        ownerHandle: v.repo?.handle,
        repoName: v.repo?.name,
        repoDid: v.repo?.repoDid,
        status: v.status || 'pending',
        startedAt: v.startedAt,
        resolvedAt: v.resolvedAt,
        prNumber: v.prNumber,
        _live: true,
      };
      addSubmissionToPool(sub);
      try { onSubmission?.(sub); } catch { /* ignore */ }
      return;
    }

    // Bounty award record (resolved hunts network-wide). We don't aggregate
    // these into anything yet — just hand to the caller for display.
    if (c.collection === AWARD_COLLECTION) {
      if (op !== 'create') return;
      try { onAward?.({
        uri: `at://${msg.did}/${c.collection}/${c.rkey}`,
        cid: c.cid,
        value: c.record,
      }); } catch { /* ignore */ }
      return;
    }

    if (op !== 'create') return;
    if (c.collection !== ISSUE_COLLECTION) return;

    // Reconstruct an atproto record shape for the existing helpers.
    const record = {
      uri: `at://${msg.did}/${c.collection}/${c.rkey}`,
      cid: c.cid,
      value: c.record,
    };

    if (!isBountyIssue(record)) return;

    try {
      const handle = await resolveHandleForDid(msg.did);
      const repo = await resolveRepoName(msg.did, c.record?.repo);
      const bounty = issueRecordToBounty(record, { did: msg.did, handle, repo });
      bounty._live = true; // mark as freshly streamed
      onBounty(bounty);
    } catch { /* skip malformed event */ }
  }

  connect();

  return {
    disconnect() {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      try { ws?.close(); } catch { /* ignore */ }
    },
  };
}
