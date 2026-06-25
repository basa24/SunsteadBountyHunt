import './brand.js';
import { getUserProfile, getUserHandle, updateUserProfile, addBounty } from './storage.js';
import { verifyAward, truncateHex } from './signer.js';
import { fetchUserProfile, fetchUserBounties, verifyBountyRecord } from './fetcher.js';
import { DIFFICULTY_LABELS } from './data.js';
import { renderNavChip } from './navchip.js';
import { runCountUps } from './juice.js';

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

function fmtDate(iso) {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function avatar(handle) {
  return `https://api.dicebear.com/7.x/identicon/svg?seed=${encodeURIComponent(handle)}&size=64`;
}

// ── Render profile header ─────────────────────────────────────────────────

function renderHeader(profile, { self = true } = {}) {
  const bp = profile.bountyProfile || {};

  // Self: editable Public-Profile toggle. Other user: a read-only "viewing" tag.
  const rightHtml = self
    ? `<label class="flex items-center gap-2 text-sm text-secondary" style="cursor:pointer">
         <input type="checkbox" id="public-toggle" ${bp.public ? 'checked' : ''} />
         Public Profile
       </label>`
    : `<a href="index.html" class="btn btn-ghost btn-sm">← Back to feed</a>`;

  document.getElementById('profile-header').innerHTML = `
    <div class="profile-header">
      <img class="avatar avatar-lg" src="${avatar(profile.handle)}" alt="" />
      <div class="profile-info flex-1">
        <div class="profile-name">${escHtml(profile.displayName || profile.handle)}${self ? '' : ' <span class="text-muted text-sm">· hunter</span>'}</div>
        <div class="profile-handle">
          <a href="https://tangled.org/${escHtml(profile.handle)}" target="_blank" rel="noopener">
            @${escHtml(profile.handle)} ↗
          </a>
        </div>
        <div class="profile-did">${escHtml(profile.did || '')}</div>
      </div>
      <div>${rightHtml}</div>
    </div>
  `;

  if (self) {
    document.getElementById('public-toggle')?.addEventListener('change', e => {
      updateUserProfile({ bountyProfile: { public: e.target.checked } });
    });
  }
}

// ── Stats row ─────────────────────────────────────────────────────────────

function renderStats(profile) {
  const bp = profile.bountyProfile || {};
  const statsEl = document.getElementById('stats-row');
  statsEl.innerHTML = `
    <div class="stats-row mb-4">
      <div class="stat-item">
        <div class="stat-value" data-countup="${bp.totalCompleted || 0}">0</div>
        <div class="stat-label">Completed</div>
      </div>
      <div class="stat-item">
        <div class="stat-value">🪙 <span data-countup="${bp.totalPoints || 0}">0</span></div>
        <div class="stat-label">Gold Knots</div>
      </div>
      <div class="stat-item">
        <div class="stat-value">${(bp.avgDifficulty || 0).toFixed(1)}</div>
        <div class="stat-label">Avg Difficulty</div>
      </div>
      <div class="stat-item">
        <div class="stat-value" data-countup="${bp.completionStreak || 0}">0</div>
        <div class="stat-label">Day Streak</div>
      </div>
    </div>
  `;
  runCountUps(statsEl);
}

// ── Skill breakdown bar chart ─────────────────────────────────────────────

function renderSkillBars(profile) {
  const skills = profile.bountyProfile?.skillBreakdown || {};
  const entries = Object.entries(skills).sort((a, b) => b[1] - a[1]);
  const max = entries[0]?.[1] || 1;

  if (!entries.length) {
    document.getElementById('skill-bars').innerHTML = `
      <p class="text-muted text-sm">No skills recorded yet. Complete bounties to build your profile.</p>
    `;
    return;
  }

  document.getElementById('skill-bars').innerHTML = `
    <div class="skill-bar-list">
      ${entries.map(([skill, count]) => `
        <div class="skill-bar-item">
          <div class="skill-bar-header">
            <span class="skill-bar-name">${escHtml(skill)}</span>
            <span class="skill-bar-count">${count} bounty${count > 1 ? 's' : ''}</span>
          </div>
          <div class="skill-bar-track">
            <div class="skill-bar-fill" style="width:${(count/max*100).toFixed(1)}%"></div>
          </div>
        </div>
      `).join('')}
    </div>
  `;
}

// ── Award card ────────────────────────────────────────────────────────────

function renderAwardCard(award, idx) {
  const kwHtml = (award.skills || []).map(s => `<span class="kw top">${escHtml(s)}</span>`).join('');
  const verifiedHtml = award.verified
    ? `<span class="verified-badge">✓ Signed</span>`
    : `<span class="unverified-badge">– Unverified</span>`;
  // The merged PR that earned this award (token-flow awards store a real URL).
  const prHtml = /^https?:\/\//.test(award.pullRequestUri || '')
    ? `<a class="btn btn-ghost btn-sm" href="${escHtml(award.pullRequestUri)}" target="_blank" rel="noopener" title="The merged pull request">View PR ↗</a>`
    : '';

  return `
    <div class="award-card" id="award-${idx}">
      <div class="award-top">
        <div>
          <div class="award-title">
            <a href="bounty.html?id=${escHtml(award.bountyId)}">${escHtml(award.bountyTitle)}</a>
          </div>
          <div class="award-meta mt-1">
            <a href="${escHtml(award.repoUrl || '#')}" target="_blank" rel="noopener" class="text-secondary">
              ${escHtml(award.repoHandle)}/${escHtml(award.repo)}
            </a>
            <span>${fmtDate(award.awardedAt)}</span>
          </div>
        </div>
        <div class="flex flex-col items-end gap-1">
          <span class="points-badge" title="${award.points} Gold Knots">+${award.points} GK</span>
          <span class="diff-badge ${diffClass(award.difficulty)} text-xs">${award.difficulty} · ${DIFFICULTY_LABELS[award.difficulty]}</span>
        </div>
      </div>

      <div class="flex items-center justify-between flex-wrap gap-2">
        <div class="bounty-tags">${kwHtml}</div>
        <div class="flex items-center gap-2">
          ${prHtml}
          ${verifiedHtml}
          <button class="btn btn-ghost btn-sm" data-verify-idx="${idx}">Verify ↗</button>
        </div>
      </div>

      <div class="text-xs text-muted">
        Authority weight: <strong>${award.authorityWeight ?? '–'}</strong>
        · Awarded by <strong>${escHtml(award.awardedByHandle || award.awardedBy)}</strong>
      </div>

      <div id="verify-result-${idx}" class="hidden"></div>
    </div>
  `;
}

function renderAwards(profile) {
  const awards = profile.awards || [];
  const container = document.getElementById('awards-list');

  if (!awards.length) {
    container.innerHTML = `
      <div class="empty-state">
        <div style="font-size:2rem">🏆</div>
        <p>No bounties claimed yet.<br>
           <a href="index.html">Hit the board</a> and bag your first bounty.</p>
      </div>
    `;
    return;
  }

  container.innerHTML = awards.map((a, i) => renderAwardCard(a, i)).join('');

  // Wire verify buttons
  container.querySelectorAll('[data-verify-idx]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const idx = parseInt(btn.dataset.verifyIdx, 10);
      const award = awards[idx];
      const resultEl = document.getElementById(`verify-result-${idx}`);

      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span>';

      const result = await verifyAward(award);
      btn.disabled = false;
      btn.textContent = 'Verify ↗';
      resultEl.classList.remove('hidden');
      resultEl.innerHTML = result.valid ? `
        <div class="verify-status verify-pass text-xs">✓ ${escHtml(result.reason)}</div>
      ` : `
        <div class="verify-status verify-fail text-xs">✗ ${escHtml(result.reason)}</div>
      `;
    });
  });
}

