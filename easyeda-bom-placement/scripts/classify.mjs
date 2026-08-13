#!/usr/bin/env node
/**
 * classify.mjs — BOM 分类（skill 官方分类器）
 *
 * 用法: node classify.mjs <bom-path> [--out <dir>] [--sheet N]
 *
 * 按位号前缀 → 规格单位 → 封装 三重信号分类，输出：
 *   <out>/common-items.json    通用符号 [{d,t}]  →  place-common.mjs
 *   <out>/searched-items.json  搜索器件 [{spec,d,fp}] →  place-searched.mjs
 *   <out>/summary.json         完整分类明细（含排除表/告警）
 *
 * 规则与 SKILL.md Step 2 一致。stdout 只打印分类统计 + 搜索行 + 告警，
 * 不逐行展开通用符号（token 优化）。
 */
import XLSX from 'xlsx';
import { writeFileSync, mkdirSync } from 'fs';
import { dirname, join, resolve } from 'path';

const args = process.argv.slice(2);
const bomPath = args.find(a => a && !a.startsWith('--'));
const sheetIdx = (() => {
  const i = args.indexOf('--sheet');
  return i >= 0 ? parseInt(args[i + 1], 10) : 0;
})();
const outIdx = args.indexOf('--out');
const outDir = outIdx >= 0
  ? resolve(args[outIdx + 1])
  : join(dirname(bomPath || '.'), 'bom-placement-out');

if (!bomPath) {
  console.error('用法: node classify.mjs <bom-path> [--out <dir>] [--sheet N]');
  process.exit(1);
}

// ── 分类常量 ──────────────────────────────────────
// 非极性（薄膜/瓷片/MLCC）型号前缀。CL1x/CL2x/CBB = 涤纶/聚丙烯薄膜电容。
const NONPOLAR_PREFIX = /^(C242|C241|C317|C322|CC4|CC81|CK45|DCC|DCS|DCH|N13|S10|DCM|CL1\d|CL2\d|CBB|CQ|CY)/;
// 极性（铝电解/钽）型号前缀。CD11/CD110/CD263/CD28x = 直插铝电解常见系列。
const POLAR_PREFIX = /(ECR|EGD|EGW|EGX|EKY|EEU|CD11|CD110|CD263|CD28\d)/;
const LED_RE = /LED|发光/i;
const CRYSTAL_RE = /MHz|kHz/i;
const TEST_RE = /测试点|TEST/i;   // 子串 TP 太宽泛（TPS54331/TP4056 等型号含 TP 会误判），测试点改由位号前缀 TP 识别
const CUSTOM_RE = /^定制/;
const RES_RE = /Ω|ohm/i;
const IND_RE = /nH|uH|mH|H/i;
const CAP_RE = /pF|nF|uF|uf|UF/i;
const KNOWN_MODEL = /(RS1M|BZT52|1N4007|LM2903|TLP181|EX2EDG|DS1011|2SD|2SB)/;

/** 位号类型字母：第一个数字前最后一个字母（AR10→R, AD20→D, ACW3→W, R32→R） */
function typeLetter(d) {
  const m = d.match(/([A-Za-z])(?=\d)/g);
  return m ? m[m.length - 1] : '';
}

function isPolarCap(spec, fp) {
  if (POLAR_PREFIX.test(spec)) return true;
  if (/MEFC/i.test(spec)) return true;
  if (/uF/i.test(spec)) {
    // 圆柱封装：D<直径>XL<长度>MM / D<直径>X<长度>MM / D<直径>*L<长度>MM（如 D16XL26MM、D8*L20MM）
    const cyl = /D\s*[\d.]+\s*(?:[X×*]\s*)?L?\s*[\d.]+\s*MM/i;
    const radial = /P\s*=\s*\d+MM/i;
    const smdSmall = /(0402|0603|0805|1206|1210)/;
    const smdMid = /(1812|2220)/;
    const ufVal = (spec.match(/(\d+(?:\.\d+)?)\s*uF/i) || [])[1];
    if (cyl.test(fp)) return true;
    if (radial.test(fp)) return ufVal && parseFloat(ufVal) >= 100;
    if (smdSmall.test(fp)) return false;            // MLCC
    if (smdMid.test(fp)) return ufVal && parseFloat(ufVal) > 47; // 1812/2220 >47uF 待确认
    if (/SMD-TAN|钽/i.test(fp) || /SMD-TAN|钽/i.test(spec)) return true;
    return false;
  }
  return false;
}

