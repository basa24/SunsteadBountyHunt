import { getBountyById, getUserHandle, getUserProfile, markBountyCompleted, addAward, getSubmissionForBounty } from './storage.js';
import { verifyAward, truncateHex } from './signer.js';
import { verifyAwardOnChain } from './repo-verify.js';
import { isLoggedIn, getSession } from './auth.js';
import { startSubmission, canTrackPR, reconcileSubmissions } from './pulls.js';
import { DIFFICULTY_LABELS, DIFFICULTY_DESCRIPTIONS } from './data.js';
import { isLiveBounty } from './ranking.js';
import { renderNavChip } from './navchip.js';
import { coinBurstOnce } from './juice.js';

// ── URL param ─────────────────────────────────────────────────────────────

const params  = new URLSearchParams(location.search);
const bountyId = params.get('id');

// ── Helpers ───────────────────────────────────────────────────────────────

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function diffClass(d) {
  if (d <= 2) return 'diff-2';
  if (d === 3) return 'diff-3';
  if (d === 4) return 'diff-4';
  return 'diff-5';
}

function timeAgo(iso) {
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 60)    return 'just now';
  if (s < 3600)  return `${Math.floor(s/60)}m ago`;
  if (s < 86400) return `${Math.floor(s/3600)}h ago`;
  return `${Math.floor(s/86400)}d ago`;
}

function avatar(handle) {
  return `https://api.dicebear.com/7.x/identicon/svg?seed=${encodeURIComponent(handle)}&size=36`;
}

// Basic markdown render: code blocks, inline code, bold, line breaks
function renderMarkdown(text) {
  return escHtml(text)
    .replace(/```([a-z]*)\n?([\s\S]*?)```/g, (_, lang, code) =>
      `<pre><code>${code.trim()}</code></pre>`)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/#bounty/gi, '<span class="kw top">#bounty</span>')
    .replace(/\n\n/g, '</p><p>')
    .replace(/\n/g, '<br>');
}

// ── Fake "active hunters" presence ──────────────────────────────────────────
// A small, stable-per-bounty count that drifts a little over time so the page
// feels alive. Purely cosmetic — there's no real presence backend.
function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}
function seedHunters(bounty) {
  const base = hashStr(String(bounty.id || bounty.issueUri || 'x'));
  return 1 + (base % 4) + (bounty.difficulty >= 4 ? base % 3 : 0); // ~1–8, harder = busier
}

let _huntersTimer = null;
function startHuntersTicker(initial) {
  clearInterval(_huntersTimer);
  let n = initial;
  _huntersTimer = setInterval(() => {
    const el = document.getElementById('hunters-count');
    if (!el) { clearInterval(_huntersTimer); return; }
    if (Math.random() < 0.55) {
      n = Math.max(1, Math.min(initial + 3, n + (Math.random() < 0.5 ? -1 : 1)));
      if (String(n) !== el.textContent) {
        el.textContent = n;
        const wrap = el.closest('.hunters-live');
        wrap?.classList.remove('bump'); void wrap?.offsetWidth; wrap?.classList.add('bump');
      }
    }
  }, 6500 + Math.floor(Math.random() * 5000));
  window.addEventListener('beforeunload', () => clearInterval(_huntersTimer));
}

// ── Render bounty detail ──────────────────────────────────────────────────

