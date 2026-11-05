import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, statSync, unlinkSync } from 'node:fs';
import { copyFile } from 'node:fs/promises';
import path from 'node:path';
import { app } from 'electron';
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
  EnhanceHdRequest,
  ExtractRequest,
  GifRequest,
  HdTarget,
  ImageFormat,
  LoudnormRequest,
  MediaFormat,
  MediaJobResult,
  MediaKind,
  MediaProbe,
  MediaProgressEvent,
  OrientOp,
  OrientRequest,
  RemoveWatermarkRequest,
  ResizeMode,
  ResizeRequest,
  SnapshotRequest,
  SpeedRequest,
  StampPosition,
  StampRequest,
  TrimAudioRequest,
  VideoAdjustRequest,
  VideoFormat,
} from '../shared/media';
import { AUDIO_FORMATS, IMAGE_FORMATS, VIDEO_FORMATS } from '../shared/media';

const nodeRequire = createRequire(__filename);
const tempOutputs = new Set<string>();

type ProgressSink = (event: MediaProgressEvent) => void;

function resolveBinary(packageName: 'ffmpeg-static' | 'ffprobe-static'): string {
  let resolved: string;
  if (packageName === 'ffmpeg-static') {
    const value = nodeRequire('ffmpeg-static') as string | null;
    if (!value) {
      throw new Error('ffmpeg-static 未找到二进制。');
    }
    resolved = value;
  } else {
    const mod = nodeRequire('ffprobe-static') as { path: string };
    resolved = mod.path;
  }
  const unpacked = resolved.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
  if (existsSync(unpacked)) {
    return unpacked;
  }
  if (existsSync(resolved)) {
    return resolved;
  }
  throw new Error(`找不到 ${packageName} 可执行文件：${resolved}`);
}

function assertInput(filePath: string, label = '文件'): string {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    throw new Error(`请选择${label}。`);
  }
  const absolute = path.resolve(filePath);
  if (!path.isAbsolute(absolute)) {
    throw new Error(`${label}路径必须是绝对路径。`);
  }
  if (!existsSync(absolute)) {
    throw new Error(`文件不存在：${absolute}`);
  }
  return absolute;
}

function tempDir(): string {
  const dir = path.join(app.getPath('temp'), 'video-studio');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function suggestedName(input: string, suffix: string, format: MediaFormat): string {
  const base = path.basename(input, path.extname(input));
  return `${base}${suffix}.${format}`;
}

function createTempOutput(input: string, suffix: string, format: MediaFormat): { tempPath: string; suggestedName: string } {
  const name = suggestedName(input, suffix, format);
  const tempPath = path.join(tempDir(), `${Date.now()}-${name}`);
  tempOutputs.add(tempPath);
  return { tempPath, suggestedName: name };
}

function clipDurationSec(
  infoDuration: number,
  startSec?: number,
  endSec?: number,
): number {
  if (typeof startSec !== 'number' && typeof endSec !== 'number') {
    return infoDuration;
  }
  const start = startSec || 0;
  const end = endSec ?? infoDuration;
  return Math.max(0.1, end - start);
}

/** Append -ss / -t before -i for a time window. */
function appendClipSeek(args: string[], startSec?: number, endSec?: number): void {
  const start = typeof startSec === 'number' && startSec > 0 ? startSec : 0;
  if (typeof endSec === 'number' && endSec > 0 && endSec <= start) {
    throw new Error('结束时间必须大于开始时间。');
  }
  if (start > 0) {
    args.push('-ss', String(start));
  }
  if (typeof endSec === 'number' && endSec > 0) {
    args.push('-t', String(endSec - start));
  }
}

export function isTrackedTemp(filePath: string): boolean {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    return false;
  }
  return tempOutputs.has(path.resolve(filePath));
}

export function forgetTemp(filePath: string): void {
  tempOutputs.delete(path.resolve(filePath));
}

export function cleanupTempOutputs(): void {
  for (const file of tempOutputs) {
    try {
      if (existsSync(file)) {
        unlinkSync(file);
      }
    } catch {
      // ignore
    }
  }
  tempOutputs.clear();
}

function encoderArgs(format: VideoFormat): string[] {
  switch (format) {
    case 'webm':
      return ['-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '32', '-c:a', 'libopus'];
    case 'mp4':
    case 'mov':
    case 'mkv':
      return ['-c:v', 'libx264', '-preset', 'medium', '-crf', '23', '-c:a', 'aac', '-movflags', '+faststart'];
    default:
      return ['-c:v', 'libx264', '-c:a', 'aac'];
  }
}

function imageEncoderArgs(format: ImageFormat): string[] {
  switch (format) {
    case 'jpg':
      return ['-q:v', '2'];
    case 'png':
      return ['-compression_level', '6'];
    case 'webp':
      return ['-quality', '80'];
    case 'bmp':
      return [];
    default:
      return [];
  }
}

function audioEncoderArgs(format: AudioFormat): string[] {
  switch (format) {
    case 'mp3':
      return ['-vn', '-c:a', 'libmp3lame', '-q:a', '2'];
    case 'aac':
      return ['-vn', '-c:a', 'aac', '-b:a', '192k'];
    case 'wav':
      return ['-vn', '-c:a', 'pcm_s16le'];
    case 'flac':
      return ['-vn', '-c:a', 'flac'];
    case 'ogg':
      return ['-vn', '-c:a', 'libvorbis', '-q:a', '5'];
    default:
      return ['-vn', '-c:a', 'aac'];
  }
}

function isVideoFormat(format: string): format is VideoFormat {
  return (VIDEO_FORMATS as string[]).includes(format);
}

function isImageFormat(format: string): format is ImageFormat {
  return (IMAGE_FORMATS as string[]).includes(format);
}

function isAudioFormat(format: string): format is AudioFormat {
  return (AUDIO_FORMATS as string[]).includes(format);
}

function parseDuration(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function parseBitrate(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

function parseRatio(value: string | undefined): number {
  if (!value || value === '0/0' || value === 'N/A') {
    return 0;
  }
  if (value.includes('/')) {
    const [num, den] = value.split('/').map((part) => Number(part));
    if (Number.isFinite(num) && Number.isFinite(den) && den > 0) {
      return num / den;
    }
    return 0;
  }
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function parseFrameRate(avg: string | undefined, raw: string | undefined): number {
  const primary = parseRatio(avg);
  if (primary >= 1 && primary <= 240) {
    return primary;
  }
  const fallback = parseRatio(raw);
  if (fallback >= 1 && fallback <= 240) {
    return fallback;
  }
  return 0;
}

type ProbeStream = {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  sample_aspect_ratio?: string;
  pix_fmt?: string;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  bit_rate?: string;
  sample_rate?: string;
  channels?: number;
  channel_layout?: string;
  bits_per_sample?: number;
  bits_per_raw_sample?: number | string;
  duration?: string;
  disposition?: { attached_pic?: number };
  tags?: { rotate?: string };
  side_data_list?: Array<{ rotation?: number }>;
};

function isAttachedPicture(stream: ProbeStream): boolean {
  return stream.disposition?.attached_pic === 1;
}

function readRotation(stream: ProbeStream | undefined): number {
  if (!stream) {
    return 0;
  }
  const fromSide = stream.side_data_list?.find((item) => typeof item.rotation === 'number');
  const raw = fromSide?.rotation ?? Number(stream.tags?.rotate);
  if (!Number.isFinite(raw)) {
    return 0;
  }
  return ((Math.round(raw) % 360) + 360) % 360;
}

/** Visual size: sample aspect ratio first, then display rotation. */
function visualSize(
  width: number,
  height: number,
  sampleAspect: string | undefined,
  rotation: number,
): { width: number; height: number } {
  let nextWidth = width;
  let nextHeight = height;
  if (sampleAspect && sampleAspect.includes(':') && sampleAspect !== '1:1' && sampleAspect !== '0:1') {
    const [num, den] = sampleAspect.split(':').map((part) => Number(part));
    if (num > 0 && den > 0 && num !== den) {
      nextWidth = Math.max(1, Math.round(width * num / den));
    }
  }
  if (rotation === 90 || rotation === 270) {
    return { width: nextHeight, height: nextWidth };
  }
  return { width: nextWidth, height: nextHeight };
}

function parseTimeToSeconds(stamp: string): number {
  const parts = stamp.split(':').map((part) => Number(part));
  if (parts.some((part) => !Number.isFinite(part))) {
    return 0;
  }
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }
  return parts[0] || 0;
}

function runProcess(
  bin: string,
  args: string[],
  onStderrLine?: (line: string) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
      const lines = chunk.split(/\r?\n/);
      for (const line of lines) {
        if (line.trim()) {
          onStderrLine?.(line);
        }
      }
    });
    child.on('error', (error) => reject(error));
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const summary = stderr.trim().split(/\r?\n/).slice(-8).join('\n') || `退出码 ${code}`;
      reject(new Error(summary));
    });
  });
}

