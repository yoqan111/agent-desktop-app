import {
  changeSpeed,
  compressMedia,
  convertMedia,
  cropMedia,
  denoiseAudio,
  enhanceHd,
  extractMedia,
  fitAspect,
  normalizeLoudness,
  orientMedia,
  probeMedia,
  removeWatermark,
  resizeImage,
  snapshotFrame,
  stampMedia,
  trimAudio,
  videoToGif,
  adjustVideo,
} from './media';
import { assertAgentPath, grantInput } from './access';
import { askUserConfirm } from './confirm';
import {
  capturePage,
  compareBaseline,
  createWorkflowFromScript,
  deleteArtifact,
  deleteWorkflow,
  getBaseline,
  getSchedule,
  getStudioStatus,
  getWorkflow,
  injectAsserts,
  installBrowsers,
  listArtifacts,
  listWorkflows,
  openTrace,
  playBatch,
  playWorkflow,
  revealArtifact,
  listScriptSteps,
  runWithParams,
  saveBaseline,
  saveReport,
  setSchedule,
  startRecord,
  stopJob,
  updateWorkflow,
} from './playwright-studio';
import type {
  AspectRatio,
  AspectRequest,
  AudioFormat,
  CompressPreset,
  CompressRequest,
  ConvertRequest,
  CropRequest,
  DenoiseAudioRequest,
  DenoiseStrength,
  EnhanceEngine,
  EnhanceHdRequest,
  ExtractMode,
  ExtractRequest,
  GifRequest,
  HdTarget,
  ImageFormat,
  LoudnormRequest,
  MediaKind,
  MediaProgressEvent,
  OrientOp,
  OrientRequest,
  RemoveWatermarkRequest,
  ResizeMode,
  ResizeRequest,
  SnapshotRequest,
  SpeedRate,
  SpeedRequest,
  StampPosition,
  StampRequest,
  TrimAudioRequest,
  VideoAdjustOutput,
  VideoAdjustRequest,
  VideoFormat,
} from '../shared/media';
import {
  ASPECT_RATIOS,
  AUDIO_FORMATS,
  COMPRESS_PRESETS,
  DENOISE_STRENGTHS,
  HD_TARGETS,
  IMAGE_FORMATS,
  ORIENT_OPS,
  RESIZE_MODES,
  SPEED_RATES,
  STAMP_POSITIONS,
  VIDEO_FORMATS,
} from '../shared/media';
import {
  PLAYWRIGHT_ASSERT_TEMPLATES,
  PLAYWRIGHT_AUTH_BEFORE_PLAY,
  PLAYWRIGHT_BROWSERS,
  PLAYWRIGHT_DEVICES,
  PLAYWRIGHT_RUN_MODES,
} from '../shared/playwright';
import type {
  PlaywrightAssertTemplate,
  PlaywrightAuthBeforePlay,
  PlaywrightBrowser,
  PlaywrightCaptureKind,
  PlaywrightRunMode,
} from '../shared/playwright';

export interface ToolContext {
  source: 'ui' | 'agent';
  onProgress?: (event: MediaProgressEvent) => void;
}

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (args: unknown, ctx: ToolContext) => Promise<unknown>;
}

const kindSchema = { type: 'string', enum: ['video', 'image', 'audio'] };
const videoFormatSchema = { type: 'string', enum: VIDEO_FORMATS };
const imageFormatSchema = { type: 'string', enum: IMAGE_FORMATS };
const audioFormatSchema = { type: 'string', enum: AUDIO_FORMATS };
const pathSchema = { type: 'string', description: '绝对路径。用户已允许的文件，或本应用生成的临时文件。' };

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('参数必须是对象。');
  }
  return value as Record<string, unknown>;
}

function requiredString(obj: Record<string, unknown>, key: string): string {
  const value = obj[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${key} 必须是非空字符串。`);
  }
  return value;
}

function optionalString(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key];
  if (value == null || value === '') {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new Error(`${key} 必须是字符串。`);
  }
  return value;
}

function optionalNumber(obj: Record<string, unknown>, key: string): number | undefined {
  const value = obj[key];
  if (value == null || value === '') {
    return undefined;
  }
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) {
    throw new Error(`${key} 必须是数字。`);
  }
  return number;
}

function optionalBoolean(obj: Record<string, unknown>, key: string): boolean | undefined {
  const value = obj[key];
  if (value == null || value === '') {
    return undefined;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${key} 必须是布尔值。`);
}

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[], label: string): T | undefined {
  if (value == null) {
    return undefined;
  }
  if ((allowed as readonly string[]).includes(value)) {
    return value as T;
  }
  throw new Error(`${label}不支持：${value}`);
}

function resolveInput(filePath: string, ctx: ToolContext): string {
  if (ctx.source === 'agent') {
    return assertAgentPath(filePath);
  }
  return filePath;
}

