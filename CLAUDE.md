# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev      # Vite dev server on localhost:5173 (required for the XRPC + tnglweb proxies)
npm run build    # Production build → dist/
npm run preview  # Preview the production build
```

There are no tests or linters configured.

**Always run via `npm run dev`.** The Vite server proxies three paths to bypass CORS:
- `/xrpc/*` → `https://tangled.org` (AT Protocol XRPC)
- `/plc/*`  → `https://plc.directory` (DID document resolution)
- `/tnglweb/*` → `https://tangled.org` (scraping the server-rendered issue/PR pages — the only place issue open/closed state and PR lists live; no JSON API)

The `/tnglweb` proxy is dev-only. Features that depend on it (closed-issue detection, PR status reconciliation in `pulls.js`) silently no-op in a static production build.

## Architecture

Multi-page Vite app, no framework. Four entry points → one JS module each:
- `index.html` → `js/app.js` (feed, sign-in, firehose-driven live discovery)
- `create.html` → `js/create.js` (parse an issue, publish a bounty post)
- `bounty.html` → `js/bounty.js` (bounty detail + submission/award flow)
- `profile.html` → `js/profile.js` (profile + awards + leaderboard view)

**Data flow:**
```
tangled XRPC ──┐
Jetstream WS ──┼──► fetcher.js / firehose.js ──► ai-parser.js ──► ranking.js ──► page JS ──► DOM
PDS (authed) ──┘                  │                                                 │
                                  ▼                                                 ▼
                            storage.js  (5-min XRPC cache + local mirror of PDS reads/writes)
```

**Layer split:**
- `js/fetcher.js` — read path. All XRPC calls (handle→DID resolution, paginated `listRecords`, repo metadata, profile aggregation). Also scrapes the dev-only `/tnglweb` proxy for issue close-state and PR pages.
- `js/firehose.js` — live read path. WebSocket subscription to Bluesky Jetstream filtered to `sh.tangled.repo.issue` / `.issue.state` / `sh.tangled.bounty.submission` / `sh.tangled.bounty.award`; emits new `#bounty` issues, close events, new hunt submissions, and award records network-wide. Submission events are also added directly to the local pool in `storage.js`. Exponential-backoff reconnect across multiple Jetstream hosts.
- `js/auth.js` — real AT Protocol sessions via **app passwords** (`com.atproto.server.createSession`), with `accessJwt`/`refreshJwt` persistence in `localStorage` and a 401-retry `authedFetch` wrapper. App-password login resolves the user's PDS via PLC so writes go to whichever host they're on.
- `js/pds.js` — authenticated write path. Uses `authedFetch` to call `com.atproto.repo.createRecord` / `uploadBlob`. Writes real `sh.tangled.bounty.post`, `sh.tangled.bounty.award`, and `sh.tangled.repo.pull` records to the logged-in user's repo (PR patches are gzipped before blob upload).
- `js/pulls.js` — bounty submission lifecycle. Because app passwords can't merge tangled PRs, the hunter opens the PR themselves on tangled and we **observe** it: each submission mints an unguessable `HuntRequest#<hex>` token the hunter must put in their PR title, and `reconcileSubmissions()` scrapes the repo's pulls pages via `/tnglweb` to find the matching merged/closed PR. Merged + author-match → sign + write award.
- `js/signer.js` — ECDSA-P256 award signatures via `crypto.subtle`. The signed message covers `(bountyUri, pullRequestUri, hunterDid, awardedAt)`. Key pair lives in `sessionStorage` (ephemeral demo key, **not** the user's real DID key — production would sign with the PDS key).
- `js/ai-parser.js` — rule-based keyword/difficulty extractor that runs locally. Optionally calls the Claude API (`claude-haiku-4-5-20251001`) when `window.CLAUDE_API_KEY` is set before page load — the key is never persisted.
- `js/ranking.js` — per-user scoring: `0.4×socialProximity + 0.4×skillMatch + 0.1×freshness + 0.1×difficultyFit`. Falls back to freshness+popularity for unauthenticated users.
- `js/storage.js` — all `localStorage` access, keys prefixed `bh_`. Manages the 5-minute XRPC cache TTL and a local mirror of PDS state (bounties, profile, awards, submissions, discovered owners, leaderboard) so the UI works offline and survives reloads. Seeds with `MOCK_BOUNTIES` on first load.
- `js/data.js` — `SEED_REPOS` (the startup fetch loop), `MOCK_BOUNTIES`, `DEMO_USERS`, and shared constants like `DIFFICULTY_LABELS`.
- `js/juice.js`, `js/navchip.js` — cosmetic effects (count-ups, coin burst, cursor spotlight; reduced-motion aware) and the top-right account chip rendered on sub-pages.

**Follow-up not yet implemented:** real per-PR quality scoring. The submissions list currently displays a placeholder score derived from a stable hash of the submission token (see `mockScore` in `js/bounty.js`), biased by observed status so awarded/declined rows look intuitively right. Replacing this with deterministic signals (patch size, tests touched, commit-message style) and/or an LLM-backed rubric is the next step — the firehose-fed submissions pool gives that work the data it needs.

## Real vs. simulated

- Live XRPC reads from tangled.org repos and Jetstream firehose — **real**.
- App-password login and PDS writes (`sh.tangled.bounty.post`, `.bounty.award`, `sh.tangled.repo.pull`) — **real**, but written to overlay collections that only this app currently consumes (until/unless tangled's appview adopts them).
- Award signatures — **demo** key pair from `crypto.subtle` in `sessionStorage`, not the user's DID key.
- LocalStorage state — **local mirror** of PDS reads + cache. Authoritative for the UI but not the source of truth.

## AT Protocol collections

- `sh.tangled.repo.issue` / `.issue.state` — source issues (fetched + firehose); `#bounty` tag in body promotes to a bounty.
- `sh.tangled.repo.pull` — real PR patches written to the hunter's PDS by `submitPullRecord` (target repo DID, gzipped `format-patch` blob in `rounds`). Read by `js/patch-fetch.js` to retrieve a hunter's diff for scoring.
- `sh.tangled.bounty.post` / `.award` / `.submission` — overlay collections defined in `IMPLEMENTATION.md` and written by `pds.js`. The submission record is created when a hunter accepts a bounty (`startSubmission` in `js/pulls.js`) so other viewers can see who's on the hunt; it's `putRecord`-updated on resolve.

## Adding seed repos

Add entries to `SEED_REPOS` in `js/data.js`. The `did` field can be `null` — it is resolved at runtime via `resolveHandle`. Each repo is fetched once per 5-minute cache window.

## Claude API mode

`js/ai-parser.js` exports both `parseIssue` (local, always available) and `parseIssueWithAPI` (calls `claude-haiku-4-5-20251001`). The create page (`js/create.js`) checks for `window.CLAUDE_API_KEY` and prefers the API mode when present. The API key is never stored — it must be set before page load.
