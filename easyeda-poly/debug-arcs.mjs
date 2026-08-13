#!/usr/bin/env node
/**
 * 弧线诊断脚本 — 两台电脑对比弧线数据
 * 用法: node debug-arcs.mjs <bridge-port> <pcb-name>
 */
const BRIDGE = `http://127.0.0.1:${process.argv[2]}`;
const PCB_NAME = process.argv[3];

if (!process.argv[2] || !process.argv[3]) {
  console.error('用法: node debug-arcs.mjs <bridge-port> <pcb-name>');
  process.exit(1);
}

async function execute(code) {
  const resp = await fetch(`${BRIDGE}/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
    signal: AbortSignal.timeout(30000),
  });
  const json = await resp.json();
  if (!json.success) throw new Error(json.error);
  return JSON.parse(json.result);
}

console.log(`\n🔍 诊断 PCB: "${PCB_NAME}"`);

// 打开 PCB
const pcbInfo = await execute(`
  const project = await eda.dmt_Project.getCurrentProjectInfo();
  if (!project) return JSON.stringify({error:"No project"});
  const pcbs = (project.data || []).filter(d => d.itemType === "PCB");
  const match = pcbs.find(p => p.name === "${PCB_NAME}");
  if (!match) return JSON.stringify({error:"PCB not found", available: pcbs.map(p=>p.name)});
  await eda.dmt_EditorControl.openDocument(match.uuid);
  return JSON.stringify({uuid: match.uuid, name: match.name});
`);
console.log('PCB:', pcbInfo.name, '(' + pcbInfo.uuid + ')');

// 获取 TOP 层弧线详情
const data = await execute(`
  const arcs = await eda.pcb_PrimitiveArc.getAll();
  const topArcs = arcs.filter(a => a.layer === 1);

  const details = topArcs.map(a => {
    // 尝试所有可能的数据获取方式
    const direct_sx = a.startX;
    const direct_sy = a.startY;
    const direct_ex = a.endX;
    const direct_ey = a.endY;
    const direct_angle = a.arcAngle;

    const getter_sx = a.getState_StartX ? a.getState_StartX() : null;
    const getter_sy = a.getState_StartY ? a.getState_StartY() : null;
    const getter_ex = a.getState_EndX ? a.getState_EndX() : null;
    const getter_ey = a.getState_EndY ? a.getState_EndY() : null;
    const getter_angle = a.getState_ArcAngle ? a.getState_ArcAngle() : null;

    return {
      id: a.primitiveId,
      layer: a.layer,
      lineWidth: a.lineWidth !== undefined ? a.lineWidth : (a.getState_LineWidth ? a.getState_LineWidth() : 'N/A'),
      direct: { sx: direct_sx, sy: direct_sy, ex: direct_ex, ey: direct_ey, angle: direct_angle },
      getter: { sx: getter_sx, sy: getter_sy, ex: getter_ex, ey: getter_ey, angle: getter_angle },
    };
  });

  // 也检查线条的坐标精度
  const lines = await eda.pcb_PrimitiveLine.getAll();
  const topLines = lines.filter(l => l.layer === 1 && l.lineWidth === 2);
  const coordSample = topLines.slice(0, 3).map(l => ({
    id: l.primitiveId,
    sx: l.startX, sy: l.startY,
    ex: l.endX, ey: l.endY,
    sxDecimals: (l.startX.toString().split('.')[1] || '').length,
    syDecimals: (l.startY.toString().split('.')[1] || '').length,
  }));

  return JSON.stringify({
    arcCount: topArcs.length,
    lineCount: topLines.length,
    arcSample: details.slice(0, 5),
    coordSample,
  });
`);

console.log(`\nTOP 层: ${data.arcCount} 弧线, ${data.lineCount} 直线(2mil)`);

console.log('\n=== 弧线数据对比 (direct vs getter) ===');
for (const a of (data.arcSample || [])) {
  console.log(`\n  ${a.id}:`);
  console.log(`    lineWidth: ${a.lineWidth}`);
  console.log(`    direct:  start=(${a.direct.sx}, ${a.direct.sy}) end=(${a.direct.ex}, ${a.direct.ey}) angle=${a.direct.angle}`);
  console.log(`    getter:  start=(${a.getter.sx}, ${a.getter.sy}) end=(${a.getter.ex}, ${a.getter.ey}) angle=${a.getter.angle}`);
  const diff_sx = a.direct.sx !== null && a.getter.sx !== null ? Math.abs(a.direct.sx - a.getter.sx) : 'N/A';
  const diff_angle = a.direct.angle !== null && a.getter.angle !== null ? Math.abs(a.direct.angle - a.getter.angle) : 'N/A';
  console.log(`    diff:     sx=${diff_sx} angle=${diff_angle}`);
}

console.log('\n=== 坐标精度 ===');
for (const l of (data.coordSample || [])) {
  console.log(`  ${l.id}: sx小数=${l.sxDecimals}位 sy小数=${l.syDecimals}位  sx=${l.sx} sy=${l.sy}`);
}

console.log('\n✅ 诊断完成。对比两台电脑的输出，找差异。');