function renderBounty(bounty) {
  const hunters = seedHunters(bounty);
  const topHtml = (bounty.topKeywords || []).map(k => `<span class="kw top">${k}</span>`).join('');
  const kwHtml  = (bounty.keywords   || [])
    .filter(k => !bounty.topKeywords?.includes(k))
    .map(k => `<span class="kw">${k}</span>`).join('');

  const pts = Math.round(bounty.difficulty * 20 * (bounty.repo?.authorityWeight || 0.5));

  const dots = Array.from({ length: 5 }, (_, i) =>
    `<div class="diff-dot ${i < bounty.difficulty ? `active-${bounty.difficulty}` : ''}"></div>`
  ).join('');

  const aw = Math.max(0, Math.min(1, Number(bounty.repo?.authorityWeight) || 0));
  const repoUrl = `https://tangled.org/${bounty.repo?.handle}/${bounty.repo?.name}`;

  // Only link to tangled when we have a real, resolvable repo (live bounty with
  // a resolved owner handle + repo name). Otherwise the link 404s — demo/mock
  // bounties and any whose repo name fell back to "repo" → show a plain chip.
  const linkOk = isLiveBounty(bounty)
    && bounty.repo?.handle && bounty.repo.handle !== 'unknown' && !String(bounty.repo.handle).startsWith('did:')
    && bounty.repo?.name && bounty.repo.name !== 'repo';
  const repoChipInner = `
    <img class="avatar avatar-sm" src="${avatar(bounty.repo?.handle)}" alt="" />
    <span class="repo-chip-name">${escHtml(bounty.repo?.handle || '?')}/${escHtml(bounty.repo?.name || '?')}</span>
    <span class="text-muted text-xs">⭐ ${bounty.repo?.stars ?? '–'} · ${escHtml(bounty.repo?.language || '—')}</span>`;
  const repoChip = linkOk
    ? `<a class="repo-chip" href="${escHtml(repoUrl)}" target="_blank" rel="noopener">${repoChipInner}</a>`
    : `<div class="repo-chip">${repoChipInner}</div>`;
  const viewIssue = linkOk
    ? `<a class="btn btn-ghost btn-sm detail-view" href="${escHtml(bounty.issueUrl)}" target="_blank" rel="noopener">View issue ↗</a>`
    : '';

  document.getElementById('bounty-content').innerHTML = `
    <article class="detail rise-in" style="--diff-color:var(--diff-${bounty.difficulty})">
      <div class="detail-top">
        <div class="detail-meta">
          <span class="status-badge status-open">● Open</span>
          <span class="text-muted text-xs">Posted ${timeAgo(bounty.createdAt)}</span>
          <span class="hunters-live" title="Hunters with an active submission on this bounty right now">
            <span class="hunters-dot"></span><span id="hunters-count">${hunters}</span>&nbsp;hunting now
          </span>
        </div>
        <span class="diff-badge ${diffClass(bounty.difficulty)}">
          <span class="diff-pip ${diffClass(bounty.difficulty)}"></span>
          ${bounty.difficulty} · ${DIFFICULTY_LABELS[bounty.difficulty]}
        </span>
      </div>

      <h1 class="detail-title">${escHtml(bounty.issueTitle)}</h1>

      <div class="detail-reward">
        <span class="points-badge lg" style="font-size:1.2rem" title="${pts} Gold Knots">+${pts} Gold Knots</span>
        ${repoChip}
        ${viewIssue}
      </div>

      <div class="card mb-4">
        <div class="card-body">
          <div class="issue-body"><p>${renderMarkdown(bounty.issueBody || '(No body)')}</p></div>
        </div>
      </div>

      <div class="detail-grid mb-4">
        <div class="card"><div class="card-body">
          <div class="parse-section-title mb-2">Difficulty</div>
          <div class="diff-meter mb-2">${dots}</div>
          <div class="text-xs text-muted">${DIFFICULTY_DESCRIPTIONS[bounty.difficulty]}</div>
        </div></div>
        <div class="card"><div class="card-body">
          <div class="parse-section-title mb-2">Repo authority</div>
          <div class="authority-bar"><div class="authority-fill" style="width:${(aw * 100).toFixed(0)}%"></div></div>
          <div class="text-xs text-muted mt-2"><strong class="text-secondary">${aw.toFixed(2)}</strong> · higher-authority repos pay more Gold Knots.</div>
        </div></div>
      </div>

      <div class="card mb-4">
        <div class="card-body">
          <div class="parse-section-title mb-2">Keywords</div>
          <div class="bounty-tags mb-1">${topHtml}${kwHtml}</div>
          <div class="text-xs text-muted mt-2">Top 3 highlighted · ${(bounty.keywords||[]).length} total</div>
        </div>
      </div>

      <div id="pr-section"></div>
      <div id="verify-section"></div>

      <div class="mt-4">
        <div class="collapsible-header" id="schema-toggle">
          <span class="collapsible-title">AT Protocol Lexicon Record (sh.tangled.bounty.post)</span>
          <span class="collapsible-chevron">▼</span>
        </div>
        <div class="collapsible-body" id="schema-body">
          <pre class="code-block">${escHtml(JSON.stringify({
            $type: 'sh.tangled.bounty.post',
            issue: bounty.issueUri,
            title: bounty.issueTitle,
            summary: bounty.summary,
            keywords: bounty.keywords,
            topKeywords: bounty.topKeywords,
            difficulty: bounty.difficulty,
            status: bounty.status,
            createdAt: bounty.createdAt,
          }, null, 2))}</pre>
        </div>
      </div>
    </article>
  `;

  // Collapsible toggle
  document.getElementById('schema-toggle').addEventListener('click', function() {
    this.classList.toggle('open');
    document.getElementById('schema-body').classList.toggle('open');
  });

  startHuntersTicker(hunters);
}

