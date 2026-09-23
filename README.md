# thincoder-webui

**Codex 式 Web 客户端 for [thincoder](https://gitee.com/shanghai-xinbo/thincoder)** —— 在本地或局域网的浏览器里与 thincoder 编码 agent 对话、审批工具调用、审阅文件变更。

> **项目理念：简洁与方便。** 这是一个自用工具长成的开源项目——只做高频核心功能，把它们做透、做顺手；不常用的一律不堆砌。如果你也在找一个「打开浏览器就能盯着 agent 干活」的轻量工作台，它应该正合适。

## 项目背景

[thincoder](https://gitee.com/shanghai-xinbo/thincoder) 是一个零依赖 Node 编码 agent（终端 TUI 形态）。内核作者把权限设计成「由 UI 层决定问不问用户」（`onPermissionRequest` 回调），本项目就是接在那个缝上的**新 UI 层**：

- **不改内核**——全部工作 = 桥接层（`server/`，纯 Node 零第三方依赖）+ 前端（`web/`，React + Vite），通过动态 import 复用内核模块；
- 内核升级时桥接层做适配重对，WebUI 自身功能不随内核漂移。

## 功能一览

- **流式工作台**：SSE 事件流，工具调用全程可视（含子 agent、思考流、实时命令输出、任务进度）
- **审批三档 + Diff 审阅**（对齐 Codex）：Suggest / Auto Edit / Full Auto；write/edit/delete 审批前展示真实 unified diff（统一/并排视图）
- **会话管理**：列表 / 恢复 / 自动归档 / 归档删除，与终端 TUI 双向兼容；刷新页面时间线自动重建
- **会话回退与复制**：一键复制用户消息；可回退到「这条消息发出之前」——对话历史与期间的文件增删改一起撤销，回退本身还可撤销
- **子代理面板**：agent 派发的子任务在右侧独立面板逐条显示进度与完成报告，不混进对话流
- **任务面板与 Plan 模式**：右侧任务进度面板；PLAN 横幅 + 方案卡确认
- **配置中心**：供应商增删改/激活/连接测试（key 脱敏），写内核 `~/.thincoder/config.json`
- **用量看板**：每次 LLM 调用落库（node:sqlite），按日/按模型聚合
- **定时任务 / MCP 管理 / 追问建议 / 局域网手机访问（二维码）** 等辅助能力

## 环境要求

- **Node.js ≥ 22**
- [thincoder](https://gitee.com/shanghai-xinbo/thincoder) 内核（通过 npm 依赖自动安装，无需全局安装）
- 现代浏览器（Chrome / Edge / Safari / Firefox 均可）

## 快速开始

```bash
# 1. 安装依赖（含 thincoder 内核，postinstall 会自动给内核打一个兼容补丁）
npm install

# 2. 构建前端（产物输出到 server/static）
npm run build

# 3. 启动服务（默认 0.0.0.0:8181）
npm start
```

首次启动会生成持久访问 token（`~/.thincoder-webui/token`，权限 0600）。终端会打印登录链接，或手动拼：

```bash
cat ~/.thincoder-webui/token
# 浏览器打开 http://localhost:8181/login?token=<上一步的内容>
```

登录后：**添加项目目录（白名单制）→ 选一个模型供应商 → 发起对话**。局域网设备（如手机）访问 `http://<你的IP>:8181` 用同一 token 登录即可（登录页有二维码）。

## 安全须知

- 服务**默认监听 `0.0.0.0`**，局域网内任何知道 token 的人都能操作你的 agent——token 请妥善保管，不要部署到公网。
- agent 有文件读写与命令执行能力，审批档位（Suggest / Auto Edit / Full Auto）决定它多大程度自主行动，请按自己的信任程度选择。

## 免责声明

本项目按「现状」提供（MIT License，见 [LICENSE](./LICENSE)），不含任何明示或默示的担保。这是一个个人维护的开源工具，作者不对使用本项目造成的任何直接或间接损失负责；请自行评估在重要项目中使用 agent 的风险（代码变更可在审批弹窗逐条审阅）。

> 版本说明：本仓库版本号与作者内部开发仓保持同步，历史版本号可能不连续，属正常现象；更新内容见 [CHANGELOG.md](./CHANGELOG.md)。

## License

[MIT](./LICENSE)
