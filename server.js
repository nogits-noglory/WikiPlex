'use strict';
const express  = require('express');
const cors     = require('cors');
const { Pool } = require('pg');
const { spawn } = require('child_process');
const crypto   = require('crypto');
require('dotenv').config();

const app  = express();
const PORT = process.env.PORT || 3001;

// Trust the nginx reverse proxy so req.ip is the real client IP, not 127.0.0.1
app.set('trust proxy', 1);

/* ── PostgreSQL pool ─────────────────────────────────────────────── */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL ||
    'postgresql://localhost/wikifold',
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on('error', (err) => {
  console.error('PostgreSQL pool error:', err.message);
});

/* ── Security headers ────────────────────────────────────────────── */
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  res.setHeader('Content-Security-Policy', "default-src 'none'");
  next();
});

/* ── Require application/json for mutation routes ────────────────── */
app.use('/api/generate', (req, res, next) => {
  if (req.method === 'POST' && !req.is('application/json')) {
    return res.status(415).json({ error: 'Content-Type must be application/json' });
  }
  next();
});

/* ── Rate limiting (in-memory) ───────────────────────────────────── */
const rateLimitMap = new Map();
const RATE_LIMIT   = 12;
const RATE_WINDOW  = 60 * 1000;
const DAILY_LIMIT  = 80;
const DAILY_WINDOW = 24 * 60 * 60 * 1000;

function rateLimit(req, res, next) {
  const ip  = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  let entry = rateLimitMap.get(ip);
  if (!entry) {
    entry = { count: 0, resetAt: now + RATE_WINDOW, dayCount: 0, dayResetAt: now + DAILY_WINDOW };
  }
  if (now > entry.resetAt)    { entry.count    = 0; entry.resetAt    = now + RATE_WINDOW;  }
  if (now > entry.dayResetAt) { entry.dayCount  = 0; entry.dayResetAt = now + DAILY_WINDOW; }
  entry.count++;
  entry.dayCount++;
  rateLimitMap.set(ip, entry);
  if (entry.count    > RATE_LIMIT)  return res.status(429).json({ error: 'Too many requests — slow down a bit.' });
  if (entry.dayCount > DAILY_LIMIT) return res.status(429).json({ error: 'Daily request limit reached.' });
  next();
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap) {
    if (now > entry.dayResetAt) rateLimitMap.delete(ip);
  }
}, 5 * 60 * 1000);

const allowedOrigin = process.env.ALLOWED_ORIGIN || '*';
app.use(cors({ origin: allowedOrigin }));
app.use(express.json({ limit: '512kb' }));

/* ── API request logging ─────────────────────────────────────────── *
 * Every request is logged to api_log with real client IP, path,
 * status code, and origin/referer. Rows older than 90 days are pruned
 * daily. View recent logs via GET /api/admin/logs with ADMIN_KEY.
 * ─────────────────────────────────────────────────────────────────── */
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS api_log (
        id         BIGSERIAL PRIMARY KEY,
        ts         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        ip         TEXT,
        method     TEXT,
        path       TEXT,
        status     INT,
        body_bytes INT,
        ua         TEXT,
        origin     TEXT,
        referer    TEXT
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_api_log_ts ON api_log (ts DESC)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_api_log_ip ON api_log (ip)`);
  } catch (e) { console.error('api_log init error:', e.message); }
})();

// Prune logs older than 90 days, once per day
setInterval(async () => {
  try { await pool.query(`DELETE FROM api_log WHERE ts < NOW() - INTERVAL '90 days'`); }
  catch {}
}, 24 * 60 * 60 * 1000);

app.use((req, res, next) => {
  res.on('finish', () => {
    pool.query(
      `INSERT INTO api_log (ip, method, path, status, body_bytes, ua, origin, referer)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        req.ip || 'unknown',
        req.method,
        req.path.slice(0, 200),
        res.statusCode,
        parseInt(req.headers['content-length'] || '0') || null,
        (req.headers['user-agent']  || '').slice(0, 300),
        (req.headers['origin']      || '').slice(0, 200),
        (req.headers['referer']     || '').slice(0, 500),
      ]
    ).catch(() => {});
  });
  next();
});

/* ── Origin enforcement for expensive/write endpoints ───────────────
 * If ALLOWED_ORIGIN is set to a real domain (not *), any POST to
 * /api/generate, /api/pathfind, or /api/classify that arrives with an
 * Origin header that does not match is rejected 403.
 *
 * Requests with no Origin header (curl, server-side) are blocked too
 * unless the request also carries X-Admin-Key matching ADMIN_KEY.
 * ─────────────────────────────────────────────────────────────────── */
