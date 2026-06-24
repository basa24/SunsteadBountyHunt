import { getBounties, getUserHandle, getUserProfile, setUserHandle, setUserProfile, clearUserHandle } from './storage.js';
import { fetchLiveBounties, fetchUserProfile } from './fetcher.js';
import { rankBounties, extractAllSkills } from './ranking.js';
import { DIFFICULTY_LABELS } from './data.js';

// ── Helpers ───────────────────────────────────────────────────────────────

function timeAgo(iso) {
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 60)   return 'just now';
  if (s < 3600) return `${Math.floor(s/60)}m ago`;
  if (s < 86400) return `${Math.floor(s/3600)}h ago`;
  return `${Math.floor(s/86400)}d ago`;
}

function diffLabel(d) { return DIFFICULTY_LABELS[d] || '?'; }

function diffClass(d) {
  if (d <= 2) return 'diff-2';
  if (d === 3) return 'diff-3';
  if (d === 4) return 'diff-4';
  return 'diff-5';
}

function points(bounty) {
  return Math.round(bounty.difficulty * 20 * (bounty.repo?.authorityWeight || 0.5));
}

function avatar(handle) {
  return `https://api.dicebear.com/7.x/identicon/svg?seed=${encodeURIComponent(handle)}&size=24`;
}

// ── Render ────────────────────────────────────────────────────────────────

function renderBountyCard(bounty) {
  const kwHtml = [
    ...(bounty.topKeywords || []).map(k => `<span class="kw top">${k}</span>`),
    ...(bounty.keywords || [])
      .filter(k => !bounty.topKeywords?.includes(k))
      .slice(0, 4)
      .map(k => `<span class="kw">${k}</span>`),
  ].join('');

  const reasonHtml = bounty._reason
    ? `<span class="reason-tag">${bounty._reason}</span>` : '';

  return `
    <div class="card card-hover" onclick="window.location='bounty.html?id=${bounty.id}'">
      <div class="card-body bounty-card">
        <div class="bounty-card-top">
          <div class="bounty-title">
            <a href="bounty.html?id=${bounty.id}" onclick="event.stopPropagation()">
              ${escHtml(bounty.issueTitle)}
            </a>
          </div>
          <span class="diff-badge ${diffClass(bounty.difficulty)}" title="${DIFFICULTY_LABELS[bounty.difficulty]}">
            ${bounty.difficulty} · ${diffLabel(bounty.difficulty)}
          </span>
        </div>

        <div class="bounty-meta">
          <span class="bounty-repo">
            <img class="avatar avatar-sm" src="${avatar(bounty.repo?.handle)}" alt="" />
            <a href="https://tangled.org/${bounty.repo?.handle}/${bounty.repo?.name}"
               target="_blank" rel="noopener" onclick="event.stopPropagation()">
              ${escHtml(bounty.repo?.handle)}/${escHtml(bounty.repo?.name)}
            </a>
          </span>
          <span class="text-muted">⭐ ${bounty.repo?.stars ?? '–'}</span>
          <span class="text-muted">${bounty.repo?.language || '–'}</span>
          <span class="text-muted">${timeAgo(bounty.createdAt)}</span>
        </div>

        <div class="bounty-footer">
          <div class="bounty-tags">${kwHtml}</div>
          <div class="bounty-right">
            ${reasonHtml}
            <span class="points-badge">+${points(bounty)} pts</span>
          </div>
        </div>

        <div class="text-xs text-muted mt-1" style="line-height:1.4">
          ${escHtml(bounty.summary || '')}
        </div>
      </div>
    </div>
  `;
}

