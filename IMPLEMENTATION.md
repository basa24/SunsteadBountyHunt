# Tangled Bounty Hunt — Implementation Guide

## Overview

Build a **standalone production-ready web app** that reads live data from tangled.org via public AT Protocol XRPC APIs and layers a bounty system on top. This is not a visual clone or a mock-data demo — it fetches real issues from real tangled.org repos, parses them with the AI parser, and displays a personalized ranked bounty feed. Award recording is simulated in localStorage (real PDS writes require user OAuth, which is post-hackathon scope), but the data model and cryptographic verification scheme are production-correct.

The full loop: **fetch live issues → detect #bounty → AI parse → ranked feed → PR simulation → verifiable award → profile CV**.

Read `PHILOSOPHY.md` first for the vision and design principles.

---

## Architecture

```
┌────────────────────────────────────────────────────────────────┐
│               TANGLED.ORG (Live AT Protocol Network)           │
│                                                                │
│  PDS instances holding sh.tangled.repo.issue records           │
│  Tangled AppView (Bobbin) — aggregates & exposes XRPC APIs     │
└────────────────────────────────────────────────────────────────┘
         │
         │  Real XRPC fetch (com.atproto.repo.listRecords)
         │  CORS handled via Vite proxy → /xrpc/* → tangled.org
         ▼
┌────────────────────────────────────────────────────────────────┐
│              OUR STANDALONE WEB APP (Vite + Vanilla JS)        │
│                                                                │
│  js/fetcher.js ─── XRPC client + CORS proxy + cache layer      │
│  js/ai-parser.js ─ Rule-based keyword/difficulty extractor     │
│  js/ranking.js ─── Proximity + skill ranking algorithm         │
│  js/signer.js ──── Web Crypto demo signing + verification      │
│  js/storage.js ─── localStorage: cache + simulated PDS state   │
│  js/data.js ────── Seed repos list + fallback mock data        │
│                                                                │
│  index.html ──── Personalized bounty feed (live ranked)        │
│  create.html ─── Submit a tangled.org issue URL → parse it     │
│  bounty.html ─── Detail view + PR merge simulation             │
│  profile.html ─── Hunter CV: awards, skills, verification UI   │
└────────────────────────────────────────────────────────────────┘
         │
         │  Simulated in localStorage (real write = post-hackathon
         │  AT Protocol OAuth integration)
         ▼
┌────────────────────────────────────────────────────────────────┐
│           SIMULATED PDS LAYER (localStorage)                   │
│                                                                │
│  sh.tangled.bounty.post ─ Parsed bounty listings               │
│  sh.tangled.bounty.award ─ Demo-signed award records           │
│  sh.tangled.bounty.profile ─ Aggregated hunter profile         │
└────────────────────────────────────────────────────────────────┘
```

**What's real vs simulated:**
| Layer | Status |
|---|---|
| Fetching issues from tangled.org repos | **Real** (XRPC) |
| Resolving handles → DIDs | **Real** (XRPC) |
| Fetching user social graph (follows, stars) | **Real** (XRPC, public) |
| AI parsing of issue text | **Real** (rule-based, optional Claude API) |
| Ranking algorithm | **Real** (runs on live fetched data) |
| Bounty award records | **Simulated** (localStorage, correct schema) |
| Cryptographic signatures on awards | **Demo** (ephemeral Web Crypto key, real `crypto.subtle.sign/verify`) |
| Writing award to user's PDS | **Not yet** (requires AT Protocol OAuth) |


---

## Project Structure

