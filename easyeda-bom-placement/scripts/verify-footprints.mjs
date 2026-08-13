#!/usr/bin/env node
/**
 * verify-footprints.mjs — BOM 封装 vs 库中封装 一致性检查
 *
 * 用法: node verify-footprints.mjs <searched-items.json> <search-results.json>
 *
 *   searched-items.json : classify 输出的搜索清单 [{spec, d, fp}]
 *   search-results.json : /search-batch 返回的 {keyword: [{n,f,u},...]}
 *
 * 对每个搜索项，在结果中找精确匹配 name===spec，对比其 footprint(f) 与
 * BOM 封装(fp)。不一致则告警（如 IN4148：库中 DO-35 vs BOM 1206）。
 * 找不到精确匹配的行列在"未精确匹配"。
 */
import { readFileSync } from 'fs';

const [,, itemsPath, resultsPath] = process.argv;
if (!itemsPath || !resultsPath) {
  console.error('用法: node verify-footprints.mjs <searched-items.json> <search-results.json>');
  process.exit(1);
}

const items = JSON.parse(readFileSync(itemsPath, 'utf-8'));
const results = JSON.parse(readFileSync(resultsPath, 'utf-8'));

const mismatch = [], missing = [], okList = [];
const seen = new Set();

for (const it of items) {
  if (seen.has(it.spec)) continue;   // 同 spec 多实例只报一次
  seen.add(it.spec);
  const hits = results[it.spec] || [];
  const exact = hits.find(h => h.n === it.spec);
  if (!exact) { missing.push({ spec: it.spec, d: it.d }); continue; }
  const bomFp = (it.fp || '').toUpperCase();
  const foundFp = (exact.f || '').toUpperCase();
  if (bomFp && foundFp && !isCompatible(bomFp, foundFp)) {
    mismatch.push({ spec: it.spec, d: it.d, bomFp: it.fp, foundFp: exact.f });
  } else {
    okList.push({ spec: it.spec, foundFp: exact.f });
  }
}

// 兼容性启发：忽略尺寸尾缀差异（如 SMA_L4.3... vs SMA），只看核心封装族；
// 引脚间距相同（P=7.5 vs P7.50）也视为兼容（径向直插 vs RES-TH 等）。
function isCompatible(a, b) {
  if (a === b) return true;
  if (a.includes(b) || b.includes(a)) return true;
  const pitch = s => (s.match(/P\s*={0,2}\s*(\d+(?:\.\d+)?)/) || [])[1];
  const pa = pitch(a), pb = pitch(b);
  if (pa && pb && Math.abs(parseFloat(pa) - parseFloat(pb)) < 0.1) return true;
  const core = s => s.replace(/_L[\d.]+.*$/, '').replace(/_W[\d.]+.*$/, '');
  const ca = core(a), cb = core(b);
  return ca === cb || ca.includes(cb) || cb.includes(ca);
}

console.log(`\n=== BOM 封装 vs 库封装 ===`);
console.log(`检查 ${seen.size} 个规格：匹配 ${okList.length}，不一致 ${mismatch.length}，未精确匹配 ${missing.length}`);
if (mismatch.length) {
  console.log('\n⚠️ 封装不一致（请核对后决定是否放置）:');
  mismatch.forEach(m => console.log(`  ${m.d} | ${m.spec} | BOM:${m.bomFp}  vs  库:${m.foundFp}`));
}
if (missing.length) {
  console.log('\n未精确匹配（库中无此名称）:');
  missing.forEach(m => console.log(`  ${m.d} | ${m.spec}`));
}
