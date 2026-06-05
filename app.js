'use strict';

// ═══════════════════════════════════════════════════════════
// CONSTANTS & CONFIG
// ═══════════════════════════════════════════════════════════
const MAP_W = 2800;
const MAP_H = 2200;
const NODE_COUNT = 56;
const VEHICLE_SPEED  = { car: 1.8, moto: 2.6, bike: 1.0, walk: 0.5 };
const VEHICLE_COLORS = { car: '#f6e05e', moto: '#fc8181', bike: '#68d391', walk: '#a78bfa' };
const VEHICLE_SIZES  = { car: 9, moto: 7, bike: 6, walk: 5 };
const ROAD_W       = 14;
const ROAD_W_MAJOR = 20;

// ═══════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════
let nodes = [], edges = [];
let vehicles = [];
let pathStart = null, pathEnd = null, activePath = [];
let pickMode = null; // 'start' | 'end'
let zoom = 1, panX = 0, panY = 0;
let isDragging = false, dragStart = { x: 0, y: 0 }, panStart = { x: 0, y: 0 };
let animFrame = null;
let seed = Math.random() * 9999 | 0;

// ═══════════════════════════════════════════════════════════
// SEEDED RNG
// ═══════════════════════════════════════════════════════════
let _seed = seed;
function rng() {
  _seed = (_seed * 16807 + 0) % 2147483647;
  return (_seed - 1) / 2147483646;
}
function rngRange(a, b) { return a + rng() * (b - a); }
function rngInt(a, b)   { return Math.floor(rngRange(a, b + 1)); }
function rngChoice(arr) { return arr[Math.floor(rng() * arr.length)]; }
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ═══════════════════════════════════════════════════════════
// MAP GENERATION
// ═══════════════════════════════════════════════════════════
function generateMap(s) {
  _seed = s;
  nodes = []; edges = [];

  const MARGIN = 180;
  const cols = 8, rows = 7;
  const cellW = (MAP_W - MARGIN * 2) / cols;
  const cellH = (MAP_H - MARGIN * 2) / rows;

  // Place nodes in grid with organic jitter
  for (let r = 0; r <= rows; r++) {
    for (let c = 0; c <= cols; c++) {
      const jx = (c === 0 || c === cols) ? 0 : rngRange(-cellW * 0.35, cellW * 0.35);
      const jy = (r === 0 || r === rows) ? 0 : rngRange(-cellH * 0.35, cellH * 0.35);
      nodes.push({
        id: nodes.length,
        x: MARGIN + c * cellW + jx,
        y: MARGIN + r * cellH + jy,
        isMajor: (c % 2 === 0 && r % 2 === 0)
      });
    }
  }

  // Add extra organic nodes
  const extras = 18;
  for (let i = 0; i < extras; i++) {
    nodes.push({
      id: nodes.length,
      x: rngRange(MARGIN, MAP_W - MARGIN),
      y: rngRange(MARGIN, MAP_H - MARGIN),
      isMajor: false
    });
  }

  // Build spanning tree first (guarantees full connectivity)
  const inTree = new Set([0]);
  const edgeSet = new Set();
  const addEdge = (a, b, major) => {
    const key = Math.min(a, b) + '_' + Math.max(a, b);
    if (!edgeSet.has(key)) {
      edgeSet.add(key);
      const dx = nodes[a].x - nodes[b].x;
      const dy = nodes[a].y - nodes[b].y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      edges.push({ a, b, dist, major, ctrl: generateCtrl(nodes[a], nodes[b]) });
    }
  };

  while (inTree.size < nodes.length) {
    let bestDist = Infinity, bestA = -1, bestB = -1;
    for (const a of inTree) {
      for (let b = 0; b < nodes.length; b++) {
        if (inTree.has(b)) continue;
        const dx = nodes[a].x - nodes[b].x;
        const dy = nodes[a].y - nodes[b].y;
        const d = Math.sqrt(dx * dx + dy * dy) + rng() * 80;
        if (d < bestDist) { bestDist = d; bestA = a; bestB = b; }
      }
    }
    inTree.add(bestB);
    addEdge(bestA, bestB, nodes[bestA].isMajor && nodes[bestB].isMajor);
  }

  // Add organic extra connections (density)
  for (let a = 0; a < nodes.length; a++) {
    const candidates = [];
    for (let b = 0; b < nodes.length; b++) {
      if (a === b) continue;
      const dx = nodes[a].x - nodes[b].x;
      const dy = nodes[a].y - nodes[b].y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < 400) candidates.push({ b, d });
    }
    candidates.sort((x, y) => x.d - y.d);
    const limit = rngInt(1, 3);
    for (let i = 0; i < Math.min(limit, candidates.length); i++) {
      if (rng() < 0.55) addEdge(a, candidates[i].b, false);
    }
  }
}

