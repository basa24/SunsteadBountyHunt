# Tangled Bounty Hunt — Philosophy

## What Is This?

Bounty Hunt is a **standalone web application** that reads live data from [tangled.org](https://tangled.org) via its public AT Protocol XRPC API, and layers a reputation-driven contribution incentive system on top of tangled's existing issue and PR workflow. The app is self-contained — it does not require any changes to tangled.org to run — making it a fully functional demo we can ship today. The long-term goal is to merge this feature directly into tangled.org once the design is proven.

Tangled.org is a decentralized, open-source code collaboration platform built on the AT Protocol (same tech as Bluesky). Repos are hosted on self-hostable servers called **knots**, and all social data (issues, PRs, follows, stars) lives as signed records in users' **Personal Data Servers (PDS)**.

Bounty Hunt adds a **reputation-driven contribution incentive system** on top of tangled's existing issue and PR workflow, defined by three core pillars:

1. **A Social Accumulation Tool:** Giving users a fun, organic way to interact with the platform, accumulating reputational capital through active contribution and social engagements.
2. **A Beneficial Toy for Open Source Collaboration:** A zero-friction, lightweight game-like mechanic where developers can collaborate, challenge each other, and contribute to repositories in a racing model.
3. **An Unofficial CV / Verifiable Developer Card:** A portable, cryptographically verified record that acts as an index of one's real coding capabilities, languages, and task difficulties resolved, independent of any centralized organization.


## The Core Loop

```
Repo Owner creates issue with #bounty tag
        ↓
AI Bot detects it, parses the issue text
        ↓
Bot generates a structured bounty listing:
  - ~10 keywords describing the project and problem
  - Top 3 most relevant keywords highlighted
  - Difficulty level (1-5) inferred from the issue
        ↓
Bounty appears in a ranked feed on tangled.org's main page
  - Top 10 bounties shown, personalized per user
  - Ranked by social proximity + skill relevance
        ↓
Hunter sees bounty, does the work, submits a PR
  - No comments, no "dibs", no pitching
  - The PR IS the hunt — code speaks for itself
  - Multiple hunters can race; best solution wins
        ↓
Repo owner reviews and merges the PR
        ↓
Bounty is automatically awarded
  - Award record written to hunter's PDS profile
  - Optionally public as a verifiable track record
```

## Design Principles

### 1. Hunt = Pull Request, Not a Comment

The hunter does NOT post "I want to work on this." There is no queue, no reservation system, no social friction. The hunter sees the bounty, does the work, and submits a PR referencing the bounty issue. If the owner merges it, the bounty is awarded. This mirrors how open source already works — it just adds a reward layer.

**Why:** Eliminates bikeshedding, social politics, and "dibs" culture. The code is the only thing that matters.

### 2. Reputation, Not Currency

Bounty awards are **reputation scores**, not money or tokens. Each completed bounty creates a verifiable record in the hunter's AT Protocol PDS that tracks:
- Which bounty was completed
- What skills were involved
- What difficulty level it was
- Who awarded it (the repo owner)

This builds a **portable, decentralized track record** that follows the developer across any AT Protocol app — not locked into tangled.org's database.

**Why:** No legal/financial overhead, no crypto complexity. Pure meritocratic reputation. A developer's bounty profile becomes a provable portfolio.

### 3. "Nearby" = Social + Skill Proximity

The bounty feed is **personalized**. "Nearby" does not mean geographic distance — it means relevance distance:

- **Social proximity:** Bounties from repos you follow/star, people you follow, mutual connections, communities you're part of
- **Skill match:** Bounties whose keywords match your demonstrated skills (from past bounty awards and contribution history)
- **Freshness:** Newer bounties rank higher (time decay)
- **Difficulty fit:** Match bounty difficulty to your experience level

The result is an **indexed, ranked feed** where the most relevant bounties surface first. The top 10 are shown on the main page.

For new/unauthenticated users, the feed falls back to: freshness + repo popularity.

### 4. AI Does the Boring Work

Repo owners should NOT have to fill out forms or tag skills manually. They write a natural-language issue and add `#bounty`. The AI bot handles everything else:

- Reads the issue text
- Extracts ~10 keywords (project context + problem domain)
- Identifies the top 3 most relevant keywords
- Estimates difficulty (1-5) based on scope, complexity, and domain signals
- Publishes the structured bounty listing

The AI should be **lightweight** — keyword extraction and difficulty classification, not creative writing. It's a parser, not a generator.

### 5. Native to AT Protocol Philosophy

The project is deeply coupled with the AT Protocol philosophy, utilizing its decentralized federation and streaming infrastructure to ensure high performance and user ownership:

- **Firehose Event Listening (Relay Hooking):** Rather than polling individual repositories or self-hosted knots (which degrades performance and violates decentralization), the Bounty Bot connects directly to AT Protocol **Relays (the global firehose)**. When a repo owner posts an issue record (`sh.tangled.repo.issue`) containing the `#bounty` tag to their PDS, the Relay streams this event globally in real-time. The Bounty Bot intercepts this event, parses it immediately, and updates the bounty registry. This ensures instant feed performance and seamless knot-agnostic updates.
  - *Status — implemented (with caveats):* `js/firehose.js` does exactly this client-side via the **Bluesky Jetstream** WebSocket (a JSON wrapper over the CBOR firehose), filtered to `sh.tangled.repo.issue` / `.issue.state` / `sh.tangled.bounty.submission` / `.award`. Two real-world limits: the Bluesky relay does **not** index tangled-hosted (`tngl.sh`) PDSes, and the stream only carries events created *after* the socket connects (no history). Direct PDS `listRecords` reads plus a `/tnglweb` HTML scrape of tangled's timeline backfill that gap for the demo.
- **AT Protocol Labeler (Verifiable Badges):** The Bounty Hunt service acts as an **AT Protocol Labeler** (`com.atproto.labeler`). When a hunter completes milestone bounties, the service issues cryptographically signed tags (e.g., `sh.tangled.bounty.badge.rust-expert`) directly onto the hunter's DID. Any AT Protocol client (Bluesky, Tangled, custom profile cards) can resolve this label and display these badges natively on the developer's public profile as their "Unofficial CV".
  - *Status — not yet implemented (aspirational).* No labeler service runs today; badges/skill breakdown are computed client-side from the hunter's `sh.tangled.bounty.award` records on their PDS.
- **Cryptographic Web of Trust:** Every bounty award (`sh.tangled.bounty.award`) is a signed record inside the user's PDS, referencing the merge signature of the repository owner's DID. This forms a verifiable chain of trust. A developer's profile rating isn't just arbitrary numbers; it is cryptographically backed by the reputation of the repository owners who merged their code.
  - *Status — partially implemented.* The award **is** a signed record written to the hunter's real PDS, and an award only fires when the app observes the **owner's real merge** of a PR carrying the hunter's unguessable token (`js/pulls.js`) — so trust comes from a genuine, owner-performed merge. The signature itself, however, currently uses an **ephemeral demo key** (`js/signer.js`), not the owner's DID key; it proves the record wasn't tampered with, but not yet owner identity. Production swaps the demo key for the owner's PDS-held key.
- **Identity & Social Graph:** Profile discovery leverages the existing AT Protocol social graph (follows, stars, blocks) to personalize recommendations and ensure that developers own their social reputation portable across the network.


### 6. Optionally Public Profile

Hunters control whether their bounty track record is visible. When public, it becomes a **verifiable portfolio** — other AT Protocol apps, employers, or communities can see their contribution history, skill breakdown, and difficulty level.

## What This Is NOT

- **Not a job board.** There's no employer/employee relationship. It's open-source contribution with reputation rewards.
- **Not a cryptocurrency/token system.** No money changes hands. Reputation is the currency.
- **Not a task assignment system.** Nobody is assigned work. Hunters self-select and compete on code quality.
- **Not a bounty auction.** There's no bidding. The bounty is the issue; the PR is the claim.

---

## 🔒 Cryptographic Verification: Defeating PDS Forgeries

In a federated network, users have root access to their own PDS (Personal Data Server). A user could theoretically manually write a fake `sh.tangled.bounty.award` record into their PDS claiming they completed 100 hard Rust bounties for `@vitalik.eth` or `@creator.tngl.sh`. 

To ensure **100% verified points** that cannot be spoofed by PDS overrides, the architecture implements two checks:

> **Implementation status:** The shipped anti-forgery gate is **token-gated merge observation** (`js/pulls.js`): a hunt mints an unguessable `HuntRequest#<hex>` token, the hunter puts it in their PR title, and an award fires only when the app sees that PR *merged by the owner* with the hunter listed as author. This is a pragmatic stand-in for the full model below. The cryptographic signature exists but uses a demo key (see Web of Trust note above). Double-entry AppView cross-referencing, authority weighting beyond a basic stars/age/contributors formula, and Sybil/collusion labels are **design targets, not yet built**.

### 1. Cryptographic Signatures (Attestations)
When a repository owner merges a PR and awards a bounty, the award record is cryptographically signed using the **owner's private key** (the key associated with their DID). 
- The record stored in the PDS contains a `signature` property.
- When an indexer (AppView) reads this record, it resolves the owner's DID document, retrieves their public key, and verifies the signature.
- Because the hunter does not have the owner's private key, **they cannot forge this signature**, even with full access to their PDS database.

### 2. Double-Entry Bookkeeping (AppView Cross-Referencing)
The indexer (Tangled's AppView, Bobbin) does not simply take the hunter's word for it. It enforces a cross-verification rule:
- To index an award, Bobbin checks the **Hunter's PDS** for the `sh.tangled.bounty.award` record.
- It then queries the **Repository Owner's PDS** (or Knot repository logs) to verify that a corresponding award transaction or commit merge event exists and matches the transaction ID.
- If the owner's PDS does not have a matching record pointing to the hunter's DID, Bobbin discards the points and **refuses to index them**.
- Since the hunter cannot write records to the repository owner's PDS, they cannot fake the connection.

### 3. Collusion & Sybil Prevention (Owner-Hunter Collusion)
If a hunter colludes with the repository owner (e.g., they are friends), they could easily sign fake award records for blank or trivial PRs. To prevent this "point-farming" collusion:
- **Repository Authority Weighting:** Bounty points are scaled by the **repository's social graph authority** (stars, active contributors, age, and forks). An award on a highly active repository with 1,000 stars awards full value (e.g., 100 points). An award on a newly created, unstarred repository owned by a friend awards negligible value (e.g., 0.1 points).
- **Public Git Auditability:** The `bounty.award` record points directly to a Git commit hash on a public Knot. Because Git history is cryptographically chained and immutable, any employer or user viewing the hunter's "Unofficial CV" can click on any award to immediately audit the code diff. Colluding to fake a history of blank PRs leaves a permanent, public trail of cheating.
- **Social Graph Moderation Labels:** If a repository and hunter are caught in a point-farming ring, community moderation labelers (`com.atproto.labeler`) will flag both DIDs with `sh.tangled.bounty.cheater` labels. These labels propagate instantly across all indexers, removing their profiles from leaderboards and warning visitors.



## Standalone App Strategy

The app is intentionally built as a **separate, deployable web app** rather than a tangled.org fork or mock. This means:

- **Real data:** It fetches live issues from tangled.org repos via public AT Protocol XRPC endpoints. No mock data for the core feed — it reads actual `sh.tangled.repo.issue` records from real knots.
- **Real parsing:** The AI parser runs on real issue text fetched from the API.
- **Real awards, demo signatures:** Users sign in with an AT Protocol **app password** (`com.atproto.server.createSession`), so the app *does* write real `sh.tangled.bounty.post` / `.submission` / `.award` records to the logged-in user's PDS via `createRecord`. localStorage is now a local *mirror/cache* of that PDS state, not the source of truth. The one part still simulated is the award **signature**: it's produced with an ephemeral `crypto.subtle` demo key rather than the owner's DID key.
- **Progressive integration path:** When tangled.org is ready to merge, the frontend pages become tangled routes, the overlay `sh.tangled.bounty.*` collections get indexed by tangled's appview (Bobbin), and the demo signature gets replaced with the user's PDS-held private key. App-password auth would also graduate to full OAuth. The read/write code stays largely identical.

The visual design is intentionally distinct from tangled.org — it's a companion app, not a clone. It should look cohesive and polished on its own while clearly linking back to the underlying tangled repos and issues it surfaces.

## Target Platform Context

Tangled.org uses:
- **Backend:** Go
- **Frontend:** HTMX (hypermedia-driven, not SPA)
- **Styling:** Tailwind CSS, dark mode by default
- **Font:** Inter (InterVariable.woff2)
- **Visual style:** Dark gray palette (gray-900 bg, gray-800 cards, gray-700 borders), minimal, clean cards with divide-y separators, rounded-sm corners
- **Icons:** Lucide (inline SVG)
- **Protocol:** AT Protocol with `sh.tangled.*` namespaced lexicons
- **Identity:** AT Protocol DIDs via Bluesky accounts
- **Repos hosted on:** "Knots" (self-hostable Git servers)

Our standalone app reads this data via XRPC and presents it through our own UI layer.