const TRUSTED_ORIGINS = allowedOrigin === '*'
  ? null  // null = wildcard, no enforcement
  : allowedOrigin.split(',').map(s => s.trim()).filter(Boolean);

function requireTrustedOrigin(req, res, next) {
  if (!TRUSTED_ORIGINS) return next(); // wildcard mode — no enforcement

  const origin   = req.headers['origin']       || '';
  const adminKey = req.headers['x-admin-key']  || '';

  // Requests with a valid admin key bypass origin check (server-side tools)
  if (process.env.ADMIN_KEY && adminKey === process.env.ADMIN_KEY) return next();

  if (!origin) {
    // No Origin header: could be a direct API probe. Block unless referer matches.
    const referer = req.headers['referer'] || '';
    const ok = TRUSTED_ORIGINS.some(o => referer.startsWith(o));
    if (!ok) return res.status(403).json({ error: 'Forbidden' });
    return next();
  }

  if (!TRUSTED_ORIGINS.includes(origin)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
}

/* ────────────────────────────────────────────────────────────────── */
/*  GRAPH API                                                         */
/* ────────────────────────────────────────────────────────────────── */

/* ── GET /api/health ─────────────────────────────────────────────── */
app.get('/api/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, db: 'connected' });
  } catch {
    res.json({ ok: true, db: 'unavailable' });
  }
});

/* ── GET /api/graph ──────────────────────────────────────────────── *
 * Returns the full classified graph: nodes + edges.
 * Optional query params: ?domain=history&type=canonical
 * ─────────────────────────────────────────────────────────────────── */
app.get('/api/graph', async (req, res) => {
  try {
    const { domain, type } = req.query;

    let nodeQuery = `
      SELECT id, title, classified, article_type,
             depth_score, shareability_score, weird_factor,
             curriculum_worthy, curiosity_hook,
             primary_domain, domains, era, primary_geography,
             geography, key_figures, linguistic_root,
             related_concepts, disambiguation_risks,
             nav_style_signal, gap_assessment,
             thumbnail_url, visit_count, classified_at
      FROM nodes
      WHERE classified = true
    `;
    const nodeParams = [];
    if (domain) {
      nodeParams.push(domain);
      nodeQuery += ` AND primary_domain = $${nodeParams.length}`;
    }
    if (type) {
      nodeParams.push(type);
      nodeQuery += ` AND article_type = $${nodeParams.length}`;
    }
    nodeQuery += ' ORDER BY classified_at DESC';

    const edgeQuery = `
      SELECT from_node AS "from", to_node AS "to",
             edge_type AS type, predicate, weight,
             edge_source AS source, source_sentence, created_at
      FROM edges
      WHERE from_node IN (
        SELECT id FROM nodes WHERE classified = true
      )
      ORDER BY created_at DESC
      LIMIT 50000
    `;

    const [nodesResult, edgesResult] = await Promise.all([
      pool.query(nodeQuery, nodeParams),
      pool.query(edgeQuery),
    ]);

    // Convert rows to keyed object matching graph.json shape
    const nodes = {};
    for (const row of nodesResult.rows) {
      nodes[row.id] = row;
    }

    res.json({
      nodes,
      edges: edgesResult.rows,
      meta: {
        node_count:  nodesResult.rowCount,
        edge_count:  edgesResult.rowCount,
        generated_at: new Date().toISOString(),
      },
    });
  } catch (err) {
    console.error('/api/graph error:', err.message);
    res.status(500).json({ error: 'Database error' });
  }
});

/* ── GET /api/graph/stream ───────────────────────────────────────── *
 * SSE endpoint. Pushes graph_events as they land in the DB.
 * Polls every 2 seconds for new events since last seen id.
 * ─────────────────────────────────────────────────────────────────── */
