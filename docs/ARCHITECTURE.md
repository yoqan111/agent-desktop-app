# MediaDo 架构（Feature Module）

## 目标

按独立功能模块划分代码，当前为 **Media** 与 **Playwright Studio**，后续新能力复制 `features/<name>/` 模板接入。

## 目录

```text
src/
├── app/                 # 应用壳：生命周期、窗口、preload 聚合、产品模式切换
├── features/
│   ├── media/           # 媒体处理（含导出支付）
│   └── playwright-studio/  # 浏览器自动化 + Agent
├── platform/            # MCP、tools 聚合、主进程 confirm
└── shared/              # 跨 feature 真公共（confirm、updater、ui）
```

每个 feature 约定：

| 路径 | 职责 |
| --- | --- |
| `main/` + `main/index.ts` | 主进程实现与对外 API（**禁止**被 renderer 引用） |
| `renderer/` + `renderer/index.ts` | 功能 UI 对外 API（Vite 可安全打包） |
| `shared/` | IPC 契约与纯类型 |
| `index.ts` | 仅 shared 级常量/类型（可选） |

## 规则

1. **禁止** renderer 直接或间接 import `features/*/main/**`（会把 Electron/原生依赖打进渲染进程，导致黑屏）。
2. **禁止** feature 之间深层 import 对方私有文件；跨模块走 `main/index`、`renderer/index` 或 `src/shared/`。
3. **壳层**只做装配：`register*Ipc()`、生命周期、Welcome / 产品切换。
4. **platform/tools** 可依赖各 feature 的 main 实现（工具聚合层）。
5. IPC channel 名保持不变，降低 preload / renderer 风险。
6. CSS 暂未按 feature 拆分（`src/index.css`），后续可选。

## 新增模块清单

1. 新建 `src/features/<name>/{main,renderer,shared}` 及对应 `index.ts`
2. 实现 `registerXxxIpc()` 并在 `src/app/main.ts` 从 `features/<name>/main` 注册
3. 在 `src/app/preload.ts` 暴露 `window.<api>`
4. 在 `src/app/renderer/App.tsx` 从 `features/<name>/renderer` 挂入口
5. 如需 MCP：在 `platform/tools.ts` 注册工具