function renderSkeletons(n = 5) {
  return Array.from({ length: n }, () => `
    <div class="skeleton-card">
      <div class="skeleton skeleton-line" style="width:65%"></div>
      <div class="skeleton skeleton-line" style="width:40%; height:10px"></div>
      <div class="skeleton skeleton-line" style="width:80%; height:10px"></div>
    </div>
  `).join('');
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── State ─────────────────────────────────────────────────────────────────

let currentFilter = { skill: '', diff: '', sort: 'relevance' };

function applyFilters() {
  const bounties = getBounties();
  const ranked = rankBounties(bounties, {
    limit: 20,
    filterSkill: currentFilter.skill || null,
    filterDiff:  currentFilter.diff  || null,
    sortMode:    currentFilter.sort,
  });
  document.getElementById('feed').innerHTML =
    ranked.length ? ranked.map(renderBountyCard).join('') : `
      <div class="empty-state">
        <div style="font-size:2rem">🎯</div>
        <p>No bounties match your filters.</p>
      </div>`;
}

// ── User onboarding banner ────────────────────────────────────────────────

function renderUserBanner() {
  const handle = getUserHandle();
  const banner = document.getElementById('user-banner');
  const navUser = document.getElementById('nav-user');

  if (handle) {
    banner.classList.add('hidden');
    navUser.innerHTML = `
      <img class="avatar avatar-sm" src="${avatar(handle)}" alt="" />
      <span>${escHtml(handle)}</span>
      <button class="btn btn-ghost btn-sm" id="logout-btn" title="Disconnect">✕</button>
    `;
    document.getElementById('logout-btn')?.addEventListener('click', () => {
      clearUserHandle();
      location.reload();
    });
  } else {
    banner.classList.remove('hidden');
    navUser.innerHTML = `<span class="text-muted text-sm">Not connected</span>`;
  }
}

async function connectHandle(handle) {
  const btn = document.getElementById('connect-btn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Resolving…';

  try {
    // Try to resolve handle and fetch profile from tangled.org
    let profile;
    try {
      profile = await fetchUserProfile(handle);
    } catch {
      // Offline fallback — create a minimal profile
      profile = {
        did: `did:plc:local-${handle.replace(/\./g,'')}`,
        handle,
        displayName: handle.split('.')[0],
        avatar: null,
        following: [],
        starredRepos: [],
        bountyProfile: {
          totalCompleted: 0,
          skillBreakdown: {},
          avgDifficulty: 0,
          completionStreak: 0,
          totalPoints: 0,
          public: true,
          lastUpdated: new Date().toISOString(),
        },
        awards: [],
      };
    }
    setUserHandle(handle);
    setUserProfile(profile);
    location.reload();
  } catch (err) {
    btn.disabled = false;
    btn.textContent = 'Connect';
    alert(`Could not resolve handle: ${err.message}`);
  }
}

// ── Skill filter dropdown ─────────────────────────────────────────────────

function populateSkillFilter(bounties) {
  const select = document.getElementById('skill-filter');
  const skills = extractAllSkills(bounties);
  skills.forEach(s => {
    const opt = document.createElement('option');
    opt.value = s;
    opt.textContent = s;
    select.appendChild(opt);
  });
}

// ── Init ──────────────────────────────────────────────────────────────────

async function init() {
  renderUserBanner();

  // Show skeletons while loading
  const feed = document.getElementById('feed');
  feed.innerHTML = renderSkeletons(5);

  // Show stale/mock data immediately
  setTimeout(applyFilters, 0);

  // Attempt live fetch in background
  const notice = document.getElementById('live-notice');
  try {
    await fetchLiveBounties(({ repo, count, error }) => {
      if (!error && count > 0) {
        applyFilters(); // refresh feed as new bounties arrive
      }
    });
    if (notice) {
      notice.textContent = '✓ Live data from tangled.org';
      notice.className = 'notice notice-info';
    }
  } catch {
    if (notice) {
      notice.textContent = '⚠ Live fetch unavailable — showing cached/demo data';
      notice.className = 'notice notice-warn';
    }
  }

  // Final render with fresh data
  applyFilters();
  populateSkillFilter(getBounties());

  // Filters
  document.getElementById('skill-filter')?.addEventListener('change', e => {
    currentFilter.skill = e.target.value;
    applyFilters();
  });
  document.getElementById('diff-filter')?.addEventListener('change', e => {
    currentFilter.diff = e.target.value;
    applyFilters();
  });
  document.getElementById('sort-select')?.addEventListener('change', e => {
    currentFilter.sort = e.target.value;
    applyFilters();
  });

  // Connect button
  document.getElementById('connect-btn')?.addEventListener('click', () => {
    const h = document.getElementById('handle-input').value.trim();
    if (h) connectHandle(h);
  });
  document.getElementById('handle-input')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('connect-btn')?.click();
  });
}

init();
