import { getBounties, getUserHandle, getUserProfile, setUserHandle, setUserProfile, clearUserHandle, addBounty, removeBountyByUri } from './storage.js';
import { fetchLiveBounties, fetchUserProfile, fetchUserBounties } from './fetcher.js';
import { login, logout, isLoggedIn, getSession } from './auth.js';
import { connectFirehose } from './firehose.js';
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
  // Combined tag list: top keywords first, then the rest. Only the first 3
  // show at rest — the others are revealed on hover via the .kw-extra class.
  const allTags = [
    ...(bounty.topKeywords || []).map(k => ({ k, top: true })),
    ...(bounty.keywords || [])
      .filter(k => !bounty.topKeywords?.includes(k))
      .map(k => ({ k, top: false })),
  ];
  const tagHtml = allTags.map((t, i) =>
    `<span class="kw ${t.top ? 'top' : ''} ${i >= 3 ? 'kw-extra' : ''}">${escHtml(t.k)}</span>`
  ).join('');

  const reasonHtml = bounty._reason
    ? `<span class="reason-tag">${escHtml(bounty._reason)}</span>` : '';

  const summaryHtml = bounty.summary
    ? `<div class="text-xs text-muted" style="line-height:1.5">${escHtml(bounty.summary)}</div>` : '';

  // Essentials at rest: title · goldKnots · repo · top 3 tags.
  // Everything else (difficulty, stars, language, age, extra tags, summary,
  // why-recommended) is folded into the hover-revealed secondary block.
  const diffLabelFull = `Difficulty ${bounty.difficulty} · ${diffLabel(bounty.difficulty)}`;

  return `
    <div class="bounty-card-wrap">
      <div class="card card-hover" style="--diff-color:var(--diff-${bounty.difficulty})"
           onclick="window.location='bounty.html?id=${bounty.id}'">
      <div class="card-body bounty-card">
        <div class="bounty-card-top">
          <div class="bounty-title">
            <span class="diff-pip ${diffClass(bounty.difficulty)}" title="${diffLabelFull}"
                  aria-label="${diffLabelFull}"></span>
            <a href="bounty.html?id=${bounty.id}" onclick="event.stopPropagation()">
              ${escHtml(bounty.issueTitle)}
            </a>
          </div>
          <span class="points-badge" title="${points(bounty)} Gold Knots">+${points(bounty)} GK</span>
        </div>

        <div class="bounty-primary-meta">
          <span class="bounty-repo">
            <img class="avatar avatar-sm" src="${avatar(bounty.repo?.handle)}" alt="" />
            <a href="https://tangled.org/${bounty.repo?.handle}/${bounty.repo?.name}"
               target="_blank" rel="noopener" onclick="event.stopPropagation()">
              ${escHtml(bounty.repo?.handle)}/${escHtml(bounty.repo?.name)}
            </a>
          </span>
          <div class="bounty-tags">${tagHtml}<span class="more-hint">hover for details ⋯</span></div>
        </div>

        <div class="bounty-secondary">
          <div class="bounty-secondary-inner">
            <div class="bounty-meta">
              <span class="diff-badge ${diffClass(bounty.difficulty)}" title="${DIFFICULTY_LABELS[bounty.difficulty]}">
                ${bounty.difficulty} · ${diffLabel(bounty.difficulty)}
              </span>
              <span class="text-muted">⭐ ${bounty.repo?.stars ?? '–'}</span>
              <span class="text-muted">${escHtml(bounty.repo?.language || '–')}</span>
              <span class="text-muted">${timeAgo(bounty.createdAt)}</span>
              ${reasonHtml}
            </div>
            ${summaryHtml}
          </div>
        </div>
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

// Compact live-status pill in the top-left nav. state ∈ loading | live | warn
function setLive(state, label) {
  const el = document.getElementById('live-notice');
  if (!el) return;
  el.className = 'live-indicator';
  el.dataset.state = state;
  el.innerHTML = `<span class="live-dot"></span><span class="live-label">${label}</span>`;
}

// ── State ─────────────────────────────────────────────────────────────────

let currentFilter = { skill: '', diff: '', sort: 'relevance' };

function applyFilters() {
  const bounties = getBounties();
  const ranked = rankBounties(bounties, {
    limit: 8,
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
  const handle = isLoggedIn() ? getSession().handle : null;
  const banner = document.getElementById('user-banner');
  const navUser = document.getElementById('nav-user');

  if (handle) {
    banner.classList.add('hidden');
    const gk = getUserProfile()?.bountyProfile?.totalPoints || 0;
    navUser.innerHTML = `
      <span class="gk-balance" title="Your Gold Knots balance">🪙 ${gk}</span>
      <div class="account-chip">
        <a class="account-chip-link" href="profile.html" title="View your profile">
          <img class="avatar avatar-sm" src="${avatar(handle)}" alt="" />
          <span class="handle">${escHtml(handle)}</span>
        </a>
        <button class="btn btn-ghost btn-sm" id="logout-btn" title="Log out">✕</button>
      </div>
    `;
    document.getElementById('logout-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      logout();
      clearUserHandle();
      location.reload();
    });
  } else {
    banner.classList.remove('hidden');
    navUser.innerHTML = `<button class="btn btn-primary btn-sm" id="nav-signin">Sign in</button>`;
    document.getElementById('nav-signin')?.addEventListener('click', () => {
      document.getElementById('user-banner')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setTimeout(() => document.getElementById('handle-input')?.focus(), 300);
    });
  }
}

function showLoginError(message) {
  const el = document.getElementById('login-error');
  if (el) {
    el.textContent = message;
    el.classList.remove('hidden');
  } else {
    alert(message);
  }
}

// Real AT Protocol login: exchange handle + app password for a session, then
// pull the user's real social graph for personalized ranking.
async function connectHandle(handle, appPassword) {
  const btn = document.getElementById('connect-btn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Signing in…';
  document.getElementById('login-error')?.classList.add('hidden');

  try {
    const session = await login(handle, appPassword);

    // Fetch the real public profile / social graph (best-effort — ranking
    // still works without it). No more fabricated DIDs.
    let profile;
    try {
      profile = await fetchUserProfile(session.handle);
    } catch {
      profile = {
        did: session.did,
        handle: session.handle,
        displayName: session.handle.split('.')[0],
        avatar: null,
        following: [],
        starredRepos: [],
        bountyProfile: {
          totalCompleted: 0, skillBreakdown: {}, avgDifficulty: 0,
          completionStreak: 0, totalPoints: 0, public: true,
          lastUpdated: new Date().toISOString(),
        },
        awards: [],
      };
    }
    setUserHandle(session.handle);
    setUserProfile(profile);
    location.reload();
  } catch (err) {
    btn.disabled = false;
    btn.textContent = 'Sign in';
    showLoginError(err.message);
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
  setLive('loading', 'Connecting…');
  try {
    await fetchLiveBounties(({ repo, count, error }) => {
      if (!error && count > 0) {
        applyFilters(); // refresh feed as new bounties arrive
      }
    });
    setLive('live', 'Live');
  } catch {
    setLive('warn', 'Offline');
  }

  // Back-fill the logged-in user's own #bounty issues directly from their PDS.
  // (Their tangled-hosted PDS isn't on the relay, so the firehose can't see
  // them — this read path is how a bounty you just created shows up.)
  if (isLoggedIn()) {
    const n = await syncUserBounties();
    if (n > 0) setLive('live', 'Live');
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

  // Login button (handle + app password)
  document.getElementById('connect-btn')?.addEventListener('click', () => {
    const h = document.getElementById('handle-input').value.trim();
    const p = document.getElementById('app-password-input')?.value ?? '';
    if (!h || !p) {
      showLoginError('Enter both your handle and an app password.');
      return;
    }
    connectHandle(h, p);
  });
  document.querySelectorAll('#handle-input, #app-password-input').forEach(el => {
    el.addEventListener('keydown', e => {
      if (e.key === 'Enter') document.getElementById('connect-btn')?.click();
    });
  });

  // Live discovery: stream newly-created #bounty issues from the firehose
  // (covers relay-indexed repos network-wide).
  startFirehose();

  // For the logged-in user (likely on a tangled-hosted PDS the relay can't
  // see), poll their own issues so a bounty they just created shows up without
  // a manual refresh.
  if (isLoggedIn()) startUserBountyPolling();
}

let _pollTimer = null;

// Reconcile the logged-in user's own bounties with their PDS: add open ones,
// and remove any of theirs that are now closed or deleted. Returns open count.
async function syncUserBounties() {
  if (!isLoggedIn()) return 0;
  const session = getSession();
  try {
    const mine = await fetchUserBounties(session.handle);
    const freshUris = new Set(mine.map(b => b.issueUri));
    const prefix = `at://${session.did}/`;
    let changed = false;

    // Drop the user's own bounties that no longer appear as open.
    for (const b of getBounties()) {
      if (b.issueUri?.startsWith(prefix) && !freshUris.has(b.issueUri)) {
        if (removeBountyByUri(b.issueUri)) changed = true;
      }
    }

    const before = getBounties().length;
    mine.forEach(addBounty);
    if (changed || getBounties().length !== before) applyFilters();
    return mine.length;
  } catch (e) {
    console.warn('User bounty sync failed:', e.message);
    return 0;
  }
}

function startUserBountyPolling() {
  if (_pollTimer) return;
  _pollTimer = setInterval(() => { syncUserBounties(); }, 20000);
  window.addEventListener('beforeunload', () => clearInterval(_pollTimer));
}

// ── Firehose live discovery ─────────────────────────────────────────────────

let _firehose = null;

function startFirehose() {
  if (_firehose) return;

  _firehose = connectFirehose(
    (bounty) => {
      // New #bounty issue seen on the network — cache it and refresh the feed.
      addBounty(bounty);
      applyFilters();
      setLive('live', 'Live');
    },
    {
      onStatus: (s) => {
        if (s === 'connected') setLive('live', 'Live');
      },
      onClose: (issueUri) => {
        // Issue was closed on the network — drop it from the feed.
        if (removeBountyByUri(issueUri)) applyFilters();
      },
    },
  );

  window.addEventListener('beforeunload', () => _firehose?.disconnect());
}

init();