app.get('/api/graph/stream', (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  // Override the default restrictive CSP for SSE
  res.setHeader('Content-Security-Policy', "default-src 'none'");
  res.flushHeaders();

  // Send a comment heartbeat immediately so the client knows the stream is alive
  res.write(': connected\n\n');

  let lastId = 0;
  let closed = false;

  const poll = async () => {
    if (closed) return;
    try {
      const result = await pool.query(
        `SELECT id, event_type, node_id, payload, created_at
         FROM graph_events
         WHERE id > $1
         ORDER BY id ASC
         LIMIT 50`,
        [lastId]
      );
      for (const row of result.rows) {
        if (closed) break;
        lastId = row.id;
        const data = JSON.stringify({
          type:       row.event_type,
          node_id:    row.node_id,
          payload:    row.payload,
          created_at: row.created_at,
        });
        res.write(`data: ${data}\n\n`);
      }
    } catch (err) {
      if (!closed) console.error('SSE poll error:', err.message);
    }
    if (!closed) setTimeout(poll, 2000);
  };

  // Start from current max event ID so this connection only receives
  // events that occur AFTER the client connects — never replays history.
  pool.query('SELECT COALESCE(MAX(id), 0) AS max_id FROM graph_events')
    .then(r => { lastId = r.rows[0].max_id; })
    .catch(() => {})
    .finally(() => { if (!closed) poll(); });

  // Keep-alive ping every 20s
  const pingInterval = setInterval(() => {
    if (!closed) res.write(': ping\n\n');
  }, 20_000);

  req.on('close', () => {
    closed = true;
    clearInterval(pingInterval);
  });
});

/* ── GET /api/node/:title ────────────────────────────────────────── *
 * Returns a single node's classification + curriculum.
 * Title is URL-encoded (spaces as %20 or +).
 * ─────────────────────────────────────────────────────────────────── */
app.get('/api/node/:title', async (req, res) => {
  const title = decodeURIComponent(req.params.title).trim();
  if (!title || title.length > 300) {
    return res.status(400).json({ error: 'Invalid title' });
  }

  try {
    const [nodeResult, currResult] = await Promise.all([
      pool.query('SELECT * FROM nodes WHERE id = $1', [title]),
      pool.query('SELECT data, generated_at FROM curricula WHERE node_id = $1', [title]),
    ]);

    if (nodeResult.rowCount === 0) {
      return res.status(404).json({ error: 'Node not found', title });
    }

    const node = nodeResult.rows[0];
    const curriculum = currResult.rowCount > 0 ? currResult.rows[0].data : null;
    const generated_at = currResult.rowCount > 0 ? currResult.rows[0].generated_at : null;

    res.json({ node, curriculum, generated_at });
  } catch (err) {
    console.error('/api/node error:', err.message);
    res.status(500).json({ error: 'Database error' });
  }
});

/* ── GET /api/search?q= ──────────────────────────────────────────── *
 * Case-insensitive full-text title search across classified nodes.
 * Falls back gracefully to an empty array on no match.
 * ─────────────────────────────────────────────────────────────────── */
app.get('/api/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q || q.length < 2 || q.length > 200) {
    return res.status(400).json({ error: 'Query must be 2–200 characters' });
  }

  try {
    const result = await pool.query(
      `SELECT id, title, article_type, primary_domain, depth_score,
              weird_factor, curiosity_hook, era, primary_geography
       FROM nodes
       WHERE classified = true
         AND title ILIKE $1
       ORDER BY depth_score DESC NULLS LAST
       LIMIT 20`,
      [`%${q}%`]
    );
    res.json({ results: result.rows, query: q });
  } catch (err) {
    console.error('/api/search error:', err.message);
    res.status(500).json({ error: 'Database error' });
  }
});

/* ── GET /api/random ─────────────────────────────────────────────── *
 * Returns one random classified node (weighted toward high depth).
 * If DB is empty, falls back to Wikipedia's random article API.
 * ─────────────────────────────────────────────────────────────────── */
app.get('/api/random', async (_req, res) => {
  try {
    const wikiRes = await fetch(
      'https://en.wikipedia.org/w/api.php?action=query&list=random&rnnamespace=0&rnlimit=1&format=json&origin=*',
      { headers: { 'User-Agent': 'WikiFold/0.1 (learning graph project)' }, signal: AbortSignal.timeout(10_000) }
    );
    const wikiData = await wikiRes.json();
    const wikiTitle = wikiData.query.random[0].title;
    res.json({ source: 'wikipedia', title: wikiTitle });
  } catch (err) {
    console.error('/api/random error:', err.message);
    res.status(500).json({ error: 'Failed to fetch random article' });
  }
});

/* ── GET /api/stats ──────────────────────────────────────────────── *
 * Quick dashboard numbers for the landing page counter.
 * ─────────────────────────────────────────────────────────────────── */
