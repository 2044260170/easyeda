---
name: easyeda-poly
description: >-
  Analyze PCB copper layers, find closed contours from 2mil outline lines + arcs,
  detect nested contours, and generate copper pours automatically.
  Trigger on: "ez-poly", "生成铜皮", "轮廓铺铜", "poly pour", "generate pours".
---

> 🔓 **自动提权模式**：进入此 Skill 后，整个流程（启动 Bridge → 连接 EDA → 分析轮廓 → 生成铜皮 → 输出汇总）**不会弹出确认框**。

# EasyEDA 轮廓铺铜 Skill

根据 PCB 板框上的 2mil 轮廓线 + 弧线，自动识别闭合轮廓、在所有铜皮层上生成铜皮。

**嵌套检测开关**：默认**关闭**，即所有闭合轮廓都生成铜皮。当用户提到 **"非铺铜"** 时开启嵌套检测，自动跳过被外层包含的内层轮廓。

## 触发方式

用户输入 `/ez-poly` 或说 "生成铜皮"、"轮廓铺铜"。
加上 **"非铺铜"** 关键词可开启嵌套检测跳过内层。

## 前置步骤

### Step 0: 启动 EasyEDA Bridge + 连接 EDA

> 调用 `easyeda-api-skill` 的 bridge 启动逻辑。

**Windows (PowerShell)**：

```powershell
# ⚠️ 用 Node.js fetch() 检测 bridge，Invoke-RestMethod 不可靠
$BRIDGE_PORT = $null
foreach ($port in 49620..49629) {
  $r = node -e "fetch('http://127.0.0.1:$port/health').then(r=>r.json()).then(j=>console.log(j.service)).catch(()=>{})" 2>$null
  if ($r -eq "easyeda-bridge") { $BRIDGE_PORT = $port; break }
}
# 没找到就启动
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

**等待 EDA 连接**（每 3 秒轮询，最多 60 秒）：

```powershell
# ⚠️ 用 Node.js fetch() 轮询 EDA 连接
$connected = $false
for ($i = 0; $i -lt 20; $i++) {
  $status = node -e "fetch('http://127.0.0.1:$BRIDGE_PORT/health').then(r=>r.json()).then(j=>console.log(j.edaConnected)).catch(()=>{})" 2>$null
  if ($status -eq "true") { $connected = $true; break }
  Start-Sleep 3
}
if (-not $connected) { Write-Output "请确保 EasyEDA 已打开并加载 run-api-gateway 扩展" }
```

**确认 EDA 窗口**：

```powershell
# ⚠️ 用 Node.js fetch()
$windows = node -e "fetch('http://127.0.0.1:$BRIDGE_PORT/eda-windows').then(r=>r.json()).then(j=>console.log(j.length)).catch(()=>console.log('0'))" 2>$null
# 0 窗口 → 报错
# 1 窗口 → 自动选中
# 多窗口 → 列出让用户选
```

> **Node.js 发请求**：后续所有 `/execute` 调用优先用 Node.js `fetch()`，避免 PowerShell 的 JSON 序列化问题。

### Step 1: 打开目标 PCB

用户提供 PCB 名称后，通过以下流程打开：

```javascript
// 1. 获取当前项目
const project = await eda.dmt_Project.getCurrentProjectInfo();

// 2. 遍历项目的 PCB 列表找目标
const boards = await eda.dmt_Board.getAllBoardsInfo();
// 或在 project.data 中找 itemType === "PCB" 且 name 匹配的

// 3. 打开 PCB 文档
const tabId = await eda.dmt_EditorControl.openDocument(pcbUuid);
```

**失败处理**：找不到 PCB → 列出所有可用 PCB 名称让用户确认。

### Step 2: 获取铜皮层列表

```javascript
// 获取 PCB 文档信息以确定层数
const doc = await eda.dmt_SelectControl.getCurrentDocumentInfo();
// 层列表: 1=TOP, 15=INNER_1, 16=INNER_2, ..., 2=BOTTOM
// 通过 pcb_Layer 或从项目中获取层配置
```

**铜皮层判定**：只处理 `layer === 1`（TOP）、`layer === 2`（BOTTOM）以及所有内电层（INNER_1 = 15 开始递增）。跳过丝印、阻焊、机械等非铜层。

---

## 主流程：逐层生成铜皮

对每个铜皮层执行以下步骤：

### A. 获取图元

```javascript
const allLines = await eda.pcb_PrimitiveLine.getAll();
const allArcs = await eda.pcb_PrimitiveArc.getAll();