```
Sunstead/
├── PHILOSOPHY.md           # Vision and design principles
├── IMPLEMENTATION.md       # This file
├── NOTES.md                # Technical notes and references
├── index.html              # Main page — live bounty feed
├── create.html             # Submit a tangled.org issue URL → parse it
├── bounty.html             # Bounty detail + PR simulation
├── profile.html            # Hunter profile / Unofficial CV
├── css/
│   └── style.css           # Full design system
├── js/
│   ├── app.js              # Feed page logic: fetch → rank → render
│   ├── create.js           # Issue URL input + parsing UI
│   ├── bounty.js           # Detail page logic + PR simulation
│   ├── profile.js          # Profile rendering + verification UI
│   ├── fetcher.js          # XRPC client: fetch issues, resolve DIDs/handles
│   ├── ai-parser.js        # Rule-based parser (+ optional Claude API mode)
│   ├── ranking.js          # Proximity + skill ranking algorithm
│   ├── signer.js           # Web Crypto: demo signing + award verification
│   ├── storage.js          # localStorage: XRPC cache + simulated PDS state
│   └── data.js             # Seed repo list + fallback mock data
├── server/
│   ├── proxy.js            # CORS proxy for XRPC calls (Express)
│   └── parser.js           # Claude API proxy for AI parsing
├── package.json
└── vite.config.js          # Multi-page config + /xrpc CORS proxy
```

---

## Data Model

### Bounty Record

```js
// Mirrors AT Protocol lexicon: sh.tangled.bounty.post
{
  id: "bounty-001",
  uri: "at://did:plc:bot/sh.tangled.bounty.post/abc123",  // AT Protocol URI

  // Source issue — fetched live from tangled.org XRPC
  issueTitle: "Fix memory leak in WebSocket handler",
  issueBody: "After 1000+ concurrent connections, the server...",
  issueUri: "at://did:plc:owner/sh.tangled.repo.issue/issue456",
  issueCid: "bafyreib...",  // Content-addressed CID from XRPC response
  issueUrl: "https://tangled.org/netcore/issue/42",  // Deep link back to tangled

  // Repo context — fetched from XRPC, cached in localStorage
  repo: {
    name: "netcore",
    owner: "systems_dev.tngl.sh",    // AT Protocol handle
    ownerDid: "did:plc:abc123",
    ownerAvatar: "https://avatar.tangled.sh/...",
    stars: 142,
    language: "rust",
    authorityWeight: 0.82  // Pre-computed: log(stars) + age + contributors
  },

  // AI-generated fields (from ai-parser.js)
  keywords: [
    "rust", "networking", "websocket", "async", "memory-leak",
    "performance", "tokio", "server", "concurrency", "tcp"
  ],
  topKeywords: ["rust", "websocket", "async"],
  difficulty: 4,
  summary: "Fix a memory leak in the WebSocket connection handler under high concurrency.",

  // Status
  status: "open",       // open | completed
  createdAt: "2026-06-24T10:00:00Z",
  completedAt: null,
  completedBy: null,    // hunter DID

  // Cache metadata
  fetchedAt: "2026-06-24T10:05:00Z"
}
```

### User Profile

```js
// Mirrors AT Protocol lexicon: sh.tangled.bounty.profile
// Populated by: resolving handle via XRPC + reading public social graph
{
  did: "did:plc:hunter123",          // Resolved via com.atproto.identity.resolveHandle
  handle: "janehunter.tngl.sh",      // User-entered handle (real tangled.org handle)
  displayName: "Jane Hunter",
  avatar: "https://avatar.tangled.sh/...",
  pdsEndpoint: "https://tangled.org", // Resolved from DID document

  // Fetched live from user's PDS (public, no auth needed)
  following: ["did:plc:owner1", "did:plc:owner2"],
  starredRepos: ["at://did:plc:owner1/sh.tangled.repo/netcore"],

  // Stored in localStorage (our simulated PDS layer)
  bountyProfile: {
    totalCompleted: 47,
    skillBreakdown: { "rust": 12, "typescript": 28, "go": 7 },
    avgDifficulty: 3.2,
    completionStreak: 5,
    totalPoints: 3840,      // Weighted: difficulty × 20 × authorityWeight per award
    public: true,
    lastUpdated: "2026-06-24T12:00:00Z"
  },

  // Award records in localStorage, each cryptographically signed
  awards: [
    {
      bountyId: "bounty-001",
      bountyTitle: "Fix memory leak in WebSocket handler",
      bountyUri: "at://did:plc:bot/sh.tangled.bounty.post/abc",
      pullRequestUri: "at://did:plc:owner1/sh.tangled.repo.pull/xyz",
      repo: "netcore",
      repoUrl: "https://tangled.org/systems_dev/netcore",
      skills: ["rust", "websocket", "async"],
      difficulty: 4,
      authorityWeight: 0.82,
      points: 65,             // difficulty × 20 × authorityWeight
      awardedAt: "2026-06-24T12:00:00Z",
      awardedBy: "did:plc:owner1",
      signature: "<base64>",  // crypto.subtle.sign output (demo key)
      publicKey: "<base64>",  // Matching public key for verification UI
      verified: true          // Set by signer.js after crypto.subtle.verify()
    }
  ]
}
```

