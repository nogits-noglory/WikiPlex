
'use strict';

const PROXY_API    = '/api/generate';
const GRAPH_API    = '/api/graph';
const STREAM_API   = '/api/graph/stream';
const SEARCH_API   = '/api/search';
const NODE_API     = '/api/node';
const STATS_API    = '/api/stats';
const PATHFIND_API = '/api/pathfind';
const TOPIC_MAX    = 200;

const TIERS = {
  novice:       { label:'Novice',       count:10, icon:'▷', desc:'Core concepts only.' },
  intermediate: { label:'Intermediate', count:15, icon:'▶', desc:'Deeper coverage.' },
  expert:       { label:'Expert',       count:20, icon:'◆', desc:'Full 20-question gauntlet.' },
};

function _setCookie(name, val, days) {
  const exp = new Date(Date.now() + days * 864e5).toUTCString();
  document.cookie = `${name}=${val};expires=${exp};path=/;SameSite=Lax`;
}
function _getCookie(name) {
  return document.cookie.split(';').map(c=>c.trim())
    .find(c=>c.startsWith(name+'='))?.split('=').slice(1).join('=') || '';
}
function _getUserId() {
  let uid = _getCookie('wd_uid') || localStorage.getItem('wd_uid');
  if (!uid) {
    uid = 'u' + Math.random().toString(36).slice(2,10) + Date.now().toString(36).slice(-4);
    _setCookie('wd_uid', uid, 365);
    localStorage.setItem('wd_uid', uid);
  } else {
    
    _setCookie('wd_uid', uid, 365);
  }
  return uid;
}
const USER_ID = _getUserId();

const PS = { UNTOUCHED:0, VIEWED:1, STUDIED:2, CONQUERED:3 };

function psKey(id)     { return `wd_ps_${USER_ID}_${id.toLowerCase().replace(/[^a-z0-9]/g,'_').slice(0,50)}`; }
function getPS(id)     { return parseInt(localStorage.getItem(psKey(id)) || '0', 10); }
function setPS(id, lvl){
  const cur = getPS(id);
  if (lvl > cur) {
    localStorage.setItem(psKey(id), lvl);
    refreshNodeState(id);
  }
}

/* ── Curriculum localStorage cache ── */
function curKey(title) {
  return 'wd_cur_' + title.toLowerCase().replace(/[^a-z0-9]/g,'_').slice(0,60);
}
function saveCurriculumLocal(title, cur) {
  try {
    localStorage.setItem(curKey(title), JSON.stringify({ title, curriculum: cur, savedAt: Date.now() }));
  } catch {}
}
function loadCurriculumLocal(title) {
  try {
    const d = JSON.parse(localStorage.getItem(curKey(title)) || 'null');
    return d?.curriculum || null;
  } catch { return null; }
}
function getAllStoredCurricula() {
  const out = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k?.startsWith('wd_cur_')) continue;
      const d = JSON.parse(localStorage.getItem(k) || 'null');
      if (d?.title && d?.curriculum) out.push(d);
    }
  } catch {}
  return out.sort((a,b) => (b.savedAt||0) - (a.savedAt||0));
}

const DOMAIN_COLOR = {
  mathematics:'#00b4d8', physics:'#7209b7',    chemistry:'#f77f00',
  biology:'#52b788',     medicine:'#e63946',    psychology:'#ff9f1c',
  philosophy:'#c77dff',  linguistics:'#b5838d', history:'#e9c46a',
  politics:'#e76f51',    economics:'#2a9d8f',   law:'#4895ef',
  technology:'#48cae4',  computing:'#4361ee',   engineering:'#f72585',
  art:'#f4a261',         literature:'#fcd5ce',  music:'#06d6a0',
  film:'#ef476f',        religion:'#118ab2',    mythology:'#ffd166',
  geography:'#43aa8b',   anthropology:'#8338ec',sociology:'#3a86ff',
  sports:'#fb5607',      food:'#ffbe0b',        other:'#6c757d',
};
function domainColor(d) { return DOMAIN_COLOR[d] || '#6c757d'; }

const EDGE_COLOR = {
  // Original families
  interpersonal:'#dd4444', geographical:'#2299aa',
  temporal:'#aa7700',      categorical:'#338866',
  etymological:'#7744aa',  positional:'#996600',
  // Extended families
  implication:'#e8890c',   misconception:'#cc3377',
  analogy:'#11bbaa',       influence:'#e040fb',
  application:'#26c6da',   semantic:'#9966dd',
  // Structural (Wikipedia link graph — ghost connections only)
  structural:'rgba(60,120,200,0.18)',
};
function edgeColor(e) {
  if (e._src === 'ai_inference' || e._src === 'embedding_similarity') {
    return EDGE_COLOR[e.type] || '#5566aa';
  }
  return EDGE_COLOR.structural;
}
/* Returns true for any edge type richer than a raw wiki link */
function isRichEdge(d) {
  return d._src === 'ai_inference' || d._src === 'embedding_similarity';
}
function nodeRadius(d) { return d.thumbnail_url ? 28 : 6 + (d.depth_score || 3) * 1.8; }
function nodePatternId(id) { return 'nip-' + id.replace(/[^a-z0-9]/gi, '_').slice(0, 60); }

function $(id) { return document.getElementById(id); }
function esc(s) {
  return String(s ?? '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function safeHTML(h) { return (typeof DOMPurify !== 'undefined') ? DOMPurify.sanitize(h) : h; }
function setHTML(el, h) { el.innerHTML = safeHTML(h); }
function gapBadge() { return '<span class="gap-flag">gap</span>'; }

function showToast(msg, dur=3000) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), dur);
}

/* ──────────────────────────────────────────────
   STUDY STATE
────────────────────────────────────────────── */
let state = {
  topic:'', wikiUrl:'', wikiText:'', curriculum:null,
  pretestAnswered:0, pretestScore:0,
  cardIndex:0, cardKnew:0, cardMissed:0,
  quizTier:null, quizQuestions:[], quizIndex:0, quizScore:0, quizResults:[],
};

/* ──────────────────────────────────────────────
   PANEL STATE MACHINE
   modes: idle | loading | article | node | study
────────────────────────────────────────────── */
let panelMode = 'idle';

function showPC(id) {
  ['pc-idle','pc-loading','pc-article','pc-node','pc-study','pc-pathfind']
    .forEach(pc => $(pc).classList.toggle('hidden', pc !== id));
}

function openPanel(mode) {
  panelMode = mode;
  $('detail-panel').classList.add('open');
  $('btn-back-to-map')?.classList.remove('hidden');
  // Push graph center left so nodes don't hide behind panel
  if (window.innerWidth > 768) nudgeGraph(true);
}
function closePanel() {
  // Don't let generic closePanel tear down path mode — use exitPathMode() for that
  if (panelMode === 'pathfind') return;
  $('detail-panel').classList.remove('open');
  $('study-tabs').classList.add('hidden');
  $('btn-back-to-map')?.classList.add('hidden');
  showPC('pc-idle');
  panelMode = 'idle';
  deselect();
  if (window.innerWidth > 768) nudgeGraph(false);
  renderLibrary();
}

function renderLibrary() {
  const el = $('idle-library');
  if (!el) return;
  const entries = getAllStoredCurricula();
  if (!entries.length) { el.innerHTML = ''; return; }
  const rows = entries.slice(0, 12).map(d => {
    const ps = getPS(d.title);
    const psLabel = ps >= PS.CONQUERED ? 'conquered' : ps >= PS.STUDIED ? 'studied' : 'viewed';
    const psText  = ps >= PS.CONQUERED ? '★ Conquered' : ps >= PS.STUDIED ? 'Studied' : 'Viewed';
    const domain  = d.curriculum?.dictionary?.[0] ? 'other' : 'other';
    return `<div class="lib-entry" data-action="openFromLibrary" data-title="${esc(d.title)}">
      <div class="lib-entry-title">${esc(d.title)}</div>
      <span class="lib-entry-state ${psLabel}">${psText}</span>
    </div>`;
  }).join('');
  setHTML(el, `<div class="idle-library-title">My Library</div>${rows}`);
}

function setPanelHeader(title, badge, wikiUrl) {
  $('panel-title').textContent = title;
  const b = $('panel-badge');
  if (badge) { b.textContent = badge; b.className = `panel-badge ${badge}`; b.classList.remove('hidden'); }
  else { b.classList.add('hidden'); }
  const wl = $('wiki-link');
  if (wikiUrl) { wl.href = wikiUrl; wl.classList.remove('hidden'); }
  else { wl.classList.add('hidden'); }
}

function setStep(s) {
  for (let i=1;i<=4;i++) {
    const e=$('lstep-'+i); if(!e) continue;
    if(i<s){ e.classList.add('done'); e.classList.remove('active'); }
    else if(i===s){ e.classList.add('active'); e.classList.remove('done'); }
    else { e.classList.remove('done','active'); }
  }
}

/* ──────────────────────────────────────────────
   D3 GRAPH
────────────────────────────────────────────── */
const svg = d3.select('#graph-svg');
const svgDefs = svg.append('defs'); // image patterns live here
let W = () => window.innerWidth;
let H = () => window.innerHeight;
let graphPanelOpen = false;

const zoomRoot = svg.append('g').attr('class','zoom-root');
const edgeVisG = zoomRoot.append('g').attr('class','edges-v');
const edgeHitG = zoomRoot.append('g').attr('class','edges-h');
const nodeG    = zoomRoot.append('g').attr('class','nodes');

let simulation, sseSource;
let gNodes = [], gLinks = [];
let rawNodes = {};
let selectedNodeId = null;
const queuedTitles = new Set(); // titles queued this session — persists across panel open/close

/* ── Path Finder state ── */
let pathMode       = false;
let pathSessionId  = null;
let pathSse        = null;
let pathFrom       = '';
let pathTo         = '';
let pathResults    = {}; // type -> { nodes, edges }
let savedGraph     = null; // { gNodes, gLinks, rawNodes } snapshot saved on enterPathMode

const zoomBehavior = d3.zoom()
  .scaleExtent([0.05, 12])
  .filter(event => {
    if (event.type === 'mousedown' || event.type === 'pointerdown') {
      return !event.target.closest('.node');
    }
    return !event.ctrlKey && !event.button;
  })
  .on('zoom', e => zoomRoot.attr('transform', e.transform));

svg.call(zoomBehavior);

// Double-click empty canvas → reset view
svg.on('dblclick.zoom', null);
svg.on('dblclick', e => {
  if (!e.target.closest('.node')) {
    fitGraph(600);
  }
});

// Click empty canvas → close panel
svg.on('click', e => {
  if (!e.target.closest('.node') && !e.target.closest('.edge-hit')) {
    closePanel();
  }
});

window.addEventListener('resize', () => {
  if (simulation) {
    const cx = graphCenterX();
    simulation.force('center', d3.forceCenter(cx, H()/2).strength(0.05));
    simulation.alpha(0.1).restart();
  }
});

function graphCenterX() {
  const pw = window.innerWidth > 768 && graphPanelOpen
    ? parseInt(getComputedStyle(document.documentElement).getPropertyValue('--panel-w') || '440')
    : 0;
  return (W() - pw) / 2;
}

function nudgeGraph(panelOpen) {
  graphPanelOpen = panelOpen;
  if (!simulation) return;
  simulation.force('center', d3.forceCenter(graphCenterX(), H()/2).strength(0.06));
  simulation.alpha(0.35).restart();
}

const GHOST_RING_R = () => Math.min(graphCenterX(), H() / 2) * 0.82;

