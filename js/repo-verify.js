// On-chain verification of bounty awards via the AT Protocol repo commit signature.
//
// WHY THIS EXISTS
// signer.js signs awards with an *ephemeral session key*. That proves the four
// award fields weren't tampered with, but NOT who authorized them — the key has
// no link to any identity. This module verifies the real thing the network
// already produced for free:
//
//   When the award record was written to the PDS (pds.js → createRecord), the
//   PDS appended it to the account's repository and signed the resulting commit
//   with the account's REAL DID signing key — the `#atproto` key published in
//   the account's DID document. That signature is the genuine proof of identity.
//
// We re-check it entirely in the browser, using only PUBLIC data (no private
// key), in five steps:
//   1. ask the PDS for a proof of the record  (com.atproto.sync.getRecord → CAR)
//   2. pull the signed commit out of the CAR and re-hash it without its `sig`
//   3. fetch the DID document and read the `#atproto` public key
//   4. ECDSA-verify the commit signature against that key  (the real DID key)
//   5. confirm the award record really sits inside that signed commit (MST walk)
//
// secp256k1 (atproto's default repo key) isn't available in WebCrypto, so the
// signature check uses @noble/curves. P-256 accounts are supported too.

import { CarReader } from '@ipld/car/reader';
import * as dagCbor from '@ipld/dag-cbor';
import { CID } from 'multiformats/cid';
import { sha256 } from 'multiformats/hashes/sha2';
import { base58btc } from 'multiformats/bases/base58';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { p256 } from '@noble/curves/nist.js';
import { getPdsEndpoint, PLC_BASE } from './fetcher.js';

const td = new TextDecoder();

// ── DID document key ────────────────────────────────────────────────────────

// A DID document publishes the signing key as a Multikey: multibase-base58btc of
// [multicodec varint prefix][compressed public key]. The prefix tells us the
// curve. We strip it and hand the raw key bytes to the matching verifier.
const MULTICODEC = {
  secp256k1: [0xe7, 0x01], // 0xe7  secp256k1-pub
  p256:      [0x80, 0x24], // 0x1200 p256-pub
};

function parseMultikey(multibase) {
  const bytes = base58btc.decode(multibase); // expects the leading 'z'
  for (const [curve, [a, b]] of Object.entries(MULTICODEC)) {
    if (bytes[0] === a && bytes[1] === b) return { curve, key: bytes.slice(2) };
  }
  throw new Error(`Unsupported key multicodec 0x${bytes[0].toString(16)}${bytes[1].toString(16)}`);
}

// Resolve the account's repo signing key from its DID document.
async function fetchSigningKey(did) {
  const res = await fetch(`${PLC_BASE}/${encodeURIComponent(did)}`, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`DID document lookup failed (${res.status})`);
  const doc = await res.json();
  const vm = (doc.verificationMethod || []).find(m => String(m.id).endsWith('#atproto'));
  if (!vm?.publicKeyMultibase) throw new Error('No #atproto verification method in DID document');
  return parseMultikey(vm.publicKeyMultibase);
}

// ── CAR / commit helpers ──────────────────────────────────────────────────────

// Read every block of a CAR into a Map keyed by CID string, and return the root.
async function readCar(bytes) {
  const reader = await CarReader.fromBytes(bytes);
  const [root] = await reader.getRoots();
  const blocks = new Map();
  for await (const { cid, bytes: b } of reader.blocks()) blocks.set(cid.toString(), b);
  return { root, blocks };
}

// The signed commit object: { did, version, data, rev, prev, sig }.
// atproto signs sha256(dag-cbor(commit-without-sig)) and stores the 64-byte
// compact, low-S signature in `sig`. Re-encoding the decoded commit minus `sig`
// reproduces the exact signed bytes (dag-cbor is canonical/deterministic).
function unsignedCommitBytes(commit) {
  const unsigned = { ...commit };
  delete unsigned.sig;
  return dagCbor.encode(unsigned);
}

// `prehash: true` makes @noble hash the message with SHA-256 itself, matching
// atproto's "sign sha256(commitBytes)" scheme. We pass the commit bytes, not a
// pre-computed digest.
function verifySig(curve, sig, message, key) {
  const v = curve === 'p256' ? p256 : secp256k1;
  return v.verify(sig, message, key, { prehash: true }); // sig: 64-byte compact
}

// ── MST inclusion ─────────────────────────────────────────────────────────────