### Social Graph (for proximity ranking)

```js
{
  // Who the current user follows
  follows: ["did:plc:owner1", "did:plc:owner2", "did:plc:owner3"],
  
  // Repos the current user has starred
  starredRepos: ["netcore", "webapp", "toolkit"],
  
  // Mutual follows (people who follow the user back)
  mutuals: ["did:plc:owner1"],
  
  // Communities/organizations the user belongs to
  communities: ["rustlang", "async-wg"]
}
```

---

## XRPC Fetcher Specification (`js/fetcher.js`)

The fetcher handles all communication with tangled.org's AT Protocol endpoints.

```js
// Resolve a tangled handle → DID
async function resolveHandle(handle)
// → { did: "did:plc:..." }
// GET /xrpc/com.atproto.identity.resolveHandle?handle={handle}

// Get a user's PDS endpoint from their DID document
async function getPdsEndpoint(did)
// → "https://tangled.org" (or external PDS URL)
// GET https://plc.directory/{did}

// Fetch all issues for a repo owner that contain #bounty
async function fetchBountyIssues(ownerDid, pdsEndpoint)
// → Array of raw XRPC record objects
// GET {pds}/xrpc/com.atproto.repo.listRecords?repo={did}&collection=sh.tangled.repo.issue

// Fetch a single issue by AT URI
async function fetchIssue(issueUri)
// → Single record value

// Fetch the public social graph for a user (who they follow)
async function fetchFollows(did, pdsEndpoint)
// → Array of { subject: { did, handle } }

// Fetch repos starred by a user
async function fetchStarredRepos(did, pdsEndpoint)
// → Array of AT URIs for starred repos

// Compute repo authority weight from live data
async function computeAuthorityWeight(repoHandle, repoDid, pdsEndpoint)
// Fetches star count, contributor list, repo age → returns 0.0–1.0 weight
```

**Caching:** Every successful fetch is cached in localStorage with `fetchedAt`. Cache TTL is 5 minutes. Stale entries trigger a background re-fetch without blocking the UI.

**Error handling:** Network errors or CORS failures fall through to `data.js` fallback mock records for that repo. The UI shows a subtle "Live data unavailable — showing cached/demo data" notice.

**Vite proxy config** (`vite.config.js`):
```js
server: {
  proxy: {
    '/xrpc': { target: 'https://tangled.org', changeOrigin: true },
    '/plc':  { target: 'https://plc.directory', changeOrigin: true, rewrite: p => p.replace(/^\/plc/, '') }
  }
}
```

---

## Cryptographic Signing Specification (`js/signer.js`)

Demonstrates the production-ready award verification model using browser-native Web Crypto API.

```js
// Generate a demo key pair (called once per session, stored in sessionStorage)
async function generateDemoKeyPair()
// → { publicKey: CryptoKey, privateKey: CryptoKey, publicKeyB64: string }

// Sign an award record (simulates repo owner signing with their DID private key)
async function signAward(awardRecord, privateKey)
// Canonical message = JSON.stringify({ bounty, pullRequest, hunterDid, awardedAt })
// → base64-encoded ECDSA-P256 signature

// Verify an award's signature
async function verifyAward(awardRecord)
// Imports the stored publicKeyB64, runs crypto.subtle.verify()
// → { valid: boolean, message: string }
```

