#!/usr/bin/env node
/**
 * place-common.mjs — 通用符号批量放置
 *
 * 用法: node place-common.mjs <bridge-port> [items-file.json|-]
 *   items 可来自文件，或传 '-' 从 stdin 读取（规避 Windows 上 Node 读不了
 *   Write 工具生成的 .json 的问题——stdin 是管道，不走文件读取拦截）。
 *
 * items-file.json 格式:
 *   [{"d":"R1","t":"resistor"}, {"d":"C1","t":"capacitor"}, {"d":"TP1","t":"testpad"}]
 *
 * 从 common-symbols.json 读配置，按类型分区自动排列，20 列/行。
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BRIDGE = `http://127.0.0.1:${process.argv[2]}`;
const ITEMS_FILE = process.argv[3];
const CONFIG_PATH = resolve(__dirname, '..', 'common-symbols.json');
const BATCH_SIZE = 20; // 每批放置数量

if (!process.argv[2]) {
  console.error('用法: node place-common.mjs <bridge-port> [items-file.json|-]');
  process.exit(1);
}

// ── 读取配置 ──────────────────────────────────
const CONFIG = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
const { libraryUuid: LIB, placement: PLC, symbols: SYM_DEF } = CONFIG;

// ── 读取输入（自动检测编码；'-' 或省略 → 读 stdin）──
let rawBytes;
if (ITEMS_FILE && ITEMS_FILE !== '-') {
  rawBytes = readFileSync(ITEMS_FILE);
} else {
  rawBytes = readFileSync(0);   // stdin 管道，绕开文件读取拦截
}
// Detect and handle UTF-16 LE (PowerShell COM Write) and UTF-8 BOM
let rawJson;
if (rawBytes.length >= 2 && rawBytes[0] === 0xFF && rawBytes[1] === 0xFE) {
  rawJson = Buffer.from(rawBytes).toString('utf16le');
} else if (rawBytes.length >= 2 && rawBytes[0] === 0xFE && rawBytes[1] === 0xFF) {
  rawJson = Buffer.from(rawBytes).toString('utf16be');
} else {
  rawJson = Buffer.from(rawBytes).toString('utf-8');
}
if (rawJson.charCodeAt(0) === 0xFEFF) rawJson = rawJson.slice(1); // strip UTF-8 BOM
// Strip any leading garbage before first '['
const bracketIdx = rawJson.indexOf('[');
if (bracketIdx > 0) rawJson = rawJson.slice(bracketIdx);
const items = JSON.parse(rawJson);
if (!Array.isArray(items) || items.length === 0) {
  console.error('items-file 应为非空数组');
  process.exit(1);
}

// ── 校验 type ─────────────────────────────────
const VALID_TYPES = new Set(['resistor', 'capacitor', 'inductor', 'testpad']);
for (const item of items) {
  if (!VALID_TYPES.has(item.t)) {
    console.error(`未知类型: "${item.t}" (designator: ${item.d})`);
    process.exit(1);
  }
  if (!item.d) {
    console.error('缺少 designator');
    process.exit(1);
  }
}

// ── 按类型分组（电阻→电容→测试点） ──────────
const groups = { resistor: [], capacitor: [], inductor: [], testpad: [] };
for (const item of items) {
  groups[item.t].push(item.d);
}

// ── 计算坐标 ─────────────────────────────────
// 为每个 designator 生成 {d, t, x, y}
const placed = [];

for (const [type, designators] of Object.entries(groups)) {
  if (designators.length === 0) continue;

  const start = PLC.starts[type];
  if (!start) { console.error(`无起点配置: ${type}`); process.exit(1); }

  const cols = PLC.cols;
  const dy = PLC.dy;

  let col = 0, x = start.x, y = start.y;

  for (const d of designators) {
    if (col >= cols) {
      col = 0;
      x = start.x;
      y -= dy;
    }
    placed.push({ d, t: type, x, y });
    x += start.dx;
    col++;
  }
}

// ── Bridge 调用 ────────────────────────────────
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

// ── 批量放置 ──────────────────────────────────
console.log(`\n⚡ 通用符号放置: ${placed.length} 个器件`);
console.log(`   电阻 ${groups.resistor.length}  电容 ${groups.capacitor.length}  电感 ${groups.inductor.length}  测试点 ${groups.testpad.length}`);
console.log(`   每行 ${PLC.cols} 个  批大小 ${BATCH_SIZE}\n`);

let ok = 0, fail = 0;
const failures = [];
const totalBatches = Math.ceil(placed.length / BATCH_SIZE);

for (let bi = 0; bi < totalBatches; bi++) {
  const batch = placed.slice(bi * BATCH_SIZE, (bi + 1) * BATCH_SIZE);

  const symUuids = {};
  for (const t of Object.keys(SYM_DEF)) {
    symUuids[t] = SYM_DEF[t].deviceUuid;
  }

  const batchJson = JSON.stringify(batch);
  const symsJson = JSON.stringify(symUuids);

  try {
    const result = await execute(`
      const LIB = ${JSON.stringify(LIB)};
      const SYMS = ${symsJson};
      const items = ${batchJson};
      const results = [];
      for (const item of items) {
        try {
          const comp = await eda.sch_PrimitiveComponent.create(
            {libraryUuid: LIB, uuid: SYMS[item.t]}, item.x, item.y, "", 0, false, true, true
          );
          if (!comp) { results.push({d:item.d, ok:false, err:"create null"}); continue; }
          await eda.sch_PrimitiveComponent.modify(comp, {designator: item.d});
          results.push({d:item.d, ok:true});
        } catch(e) {
          results.push({d:item.d, ok:false, err:e.message});
        }
      }
      return JSON.stringify(results);
    `);

    for (const r of result) {
      if (r.ok) { ok++; process.stdout.write('.'); }
      else { fail++; failures.push(r); process.stdout.write('✗'); }
    }
    console.log(` ${bi + 1}/${totalBatches}`);
  } catch (e) {
    // 整批失败
    for (const item of batch) {
      fail++;
      failures.push({ d: item.d, ok: false, err: e.message });
    }
    console.log(` ✗ 第${bi + 1}批崩溃: ${e.message}`);
  }
}

// ── 输出汇总 ──────────────────────────────────
console.log(`\n✅ 成功 ${ok}  ❌ 失败 ${fail}`);
if (failures.length > 0) {
  console.log('失败清单:');
  failures.forEach(f => console.log(`  - ${f.d}: ${f.err}`));
}