export async function probeMedia(filePath: string, expectedKind?: MediaKind): Promise<MediaProbe> {
  const input = assertInput(filePath);
  const ffprobe = resolveBinary('ffprobe-static');
  const args = [
    '-v', 'quiet',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    input,
  ];
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn(ffprobe, args, { windowsHide: true });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { out += chunk; });
    child.stderr.on('data', (chunk: string) => { err += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(out);
        return;
      }
      reject(new Error(err.trim() || `ffprobe 失败（${code}）`));
    });
  });

  const json = JSON.parse(stdout) as {
    format?: { duration?: string; format_name?: string; size?: string; bit_rate?: string };
    streams?: ProbeStream[];
  };
  const streams = json.streams || [];
  const video = streams.find((stream) => stream.codec_type === 'video' && !isAttachedPicture(stream));
  const audio = streams.find((stream) => stream.codec_type === 'audio');
  const formatDuration = parseDuration(json.format?.duration);
  const streamDuration = streams.reduce((max, stream) => Math.max(max, parseDuration(stream.duration)), 0);
  const durationSec = formatDuration > 0 ? formatDuration : streamDuration;
  const formatName = json.format?.format_name || path.extname(input).slice(1) || 'unknown';

  let kind: MediaKind;
  if (expectedKind) {
    kind = expectedKind;
  } else if (video?.width && video.height && durationSec > 0.5 && audio) {
    kind = 'video';
  } else if (video?.width && video.height && (!audio || durationSec <= 0.5)) {
    kind = 'image';
  } else if (audio) {
    kind = 'audio';
  } else if (video?.width && video.height) {
    kind = 'video';
  } else {
    throw new Error('未识别到可处理的媒体流。');
  }

  if (kind === 'video' || kind === 'image') {
    if (!video?.width || !video.height) {
      throw new Error(kind === 'image' ? '未识别到图片尺寸。' : '未识别到视频流。');
    }
  }
  if (kind === 'audio' && !audio) {
    throw new Error('未识别到音频流。');
  }
  if (expectedKind === 'video' && (!video?.width || !video.height)) {
    throw new Error('请选择视频文件。');
  }
  if (expectedKind === 'image' && (!video?.width || !video.height)) {
    throw new Error('请选择图片文件。');
  }
  if (expectedKind === 'audio' && !audio) {
    throw new Error('请选择音频文件。');
  }

  const width = video?.width || 0;
  const height = video?.height || 0;
  const rotation = kind === 'audio' ? 0 : readRotation(video);
  const display = kind === 'audio' || !width || !height
    ? { width: 0, height: 0 }
    : visualSize(width, height, video?.sample_aspect_ratio, rotation);
  const videoBitrateBps = kind === 'image' ? 0 : parseBitrate(video?.bit_rate);
  const audioBitrateBps = parseBitrate(audio?.bit_rate);
  const containerBitrate = kind === 'image' ? 0 : parseBitrate(json.format?.bit_rate);
  const bitsPerSample = Number(audio?.bits_per_sample) || Number(audio?.bits_per_raw_sample) || 0;

  return {
    kind,
    path: input,
    durationSec: kind === 'image' ? 0 : durationSec,
    width,
    height,
    displayWidth: display.width,
    displayHeight: display.height,
    videoCodec: video?.codec_name || 'none',
    audioCodec: audio?.codec_name || 'none',
    formatName,
    sizeBytes: Number(json.format?.size) || statSync(input).size,
    bitrateBps: containerBitrate || videoBitrateBps + audioBitrateBps,
    videoBitrateBps,
    audioBitrateBps,
    frameRate: kind === 'video' ? parseFrameRate(video?.avg_frame_rate, video?.r_frame_rate) : 0,
    sampleRate: Number(audio?.sample_rate) || 0,
    channels: audio?.channels || 0,
    channelLayout: audio?.channel_layout || '',
    bitsPerSample: Number.isFinite(bitsPerSample) && bitsPerSample > 0 ? bitsPerSample : 0,
    pixelFormat: kind === 'audio' ? '' : (video?.pix_fmt || ''),
    rotation,
  };
}

/** @deprecated use probeMedia */
export async function probeVideo(filePath: string): Promise<MediaProbe> {
  return probeMedia(filePath, 'video');
}

