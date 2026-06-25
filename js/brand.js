// Knotch wordmark behavior — the bullseye "O" with a nocked arrow.
//
// CSS handles the resting float and the draw-back/fire transition. The one
// thing CSS can't do is fire a one-shot animation when the *hover ends* (the
// moment the arrow lands), so we add a short-lived `.shot` class on mouseleave
// to trigger the board's impact shake, timed to coincide with the arrow's
// arrival. Purely cosmetic — safe to no-op if the mark isn't on the page.

function wireKnotch() {
  // Hover happens on the link/heading that wraps the mark, matching the
  // `.nav-logo:hover` / `.start-title:hover` selectors in CSS.
  const triggers = document.querySelectorAll('.nav-logo, .start-title');

  triggers.forEach((trigger) => {
    const board = trigger.querySelector('.knot-glyph');
    if (!board) return;

    trigger.addEventListener('mouseleave', () => {
      // Restart the animation even if it's still running from a quick re-hover.
      board.classList.remove('shot');
      void board.offsetWidth; // force reflow so the animation re-triggers
      board.classList.add('shot');
    });

    board.addEventListener('animationend', (e) => {
      if (e.animationName === 'boardImpact') board.classList.remove('shot');
    });
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', wireKnotch);
} else {
  wireKnotch();
}