// 过滤当前层 + 2mil 直线 + 不限宽度弧线
const lines = allLines.filter(l => l.layer === LAYER_ID && l.lineWidth === 2);
const arcs = allArcs.filter(a => a.layer === LAYER_ID);
// ⚠️ 弧线不限宽度！实际可能是 10mil 而非 2mil
```

**弧线数据兼容两种 EasyEDA 版本**（直接属性优先，getter 兜底）：

```javascript
arcs.map(a => ({
  id: a.primitiveId, type: 'A',
  sx: a.startX !== undefined ? a.startX : a.getState_StartX(),
  sy: a.startY !== undefined ? a.startY : a.getState_StartY(),
  ex: a.endX !== undefined ? a.endX : a.getState_EndX(),
  ey: a.endY !== undefined ? a.endY : a.getState_EndY(),
  arcAngle: a.arcAngle !== undefined ? a.arcAngle : a.getState_ArcAngle(),
  width: a.lineWidth !== undefined ? a.lineWidth : a.getState_LineWidth()
}))
```

### B. 构建端点邻接图

```javascript
const exactKey = (x, y) => Math.round(x * 10) / 10 + ',' + Math.round(y * 10) / 10;
const adj = new Map();

for (const seg of [...lines, ...arcs]) {
  const s = exactKey(seg.sx, seg.sy);
  const e = exactKey(seg.ex, seg.ey);
  if (s === e) continue;  // 跳过零长度
  if (!adj.has(s)) adj.set(s, []);
  if (!adj.has(e)) adj.set(e, []);
  adj.get(s).push({ other: e, seg });
  adj.get(e).push({ other: s, seg });
}
```

> ⚠️ **精度用 `*10`（0.1mil），不是 `*100`**。直线坐标含 2 位小数（如 `55721.52`），弧线坐标只含 1 位小数（如 `55721.5`），用 `*100` 会导致 `"55721.5" ≠ "55721.52"`，弧线端点全部孤立无法参与轮廓检测。

### C. 查找闭合轮廓（含两个关键 bug fix）

```javascript
const visitedEdges = new Set();
const contours = [];
const edgeKey = (v1, v2, id) => [v1, v2].sort().join('|') + '|' + id;
const unsnap = (key) => key.split(',').map(Number);