function generateCtrl(na, nb) {
  const mx = (na.x + nb.x) / 2;
  const my = (na.y + nb.y) / 2;
  const dx = nb.x - na.x;
  const dy = nb.y - na.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  const px = -dy / len;
  const py =  dx / len;
  const offset  = rngRange(-len * 0.45, len * 0.45);
  const tension = rngRange(0.1, 0.45);
  return [
    { x: mx + px * offset * tension, y: my + py * offset * tension }
  ];
}

// ═══════════════════════════════════════════════════════════
// PATH ON BEZIER CURVE
// ═══════════════════════════════════════════════════════════
function getPointOnEdge(edge, t) {
  const na = nodes[edge.a];
  const nb = nodes[edge.b];
  const [cp] = edge.ctrl;
  const mt = 1 - t;
  return {
    x: mt * mt * na.x + 2 * mt * t * cp.x + t * t * nb.x,
    y: mt * mt * na.y + 2 * mt * t * cp.y + t * t * nb.y
  };
}

function getTangentOnEdge(edge, t) {
  const na = nodes[edge.a];
  const nb = nodes[edge.b];
  const [cp] = edge.ctrl;
  const mt = 1 - t;
  const tx = 2 * mt * (cp.x - na.x) + 2 * t * (nb.x - cp.x);
  const ty = 2 * mt * (cp.y - na.y) + 2 * t * (nb.y - cp.y);
  const len = Math.sqrt(tx * tx + ty * ty) || 1;
  return { x: tx / len, y: ty / len };
}

function edgePath(edge) {
  const na = nodes[edge.a];
  const nb = nodes[edge.b];
  const [cp] = edge.ctrl;
  return `M ${na.x} ${na.y} Q ${cp.x} ${cp.y} ${nb.x} ${nb.y}`;
}

// ═══════════════════════════════════════════════════════════
// ADJACENCY & GRAPH
// ═══════════════════════════════════════════════════════════
function buildAdjacency() {
  const adj = new Map();
  nodes.forEach(n => adj.set(n.id, []));
  edges.forEach((e, idx) => {
    adj.get(e.a).push({ node: e.b, edge: idx, dist: e.dist });
    adj.get(e.b).push({ node: e.a, edge: idx, dist: e.dist });
  });
  return adj;
}

// ═══════════════════════════════════════════════════════════
// DIJKSTRA PATHFINDING
// ═══════════════════════════════════════════════════════════
function dijkstra(startId, endId) {
  const adj = buildAdjacency();
  const dist = new Map();
  const prev = new Map();
  const prevEdge = new Map();
  const visited = new Set();

  nodes.forEach(n => dist.set(n.id, Infinity));
  dist.set(startId, 0);

  const pq = [{ id: startId, d: 0 }];

  while (pq.length) {
    pq.sort((a, b) => a.d - b.d);
    const { id: u } = pq.shift();
    if (visited.has(u)) continue;
    visited.add(u);
    if (u === endId) break;

    for (const { node: v, edge: ei, dist: w } of (adj.get(u) || [])) {
      const nd = dist.get(u) + w;
      if (nd < dist.get(v)) {
        dist.set(v, nd);
        prev.set(v, u);
        prevEdge.set(v, { edgeIdx: ei, reversed: edges[ei].b === u });
        pq.push({ id: v, d: nd });
      }
    }
  }

  if (dist.get(endId) === Infinity) return null;

  const path = [];
  let cur = endId;
  while (cur !== startId) {
    const ep = prevEdge.get(cur);
    path.unshift({ nodeId: cur, ...ep });
    cur = prev.get(cur);
  }
  path.unshift({ nodeId: startId });
  return path;
}

// ═══════════════════════════════════════════════════════════
// SVG HELPERS & LAYERS
// ═══════════════════════════════════════════════════════════
const svg = document.getElementById('map-svg');
svg.setAttribute('width', MAP_W);
svg.setAttribute('height', MAP_H);
svg.setAttribute('viewBox', `0 0 ${MAP_W} ${MAP_H}`);

let roadLayer, highlightLayer, nodeLayer, vehicleLayer, flagLayer, buildingLayer;

function setupLayers() {
  svg.innerHTML = '';

  const defs = svgEl('defs');

  // Road glow filter
  const filt = svgEl('filter', { id: 'road-glow', x: '-20%', y: '-20%', width: '140%', height: '140%' });
  const feBlur = svgEl('feGaussianBlur', { in: 'SourceGraphic', stdDeviation: '3', result: 'blur' });
  const feMerge = svgEl('feMerge');
  feMerge.appendChild(svgEl('feMergeNode', { in: 'blur' }));
  feMerge.appendChild(svgEl('feMergeNode', { in: 'SourceGraphic' }));
  filt.appendChild(feBlur); filt.appendChild(feMerge);
  defs.appendChild(filt);

  // Path highlight filter
  const filt2 = svgEl('filter', { id: 'path-glow' });
  filt2.appendChild(svgEl('feGaussianBlur', { in: 'SourceGraphic', stdDeviation: '4', result: 'blur' }));
  const feMerge2 = svgEl('feMerge');
  feMerge2.appendChild(svgEl('feMergeNode', { in: 'blur' }));
  feMerge2.appendChild(svgEl('feMergeNode', { in: 'SourceGraphic' }));
  filt2.appendChild(feMerge2);
  defs.appendChild(filt2);

  svg.appendChild(defs);

  buildingLayer  = svgEl('g', { id: 'buildings' });
  roadLayer      = svgEl('g', { id: 'roads' });
  highlightLayer = svgEl('g', { id: 'highlights' });
  nodeLayer      = svgEl('g', { id: 'nodes' });
  vehicleLayer   = svgEl('g', { id: 'vehicles' });
  flagLayer      = svgEl('g', { id: 'flags' });

  svg.appendChild(buildingLayer);
  svg.appendChild(roadLayer);
  svg.appendChild(highlightLayer);
  svg.appendChild(nodeLayer);
  svg.appendChild(vehicleLayer);
  svg.appendChild(flagLayer);
}

