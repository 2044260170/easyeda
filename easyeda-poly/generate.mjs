#!/usr/bin/env node
/**
 * EasyEDA Poly — 轮廓铺铜生成脚本
 *
 * 用法: node generate.mjs <bridge-port> <pcb-name>
 * 示例: node generate.mjs 49620 "03021080"
 *
 * 流程:
 *   1. 连接到 Bridge
 *   2. 打开目标 PCB
 *   3. 逐铜皮层分析闭合轮廓 + 嵌套检测 + 生成铜皮
 *   4. 输出总结
 */

const BRIDGE = `http://127.0.0.1:${process.argv[2]}`;
const PCB_NAME = process.argv[3];
const SKIP_NESTED = process.argv[4] === '非铺铜';  // 默认 false=所有轮廓都生成铜皮，传"非铺铜"时跳过内层

if (!process.argv[2] || !process.argv[3]) {
  console.error('用法: node generate.mjs <bridge-port> <pcb-name> [非铺铜]');
  process.exit(1);
}

console.log(`嵌套检测: ${SKIP_NESTED ? '开启 (跳过内层)' : '关闭 (所有轮廓)'}`);

// ─── 工具函数 ───────────────────────────────────────────────

async function execute(code) {
  const resp = await fetch(`${BRIDGE}/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
    signal: AbortSignal.timeout(60000),
  });
  const json = await resp.json();
  if (!json.success) throw new Error(json.error);
  return JSON.parse(json.result);
}

function pointInPolygon(px, py, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i][0], yi = polygon[i][1];
    const xj = polygon[j][0], yj = polygon[j][1];
    if ((yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function exactKey(x, y) {
  // 精度降为 0.1mil：弧线坐标 (1位小数) 和直线坐标 (2位小数) 的精度不一致，
  // 用 *100 (0.01mil) 会导致弧线端点无法匹配直线端点，弧线全部孤立
  return Math.round(x * 10) / 10 + ',' + Math.round(y * 10) / 10;
}

// 端点容差 (mil)：弧线端点由几何计算产生，与相接直线端点可能有 0.0001~0.02mil 的浮点差。
// 精确 0.1mil 取整会把落在 0.05mil 边界两侧的同一点拆开
// (例: 50861.25 vs 50861.2498 -> 取整 50861.3 vs 50861.2，弧线连不上直线)。
// 先做容差聚类，把距离 <= EPS 的端点合并为同一顶点，再做 0.1mil 匹配。
const EPS = 0.25;

function normalizeSegments(segments) {
  if (segments.length === 0) return segments;
  // 收集所有端点
  const pts = [];
  for (const s of segments) { pts.push([s.sx, s.sy]); pts.push([s.ex, s.ey]); }
  // union-find 按距离聚类 (按 x 排序 + 滑动窗口，避免 O(n^2))
  const parent = pts.map((_, i) => i);
  function find(a) { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; }
  function union(a, b) { parent[find(a)] = find(b); }
  const order = pts.map((_, i) => i).sort((a, b) => pts[a][0] - pts[b][0]);
  for (let i = 0; i < order.length; i++) {
    for (let j = i + 1; j < order.length; j++) {
      const pi = pts[order[i]], pj = pts[order[j]];
      if (pj[0] - pi[0] > EPS) break;
      if (Math.hypot(pj[0] - pi[0], pj[1] - pi[1]) <= EPS) union(order[i], order[j]);
    }
  }
  // 每个聚类取代表点，写回线段端点
  const rep = new Map();
  for (let i = 0; i < pts.length; i++) {
    const r = find(i);
    if (!rep.has(r)) rep.set(r, pts[i]);
  }
  return segments.map((s, si) => {
    const sp = rep.get(find(si * 2));
    const ep = rep.get(find(si * 2 + 1));
    return { ...s, sx: sp[0], sy: sp[1], ex: ep[0], ey: ep[1] };
  });
}

function unsnap(key) {
  return key.split(',').map(Number);
}

function edgeKey(v1, v2, id) {
  return [v1, v2].sort().join('|') + '|' + id;
}

function buildPolySource(contour) {
  const pts = contour.vertices;
  const edges = contour.edges;
  const src = [];
  for (let i = 0; i < pts.length; i++) {
    const e = edges[i], v = pts[i];
    if (e.type === 'L') {
      src.push(Math.round(v[0]), Math.round(v[1]), 'L');
    } else {
      // 判断遍历方向：逆向(vertex==arc.end)才取反
      const vKey = exactKey(v[0], v[1]);
      const segStartKey = exactKey(e.sx, e.sy);
      const forward = vKey === segStartKey;
      const angle = forward ? e.arcAngle : -e.arcAngle;
      src.push(Math.round(v[0]), Math.round(v[1]), 'ARC', Math.round(angle));
    }
  }
  src.push(Math.round(pts[0][0]), Math.round(pts[0][1]));
  return src;
}

// ─── Step 1: 打开 PCB ────────────────────────────────────────

console.log(`\n🔍 查找 PCB: "${PCB_NAME}"...`);

const pcbUuid = await execute(`
  const project = await eda.dmt_Project.getCurrentProjectInfo();
  if (!project) { return JSON.stringify({ error: "No project open" }); }

  // 从 project.data 找匹配的 PCB
  const pcbs = (project.data || []).filter(d => d.itemType === "PCB" && d.name);
  const match = pcbs.find(p => p.name === "${PCB_NAME}");
  if (!match) {
    return JSON.stringify({
      error: "PCB not found",
      available: pcbs.map(p => ({ name: p.name, uuid: p.uuid }))
    });
  }

  const tabId = await eda.dmt_EditorControl.openDocument(match.uuid);
  return JSON.stringify({ uuid: match.uuid, name: match.name, tabId });
`);

if (pcbUuid.error) {
  console.error('❌', pcbUuid.error);
  if (pcbUuid.available) {
    console.log('可用 PCB:');
    pcbUuid.available.forEach(p => console.log('  - ' + p.name));
  }
  process.exit(1);
}
console.log('✅ 已打开:', pcbUuid.name, '(' + pcbUuid.uuid + ')');

// ─── Step 2: 获取铜皮层列表 ───────────────────────────────────

console.log('\n📐 获取铜皮层...');

const layerInfo = await execute(`
  // 检查项目设置中的层数
  const project = await eda.dmt_Project.getCurrentProjectInfo();
  const doc = await eda.dmt_SelectControl.getCurrentDocumentInfo();

  // 从项目数据推断层配置
  // 尝试获取层的实际信息
  const allLines = await eda.pcb_PrimitiveLine.getAll();
  const layerSet = new Set();
  allLines.forEach(l => layerSet.add(l.layer));

  return JSON.stringify({
    layers: Array.from(layerSet).sort((a,b) => a-b).filter(l => {
      // 铜皮层: 1=TOP, 2=BOTTOM, 15+=INNER
      return l === 1 || l === 2 || l >= 15;
    }),
    allLayers: Array.from(layerSet).sort((a,b) => a-b)
  });
`);

const copperLayers = layerInfo.layers;
console.log('铜皮层:', copperLayers.join(', '));
if (copperLayers.length === 0) {
  console.log('⚠️ 未检测到铜皮层数据，尝试默认 TOP+BOTTOM');
  copperLayers.push(1, 2);
}

// ─── Step 3: 定义铜皮层名称 ───────────────────────────────────

const LAYER_NAMES = { 1: 'TOP', 2: 'BOTTOM' };
for (let i = 1; i <= 30; i++) {
  if (!LAYER_NAMES[14 + i]) LAYER_NAMES[14 + i] = 'INNER_' + i;
}

// ─── Step 4: 逐层处理 ────────────────────────────────────────

const summary = [];

for (const layerId of copperLayers) {
  const layerName = LAYER_NAMES[layerId] || 'LAYER_' + layerId;
  console.log(`\n━━━ ${layerName} (layer ${layerId}) ━━━`);

  // 4a. 获取图元
  console.log('  获取图元...');
  const segments = await execute(`
    const allLines = await eda.pcb_PrimitiveLine.getAll();
    const allArcs = await eda.pcb_PrimitiveArc.getAll();

    const lines = allLines.filter(l => l.layer === ${layerId} && l.lineWidth === 2);
    const arcs = allArcs.filter(a => a.layer === ${layerId});

    return JSON.stringify({
      lines: lines.map(l => ({id:l.primitiveId,type:'L',sx:l.startX,sy:l.startY,ex:l.endX,ey:l.endY})),
      arcs: arcs.map(a => ({id:a.primitiveId,type:'A',
        sx:a.startX !== undefined ? a.startX : a.getState_StartX(),
        sy:a.startY !== undefined ? a.startY : a.getState_StartY(),
        ex:a.endX !== undefined ? a.endX : a.getState_EndX(),
        ey:a.endY !== undefined ? a.endY : a.getState_EndY(),
        arcAngle:a.arcAngle !== undefined ? a.arcAngle : a.getState_ArcAngle()
      }))
    });
  `);

  const allSegments = normalizeSegments([...segments.lines, ...segments.arcs]);
  console.log(`  直线(2mil): ${segments.lines.length}  弧线: ${segments.arcs.length}`);

  if (allSegments.length === 0) {
    console.log('  ⚠️ 无图元，跳过');
    summary.push({ layer: layerName, contours: 0, nested: 0, generated: 0, failed: 0, skipped: '无图元' });
    continue;
  }

  // 4b. 构建邻接图 + 查找轮廓
  const adj = new Map();
  for (const seg of allSegments) {
    const s = exactKey(seg.sx, seg.sy);
    const e = exactKey(seg.ex, seg.ey);
    if (s === e) continue;
    if (!adj.has(s)) adj.set(s, []);
    if (!adj.has(e)) adj.set(e, []);
    adj.get(s).push({ other: e, seg });
    adj.get(e).push({ other: s, seg });
  }

  const visitedEdges = new Set();
  const allUsedIds = new Set();
  const contours = [];

  for (const [startVertex, neighbors] of adj) {
    for (const { other: neighbor, seg } of neighbors) {
      const ek = edgeKey(startVertex, neighbor, seg.id);
      if (visitedEdges.has(ek)) continue;

      const pathVertices = [startVertex];
      const pathEdges = [seg];
      let current = neighbor;
      let prev = startVertex;
      let foundCycle = false;

      for (let step = 0; step < 10000; step++) {
        const nextOptions = adj.get(current).filter(n => n.other !== prev);
        if (nextOptions.length === 0) break;
        if (nextOptions.length > 1) break;

        const next = nextOptions[0];
        if (next.other === startVertex) {
          foundCycle = true;
          pathVertices.push(current);
          pathEdges.push(next.seg);
          for (let i = 0; i < pathVertices.length; i++) {
            const v1 = pathVertices[i];
            const v2 = (i + 1 < pathVertices.length) ? pathVertices[i + 1] : startVertex;
            visitedEdges.add(edgeKey(v1, v2, pathEdges[i].id));
          }
          break;
        }

        pathVertices.push(current);
        pathEdges.push(next.seg);
        prev = current;
        current = next.other;
      }

      if (foundCycle) {
        pathEdges.forEach(e => allUsedIds.add(e.id));
        contours.push({
          vertices: pathVertices.map(v => unsnap(v)),
          edges: pathEdges,
        });
      }
    }
  }

  console.log(`  闭合轮廓: ${contours.length}`);

  // 4b2. 开口路径自动闭合：从剩余边中找简单路径(2端点degree=1)，自动连线闭合
  const unusedEdges = allSegments.filter(s => !allUsedIds.has(s.id));
  if (unusedEdges.length > 0) {
    // 构建剩余边的子图
    const subAdj = new Map();
    for (const seg of unusedEdges) {
      const s = exactKey(seg.sx, seg.sy);
      const e = exactKey(seg.ex, seg.ey);
      if (s === e) continue;
      if (!subAdj.has(s)) subAdj.set(s, []);
      if (!subAdj.has(e)) subAdj.set(e, []);
      subAdj.get(s).push({ other: e, seg });
      subAdj.get(e).push({ other: s, seg });
    }

    // 找连通分量
    const visitedVerts = new Set();
    const components = [];
    for (const [v] of subAdj) {
      if (visitedVerts.has(v)) continue;
      const compVerts = new Set();
      const compEdges = new Set();
      const queue = [v];
      compVerts.add(v);
      while (queue.length > 0) {
        const cv = queue.shift();
        for (const { other, seg } of (subAdj.get(cv) || [])) {
          compEdges.add(seg);
          if (!compVerts.has(other)) { compVerts.add(other); queue.push(other); }
        }
        visitedVerts.add(cv);
      }
      components.push({ verts: compVerts, edges: [...compEdges] });
    }

    // 对每条简单开口路径，自动连接两端点
    let openClosed = 0;
    for (const comp of components) {
      if (comp.edges.length < 2) continue;
      // 找端点 (degree=1)
      const endpoints = [];
      for (const cv of comp.verts) {
        if ((subAdj.get(cv) || []).length === 1) endpoints.push(cv);
      }
      if (endpoints.length !== 2) continue; // 只处理简单开口路径

      // 从一端走到另一端，收集有序边
      const orderedEdges = [];
      const orderedVerts = [];
      let cur = endpoints[0], prevKey = null;
      for (let step = 0; step < 50000; step++) {
        orderedVerts.push(cur);
        const nextOptions = (subAdj.get(cur) || []).filter(n => n.other !== prevKey);
        if (nextOptions.length === 0) break;
        const next = nextOptions[0];
        orderedEdges.push(next.seg);
        prevKey = cur;
        cur = next.other;
        if (cur === endpoints[1]) { orderedVerts.push(cur); break; }
      }

      if (orderedVerts.length < 2) continue;

      // 添加闭合边（最后一点连回第一点）
      const lastV = unsnap(endpoints[1]);
      const firstV = unsnap(endpoints[0]);
      const closeEdge = {
        id: '__close_' + contours.length, type: 'L',
        sx: lastV[0], sy: lastV[1], ex: firstV[0], ey: firstV[1],
      };

      contours.push({
        vertices: orderedVerts.map(v => unsnap(v)),
        edges: [...orderedEdges, closeEdge],
        _openClosed: true,
      });
      openClosed++;
    }

    if (openClosed > 0) {
      console.log(`  开口闭合: ${openClosed} 条路径 → 自动连线封闭`);
    }
  }

  if (contours.length === 0) {
    summary.push({ layer: layerName, contours: 0, nested: 0, generated: 0, failed: 0, skipped: '无闭合轮廓' });
    continue;
  }

  // 4c. 嵌套检测 (仅在"非铺铜"模式下开启)
  const nestedSet = new Set();

  if (SKIP_NESTED) {
    const contourSummaries = contours.map(c => {
      const xs = c.vertices.map(v => v[0]), ys = c.vertices.map(v => v[1]);
      return {
        bbox: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
        points: c.vertices,
      };
    });

    for (let i = 0; i < contourSummaries.length; i++) {
      for (let j = 0; j < contourSummaries.length; j++) {
        if (i === j) continue;
        const ob = contourSummaries[j].bbox, ib = contourSummaries[i].bbox;
        if (ob[0] <= ib[0] && ob[1] <= ib[1] && ob[2] >= ib[2] && ob[3] >= ib[3]) {
          if (contourSummaries[i].points.every(p => pointInPolygon(p[0], p[1], contourSummaries[j].points))) {
            nestedSet.add(i);
            break;
          }
        }
      }
    }

    console.log(`  嵌套(跳过): ${nestedSet.size}  外层: ${contours.length - nestedSet.size}`);
  }

  // 4d. 生成铜皮
  let generated = 0, failed = 0;
  const failures = [];

  for (let i = 0; i < contours.length; i++) {
    if (SKIP_NESTED && nestedSet.has(i)) continue;

    const c = contours[i];
    const polySource = buildPolySource(c);
    const pourName = `Pour_${layerName}_C${i + 1}`;

    try {
      const result = await execute(`
        const polySource = ${JSON.stringify(polySource)};
        const polygon = eda.pcb_MathPolygon.createPolygon(polySource);
        if (!polygon) { return JSON.stringify({ err: "createPolygon failed" }); }
        const pour = await eda.pcb_PrimitivePour.create(
          "", ${layerId}, polygon, "solid", false, "${pourName}", 0, 10, false
        );
        if (!pour) { return JSON.stringify({ err: "createPour failed" }); }
        return JSON.stringify({ id: pour.primitiveId });
      `);

      if (result.err) {
        failed++;
        failures.push({ name: pourName, reason: result.err });
        process.stdout.write('✗');
      } else {
        generated++;
        process.stdout.write('.');
      }
    } catch (e) {
      failed++;
      failures.push({ name: pourName, reason: e.message });
      process.stdout.write('✗');
    }
  }
  console.log('');

  summary.push({ layer: layerName, contours: contours.length, nested: nestedSet.size, generated, failed, failures });
}

// ─── Step 5: 总结 ────────────────────────────────────────────

console.log('\n═══════════════════════════════════════');
console.log('  EasyEDA Poly 完成');
console.log('═══════════════════════════════════════');
console.log(`  PCB: ${PCB_NAME}  (${pcbUuid.uuid})`);
console.log('');

let totalContours = 0, totalNested = 0, totalGen = 0, totalFail = 0;

for (const s of summary) {
  totalContours += s.contours;
  totalNested += s.nested;
  totalGen += s.generated;
  totalFail += s.failed;

  const flag = s.skipped ? ` ⚠️ ${s.skipped}` : '';
  console.log(`  ${s.layer.padEnd(10)} ${String(s.contours).padStart(3)} 轮廓 → ${String(s.nested).padStart(2)} 跳过 → ${String(s.generated).padStart(2)} 铜皮 ✓${flag}`);
  if (s.failures && s.failures.length > 0) {
    s.failures.forEach(f => console.log(`    ✗ ${f.name}: ${f.reason}`));
  }
}

console.log('');
console.log(`  总计: ${totalContours} 轮廓 → ${totalNested} 嵌套跳过 → ${totalGen} 铜皮生成`);
if (totalFail > 0) {
  console.log(`  ❌ 失败: ${totalFail}`);
}
console.log('');