async function runFfmpegJob(
  args: string[],
  durationSec: number,
  sink?: ProgressSink,
): Promise<void> {
  const ffmpeg = resolveBinary('ffmpeg-static');
  sink?.({ phase: 'running', percent: 0, message: '开始处理' });
  try {
    await runProcess(ffmpeg, args, (line) => {
      const match = /time=(\d+:\d+:\d+(?:\.\d+)?)/.exec(line);
      if (!match || durationSec <= 0) {
        return;
      }
      const current = parseTimeToSeconds(match[1]);
      const percent = Math.max(0, Math.min(99, Math.round((current / durationSec) * 100)));
      sink?.({ phase: 'running', percent, message: `已处理 ${match[1]}` });
    });
    sink?.({ phase: 'done', percent: 100, message: '完成' });
  } catch (error) {
    const message = error instanceof Error ? error.message : '处理失败';
    sink?.({ phase: 'error', percent: 0, message });
    throw error;
  }
}

export async function convertMedia(
  request: ConvertRequest,
  sink?: ProgressSink,
): Promise<MediaJobResult> {
  if (request.kind === 'image') {
    return convertImage(request, sink);
  }
  if (request.kind === 'audio') {
    return convertAudio(request, sink);
  }
  return convertVideo(request, sink);
}

export async function convertVideo(
  request: ConvertRequest,
  sink?: ProgressSink,
): Promise<MediaJobResult> {
  const input = assertInput(request.input, '视频');
  if (!isVideoFormat(request.format)) {
    throw new Error('不支持的视频格式。');
  }
  const format = request.format;
  const { tempPath, suggestedName: name } = createTempOutput(input, '_converted', format);
  const info = await probeMedia(input, 'video');
  const args = [
    '-y',
    '-i', input,
    ...encoderArgs(format),
    tempPath,
  ];
  await runFfmpegJob(args, info.durationSec, sink);
  return { tempPath, suggestedName: name, format, kind: 'video' };
}

export async function convertImage(
  request: ConvertRequest,
  sink?: ProgressSink,
): Promise<MediaJobResult> {
  const input = assertInput(request.input, '图片');
  if (!isImageFormat(request.format)) {
    throw new Error('不支持的图片格式。');
  }
  const format = request.format;
  const { tempPath, suggestedName: name } = createTempOutput(input, '_converted', format);
  await probeMedia(input, 'image');
  const args = ['-y', '-i', input, ...imageEncoderArgs(format), tempPath];
  sink?.({ phase: 'running', percent: 10, message: '转换图片' });
  await runFfmpegJob(args, 1, sink);
  return { tempPath, suggestedName: name, format, kind: 'image' };
}

export async function convertAudio(
  request: ConvertRequest,
  sink?: ProgressSink,
): Promise<MediaJobResult> {
  const input = assertInput(request.input, '音频');
  if (!isAudioFormat(request.format)) {
    throw new Error('不支持的音频格式。');
  }
  const format = request.format;
  const { tempPath, suggestedName: name } = createTempOutput(input, '_converted', format);
  const info = await probeMedia(input, 'audio');
  const args = ['-y', '-i', input, ...audioEncoderArgs(format), tempPath];
  await runFfmpegJob(args, info.durationSec, sink);
  return { tempPath, suggestedName: name, format, kind: 'audio' };
}

export async function cropMedia(
  request: CropRequest,
  sink?: ProgressSink,
): Promise<MediaJobResult> {
  if (request.kind === 'image') {
    return cropImage(request, sink);
  }
  return cropVideo(request, sink);
}

export async function cropVideo(
  request: CropRequest,
  sink?: ProgressSink,
): Promise<MediaJobResult> {
  const input = assertInput(request.input, '视频');
  const info = await probeMedia(input, 'video');
  const x = Math.floor(request.x);
  const y = Math.floor(request.y);
  const width = Math.floor(request.width);
  const height = Math.floor(request.height);
  if (x < 0 || y < 0 || width <= 0 || height <= 0) {
    throw new Error('裁剪区域不合法。');
  }
  if (x + width > info.width || y + height > info.height) {
    throw new Error(`裁剪超出画面（${info.width}×${info.height}）。`);
  }
  const format = (request.format && isVideoFormat(request.format) ? request.format : 'mp4');
  const { tempPath, suggestedName: name } = createTempOutput(input, '_cropped', format);

  const args = ['-y'];
  appendClipSeek(args, request.startSec, request.endSec);
  args.push('-i', input, '-vf', `crop=${width}:${height}:${x}:${y}`, ...encoderArgs(format), tempPath);

  const durationSec = clipDurationSec(info.durationSec, request.startSec, request.endSec);
  await runFfmpegJob(args, durationSec, sink);
  return { tempPath, suggestedName: name, format, kind: 'video' };
}

export async function cropImage(
  request: CropRequest,
  sink?: ProgressSink,
): Promise<MediaJobResult> {
  const input = assertInput(request.input, '图片');
  const info = await probeMedia(input, 'image');
  const x = Math.floor(request.x);
  const y = Math.floor(request.y);
  const width = Math.floor(request.width);
  const height = Math.floor(request.height);
  if (x < 0 || y < 0 || width <= 0 || height <= 0) {
    throw new Error('裁剪区域不合法。');
  }
  if (x + width > info.width || y + height > info.height) {
    throw new Error(`裁剪超出画面（${info.width}×${info.height}）。`);
  }
  const format = (request.format && isImageFormat(request.format) ? request.format : 'png');
  const { tempPath, suggestedName: name } = createTempOutput(input, '_cropped', format);
  const args = [
    '-y',
    '-i', input,
    '-vf', `crop=${width}:${height}:${x}:${y}`,
    ...imageEncoderArgs(format),
    tempPath,
  ];
  sink?.({ phase: 'running', percent: 10, message: '裁剪图片' });
  await runFfmpegJob(args, 1, sink);
  return { tempPath, suggestedName: name, format, kind: 'image' };
}

export async function trimAudio(
  request: TrimAudioRequest,
  sink?: ProgressSink,
): Promise<MediaJobResult> {
  const input = assertInput(request.input, '音频');
  const info = await probeMedia(input, 'audio');
  const format = (request.format && isAudioFormat(request.format) ? request.format : 'mp3');
  const { tempPath, suggestedName: name } = createTempOutput(input, '_trimmed', format);
  const args = ['-y'];
  appendClipSeek(args, request.startSec, request.endSec);
  args.push('-i', input, ...audioEncoderArgs(format), tempPath);
  const durationSec = clipDurationSec(info.durationSec, request.startSec, request.endSec);
  await runFfmpegJob(args, durationSec, sink);
  return { tempPath, suggestedName: name, format, kind: 'audio' };
}

