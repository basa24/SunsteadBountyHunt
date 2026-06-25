import './brand.js';
import { parseIssue, parseIssueWithAPI } from './ai-parser.js';
import { fetchIssueByUrl } from './fetcher.js';
import { addBounty, getUserHandle } from './storage.js';
import { isLoggedIn, publishBountyRecord } from './pds.js';
import { DIFFICULTY_LABELS, DIFFICULTY_DESCRIPTIONS } from './data.js';

// ── Tab switching ─────────────────────────────────────────────────────────

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(btn.dataset.tab).classList.add('active');
  });
});

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

function computeAuthorityWeight(stars) {
  return +Math.min(Math.log10(Math.max(stars || 1, 1)) / 4, 1).toFixed(2);
}

// ── Result panel rendering ────────────────────────────────────────────────

async function showResults(parsed, issueData = {}) {
  const panel = document.getElementById('result-panel');
  const { keywords = [], topKeywords = [], difficulty = 1, summary = '' } = parsed;

  // Build keyword HTML (will animate in)
  const kwItems = [
    ...(topKeywords.map(k => `<span class="kw top kw-animate" data-kw>${k}</span>`)),
    ...(keywords.filter(k => !topKeywords.includes(k)).map(k => `<span class="kw kw-animate" data-kw>${k}</span>`)),
  ].join('');

  // Difficulty dots
  const dots = Array.from({ length: 5 }, (_, i) =>
    `<div class="diff-dot ${i < difficulty ? `active-${difficulty}` : ''}"></div>`
  ).join('');

  const auth = computeAuthorityWeight(issueData.stars);
  const pts  = Math.round(difficulty * 20 * (auth || 0.5));

  panel.innerHTML = `
    <div class="parse-result">
      <div>
        <div class="parse-section-title">Extracted Keywords</div>
        <div class="bounty-tags" id="kw-container">${kwItems}</div>
        <div class="text-xs text-muted mt-2">Top 3 (highlighted) · ${keywords.length} total</div>
      </div>

      <div>
        <div class="parse-section-title">Difficulty</div>
        <div class="flex items-center gap-3 mt-1">
          <div class="diff-meter">${dots}</div>
          <span class="diff-badge ${diffClass(difficulty)}">${difficulty} · ${DIFFICULTY_LABELS[difficulty]}</span>
        </div>
        <div class="text-xs text-muted mt-1">${DIFFICULTY_DESCRIPTIONS[difficulty]}</div>
      </div>

      <div>
        <div class="parse-section-title">Summary</div>
        <p class="text-sm text-secondary">${escHtml(summary)}</p>
      </div>

      <div class="flex items-center justify-between flex-wrap gap-2">
        <div>
          <div class="parse-section-title">Estimated Value</div>
          <div class="flex items-center gap-2 mt-1">
            <span class="points-badge" style="font-size:1rem">+${pts} pts</span>
            <span class="text-xs text-muted">difficulty ${difficulty} × 20 × authority ${auth}</span>
          </div>
        </div>
        <button class="btn btn-primary" id="publish-btn">
          Add to Feed →
        </button>
      </div>
    </div>
  `;

  panel.classList.remove('hidden');

  // Animate keywords in one by one
  const kwEls = panel.querySelectorAll('[data-kw]');
  kwEls.forEach((el, i) => {
    setTimeout(() => el.classList.add('visible'), i * 80);
  });

  // Publish button
  const bountyData = {
    id: `user-${Date.now()}`,
    issueTitle:  issueData.title  || document.getElementById('manual-title')?.value || 'Custom Bounty',
    issueBody:   issueData.body   || document.getElementById('manual-body')?.value  || '',
    issueUri:    issueData.uri    || `at://did:plc:user/sh.tangled.repo.issue/${Date.now()}`,
    issueUrl:    issueData.url    || '#',
    repo: {
      name:            issueData.repo   || 'custom',
      handle:          issueData.handle || 'user.tngl.sh',
      ownerDid:        issueData.ownerDid || 'did:plc:unknown',
      stars:           issueData.stars   || 0,
      language:        parsed.topKeywords?.[0] || 'unknown',
      authorityWeight: auth,
    },
    ...parsed,
    status:    'open',
    createdAt: new Date().toISOString(),
    fetchedAt: new Date().toISOString(),
  };

  document.getElementById('publish-btn').addEventListener('click', async () => {
    const btn = document.getElementById('publish-btn');

    // Always cache locally for instant feed display.
    addBounty(bountyData);

    // If logged in, also write a real sh.tangled.bounty.post to the user's PDS.
    if (isLoggedIn()) {
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span> Publishing…';
      try {
        const { uri } = await publishBountyRecord(bountyData);
        bountyData.uri = uri;
        addBounty(bountyData); // upsert with the real record URI
      } catch (e) {
        // Non-fatal: the bounty is already in the local feed.
        console.warn('PDS write failed, kept local copy:', e.message);
      }
    }

    window.location.href = 'index.html';
  });
}

