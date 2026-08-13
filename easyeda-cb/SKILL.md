---
name: easyeda-cb
description: >-
  抄板全流程调度器：自由选择铺铜/丝印匹配/BOM放置的步骤和顺序（1~3步任意组合）。
  Bridge 只启动一次，按用户选择的顺序执行，失败不中断，最后汇总结果。
  Trigger on: "easyeda-cb", "/easyeda-cb", "抄板", "开始抄板", "一键抄板".
---

> 🔓 **自动提权模式**：进入此 Skill 后，整个流程（启动 Bridge → 按用户选择的步骤和顺序执行 → 汇总）**不会弹出确认框**。

# EasyEDA 抄板全流程 Skill

一键完成 **轮廓铺铜** + **丝印匹配** + **BOM 器件放置**，bridge 只启动一次，中途失败不中断。

## 触发方式

```
/easyeda-cb <pcb名称> <bom文件路径>
```

**示例**：
```
/easyeda-cb 03021080 D:\项目\BOM清单.xlsx
```

**⚠️ 重要**：参数解析完毕后，**必须先弹出模式选项让用户选择**，不要直接用默认值开跑。详见 Step -1。

---

## 流程总览

```
触发 /easyeda-cb <pcb> <bom>
   │
   ├─ Step -1: 选择步骤 + 顺序 + 各步骤参数（自由组合）
   │
   ├─ Step 0: 启动 Bridge + 连接 EDA（一次）
   │
   ├─ Dynamic: 按用户选择的顺序执行（1~3 步任意组合）
   │   ├─ [铺铜]     → node generate.mjs <port> <pcb> [非铺铜]
   │   ├─ [丝印匹配] → 顶层/底层匹配 → 挪动
   │   └─ [BOM 放置] → 读取 BOM → 分类 → 搜索 → 放置 → 汇总 → 🚨标黄
   │
   └─ Final: 最终汇总（仅汇总已执行的步骤）
```

> **灵活组合**：不强制三步全跑。可以只跑铺铜+丝印、只跑 BOM、丝印→BOM 等任意组合。
> 未选中的步骤直接跳过，不追问参数。

---

## 参数解析

从用户消息中提取：

| 参数 | 来源 | 必填 |
|------|------|:--:|
| PCB 名称 | 用户消息第 1 个参数 | ✅ |
| BOM 路径 | 用户消息第 2 个参数 | ✅ |

如果缺少参数，提示：
```
用法: /easyeda-cb <pcb名称> <bom文件路径>
示例: /easyeda-cb 03021080 D:\项目\BOM清单.xlsx
```

---

## Step -1: 步骤与顺序选择（⚠️ 必须先执行）

> 🚨 **铁律**：参数解析完毕后，**必须先用 AskUserQuestion 让用户选择步骤和顺序**。
> 先后分两到三轮追问，选完后直接跑，不再追问。

### 第一轮：选择步骤（多选，至少选 1 个）

| 选项 | 值 | 说明 |
|------|------|------|
| **铺铜** | `poly` | 从 PCB 线条找闭合轮廓并生成铜皮 |
| **丝印匹配** | `silk` | 拍照匹配丝印位号并挪动到正确位置 |
| **BOM 器件放置** | `bom` | 读取 BOM 清单，搜索器件并放置到原理图 |

> 根据用户选择，后续只追问选中步骤的参数。未选中的步骤直接跳过。

### 第二轮：选择执行顺序

> 仅在选中 **2 个或以上** 步骤时追问。选 1 个步骤时跳过本轮。

**选中 3 个时**（铺铜 + 丝印 + BOM）：

| 选项 | 顺序 |
|------|------|
| **铺铜 → 丝印 → BOM**（推荐） | poly → silk → bom |
| 铺铜 → BOM → 丝印 | poly → bom → silk |
| BOM → 丝印 → 铺铜 | bom → silk → poly |
| 自定义顺序 | 用户在 Other 中输入，用 `→` 连接。例: `丝印 → BOM → 铺铜` |

**选中 2 个时**：列出两种可能顺序 + 自定义顺序（Other）。

### 第三轮：各步骤参数

> 根据第一轮选中的步骤，**逐个**追问对应参数。未选中的步骤整套跳过。

#### 铺铜参数（选中 `poly` 时追问）

| 选项 | 值 | 说明 |
|------|------|------|
| **非铺铜**（推荐） | `skip-nested` | 跳过被外层包含的内层轮廓 |
| 全部铺铜 | `all` | 所有闭合轮廓都生成铜皮 |

