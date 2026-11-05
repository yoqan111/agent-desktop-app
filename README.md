# Video Studio

桌面视频工具：格式转换与画面裁剪。Electron 44、Forge、Vite、React，FFmpeg 经 `ffmpeg-static` / `ffprobe-static` 随包分发。

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

## 功能

- 转换：`mp4` / `webm` / `mov` / `mkv`，先生成临时预览，再手动导出
- 裁剪：像素区域 + 可选起止秒，同样先预览再导出

处理结果默认写在系统临时目录，不会自动覆盖或写入源文件旁。确认后通过「导出到本地」选择保存路径。

## 目录

```text
src/main.ts              生命周期与 IPC
src/main/media.ts        FFmpeg 探测 / 转换 / 裁剪
src/main/windows.ts      窗口
src/preload.ts           window.media
src/renderer/            Video Studio 界面
src/shared/media.ts      媒体协议
src/updater.ts           自动升级（可选）
forge.config.ts          打包；解包 ffmpeg 二进制
forge/native.ts          packageAfterCopy 拷贝 runtime 包
```

方案说明见 [docs/方案设计.md](docs/方案设计.md)。媒体打包见 [docs/media-packaging.md](docs/media-packaging.md)。

## 签名与升级

复制 `.env.example` 为 `.env`，在打包或发布时填入证书和更新地址。本地 `yarn start` 不签名，也不检查更新。
