// Rule-based issue parser — works offline, no API key required.
// Optional: set window.CLAUDE_API_KEY to use Claude for higher-quality extraction.

const STOP_WORDS = new Set([
  'the','a','an','is','it','in','on','at','to','for','of','and','or','but',
  'with','from','by','as','this','that','these','those','was','are','be',
  'have','has','had','will','would','should','could','may','might','i','we',
  'you','they','he','she','its','our','your','their','my','not','no','can',
  'also','just','more','if','when','then','so','do','does','did','been',
  'into','than','about','which','there','after','before','all','any','some',
  'what','how','need','use','using','used','via','per','new','old','get',
  'set','see','run','add','fix','make','build','test','take','work','works',
  'https','http','com','github','www','issue','issues','pr','bug','feature',
]);

// Keyword dictionaries by category with relevance weights
const KEYWORDS = {
  // Programming languages — highest weight
  language: {
    weight: 3,
    terms: new Set([
      'rust','go','golang','typescript','javascript','python','java','c','cpp',
      'c++','csharp','c#','ruby','php','swift','kotlin','scala','elixir',
      'haskell','lua','perl','r','dart','zig','nim','ocaml','clojure','erlang',
      'julia','assembly','sql','html','css','sass','less','shell','bash',
      'powershell','graphql','wasm','webassembly','solidity','markdown',
    ]),
  },
  // Frameworks & libraries — high weight
  framework: {
    weight: 2.5,
    terms: new Set([
      'react','nextjs','vue','angular','svelte','solid','astro','remix','nuxt',
      'express','fastify','koa','hono','django','flask','fastapi','rails',
      'spring','tokio','actix','axum','rocket','gin','echo','fiber','actix-web',
      'tailwind','bootstrap','chakra','shadcn','codemirror','monaco',
      'prisma','drizzle','sequelize','typeorm','sqlalchemy','diesel','gorm',
      'jest','vitest','mocha','pytest','playwright','cypress',
      'webpack','vite','rollup','esbuild','turbopack','parcel',
      'opentelemetry','otel','grpc','protobuf','graphql','redis','kafka',
      'wasmtime','wasmer','blake3','aiohttp','asyncio',
    ]),
  },
  // Technical domains — medium-high weight
  domain: {
    weight: 2,
    terms: new Set([
      'networking','database','authentication','authorization','api','rest',
      'grpc','websocket','webrtc','streaming','frontend','backend','fullstack',
      'devops','infrastructure','cloud','serverless','edge','microservices',
      'machine-learning','ai','nlp','computer-vision','data-science','etl',
      'security','cryptography','encryption','oauth','jwt','cors','csrf','xss',
      'testing','ci-cd','deployment','monitoring','logging','observability',
      'performance','optimization','caching','memory','concurrency','parallelism',
      'ui','ux','accessibility','responsive','mobile','pwa','desktop',
      'compiler','parser','interpreter','runtime','virtual-machine','vm',
      'blockchain','smart-contract','defi','web3','protocol','specification',
    ]),
  },
  // Concepts — medium weight
  concept: {
    weight: 1.5,
    terms: new Set([
      'async','await','promise','callback','event-driven','reactive','n+1',
      'orm','migration','schema','query','index','join','transaction',
      'component','hook','state-management','routing','middleware','proxy',
      'container','orchestration','kubernetes','docker','helm','terraform',
      'type-system','generics','trait','interface','polymorphism','inheritance',
      'algorithm','data-structure','tree','graph','hash','sort','search','binary',
      'refactor','technical-debt','legacy','upgrade','rewrite','port',
      'documentation','tutorial','example','template','boilerplate','scaffold',
      'race-condition','deadlock','thread-safety','lock-free','atomic','mutex',
      'token-bucket','rate-limiting','sandbox','isolation','sybil','labeler',
      'cbor','atproto','pds','did','firehose','lexicon','xrpc','knot',
      'blake3','sha256','hashing','signing','certificate','tls','ssl',
    ]),
  },
};

