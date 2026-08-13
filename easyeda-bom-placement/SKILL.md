---
name: easyeda-bom-placement
description: >-
  Read user-provided BOM (Excel), classify components, search EasyEDA library,
  and place matching components onto schematic. Components that can't be found
  are skipped and reported.
  Trigger on: "找器件", "BOM", "放置器件", "BOM放置", "导入BOM", "器件清单",
  "根据BOM", "原理图放置", "批量放置", "搜索器件", "放器件",
  "全放", "连位号".
Diode mode: "place" (default) or "skip" (just list in table, like polar caps).
Detect from user message: 不放置二极管/不放二极管 → skip; 放置二极管/默认 → place.
---

> 🔓 **自动提权模式**：进入此 Skill 后，settings.json 中的 permissions.allow 已覆盖所有 EasyEDA Bridge 调用、BOM 文件读取、临时文件读写等操作。整个流程（启动 Bridge → 轮询 EDA → 搜索 → 放置 → 输出汇总）**不会弹出确认框**。非 Skill 相关操作仍正常询问。权限由 auto mode 系统管理，Skill 结束后自动恢复。

## ⚠️ Windows Git Bash 兼容性（重要）

本 Skill 通过 Claude Code 的 Bash 工具执行命令。Windows 上 Bash 工具使用 **Git Bash**（不是 PowerShell），以下陷阱会导致脚本静默失败：

| 陷阱 | 错误示例 | 正确做法 |
|------|----------|----------|
| **`$变量` 被 bash 吃掉** | `node -e "console.log($var)"` → 空字符串 | 用 Write 工具写脚本文件，再 node 执行；或 base64 编码 |
| **heredoc 写 PS1** | `cat > file.ps1 << 'EOF' ... $excel ...` → `$excel` 变空 | ❌ 禁止 heredoc 写 PowerShell。用 Write 工具或 Node.js `fs.writeFileSync` |
| **`/tmp/` 路径** | `node -e "fs.writeFileSync('/tmp/x.json')` → `ENOENT: D:\tmp\` | 写项目目录 `D:/path/to/project/temp.json` |
| **PowerShell 执行策略** | `powershell -File x.ps1` → UnauthorizedAccess | 用 Node.js `execSync` + `-EncodedCommand` base64，或直接用 Node.js 替代脚本 |
| **Node 模板字符串 `\6`** | `` `D:\65-power\file` `` → octal escape 报错 | 路径用正斜杠或 `\\\\` 双转义 |
| **BOM 标黄** | exceljs 修改已有文件时 fill 全局传播 | ✅ 已替换为 `xlsx-populate`（原地改 XML，不传播，不重建文件） |

> 🔑 **核心原则**：所有需要 `$` 符号的脚本（PowerShell、模板字符串）一律通过 **Write 工具写文件** 或用 **Node.js `execSync` + base64** 执行，避免 bash 转义链断裂。
>
> 🔑 **临时文件**：统一写到项目目录或 `os.tmpdir()`，不要依赖 bash 的 `/tmp/`。
>
> 🔑 **BOM 标黄**：已从 PowerShell COM 迁移到 `xlsx-populate`。直接用 `node scripts/mark-yellow.mjs <port> <bom-path>`，原地改 fill，不重建文件。

# EasyEDA BOM 器件放置 Skill

根据用户提供的 BOM（Excel 文件），自动搜索 EasyEDA 库并放置器件到原理图。

## 前置步骤

### Step 0-1: 启动 EasyEDA Bridge

**Git Bash / Linux / macOS**（Claude Code 默认环境，✅ 推荐）：

```bash
# 检测 bridge 是否已运行
BRIDGE_PORT=$(node -e "
const http = require('http');
function check(p) { return new Promise(r => { const req = http.get('http://127.0.0.1:'+p+'/health', res => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>{ try { r(JSON.parse(d).service); } catch(e) { r(null); } }); }); req.on('error',()=>r(null)); req.setTimeout(2000,()=>{req.destroy();r(null)}); }); }
async function main() { for (let p=49620;p<=49629;p++) { if (await check(p)==='easyeda-bridge') { console.log(p); return; } } console.log('0'); }
main();
")
if [ "$BRIDGE_PORT" = "0" ]; then
  cd "$USERPROFILE/.claude/skills/easyeda-api-skill"
  node scripts/bridge-server.mjs &
  sleep 3
  BRIDGE_PORT=$(node -e "...同上检测逻辑...")
fi
echo "BRIDGE_PORT=$BRIDGE_PORT"
```

> 💡 上面的 bash 版不依赖 PowerShell，直接在 Git Bash 中运行。用 Node.js `http.get` 替代 `Invoke-RestMethod`，避免 `foreach` 语法不兼容。

**Windows (PowerShell)**（备用，仅限直接在 PowerShell 终端中执行）：

```powershell
# ⚠️ 用 Node.js fetch() 检测 bridge，Invoke-RestMethod 不可靠
$BRIDGE_PORT = $null
foreach ($port in 49620..49629) {
  $r = node -e "fetch('http://127.0.0.1:$port/health').then(r=>r.json()).then(j=>console.log(j.service)).catch(()=>{})" 2>$null
  if ($r -eq "easyeda-bridge") { $BRIDGE_PORT = $port; break }
}
# 没运行就启动
if (-not $BRIDGE_PORT) {
  Set-Location "$env:USERPROFILE\.claude\skills\easyeda-api-skill"
  Start-Process node -ArgumentList "scripts/bridge-server.mjs" -NoNewWindow
  Start-Sleep 3
  foreach ($port in 49620..49629) {
    $r = node -e "fetch('http://127.0.0.1:$port/health').then(r=>r.json()).then(j=>console.log(j.service)).catch(()=>{})" 2>$null
    if ($r -eq "easyeda-bridge") { $BRIDGE_PORT = $port; break }
  }
}
Write-Output "BRIDGE_PORT=$BRIDGE_PORT"
```

### Step 0-1b: 等待 EasyEDA 连接（自动轮询，不询问用户）⚠️ 强制执行

**🚨 铁律：启动 bridge 后必须自动轮询 EDA 连接，严禁停下來问用户！**

```powershell
# ⚠️ 用 Node.js fetch() 轮询，Invoke-RestMethod 不可靠
$connected = $false
for ($i = 0; $i -lt 20; $i++) {
  $status = node -e "fetch('http://127.0.0.1:$BRIDGE_PORT/health').then(r=>r.json()).then(j=>console.log(j.edaConnected)).catch(()=>{})" 2>$null
  if ($status -eq "true") { $connected = $true; break }
  Write-Output "WAITING_EDA ($($i+1)/20)"
  Start-Sleep 3
}
if (-not $connected) {
  Write-Output "EDA_NOT_CONNECTED"
}
```

> **关键原则**：
> - 启动 bridge 后立即进入轮询循环，不要问用户"连上了吗"
> - 50% 的情况下用户说"继续"时 EDA 已经连上了，只是 AI 没有自动重试
> - 连上后直接进入 Step 0-2（扫描工程），不要输出中间确认信息

### Step 0-2: 扫描工程，确定目标原理图

```javascript
// 代码必须使用 return await 语法，不能用 IIFE
return await eda.dmt_Project.getCurrentProjectInfo();
```

```javascript
// 获取当前文档信息
const doc = await eda.dmt_SelectControl.getCurrentDocumentInfo();
// documentType: 1 = SCHEMATIC_PAGE
return JSON.stringify({ docType: doc.documentType, pageUuid: doc.uuid, pageName: doc.name });
```

**选择逻辑**：
- 如果当前文档已是原理图页面 → 直接使用
- 如果只有 1 个原理图 → 打开其第一个页面
- 如果有多个原理图 → 列出让用户选择

**切换页面**：
```javascript
await eda.dmt_EditorControl.openDocument(pageUuid);
```

### Step 0-3: 确认 BOM 文件路径

向用户确认 BOM 文件路径。如果用户已在触发消息中提供，直接使用。

### Step 0-4: 读取标注文件（可选，但强烈推荐）

如果项目中有 `标注/` 目录（常见于工程文件夹），**主动询问用户是否有标注文件**。标注通常由工程师手动整理，包含三类关键信息：

#### 标注提供的信息及用途

| 信息类型 | 示例 | 用途 |
|----------|------|------|
| **器件类型描述** | `直插铝电解电容`、`定制CD287系列` | **覆盖**自动分类的极性/非极性判断 |
| **芯片/运放标识** | `四路比较器`、`LM339N` | **路由**到多部件放置流程 |
| **实际容值/耐压** | `DCH103M36...` → `10nF±20% 1kV` | 解析 `(类似)` 型号的确切参数 |
| **丝印信息** | `丝印1N4148`、`丝印18V` | 来料核对参考 |
| **datasheet 链接** | `http://www.takcheong.com/...` | 未找到器件时直接引用，不用再 WebSearch |
| **定制件说明** | `定制CD287直插铝电解` | 确认电容是标准件还是定制 |

#### 读取方式

