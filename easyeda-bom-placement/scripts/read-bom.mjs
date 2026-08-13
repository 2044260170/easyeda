#!/usr/bin/env node
/**
 * read-bom.mjs — 读取 BOM Excel，输出结构化行（供 AI 快速查看 / 分类前置步骤）
 *
 * 用法: node read-bom.mjs <bom-path> [--sheet N] [--json]
 *
 *   --sheet N  选择工作表（0 起，默认 0）
 *   --json     输出 JSON 数组（机器可读），默认输出紧凑表格行（token 友好）
 *
 * 放在 scripts/ 目录内运行，xlsx 模块自动从本 skill 的 node_modules 解析，
 * 不受调用方 cwd 影响（解决 MODULE_NOT_FOUND）。
 */
import XLSX from 'xlsx';

const args = process.argv.slice(2);
const bomPath = args.find(a => a && !a.startsWith('--'));
const sheetIdx = (() => {
  const i = args.indexOf('--sheet');
  return i >= 0 ? parseInt(args[i + 1], 10) : 0;
})();
const asJson = args.includes('--json');

if (!bomPath) {
  console.error('用法: node read-bom.mjs <bom-path> [--sheet N] [--json]');
  process.exit(1);
}

let wb;
try {
  wb = XLSX.readFile(bomPath);
} catch (e) {
  console.error(`读取失败: ${bomPath}\n${e.message}`);
  process.exit(1);
}
const sheetName = wb.SheetNames[sheetIdx];
if (!sheetName) {
  console.error(`无工作表 ${sheetIdx}。可用: ${wb.SheetNames.join(', ')}`);
  process.exit(1);
}
const ws = wb.Sheets[sheetName];
const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

const parsed = [];
for (let i = 0; i < rows.length; i++) {
  const row = rows[i];
  if (!row || row.length === 0) continue;
  const desigStr = String(row[0] || '').trim();
  if (!desigStr) continue;
  const spec = String(row[1] || '').trim();
  const fp = String(row[2] || '').trim();
  const qty = Number(row[3]) || 0;
  const designators = desigStr.split(',').map(s => s.trim()).filter(Boolean);
  parsed.push({ row: i + 1, desig: desigStr, designators, spec, fp, qty });
}

if (asJson) {
  console.log(JSON.stringify(parsed, null, 1));
} else {
  // 紧凑表格行：便于 AI 一眼扫读，token 最小
  for (const r of parsed) {
    console.log(`${r.row} | ${r.desig} | ${r.spec} | ${r.fp} | ${r.qty}`);
  }
  console.error(`# ${sheetName}: ${parsed.length} 行`);
}
