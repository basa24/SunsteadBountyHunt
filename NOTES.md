# Tangled Bounty Hunt — Technical Notes & References

## About Tangled.org

### What It Is
- Decentralized code collaboration platform (the "decentralized GitHub")
- Built on **AT Protocol** (same protocol as Bluesky)
- Open source, developed by **Tangled Labs Oy** (Finnish company)
- Currently in **alpha** stage
- URL: https://tangled.org

### Architecture
- **Backend:** Go
- **Frontend:** HTMX (hypermedia-driven, server-rendered — NOT a SPA)
- **Styling:** Tailwind CSS
- **Font:** Inter (loaded as InterVariable.woff2)
- **Icons:** Lucide (inline SVGs)
- **Identity:** AT Protocol DIDs (Decentralized Identifiers)
- **Auth:** AT Protocol OAuth / session-based via PDS
- **Repos hosted on:** "Knots" — lightweight, self-hostable Git servers

### Key Concepts
- **Knots:** Headless servers that host Git repos. Users can self-host or use tangled.org's managed knots. Think of them as decentralized repo hosts.
- **PDS (Personal Data Server):** Where each user's data lives. Part of AT Protocol. Every user has a PDS that stores their records (posts, follows, stars, issues, PRs, etc.).
- **DID (Decentralized Identifier):** The user's unique identity. Looks like `did:plc:abc123xyz`. Portable across any AT Protocol app.
- **Handle:** Human-readable username. On tangled it's typically `username.tngl.sh` or a custom domain like `jane.dev`.
- **Lexicon:** AT Protocol's schema definition format. JSON files that define record types. Tangled uses the `sh.tangled.*` namespace.
- **XRPC:** AT Protocol's RPC protocol for reading/writing records.
- **AppView:** A service that aggregates and indexes data from many PDS instances. Tangled runs an AppView called "Bobbin."

### Relevant Tangled Lexicons (Existing)
These are existing record types in tangled's `sh.tangled.*` namespace:
- `sh.tangled.repo.issue` — Issue records
- `sh.tangled.repo.pull` — Pull request records
- `sh.tangled.repo.tag` — Repository tags
- `sh.tangled.repo` — Repository records