function makeSimulation() {
  return d3.forceSimulation()
    .force('link', d3.forceLink()
      .id(d => d.id)
      .distance(d => {
        if (d._ghost_edge) return GHOST_RING_R() * 1.05; // tether length matches ring radius
        if (d._src === 'embedding_similarity') return 160;
        if (d._src === 'ai_inference')         return 120;
        return 260;
      })
      .strength(d => {
        if (d._ghost_edge) return 0.006; // almost no pull — radial force owns position
        if (d._src === 'embedding_similarity') return 0.30;
        if (d._src === 'ai_inference')         return 0.55;
        return 0.08;
      })
    )
    .force('charge', d3.forceManyBody()
      .strength(d => d.ghost
        ? -12   // minimal — just enough to prevent stacking on the ring
        : -(320 + (d.depth_score || 3) * 32))
      .distanceMax(d => d.ghost ? 80 : 600)
    )
    .force('collide', d3.forceCollide()
      .radius(d => (d.ghost ? 10 : nodeRadius(d)) + (d.ghost ? 12 : 24))
      .iterations(3)
    )
    .force('center', d3.forceCenter(graphCenterX(), H()/2).strength(0.04))
    // Dominant radial force — ghosts snap to GHOST_RING_R from center
    .force('ghost_radial', d3.forceRadial(
      d => d.ghost ? GHOST_RING_R() : 0,
      graphCenterX(), H()/2
    ).strength(d => d.ghost ? 0.92 : 0))
    // Domain-clustering for classified nodes only
    .force('domain_x', d3.forceX(d => {
      if (d.ghost) return graphCenterX();
      const domainIndex = Object.keys(DOMAIN_COLOR).indexOf(d.primary_domain || 'other');
      const angle = (domainIndex / Object.keys(DOMAIN_COLOR).length) * 2 * Math.PI;
      return graphCenterX() + Math.cos(angle) * 140;
    }).strength(d => d.ghost ? 0 : 0.04))
    .force('domain_y', d3.forceY(d => {
      if (d.ghost) return H() / 2;
      const domainIndex = Object.keys(DOMAIN_COLOR).indexOf(d.primary_domain || 'other');
      const angle = (domainIndex / Object.keys(DOMAIN_COLOR).length) * 2 * Math.PI;
      return H() / 2 + Math.sin(angle) * 140;
    }).strength(d => d.ghost ? 0 : 0.04))
    .alphaDecay(0.018);
}

/* ── Load graph from API ── */
async function loadGraph() {
  let data;
  try {
    const res = await fetch(GRAPH_API);
    data = await res.json();
  } catch(e) {
    console.error('Graph load failed:', e);
    return;
  }

  rawNodes = data.nodes || {};
  const nodeIds = new Set(Object.keys(rawNodes));

  if (nodeIds.size === 0) {
    $('stat-nodes').textContent = '0';
    $('stat-edges').textContent = '0';
    return;
  }

  const allEdges = (data.edges || []);

  // ── Classified↔Classified edges:
  //    Only show rich (non-structural) edges between classified nodes.
  //    Raw "links to" structural edges are pure visual noise at scale.
  const richClassifiedEdges = allEdges.filter(e =>
    nodeIds.has(e.from) && nodeIds.has(e.to) && e.source !== 'wikipedia_links'
  );

  // ── Ghost (frontier) nodes — two tiers, hard-capped for a clean ring:
  //
  //  Tier 1: TYPED ghosts — top 40 unclassified nodes by number of typed edges
  //          pointing to them. One typed edge each (highest-weight connection).
  //
  //  Tier 2: STRUCTURAL ghosts — top 15 unclassified nodes referenced 3+ times
  //          by classified nodes via raw Wikipedia links (not already in tier 1).
  //
  //  Total cap: ~55 ghost nodes → clean concentric ring.

  // Count typed-edge references per unclassified target
  const typedGhostCount = new Map();
  allEdges.forEach(e => {
    if (nodeIds.has(e.from) && !nodeIds.has(e.to) && e.source !== 'wikipedia_links')
      typedGhostCount.set(e.to, (typedGhostCount.get(e.to)||0)+1);
  });
  // Top 40 by reference count; one best typed edge per ghost
  const typedGhostIds = new Set(
    [...typedGhostCount.entries()].sort((a,b)=>b[1]-a[1]).slice(0,40).map(([id])=>id)
  );
  const typedGhostBestEdge = new Map();
  allEdges.forEach(e => {
    if (!typedGhostIds.has(e.to) || !nodeIds.has(e.from) || e.source === 'wikipedia_links') return;
    const prev = typedGhostBestEdge.get(e.to);
    if (!prev || (e.weight||0) > (prev.weight||0)) typedGhostBestEdge.set(e.to, e);
  });

  // Structural-only ghosts (not already in typed tier)
  const structNeighborCount = new Map();
  allEdges.forEach(e => {
    if (e.source !== 'wikipedia_links') return;
    if (nodeIds.has(e.from) && !nodeIds.has(e.to) && !typedGhostIds.has(e.to))
      structNeighborCount.set(e.to, (structNeighborCount.get(e.to)||0)+1);
  });
  const structGhostIds = [...structNeighborCount.entries()]
    .filter(([,c]) => c >= 3)
    .sort((a,b) => b[1]-a[1])
    .slice(0, 15)
    .map(([id]) => id);
  const structGhostIdSet = new Set(structGhostIds);

  const structGhostBestEdge = new Map();
  allEdges.forEach(e => {
    if (e.source !== 'wikipedia_links') return;
    if (!structGhostIdSet.has(e.to) || !nodeIds.has(e.from)) return;
    const prev = structGhostBestEdge.get(e.to);
    if (!prev || (e.weight||0) > (prev.weight||0)) structGhostBestEdge.set(e.to, e);
  });

  const allGhostIds   = [...typedGhostIds, ...structGhostIds];
  const ghostIdSet    = new Set(allGhostIds);
  const frontierEdges = [...typedGhostBestEdge.values(), ...structGhostBestEdge.values()];

  const visEdges = [...richClassifiedEdges, ...frontierEdges];

  // Preserve positions from previous render; seed new nodes near center
  const cx = graphCenterX(), cy = H()/2;
  const pos = new Map(gNodes.map(n => [n.id, {x:n.x, y:n.y}]));
  const classifiedNodes = Object.values(rawNodes).map(n => {
    const p = pos.get(n.id);
    return {
      ...n,
      x: p?.x ?? (cx + (Math.random()-.5)*180),
      y: p?.y ?? (cy + (Math.random()-.5)*180),
    };
  });
  // Build a map of ghost → parent classified node (for ring-angle seeding)
  const ghostParent = new Map();
  frontierEdges.forEach(e => {
    const gId = !nodeIds.has(e.from) ? e.from : e.to;
    const pId = !nodeIds.has(e.from) ? e.to   : e.from;
    if (!ghostParent.has(gId)) ghostParent.set(gId, pId);
  });

  const R = GHOST_RING_R();
  const ghostNodes = allGhostIds.map((id, i) => {
    const existing = pos.get(id);
    if (existing) {
      return {
        id, title: id, ghost: true, primary_domain: 'other', depth_score: 1,
        typed_ghost: typedGhostIds.has(id),
        x: existing.x, y: existing.y,
      };
    }
    // New ghost: seed it on the ring, angled toward its parent classified node
    const parentId  = ghostParent.get(id);
    const parentPos = parentId ? pos.get(parentId) : null;
    const baseAngle = parentPos
      ? Math.atan2(parentPos.y - cy, parentPos.x - cx)
      : (i / allGhostIds.length) * 2 * Math.PI;
    // Spread multiple ghosts from the same parent with a small fan offset
    const siblings = allGhostIds.filter(g => ghostParent.get(g) === parentId);
    const sibIdx   = siblings.indexOf(id);
    const spread   = siblings.length > 1 ? (sibIdx / siblings.length - 0.5) * 0.9 : 0;
    const angle    = baseAngle + spread;
    return {
      id, title: id, ghost: true, primary_domain: 'other', depth_score: 1,
      typed_ghost: typedGhostIds.has(id),
      x: cx + Math.cos(angle) * R,
      y: cy + Math.sin(angle) * R,
    };
  });
  gNodes = [...classifiedNodes, ...ghostNodes];

  gLinks = visEdges.map(e => ({
    ...e,
    _src:        e.source,
    _ghost_edge: !nodeIds.has(e.from) || !nodeIds.has(e.to), // one end is unclassified
    source: e.from,
    target: e.to,
  }));

  renderGraph();
  updateStats(data.meta);
  requestAnimationFrame(() => { if (!graphPanelOpen) fitGraph(500); });
}