export async function videoToGif(
  request: GifRequest,
  sink?: ProgressSink,
): Promise<MediaJobResult> {
  const input = assertInput(request.input, '视频');
  const info = await probeMedia(input, 'video');
  const fps = Math.max(1, Math.min(30, Math.round(request.fps ?? 10)));
  const maxWidth = Math.max(0, Math.round(request.maxWidth ?? 480));
  const scaleFilter = maxWidth > 0 && maxWidth < info.width
    ? `scale=${maxWidth}:-1:flags=lanczos`
    : 'scale=iw:ih:flags=lanczos';
  const baseVf = `fps=${fps},${scaleFilter}`;

  const { tempPath, suggestedName: name } = createTempOutput(input, '_gif', 'gif');
  const palettePath = path.join(tempDir(), `${Date.now()}-palette.png`);
  const durationSec = clipDurationSec(info.durationSec, request.startSec, request.endSec);

  try {
    const paletteArgs = ['-y'];
    appendClipSeek(paletteArgs, request.startSec, request.endSec);
    paletteArgs.push('-i', input, '-vf', `${baseVf},palettegen=stats_mode=diff`, palettePath);

    sink?.({ phase: 'running', percent: 0, message: '生成调色板' });
    await runFfmpegJob(paletteArgs, durationSec, (event) => {
      if (event.phase === 'running') {
        sink?.({
          phase: 'running',
          percent: Math.min(40, Math.round(event.percent * 0.4)),
          message: '生成调色板',
        });
      }
    });

    const gifArgs = ['-y'];
    appendClipSeek(gifArgs, request.startSec, request.endSec);
    gifArgs.push(
      '-i', input,
      '-i', palettePath,
      '-lavfi',
      `${baseVf}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`,
      '-loop', '0',
      tempPath,
    );

    sink?.({ phase: 'running', percent: 45, message: '编码 GIF' });
    await runFfmpegJob(gifArgs, durationSec, (event) => {
      if (event.phase === 'running') {
        sink?.({
          phase: 'running',
          percent: Math.min(99, 45 + Math.round(event.percent * 0.55)),
          message: '编码 GIF',
        });
      } else if (event.phase === 'done') {
        sink?.({ phase: 'done', percent: 100, message: '完成' });
      } else {
        sink?.(event);
      }
    });
  } finally {
    try {
      if (existsSync(palettePath)) {
        unlinkSync(palettePath);
      }
    } catch {
      // ignore
    }
  }

  return { tempPath, suggestedName: name, format: 'gif', kind: 'video' };
}

function evenDim(value: number): number {
  const rounded = Math.max(2, Math.round(value));
  return rounded % 2 === 0 ? rounded : rounded + 1;
}

/** Resolve output size for HD enhance. Never downscales below source. */
export function resolveHdSize(
  srcW: number,
  srcH: number,
  target: HdTarget,
): { width: number; height: number } {
  if (target === '2x') {
    return { width: evenDim(srcW * 2), height: evenDim(srcH * 2) };
  }
  const longEdge = target === '1080p' ? 1920 : target === '1440p' ? 2560 : 3840;
  const srcLong = Math.max(srcW, srcH) || 1;
  const scale = Math.max(1, longEdge / srcLong);
  return {
    width: evenDim(srcW * scale),
    height: evenDim(srcH * scale),
  };
}

function hdFilter(width: number, height: number): string {
  // Lightweight upscale + mild sharpen; replaceable by AI engine later.
  return `scale=${width}:${height}:flags=lanczos,unsharp=5:5:0.8:5:5:0.0`;
}

function denoiseFilter(strength: DenoiseStrength): string {
  const nr = strength === 'low' ? 6 : strength === 'high' ? 20 : 12;
  return `afftdn=nr=${nr}:nf=-25`;
}

/**
 * Upscale video/image toward HD. engine=ffmpeg (default); ai reserved.
 */
export async function enhanceHd(
  request: EnhanceHdRequest,
  sink?: ProgressSink,
): Promise<MediaJobResult> {
  const engine = request.engine || 'ffmpeg';
  if (engine !== 'ffmpeg') {
    throw new Error('AI 超分尚未接入，请使用默认引擎。');
  }
  const label = request.kind === 'image' ? '图片' : '视频';
  const input = assertInput(request.input, label);
  const info = await probeMedia(input, request.kind);
  if (!info.width || !info.height) {
    throw new Error('无法读取分辨率。');
  }
  const target = request.target || '1080p';
  const size = resolveHdSize(info.width, info.height, target);
  const vf = hdFilter(size.width, size.height);

  if (request.kind === 'image') {
    const format = (request.format && isImageFormat(request.format) ? request.format : 'png');
    const { tempPath, suggestedName: name } = createTempOutput(input, '_hd', format);
    const args = ['-y', '-i', input, '-vf', vf, ...imageEncoderArgs(format), tempPath];
    sink?.({ phase: 'running', percent: 10, message: '转高清' });
    await runFfmpegJob(args, 1, sink);
    return { tempPath, suggestedName: name, format, kind: 'image' };
  }

  const format = (request.format && isVideoFormat(request.format) ? request.format : 'mp4');
  const { tempPath, suggestedName: name } = createTempOutput(input, '_hd', format);
  const args = ['-y', '-i', input, '-vf', vf, ...encoderArgs(format), tempPath];
  await runFfmpegJob(args, info.durationSec, sink);
  return { tempPath, suggestedName: name, format, kind: 'video' };
}

/**
 * Denoise audio. engine=ffmpeg afftdn (default); ai reserved.
 */
export async function denoiseAudio(
  request: DenoiseAudioRequest,
  sink?: ProgressSink,
): Promise<MediaJobResult> {
  const engine = request.engine || 'ffmpeg';
  if (engine !== 'ffmpeg') {
    throw new Error('AI 降噪尚未接入，请使用默认引擎。');
  }
  const input = assertInput(request.input, '音频');
  const info = await probeMedia(input, 'audio');
  const strength = request.strength || 'medium';
  const format = (request.format && isAudioFormat(request.format) ? request.format : 'mp3');
  const { tempPath, suggestedName: name } = createTempOutput(input, '_denoise', format);
  const args = ['-y'];
  appendClipSeek(args, request.startSec, request.endSec);
  args.push('-i', input, '-af', denoiseFilter(strength), ...audioEncoderArgs(format), tempPath);
  const durationSec = clipDurationSec(info.durationSec, request.startSec, request.endSec);
  await runFfmpegJob(args, durationSec, sink);
  return { tempPath, suggestedName: name, format, kind: 'audio' };
}

function assertDelogoRect(
  info: MediaProbe,
  x: number,
  y: number,
  width: number,
  height: number,
): { x: number; y: number; width: number; height: number } {
  const rx = Math.floor(x);
  const ry = Math.floor(y);
  const rw = Math.floor(width);
  const rh = Math.floor(height);
  if (rw < 2 || rh < 2) {
    throw new Error('去水印区域太小（宽高至少 2 像素）。');
  }
  if (rx < 0 || ry < 0 || rw <= 0 || rh <= 0) {
    throw new Error('去水印区域不合法。');
  }
  if (rx + rw > info.width || ry + rh > info.height) {
    throw new Error(`去水印区域超出画面（${info.width}×${info.height}）。`);
  }
  // removelogo / delogo need neighbors outside the logo for fill.
  if (rx < 1 || ry < 1 || rx + rw > info.width - 1 || ry + rh > info.height - 1) {
    throw new Error('去水印区域需距画面边缘至少 1 像素。');
  }
  return { x: rx, y: ry, width: rw, height: rh };
}

