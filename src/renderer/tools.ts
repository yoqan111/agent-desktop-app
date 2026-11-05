import type { MediaKind } from '../shared/media';

export type ToolTab = 'convert' | 'crop' | 'gif' | 'enhance' | 'denoise' | 'watermark'
  | 'compress' | 'orient' | 'aspect' | 'speed' | 'extract' | 'frame' | 'stamp' | 'resize' | 'loudnorm'
  | 'adjust';

export function kindLabel(kind: MediaKind): string {
  if (kind === 'image') return '图片';
  if (kind === 'audio') return '音频';
  return '视频';
}

export function toolsForKind(kind: MediaKind): ToolTab[] {
  if (kind === 'video') {
    return ['crop', 'convert', 'gif', 'enhance', 'watermark', 'adjust'];
  }
  if (kind === 'image') {
    return ['crop', 'convert', 'enhance', 'watermark', 'compress', 'orient', 'aspect', 'resize', 'stamp'];
  }
  return ['crop', 'convert', 'denoise', 'loudnorm'];
}

export function toolTitle(kind: MediaKind, tab: ToolTab): string {
  if (tab === 'gif') return '视频转 GIF';
  if (tab === 'convert') return '格式转换';
  if (tab === 'enhance') return '转高清';
  if (tab === 'denoise') return '音频降噪';
  if (tab === 'watermark') return '去水印';
  if (tab === 'compress') return '压缩体积';
  if (tab === 'orient') return '旋转 / 镜像';
  if (tab === 'aspect') return '改比例';
  if (tab === 'speed') return '变速';
  if (tab === 'extract') return '提取音频 / 静音';
  if (tab === 'frame') return '截取一帧';
  if (tab === 'stamp') return '文字 / 台标';
  if (tab === 'resize') return '缩放尺寸';
  if (tab === 'loudnorm') return '音量标准化';
  if (tab === 'adjust') return '视频调整';
  if (kind === 'audio') return '时间裁剪';
  return '可视化裁剪';
}

export function toolSubtitle(kind: MediaKind, tab: ToolTab): string {
  if (tab === 'gif') return '设置帧率与宽度后生成 GIF 预览，再决定是否导出。';
  if (tab === 'convert') return '选择目标格式后生成预览，再决定是否导出。';
  if (tab === 'enhance') return '轻量放大锐化提升清晰度；后续可切换 AI 超分。';
  if (tab === 'denoise') return '频谱降噪清理底噪；强度可调，后续可切换 AI 降噪。';
  if (tab === 'watermark') return '框选水印区域后整段抹除；半透明或移动水印效果有限。';
  if (tab === 'compress') return '按画质档位缩小文件，适合分享或邮件。';
  if (tab === 'orient') return '顺时针旋转，或做水平、垂直翻转。';
  if (tab === 'aspect') return '居中裁成 16:9、1:1 或 9:16。';
  if (tab === 'speed') return '0.5×、1.5× 或 2×。默认可保持原来的音调。';
  if (tab === 'extract') return '抽出音轨，或去掉声音只保留画面。';
  if (tab === 'frame') return '按时间点导出一张封面图。';
  if (tab === 'stamp') return '烧录文字，或叠一张台标图片。';
  if (tab === 'resize') return '按宽度、高度或百分比缩放，保持比例。';
  if (tab === 'loudnorm') return '把忽大忽小的声音拉到统一响度。';
  if (tab === 'adjust') return '勾选旋转、比例、变速、压缩、台标、响度等，一次生成。';
  if (kind === 'audio') return '拖入或选择音频，在波形时间轴上拖拽选区。';
  if (kind === 'video') return '拖入或选择视频，拖拽画面裁剪框与时间轴选区。';
  return '拖入或选择图片，在预览上拖动裁剪框。';
}

export function toolNavLabel(kind: MediaKind, tab: ToolTab): string {
  if (tab === 'gif') return '转 GIF';
  if (tab === 'convert') return '格式转换';
  if (tab === 'enhance') return '转高清';
  if (tab === 'denoise') return '降噪';
  if (tab === 'watermark') return '去水印';
  if (tab === 'compress') return '压缩';
  if (tab === 'orient') return '旋转';
  if (tab === 'aspect') return '比例';
  if (tab === 'speed') return '变速';
  if (tab === 'extract') return '音频';
  if (tab === 'frame') return '截帧';
  if (tab === 'stamp') return '台标';
  if (tab === 'resize') return '缩放';
  if (tab === 'loudnorm') return '响度';
  if (tab === 'adjust') return '调整';
  if (kind === 'audio') return '时间裁剪';
  return '可视化裁剪';
}
