// Renders the top-right account preview (profile chip + goldKnots balance)
// into #nav-user on the secondary pages (bounty, profile). The chip is the
// way to reach the profile — there is no separate "Profile" nav button.
//
// The feed page (index) renders its own richer version in app.js because it
// also owns the sign-in banner; this is the lightweight, read-only variant.
import { getUserHandle, getUserProfile, clearUserHandle } from './storage.js';
import { logout } from './auth.js';
import { runCountUps } from './juice.js';

function avatar(handle) {
  return `https://api.dicebear.com/7.x/identicon/svg?seed=${encodeURIComponent(handle || 'anon')}&size=24`;
}

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function renderNavChip() {
  const el = document.getElementById('nav-user');
  if (!el) return;

  const handle = getUserHandle();
  if (!handle) {
    el.innerHTML = `<a class="btn btn-primary btn-sm" href="index.html">Sign in</a>`;
    return;
  }

  const gk = getUserProfile()?.bountyProfile?.totalPoints || 0;
  el.innerHTML = `
    <span class="gk-balance" title="Your Gold Knots balance">🪙 <span class="gk-num" data-countup="${gk}">0</span></span>
    <div class="account-chip">
      <a class="account-chip-link" href="profile.html" title="View your profile">
        <img class="avatar avatar-sm" src="${avatar(handle)}" alt="" />
        <span class="handle">${esc(handle)}</span>
      </a>
      <button class="btn btn-ghost btn-sm" id="navchip-logout" title="Log out">✕</button>
    </div>
  `;

  runCountUps(el);
  document.getElementById('navchip-logout')?.addEventListener('click', () => {
    logout();
    clearUserHandle();
    location.href = 'index.html';
  });
}