function svgEl(tag, attrs = {}) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

// ═══════════════════════════════════════════════════════════
// BUILDING RENDERING
// ═══════════════════════════════════════════════════════════
function renderBuildings() {
  buildingLayer.innerHTML = '';

  const TYPES = ['residential', 'commercial', 'tower', 'park'];
  const placed = [];

  const cols = 7, rows = 6;
  const cellW = (MAP_W - 360) / cols;
  const cellH = (MAP_H - 360) / rows;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cx = 180 + c * cellW + cellW / 2;
      const cy = 180 + r * cellH + cellH / 2;

      const tooClose = nodes.some(n => {
        const dx = n.x - cx, dy = n.y - cy;
        return Math.sqrt(dx * dx + dy * dy) < 90;
      });
      if (tooClose) continue;

      const count = rngInt(1, 3);
      for (let i = 0; i < count; i++) {
        const bx = cx + rngRange(-cellW * 0.28, cellW * 0.28);
        const by = cy + rngRange(-cellH * 0.28, cellH * 0.28);

        const nearEdge = edges.some(e => {
          const na = nodes[e.a], nb = nodes[e.b];
          const cp = e.ctrl[0];
          for (let t = 0; t <= 1; t += 0.15) {
            const mt = 1 - t;
            const px = mt * mt * na.x + 2 * mt * t * cp.x + t * t * nb.x;
            const py = mt * mt * na.y + 2 * mt * t * cp.y + t * t * nb.y;
            const dx = px - bx, dy = py - by;
            if (Math.sqrt(dx * dx + dy * dy) < 55) return true;
          }
          return false;
        });
        if (nearEdge) continue;

        const type = rngChoice(TYPES);
        placed.push({ x: bx, y: by, type, angle: rngRange(-15, 15) });
      }
    }
  }

  placed.forEach(b => {
    const g = svgEl('g', { transform: `translate(${b.x.toFixed(1)}, ${b.y.toFixed(1)}) rotate(${b.angle.toFixed(1)})` });

    if (b.type === 'tower') {
      const w = rngRange(22, 40), h = rngRange(50, 100);
      g.appendChild(svgEl('rect', { x: -w/2, y: -h, width: w, height: h, rx: 2,
        fill: 'var(--building-roof)', stroke: 'var(--building-stroke)', 'stroke-width': 1 }));
      g.appendChild(svgEl('rect', { x: -w/2, y: -h, width: w, height: h * 0.85, rx: 2,
        fill: 'var(--building-fill)', stroke: 'var(--building-stroke)', 'stroke-width': 1 }));
      const wCols = Math.floor(w / 7), wRows = Math.floor(h * 0.7 / 8);
      for (let wr = 0; wr < wRows; wr++) {
        for (let wc = 0; wc < wCols; wc++) {
          const wx = -w/2 + 3 + wc * (w - 6) / wCols;
          const wy = -h + 6 + wr * (h * 0.7) / wRows;
          if (rng() > 0.35) {
            g.appendChild(svgEl('rect', { x: wx, y: wy, width: 4, height: 5,
              fill: 'var(--building-window)', rx: 0.5 }));
          }
        }
      }
      g.appendChild(svgEl('line', { x1: 0, y1: -h, x2: 0, y2: -h - 14,
        stroke: 'var(--building-stroke)', 'stroke-width': 1.5 }));
      g.appendChild(svgEl('circle', { cx: 0, cy: -h - 14, r: 2, fill: 'rgba(255,80,80,0.7)' }));

    } else if (b.type === 'commercial') {
      const w = rngRange(40, 70), h = rngRange(16, 30);
      g.appendChild(svgEl('rect', { x: -w/2, y: -h, width: w, height: h, rx: 2,
        fill: 'var(--building-fill)', stroke: 'var(--building-stroke)', 'stroke-width': 1 }));
      const stripes = Math.floor(w / 14);
      for (let s = 0; s < stripes; s++) {
        const sx = -w/2 + 4 + s * (w - 8) / stripes;
        g.appendChild(svgEl('rect', { x: sx, y: -h + 3, width: (w - 8)/stripes - 3, height: h - 6, rx: 1,
          fill: 'var(--building-window)' }));
      }
      g.appendChild(svgEl('rect', { x: -w/2, y: -h - 3, width: w, height: 3, rx: 1,
        fill: 'var(--building-roof)', stroke: 'var(--building-stroke)', 'stroke-width': 0.5 }));

    } else if (b.type === 'park') {
      const r = rngRange(18, 32);
      g.appendChild(svgEl('ellipse', { cx: 0, cy: 0, rx: r, ry: r * 0.7,
        fill: 'rgba(60,140,60,0.18)', stroke: 'rgba(80,160,80,0.3)', 'stroke-width': 1 }));
      const treeCount = rngInt(2, 5);
      for (let t = 0; t < treeCount; t++) {
        const tx = rngRange(-r * 0.7, r * 0.7);
        const ty = rngRange(-r * 0.5, r * 0.5);
        g.appendChild(svgEl('circle', { cx: tx, cy: ty, r: rngRange(4, 8),
          fill: 'rgba(50,160,70,0.35)', stroke: 'rgba(60,120,60,0.4)', 'stroke-width': 0.8 }));
      }

    } else {
      // Residential
      const w = rngRange(18, 32), h = rngRange(18, 36);
      g.appendChild(svgEl('rect', { x: -w/2 + 3, y: -h + 3, width: w, height: h, rx: 2,
        fill: 'rgba(0,0,0,0.2)' }));
      g.appendChild(svgEl('rect', { x: -w/2, y: -h, width: w, height: h, rx: 2,
        fill: 'var(--building-fill)', stroke: 'var(--building-stroke)', 'stroke-width': 1 }));
      const roofPts = `${-w/2},${-h} 0,${-h - w*0.4} ${w/2},${-h}`;
      g.appendChild(svgEl('polygon', { points: roofPts,
        fill: 'var(--building-roof)', stroke: 'var(--building-stroke)', 'stroke-width': 0.8 }));
      const winCount = rngInt(1, 2);
      for (let wi = 0; wi < winCount; wi++) {
        const wx = -w/4 + wi * w/2;
        g.appendChild(svgEl('rect', { x: wx - 4, y: -h + 5, width: 6, height: 7, rx: 1,
          fill: 'var(--building-window)' }));
      }
      g.appendChild(svgEl('rect', { x: -3, y: -8, width: 6, height: 8, rx: 1,
        fill: 'rgba(0,0,0,0.35)' }));
    }

    buildingLayer.appendChild(g);
  });
}

