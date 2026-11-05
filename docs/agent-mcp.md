# 在其他 Agent 里使用 MediaDo

MediaDo 运行时会在本机开放一个 MCP 服务。其他 Agent 通过它调用转码、裁剪、GIF、放大、降噪、去水印、压缩、旋转、改比例、变速、提取音频、截帧、台标、响度标准化和缩放。处理仍在本应用里完成，Agent 不直接执行 FFmpeg。

应用没启动时，这个地址没有服务。

## 找到地址

启动应用后，终端会打印：

```text
MediaDo MCP http://127.0.0.1:47321/mcp
```

同一地址写在用户数据目录的 `mcp.json`：

```json
{
  "url": "http://127.0.0.1:47321/mcp",
  "name": "media-studio"
}
```

macOS 开发态通常是：

```text
~/Library/Application Support/agent-desktop-app/mcp.json
```

`47321` 被占用时会顺延，最多试 10 个端口。要用固定端口，启动前设置 `MEDIA_STUDIO_MCP_PORT`。以终端或 `mcp.json` 里的 `url` 为准。

## 接到 Cursor

在 Cursor 的 MCP 配置（用户级 `~/.cursor/mcp.json`，或项目级 `.cursor/mcp.json`）里加上：

```json
{
  "mcpServers": {
    "media-studio": {
      "url": "http://127.0.0.1:47321/mcp"
    }
  }
}
```

保存后在 Cursor Settings → MCP 里确认 `media-studio` 已连接，工具列表里能看到 `media_grant`、`media_probe` 等。端口变了就改这里的 `url`。

其他支持 Streamable HTTP MCP 的 Agent，把服务器地址设成同一个 `url` 即可。协议版本接受 `2025-03-26` 和 `2024-11-05`。

## 调用顺序

1. 应用保持打开。
2. 对用户给出的本地文件先调用 `media_grant`。应用会弹出「外部 Agent 请求处理这个文件」，用户点允许后才会读取。
3. 在界面里用「选择视频」打开过的文件已经允许，可以跳过 `media_grant`。
4. 处理类工具返回临时文件。下一步把上一步的 `tempPath` 当作 `input`。
5. 导出到用户指定位置、付款、检查更新不在这组工具里，回到 MediaDo 窗口操作。

用户点拒绝时，工具返回「用户拒绝了这个文件。」没授权的路径会返回「这个路径还没被用户允许。请先调用 media_grant。」

## 工具

路径都是绝对路径。结果里的临时文件在系统临时目录的 `video-studio` 下，应用退出时会删掉。

### media_grant

向用户确认一个本地文件。

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `path` | 是 | 本地绝对路径 |

返回 `{ granted: true, probe }`。`probe` 含 `kind`、`path`、`durationSec`、`width`、`height`、`videoCodec`、`audioCodec`、`formatName`、`sizeBytes`。

### media_probe

读取时长、分辨率、编码和大小。

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `path` | 是 | 已允许的文件，或本应用生成的临时文件 |
| `kind` | 否 | `video`、`image`、`audio` |

### media_convert

转换格式，结果写入临时文件。

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `kind` | 是 | `video`、`image`、`audio` |
| `input` | 是 | 已允许的路径 |
| `format` | 是 | 视频 `mp4` `webm` `mov` `mkv`；图片 `jpg` `png` `webp` `bmp`；音频 `mp3` `aac` `wav` `flac` `ogg` |

### media_crop

按像素矩形裁剪视频或图片。

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `kind` | 是 | `video` 或 `image` |
| `input` | 是 | 已允许的路径 |
| `x` `y` `width` `height` | 是 | 像素，宽高需落在画面内 |
| `startSec` `endSec` | 否 | 只处理这一段 |
| `format` | 否 | 与 `kind` 对应的视频或图片格式 |

### media_trim_audio

按秒裁剪音频。

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `input` | 是 | 已允许的路径 |
| `startSec` `endSec` | 否 | 结束时间必须大于开始时间 |
| `format` | 否 | `mp3` `aac` `wav` `flac` `ogg` |

### media_gif

把视频片段转成 GIF。

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `input` | 是 | 已允许的视频 |
| `fps` | 否 | 默认约 10 |
| `maxWidth` | 否 | 限制宽度，默认约 480 |
| `startSec` `endSec` | 否 | 只转换这一段 |

### media_enhance_hd

放大视频或图片。

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `kind` | 是 | `video` 或 `image` |
| `input` | 是 | 已允许的路径 |
| `target` | 否 | `2x`、`1080p`、`1440p`、`4k` |
| `format` | 否 | 与 `kind` 对应的格式 |
| `engine` | 否 | 目前使用 `ffmpeg` |

### media_denoise_audio

给音频降噪。

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `input` | 是 | 已允许的音频 |
| `strength` | 否 | `low`、`medium`、`high` |
| `startSec` `endSec` | 否 | 只处理这一段 |
| `format` | 否 | 音频格式 |
| `engine` | 否 | 目前使用 `ffmpeg` |