#### 丝印参数（选中 `silk` 时追问）

**丝印-追问 0：匹配范围**

| 选项 | 值 | 说明 |
|------|------|------|
| 仅顶层 | `top` | 只匹配顶层丝印，需提供 1 张照片 |
| 顶层 + 底层 | `both` | 双面匹配，需提供 2 张照片 |

**丝印-追问 1：照片路径**（选 top 或 both 后追问）

| 选项 | 说明 |
|------|------|
| 输入路径 (选后在 Other 填) | 顶层和底层照片路径，空格分隔。例: `D:/xxx/TOP.jpg D:/xxx/BOT.jpg` |
| 当前目录默认名 | `TOP.jpg BOT.jpg` |

**丝印-追问 2：抄板坐标系**

| 选项 | 说明 |
|------|------|
| 输入参数 (选后在 Other 填) | 格式: `抄板右下角x 抄板右下角y 参考位号 抄板x 抄板y PCBx PCBy` (全 mil) |
| 稍后提供 | 跳过，手动编辑 mapping.json |

> 抄板软件原点固定 (0,0) = 照片左上角。offset 固定 50000。Claude 收到参数后调用 `build_mapping()` 生成 mapping.json。

#### BOM 参数（选中 `bom` 时追问）

**二极管处理：**

| 选项 | 值 | 说明 |
|------|------|------|
| **放置**（推荐） | `place` | 二极管正常搜索并放置到原理图 |
| 不放置 | `skip` | 二极管不搜索不放置，最后列二极管表 |

### 选项映射

| 用户选择 | 传给 poly | 传给 silk | 传给 BOM |
|----------|-----------|-----------|----------|
| 步骤未选中 | 跳过 | 跳过 | 跳过 |
| 铺铜 = 非铺铜 | `非铺铜` | — | — |
| 铺铜 = 全部铺铜 | 不传第4参数 | — | — |
| 丝印 = 仅顶层 | — | `top` + 照片 + 坐标 | — |
| 丝印 = 双面 | — | `both` + 照片 + 坐标 | — |
| 二极管 = 放置 | — | — | `diodeMode = "place"` |
| 二极管 = 不放置 | — | — | `diodeMode = "skip"` |

---

## Step 0: 启动 Bridge + 连接 EDA（共享基础设施）

> 与 `easyeda-poly`、`easyeda-silk`、`easyeda-bom-placement` 的 Step 0 完全相同。
> **整个流程只执行一次。**

```powershell
.\start-bridge.ps1
```

脚本位置：`~/.claude/skills/easyeda-silk\start-bridge.ps1`。
成功后输出 `BRIDGE_PORT=<port>`。

---

## Dynamic Step: 铺铜（仅当用户选中 `poly` 时执行）

**完全遵循 `easyeda-poly` skill 流程**，根据选择的铺铜模式传入对应参数。按用户指定的顺序插入执行。

**记录结果**：从 poly 输出中提取：
```
POLY_RESULT: { totalContours, nestedSkipped, generated, failed, failures[] }
```

---

## Dynamic Step: 丝印匹配（仅当用户选中 `silk` 时执行）

> 仅在 Step -1 选择顶层/双面时执行。完整逻辑见 `easyeda-silk/SKILL.md`。
> `~/.claude/skills/easyeda-silk\`

### 2a. 生成 mapping.json

根据 Step -1 收集的抄板参数：
```python
from silk_engine import build_mapping
# tl = (0,0)mm, br = 抄板右下角 mil / 39.3701, offset = 50000
```

### 2b. 导出位号

```bash
node export-designators.mjs <port> top     # 仅顶层
node export-designators.mjs <port> both    # 双面
```

### 2b2. 补全缺失的丝印文字（如有 text_id 为空）

```bash
node create-texts.mjs <port> designators_top.json --height 60 --width 10
node create-texts.mjs <port> designators_bottom.json --height 60 --width 10
```

### 2c. 匹配

```bash
python silk_engine.py match -i <照片> -m mapping.json -d designators_top.json -o match_top.json
# 底层: --mirror（镜像翻转匹配）
python silk_engine.py match -i <照片> -m mapping.json -d designators_bottom.json -o match_bottom.json --mirror
```

### 2d. 挪动

```bash
python silk_engine.py move -r match_top.json
python silk_engine.py move -r match_bottom.json
```

**记录结果**——从 silk 输出中提取：
```
SILK_RESULT: { top: {matched, moved, ok, fail}, bottom: {matched, moved, ok, fail} }
```

---

### 阶段间通知（⚠️ 每个阶段完成后必须执行）

每步完成后：① EDA 弹出**英文** toast，② **终端输出醒目提示**，③ **停 20 秒**让用户查看。

**通知模板**（每阶段替换 `<phase>` 和 `<next>`）：

```powershell
# === EDA Toast（英文） ===
node -e "fetch('http://127.0.0.1:$BRIDGE_PORT/execute',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:\"eda.sys_Message.showToastMessage('Step <phase> done. Next: <next> in 20s...'); return 'ok';\"})}).catch(()=>{})" 2>$null