// ═══════════════════════════════════════════════════════════
// ROAD RENDERING
// ═══════════════════════════════════════════════════════════
function renderRoads() {
  roadLayer.innerHTML = '';
  const isLight = document.body.classList.contains('light');

  // Shadow
  edges.forEach(e => {
    const w = e.major ? ROAD_W_MAJOR + 8 : ROAD_W + 6;
    roadLayer.appendChild(svgEl('path', {
      d: edgePath(e), fill: 'none',
      stroke: 'rgba(0,0,0,0.5)', 'stroke-width': w, 'stroke-linecap': 'round'
    }));
  });

  // Road body
  edges.forEach(e => {
    const w = e.major ? ROAD_W_MAJOR : ROAD_W;
    const col = isLight
      ? (e.major ? '#8aa0c4' : '#a8b8d0')
      : (e.major ? '#2e4670' : '#1e2f4a');
    roadLayer.appendChild(svgEl('path', {
      d: edgePath(e), fill: 'none',
      stroke: col, 'stroke-width': w, 'stroke-linecap': 'round'
    }));
  });

  // Center line
  edges.forEach(e => {
    const w = e.major ? 1.8 : 1.2;
    roadLayer.appendChild(svgEl('path', {
      d: edgePath(e), fill: 'none',
      stroke: 'rgba(255,210,0,0.18)', 'stroke-width': w, 'stroke-linecap': 'round',
      'stroke-dasharray': e.major ? '16 12' : '10 10'
    }));
  });

  // Curb lines
  edges.forEach(e => {
    const w = e.major ? ROAD_W_MAJOR : ROAD_W;
    roadLayer.appendChild(svgEl('path', {
      d: edgePath(e), fill: 'none',
      stroke: 'rgba(0,212,255,0.08)', 'stroke-width': w + 1,
      'stroke-linecap': 'round', 'stroke-dasharray': 'none'
    }));
  });
}