function classify(spec, fp, desigs) {
  spec = spec.trim();
  const first = desigs[0] || '';

  if (/^TP/i.test(first)) return 'testpad';                              // 位号前缀 TP → 测试点（最可靠）
  if (TEST_RE.test(spec)) return 'testpad';                              // 规格明确写"测试点"/TEST 作备用
  if (CUSTOM_RE.test(spec)) return 'custom';                             // 定制件
  if (spec === 'NC') {                                                   // NC
    // 位号首字母 或 封装首字母 以 R/C+数字 开头 → 通用阻容；否则排除
    // （"UC1"+SOP-16 是 IC，不能因 type 字母 C 就误判为电容）
    const rHit = /^R\d/.test(first) || /^R\d/.test(fp);
    const cHit = /^C\d/.test(first) || /^C\d/.test(fp);
    if (rHit && !cHit) return 'resistor';
    if (cHit && !rHit) return 'capacitor';
    if (rHit && cHit) return 'resistor';
    return 'nc_excluded';
  }
  // 安装孔：规格 "H"/"H1"/"H 3.2"/"H 3.2MM"/"H孔"/"安装孔"。注意必须 H 在**前面**——
  // "1H"/"10H"（真电感，数字在前）和 "10uH"/"1mH" 不命中，落到 IND_RE 归电感。
  if (/^H[\s\d.]*(?:MM)?\s*$/i.test(spec) || /^H[\s\d.]*\s*孔/i.test(spec) || /安装孔/i.test(spec)) return 'mount';
  if (LED_RE.test(spec)) return 'led';
  if (CRYSTAL_RE.test(spec)) return 'crystal';
  if (RES_RE.test(spec)) return 'resistor';
  if (isPolarCap(spec, fp) === true) return 'polar_cap';                 // 电解型号/圆柱封装 优先于电感（防 CD288H1... 含 "H" 被误判）
  if (IND_RE.test(spec)) return 'inductor';
  if (CAP_RE.test(spec)) return 'capacitor';
  if (NONPOLAR_PREFIX.test(spec)) return 'capacitor';                    // 薄膜/瓷片型号前缀
  return 'search';
}

/** 提取搜索型号：去掉 (类似)/(可能是)/(待确认)/(相似)/(实测) 等注释（半角+全角括号）。
 * 保留内部空格（如 "AM-300 300V 12A"），只折叠连续空白并修 "SRV05-4. TCT" 这类点后空格。 */
function extractModel(spec) {
  let s = spec.replace(/\s*[\(（](类似|可能是|待确认|相似|实测|实物缺\d+P)[\)）]\s*$/g, '').trim();
  s = s.replace(/\s+/g, ' ').replace(/\.\s+/g, '.');
  return s || null;   // null → 无型号可搜
}

// ── 逐行分类 ──────────────────────────────────────
let wb;
try { wb = XLSX.readFile(bomPath); } catch (e) { console.error(`读取失败: ${bomPath}\n${e.message}`); process.exit(1); }
const sheetName = wb.SheetNames[sheetIdx];
if (!sheetName) { console.error(`无工作表 ${sheetIdx}。可用: ${wb.SheetNames.join(', ')}`); process.exit(1); }
const ws = wb.Sheets[sheetName];
const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

const common = [];        // {d,t}
const searched = [];      // {spec,d,fp}
const polarCaps = [], leds = [], ncExcluded = [], customSkip = [], mountHoles = [], anomalies = [];
let total = 0;
const seenRows = [];

for (let i = 1; i < rows.length; i++) {
  const row = rows[i];
  if (!row || row.length === 0) continue;
  const desigStr = String(row[0] || '').trim();
  if (!desigStr) continue;
  const spec = String(row[1] || '').trim();
  const fp = String(row[2] || '').trim();
  const qty = Number(row[3]) || 0;

  const desigs = desigStr.split(',').map(s => s.trim()).filter(Boolean);
  total += desigs.length;

  const kind = classify(spec, fp, desigs);
  const model = extractModel(spec);
  seenRows.push({ row: i + 1, spec, fp, qty, desigs, kind, model });

  switch (kind) {
    case 'resistor':  desigs.forEach(d => common.push({ d, t: 'resistor' })); break;
    case 'capacitor': desigs.forEach(d => common.push({ d, t: 'capacitor' })); break;
    case 'inductor':  desigs.forEach(d => common.push({ d, t: 'inductor' })); break;
    case 'testpad':   desigs.forEach(d => common.push({ d, t: 'testpad' })); break;
    case 'polar_cap': polarCaps.push({ desig: desigStr, spec, fp, qty }); break;
    case 'led':       leds.push({ desig: desigStr, spec, fp, qty }); break;
    case 'crystal':   leds.push({ desig: desigStr, spec, fp, qty, note: 'crystal' }); break;
    case 'nc_excluded': ncExcluded.push({ desig: desigStr, spec, fp, qty }); break;
    case 'mount':     mountHoles.push({ desig: desigStr, spec, fp, qty }); break;
    case 'custom':    customSkip.push({ desig: desigStr, spec, fp, qty }); break;
    case 'search':
    default:
      if (model) desigs.forEach(d => searched.push({ spec: model, d, fp }));
      else customSkip.push({ desig: desigStr, spec, fp, qty, note: '无型号可搜' });
      break;
  }
}