/* ── Render / update graph ── */
function renderGraph() {
  if (!simulation) simulation = makeSimulation();
  // Re-center the ghost ring when the panel state changes viewport width
  const radial = simulation.force('ghost_radial');
  if (radial) radial.x(graphCenterX()).y(H()/2);

  /* ── SVG image patterns for thumbnail nodes ── */
  svgDefs.selectAll('pattern.nip')
    .data(gNodes.filter(n => !n.ghost && n.thumbnail_url), d => d.id)
    .join(
      enter => {
        const pat = enter.append('pattern')
          .attr('class', 'nip')
          .attr('id', d => nodePatternId(d.id))
          .attr('patternUnits', 'objectBoundingBox')
          .attr('width', 1).attr('height', 1);
        pat.append('image')
          .attr('href', d => d.thumbnail_url)
          .attr('x', 0).attr('y', 0)
          .attr('width', d => nodeRadius(d) * 2)
          .attr('height', d => nodeRadius(d) * 2)
          .attr('preserveAspectRatio', 'xMidYMid slice');
        return pat;
      },
      update => update,
      exit => exit.remove()
    );

  const tooltip = $('edge-tooltip');

  /* ── Edge key function (used for both selections) ── */
  const edgeKey = d => `${d.from}||${d.to}||${d.predicate}`;

  /* ── Edge visual lines ── */
  const visLines = edgeVisG.selectAll('line.ev')
    .data(gLinks, edgeKey)
    .join(
      enter => enter.append('line').attr('class', d => `ev edge-visual et-${d.type||'structural'}`)
        .attr('stroke-opacity',0)
        .call(s => s.transition().duration(500).attr('stroke-opacity',
          d => isRichEdge(d) ? 0.78 : 0.45)),
      update => update.attr('class', d => `ev edge-visual et-${d.type||'structural'}`),
      exit => exit.transition().duration(250).attr('stroke-opacity',0).remove()
    )
    .attr('stroke', d => edgeColor(d))
    .attr('stroke-width', d => {
      if (d._src === 'embedding_similarity') return 1.4;
      if (d._src === 'ai_inference')         return 1.8;
      return 0.65;
    })
    .attr('stroke-dasharray', d => d._src === 'embedding_similarity' ? '5,3' : 'none');

  /* ── Edge tooltip builder ── */
  function edgeTip(d) {
    const ec = edgeColor(d);
    if (d._src === 'embedding_similarity') {
      return `<span class="et-badge" style="color:${ec}">semantic</span><span class="et-pred">~${(d.weight*100).toFixed(0)}% similar</span>`;
    }
    if (!isRichEdge(d)) {
      return `<span class="et-badge" style="color:rgba(100,150,200,0.7)">link</span><span class="et-pred">links to</span>`;
    }
    return `<span class="et-badge" style="color:${ec}">${esc(d.type||'?')}</span><span class="et-pred">${esc(d.predicate)}</span>`;
  }

  /* ── Edge hit areas — ALL edges hoverable; rich edges also clickable ── */
  const hitLines = edgeHitG.selectAll('line.eh')
    .data(gLinks, edgeKey)
    .join('line')
    .attr('class', d => `eh edge-hit${isRichEdge(d) ? ' clickable' : ''}`)
    .attr('stroke','transparent')
    .attr('stroke-width', d => isRichEdge(d) ? 16 : 10)
    .on('mouseenter', (event, d) => {
      // Fade all vis lines; un-fade the hovered one using datum identity (not index)
      edgeVisG.selectAll('line.ev').classed('faded', true);
      edgeVisG.selectAll('line.ev')
        .filter(dd => edgeKey(dd) === edgeKey(d))
        .classed('faded', false).classed('hovered', true);
      tooltip.innerHTML = edgeTip(d);
      tooltip.style.display = 'flex';
      moveTooltip(event, tooltip);
    })
    .on('mousemove', (event) => moveTooltip(event, tooltip))
    .on('mouseleave', () => {
      edgeVisG.selectAll('line.ev').classed('faded',false).classed('hovered',false);
      tooltip.style.display = 'none';
    })
    .on('click', (event, d) => {
      if (!isRichEdge(d)) return; // structural frontier edges: let click fall through to canvas
      event.stopPropagation();
      tooltip.style.display = 'none';
      showEdgePanel(d);
    });

  /* ── Node groups ── */
  const nodeGrps = nodeG.selectAll('g.node')
    .data(gNodes, d => d.id)
    .join(
      enter => {
        const g = enter.append('g').attr('class','node')
          .attr('opacity', 0)
          .call(s => s.transition().duration(500).attr('opacity', 1));

        // Conquest pulse ring (hidden by default, shown for conquered)
        g.append('circle').attr('class','node-conquest-ring')
          .attr('fill','none').attr('stroke','#ffd700').attr('stroke-width',1.5)
          .attr('opacity', 0);

        // Personal state ring
        g.append('circle').attr('class','node-ring')
          .attr('fill','none').attr('stroke-width',1.5);

        // Domain glow
        g.append('circle').attr('class','node-glow')
          .attr('fill', d => domainColor(d.primary_domain)).attr('opacity',0.12);

        // Main circle
        g.append('circle').attr('class','node-main')
          .attr('fill', d => domainColor(d.primary_domain))
          .attr('stroke','rgba(255,255,255,0.6)').attr('stroke-width',1.5);

        // Center dot
        g.append('circle').attr('class','node-core')
          .attr('r',2.2).attr('fill','rgba(255,255,255,0.85)');

        // Label
        g.append('text').attr('class','node-label')
          .attr('text-anchor','middle')
          .attr('font-family','Share Tech Mono,monospace')
          .attr('font-size','10px').attr('fill','#aaccee')
          .attr('letter-spacing','0.05em');

        return g;
      },
      update => update,
      exit => exit.transition().duration(250).attr('opacity',0).remove()
    )
    .call(d3.drag()
      .on('start', (ev,d) => { if(!ev.active) simulation.alphaTarget(0.3).restart(); d.fx=d.x; d.fy=d.y; })
      .on('drag',  (ev,d) => { d.fx=ev.x; d.fy=ev.y; })
      .on('end',   (ev,d) => { if(!ev.active) simulation.alphaTarget(0); d.fx=null; d.fy=null; })
    )
    .on('click', (event, d) => {
      event.stopPropagation();
      if (d.ghost) {
        showArticleForTitle(d.title || d.id);
        return;
      }
      selectNode(d.id);
      onNodeClick(d);
    })
    .on('mouseenter', (event, d) => { if (!d.ghost) highlightNeighbors(d.id, true); })
    .on('mouseleave', (event, d) => { if (!d.ghost) highlightNeighbors(d.id, false); });

  // Update node geometry and personal states
  nodeG.selectAll('g.node').each(function(d) {
    const g = d3.select(this);

    // Ghost (frontier) nodes — visible dim dots, clickable
    // Typed ghosts (connected via a real relationship) are slightly brighter and larger
    if (d.ghost) {
      const isTyped = d.typed_ghost;
      g.select('.node-main').attr('r', isTyped ? 6 : 4)
        .attr('fill', isTyped ? '#4488cc' : '#2d5590')
        .attr('opacity', isTyped ? 0.85 : 0.55);
      g.select('.node-glow').attr('r', isTyped ? 11 : 7)
        .attr('fill', isTyped ? '#3377bb' : '#1e4070')
        .attr('opacity', isTyped ? 0.28 : 0.14);
      g.select('.node-ring').attr('r', 0).attr('stroke', 'none');
      g.select('.node-conquest-ring').attr('opacity', 0);
      g.select('.node-core').attr('r', 0);
      g.select('.node-label')
        .attr('fill', isTyped ? '#4488cc' : '#2a4a7a')
        .attr('dy', isTyped ? 20 : 16)
        .attr('opacity', isTyped ? 0.9 : 0.55)
        .text(truncLabel(d.title));
      return;
    }

    const r = nodeRadius(d);
    const ps = getPS(d.id);
    const hasImg = !!d.thumbnail_url;
    const domCol = domainColor(d.primary_domain);

    g.select('.node-conquest-ring').attr('r', r + 12);
    g.select('.node-ring').attr('r', r + 6)
      .attr('stroke', domCol);
    g.select('.node-glow').attr('r', r + 8)
      .attr('fill', domCol)
      .attr('opacity', ps === PS.UNTOUCHED ? 0.18 : 0.38);

    if (hasImg) {
      // Circular image: pattern fill + domain-color border ring
      g.select('.node-main').attr('r', r)
        .attr('fill', `url(#${nodePatternId(d.id)})`)
        .attr('opacity', 1)
        .attr('stroke', domCol)
        .attr('stroke-width', 2.5);
    } else {
      g.select('.node-main').attr('r', r)
        .attr('fill', domCol)
        .attr('opacity', ps === PS.UNTOUCHED ? 0.82 : 1)
        .attr('stroke', 'none');
    }

    g.select('.node-label')
      .attr('dy', r + 15)
      .attr('fill', ps === PS.UNTOUCHED ? '#3a5a7a' : '#0d2030')
      .text(truncLabel(d.title));

    applyStateRing(g, ps, d);
  });

  /* ── Simulation tick ── */
  simulation.nodes(gNodes);
  simulation.force('link').links(gLinks);
  simulation.on('tick', () => {
    visLines
      .attr('x1',d=>d.source.x).attr('y1',d=>d.source.y)
      .attr('x2',d=>d.target.x).attr('y2',d=>d.target.y);
    hitLines
      .attr('x1',d=>d.source.x).attr('y1',d=>d.source.y)
      .attr('x2',d=>d.target.x).attr('y2',d=>d.target.y);
    nodeG.selectAll('g.node')
      .attr('transform', d => `translate(${d.x ?? 0},${d.y ?? 0})`);
  });

  simulation.alpha(0.7).restart();

  // After simulation settles, fit the view once
  simulation.on('end', () => {
    if (gNodes.length > 0 && !graphPanelOpen) fitGraph(800);
  });
}

function applyStateRing(g, ps, d) {
  const r = nodeRadius(d);
  switch(ps) {
    case PS.UNTOUCHED:
      g.select('.node-ring').attr('r',0).attr('stroke','transparent');
      g.select('.node-conquest-ring').attr('opacity',0);
      break;
    case PS.VIEWED:
      g.select('.node-ring').attr('r', r+5)
        .attr('stroke', '#3a4a60').attr('stroke-dasharray','3,3').attr('opacity',0.6);
      g.select('.node-conquest-ring').attr('opacity',0);
      break;
    case PS.STUDIED:
      g.select('.node-ring').attr('r', r+5)
        .attr('stroke', domainColor(d.primary_domain))
        .attr('stroke-dasharray','none').attr('opacity',0.55);
      g.select('.node-conquest-ring').attr('opacity',0);
      break;
    case PS.CONQUERED:
      g.select('.node-ring').attr('r', r+5)
        .attr('stroke','#ffd700').attr('stroke-dasharray','none').attr('opacity',0.8);
      g.select('.node-conquest-ring').attr('r', r+13)
        .attr('stroke','#ffd700').attr('opacity',0.4);
      break;
  }
}

function refreshNodeState(id) {
  nodeG.selectAll('g.node')
    .filter(d => d.id === id)
    .each(function(d) { applyStateRing(d3.select(this), getPS(id), d); });
}

/* ── Selection / highlight ── */
function selectNode(id) {
  selectedNodeId = id;
  nodeG.selectAll('g.node').classed('selected', d => d.id === id);
}
function deselect() {
  selectedNodeId = null;
  nodeG.selectAll('g.node').classed('selected', false);
  edgeVisG.selectAll('line.ev').classed('faded',false).classed('hovered',false);
}

function highlightNeighbors(id, on) {
  if (on) {
    const nbrs = new Set([id]);
    gLinks.forEach(l => {
      const s = typeof l.source === 'object' ? l.source.id : l.source;
      const t = typeof l.target === 'object' ? l.target.id : l.target;
      if (s===id) nbrs.add(t);
      if (t===id) nbrs.add(s);
    });
    nodeG.selectAll('g.node').classed('selected', d => nbrs.has(d.id));
    edgeVisG.selectAll('line.ev').classed('faded', d => {
      const s = typeof d.source === 'object' ? d.source.id : d.source;
      const t = typeof d.target === 'object' ? d.target.id : d.target;
      return s!==id && t!==id;
    });
  } else if (!selectedNodeId) {
    nodeG.selectAll('g.node').classed('selected', false);
    edgeVisG.selectAll('line.ev').classed('faded', false);
  }
}

/* ── Camera ── */
function fitGraph(dur=600) {
  if (!gNodes.length) return;
  const xs = gNodes.map(n=>n.x).filter(Boolean);
  const ys = gNodes.map(n=>n.y).filter(Boolean);
  if (!xs.length) return;
  const minX=Math.min(...xs), maxX=Math.max(...xs);
  const minY=Math.min(...ys), maxY=Math.max(...ys);
  const pw = graphPanelOpen && window.innerWidth > 768
    ? parseInt(getComputedStyle(document.documentElement).getPropertyValue('--panel-w') || '440') : 0;
  const vw = W() - pw, vh = H();
  const pad = 80;
  const scaleX = (vw-2*pad) / (maxX-minX||1);
  const scaleY = (vh-2*pad) / (maxY-minY||1);
  const scale = Math.min(scaleX, scaleY, 2);
  const tx = (vw/2) - scale*(minX+maxX)/2;
  const ty = vh/2 - scale*(minY+maxY)/2;
  svg.transition().duration(dur)
    .call(zoomBehavior.transform, d3.zoomIdentity.translate(tx,ty).scale(scale));
}

function focusNode(id) {
  const n = gNodes.find(d => d.id === id);
  if (!n) return;
  const scale = 1.9;
  const pw = graphPanelOpen && window.innerWidth>768
    ? parseInt(getComputedStyle(document.documentElement).getPropertyValue('--panel-w')||'440') : 0;
  const tx = (W()-pw)/2 - scale*n.x;
  const ty = H()/2 - scale*n.y;
  svg.transition().duration(600)
    .call(zoomBehavior.transform, d3.zoomIdentity.translate(tx,ty).scale(scale));
}

function moveTooltip(event, el) {
  el.style.left = (event.clientX + 14) + 'px';
  el.style.top  = (event.clientY - 30) + 'px';
}

function truncLabel(t) { return t.length > 22 ? t.slice(0,21)+'…' : t; }

/* ── Stats ── */
function updateStats(meta) {
  if (meta) {
    $('stat-nodes').textContent = meta.node_count ?? gNodes.length;
    $('stat-edges').textContent = meta.edge_count ?? gLinks.length;
  }
}

/* ── Add node live (from SSE) ── */
function addNodeLive(node) {
  if (rawNodes[node.id]) return;
  rawNodes[node.id] = node;
  const pos = { x: graphCenterX() + (Math.random()-.5)*200, y: H()/2 + (Math.random()-.5)*200 };
  gNodes.push({ ...node, ...pos });
  renderGraph();
  showToast(`+ ${node.title}`);
  $('stat-nodes').textContent = gNodes.length;
}

/* ── SSE connection ── */
function connectSSE() {
  if (sseSource) sseSource.close();
  sseSource = new EventSource(STREAM_API);
  sseSource.addEventListener('message', e => {
    try {
      const ev = JSON.parse(e.data);
      if (ev.type === 'node_classified' && ev.payload?.node) addNodeLive(ev.payload.node);
    } catch {}
  });
  sseSource.addEventListener('open', () => {
    $('live-dot').classList.add('on');
  });
  sseSource.addEventListener('error', () => {
    $('live-dot').classList.remove('on');
    sseSource.close();
    setTimeout(connectSSE, 8000);
  });
}

/* ══════════════════════════════════════════════
   KNOWLEDGE PATH FINDER
══════════════════════════════════════════════ */