// ═══════════════════════════════════════════════════════════
// NODE RENDERING
// ═══════════════════════════════════════════════════════════
function renderNodes() {
  nodeLayer.innerHTML = '';
  const isLight = document.body.classList.contains('light');

  nodes.forEach(n => {
    const r   = n.isMajor ? 7 : 4;
    const col = isLight
      ? (n.isMajor ? '#5a7ab0' : '#7090b8')
      : (n.isMajor ? '#3a5a8c' : '#1e3050');

    nodeLayer.appendChild(svgEl('circle', { cx: n.x, cy: n.y, r: r + 3, fill: 'rgba(0,0,0,0.15)' }));
    nodeLayer.appendChild(svgEl('circle', {
      cx: n.x, cy: n.y, r,
      fill: col,
      stroke: n.isMajor ? 'rgba(0,212,255,0.5)' : 'rgba(0,212,255,0.2)',
      'stroke-width': 1.5,
      'data-nid': n.id,
      class: 'node-dot',
      style: 'cursor:pointer'
    }));
  });
}

// ═══════════════════════════════════════════════════════════
// PATH RENDERING
// ═══════════════════════════════════════════════════════════
function renderPath(path) {
  highlightLayer.innerHTML = '';
  if (!path || path.length < 2) return;

  for (let i = 1; i < path.length; i++) {
    const ep   = path[i];
    const edge = edges[ep.edgeIdx];
    const d    = ep.reversed
      ? `M ${nodes[edge.b].x} ${nodes[edge.b].y} Q ${edge.ctrl[0].x} ${edge.ctrl[0].y} ${nodes[edge.a].x} ${nodes[edge.a].y}`
      : edgePath(edge);

    // Glow layer
    highlightLayer.appendChild(svgEl('path', {
      d, fill: 'none',
      stroke: 'rgba(0,212,255,0.25)', 'stroke-width': 22,
      'stroke-linecap': 'round', filter: 'url(#path-glow)'
    }));

    // Animated dash
    highlightLayer.appendChild(svgEl('path', {
      d, fill: 'none',
      stroke: '#00d4ff', 'stroke-width': 4,
      'stroke-linecap': 'round', 'stroke-dasharray': '8 5',
      class: 'path-dash'
    }));
  }
}

// ═══════════════════════════════════════════════════════════
// FLAGS
// ═══════════════════════════════════════════════════════════
function renderFlags() {
  flagLayer.innerHTML = '';
  if (pathStart !== null) drawFlag(nodes[pathStart], '#e53e3e', 'S');
  if (pathEnd   !== null) drawFlag(nodes[pathEnd],   '#38a169', 'E');
}

function drawFlag(node, color, letter) {
  const g = svgEl('g', { transform: `translate(${node.x}, ${node.y})` });
  g.appendChild(svgEl('line', { x1: 0, y1: 0, x2: 0, y2: -36, stroke: color, 'stroke-width': 2.5 }));
  g.appendChild(svgEl('polygon', {
    points: '0,-36 18,-28 0,-20',
    fill: color, stroke: 'rgba(0,0,0,0.3)', 'stroke-width': 1
  }));
  g.appendChild(svgEl('circle', {
    cx: 0, cy: 0, r: 6,
    fill: color, stroke: 'rgba(0,0,0,0.4)', 'stroke-width': 2
  }));
  const txt = svgEl('text', {
    x: 9, y: -25, fill: 'white',
    'font-size': 9, 'font-family': 'JetBrains Mono, monospace',
    'font-weight': 'bold', 'text-anchor': 'middle'
  });
  txt.textContent = letter;
  g.appendChild(txt);
  flagLayer.appendChild(g);
}

// ═══════════════════════════════════════════════════════════
// VEHICLE SYSTEM
// ═══════════════════════════════════════════════════════════
function createVehicle(type) {
  const adj       = buildAdjacency();
  const startNode = rngInt(0, nodes.length - 1);
  const nbrs      = adj.get(startNode);
  if (!nbrs || nbrs.length === 0) return null;

  const edgePath_ = [];
  let cur = startNode;
  const pathLen = rngInt(4, 12);
  for (let i = 0; i < pathLen; i++) {
    const nb = adj.get(cur);
    if (!nb || nb.length === 0) break;
    const next = rngChoice(nb);
    edgePath_.push({ edgeIdx: next.edge, reversed: edges[next.edge].b === cur });
    cur = next.node;
  }

  if (edgePath_.length === 0) return null;

  return {
    id: Math.random().toString(36).slice(2),
    type,
    path: edgePath_,
    pathIdx: 0,
    t: 0,
    speed: VEHICLE_SPEED[type] * rngRange(0.7, 1.3),
    el: null,
    angle: 0
  };
}

function spawnVehicles(count = 12) {
  vehicles = [];
  const types = ['car', 'car', 'car', 'moto', 'moto', 'bike', 'walk'];
  for (let i = 0; i < count; i++) {
    const type = rngChoice(types);
    const v    = createVehicle(type);
    if (v) vehicles.push(v);
  }
  renderVehicleElements();
}

