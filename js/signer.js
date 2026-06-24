// Cryptographic signing for bounty awards using Web Crypto API (ECDSA P-256).
// In production this would use the AT Protocol user's secp256k1 key via their PDS.
// Here we generate an ephemeral demo key per session to prove the verification model.

const KEY_STORE_KEY = 'bh_demo_keypair';

let _keyPair = null;

// ── Key pair management ───────────────────────────────────────────────────

async function getOrCreateKeyPair() {
  if (_keyPair) return _keyPair;

  // Try to restore from sessionStorage (survives page navigation, not tab close)
  const stored = sessionStorage.getItem(KEY_STORE_KEY);
  if (stored) {
    try {
      const { publicJwk, privateJwk } = JSON.parse(stored);
      const publicKey  = await crypto.subtle.importKey('jwk', publicJwk,  { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
      const privateKey = await crypto.subtle.importKey('jwk', privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
      _keyPair = { publicKey, privateKey, publicJwk, privateJwk };
      return _keyPair;
    } catch { /* stale key, regenerate */ }
  }

  // Generate fresh key pair
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  );

  const publicJwk  = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);

  sessionStorage.setItem(KEY_STORE_KEY, JSON.stringify({ publicJwk, privateJwk }));
  _keyPair = { publicKey: pair.publicKey, privateKey: pair.privateKey, publicJwk, privateJwk };
  return _keyPair;
}

export async function getDemoPublicKeyJwk() {
  const kp = await getOrCreateKeyPair();
  return kp.publicJwk;
}

// ── Signing ───────────────────────────────────────────────────────────────

// The signed message covers the four fields that must not change post-award.
function buildSignableMessage(awardRecord) {
  const { bountyUri, pullRequestUri, hunterDid, awardedAt } = awardRecord;
  return JSON.stringify({ bountyUri, pullRequestUri, hunterDid, awardedAt });
}

export async function signAward(awardRecord) {
  const kp = await getOrCreateKeyPair();
  const msg = buildSignableMessage(awardRecord);
  const encoded = new TextEncoder().encode(msg);
  const sigBuffer = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    kp.privateKey,
    encoded,
  );
  return bufToBase64(sigBuffer);
}

// ── Verification ──────────────────────────────────────────────────────────

export async function verifyAward(awardRecord) {
  const { signature, publicKeyJwk } = awardRecord;
  if (!signature || !publicKeyJwk) {
    return { valid: false, reason: 'Missing signature or public key in award record.' };
  }

  try {
    const publicKey = await crypto.subtle.importKey(
      'jwk',
      publicKeyJwk,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );

    const msg     = buildSignableMessage(awardRecord);
    const encoded = new TextEncoder().encode(msg);
    const sigBuf  = base64ToBuf(signature);

    const valid = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      publicKey,
      sigBuf,
      encoded,
    );

    return {
      valid,
      reason: valid
        ? 'crypto.subtle.verify() passed — the award signature is authentic and unmodified.'
        : 'Signature verification FAILED — the award record may have been tampered with.',
      algorithm: 'ECDSA P-256 / SHA-256',
      signedPayload: buildSignableMessage(awardRecord),
    };
  } catch (err) {
    return { valid: false, reason: `Verification error: ${err.message}` };
  }
}

// ── Full award creation ───────────────────────────────────────────────────

export async function createSignedAward({
  bounty,
  hunterDid,
  hunterHandle,
  pullRequestUri = null,
}) {
  const kp = await getOrCreateKeyPair();
  const now = new Date().toISOString();

  const points = Math.round(bounty.difficulty * 20 * (bounty.repo?.authorityWeight || 0.5));

  const awardRecord = {
    // AT Protocol references
    bountyUri:      bounty.issueUri,
    pullRequestUri: pullRequestUri || `at://${hunterDid}/sh.tangled.repo.pull/demo-${Date.now()}`,
    hunterDid,
    hunterHandle,
    awardedAt:      now,
    awardedBy:      bounty.repo.ownerDid,
    awardedByHandle: bounty.repo.handle,

    // Bounty context (denormalized for display)
    bountyId:    bounty.id,
    bountyTitle: bounty.issueTitle,
    repo:        bounty.repo.name,
    repoHandle:  bounty.repo.handle,
    repoUrl:     `https://tangled.org/${bounty.repo.handle}/${bounty.repo.name}`,
    skills:      bounty.topKeywords,
    difficulty:  bounty.difficulty,
    authorityWeight: bounty.repo.authorityWeight,
    points,

    // Verification
    publicKeyJwk: kp.publicJwk,
    signature:    null, // filled in below
    verified:     false,
  };

  awardRecord.signature = await signAward(awardRecord);
  awardRecord.verified  = true;

  return awardRecord;
}

// ── Base64 helpers ────────────────────────────────────────────────────────

function bufToBase64(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

function base64ToBuf(b64) {
  const binary = atob(b64);
  const buf = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) buf[i] = binary.charCodeAt(i);
  return buf.buffer;
}

export function truncateHex(b64, chars = 32) {
  const hex = [...atob(b64)].map(c => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
  return hex.slice(0, chars) + '…';
}