function escapeFilterPath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

/**
 * Build a full-frame mask (white = remove) for removelogo.
 * Soft edge avoids hard rectangular artifacts.
 */
async function createWatermarkMask(
  frameW: number,
  frameH: number,
  rect: { x: number; y: number; width: number; height: number },
): Promise<string> {
  const ffmpeg = resolveBinary('ffmpeg-static');
  const maskPath = path.join(tempDir(), `wm_mask_${Date.now()}.png`);
  const vf = [
    `drawbox=x=${rect.x}:y=${rect.y}:w=${rect.width}:h=${rect.height}:color=white:t=fill`,
    'gblur=sigma=1.5',
  ].join(',');
  await runProcess(ffmpeg, [
    '-y',
    '-f', 'lavfi',
    '-i', `color=c=black:s=${frameW}x${frameH}:d=1`,
    '-vf', vf,
    '-frames:v', '1',
    maskPath,
  ]);
  tempOutputs.add(path.resolve(maskPath));
  return maskPath;
}

function watermarkVideoEncoderArgs(format: VideoFormat): string[] {
  // Prefer higher visual fidelity so non-logo areas stay close to the source.
  switch (format) {
    case 'webm':
      return ['-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '28', '-c:a', 'copy'];
    case 'mp4':
    case 'mov':
    case 'mkv':
      return ['-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-c:a', 'copy', '-movflags', '+faststart'];
    default:
      return ['-c:v', 'libx264', '-crf', '18', '-c:a', 'copy'];
  }
}

/**
 * Remove a rectangular watermark via removelogo (neighbor fill).
 * Avoids delogo's cross-hatch look and blur/mosaic cover styles.
 * Video applies to the full clip (no time trim in v1).
 */
export async function removeWatermark(
  request: RemoveWatermarkRequest,
  sink?: ProgressSink,
): Promise<MediaJobResult> {
  const engine = request.engine || 'ffmpeg';
  if (engine !== 'ffmpeg') {
    throw new Error('AI 去水印尚未接入，请使用默认引擎。');
  }
  const label = request.kind === 'image' ? '图片' : '视频';
  const input = assertInput(request.input, label);
  const info = await probeMedia(input, request.kind);
  if (!info.width || !info.height) {
    throw new Error('无法读取分辨率。');
  }
  const rect = assertDelogoRect(info, request.x, request.y, request.width, request.height);
  const maskPath = await createWatermarkMask(info.width, info.height, rect);
  const vf = `removelogo=${escapeFilterPath(maskPath)}`;

  try {
    if (request.kind === 'image') {
      const format = (request.format && isImageFormat(request.format) ? request.format : 'png');
      const { tempPath, suggestedName: name } = createTempOutput(input, '_nowm', format);
      const args = ['-y', '-i', input, '-vf', vf, ...imageEncoderArgs(format), tempPath];
      sink?.({ phase: 'running', percent: 10, message: '去水印' });
      await runFfmpegJob(args, 1, sink);
      return { tempPath, suggestedName: name, format, kind: 'image' };
    }

    const format = (request.format && isVideoFormat(request.format) ? request.format : 'mp4');
    const { tempPath, suggestedName: name } = createTempOutput(input, '_nowm', format);
    const args = ['-y', '-i', input, '-vf', vf, ...watermarkVideoEncoderArgs(format), tempPath];
    try {
      await runFfmpegJob(args, info.durationSec, sink);
    } catch {
      // Some sources cannot stream-copy audio into the target container.
      const fallback = ['-y', '-i', input, '-vf', vf, ...encoderArgs(format), tempPath];
      sink?.({ phase: 'running', percent: 5, message: '去水印（重编码音频）' });
      await runFfmpegJob(fallback, info.durationSec, sink);
    }
    return { tempPath, suggestedName: name, format, kind: 'video' };
  } finally {
    try {
      if (existsSync(maskPath)) {
        unlinkSync(maskPath);
      }
    } catch {
      // ignore
    }
    forgetTemp(maskPath);
  }
}

function hasAudioStream(info: MediaProbe): boolean {
  return Boolean(info.audioCodec && info.audioCodec !== 'none');
}

function imageQualityArgs(format: ImageFormat, preset: CompressPreset): string[] {
  if (format === 'jpg') {
    const q = preset === 'high' ? '3' : preset === 'small' ? '12' : '7';
    return ['-q:v', q];
  }
  if (format === 'webp') {
    const quality = preset === 'high' ? '88' : preset === 'small' ? '45' : '70';
    return ['-quality', quality];
  }
  if (format === 'png') {
    const level = preset === 'high' ? '3' : preset === 'small' ? '9' : '6';
    return ['-compression_level', level];
  }
  return [];
}

function videoCompressArgs(format: VideoFormat, preset: CompressPreset): string[] {
  const crf = preset === 'high' ? '20' : preset === 'small' ? '32' : '28';
  const audioBitrate = preset === 'high' ? '128k' : preset === 'small' ? '64k' : '96k';
  if (format === 'webm') {
    return ['-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', crf, '-c:a', 'libopus', '-b:a', audioBitrate];
  }
  return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', crf, '-c:a', 'aac', '-b:a', audioBitrate, '-movflags', '+faststart'];
}

function orientFilter(op: OrientOp): string {
  if (op === 'rotate90') return 'transpose=1';
  if (op === 'rotate180') return 'hflip,vflip';
  if (op === 'rotate270') return 'transpose=2';
  if (op === 'flipH') return 'hflip';
  return 'vflip';
}

function aspectFilter(width: number, height: number, ratio: AspectRatio): string {
  const [rw, rh] = ratio.split(':').map((part) => Number(part));
  const target = rw / rh;
  const src = width / height;
  if (src > target) {
    const cropW = evenDim(height * target);
    const x = Math.max(0, Math.floor((width - cropW) / 2));
    return `crop=${Math.min(cropW, width)}:${height}:${x}:0`;
  }
  const cropH = evenDim(width / target);
  const y = Math.max(0, Math.floor((height - cropH) / 2));
  return `crop=${width}:${Math.min(cropH, height)}:0:${y}`;
}

function stampFont(): string {
  const candidates = process.platform === 'darwin'
    ? ['/System/Library/Fonts/PingFang.ttc', '/System/Library/Fonts/STHeiti Light.ttc', '/Library/Fonts/Arial Unicode.ttf']
    : process.platform === 'win32'
      ? ['C:/Windows/Fonts/msyh.ttc', 'C:/Windows/Fonts/arial.ttf']
      : ['/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'];
  const found = candidates.find((file) => existsSync(file));
  if (!found) {
    throw new Error('找不到可用于烧录文字的字体。');
  }
  return found;
}

function escapeDrawtext(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/%/g, '\\%');
}