function renderVehicleElements() {
  vehicleLayer.innerHTML = '';
  vehicles.forEach(v => {
    const size  = VEHICLE_SIZES[v.type];
    const color = VEHICLE_COLORS[v.type];
    const g     = svgEl('g');
    g.setAttribute('data-vid', v.id);

    if (v.type === 'car') {
      g.appendChild(svgEl('rect', { x: -size, y: -size*0.55, width: size*2, height: size*1.1, rx: size*0.35, fill: color, stroke: 'rgba(0,0,0,0.5)', 'stroke-width': 1 }));
      g.appendChild(svgEl('rect', { x: -size*0.5, y: -size*0.9, width: size*1, height: size*0.45, rx: size*0.15, fill: 'rgba(100,200,255,0.6)', stroke: 'rgba(0,0,0,0.3)', 'stroke-width': 0.5 }));
      g.appendChild(svgEl('circle', { cx: size-1, cy: -size*0.25, r: 1.8, fill: 'rgba(255,255,180,0.9)' }));
      g.appendChild(svgEl('circle', { cx: size-1, cy:  size*0.25, r: 1.8, fill: 'rgba(255,255,180,0.9)' }));
    } else if (v.type === 'moto') {
      g.appendChild(svgEl('ellipse', { cx: 0, cy: 0, rx: size*1.2, ry: size*0.4, fill: color, stroke: 'rgba(0,0,0,0.4)', 'stroke-width': 1 }));
      g.appendChild(svgEl('circle', { cx:  size*0.9, cy: 0, r: size*0.35, fill: 'none', stroke: '#888', 'stroke-width': 1.5 }));
      g.appendChild(svgEl('circle', { cx: -size*0.9, cy: 0, r: size*0.35, fill: 'none', stroke: '#888', 'stroke-width': 1.5 }));
    } else if (v.type === 'bike') {
      g.appendChild(svgEl('line', { x1: -size, y1: 0, x2: size, y2: 0, stroke: color, 'stroke-width': 2.5, 'stroke-linecap': 'round' }));
      g.appendChild(svgEl('circle', { cx:  size*0.8, cy: 0, r: size*0.4, fill: 'none', stroke: color, 'stroke-width': 1.5 }));
      g.appendChild(svgEl('circle', { cx: -size*0.8, cy: 0, r: size*0.4, fill: 'none', stroke: color, 'stroke-width': 1.5 }));
    } else {
      g.appendChild(svgEl('ellipse', { cx: 0, cy: 0, rx: size*0.45, ry: size*0.7, fill: color, stroke: 'rgba(0,0,0,0.3)', 'stroke-width': 1 }));
      g.appendChild(svgEl('circle', { cx: 0, cy: -size*0.85, r: size*0.4, fill: color }));
    }

    vehicleLayer.appendChild(g);
    v.el = g;
  });
}

// ═══════════════════════════════════════════════════════════
// ANIMATION LOOP
// ═══════════════════════════════════════════════════════════
let lastTime = 0;
function animate(ts) {
  const dt = Math.min((ts - lastTime) / 16, 3);
  lastTime = ts;

  vehicles.forEach(v => {
    if (!v.el || v.path.length === 0) return;

    const ep   = v.path[v.pathIdx];
    const edge = edges[ep.edgeIdx];
    const step = v.speed * 0.003 * dt;

    v.t += ep.reversed ? -step : step;

    if ((!ep.reversed && v.t >= 1) || (ep.reversed && v.t <= 0)) {
      v.t       = ep.reversed ? 0 : 1;
      v.pathIdx = (v.pathIdx + 1) % v.path.length;
      if (v.pathIdx === 0) v.t = 0;
    }

    const t    = Math.max(0, Math.min(1, v.t));
    const pos  = getPointOnEdge(edge, t);
    const tang = getTangentOnEdge(edge, t);
    const angle = Math.atan2(tang.y, tang.x) * 180 / Math.PI;

    v.el.setAttribute('transform',
      `translate(${pos.x.toFixed(2)}, ${pos.y.toFixed(2)}) rotate(${angle.toFixed(1)})`);
  });

  updateMinimap();
  animFrame = requestAnimationFrame(animate);
}

// ═══════════════════════════════════════════════════════════
// MINIMAP
// ═══════════════════════════════════════════════════════════
const minimapCanvas = document.getElementById('minimap-canvas');
const mmCtx = minimapCanvas.getContext('2d');
const MM_W = 160, MM_H = 120;
minimapCanvas.width  = MM_W;
minimapCanvas.height = MM_H;
const mmScaleX = MM_W / MAP_W;
const mmScaleY = MM_H / MAP_H;

