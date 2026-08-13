# EasyEDA 自动化 Skills 合集

基于 **EasyEDA（嘉立创EDA）** 的自动化技能集，通过 Claude Code 驱动 EasyEDA Bridge，实现原理图/PCB 的自动化操作。

本仓库包含三个互相配合的 Skill：

| Skill | 功能 | 触发方式 |
|-------|------|----------|
| [easyeda-bom-placement](./easyeda-bom-placement/) | 读取用户提供的 BOM Excel，分类器件、搜索 EasyEDA 库，批量放置到原理图 | "找器件" / "BOM放置" / "导入BOM" |
| [easyeda-poly](./easyeda-poly/) | 分析 PCB 铜层，从 2mil 轮廓线 + 弧线识别闭合轮廓，自动生成铜皮 | "/ez-poly" / "生成铜皮" / "轮廓铺铜" |
| [easyeda-cb](./easyeda-cb/) | 抄板全流程调度：轮廓铺铜 + 丝印匹配 + BOM 器件放置，一键完成 | "/easyeda-cb <pcb名称> <bom路径>" |

## 快速开始

1. 将对应 skill 文件夹放到 Claude Code 的 skills 目录（如 `~/.claude/skills/`）
2. 安装依赖（easyeda-bom-placement）：
   ```bash
   cd easyeda-bom-placement
   npm install
   ```
3. 启动 EasyEDA Bridge，连接 EasyEDA 客户端，即可触发对应 skill

## 环境要求

- Claude Code
- EasyEDA（嘉立创EDA）桌面客户端 + Bridge 服务
- Node.js
- Windows（脚本针对 Git Bash / PowerShell 环境编写）

## 说明

- `easyeda-bom-placement` 使用 `xlsx-populate` 原地修改 BOM 文件，避免格式传播问题
- 所有 Skill 均支持自动提权模式，流程执行不弹确认框
