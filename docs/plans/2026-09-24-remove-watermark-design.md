# Remove Watermark Design

**Date:** 2026-09-24  
**Status:** Approved

## Summary

Add image/video watermark removal via region selection + ffmpeg `delogo`. Full-clip for video (no time trim in v1). MCP tool `media_remove_watermark`. Free preview, paid export unchanged.

## Request

```ts
RemoveWatermarkRequest {
  kind: 'video' | 'image'
  input: string
  x, y, width, height: number
  format?: VideoFormat | ImageFormat
  engine?: 'ffmpeg' | 'ai'  // v1: ffmpeg only
}
```

## Pipeline

UI CropEditor → IPC `media:removeWatermark` → `callTool('media_remove_watermark')` → `removeWatermark()` → `-vf delogo=x:y:w:h` → temp `_nowm` → preview → export

## Constraints

- Rect inside frame; width/height ≥ 2; ≥1px margin from edges
- Algorithm: ffmpeg `removelogo` with soft mask (neighbor fill). Not mosaic/blur cover; not `delogo` cross-hatch.
- `engine=ai` throws not-yet-available
- Docs: `docs/agent-mcp.md`
