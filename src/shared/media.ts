export type MediaKind = 'video' | 'image' | 'audio';

export type VideoFormat = 'mp4' | 'webm' | 'mov' | 'mkv';
export type ImageFormat = 'jpg' | 'png' | 'webp' | 'bmp';
export type AudioFormat = 'mp3' | 'aac' | 'wav' | 'flac' | 'ogg';
export type MediaFormat = VideoFormat | ImageFormat | AudioFormat | 'gif';

export const VIDEO_FORMATS: VideoFormat[] = ['mp4', 'webm', 'mov', 'mkv'];
export const IMAGE_FORMATS: ImageFormat[] = ['jpg', 'png', 'webp', 'bmp'];
export const AUDIO_FORMATS: AudioFormat[] = ['mp3', 'aac', 'wav', 'flac', 'ogg'];

export interface MediaProbe {
  kind: MediaKind;
  path: string;
  /** Container duration in seconds, including fractional part. Images are 0. */
  durationSec: number;
  /** Coded frame size used by filters. */
  width: number;
  height: number;
  /** Size after sample aspect ratio and display rotation. */
  displayWidth: number;
  displayHeight: number;
  videoCodec: string;
  audioCodec: string;
  formatName: string;
  sizeBytes: number;
  /** Container bitrate in bits per second. 0 when unknown. */
  bitrateBps: number;
  videoBitrateBps: number;
  audioBitrateBps: number;
  /** Average frame rate. 0 for images and audio. */
  frameRate: number;
  sampleRate: number;
  channels: number;
  channelLayout: string;
  bitsPerSample: number;
  pixelFormat: string;
  /** Clockwise display rotation in degrees, normalized to 0–359. */
  rotation: number;
}

/** @deprecated alias — use MediaProbe */
export type VideoProbe = MediaProbe;

export interface ConvertRequest {
  kind: MediaKind;
  input: string;
  format: VideoFormat | ImageFormat | AudioFormat;
}

export interface CropRequest {
  kind: 'video' | 'image';
  input: string;
  x: number;
  y: number;
  width: number;
  height: number;
  startSec?: number;
  endSec?: number;
  format?: VideoFormat | ImageFormat;
}

export interface TrimAudioRequest {
  input: string;
  startSec?: number;
  endSec?: number;
  format?: AudioFormat;
}

export interface GifRequest {
  input: string;
  fps?: number;
  maxWidth?: number;
  startSec?: number;
  endSec?: number;
}

/** HD upscale target. `ffmpeg` now; swap engine later for Real-ESRGAN etc. */
export type HdTarget = '2x' | '1080p' | '1440p' | '4k';
export type EnhanceEngine = 'ffmpeg' | 'ai';

export interface EnhanceHdRequest {
  kind: 'video' | 'image';
  input: string;
  target?: HdTarget;
  format?: VideoFormat | ImageFormat;
  /** Reserved for future AI backends. Default ffmpeg. */
  engine?: EnhanceEngine;
}

export type DenoiseStrength = 'low' | 'medium' | 'high';

export interface DenoiseAudioRequest {
  input: string;
  strength?: DenoiseStrength;
  startSec?: number;
  endSec?: number;
  format?: AudioFormat;
  /** Reserved for future AI denoise. Default ffmpeg. */
  engine?: EnhanceEngine;
}

/** Region-based watermark removal. `ffmpeg` removelogo now; AI reserved. */
export interface RemoveWatermarkRequest {
  kind: 'video' | 'image';
  input: string;
  x: number;
  y: number;
  width: number;
  height: number;
  format?: VideoFormat | ImageFormat;
  /** Reserved for future AI backends. Default ffmpeg. */
  engine?: EnhanceEngine;
}

export const HD_TARGETS: HdTarget[] = ['2x', '1080p', '1440p', '4k'];
export const DENOISE_STRENGTHS: DenoiseStrength[] = ['low', 'medium', 'high'];

export type CompressPreset = 'high' | 'medium' | 'small';
export const COMPRESS_PRESETS: CompressPreset[] = ['high', 'medium', 'small'];

export interface CompressRequest {
  kind: 'video' | 'image';
  input: string;
  preset?: CompressPreset;
  format?: VideoFormat | ImageFormat;
}

export type OrientOp = 'rotate90' | 'rotate180' | 'rotate270' | 'flipH' | 'flipV';
export const ORIENT_OPS: OrientOp[] = ['rotate90', 'rotate180', 'rotate270', 'flipH', 'flipV'];

export interface OrientRequest {
  kind: 'video' | 'image';
  input: string;
  op: OrientOp;
  format?: VideoFormat | ImageFormat;
}

export const SPEED_RATES = [0.5, 1.5, 2] as const;
export type SpeedRate = (typeof SPEED_RATES)[number];

export interface SpeedRequest {
  input: string;
  rate: SpeedRate;
  /** Shift pitch together with speed. Default keeps the original pitch. */
  changePitch?: boolean;
  format?: VideoFormat;
}

export type ExtractMode = 'audio' | 'mute';

export interface ExtractRequest {
  input: string;
  mode: ExtractMode;
  format?: VideoFormat | AudioFormat;
}

export interface SnapshotRequest {
  input: string;
  timeSec?: number;
  format?: ImageFormat;
}

export type AspectRatio = '16:9' | '1:1' | '9:16';
export const ASPECT_RATIOS: AspectRatio[] = ['16:9', '1:1', '9:16'];