const tools: ToolDefinition[] = [
  {
    name: 'media_grant',
    description: '向用户确认后，允许后续工具处理这个本地文件。确认前不会读取内容。',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: '要处理的本地绝对路径。' } },
      required: ['path'],
      additionalProperties: false,
    },
    run: async (args) => {
      const pathValue = requiredString(asObject(args), 'path');
      const allowed = await askUserConfirm({
        title: '外部 Agent 请求处理这个文件',
        message: pathValue,
        confirmLabel: '允许',
        cancelLabel: '拒绝',
        danger: false,
      });
      if (!allowed) {
        throw new Error('用户拒绝了这个文件。');
      }
      const probe = await probeMedia(pathValue);
      grantInput(probe.path);
      return { granted: true, probe };
    },
  },
  {
    name: 'media_probe',
    description: '读取视频、图片或音频的宽高、分辨率、码率、精确时长、帧率、编码和大小。',
    inputSchema: {
      type: 'object',
      properties: {
        path: pathSchema,
        kind: kindSchema,
      },
      required: ['path'],
      additionalProperties: false,
    },
    run: (args, ctx) => {
      const obj = asObject(args);
      const kind = oneOf(optionalString(obj, 'kind'), ['video', 'image', 'audio'] as const, '类型');
      return probeMedia(resolveInput(requiredString(obj, 'path'), ctx), kind as MediaKind | undefined);
    },
  },
  {
    name: 'media_convert',
    description: '转换视频、图片或音频格式，结果写到临时文件。',
    inputSchema: {
      type: 'object',
      properties: {
        kind: kindSchema,
        input: pathSchema,
        format: { type: 'string', description: '视频 mp4/webm/mov/mkv，图片 jpg/png/webp/bmp，音频 mp3/aac/wav/flac/ogg。' },
      },
      required: ['kind', 'input', 'format'],
      additionalProperties: false,
    },
    run: (args, ctx) => {
      const obj = asObject(args);
      const request: ConvertRequest = {
        kind: oneOf(requiredString(obj, 'kind'), ['video', 'image', 'audio'] as const, '类型') as MediaKind,
        input: resolveInput(requiredString(obj, 'input'), ctx),
        format: requiredString(obj, 'format') as VideoFormat | ImageFormat | AudioFormat,
      };
      return convertMedia(request, ctx.onProgress);
    },
  },
  {
    name: 'media_crop',
    description: '按像素矩形裁剪视频或图片，可选起止秒。结果写到临时文件。',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['video', 'image'] },
        input: pathSchema,
        x: { type: 'number' },
        y: { type: 'number' },
        width: { type: 'number' },
        height: { type: 'number' },
        startSec: { type: 'number' },
        endSec: { type: 'number' },
        format: { anyOf: [videoFormatSchema, imageFormatSchema] },
      },
      required: ['kind', 'input', 'x', 'y', 'width', 'height'],
      additionalProperties: false,
    },
    run: (args, ctx) => {
      const obj = asObject(args);
      const request: CropRequest = {
        kind: oneOf(requiredString(obj, 'kind'), ['video', 'image'] as const, '类型') as 'video' | 'image',
        input: resolveInput(requiredString(obj, 'input'), ctx),
        x: optionalNumber(obj, 'x') ?? Number.NaN,
        y: optionalNumber(obj, 'y') ?? Number.NaN,
        width: optionalNumber(obj, 'width') ?? Number.NaN,
        height: optionalNumber(obj, 'height') ?? Number.NaN,
        startSec: optionalNumber(obj, 'startSec'),
        endSec: optionalNumber(obj, 'endSec'),
        format: oneOf(
          optionalString(obj, 'format'),
          [...VIDEO_FORMATS, ...IMAGE_FORMATS],
          '格式',
        ) as VideoFormat | ImageFormat | undefined,
      };
      if (![request.x, request.y, request.width, request.height].every(Number.isFinite)) {
        throw new Error('裁剪区域必须是数字。');
      }
      return cropMedia(request, ctx.onProgress);
    },
  },
  {
    name: 'media_trim_audio',
    description: '按起止秒裁剪音频。结果写到临时文件。',
    inputSchema: {
      type: 'object',
      properties: {
        input: pathSchema,
        startSec: { type: 'number' },
        endSec: { type: 'number' },
        format: audioFormatSchema,
      },
      required: ['input'],
      additionalProperties: false,
    },
    run: (args, ctx) => {
      const obj = asObject(args);
      const request: TrimAudioRequest = {
        input: resolveInput(requiredString(obj, 'input'), ctx),
        startSec: optionalNumber(obj, 'startSec'),
        endSec: optionalNumber(obj, 'endSec'),
        format: oneOf(optionalString(obj, 'format'), AUDIO_FORMATS, '格式'),
      };
      return trimAudio(request, ctx.onProgress);
    },
  },
  {
    name: 'media_gif',
    description: '把视频片段转成 GIF。结果写到临时文件。',
    inputSchema: {
      type: 'object',
      properties: {
        input: pathSchema,
        fps: { type: 'number' },
        maxWidth: { type: 'number' },
        startSec: { type: 'number' },
        endSec: { type: 'number' },
      },
      required: ['input'],
      additionalProperties: false,
    },
    run: (args, ctx) => {
      const obj = asObject(args);
      const request: GifRequest = {
        input: resolveInput(requiredString(obj, 'input'), ctx),
        fps: optionalNumber(obj, 'fps'),
        maxWidth: optionalNumber(obj, 'maxWidth'),
        startSec: optionalNumber(obj, 'startSec'),
        endSec: optionalNumber(obj, 'endSec'),
      };
      return videoToGif(request, ctx.onProgress);
    },
  },
  {
    name: 'media_enhance_hd',
    description: '把视频或图片放大到 2x、1080p、1440p 或 4k。结果写到临时文件。',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['video', 'image'] },
        input: pathSchema,
        target: { type: 'string', enum: HD_TARGETS },
        format: { anyOf: [videoFormatSchema, imageFormatSchema] },
        engine: { type: 'string', enum: ['ffmpeg', 'ai'] },
      },
      required: ['kind', 'input'],
      additionalProperties: false,
    },
    run: (args, ctx) => {
      const obj = asObject(args);
      const request: EnhanceHdRequest = {
        kind: oneOf(requiredString(obj, 'kind'), ['video', 'image'] as const, '类型') as 'video' | 'image',
        input: resolveInput(requiredString(obj, 'input'), ctx),
        target: oneOf(optionalString(obj, 'target'), HD_TARGETS, '清晰度') as HdTarget | undefined,
        format: oneOf(
          optionalString(obj, 'format'),
          [...VIDEO_FORMATS, ...IMAGE_FORMATS],
          '格式',
        ) as VideoFormat | ImageFormat | undefined,
        engine: oneOf(optionalString(obj, 'engine'), ['ffmpeg', 'ai'] as const, '引擎') as EnhanceEngine | undefined,
      };
      return enhanceHd(request, ctx.onProgress);
    },
  },
  {
    name: 'media_denoise_audio',
    description: '按低、中、高强度给音频降噪，可选起止秒。结果写到临时文件。',
    inputSchema: {
      type: 'object',
      properties: {
        input: pathSchema,
        strength: { type: 'string', enum: DENOISE_STRENGTHS },
        startSec: { type: 'number' },
        endSec: { type: 'number' },
        format: audioFormatSchema,
        engine: { type: 'string', enum: ['ffmpeg', 'ai'] },
      },
      required: ['input'],
      additionalProperties: false,
    },
    run: (args, ctx) => {
      const obj = asObject(args);
      const request: DenoiseAudioRequest = {
        input: resolveInput(requiredString(obj, 'input'), ctx),
        strength: oneOf(optionalString(obj, 'strength'), DENOISE_STRENGTHS, '强度') as DenoiseStrength | undefined,
        startSec: optionalNumber(obj, 'startSec'),
        endSec: optionalNumber(obj, 'endSec'),
        format: oneOf(optionalString(obj, 'format'), AUDIO_FORMATS, '格式'),
        engine: oneOf(optionalString(obj, 'engine'), ['ffmpeg', 'ai'] as const, '引擎') as EnhanceEngine | undefined,
      };
      return denoiseAudio(request, ctx.onProgress);
    },
  },
  {
    name: 'media_remove_watermark',
    description: '按像素矩形去除视频或图片上的水印（整段处理）。结果写到临时文件。',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['video', 'image'] },
        input: pathSchema,
        x: { type: 'number' },
        y: { type: 'number' },
        width: { type: 'number' },
        height: { type: 'number' },
        format: { anyOf: [videoFormatSchema, imageFormatSchema] },
        engine: { type: 'string', enum: ['ffmpeg', 'ai'] },
      },
      required: ['kind', 'input', 'x', 'y', 'width', 'height'],
      additionalProperties: false,
    },
    run: (args, ctx) => {
      const obj = asObject(args);
      const request: RemoveWatermarkRequest = {
        kind: oneOf(requiredString(obj, 'kind'), ['video', 'image'] as const, '类型') as 'video' | 'image',
        input: resolveInput(requiredString(obj, 'input'), ctx),
        x: optionalNumber(obj, 'x') ?? Number.NaN,
        y: optionalNumber(obj, 'y') ?? Number.NaN,
        width: optionalNumber(obj, 'width') ?? Number.NaN,
        height: optionalNumber(obj, 'height') ?? Number.NaN,
        format: oneOf(
          optionalString(obj, 'format'),
          [...VIDEO_FORMATS, ...IMAGE_FORMATS],
          '格式',
        ) as VideoFormat | ImageFormat | undefined,
        engine: oneOf(optionalString(obj, 'engine'), ['ffmpeg', 'ai'] as const, '引擎') as EnhanceEngine | undefined,
      };
      if (![request.x, request.y, request.width, request.height].every(Number.isFinite)) {
        throw new Error('去水印区域必须是数字。');
      }
      return removeWatermark(request, ctx.onProgress);
    },
  },
  {
    name: 'media_compress',
    description: '按高画质、均衡或小体积压缩视频或图片。结果写到临时文件。',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['video', 'image'] },
        input: pathSchema,
        preset: { type: 'string', enum: COMPRESS_PRESETS },
        format: { anyOf: [videoFormatSchema, imageFormatSchema] },
      },
      required: ['kind', 'input'],
      additionalProperties: false,
    },
    run: (args, ctx) => {
      const obj = asObject(args);
      const request: CompressRequest = {
        kind: oneOf(requiredString(obj, 'kind'), ['video', 'image'] as const, '类型') as 'video' | 'image',
        input: resolveInput(requiredString(obj, 'input'), ctx),
        preset: oneOf(optionalString(obj, 'preset'), COMPRESS_PRESETS, '压缩档位') as CompressPreset | undefined,
        format: oneOf(optionalString(obj, 'format'), [...VIDEO_FORMATS, ...IMAGE_FORMATS], '格式') as VideoFormat | ImageFormat | undefined,
      };
      return compressMedia(request, ctx.onProgress);
    },
  },
  {
    name: 'media_orient',
    description: '旋转或镜像视频、图片。rotate90/180/270 为顺时针，flipH/flipV 为水平或垂直翻转。',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['video', 'image'] },
        input: pathSchema,
        op: { type: 'string', enum: ORIENT_OPS },
        format: { anyOf: [videoFormatSchema, imageFormatSchema] },
      },
      required: ['kind', 'input', 'op'],
      additionalProperties: false,
    },
    run: (args, ctx) => {
      const obj = asObject(args);
      const request: OrientRequest = {
        kind: oneOf(requiredString(obj, 'kind'), ['video', 'image'] as const, '类型') as 'video' | 'image',
        input: resolveInput(requiredString(obj, 'input'), ctx),
        op: oneOf(requiredString(obj, 'op'), ORIENT_OPS, '方向') as OrientOp,
        format: oneOf(optionalString(obj, 'format'), [...VIDEO_FORMATS, ...IMAGE_FORMATS], '格式') as VideoFormat | ImageFormat | undefined,
      };
      return orientMedia(request, ctx.onProgress);
    },
  },
  {
    name: 'media_speed',
    description: '把视频变速为 0.5、1.5 或 2 倍。默认保持音调，changePitch 为 true 时同时变调。',
    inputSchema: {
      type: 'object',
      properties: {
        input: pathSchema,
        rate: { type: 'number', enum: [...SPEED_RATES] },
        changePitch: { type: 'boolean' },
        format: videoFormatSchema,
      },
      required: ['input', 'rate'],
      additionalProperties: false,
    },
    run: (args, ctx) => {
      const obj = asObject(args);
      const rate = optionalNumber(obj, 'rate');
      if (rate !== 0.5 && rate !== 1.5 && rate !== 2) {
        throw new Error('变速仅支持 0.5、1.5、2。');
      }
      const request: SpeedRequest = {
        input: resolveInput(requiredString(obj, 'input'), ctx),
        rate: rate as SpeedRate,
        changePitch: optionalBoolean(obj, 'changePitch'),
        format: oneOf(optionalString(obj, 'format'), VIDEO_FORMATS, '格式'),
      };
      return changeSpeed(request, ctx.onProgress);
    },
  },
  {
    name: 'media_extract',
    description: '从视频抽出音轨，或去掉音轨只保留画面。',
    inputSchema: {
      type: 'object',
      properties: {
        input: pathSchema,
        mode: { type: 'string', enum: ['audio', 'mute'] },
        format: { anyOf: [videoFormatSchema, audioFormatSchema] },
      },
      required: ['input', 'mode'],
      additionalProperties: false,
    },
    run: (args, ctx) => {
      const obj = asObject(args);
      const request: ExtractRequest = {
        input: resolveInput(requiredString(obj, 'input'), ctx),
        mode: oneOf(requiredString(obj, 'mode'), ['audio', 'mute'] as const, '模式') as ExtractMode,
        format: oneOf(optionalString(obj, 'format'), [...VIDEO_FORMATS, ...AUDIO_FORMATS], '格式') as VideoFormat | AudioFormat | undefined,
      };
      return extractMedia(request, ctx.onProgress);
    },
  },
  {
    name: 'media_snapshot',
    description: '按秒截取视频中的一帧图片。',
    inputSchema: {
      type: 'object',
      properties: {
        input: pathSchema,
        timeSec: { type: 'number' },
        format: imageFormatSchema,
      },
      required: ['input'],
      additionalProperties: false,
    },
    run: (args, ctx) => {
      const obj = asObject(args);
      const request: SnapshotRequest = {
        input: resolveInput(requiredString(obj, 'input'), ctx),
        timeSec: optionalNumber(obj, 'timeSec'),
        format: oneOf(optionalString(obj, 'format'), IMAGE_FORMATS, '格式'),
      };
      return snapshotFrame(request, ctx.onProgress);
    },
  },
  {
    name: 'media_aspect',
    description: '把视频或图片居中裁成 16:9、1:1 或 9:16。',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['video', 'image'] },
        input: pathSchema,
        ratio: { type: 'string', enum: ASPECT_RATIOS },
        format: { anyOf: [videoFormatSchema, imageFormatSchema] },
      },
      required: ['kind', 'input', 'ratio'],
      additionalProperties: false,
    },
    run: (args, ctx) => {
      const obj = asObject(args);
      const request: AspectRequest = {
        kind: oneOf(requiredString(obj, 'kind'), ['video', 'image'] as const, '类型') as 'video' | 'image',
        input: resolveInput(requiredString(obj, 'input'), ctx),
        ratio: oneOf(requiredString(obj, 'ratio'), ASPECT_RATIOS, '比例') as AspectRatio,
        format: oneOf(optionalString(obj, 'format'), [...VIDEO_FORMATS, ...IMAGE_FORMATS], '格式') as VideoFormat | ImageFormat | undefined,
      };
      return fitAspect(request, ctx.onProgress);
    },
  },
  {
    name: 'media_stamp',
    description: '给视频或图片烧录文字，或叠加一张台标图片。',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['video', 'image'] },
        input: pathSchema,
        mode: { type: 'string', enum: ['text', 'logo'] },
        text: { type: 'string' },
        logo: pathSchema,
        position: { type: 'string', enum: STAMP_POSITIONS },
        format: { anyOf: [videoFormatSchema, imageFormatSchema] },
      },
      required: ['kind', 'input', 'mode'],
      additionalProperties: false,
    },
    run: (args, ctx) => {
      const obj = asObject(args);
      const logo = optionalString(obj, 'logo');
      const request: StampRequest = {
        kind: oneOf(requiredString(obj, 'kind'), ['video', 'image'] as const, '类型') as 'video' | 'image',
        input: resolveInput(requiredString(obj, 'input'), ctx),
        mode: oneOf(requiredString(obj, 'mode'), ['text', 'logo'] as const, '模式') as 'text' | 'logo',
        text: optionalString(obj, 'text'),
        logo: logo ? resolveInput(logo, ctx) : undefined,
        position: oneOf(optionalString(obj, 'position'), STAMP_POSITIONS, '位置') as StampPosition | undefined,
        format: oneOf(optionalString(obj, 'format'), [...VIDEO_FORMATS, ...IMAGE_FORMATS], '格式') as VideoFormat | ImageFormat | undefined,
      };
      return stampMedia(request, ctx.onProgress);
    },
  },
  {
    name: 'media_loudnorm',
    description: '把视频或音频的响度标准化到约 -16 LUFS。',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['video', 'audio'] },
        input: pathSchema,
        format: { anyOf: [videoFormatSchema, audioFormatSchema] },
      },
      required: ['kind', 'input'],
      additionalProperties: false,
    },
    run: (args, ctx) => {
      const obj = asObject(args);
      const request: LoudnormRequest = {
        kind: oneOf(requiredString(obj, 'kind'), ['video', 'audio'] as const, '类型') as 'video' | 'audio',
        input: resolveInput(requiredString(obj, 'input'), ctx),
        format: oneOf(optionalString(obj, 'format'), [...VIDEO_FORMATS, ...AUDIO_FORMATS], '格式') as VideoFormat | AudioFormat | undefined,
      };
      return normalizeLoudness(request, ctx.onProgress);
    },
  },
  {
    name: 'media_resize',
    description: '按宽度、高度或百分比缩放图片，保持比例。',
    inputSchema: {
      type: 'object',
      properties: {
        input: pathSchema,
        mode: { type: 'string', enum: RESIZE_MODES },
        value: { type: 'number' },
        format: imageFormatSchema,
      },
      required: ['input', 'mode', 'value'],
      additionalProperties: false,
    },
    run: (args, ctx) => {
      const obj = asObject(args);
      const value = optionalNumber(obj, 'value');
      if (value == null) {
        throw new Error('缩放数值必须是数字。');
      }
      const request: ResizeRequest = {
        input: resolveInput(requiredString(obj, 'input'), ctx),
        mode: oneOf(requiredString(obj, 'mode'), RESIZE_MODES, '缩放方式') as ResizeMode,
        value,
        format: oneOf(optionalString(obj, 'format'), IMAGE_FORMATS, '格式'),
      };
      return resizeImage(request, ctx.onProgress);
    },
  },
  {
    name: 'media_adjust',
    description: '一次处理视频的多项调整：旋转、比例、变速、压缩、台标、静音、响度，或改成只出音频、只截一帧。未传的项不生效。',
    inputSchema: {
      type: 'object',
      properties: {
        input: pathSchema,
        output: { type: 'string', enum: ['video', 'audio', 'frame'] },
        format: { anyOf: [videoFormatSchema, imageFormatSchema, audioFormatSchema] },
        orient: { type: 'string', enum: ORIENT_OPS },
        ratio: { type: 'string', enum: ASPECT_RATIOS },
        rate: { type: 'number' },
        changePitch: { type: 'boolean' },
        preset: { type: 'string', enum: COMPRESS_PRESETS },
        mute: { type: 'boolean' },
        loudnorm: { type: 'boolean' },
        timeSec: { type: 'number' },
        stampMode: { type: 'string', enum: ['text', 'logo'] },
        text: { type: 'string' },
        logo: pathSchema,
        position: { type: 'string', enum: STAMP_POSITIONS },
      },
      required: ['input'],
      additionalProperties: false,
    },
    run: (args, ctx) => {
      const obj = asObject(args);
      const rate = optionalNumber(obj, 'rate');
      const logo = optionalString(obj, 'logo');
      const request: VideoAdjustRequest = {
        input: resolveInput(requiredString(obj, 'input'), ctx),
        output: oneOf(optionalString(obj, 'output'), ['video', 'audio', 'frame'] as const, '输出') as VideoAdjustOutput | undefined,
        format: oneOf(
          optionalString(obj, 'format'),
          [...VIDEO_FORMATS, ...IMAGE_FORMATS, ...AUDIO_FORMATS],
          '格式',
        ) as VideoAdjustRequest['format'],
        orient: oneOf(optionalString(obj, 'orient'), ORIENT_OPS, '方向'),
        ratio: oneOf(optionalString(obj, 'ratio'), ASPECT_RATIOS, '比例'),
        rate: rate === 0.5 || rate === 1.5 || rate === 2 ? rate : undefined,
        changePitch: optionalBoolean(obj, 'changePitch'),
        preset: oneOf(optionalString(obj, 'preset'), COMPRESS_PRESETS, '压缩档位'),
        mute: optionalBoolean(obj, 'mute'),
        loudnorm: optionalBoolean(obj, 'loudnorm'),
        timeSec: optionalNumber(obj, 'timeSec'),
        stampMode: oneOf(optionalString(obj, 'stampMode'), ['text', 'logo'] as const, '台标'),
        text: optionalString(obj, 'text'),
        logo: logo ? resolveInput(logo, ctx) : undefined,
        position: oneOf(optionalString(obj, 'position'), STAMP_POSITIONS, '位置'),
      };
      if (rate != null && request.rate == null) {
        throw new Error('变速仅支持 0.5、1.5、2。');
      }
      return adjustVideo(request, ctx.onProgress);
    },
  },
  {
    name: 'playwright_status',
    description: '查看 Playwright Studio 状态：工作区路径、浏览器是否就绪、是否有录制/回放任务在跑。',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    run: async () => getStudioStatus(),
  },
  {
    name: 'playwright_list',
    description: '列出已保存的 Playwright 工作流（名称、URL、浏览器、最近执行状态）。',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    run: async () => listWorkflows(),
  },
  {
    name: 'playwright_get',
    description: '读取单个工作流详情，包含完整 Playwright 脚本内容。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '工作流 ID。' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    run: async (args) => getWorkflow(requiredString(asObject(args), 'id')),
  },
  {
    name: 'playwright_create',
    description: '用 Playwright 脚本文本创建工作流（无需 Codegen）。适合 Agent 直接编写或改写自动化脚本后入库。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '工作流名称。' },
        url: { type: 'string', description: '起始页面 URL。' },
        script: { type: 'string', description: '完整 *.spec.ts 脚本，需包含 test(...)。' },
        browser: { type: 'string', enum: PLAYWRIGHT_BROWSERS, description: '默认 chromium；本机 Chrome 用 chrome。' },
        device: { type: 'string', enum: [...PLAYWRIGHT_DEVICES], description: '可选设备模拟，空字符串表示桌面。' },
        notes: { type: 'string', description: '备注。' },
      },
      required: ['name', 'url', 'script'],
      additionalProperties: false,
    },
    run: async (args) => {
      const obj = asObject(args);
      const browser = oneOf(optionalString(obj, 'browser'), PLAYWRIGHT_BROWSERS, '浏览器');
      const device = optionalString(obj, 'device');
      if (device != null && !(PLAYWRIGHT_DEVICES as readonly string[]).includes(device)) {
        throw new Error(`设备不支持：${device}`);
      }
      return createWorkflowFromScript({
        name: requiredString(obj, 'name'),
        url: requiredString(obj, 'url'),
        script: requiredString(obj, 'script'),
        browser: browser as PlaywrightBrowser | undefined,
        device,
        notes: optionalString(obj, 'notes'),
      });
    },
  },
  {
    name: 'playwright_update',
    description: '更新工作流名称、备注、URL、浏览器、脚本或登录前置配置。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        notes: { type: 'string' },
        url: { type: 'string' },
        browser: { type: 'string', enum: PLAYWRIGHT_BROWSERS },
        device: { type: 'string' },
        script: { type: 'string', description: '替换整个脚本内容。' },
        authWorkflowId: {
          type: 'string',
          description: '登录前置工作流 ID；传空字符串清除。',
        },
        authBeforePlay: {
          type: 'string',
          enum: PLAYWRIGHT_AUTH_BEFORE_PLAY,
          description: 'if-missing-auth / always / off。',
        },
        isAuthWorkflow: {
          type: 'boolean',
          description: '标记为登录流。',
        },
      },
      required: ['id'],
      additionalProperties: false,
    },
    run: async (args) => {
      const obj = asObject(args);
      const authWorkflowId = optionalString(obj, 'authWorkflowId');
      return updateWorkflow({
        id: requiredString(obj, 'id'),
        name: optionalString(obj, 'name'),
        notes: optionalString(obj, 'notes'),
        url: optionalString(obj, 'url'),
        browser: oneOf(optionalString(obj, 'browser'), PLAYWRIGHT_BROWSERS, '浏览器') as PlaywrightBrowser | undefined,
        device: optionalString(obj, 'device'),
        script: optionalString(obj, 'script'),
        authWorkflowId: authWorkflowId === undefined
          ? undefined
          : (authWorkflowId.trim() ? authWorkflowId.trim() : null),
        authBeforePlay: oneOf(
          optionalString(obj, 'authBeforePlay'),
          PLAYWRIGHT_AUTH_BEFORE_PLAY,
          '登录前置策略',
        ) as PlaywrightAuthBeforePlay | undefined,
        isAuthWorkflow: optionalBoolean(obj, 'isAuthWorkflow'),
      });
    },
  },
  {
    name: 'playwright_delete',
    description: '删除工作流及其脚本/登录态。需 confirm=true。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        confirm: { type: 'boolean', description: '必须为 true 才会删除。' },
      },
      required: ['id', 'confirm'],
      additionalProperties: false,
    },
    run: async (args) => {
      const obj = asObject(args);
      if (optionalBoolean(obj, 'confirm') !== true) {
        throw new Error('删除需设置 confirm=true。');
      }
      const id = requiredString(obj, 'id');
      deleteWorkflow(id);
      return { deleted: true, id };
    },
  },
  {
    name: 'playwright_record',
    description: '启动 Playwright Codegen 录制：弹出浏览器供用户操作，关闭窗口后脚本写入工作流。Agent 调用时默认等待录制结束。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        url: { type: 'string', description: '起始 URL。' },
        browser: { type: 'string', enum: PLAYWRIGHT_BROWSERS },
        device: { type: 'string' },
        saveAuth: { type: 'boolean', description: '录制结束时保存登录态。' },
        loadAuthFromId: { type: 'string', description: '复用已有工作流的登录态。' },
        usePersistentProfile: {
          type: 'boolean',
          description: '复用 Studio 持久登录目录（user-data-dir），同一浏览器下次录制保留 Cookie。默认 false。',
        },
        slowMoMs: {
          type: 'number',
          description: '建议回放放慢毫秒数，写入工作流元数据；默认 500。',
        },
        notes: { type: 'string' },
        wait: { type: 'boolean', description: '是否等待录制结束。Agent 默认 true，UI 可 false。' },
      },
      required: ['name', 'url'],
      additionalProperties: false,
    },
    run: async (args, ctx) => {
      const obj = asObject(args);
      const wait = optionalBoolean(obj, 'wait');
      return startRecord({
        name: requiredString(obj, 'name'),
        url: requiredString(obj, 'url'),
        browser: oneOf(optionalString(obj, 'browser'), PLAYWRIGHT_BROWSERS, '浏览器') as PlaywrightBrowser | undefined,
        device: optionalString(obj, 'device'),
        saveAuth: optionalBoolean(obj, 'saveAuth'),
        loadAuthFromId: optionalString(obj, 'loadAuthFromId'),
        usePersistentProfile: optionalBoolean(obj, 'usePersistentProfile'),
        slowMoMs: optionalNumber(obj, 'slowMoMs'),
        notes: optionalString(obj, 'notes'),
      }, {
        wait: wait ?? ctx.source === 'agent',
      });
    },
  },
  {
    name: 'playwright_play',
    description: '回放已保存的 Playwright 工作流。Agent 调用时默认等待执行结束并返回结果。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '工作流 ID。' },
        mode: { type: 'string', enum: PLAYWRIGHT_RUN_MODES, description: 'headed / headless / ui / debug，默认 headed。' },
        browser: {
          type: 'string',
          enum: PLAYWRIGHT_BROWSERS,
          description: '覆盖工作流浏览器；本机 Chrome 用 chrome，本机 Edge 用 msedge。',
        },
        slowMoMs: {
          type: 'number',
          description: '放慢毫秒数；省略则使用工作流记录的 slowMoMs（默认 500）。',
        },
        skipAuthPrecondition: {
          type: 'boolean',
          description: '跳过登录前置工作流。',
        },
        saveAuthAfterPlay: {
          type: 'boolean',
          description: '回放成功后把 storageState 写回本工作流（用于刷新登录态）。',
        },
        recordHar: {
          type: 'boolean',
          description: '回放时录制 network HAR 到产物目录。',
        },
        saveBaseline: {
          type: 'boolean',
          description: '回放成功后把本次 run 设为回归基线。',
        },
        wait: { type: 'boolean', description: '是否等待结束。Agent 默认 true。' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    run: async (args, ctx) => {
      const obj = asObject(args);
      const wait = optionalBoolean(obj, 'wait');
      return playWorkflow({
        id: requiredString(obj, 'id'),
        mode: oneOf(optionalString(obj, 'mode'), PLAYWRIGHT_RUN_MODES, '回放模式') as PlaywrightRunMode | undefined,
        browser: oneOf(optionalString(obj, 'browser'), PLAYWRIGHT_BROWSERS, '浏览器') as PlaywrightBrowser | undefined,
        slowMoMs: optionalNumber(obj, 'slowMoMs'),
        skipAuthPrecondition: optionalBoolean(obj, 'skipAuthPrecondition'),
        saveAuthAfterPlay: optionalBoolean(obj, 'saveAuthAfterPlay'),
        recordHar: optionalBoolean(obj, 'recordHar'),
        saveBaseline: optionalBoolean(obj, 'saveBaseline'),
      }, {
        wait: wait ?? ctx.source === 'agent',
      });
    },
  },
  {
    name: 'playwright_stop',
    description: '停止当前正在进行的录制或回放任务。',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    run: async () => {
      await stopJob();
      return { stopped: true, status: getStudioStatus() };
    },
  },
  {
    name: 'playwright_install_browsers',
    description: '安装与当前 Playwright 版本匹配的浏览器（chromium / firefox / webkit / all）。本机 Chrome/Edge 通道通常不需要。',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', enum: ['chromium', 'firefox', 'webkit', 'all'], description: '默认 chromium。' },
      },
      additionalProperties: false,
    },
    run: async (args) => {
      const obj = asObject(args);
      const target = oneOf(
        optionalString(obj, 'target'),
        ['chromium', 'firefox', 'webkit', 'all'] as const,
        '安装目标',
      ) || 'chromium';
      return installBrowsers(target);
    },
  },
  {
    name: 'playwright_list_artifacts',
    description: '列出某工作流回放/采集产生的产物（Trace / 视频 / 截图 / PDF）。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '工作流 ID。' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    run: async (args) => {
      const obj = asObject(args);
      const id = requiredString(obj, 'id');
      return { id, artifacts: listArtifacts(id) };
    },
  },
  {
    name: 'playwright_open_trace',
    description: '用 Playwright Trace Viewer 打开指定 trace.zip。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'trace.zip 绝对路径。' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    run: async (args) => {
      const obj = asObject(args);
      const file = requiredString(obj, 'path');
      await openTrace(file);
      return { opened: true, path: file };
    },
  },
  {
    name: 'playwright_reveal_artifact',
    description: '在系统文件管理器中定位某个回放产物。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '产物绝对路径。' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    run: async (args) => {
      const obj = asObject(args);
      const file = requiredString(obj, 'path');
      await revealArtifact(file);
      return { revealed: true, path: file };
    },
  },
  {
    name: 'playwright_delete_artifact',
    description: '删除某个回放/采集产物文件（仅限 Studio 产物目录）。需 confirm=true。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '产物绝对路径。' },
        confirm: { type: 'boolean', description: '必须为 true 才会删除。' },
      },
      required: ['path', 'confirm'],
      additionalProperties: false,
    },
    run: async (args) => {
      const obj = asObject(args);
      if (optionalBoolean(obj, 'confirm') !== true) {
        throw new Error('删除需设置 confirm=true。');
      }
      return deleteArtifact(requiredString(obj, 'path'));
    },
  },
  {
    name: 'playwright_inject_asserts',
    description: '向工作流脚本插入 expect 断言模板（url / title / body / all），可重复调用覆盖同一标记块。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '工作流 ID。' },
        templates: {
          type: 'array',
          items: { type: 'string', enum: PLAYWRIGHT_ASSERT_TEMPLATES },
          description: '断言模板列表，默认 ["all"]。',
        },
      },
      required: ['id'],
      additionalProperties: false,
    },
    run: async (args) => {
      const obj = asObject(args);
      const templatesRaw = obj.templates;
      let templates: PlaywrightAssertTemplate[] | undefined;
      if (Array.isArray(templatesRaw)) {
        templates = templatesRaw.map((item) => {
          if (typeof item !== 'string') throw new Error('templates 项必须是字符串。');
          return oneOf(item, PLAYWRIGHT_ASSERT_TEMPLATES, '断言模板') as PlaywrightAssertTemplate;
        });
      }
      return injectAsserts({
        id: requiredString(obj, 'id'),
        templates,
      });
    },
  },
  {
    name: 'playwright_capture',
    description: '打开工作流起始 URL，截图或导出 PDF，归档到产物目录。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '工作流 ID。' },
        kind: { type: 'string', enum: ['screenshot', 'pdf'], description: '默认 screenshot。PDF 仅 Chromium/Chrome/Edge。' },
        fullPage: { type: 'boolean', description: '截图是否整页，默认 true。' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    run: async (args) => {
      const obj = asObject(args);
      const kind = (oneOf(optionalString(obj, 'kind'), ['screenshot', 'pdf'] as const, '采集类型')
        || 'screenshot') as PlaywrightCaptureKind;
      return capturePage({
        id: requiredString(obj, 'id'),
        kind,
        fullPage: optionalBoolean(obj, 'fullPage'),
      });
    },
  },
  {
    name: 'playwright_play_batch',
    description: '按顺序批量回放多个工作流。Agent 默认等待全部结束。',
    inputSchema: {
      type: 'object',
      properties: {
        ids: {
          type: 'array',
          items: { type: 'string' },
          description: '工作流 ID 列表。',
        },
        mode: { type: 'string', enum: PLAYWRIGHT_RUN_MODES, description: '默认 headless。' },
        browser: {
          type: 'string',
          enum: PLAYWRIGHT_BROWSERS,
          description: '覆盖本批工作流浏览器；本机 Chrome 用 chrome。',
        },
        slowMoMs: { type: 'number' },
        wait: { type: 'boolean', description: '是否等待全部结束。Agent 默认 true。' },
      },
      required: ['ids'],
      additionalProperties: false,
    },
    run: async (args, ctx) => {
      const obj = asObject(args);
      const idsRaw = obj.ids;
      if (!Array.isArray(idsRaw) || idsRaw.length === 0) {
        throw new Error('ids 不能为空。');
      }
      const ids = idsRaw.map((item) => {
        if (typeof item !== 'string' || !item.trim()) throw new Error('ids 项必须是非空字符串。');
        return item.trim();
      });
      const wait = optionalBoolean(obj, 'wait');
      return playBatch({
        ids,
        mode: oneOf(optionalString(obj, 'mode'), PLAYWRIGHT_RUN_MODES, '回放模式') as PlaywrightRunMode | undefined,
        browser: oneOf(optionalString(obj, 'browser'), PLAYWRIGHT_BROWSERS, '浏览器') as PlaywrightBrowser | undefined,
        slowMoMs: optionalNumber(obj, 'slowMoMs'),
      }, {
        wait: wait ?? ctx.source === 'agent',
      });
    },
  },
  {
    name: 'playwright_get_schedule',
    description: '读取简易定时回放配置（间隔、工作流列表、上次/下次执行）。',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    run: async () => getSchedule(),
  },
  {
    name: 'playwright_set_schedule',
    description: '设置简易定时回放：按间隔分钟批量执行选定工作流。',
    inputSchema: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean' },
        intervalMinutes: { type: 'number', description: '间隔分钟，最小 1。' },
        workflowIds: { type: 'array', items: { type: 'string' } },
        mode: { type: 'string', enum: PLAYWRIGHT_RUN_MODES },
        slowMoMs: { type: 'number' },
      },
      additionalProperties: false,
    },
    run: async (args) => {
      const obj = asObject(args);
      const workflowIdsRaw = obj.workflowIds;
      let workflowIds: string[] | undefined;
      if (Array.isArray(workflowIdsRaw)) {
        workflowIds = workflowIdsRaw.map((item) => {
          if (typeof item !== 'string' || !item.trim()) throw new Error('workflowIds 项必须是非空字符串。');
          return item.trim();
        });
      }
      return setSchedule({
        enabled: optionalBoolean(obj, 'enabled'),
        intervalMinutes: optionalNumber(obj, 'intervalMinutes'),
        workflowIds,
        mode: oneOf(optionalString(obj, 'mode'), PLAYWRIGHT_RUN_MODES, '回放模式') as PlaywrightRunMode | undefined,
        slowMoMs: optionalNumber(obj, 'slowMoMs'),
      });
    },
  },
  {
    name: 'playwright_save_baseline',
    description: '将某次回放 run 设为回归基线（默认最近一次）。用于后续异常对比。',
    inputSchema: {
      type: 'object',
      properties: {
        workflowId: { type: 'string' },
        runId: { type: 'string', description: '可选；省略则用最近一次回放。' },
      },
      required: ['workflowId'],
      additionalProperties: false,
    },
    run: async (args) => {
      const obj = asObject(args);
      return saveBaseline({
        workflowId: requiredString(obj, 'workflowId'),
        runId: optionalString(obj, 'runId'),
      });
    },
  },
  {
    name: 'playwright_get_baseline',
    description: '读取工作流当前回归基线信息。',
    inputSchema: {
      type: 'object',
      properties: {
        workflowId: { type: 'string' },
      },
      required: ['workflowId'],
      additionalProperties: false,
    },
    run: async (args) => {
      const obj = asObject(args);
      return getBaseline(requiredString(obj, 'workflowId'));
    },
  },
  {
    name: 'playwright_compare_baseline',
    description: '对比工作流基线与最近回放（脚本哈希、产物、状态），返回可读摘要。',
    inputSchema: {
      type: 'object',
      properties: {
        workflowId: { type: 'string' },
      },
      required: ['workflowId'],
      additionalProperties: false,
    },
    run: async (args) => {
      const obj = asObject(args);
      return compareBaseline(requiredString(obj, 'workflowId'));
    },
  },
  {
    name: 'playwright_save_report',
    description: '将 Agent 分析报告保存为工作流产物 Markdown（test-enhance / business-doc / anomaly / general）。',
    inputSchema: {
      type: 'object',
      properties: {
        workflowId: { type: 'string' },
        content: { type: 'string', description: 'Markdown 正文。' },
        title: { type: 'string' },
        kind: {
          type: 'string',
          enum: ['test-enhance', 'business-doc', 'anomaly', 'general'],
        },
      },
      required: ['workflowId', 'content'],
      additionalProperties: false,
    },
    run: async (args) => {
      const obj = asObject(args);
      const kindRaw = optionalString(obj, 'kind');
      const kind = kindRaw === 'test-enhance'
        || kindRaw === 'business-doc'
        || kindRaw === 'anomaly'
        || kindRaw === 'general'
        ? kindRaw
        : undefined;
      return saveReport({
        workflowId: requiredString(obj, 'workflowId'),
        content: requiredString(obj, 'content'),
        title: optionalString(obj, 'title'),
        kind,
      });
    },
  },
  {
    name: 'playwright_list_steps',
    description: '解析录制脚本中可参数化的步骤（goto / fill / type / selectOption），供按 Prompt 替换后再执行。',
    inputSchema: {
      type: 'object',
      properties: {
        workflowId: { type: 'string' },
      },
      required: ['workflowId'],
      additionalProperties: false,
    },
    run: async (args) => {
      const obj = asObject(args);
      const workflowId = requiredString(obj, 'workflowId');
      const steps = listScriptSteps(workflowId);
      return {
        workflowId,
        steps,
        tip: '把用户 Prompt 中的关键信息映射到 step.id / index / hint，再调用 playwright_run_with_params。',
      };
    },
  },
  {
    name: 'playwright_run_with_params',
    description: '按参数替换录制脚本中的 URL/表单值后自动回放（打开页面并逐步操作）。params 可用 step.id、序号、hint、邮箱/密码等别名。',
    inputSchema: {
      type: 'object',
      properties: {
        workflowId: { type: 'string' },
        params: {
          type: 'object',
          description: '键值对，如 {"0":"https://...","邮箱":"a@b.com","密码":"xxx"} 或 {"fill-1":"新值"}。',
          additionalProperties: { type: 'string' },
        },
        mode: { type: 'string', enum: PLAYWRIGHT_RUN_MODES },
        browser: { type: 'string', enum: PLAYWRIGHT_BROWSERS },
        slowMoMs: { type: 'number' },
        recordHar: { type: 'boolean' },
        persistScript: {
          type: 'boolean',
          description: '是否把替换后的脚本写回工作流；默认 false（仅本次执行）。',
        },
        wait: { type: 'boolean', description: '是否等待回放结束。Agent 默认 true。' },
      },
      required: ['workflowId', 'params'],
      additionalProperties: false,
    },
    run: async (args, ctx) => {
      const obj = asObject(args);
      const paramsRaw = obj.params;
      if (!paramsRaw || typeof paramsRaw !== 'object' || Array.isArray(paramsRaw)) {
        throw new Error('params 必须是对象，例如 {"邮箱":"a@b.com","密码":"secret"}。');
      }
      const params: Record<string, string> = {};
      for (const [key, value] of Object.entries(paramsRaw as Record<string, unknown>)) {
        if (typeof value === 'string') params[key] = value;
        else if (typeof value === 'number' || typeof value === 'boolean') params[key] = String(value);
      }
      const wait = optionalBoolean(obj, 'wait');
      return runWithParams({
        workflowId: requiredString(obj, 'workflowId'),
        params,
        mode: oneOf(optionalString(obj, 'mode'), PLAYWRIGHT_RUN_MODES, '回放模式') as PlaywrightRunMode | undefined,
        browser: oneOf(optionalString(obj, 'browser'), PLAYWRIGHT_BROWSERS, '浏览器') as PlaywrightBrowser | undefined,
        slowMoMs: optionalNumber(obj, 'slowMoMs'),
        recordHar: optionalBoolean(obj, 'recordHar'),
        persistScript: optionalBoolean(obj, 'persistScript'),
      }, {
        wait: wait ?? ctx.source === 'agent',
      });
    },
  },
];

const byName = new Map(tools.map((tool) => [tool.name, tool]));

export function listAgentTools(): Array<Pick<ToolDefinition, 'name' | 'description' | 'inputSchema'>> {
  return tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
}

export async function callTool(name: string, args: unknown, ctx: ToolContext): Promise<unknown> {
  const tool = byName.get(name);
  if (!tool) {
    throw new Error(`未知工具：${name}`);
  }
  return tool.run(args, ctx);
}
