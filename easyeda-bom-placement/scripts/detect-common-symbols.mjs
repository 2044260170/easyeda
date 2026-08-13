#!/usr/bin/env node
/**
 * detect-common-symbols.mjs
 *
 * 自动检测 EasyEDA 库中的三个通用符号（电阻、电容、TEST_PAD），
 * 生成/更新 common-symbols.json 配置文件。
 *
 * 用法:
 *   node detect-common-symbols.mjs [bridge-port]
 *
 * 原理:
 *   - 在 EasyEDA JS 运行时内部执行中文搜索（避开 HTTP 传输编码问题）
 *   - 搜不到则枚举个人库全部器件，按名称+位号前缀匹配
 *   - 输出到 common-symbols.json
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BRIDGE_PORT = process.argv[2] || '49620';
const BRIDGE_URL = `http://localhost:${BRIDGE_PORT}`;
const CONFIG_PATH = resolve(__dirname, 'common-symbols.json');

// ── 目标符号定义 ──────────────────────────────────
const TARGETS = [
  { name: '电阻', designator: 'R?', type: 'resistor' },
  { name: '电容', designator: 'C?', type: 'capacitor' },
  { name: 'TEST_PAD', designator: 'TP?', type: 'test_point' },
];

// ── 工具函数 ──────────────────────────────────────
async function execute(code) {
  const res = await fetch(`${BRIDGE_URL}/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  const json = await res.json();
  if (!json.success) throw new Error(`Execute failed: ${json.error}`);
  return json.result;
}

async function healthCheck() {
  const res = await fetch(`${BRIDGE_URL}/health`);
  const json = await res.json();
  if (json.service !== 'easyeda-bridge') throw new Error('Not an EasyEDA bridge');
  if (!json.edaConnected) throw new Error('EasyEDA not connected to bridge');
  return json;
}

// ── 主逻辑 ────────────────────────────────────────
async function main() {
  console.log('🔍 EasyEDA 通用符号检测器\n');

  // 1. 检查连接
  console.log('  [1/4] 检查 Bridge 连接...');
  const health = await healthCheck();
  console.log(`  ✅ Bridge OK, EDA connected (${health.edaWindowCount} window(s))`);

  // 2. 获取库 UUID
  console.log('  [2/4] 获取个人库 UUID...');
  const libUuid = await execute(
    'return await eda.lib_LibrariesList.getPersonalLibraryUuid();'
  );
  console.log(`  ✅ 个人库: ${libUuid}`);

  // 3. 搜索三个符号
  console.log('  [3/4] 搜索电阻/电容/TEST_PAD...');

  // 核心搜索逻辑在 EasyEDA 内部执行
  const detectionCode = `
    const libUuid = arguments[0];
    const targets = arguments[1];
    const results = {};

    for (const t of targets) {
      // 方案 A: 直接搜中文名（EasyEDA 内部中文正常工作）
      const devices = await eda.lib_Device.search(t.name, libUuid);
      let match = devices.find(d => d.name === t.name);

      // 方案 B: 搜不到则枚举全库器件，按名称+位号匹配
      if (!match) {
        for (let page = 1; page <= 20; page++) {
          const pageDevices = await eda.lib_Device.search("", libUuid, null, null, 50, page);
          if (!pageDevices.length) break;

          match = pageDevices.find(d => d.name === t.name);
          if (!match) {
            // 名称匹配不到（编码问题），按位号前缀 + 简单名称匹配
            match = pageDevices.find(d => {
              const designator = d.otherProperty?.Designator || d.otherProperty?.designator || "";
              const dname = (d.name || "").toLowerCase();
              if (t.designator === "R?" && designator === "R?" &&
                  (dname.includes("µç") || dname.includes("é»") || dname.length <= 4)) return true;
              if (t.designator === "C?" && designator === "C?" &&
                  (dname.includes("µç") || dname.includes("å®¹") || dname.length <= 4)) return true;
              if (t.designator === "TP?" && dname === "test_pad") return true;
              return false;
            });
          }
          if (match) break;
        }
      }

      if (match) {
        // 获取完整器件信息
        const detail = await eda.lib_Device.get(match.uuid, libUuid);
        results[t.name] = {
          name: detail?.name || match.name,
          deviceUuid: match.uuid,
          symbolUuid: detail?.association?.symbolUuid || null,
          footprintUuid: detail?.association?.footprintUuid || null,
          designator: detail?.property?.designator || t.designator,
          type: t.type,
          description: detail?.description || "",
        };
      } else {
        results[t.name] = { error: "not_found", searched: t.name };
      }
    }

    return results;
  `;

  // 注意：这里中文作为 JS 字符串传给 EasyEDA，EasyEDA 内部处理无编码问题
  const detected = await execute(
    `return await (${detectionCode})(...[${JSON.stringify(libUuid)},${JSON.stringify(TARGETS)}]);`
  );

  // 4. 输出结果
  console.log('  [4/4] 生成配置...\n');

  const success = [];
  const failed = [];
  for (const t of TARGETS) {
    const r = detected[t.name];
    if (r && !r.error) {
      success.push(`  ✅ ${t.name.padEnd(10)} → ${r.deviceUuid}`);
    } else {
      failed.push(`  ❌ ${t.name.padEnd(10)} → 未找到（需手动创建通用符号后重试）`);
    }
  }
  console.log(success.join('\n'));
  if (failed.length) console.log(failed.join('\n'));

  if (failed.length === TARGETS.length) {
    console.log('\n⚠️  三个符号都没找到。请先在 EasyEDA 个人库创建通用符号：');
    console.log('   1. 打开 EasyEDA → 库 → 符号 → 新建');
    console.log('   2. 分别创建 "电阻"、"电容"、"TEST_PAD" 符号');
    console.log('   3. 把符号关联成器件（位号 R?/C?/TP?）');
    console.log('   4. 重新运行本脚本');
    process.exit(1);
  }

  // 写入配置
  const config = {
    description: "通用符号：电阻、电容、测试点。由 detect-common-symbols.mjs 自动生成。",
    generatedAt: new Date().toISOString(),
    libraryUuid: libUuid,
    symbols: {},
  };

  for (const t of TARGETS) {
    const r = detected[t.name];
    if (r && !r.error) {
      config.symbols[t.name] = r;
    }
  }

  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
  console.log(`\n📄 配置已写入: ${CONFIG_PATH}`);
  console.log(`   共 ${Object.keys(config.symbols).length} 个通用符号`);
}

main().catch(err => {
  console.error(`\n❌ 失败: ${err.message}`);
  console.error('   请确保:');
  console.error('   1. Bridge 已启动 (node bridge-server.mjs)');
  console.error('   2. EasyEDA 已连接');
  console.error('   3. 个人库中有电阻/电容/测试点器件');
  process.exit(1);
});
