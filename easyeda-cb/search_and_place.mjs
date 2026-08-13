import { readFileSync, writeFileSync } from 'fs';

const BRIDGE = 'http://127.0.0.1:49620';
const searchItems = JSON.parse(readFileSync('search_items.json', 'utf-8'));

// ====== Step 1: Pre-filter ======
const skipReasons = [];  // items that are custom/skip
const toSearch = [];     // items that need searching
const silkItems = [];    // silk screen items for WebSearch later

for (const item of searchItems) {
  const spec = item.spec.trim();

  // Empty spec → skip (mounting holes etc)
  if (!spec) {
    skipReasons.push({ ...item, reason: 'empty_spec' });
    continue;
  }

  // Custom parts
  if (spec.includes('定制')) {
    skipReasons.push({ ...item, reason: 'custom' });
    continue;
  }

  // Silk screen markings
  if (spec.startsWith('丝印')) {
    silkItems.push(item);
    skipReasons.push({ ...item, reason: 'silk_screen' });
    continue;
  }

  // Gold finger / special mechanical
  if (spec === '金手指') {
    skipReasons.push({ ...item, reason: 'mechanical_special' });
    continue;
  }

  // Strip (类似) suffix
  let searchSpec = spec.replace(/\(类似\)/g, '').trim();

  toSearch.push({ ...item, searchSpec });
}

console.log(`Pre-filter results:`);
console.log(`  Skip (custom/empty/silk): ${skipReasons.length}`);
console.log(`  To search: ${toSearch.length}`);

// ====== Step 2: Search unique specs ======
const searchCache = new Map(); // spec → {exact: {...}, suffix: {...}, notFound: true}

// Note: we can't batch search in one /execute call (API limitation)
// Instead we'll use individual /search calls

const uniqueSearchSpecs = [...new Set(toSearch.map(i => i.searchSpec))];
console.log(`  Unique search specs: ${uniqueSearchSpecs.length}`);

// Just list for now - we'll do the actual search+place next
const result = {
  searchCount: toSearch.length,
  skipCount: skipReasons.length,
  uniqueSpecs: uniqueSearchSpecs,
  silkItems: silkItems.map(i => i.spec)
};
writeFileSync('search_plan.json', JSON.stringify(result, null, 2));

// Print skip reasons summary
console.log('\n=== Skip Details ===');
const byReason = {};
for (const s of skipReasons) {
  byReason[s.reason] = (byReason[s.reason] || 0) + 1;
}
for (const [k, v] of Object.entries(byReason)) {
  console.log(`  ${k}: ${v}`);
}

// Print to-search items grouped by spec
console.log('\n=== To Search Items ===');
const bySpec = new Map();
for (const item of toSearch) {
  if (!bySpec.has(item.searchSpec)) bySpec.set(item.searchSpec, []);
  bySpec.get(item.searchSpec).push(item);
}
for (const [spec, items] of bySpec) {
  console.log(`  ${spec} (${items.length}): ${items.map(i => i.d).join(',')}`);
}
