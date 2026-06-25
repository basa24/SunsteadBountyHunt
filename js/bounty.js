import { getBountyById, getUserHandle, getUserProfile, markBountyCompleted, addAward, getSubmissionForBounty } from './storage.js';
import { verifyAward, truncateHex } from './signer.js';
import { isLoggedIn, getSession } from './auth.js';
import { submitPullRequest, canSubmitPR } from './pulls.js';
import { DIFFICULTY_LABELS, DIFFICULTY_DESCRIPTIONS } from './data.js';
import { renderNavChip } from './navchip.js';

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

// ── Render bounty detail ──────────────────────────────────────────────────

function renderBounty(bounty) {
  const topHtml = (bounty.topKeywords || []).map(k => `<span class="kw top">${k}</span>`).join('');
  const kwHtml  = (bounty.keywords   || [])
    .filter(k => !bounty.topKeywords?.includes(k))
    .map(k => `<span class="kw">${k}</span>`).join('');

  const pts = Math.round(bounty.difficulty * 20 * (bounty.repo?.authorityWeight || 0.5));

  const dots = Array.from({ length: 5 }, (_, i) =>
    `<div class="diff-dot ${i < bounty.difficulty ? `active-${bounty.difficulty}` : ''}"></div>`
  ).join('');

  document.getElementById('bounty-content').innerHTML = `
    <div class="flex items-center gap-2 mb-3 text-sm text-muted">
      <span class="status-badge status-open">● Open</span>
      <span>Posted ${timeAgo(bounty.createdAt)}</span>
      <a href="${escHtml(bounty.issueUrl || '#')}" target="_blank" rel="noopener" class="btn btn-ghost btn-sm">
        View on tangled.org ↗
      </a>
    </div>

    <h1 style="font-size:1.375rem;font-weight:700;margin-bottom:1rem;line-height:1.3">
      ${escHtml(bounty.issueTitle)}
    </h1>

    <div class="card mb-4">
      <div class="card-header flex items-center justify-between">
        <div class="flex items-center gap-2">
          <img class="avatar" style="width:36px;height:36px" src="${avatar(bounty.repo?.handle)}" alt="" />
          <div>
            <div class="font-bold text-sm">${escHtml(bounty.repo?.handle || '?')}</div>
            <div class="text-xs text-muted">${escHtml(bounty.repo?.name || '?')} · ⭐ ${bounty.repo?.stars ?? '–'}</div>
          </div>
        </div>
        <span class="points-badge" style="font-size:1rem" title="${pts} Gold Knots">+${pts} GK</span>
      </div>
      <div class="card-body">
        <div class="issue-body"><p>${renderMarkdown(bounty.issueBody || '(No body)')}</p></div>
      </div>
    </div>

    <div class="card mb-4">
      <div class="card-body">
        <div class="parse-section-title mb-2">Keywords</div>
        <div class="bounty-tags mb-1">${topHtml}${kwHtml}</div>
        <div class="text-xs text-muted">Top 3 highlighted · ${(bounty.keywords||[]).length} total</div>

        <hr class="divider">

        <div class="parse-section-title mb-2">Difficulty</div>
        <div class="flex items-center gap-3 mb-1">
          <div class="diff-meter">${dots}</div>
          <span class="diff-badge ${diffClass(bounty.difficulty)}">${bounty.difficulty} · ${DIFFICULTY_LABELS[bounty.difficulty]}</span>
        </div>
        <div class="text-xs text-muted">${DIFFICULTY_DESCRIPTIONS[bounty.difficulty]}</div>

        <hr class="divider">

        <div class="parse-section-title mb-1">Authority Weight</div>
        <div class="text-sm text-secondary">
          <strong>${bounty.repo?.authorityWeight ?? '–'}</strong>
          <span class="text-muted"> (based on ${bounty.repo?.stars ?? 0} stars · affects final point value)</span>
        </div>
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
  `;

  // Collapsible toggle
  document.getElementById('schema-toggle').addEventListener('click', function() {
    this.classList.toggle('open');
    document.getElementById('schema-body').classList.toggle('open');
  });
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
          <div class="success-icon">🪙</div>
          <div class="success-title">PR Merged — Gold Knots Minted!</div>
          <div class="success-sub flex flex-col items-center gap-2">
            ${award ? `<span class="points-badge lg gk-pop" style="font-size:1.125rem">+${award.points} Gold Knots</span>` : ''}
            <span class="text-xs text-muted">Awarded after the owner merged your PR on tangled.</span>
          </div>
          <a href="profile.html" class="btn btn-primary mt-2">View Your Profile →</a>
        </div>
      `;
      if (award) renderVerifyPanel(award);
      return;
    }
    if (sub.status === 'declined') {
      section.innerHTML = `
        <div class="card mb-4"><div class="card-body">
          <div class="notice notice-warn mb-2">✗ Your pull request was closed without merging — no award.</div>
          <p class="text-sm text-secondary mb-3">You can submit a new pull request to try again.</p>
          <button class="btn btn-primary" id="pr-btn">Submit Another Pull Request</button>
        </div></div>
      `;
      document.getElementById('pr-btn')?.addEventListener('click', () => onSubmitPR(bounty));
      return;
    }
    // pending
    section.innerHTML = `
      <div class="card mb-4" style="border-color:var(--bounty-green-dim)"><div class="card-body">
        <div class="parse-section-title mb-2">Pull Request Submitted</div>
        <p class="text-sm text-secondary mb-2">
          ⏳ Awaiting the owner's review on tangled. When they <strong>merge</strong> it, your award is recorded
          automatically (we watch the PR's status). If they close it, it's marked declined.
        </p>
        <div class="flex items-center gap-2">
          <a href="${escHtml(pullsUrl(bounty))}" target="_blank" rel="noopener" class="btn btn-ghost btn-sm">View pulls on tangled ↗</a>
        </div>
        <div class="text-xs text-muted mt-2" style="word-break:break-all">PR: <code>${escHtml(sub.prUri)}</code></div>
      </div></div>
    `;
    return;
  }

  // Bounty completed by someone else.
  if (bounty.status === 'completed') {
    section.innerHTML = `
      <div class="notice" style="margin-bottom:1rem">
        ✓ This bounty was completed by <strong>${escHtml(bounty.completedBy || 'a hunter')}</strong>.
      </div>
    `;
    return;
  }

  // No submission yet → offer to open a real PR.
  const loggedIn = isLoggedIn();
  const submittable = canSubmitPR(bounty);
  section.innerHTML = `
    <div class="card mb-4" style="border-color:var(--bounty-green-dim)">
      <div class="card-body">
        <div class="parse-section-title mb-2">Submit Your Solution</div>
        <p class="text-sm text-secondary mb-3">
          Open a pull request on
          <a href="${escHtml(pullsUrl(bounty))}" target="_blank" rel="noopener">${escHtml(bounty.repo?.handle)}/${escHtml(bounty.repo?.name)}</a>.
          The owner reviews and <strong>merges it on tangled</strong>; we detect the merge and record your award.
        </p>
        ${!loggedIn ? `
          <div class="notice notice-warn mb-3">Sign in on the main page to submit a pull request.</div>
        ` : (!submittable ? `
          <div class="notice notice-warn mb-3">This is a demo/mock bounty — it has no real tangled repo to open a PR against.</div>
        ` : '')}
        <button class="btn btn-primary btn-lg w-full" id="pr-btn" ${(!loggedIn || !submittable) ? 'disabled' : ''}>
          Submit Pull Request
        </button>
        <p class="text-xs text-muted mt-2 text-center">
          A real <code>sh.tangled.repo.pull</code> is written to your PDS and shows up on tangled's pulls page.
        </p>
      </div>
    </div>
  `;

  document.getElementById('pr-btn')?.addEventListener('click', () => onSubmitPR(bounty));
}

async function onSubmitPR(bounty) {
  const btn = document.getElementById('pr-btn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Submitting PR…';
  try {
    await submitPullRequest(bounty);
    renderPRSection(bounty); // re-render → now shows the pending state
  } catch (e) {
    btn.disabled = false;
    btn.textContent = 'Submit Pull Request';
    alert(e.message);
  }
}

// ── Verification panel ────────────────────────────────────────────────────

function renderVerifyPanel(award) {
  const section = document.getElementById('verify-section');
  section.innerHTML = `
    <div class="card mb-4">
      <div class="card-body">
        <div class="flex items-center justify-between mb-3">
          <div class="parse-section-title">Cryptographic Verification</div>
          <span class="verified-badge">✓ ECDSA P-256 Signed</span>
        </div>

        <p class="text-sm text-secondary mb-3">
          This award record is signed with an ECDSA P-256 key. The signature covers:
          bountyUri + pullRequestUri + hunterDid + awardedAt. No one can forge this
          without the signer's private key.
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

  document.title = `${bounty.issueTitle} — Bounty Hunt`;
  renderBounty(bounty);
  renderPRSection(bounty);
}

renderNavChip();
init();
