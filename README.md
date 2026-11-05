# MediaDo

本地媒体处理与浏览器自动化桌面应用。Electron 44、Forge、Vite、React；媒体能力基于随包分发的 `ffmpeg-static` / `ffprobe-static`，自动化基于 `@playwright/test`。

首页拆成两条独立能力线：

- **媒体处理**：视频 / 图片 / 音频本地工具台
- **浏览器自动化**：Playwright Studio（录制、管理、回放），与媒体素材无关

## 开发

```bash
yarn
yarn start
```

| 命令 | 作用 |
| --- | --- |
| `yarn start` | 启动应用 |
| `yarn package` | 打包 |
| `yarn make` | 生成安装包 |
| `yarn publish` | 按环境变量发布 |
| `yarn lint` | TypeScript / ESLint |

## 媒体处理

处理结果默认写在系统临时目录，不自动覆盖源文件。确认后通过「导出到本地」选择保存路径。

### 视频

- 可视化裁剪（画面框选 + 时间轴）
- 格式转换（`mp4` / `webm` / `mov` / `mkv` 等）
- 视频转 GIF
- 转高清（ffmpeg 放大锐化；预留 AI 引擎）
- 去水印（框选区域抹除）
- 视频调整（旋转、比例、变速、压缩、台标、响度等组合）

### 图片

- 可视化裁剪
- 格式转换
- 转高清
- 去水印
- 压缩体积
- 旋转 / 镜像
- 改比例（16:9 / 1:1 / 9:16）
- 缩放尺寸
- 文字 / 台标

### 音频

- 时间裁剪（波形选区）
- 格式转换
- 音频降噪
- 音量标准化

## Playwright Studio

独立工作区，用于录制浏览器操作路径、管理脚本并回放。

- Codegen 录制，生成 Playwright 测试脚本
- 支持 Chromium / 本机 Chrome / Edge / Firefox / WebKit
- 回放模式：有头 / 无头 / UI / Debug
- **复用持久登录目录**：Studio 专用 `user-data-dir`，同浏览器下次录制可免登
- **保存 / 加载登录态**：`storageState`，供无痕回放带 Cookie
- 「安装浏览器」会同时补齐 Playwright 自带的 `ffmpeg`（失败视频依赖）
- **产物面板**：失败回放保留 Trace / 截图 / 视频，可一键打开 Trace Viewer
- **断言助手**：一键向脚本插入 `expect` 模板（URL / Title / Body）
- **页面采集**：对起始 URL 截图或导出 PDF，归档到产物目录
- **批量回放**：勾选多条工作流顺序执行
- **简易定时**：按间隔分钟自动批量回放（应用保持运行时生效）

## Agent / MCP

应用启动后会在本机开放 MCP（Streamable HTTP），外部 Agent 可调用媒体与 Playwright 工具；处理仍在本应用内完成。

```text
MediaDo MCP http://127.0.0.1:47321/mcp
```

地址也会写入用户数据目录的 `mcp.json`。端口占用时顺延；可用 `MEDIA_STUDIO_MCP_PORT` 固定端口。

媒体类工具（节选）：`media_grant`、`media_probe`、`media_convert`、`media_crop`、`media_gif`、`media_enhance_hd`、`media_denoise_audio`、`media_remove_watermark`、`media_adjust` 等。

Playwright 类工具：`playwright_record`、`playwright_play`、`playwright_play_batch`、`playwright_inject_asserts`、`playwright_capture`、`playwright_get_schedule` / `playwright_set_schedule`、`playwright_list`、`playwright_install_browsers` 等。

外部 Agent 访问本地文件前需先 `media_grant`，由用户在弹窗中确认。完整说明见 [docs/agent-mcp.md](docs/agent-mcp.md)。

## 目录

```text
src/main.ts                     生命周期、IPC、MCP 启动
src/main/media.ts               FFmpeg 探测与媒体处理
src/main/playwright-studio.ts   Playwright 录制 / 回放 / 浏览器安装
src/main/tools.ts               MCP / Agent 工具声明
src/main/mcp-server.ts          本机 MCP 服务
src/main/windows.ts             窗口
src/preload.ts                  window.media / playwright
src/renderer/                   MediaDo UI + Playwright Studio
src/renderer/components/WelcomeScreen.tsx   首页（媒体与自动化分区）
src/shared/media.ts             媒体协议
src/shared/playwright.ts        Playwright 协议
src/updater.ts                  自动升级（可选）
forge.config.ts                 打包；解包 ffmpeg 二进制
forge/native.ts                 packageAfterCopy 拷贝 runtime 包
```

方案说明见 [docs/方案设计.md](docs/方案设计.md)。媒体打包见 [docs/media-packaging.md](docs/media-packaging.md)。Agent 接入见 [docs/agent-mcp.md](docs/agent-mcp.md)。

## 签名与升级

复制 `.env.example` 为 `.env`，在打包或发布时填入证书和更新地址。本地 `yarn start` 不签名，也不检查更新。