// ── AT Protocol record schemas ────────────────────────────────────────────

function renderSchemas(profile) {
  const bp = profile.bountyProfile || {};
  document.getElementById('profile-schema').innerHTML = JSON.stringify({
    $type: 'sh.tangled.bounty.profile',
    key: 'self',
    totalCompleted: bp.totalCompleted || 0,
    skillBreakdown: bp.skillBreakdown || {},
    avgDifficulty: bp.avgDifficulty || 0,
    completionStreak: bp.completionStreak || 0,
    public: bp.public ?? true,
    lastUpdated: bp.lastUpdated,
  }, null, 2);
}

// ── Bounties posted by this person ──────────────────────────────────────────

function gk(b) {
  return Math.round(b.difficulty * 20 * (b.repo?.authorityWeight || 0.5));
}

function renderPostedBounties(bounties) {
  const el = document.getElementById('posted-bounties');
  if (!el) return;

  if (!bounties.length) {
    el.innerHTML = `<p class="text-muted text-sm">No open #bounty issues posted.</p>`;
    return;
  }

  // Cache them so the in-app bounty page can open them.
  bounties.forEach(addBounty);

  el.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:0.6rem">
      ${bounties.map((b, i) => `
        <div class="posted-bounty" data-idx="${i}">
          <div style="display:flex;align-items:center;gap:0.5rem">
            <span class="diff-badge ${diffClass(b.difficulty)} text-xs">${b.difficulty}</span>
            <a href="bounty.html?id=${encodeURIComponent(b.id)}"
               style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
               title="${escHtml(b.issueTitle)}">${escHtml(b.issueTitle)}</a>
            <span class="points-badge" title="${gk(b)} Gold Knots">+${gk(b)} GK</span>
            <button class="btn btn-ghost btn-sm" data-verify-bounty="${i}" title="Verify this is a real record in the author's repo">Verify</button>
          </div>
          <div id="bverify-${i}" class="hidden text-xs mt-1"></div>
        </div>
      `).join('')}
    </div>
  `;

  // Verify = provenance check against the author's canonical PDS.
  el.querySelectorAll('[data-verify-bounty]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const i = parseInt(btn.dataset.verifyBounty, 10);
      const out = document.getElementById(`bverify-${i}`);
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span>';
      const r = await verifyBountyRecord(bounties[i]);
      btn.disabled = false;
      btn.textContent = 'Verify';
      out.classList.remove('hidden');
      if (r.valid) {
        const host = (() => { try { return new URL(r.pds).host; } catch { return r.pds; } })();
        out.innerHTML = `
          <div class="verify-status ${r.cidMatch ? 'verify-pass' : 'verify-fail'}">${r.cidMatch ? '✓' : '⚠'} ${escHtml(r.reason)}</div>
          <div class="text-muted" style="word-break:break-all">${escHtml(r.did)} · ${escHtml(host)}</div>`;
      } else {
        out.innerHTML = `<div class="verify-status verify-fail">✗ ${escHtml(r.reason)}</div>`;
      }
    });
  });
}

// ── Collapsibles ──────────────────────────────────────────────────────────

function initCollapsibles() {
  document.querySelectorAll('.collapsible-header').forEach(h => {
    h.addEventListener('click', function() {
      this.classList.toggle('open');
      this.nextElementSibling.classList.toggle('open');
    });
  });
}

// ── Init ──────────────────────────────────────────────────────────────────

function renderProfile(profile, { self }) {
  document.title = `@${profile.handle} — Knotch Profile`;
  renderHeader(profile, { self });
  renderStats(profile);
  renderSkillBars(profile);
  renderAwards(profile);
  renderSchemas(profile);
  initCollapsibles();
}

async function init() {
  const viewHandle = new URLSearchParams(location.search).get('handle');
  const myHandle   = getUserHandle();
  const isOther    = viewHandle && viewHandle.toLowerCase() !== (myHandle || '').toLowerCase();

  if (isOther) {
    // Viewing someone else — public, read-only. Fetch their live profile + posts.
    document.getElementById('profile-header').innerHTML =
      `<div class="notice">Loading @${escHtml(viewHandle)}…</div>`;
    try {
      const profile = await fetchUserProfile(viewHandle);
      renderProfile(profile, { self: false });
    } catch (err) {
      document.getElementById('profile-header').innerHTML = `
        <div class="notice notice-warn">
          Couldn't load @${escHtml(viewHandle)} (${escHtml(err.message)}).
          <a href="index.html" class="ml-2">← Back to feed</a>
        </div>`;
      ['stats-row', 'skill-bars', 'awards-list', 'posted-bounties'].forEach(id => {
        const e = document.getElementById(id); if (e) e.innerHTML = '';
      });
      return;
    }
    fetchUserBounties(viewHandle).then(renderPostedBounties).catch(() => renderPostedBounties([]));
    return;
  }

  // Self mode (no ?handle or it's me).
  const profile = getUserProfile();
  if (!myHandle || !profile) {
    document.getElementById('profile-header').innerHTML = `
      <div class="notice notice-warn">
        No handle connected.
        <a href="index.html" class="ml-2">Connect on the main page →</a>
      </div>
    `;
    ['stats-row', 'skill-bars', 'awards-list', 'posted-bounties'].forEach(id => {
      const e = document.getElementById(id); if (e) e.innerHTML = '';
    });
    return;
  }

  renderProfile(profile, { self: true });
  // Your own posted bounties too (live read).
  fetchUserBounties(myHandle).then(renderPostedBounties).catch(() => renderPostedBounties([]));
}

renderNavChip();
init();
