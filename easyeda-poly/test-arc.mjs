#!/usr/bin/env node
const BRIDGE = `http://127.0.0.1:${process.argv[2]}`;
async function execute(code) {
  const resp = await fetch(`${BRIDGE}/execute`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }), signal: AbortSignal.timeout(10000),
  });
  const json = await resp.json();
  if (!json.success) throw new Error(json.error);
  return JSON.parse(json.result);
}
(async () => {
  const r = await execute(`
    const allLines = await eda.pcb_PrimitiveLine.getAll();
    const allArcs = await eda.pcb_PrimitiveArc.getAll();
    const lines = allLines.filter(l => l.layer === 1 && l.lineWidth === 2);
    const arcs = allArcs.filter(a => a.layer === 1);

    // 新精度: *10 (0.1mil)
    const exactKey = (x, y) => Math.round(x * 10) / 10 + ',' + Math.round(y * 10) / 10;

    const lineEndpoints = new Set();
    for (const l of lines) {
      lineEndpoints.add(exactKey(l.startX, l.startY));
      lineEndpoints.add(exactKey(l.endX, l.endY));
    }
    let matched = 0, unmatched = 0;
    for (const a of arcs) {
      const sx = a.startX !== undefined ? a.startX : a.getState_StartX();
      const sy = a.startY !== undefined ? a.startY : a.getState_StartY();
      const ex = a.endX !== undefined ? a.endX : a.getState_EndX();
      const ey = a.endY !== undefined ? a.endY : a.getState_EndY();
      if (lineEndpoints.has(exactKey(sx, sy))) matched++; else unmatched++;
      if (lineEndpoints.has(exactKey(ex, ey))) matched++; else unmatched++;
    }
    return JSON.stringify({ total: arcs.length * 2, matched, unmatched });
  `);
  console.log(JSON.stringify(r, null, 2));
})();