export interface AspectRequest {
  kind: 'video' | 'image';
  input: string;
  ratio: AspectRatio;
  format?: VideoFormat | ImageFormat;
}

export type StampPosition = 'tl' | 'tr' | 'bl' | 'br' | 'center';
export const STAMP_POSITIONS: StampPosition[] = ['tl', 'tr', 'bl', 'br', 'center'];

export interface StampRequest {
  kind: 'video' | 'image';
  input: string;
  mode: 'text' | 'logo';
  text?: string;
  logo?: string;
  position?: StampPosition;
  format?: VideoFormat | ImageFormat;
}

export interface LoudnormRequest {
  kind: 'video' | 'audio';
  input: string;
  format?: VideoFormat | AudioFormat;
}

export type ResizeMode = 'width' | 'height' | 'percent';
export const RESIZE_MODES: ResizeMode[] = ['width', 'height', 'percent'];

export interface ResizeRequest {
  input: string;
  mode: ResizeMode;
  value: number;
  format?: ImageFormat;
}

export type VideoAdjustOutput = 'video' | 'audio' | 'frame';

export interface VideoAdjustRequest {
  input: string;
  output?: VideoAdjustOutput;
  format?: VideoFormat | ImageFormat | AudioFormat;
  orient?: OrientOp;
  ratio?: AspectRatio;
  rate?: SpeedRate;
  changePitch?: boolean;
  preset?: CompressPreset;
  mute?: boolean;
  loudnorm?: boolean;
  timeSec?: number;
  stampMode?: 'text' | 'logo';
  text?: string;
  logo?: string;
  position?: StampPosition;
}

export interface MediaJobResult {
  tempPath: string;
  suggestedName: string;
  format: MediaFormat;
  kind: MediaKind;
}

export interface ExportRequest {
  tempPath: string;
  suggestedName: string;
  format: MediaFormat;
  orderId: string;
}

export interface MediaProgressEvent {
  phase: 'running' | 'done' | 'error';
  percent: number;
  message: string;
}

export interface MediaApi {
  pickMedia(kind: MediaKind): Promise<string | null>;
  probe(path: string, kind?: MediaKind): Promise<MediaProbe>;
  convert(request: ConvertRequest): Promise<MediaJobResult>;
  crop(request: CropRequest): Promise<MediaJobResult>;
  trimAudio(request: TrimAudioRequest): Promise<MediaJobResult>;
  toGif(request: GifRequest): Promise<MediaJobResult>;
  enhanceHd(request: EnhanceHdRequest): Promise<MediaJobResult>;
  denoiseAudio(request: DenoiseAudioRequest): Promise<MediaJobResult>;
  removeWatermark(request: RemoveWatermarkRequest): Promise<MediaJobResult>;
  compress(request: CompressRequest): Promise<MediaJobResult>;
  orient(request: OrientRequest): Promise<MediaJobResult>;
  changeSpeed(request: SpeedRequest): Promise<MediaJobResult>;
  extractMedia(request: ExtractRequest): Promise<MediaJobResult>;
  snapshot(request: SnapshotRequest): Promise<MediaJobResult>;
  fitAspect(request: AspectRequest): Promise<MediaJobResult>;
  stamp(request: StampRequest): Promise<MediaJobResult>;
  loudnorm(request: LoudnormRequest): Promise<MediaJobResult>;
  resizeImage(request: ResizeRequest): Promise<MediaJobResult>;
  adjustVideo(request: VideoAdjustRequest): Promise<MediaJobResult>;
  exportFile(request: ExportRequest): Promise<string | null>;
  previewUrl(path: string): string;
  /** Resolve OS path from a dropped File (Electron webUtils). */
  pathForFile(file: File): string;
  onProgress(handler: (event: MediaProgressEvent) => void): () => void;
}

export const MediaIpc = {
  pick: 'media:pick',
  probe: 'media:probe',
  convert: 'media:convert',
  crop: 'media:crop',
  trimAudio: 'media:trimAudio',
  gif: 'media:gif',
  enhanceHd: 'media:enhanceHd',
  denoiseAudio: 'media:denoiseAudio',
  removeWatermark: 'media:removeWatermark',
  compress: 'media:compress',
  orient: 'media:orient',
  speed: 'media:speed',
  extract: 'media:extract',
  snapshot: 'media:snapshot',
  aspect: 'media:aspect',
  stamp: 'media:stamp',
  loudnorm: 'media:loudnorm',
  resize: 'media:resize',
  adjust: 'media:adjust',
  export: 'media:export',
  progress: 'media:progress',
} as const;

export const MEDIA_SCHEME = 'vsmedia';

export function toMediaPreviewUrl(filePath: string): string {
  return `${MEDIA_SCHEME}://local/?path=${encodeURIComponent(filePath)}`;
}

export function isImageFormat(format: MediaFormat): boolean {
  return (IMAGE_FORMATS as string[]).includes(format);
}

export function isAudioFormat(format: MediaFormat): boolean {
  return (AUDIO_FORMATS as string[]).includes(format);
}

export function defaultFormatForKind(kind: MediaKind): VideoFormat | ImageFormat | AudioFormat {
  if (kind === 'image') return 'png';
  if (kind === 'audio') return 'mp3';
  return 'mp4';
}

export function formatsForKind(kind: MediaKind): readonly string[] {
  if (kind === 'image') return IMAGE_FORMATS;
  if (kind === 'audio') return AUDIO_FORMATS;
  return VIDEO_FORMATS;
}