Our bounty feature would add:
- `sh.tangled.bounty.post` — Bounty listing records
- `sh.tangled.bounty.award` — Award records (in hunter's PDS)
- `sh.tangled.bounty.profile` — Aggregated profile scores (in hunter's PDS)

---

## AT Protocol Quick Reference

### Record Operations
All record CRUD goes through standard AT Protocol XRPC endpoints:
```
com.atproto.repo.createRecord  — Create a new record
com.atproto.repo.putRecord     — Update a record
com.atproto.repo.deleteRecord  — Delete a record
com.atproto.repo.listRecords   — List records in a collection
com.atproto.repo.getRecord     — Get a single record
```

### AT URI Format
Records are addressed by AT URIs:
```
at://did:plc:abc123/sh.tangled.bounty.post/tid456
       └── DID      └── collection (NSID)    └── record key
```

### Record Key Types
- `tid` — Time-based ID (default for most records)
- `self` — Singleton record (used for profile-level data like bounty.profile)

### SDK
The official AT Protocol SDK is TypeScript-first:
```
npm install @atproto/api
```

Key classes:
- `AtpAgent` — Main client for XRPC calls
- `BskyAgent` — Bluesky-specific client (extends AtpAgent)

We don't use the SDK — we read live data with raw `fetch()` XRPC calls, and we *write* real records with app-password auth (`createSession` → `createRecord`) directly. The SDK remains the cleaner path once we move to full OAuth.

---

## Tangled.org Visual Reference

### HTML Structure Pattern (from live site)
Tangled's cards follow this pattern:
```html
<div class="flex flex-col divide-y divide-gray-200 dark:divide-gray-700 
            border border-gray-200 dark:border-gray-700 
            rounded-sm bg-white dark:bg-gray-800 drop-shadow-sm">
  <!-- Row 1 -->
  <div class="bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-300 
              flex w-max items-stretch divide-x divide-gray-200 dark:divide-gray-700 text-sm">
    <div class="p-4 bg-gray-100 dark:bg-gray-900/50 h-full">
      <!-- Icon -->
    </div>
    <div class="px-4 flex items-center gap-2">
      <!-- Content -->
    </div>
  </div>
</div>
```

### Navigation Pattern
```html
<nav class="mx-auto space-x-4 px-6 py-2">
  <div class="flex justify-between p-0 items-center">
    <div id="left-items"><!-- Logo --></div>
    <div id="right-items" class="flex items-center gap-4">
      <!-- Login / Join buttons -->
    </div>
  </div>
</nav>
```

### Page Layout
```html
<body class="min-h-screen flex flex-col gap-4 bg-slate-100 dark:bg-gray-900 dark:text-white">
  <header class="max-w-screen-xl mx-auto w-full"><!-- nav --></header>
  <div class="flex-grow relative">
    <div class="max-w-screen-xl mx-auto flex flex-col gap-4 relative z-10">
      <main><!-- content --></main>
    </div>
  </div>
</body>
```

### Avatar Pattern
```html
<img src="https://avatar.tangled.sh/{hash}/{did}?size=tiny"
     class="rounded-full h-6 w-6 border border-gray-300 dark:border-gray-700" />
```

For our demo, we can use placeholder avatars:
- `https://api.dicebear.com/7.x/identicon/svg?seed={handle}` — deterministic identicons
- Or inline SVG placeholder circles

### CSS Classes Mapping (Tailwind → Vanilla)
Since tangled uses Tailwind and we're writing vanilla CSS, here's the mapping for key classes:

| Tailwind | CSS |
|----------|-----|
| `bg-gray-900` | `background: #111827` |
| `bg-gray-800` | `background: #1f2937` |
| `bg-gray-700` | `background: #374151` |
| `bg-gray-100` | `background: #f3f4f6` |
| `text-white` | `color: #ffffff` |
| `text-gray-400` | `color: #9ca3af` |
| `text-gray-500` | `color: #6b7280` |
| `text-gray-300` | `color: #d1d5db` |
| `border-gray-700` | `border-color: #374151` |
| `border-gray-200` | `border-color: #e5e7eb` |
| `rounded-sm` | `border-radius: 2px` |
| `rounded-full` | `border-radius: 9999px` |
| `drop-shadow-sm` | `filter: drop-shadow(0 1px 1px rgb(0 0 0 / 0.05))` |
| `divide-y` | `& > * + * { border-top: 1px solid }` |
| `divide-x` | `& > * + * { border-left: 1px solid }` |
| `gap-2` | `gap: 0.5rem` |
| `gap-4` | `gap: 1rem` |
| `gap-6` | `gap: 1.5rem` |
| `p-4` | `padding: 1rem` |
| `px-4` | `padding-left: 1rem; padding-right: 1rem` |
| `px-6` | `padding-left: 1.5rem; padding-right: 1.5rem` |
| `py-2` | `padding-top: 0.5rem; padding-bottom: 0.5rem` |
| `text-sm` | `font-size: 0.875rem; line-height: 1.25rem` |
| `text-xs` | `font-size: 0.75rem; line-height: 1rem` |
| `text-2xl` | `font-size: 1.5rem; line-height: 2rem` |
| `font-bold` | `font-weight: 700` |
| `max-w-screen-xl` | `max-width: 1280px` |

---

## Keyword Dictionary (for Rule-Based Parser)

### Programming Languages
```
javascript, typescript, python, rust, go, golang, java, c, cpp, c++, csharp, c#, 
ruby, php, swift, kotlin, scala, elixir, haskell, lua, perl, r, dart, zig, nim, 
ocaml, clojure, erlang, julia, assembly, sql, html, css, sass, less, shell, bash, 
powershell, graphql, wasm, webassembly, solidity
```

### Frameworks & Libraries
```
react, nextjs, next.js, vue, angular, svelte, solid, astro, remix, nuxt, 
express, fastify, koa, hono, django, flask, fastapi, rails, spring, 
tokio, actix, axum, rocket, gin, echo, fiber,
tailwind, bootstrap, material-ui, chakra,
prisma, drizzle, sequelize, typeorm, sqlalchemy, diesel,
jest, vitest, mocha, pytest, cargo-test,
webpack, vite, rollup, esbuild, turbopack
```

### Technical Domains
```
networking, database, authentication, authorization, api, rest, grpc, websocket,
frontend, backend, fullstack, devops, infrastructure, cloud, serverless,
machine-learning, ai, nlp, computer-vision, data-science,
security, cryptography, encryption, oauth, jwt, cors,
testing, ci-cd, deployment, monitoring, logging, observability,
performance, optimization, caching, memory, concurrency, parallelism,
ui, ux, accessibility, responsive, mobile, pwa,
compiler, parser, interpreter, runtime, virtual-machine,
blockchain, smart-contract, defi, web3,
protocol, specification, rfc, standard
```

### Concepts
```
async, await, promise, callback, event-driven, reactive, streaming,
microservice, monolith, serverless, edge, distributed, 
orm, migration, schema, query, index,
component, hook, state-management, routing, middleware,
container, orchestration, service-mesh, load-balancer,
type-system, generics, trait, interface, polymorphism,
algorithm, data-structure, tree, graph, hash, sort, search,
refactor, technical-debt, legacy, migration, upgrade,
documentation, tutorial, example, template, boilerplate
```

### Difficulty Signal Words

**Level 1 — Trivial:**
```
typo, spelling, grammar, readme, docs, documentation, comment, rename, 
formatting, whitespace, lint, style, badge, link, broken-link, changelog
```

**Level 2 — Easy:**
```
add, simple, small, minor, config, configuration, environment, variable,
style, css, color, font, icon, label, text, string, translation, i18n,
dependency, update, bump, version, upgrade-dependency
```

**Level 3 — Medium:**
```
feature, implement, create, build, endpoint, route, handler, controller,
test, unit-test, integration-test, e2e, coverage, mock,
refactor, cleanup, reorganize, extract, split, merge,
bug, fix, issue, error, exception, edge-case, validation
```

**Level 4 — Hard:**
```
performance, optimize, benchmark, profiling, memory-leak, latency,
security, vulnerability, cve, injection, xss, csrf, audit,
architecture, design, system, scalability, availability,
migration, database-migration, data-migration, schema-change,
concurrency, race-condition, deadlock, thread-safety, lock-free
```

**Level 5 — Expert:**
```
cryptography, encryption, decryption, signing, certificate, tls, ssl,
consensus, distributed-consensus, raft, paxos, byzantine,
compiler, parser-generator, ast, code-generation, llvm,
kernel, driver, syscall, interrupt, bare-metal,
protocol-design, specification, rfc, wire-format, binary-protocol,
zero-knowledge, proof, formal-verification
```

---

## External Resources

### Tangled
- Homepage: https://tangled.org
- Core repo: https://tangled.org/tangled.org/core
- Documentation: https://tangled.org/tangled.org/docs

### AT Protocol
- Specification: https://atproto.com
- Lexicon guide: https://atproto.com/guides/lexicon
- TypeScript SDK: https://github.com/bluesky-social/atproto
- Label docs: https://atproto.com/guides/labels
- Lexicon style guide ("Lexinomicon"): community-maintained best practices

### Design Resources
- Dicebear Avatars: https://www.dicebear.com (for mock user avatars)
- Lucide Icons: https://lucide.dev (matches tangled's icon set)
- Inter Font: https://fonts.google.com/specimen/Inter
- Google Fonts CDN: `https://fonts.googleapis.com/css2?family=Inter:wght@300..700&display=swap`

---

## Fetching Real Data from Tangled.org

### How AT Protocol Public Read Works
All AT Protocol records are publicly readable without auth. Tangled.org's AppView (Bobbin) exposes XRPC endpoints at `https://tangled.org/xrpc/`.

### Resolving a Handle to a DID
```
GET https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle={handle}
→ { "did": "did:plc:abc123" }
```
> Note: `tangled.org/xrpc` 404s — tangled does **not** expose a public XRPC endpoint. Identity resolution goes through the Bluesky public API; record reads go directly against the owner's PDS (resolved via `plc.directory`).

### Getting a User's PDS Endpoint
Once you have a DID, fetch its DID document to find where their PDS lives:
```
GET https://plc.directory/{did}
→ { "service": [{ "id": "#atproto_pds", "serviceEndpoint": "https://..." }] }
```
For users on tangled.org's managed PDS, the endpoint is likely `https://tangled.org` or a subdomain.

### Listing Issues from a Repo
Issues in AT Protocol are records in the `sh.tangled.repo.issue` collection stored in the repo owner's PDS:
```
GET {pdsEndpoint}/xrpc/com.atproto.repo.listRecords
  ?repo={ownerDid}
  &collection=sh.tangled.repo.issue
  &limit=50
→ { "records": [ { "uri": "at://...", "cid": "...", "value": { ... } } ] }
```

### Fetching a Single Record
```
GET {pdsEndpoint}/xrpc/com.atproto.repo.getRecord
  ?repo={ownerDid}
  &collection=sh.tangled.repo.issue
  &rkey={recordKey}
```

### Discovering Repos on Tangled
Tangled's AppView (Bobbin) likely exposes search/browse endpoints. Until those are documented, bootstrap with:
1. A hardcoded seed list of popular tangled.org repos (fetched at startup)
2. Let users paste a tangled.org repo URL to add it to the scan list
3. Use `com.atproto.repo.listRecords` with `collection=sh.tangled.repo` to enumerate repos for a given user DID

### Filtering for Bounties
After fetching issues, filter client-side:
```js
const isBounty = issue.value.body?.includes('#bounty') 
              || issue.value.title?.includes('#bounty')
              || issue.value.labels?.includes('bounty');
```

### CORS Considerations
Browser CORS policy may block direct `fetch()` calls to tangled.org or external PDS endpoints. Mitigation options:
- **What we actually do (Option C confirmed):** the AT Protocol hosts we read from — `public.api.bsky.app`, `plc.directory`, and the owners' PDSes — all send `Access-Control-Allow-Origin: *`, so the core read/write path needs **no proxy at all**.
- **The one proxy that matters — `/tnglweb` (dev-only):** tangled's *appview* is server-rendered HTML with no CORS and no JSON API, yet it's the only place issue open/closed state and PR merge status live. So `vite.config.js` proxies `/tnglweb/* → tangled.org` to scrape those pages in dev. This is unavailable in a static production build (so closed-issue filtering and PR reconciliation no-op there).
- **Legacy:** the `/xrpc → tangled.org` proxy is kept as a fallback but is effectively dead, since `tangled.org/xrpc` 404s. There is no `server/` Express proxy — Vite's dev proxy covers everything.

### Caching Strategy
Since we're fetching live data, cache aggressively in localStorage to avoid re-fetching on every page load:
```js
// In storage.js
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
```
Each cached issue record stores its `fetchedAt` timestamp. Stale records are re-fetched in the background.

---

## Verifiable Bounty Points — Cheat Prevention Design

### Why It Matters
In a federated network, a user has root access to their own PDS. Without verification, they could manually write a fake `sh.tangled.bounty.award` claiming they completed 100 hard bounties. The system must make forgery impossible (cryptography) and detectable (double-entry + social graph).

### Layer 1 — Cryptographic Signatures
Every `sh.tangled.bounty.award` record contains a `signature` field:
```js
{
  bounty: "at://did:plc:bot/sh.tangled.bounty.post/abc",
  pullRequest: "at://did:plc:owner/sh.tangled.repo.pull/xyz",
  skills: ["rust", "websocket"],
  difficulty: 4,
  awardedAt: "2026-06-24T12:00:00Z",
  awardedBy: "did:plc:owner123",       // Repo owner's DID
  signature: "<base64-encoded sig>"    // Signed by owner's AT Protocol private key
}
```
The signature covers: `bountyUri + pullRequestUri + hunterDid + awardedAt`. Since the hunter does not hold the repo owner's private key, they cannot forge this field. Any indexer can verify by resolving the owner's DID document → public key → verify signature.

In the demo, we simulate this: awards are signed with a demo key pair (generated at runtime via Web Crypto API), and the verification UI actually runs `crypto.subtle.verify()` client-side to prove the model works.

### Layer 2 — Double-Entry Cross-Reference
The AppView (Bobbin) enforces a two-sided check before indexing any award:
1. Award record exists in **hunter's PDS** with a valid signature from `awardedBy`
2. A corresponding record (PR merge event or explicit award acknowledgment) exists in the **repo owner's PDS** pointing back to the hunter's DID

A hunter cannot write records to the repo owner's PDS — so a one-sided fake award is automatically discarded.

In the demo: simulate this by requiring both sides to exist in localStorage before the award appears on the profile leaderboard.

### Layer 3 — Repository Authority Weighting
Award points are scaled by the repo's credibility score:
```js
function repoAuthorityWeight(repo) {
  const starScore  = Math.log10(Math.max(repo.stars, 1)) / 4;   // 0–1, log scale
  const ageScore   = Math.min(repo.ageInDays / 365, 1);         // capped at 1 year
  const contribs   = Math.min(repo.contributorCount / 20, 1);   // 20+ contributors = max
  return (0.5 * starScore) + (0.3 * ageScore) + (0.2 * contribs);
}
// Final points = difficulty × 20 × repoAuthorityWeight
```
A brand-new repo with 0 stars and 1 contributor gives ≈0.1× multiplier. A repo with 500+ stars gives ≈1.0×.

### Layer 4 — Public Git Auditability
Every `sh.tangled.bounty.award` record contains a `pullRequest` field pointing to the AT URI of the actual merged PR. That PR record on the repo owner's PDS contains the Git commit hash. Anyone can:
1. Resolve the PR record → get commit SHA
2. Visit the repo on tangled.org (or clone the knot) → inspect the actual code diff
3. Verify that the PR meaningfully addresses the bounty issue

Farming empty PRs is publicly auditable and leaves a permanent trail.

### Layer 5 — Sybil / Collusion Labels
If a hunter and repo owner are caught in a point-farming ring (fake bounties → trivial PRs → inflated awards), community moderation labelers flag both DIDs:
- `sh.tangled.bounty.cheater` — removes from leaderboards, warns profile visitors
- Labels propagate via the AT Protocol labeler mechanism to all indexers instantly

In the demo: show the label badge UI on profile cards for flagged accounts (using mock flagged users in seed data).

---

## Constraints & Known Limitations

### Standalone App Constraints (Real Data, Simulated Writes)
- **Reads are real:** Issues fetched live from owners' PDSes via `listRecords`, plus the Jetstream firehose for new ones.
- **Writes are real:** `sh.tangled.bounty.post` / `.submission` / `.award` records are written to the logged-in user's PDS via `createRecord`. localStorage is a local mirror/cache, not the source of truth.
- **Auth is app-password, not OAuth:** Users log in with an AT Protocol **app password** → a real `createSession` (`accessJwt`/`refreshJwt`). This grants record-write access to *their own* PDS, but it is not full OAuth and is **not** the DID signing key — and app passwords can't merge PRs, which is why awards rely on observing a real owner-merge.
- **Signing is demo-mode:** Award signatures are generated with an ephemeral Web Crypto key pair to prove the model, not with the user's real AT Protocol key.
- **No real AI API call by default:** Rule-based parser. Optional Claude API mode if a key is available
- **CORS proxy required:** Vite dev proxy or small Express relay for XRPC calls

### Future Integration Path & AT Protocol Integrations

To integrate with tangled.org and the AT Protocol network for real:

1. **Register the Lexicons:** Add `sh.tangled.bounty.post`, `sh.tangled.bounty.award`, and `sh.tangled.bounty.profile` to the AT Protocol lexicon definitions.
2. **Listen to the Relay Firehose:**
   - Instead of polling individual Knots (repos), create a firehose subscriber bot.
   - Connect to a Relay's websocket subscription endpoint: `wss://bsky.network/xrpc/com.atproto.sync.subscribeRepos`
   - Filter the incoming CBOR-encoded event streams for repo writes with the collection type `sh.tangled.repo.issue`.
   - Inspect the record content. If the text has `#bounty`, pass it to the AI parser.
   - *Status — partially implemented in the browser already.* `js/firehose.js` subscribes to the **Jetstream** JSON firehose (`wss://jetstream*.bsky.network/subscribe`) over a plain WebSocket with server-side `wantedCollections` filtering — no CBOR decoding, no auth, no CORS. A dedicated server-side subscriber bot is still the production move (history + reliability), and it must address the relay's blind spot for tngl.sh-hosted PDSes.
3. **AppView (Bobbin) Indexing:**
   - Extend Bobbin (Tangled's AppView indexer) to consume the `sh.tangled.bounty.*` namespace.
   - Bobbin will index these postings and expose query APIs (like personalized recommended lists) to the tangled.org frontend.
4. **Implement the Labeler Service (Unofficial CV):**
   - Build a service implementing `com.atproto.labeler.defs` and `com.atproto.label.defs`.
   - When a user earns a bounty milestone, the service signs a label:
     ```json
     {
       "src": "did:plc:bountyhunt-labeler", // Labeler identity
       "uri": "did:plc:hunter-did",         // Subject of the label
       "val": "sh.tangled.bounty.badge.rust-expert", // Badge identifier
       "cts": "2026-06-24T21:32:00Z",
       "sig": "..."                         // Cryptographic signature of this label
     }
     ```
   - Standard AT Protocol clients can display this badge natively on profiles.
5. **Knot Merge Webhook / Integration:**
   - Configure Tangled's Knots (Git servers) to emit a webhook or record write when a PR is merged.
   - Verify that the PR resolves an active bounty issue (via issue URI checks).
   - Prompt the owner's PDS to write the acceptance/award record.


### Schema Evolution Considerations
AT Protocol records are hard to change once deployed. Key decisions to finalize before production:
- Should `difficulty` be an integer (1-5) or a string enum ("trivial"/"easy"/"medium"/"hard"/"expert")?
- Should `keywords` and `topKeywords` be separate fields, or a single array with a `primary` flag per item?
- Should `bounty.profile` be a singleton record (`key: "self"`) or should each skill be a separate record for granular updates?
- How should expired/cancelled bounties be handled? Status field? Or delete the record?

---

## Quick Setup Commands

```bash
# Initialize the project
cd Sunstead
npm init -y
npm install vite --save-dev

# Add scripts to package.json
# "dev": "vite",
# "build": "vite build",
# "preview": "vite preview"

# Run dev server
npm run dev
```

### Optional: Claude API Proxy
If a Claude API key is available:
```bash
npm install express cors @anthropic-ai/sdk
# Then run server/parser.js alongside the Vite dev server
```