function textOverlay(position: StampPosition): string {
  if (position === 'tl') return 'x=24:y=24';
  if (position === 'tr') return 'x=w-tw-24:y=24';
  if (position === 'bl') return 'x=24:y=h-th-24';
  if (position === 'center') return 'x=(w-tw)/2:y=(h-th)/2';
  return 'x=w-tw-24:y=h-th-24';
}

function logoOverlay(position: StampPosition): string {
  if (position === 'tl') return '24:24';
  if (position === 'tr') return 'W-w-24:24';
  if (position === 'bl') return '24:H-h-24';
  if (position === 'center') return '(W-w)/2:(H-h)/2';
  return 'W-w-24:H-h-24';
}

function resizeFilter(mode: ResizeMode, value: number): string {
  if (mode === 'percent') {
    return `scale=trunc(iw*${value}/100/2)*2:trunc(ih*${value}/100/2)*2`;
  }
  if (mode === 'height') {
    return `scale=-2:${evenDim(value)}`;
  }
  return `scale=${evenDim(value)}:-2`;
}

export async function compressMedia(
  request: CompressRequest,
  sink?: ProgressSink,
): Promise<MediaJobResult> {
  const preset = request.preset || 'medium';
  const label = request.kind === 'image' ? '图片' : '视频';
  const input = assertInput(request.input, label);
  const info = await probeMedia(input, request.kind);

  if (request.kind === 'image') {
    const format = (request.format && isImageFormat(request.format) ? request.format : 'jpg');
    const { tempPath, suggestedName: name } = createTempOutput(input, '_compressed', format);
    const maxWidth = preset === 'small' ? 1280 : preset === 'medium' ? 1920 : 0;
    const vf = maxWidth > 0 ? `scale='min(${maxWidth}\\,iw)':-2` : undefined;
    const args = ['-y', '-i', input];
    if (vf) args.push('-vf', vf);
    args.push(...imageQualityArgs(format, preset), tempPath);
    sink?.({ phase: 'running', percent: 10, message: '压缩图片' });
    await runFfmpegJob(args, 1, sink);
    return { tempPath, suggestedName: name, format, kind: 'image' };
  }

  const format = (request.format && isVideoFormat(request.format) ? request.format : 'mp4');
  const { tempPath, suggestedName: name } = createTempOutput(input, '_compressed', format);
  const maxWidth = preset === 'small' ? 854 : preset === 'medium' ? 1280 : 0;
  const args = ['-y', '-i', input];
  if (maxWidth > 0) {
    args.push('-vf', `scale='min(${maxWidth}\\,iw)':-2`);
  }
  args.push(...videoCompressArgs(format, preset), tempPath);
  await runFfmpegJob(args, info.durationSec, sink);
  return { tempPath, suggestedName: name, format, kind: 'video' };
}

export async function orientMedia(
  request: OrientRequest,
  sink?: ProgressSink,
): Promise<MediaJobResult> {
  const label = request.kind === 'image' ? '图片' : '视频';
  const input = assertInput(request.input, label);
  const info = await probeMedia(input, request.kind);
  const vf = orientFilter(request.op);
  if (request.kind === 'image') {
    const format = (request.format && isImageFormat(request.format) ? request.format : 'png');
    const { tempPath, suggestedName: name } = createTempOutput(input, '_oriented', format);
    await runFfmpegJob(['-y', '-i', input, '-vf', vf, ...imageEncoderArgs(format), tempPath], 1, sink);
    return { tempPath, suggestedName: name, format, kind: 'image' };
  }
  const format = (request.format && isVideoFormat(request.format) ? request.format : 'mp4');
  const { tempPath, suggestedName: name } = createTempOutput(input, '_oriented', format);
  await runFfmpegJob(['-y', '-i', input, '-vf', vf, ...encoderArgs(format), tempPath], info.durationSec, sink);
  return { tempPath, suggestedName: name, format, kind: 'video' };
}

export async function changeSpeed(
  request: SpeedRequest,
  sink?: ProgressSink,
): Promise<MediaJobResult> {
  const input = assertInput(request.input, '视频');
  const info = await probeMedia(input, 'video');
  const rate = request.rate;
  if (rate !== 0.5 && rate !== 1.5 && rate !== 2) {
    throw new Error('变速仅支持 0.5、1.5、2 倍。');
  }
  const format = (request.format && isVideoFormat(request.format) ? request.format : 'mp4');
  const { tempPath, suggestedName: name } = createTempOutput(input, `_${rate}x`, format);
  const args = ['-y', '-i', input, '-vf', `setpts=PTS/${rate}`];
  if (hasAudioStream(info)) {
    const audio = request.changePitch
      ? `asetrate=44100*${rate},aresample=44100`
      : `atempo=${rate}`;
    args.push('-af', audio, ...encoderArgs(format), tempPath);
  } else {
    const encode = encoderArgs(format).filter((part, index, list) => part !== '-c:a' && list[index - 1] !== '-c:a');
    args.push('-an', ...encode, tempPath);
  }
  await runFfmpegJob(args, info.durationSec / rate, sink);
  return { tempPath, suggestedName: name, format, kind: 'video' };
}

export async function extractMedia(
  request: ExtractRequest,
  sink?: ProgressSink,
): Promise<MediaJobResult> {
  const input = assertInput(request.input, '视频');
  const info = await probeMedia(input, 'video');
  if (request.mode === 'audio') {
    if (!hasAudioStream(info)) {
      throw new Error('这个视频没有音轨。');
    }
    const format = (request.format && isAudioFormat(request.format) ? request.format : 'mp3');
    const { tempPath, suggestedName: name } = createTempOutput(input, '_audio', format);
    await runFfmpegJob(['-y', '-i', input, ...audioEncoderArgs(format), tempPath], info.durationSec, sink);
    return { tempPath, suggestedName: name, format, kind: 'audio' };
  }
  const format = (request.format && isVideoFormat(request.format) ? request.format : 'mp4');
  const { tempPath, suggestedName: name } = createTempOutput(input, '_muted', format);
  const encode = encoderArgs(format).filter((part, index, list) => part !== '-c:a' && list[index - 1] !== '-c:a');
  await runFfmpegJob(['-y', '-i', input, '-an', ...encode, tempPath], info.durationSec, sink);
  return { tempPath, suggestedName: name, format, kind: 'video' };
}