for (const [startVertex, neighbors] of adj) {
  for (const { other: neighbor, seg } of neighbors) {
    const ek = edgeKey(startVertex, neighbor, seg.id);
    if (visitedEdges.has(ek)) continue;

    const pathVertices = [startVertex];
    const pathEdges = [seg];           // ← FIX 1: 起始边也要存
    let current = neighbor;
    let prev = startVertex;
    let foundCycle = false;

    for (let step = 0; step < 10000; step++) {
      const nextOptions = adj.get(current).filter(n => n.other !== prev);
      if (nextOptions.length === 0) break;  // 死路
      if (nextOptions.length > 1) break;    // 分支点

      const next = nextOptions[0];
      if (next.other === startVertex) {
        foundCycle = true;
        pathVertices.push(current);   // ← FIX 2: 最后一个顶点不能漏
        pathEdges.push(next.seg);     // ← FIX 1: 闭合边不能漏
        for (let i = 0; i < pathVertices.length; i++) {
          const v1 = pathVertices[i];
          const v2 = (i + 1 < pathVertices.length) ? pathVertices[i + 1] : startVertex;
          visitedEdges.add(edgeKey(v1, v2, pathEdges[i].id));
        }
        break;
      }

      pathVertices.push(current);
      pathEdges.push(next.seg);
      prev = current;
      current = next.other;
    }

    if (foundCycle) {
      contours.push({ vertices: pathVertices.map(v => unsnap(v)), edges: pathEdges });
    }
  }
}
```

### D. 开口路径自动闭合

> 闭合轮廓检测完毕后，剩余未使用的边会被分析。若形成简单开口路径（2 个 degree=1 端点 + 其余 degree=2），自动在两端口之间添加直线闭合，生成铜皮。

```javascript
// 从未使用边中构建子图 → 找连通分量 → 找 degree=1 端点
// 简单开口路径：恰好 2 个端点，从一端走到另一端，加闭合边
const closeEdge = {
  id: '__close_' + contours.length, type: 'L',
  sx: lastPt[0], sy: lastPt[1], ex: firstPt[0], ey: firstPt[1],
};
contours.push({
  vertices: orderedVerts.map(v => unsnap(v)),
  edges: [...orderedEdges, closeEdge],
  _openClosed: true,
});
```

### E. 嵌套检测（点-in-多边形）⚠️ 默认关闭

> **仅当传入 `非铺铜` 关键词时才执行嵌套检测。默认情况下所有轮廓都生成铜皮。**

```javascript
function pointInPolygon(px, py, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i][0], yi = polygon[i][1];
    const xj = polygon[j][0], yj = polygon[j][1];
    if ((yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi)
      inside = !inside;
  }
  return inside;
}

// BBox 快速排除 → 精确检测
const nestedSet = new Set();
for (let i = 0; i < contours.length; i++) {
  for (let j = 0; j < contours.length; j++) {
    if (i === j) continue;
    // BBox 包含检查
    if (outerBBox[0] <= innerBBox[0] && outerBBox[1] <= innerBBox[1] &&
        outerBBox[2] >= innerBBox[2] && outerBBox[3] >= innerBBox[3]) {
      // 精确：所有内层顶点都在外层内
      if (innerPoints.every(p => pointInPolygon(p[0], p[1], outerPoints))) {
        nestedSet.add(i); break;  // 内层轮廓 → 跳过
      }
    }
  }
}
```

> 只跳过硬嵌套（完全被包含的）。外层正常生成铜皮，内层自动成为挖空区域。

### F. 构建 Polygon Source

**⚠️ 关键格式发现**：

```javascript
function buildPolySource(contour) {
  const pts = contour.vertices;
  const edges = contour.edges;
  const src = [];

  for (let i = 0; i < pts.length; i++) {
    const e = edges[i];
    const v = pts[i];
    if (e.type === 'L') {
      // 直线: x, y, 'L'
      src.push(Math.round(v[0]), Math.round(v[1]), 'L');
    } else {
      // 弧线: 判断遍历方向，逆向(vertex==arc.end)才取反
      const vKey = exactKey(v[0], v[1]);
      const segStartKey = exactKey(e.sx, e.sy);
      const forward = vKey === segStartKey;
      const angle = forward ? e.arcAngle : -e.arcAngle;
      src.push(Math.round(v[0]), Math.round(v[1]), 'ARC', Math.round(angle));
    }
  }
  // 闭合：末尾加第一个点
  src.push(Math.round(pts[0][0]), Math.round(pts[0][1]));
  return src;
}
```

**ARC 方向要点**：
- 轮廓 walk 可能正向（vertex==arc.start）或逆向（vertex==arc.end）遍历弧线
- 正向用原角度 `e.arcAngle`，逆向才取反 `-e.arcAngle`
- 之前一律取反导致正向遍历的弧线弯向反方向

### G. 生成铜皮

```javascript
const polySource = buildPolySource(contour);

