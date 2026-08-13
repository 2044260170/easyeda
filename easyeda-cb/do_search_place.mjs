import { readFileSync, writeFileSync } from 'fs';

const BRIDGE = 'http://127.0.0.1:49620';

async function exec(code) {
  const r = await fetch(`${BRIDGE}/execute`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code })
  });
  const j = await r.json();
  return j.result ? JSON.parse(j.result) : j;
}

async function searchExact(keyword) {
  const r = await fetch(`${BRIDGE}/search`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keyword, exact: true })
  });
  const j = await r.json();
  if (!j.success) return [];
  return j.result || [];
}

async function placeOne(spec, x, y, designator) {
  const r = await fetch(`${BRIDGE}/place`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ spec, x, y, designator })
  });
  return await r.json();
}

async function deleteByDesignator(d) {
  return exec(`
    const all = await eda.sch_PrimitiveComponent.getAll();
    const target = all.filter(c => c.designator === '${d}');
    for (const c of target) await eda.sch_PrimitiveComponent.delete(c);
    return JSON.stringify({deleted: target.length});
  `);
}

// ====== Main ======
const searchItems = JSON.parse(readFileSync('search_items.json', 'utf-8'));

// Step 1: Pre-filter
const toPlace = [];
const skipItems = [];

for (const item of searchItems) {
  const spec = item.spec.trim();
  if (!spec) { skipItems.push({...item, reason: 'empty_spec'}); continue; }
  if (spec.includes('定制') || spec === '金手指') { skipItems.push({...item, reason: 'custom'}); continue; }
  if (spec.startsWith('丝印')) { skipItems.push({...item, reason: 'silk_screen'}); continue; }
  const searchSpec = spec.replace(/\(类似\)/g, '').trim();
  toPlace.push({...item, searchSpec});
}

console.log(`To search+place: ${toPlace.length}, Skip: ${skipItems.length}`);

// Step 2: Get commonMinY for coordinate calculation
const comps = await exec(`
  const all = await eda.sch_PrimitiveComponent.getAll();
  return JSON.stringify(all.map(c => ({d: c.designator, x: c.x, y: c.y})));
`);
const commonYs = comps
  .filter(c => /^(R|C|TP)/.test(c.d || ''))
  .filter(c => c.x !== 0 || c.y !== 0)
  .map(c => c.y);
const commonMinY = Math.min(...commonYs);
const GAP = 200;
const Y_START = commonMinY - GAP;
const Y_STEP = -120;
const X_START = 100, X_STEP = 300, PER_ROW = 8;
console.log(`CommonMinY: ${commonMinY}, Y_START: ${Y_START}`);

// Step 3: Search unique specs
const uniqueSpecs = [...new Set(toPlace.map(i => i.searchSpec))];
const searchResults = new Map(); // spec → {found: true/false, name: ..., multiPart: bool}

console.log(`\nSearching ${uniqueSpecs.length} unique specs...`);
for (let i = 0; i < uniqueSpecs.length; i++) {
  const spec = uniqueSpecs[i];
  process.stdout.write(`  [${i+1}/${uniqueSpecs.length}] ${spec}... `);
  const results = await searchExact(spec);
  // Check exact match
  const exact = results.find(r => r.n === spec);
  const suffix = results.find(r => r.n && r.n.startsWith(spec + '_'));
  if (exact || suffix) {
    const match = exact || suffix;
    console.log(`FOUND: ${match.n}`);
    searchResults.set(spec, { found: true, name: match.n, uuid: match.u });
  } else {
    console.log('NOT_FOUND');
    searchResults.set(spec, { found: false });
  }
}

// Step 4: Place found items
const placed = [];
const notFound = [];
let gridIdx = 0;

console.log(`\nPlacing found items...`);
for (const item of toPlace) {
  const sr = searchResults.get(item.searchSpec);
  if (!sr || !sr.found) {
    notFound.push(item);
    continue;
  }

  const col = gridIdx % PER_ROW;
  const row = Math.floor(gridIdx / PER_ROW);
  const x = X_START + col * X_STEP;
  const y = Y_START + row * Y_STEP;

  // Delete existing component with same designator
  await deleteByDesignator(item.d);

  // Place
  const result = await placeOne(sr.name, x, y, item.d);
  if (result.success && !result.result?.startsWith?.('NOT_FOUND')) {
    gridIdx++;
    placed.push({...item, x, y, name: sr.name});
    console.log(`  OK: ${item.d} (${sr.name}) @ (${x},${y})`);
  } else {
    notFound.push(item);
    console.log(`  FAIL: ${item.d} (${sr.name}) - ${JSON.stringify(result)}`);
  }
}

// Step 5: Summary
console.log(`\n=== RESULTS ===`);
console.log(`Placed: ${placed.length}`);
console.log(`Not found: ${notFound.length}`);
console.log(`Skipped (custom/empty): ${skipItems.length}`);

writeFileSync('place_results.json', JSON.stringify({ placed, notFound, skipItems }, null, 2));
console.log('Results saved to place_results.json');
