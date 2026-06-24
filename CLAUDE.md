# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev      # Vite dev server on localhost:5173 (required for XRPC proxy)
npm run build    # Production build → dist/
npm run preview  # Preview the production build
```

There are no tests or linters configured.

**Always run via `npm run dev`** — the Vite dev server proxies `/xrpc/*` to `https://tangled.org` and `/plc/*` to `https://plc.directory` to bypass CORS. Serving the HTML files directly (without the proxy) will fail on live data fetches.

## Architecture

Multi-page Vite app (no framework). Four entry points: `index.html`, `create.html`, `bounty.html`, `profile.html`, each with a dedicated JS module in `js/`.

**Data flow:**
```
tangled.org XRPC → fetcher.js → ai-parser.js → ranking.js → page JS → DOM
                        ↕                                       ↕
                   storage.js (localStorage cache)        storage.js (simulated PDS)
```

**Layer split:**
- `js/fetcher.js` — all XRPC calls to tangled.org and plc.directory. Resolves handles→DIDs, paginates `listRecords`, falls back to mock data on failure.
- `js/ai-parser.js` — rule-based keyword/difficulty extractor that works offline. Optionally uses the Claude API when `window.CLAUDE_API_KEY` is set.
- `js/ranking.js` — scores bounties per user: `0.4×socialProximity + 0.4×skillMatch + 0.1×freshness + 0.1×difficultyFit`. Falls back to freshness+popularity for unauthenticated users.
- `js/signer.js` — demo cryptographic signing of award records using `crypto.subtle` (ECDSA-P256). Key pair lives in `sessionStorage`.
- `js/storage.js` — all localStorage reads/writes. Keys are prefixed `bh_`. Manages the 5-minute XRPC cache TTL and the simulated PDS state (bounties, profile, awards).
- `js/data.js` — seed repo list (`SEED_REPOS`) for the startup fetch loop, and `MOCK_BOUNTIES`/`DEMO_USERS` fallback data.

## Key Distinctions

**What is real vs. simulated:**
- Live XRPC fetches from tangled.org repos — **real**
- Bounty award records and profile state — **simulated in localStorage** (production would write to the user's AT Protocol PDS via OAuth)
- Cryptographic signatures — **demo** (ephemeral session key, not the repo owner's actual DID key)

**AT Protocol collections used:**
- `sh.tangled.repo.issue` — source issues fetched for `#bounty` detection
- `sh.tangled.bounty.post` / `.award` / `.profile` — schemas defined in `IMPLEMENTATION.md`, currently stored only in localStorage

## Adding Seed Repos

Add entries to `SEED_REPOS` in `js/data.js`. The `did` field can be `null` — it is resolved at runtime via `resolveHandle`. Each repo is fetched once per 5-minute cache window.

## Claude API Mode

`js/ai-parser.js` exports both `parseIssue` (local, always available) and `parseIssueWithAPI` (calls `claude-haiku-4-5-20251001`). The create page (`js/create.js`) should check for `window.CLAUDE_API_KEY` and prefer the API mode when present. The API key is never stored — it must be set before page load.