/* Enter isolated path mode: save graph, clear display */
function enterPathMode(fromTitle, toTitle, sessionId) {
  pathMode      = true;
  pathFrom      = fromTitle;
  pathTo        = toTitle;
  pathSessionId = sessionId;
  pathResults   = {};

  // Save current graph state so we can restore it on exit
  savedGraph = { gNodes: [...gNodes], gLinks: [...gLinks], rawNodes: { ...rawNodes } };

  // Clear SVG to show only path nodes
  gNodes = [];
  gLinks = [];
  rawNodes = {};
  renderGraph();

  // Open the path panel
  $('study-tabs').classList.add('hidden');
  setPanelHeader('Knowledge Path', null, null);
  renderPathPanel('searching');
  showPC('pc-pathfind');
  openPanel('pathfind');

  // Persist session for reconnect
  try {
    localStorage.setItem('wd_path_session', JSON.stringify({
      sessionId, from: fromTitle, to: toTitle, startedAt: Date.now()
    }));
  } catch {}

  connectPathSSE(sessionId);
}

/* Exit path mode: restore graph and close panel */
function exitPathMode() {
  pathMode  = false;
  panelMode = 'idle'; // reset before closePanel guard checks it
  if (pathSse) { pathSse.close(); pathSse = null; }
  try { localStorage.removeItem('wd_path_session'); } catch {}

  // Restore full graph
  if (savedGraph) {
    gNodes   = savedGraph.gNodes;
    gLinks   = savedGraph.gLinks;
    rawNodes = savedGraph.rawNodes;
    savedGraph = null;
    renderGraph();
  } else {
    loadGraph();
  }

  // Hide resume banner
  const banner = $('path-resume-banner');
  if (banner) banner.classList.add('hidden');

  // Close the panel properly
  $('detail-panel').classList.remove('open');
  $('study-tabs').classList.add('hidden');
  $('btn-back-to-map')?.classList.add('hidden');
  showPC('pc-idle');
  deselect();
  if (window.innerWidth > 768) nudgeGraph(false);
  renderLibrary();
}

/* Add a node from path results to the path-mode graph */
function addPathNode(node) {
  if (!pathMode || !node) return;
  if (gNodes.find(n => n.id === (node.id || node.title))) return;
  rawNodes[node.id || node.title] = node;
  const cx = graphCenterX(), cy = H() / 2;
  gNodes.push({ ...node, x: cx + (Math.random() - .5) * 220, y: cy + (Math.random() - .5) * 220 });
  renderGraph();
}

/* Add edges from a found path result */
function addPathEdges(edges) {
  if (!pathMode || !edges?.length) return;
  let added = false;
  for (const e of edges) {
    const from = e.from_node || e.from;
    const to   = e.to_node   || e.to;
    if (!from || !to) continue;
    const key = `${from}||${to}||${e.predicate}`;
    if (gLinks.find(l => `${l.from}||${l.to}||${l.predicate}` === key)) continue;
    gLinks.push({
      from, to, type: e.edge_type || e.type,
      predicate: e.predicate || '',
      _src: e.edge_source === 'embedding_similarity' ? 'embedding_similarity' : 'ai_inference',
      weight: e.weight || 1,
      source: from, target: to,
    });
    added = true;
  }
  if (added) renderGraph();
}

/* Render path panel content */
function renderPathPanel(phase) {
  const el = $('pc-pathfind');
  if (!el) return;

  const foundPaths = Object.entries(pathResults).filter(([, p]) => p);
  const cardsHTML  = foundPaths.map(([type, path]) => renderPathCard(type, path)).join('');

  const statusDot  = (phase === 'searching')
    ? '<span class="pf-status-dot"></span>'
    : (phase === 'complete' ? '<span class="pf-status-dot done"></span>' : '');

  const statusText = phase === 'complete'
    ? `Found ${foundPaths.length} path${foundPaths.length !== 1 ? 's' : ''}`
    : phase === 'error' ? 'Search encountered an error'
    : $('pf-status-msg')?.textContent || 'Searching...';

  setHTML(el, `
    <div class="pf-panel-header">
      <div class="pf-panel-route">
        <span class="pf-endpoint" title="${esc(pathFrom)}">${esc(pathFrom.length > 22 ? pathFrom.slice(0,21)+'...' : pathFrom)}</span>
        <span class="pf-arrow">&#8594;</span>
        <span class="pf-endpoint" title="${esc(pathTo)}">${esc(pathTo.length > 22 ? pathTo.slice(0,21)+'...' : pathTo)}</span>
      </div>
    </div>
    <div class="pf-status-bar" id="pf-status-bar">
      ${statusDot}
      <span id="pf-status-msg">${esc(statusText)}</span>
    </div>
    <div class="pf-cards" id="pf-cards">
      ${cardsHTML || (phase === 'searching' ? '<div class="pf-no-path">Searching for connections...</div>' : '')}
    </div>
    <div class="pf-exit-wrap">
      <button class="btn-pf-exit" id="btn-pf-exit">EXIT PATH MODE</button>
    </div>
  `);

  $('btn-pf-exit')?.addEventListener('click', exitPathMode);
}

/* Render a single path card */
function renderPathCard(type, path) {
  const color = EDGE_COLOR[type] || '#5566aa';
  const nodes = path.nodes || [];
  const hops  = nodes.length - 1;

  const chain = nodes.map((n, i) => {
    const isEnd = i === 0 || i === nodes.length - 1;
    return `<span class="pf-chain-node${isEnd ? ' endpoint' : ''}"
              style="border-color:${color}55"
              data-action="pfNodeClick" data-title="${esc(n)}"
              title="${esc(n)}">${esc(n.length > 20 ? n.slice(0,19)+'...' : n)}</span>${
      i < nodes.length - 1 ? '<span class="pf-chain-arrow">&#8594;</span>' : ''}`;
  }).join('');

  const label = type.charAt(0).toUpperCase() + type.slice(1);

  return `<div class="pf-path-card" data-type="${esc(type)}">
    <div class="pf-card-header">
      <span class="pf-card-dot" style="background:${color}"></span>
      <span class="pf-card-type" style="color:${color}">${esc(label)}</span>
      <span class="pf-card-hops">${hops} hop${hops !== 1 ? 's' : ''}</span>
    </div>
    <div class="pf-card-chain">${chain}</div>
    <div class="pf-card-summary">"${esc(pathFrom)}" reached "${esc(pathTo)}" in ${hops} ${hops === 1 ? 'jump' : 'jumps'} via ${esc(label.toLowerCase())} connections</div>
  </div>`;
}

/* Update just the status bar text without full re-render */
function setPfStatus(msg) {
  const el = $('pf-status-msg');
  if (el) el.textContent = msg;
}

/* Append a new path card to the cards container */
function appendPathCard(type, path) {
  pathResults[type] = path;
  const container = $('pf-cards');
  if (!container) return;

  // Remove "Searching..." placeholder
  const placeholder = container.querySelector('.pf-no-path');
  if (placeholder) placeholder.remove();

  const div = document.createElement('div');
  div.innerHTML = safeHTML(renderPathCard(type, path));
  container.appendChild(div.firstElementChild);
}

/* Connect SSE for a path session */
function connectPathSSE(sessionId) {
  if (pathSse) pathSse.close();
  pathSse = new EventSource(`${PATHFIND_API}/stream/${sessionId}`);

  pathSse.addEventListener('message', e => {
    try {
      const ev = JSON.parse(e.data);
      handlePathEvent(ev);
    } catch {}
  });

  pathSse.addEventListener('error', () => {
    // SSE will auto-reconnect if server is still running
  });
}

/* Handle incoming path session events */
function handlePathEvent(ev) {
  switch (ev.type) {
    case 'status':
      setPfStatus(ev.msg || '');
      break;

    case 'warn':
      setPfStatus(ev.msg || '');
      break;

    case 'node_ready':
      if (ev.node) {
        addPathNode(ev.node);
        showToast(`+ ${ev.node.title || ev.node.id}`);
      }
      break;

    case 'path_found':
      if (ev.nodes?.length && ev.path_type) {
        const path = { nodes: ev.nodes, edges: ev.edges || [] };
        appendPathCard(ev.path_type, path);
        addPathEdges(ev.edges || []);
        // Ensure all path nodes are represented in the D3 graph
        for (const title of ev.nodes) {
          if (!gNodes.find(n => n.id === title)) {
            addPathNode({ id: title, title, classified: false, primary_domain: 'other', depth_score: 3 });
          }
        }
      }
      break;

    case 'complete':
      if (pathSse) { pathSse.close(); pathSse = null; }
      try { localStorage.removeItem('wd_path_session'); } catch {}
      renderPathPanel('complete');
      break;

    case 'error':
      setPfStatus(`Error: ${ev.message || 'unknown'}`);
      renderPathPanel('error');
      break;
  }
}

/* ── Path Finder Modal ── */
let pfFromVal = '', pfToVal = '';

let pfAcInitialized = false;

function openPathModal() {
  const modal = $('pathfind-modal');
  if (!modal) return;
  modal.classList.remove('hidden');

  const fromInput = $('pf-from-input');
  const toInput   = $('pf-to-input');
  if (fromInput) { fromInput.value = ''; setTimeout(() => fromInput.focus(), 50); }
  if (toInput)   { toInput.value = ''; }

  // Set up autocomplete once
  if (!pfAcInitialized) {
    setupPfAc('pf-from-input', 'pf-from-ac');
    setupPfAc('pf-to-input',   'pf-to-ac');
    pfAcInitialized = true;
  }

  const goBtn = $('btn-pf-go');
  if (goBtn) { goBtn.disabled = false; goBtn.textContent = 'FIND PATH'; }
}

function closePathModal() {
  const modal = $('pathfind-modal');
  if (modal) modal.classList.add('hidden');
}

function setupPfAc(inputId, dropdownId) {
  const inp = $(inputId);
  const dd  = $(dropdownId);
  if (!inp || !dd) return;

  let items = [], sel = -1, timer = null;

  function closeAcLocal() { dd.innerHTML = ''; dd.classList.remove('open'); sel = -1; }

  function renderAcLocal() {
    if (!items.length) { closeAcLocal(); return; }
    setHTML(dd, items.map((it, i) =>
      `<div class="pf-ac-item${i === sel ? ' sel' : ''}" data-idx="${i}">
        <span class="pf-ac-name">${esc(it.title)}</span>
        <span class="pf-ac-desc">${esc(it.desc || '')}</span>
      </div>`
    ).join(''));
    dd.classList.add('open');
    dd.querySelectorAll('.pf-ac-item').forEach(el => {
      el.addEventListener('mousedown', ev => {
        ev.preventDefault();
        inp.value = items[parseInt(el.dataset.idx)].title;
        closeAcLocal();
      });
    });
  }

  async function suggest(q) {
    if (!q || q.length < 2) { closeAcLocal(); return; }
    try {
      const r = await fetch(`${SEARCH_API}?q=${encodeURIComponent(q)}`);
      const d = await r.json();
      if (d.results?.length) {
        items = d.results.map(n => ({ title: n.title, desc: n.primary_domain || '' }));
        renderAcLocal(); return;
      }
    } catch {}
    try {
      const r = await fetch(`${WIKI_API}?action=opensearch&search=${encodeURIComponent(q)}&limit=5&redirects=resolve&format=json&origin=*`);
      const d = await r.json();
      items = (d[1] || []).map((t, i) => ({ title: t, desc: (d[2] || [])[i] || '' })).filter(it => it.title);
      renderAcLocal();
    } catch { closeAcLocal(); }
  }

  inp.addEventListener('input', () => {
    clearTimeout(timer); sel = -1;
    timer = setTimeout(() => suggest(inp.value.trim()), 250);
  });
  inp.addEventListener('keydown', e => {
    const open = dd.classList.contains('open');
    if (open && items.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(sel + 1, items.length - 1); renderAcLocal(); return; }
      if (e.key === 'ArrowUp')   { e.preventDefault(); sel = Math.max(sel - 1, -1); renderAcLocal(); return; }
      if (e.key === 'Enter' && sel >= 0) { e.preventDefault(); inp.value = items[sel].title; closeAcLocal(); return; }
      if (e.key === 'Escape') { closeAcLocal(); return; }
    }
  });
  inp.addEventListener('blur', () => setTimeout(closeAcLocal, 160));
}

