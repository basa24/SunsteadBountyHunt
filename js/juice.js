// ── Visual juice ────────────────────────────────────────────────────────────
// Opt-in delight effects wired from the page modules. Everything here is
// purely cosmetic and degrades gracefully (and respects reduced-motion).

const reduced = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

// Count an integer up to its target, easing out. Preserves prefix/suffix.
export function countUp(el, to, { duration = 900, prefix = '', suffix = '' } = {}) {
  if (!el) return;
  to = Number(to) || 0;
  if (reduced() || to <= 0) { el.textContent = `${prefix}${to}${suffix}`; return; }
  const start = performance.now();
  function frame(now) {
    const t = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - t, 3); // easeOutCubic
    el.textContent = `${prefix}${Math.round(to * eased)}${suffix}`;
    if (t < 1) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

// Animate every [data-countup] under `root` once (idempotent).
export function runCountUps(root = document) {
  root.querySelectorAll?.('[data-countup]').forEach((el) => {
    if (el.dataset.countupDone) return;
    el.dataset.countupDone = '1';
    countUp(el, el.dataset.countup);
  });
}

// Spray gold coins outward from the center of a container (the payoff moment).
export function coinBurst(container, count = 16) {
  if (!container || reduced()) return;
  const layer = document.createElement('div');
  layer.className = 'coin-burst';
  for (let i = 0; i < count; i++) {
    const c = document.createElement('span');
    c.className = 'coin-particle';
    const angle = (Math.PI * 2 * i) / count + (Math.random() - 0.5) * 0.6;
    const dist = 70 + Math.random() * 110;
    c.style.setProperty('--dx', `${Math.cos(angle) * dist}px`);
    c.style.setProperty('--dy', `${Math.sin(angle) * dist - 30}px`);
    c.style.setProperty('--rot', `${Math.random() * 720 - 360}deg`);
    c.style.animationDelay = `${Math.floor(Math.random() * 90)}ms`;
    layer.appendChild(c);
  }
  container.appendChild(layer);
  setTimeout(() => layer.remove(), 1500);
}

// One-shot coin burst per bounty per session (so revisiting a won bounty page
// doesn't re-fire it every load).
export function coinBurstOnce(container, key) {
  try {
    if (sessionStorage.getItem(`burst_${key}`)) return;
    sessionStorage.setItem(`burst_${key}`, '1');
  } catch { /* sessionStorage unavailable — just burst */ }
  coinBurst(container);
}

// Soft cursor spotlight that follows the pointer across bounty cards. Delegated
// once on the document so it also covers feed cards rendered after load.
export function initCardSpotlight() {
  if (reduced() || window.__spotlightInit) return;
  window.__spotlightInit = true;
  document.addEventListener('pointermove', (e) => {
    const card = e.target.closest?.('.card-hover');
    if (!card) return;
    const r = card.getBoundingClientRect();
    card.style.setProperty('--mx', `${e.clientX - r.left}px`);
    card.style.setProperty('--my', `${e.clientY - r.top}px`);
  }, { passive: true });
}
