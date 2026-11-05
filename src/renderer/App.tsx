import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type ReactNode } from 'react';
import type {
  AspectRatio,
  AudioFormat,
  CompressPreset,
  DenoiseStrength,
  ExtractMode,
  HdTarget,
  ImageFormat,
  MediaJobResult,
  MediaKind,
  MediaProbe,
  MediaProgressEvent,
  OrientOp,
  ResizeMode,
  StampPosition,
  VideoAdjustOutput,
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
  defaultFormatForKind,
  formatsForKind,
  isAudioFormat,
  isImageFormat,
} from '../shared/media';
import type { PayOrder } from '../shared/payment';
import { EXPORT_REQUIRES_PAYMENT } from '../shared/payment';
import { CropEditor } from './components/CropEditor';
import { FileInfo } from './components/FileInfo';
import type { CropRect } from './components/CropEditor';
import { PaymentModal } from './components/PaymentModal';
import { PlaywrightStudio } from './components/PlaywrightStudio';
import { ResizeHandle } from './components/ResizeHandle';
import { ResultVideoPlayer } from './components/ResultVideoPlayer';
import { TimelineTrim } from './components/TimelineTrim';
import type { TrimRange } from './components/TimelineTrim';
import { WelcomeScreen } from './components/WelcomeScreen';
import type { ToolTab } from './tools';
import { kindLabel, toolNavLabel, toolSubtitle, toolTitle, toolsForKind } from './tools';

type ProductMode = 'media' | 'playwright';
type MainView = 'welcome' | 'editor' | 'result';
type ElectronFile = File & { path?: string };

const VIDEO_EXTS = new Set(['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v', 'mpeg', 'mpg', 'wmv', 'flv']);
const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif', 'tif', 'tiff']);
const AUDIO_EXTS = new Set(['mp3', 'aac', 'wav', 'flac', 'ogg', 'm4a', 'wma', 'aiff']);

function fileExtension(nameOrPath: string): string {
  const base = nameOrPath.split(/[/\\]/).pop() || nameOrPath;
  const dot = base.lastIndexOf('.');
  return dot >= 0 ? base.slice(dot + 1).toLowerCase() : '';
}

function detectKindFromName(nameOrPath: string): MediaKind | null {
  const ext = fileExtension(nameOrPath);
  if (VIDEO_EXTS.has(ext)) return 'video';
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (AUDIO_EXTS.has(ext)) return 'audio';
  return null;
}

function droppedFilePath(file: File): string | null {
  const fromApi = window.media?.pathForFile?.(file);
  if (typeof fromApi === 'string' && fromApi.trim()) {
    return fromApi;
  }
  const legacy = (file as ElectronFile).path;
  return typeof legacy === 'string' && legacy.trim() ? legacy : null;
}

function readPaneWidth(key: string, fallback: number): number {
  const raw = window.localStorage.getItem(key);
  const value = raw ? Number(raw) : fallback;
  return Number.isFinite(value) ? value : fallback;
}

function storePaneWidth(key: string, value: number, min: number, max: number): number {
  const next = Math.round(Math.min(max, Math.max(min, value)));
  window.localStorage.setItem(key, String(next));
  return next;
}

function defaultWatermarkRect(width: number, height: number): CropRect {
  const box = Math.max(48, Math.min(160, Math.floor(Math.min(width, height) * 0.14)));
  const margin = 8;
  const w = Math.min(box, Math.max(2, width - 2));
  const h = Math.min(box, Math.max(2, height - 2));
  return {
    x: Math.max(1, width - w - margin),
    y: Math.max(1, margin),
    width: w,
    height: h,
  };
}

function hdTargetLabel(target: HdTarget): string {
  if (target === '2x') return '2× 放大';
  if (target === '1080p') return '1080p';
  if (target === '1440p') return '1440p';
  return '4K';
}

function denoiseLabel(strength: DenoiseStrength): string {
  if (strength === 'low') return '弱';
  if (strength === 'high') return '强';
  return '中';
}

function compressLabel(preset: CompressPreset): string {
  if (preset === 'high') return '高画质';
  if (preset === 'small') return '小体积';
  return '均衡分享';
}

function orientLabel(op: OrientOp): string {
  if (op === 'rotate90') return '顺时针 90°';
  if (op === 'rotate180') return '旋转 180°';
  if (op === 'rotate270') return '顺时针 270°';
  if (op === 'flipH') return '水平翻转';
  return '垂直翻转';
}

function stampPosLabel(position: StampPosition): string {
  if (position === 'tl') return '左上';
  if (position === 'tr') return '右上';
  if (position === 'bl') return '左下';
  if (position === 'center') return '居中';
  return '右下';
}

function resizeModeLabel(mode: ResizeMode): string {
  if (mode === 'height') return '按高度';
  if (mode === 'percent') return '按百分比';
  return '按宽度';
}