async function startPathFind() {
  const fromTitle = ($('pf-from-input')?.value || '').trim();
  const toTitle   = ($('pf-to-input')?.value   || '').trim();

  if (!fromTitle || !toTitle) {
    showToast('Enter both article titles', 2500);
    return;
  }
  if (fromTitle === toTitle) {
    showToast('Choose two different articles', 2500);
    return;
  }

  const goBtn = $('btn-pf-go');
  if (goBtn) { goBtn.disabled = true; goBtn.textContent = 'Starting...'; }

  try {
    const r = await fetch(PATHFIND_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: fromTitle, to: toTitle }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Request failed');

    closePathModal();

    // Show queue info briefly before entering path mode
    if (d.ahead > 0) {
      showToast(`${d.ahead} user${d.ahead !== 1 ? 's' : ''} ahead of you in queue`, 3000);
    }

    enterPathMode(fromTitle, toTitle, d.sessionId);

  } catch (e) {
    showToast(`Path find failed: ${e.message}`, 4000);
    if (goBtn) { goBtn.disabled = false; goBtn.textContent = 'FIND PATH'; }
  }
}

/* Check localStorage for an active path session on page load */
async function checkPathResume() {
  let saved;
  try { saved = JSON.parse(localStorage.getItem('wd_path_session') || 'null'); } catch { return; }
  if (!saved?.sessionId) return;

  // Check if session is still relevant
  try {
    const r = await fetch(`${PATHFIND_API}/status/${saved.sessionId}`);
    if (!r.ok) { localStorage.removeItem('wd_path_session'); return; }
    const d = await r.json();
    if (d.status === 'complete' || d.status === 'error') {
      localStorage.removeItem('wd_path_session');
      return;
    }
  } catch { return; }

  // Show resume banner
  const banner = $('path-resume-banner');
  if (!banner) return;
  const msg    = banner.querySelector('.path-resume-msg');
  if (msg) {
    msg.innerHTML = safeHTML(
      `Path session in progress: <strong>${esc(saved.from)}</strong> &#8594; <strong>${esc(saved.to)}</strong>`
    );
  }
  banner.classList.remove('hidden');

  banner.querySelector('.btn-resume-path')?.addEventListener('click', () => {
    banner.classList.add('hidden');
    pathFrom      = saved.from;
    pathTo        = saved.to;
    pathSessionId = saved.sessionId;
    enterPathMode(saved.from, saved.to, saved.sessionId);
  });

  banner.querySelector('.btn-dismiss-resume')?.addEventListener('click', () => {
    banner.classList.add('hidden');
    localStorage.removeItem('wd_path_session');
  });
}

/* ──────────────────────────────────────────────
   NODE CLICK HANDLER
   - if classified (in rawNodes): show node panel
   - if not classified: fetch Wikipedia + show article panel
────────────────────────────────────────────── */
async function onNodeClick(d) {
  setPS(d.id, PS.VIEWED);

  const node = rawNodes[d.id];
  if (node && node.classified) {
    showNodePanel(node);
  } else {
    // Shouldn't happen (graph only shows classified), but handle gracefully
    await showArticleForTitle(d.title || d.id);
  }
}

/* ──────────────────────────────────────────────
   NODE DETAIL PANEL (classified article from DB)
────────────────────────────────────────────── */
function showNodePanel(node) {
  setPanelHeader(node.title, node.article_type,
    `https://en.wikipedia.org/wiki/${encodeURIComponent(node.title.replace(/ /g,'_'))}`);

  const color = domainColor(node.primary_domain);
  const ps    = getPS(node.id);
  const figs  = Array.isArray(node.key_figures) ? node.key_figures.slice(0,5) : [];
  const doms  = Array.isArray(node.domains) ? node.domains : [];

  let psLabel = '';
  if(ps===PS.VIEWED)    psLabel = '<div style="font-family:var(--mono);font-size:9px;color:#4a7090;margin-bottom:8px;letter-spacing:0.08em">◦ READ</div>';
  if(ps===PS.STUDIED)   psLabel = '<div style="font-family:var(--mono);font-size:9px;color:#6090cc;margin-bottom:8px;letter-spacing:0.08em">◈ STUDIED</div>';
  if(ps===PS.CONQUERED) psLabel = '<div style="font-family:var(--mono);font-size:9px;color:#ffd700;margin-bottom:8px;letter-spacing:0.08em;animation:livepulse 2s ease-in-out infinite">★ CONQUERED</div>';

  setHTML($('pc-node'), `
    ${psLabel}
    ${node.curiosity_hook ? `<div class="nd-hook">"${esc(node.curiosity_hook)}"</div>` : ''}

    <div class="nd-section">Scores</div>
    ${sBar('depth', node.depth_score||0, color)}
    ${sBar('weird', node.weird_factor||0, '#c9a0dc')}
    ${sBar('share', node.shareability_score||0, '#4ecdc4')}

    <div class="nd-section">Details</div>
    ${ndRow('domain',    node.primary_domain||'–')}
    ${ndRow('era',       node.era||'–')}
    ${ndRow('region',    node.primary_geography||'–')}
    ${ndRow('nav style', node.nav_style_signal||'–')}

    ${figs.length ? `<div class="nd-section">Key figures</div>
      <div class="nd-tags">${figs.map(f=>`<span class="nd-tag">${esc(f)}</span>`).join('')}</div>` : ''}

    ${doms.length>1 ? `<div class="nd-section">Domains</div>
      <div class="nd-tags">${doms.map(dm=>`<span class="nd-tag" style="border-color:${domainColor(dm)}33;color:${domainColor(dm)}">${esc(dm)}</span>`).join('')}</div>` : ''}

    ${node.gap_assessment ? `<div class="nd-section">Wikipedia gaps</div>
      <div class="nd-gap-text">${esc(node.gap_assessment)}</div>` : ''}

    <button class="btn-study" id="btn-nd-study">STUDY THIS →</button>
  `);

  showPC('pc-node');
  openPanel('node');

  $('btn-nd-study').onclick = () => startStudyForTitle(node.title);
}

function sBar(label, val, color) {
  return `<div class="score-row">
    <span class="lbl">${label}</span>
    <div class="score-track"><div class="score-fill" style="width:${Math.round(val/10*100)}%;background:${color}"></div></div>
    <span class="score-num">${val}</span>
  </div>`;
}
function ndRow(k,v) {
  return `<div class="nd-row"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`;
}

/* ──────────────────────────────────────────────
   EDGE CONNECTION PANEL
────────────────────────────────────────────── */
/* Human-readable description for each edge family */
const EDGE_DESC = {
  interpersonal: 'A personal or social relationship between people.',
  geographical:  'A geographic connection — place of origin, location, or territory.',
  temporal:      'A cause-and-effect or timing relationship in history.',
  categorical:   'A classification or taxonomic relationship.',
  etymological:  'A linguistic or naming relationship — roots, synonyms, or aliases.',
  positional:    'A role, occupation, or institutional affiliation.',
  implication:   'A logical or practical consequence — one concept requires or enables the other.',
  misconception: 'A common confusion or false equivalence between these two concepts.',
  analogy:       'A structural parallel — these concepts mirror each other across different domains.',
  influence:     'One shaped the development, thinking, or direction of the other.',
  application:   'One concept is applied within or underlies the other.',
  semantic:      'These articles are conceptually similar based on their content and context.',
};

function showEdgePanel(d) {
  const srcId = typeof d.source==='object' ? d.source.id : d.source;
  const tgtId = typeof d.target==='object' ? d.target.id : d.target;
  const src   = rawNodes[srcId] || {title:srcId};
  const tgt   = rawNodes[tgtId] || {title:tgtId};
  const ec    = EDGE_COLOR[d.type] || '#4a4a88';
  const isSemantic = d._src === 'embedding_similarity';
  const simPct = isSemantic ? Math.round((d.weight || 0) * 100) : null;

  $('study-tabs').classList.add('hidden');
  setPanelHeader('Connection', null, null);

  const sourceLine = isSemantic
    ? `<div class="pe-sim-wrap">
         <div class="pe-sim-bar-bg"><div class="pe-sim-bar-fill" style="width:${simPct}%;background:${ec}"></div></div>
         <span class="pe-sim-label" style="color:${ec}">${simPct}% semantic similarity</span>
       </div>`
    : d.source_sentence
      ? `<div class="pe-sentence ai">"${esc(d.source_sentence)}"</div>`
      : `<div class="pe-sentence">No source sentence recorded for this edge.</div>`;

  const familyDesc = EDGE_DESC[d.type] || '';

  // If both ends are classified, offer study buttons
  const srcStudy = rawNodes[srcId]?.classified
    ? `<button class="pe-study-btn" data-action="peStudy" data-title="${esc(src.title)}" style="border-color:${domainColor(src.primary_domain)}55">Study ${esc(src.title)} →</button>`
    : '';
  const tgtStudy = rawNodes[tgtId]?.classified
    ? `<button class="pe-study-btn" data-action="peStudy" data-title="${esc(tgt.title)}" style="border-color:${domainColor(tgt.primary_domain)}55">Study ${esc(tgt.title)} →</button>`
    : '';

  setHTML($('pc-node'), `
    <div class="pe-nodes">
      <div class="pe-node-nm" style="border-color:${domainColor(src.primary_domain)}55">
        ${src.primary_domain ? `<span class="pe-domain-dot" style="background:${domainColor(src.primary_domain)}"></span>` : ''}
        ${esc(src.title)}
      </div>
      <div class="pe-arrow">
        <div class="pe-predicate" style="color:${ec}">${esc(d.predicate)}</div>
        <div class="pe-arrow-line" style="border-color:${ec}66"></div>
      </div>
      <div class="pe-node-nm" style="border-color:${domainColor(tgt.primary_domain)}55">
        ${tgt.primary_domain ? `<span class="pe-domain-dot" style="background:${domainColor(tgt.primary_domain)}"></span>` : ''}
        ${esc(tgt.title)}
      </div>
    </div>

    ${sourceLine}

    ${familyDesc ? `<div class="pe-family-desc">${esc(familyDesc)}</div>` : ''}

    ${ndRow('edge family',  d.type||'–')}
    ${ndRow('source',       isSemantic ? 'Embedding similarity' : 'AI inference')}
    ${ndRow('weight',       d.weight!=null ? d.weight.toFixed(isSemantic ? 3 : 1) : '–')}

    <div class="pe-type-badge" style="color:${ec};border-color:${ec}44">${esc(d.type||'unknown')}</div>

    ${(srcStudy || tgtStudy) ? `<div class="pe-study-row">${srcStudy}${tgtStudy}</div>` : ''}
  `);

  showPC('pc-node');
  openPanel('node');
}

// Delegate study buttons inside the edge panel
document.addEventListener('click', e => {
  const btn = e.target.closest('[data-action="peStudy"]');
  if (btn) startStudyForTitle(btn.dataset.title);
});

