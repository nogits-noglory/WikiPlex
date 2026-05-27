'use strict';
const express = require('express');
const cors    = require('cors');
const { Pool } = require('pg');
require('dotenv').config();

const app  = express();
const PORT = process.env.PORT || 3001;

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
             visit_count, classified_at
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

  // Start polling
  poll();

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

app.post('/api/generate', rateLimit, async (req, res) => {
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
        'llm-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      process.env.MODEL || 'claude-sonnet-4-20250514',
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
app.post('/api/classify', rateLimit, async (req, res) => {
  const { title } = req.body;
  if (!title || typeof title !== 'string' || title.trim().length < 1) {
    return res.status(400).json({ error: 'Missing or invalid title' });
  }
  const clean = title.trim().slice(0, 300);
  try {
    await pool.query(
      `INSERT INTO frontier (id, title, discovered_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (id) DO NOTHING`,
      [clean, clean]
    );
    return res.status(202).json({ queued: true, title: clean });
  } catch (err) {
    console.error('/api/classify error:', err.message);
    return res.status(500).json({ error: 'Could not queue article' });
  }
});

/* ────────────────────────────────────────────────────────────────── */
app.listen(PORT, '127.0.0.1', () => {
  console.log(`WikiFold API listening on 127.0.0.1:${PORT}`);
});