**Why ECDSA-P256:** This is the same curve used by AT Protocol's secp256k1 (we use P-256 in the demo because it's supported by `crypto.subtle` in all browsers without extra libraries; production would use secp256k1 via the `@noble/curves` library).

**What gets signed:** `bountyUri + pullRequestUri + hunterDid + awardedAt` — the four fields that cannot be changed post-award without invalidating the signature.

---

## AI Parser Specification

The parser takes raw issue text and produces a structured bounty. It has two modes:

### Mode 1: Local (Rule-Based)

Works offline, instant response. Good for demos.

**Algorithm:**
1. Tokenize the issue title + body
2. Remove stop words
3. Match against a programming keyword dictionary (languages, frameworks, concepts, tools)
4. Score by frequency × relevance weight
5. Return top 10 as `keywords`, top 3 as `topKeywords`
6. Estimate difficulty:
   - **1 (Trivial):** "typo", "docs", "readme", "comment", "rename"
   - **2 (Easy):** "add", "simple", "style", "css", "config", "ui tweak"
   - **3 (Medium):** "feature", "implement", "endpoint", "test", "refactor"
   - **4 (Hard):** "performance", "memory", "security", "architecture", "migration"
   - **5 (Expert):** "cryptography", "consensus", "compiler", "kernel", "protocol"

The keyword dictionary should include:
- Programming languages (rust, go, typescript, python, etc.)
- Frameworks/libraries (react, tokio, express, django, etc.)
- Domains (networking, database, auth, ui, api, etc.)
- Concepts (async, concurrency, caching, encryption, etc.)
- Tools (docker, git, ci/cd, kubernetes, etc.)

### Mode 2: API (Claude/LLM)

Optional. Calls an LLM for higher-quality extraction.

**Prompt template:**
```
You are a code issue analyzer for a bounty system. Given a GitHub-style issue, extract:

1. keywords: Exactly 10 technical keywords that describe the project and the problem. Include programming languages, frameworks, concepts, and tools mentioned or implied.
2. topKeywords: The 3 most relevant keywords from the list above.
3. difficulty: A difficulty rating from 1-5:
   - 1: Trivial (typos, docs, simple config)
   - 2: Easy (small UI changes, simple additions)
   - 3: Medium (new features, refactors, tests)
   - 4: Hard (performance, security, architecture)
   - 5: Expert (cryptography, protocols, compilers)

Issue Title: {title}
Issue Body: {body}

Respond in JSON only: { "keywords": [...], "topKeywords": [...], "difficulty": N }
```

---

## Ranking Algorithm

Bounties are ranked per-user for the feed. The score determines position (higher = shown first).

```
score = (0.4 × socialProximity) + (0.4 × skillMatch) + (0.1 × freshness) + (0.1 × difficultyFit)
```

### Social Proximity (0.0 - 1.0)
- User follows the bounty's repo owner: +0.4
- User has starred the bounty's repo: +0.3
- Repo owner is a mutual follow: +0.2
- Same community/organization: +0.1

### Skill Match (0.0 - 1.0)
- Count how many of the bounty's `topKeywords` appear in the user's `skillBreakdown`
- Score = matching skills / 3 (since there are 3 topKeywords)
- Bonus: if any of the bounty's `keywords` match skills, add 0.1 per match (capped at 0.3)

### Freshness (0.0 - 1.0)
- Score = max(0, 1 - (hoursSinceCreation / 168))
- Bounties older than 7 days get 0.0 freshness

### Difficulty Fit (0.0 - 1.0)
- Calculate user's `avgDifficulty` from their completed bounties
- Score = 1.0 - (abs(bountyDifficulty - userAvgDifficulty) / 4)
- New users with no history get 0.5 (neutral)

### Fallback (unauthenticated users)
When there's no user context:
```
score = (0.5 × freshness) + (0.3 × repoPopularity) + (0.2 × random)
```

---

## Page Specifications

### Main Page (index.html)

