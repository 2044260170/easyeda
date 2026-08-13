#!/usr/bin/env node
/**
 * place-searched.mjs — 搜索器件自适应间距批量放置
 *
 * 用法: node place-searched.mjs <bridge-port> [items-file.json|-]
 *   items 可来自文件，或传 '-' 从 stdin 读取（绕开 Windows 上 Node 读不了
 *   Write 工具 .json 的问题）。
 *
 * items-file.json 格式:
 *   [{"spec":"BAV99,215","d":"D2","fp":"SOT-23", "approxOrig": "近似原始规格(可选)"}, ...]
 *   - spec   : 放置时传给 /place 的名称（精确匹配用 BOM 规格；近似匹配用库中查到的名称）
 *   - approxOrig: 存在则标记为"近似匹配放置"，输出以 ⚠️APPROX 提示并单独汇总
 *
 * 自动根据位号前缀和封装计算间距，按 20 个/批放置。
 * NOT_FOUND 不占格子，下一个紧接填入。
 */

import { readFileSync } from 'fs';

const BRIDGE = `http://127.0.0.1:${process.argv[2]}`;
const ITEMS_FILE = process.argv[3];
const BATCH_SIZE = 20;

if (!process.argv[2]) {
  console.error('用法: node place-searched.mjs <bridge-port> [items-file.json|-]');
  process.exit(1);
}

// ── 读取输入（支持 stdin）────────────────────
function readJsonFile(path) {
  const bytes = readFileSync(path);
  let str;
  if (bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE) {
    str = Buffer.from(bytes).toString('utf16le');
  } else if (bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF) {
    str = Buffer.from(bytes).toString('utf16be');
  } else {
    str = Buffer.from(bytes).toString('utf-8');
  }
  if (str.charCodeAt(0) === 0xFEFF) str = str.slice(1);
  const bracketIdx = str.indexOf('[');
  if (bracketIdx > 0) str = str.slice(bracketIdx);
  return JSON.parse(str);
}

const items = readJsonFile(ITEMS_FILE && ITEMS_FILE !== '-' ? ITEMS_FILE : 0);
if (!Array.isArray(items) || items.length === 0) {
  console.error('items-file 应为非空数组');
  process.exit(1);
}

// ── 自适应间距计算 ────────────────────────────
// 类型优先规则
function getPrefixType(d) {
  if (/^D/.test(d)) return 'diode';
  if (/^Q/.test(d)) return 'transistor';
  if (/^R/.test(d)) return 'resistor_special';
  return 'other';
}

// 封装 → {w, dx, dy} 估算表
function getSizeFromFootprint(fp) {
  const patterns = [
    [/DO-35|SOD-123|SOD-323/i,          {w:80,  dx:120, dy:150}],
    [/DO-41|DO-15|DO-201AD|DO-204AL/i,  {w:120, dx:160, dy:180}],
    [/^SMA|^SMB|^SMC/i,                  {w:100, dx:140, dy:160}],
    [/TO-92(?!\d)/i,                    {w:100, dx:140, dy:200}],
    [/TO-220/i,                          {w:180, dx:220, dy:250}],
    [/DIP-4(?!\d)/i,                    {w:120, dx:160, dy:160}],
    [/DIP-8|DIP-14|PDIP-14/i,           {w:200, dx:250, dy:250}],
    [/DIP-16|PDIP-16|DIP-20/i,          {w:250, dx:250, dy:250}],
    [/SIP-12/i,                          {w:250, dx:250, dy:200}],
    [/CONN-TH_2P|HDR-TH_2P/i,           {w:120, dx:160, dy:180}],
    [/CONN-TH_[3-5]P/i,                 {w:200, dx:250, dy:200}],
    [/IDC-TH|DSUB-TH|^DB|MODE-TH/i,     {w:250, dx:250, dy:250}],
    [/RES-ADJ-TH/i,                      {w:200, dx:250, dy:250}],
    [/RES-TH/i,                          {w:150, dx:200, dy:200}],
    [/HC-49S/i,                          {w:200, dx:250, dy:200}],
    [/LED-SEG/i,                         {w:250, dx:250, dy:250}],
    [/SOIC-8/i,                          {w:200, dx:250, dy:250}],
    [/SOIC-14/i,                         {w:250, dx:250, dy:250}],
    [/LQFP-48/i,                         {w:250, dx:250, dy:250}],
    [/SOT-223/i,                         {w:180, dx:250, dy:250}],
  ];
  for (const [re, size] of patterns) {
    if (re.test(fp)) return size;
  }
  return {w:200, dx:250, dy:250}; // default capped at 250
}