export function App() {
  const [productMode, setProductMode] = useState<ProductMode>('media');
  const [kind, setKind] = useState<MediaKind>('video');
  const [tab, setTab] = useState<ToolTab>('crop');
  const [mainView, setMainView] = useState<MainView>('welcome');
  const [filePath, setFilePath] = useState('');
  const [previewUrl, setPreviewUrl] = useState('');
  const [probe, setProbe] = useState<MediaProbe | null>(null);
  const [format, setFormat] = useState<VideoFormat | ImageFormat | AudioFormat>('mp4');
  const [crop, setCrop] = useState<CropRect>({ x: 0, y: 0, width: 320, height: 240 });
  const [trim, setTrim] = useState<TrimRange>({ startSec: 0, endSec: 1 });
  const [gifFps, setGifFps] = useState('10');
  const [gifMaxWidth, setGifMaxWidth] = useState('480');
  const [hdTarget, setHdTarget] = useState<HdTarget>('1080p');
  const [denoiseStrength, setDenoiseStrength] = useState<DenoiseStrength>('medium');
  const [compressPreset, setCompressPreset] = useState<CompressPreset>('medium');
  const [orientOp, setOrientOp] = useState<OrientOp>('rotate90');
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>('9:16');
  const [speedRate, setSpeedRate] = useState<(typeof SPEED_RATES)[number]>(1.5);
  const [changePitch, setChangePitch] = useState(false);
  const [extractMode, setExtractMode] = useState<ExtractMode>('audio');
  const [frameSec, setFrameSec] = useState('1');
  const [stampMode, setStampMode] = useState<'text' | 'logo'>('text');
  const [stampText, setStampText] = useState('');
  const [stampLogo, setStampLogo] = useState('');
  const [stampPos, setStampPos] = useState<StampPosition>('br');
  const [resizeMode, setResizeMode] = useState<ResizeMode>('width');
  const [resizeValue, setResizeValue] = useState('1280');
  const [adjustOutput, setAdjustOutput] = useState<VideoAdjustOutput>('video');
  const [useOrient, setUseOrient] = useState(false);
  const [useAspect, setUseAspect] = useState(false);
  const [useSpeed, setUseSpeed] = useState(false);
  const [useCompress, setUseCompress] = useState(false);
  const [useStamp, setUseStamp] = useState(false);
  const [useLoudnorm, setUseLoudnorm] = useState(false);
  const [useMute, setUseMute] = useState(false);
  const [busy, setBusy] = useState(false);
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState<MediaProgressEvent | null>(null);
  const [result, setResult] = useState<MediaJobResult | null>(null);
  const [resultUrl, setResultUrl] = useState('');
  const [exportedPath, setExportedPath] = useState('');
  const [error, setError] = useState('');
  const [payOpen, setPayOpen] = useState(false);
  const [paidOrderId, setPaidOrderId] = useState('');
  const [railWidth, setRailWidth] = useState(() => readPaneWidth('studio-rail', 220));
  const [sideWidth, setSideWidth] = useState(() => readPaneWidth('studio-side', 300));
  const [draggingFile, setDraggingFile] = useState(false);
  const dragDepthRef = useRef(0);
  const kindRef = useRef(kind);

  useEffect(() => {
    kindRef.current = kind;
  }, [kind]);

  useEffect(() => {
    if (!window.media) {
      setError('媒体桥接不可用。请在 Electron 窗口中打开。');
      return undefined;
    }
    return window.media.onProgress((event) => setProgress(event));
  }, []);

  useEffect(() => {
    if (!probe) {
      return;
    }
    if (kind !== 'audio' && probe.width > 0 && probe.height > 0) {
      setCrop({
        x: 0,
        y: 0,
        width: probe.width,
        height: probe.height,
      });
    }
    if (kind !== 'image') {
      const duration = Math.max(0.1, probe.durationSec || 0.1);
      setTrim({ startSec: 0, endSec: duration });
    }
  }, [probe, kind]);

  const statusLabel = useMemo(() => {
    if (importing) return '读取文件';
    if (busy) return progress?.message || '处理中';
    if (error) return '失败';
    if (exportedPath) return '已导出';
    if (result) return '可预览';
    return '就绪';
  }, [busy, error, exportedPath, importing, progress, result]);

  const uiLocked = busy || importing;

  const formatOptions = tab === 'frame' || (tab === 'adjust' && adjustOutput === 'frame')
    ? IMAGE_FORMATS
    : (tab === 'extract' && extractMode === 'audio') || (tab === 'adjust' && adjustOutput === 'audio')
      ? AUDIO_FORMATS
      : tab === 'loudnorm' && kind === 'audio'
        ? AUDIO_FORMATS
        : formatsForKind(kind);

  function resetWorkspace(): void {
    setFilePath('');
    setPreviewUrl('');
    setProbe(null);
    setResult(null);
    setResultUrl('');
    setExportedPath('');
    setPaidOrderId('');
    setPayOpen(false);
    setError('');
    setProgress(null);
    setImporting(false);
    setTrim({ startSec: 0, endSec: 1 });
  }

  function clearResult(): void {
    setResult(null);
    setResultUrl('');
    setExportedPath('');
    setPaidOrderId('');
    setPayOpen(false);
    setMainView('editor');
  }

  function adoptKind(nextKind: MediaKind): void {
    if (nextKind === kindRef.current) {
      return;
    }
    setKind(nextKind);
    kindRef.current = nextKind;
    setTab('crop');
    setFormat(defaultFormatForKind(nextKind));
    resetWorkspace();
  }

  function switchKind(next: MediaKind): void {
    if (next === kind) {
      return;
    }
    adoptKind(next);
    setMainView('editor');
  }

  function switchTab(next: ToolTab): void {
    if (!toolsForKind(kind).includes(next)) {
      return;
    }
    setTab(next);
    if (next === 'watermark' && probe && probe.width > 0 && probe.height > 0) {
      setCrop(defaultWatermarkRect(probe.width, probe.height));
    }
    if (next === 'frame') setFormat('jpg');
    if (next === 'compress' && kind === 'image') setFormat('jpg');
    if (next === 'extract') setFormat(extractMode === 'audio' ? 'mp3' : 'mp4');
    if (next === 'loudnorm' && kind === 'audio') setFormat('mp3');
    if (next === 'adjust') {
      setFormat(adjustOutput === 'audio' ? 'mp3' : adjustOutput === 'frame' ? 'jpg' : 'mp4');
    }
    setMainView(result ? 'result' : 'editor');
  }

  async function openLocalFile(picked: string, nextKind: MediaKind = kindRef.current): Promise<void> {
    setError('');
    setProgress(null);
    clearResult();
    if (nextKind !== kindRef.current) {
      setKind(nextKind);
      setTab('crop');
      setFormat(defaultFormatForKind(nextKind));
      kindRef.current = nextKind;
    }
    setImporting(true);
    try {
      setFilePath(picked);
      setProbe(null);
      setPreviewUrl('');
      const info = await window.media.probe(picked, nextKind);
      setProbe(info);
      setPreviewUrl(window.media.previewUrl(picked));
      setMainView('editor');
    } catch (err) {
      setProbe(null);
      setPreviewUrl('');
      setError(err instanceof Error ? err.message : `读取${kindLabel(nextKind)}失败`);
    } finally {
      setImporting(false);
    }
  }

  async function pickAndProbe(): Promise<void> {
    if (uiLocked) {
      return;
    }
    try {
      const picked = await window.media.pickMedia(kind);
      if (!picked) {
        return;
      }
      await openLocalFile(picked, kind);
    } catch (err) {
      setError(err instanceof Error ? err.message : `选择${kindLabel(kind)}失败`);
    }
  }

  async function pickFromWelcome(nextKind: MediaKind): Promise<void> {
    if (uiLocked) {
      return;
    }
    adoptKind(nextKind);
    try {
      const picked = await window.media.pickMedia(nextKind);
      if (!picked) {
        return;
      }
      await openLocalFile(picked, nextKind);
    } catch (err) {
      setMainView('editor');
      setError(err instanceof Error ? err.message : `选择${kindLabel(nextKind)}失败`);
    }
  }

  function startFromWelcome(nextKind: MediaKind, nextTab: ToolTab): void {
    adoptKind(nextKind);
    setTab(nextTab);
    setFormat(
      nextTab === 'frame'
        ? 'jpg'
        : nextTab === 'extract'
          ? (extractMode === 'audio' ? 'mp3' : 'mp4')
          : nextTab === 'loudnorm' && nextKind === 'audio'
            ? 'mp3'
            : defaultFormatForKind(nextKind),
    );
    setMainView('editor');
  }

  function hasFiles(event: DragEvent): boolean {
    return Array.from(event.dataTransfer?.types || []).includes('Files');
  }

  function onDragEnter(event: DragEvent<HTMLDivElement>): void {
    if (!hasFiles(event) || uiLocked) {
      return;
    }
    event.preventDefault();
    dragDepthRef.current += 1;
    setDraggingFile(true);
  }

  function onDragOver(event: DragEvent<HTMLDivElement>): void {
    if (!hasFiles(event) || uiLocked) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  }

  function onDragLeave(event: DragEvent<HTMLDivElement>): void {
    if (!hasFiles(event)) {
      return;
    }
    event.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) {
      setDraggingFile(false);
    }
  }

  async function onDrop(event: DragEvent<HTMLDivElement>): Promise<void> {
    event.preventDefault();
    dragDepthRef.current = 0;
    setDraggingFile(false);
    if (uiLocked) {
      return;
    }
    const file = event.dataTransfer?.files?.[0];
    if (!file) {
      return;
    }
    const detected = detectKindFromName(file.name);
    if (!detected) {
      setError('不支持的文件类型。请拖入视频、图片或音频。');
      return;
    }
    const path = droppedFilePath(file);
    if (!path) {
      setError('无法读取拖入文件路径，请改用「选择文件」。');
      return;
    }
    await openLocalFile(path, detected);
  }

  async function applyResult(job: MediaJobResult): Promise<void> {
    setResult(job);
    setResultUrl(window.media.previewUrl(job.tempPath));
    setExportedPath('');
    setPaidOrderId('');
    setMainView('result');
  }

  const exportWithOrder = useCallback(async (orderId: string, job: MediaJobResult): Promise<void> => {
    setError('');
    try {
      const saved = await window.media.exportFile({
        tempPath: job.tempPath,
        suggestedName: job.suggestedName,
        format: job.format,
        orderId,
      });
      if (saved) {
        setExportedPath(saved);
        setPaidOrderId('');
        setPayOpen(false);
      } else {
        setPaidOrderId(orderId);
        setPayOpen(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '导出失败');
    }
  }, []);

  function requestExport(): void {
    if (!result) {
      return;
    }
    if (!EXPORT_REQUIRES_PAYMENT) {
      void exportWithOrder(paidOrderId || 'free', result);
      return;
    }
    if (paidOrderId) {
      void exportWithOrder(paidOrderId, result);
      return;
    }
    setPayOpen(true);
  }

  const handlePaid = useCallback((order: PayOrder) => {
    if (!result) {
      return;
    }
    setPaidOrderId(order.orderId);
    void exportWithOrder(order.orderId, result);
  }, [exportWithOrder, result]);

  async function runConvert(): Promise<void> {
    if (!filePath) {
      setError(`请先选择${kindLabel(kind)}。`);
      return;
    }
    setBusy(true);
    setError('');
    clearResult();
    setProgress({ phase: 'running', percent: 0, message: '准备转换' });
    try {
      const job = await window.media.convert({ kind, input: filePath, format });
      await applyResult(job);
    } catch (err) {
      setError(err instanceof Error ? err.message : '转换失败');
    } finally {
      setBusy(false);
    }
  }

  async function runCrop(): Promise<void> {
    if (!filePath || !probe) {
      setError(`请先选择${kindLabel(kind)}。`);
      return;
    }
    setBusy(true);
    setError('');
    clearResult();
    setProgress({ phase: 'running', percent: 0, message: kind === 'audio' ? '准备裁剪' : '准备裁剪' });
    try {
      if (kind === 'audio') {
        const job = await window.media.trimAudio({
          input: filePath,
          startSec: trim.startSec,
          endSec: trim.endSec,
          format: format as AudioFormat,
        });
        await applyResult(job);
      } else {
        const job = await window.media.crop({
          kind,
          input: filePath,
          x: crop.x,
          y: crop.y,
          width: crop.width,
          height: crop.height,
          startSec: kind === 'video' ? trim.startSec : undefined,
          endSec: kind === 'video' ? trim.endSec : undefined,
          format: format as VideoFormat | ImageFormat,
        });
        await applyResult(job);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '裁剪失败');
    } finally {
      setBusy(false);
    }
  }

  async function runGif(): Promise<void> {
    if (!filePath) {
      setError('请先选择视频。');
      return;
    }
    const fps = Number(gifFps);
    const maxWidth = Number(gifMaxWidth);
    if (!Number.isFinite(fps) || fps < 1 || fps > 30) {
      setError('帧率需在 1–30 之间。');
      return;
    }
    if (!Number.isFinite(maxWidth) || maxWidth < 0) {
      setError('最大宽度不合法（填 0 表示原宽）。');
      return;
    }
    setBusy(true);
    setError('');
    clearResult();
    setProgress({ phase: 'running', percent: 0, message: '准备转 GIF' });
    try {
      const job = await window.media.toGif({
        input: filePath,
        fps,
        maxWidth,
        startSec: trim.startSec,
        endSec: trim.endSec,
      });
      await applyResult(job);
    } catch (err) {
      setError(err instanceof Error ? err.message : '转 GIF 失败');
    } finally {
      setBusy(false);
    }
  }

  async function runEnhance(): Promise<void> {
    if (!filePath || (kind !== 'video' && kind !== 'image')) {
      setError(`请先选择${kindLabel(kind)}。`);
      return;
    }
    setBusy(true);
    setError('');
    clearResult();
    setProgress({ phase: 'running', percent: 0, message: '准备转高清' });
    try {
      const job = await window.media.enhanceHd({
        kind,
        input: filePath,
        target: hdTarget,
        format: format as VideoFormat | ImageFormat,
        engine: 'ffmpeg',
      });
      await applyResult(job);
    } catch (err) {
      setError(err instanceof Error ? err.message : '转高清失败');
    } finally {
      setBusy(false);
    }
  }

  async function runDenoise(): Promise<void> {
    if (!filePath || kind !== 'audio') {
      setError('请先选择音频。');
      return;
    }
    setBusy(true);
    setError('');
    clearResult();
    setProgress({ phase: 'running', percent: 0, message: '准备降噪' });
    try {
      const job = await window.media.denoiseAudio({
        input: filePath,
        strength: denoiseStrength,
        startSec: trim.startSec,
        endSec: trim.endSec,
        format: format as AudioFormat,
        engine: 'ffmpeg',
      });
      await applyResult(job);
    } catch (err) {
      setError(err instanceof Error ? err.message : '降噪失败');
    } finally {
      setBusy(false);
    }
  }

  async function runRemoveWatermark(): Promise<void> {
    if (!filePath || (kind !== 'video' && kind !== 'image')) {
      setError(`请先选择${kindLabel(kind)}。`);
      return;
    }
    setBusy(true);
    setError('');
    clearResult();
    setProgress({ phase: 'running', percent: 0, message: '准备去水印' });
    try {
      const job = await window.media.removeWatermark({
        kind,
        input: filePath,
        x: crop.x,
        y: crop.y,
        width: crop.width,
        height: crop.height,
        format: format as VideoFormat | ImageFormat,
        engine: 'ffmpeg',
      });
      await applyResult(job);
    } catch (err) {
      setError(err instanceof Error ? err.message : '去水印失败');
    } finally {
      setBusy(false);
    }
  }

  async function runJob(
    message: string,
    fail: string,
    work: () => Promise<MediaJobResult>,
  ): Promise<void> {
    if (!filePath) {
      setError(`请先选择${kindLabel(kind)}。`);
      return;
    }
    setBusy(true);
    setError('');
    clearResult();
    setProgress({ phase: 'running', percent: 0, message });
    try {
      await applyResult(await work());
    } catch (err) {
      setError(err instanceof Error ? err.message : fail);
    } finally {
      setBusy(false);
    }
  }

  function runCompress(): Promise<void> {
    if (kind !== 'video' && kind !== 'image') return Promise.resolve();
    return runJob('准备压缩', '压缩失败', () => window.media.compress({
      kind,
      input: filePath,
      preset: compressPreset,
      format: format as VideoFormat | ImageFormat,
    }));
  }

  function runOrient(): Promise<void> {
    if (kind !== 'video' && kind !== 'image') return Promise.resolve();
    return runJob('准备旋转', '旋转失败', () => window.media.orient({
      kind,
      input: filePath,
      op: orientOp,
      format: format as VideoFormat | ImageFormat,
    }));
  }

  function runAspect(): Promise<void> {
    if (kind !== 'video' && kind !== 'image') return Promise.resolve();
    return runJob('准备改比例', '改比例失败', () => window.media.fitAspect({
      kind,
      input: filePath,
      ratio: aspectRatio,
      format: format as VideoFormat | ImageFormat,
    }));
  }

  function runSpeed(): Promise<void> {
    return runJob('准备变速', '变速失败', () => window.media.changeSpeed({
      input: filePath,
      rate: speedRate,
      changePitch,
      format: format as VideoFormat,
    }));
  }

  function runExtract(): Promise<void> {
    return runJob('准备处理音轨', '处理音轨失败', () => window.media.extractMedia({
      input: filePath,
      mode: extractMode,
      format: extractMode === 'audio' ? format as AudioFormat : format as VideoFormat,
    }));
  }

  function runSnapshot(): Promise<void> {
    const timeSec = Number(frameSec);
    if (!Number.isFinite(timeSec) || timeSec < 0) {
      setError('截帧时间不合法。');
      return Promise.resolve();
    }
    return runJob('准备截帧', '截帧失败', () => window.media.snapshot({
      input: filePath,
      timeSec,
      format: (IMAGE_FORMATS as readonly string[]).includes(format) ? format as ImageFormat : 'jpg',
    }));
  }

  function runStamp(): Promise<void> {
    if (kind !== 'video' && kind !== 'image') return Promise.resolve();
    if (stampMode === 'text' && !stampText.trim()) {
      setError('请填写要烧录的文字。');
      return Promise.resolve();
    }
    if (stampMode === 'logo' && !stampLogo) {
      setError('请选择台标图片。');
      return Promise.resolve();
    }
    return runJob('准备叠加', '叠加失败', () => window.media.stamp({
      kind,
      input: filePath,
      mode: stampMode,
      text: stampText,
      logo: stampLogo,
      position: stampPos,
      format: format as VideoFormat | ImageFormat,
    }));
  }

  function runLoudnorm(): Promise<void> {
    if (kind !== 'video' && kind !== 'audio') return Promise.resolve();
    return runJob('准备标准化', '标准化失败', () => window.media.loudnorm({
      kind,
      input: filePath,
      format: kind === 'audio' ? format as AudioFormat : format as VideoFormat,
    }));
  }

  function runResize(): Promise<void> {
    const value = Number(resizeValue);
    if (!Number.isFinite(value) || value <= 0) {
      setError('缩放数值不合法。');
      return Promise.resolve();
    }
    return runJob('准备缩放', '缩放失败', () => window.media.resizeImage({
      input: filePath,
      mode: resizeMode,
      value,
      format: format as ImageFormat,
    }));
  }

  function runAdjust(): Promise<void> {
    const picture = adjustOutput !== 'audio';
    const timeSec = Number(frameSec);
    if (adjustOutput === 'frame' && (!Number.isFinite(timeSec) || timeSec < 0)) {
      setError('截帧时间不合法。');
      return Promise.resolve();
    }
    if (picture && useStamp && stampMode === 'text' && !stampText.trim()) {
      setError('请填写要烧录的文字。');
      return Promise.resolve();
    }
    if (picture && useStamp && stampMode === 'logo' && !stampLogo) {
      setError('请选择台标图片。');
      return Promise.resolve();
    }
    return runJob('准备调整', '调整失败', () => window.media.adjustVideo({
      input: filePath,
      output: adjustOutput,
      format,
      orient: picture && useOrient ? orientOp : undefined,
      ratio: picture && useAspect ? aspectRatio : undefined,
      rate: picture && adjustOutput === 'video' && useSpeed ? speedRate : undefined,
      changePitch: useSpeed && changePitch,
      preset: picture && useCompress ? compressPreset : undefined,
      mute: adjustOutput === 'video' && useMute,
      loudnorm: adjustOutput !== 'frame' && useLoudnorm,
      timeSec: adjustOutput === 'frame' ? timeSec : undefined,
      stampMode: picture && useStamp ? stampMode : undefined,
      text: stampText,
      logo: stampLogo || undefined,
      position: stampPos,
    }));
  }

  async function pickStampLogo(): Promise<void> {
    try {
      const picked = await window.media.pickMedia('image');
      if (picked) setStampLogo(picked);
    } catch (err) {
      setError(err instanceof Error ? err.message : '选择台标失败');
    }
  }

  function updateCropField(key: keyof CropRect, raw: string): void {
    const n = Number(raw);
    if (!Number.isFinite(n) || !probe || probe.width <= 0) {
      return;
    }
    setCrop((prev) => {
      const next = { ...prev, [key]: Math.round(n) };
      const width = Math.max(16, Math.min(next.width, probe.width - next.x));
      const height = Math.max(16, Math.min(next.height, probe.height - next.y));
      const x = Math.max(0, Math.min(next.x, probe.width - width));
      const y = Math.max(0, Math.min(next.y, probe.height - height));
      return { x, y, width, height };
    });
  }

  function resizeRail(delta: number): void {
    setRailWidth((width) => storePaneWidth('studio-rail', width + delta, 160, 420));
  }

  function resizeSide(delta: number): void {
    setSideWidth((width) => storePaneWidth('studio-side', width - delta, 240, 560));
  }

  function renderResultPreview(job: MediaJobResult, url: string): ReactNode {
    if (job.format === 'gif' || isImageFormat(job.format) || job.kind === 'image') {
      return <img className="result-gif" src={url} alt={job.suggestedName} />;
    }
    if (isAudioFormat(job.format) || job.kind === 'audio') {
      return <audio className="result-audio" src={url} controls />;
    }
    return <ResultVideoPlayer src={url} />;
  }

  if (productMode === 'playwright') {
    return <PlaywrightStudio onBack={() => setProductMode('media')} />;
  }

  return (
    <>
    <div
      className={[
        'studio',
        draggingFile ? 'is-dropping' : '',
        mainView === 'welcome' ? 'is-welcome' : '',
      ].filter(Boolean).join(' ')}
      style={{ '--rail-width': `${railWidth}px` } as CSSProperties}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={(event) => { void onDrop(event); }}
    >
      <aside className="studio-rail">
        <div className="brand">
          <div className="brand-mark">M</div>
          <div>
            <strong>MediaDo</strong>
            <em>视频、图片、音频处理工具</em>
          </div>
        </div>
        <button type="button" className="rail-product" onClick={() => setProductMode('playwright')}>
          Playwright Studio
        </button>

        <div className="kind-nav" role="tablist" aria-label="媒体类型">
          {(['video', 'image', 'audio'] as MediaKind[]).map((item) => (
            <button
              key={item}
              type="button"
              role="tab"
              className={kind === item ? 'active' : ''}
              aria-selected={kind === item}
              disabled={uiLocked}
              onClick={() => switchKind(item)}
            >
              {kindLabel(item)}
            </button>
          ))}
        </div>

        <nav className="rail-nav">
          {toolsForKind(kind).map((item) => (
            <button
              key={item}
              type="button"
              className={tab === item ? 'active' : ''}
              disabled={uiLocked}
              onClick={() => switchTab(item)}
            >
              {toolNavLabel(kind, item)}
            </button>
          ))}
        </nav>
        <div className="rail-meta">
          <button
            type="button"
            className="rail-home"
            disabled={uiLocked || mainView === 'welcome'}
            onClick={() => setMainView('welcome')}
          >
            工作台
          </button>
          <span className="pill">{statusLabel}</span>
        </div>
      </aside>
      <ResizeHandle label="调整导航宽度" onResize={resizeRail} />

      <div className="studio-body">
        <header className="studio-top">
          <div>
            <h1>{mainView === 'result' ? '结果预览' : toolTitle(kind, tab)}</h1>
            <p className="subtitle">
              {mainView === 'result'
                ? '处理结果仅保存在临时目录，确认后手动导出。'
                : toolSubtitle(kind, tab)}
            </p>
          </div>
          <div className="top-actions">
            {mainView === 'result' ? (
              <button type="button" className="btn-secondary" disabled={uiLocked} onClick={() => setMainView('editor')}>
                返回编辑
              </button>
            ) : null}
            <button type="button" className="btn-secondary" disabled={uiLocked} onClick={() => { void pickAndProbe(); }}>
              {importing ? '读取中…' : `选择${kindLabel(kind)}`}
            </button>
          </div>
        </header>

        <div className="studio-content" style={{ '--side-width': `${sideWidth}px` } as CSSProperties}>
          <section className="panel main-panel">
            {probe && mainView !== 'result' ? <FileInfo probe={probe} filePath={filePath} /> : null}
            {mainView === 'result' && result && resultUrl ? (
              <div className="result-stage">
                {renderResultPreview(result, resultUrl)}
                <p className="hint result-hint">临时预览 · {result.suggestedName}</p>
              </div>
            ) : tab === 'crop' || tab === 'watermark' ? (
              probe && previewUrl ? (
                kind === 'audio' ? (
                  <div className="crop-stack audio-crop">
                    <TimelineTrim
                      mode="audio"
                      src={previewUrl}
                      durationSec={probe.durationSec}
                      value={trim}
                      disabled={uiLocked}
                      onChange={setTrim}
                    />
                  </div>
                ) : (
                  <div className="crop-stack">
                    <CropEditor
                      src={previewUrl}
                      mediaWidth={probe.width}
                      mediaHeight={probe.height}
                      mode={kind === 'image' ? 'image' : 'video'}
                      value={crop}
                      disabled={uiLocked}
                      onChange={setCrop}
                    />
                    {tab === 'crop' && kind === 'video' ? (
                      <TimelineTrim
                        mode="video"
                        src={previewUrl}
                        durationSec={probe.durationSec}
                        value={trim}
                        disabled={uiLocked}
                        onChange={setTrim}
                      />
                    ) : null}
                  </div>
                )
              ) : (
                <div className="empty-state">
                  <h2>还没有{kindLabel(kind)}</h2>
                  <p>
                    {kind === 'audio'
                      ? '拖入或选择本地音频后，可在波形上拖拽选区裁剪。'
                      : tab === 'watermark'
                        ? '拖入或选择本地文件后，在画面上框选水印区域。'
                        : '拖入或选择本地文件后，可在画面上拖拽裁剪区域。'}
                  </p>
                  <button type="button" className="btn-primary" disabled={uiLocked} onClick={() => { void pickAndProbe(); }}>
                    {importing ? '读取中…' : `选择${kindLabel(kind)}`}
                  </button>
                </div>
              )
            ) : (
              probe && kind === 'audio' && previewUrl ? (
                <div className="convert-stage">
                  <audio className="audio-preview" src={previewUrl} controls />
                </div>
              ) : probe ? null : (
                <div className="convert-stage">
                  <div className="empty-state compact">
                    <p>
                      {tab === 'gif'
                        ? '选择视频后可开始转 GIF。'
                        : `选择${kindLabel(kind)}后可开始处理。`}
                    </p>
                  </div>
                </div>
              )
            )}
          </section>
          <ResizeHandle label="调整参数栏宽度" onResize={resizeSide} />

          <aside className="panel side-panel">
            <div className="side-block">
              <h3>输出</h3>
              {tab === 'gif' ? (
                <p className="hint">格式固定为 GIF</p>
              ) : (
                <label className="field">
                  格式
                  <select
                    value={format}
                    disabled={uiLocked}
                    onChange={(event) => setFormat(event.target.value as typeof format)}
                  >
                    {formatOptions.map((item) => (
                      <option key={item} value={item}>{item.toUpperCase()}</option>
                    ))}
                  </select>
                </label>
              )}
              <p className="hint path-hint" title={filePath || undefined}>
                {filePath ? filePath.split(/[/\\]/).pop() : '未选择文件'}
              </p>
            </div>

            {tab === 'crop' && mainView === 'editor' && kind !== 'audio' ? (
              <div className="side-block">
                <h3>画面裁剪</h3>
                <div className="num-grid">
                  <label className="field">X<input type="number" value={crop.x} disabled={uiLocked || !probe} onChange={(e) => updateCropField('x', e.target.value)} /></label>
                  <label className="field">Y<input type="number" value={crop.y} disabled={uiLocked || !probe} onChange={(e) => updateCropField('y', e.target.value)} /></label>
                  <label className="field">宽<input type="number" value={crop.width} disabled={uiLocked || !probe} onChange={(e) => updateCropField('width', e.target.value)} /></label>
                  <label className="field">高<input type="number" value={crop.height} disabled={uiLocked || !probe} onChange={(e) => updateCropField('height', e.target.value)} /></label>
                </div>
                {probe ? (
                  <p className="hint">{crop.width} × {crop.height} px · 源 {probe.width} × {probe.height}</p>
                ) : null}
                {kind === 'video' ? (
                  <p className="hint">下方时间轴可拖拽起止选区；也可微调数值。</p>
                ) : null}
              </div>
            ) : null}

            {tab === 'watermark' && mainView === 'editor' ? (
              <div className="side-block">
                <h3>水印区域</h3>
                <div className="num-grid">
                  <label className="field">X<input type="number" value={crop.x} disabled={uiLocked || !probe} onChange={(e) => updateCropField('x', e.target.value)} /></label>
                  <label className="field">Y<input type="number" value={crop.y} disabled={uiLocked || !probe} onChange={(e) => updateCropField('y', e.target.value)} /></label>
                  <label className="field">宽<input type="number" value={crop.width} disabled={uiLocked || !probe} onChange={(e) => updateCropField('width', e.target.value)} /></label>
                  <label className="field">高<input type="number" value={crop.height} disabled={uiLocked || !probe} onChange={(e) => updateCropField('height', e.target.value)} /></label>
                </div>
                {probe ? (
                  <p className="hint">{crop.width} × {crop.height} px · 源 {probe.width} × {probe.height}</p>
                ) : null}
                <p className="hint">框紧贴水印；需距边缘至少 1 像素。用周围像素自然填补，不会打马赛克。视频对整段生效。</p>
              </div>
            ) : null}

            {tab === 'crop' && mainView === 'editor' && (kind === 'audio' || kind === 'video') ? (
              <div className="side-block">
                <h3>时间选区</h3>
                <div className="num-grid">
                  <label className="field">
                    开始秒
                    <input
                      type="number"
                      step="0.1"
                      value={trim.startSec}
                      disabled={uiLocked || !probe}
                      onChange={(e) => {
                        const n = Number(e.target.value);
                        if (!Number.isFinite(n) || !probe) return;
                        setTrim((prev) => ({
                          startSec: Math.max(0, Math.min(n, prev.endSec - 0.1)),
                          endSec: prev.endSec,
                        }));
                      }}
                    />
                  </label>
                  <label className="field">
                    结束秒
                    <input
                      type="number"
                      step="0.1"
                      value={trim.endSec}
                      disabled={uiLocked || !probe}
                      onChange={(e) => {
                        const n = Number(e.target.value);
                        if (!Number.isFinite(n) || !probe) return;
                        setTrim((prev) => ({
                          startSec: prev.startSec,
                          endSec: Math.max(prev.startSec + 0.1, Math.min(n, probe.durationSec)),
                        }));
                      }}
                    />
                  </label>
                </div>
                {probe ? (
                  <p className="hint">
                    选区 {(trim.endSec - trim.startSec).toFixed(1)}s · 源 {probe.durationSec.toFixed(1)}s
                  </p>
                ) : null}
              </div>
            ) : null}

            {tab === 'gif' && mainView === 'editor' ? (
              <div className="side-block">
                <h3>GIF 参数</h3>
                <div className="num-grid">
                  <label className="field">
                    帧率
                    <input value={gifFps} disabled={uiLocked} onChange={(e) => setGifFps(e.target.value)} />
                  </label>
                  <label className="field">
                    最大宽
                    <input value={gifMaxWidth} disabled={uiLocked} placeholder="0=原宽" onChange={(e) => setGifMaxWidth(e.target.value)} />
                  </label>
                </div>
                <div className="num-grid">
                  <label className="field">
                    开始秒
                    <input
                      type="number"
                      step="0.1"
                      value={trim.startSec}
                      disabled={uiLocked}
                      onChange={(e) => {
                        const n = Number(e.target.value);
                        if (!Number.isFinite(n)) return;
                        setTrim((prev) => ({ ...prev, startSec: Math.max(0, n) }));
                      }}
                    />
                  </label>
                  <label className="field">
                    结束秒
                    <input
                      type="number"
                      step="0.1"
                      value={trim.endSec}
                      disabled={uiLocked}
                      onChange={(e) => {
                        const n = Number(e.target.value);
                        if (!Number.isFinite(n)) return;
                        setTrim((prev) => ({ ...prev, endSec: Math.max(prev.startSec + 0.1, n) }));
                      }}
                    />
                  </label>
                </div>
                <p className="hint">默认 10fps · 宽 480；过长片段文件会很大。</p>
              </div>
            ) : null}

            {tab === 'enhance' && mainView === 'editor' ? (
              <div className="side-block">
                <h3>高清目标</h3>
                <label className="field">
                  目标
                  <select
                    value={hdTarget}
                    disabled={uiLocked}
                    onChange={(e) => setHdTarget(e.target.value as HdTarget)}
                  >
                    {HD_TARGETS.map((item) => (
                      <option key={item} value={item}>{hdTargetLabel(item)}</option>
                    ))}
                  </select>
                </label>
                <p className="hint">当前引擎：ffmpeg 放大 + 锐化（不缩小低于源尺寸）。</p>
              </div>
            ) : null}

            {tab === 'denoise' && mainView === 'editor' ? (
              <div className="side-block">
                <h3>降噪参数</h3>
                <label className="field">
                  强度
                  <select
                    value={denoiseStrength}
                    disabled={uiLocked}
                    onChange={(e) => setDenoiseStrength(e.target.value as DenoiseStrength)}
                  >
                    {DENOISE_STRENGTHS.map((item) => (
                      <option key={item} value={item}>{denoiseLabel(item)}</option>
                    ))}
                  </select>
                </label>
                <div className="num-grid">
                  <label className="field">
                    开始秒
                    <input
                      type="number"
                      step="0.1"
                      value={trim.startSec}
                      disabled={uiLocked}
                      onChange={(e) => {
                        const n = Number(e.target.value);
                        if (!Number.isFinite(n)) return;
                        setTrim((prev) => ({ ...prev, startSec: Math.max(0, n) }));
                      }}
                    />
                  </label>
                  <label className="field">
                    结束秒
                    <input
                      type="number"
                      step="0.1"
                      value={trim.endSec}
                      disabled={uiLocked}
                      onChange={(e) => {
                        const n = Number(e.target.value);
                        if (!Number.isFinite(n)) return;
                        setTrim((prev) => ({ ...prev, endSec: Math.max(prev.startSec + 0.1, n) }));
                      }}
                    />
                  </label>
                </div>
                <p className="hint">当前引擎：ffmpeg afftdn；过强可能损伤人声。</p>
              </div>
            ) : null}

            {tab === 'compress' && mainView === 'editor' ? (
              <div className="side-block">
                <h3>压缩档位</h3>
                <label className="field">
                  档位
                  <select value={compressPreset} disabled={uiLocked} onChange={(e) => setCompressPreset(e.target.value as CompressPreset)}>
                    {COMPRESS_PRESETS.map((item) => (
                      <option key={item} value={item}>{compressLabel(item)}</option>
                    ))}
                  </select>
                </label>
                <p className="hint">均衡适合分享；小体积会限制宽度。图片默认倾向 JPG 以明显减小体积。</p>
              </div>
            ) : null}

            {tab === 'orient' && mainView === 'editor' ? (
              <div className="side-block">
                <h3>方向</h3>
                <label className="field">
                  操作
                  <select value={orientOp} disabled={uiLocked} onChange={(e) => setOrientOp(e.target.value as OrientOp)}>
                    {ORIENT_OPS.map((item) => (
                      <option key={item} value={item}>{orientLabel(item)}</option>
                    ))}
                  </select>
                </label>
              </div>
            ) : null}

            {tab === 'aspect' && mainView === 'editor' ? (
              <div className="side-block">
                <h3>目标比例</h3>
                <label className="field">
                  比例
                  <select value={aspectRatio} disabled={uiLocked} onChange={(e) => setAspectRatio(e.target.value as AspectRatio)}>
                    {ASPECT_RATIOS.map((item) => (
                      <option key={item} value={item}>{item}</option>
                    ))}
                  </select>
                </label>
                <p className="hint">从画面中心裁切，不拉伸。</p>
              </div>
            ) : null}

            {tab === 'speed' && mainView === 'editor' ? (
              <div className="side-block">
                <h3>速度</h3>
                <label className="field">
                  倍率
                  <select value={String(speedRate)} disabled={uiLocked} onChange={(e) => setSpeedRate(Number(e.target.value) as (typeof SPEED_RATES)[number])}>
                    {SPEED_RATES.map((item) => (
                      <option key={item} value={item}>{item}×</option>
                    ))}
                  </select>
                </label>
                <label className="field check-field">
                  <input type="checkbox" checked={changePitch} disabled={uiLocked} onChange={(e) => setChangePitch(e.target.checked)} />
                  同时变调
                </label>
                <p className="hint">不勾选时只改变速度，音调保持原样。</p>
              </div>
            ) : null}

            {tab === 'extract' && mainView === 'editor' ? (
              <div className="side-block">
                <h3>音轨</h3>
                <label className="field">
                  方式
                  <select
                    value={extractMode}
                    disabled={uiLocked}
                    onChange={(e) => {
                      const next = e.target.value as ExtractMode;
                      setExtractMode(next);
                      setFormat(next === 'audio' ? 'mp3' : 'mp4');
                    }}
                  >
                    <option value="audio">提取音频</option>
                    <option value="mute">去掉声音</option>
                  </select>
                </label>
              </div>
            ) : null}

            {tab === 'frame' && mainView === 'editor' ? (
              <div className="side-block">
                <h3>时间点</h3>
                <label className="field">
                  秒
                  <input type="number" min={0} step="0.1" value={frameSec} disabled={uiLocked} onChange={(e) => setFrameSec(e.target.value)} />
                </label>
                {probe ? <p className="hint">片长 {probe.durationSec.toFixed(1)} 秒</p> : null}
              </div>
            ) : null}

            {tab === 'stamp' && mainView === 'editor' ? (
              <div className="side-block">
                <h3>叠加</h3>
                <label className="field">
                  类型
                  <select value={stampMode} disabled={uiLocked} onChange={(e) => setStampMode(e.target.value as 'text' | 'logo')}>
                    <option value="text">文字</option>
                    <option value="logo">台标图片</option>
                  </select>
                </label>
                {stampMode === 'text' ? (
                  <label className="field">
                    文字
                    <input value={stampText} disabled={uiLocked} placeholder="例如 MediaDo" onChange={(e) => setStampText(e.target.value)} />
                  </label>
                ) : (
                  <div className="field">
                    <span>台标</span>
                    <button type="button" className="btn-secondary" disabled={uiLocked} onClick={() => { void pickStampLogo(); }}>
                      {stampLogo ? stampLogo.split(/[/\\]/).pop() : '选择图片'}
                    </button>
                  </div>
                )}
                <label className="field">
                  位置
                  <select value={stampPos} disabled={uiLocked} onChange={(e) => setStampPos(e.target.value as StampPosition)}>
                    {STAMP_POSITIONS.map((item) => (
                      <option key={item} value={item}>{stampPosLabel(item)}</option>
                    ))}
                  </select>
                </label>
              </div>
            ) : null}

            {tab === 'resize' && mainView === 'editor' ? (
              <div className="side-block">
                <h3>缩放</h3>
                <label className="field">
                  方式
                  <select value={resizeMode} disabled={uiLocked} onChange={(e) => setResizeMode(e.target.value as ResizeMode)}>
                    {RESIZE_MODES.map((item) => (
                      <option key={item} value={item}>{resizeModeLabel(item)}</option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  {resizeMode === 'percent' ? '百分比' : '像素'}
                  <input value={resizeValue} disabled={uiLocked} onChange={(e) => setResizeValue(e.target.value)} />
                </label>
                <p className="hint">另一边按比例自动计算。要再压体积，可接着用压缩。</p>
              </div>
            ) : null}

            {tab === 'loudnorm' && mainView === 'editor' ? (
              <div className="side-block">
                <h3>响度</h3>
                <p className="hint">统一到约 -16 LUFS，适合把音量忽大忽小的素材拉齐。</p>
              </div>
            ) : null}

            {tab === 'adjust' && mainView === 'editor' ? (
              <div className="side-block">
                <h3>一起调整</h3>
                <label className="field">
                  输出
                  <select
                    value={adjustOutput}
                    disabled={uiLocked}
                    onChange={(e) => {
                      const next = e.target.value as VideoAdjustOutput;
                      setAdjustOutput(next);
                      setFormat(next === 'audio' ? 'mp3' : next === 'frame' ? 'jpg' : 'mp4');
                    }}
                  >
                    <option value="video">视频</option>
                    <option value="audio">只提取音频</option>
                    <option value="frame">只截一帧</option>
                  </select>
                </label>
                <p className="hint">勾选的项目会在同一次处理里生效。</p>

                {adjustOutput !== 'audio' ? (
                  <>
                    <label className="field check-field">
                      <input type="checkbox" checked={useOrient} disabled={uiLocked} onChange={(e) => setUseOrient(e.target.checked)} />
                      旋转 / 镜像
                    </label>
                    {useOrient ? (
                      <label className="field">
                        方向
                        <select value={orientOp} disabled={uiLocked} onChange={(e) => setOrientOp(e.target.value as OrientOp)}>
                          {ORIENT_OPS.map((item) => (
                            <option key={item} value={item}>{orientLabel(item)}</option>
                          ))}
                        </select>
                      </label>
                    ) : null}

                    <label className="field check-field">
                      <input type="checkbox" checked={useAspect} disabled={uiLocked} onChange={(e) => setUseAspect(e.target.checked)} />
                      改比例
                    </label>
                    {useAspect ? (
                      <label className="field">
                        比例
                        <select value={aspectRatio} disabled={uiLocked} onChange={(e) => setAspectRatio(e.target.value as AspectRatio)}>
                          {ASPECT_RATIOS.map((item) => (
                            <option key={item} value={item}>{item}</option>
                          ))}
                        </select>
                      </label>
                    ) : null}

                    {adjustOutput === 'video' ? (
                      <>
                        <label className="field check-field">
                          <input type="checkbox" checked={useSpeed} disabled={uiLocked} onChange={(e) => setUseSpeed(e.target.checked)} />
                          变速
                        </label>
                        {useSpeed ? (
                          <>
                            <label className="field">
                              倍率
                              <select value={String(speedRate)} disabled={uiLocked} onChange={(e) => setSpeedRate(Number(e.target.value) as (typeof SPEED_RATES)[number])}>
                                {SPEED_RATES.map((item) => (
                                  <option key={item} value={item}>{item}×</option>
                                ))}
                              </select>
                            </label>
                            <label className="field check-field">
                              <input type="checkbox" checked={changePitch} disabled={uiLocked} onChange={(e) => setChangePitch(e.target.checked)} />
                              同时变调
                            </label>
                          </>
                        ) : null}
                      </>
                    ) : null}

                    <label className="field check-field">
                      <input type="checkbox" checked={useCompress} disabled={uiLocked} onChange={(e) => setUseCompress(e.target.checked)} />
                      压缩体积
                    </label>
                    {useCompress ? (
                      <label className="field">
                        档位
                        <select value={compressPreset} disabled={uiLocked} onChange={(e) => setCompressPreset(e.target.value as CompressPreset)}>
                          {COMPRESS_PRESETS.map((item) => (
                            <option key={item} value={item}>{compressLabel(item)}</option>
                          ))}
                        </select>
                      </label>
                    ) : null}

                    <label className="field check-field">
                      <input type="checkbox" checked={useStamp} disabled={uiLocked} onChange={(e) => setUseStamp(e.target.checked)} />
                      文字 / 台标
                    </label>
                    {useStamp ? (
                      <>
                        <label className="field">
                          类型
                          <select value={stampMode} disabled={uiLocked} onChange={(e) => setStampMode(e.target.value as 'text' | 'logo')}>
                            <option value="text">文字</option>
                            <option value="logo">台标图片</option>
                          </select>
                        </label>
                        {stampMode === 'text' ? (
                          <label className="field">
                            文字
                            <input value={stampText} disabled={uiLocked} placeholder="例如 MediaDo" onChange={(e) => setStampText(e.target.value)} />
                          </label>
                        ) : (
                          <div className="field">
                            <span>台标</span>
                            <button type="button" className="btn-secondary" disabled={uiLocked} onClick={() => { void pickStampLogo(); }}>
                              {stampLogo ? stampLogo.split(/[/\\]/).pop() : '选择图片'}
                            </button>
                          </div>
                        )}
                        <label className="field">
                          位置
                          <select value={stampPos} disabled={uiLocked} onChange={(e) => setStampPos(e.target.value as StampPosition)}>
                            {STAMP_POSITIONS.map((item) => (
                              <option key={item} value={item}>{stampPosLabel(item)}</option>
                            ))}
                          </select>
                        </label>
                      </>
                    ) : null}
                  </>
                ) : null}

                {adjustOutput === 'video' ? (
                  <label className="field check-field">
                    <input type="checkbox" checked={useMute} disabled={uiLocked} onChange={(e) => setUseMute(e.target.checked)} />
                    去掉声音
                  </label>
                ) : null}

                {adjustOutput === 'frame' ? (
                  <label className="field">
                    截帧秒
                    <input type="number" min={0} step="0.1" value={frameSec} disabled={uiLocked} onChange={(e) => setFrameSec(e.target.value)} />
                  </label>
                ) : null}

                {adjustOutput !== 'frame' ? (
                  <label className="field check-field">
                    <input type="checkbox" checked={useLoudnorm} disabled={uiLocked || (adjustOutput === 'video' && useMute)} onChange={(e) => setUseLoudnorm(e.target.checked)} />
                    音量标准化
                  </label>
                ) : null}
              </div>
            ) : null}

            <div className="side-actions">
              {mainView === 'result' ? (
                <>
                  <button type="button" className="btn-primary" disabled={!result || uiLocked} onClick={requestExport}>
                    导出到本地
                  </button>
                  <button type="button" className="btn-secondary" disabled={uiLocked} onClick={() => setMainView('editor')}>
                    继续编辑
                  </button>
                </>
              ) : tab === 'convert' ? (
                <button type="button" className="btn-primary" disabled={uiLocked || !filePath} onClick={() => { void runConvert(); }}>
                  生成预览
                </button>
              ) : tab === 'gif' ? (
                <button type="button" className="btn-primary" disabled={uiLocked || !filePath} onClick={() => { void runGif(); }}>
                  生成 GIF
                </button>
              ) : tab === 'enhance' ? (
                <button type="button" className="btn-primary" disabled={uiLocked || !filePath} onClick={() => { void runEnhance(); }}>
                  生成高清预览
                </button>
              ) : tab === 'denoise' ? (
                <button type="button" className="btn-primary" disabled={uiLocked || !filePath} onClick={() => { void runDenoise(); }}>
                  生成降噪预览
                </button>
              ) : tab === 'watermark' ? (
                <button type="button" className="btn-primary" disabled={uiLocked || !filePath} onClick={() => { void runRemoveWatermark(); }}>
                  生成去水印预览
                </button>
              ) : tab === 'compress' ? (
                <button type="button" className="btn-primary" disabled={uiLocked || !filePath} onClick={() => { void runCompress(); }}>
                  生成压缩预览
                </button>
              ) : tab === 'orient' ? (
                <button type="button" className="btn-primary" disabled={uiLocked || !filePath} onClick={() => { void runOrient(); }}>
                  生成预览
                </button>
              ) : tab === 'aspect' ? (
                <button type="button" className="btn-primary" disabled={uiLocked || !filePath} onClick={() => { void runAspect(); }}>
                  生成预览
                </button>
              ) : tab === 'speed' ? (
                <button type="button" className="btn-primary" disabled={uiLocked || !filePath} onClick={() => { void runSpeed(); }}>
                  生成变速预览
                </button>
              ) : tab === 'extract' ? (
                <button type="button" className="btn-primary" disabled={uiLocked || !filePath} onClick={() => { void runExtract(); }}>
                  生成预览
                </button>
              ) : tab === 'frame' ? (
                <button type="button" className="btn-primary" disabled={uiLocked || !filePath} onClick={() => { void runSnapshot(); }}>
                  截取这一帧
                </button>
              ) : tab === 'stamp' ? (
                <button type="button" className="btn-primary" disabled={uiLocked || !filePath} onClick={() => { void runStamp(); }}>
                  生成预览
                </button>
              ) : tab === 'resize' ? (
                <button type="button" className="btn-primary" disabled={uiLocked || !filePath} onClick={() => { void runResize(); }}>
                  生成预览
                </button>
              ) : tab === 'loudnorm' ? (
                <button type="button" className="btn-primary" disabled={uiLocked || !filePath} onClick={() => { void runLoudnorm(); }}>
                  生成预览
                </button>
              ) : tab === 'adjust' ? (
                <button type="button" className="btn-primary" disabled={uiLocked || !filePath} onClick={() => { void runAdjust(); }}>
                  生成预览
                </button>
              ) : (
                <button type="button" className="btn-primary" disabled={uiLocked || !filePath} onClick={() => { void runCrop(); }}>
                  生成预览
                </button>
              )}
            </div>

            {progress && busy ? (
              <div className="progress-block">
                <div className="progress-track">
                  <div className="progress-fill" style={{ width: `${progress.percent}%` }} />
                </div>
                <p>{progress.percent}% · {progress.message}</p>
              </div>
            ) : null}

            {error ? <p className="banner">{error}</p> : null}
            {exportedPath ? <p className="output-path">已导出到<br />{exportedPath}</p> : null}
            {result && !exportedPath && mainView === 'result' ? (
              <p className="hint">
                {EXPORT_REQUIRES_PAYMENT
                  ? '导出需付费；结果确认前仅保存在临时目录。'
                  : '结果确认前仅保存在临时目录，导出后才会写入你选择的位置。'}
              </p>
            ) : null}
          </aside>
        </div>
      </div>

      {mainView === 'welcome' ? (
        <WelcomeScreen
          dragging={draggingFile}
          importing={importing}
          onPick={(nextKind) => { void pickFromWelcome(nextKind); }}
          onStart={startFromWelcome}
          onOpenPlaywright={() => setProductMode('playwright')}
        />
      ) : null}

      {importing ? (
        <div className="drop-overlay import-overlay" role="status" aria-live="polite">
          <div className="drop-card import-card">
            <span className="import-spinner" aria-hidden />
            <strong>正在读取文件</strong>
            <p>{filePath ? filePath.split(/[/\\]/).pop() : '解析媒体信息…'}</p>
          </div>
        </div>
      ) : null}

      {draggingFile && mainView !== 'welcome' ? (
        <div className="drop-overlay" aria-hidden>
          <div className="drop-card">
            <strong>松开以导入文件</strong>
            <p>支持视频 · 图片 · 音频，将自动切换对应类型</p>
          </div>
        </div>
      ) : null}
    </div>

    <PaymentModal
      open={payOpen}
      meta={result ? {
        tempPath: result.tempPath,
        suggestedName: result.suggestedName,
        format: result.format,
      } : undefined}
      onClose={() => setPayOpen(false)}
      onPaid={handlePaid}
    />
    </>
  );
}