app.get('/api/stats', async (_req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM nodes WHERE classified = true)          AS node_count,
        (SELECT COUNT(*) FROM edges)                                  AS edge_count,
        (SELECT COUNT(*) FROM frontier)                               AS frontier_count,
        (SELECT COUNT(*) FROM curricula)                              AS curriculum_count,
        (SELECT MAX(classified_at) FROM nodes WHERE classified = true) AS last_classified
    `);
    res.json(result.rows[0]);
  } catch (err) {
    console.error('/api/stats error:', err.message);
    res.status(500).json({ error: 'Database error' });
  }
});

/* ────────────────────────────────────────────────────────────────── */
/*  WIKIDACTIC (existing curriculum generation proxy)                 */
/* ────────────────────────────────────────────────────────────────── */

function sanitizeInput(str) {
  return str.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

const SYSTEM_PROMPT = 'You are an expert curriculum designer. You ALWAYS respond with valid JSON only — no markdown fences, no preamble, no trailing text.';

app.post('/api/generate', requireTrustedOrigin, rateLimit, async (req, res) => {
  if (process.env.GENERATE_ENABLED === 'false') {
    return res.status(503).json({ error: 'Service disabled' });
  }

  const { user, maxTokens = 7000 } = req.body;
  const unknownKeys = Object.keys(req.body).filter(k => !['user', 'maxTokens'].includes(k));
  if (unknownKeys.length > 0) return res.status(400).json({ error: 'Unexpected fields in request' });
  if (!user)                   return res.status(400).json({ error: 'Missing user field' });
  if (typeof user !== 'string') return res.status(400).json({ error: 'Invalid input type' });
  if (user.length > 25000)     return res.status(400).json({ error: 'Input too large' });

  const safeUser = sanitizeInput(user);
  if (safeUser.length === 0) return res.status(400).json({ error: 'Input empty after sanitization' });

  const safeMaxTokens = Math.min(Math.max(parseInt(maxTokens, 10) || 7000, 100), 8000);

  if (!process.env.LLM_API_KEY) {
    return res.status(500).json({ error: 'LLM_API_KEY not configured on server' });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);

  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      signal:  controller.signal,
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         process.env.LLM_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      process.env.MODEL || 'claude-haiku-4-5-20251001',
        max_tokens: safeMaxTokens,
        system:     SYSTEM_PROMPT,
        messages:   [{ role: 'user', content: safeUser }],
      }),
    });

    clearTimeout(timeout);
    const data = await upstream.json();
    if (!upstream.ok) {
      return res.status(upstream.status).json({ error: data.error?.message || 'API error' });
    }
    res.json(data);

  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') return res.status(504).json({ error: 'Upstream request timed out' });
    console.error('Proxy error:', err.message);
    res.status(502).json({ error: 'Upstream request failed' });
  }
});

/* ── POST /api/classify ──────────────────────────────────────────── *
 * Queues a Wikipedia article for classification into the graph.
 * ─────────────────────────────────────────────────────────────────── */
app.post('/api/classify', requireTrustedOrigin, rateLimit, async (req, res) => {
  const { title } = req.body;
  if (!title || typeof title !== 'string' || title.trim().length < 1) {
    return res.status(400).json({ error: 'Missing or invalid title' });
  }
  const clean = title.trim().slice(0, 300);
  try {
    // Already fully classified — no point re-queuing
    const nodeCheck = await pool.query(
      'SELECT id FROM nodes WHERE id = $1 AND classified = true',
      [clean]
    );
    if (nodeCheck.rowCount > 0) {
      return res.status(200).json({ status: 'already_classified', title: clean });
    }

    // Already sitting in the queue
    const frontierCheck = await pool.query(
      'SELECT id FROM frontier WHERE id = $1',
      [clean]
    );
    if (frontierCheck.rowCount > 0) {
      return res.status(200).json({ status: 'already_queued', title: clean });
    }

    await pool.query(
      `INSERT INTO frontier (id, title, added_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (id) DO NOTHING`,
      [clean, clean]
    );
    return res.status(202).json({ status: 'queued', title: clean });
  } catch (err) {
    console.error('/api/classify error:', err.message);
    return res.status(500).json({ error: 'Could not queue article' });
  }
});

/* ── POST /api/curriculum ────────────────────────────────────────── *
 * Stores a generated curriculum in the DB so it can be served later.
 * ─────────────────────────────────────────────────────────────────── */
app.post('/api/curriculum', rateLimit, async (req, res) => {
  const { title, data } = req.body;
  if (!title || typeof title !== 'string' || !data || typeof data !== 'object') {
    return res.status(400).json({ error: 'Missing title or data' });
  }
  const clean = title.trim().slice(0, 300);
  try {
    await pool.query(
      `INSERT INTO curricula (node_id, data, generated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (node_id) DO UPDATE SET data = EXCLUDED.data, generated_at = NOW()`,
      [clean, JSON.stringify(data)]
    );
    return res.json({ saved: true });
  } catch (err) {
    console.error('/api/curriculum error:', err.message);
    return res.status(500).json({ error: 'Could not save curriculum' });
  }
});

/* ════════════════════════════════════════════════════════════════════
   KNOWLEDGE PATH FINDER
   ════════════════════════════════════════════════════════════════════ */

const PIPELINE_PATH = process.env.PIPELINE_PATH || '/var/www/wikidactic/pipeline.py';

/* Ensure thumbnail_url column exists on nodes table */
(async () => {
  try {
    await pool.query(`ALTER TABLE nodes ADD COLUMN IF NOT EXISTS thumbnail_url TEXT`);
  } catch (e) {
    console.error('thumbnail_url migration error:', e.message);
  }
})();

/* Create pathfind_sessions table on startup */
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS pathfind_sessions (
        id           TEXT PRIMARY KEY,
        from_title   TEXT NOT NULL,
        to_title     TEXT NOT NULL,
        status       TEXT NOT NULL DEFAULT 'queued',
        events       JSONB NOT NULL DEFAULT '[]',
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        started_at   TIMESTAMPTZ,
        completed_at TIMESTAMPTZ
      )
    `);
  } catch (e) {
    console.error('pathfind_sessions table error:', e.message);
  }
})();