function drawMinimap() {
  mmCtx.clearRect(0, 0, MM_W, MM_H);
  const isLight = document.body.classList.contains('light');
  mmCtx.fillStyle = isLight ? '#dde4f0' : '#0a0e1a';
  mmCtx.fillRect(0, 0, MM_W, MM_H);

  edges.forEach(e => {
    const na = nodes[e.a], nb = nodes[e.b], cp = e.ctrl[0];
    mmCtx.beginPath();
    mmCtx.moveTo(na.x * mmScaleX, na.y * mmScaleY);
    mmCtx.quadraticCurveTo(cp.x * mmScaleX, cp.y * mmScaleY, nb.x * mmScaleX, nb.y * mmScaleY);
    mmCtx.strokeStyle = isLight
      ? (e.major ? '#8aa0c0' : '#b0bcd8')
      : (e.major ? '#2e4a7a' : '#1a2a4a');
    mmCtx.lineWidth = e.major ? 2 : 1;
    mmCtx.stroke();
  });

  vehicles.forEach(v => {
    if (!v.path.length) return;
    const ep   = v.path[v.pathIdx];
    const edge = edges[ep.edgeIdx];
    const t    = Math.max(0, Math.min(1, v.t));
    const pos  = getPointOnEdge(edge, t);
    mmCtx.beginPath();
    mmCtx.arc(pos.x * mmScaleX, pos.y * mmScaleY, 1.8, 0, Math.PI * 2);
    mmCtx.fillStyle = VEHICLE_COLORS[v.type];
    mmCtx.fill();
  });
}

function updateMinimap() {
  drawMinimap();
  const container = document.getElementById('map-container');
  const vw = container.offsetWidth;
  const vh = container.offsetHeight;
  const vp = document.getElementById('minimap-viewport');
  const vLeft   = (-panX / (MAP_W * zoom)) * MM_W;
  const vTop    = (-panY / (MAP_H * zoom)) * MM_H;
  const vWidth  = (vw   / (MAP_W * zoom)) * MM_W;
  const vHeight = (vh   / (MAP_H * zoom)) * MM_H;
  vp.style.left   = Math.max(0, vLeft)   + 'px';
  vp.style.top    = Math.max(0, vTop)    + 'px';
  vp.style.width  = Math.min(MM_W, vWidth)  + 'px';
  vp.style.height = Math.min(MM_H, vHeight) + 'px';
}

// ═══════════════════════════════════════════════════════════
// PAN & ZOOM
// ═══════════════════════════════════════════════════════════
function applyTransform() {
  document.getElementById('map-svg').style.transform =
    `translate(${panX}px, ${panY}px) scale(${zoom})`;
}

function zoomTo(factor, cx, cy) {
  const container = document.getElementById('map-container');
  const rect = container.getBoundingClientRect();
  const mx = (cx ?? rect.width  / 2);
  const my = (cy ?? rect.height / 2);
  const prevZoom = zoom;
  zoom = Math.max(0.25, Math.min(4, zoom * factor));
  panX += (mx - panX) * (1 - zoom / prevZoom);
  panY += (my - panY) * (1 - zoom / prevZoom);
  applyTransform();
}

// ═══════════════════════════════════════════════════════════
// STATS
// ═══════════════════════════════════════════════════════════
function updateStats() {
  document.getElementById('stats').innerHTML =
    `Nodes: ${nodes.length}<br>
     Edges: ${edges.length}<br>
     Vehicles: ${vehicles.length}<br>
     Seed: ${seed}`;
}

// ═══════════════════════════════════════════════════════════
// FULL REBUILD
// ═══════════════════════════════════════════════════════════
function rebuild(newSeed) {
  if (newSeed !== undefined) seed = newSeed;
  _seed = seed;
  generateMap(seed);
  setupLayers();
  renderBuildings();
  renderRoads();
  renderNodes();
  renderPath([]);
  pathStart = null; pathEnd = null; activePath = [];
  renderFlags();
  spawnVehicles(14);
  updateStats();
  setStatus('Peta dihasilkan · seed: ' + seed);
}

function setStatus(msg) {
  document.getElementById('status-bar').textContent = msg;
}

// ═══════════════════════════════════════════════════════════
// NODE CLICK (pick start/end)
// ═══════════════════════════════════════════════════════════
document.getElementById('map-svg').addEventListener('click', e => {
  const dot = e.target.closest('.node-dot');
  if (!dot || !pickMode) return;
  const nid = parseInt(dot.getAttribute('data-nid'));

  if (pickMode === 'start') {
    pathStart = nid;
    setStatus(`Start node set → Node ${nid}`);
  } else {
    pathEnd = nid;
    setStatus(`End node set → Node ${nid}`);
  }
  pickMode = null;
  document.getElementById('map-container').className = '';
  document.getElementById('mode-indicator').style.display = 'none';
  document.getElementById('btn-setstart').classList.remove('active');
  document.getElementById('btn-setend').classList.remove('active');
  renderFlags();
});

// ═══════════════════════════════════════════════════════════
// BUTTON HANDLERS
// ═══════════════════════════════════════════════════════════
document.getElementById('btn-regen').addEventListener('click', () => {
  if (animFrame) cancelAnimationFrame(animFrame);
  rebuild(Math.random() * 99999 | 0);
  lastTime = 0;
  requestAnimationFrame(ts => { lastTime = ts; animFrame = requestAnimationFrame(animate); });
});

document.getElementById('btn-vehicles').addEventListener('click', () => {
  spawnVehicles(14 + rngInt(0, 8));
  setStatus('Kendaraan dirandomisasi');
});

