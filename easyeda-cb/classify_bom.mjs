import { readFileSync, writeFileSync } from 'fs';

let raw = readFileSync('bom_data.json', 'utf-8');
// Strip BOM if present
if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
const bom = JSON.parse(raw);

// Classification results
const commonItems = [];  // {d: "R1", t: "resistor"}
const searchItems = [];  // {designator, spec, footprint, comment}
const excluded = { polarCaps: [], diodes: [], crystals: [], leds: [], ncOther: [], anomaly: [] };
let diodeMode = 'place'; // from user selection

// Helper: parse designator string into array
function parseDesignators(str) {
  if (!str) return [];
  // Remove trailing comma, split by comma+optional space
  return str.replace(/,\s*$/, '').split(/,\s*/).map(s => s.trim()).filter(Boolean);
}

// Check if comment is NC
function isNC(comment) {
  return comment && comment.trim().toUpperCase() === 'NC';
}

// Check if capacitor is polar
function isPolarCap(comment, footprint) {
  if (!comment) return false;
  const c = comment.trim();
  const fp = (footprint || '').toUpperCase();

  // Priority 1: non-polar model prefixes
  const nonPolarPrefixes = /^(C242|C241|C317|CC4|CC81|CK45|DCC|DCS|DCH|N13|S10|C322|DCM)/;
  if (nonPolarPrefixes.test(c)) return false;

  // Priority 2: pF/nF → non-polar
  if (/pF|nF/.test(c)) return false;

  // Priority 3: polar model prefixes
  const polarPrefixes = /^(ECR|EGD|EGW|EGX|EKY|EEU)/;
  if (polarPrefixes.test(c)) return true;

  // Priority 4: Cylindrical footprint + >=1uF
  if (/D\s*\d+\s*[xX*]\s*L\s*\d+/.test(fp)) {
    if (/(\d+(?:\.\d+)?)\s*uF/.test(c)) return true;
  }

  // Priority 5: uF level - check package
  const ufMatch = c.match(/(\d+(?:\.\d+)?)\s*uF/);
  if (ufMatch) {
    const val = parseFloat(ufMatch[1]);
    const pureFp = fp.replace(/^C/, ''); // e.g. C0805 → 0805

    // SMD small packages
    if (/^(0402|0603|0805|1206|1210)/.test(pureFp)) {
      return val > 100; // >100uF → polar (待确认 in skill, but mark as polar to be safe)
    }
    // SMD medium packages
    if (/^(1812|2220)/.test(pureFp)) {
      return val > 47;
    }
    // Tantalum packages
    if (/^(A|B|C|D|E)\b|SMD-TAN|TAN/.test(pureFp)) return true;
    // DIP radial
    if (fp.includes('P=')) return val >= 100;
    // Unknown package
    if (val >= 100) return true;
    if (val >= 10) return null; // 待确认
    return false;
  }

  return false;
}

// Check if comment is a standard resistor value
function isStdResistor(comment) {
  if (!comment) return false;
  const c = comment.trim();
  if (isNC(c)) return true; // NC resistors use common symbol
  return /[ΩkM]|ohm/i.test(c) && /\d/.test(c);
}

// Check if comment is a standard capacitor value
function isStdCapacitor(comment) {
  if (!comment) return false;
  const c = comment.trim();
  if (isNC(c)) return true; // NC capacitors use common symbol
  return /[pnu]F/i.test(c) && /\d/.test(c);
}

// Check if test point
function isTestPoint(comment, footprint) {
  const c = (comment || '').toUpperCase();
  const fp = (footprint || '').toUpperCase();
  return c.includes('TEST') || fp.includes('TP') || fp === 'TP-2';
}

