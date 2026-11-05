# FFmpeg 随包分发

本应用使用 `ffmpeg-static` 与 `ffprobe-static`，不依赖系统 PATH 里的 ffmpeg。

## 开发

`yarn` 会下载当前平台二进制。主进程通过 `createRequire` 取路径：

```ts
require('ffmpeg-static')
require('ffprobe-static').path
```

## 打包

1. [`vite.main.config.ts`](../vite.main.config.ts) external 这两个包，避免 Vite 打坏二进制引用。
2. [`forge/native.ts`](../forge/native.ts) 在 `packageAfterCopy` 拷贝整个包目录。
3. [`forge.config.ts`](../forge.config.ts) `asar.unpack` 解出 `node_modules/{ffmpeg-static,ffprobe-static}/**`。
4. [`src/main/media.ts`](../src/main/media.ts) 将 `app.asar` 替换为 `app.asar.unpacked` 后再 `spawn`。

签名时需覆盖 unpacked 目录中的可执行文件（Forge 默认签名流程一般会扫到）。