标注可能以两种形式存在：

1. **文本文件**（推荐）：用户直接粘贴内容
2. **EasyEDA 二进制格式**（`标注.txt` 头部为 `6E 7E 5A 6D`）：无法解析，要求用户粘贴内容

```powershell
# 检测标注目录是否存在
$annoDir = "D:\...\标注"
if (Test-Path $annoDir) {
  Get-ChildItem $annoDir
}
# 如果标注.txt 头部是 6E 7E 5A 6D → EasyEDA 加密格式 → 让用户手动粘贴
```

#### 标注与自动判断的优先级

```
标注明确说了类型 → 以标注为准（覆盖自动判断）
标注没提到       → 用常识判断规则
自动判断不确定   → 标注也没提 → 归入"待确认"
```

> ⚠️ **重要**：标注是工程师手动整理的，比自动判断更可靠。如果标注说"直插铝电解电容"，即使规格看起来像瓷片型号，也以标注为准。

---

## 核心原则

1. **只放完全一致的** — 名称必须完全一致才放置
2. **搜不到或名称不一致就跳过** — 报给用户
3. **普通阻容/电感/测试点用通用符号** — 电阻/非极性电容/普通电感/测试点不搜索，读 `common-symbols.json` 直接批量放置。极性电容/共模电感/晶振/LED 排除或走搜索。**NC 特殊处理**：R/C 前缀 + 规格=NC → 正常放通用符号（电阻/电容）；其他前缀 + 规格=NC → 排除不放置。
4. **异常阻容感排除+告警** — 位号是 C/R/L 但规格不是标准数值的，排除并提醒用户
5. **不要停下来问用户** — 分类完直接搜，搜完直接放，放完输出汇总表。不要中间确认。

---

## 二极管放置开关

Skill 支持两种二极管处理方式，从用户消息中自动检测：

### 放置模式（默认）— `place`

**触发词**：`放置二极管` / 不指定（默认）

二极管正常进入搜索 → 放置流程，直接放到原理图上。

### 不放置模式 — `skip`

**触发词**：`不放置二极管` / `不放二极管`

二极管**不搜索、不放置**，仅在汇总时输出一张 🔴 二极管表，列明位号/规格/封装/数量，由用户手动用通用二极管符号放置。处理方式与极性电容一致。

### 检测逻辑

1. 用户消息中包含 `不放置二极管` / `不放二极管` → **不放置模式**
2. 都不含 → **默认放置模式**

---

## 流程

### Step 1: 读取 BOM

读取用户提供的 Excel BOM 文件（.xlsx），**优先使用官方脚本 `scripts/read-bom.mjs`**（UTF-8 原生支持，中文不乱码，自动从 skill 目录解析 `xlsx` 依赖，不受调用方 cwd 影响）：

```bash
# ✅ 推荐：官方脚本（在 skill 目录内运行，自动解析 node_modules）
cd "$USERPROFILE/.claude/skills/easyeda-bom-placement"
node scripts/read-bom.mjs "<BOM路径>"        # 默认紧凑表格行（token 友好）
node scripts/read-bom.mjs "<BOM路径>" --json  # JSON 数组（机器可读）
node scripts/read-bom.mjs "<BOM路径>" --sheet 1  # 选第二个工作表
```

> ⚠️ **为什么不用 `node -e "require('xlsx')"`**：`xlsx` 模块装在 skill 目录的 node_modules 里，从项目目录跑 `node -e` 会 `MODULE_NOT_FOUND`。脚本放在 `scripts/` 内，Node 会向上找到本 skill 的 node_modules。ESM 脚本同理：自定义 `.mjs` 必须放 skill 目录内（或 `import` 绝对路径）。

PowerShell COM 对象作为备用（中文可能乱码）：

```powershell
$excel = New-Object -ComObject Excel.Application
$excel.Visible = $false
$wb = $excel.Workbooks.Open("文件路径")
$ws = $wb.Worksheets(1)
# 读取所有行...
$wb.Close($false)
$excel.Quit()
```

```powershell
# 备用：PowerShell COM 对象（中文可能乱码）
$excel = New-Object -ComObject Excel.Application
...
```

```powershell
$excel = New-Object -ComObject Excel.Application
$excel.Visible = $false
$wb = $excel.Workbooks.Open("文件路径")
$ws = $wb.Worksheets(1)
# 读取所有行...
$wb.Close($false)
$excel.Quit()
```

BOM 格式示例：
```
位号            | 规格              | 封装      | 数量
C1, C2, C3      | 6.8uF±10% 10V     | C0805     | 3
U1              | STM32F405RGT6     | LQFP-64   | 1
```

> 📊 **Token 优化**：读取 BOM 后分类，在汇总输出中只列出**进入搜索的行**和**告警行**。通用符号（电阻/非极性电容/测试点，含 NC 阻容）和晶振/LED/非阻容 NC 等排除行只报统计数字，不逐行展开。

#### BOM 数据清洗（重要！）

读取后自动修复以下常见问题：

| 问题 | 示例 | 修复 |
|------|------|------|
| 位号末尾多余逗号 | `C7, C8, C9, C10,` | 去掉末尾逗号 |
| 规格末尾 `\|` 截断标记 | `LP5907MFX-3.3/NOP\|` | 尝试补全：`NOP\|` → `NOPB`（TI 包装后缀） |
| 规格末尾 `.` 截断 | `TYPE-C 14P LTH10.` | 尝试补全：`LTH10.` → `LTH10.0`（尾部数字被截） |
| 拼写错误 | `WAFFER` → `WAFER` | 自动修正常见拼写 |
| 规格内多余空格 | `SRV05-4. TCT` | 去掉 `.` 后多余空格 → `SRV05-4.TCT` |

**截断修复规则（按优先级尝试）：**

| 截断模式 | 补全尝试 | 实战验证 |
|----------|----------|----------|
| `NOP\|` | → `NOPB` | ✅ `LP5907MFX-3.3/NOPB` |
| `LTH10.` | → `LTH10.0` | ✅ `TYPE-C 14P LTH10.0` |
| `R011` 后缀不匹配 | → `R0` | ⚠️ `CSTCE8M00G52-R0`（近似，不放置） |

### Step 2: 分类识别（三重验证）

**🚀 官方分类器 `scripts/classify.mjs`（推荐）**：直接读 BOM，按下面的规则自动分类，输出 `common-items.json` / `searched-items.json` / `summary.json`，并打印可直接传给 `/search-batch` 的规格清单：

```bash
cd "$USERPROFILE/.claude/skills/easyeda-bom-placement"
node scripts/classify.mjs "<BOM路径>" --out <输出目录>
# 输出目录默认 <BOM同目录>/bom-placement-out/
```

- `common-items.json` → 直接喂给 `place-common.mjs`（Step 2.6）
- `searched-items.json` → 先核对搜索结果里的近似匹配（如 EX2EDG 只有 VC 变体），剔除后再喂给 `place-searched.mjs`（Step 4）
- `summary.json` → 排除表（极性电容/LED/NC/定制）、异常告警、逐行分类明细

> AI 手写分类时仍按下述规则；`classify.mjs` 与这些规则一致（含 NC 阻容判断、极性电容判断表、`(类似)` 型号提取、异常阻容感告警）。

对每一行，用**位号前缀 → 规格单位 → 封装**三重信号交叉判断：

#### 分类规则

##### 🟢 通用符号放置（不搜索，直接放）

这些器件用 [common-symbols.json](./common-symbols.json) 中的通用符号直接放置：

| 类型 | 位号 | 识别信号 | 符号 | ΔX | ΔY |
|------|------|----------|------|:--:|:--:|
| 普通电阻 | R | 含 Ω/kΩ/MΩ 单位，**或规格="NC"** | 电阻 `R?` | **50** | 45 |
| 非极性电容 | C | 含 pF/nF 单位，或瓷片/薄膜型号（C242/C241/CC4/CK45/DCC/DCS/DCH...），**或规格="NC"** | 电容 `C?` | **40** | 45 |
| 普通电感 | L | 含 nH/uH/mH/H 单位 | 电感 `L?` | **40** | 45 |
| 测试点 | 任意 | 位号前缀 `TP`（可靠信号）；规格明确写"测试点"/TEST 作备用。**规格/封装含 TP 子串不算**（TPS54331/TP4056 等型号会误判） | TEST_PAD `TP?` | **50** | 45 |