// Process each BOM line
for (const row of bom) {
  const designators = parseDesignators(row.Designator);
  const comment = row.Comment || '';
  const footprint = row.Footprint || '';

  for (const d of designators) {
    const prefix = d.replace(/[\d_]+$/, ''); // e.g. R1 → R, CE3 → CE, TP1 → TP

    // === NC handling ===
    if (isNC(comment)) {
      if (prefix === 'R') {
        commonItems.push({ d, t: 'resistor' });
      } else if (prefix === 'C') {
        commonItems.push({ d, t: 'capacitor' });
      } else {
        excluded.ncOther.push({ d, comment, footprint });
      }
      continue;
    }

    // === Resistors ===
    if (prefix === 'R' || prefix === 'RC') {
      if (isStdResistor(comment)) {
        commonItems.push({ d, t: 'resistor' });
      } else {
        excluded.anomaly.push({ d, comment, footprint, type: 'resistor' });
      }
      continue;
    }

    // === Capacitors ===
    if (prefix === 'C' && d !== 'CE3' && d !== 'CE5' && d !== 'CE6' && d !== 'CE7') {
      if (isStdCapacitor(comment)) {
        const polar = isPolarCap(comment, footprint);
        if (polar === true) {
          excluded.polarCaps.push({ d, comment, footprint });
        } else if (polar === null) {
          // 待确认 — treat as non-polar for now, flag later
          commonItems.push({ d, t: 'capacitor' });
          excluded.anomaly.push({ d, comment, footprint, type: 'capacitor_ambiguous' });
        } else {
          commonItems.push({ d, t: 'capacitor' });
        }
      } else {
        // Non-standard capacitor value
        excluded.anomaly.push({ d, comment, footprint, type: 'capacitor' });
      }
      continue;
    }

    // === Electrolytic capacitors (CE*) ===
    if (prefix === 'CE') {
      searchItems.push({ d, spec: comment, footprint, comment, type: 'electrolytic' });
      continue;
    }

    // === Test Points ===
    if (prefix === 'TP') {
      commonItems.push({ d, t: 'testpad' });
      continue;
    }

    // === Diodes ===
    if (prefix === 'D') {
      if (diodeMode === 'place') {
        searchItems.push({ d, spec: comment, footprint, comment, type: 'diode' });
      } else {
        excluded.diodes.push({ d, comment, footprint });
      }
      continue;
    }

    // === Crystals ===
    if (prefix === 'Y') {
      excluded.crystals.push({ d, comment, footprint });
      continue;
    }

    // === LED ===
    if (comment.includes('发光') || comment.includes('LED')) {
      excluded.leds.push({ d, comment, footprint });
      continue;
    }

    // === Everything else → search ===
    searchItems.push({ d, spec: comment, footprint, comment, type: 'other' });
  }
}

// Sort common items: resistors → capacitors → testpads
const typeOrder = { resistor: 0, capacitor: 1, testpad: 2 };
commonItems.sort((a, b) => {
  const tdiff = typeOrder[a.t] - typeOrder[b.t];
  if (tdiff !== 0) return tdiff;
  return a.d.localeCompare(b.d, undefined, { numeric: true });
});

// Write outputs
writeFileSync('common_items.json', JSON.stringify(commonItems, null, 2));
writeFileSync('search_items.json', JSON.stringify(searchItems, null, 2));
writeFileSync('excluded_items.json', JSON.stringify(excluded, null, 2));

// Summary
console.log('=== Classification Summary ===');
console.log(`Common symbols: ${commonItems.length} items`);
console.log(`  Resistors: ${commonItems.filter(i => i.t === 'resistor').length}`);
console.log(`  Capacitors: ${commonItems.filter(i => i.t === 'capacitor').length}`);
console.log(`  Testpads: ${commonItems.filter(i => i.t === 'testpad').length}`);
console.log(`Search items: ${searchItems.length}`);
console.log(`Excluded:`);
console.log(`  Polar caps: ${excluded.polarCaps.length}`);
console.log(`  Diodes (info): ${excluded.diodes.length}`);
console.log(`  Crystals: ${excluded.crystals.length}`);
console.log(`  LEDs: ${excluded.leds.length}`);
console.log(`  NC (non-R/C): ${excluded.ncOther.length}`);
console.log(`  Anomaly: ${excluded.anomaly.length}`);