/* ──────────────────────────────────────────────
   ARTICLE PANEL (unclassified Wikipedia article)
────────────────────────────────────────────── */
async function showArticleForTitle(title) {
  // Show loading
  setPanelHeader(title, null, null);
  $('loading-msg').textContent = 'Fetching article…';
  setStep(1);
  showPC('pc-loading');
  openPanel('loading');

  let wiki;
  try {
    wiki = await fetchWikipedia(title);
  } catch(e) {
    setPanelHeader(title, null, `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g,'_'))}`);
    setHTML($('pc-article'), `
      <div class="art-title">${esc(title)}</div>
      <div class="art-excerpt" style="color:var(--muted2)">${esc(e.message)}</div>
      <div class="art-ctas" style="margin-top:16px">
        <a class="btn-cta-secondary" style="text-decoration:none;display:block;text-align:center;padding:9px 14px"
           href="https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g,'_'))}"
           target="_blank" rel="noopener">Open on Wikipedia ↗</a>
      </div>
    `);
    showPC('pc-article');
    openPanel('article');
    return;
  }
  setPS(title, PS.VIEWED);

  const wikiUrl = `https://en.wikipedia.org/wiki/${encodeURIComponent(wiki.title.replace(/ /g,'_'))}`;
  setPanelHeader(wiki.title, null, wikiUrl);

  function splitAtBoundary(text, target=600) {
    if (text.length <= target) return [text, ''];
    const window = text.slice(0, target + 300);
    
    const pp = window.lastIndexOf('\n\n');
    if (pp > 120) return [text.slice(0, pp).trimEnd(), text.slice(pp).trimStart()];
    
    const sp = Math.max(window.lastIndexOf('. ', target), window.lastIndexOf('.\n', target));
    if (sp > 80) return [text.slice(0, sp + 1).trimEnd(), text.slice(sp + 1).trimStart()];
    
    const ws = window.lastIndexOf(' ', target);
    if (ws > 0) return [text.slice(0, ws), text.slice(ws + 1)];
    return [text.slice(0, target), text.slice(target)];
  }
  const [intro, rest] = splitAtBoundary(wiki.text, 600);

  setHTML($('pc-article'), `
    <div class="art-title">${esc(wiki.title)}</div>
    <div class="art-excerpt" id="art-excerpt-text">${esc(intro)}</div>
    ${rest ? `<button class="art-read-more" id="btn-read-more">▾ Read full article</button>
    <div class="art-full-text hidden" id="art-full-text">${esc(rest)}</div>` : ''}
    <div class="art-ctas">
      <button class="btn-cta-primary" id="btn-study-it">STUDY THIS ARTICLE →</button>
      <button class="btn-cta-secondary" id="btn-graph-it"
        ${rawNodes[wiki.title] ? 'disabled' : ''}
      >${rawNodes[wiki.title] ? 'Already on map' : queuedTitles.has(wiki.title) ? 'Queued for map' : 'Classify for Map'}</button>
    </div>
    <hr class="art-sep">
    <div class="art-meta">
      <span>${wiki.word_count.toLocaleString()} words</span>
      <span>·</span>
      <span>${wiki.outbound_links.length} links</span>
    </div>
  `);

  const rmBtn = $('btn-read-more');
  if (rmBtn) {
    rmBtn.onclick = () => {
      const ft = $('art-full-text');
      const collapsed = ft.classList.toggle('hidden');
      rmBtn.textContent = collapsed ? '▾ Read full article' : '▴ Collapse';
    };
  }

  showPC('pc-article');
  openPanel('article');

  $('btn-study-it').onclick = () => startStudyForWiki(wiki);

  const graphBtn = $('btn-graph-it');
  if (graphBtn && !graphBtn.disabled) {
    graphBtn.onclick = async () => {
      graphBtn.disabled = true;
      graphBtn.textContent = 'Checking…';
      try {
        const r = await fetch('/api/classify', {
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body: JSON.stringify({title: wiki.title})
        });
        const data = await r.json();
        if (r.ok) {
          if (data.status === 'already_classified') {
            graphBtn.textContent = 'Already on map';
            showToast(`${wiki.title} is already on the map`);
          } else if (data.status === 'already_queued') {
            queuedTitles.add(wiki.title);
            graphBtn.textContent = 'Queued for map';
            showToast(`${wiki.title} is already queued — check back soon`);
          } else {
            queuedTitles.add(wiki.title);
            graphBtn.textContent = 'Queued for map';
            showToast(`${wiki.title} queued — it will appear on the map shortly`);
          }
        } else {
          graphBtn.disabled = false;
          graphBtn.textContent = 'Classify for Map';
          showToast(data.error || 'Classification failed', 4000);
        }
      } catch(e) {
        graphBtn.disabled = false;
        graphBtn.textContent = 'Classify for Map';
        showToast('Network error', 4000);
      }
    };
  }

  const excEl = $('pc-article').querySelector('.art-excerpt');
  if (excEl) {
    excEl.addEventListener('scroll', function() {
      if (this.scrollTop + this.clientHeight >= this.scrollHeight - 20) {
        setPS(wiki.title, PS.VIEWED);
      }
    }, { once: true });
  }
}

async function startStudyForTitle(title) {
  // 1. Check localStorage first (instant)
  const local = loadCurriculumLocal(title);
  if (local) {
    state.topic = title;
    state.wikiUrl = `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g,'_'))}`;
    state.curriculum = local;
    state.wikiText = '';
    resetStudyState();
    renderStudy();
    renderLibrary();
    return;
  }

  // 2. Check server (classified nodes may have stored curriculum)
  try {
    const r = await fetch(`${NODE_API}/${encodeURIComponent(title)}`);
    if (r.ok) {
      const data = await r.json();
      if (data.curriculum) {
        saveCurriculumLocal(title, data.curriculum);
        state.topic = title;
        state.wikiUrl = `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g,'_'))}`;
        state.curriculum = data.curriculum;
        state.wikiText = '';
        resetStudyState();
        renderStudy();
        renderLibrary();
        return;
      }
    }
  } catch {}

  // 3. Generate fresh
  showPC('pc-loading');
  $('loading-msg').textContent = 'Fetching article…';
  setStep(1);
  openPanel('loading');

  try {
    const wiki = await fetchWikipedia(title);
    await startStudyForWiki(wiki);
  } catch(e) {
    showToast(e.message, 4000);
    closePanel();
  }
}

async function startStudyForWiki(wiki) {
  showPC('pc-loading');
  openPanel('loading');

  setPanelHeader(wiki.title, null,
    `https://en.wikipedia.org/wiki/${encodeURIComponent(wiki.title.replace(/ /g,'_'))}`);

  state.topic   = wiki.title;
  state.wikiUrl = `https://en.wikipedia.org/wiki/${encodeURIComponent(wiki.title.replace(/ /g,'_'))}`;
  state.wikiText= wiki.text;

  $('loading-msg').textContent = 'Building curriculum…';
  setStep(2); setTimeout(()=>setStep(3), 600); setTimeout(()=>setStep(4), 2000);

  try {
    const cur = await generateCurriculum(wiki.title, wiki.text);
    state.curriculum = cur;
    state.topic = cur.topic || wiki.title;
    // Save to localStorage immediately
    saveCurriculumLocal(state.topic, cur);
    // Save to server (fire and forget)
    fetch('/api/curriculum', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({title: state.topic, data: cur}),
    }).catch(() => {});
    resetStudyState();
    setPS(wiki.title, PS.STUDIED);
    renderStudy();
    renderLibrary();
  } catch(e) {
    showToast('Curriculum error: ' + e.message, 5000);
    closePanel();
  }
}

function resetStudyState() {
  Object.assign(state, {
    pretestAnswered:0, pretestScore:0,
    cardIndex:0, cardKnew:0, cardMissed:0,
    quizTier:null, quizQuestions:[], quizIndex:0, quizScore:0, quizResults:[]
  });
}

function renderStudy() {
  $('wiki-link').href = state.wikiUrl;
  $('wiki-link').classList.remove('hidden');
  $('panel-title').textContent = state.topic;

  const tabs = $('study-tabs');
  tabs.classList.remove('hidden');
  tabs.querySelectorAll('.stab').forEach(t => {
    t.classList.toggle('active', t.dataset.panel === 'pretest');
    t.onclick = () => {
      tabs.querySelectorAll('.stab').forEach(s => s.classList.remove('active'));
      t.classList.add('active');
      if(t.dataset.panel==='curriculum') setPS(state.topic, PS.STUDIED);
      showStudyPanel(t.dataset.panel);
    };
  });

  WD.renderPretest();
  WD.renderCurriculum(state.curriculum.gaps?.length > 0);
  WD.renderFlashcards();
  WD.renderQuizStart();
  WD.renderResources();

  showPC('pc-study');
  showStudyPanel('pretest');
  openPanel('study');
}

function showStudyPanel(name) {
  document.querySelectorAll('#pc-study .panel').forEach(p => p.classList.add('hidden'));
  $('panel-' + name)?.classList.remove('hidden');
  $('panel-body').scrollTop = 0;
}

document.addEventListener('click', e => {
  const target = e.target.closest('[data-action]');
  if (!target) return;
  switch(target.dataset.action) {
    case 'showPanel':       showStudyPanel(target.dataset.panel); syncTab(target.dataset.panel); break;
    case 'answerPt':        WD.answerPt(+target.dataset.qi,+target.dataset.oi,+target.dataset.correct); break;
    case 'startQuiz':       WD.startQuiz(target.dataset.tier); break;
    case 'answerQuiz':      WD.answerQuiz(+target.dataset.chosen,+target.dataset.correct); break;
    case 'nextQuizQ':       WD.nextQuizQ(); break;
    case 'renderQuizStart': WD.renderQuizStart(); break;
    case 'renderFlashcards':WD.renderFlashcards(); break;
    case 'rateCard':        WD.rateCard(target.dataset.knew==='1'); break;
    case 'flipCardFromNav': { const sc=document.querySelector('.fc-scene'); if(sc) WD.flipCard(sc); break; }
    case 'openFromLibrary': startStudyForTitle(target.dataset.title); break;
  }
});
document.addEventListener('click', e => {
  const sc = e.target.closest('.fc-scene');
  if (sc) WD.flipCard(sc);
});

function syncTab(panel) {
  $('study-tabs')?.querySelectorAll('.stab')
    .forEach(t => t.classList.toggle('active', t.dataset.panel === panel));
}