function getSize(fp, d) {
  const base = getSizeFromFootprint(fp);
  const prefix = getPrefixType(d);
  if (prefix === 'diode')       base.dx = 50;
  else if (prefix === 'transistor') base.dx = 120;
  else if (prefix === 'resistor_special') base.dx = 50;
  // Cap at 250
  if (base.dx > 250) base.dx = 250;
  if (base.dy > 250) base.dy = 250;
  return base;
}

// Compute Y_START (below common symbols)
async function getYStart() {
  try {
    const r = await apiCall('/execute', { code: 'const all = await eda.sch_PrimitiveComponent.getAll(); return all.filter(c => c.x !== 0 || c.y !== 0).map(c => ({d: c.designator || "", y: c.y}));' });
    if (r.success && Array.isArray(r.result)) {
      const commonMinY = Math.min(...r.result.map(c => c.y));
      const GAP = 200;
      const Y_START = commonMinY - GAP;
      console.log(`   通用符号最低 Y=${commonMinY}  →  搜索器件 Y_START=${Y_START}`);
      return Y_START;
    }
  } catch (e) {
    console.error('   获取 Y 起点失败:', e.message);
  }
  return 3000; // fallback
}

const Y_START = await getYStart();

// Compute coordinates
const ROW_MAX = 2500, X0 = 100, GROUP_GAP = 100;
let x = X0, y = Y_START, rowMaxDy = 0, prevSpec = null;
const placements = [];

for (const item of items) {
  const size = getSize(item.fp || '', item.d);

  if (prevSpec && item.spec !== prevSpec) {
    x += GROUP_GAP;
    if (x + size.w - X0 > ROW_MAX) { x = X0; y -= rowMaxDy; rowMaxDy = 0; }
  }
  if (x + size.w - X0 > ROW_MAX) { x = X0; y -= rowMaxDy; rowMaxDy = 0; }

  placements.push({ spec: item.spec, d: item.d, x, y, approxOrig: item.approxOrig });
  x += size.dx;
  if (size.dy > rowMaxDy) rowMaxDy = size.dy;
  prevSpec = item.spec;
}

// ── Bridge API helpers ─────────────────────────
async function apiCall(endpoint, body) {
  const resp = await fetch(`${BRIDGE}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  return resp.json();
}

// ── 放置 ──────────────────────────────────────
console.log(`\n⚡ 搜索器件放置: ${placements.length} 个`);
console.log(`   每批 ${BATCH_SIZE}  总批次 ${Math.ceil(placements.length / BATCH_SIZE)}\n`);

let ok = 0, fail = 0;
const failures = [];
const approxPlaced = [], approxFailed = [];
const totalBatches = Math.ceil(placements.length / BATCH_SIZE);

for (let bi = 0; bi < totalBatches; bi++) {
  const batch = placements.slice(bi * BATCH_SIZE, (bi + 1) * BATCH_SIZE);
  const results = [];

  for (const p of batch) {
    try {
      const r = await apiCall('/place', { spec: p.spec, x: p.x, y: p.y, designator: p.d });
      if (r.success && r.result && r.result.startsWith('PLACED')) {
        ok++; process.stdout.write(p.approxOrig ? 'A' : '.');
        if (p.approxOrig) approxPlaced.push({ d: p.d, orig: p.approxOrig, as: p.spec });
        results.push({ d: p.d, ok: true });
      } else {
        fail++; process.stdout.write('✗');
        results.push({ d: p.d, ok: false, err: r.result || 'UNKNOWN' });
        failures.push({ d: p.d, err: r.result || 'UNKNOWN' });
        if (p.approxOrig) approxFailed.push({ d: p.d, orig: p.approxOrig, as: p.spec });
      }
    } catch (e) {
      fail++; process.stdout.write('✗');
      failures.push({ d: p.d, err: e.message });
      if (p.approxOrig) approxFailed.push({ d: p.d, orig: p.approxOrig, as: p.spec });
    }
  }
  console.log(` ${bi + 1}/${totalBatches}`);
}

// ── 输出汇总 ──────────────────────────────────
console.log(`\n✅ 成功 ${ok}  ❌ 失败 ${fail}`);
if (approxPlaced.length) {
  console.log('\n⚠️ 近似匹配已放置（与 BOM 规格名称不一致，请核对封装/丝印）:');
  approxPlaced.forEach(a => console.log(`  ${a.d}: ${a.orig} → 放置为 ${a.as}`));
}
if (approxFailed.length) {
  console.log('\n⚠️ 近似匹配放置失败:');
  approxFailed.forEach(a => console.log(`  ${a.d}: ${a.orig} → ${a.as}`));
}
if (failures.length > 0) {
  console.log('失败清单:');
  failures.forEach(f => console.log(`  - ${f.d}: ${f.err}`));
}
