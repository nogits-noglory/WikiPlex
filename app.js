
'use strict';

const PROXY_API   = '/api/generate';
const GRAPH_API   = '/api/graph';
const STREAM_API  = '/api/graph/stream';
const SEARCH_API  = '/api/search';
const NODE_API    = '/api/node';
const STATS_API   = '/api/stats';
const TOPIC_MAX   = 200;

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
  interpersonal:'#dd4444', geographical:'#2299aa',
  temporal:'#aa7700',      categorical:'#338866',
  etymological:'#7744aa',  positional:'#996600',
  structural:'rgba(60,120,200,0.25)',
};
function edgeColor(e) {
  return e._src === 'ai_inference' ? (EDGE_COLOR[e.type] || '#3a3a66') : EDGE_COLOR.structural;
}
function nodeRadius(d) { return 6 + (d.depth_score || 3) * 1.8; }

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
  ['pc-idle','pc-loading','pc-article','pc-node','pc-study']
    .forEach(pc => $(pc).classList.toggle('hidden', pc !== id));
}

function openPanel(mode) {
  panelMode = mode;
  $('detail-panel').classList.add('open');
  // Push graph center left so nodes don't hide behind panel
  if (window.innerWidth > 768) nudgeGraph(true);
}
function closePanel() {
  $('detail-panel').classList.remove('open');
  $('study-tabs').classList.add('hidden');
  showPC('pc-idle');
  panelMode = 'idle';
  deselect();
  if (window.innerWidth > 768) nudgeGraph(false);
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

function makeSimulation() {
  return d3.forceSimulation()
    .force('link', d3.forceLink()
      .id(d => d.id)
      .distance(d => d._src === 'ai_inference' ? 130 : 175)
      .strength(d => d._src === 'ai_inference' ? 0.55 : 0.2)
    )
    .force('charge', d3.forceManyBody()
      .strength(d => -(260 + (d.depth_score || 3) * 28))
      .distanceMax(520)
    )
    .force('collide', d3.forceCollide()
      .radius(d => nodeRadius(d) + 34)
      .iterations(2)
    )
    .force('center', d3.forceCenter(graphCenterX(), H()/2).strength(0.06))
    .alphaDecay(0.022);
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

  // Show all edges where both classified nodes exist, PLUS frontier ghost nodes
  // for the top-K most-connected unclassified neighbors (limited for performance)
  const allEdges = (data.edges || []);
  const classifiedEdges = allEdges.filter(e => nodeIds.has(e.from) && nodeIds.has(e.to));

  // Build frontier ghost nodes from top-50 most-referenced unclassified neighbors
  const neighborCount = new Map();
  allEdges.forEach(e => {
    if (nodeIds.has(e.from) && !nodeIds.has(e.to))
      neighborCount.set(e.to, (neighborCount.get(e.to)||0)+1);
    if (nodeIds.has(e.to) && !nodeIds.has(e.from))
      neighborCount.set(e.from, (neighborCount.get(e.from)||0)+1);
  });
  const ghostIds = [...neighborCount.entries()]
    .sort((a,b) => b[1]-a[1])
    .slice(0, 80)
    .map(([id]) => id);
  const ghostIdSet = new Set(ghostIds);

  // Edges: classified↔classified + classified↔ghost (top-80 frontier)
  const frontierEdges = allEdges.filter(e =>
    (nodeIds.has(e.from) && ghostIdSet.has(e.to)) ||
    (nodeIds.has(e.to) && ghostIdSet.has(e.from))
  );

  // Where an AI edge exists for a pair, drop the structural duplicate
  const allVisEdges = [...classifiedEdges, ...frontierEdges];
  const aiPairs = new Set(
    allVisEdges.filter(e => e.source === 'ai_inference').map(e => `${e.from}||${e.to}`)
  );
  const visEdges = allVisEdges.filter(e =>
    e.source === 'ai_inference' || !aiPairs.has(`${e.from}||${e.to}`)
  );

  // Preserve positions from previous render
  const pos = new Map(gNodes.map(n => [n.id, {x:n.x, y:n.y}]));
  const classifiedNodes = Object.values(rawNodes).map(n => {
    const p = pos.get(n.id);
    return { ...n, x: p?.x, y: p?.y };
  });
  // Ghost nodes placed randomly near center
  const cx = graphCenterX(), cy = H()/2;
  const ghostNodes = ghostIds.map(id => {
    const p = pos.get(id);
    return {
      id, title: id, ghost: true, primary_domain: 'other', depth_score: 1,
      x: p?.x ?? (cx + (Math.random()-.5)*300),
      y: p?.y ?? (cy + (Math.random()-.5)*300),
    };
  });
  gNodes = [...classifiedNodes, ...ghostNodes];

  gLinks = visEdges.map(e => ({
    ...e,
    _src:   e.source,   // 'ai_inference' | 'wikipedia_links'
    source: e.from,
    target: e.to,
  }));

  renderGraph();
  updateStats(data.meta);
}

/* ── Render / update graph ── */
function renderGraph() {
  if (!simulation) simulation = makeSimulation();

  const tooltip = $('edge-tooltip');

  /* ── Edge visual lines ── */
  const visLines = edgeVisG.selectAll('line.ev')
    .data(gLinks, d => `${d.from}||${d.to}||${d.predicate}`)
    .join(
      enter => enter.append('line').attr('class','ev edge-visual')
        .attr('stroke-opacity',0)
        .call(s => s.transition().duration(500).attr('stroke-opacity',
          d => d._src === 'ai_inference' ? 0.75 : 1)),
      update => update,
      exit => exit.transition().duration(250).attr('stroke-opacity',0).remove()
    )
    .attr('stroke', d => edgeColor(d))
    .attr('stroke-width', d => d._src === 'ai_inference' ? 1.8 : 0.8);

  /* ── Edge hit areas ── */
  const hitLines = edgeHitG.selectAll('line.eh')
    .data(gLinks, d => `${d.from}||${d.to}||${d.predicate}`)
    .join('line')
    .attr('class', d => `eh edge-hit${d._src === 'ai_inference' ? ' clickable' : ''}`)
    .attr('stroke','transparent')
    .attr('stroke-width', 14)
    .on('mouseenter', (event, d) => {
      if (d._src !== 'ai_inference') return;
      edgeVisG.selectAll('line.ev').classed('faded', true);
      d3.select(visLines.nodes()[gLinks.indexOf(d)]).classed('faded',false).classed('hovered',true);
      tooltip.innerHTML = `<span>${esc(d.predicate)}</span>`;
      tooltip.style.display = 'block';
      moveTooltip(event, tooltip);
    })
    .on('mousemove', (event) => moveTooltip(event, tooltip))
    .on('mouseleave', (event, d) => {
      if (d._src !== 'ai_inference') return;
      edgeVisG.selectAll('line.ev').classed('faded',false).classed('hovered',false);
      tooltip.style.display = 'none';
    })
    .on('click', (event, d) => {
      if (d._src !== 'ai_inference') return;
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
    if (d.ghost) {
      g.select('.node-main').attr('r', 5).attr('fill', '#3366aa').attr('opacity', 0.7);
      g.select('.node-glow').attr('r', 9).attr('fill', '#2255aa').attr('opacity', 0.22);
      g.select('.node-ring').attr('r', 0).attr('stroke', 'none');
      g.select('.node-conquest-ring').attr('opacity', 0);
      g.select('.node-core').attr('r', 0);
      g.select('.node-label').attr('fill', '#2a4a7a').attr('dy', 18)
        .text(truncLabel(d.title));
      return;
    }

    const r = nodeRadius(d);
    const ps = getPS(d.id);

    g.select('.node-conquest-ring').attr('r', r + 12);
    g.select('.node-ring').attr('r', r + 6);
    g.select('.node-glow').attr('r', r + 8);
    g.select('.node-main').attr('r', r)
      .attr('fill', domainColor(d.primary_domain))
      .attr('opacity', ps === PS.UNTOUCHED ? 0.82 : 1);
    g.select('.node-glow').attr('fill', domainColor(d.primary_domain))
      .attr('opacity', ps === PS.UNTOUCHED ? 0.18 : 0.38);
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
function showEdgePanel(d) {
  const srcId = typeof d.source==='object' ? d.source.id : d.source;
  const tgtId = typeof d.target==='object' ? d.target.id : d.target;
  const src   = rawNodes[srcId] || {title:srcId};
  const tgt   = rawNodes[tgtId] || {title:tgtId};
  const ec    = EDGE_COLOR[d.type] || '#4a4a88';

  setPanelHeader('Connection', null, null);

  setHTML($('pc-node'), `
    <div class="pe-nodes">
      <div class="pe-node-nm" style="border-color:${domainColor(src.primary_domain)}44">${esc(src.title)}</div>
      <div class="pe-arrow">
        <div class="pe-predicate" style="color:${ec}">${esc(d.predicate)}</div>
        <div style="font-size:20px;color:var(--border2);margin:2px 0">↓</div>
      </div>
      <div class="pe-node-nm" style="border-color:${domainColor(tgt.primary_domain)}44">${esc(tgt.title)}</div>
    </div>
    ${d.source_sentence
      ? `<div class="pe-sentence ai">"${esc(d.source_sentence)}"</div>`
      : `<div class="pe-sentence">No source sentence for this edge.</div>`
    }
    ${ndRow('edge type', d.type||'–')}
    ${ndRow('source',    d._src==='ai_inference' ? 'AI inference' : 'Wikipedia link')}
    ${ndRow('weight',    d.weight!=null ? d.weight.toFixed(1) : '–')}
    <div style="margin-top:8px">
      <span style="font-family:var(--mono);font-size:8px;color:${ec};border:1px solid ${ec}44;padding:2px 7px;letter-spacing:1px;text-transform:uppercase">${esc(d.type||'unknown')}</span>
    </div>
  `);

  showPC('pc-node');
  openPanel('node');
}

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
           href="https:
           target="_blank" rel="noopener">Open on Wikipedia ↗</a>
      </div>
    `);
    showPC('pc-article');
    openPanel('article');
    return;
  }
  setPS(title, PS.VIEWED);

  const wikiUrl = `https:
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
      <button class="btn-cta-secondary" id="btn-graph-it">Classify for Map</button>
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

  $('btn-graph-it').onclick = async () => {
    const btn = $('btn-graph-it');
    btn.disabled = true;
    btn.textContent = 'Classifying…';
    try {
      const r = await fetch('/api/classify', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({title: wiki.title})
      });
      const data = await r.json();
      if (r.ok) {
        showToast(`${wiki.title} queued for the map`);
        btn.textContent = 'Queued';
      } else {
        btn.disabled = false;
        btn.textContent = 'Classify for Map';
        showToast(data.error || 'Classification failed', 4000);
      }
    } catch(e) {
      btn.disabled = false;
      btn.textContent = 'Add to graph only';
      showToast('Network error', 4000);
    }
  };

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
  
  try {
    const r = await fetch(`${NODE_API}/${encodeURIComponent(title)}`);
    if (r.ok) {
      const data = await r.json();
      if (data.curriculum) {
        state.topic = title;
        state.wikiUrl = `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g,'_'))}`;
        state.curriculum = data.curriculum;
        state.wikiText = '';
        resetStudyState();
        renderStudy();
        return;
      }
    }
  } catch {}

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
    resetStudyState();
    setPS(wiki.title, PS.STUDIED);
    renderStudy();
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
    const r = await fetch('/api/random');
    const d = await r.json();
    const title = d.title || (d.node && (d.node.title || d.node.id));
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
  /* ── Panel close button ── */
  $('btn-panel-back').addEventListener('click', closePanel);

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
