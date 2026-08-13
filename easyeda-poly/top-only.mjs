#!/usr/bin/env node
/**
 * TOP-only 弧线修复验证：生成 TOP 层铜皮，不删线
 */
const BRIDGE = `http://127.0.0.1:${process.argv[2]}`;

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

function exactKey(x, y) {
  return Math.round(x * 10) / 10 + ',' + Math.round(y * 10) / 10;
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

(async () => {
  const LAYER_ID = 1;
  console.log('━━━ TOP (layer 1) ━━━');

  // 1. 获取图元
  console.log('获取图元...');
  const segments = await execute(`
    const allLines = await eda.pcb_PrimitiveLine.getAll();
    const allArcs = await eda.pcb_PrimitiveArc.getAll();
    const lines = allLines.filter(l => l.layer === 1 && l.lineWidth === 2);
    const arcs = allArcs.filter(a => a.layer === 1);
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
  console.log(`直线(2mil): ${segments.lines.length}  弧线: ${segments.arcs.length}`);

  const allSegments = [...segments.lines, ...segments.arcs];

  // 2. 构建邻接图
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
  console.log(`邻接顶点: ${adj.size}`);

  // 3. 查找闭合轮廓
  const visitedEdges = new Set();
  const allUsedIds = new Set();
  const contours = [];

  for (const [startVertex, neighbors] of adj) {
    for (const { other: neighbor, seg } of neighbors) {
      const ek = edgeKey(startVertex, neighbor, seg.id);
      if (visitedEdges.has(ek)) continue;

      const pathVertices = [startVertex];
      const pathEdges = [seg];
      let current = neighbor, prev = startVertex, foundCycle = false;

      for (let step = 0; step < 10000; step++) {
        const nextOptions = adj.get(current).filter(n => n.other !== prev);
        if (nextOptions.length === 0 || nextOptions.length > 1) break;
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

  // 统计含弧线的轮廓
  const withArcs = contours.filter(c => c.edges.some(e => e.type === 'A'));
  console.log(`闭合轮廓: ${contours.length} (含弧线: ${withArcs.length})`);

  // 4. 生成铜皮 (不删线)
  console.log('生成铜皮...');
  let ok = 0, fail = 0;
  const failures = [];

  for (let i = 0; i < contours.length; i++) {
    const c = contours[i];
    const hasArc = c.edges.some(e => e.type === 'A');
    const polySource = buildPolySource(c);
    const pourName = `Pour_TOP_C${i + 1}`;

    try {
      const result = await execute(`
        const polySource = ${JSON.stringify(polySource)};
        const polygon = eda.pcb_MathPolygon.createPolygon(polySource);
        if (!polygon) { return JSON.stringify({ err: "createPolygon failed" }); }
        const pour = await eda.pcb_PrimitivePour.create(
          "", 1, polygon, "solid", false, "${pourName}", 0, 10, false
        );
        if (!pour) { return JSON.stringify({ err: "createPour failed" }); }
        return JSON.stringify({ id: pour.primitiveId });
      `);

      if (result.err) {
        fail++;
        failures.push({ name: pourName, reason: result.err, hasArc });
        process.stdout.write('✗');
      } else {
        ok++;
        process.stdout.write(hasArc ? '○' : '.');
      }
    } catch (e) {
      fail++;
      failures.push({ name: pourName, reason: e.message, hasArc });
      process.stdout.write('✗');
    }
  }
  console.log('');

  console.log(`\n结果: ${ok} 成功, ${fail} 失败`);
  if (failures.length > 0) {
    console.log('失败清单:');
    failures.forEach(f => console.log(`  ✗ ${f.name} (${f.hasArc?'含弧线':'纯直线'}): ${f.reason}`));
  }
  console.log('\n⚠️ 原始线条未删除');
})();