export async function snapshotFrame(
  request: SnapshotRequest,
  sink?: ProgressSink,
): Promise<MediaJobResult> {
  const input = assertInput(request.input, '视频');
  const info = await probeMedia(input, 'video');
  const timeSec = Math.max(0, request.timeSec ?? 0);
  if (info.durationSec > 0 && timeSec > info.durationSec) {
    throw new Error(`截帧时间超出时长（${info.durationSec.toFixed(1)} 秒）。`);
  }
  const format = (request.format && isImageFormat(request.format) ? request.format : 'jpg');
  const { tempPath, suggestedName: name } = createTempOutput(input, '_frame', format);
  await runFfmpegJob(
    ['-y', '-ss', String(timeSec), '-i', input, '-frames:v', '1', ...imageEncoderArgs(format), tempPath],
    1,
    sink,
  );
  return { tempPath, suggestedName: name, format, kind: 'image' };
}

export async function fitAspect(
  request: AspectRequest,
  sink?: ProgressSink,
): Promise<MediaJobResult> {
  const label = request.kind === 'image' ? '图片' : '视频';
  const input = assertInput(request.input, label);
  const info = await probeMedia(input, request.kind);
  if (!info.width || !info.height) {
    throw new Error('无法读取分辨率。');
  }
  const vf = aspectFilter(info.width, info.height, request.ratio);
  if (request.kind === 'image') {
    const format = (request.format && isImageFormat(request.format) ? request.format : 'png');
    const { tempPath, suggestedName: name } = createTempOutput(input, `_${request.ratio.replace(':', 'x')}`, format);
    await runFfmpegJob(['-y', '-i', input, '-vf', vf, ...imageEncoderArgs(format), tempPath], 1, sink);
    return { tempPath, suggestedName: name, format, kind: 'image' };
  }
  const format = (request.format && isVideoFormat(request.format) ? request.format : 'mp4');
  const { tempPath, suggestedName: name } = createTempOutput(input, `_${request.ratio.replace(':', 'x')}`, format);
  await runFfmpegJob(['-y', '-i', input, '-vf', vf, ...encoderArgs(format), tempPath], info.durationSec, sink);
  return { tempPath, suggestedName: name, format, kind: 'video' };
}

export async function stampMedia(
  request: StampRequest,
  sink?: ProgressSink,
): Promise<MediaJobResult> {
  const label = request.kind === 'image' ? '图片' : '视频';
  const input = assertInput(request.input, label);
  const info = await probeMedia(input, request.kind);
  const position = request.position || 'br';
  const format = request.kind === 'image'
    ? (request.format && isImageFormat(request.format) ? request.format : 'png')
    : (request.format && isVideoFormat(request.format) ? request.format : 'mp4');
  const { tempPath, suggestedName: name } = createTempOutput(input, '_stamp', format);

  if (request.mode === 'logo') {
    const logo = assertInput(request.logo || '', '台标图片');
    const graph = `[1:v]scale=160:-1[lg];[0:v][lg]overlay=${logoOverlay(position)}[vout]`;
    const args = ['-y', '-i', input, '-i', logo, '-filter_complex', graph, '-map', '[vout]'];
    if (request.kind === 'image') {
      args.push(...imageEncoderArgs(format as ImageFormat), tempPath);
      await runFfmpegJob(args, 1, sink);
      return { tempPath, suggestedName: name, format, kind: 'image' };
    }
    if (hasAudioStream(info)) {
      args.push('-map', '0:a?');
    }
    args.push(...encoderArgs(format as VideoFormat), tempPath);
    await runFfmpegJob(args, info.durationSec, sink);
    return { tempPath, suggestedName: name, format, kind: 'video' };
  }

  const text = (request.text || '').trim();
  if (!text) {
    throw new Error('请填写要烧录的文字。');
  }
  const vf = `drawtext=fontfile='${escapeFilterPath(stampFont())}':text='${escapeDrawtext(text)}':fontsize=36:fontcolor=white:borderw=2:bordercolor=black@0.65:${textOverlay(position)}`;
  if (request.kind === 'image') {
    await runFfmpegJob(['-y', '-i', input, '-vf', vf, ...imageEncoderArgs(format as ImageFormat), tempPath], 1, sink);
    return { tempPath, suggestedName: name, format, kind: 'image' };
  }
  await runFfmpegJob(['-y', '-i', input, '-vf', vf, ...encoderArgs(format as VideoFormat), tempPath], info.durationSec, sink);
  return { tempPath, suggestedName: name, format, kind: 'video' };
}

export async function normalizeLoudness(
  request: LoudnormRequest,
  sink?: ProgressSink,
): Promise<MediaJobResult> {
  const label = request.kind === 'audio' ? '音频' : '视频';
  const input = assertInput(request.input, label);
  const info = await probeMedia(input, request.kind);
  if (!hasAudioStream(info)) {
    throw new Error('没有可标准化的音轨。');
  }
  const af = 'loudnorm=I=-16:TP=-1.5:LRA=11';
  if (request.kind === 'audio') {
    const format = (request.format && isAudioFormat(request.format) ? request.format : 'mp3');
    const { tempPath, suggestedName: name } = createTempOutput(input, '_loudnorm', format);
    await runFfmpegJob(['-y', '-i', input, '-af', af, ...audioEncoderArgs(format), tempPath], info.durationSec, sink);
    return { tempPath, suggestedName: name, format, kind: 'audio' };
  }
  const format = (request.format && isVideoFormat(request.format) ? request.format : 'mp4');
  const { tempPath, suggestedName: name } = createTempOutput(input, '_loudnorm', format);
  const copyArgs = ['-y', '-i', input, '-c:v', 'copy', '-af', af, '-c:a', 'aac', '-b:a', '160k', tempPath];
  try {
    await runFfmpegJob(copyArgs, info.durationSec, sink);
  } catch {
    sink?.({ phase: 'running', percent: 5, message: '标准化（重编码画面）' });
    await runFfmpegJob(['-y', '-i', input, '-af', af, ...encoderArgs(format), tempPath], info.durationSec, sink);
  }
  return { tempPath, suggestedName: name, format, kind: 'video' };
}

export async function resizeImage(
  request: ResizeRequest,
  sink?: ProgressSink,
): Promise<MediaJobResult> {
  const input = assertInput(request.input, '图片');
  await probeMedia(input, 'image');
  const value = request.value;
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error('缩放数值需大于 0。');
  }
  if (request.mode === 'percent' && (value < 1 || value > 400)) {
    throw new Error('百分比需在 1–400 之间。');
  }
  if (request.mode !== 'percent' && (value < 2 || value > 8000)) {
    throw new Error('边长需在 2–8000 像素之间。');
  }
  const format = (request.format && isImageFormat(request.format) ? request.format : 'png');
  const { tempPath, suggestedName: name } = createTempOutput(input, '_resized', format);
  await runFfmpegJob(
    ['-y', '-i', input, '-vf', resizeFilter(request.mode, value), ...imageEncoderArgs(format), tempPath],
    1,
    sink,
  );
  return { tempPath, suggestedName: name, format, kind: 'image' };
}

