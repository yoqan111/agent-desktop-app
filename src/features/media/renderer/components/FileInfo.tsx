import type { ReactElement } from 'react';
import type { MediaProbe } from '../../shared/media';

type Fact = {
  label: string;
  value: string;
  detail?: string;
};

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  return `${(size / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatBitrate(bps: number): string | null {
  if (!bps || bps <= 0) return null;
  if (bps >= 1_000_000) {
    const mbps = bps / 1_000_000;
    return `${mbps >= 10 ? mbps.toFixed(1) : mbps.toFixed(2)} Mbps`;
  }
  if (bps >= 1000) return `${Math.round(bps / 1000)} kbps`;
  return `${bps} bps`;
}

function formatExactDuration(sec: number): { clock: string; seconds: string } | null {
  if (!Number.isFinite(sec) || sec <= 0) return null;
  const msTotal = Math.round(sec * 1000);
  const hours = Math.floor(msTotal / 3_600_000);
  const minutes = Math.floor((msTotal % 3_600_000) / 60_000);
  const seconds = Math.floor((msTotal % 60_000) / 1000);
  const millis = msTotal % 1000;
  const clock = hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`
    : `${minutes}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
  return { clock, seconds: `${(msTotal / 1000).toFixed(3)} 秒` };
}

function formatFrameRate(fps: number): string | null {
  if (!fps) return null;
  const rounded = Math.round(fps * 1000) / 1000;
  const text = Number.isInteger(rounded)
    ? String(rounded)
    : rounded.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
  return `${text} fps`;
}

function formatSampleRate(hz: number): string {
  if (hz % 1000 === 0) return `${hz / 1000} kHz`;
  if (hz % 100 === 0) return `${(hz / 1000).toFixed(1)} kHz`;
  return `${hz} Hz`;
}

function channelLabel(channels: number, layout: string): string {
  if (layout === 'mono' || channels === 1) return '单声道';
  if (layout === 'stereo' || channels === 2) return '立体声';
  if (layout) return layout;
  if (channels > 0) return `${channels} 声道`;
  return '';
}

function resolutionGrade(width: number, height: number): string {
  const shortEdge = Math.min(width, height);
  const longEdge = Math.max(width, height);
  if (longEdge >= 7600 || shortEdge >= 4320) return '8K';
  if (longEdge >= 3800 || shortEdge >= 2160) return '4K';
  if (shortEdge >= 1440) return '1440p';
  if (shortEdge >= 1080) return '1080p';
  if (shortEdge >= 720) return '720p';
  if (shortEdge >= 480) return '480p';
  if (shortEdge >= 360) return '360p';
  return `${shortEdge}p`;
}

function gcd(a: number, b: number): number {
  let x = Math.abs(Math.round(a));
  let y = Math.abs(Math.round(b));
  while (y) {
    const next = x % y;
    x = y;
    y = next;
  }
  return x || 1;
}

function aspectLabel(width: number, height: number): string {
  const ratio = width / height;
  const common: Array<[number, string]> = [
    [16 / 9, '16:9'],
    [9 / 16, '9:16'],
    [4 / 3, '4:3'],
    [3 / 4, '3:4'],
    [1, '1:1'],
    [21 / 9, '21:9'],
    [2.35, '2.35:1'],
    [2, '2:1'],
  ];
  for (const [value, label] of common) {
    if (Math.abs(ratio - value) / value < 0.02) return label;
  }
  const divisor = gcd(width, height);
  const rw = Math.round(width) / divisor;
  const rh = Math.round(height) / divisor;
  if (rw > 40 || rh > 40) return `${ratio.toFixed(3)}:1`;
  return `${rw}:${rh}`;
}

function containerLabel(formatName: string, filePath: string): string {
  const base = filePath.split(/[/\\]/).pop() || filePath;
  const dot = base.lastIndexOf('.');
  const ext = dot >= 0 ? base.slice(dot + 1).toLowerCase() : '';
  if (ext === 'jpg' || ext === 'jpeg') return 'JPG';
  if (ext) return ext.toUpperCase();
  const parts = formatName.split(',').map((part) => part.trim()).filter(Boolean);
  return (parts[0] || formatName).toUpperCase();
}

function fileName(filePath: string): string {
  return filePath.split(/[/\\]/).pop() || filePath;
}

function buildFacts(probe: MediaProbe): Fact[] {
  const facts: Fact[] = [];
  const width = probe.displayWidth || probe.width;
  const height = probe.displayHeight || probe.height;
  const hasPicture = probe.kind !== 'audio' && width > 0 && height > 0;

  if (hasPicture) {
    facts.push({ label: '宽度', value: `${width} px` });
    facts.push({ label: '高度', value: `${height} px` });
    facts.push({
      label: '分辨率',
      value: `${width} × ${height}`,
      detail: `${resolutionGrade(width, height)} · ${aspectLabel(width, height)}`,
    });
    if ((probe.width > 0 && probe.width !== width) || (probe.height > 0 && probe.height !== height)) {
      facts.push({ label: '编码尺寸', value: `${probe.width} × ${probe.height}` });
    }
    if (probe.rotation === 90 || probe.rotation === 180 || probe.rotation === 270) {
      facts.push({ label: '旋转', value: `${probe.rotation}°` });
    }
  }

  if (probe.kind !== 'image') {
    const duration = formatExactDuration(probe.durationSec);
    if (duration) {
      facts.push({ label: '精确时长', value: duration.clock, detail: duration.seconds });
    }
  }

  if (probe.kind === 'video') {
    const fps = formatFrameRate(probe.frameRate);
    if (fps) facts.push({ label: '帧率', value: fps });
  }

  const totalRate = formatBitrate(probe.bitrateBps);
  if (totalRate) {
    facts.push({ label: '码率', value: totalRate, detail: `${probe.bitrateBps} bps` });
  }
  const videoRate = formatBitrate(probe.videoBitrateBps);
  if (probe.kind === 'video' && videoRate && probe.videoBitrateBps !== probe.bitrateBps) {
    facts.push({ label: '视频码率', value: videoRate });
  }
  const audioRate = formatBitrate(probe.audioBitrateBps);
  if (probe.kind === 'video' && audioRate) {
    facts.push({ label: '音频码率', value: audioRate });
  }

  if (probe.kind === 'audio') {
    facts.push({ label: '编码', value: probe.audioCodec && probe.audioCodec !== 'none' ? probe.audioCodec : '—' });
  } else if (probe.kind === 'image') {
    facts.push({ label: '编码', value: probe.videoCodec && probe.videoCodec !== 'none' ? probe.videoCodec : '—' });
  } else {
    const audio = probe.audioCodec && probe.audioCodec !== 'none' ? probe.audioCodec : '';
    facts.push({
      label: '编码',
      value: audio ? `${probe.videoCodec} / ${audio}` : (probe.videoCodec || '—'),
    });
  }

  if (probe.pixelFormat) {
    facts.push({ label: '像素格式', value: probe.pixelFormat });
  }

  if (probe.kind !== 'image' && probe.sampleRate > 0) {
    const channels = channelLabel(probe.channels, probe.channelLayout);
    facts.push({
      label: '采样率',
      value: formatSampleRate(probe.sampleRate),
      detail: probe.bitsPerSample > 0 ? `${probe.bitsPerSample} bit` : undefined,
    });
    if (channels) facts.push({ label: '声道', value: channels });
  }

  facts.push({ label: '大小', value: formatBytes(probe.sizeBytes) });
  if (probe.formatName) {
    facts.push({ label: '容器', value: containerLabel(probe.formatName, probe.path) });
  }
  return facts;
}

export function FileInfo({ probe, filePath }: { probe: MediaProbe; filePath: string }): ReactElement {
  const facts = buildFacts(probe);
  const name = fileName(filePath || probe.path);

  return (
    <section className="file-info" aria-label="当前文件">
      <header>
        <h2>当前文件</h2>
        <p title={filePath || probe.path}>{name}</p>
      </header>
      <dl>
        {facts.map((fact) => (
          <div key={fact.label}>
            <dt>{fact.label}</dt>
            <dd>
              {fact.value}
              {fact.detail ? <small>{fact.detail}</small> : null}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
