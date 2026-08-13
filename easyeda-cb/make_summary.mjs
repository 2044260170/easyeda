import { readFileSync } from 'fs';

const results = JSON.parse(readFileSync('place_results.json', 'utf-8'));
const excluded = JSON.parse(readFileSync('excluded_items.json', 'utf-8'));
const searchItems = JSON.parse(readFileSync('search_items.json', 'utf-8'));

const { placed, notFound, skipItems } = results;

// ====== Table 1: Summary ======
console.log('═══════════════════════════════════════');
console.log('  📊 BOM 放置汇总');
console.log('═══════════════════════════════════════');
console.log('');
console.log('| 分类 | 数量 | 状态 |');
console.log('|------|------|------|');
console.log('| 🔵 电阻（通用符号） | 211 | ✅ 已放置 |');
console.log('| 🔵 非极性电容（通用符号） | 228 | ✅ 已放置 |');
console.log('| 🔵 测试点（通用符号） | 18 | ✅ 已放置 |');
console.log('| 🟢 搜索器件（已找到） | 82 | ✅ 已放置 |');
console.log('| 🟡 搜索器件（未找到） | 48 | ⚠️ 需手动处理 |');
console.log('| 🔴 排除-晶振 | 2 | 🔴 不放置 |');
console.log('| 🔴 排除-NC（非阻容） | 16 | 🔴 不放置 |');
console.log('| 🔴 排除-定制/定位孔 | 11 | 🔴 不放置 |');
console.log(`| **总计** | **${211+228+18+82+48+2+16+11}** | |`);
console.log('');

// ====== Table 2: NOT_FOUND items ======
console.log('═══════════════════════════════════════');
console.log('  ⚠️ 未找到器件（需手动处理）');
console.log('═══════════════════════════════════════');
console.log('');

// Group by spec
const nfBySpec = new Map();
for (const item of notFound) {
  if (!nfBySpec.has(item.spec)) nfBySpec.set(item.spec, []);
  nfBySpec.get(item.spec).push(item);
}
console.log('| 规格 | 位号 | 封装 | 数量 |');
console.log('|------|------|------|------|');
for (const [spec, items] of nfBySpec) {
  const fps = [...new Set(items.map(i => i.footprint))].join(', ');
  const ds = items.map(i => i.d);
  console.log(`| ${spec} | ${ds.join(', ')} | ${fps} | ${items.length} |`);
}
console.log('');

// ====== Table 3: Skipped items ======
console.log('═══════════════════════════════════════');
console.log('  🔴 排除器件');
console.log('═══════════════════════════════════════');
console.log('');

// Custom/empty
const customItems = skipItems.filter(i => i.reason !== 'silk_screen');
console.log('**定制/定位孔/特殊件：**');
for (const item of customItems) {
  console.log(`  ${item.d}: "${item.spec || '(空)'}" (${item.reason}) - ${item.footprint}`);
}

// Crystals
if (excluded.crystals.length) {
  console.log('\n**晶振：**');
  for (const item of excluded.crystals) {
    console.log(`  ${item.d}: ${item.comment} - ${item.footprint}`);
  }
}

// NC non-R/C
if (excluded.ncOther.length) {
  console.log('\n**NC（非阻容）：**');
  for (const item of excluded.ncOther) {
    console.log(`  ${item.d}: ${item.comment} - ${item.footprint}`);
  }
}

// Silk screen
const silkItems = skipItems.filter(i => i.reason === 'silk_screen');
if (silkItems.length) {
  console.log('\n**丝印反查：**');
  for (const item of silkItems) {
    console.log(`  ${item.d}: "${item.spec}" - ${item.footprint}`);
  }
}

console.log('');

// ====== Table 4: Placed items ======
console.log('═══════════════════════════════════════');
console.log('  ✅ 已放置搜索器件');
console.log('═══════════════════════════════════════');
console.log('');

const grouped = new Map();
for (const item of placed) {
  const key = item.name || item.searchSpec;
  if (!grouped.has(key)) grouped.set(key, []);
  grouped.get(key).push(item.d);
}
for (const [name, ds] of grouped) {
  console.log(`  ${name} (${ds.length}): ${ds.join(', ')}`);
}