function stripAudioEncoder(args: string[]): string[] {
  return args.filter((part, index, list) => part !== '-c:a' && list[index - 1] !== '-c:a' && part !== '-b:a' && list[index - 1] !== '-b:a');
}

function orientedSize(width: number, height: number, op?: OrientOp): { width: number; height: number } {
  if (op === 'rotate90' || op === 'rotate270') {
    return { width: height, height: width };
  }
  return { width, height };
}

/**
 * Apply several video adjustments in one pass: orient, aspect, compress,
 * stamp, speed, mute, loudnorm, or a still / audio-only output.
 */
export async function adjustVideo(
  request: VideoAdjustRequest,
  sink?: ProgressSink,
): Promise<MediaJobResult> {
  const input = assertInput(request.input, '视频');
  const info = await probeMedia(input, 'video');
  const output = request.output || 'video';
  const rate = request.rate;
  if (rate != null && rate !== 0.5 && rate !== 1.5 && rate !== 2) {
    throw new Error('变速仅支持 0.5、1.5、2 倍。');
  }

  if (output === 'audio') {
    if (!hasAudioStream(info)) {
      throw new Error('这个视频没有音轨。');
    }
    const format = (request.format && isAudioFormat(request.format) ? request.format : 'mp3');
    const { tempPath, suggestedName: name } = createTempOutput(input, '_audio', format);
    const args = ['-y', '-i', input];
    if (request.loudnorm) {
      args.push('-af', 'loudnorm=I=-16:TP=-1.5:LRA=11');
    }
    args.push(...audioEncoderArgs(format), tempPath);
    await runFfmpegJob(args, info.durationSec, sink);
    return { tempPath, suggestedName: name, format, kind: 'audio' };
  }

  const hasPicture = Boolean(request.orient || request.ratio || request.preset || request.stampMode || request.rate);
  const hasSound = Boolean(request.mute || request.loudnorm);
  if (output === 'video' && !hasPicture && !hasSound) {
    throw new Error('请至少勾选一项调整。');
  }
  if (!info.width || !info.height) {
    throw new Error('无法读取分辨率。');
  }

  const filters: string[] = [];
  const size = orientedSize(info.width, info.height, request.orient);
  if (request.orient) {
    filters.push(orientFilter(request.orient));
  }
  if (request.ratio) {
    filters.push(aspectFilter(size.width, size.height, request.ratio));
  }
  if (request.preset) {
    const maxWidth = request.preset === 'small' ? 854 : request.preset === 'medium' ? 1280 : 0;
    if (maxWidth > 0) {
      filters.push(`scale='min(${maxWidth}\\,iw)':-2`);
    }
  }
  if (output === 'video' && request.rate) {
    filters.push(`setpts=PTS/${request.rate}`);
  }

  const position = request.position || 'br';
  let logoPath = '';
  if (request.stampMode === 'text') {
    const text = (request.text || '').trim();
    if (!text) {
      throw new Error('请填写要烧录的文字。');
    }
    filters.push(`drawtext=fontfile='${escapeFilterPath(stampFont())}':text='${escapeDrawtext(text)}':fontsize=36:fontcolor=white:borderw=2:bordercolor=black@0.65:${textOverlay(position)}`);
  } else if (request.stampMode === 'logo') {
    logoPath = assertInput(request.logo || '', '台标图片');
  }

  const mute = output === 'video' && Boolean(request.mute);
  const audioFilters: string[] = [];
  if (!mute && output === 'video' && hasAudioStream(info)) {
    if (request.rate) {
      audioFilters.push(request.changePitch ? `asetrate=44100*${request.rate},aresample=44100` : `atempo=${request.rate}`);
    }
    if (request.loudnorm) {
      audioFilters.push('loudnorm=I=-16:TP=-1.5:LRA=11');
    }
  }

  if (output === 'frame') {
    const timeSec = Math.max(0, request.timeSec ?? 0);
    if (info.durationSec > 0 && timeSec > info.durationSec) {
      throw new Error(`截帧时间超出时长（${info.durationSec.toFixed(1)} 秒）。`);
    }
    const format = (request.format && isImageFormat(request.format) ? request.format : 'jpg');
    const { tempPath, suggestedName: name } = createTempOutput(input, '_frame', format);
    const args = ['-y', '-ss', String(timeSec), '-i', input];
    if (logoPath) {
      const chain = filters.length ? `[0:v]${filters.join(',')}[base];` : '';
      const base = filters.length ? '[base]' : '[0:v]';
      args.push('-i', logoPath, '-filter_complex', `${chain}[1:v]scale=160:-1[lg];${base}[lg]overlay=${logoOverlay(position)}`);
    } else if (filters.length) {
      args.push('-vf', filters.join(','));
    }
    args.push('-frames:v', '1', ...imageQualityArgs(format, request.preset || 'high'), tempPath);
    await runFfmpegJob(args, 1, sink);
    return { tempPath, suggestedName: name, format, kind: 'image' };
  }

  const format = (request.format && isVideoFormat(request.format) ? request.format : 'mp4');
  const { tempPath, suggestedName: name } = createTempOutput(input, '_adjusted', format);
  const encode = request.preset ? videoCompressArgs(format, request.preset) : encoderArgs(format);
  const videoEncode = mute || !hasAudioStream(info) ? stripAudioEncoder(encode) : encode;
  const args = ['-y', '-i', input];
  if (logoPath) {
    const chain = filters.length ? `[0:v]${filters.join(',')}[base];` : '';
    const base = filters.length ? '[base]' : '[0:v]';
    args.push('-i', logoPath, '-filter_complex', `${chain}[1:v]scale=160:-1[lg];${base}[lg]overlay=${logoOverlay(position)}[vout]`, '-map', '[vout]');
    if (!mute && hasAudioStream(info)) {
      args.push('-map', '0:a?');
    }
  } else if (filters.length) {
    args.push('-vf', filters.join(','));
  }
  if (mute || !hasAudioStream(info)) {
    args.push('-an');
  } else if (audioFilters.length) {
    args.push('-af', audioFilters.join(','));
  }
  args.push(...videoEncode, tempPath);
  const duration = info.durationSec / (request.rate && output === 'video' ? request.rate : 1);
  await runFfmpegJob(args, duration, sink);
  return { tempPath, suggestedName: name, format, kind: 'video' };
}

export async function exportTempFile(
  tempPath: string,
  destination: string,
): Promise<string> {
  const source = path.resolve(tempPath);
  const root = tempDir();
  const underTemp = source === root || source.startsWith(`${root}${path.sep}`);
  if (!underTemp) {
    throw new Error('只能导出本应用生成的预览文件。');
  }
  if (!existsSync(source)) {
    throw new Error('预览文件不存在，请重新处理。');
  }
  const target = path.resolve(destination);
  await copyFile(source, target);
  return target;
}

/** @deprecated use exportTempFile */
export const exportTempVideo = exportTempFile;