/* Live SSE clients: sessionId -> Set<res> */
const pathSseClients = new Map();

/* Worker queue */
const pathQueue = [];
let pathWorkerRunning = false;

/* Store event in DB and push to live SSE clients */
async function pathEmit(sessionId, type, data) {
  const ev = { type, data, ts: Date.now() };
  try {
    await pool.query(
      `UPDATE pathfind_sessions SET events = events || $1::jsonb WHERE id = $2`,
      [JSON.stringify([ev]), sessionId]
    );
  } catch (e) {
    console.error('pathEmit DB error:', e.message);
  }
  const clients = pathSseClients.get(sessionId);
  if (clients) {
    const msg = `data: ${JSON.stringify({ type, ...data })}\n\n`;
    for (const res of clients) { try { res.write(msg); } catch {} }
  }
}

/* Spawn pipeline.py for a single article; resolves when classified */
function classifyTitle(title) {
  return new Promise(async (resolve, reject) => {
    try {
      const check = await pool.query(
        'SELECT id FROM nodes WHERE id = $1 AND classified = true', [title]
      );
      if (check.rowCount > 0) return resolve();
    } catch {}

    const proc = spawn('python3', [PIPELINE_PATH, title], { env: { ...process.env } });
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.stdout.on('data', () => {});

    const timer = setTimeout(() => { proc.kill('SIGTERM'); reject(new Error('timeout')); }, 90_000);
    proc.on('close', code => {
      clearTimeout(timer);
      if (code === 0)      resolve();
      else if (code === 2) reject(new Error('article_not_found'));
      else                 reject(new Error(`pipeline_exit_${code}`));
    });
    proc.on('error', e => { clearTimeout(timer); reject(e); });
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* Load all AI-inferred + semantic edges originating from a node */
async function getNodeEdges(title) {
  const r = await pool.query(`
    SELECT from_node, to_node, edge_type, predicate, weight, edge_source
    FROM edges
    WHERE from_node = $1
      AND edge_source IN ('ai_inference', 'embedding_similarity')
    ORDER BY weight DESC NULLS LAST, edge_type
  `, [title]);
  return r.rows;
}

/* Main pathfind orchestrator
 *
 * Algorithm:
 *   1. Classify both endpoints (if not already done).
 *   2. Load every AI-inferred edge for each endpoint — these are the
 *      "branches" that radiate out from each node.
 *   3. Emit those branches to the client one at a time for animation.
 *   4. Intersection of the two ghost-neighbor sets = 1-hop typed paths.
 *   5. Check already-classified intermediaries for 2-hop paths.
 *   6. Queue all unclassified ghost nodes in the frontier so the graph
 *      can deepen and the path can be re-run for richer results later.
 */
async function runPathfind(sessionId, fromTitle, toTitle) {

  // ── 1. Classify FROM ────────────────────────────────────────────────
  await pathEmit(sessionId, 'status', { msg: `Classifying "${fromTitle}"...` });
  try { await classifyTitle(fromTitle); }
  catch (e) { await pathEmit(sessionId, 'warn', { msg: `Could not classify "${fromTitle}": ${e.message}` }); }
  const fromRow = await pool.query('SELECT * FROM nodes WHERE id = $1', [fromTitle]);
  await pathEmit(sessionId, 'node_ready', {
    node: fromRow.rows[0] || { id: fromTitle, title: fromTitle },
    role: 'from',
  });

  // ── 2. Classify TO ──────────────────────────────────────────────────
  await pathEmit(sessionId, 'status', { msg: `Classifying "${toTitle}"...` });
  try { await classifyTitle(toTitle); }
  catch (e) { await pathEmit(sessionId, 'warn', { msg: `Could not classify "${toTitle}": ${e.message}` }); }
  const toRow = await pool.query('SELECT * FROM nodes WHERE id = $1', [toTitle]);
  await pathEmit(sessionId, 'node_ready', {
    node: toRow.rows[0] || { id: toTitle, title: toTitle },
    role: 'to',
  });

  // ── 3. Load typed edges ─────────────────────────────────────────────
  await pathEmit(sessionId, 'status', { msg: 'Mapping connections...' });
  const [fromEdges, toEdges] = await Promise.all([
    getNodeEdges(fromTitle),
    getNodeEdges(toTitle),
  ]);

  // ── 4. Emit FROM branches (paced for client animation) ──────────────
  for (const e of fromEdges) {
    await pathEmit(sessionId, 'branch', {
      from: e.from_node, to: e.to_node,
      edge_type: e.edge_type, predicate: e.predicate || '',
      source: e.edge_source, side: 'from',
    });
    await sleep(45);
  }

  // ── 5. Emit TO branches ─────────────────────────────────────────────
  for (const e of toEdges) {
    await pathEmit(sessionId, 'branch', {
      from: e.from_node, to: e.to_node,
      edge_type: e.edge_type, predicate: e.predicate || '',
      source: e.edge_source, side: 'to',
    });
    await sleep(45);
  }

  // ── 6. Find 1-hop paths: shared ghost neighbors ─────────────────────
  await pathEmit(sessionId, 'status', { msg: 'Finding connections...' });

  // Map: ghost_title -> all FROM edges that point to it
  const fromMap = new Map();
  for (const e of fromEdges) {
    if (!fromMap.has(e.to_node)) fromMap.set(e.to_node, []);
    fromMap.get(e.to_node).push(e);
  }

  let found = 0;
  for (const te of toEdges) {
    if (fromMap.has(te.to_node)) {
      for (const fe of fromMap.get(te.to_node)) {
        await pathEmit(sessionId, 'path_found', {
          path_type: fe.edge_type,
          via:       te.to_node,
          nodes:     [fromTitle, te.to_node, toTitle],
          edges:     [fe, te],
          hops:      1,
        });
        found++;
      }
    }
  }

  // ── 7. Find 2-hop paths through already-classified intermediaries ────
  const classifiedRes = await pool.query(
    `SELECT id FROM nodes WHERE classified = true AND id NOT IN ($1, $2)`,
    [fromTitle, toTitle]
  );
  for (const { id: mid } of classifiedRes.rows) {
    const midEdges   = await getNodeEdges(mid);
    const midTargets = new Set(midEdges.map(e => e.to_node));

    const connectsFrom = fromEdges.some(e => e.to_node === mid) || midTargets.has(fromTitle);
    const connectsTo   = toEdges.some(e => e.to_node === mid)   || midTargets.has(toTitle);

    if (connectsFrom && connectsTo) {
      const fe = fromEdges.find(e => e.to_node === mid) || midEdges.find(e => e.to_node === fromTitle);
      const te = toEdges.find(e => e.to_node === mid)   || midEdges.find(e => e.to_node === toTitle);
      const midNodeRow = await pool.query('SELECT * FROM nodes WHERE id = $1', [mid]);
      if (midNodeRow.rowCount > 0) {
        await pathEmit(sessionId, 'node_ready', { node: midNodeRow.rows[0], role: 'intermediate' });
      }
      await pathEmit(sessionId, 'path_found', {
        path_type: fe?.edge_type || 'categorical',
        via:   mid,
        nodes: [fromTitle, mid, toTitle],
        edges: [fe, te].filter(Boolean),
        hops:  2,
      });
      found++;
    }
  }

  // ── 8. Queue all ghost nodes for future classification ───────────────
  const classifiedSet = new Set([fromTitle, toTitle, ...classifiedRes.rows.map(r => r.id)]);
  const allGhosts = [...new Set([
    ...fromEdges.map(e => e.to_node),
    ...toEdges.map(e => e.to_node),
  ])].filter(g => !classifiedSet.has(g));

  let queued = 0;
  for (const ghost of allGhosts) {
    try {
      const r = await pool.query(
        `INSERT INTO frontier (id, title, added_at)
         VALUES ($1, $2, NOW()) ON CONFLICT (id) DO NOTHING RETURNING id`,
        [ghost, ghost]
      );
      if (r.rowCount > 0) queued++;
    } catch {}
  }

  const summary = found > 0
    ? `${found} connection${found !== 1 ? 's' : ''} found — ${queued} articles queued for deeper paths`
    : `No direct connections yet — ${queued} articles queued for future classification`;

  await pathEmit(sessionId, 'status',   { msg: summary });
  await pathEmit(sessionId, 'complete', { found, queued, from: fromTitle, to: toTitle });
}

/* Worker: pulls one session from queue and runs it */
async function startPathWorker() {
  if (pathWorkerRunning || !pathQueue.length) return;
  pathWorkerRunning = true;
  const sessionId = pathQueue.shift();

  try {
    const sess = await pool.query('SELECT * FROM pathfind_sessions WHERE id = $1', [sessionId]);
    if (!sess.rowCount) { pathWorkerRunning = false; return; }
    const { from_title, to_title } = sess.rows[0];

    await pool.query(
      `UPDATE pathfind_sessions SET status = 'running', started_at = NOW() WHERE id = $1`,
      [sessionId]
    );
    await runPathfind(sessionId, from_title, to_title);
    await pool.query(
      `UPDATE pathfind_sessions SET status = 'complete', completed_at = NOW() WHERE id = $1`,
      [sessionId]
    );
  } catch (err) {
    console.error('Pathfind worker error:', err.message);
    try {
      await pathEmit(sessionId, 'error', { message: err.message });
      await pool.query(`UPDATE pathfind_sessions SET status = 'error' WHERE id = $1`, [sessionId]);
    } catch {}
  } finally {
    pathWorkerRunning = false;
    if (pathQueue.length) setTimeout(startPathWorker, 50);
  }
}

/* On restart: re-queue any sessions that were 'running' (they stalled) */
(async () => {
  try {
    const stalled = await pool.query(
      `UPDATE pathfind_sessions SET status = 'queued', started_at = NULL
       WHERE status IN ('running', 'queued')
       RETURNING id`
    );
    for (const row of stalled.rows) {
      pathQueue.push(row.id);
    }
    if (pathQueue.length) setTimeout(startPathWorker, 2000);
  } catch {}
})();

/* ── POST /api/pathfind ───────────────────────────────────────────── */
app.post('/api/pathfind', requireTrustedOrigin, rateLimit, async (req, res) => {
  const { from, to } = req.body;
  if (!from || !to || typeof from !== 'string' || typeof to !== 'string') {
    return res.status(400).json({ error: 'from and to required' });
  }
  const cleanFrom = from.trim().slice(0, 300);
  const cleanTo   = to.trim().slice(0, 300);
  if (!cleanFrom || !cleanTo) return res.status(400).json({ error: 'Invalid titles' });
  if (cleanFrom === cleanTo)  return res.status(400).json({ error: 'from and to must differ' });

  try {
    const sessionId = crypto.randomBytes(12).toString('hex');
    await pool.query(
      `INSERT INTO pathfind_sessions (id, from_title, to_title) VALUES ($1, $2, $3)`,
      [sessionId, cleanFrom, cleanTo]
    );

    const aheadRes = await pool.query(
      `SELECT COUNT(*) FROM pathfind_sessions
       WHERE status IN ('queued','running') AND id != $1`,
      [sessionId]
    );
    const ahead = parseInt(aheadRes.rows[0].count, 10);

    pathQueue.push(sessionId);
    setTimeout(startPathWorker, 10);

    res.json({ sessionId, ahead, from: cleanFrom, to: cleanTo });
  } catch (err) {
    console.error('/api/pathfind error:', err.message);
    res.status(500).json({ error: 'Could not create path session' });
  }
});

/* ── GET /api/pathfind/stream/:sessionId ─────────────────────────── */
app.get('/api/pathfind/stream/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  if (!sessionId || !/^[0-9a-f]{24}$/.test(sessionId)) {
    return res.status(400).json({ error: 'Invalid session ID' });
  }

  try {
    const sess = await pool.query(
      'SELECT events FROM pathfind_sessions WHERE id = $1', [sessionId]
    );
    if (!sess.rowCount) return res.status(404).json({ error: 'Session not found' });

    res.setHeader('Content-Type',  'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection',    'keep-alive');
    res.setHeader('Content-Security-Policy', "default-src 'none'");
    res.flushHeaders();
    res.write(': connected\n\n');

    /* Replay stored events */
    for (const ev of (sess.rows[0].events || [])) {
      res.write(`data: ${JSON.stringify({ type: ev.type, ...ev.data })}\n\n`);
    }

    /* Register as live client */
    if (!pathSseClients.has(sessionId)) pathSseClients.set(sessionId, new Set());
    pathSseClients.get(sessionId).add(res);

    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 20_000);
    req.on('close', () => {
      clearInterval(ping);
      const set = pathSseClients.get(sessionId);
      if (set) { set.delete(res); if (!set.size) pathSseClients.delete(sessionId); }
    });
  } catch (err) {
    console.error('/api/pathfind/stream error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'Stream error' });
  }
});

/* ── GET /api/pathfind/status/:sessionId ─────────────────────────── */
app.get('/api/pathfind/status/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  if (!sessionId || !/^[0-9a-f]{24}$/.test(sessionId)) {
    return res.status(400).json({ error: 'Invalid session ID' });
  }
  try {
    const result = await pool.query(
      `SELECT id, from_title, to_title, status, created_at, started_at, completed_at
       FROM pathfind_sessions WHERE id = $1`,
      [sessionId]
    );
    if (!result.rowCount) return res.status(404).json({ error: 'Session not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('/api/pathfind/status error:', err.message);
    res.status(500).json({ error: 'DB error' });
  }
});

/* ── GET /api/admin/logs ─────────────────────────────────────────── *
 * Returns recent API log entries. Requires X-Admin-Key header or
 * ?key= query param matching ADMIN_KEY in .env
 * Optional: ?limit=200&ip=1.2.3.4&path=/api/generate
 * ─────────────────────────────────────────────────────────────────── */
app.get('/api/admin/logs', async (req, res) => {
  const provided = req.headers['x-admin-key'] || req.query.key || '';
  if (!process.env.ADMIN_KEY || provided !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const limit  = Math.min(parseInt(req.query.limit  || '200', 10), 2000);
  const ipFilt = req.query.ip   || null;
  const pfFilt = req.query.path || null;

  try {
    let q      = `SELECT id, ts, ip, method, path, status, body_bytes, ua, origin, referer
                  FROM api_log WHERE 1=1`;
    const params = [];
    if (ipFilt) { params.push(ipFilt);  q += ` AND ip = $${params.length}`; }
    if (pfFilt) { params.push(pfFilt);  q += ` AND path = $${params.length}`; }
    q += ` ORDER BY ts DESC LIMIT $${params.length + 1}`;
    params.push(limit);

    const result = await pool.query(q, params);
    res.json({ count: result.rowCount, rows: result.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ── GET /api/admin/stats ────────────────────────────────────────── *
 * Summary stats for the last 24h — top IPs and paths by hit count.
 * ─────────────────────────────────────────────────────────────────── */
app.get('/api/admin/stats', async (req, res) => {
  const provided = req.headers['x-admin-key'] || req.query.key || '';
  if (!process.env.ADMIN_KEY || provided !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const [topIps, topPaths, recentErrors] = await Promise.all([
      pool.query(`SELECT ip, COUNT(*) AS hits FROM api_log
                  WHERE ts > NOW() - INTERVAL '24 hours'
                  GROUP BY ip ORDER BY hits DESC LIMIT 20`),
      pool.query(`SELECT path, method, COUNT(*) AS hits FROM api_log
                  WHERE ts > NOW() - INTERVAL '24 hours'
                  GROUP BY path, method ORDER BY hits DESC LIMIT 20`),
      pool.query(`SELECT ts, ip, method, path, status, ua FROM api_log
                  WHERE ts > NOW() - INTERVAL '24 hours' AND status >= 400
                  ORDER BY ts DESC LIMIT 50`),
    ]);
    res.json({
      top_ips:      topIps.rows,
      top_paths:    topPaths.rows,
      recent_errors: recentErrors.rows,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ────────────────────────────────────────────────────────────────── */
app.listen(PORT, '127.0.0.1', () => {
  console.log(`WikiFold API listening on 127.0.0.1:${PORT}`);
});