// ── URL mode ──────────────────────────────────────────────────────────────

document.getElementById('fetch-btn')?.addEventListener('click', async () => {
  const url = document.getElementById('issue-url').value.trim();
  if (!url) return;

  const btn = document.getElementById('fetch-btn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Fetching…';

  const err = document.getElementById('url-error');
  err.classList.add('hidden');

  try {
    const issue = await fetchIssueByUrl(url);
    btn.disabled = false;
    btn.textContent = 'Fetch Issue';

    // Pre-fill the result display
    const preview = document.getElementById('issue-preview');
    preview.innerHTML = `
      <div class="card" style="margin-bottom:1rem">
        <div class="card-body">
          <div class="font-bold mb-1">${escHtml(issue.issueTitle)}</div>
          <div class="text-xs text-muted mb-2">${escHtml(url)}</div>
          <div class="issue-body text-sm">${escHtml(issue.issueBody.slice(0, 300))}${issue.issueBody.length > 300 ? '…' : ''}</div>
        </div>
      </div>
    `;
    preview.classList.remove('hidden');

    const apiKey = document.getElementById('api-key')?.value?.trim();
    let parsed;
    if (apiKey) {
      try {
        parsed = await parseIssueWithAPI(issue.issueTitle, issue.issueBody, apiKey);
      } catch {
        parsed = parseIssue(issue.issueTitle, issue.issueBody);
      }
    } else {
      parsed = parseIssue(issue.issueTitle, issue.issueBody);
    }

    await showResults(parsed, {
      title:    issue.issueTitle,
      body:     issue.issueBody,
      uri:      issue.issueUri,
      url:      issue.issueUrl,
      repo:     issue.repo?.name,
      handle:   issue.repo?.handle,
      ownerDid: issue.repo?.ownerDid,
      stars:    issue.repo?.stars,
    });

  } catch (e) {
    btn.disabled = false;
    btn.textContent = 'Fetch Issue';
    err.textContent = `Error: ${e.message}`;
    err.classList.remove('hidden');
  }
});

// ── Manual mode ───────────────────────────────────────────────────────────

document.getElementById('parse-btn')?.addEventListener('click', async () => {
  const title = document.getElementById('manual-title')?.value?.trim();
  const body  = document.getElementById('manual-body')?.value?.trim();

  if (!title && !body) {
    alert('Please enter an issue title or body.');
    return;
  }

  const btn = document.getElementById('parse-btn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Parsing…';

  const apiKey = document.getElementById('api-key-manual')?.value?.trim();
  let parsed;
  try {
    if (apiKey) {
      try {
        parsed = await parseIssueWithAPI(title || '', body || '', apiKey);
      } catch {
        parsed = parseIssue(title || '', body || '');
      }
    } else {
      parsed = parseIssue(title || '', body || '');
    }
  } finally {
    btn.disabled = false;
    btn.textContent = 'Parse Bounty';
  }

  await showResults(parsed);
});

// ── Pre-fill example on load ──────────────────────────────────────────────

const EXAMPLE_TITLE = 'Fix memory leak in Redis connection pool';
const EXAMPLE_BODY  = `Our Redis connection pool grows unbounded under high traffic. After running for 48 hours, the service OOMs and needs a restart.

Profiling shows connections are not returned to the pool after pipeline operations. The issue is in the retry logic — on error, it creates a new connection but never closes the failed one.

\`\`\`go
func (p *Pool) retryPipeline(ctx context.Context, cmds []Cmd) error {
    conn, err := p.Get(ctx)  // never released on error path below
    if err != nil { return err }
    if err := conn.ExecPipeline(cmds); err != nil {
        conn2, _ := p.Get(ctx)  // gets a second conn instead of reusing
        return conn2.ExecPipeline(cmds)
    }
    return nil
}
\`\`\`

Expected: stable connection count. Actual: grows by ~50 connections/hour.

#bounty`;

// Modules are deferred — DOM is already ready here
const titleEl = document.getElementById('manual-title');
const bodyEl  = document.getElementById('manual-body');
if (titleEl && !titleEl.value) titleEl.value = EXAMPLE_TITLE;
if (bodyEl  && !bodyEl.value)  bodyEl.value  = EXAMPLE_BODY;