// Difficulty signal words per level
const DIFFICULTY_SIGNALS = [
  // Level 1 — trivial
  new Set(['typo','spelling','grammar','readme','docs','documentation',
           'comment','rename','formatting','whitespace','lint','style',
           'badge','link','broken-link','changelog','typos','anchors',
           'markdown','i18n','translation']),
  // Level 2 — easy
  new Set(['add','simple','small','minor','config','configuration',
           'environment','variable','css','color','font','icon','label',
           'text','string','toggle','theme','dark-mode','pagination',
           'dependency','bump','version','keyboard','shortcut','placeholder']),
  // Level 3 — medium
  new Set(['feature','implement','create','build','endpoint','route',
           'handler','controller','test','unit-test','integration-test',
           'e2e','coverage','mock','refactor','cleanup','reorganize',
           'extract','split','merge','bug','fix','error','exception',
           'edge-case','validation','middleware','grpc','health-check',
           'rate-limiting','pagination','asyncio','async','port']),
  // Level 4 — hard
  new Set(['performance','optimize','benchmark','profiling','memory-leak',
           'latency','security','vulnerability','cve','injection','xss',
           'csrf','audit','architecture','design','system','scalability',
           'migration','database-migration','data-migration','schema-change',
           'concurrency','race-condition','deadlock','thread-safety','lock-free',
           'distributed','tracing','observability','opentelemetry','jwt',
           'authentication','refresh-token','rotation','websocket','n+1',
           'zero-copy','unsafe','gc','atomic']),
  // Level 5 — expert
  new Set(['cryptography','encryption','decryption','signing','certificate',
           'tls','ssl','consensus','distributed-consensus','raft','paxos',
           'byzantine','compiler','parser-generator','ast','code-generation',
           'llvm','kernel','driver','syscall','interrupt','bare-metal',
           'protocol-design','specification','rfc','wire-format','binary-protocol',
           'zero-knowledge','proof','formal-verification','wasm','sandbox',
           'wasmtime','blake3','cbor','zero-copy','arena-allocator','unsafe']),
];

const DIFF_LABELS = ['Trivial', 'Easy', 'Medium', 'Hard', 'Expert'];

function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/```[\s\S]*?```/g, ' ')  // strip code blocks
    .replace(/[^a-z0-9#+\-_./]/g, ' ')
    .split(/\s+/)
    .map(t => t.replace(/^[^a-z0-9#]+|[^a-z0-9]+$/g, ''))
    .filter(t => t.length > 1 && !STOP_WORDS.has(t));
}

export function parseIssue(title, body) {
  const tokens = tokenize(`${title} ${body} ${title}`); // weight title double

  // Score keywords by frequency × category weight
  const scores = new Map();
  for (const token of tokens) {
    for (const [, { weight, terms }] of Object.entries(KEYWORDS)) {
      if (terms.has(token)) {
        scores.set(token, (scores.get(token) || 0) + weight);
      }
    }
  }

  // Sort by score descending
  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  const keywords    = ranked.slice(0, 10).map(([k]) => k);
  const topKeywords = ranked.slice(0, 3).map(([k]) => k);

  // Difficulty: highest level where any signal word appears in tokens
  const tokenSet = new Set(tokens);
  // Also check bigrams (e.g. "memory leak", "race condition")
  const bigrams = new Set();
  for (let i = 0; i < tokens.length - 1; i++) {
    bigrams.add(`${tokens[i]}-${tokens[i+1]}`);
  }
  const allTokens = new Set([...tokenSet, ...bigrams]);

  let difficulty = 1;
  for (let level = 4; level >= 0; level--) {
    for (const sig of DIFFICULTY_SIGNALS[level]) {
      if (allTokens.has(sig) || tokenSet.has(sig)) {
        if (level + 1 > difficulty) difficulty = level + 1;
        break;
      }
    }
    if (difficulty === level + 1) break;
  }

  // Generate a concise summary (first non-empty sentence of the body, cleaned)
  const summary = generateSummary(title, body, topKeywords);

  return { keywords, topKeywords, difficulty, summary };
}

function generateSummary(title, body, topKeywords) {
  // Try to pull first sentence from body that's meaningful
  const sentences = body
    .replace(/```[\s\S]*?```/g, '')
    .replace(/#bounty/gi, '')
    .split(/\.\s+|\n\n/)
    .map(s => s.trim().replace(/\s+/g, ' '))
    .filter(s => s.length > 20 && s.length < 200 && !/^https?:\/\//.test(s));

  if (sentences.length > 0) {
    const s = sentences[0].replace(/\*+/g, '').trim();
    return s.endsWith('.') ? s : s + '.';
  }

  // Fallback: rephrase the title
  return `${title} — involves ${topKeywords.slice(0, 2).join(' and ')}.`;
}

// ── Optional: Claude API mode ─────────────────────────────────────────────

export async function parseIssueWithAPI(title, body, apiKey) {
  const prompt = `You are a code issue analyzer for a bounty system. Given a GitHub-style issue, extract structured data.

Return ONLY valid JSON with these exact fields:
{
  "keywords": ["exactly 10 technical keywords: languages, frameworks, concepts, tools"],
  "topKeywords": ["3 most relevant from the list above"],
  "difficulty": 3,
  "summary": "One concise sentence describing the task."
}

Difficulty scale: 1=Trivial (typos/docs), 2=Easy (small UI), 3=Medium (features/refactors), 4=Hard (perf/security/architecture), 5=Expert (cryptography/protocols/compilers).

Issue Title: ${title}
Issue Body: ${body}`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 256,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) throw new Error(`Claude API error: ${res.status}`);
  const data = await res.json();
  const text = data.content[0]?.text || '';
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON in API response');
  return JSON.parse(jsonMatch[0]);
}
