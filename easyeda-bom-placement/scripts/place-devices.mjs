#!/usr/bin/env node
/**
 * place-devices.mjs — 单部件器件并发快放
 *
 * 芯片/运放等多部件器件由 AI 直接处理（search → _*匹配 → 试放.2 → create 循环），
 * 不经过此脚本。脚本只负责单部件器件走 /place 端点的并发放置。
 *
 * 用法:
 *   node place-devices.mjs <bridge-port> <items-file.json>
 *
 * items-file.json:
 *   [{"d":"D1","spec":"HS1O","x":100,"y":100}, ...]
 *
 *   d=designator, spec=搜索关键词, x/y=坐标（AI 已按自适应间距预计算）
 */

import { readFileSync } from 'fs';

const BRIDGE = `http://127.0.0.1:${process.argv[2]}`;
const ITEMS_FILE = process.argv[3];
const CONCURRENCY = 5;

if (!process.argv[2] || !process.argv[3]) {
  console.error('用法: node place-devices.mjs <bridge-port> <items-file.json>');
  process.exit(1);
}

// ── 读取输入 ──────────────────────────────────
let raw = readFileSync(ITEMS_FILE, 'utf-8');
if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
const items = JSON.parse(raw);
if (!Array.isArray(items) || items.length === 0) {
  console.error('items 应为非空数组');
  process.exit(1);
}

console.log(`\n⚡ 单部件放置: ${items.length} 个  并发 ${CONCURRENCY}\n`);

// ── /place 放置 ──────────────────────────────
async function placeOne({ spec, x, y, designator }) {
  const t0 = Date.now();
  try {
    const resp = await fetch(`${BRIDGE}/place`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ spec, x, y, designator }),
      signal: AbortSignal.timeout(30000),
    });
    const json = await resp.json();
    return { d: designator, spec, result: json.result, ms: Date.now() - t0 };
  } catch (e) {
    return { d: designator, spec, result: 'ERROR: ' + e.message, ms: Date.now() - t0 };
  }
}

// ── 并发执行 ──────────────────────────────────
const results = new Array(items.length);
let nextIdx = 0;

async function worker(id) {
  while (true) {
    const i = nextIdx++;
    if (i >= items.length) break;
    const r = await placeOne(items[i]);
    results[i] = r;
    const icon = r.result.startsWith('PLACED') ? '.' : '✗';
    process.stdout.write(icon);
  }
}

const workers = [];
for (let w = 0; w < Math.min(CONCURRENCY, items.length); w++) {
  workers.push(worker(w + 1));
}
await Promise.all(workers);
console.log('');

// ── 汇总 ──────────────────────────────────────
let ok = 0, fail = 0;
const failures = [];

for (const r of results) {
  if (r.result.startsWith('PLACED')) {
    ok++;
  } else {
    fail++;
    failures.push({ d: r.d, reason: r.result });
  }
}

console.log(`✅ 成功 ${ok}  ❌ 失败 ${fail}`);
if (failures.length > 0) {
  console.log('失败清单:');
  failures.forEach(f => console.log(`  - ${f.d}: ${f.reason}`));
}