**Layout:**
- Navigation bar matching tangled.org (logo, login/signup)
- Hero section: "🎯 Bounty Hunt" heading with tagline
- Bounty feed: Top 10 cards in a vertical list
- Each card shows:
  - Bounty title (clickable → bounty detail)
  - Repo name + owner avatar + handle
  - Top 3 keywords as colored pills
  - Difficulty badge (color-coded)
  - "Why recommended" tag (e.g., "👥 You follow this owner", "🎯 Matches your skills")
  - Time ago
- Sidebar or filter bar: skill filter, difficulty filter, sort options

### Create Bounty Page (create.html)

Two input modes — user picks one:

**Mode A: Paste a Tangled Issue URL**
- Input: `https://tangled.org/{handle}/{repo}/issues/{number}`
- `fetcher.js` resolves the handle → DID → fetches the issue record via XRPC
- Issue title + body auto-populate below
- "Parse Bounty" button → runs parser on live-fetched text

**Mode B: Manual Entry (Fallback)**
- Text input for issue title + textarea for issue body
- Pre-fillable with an example for demo purposes
- `#bounty` tag toggle (always on)
- "Parse Bounty" button → runs parser on entered text

**Results panel (both modes):**
- Animated keyword extraction (keywords appear one by one with staggered CSS transitions)
- Top 3 highlighted with emphasis (emerald pill style)
- Difficulty gauge/badge with text description
- Generated summary
- Repo authority weight shown (if URL mode: real star count → weight)
- Estimated points value: `difficulty × 20 × authorityWeight`
- "Add to Feed" button → `storage.addBounty()`, redirect to `index.html`

### Bounty Detail Page (bounty.html)

**Layout:**
- Back link to feed
- Full bounty card:
  - Title (links to real issue on tangled.org via `issueUrl`)
  - Repo + owner (links to real tangled.org repo)
  - Full issue body (rendered markdown: newlines, code blocks, bold)
  - All 10 keywords (top 3 highlighted)
  - Difficulty badge + description text
  - Creation date, repo stars, authority weight, estimated points value
- "Submit PR" action button:
  - Click: → PR submission animation
  - Simulates: PR merged → `signer.js` generates demo key pair → signs award record → `storage.addAward()` + `storage.updateProfile()`
  - Shows: "Bounty awarded! Points: {N}" + link to profile
  - Shows: verification badge ("✓ Cryptographically signed") which opens the verification panel
- Verification Panel (inline):
  - Shows the raw `sh.tangled.bounty.award` JSON record
  - Shows the signature bytes (truncated hex)
  - "Verify Signature" button → runs `crypto.subtle.verify()` client-side → shows pass/fail
  - Explains the double-entry bookkeeping model
- Collapsible: AT Protocol Lexicon schemas for `bounty.post` and `bounty.award`

### Hunter Profile Page (profile.html)

**Layout:**
- User avatar (from tangled.org avatar service) + handle + display name + DID
- "View on Tangled" link → `https://tangled.org/{handle}`
- Stats row: Total Completed | Total Points | Avg Difficulty | Streak
- Skill breakdown: horizontal bar chart per skill (CSS width percentages, no canvas)
- "Public Profile" toggle → updates `bountyProfile.public` in localStorage
- Recent awards list — each award card shows:
  - Bounty title (links to bounty detail page)
  - Repo name + link to tangled.org
  - Skill pills, difficulty badge, points earned
  - Date awarded
  - **Verification badge:** "✓ Verified" or "⚠ Unverified" based on `award.verified`
  - "Verify" button → runs `crypto.subtle.verify()` inline, updates badge
- Authority weighting explainer: "Why does this award score less?" tooltip on low-weight repos
- Collapsible: Raw `sh.tangled.bounty.profile` and `sh.tangled.bounty.award` records (full JSON)
- Collapsible: Cryptographic verification explanation + link to AT Protocol labeler docs

---

## Visual Design System

Match tangled.org's visual language exactly:

### Colors
```css
--bg-primary: #111827;        /* gray-900 — page background */
--bg-card: #1f2937;           /* gray-800 — card background */
--bg-card-hover: #374151;     /* gray-700 — card hover */
--bg-accent: #111827;         /* gray-900/50 — subtle accent */
--border: #374151;            /* gray-700 — borders */
--border-light: #e5e7eb;      /* gray-200 — light mode borders */
--text-primary: #ffffff;
--text-secondary: #9ca3af;    /* gray-400 */
--text-muted: #6b7280;        /* gray-500 */

/* Bounty-specific accent colors */
--bounty-green: #10b981;      /* emerald-500 — bounty accent */
--bounty-glow: #10b98133;     /* bounty hover glow */
--difficulty-easy: #22c55e;   /* green-500 */
--difficulty-medium: #f59e0b; /* amber-500 */
--difficulty-hard: #ef4444;   /* red-500 */
--difficulty-expert: #8b5cf6; /* violet-500 */
--keyword-bg: #1e3a5f;        /* blue-tinted dark */
--keyword-text: #60a5fa;      /* blue-400 */
--keyword-top-bg: #064e3b;    /* emerald-tinted dark */
--keyword-top-text: #34d399;  /* emerald-400 */
```

### Typography
```css
font-family: 'Inter', 'InterVariable', system-ui, sans-serif;
/* Load from Google Fonts CDN: https://fonts.googleapis.com/css2?family=Inter:wght@300..700&display=swap */
```

### Card Pattern
```css
/* Matches tangled.org's feed card style exactly */
.card {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 2px;          /* rounded-sm */
  overflow: hidden;
}
.card:hover {
  background: var(--bg-card-hover);
  box-shadow: 0 0 20px var(--bounty-glow);
}
```

### Keyword Pills
```css
.keyword {
  background: var(--keyword-bg);
  color: var(--keyword-text);
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 0.75rem;
  font-weight: 500;
}
.keyword.top {
  background: var(--keyword-top-bg);
  color: var(--keyword-top-text);
  border: 1px solid var(--keyword-top-text);
}
```

### Difficulty Badges
```css
.difficulty-1 { color: var(--difficulty-easy); }
.difficulty-2 { color: var(--difficulty-easy); }
.difficulty-3 { color: var(--difficulty-medium); }
.difficulty-4 { color: var(--difficulty-hard); }
.difficulty-5 { color: var(--difficulty-expert); }
```

---

## AT Protocol Lexicon Schemas (Reference)

These are the schemas that would be used in production when integrating with tangled.org. Show these in the demo as collapsible sections to demonstrate the integration path.

### sh.tangled.bounty.post
```json
{
  "lexicon": 1,
  "id": "sh.tangled.bounty.post",
  "defs": {
    "main": {
      "type": "record",
      "key": "tid",
      "record": {
        "type": "object",
        "required": ["issue", "repo", "title", "keywords", "topKeywords", "difficulty", "status", "createdAt"],
        "properties": {
          "issue": { "type": "string", "format": "at-uri" },
          "repo": { "type": "string", "format": "at-uri" },
          "title": { "type": "string", "maxLength": 256 },
          "summary": { "type": "string", "maxLength": 1024 },
          "keywords": {
            "type": "array",
            "items": { "type": "string" },
            "maxLength": 10
          },
          "topKeywords": {
            "type": "array",
            "items": { "type": "string" },
            "maxLength": 3
          },
          "difficulty": { "type": "integer", "minimum": 1, "maximum": 5 },
          "status": { "type": "string", "knownValues": ["open", "completed"] },
          "createdAt": { "type": "string", "format": "datetime" }
        }
      }
    }
  }
}
```