document.getElementById('btn-setstart').addEventListener('click', () => {
  pickMode = 'start';
  document.getElementById('map-container').className = 'picking-start';
  document.getElementById('mode-indicator').textContent = '⚑ Klik node untuk START';
  document.getElementById('mode-indicator').style.display = 'block';
  document.getElementById('btn-setstart').classList.add('active');
  document.getElementById('btn-setend').classList.remove('active');
  setStatus('Pilih node START...');
});

document.getElementById('btn-setend').addEventListener('click', () => {
  pickMode = 'end';
  document.getElementById('map-container').className = 'picking-end';
  document.getElementById('mode-indicator').textContent = '⚑ Klik node untuk END';
  document.getElementById('mode-indicator').style.display = 'block';
  document.getElementById('btn-setend').classList.add('active');
  document.getElementById('btn-setstart').classList.remove('active');
  setStatus('Pilih node END...');
});

document.getElementById('btn-findpath').addEventListener('click', () => {
  if (pathStart === null || pathEnd === null) {
    setStatus('Pilih START dan END terlebih dahulu!'); return;
  }
  if (pathStart === pathEnd) { setStatus('Start dan End sama!'); return; }
  const path = dijkstra(pathStart, pathEnd);
  if (!path) { setStatus('Tidak ada jalur ditemukan'); return; }
  activePath = path;
  renderPath(path);
  setStatus(`Jalur ditemukan: ${path.length - 1} edge`);
});

document.getElementById('btn-clearpath').addEventListener('click', () => {
  pathStart = null; pathEnd = null; activePath = [];
  highlightLayer.innerHTML = '';
  renderFlags();
  setStatus('Jalur dihapus');
});

document.getElementById('btn-theme').addEventListener('click', () => {
  const isLight = document.body.classList.toggle('light');
  const btn = document.getElementById('btn-theme');
  btn.textContent = isLight ? '🌙 DARK' : '☀ LIGHT';
  btn.title = isLight ? 'Switch to dark mode' : 'Switch to light mode';
  renderBuildings();
  renderRoads();
  renderNodes();
});

document.getElementById('btn-zoomin').addEventListener('click',  () => zoomTo(1.3));
document.getElementById('btn-zoomout').addEventListener('click', () => zoomTo(1 / 1.3));
document.getElementById('btn-reset').addEventListener('click', () => {
  zoom = 0.85; panX = 0; panY = 0; applyTransform();
});

// ═══════════════════════════════════════════════════════════
// MOUSE & TOUCH EVENTS — PAN & ZOOM
// ═══════════════════════════════════════════════════════════
const mc = document.getElementById('map-container');

mc.addEventListener('mousedown', e => {
  if (pickMode) return;
  isDragging = true;
  dragStart = { x: e.clientX, y: e.clientY };
  panStart  = { x: panX, y: panY };
});

window.addEventListener('mousemove', e => {
  if (!isDragging) return;
  panX = panStart.x + (e.clientX - dragStart.x);
  panY = panStart.y + (e.clientY - dragStart.y);
  applyTransform();
});

window.addEventListener('mouseup', () => { isDragging = false; });

mc.addEventListener('wheel', e => {
  e.preventDefault();
  const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
  const rect   = mc.getBoundingClientRect();
  zoomTo(factor, e.clientX - rect.left, e.clientY - rect.top);
}, { passive: false });

// Touch support
let lastTouchDist = null;

mc.addEventListener('touchstart', e => {
  if (e.touches.length === 1 && !pickMode) {
    isDragging = true;
    dragStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    panStart  = { x: panX, y: panY };
  } else if (e.touches.length === 2) {
    isDragging = false;
    const dx = e.touches[0].clientX - e.touches[1].clientX;
    const dy = e.touches[0].clientY - e.touches[1].clientY;
    lastTouchDist = Math.sqrt(dx * dx + dy * dy);
  }
}, { passive: true });

mc.addEventListener('touchmove', e => {
  e.preventDefault();
  if (e.touches.length === 1 && isDragging) {
    panX = panStart.x + (e.touches[0].clientX - dragStart.x);
    panY = panStart.y + (e.touches[0].clientY - dragStart.y);
    applyTransform();
  } else if (e.touches.length === 2) {
    const dx   = e.touches[0].clientX - e.touches[1].clientX;
    const dy   = e.touches[0].clientY - e.touches[1].clientY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (lastTouchDist) {
      const mx   = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      const my   = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      const rect = mc.getBoundingClientRect();
      zoomTo(dist / lastTouchDist, mx - rect.left, my - rect.top);
    }
    lastTouchDist = dist;
  }
}, { passive: false });

mc.addEventListener('touchend', () => { isDragging = false; lastTouchDist = null; });

// ═══════════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════════
(function init() {
  rebuild(seed);
  zoom = 0.85; panX = 10; panY = 0;
  applyTransform();
  lastTime = 0;
  requestAnimationFrame(ts => {
    lastTime = ts;
    animFrame = requestAnimationFrame(animate);
  });
})();