const createCode = `
const polySource = ${JSON.stringify(polySource)};
const polygon = eda.pcb_MathPolygon.createPolygon(polySource);
if (!polygon) { return JSON.stringify({ err: "polygon failed" }); }
const pour = await eda.pcb_PrimitivePour.create(
  "",           // net: 无网络
  ${LAYER_ID},  // layer
  polygon,
  "solid",      // pourFillMethod: 实心
  false,        // preserveSilos
  "Pour_${LAYER_NAME}_C${idx}",  // pourName
  0,            // pourPriority
  10,           // lineWidth: 10mil
  false         // primitiveLock
);
if (!pour) { return JSON.stringify({ err: "pour failed" }); }
return JSON.stringify({ ok: true, id: pour.primitiveId });
`;
```

---

## 输出总结

```
=== EasyEDA Poly 完成 ===

PCB: 03021080  铜皮层: 2 层
嵌套检测: 关闭 (所有轮廓)

TOP (layer 1):
  34 轮廓 → 34 铜皮生成 ✓

BOTTOM (layer 2):
  33 轮廓 → 33 铜皮生成 ✓

总计: 67 铜皮
失败: 0
```

非铺铜模式（开启嵌套检测）：
```
=== EasyEDA Poly 完成 ===

PCB: 03021080  铜皮层: 2 层
嵌套检测: 开启 (跳过内层)

TOP (layer 1):
  34 轮廓 → 7 内层跳过 → 27 铜皮生成 ✓

BOTTOM (layer 2):
  33 轮廓 → 7 内层跳过 → 26 铜皮生成 ✓

总计: 53 铜皮
失败: 0
```

如有失败，列出：
```
失败清单:
  - Pour_TOP_C3: createPolygon failed
  - Pour_BOTTOM_C12: timeout
```

---

## 已验证的关键经验

| # | 教训 | 说明 |
|---|------|------|
| 1 | **弧线必须包含** | 仅用直线 → 11 轮廓；加弧线 → 34 轮廓 |
| 2 | **弧线宽度不限** | 弧线可能是 10mil，不是 2mil |
| 3 | **弧线兼容不同 EDA 版本** | 直接属性优先 `a.startX`，getter `a.getState_StartX()` 兜底，兼容不同 EasyEDA 版本 |
| 4 | **ARC 方向** | 正向用 `e.arcAngle`，逆向用 `-e.arcAngle`，取决于 path vertex 是否匹配 arc.start |
| 5 | **最后顶点 fix** | `pathVertices.push(current)` 在找到环时必须加 |
| 6 | **闭合边 fix** | `pathEdges.push(next.seg)` 闭合边必须存 |
| 7 | **端点精度 0.1mil** | `exactKey` 必须用 `*10`（0.1mil），不能用 `*100`。直线坐标含 2 位小数、弧线只含 1 位小数，精度不匹配会导致弧线端点全部无法匹配直线端点 |
| 8 | **Node.js 发请求** | 避免 PowerShell ConvertTo-Json 的字符串包装问题 |
| 9 | **枚举不可用** | bridge 执行上下文中 `EPCB_LayerId` 等枚举不存在，用数值 |
| 10 | **createPolygon 后再 createPour** | 两步分开，先建 polygon 对象再传 |
| 11 | **开口路径自动闭合** | 剩余未用边中找 degree=1 端点的简单路径，两端自动连线封闭 |
| 12 | **ARC 铜皮确实有效** | `createPolygon` + `createPour` 完全支持 ARC 段，之前失败只因端点没匹配上，不是格式问题 |

## 执行

Skill 启动并完成前置步骤后，用 Node.js 执行主脚本：

```powershell
# 默认：所有轮廓生成铜皮（嵌套检测关闭）
node $env:USERPROFILE\.claude\skills\easyeda-poly\generate.mjs $BRIDGE_PORT "PCB名称"

# 非铺铜模式：开启嵌套检测，跳过内层轮廓
node $env:USERPROFILE\.claude\skills\easyeda-poly\generate.mjs $BRIDGE_PORT "PCB名称" 非铺铜
```

脚本自动完成：打开 PCB → 获取铜皮层 → 逐层分析轮廓 → (可选)嵌套检测 → 生成铜皮 → 删除原线条 → 输出总结。

## 坐标单位

| 域 | 单位 |
|------|------|
| PCB | 1mil |
