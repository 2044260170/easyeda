#!/usr/bin/env node
/**
 * mark-yellow.mjs — BOM 未放置行标黄（原地修改，不重建文件）
 *
 * 用法: node mark-yellow.mjs <bridge-port> <bom-xlsx-path>
 *
 * 用 xlsx-populate 直接在原文件上改 fill，不重建 workbook。
 * 保留原文件所有格式（列宽、字体、边框等），只动需要标黄的行。
 */

import XlsxPopulate from 'xlsx-populate';

const BRIDGE = `http://127.0.0.1:${process.argv[2]}`;
const BOM_PATH = process.argv[3];

if (!process.argv[2] || !process.argv[3]) {
  console.error('用法: node mark-yellow.mjs <bridge-port> <bom-xlsx-path>');
  process.exit(1);
}

// ── Bridge API ─────────────────────────────────
async function apiCall(endpoint, body) {
  const resp = await fetch(`${BRIDGE}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  return resp.json();
}

// ── Step 1: 从 EDA 获取已放置 designator ──────
console.log('🔍 查询 EDA 已放置器件...');
const r = await apiCall('/execute', {
  code: 'const comps = await eda.sch_PrimitiveComponent.getAll(); return comps.map(c => c.designator).filter(Boolean);',
});
const edaSet = new Set(r.result || []);
console.log(`   找到 ${edaSet.size} 个已放置器件`);

// ── Step 2: 打开 BOM，逐行判断标黄 ────────────
console.log(`📂 标黄: ${BOM_PATH}`);
const wb = await XlsxPopulate.fromFileAsync(BOM_PATH);
const ws = wb.sheet(0);

const YELLOW = { type: 'solid', color: 'FFFFFF00' };
let yellowCount = 0;
const yellowRows = [];

for (let r = 1; ; r++) {
  const cell = ws.row(r + 1).cell(1);  // row() is 0-based
  const val = cell.value();
  if (val === undefined || val === null) break;

  const strVal = String(val).trim();
  if (!strVal) continue;

  const designators = strVal.split(',').map(s => s.trim()).filter(Boolean);
  if (designators.length === 0) continue;

  // 跳过表头
  if (r === 0) continue;

  const anyPlaced = designators.some(d => edaSet.has(d));

  if (!anyPlaced) {
    for (let c = 1; c <= 4; c++) {
      ws.row(r + 1).cell(c).style({ fill: YELLOW });
    }
    yellowCount++;
    yellowRows.push(`Row ${r + 1}: ${strVal}`);
  }
}

// ── Step 3: 原地保存（文件被 Excel/WPS 占用时不强杀进程，提示用户）──
console.log(`💾 保存: ${BOM_PATH}`);
try {
  await wb.toFileAsync(BOM_PATH);
} catch (e) {
  console.log(`\n⚠️ 写入失败：${e.message}`);
  console.log('   文件可能被 Excel / WPS 打开占用。请关闭打开的 BOM 后重跑本脚本。');
  process.exit(2);
}

console.log('');
console.log('========================================');
console.log(`  BOM YELLOW MARKING DONE`);
console.log(`  Yellow rows: ${yellowCount}`);
console.log('========================================');
yellowRows.forEach(line => console.log('  ' + line));

// ── Step 4: 读回验证（确认黄色 fill 真正落盘）───
try {
  const wb2 = await XlsxPopulate.fromFileAsync(BOM_PATH);
  const ws2 = wb2.sheet(0);
  let verified = 0, miss = 0;
  for (const line of yellowRows) {
    const m = line.match(/Row (\d+)/);
    const rowNum = m ? parseInt(m[1], 10) : 2;
    const fill = ws2.row(rowNum).cell(1).style('fill');
    const color = fill && fill.color != null ? fill.color : null;
    const hex = (typeof color === 'string' ? color : (color && (color.rgb || color.hex)) || '').toString().toUpperCase();
    if (hex.includes('FFFF00')) verified++; else miss++;
  }
  console.log(`\n✅ 标黄读回验证: ${verified}/${yellowRows.length} 行确认黄色  ${miss ? `⚠️ ${miss} 行未验证到` : '全部确认'}`);
} catch (e) {
  console.log(`\n⚠️ 读回验证失败: ${e.message}`);
}