### media_remove_watermark

按像素矩形去除视频或图片上的水印（整段处理）。

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `kind` | 是 | `video` 或 `image` |
| `input` | 是 | 已允许的路径 |
| `x` `y` `width` `height` | 是 | 像素矩形，需落在画面内，且距边缘至少 1 像素 |
| `format` | 否 | 与 `kind` 对应的视频或图片格式 |
| `engine` | 否 | 目前使用 `ffmpeg`（`removelogo` 邻域填补，非马赛克遮盖） |

### media_compress

按档位压缩视频或图片。

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `kind` | 是 | `video` 或 `image` |
| `input` | 是 | 已允许的路径 |
| `preset` | 否 | `high`、`medium`、`small` |
| `format` | 否 | 与 `kind` 对应的格式 |

### media_orient

旋转或镜像。

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `kind` | 是 | `video` 或 `image` |
| `input` | 是 | 已允许的路径 |
| `op` | 是 | `rotate90`、`rotate180`、`rotate270`、`flipH`、`flipV` |
| `format` | 否 | 与 `kind` 对应的格式 |

### media_speed

变速视频。

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `input` | 是 | 已允许的视频 |
| `rate` | 是 | `0.5`、`1.5` 或 `2` |
| `changePitch` | 否 | `true` 时音调随速度变化；默认保持原音调 |
| `format` | 否 | 视频格式 |

### media_extract

提取音轨或静音。

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `input` | 是 | 已允许的视频 |
| `mode` | 是 | `audio` 抽出音轨，`mute` 去掉声音 |
| `format` | 否 | 音频格式或视频格式，随 `mode` 而定 |

### media_snapshot

截取一帧。

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `input` | 是 | 已允许的视频 |
| `timeSec` | 否 | 秒，默认 0 |
| `format` | 否 | `jpg` `png` `webp` `bmp` |

### media_aspect

居中裁成指定比例。

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `kind` | 是 | `video` 或 `image` |
| `input` | 是 | 已允许的路径 |
| `ratio` | 是 | `16:9`、`1:1`、`9:16` |
| `format` | 否 | 与 `kind` 对应的格式 |

### media_stamp

烧录文字或叠加台标。

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `kind` | 是 | `video` 或 `image` |
| `input` | 是 | 已允许的路径 |
| `mode` | 是 | `text` 或 `logo` |
| `text` | 文字时必填 | 要烧录的文字 |
| `logo` | 台标时必填 | 已允许的图片路径 |
| `position` | 否 | `tl`、`tr`、`bl`、`br`、`center` |
| `format` | 否 | 与 `kind` 对应的格式 |

### media_loudnorm

响度标准化到约 -16 LUFS。

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `kind` | 是 | `video` 或 `audio` |
| `input` | 是 | 已允许的路径 |
| `format` | 否 | 与 `kind` 对应的格式 |

### media_resize

按一边或百分比缩放图片。

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `input` | 是 | 已允许的图片 |
| `mode` | 是 | `width`、`height`、`percent` |
| `value` | 是 | 像素或百分比（1–400） |
| `format` | 否 | 图片格式 |

### media_adjust

把多项视频调整合成一次处理。没传的字段不生效。

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `input` | 是 | 已允许的视频 |
| `output` | 否 | `video`（默认）、`audio` 只出音轨、`frame` 只截一帧 |
| `orient` | 否 | `rotate90`、`rotate180`、`rotate270`、`flipH`、`flipV` |
| `ratio` | 否 | `16:9`、`1:1`、`9:16` |
| `rate` | 否 | `0.5`、`1.5`、`2` |
| `changePitch` | 否 | 变速时是否同时变调 |
| `preset` | 否 | `high`、`medium`、`small` |
| `mute` | 否 | 去掉声音 |
| `loudnorm` | 否 | 响度标准化 |
| `timeSec` | 否 | `output=frame` 时的秒数 |
| `stampMode` | 否 | `text` 或 `logo` |
| `text` / `logo` / `position` | 否 | 台标内容与位置 |
| `format` | 否 | 随输出类型选择视频、音频或图片格式 |

处理类工具成功时返回：

```json
{
  "tempPath": "/var/folders/.../video-studio/....mp4",
  "suggestedName": "clip_converted.mp4",
  "format": "mp4",
  "kind": "video"
}
```

失败时 MCP 的 `isError` 为 `true`，文本是错误原因。

## 让 Agent 怎么说

接好 MCP 后，可以直接说：

```text
用 MediaDo 处理 /Users/me/Desktop/clip.mov：
先请求用户授权，再裁成从第 2 秒到第 8 秒、宽 1280 高 720，
最后转成 GIF。把临时文件路径告诉我，先不要导出。
```

Agent 应依次调用 `media_grant`、`media_crop`、`media_gif`，并把 `media_crop` 返回的 `tempPath` 传给 `media_gif`。授权弹窗出现时，在 MediaDo 窗口点「允许」。