# === 终端醒目提示 ===
Write-Output "========================================"
Write-Output "  STEP <phase> COMPLETED"
Write-Output "  Next: <next> in 20 seconds..."
Write-Output "========================================"
Start-Sleep 20
```

**各阶段映射**（根据用户选择的步骤和顺序动态生成 `<phase>` 和 `<next>`）：

| 阶段 | `<phase>` | `<next>` |
|------|-----------|----------|
| Step 0 完成 | Bridge Ready | 用户顺序中的第 1 步 |
| 第 1 步完成 | (实际步骤名) | 第 2 步（如有）或 Summary |
| 第 2 步完成 | (实际步骤名) | 第 3 步（如有）或 Summary |
| 最后一步完成 | (实际步骤名) | Summary |

> 步骤名用英文：`Poly Pour` / `Silk Match` / `BOM Placement`。
> 如果用户只选了 1 个步骤，Step 0 之后直接跑那一步，完成后 → Summary。

---

## Dynamic Step: BOM 放置（仅当用户选中 `bom` 时执行）

> 🚨 **Bridge 已在 Step 0 启动。** CB 不重复任何 BOM 放置逻辑。
> 完全遵循 `easyeda-bom-placement` skill。
> 详见 `~/.claude/skills/easyeda-bom-placement\SKILL.md`。

**CB 仅负责传入参数**：

| 参数 | 值 | 来源 |
|------|-----|------|
| BOM 文件路径 | `<bom文件路径>` | 触发命令第 2 个参数 |
| diodeMode | `"place"` 或 `"skip"` | Step -1 用户选择 |

**记录结果**：
```
BOM_RESULT: { placed, notFound, excluded, yellowRows }
```

---

## Step 4: 最终汇总

> 只汇总**用户实际选中并执行**的步骤。未选中的步骤不出现在汇总中。

```
═══════════════════════════════════════
  EasyEDA 抄板完成
═══════════════════════════════════════

📐 铺铜 (PCB: <名称>):                          ← 仅当选中 poly
  ✅ <N> 铜皮生成成功
  ❌ <N> 失败 (如有)

🔤 丝印匹配:                                    ← 仅当选中 silk
  ✅ 顶层: <N>/<N> 匹配, <N> 挪动成功
  ✅ 底层: <N>/<N> 匹配, <N> 挪动成功 (如有)
  ⚠️ <N> 去重跳过

📦 BOM 放置 (文件: <路径>):                     ← 仅当选中 bom
  ✅ <N> 个器件已放置
  ⚠️ <N> 个近似匹配 / 未找到
  🔴 <N> 行已被排除（标准阻容/NC等）
  🟡 <N> 行已在 Excel 标黄

───────────────────────────────────────
  执行顺序: <poly→silk→bom 实际顺序>
  Bridge 端口: <port> (保持运行)
═══════════════════════════════════════
```

### 失败处理规则

- 铺铜失败 → **不中断**，记录失败数和清单
- 丝印匹配失败 → **不中断**，记录失败数
- BOM 单个器件放置失败 → **不中断**
- Bridge 断连 → 尝试重连一次，仍失败则终止并报告

---

## 依赖

| 依赖 | 路径 |
|------|------|
| Bridge 服务器 | `~/.claude/skills/easyeda-api-skill\scripts\bridge-server.mjs` |
| Bridge 启动脚本 | `~/.claude/skills/easyeda-silk\start-bridge.ps1` |
| 铺铜脚本 | `~/.claude/skills/easyeda-poly\generate.mjs` |
| 丝印引擎 | `~/.claude/skills/easyeda-silk\silk_engine.py` |
| 位号导出 | `~/.claude/skills/easyeda-silk\export-designators.mjs` |
| 丝印创建 | `~/.claude/skills/easyeda-silk\create-texts.mjs` |
| BOM 流程 | `~/.claude/skills/easyeda-bom-placement\SKILL.md` |