// 异常阻容感告警：整行位号**字母前缀**均为 R/C（单字母），却走搜索且规格无标准单位。
// 用完整字母前缀而非 typeLetter：IC1 前缀是 "IC"（IC 器件），不是电容，不能算异常。
function alphaPrefix(d) { return (d.match(/^[A-Za-z]+/) || [''])[0]; }
for (const r of seenRows) {
  if (r.kind !== 'search') continue;
  const allRC = r.desigs.every(d => { const ap = alphaPrefix(d); return ap === 'R' || ap === 'C'; });
  if (allRC && !KNOWN_MODEL.test(r.spec) && !RES_RE.test(r.spec) && !CAP_RE.test(r.spec)) {
    anomalies.push({ desig: r.desigs.join(', '), spec: r.spec, fp: r.fp, reason: 'C/R 位号但规格无标准阻容单位' });
  }
}

// ── 写出 ──────────────────────────────────────────
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'common-items.json'), JSON.stringify(common, null, 1));
writeFileSync(join(outDir, 'searched-items.json'), JSON.stringify(searched, null, 1));
writeFileSync(join(outDir, 'summary.json'), JSON.stringify({
  bomPath, sheetName, totalDesignators: total,
  counts: { resistor: common.filter(i => i.t === 'resistor').length,
            capacitor: common.filter(i => i.t === 'capacitor').length,
            inductor: common.filter(i => i.t === 'inductor').length,
            testpad: common.filter(i => i.t === 'testpad').length,
            polar_cap: polarCaps.reduce((a, r) => a + r.qty, 0),
            led: leds.reduce((a, r) => a + r.qty, 0),
            nc_excluded: ncExcluded.reduce((a, r) => a + r.qty, 0),
            mount_hole: mountHoles.reduce((a, r) => a + r.qty, 0),
            custom: customSkip.reduce((a, r) => a + r.qty, 0),
            search: searched.length },
  polarCaps, leds, ncExcluded, mountHoles, customSkip, anomalies, seenRows,
}, null, 1));

// ── 打印汇总（只打搜索行 + 告警 + 统计）────────────
const bySpec = {};
for (const s of searched) bySpec[s.spec] = (bySpec[s.spec] || 0) + 1;

console.log('=== BOM 分类完成 ===');
console.log(`总位号 ${total} → 通用 ${common.length} | 搜索 ${searched.length} | 排除 ${total - common.length - searched.length}`);
console.log(`通用: R${common.filter(i => i.t === 'resistor').length} C${common.filter(i => i.t === 'capacitor').length} L${common.filter(i => i.t === 'inductor').length} TP${common.filter(i => i.t === 'testpad').length}`);
console.log(`排除: 极性电容${polarCaps.reduce((a, r) => a + r.qty, 0)} LED/晶振${leds.reduce((a, r) => a + r.qty, 0)} 非阻容NC${ncExcluded.reduce((a, r) => a + r.qty, 0)} 定制${customSkip.reduce((a, r) => a + r.qty, 0)} 安装孔${mountHoles.reduce((a, r) => a + r.qty, 0)}`);

if (searched.length) {
  console.log('\n→ 搜索规格（可直接传 /search-batch）:');
  console.log(Object.keys(bySpec).map(k => `${k}(${bySpec[k]})`).join(', '));
}
if (anomalies.length) {
  console.log('\n⚠️ 异常阻容感:');
  anomalies.forEach(a => console.log(`  ${a.desig} | ${a.spec} | ${a.reason}`));
}
console.log(`\n输出: ${outDir}`);
