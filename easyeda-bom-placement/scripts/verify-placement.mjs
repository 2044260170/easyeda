#!/usr/bin/env node
/**
 * verify-placement.mjs — 放置后验证（post-placement sanity check）
 *
 * 用法: node verify-placement.mjs <bridge-port>
 *
 * 查询 EDA 全部已放置器件，检查：
 *   - 总数量 + 按位号前缀统计
 *   - 同坐标重叠（两个器件 x/y 完全相同 → 疑似叠放）
 *   - 位号仍为默认（含 '?'，如 U?/C?）→ 未设位号
 *   - 位号为空
 */
const PORT = process.argv[2];
if (!PORT) { console.error('用法: node verify-placement.mjs <bridge-port>'); process.exit(1); }

async function main() {
  const res = await fetch(`http://127.0.0.1:${PORT}/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code: 'const all = await eda.sch_PrimitiveComponent.getAll(); return all.map(c => ({d: (c.designator||""), x: c.x, y: c.y}));',
    }),
    signal: AbortSignal.timeout(30000),
  });
  const j = await res.json();
  const comps = j.result || [];
  const placed = comps.filter(c => c.d && c.d !== '');
  const empty = comps.filter(c => !c.d || c.d === '');
  const unset = placed.filter(c => c.d.includes('?'));

  // 同坐标重叠
  const seen = new Map();
  const overlaps = [];
  for (const c of placed) {
    const key = `${c.x},${c.y}`;
    if (seen.has(key)) overlaps.push([seen.get(key), c.d, key]);
    else seen.set(key, c.d);
  }

  // 前缀统计
  const byPrefix = {};
  for (const c of placed) {
    const m = c.d.match(/^[A-Za-z]+/);
    const p = m ? m[0] : '(其他)';
    byPrefix[p] = (byPrefix[p] || 0) + 1;
  }

  console.log(`\n=== 放置验证 ===`);
  console.log(`总器件 ${comps.length}  已设位号 ${placed.length}  空位号 ${empty.length}  默认位号(含?) ${unset.length}`);
  console.log('按前缀: ' + Object.entries(byPrefix).map(([k, v]) => `${k}:${v}`).join('  '));
  if (overlaps.length) {
    console.log(`\n⚠️ 同坐标重叠 ${overlaps.length} 处:`);
    overlaps.forEach(([a, b, key]) => console.log(`  (${key}) ${a} <-> ${b}`));
  } else {
    console.log('✅ 无同坐标重叠');
  }
  if (unset.length) {
    console.log(`\n⚠️ 未设位号(默认): ${unset.map(c => c.d).join(', ')}`);
  }
  if (empty.length) {
    console.log(`\n⚠️ 空位号: ${empty.length} 个`);
  }
}
main().catch(e => { console.error('ERR', e.message); process.exit(1); });