> 🔑 放置时从 `common-symbols.json` 读 UUID，不同间距换行，行宽上限 2500。具体逻辑见 [Step 2.6](#step-26-通用符号批量放置)。

##### 🔴 排除（不搜索，手动处理）

| 类型 | 位号 | 识别信号 | 处理 |
|------|------|----------|------|
| 极性/电解电容 | C | 电解型号前缀（ECR/EGD/EGW/EGX），或圆柱封装（D*x*L*MM）+ uF 级容值，或 uF 级容值 + 封装判断表判为极性（见下方详表） | 不放置，列极性电容表（需电解符号） |
| 二极管（不放置模式） | D | 任意 | 仅当 diodeMode=`skip` 时排除 |
| 晶振 | Y | 含 MHz/kHz | 不放置，统计数量 |
| LED | LED | 含"发光"/"LED" | 不放置，统计数量 |
| 安装孔 | 任意 | 规格=`H`/`H1`/`H 3.2`/`H 3.2MM`/`H孔`/`安装孔`（H 在**前面**）；`1H`/`10H`（数字在前）是真电感，归通用电感 | 不放置，统计数量 |
| NC（非阻容） | 非 R/C 前缀 | 规格="NC" | 不放置，统计数量 |

> 🔑 **NC 阻容正常放置**：当位号前缀为 R 且规格="NC" → 放入通用电阻符号队列，正常放置。当位号前缀为 C 且规格="NC" → 放入通用电容符号队列（先检查是否为极性电容的其它信号，NC 无容值单位默认为非极性），正常放置。只有非 R/C 前缀的 NC 才排除。

##### 其余 → 进入搜索

不满足上述任何规则的行，进入 Step 3 搜索。

**冲突处理**：如 L7 位号但规格是 ESD 二极管型号 → 正常搜索，不适用通用符号。

#### 极性电容 vs 非极性电容（常识判断）⚠️ 重要

排除电容时不搜索 EDA，但**必须按常识分开极性/非极性**，因为用户放通用符号时符号不同。判断规则（按优先级）：

| 优先级 | 信号 | 判断 | 示例 |
|--------|------|------|------|
| 1 | 型号前缀 `C242`/`C241`/`C317`/`CC4`/`CC81`/`CK45`/`DCC`/`DCS`/`DCH`/`N13`/`S10`/`C322`/`DCM` | 🟢 非极性（薄膜/瓷片/MLCC） | `C242A104J2SA201`、`DCC101J20SL F6FJ5A0` |
| 2 | 规格含 `pF`/`nF` 单位 | 🟢 非极性（瓷片/薄膜） | `100nF±10%`、`50pF±10% 50V` |
| 3 | 规格前缀 `ECR`/`EGD`/`EGW`/`EGX`/`EKY`/`EEU` | 🔴 极性（铝电解） | `ECR1HGK100MFA050011` |
| 4 | 封装 `D*x*L*MM`（圆柱形）+ 容值 ≥1uF | 🔴 极性（电解） | `DIP,D5XL11.5MM` + `2.2uF` |
| 5 | uF 级容值 → **必须结合封装判断**（见下方 uF 级判断表） | 见下表 | — |
| 6 | 无法判断 | 🟡 默认非极性，标注"待确认" | — |

##### uF 级容值判断表（优先级 5 展开）⚠️ 关键

> 🚨 **不是所有 uF 就是极性！** 现代 MLCC 陶瓷电容已能量产 10uF/22uF/47uF，甚至 100uF 的 1206/1210 封装。必须结合封装判断。

| 封装类型 | 容值范围 | 判断 | 原因 |
|----------|----------|:--:|------|
| SMD 小封装（`0402`/`0603`/`0805`/`1206`/`1210`） | ≤100uF | 🟢 非极性 | 现代 MLCC 可做到，不可能是电解 |
| SMD 小封装（`0402`/`0603`/`0805`/`1206`/`1210`） | >100uF | 🟡 待确认 | 可能钽电容/大容量 MLCC |
| SMD 中封装（`1812`/`2220`） | ≤47uF | 🟢 非极性 | MLCC 范围 |
| SMD 中封装（`1812`/`2220`） | >47uF | 🟡 待确认 | 可能钽电容 |
| 钽电容封装（`A`/`B`/`C`/`D`/`E` case 或 `SMD-TAN`） | 任意 uF | 🔴 极性 | 钽电容有极性 |
| 圆柱形（`D*x*L*MM`） | ≥1uF | 🔴 极性 | 铝电解电容标准封装（已在优先级 4 命中） |
| 径向直插（`P=*MM`） | ≥100uF | 🔴 极性 | 大容量直插 → 铝电解 |
| 径向直插（`P=*MM`） | <100uF | 🟡 待确认 | 可能薄膜电容或小电解 |
| 封装未知 | ≥100uF | 🔴 极性 | 大容量大概率电解 |
| 封装未知 | 10uF~99uF | 🟡 待确认 | 无法确定，需人工判断 |
| 封装未知 | <10uF | 🟢 非极性 | MLCC 更常见 |

> **关键点**：
> 1. **封装优先**：SMD 小封装 → 非极性，圆柱大封装 → 极性
> 2. **`uF` 不是极性代名词**：`10uF 0805` = 非极性 MLCC，`10uF D5XL11.5MM` = 极性电解
> 3. 封装来源：BOM 的"封装"列 → 如果有 DIP 前缀（如 `DIP,D5XL11.5MM`）取逗号后面的尺寸判断；如果是纯 SMD 封装名（如 `C0805`、`0805`）按 SMD 规则判断

#### 异常阻容感告警

位号前缀是 C/R，但规格不符合上述标准模式 → **搜索型号识别类型 → 不放置，记录到告警表**。

这些器件的符号就是普通阻容感，用通用符号即可。关键是帮用户查清它**具体是什么**（而不是瞎猜）。

**处理流程**：
1. 搜索型号（同 Step 3）
2. 搜到了 → 不放置，告警表标注"已查到：XXX 器件，用通用符号"
3. 搜不到 → 直接归入"未找到"表

诊断线索：
- C 前缀 + 无容值单位 → 可能钽电容/极性电容/超级电容
- R 前缀 + 无阻值单位 → 可能排阻/热敏电阻/压敏电阻/电流检测电阻
- L 前缀 → 正常进入搜索（电感不再排除）

#### 芯片/运放识别（标注优先）

标注中已标明类型的（如"四路比较器""运放""MCU"等）→ 直接标记为芯片/运放。
未标明的 → 从规格文字推断（非 R/C/L/Y/LED 且非定制 → 按芯片处理）。

芯片/运放类器件在放置前需做**多部件检测**（见 Step 4）。

### Step 2.5: 预过滤（不可搜索型号直接跳过）+ 型号提取

进入搜索前，先筛查规格字段：

#### ❌ 直接跳过（无型号可提取，归入"未找到"）

| 模式 | 示例 | 原因 |
|------|------|------|
| `定制XXX` | `DJI定制T40平衡接口`、`定制共模滤波器` | 定制件，无通用型号 |
| `打磨丝印` | `打磨丝印(待确认)` | 芯片打磨，无型号 |
| `待确认`（且无其他型号信息） | — | 完全无法识别 |

#### 🔍 丝印反查（不跳过，走 WebSearch）

| 模式 | 示例 | 处理 |
|------|------|------|
| `丝印XXX` | `丝印2Z03` | 不跳过，用 `WebSearch(query="SMD marking "XXX" 封装 datasheet")` 反查 |

丝印不进入 EasyEDA 搜索（库里不会用丝印建索引），直接在 Step 5 汇总时调用 WebSearch 反查。查到了给出型号和 datasheet 链接，查不到标注"丝印 XXX 查不到型号"。

#### ✅ 提取型号后照常搜索

如果规格包含 `(类似)`、`(可能是)`、`(待确认)` 等括号标注，**不要跳过**，去掉标注提取前面的型号照常进入搜索：

| 规格原文 | 提取后搜索关键词 |
|----------|-------------------|
| `JBLH2470M100E125RLM 47UF 100V(类似)` | → `JBLH2470M100E125RLM` |
| `CCH4F(可能是)` | → `CCH4F` |
| `10kΩ±1% NTC热敏电阻(可能是)` | → `10kΩ±1% NTC热敏电阻`（但仍会被分类规则排除，因为 R 前缀 + Ω 单位） |

**提取规则**：去掉规格末尾的 `(类似)`、`(可能是)`、`(待确认)` 等括号标注，取前面部分作为搜索关键词。如果去掉后只剩空格或空字符串，则按"直接跳过"处理。

> 🔧 **标注优先**：如果用户提供了标注文件（Step 0-4），标注中通常会写明这些 `(类似)` 型号的**确切容值、耐压、类型**（如 `DCH103M36Y5VN6WL7A0(类似) → 直插瓷片电容 10nF±20% 1kV`）。分类时优先用标注中的类型描述，而不是从型号猜测。

### Step 2.6: 通用符号批量放置

普通电阻、非极性电容、测试点不搜索 EDA，而是读 `common-symbols.json` 用固化 UUID 直接放置。

**🚨 必须使用 `scripts/place-common.mjs`，禁止手写临时放置脚本！**

```powershell
# 1. 生成 items JSON（所有器件一次性列出，按 电阻→电容→电感→测试点 排序）
#    格式: [{"d":"R1","t":"resistor"}, {"d":"C1","t":"capacitor"}, {"d":"L1","t":"inductor"}, {"d":"TP1","t":"testpad"}]

# 2. 调用官方脚本
Set-Location "$env:USERPROFILE\.claude\skills\easyeda-bom-placement"
node scripts/place-common.mjs <bridge-port> <items-file.json>
```

> `place-common.mjs` 将所有坐标在放置前**一次性预计算完成**，再按 20 个/批执行。**不会出现手写脚本常见的"每批从起点重新开始导致重叠"的 bug**。下面展示的是脚本内部的坐标计算逻辑（仅供参考，不要照着写临时脚本）。

#### 间距规则

| 符号 | 同行 ΔX | 行间 ΔY | 起点 | 列数 |
|------|:------:|:------:|------|:------:|
| 电阻 `R?` | 50 | 45 | (960, 3250) | 20 |
| 电容 `C?` | 40 | 45 | (100, 3250) | 20 |
| 电感 `L?` | 40 | 45 | (3100, 3250) | 20 |
| 测试点 `TP?` | 50 | 45 | (2030, 3260) | 20 |

> 注意：EasyEDA 原理图 Y 轴向上增大，电容行从上往下（Y 递减 45/行）。

#### 放置代码（仅供参考，理解坐标计算逻辑）

```javascript
// 读配置
const CFG = { /* common-symbols.json 内容 */ };
const LIB = CFG.libraryUuid;
const SYM = {
  resistor: CFG.symbols.resistor.deviceUuid,
  capacitor: CFG.symbols.capacitor.deviceUuid,
  testpad: CFG.symbols.testpad.deviceUuid,
};
const STARTS = CFG.placement.starts;   // {resistor:{x,dx}, capacitor:{x,dx}, testpad:{x,dx}}
const DY = CFG.placement.dy;           // 45
const COLS = CFG.placement.cols;       // 20

// 把待放器件按符号类型分组，同类型连续排列
let x = 0, y = 0, col = 0;

for (const item of genericItems) {  // [{designator, symbolKey: "resistor"|"capacitor"|"testpad"}, ...]
  const start = STARTS[item.symbolKey];
  if (col === 0) { x = start.x; y = start.y; }
  if (col >= COLS) { x = start.x; y -= DY; col = 0; }
  
  const comp = await eda.sch_PrimitiveComponent.create(
    {libraryUuid: LIB, uuid: SYM[item.symbolKey]}, x, y, "", 0, false, true, true
  );
  await eda.sch_PrimitiveComponent.modify(comp, {designator: item.designator});
  
  x += start.dx;
  col++;
}
```

#### 放置顺序

按符号类型分组放置，同类型器件排完再换下一类：
1. 先放所有电阻（R 开头位号）
2. 再放所有非极性电容（C 开头位号，非极性）
3. 再放所有普通电感（L 开头位号，含 nH/uH/mH/H 单位）
4. 最后放所有测试点（TP/TEST）

每类之间自动换行（不满一行也换，视觉分隔）。

> ⚡ **并行优化**：通用符号放置和第一步搜索可以并行执行。`place-common.mjs` 运行期间，同时调用 `/search-batch` 搜索所有待搜规格。两个任务都完成后，再生成 items JSON 调用 `place-searched.mjs`。

### Step 3: 搜索器件

**✅ 优先使用 `/search-batch` 批量搜索（一次 EDA 调用搜完所有规格）：**

```powershell
# ✅ 推荐：批量搜索，一次传入所有 keyword
$keywords = @("STM32F405RGT6", "LM324DT", "BAV99,215", ...)
$body = @{ keywords = $keywords; exact = $true } | ConvertTo-Json -Compress
$r = Invoke-RestMethod -Uri "http://localhost:$BRIDGE_PORT/search-batch" -Method Post -Body $body -ContentType "application/json" -TimeoutSec 60
# 返回: { success: true, result: { "STM32F405RGT6": [{n,f,u}], "LM324DT": [{n,f,u}], ... } }
# 每个 keyword 的结果单独 key，精确匹配已在服务端过滤
```

> ⚠️ **search-batch 已服务端切块**（每块 4 个关键词，各自独立 EDA 执行，规避 30s 单次请求硬超时）。实测 10 个关键词 ~25s 完成。**关键词越多越接近 30s 上限**：>12 个建议分两次调用，或改用逐条 `/search` 并发。若返回 `timed out after 30000ms`，说明关键词过多，拆小再发。

> ✅ **for...of + await 搜索循环已实测可用**（每轮返回不同结果，旧版"全部相同"bug 未复现）。如再遇异常，退回逐条 `/search`。

**单搜备用（keyword 数量 ≤3 时使用）：**

```powershell
$body = @{ keyword = "STM32F405RGT6"; exact = $true } | ConvertTo-Json -Compress
$r = Invoke-RestMethod -Uri "http://localhost:$BRIDGE_PORT/search" -Method Post -Body $body -ContentType "application/json" -TimeoutSec 30
```

搜索关键词使用 BOM 的**规格列**（去除多余空格）。

**返回字段**：
- `n`: 器件名称 (name)
- `f`: 封装名称 (footprintName)  
- `u`: 器件 UUID（放置时用来查找完整对象）

#### 🚨 搜索代码规范

```powershell
# ✅ 正确：每个器件独立调用 /search
$body = @{ keyword = "STM32F405RGT6" } | ConvertTo-Json -Compress
$r = Invoke-RestMethod -Uri "http://localhost:$BRIDGE_PORT/search" -Method Post -Body $body ...

# ❌ 致命错误：在单个 /execute 调用中使用 for...of 循环搜索
# 原因：EasyEDA 执行环境对循环内 await 有 bug，每次迭代得到的数据一样
# 对策：每个器件必须用独立的 PowerShell 调用 /search 端点

#### 匹配规则

```
名称完全一致           → ✅ 放置（裸名）
名称 = spec + "_*"     → ✅ 精确匹配（仅运放/芯片，多部件优先）
名称不完全一致，无后缀 → ❌ 近似匹配，不放置
搜不到                  → ❌ 跳过
```

> ⚠️ 搜索策略：
> 1. 先用原始规格搜
> 2. 搜不到 → 尝试修正截断/拼写后重搜
> 3. 用 `sr.find(s => s.name === spec)` 在所有结果中找精确匹配，**不能只检查 `sr[0]`**
> 4. **`_*` 后缀匹配（仅运放/芯片）**：`LM339N_C3658785` 也是 `LM339N` 的精确匹配。优先选带后缀的多部件版本（裸名版本可能是单部件或不同符号）。其他器件（电阻、电容、连接器等）不适用此规则，必须裸名匹配。
> 5. 近似匹配不放置，只记录

正确做法：
```javascript
const sr = await eda.lib_Device.search(spec);
const exact = sr.find(s => s.name === spec);  // 在所有结果中找精确匹配

// 仅运放/芯片：裸名优先，_* 后缀也算精确匹配，多部件优先
const bareMatch = sr.find(s => s.name === spec);
const suffixMatch = sr.find(s => s.name.startsWith(spec + "_"));  // 仅运放/芯片
const best = bareMatch || suffixMatch;

if (best) {
  await placeComponent(best, x, y, designator);  // 见 Step 4
}
```

### Step 4: 放置器件（不询问用户，直接放）

#### 多部件器件放置（芯片/运放）⚠️

**🚨 铁律：必须逐个器件实测 `.2` 后缀，不能根据型号类别猜测！**

> 同是双运放，结果可能不同：OPA2365AIDR `.2` 被保留（多部件 ✅），OPA1678IDR `.2` 被纠正为 `.1`（单部件 ❌）。不能因为都是 dual op-amp 就假设一样。

**已知多部件型号清单**（命中直接走多部件流程，跳过检测，节省 ~5s/器件）：

| 型号前缀 | 部件数 | 类型 |
|----------|:-----:|------|
| `LM324` | 4 | 四运放 |
| `LM339` | 4 | 四比较器 |
| `LM358` | 2 | 双运放 |
| `LM393` | 2 | 双比较器 |
| `TL074` | 4 | 四运放 |
| `TL072` | 2 | 双运放 |
| `TL082` | 2 | 双运放 |
| `NE5532` | 2 | 双运放 |
| `LM2904` | 2 | 双运放 |
| `LM2902` | 4 | 四运放 |

**检测超时**：`.2` 后缀检测设 **5 秒硬超时**。超时 → 默认当单部件放置，汇总表标注 `⚠️ 多部件未确认`。

检测前先查清单：型号匹配已知多部件 → 直接走多部件循环；不匹配 → 实测 `.2` 后缀。

放置前先检测是否为多部件：

```javascript
// 1. 检测：试放 Part 2，查 EDA 是否保留 .2 后缀
const test = await eda.sch_PrimitiveComponent.create(device, 0, 0, deviceName + ".2", 0, false, true, true);
const all = await eda.sch_PrimitiveComponent.getAll();
const actual = all[all.length - 1].subPartName;
const isMulti = actual.endsWith(".2");
await eda.sch_PrimitiveComponent.delete(test);
```

- **单部件**（`.2` 被纠正为 `.1`）→ 走 `batch-place.mjs` 快车道
- **多部件**（`.2` 被保留）→ 走以下循环：

```javascript
// 2. 循环放置所有子件
let partNum = 1;
while (true) {
  const subPartName = deviceName + "." + partNum;
  const comp = await eda.sch_PrimitiveComponent.create(device, x, y, subPartName, 0, false, true, true);
  const recheck = await eda.sch_PrimitiveComponent.getAll();
  if (!recheck[recheck.length - 1].subPartName.endsWith("." + partNum)) {
    await eda.sch_PrimitiveComponent.delete(comp);  // 绕回，删掉
    break;
  }
  await eda.sch_PrimitiveComponent.modify(comp, {designator: designator});
  partNum++;
}
```

> **关键点**：
> - subPartName 必须传完整格式：`"LM339N_C3658785.1"`
> - 位号用 `modify()`，不要手动加 `.N` 后缀
> - 单部件器件检测开销 ~1 次 create，不影响速度

#### 自适应间距（⚠️ 重要）

**不要用固定 250×250 网格**。根据每个器件的封装名估算符号宽度，密排小器件、拉开大器件。

**间距决定顺序**：先看位号类型，再看封装名。类型规则优先级更高。

**类型优先规则**（基于位号前缀，命中后直接使用，不走封装表）：

| 位号前缀 | 器件类型 | 行内间距 DX |
|----------|----------|:----------:|
| `D` / `ZD` | 二极管、稳压管 | **50** |
| `Q` | MOS 管、三极管 | **120** |
| `R`（进入放置流程的） | 热敏电阻、压敏电阻、电位器等特殊电阻 | **50** |

**符号宽度估算表**（从 `footprintName` 匹配，未命中类型规则时使用，单位 0.01inch）：

| 封装模式 | 估算宽度 | 行内间距 DX | 行间距 DY |
|----------|---------|------------|----------|
| `DO-35` / `SOD-123` / `SOD-323` | 80 | 120 | 150 |
| `DO-41` / `DO-15` / `DO-201AD` / `DO-204AL` | 120 | 160 | 180 |
| `SMA` / `SMB` / `SMC` | 100 | 140 | 160 |
| `TO-92` | 100 | 140 | 200 |
| `TO-220` / `TO-220-3L` | 180 | 220 | 250 |
| `DIP-4` | 120 | 160 | 160 |
| `DIP-8` / `DIP-8P` / `DIP-14` / `DIP-14P` / `PDIP-14` | 200 | 250 | 250 |
| `DIP-16` / `PDIP-16` / `DIP-20` | 250 | 250 | 250 |
| `SIP-12` | 250 | 250 | 200 |
| `CONN-TH_2P` / `HDR-TH_2P` | 120 | 160 | 180 |
| `CONN-TH_3P` ~ `5P` | 200 | 250 | 200 |
| `IDC-TH_26P` / 牛角座 | 250 | 250 | 250 |
| `DSUB-TH` / VGA | 250 | 250 | 250 |
| `DB` / 整流桥（`DFM`） | 250 | 250 | 250 |
| `MODE-TH`（如 QC962） | 250 | 250 | 200 |
| `RES-ADJ-TH` / 电位器（3296） | 200 | 250 | 250 |
| `RES-TH`（热敏电阻等） | 150 | 200 | 200 |
| `HC-49S` / 晶振 | 200 | 250 | 200 |
| 其他 / 未知 | 200 | 250 | 250 |

> 🔑 **大器件 DX/DY 封顶 250**。小器件（DO-35、TO-92、DIP-4 等）可以更密，节省空间。所有 >250 的估算值一律砍到 250。

**换行逻辑**：

```
行宽上限 = 2500 (10 个 DIP-8 的宽度)
当前行累计宽度 + 本器件估算宽度 > 行宽上限 → 换行
换行后取本行最大 DY 作为行间距
```

**同型号分组间距**（⚠️ 重要）：

```
同一型号（spec 相同）的器件 → 紧密排列（正常 DX）
相邻两个不同型号之间      → 额外加 100 间距（视觉分组）
```

> 为什么：二极管 DX=50 很密，HS1O 型号 3 个和 BAT54S 型号 2 个如果全挤在一起很难区分数了几颗。加分组间距后一眼看出型号边界。

#### 自适应间距放置（使用 place-searched.mjs）⚠️ 强制

**🚨 必须使用 `scripts/place-searched.mjs`，禁止手写临时放置脚本！**

```powershell
# 1. 搜索完成后，生成 items JSON（带 footprint 信息）
#    格式: [{"spec":"BAV99,215","d":"D2","fp":"SOT-23"}, ...]

# 2. 调用官方脚本
Set-Location "$env:USERPROFILE\.claude\skills\easyeda-bom-placement"
node scripts/place-searched.mjs <bridge-port> <items-file.json>
```

> `place-searched.mjs` 将所有坐标在放置前**一次性预计算完成**，内部处理自适应间距、封装→DX/DY 映射、分组间距、换行，按 20 个/批执行。NOT_FOUND 自动跳过不占格子。下面展示的是脚本内部的间距计算逻辑（仅供参考）。

#### 自适应间距放置脚本（仅供参考）
$items = @(
  @{spec="DB207"; d="BD1"; fp="DB"},
  @{spec="1N4148"; d="D2"; fp="DO-35"},
  @{spec="AT89C2051-24PU"; d="U1"; fp="DIP-20"}
)

# 封装 → 宽度/DX/DY 映射
function Get-SymbolSize($fp) {
  if ($fp -match "DO-35|SOD-123|SOD-323") { return @{w=80; dx=120; dy=150} }
  if ($fp -match "DO-41|DO-15|DO-201AD|DO-204AL") { return @{w=120; dx=160; dy=180} }
  if ($fp -match "SMA|SMB|SMC") { return @{w=100; dx=140; dy=160} }
  if ($fp -match "TO-92") { return @{w=100; dx=140; dy=200} }
  if ($fp -match "TO-220") { return @{w=180; dx=220; dy=250} }
  if ($fp -match "DIP-4[^0-9]|DIP-4$") { return @{w=120; dx=160; dy=160} }
  if ($fp -match "CONN-TH_2P|HDR-TH_2P") { return @{w=120; dx=160; dy=180} }
  if ($fp -match "RES-TH") { return @{w=150; dx=200; dy=200} }
  # 其余一律 250 封顶
  return @{w=200; dx=250; dy=250}
}

$ROW_MAX = 2500; $X0 = 100; $Y0 = 100; $GROUP_GAP = 100
$x = $X0; $y = $Y0; $rowMaxDy = 0; $prevSpec = $null

for ($i = 0; $i -lt $items.Count; $i++) {
  $size = Get-SymbolSize $items[$i].fp
  # 类型优先规则：根据位号前缀覆盖 DX（优先级高于封装匹配）
  if ($items[$i].d -match "^D")       { $size.dx = 50  }   # 二极管
  elseif ($items[$i].d -match "^Q")   { $size.dx = 120 }   # MOS 管 / 三极管
  elseif ($items[$i].d -match "^R")   { $size.dx = 50  }   # 特殊电阻（进入放置流程的都不是普通电阻）
  # 同型号分组间距：型号变了加额外间距
  if ($prevSpec -and $items[$i].spec -ne $prevSpec) {
    $x += $GROUP_GAP
  }
  if ($x + $size.w - $X0 -gt $ROW_MAX) {
    $x = $X0; $y += $rowMaxDy; $rowMaxDy = 0
  }
  $body = @{ spec = $items[$i].spec; x = $x; y = $y; designator = $items[$i].d } | ConvertTo-Json -Compress
  $r = Invoke-RestMethod -Uri "http://localhost:$BRIDGE_PORT/place" -Method Post -Body $body -ContentType "application/json" -TimeoutSec 30
  $x += $size.dx
  if ($size.dy -gt $rowMaxDy) { $rowMaxDy = $size.dy }
  $prevSpec = $items[$i].spec
}
```

> 📐 **封装来源优先级**：`/search` 返回的 `f` > BOM 的封装列 > 默认估算。

#### 🚨 Y 轴方向（关键！）

> **EasyEDA 原理图 Y 轴：值越大 = 越靠页面顶部。** 与屏幕坐标相反。

#### 🚨 搜索器件起始坐标：必须在通用符号下方

通用符号 `place-common.mjs` 占用区域约 `y ∈ [2890, 3260]`。搜索器件必须放在更低 Y（页面更下方），**不能硬编码**——不同 BOM 通用符号行数不同。

```javascript
// ✅ 正确：通用符号放完后动态计算 Y 起点
const all = await eda.sch_PrimitiveComponent.getAll();
const commonYs = all
  .filter(c => /^(R|C|TP)/.test(c.designator || ''))
  .filter(c => c.x !== 0 || c.y !== 0)   // 排除原点噪声
  .map(c => c.y);
const commonMinY = Math.min(...commonYs);  // 通用符号最低行
const GAP = 200;                           // 间隙 2 英寸
const Y_START = commonMinY - GAP;          // 第一行紧贴通用符号下方
const Y_STEP = -120;                       // ⚠️ 负数！每行往下走
const X_START = 100, X_STEP = 300, PER_ROW = 8;

// ❌ Y_STEP 为正 → 越放越往上，撞进通用符号区
// ❌ 硬编码 Y_START → 换 BOM 就炸
// ❌ 不过滤前缀 → 之前失败的搜索器件会污染计算
```

#### 🚨 放置前删重（铁律）

`/place` 总是创建新器件，不会更新已有位置。不删重会导致同一 designator 出现多个实例。

```javascript
// 放置前：查询并删除同 designator 的已有器件
const all = await eda.sch_PrimitiveComponent.getAll();
const toDel = all.filter(c => TARGET_DESIGNATORS.includes(c.designator));
for (const c of toDel) await eda.sch_PrimitiveComponent.delete(c);
```

#### 🚨 NOT_FOUND 不能占格子

NOT_FOUND 的器件不消耗坐标位置，下一个器件紧接填入。

```javascript
// ✅ 正确：gridIdx 只在实际放置成功时前进
let gridIdx = 0;
for (const {d, spec} of items) {
  const col = gridIdx % PER_ROW, row = Math.floor(gridIdx / PER_ROW);
  const x = X_START + col * X_STEP, y = Y_START + row * Y_STEP;
  const j = await place(spec, x, y, d);
  if (j.success && !j.result.startsWith('NOT_FOUND')) {
    gridIdx++;  // 成功了才推进
  }
  // NOT_FOUND → gridIdx 不动，下一个复用此坐标
}

// ❌ 错误：用 for 循环的 i 算坐标 → NOT_FOUND 留下空洞，整行歪掉
```

**常用 API**：

| API | 用途 |
|-----|------|
| `eda.sch_PrimitiveComponent.getAll()` | 获取所有器件（含 x, y, designator） |
| `eda.sch_PrimitiveComponent.delete(comp)` | 删除器件（传入对象） |
| `eda.sch_PrimitiveComponent.create(device, x, y, sub, rot, mir, bom, pcb)` | 创建器件 |
| `eda.sch_PrimitiveComponent.modify(comp, {designator})` | 设置位号 |

### Step 5: 输出汇总表

放置完成后，**先查 `known-unfindable.json` 缓存**，命中则直接复用已有 datasheet/供应商链接，不再重复 WebSearch。未命中的才调用 WebSearch：

```
对每个未找到的规格：
  1. 查 known-unfindable.json → 命中 → 直接用缓存的链接
  2. 未命中 → WebSearch(query="{spec} datasheet 规格书")
  3. 搜索结果写入 known-unfindable.json（下次复用）
  4. 将链接填入汇总表
```

最终向用户展示。**输出规则**：

> 🚫 **排除项不列明细**。已排除的极性电容、晶振、LED、非阻容 NC 只报**一行统计数字**，不逐行展开。已放置的通用符号（电阻/电容/TP，含 NC 阻容）汇总在放置统计中。只有**用户需要行动**的表才列明细。

#### 输出表清单（共 4 张）⚠️ 不含分类汇总表

> 🚫 **不输出分类汇总表**。通用符号（电阻/电容/TP/NC阻容）已放置的信息已在原理图上可见，未放置/排除/未找到的行已通过 Excel 标黄体现。只输出**用户需要行动**的表。

| # | 表名 | 内容 | 触发条件 |
|---|------|------|---------|
| 1 | ⚠️ 近似匹配表 | 搜到但名称不完全一致 | 有近似匹配时 |
| 2 | 🔴 极性电容表 | 已排除的电解电容（需要电解符号） | 有极性电容时 |
| 3 | 🔴 二极管表 | 不放置模式下排除的二极管（需手动用通用符号放置） | diodeMode=`skip` 且有二极管时 |
| 4 | 🟡 异常阻容感告警表 | C/R 前缀但规格异常 | 有异常时 |

> **不再单独出"未找到器件表"和"未放置器件总表"**。未放置/未找到的行直接在 BOM Excel 文件中整行标黄。

#### 一句话汇总（列在开头）

```
已放置 XX 个器件（XX 个规格）。已排除极性电容 XX 个、晶振 X 个、LED X 个、非阻容 NC X 个[、二极管 X 个]。未放置的行已在 BOM 文件中标黄。
```

> 💾 **保存提醒（强制）**：所有器件已放置到 EasyEDA 编辑器文档，但尚未落盘。汇总输出后**必须提醒用户在 EasyEDA 中按 `Ctrl+S` 保存原理图**，否则关闭编辑器会丢失本次放置。

#### 🚨 BOM 文件标黄（强制步骤，禁止跳过）

> 🚨 **铁律**：输出汇总表之后，**必须执行此步骤**。跳过会导致用户不知道哪些器件未放置。

**原理**：不用手动维护 placed designator 列表（跨步骤追踪容易断裂）。脚本自动从 EDA `getAll()` 反查实际已放置的 designator，用 `xlsx-populate` 原地修改 BOM Excel 把未放置的行整行标黄。

**🚨 必须使用 `scripts/mark-yellow.mjs`（Node.js 原生，跨平台，零依赖 COM/PowerShell）**

```bash
node scripts/mark-yellow.mjs <bridge-port> <BOM文件路径>
```

脚本内部流程：
1. 调 EDA `/execute` 获取所有已放置 designator → 建 `Set`
2. 用 `xlsx-populate` **原地修改**原文件（不重建 workbook）
3. 逐行比对：行内**所有** designator 都不在 Set 中 → 前 4 列标黄
4. 直接 `toFileAsync` 保存回原文件（保留列宽、字体、边框等所有格式）

> ⚠️ **为什么不用 exceljs**：exceljs 修改已有 xlsx 时存在 fill 全局传播 bug（设一个 cell 的 fill 会导致所有 cell 继承该 fill）。`xlsx-populate` 直接操作 XML，无此问题。

**标记规则**：

| 条件 | 操作 |
|------|------|
| 行内**所有**位号都不在 EDA 中 | 🟡 整行标黄 |
| 行内**至少一个**位号在 EDA 中 | ⚪ 不标黄（含部分放置） |

**输出示例**：
```
🔍 查询 EDA 已放置器件...
   找到 9 个已放置器件
   [R1, R2, C1, C3, C2, C5, C4, AC1_OUT, AC2_OUT]
📂 读取 BOM: D:\...\Free Documents.xlsx
💾 写入临时文件: C:\Users\...\bom_yellow_1785290302481.xlsx

========================================
  BOM YELLOW MARKING DONE
  Yellow rows: 5
========================================
  Row 2: AC1_IN, AC2_IN
  Row 7: EARTH
  Row 8: H1, H2
  Row 9: L1
  Row 11: RY1
```

> ⚠️ **常见失败原因**：Excel 文件被其他进程打开时写不进去。脚本会自动杀 Excel 进程（Windows）。如果仍 EBUSY，关闭文件资源管理器的预览窗格再试。

#### ⚠️ 近似匹配表（搜到但名称不完全一致，不放置）
| 位号 | BOM规格 | 库中名称 | 差异 |
|------|---------|----------|------|

#### 🔴 极性电容表（排除但需区分符号）
| 位号 | 规格 | 封装 | 数量 | 类型 |
|------|------|------|------|------|
| C70, C121, ... | 470uF±20% 50V | DIP,D10XL20MM | 12 | 铝电解 |
| C2, C24, ... | ECR1HGK100MFA050011 | DIP,D5XL11.5MM | 11 | 铝电解 |

#### 🔴 二极管表（不放置模式，排除但需要手动用通用符号放置）
| 位号 | 规格 | 封装 | 数量 |
|------|------|------|------|
| D1, D2, D3, D4 | 1N4007 | SMA | 4 |
| D5, D6 | BAT54S | SOT-23 | 2 |

#### 🟡 异常阻容感告警表
| 位号 | 规格 | 封装 | 诊断 |
|------|------|------|------|




---

## API 参考

### Bridge 端点

| 端点 | 方法 | 用途 | 返回数据量 |
|------|------|------|-----------|
| `/search` | POST | 搜索器件（精简，支持 exact 过滤） | 极小 — 仅 `{n, f, u}`，`exact=true` 时只返回精确匹配 |
| `/search-batch` | POST | **批量搜索**（一次传入多个 keyword） | 极小 — `{kw: [{n,f,u}]}`，替代串行搜索节约 ~80% 时间 |
| `/place` | POST | 放置器件（搜索+放置+设位号，Bridge 内部完成） | 极小 — `"PLACED:xxx@(x,y) AS D1"` 或 `"NOT_FOUND:xxx"` |
| `/execute` | POST | 执行任意代码 | 取决于代码返回值 |
| `/health` | GET | 健康检查 + EDA 连接状态 | 极小 |

### 搜索（精简，Step 3 使用）
```powershell
$body = @{ keyword = "STM32F405RGT6"; exact = $true } | ConvertTo-Json -Compress
$r = Invoke-RestMethod -Uri "http://localhost:$BRIDGE_PORT/search" -Method Post -Body $body -ContentType "application/json"
# $r.result = [ { n: "name", f: "footprintName", u: "uuid" } ]  — 仅精确匹配
```

### 批量搜索（推荐，Step 3 使用，一次搜完所有规格）
```powershell
$keywords = @("STM32F405RGT6", "LM324DT", "BAV99,215")
$body = @{ keywords = $keywords; exact = $true } | ConvertTo-Json -Compress
$r = Invoke-RestMethod -Uri "http://localhost:$BRIDGE_PORT/search-batch" -Method Post -Body $body -ContentType "application/json" -TimeoutSec 60
# $r.result = { "STM32F405RGT6": [{n,f,u}], "LM324DT": [{n,f,u}], ... }
# 每个 keyword 的结果独立 key，精确匹配已在服务端过滤
```

### 放置（Step 4 使用）
```powershell
$body = @{ spec = "STM32F405RGT6"; x = 100; y = 200; designator = "U1" } | ConvertTo-Json -Compress
$r = Invoke-RestMethod -Uri "http://localhost:$BRIDGE_PORT/place" -Method Post -Body $body -ContentType "application/json"
# 返回 "PLACED:STM32F405RGT6@(100,200) AS U1" 或 "NOT_FOUND:STM32F405RGT6"
# designator 为可选参数，不传则保持默认 U?/D?/Q?
```

### 搜索（完整，备用）
```powershell
$body = @{ code = 'return await eda.lib_Device.search("STM32F405RGT6");' } | ConvertTo-Json -Compress
$r = Invoke-RestMethod -Uri "http://localhost:$BRIDGE_PORT/execute" -Method Post -Body $body -ContentType "application/json"
```

### 放置
```javascript
const placed = await eda.sch_PrimitiveComponent.create(
  searchResult,  // 搜索结果对象（必须用 sr.find 找到的精确匹配项）
  100,           // x 坐标 (0.01inch = 10mil)
  100,           // y 坐标
  "",            // subPartName
  0,             // rotation
  false,         // mirror
  true,          // addIntoBom
  true           // addIntoPcb
);
```

### 工程信息
```javascript
// 获取当前项目
const project = await eda.dmt_Project.getCurrentProjectInfo();
// 获取当前文档
const doc = await eda.dmt_SelectControl.getCurrentDocumentInfo();
// 切换页面
await eda.dmt_EditorControl.openDocument(pageUuid);
```

---

## 坐标单位

| 域 | 单位 |
|------|------|
| 原理图 (SCH) | 0.01inch = 10mil |
| PCB | 1mil |

---

## 已验证的实战参数

| 参数 | 值 | 说明 |
|------|-----|------|
| 通用符号列数 | 20 | A0 纸 |
| 通用符号 ΔY | 45 | EasyEDA 网格吸附值 |
| 通用符号起点 | 见 Step 2.6 间距表 | 电阻(960,3250)、电容(100,3250)、TP(2030,3260) |
| 搜索器件间距 | 见自适应间距表 | 按封装估算 |
| EDA 轮询间隔 | 3 秒 | 最多 20 次（60 秒） |
| 搜索超时 | 30 秒 | |
| 搜索端点 | `POST /search` / `/search-batch` | 精简返回 `{n,f,u}`；批量搜索节约 ~80% 时间 |
| 放置端点 | `POST /place` | 搜+放+设位号，Bridge 内部完成 |
| 单次搜索耗时 | ~2-5 秒 | 实测 |
| search-batch 批量 | ~2.5s/关键词 | 服务端切块 4 个/执行；10 个关键词 ~25s（>12 个需拆两次） |
| 单批放置耗时 | ~10 秒 | 20 个/批 |

## 已验证的问题与对策

| 问题 | 对策 |
|------|------|
| `sr[0]` 不是精确匹配（如 AMS1117-3.3_C6186 排在 AMS1117-3.3 前面） | 用 `sr.find(s => s.name === spec)` |
| 代码用 IIFE 无返回值 | 必须用 `return await ...` |
| 18 个器件一次性放置超时 | 分批 6-7 个/次 |
| BOM 规格末尾 `\|` 截断（如 NOP\|） | 搜索时补全常见后缀 |
| BOM 拼写错误（WAFFER→WAFER） | 自动修正后搜索 |
| 位号全是默认 U?/D?/Q? | ✅ 已解决：`/place` 支持 `designator` 参数，放置时传入位号 |
| for...of 循环内 await 搜索 | ✅ 已实测可用（每轮返回不同结果）；如再遇异常退回逐条 `/search` |
| **search-batch 30s 硬超时** | ✅ 已修复：服务端切块 4 个/执行，10 个关键词 ~25s；>12 个拆两次调用 |
| **BOM 读取 `MODULE_NOT_FOUND`** | ✅ 已修复：新增 `scripts/read-bom.mjs`，脚本内自定位 skill node_modules |
| **分类逻辑 AI 手写易误判** | ✅ 已修复：新增 `scripts/classify.mjs` 官方分类器（NC 阻容/极性判断/型号提取/异常告警） |
| **`mark-yellow.mjs` 只杀 EXCEL，WPS 占用时写不进** | ✅ 已解决：不再强杀进程（会毁用户其他未保存表格）。改为检测 EBUSY → 提示用户关闭 Excel/WPS 后重跑 |
| **Write 工具写的 `.json` 被 Node 读成 EasyEDA blob** | ✅ 已解决：环境层文件读取拦截。`place-common.mjs`/`place-searched.mjs` 支持传 `-` 从 **stdin 读 items**（管道不走文件读取）；不信任中间 `.json` |
| **classify 误判**（IC 前缀当电容/`CD28x` 电解漏判/H 当电感/`(相似)` 全角括号不提取/圆柱封装 `D16XL26MM` 正则失效） | ✅ 已修复：异常用完整字母前缀；POLAR 前缀加 `CD28\d/CD11/CD110/CD263`；极性判断提到电感前（防 `CD288H1...` 含 "H" 误判电感）；`H`/`H1`/`H 3.2MM` 规格归安装孔（数字在前如 `1H` 才是电感）；NONPOLAR 加 `CL1x/CL2x/CBB`；extractModel 支持全角括号且保留内部空格 |
| **BOM 封装 vs 库封装不一致无检查** | ✅ 已解决：新增 `scripts/verify-footprints.mjs`（同间距视为兼容，抓 `IN4148:DO-35 vs 1206` 这类真实不一致） |
| **放置后无验证** | ✅ 已解决：新增 `scripts/verify-placement.mjs`（同坐标重叠 / 空位号 / 默认位号 / 前缀统计） |
| **BOM 标黄后无读回验证** | ✅ 已解决：`mark-yellow.mjs` 保存后读回 fills 逐行确认（注意 xlsx-populate 返回 `color.rgb`） |
| **EDA 未连接时 AI 停下来问用户** | **自动轮询 60 秒，连上直接继续，超时才提醒** |
| **丝印/不确定型号浪费搜索** | **Step 2.5 预过滤，型号提取后照常搜索** |
| **规格内多余空格（SRV05-4. TCT）** | **去掉 `. ` → `.`** |
| **多部位器件只放 Part 1** | ✅ 已解决：`create(name + ".N")` 循环 + `modify()` 设位号，直到 `null` 停止 |
| **`_*` 后缀器件不匹配** | ✅ 已解决：运放/芯片类 `spec + "_*"` 也算精确匹配，多部件版本优先 |
| **电容全部分为"排除"不分极性** | ✅ 已解决：常识判断表 + 标注覆盖（见 Step 2 极性电容规则） |
| **通用符号批量放置** | ✅ 已解决：读 common-symbols.json，20 列从上往下排列 |
| **`(类似)` 型号无法确认具体参数** | ✅ 已解决：标注文件中通常有确切容值/耐压 |
| **未找到器件的 datasheet 需 WebSearch** | ⚠️ 改进：标注中已有链接的优先使用，不再搜 |
| **exceljs 修改已有 xlsx 时 fill 全局传播** | ✅ 已解决：切换为 `xlsx-populate`，直接操作 XML 原地改 fill |
| **`place-searched.mjs` Y 起点 `ReferenceError`** | ✅ 已修复：脚本内置 `getYStart()` 从 EDA 动态查询通用符号最低 Y |
| **Git Bash 写临时文件到 `/tmp/` 失败** | ✅ 改写到项目目录，或脚本内部用 `os.tmpdir()` |

---

## 待改进

1. ✅ **近似匹配自动处理** — `place-searched.mjs` 支持 item 带 `approxOrig`：传库中查到的名称放置并标记 `⚠️APPROX` 单独汇总。AI 判断"封装一致、就是这颗料"时才启用，仍保留严格匹配默认
2. ✅ **多实例自动复制** — 完整模式下每个位号独立放置并设位号（已完成）
3. ✅ **位号自动设置** — `/place` 端点支持 `designator` 参数（已完成）
4. ✅ **智能间距** — 根据封装名估算符号大小，小器件密排大器件拉开，自动换行；封装到 `place-searched.mjs`（已完成）
5. **自动翻页** — 器件超过一页时自动创建新页面
6. **Bridge 断线自动重连** — 检测到断线自动重启 bridge
7. **分类扩展** — 排阻、热敏电阻、保险丝等更多类型
8. **BOM 截断自动补全引擎** — 将截断修复规则系统化：`|` 截断 → 查常见后缀表；`.` 截断 → 递增尝试 0-9
9. ✅ **搜索结果精简** — Bridge 已新增 `POST /search` 端点，仅返回 `{n,f,u}`（已完成）
10. ✅ **精确匹配过滤** — `/search` 端点支持 `exact=true`，只返回 name===keyword 的结果，节省 ~75% token（已完成）
11. ✅ **放置端点** — 新增 `POST /place`，搜索+匹配+放置全在 Bridge 内部，不占 AI context（已完成）
12. ✅ **极性电容识别** — 型号前缀+单位+封装+容值四维判断，SMD 小封装 uF=MLCC 非极性，圆柱封装 uF=电解极性（已完成）
13. ✅ **`(类似)` 型号解析** — 标注文件中通常有确切容值/耐压/类型，优于从型号猜测（已完成）
14. ✅ **批量搜索** — Bridge 新增 `POST /search-batch` 端点，一次搜完所有规格（已完成；服务端切块规避 30s 超时，10 个关键词 ~25s）
15. ✅ **自适应间距脚本化** — 新增 `place-searched.mjs`，AI 只生成输入文件（已完成）
16. ✅ **WebSearch 缓存** — 新增 `known-unfindable.json`，搜过不再重复搜（已完成）
17. ✅ **多部件已知清单** — LM324/LM339/LM358 等命中直接走多部件流程（已完成）
18. ✅ **编码容错** — `place-common.mjs` 增加 UTF-16/BOM 自动检测（已完成）
19. ✅ **BOM 标黄原地修改** — 已从 exceljs（fill 传播 bug）切换到 `xlsx-populate`（直接操作 XML，原地改 fill，不重建文件）（已完成）
20. ✅ **`place-searched.mjs` Y 起点 bug** — 脚本内置 EDA 动态查询 + `getYStart()`（已修复）
21. **通用符号放置与搜索并行** — 目前串行，可同时进行节约 ~15s
22. ✅ **`/search-batch` 超时** — 已修复：服务端切块 4 个/执行；>12 个关键词仍需拆两次调用
23. ✅ **官方分类器** — 新增 `scripts/classify.mjs`，读 BOM → 输出 common/searched/summary 三件套（已完成）
24. ✅ **官方 BOM 读取** — 新增 `scripts/read-bom.mjs`，脚本内自定位 node_modules，解决 `MODULE_NOT_FOUND`（已完成）
25. ✅ **`mark-yellow.mjs` WPS/Excel 占用** — 改为安全处理：不强杀进程，检测到 EBUSY 时提示用户关闭后重跑（避免毁掉用户其他未保存表格）
26. **`place-searched.mjs` 多部件支持** — 现仅 `/place` 单实例；已知多部件清单外的 IC（如双比较器）可能漏放 Part B，建议内置 `.2` 探测
27. ✅ **BOM 标黄验证** — `mark-yellow.mjs` 保存后读回 fills 逐行确认（`color.rgb` 判黄色），新增 `scripts/verify-placement.mjs` + `scripts/verify-footprints.mjs`
28. ✅ **放置脚本 stdin 支持** — `place-common.mjs`/`place-searched.mjs` 传 `-` 读 stdin，绕开 Windows 上 Node 读不了 Write 工具 `.json` 的问题
29. ✅ **搜索关键词保留原始空格** — `extractModel` 不再粗暴去空格，只折叠连续空白 + 修 `. ` → `.`（`AM-300 300V 12A` 不再变 `AM-300300V12A`）
30. ✅ **分类器已知型号清单扩展** — 极性前缀加 `CD11/CD110/CD263/CD28x`；非极性前缀加 `CL1x/CL2x/CBB/CQ/CY`；安装孔独立 `mount` 桶

---

## 附录：极性电容常识判断速查表

排除电容时不搜索 EDA，但必须按常识区分极性/非极性，因为用户放通用符号时**符号不同**（极性用电解符号带 `+`，非极性用普通电容符号）。

### 判断流程（按优先级）

```
读型号前缀 → 看单位（pF/nF） → 看电解型号前缀 → 看封装形状 → uF级看封装+数值 → 判定
```

### 🔴 极性电容信号（电解电容/钽电容）

| 信号类型 | 具体特征 | 示例 |
|----------|----------|------|
| **电解型号前缀** | `ECR` / `EGD` / `EGW` / `EGX` / `EKY` / `EEU` | `ECR1HGK100MFA050011`、`EGD2WM121M35OT` |
| **圆柱封装 + uF级** | 封装 `D*x*L*MM` + 容值 ≥1uF | `2.2uF±20% 50V` + `DIP,D5XL11.5MM` |
| **超大圆柱封装** | `D18XL35MM`、`D10XL20MM` 等 | 一定是电解 |
| **大容量直插** | 径向 `P=*MM` + ≥100uF | `100uF±20% 50V` + `P=5MM` |
| **钽电容封装** | `SMD-TAN` / case `A`/`B`/`C`/`D`/`E` | 钽电容有极性标识 |
| **封装未知 + 超大容量** | 无封装信息 + ≥100uF | 大概率电解 |

> 🚨 **不是所有 uF 就是极性！** 看到 `10uF 0805` 这种 SMD 小封装 → 非极性 MLCC。

### 🟢 非极性电容信号（瓷片/薄膜/MLCC）

| 信号类型 | 具体特征 | 示例 |
|----------|----------|------|
| **特定型号前缀** | `C242`/`C241`/`C317`/`C322`/`CC4`/`CC81`/`CK45`/`DCC`/`DCS`/`DCH`/`N13`/`S10`/`DCM` | `C242A104J2SA201`、`DCC101J20SL F6FJ5A0` |
| **小容量单位** | `pF` / `nF` 单位 | `100nF±10%`、`50pF±10% 50V` |
| **SMD 小封装 + uF** | `0402`/`0603`/`0805`/`1206`/`1210` + ≤100uF | `10uF±10% 16V 0805` → MLCC，非极性 |
| **SMD 中封装 + 小uF** | `1812`/`2220` + ≤47uF | MLCC 可做到 |
| **扁平封装** | `P=*MM` + <100uF（非电解前缀） | 薄膜电容 |

### ⚡ 快速判断口诀

| 看到这个 | 直接判定 | 原因 |
|----------|----------|------|
| `C242`/`CC4`/`DCC`/`C241`/etc | 🟢 非极性 | 型号前缀明确为薄膜/MLCC |
| `XXXpF` / `XXXnF` | 🟢 非极性 | 小容量 = 不可能是电解 |
| `ECR` / `EGD` / `EGW` / `EEU` | 🔴 极性 | 铝电解电容厂家系列前缀 |
| 封装 `D*x*L*MM` + uF 级 | 🔴 极性 | 圆柱直插 = 电解电容封装 |
| `XXuF` + `0805`/`0603`/`1206` | 🟢 非极性 | SMD 小封装 + uF = MLCC，不是电解 |
| `XXuF` + 没封装信息 → 看数值 | ≥100uF: 🔴 / 10~99uF: 🟡 / <10uF: 🟢 | 数值大小 + 无封装 = 需判断 |

### 实战示例

```
C242A104J2SA201            → 🟢 非极性（C242 前缀=薄膜，优先级 1）
DCC101J20SL F6FJ5A0        → 🟢 非极性（DCC 前缀=瓷片，优先级 1）
CC4-0805N471J500PF3        → 🟢 非极性（CC4+PF 单位，优先级 1/2）
CK45-B3AD102KYNNA          → 🟢 非极性（CK45 前缀，优先级 1）
100nF±10%                  → 🟢 非极性（nF 单位，优先级 2）
10uF±10% 16V + 0805        → 🟢 非极性（SMD 小封装 ≤100uF，优先级 5）
22uF±20% 6.3V + 1206       → 🟢 非极性（SMD 小封装 ≤100uF，优先级 5）
ECR1HGK100MFA050011        → 🔴 极性（ECR 铝电解前缀，优先级 3）
2.2uF±20% 50V + D5XL11.5   → 🔴 极性（圆柱封装+uF，优先级 4）
470uF±20% 50V + D10XL20MM  → 🔴 极性（圆柱封装+大容量，优先级 4）
100uF±20% 16V + P=5MM       → 🔴 极性（径向直插≥100uF，优先级 5）
47uF±20% 10V + P=5MM        → 🟡 待确认（径向直插<100uF，可能薄膜或小电解）
100uF±20% 6.3V + 封装未知   → 🔴 极性（无封装+≥100uF，优先级 5）
4.7uF±10% 50V + 封装未知    → 🟡 待确认（无封装+<10uF 但接近边界，建议确认）
```