const WD = {
  renderPretest() {
    const c=state.curriculum, el=$('panel-pretest');
    setHTML(el, `<div class="panel-intro"><h2 class="panel-title">Pre-test</h2><p class="panel-desc">Answer before studying — sets your baseline.</p></div>`);
    c.pretest.forEach((q,qi)=>{
      const d=document.createElement('div'); d.className='pt-question'; d.id='ptq-'+qi;
      setHTML(d,`<div class="pt-q-num">Question ${qi+1} of ${c.pretest.length}</div><div class="pt-q-text">${esc(q.question)}</div><div class="pt-options">${q.options.map((o,oi)=>`<button class="pt-opt" data-action="answerPt" data-qi="${qi}" data-oi="${oi}" data-correct="${q.correctIndex}">${esc(o)}</button>`).join('')}</div><div class="pt-feedback hidden" id="ptf-${qi}"></div>`);
      el.appendChild(d);
    });
  },

  answerPt(qi,chosen,correct) {
    const qEl=$('ptq-'+qi), fEl=$('ptf-'+qi);
    if(!qEl||qEl.dataset.answered) return;
    qEl.dataset.answered='1';
    qEl.querySelectorAll('.pt-opt').forEach((b,i)=>{b.disabled=true;if(i===correct)b.classList.add('correct');else if(i===chosen)b.classList.add('wrong');});
    const ok=chosen===correct; if(ok) state.pretestScore++; state.pretestAnswered++;
    fEl.classList.remove('hidden');
    fEl.textContent=(ok?'> Correct. ':'> Incorrect. ')+state.curriculum.pretest[qi].explanation;
    if(state.pretestAnswered===state.curriculum.pretest.length){
      const tot=state.curriculum.pretest.length,pct=Math.round(state.pretestScore/tot*100);
      const msg=pct>=80?"Strong baseline — this topic isn't new territory.":pct>=50?"Some familiarity. The curriculum will fill the gaps.":"Great starting point — you're about to learn a lot.";
      const sc=document.createElement('div'); sc.className='pt-score-card';
      setHTML(sc,`<div class="pt-score-num">${state.pretestScore}/${tot}</div><div class="pt-score-label">Pre-test score</div><div class="pt-score-msg">${esc(msg)}</div><button class="btn-to-study" data-action="showPanel" data-panel="curriculum">Start studying ›</button>`);
      $('panel-pretest').appendChild(sc);
    }
  },

  renderCurriculum(hasGaps) {
    const c=state.curriculum,el=$('panel-curriculum');
    el.innerHTML='';
    if(hasGaps) setHTML(el,`<div class="gap-banner"><div class="gap-banner-icon">!</div><div><strong>Knowledge gaps flagged</strong> — Important concepts not in the Wikipedia article are marked <span class="gap-flag">gap</span>.</div></div>`);
    if(c.summary){const d=document.createElement('div');d.className='curr-section';setHTML(d,`<div class="curr-section-heading">Overview</div><p class="curr-overview">${esc(c.summary)}</p>`);el.appendChild(d);}
    if(hasGaps){const d=document.createElement('div');d.className='curr-section';setHTML(d,`<div class="curr-section-heading">Missing from Wikipedia</div><ul class="curr-gaps-list">${c.gaps.map(g=>`<li class="curr-gap-item">${esc(g)}</li>`).join('')}</ul>`);el.appendChild(d);}
    const dd=document.createElement('div');dd.className='curr-section';
    setHTML(dd,`<div class="curr-section-heading">Key terms</div><div class="dict-grid">${c.dictionary.map(d=>`<div class="dict-card${d.fromWiki===false?' is-gap':''}"><div class="dict-term">${esc(d.term)}${d.fromWiki===false?gapBadge():''}</div><div class="dict-def">${esc(d.definition)}</div></div>`).join('')}</div>`);
    el.appendChild(dd);
    if(c.people?.length){const pd=document.createElement('div');pd.className='curr-section';setHTML(pd,`<div class="curr-section-heading">Notable people</div><div class="people-list">${c.people.map(p=>`<div class="person-card${p.fromWiki===false?' is-gap':''}"><div class="person-avatar">${esc(p.name.trim().split(/\s+/).map(w=>w[0]).slice(0,2).join('').toUpperCase())}</div><div><div class="person-name">${esc(p.name)}${p.fromWiki===false?gapBadge():''}</div><div class="person-desc">${esc(p.role)}</div></div></div>`).join('')}</div>`);el.appendChild(pd);}
    if(c.timeline?.length){const td=document.createElement('div');td.className='curr-section';setHTML(td,`<div class="curr-section-heading">Timeline</div><div class="timeline-list">${c.timeline.map(e=>`<div class="tl-item${e.fromWiki===false?' is-gap':''}"><div class="tl-dot"></div><div class="tl-date">${esc(e.date)}${e.fromWiki===false?gapBadge():''}</div><div class="tl-event">${esc(e.event)}</div>${e.significance?`<div class="tl-event-note">${esc(e.significance)}</div>`:''}</div>`).join('')}</div>`);el.appendChild(td);}
  },

  renderFlashcards(){ state.cardIndex=0;state.cardKnew=0;state.cardMissed=0;WD.renderCard(); },
  renderCard(){
    const cards=state.curriculum.flashcards,con=$('panel-flashcards');
    if(state.cardIndex>=cards.length){
      const pct=Math.round(state.cardKnew/cards.length*100);
      const msg=pct>=80?"Ready for the quiz.":pct>=50?"Solid. Review the missed cards.":"Try another round first.";
      setPS(state.topic, PS.STUDIED);
      setHTML(con,`<div class="fc-done"><div class="fc-done-score">${state.cardKnew}/${cards.length}</div><div class="fc-done-label">Cards you knew</div><div class="fc-done-msg">${esc(msg)}</div><button class="btn-restart" data-action="renderFlashcards">Review again</button>&nbsp;<button class="btn-restart btn-sec" data-action="showPanel" data-panel="quiz">Take the quiz ›</button></div>`);
      return;
    }
    const card=cards[state.cardIndex],tot=cards.length;
    setHTML(con,`<div class="fc-header"><span class="fc-counter">Card ${state.cardIndex+1} of ${tot}</span><span class="fc-tally"><span class="knew">> ${state.cardKnew}</span><span class="missed">x ${state.cardMissed}</span></span></div>
    <div class="fc-scene"><div class="fc-inner" id="fc-inner">
      <div class="fc-face front"><div class="fc-type-badge">${esc(card.type||'card')}</div><div class="fc-face-label">Question</div><div class="fc-text">${esc(card.question)}</div><div class="fc-tap-hint">[ tap to reveal ]</div></div>
      <div class="fc-face back">${card.fromWiki===false?`<div class="fc-gap-indicator">${gapBadge()}</div>`:''}<div class="fc-face-label">Answer</div><div class="fc-text">${esc(card.answer)}</div></div>
    </div></div>
    <div class="fc-nav hidden" id="fc-nav"><button class="btn-fc missed" data-action="rateCard" data-knew="0">x Missed</button><button class="btn-fc" data-action="flipCardFromNav">Flip</button><button class="btn-fc knew" data-action="rateCard" data-knew="1">> Knew it</button></div>`);
  },
  flipCard(scene){ const inner=scene.querySelector('.fc-inner'),nav=$('fc-nav');if(!inner)return;inner.classList.toggle('flipped');if(nav)nav.classList.toggle('hidden',!inner.classList.contains('flipped')); },
  rateCard(knew){ if(knew)state.cardKnew++;else state.cardMissed++;state.cardIndex++;WD.renderCard(); },

  renderQuizStart(){
    const done=WD.getCompletedTiers();
    const cards=Object.entries(TIERS).map(([key,t])=>{
      const d=done.includes(key);
      return `<div class="tier-card ${key}" data-action="startQuiz" data-tier="${key}">${d?'<div class="tier-complete-mark">DONE</div>':''}<div class="tier-icon">${esc(t.icon)}</div><div class="tier-name">${esc(t.label)}</div><div class="tier-count">${t.count} questions</div><div class="tier-desc">${esc(t.desc)}</div></div>`;
    }).join('');
    setHTML($('panel-quiz'),`<div class="quiz-start-screen"><div class="panel-intro"><h2 class="panel-title">Final Quiz</h2><p>Choose your difficulty. Questions ordered easy to hard.</p></div><div class="tier-grid">${cards}</div></div>`);
  },
  getCompletedTiers(){
    try{return JSON.parse(localStorage.getItem('wd_done_'+state.topic.toLowerCase().replace(/[^a-z0-9]/g,'_').slice(0,40))||'[]');}catch{return [];}
  },
  markTierComplete(tier){
    try{const k='wd_done_'+state.topic.toLowerCase().replace(/[^a-z0-9]/g,'_').slice(0,40);const d=JSON.parse(localStorage.getItem(k)||'[]');if(!d.includes(tier)){d.push(tier);localStorage.setItem(k,JSON.stringify(d));}}catch{}
  },
  startQuiz(tier){
    state.quizTier=tier;
    state.quizQuestions=(state.curriculum.quiz||[]).slice(0,TIERS[tier].count);
    state.quizIndex=0;state.quizScore=0;state.quizResults=[];
    WD.renderQuizQ();
  },
  renderQuizQ(){
    const qs=state.quizQuestions;
    if(state.quizIndex>=qs.length){WD.renderQuizResults();return;}
    const q=qs[state.quizIndex],tot=qs.length,pct=Math.round(state.quizIndex/tot*100),tier=state.quizTier;
    setHTML($('panel-quiz'),`
      <div class="quiz-tier-label ${esc(tier)}">${esc(TIERS[tier].label)}</div>
      <div class="quiz-progress-row"><span class="quiz-q-num">${state.quizIndex+1}/${tot}</span><div class="quiz-progress-bar"><div class="quiz-progress-fill ${esc(tier)}" style="width:${pct}%"></div></div><span class="quiz-q-num">Score: ${state.quizScore}</span></div>
      <div class="quiz-q-text">${esc(q.question)}</div>
      <div class="quiz-options">${q.options.map((o,oi)=>`<button class="quiz-opt" data-action="answerQuiz" data-chosen="${oi}" data-correct="${q.correctIndex}">${esc(o)}</button>`).join('')}</div>
      <div id="quiz-exp" class="quiz-explanation hidden"></div>
      <div id="quiz-next" class="hidden"><button class="btn-next-q" data-action="nextQuizQ">${state.quizIndex+1<tot?'Next ›':'See results ›'}</button></div>`);
  },
  answerQuiz(chosen,correct){
    document.querySelectorAll('.quiz-opt').forEach((b,i)=>{b.disabled=true;if(i===correct)b.classList.add('correct');else if(i===chosen)b.classList.add('wrong');});
    const ok=chosen===correct;if(ok)state.quizScore++;
    const q=state.quizQuestions[state.quizIndex];
    state.quizResults.push({question:q.question,correct:ok,correctAnswer:q.options[correct]});
    const exp=$('quiz-exp');exp.classList.remove('hidden');exp.className='quiz-explanation '+state.quizTier;exp.textContent=q.explanation||'';
    $('quiz-next').classList.remove('hidden');
  },
  nextQuizQ(){ state.quizIndex++;WD.renderQuizQ(); },
  renderQuizResults(){
    const tot=state.quizQuestions.length,sc=state.quizScore,pct=Math.round(sc/tot*100),tier=state.quizTier;
    const isMaster=pct>=90&&tier==='expert';
    if(isMaster||pct>=70) setPS(state.topic, PS.CONQUERED);
    WD.markTierComplete(tier);
    const msg=pct>=90?"Outstanding. You've mastered this.":pct>=70?"Strong result.":pct>=50?"Getting there.":"Another pass through the flashcards first.";
    const bd=state.quizResults.map(r=>`<div class="qr-item"><div class="qr-icon ${r.correct?'ok':'fail'}">${r.correct?'>':'x'}</div><div><div class="qr-q">${esc(r.question)}</div>${!r.correct?`<div class="qr-a">Correct: ${esc(r.correctAnswer)}</div>`:''}</div></div>`).join('');
    setHTML($('panel-quiz'),`<div class="quiz-results">
      <div class="qr-tier-badge"><span class="quiz-tier-label ${esc(tier)}">${esc(TIERS[tier].label)}</span></div>
      ${isMaster?`<div class="qr-mastered-msg">> TOPIC CONQUERED — Stamped on your map.</div>`:''}
      <div class="qr-header"><div class="qr-score-num">${sc}/${tot}</div><div class="qr-score-side"><div class="qr-score-label">${pct}% correct</div><div class="qr-score-msg">${esc(msg)}</div></div></div>
      <div class="qr-breakdown-title">Question breakdown</div>${bd}
      <div class="qr-actions">
        <button class="btn-retry" data-action="startQuiz" data-tier="${esc(tier)}">Retry</button>
        <button class="btn-sec" data-action="renderQuizStart">Change tier</button>
        <button class="btn-sec" data-action="showPanel" data-panel="resources">Further reading ›</button>
      </div></div>`);
  },

  renderResources(){
    const r=state.curriculum.resources||{},reading=r.furtherReading||[],courses=r.courses||[];
    setHTML($('panel-resources'),`<div class="panel-intro"><h2 class="panel-title">Keep learning</h2><p class="panel-desc">Curated resources for going deeper on <em>${esc(state.topic)}</em>.</p></div>
    ${reading.length?`<div class="res-section"><div class="res-section-heading">Further reading</div><div class="res-list">${reading.map(i=>`<a class="res-card" href="${esc(i.url)}" target="_blank" rel="noopener noreferrer"><div class="res-card-top"><div class="res-title">${esc(i.title)}</div><div class="res-source">${esc(i.source)}</div></div><div class="res-desc">${esc(i.description)}</div></a>`).join('')}</div></div>`:''}
    ${courses.length?`<div class="res-section"><div class="res-section-heading">Courses &amp; videos</div><div class="courses-grid">${courses.map(i=>`<a class="course-card" href="${esc(i.url)}" target="_blank" rel="noopener noreferrer"><div class="course-platform">${esc(i.platform)}</div><div class="course-title">${esc(i.title)}</div><div class="course-desc">${esc(i.description)}</div></a>`).join('')}</div></div>`:''}
    <div class="res-section"><div class="res-section-heading">Wikipedia</div><div class="res-list"><a class="res-card" href="${esc(state.wikiUrl)}" target="_blank" rel="noopener noreferrer"><div class="res-card-top"><div class="res-title">${esc(state.topic)} — Wikipedia</div><div class="res-source">Wikipedia</div></div><div class="res-desc">The source article used to generate this curriculum.</div></a></div></div>`);
  },
};

const WIKI_API = 'https://en.wikipedia.org/w/api.php';

