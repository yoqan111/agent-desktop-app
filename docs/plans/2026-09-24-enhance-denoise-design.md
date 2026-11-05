# 转高清 / 音频降噪

> 状态：已批准（方案 3）  
> 日期：2026-09-24

- 视频/图片「转高清」：ffmpeg lanczos scale + unsharp；目标 2x / 1080p / 1440p / 4k；`engine` 预留 `ai`
- 音频「降噪」：ffmpeg `afftdn`；强度弱/中/强；`engine` 预留 `ai`