// Walk the Merkle Search Tree from the signed commit's `data` root down to a
// target key (`collection/rkey`), returning the record's value CID, or null if
// the key isn't in the tree. MST keys are prefix-compressed: each entry stores
// how many leading bytes it shares with the previous key (`p`) plus the rest
// (`k`); entries are sorted ascending. `l` is the subtree of keys below the
// first entry; each entry's `t` is the subtree of keys between it and the next.
function mstFindValue(blocks, rootCid, targetKey) {
  let nodeCid = rootCid;
  while (nodeCid) {
    const raw = blocks.get(nodeCid.toString());
    if (!raw) return null; // proof didn't include this node
    const node = dagCbor.decode(raw);
    const entries = node.e || [];

    let prevKey = '';
    let descend = node.l ?? null; // default: smaller than everything → left subtree
    let matched = null;

    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const key = prevKey.slice(0, e.p) + td.decode(e.k);
      prevKey = key;

      if (targetKey === key) { matched = e.v; break; }
      if (targetKey < key) { descend = i === 0 ? (node.l ?? null) : entries[i - 1].t ?? null; break; }
      // targetKey > key → it lives to the right of this entry (so far)
      descend = e.t ?? null;
    }

    if (matched) return matched;
    nodeCid = descend;
  }
  return null;
}

// Confirm a block's bytes content-address to the expected CID (dag-cbor + sha256).
async function blockMatchesCid(bytes, cid) {
  const mh = await sha256.digest(bytes);
  return CID.create(1, dagCbor.code, mh).equals(cid);
}

// ── Public API ────────────────────────────────────────────────────────────────

function parseAtUri(uri) {
  const m = /^at:\/\/([^/]+)\/([^/]+)\/(.+)$/.exec(String(uri || ''));
  if (!m) return null;
  return { did: m[1], collection: m[2], rkey: m[3] };
}

// Verify that `award` is recorded in its owner's repo under a commit signed by
// the owner's real DID key. Returns a structured result for the UI.
//
//   { ok, reason, steps: [{ label, ok, detail }], curve, did, signedKey }
//
// `steps` lets the panel show the chain of checks. A failure at any step sets
// ok:false but still reports what passed.
export async function verifyAwardOnChain(award) {
  const ref = parseAtUri(award?.uri);
  if (!ref) {
    return {
      ok: false,
      reason: 'This award was never published to a PDS (kept only in local storage), so there is no signed commit to verify.',
      steps: [],
    };
  }
  const { did, collection, rkey } = ref;
  const steps = [];

  try {
    // 1. Proof CAR for this exact record.
    const pds = await getPdsEndpoint(did);
    const qs = new URLSearchParams({ did, collection, rkey }).toString();
    const res = await fetch(`${pds}/xrpc/com.atproto.sync.getRecord?${qs}`, {
      headers: { Accept: 'application/vnd.ipld.car' },
    });
    if (!res.ok) throw new Error(`sync.getRecord → ${res.status}`);
    const carBytes = new Uint8Array(await res.arrayBuffer());
    const { root, blocks } = await readCar(carBytes);
    steps.push({ label: 'Fetched signed proof from PDS', ok: true, detail: `${blocks.size} blocks, root ${root.toString().slice(0, 18)}…` });

    // 2. Decode the commit at the CAR root.
    const commit = dagCbor.decode(blocks.get(root.toString()));
    const didOk = commit.did === did;
    steps.push({ label: 'Commit names the expected repo', ok: didOk, detail: commit.did });
    if (!didOk) throw new Error('Commit DID does not match the award owner');

    // 3. Resolve the account's real signing key from its DID document.
    const { curve, key } = await fetchSigningKey(did);
    steps.push({ label: 'Resolved #atproto key from DID document', ok: true, detail: `${curve}, ${key.length}-byte compressed key` });

    // 4. Verify the commit signature with that key — the real DID key check.
    const message = unsignedCommitBytes(commit);
    const sigOk = !!commit.sig && verifySig(curve, commit.sig, message, key);
    steps.push({
      label: 'Commit signature valid under the DID key',
      ok: sigOk,
      detail: sigOk ? `ECDSA/${curve} over SHA-256 of the commit` : 'signature did NOT verify',
    });
    if (!sigOk) throw new Error('Commit signature failed verification');

    // 5. Prove the award record is actually inside that signed commit.
    const valueCid = mstFindValue(blocks, commit.data, `${collection}/${rkey}`);
    let inclusionOk = false;
    if (valueCid) {
      const recBytes = blocks.get(valueCid.toString());
      inclusionOk = !!recBytes && await blockMatchesCid(recBytes, valueCid);
    }
    steps.push({
      label: 'Award record is committed in the signed tree',
      ok: inclusionOk,
      detail: inclusionOk ? `record CID ${valueCid.toString().slice(0, 18)}…` : 'record not found on the signed MST path',
    });
    if (!inclusionOk) throw new Error('Could not prove the award record is in the signed commit');

    return {
      ok: true,
      reason: `This award is committed in ${did}'s repository under a commit signed by their real DID key. Verified in-browser against the DID document — no trust in this app required.`,
      steps,
      curve,
      did,
    };
  } catch (err) {
    return { ok: false, reason: err.message, steps };
  }
}