### sh.tangled.bounty.award
```json
{
  "lexicon": 1,
  "id": "sh.tangled.bounty.award",
  "defs": {
    "main": {
      "type": "record",
      "key": "tid",
      "record": {
        "type": "object",
        "required": ["bounty", "repo", "pullRequest", "skills", "difficulty", "awardedAt", "awardedBy", "signature"],
        "properties": {
          "bounty": { "type": "string", "format": "at-uri" },
          "repo": { "type": "string", "format": "at-uri" },
          "pullRequest": { "type": "string", "format": "at-uri" },
          "skills": {
            "type": "array",
            "items": { "type": "string" },
            "maxLength": 10
          },
          "difficulty": { "type": "integer", "minimum": 1, "maximum": 5 },
          "awardedAt": { "type": "string", "format": "datetime" },
          "awardedBy": { "type": "string", "format": "did" },
          "signature": { "type": "string", "description": "Cryptographic signature signed by the private key of the awardedBy DID" }
        }
      }

    }
  }
}
```

### sh.tangled.bounty.profile
```json
{
  "lexicon": 1,
  "id": "sh.tangled.bounty.profile",
  "defs": {
    "main": {
      "type": "record",
      "key": "self",
      "record": {
        "type": "object",
        "required": ["totalCompleted", "skillBreakdown", "avgDifficulty", "public", "lastUpdated"],
        "properties": {
          "totalCompleted": { "type": "integer" },
          "skillBreakdown": {
            "type": "object",
            "description": "Map of skill name to count of bounties completed with that skill"
          },
          "avgDifficulty": { "type": "number" },
          "completionStreak": { "type": "integer" },
          "public": { "type": "boolean" },
          "lastUpdated": { "type": "string", "format": "datetime" }
        }
      }
    }
  }
}
```

---

## Seed Data & Fallback Strategy

### Seed Repo List (`js/data.js`)
`data.js` contains a curated list of real tangled.org repos to scan at startup. These are actual repos on tangled.org that `fetcher.js` will query for live `#bounty` issues:

```js
export const SEED_REPOS = [
  { handle: "tangled.org",   repo: "core",   did: null },  // did resolved at runtime
  { handle: "tangled.org",   repo: "docs",   did: null },
  // Add more real tangled.org repos here as they're discovered
];
```

If a repo's owner DID cannot be resolved (offline, CORS issue, XRPC error), `fetcher.js` falls back to the bundled mock issues for that repo. This ensures the demo always has data.

### Fallback Mock Issues
Keep 10–15 realistic mock bounty issues in `data.js` as offline fallback, matching the format of live XRPC responses. These are displayed when live fetch fails:

- Mix of languages: Rust, TypeScript, Go, Python, C++
- Mix of difficulties: 2–3 easy, 5–6 medium, 4–5 hard, 2–3 expert
- Use real tangled.org-style handles

### Current User Identity
The app prompts the user to enter their tangled.org handle on first load (stored in localStorage). If they skip it:
- Feed shows unauthenticated ranking (freshness + popularity)
- Profile page shows a guest prompt

If they enter a valid handle:
- `fetcher.js` resolves it to a DID, fetches their public social graph
- Ranking algorithm runs personalized mode
- Their handle is shown in the nav bar

---

## Demo Flow (Presentation Script)

The demo should support this 3–5 minute walkthrough:

1. **Open main page** → "This feed is live data from tangled.org — these are real issues with #bounty tags, fetched right now via AT Protocol"
2. **Enter your tangled handle** (or use pre-set demo handle) → Feed re-ranks: "This bounty is #1 because I follow the owner AND it matches my TypeScript skills"
3. **Navigate to Create page** → Paste a real tangled.org issue URL → "Watch it fetch the issue live"
4. **Click Parse** → Watch keywords animate in, top 3 highlight, difficulty appears, authority weight + points value shown
5. **Click Add to Feed** → Return to main page, new bounty appears
6. **Click a bounty** → Full details, link back to real tangled.org issue, all keywords
7. **Click Submit PR** → Success animation → "Here's the cryptographic proof:"
8. **Show verification panel** → Raw award JSON, signature bytes, click "Verify Signature" → "✓ Passes `crypto.subtle.verify()` — this award cannot be forged without the repo owner's private key"
9. **Navigate to Profile** → New award in list with verified badge, points tally, authority weight explanation
10. **Show AT Protocol schemas** → "When tangled merges this, these localStorage writes become real XRPC writes to the user's PDS — the rest of the code stays identical"