async function fetchWikipedia(topic) {
  let title = topic.trim().slice(0, TOPIC_MAX);
  const urlMatch = title.match(/^https?:\/\/([^/]+)\/wiki\/(.+)/);
  if (urlMatch) {
    if (urlMatch[1] !== 'en.wikipedia.org') throw new Error('Only en.wikipedia.org is supported');
    title = decodeURIComponent(urlMatch[2].replace(/_/g,' '));
  } else if (/wikipedia\.org/i.test(title)) {
    throw new Error('Only English Wikipedia (en.wikipedia.org) is supported');
  }

  const r = await fetch(`${WIKI_API}?action=query&titles=${encodeURIComponent(title)}&prop=extracts%7Clinks&exintro=false&explaintext=true&pllimit=max&plnamespace=0&redirects=1&format=json&origin=*`);
  if (!r.ok) throw new Error('Wikipedia request failed');
  const d = await r.json();
  let page = Object.values(d.query.pages)[0];

  if ('missing' in page) {
    
    const sr = await fetch(`${WIKI_API}?action=query&list=search&srsearch=${encodeURIComponent(title)}&srlimit=1&format=json&origin=*`);
    const sd = await sr.json();
    const found = sd.query?.search?.[0]?.title;
    if (!found) throw new Error(`No Wikipedia article found for "${title}"`);
    const r2 = await fetch(`${WIKI_API}?action=query&titles=${encodeURIComponent(found)}&prop=extracts%7Clinks&exintro=false&explaintext=true&pllimit=max&plnamespace=0&redirects=1&format=json&origin=*`);
    const d2 = await r2.json();
    page = Object.values(d2.query.pages)[0];
    if ('missing' in page) throw new Error(`No Wikipedia article found for "${title}"`);
  }

  if (page.ns !== 0) throw new Error(`"${page.title}" is not a main Wikipedia article`);
  const text = page.extract || 'No article text available for this Wikipedia entry.';

  const links = (page.links || []).map(l => l.title);
  const wc = text.split(/\s+/).length;
  return {
    title:          page.title,
    text:           text.length > 8000 ? text.slice(0,8000)+'\n[truncated]' : text,
    outbound_links: links,
    word_count:     wc,
  };
}

async function callLLM(user, maxTokens=7000) {
  const r = await fetch(PROXY_API, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({user, maxTokens}),
  });
  if (!r.ok) { const e=await r.json().catch(()=>({})); throw new Error(e.error||`API error ${r.status}`); }
  const d = await r.json();
  return d.content[0].text;
}

async function generateCurriculum(topic, wikiText) {
  const usr = `Build a complete study curriculum for: "${topic}"

Wikipedia text:
---
${wikiText}
---

Return EXACTLY this JSON (no markdown, no extra text):
{
  "topic":"Clean display name",
  "summary":"2-3 sentence overview",
  "gaps":["Important concepts MISSING from the Wikipedia text. Empty array if none."],
  "dictionary":[{"term":"...","definition":"...","fromWiki":true}],
  "people":[{"name":"...","role":"...","fromWiki":true}],
  "timeline":[{"date":"...","event":"...","significance":"...","fromWiki":true}],
  "flashcards":[{"type":"term|person|event|concept","question":"...","answer":"...","fromWiki":true}],
  "pretest":[{"question":"...","options":["A","B","C","D"],"correctIndex":0,"explanation":"..."}],
  "quiz":[{"question":"...","options":["A","B","C","D"],"correctIndex":0,"explanation":"..."}],
  "resources":{"furtherReading":[{"title":"...","url":"https://...","source":"...","description":"..."}],"courses":[{"title":"...","url":"https://...","platform":"...","description":"..."}]}
}
RULES: dictionary 8-14 entries. people 4-8. timeline 6-12. flashcards exactly 16. pretest exactly 5. quiz exactly 20 questions easy→hard. All questions: 4 options, correctIndex 0-based. Real URLs only.`;

  const raw = await callLLM(usr, 7000);
  const cleaned = raw.replace(/^```json\s*/i,'').replace(/^```\s*/i,'').replace(/```\s*$/,'').trim();
  return JSON.parse(cleaned);
}

/* ──────────────────────────────────────────────
   SEARCH + AUTOCOMPLETE
────────────────────────────────────────────── */
let acItems=[], acSel=-1, acTimer=null;

function closeAc() { $('ac-dropdown').classList.remove('open'); acSel=-1; }

function renderAc() {
  const dd=$('ac-dropdown');
  if (!acItems.length) { closeAc(); return; }
  setHTML(dd, acItems.map((it,i)=>`
    <div class="ac-item${i===acSel?' ac-sel':''}" data-idx="${i}">
      <span class="ac-badge">W</span>
      <span class="ac-name">${esc(it.title)}</span>
      <span class="ac-desc">${esc(it.desc||'')}</span>
    </div>`).join(''));
  dd.classList.add('open');
  dd.querySelectorAll('.ac-item').forEach(el => {
    el.addEventListener('mousedown', e => {
      e.preventDefault();
      const it = acItems[parseInt(el.dataset.idx)];
      $('topic-input').value = it.title;
      closeAc();
      handleSearch(it.title);
    });
  });
}

async function fetchSuggestions(q) {
  if (!q || q.length < 2) { closeAc(); return; }
  // First check DB
  try {
    const r = await fetch(`${SEARCH_API}?q=${encodeURIComponent(q)}`);
    const d = await r.json();
    if (d.results?.length) {
      acItems = d.results.map(n => ({ title:n.title, desc:n.primary_domain||'' }));
      renderAc(); return;
    }
  } catch {}
  // Fallback to Wikipedia
  try {
    const r = await fetch(`${WIKI_API}?action=opensearch&search=${encodeURIComponent(q)}&limit=5&redirects=resolve&format=json&origin=*`);
    const d = await r.json();
    acItems = (d[1]||[]).map((t,i)=>({title:t,desc:(d[2]||[])[i]||''})).filter(it=>it.title);
    renderAc();
  } catch { closeAc(); }
}

async function handleSearch(title) {
  $('topic-input').value = '';
  closeAc();

  // Check if in graph
  if (rawNodes[title]) {
    focusNode(title);
    selectNode(title);
    showNodePanel(rawNodes[title]);
    return;
  }

  // Not in graph → show article panel
  await showArticleForTitle(title);
}

/* ──────────────────────────────────────────────
   RANDOM
────────────────────────────────────────────── */
async function handleRandom() {
  try {
    const r = await fetch(
      'https://en.wikipedia.org/w/api.php?action=query&list=random&rnnamespace=0&rnlimit=1&format=json&origin=*',
      { signal: AbortSignal.timeout(8000) }
    );
    const d = await r.json();
    const title = d?.query?.random?.[0]?.title;
    if (!title) { showToast('Could not fetch random article', 3000); return; }
    await showArticleForTitle(title);
  } catch(e) {
    showToast('Could not fetch random article', 3000);
  }
}

/* ──────────────────────────────────────────────
   BOOT
────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  /* ── Panel close / back-to-map buttons ── */
  $('btn-panel-back').addEventListener('click', () => {
    if (panelMode === 'pathfind') exitPathMode(); else closePanel();
  });
  $('btn-back-to-map')?.addEventListener('click', () => {
    if (panelMode === 'pathfind') exitPathMode(); else closePanel();
  });

  /* ── Search input ── */
  const inp = $('topic-input');
  inp.addEventListener('input', () => {
    clearTimeout(acTimer); acSel=-1;
    const v = inp.value.trim();
    if (!v) { closeAc(); return; }
    acTimer = setTimeout(() => fetchSuggestions(v), 250);
  });
  inp.addEventListener('keydown', e => {
    const open = $('ac-dropdown').classList.contains('open');
    if (open && acItems.length) {
      if (e.key==='ArrowDown') { e.preventDefault(); acSel=Math.min(acSel+1,acItems.length-1); renderAc(); return; }
      if (e.key==='ArrowUp')   { e.preventDefault(); acSel=Math.max(acSel-1,-1); renderAc(); return; }
      if (e.key==='Enter' && acSel>=0) { e.preventDefault(); const it=acItems[acSel]; inp.value=it.title; closeAc(); handleSearch(it.title); return; }
      if (e.key==='Escape') { closeAc(); return; }
    }
    if (e.key==='Enter') { const v=inp.value.trim(); if(v){closeAc();handleSearch(v);} }
  });
  inp.addEventListener('blur', () => setTimeout(closeAc, 160));

  /* ── Random button ── */
  $('btn-random').addEventListener('click', handleRandom);

  /* ── Path Finder button ── */
  $('btn-pathfind')?.addEventListener('click', openPathModal);

  /* ── Path Finder modal ── */
  $('pathfind-backdrop')?.addEventListener('click', closePathModal);
  $('pathfind-close')?.addEventListener('click',   closePathModal);
  $('btn-pf-go')?.addEventListener('click', startPathFind);
  $('pf-from-input')?.addEventListener('keydown', e => { if (e.key === 'Enter') $('pf-to-input')?.focus(); });
  $('pf-to-input')?.addEventListener('keydown',   e => { if (e.key === 'Enter') startPathFind(); });

  /* ── Delegate: pfNodeClick — click node chip in path card ── */
  document.addEventListener('click', e => {
    const chip = e.target.closest('[data-action="pfNodeClick"]');
    if (chip) {
      const title = chip.dataset.title;
      if (!title) return;
      // In path mode: just highlight the node on the graph
      if (pathMode) {
        focusNode(title);
        selectNode(title);
        setTimeout(() => deselect(), 1800);
      } else if (rawNodes[title]) {
        focusNode(title);
        selectNode(title);
        showNodePanel(rawNodes[title]);
      } else {
        showArticleForTitle(title);
      }
    }
  });

  /* ── Escape key closes path modal ── */
  document.addEventListener('keydown', e => {
    const modal = $('pathfind-modal');
    if (e.key === 'Escape' && modal && !modal.classList.contains('hidden')) closePathModal();
  });

  /* ── Help modal ── */
  (function() {
    const modal   = $('help-modal');
    const btnHelp = $('btn-help');
    const btnClose= $('help-close');
    const backdrop= $('help-backdrop');

    // Populate domain swatches
    const domsEl = $('help-domains');
    if (domsEl) {
      const domNames = Object.keys(DOMAIN_COLOR);
      domsEl.innerHTML = domNames.map(d =>
        `<div class="hd-item">
          <span class="hd-swatch" style="background:${DOMAIN_COLOR[d]}"></span>
          <span>${d.charAt(0).toUpperCase()+d.slice(1)}</span>
        </div>`
      ).join('');
    }

    // Populate edge type legend (skip structural — internal only)
    const edgeTypesEl = $('help-edge-types');
    if (edgeTypesEl) {
      const richTypes = Object.keys(EDGE_COLOR).filter(t => t !== 'structural');
      edgeTypesEl.innerHTML = richTypes.map(t =>
        `<div class="het-item">
          <span class="het-swatch" style="background:${EDGE_COLOR[t]}"></span>
          <span class="het-name">${t.charAt(0).toUpperCase()+t.slice(1)}</span>
        </div>`
      ).join('');
    }

    function openHelp()  { modal.classList.remove('hidden'); document.body.style.overflow='hidden'; }
    function closeHelp() { modal.classList.add('hidden');    document.body.style.overflow=''; }

    btnHelp.addEventListener('click', openHelp);
    btnClose.addEventListener('click', closeHelp);
    backdrop.addEventListener('click', closeHelp);
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && !modal.classList.contains('hidden')) closeHelp(); });
  })();

  /* ── Auto-start from ?study= URL param ── */
  const params = new URLSearchParams(window.location.search);
  const autoTopic = params.get('study');
  if (autoTopic) {
    setTimeout(() => startStudyForTitle(autoTopic.slice(0, TOPIC_MAX)), 300);
  }

  /* ── Boot graph ── */
  loadGraph().then(() => connectSSE());
  renderLibrary();

  /* ── Check for in-progress path session ── */
  setTimeout(checkPathResume, 600);

  /* ── Load stats ── */
  fetch(STATS_API).then(r=>r.json()).then(d => {
    if (d.node_count) $('stat-nodes').textContent = d.node_count;
    if (d.edge_count) $('stat-edges').textContent = d.edge_count;
    // Update help modal footer with live stats
    const hf = document.querySelector('.help-footer');
    if (hf && d.node_count) {
      hf.innerHTML = `WikiDactic is open and growing — <span>${d.node_count} articles</span> classified · <span>${d.edge_count || '–'} connections</span> mapped`;
    }
  }).catch(()=>{});
});