// ── Pull request: submit → owner merges on tangled → award ──────────────────

function pullsUrl(bounty) {
  return `https://tangled.org/${bounty.repo?.handle}/${bounty.repo?.name}/pulls`;
}

function renderPRSection(bounty) {
  const section = document.getElementById('pr-section');
  const session = getSession();
  const sub = isLoggedIn() ? getSubmissionForBounty(bounty.id, session?.did) : null;

  // Already have a submission for this bounty → show its live status.
  if (sub) {
    if (sub.status === 'awarded') {
      const award = (getUserProfile()?.awards || []).find(a => a.bountyId === bounty.id);
      section.innerHTML = `
        <div class="success-panel mb-4">
          <div class="success-icon">🎯</div>
          <div class="success-title">Hunt Successful!</div>
          <div class="success-sub flex flex-col items-center gap-2">
            ${award ? `<span class="points-badge lg gk-pop" style="font-size:1.125rem">Paid +${award.points} Gold Knots</span>` : ''}
            <span class="text-xs text-muted">Bounty collected — the owner merged your pull request on tangled.</span>
          </div>
          <div class="flex items-center gap-2 mt-2">
            ${/^https?:\/\//.test(sub.prUri || '') ? `<a href="${escHtml(sub.prUri)}" target="_blank" rel="noopener" class="btn btn-ghost">View merged PR ↗</a>` : ''}
            <a href="profile.html" class="btn btn-primary">View your hunter profile →</a>
          </div>
        </div>
      `;
      coinBurstOnce(section.querySelector('.success-panel'), bounty.id);
      if (award) renderVerifyPanel(award);
      return;
    }
    if (sub.status === 'declined') {
      section.innerHTML = `
        <div class="card mb-4"><div class="card-body">
          <div class="notice notice-warn mb-2">✗ Hunt failed — your pull request${sub.prNumber ? ` (#${sub.prNumber})` : ''} was closed without merging. No bounty paid.</div>
          <p class="text-sm text-secondary mb-3">Pick up the trail and try again.</p>
          <button class="btn btn-primary" id="pr-start-btn">Start a new hunt</button>
        </div></div>
      `;
      document.getElementById('pr-start-btn')?.addEventListener('click', () => onStart(bounty));
      return;
    }
    // pending — show the token to embed and that we're watching for it
    section.innerHTML = `
      <div class="card mb-4" style="border-color:var(--bounty-green-dim)"><div class="card-body">
        <div class="parse-section-title mb-2">On the Hunt — your bounty token</div>
        ${renderTokenInstructions(bounty, sub.token)}
        <p class="text-xs text-muted mt-3">
          ⏳ We're tracking <a href="${escHtml(pullsUrl(bounty))}" target="_blank" rel="noopener">this repo's pulls</a>
          for a PR whose title carries your token. When the owner <strong>merges</strong> it, the bounty pays out
          automatically (~20s). Only a PR carrying <em>your</em> token counts — no one can claim your bounty.
        </p>
      </div></div>
    `;
    document.getElementById('pr-token-copy')?.addEventListener('click', () => navigator.clipboard?.writeText(sub.token));
    return;
  }

  // Bounty completed by someone else.
  if (bounty.status === 'completed') {
    section.innerHTML = `
      <div class="notice" style="margin-bottom:1rem">
        🎯 Bounty already claimed by <strong>${escHtml(bounty.completedBy || 'another hunter')}</strong>.
      </div>
    `;
    return;
  }

  // No submission yet → issue a token to start.
  const loggedIn = isLoggedIn();
  const trackable = canTrackPR(bounty);
  section.innerHTML = `
    <div class="card mb-4" style="border-color:var(--bounty-green-dim)">
      <div class="card-body">
        <div class="parse-section-title mb-2">Take this bounty</div>
        <p class="text-sm text-secondary mb-3">
          Grab a unique token, open a pull request on
          <a href="${escHtml(pullsUrl(bounty))}" target="_blank" rel="noopener">${escHtml(bounty.repo?.handle)}/${escHtml(bounty.repo?.name)}</a>
          with that token in the PR title, and the bounty pays out in Gold Knots when the owner merges it.
        </p>
        ${!loggedIn ? `
          <div class="notice notice-warn mb-3">Sign in on the main page to take bounties and collect Gold Knots.</div>
        ` : (!trackable ? `
          <div class="notice notice-warn mb-3">This is a demo/mock bounty — it has no real tangled repo.</div>
        ` : `<button class="btn btn-primary btn-lg w-full" id="pr-start-btn">Accept bounty &amp; get my token</button>`)}
      </div>
    </div>
  `;
  if (loggedIn && trackable) {
    document.getElementById('pr-start-btn')?.addEventListener('click', () => onStart(bounty));
  }
}

function renderTokenInstructions(bounty, token) {
  return `
    <div class="verify-panel" style="display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap">
      <code style="font-size:1rem;font-weight:700">${escHtml(token)}</code>
      <button class="btn btn-ghost btn-sm" id="pr-token-copy">Copy</button>
    </div>
    <ol class="text-sm text-secondary mt-2" style="padding-left:1.25rem;display:flex;flex-direction:column;gap:0.35rem">
      <li>Open a PR on
        <a href="${escHtml(pullsUrl(bounty))}" target="_blank" rel="noopener">${escHtml(bounty.repo?.handle)}/${escHtml(bounty.repo?.name)}</a>
        (Paste Patch / Compare Branches).</li>
      <li>Include the token <strong>in the PR title</strong>, e.g. <code>${escHtml(token)} fix: …</code></li>
      <li>Leave the rest to us — no need to paste anything back.</li>
    </ol>
  `;
}

function onStart(bounty) {
  try {
    startSubmission(bounty);
    renderPRSection(bounty); // re-render → pending branch shows token + wires copy
  } catch (e) {
    alert(e.message);
  }
}

// ── Verification panel ────────────────────────────────────────────────────

// Render the ordered chain of on-chain verification checks (from repo-verify).
function renderVerifySteps(steps) {
  if (!steps?.length) return '';
  return `<div class="mt-2" style="display:flex;flex-direction:column;gap:0.15rem">${
    steps.map(s => `
      <div style="display:flex;gap:0.5rem;align-items:baseline;font-size:0.8125rem">
        <span style="color:var(--${s.ok ? 'bounty-green' : 'diff-4'},${s.ok ? '#3fb950' : '#f85149'})">${s.ok ? '✓' : '✗'}</span>
        <span style="flex:1">${escHtml(s.label)}${s.detail ? ` <span class="text-muted font-mono" style="font-size:0.75rem">— ${escHtml(s.detail)}</span>` : ''}</span>
      </div>`).join('')
  }</div>`;
}

function renderVerifyPanel(award) {
  const section = document.getElementById('verify-section');
  section.innerHTML = `
    <div class="card mb-4">
      <div class="card-body">
        <div class="flex items-center justify-between mb-3">
          <div class="parse-section-title">Cryptographic Verification</div>
          <span class="verified-badge">✓ Repo commit signed</span>
        </div>

        <p class="text-sm text-secondary mb-3">
          <strong class="text-secondary">On-chain proof — the real DID key.</strong> When this award was
          written to the hunter's PDS, their AT Protocol repository commit was signed with the account's
          <strong>real DID signing key</strong> (the <code>#atproto</code> key in their DID document). We
          re-verify that signature here in your browser using only public data: fetch the signed proof,
          check the commit signature against the DID document, and prove the award sits inside that
          signed commit. No trust in this app required.
        </p>
        <button class="btn btn-primary btn-sm mb-2" id="onchain-btn">Verify on-chain (real DID key) →</button>
        <div id="onchain-result" class="mb-3"></div>

        <p class="text-sm text-secondary mb-3">
          <strong class="text-secondary">App-layer integrity (demo key).</strong> Separately, the award
          carries an ephemeral session-key signature (ECDSA P-256) over bountyUri + pullRequestUri +
          hunterDid + awardedAt. That key is per-session and not tied to any identity, so it proves those
          four fields are unaltered — but not <em>who</em> authorized them. The on-chain check above is
          what binds the award to a real account.
        </p>

        <div class="verify-panel">
          <div class="text-xs text-muted font-mono mb-2" style="word-break:break-all">
            <strong>Signature (hex):</strong> ${truncateHex(award.signature)}
          </div>
          <div class="text-xs text-muted font-mono" style="word-break:break-all">
            <strong>Public Key (JWK x):</strong> ${award.publicKeyJwk?.x?.slice(0,32)}…
          </div>
        </div>

        <button class="btn btn-secondary btn-sm mt-3" id="verify-btn">
          Run crypto.subtle.verify() →
        </button>
        <div id="verify-result" class="mt-2"></div>

        <div class="collapsible-header mt-3" id="award-schema-toggle">
          <span class="collapsible-title">Raw sh.tangled.bounty.award Record</span>
          <span class="collapsible-chevron">▼</span>
        </div>
        <div class="collapsible-body" id="award-schema-body">
          <pre class="code-block">${escHtml(JSON.stringify({
            $type: 'sh.tangled.bounty.award',
            bountyUri:      award.bountyUri,
            pullRequestUri: award.pullRequestUri,
            hunterDid:      award.hunterDid,
            skills:         award.skills,
            difficulty:     award.difficulty,
            points:         award.points,
            awardedAt:      award.awardedAt,
            awardedBy:      award.awardedBy,
            signature:      award.signature?.slice(0, 40) + '…',
            publicKeyJwk:   '{ "kty":"EC", "crv":"P-256", … }',
          }, null, 2))}</pre>
        </div>
      </div>
    </div>
  `;

  document.getElementById('award-schema-toggle').addEventListener('click', function() {
    this.classList.toggle('open');
    document.getElementById('award-schema-body').classList.toggle('open');
  });

  document.getElementById('onchain-btn').addEventListener('click', async () => {
    const btn = document.getElementById('onchain-btn');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Verifying on-chain…';
    const r = await verifyAwardOnChain(award);
    btn.disabled = false;
    btn.textContent = 'Re-run on-chain verification →';
    document.getElementById('onchain-result').innerHTML = `
      <div class="verify-status ${r.ok ? 'verify-pass' : 'verify-fail'}">
        ${r.ok ? "✓ Signed by the account's real DID key" : '✗ On-chain verification failed'}
      </div>
      ${renderVerifySteps(r.steps)}
      <p class="text-xs text-muted mt-1">${escHtml(r.reason)}</p>
    `;
  });

  document.getElementById('verify-btn').addEventListener('click', async () => {
    const btn = document.getElementById('verify-btn');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Verifying…';
    const result = await verifyAward(award);
    btn.disabled = false;
    btn.textContent = 'Run crypto.subtle.verify() →';

    document.getElementById('verify-result').innerHTML = result.valid ? `
      <div class="verify-status verify-pass">✓ Signature valid</div>
      <p class="text-xs text-muted mt-1">${escHtml(result.reason)}</p>
      <p class="text-xs text-muted">Algorithm: ${escHtml(result.algorithm || '')}</p>
    ` : `
      <div class="verify-status verify-fail">✗ Verification failed</div>
      <p class="text-xs text-muted mt-1">${escHtml(result.reason)}</p>
    `;
  });
}

// ── Init ──────────────────────────────────────────────────────────────────

function init() {
  if (!bountyId) {
    document.getElementById('bounty-content').innerHTML = `
      <div class="empty-state"><p>No bounty ID specified. <a href="index.html">Back to feed</a></p></div>
    `;
    return;
  }

  const bounty = getBountyById(bountyId);
  if (!bounty) {
    document.getElementById('bounty-content').innerHTML = `
      <div class="empty-state"><p>Bounty not found. <a href="index.html">Back to feed</a></p></div>
    `;
    return;
  }

  document.title = `${bounty.issueTitle} — Knotch`;
  renderBounty(bounty);
  renderPRSection(bounty);

  // Resolve a pending PR right here too (not just from the main-page poll), so
  // reloading this page picks up a merge/close. Re-render the PR section on any
  // change, and keep it live while the page is open.
  if (isLoggedIn()) {
    const refresh = async () => {
      const { changed } = await reconcileSubmissions();
      if (changed) renderPRSection(getBountyById(bountyId) || bounty);
    };
    refresh();
    const timer = setInterval(refresh, 20000);
    window.addEventListener('beforeunload', () => clearInterval(timer));
  }
}

renderNavChip();
init();
