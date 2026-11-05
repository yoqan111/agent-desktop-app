import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';

export interface TrimRange {
  startSec: number;
  endSec: number;
}

interface TimelineTrimProps {
  durationSec: number;
  value: TrimRange;
  disabled?: boolean;
  /** Optional media URL for waveform (audio) or scrubbing (video). */
  src?: string;
  mode?: 'audio' | 'video';
  onChange: (next: TrimRange) => void;
}

type Handle = 'start' | 'end' | 'move';

const MIN_SPAN = 0.1;

function clampRange(start: number, end: number, duration: number): TrimRange {
  const max = Math.max(MIN_SPAN, duration);
  let s = Number.isFinite(start) ? start : 0;
  let e = Number.isFinite(end) ? end : max;
  s = Math.max(0, Math.min(s, max - MIN_SPAN));
  e = Math.max(s + MIN_SPAN, Math.min(e, max));
  return {
    startSec: Math.round(s * 100) / 100,
    endSec: Math.round(e * 100) / 100,
  };
}

function formatTime(sec: number): string {
  const total = Math.max(0, sec);
  const m = Math.floor(total / 60);
  const s = total - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

function buildFallbackPeaks(count: number, seed: number): number[] {
  const peaks: number[] = [];
  let x = seed || 1;
  for (let i = 0; i < count; i += 1) {
    x = (x * 16807) % 2147483647;
    const n = 0.25 + (x / 2147483647) * 0.75;
    peaks.push(n);
  }
  return peaks;
}

async function extractPeaks(src: string, barCount: number): Promise<number[] | null> {
  try {
    const response = await fetch(src);
    const buffer = await response.arrayBuffer();
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new AudioCtx();
    const audio = await ctx.decodeAudioData(buffer.slice(0));
    const channel = audio.getChannelData(0);
    const block = Math.max(1, Math.floor(channel.length / barCount));
    const peaks: number[] = [];
    for (let i = 0; i < barCount; i += 1) {
      const start = i * block;
      let peak = 0;
      for (let j = 0; j < block && start + j < channel.length; j += 1) {
        peak = Math.max(peak, Math.abs(channel[start + j]));
      }
      peaks.push(peak);
    }
    const max = Math.max(...peaks, 0.001);
    await ctx.close();
    return peaks.map((p) => Math.max(0.08, p / max));
  } catch {
    return null;
  }
}

export function TimelineTrim({
  durationSec,
  value,
  disabled,
  src,
  mode = 'audio',
  onChange,
}: TimelineTrimProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const mediaRef = useRef<HTMLAudioElement | HTMLVideoElement | null>(null);
  const dragRef = useRef<{
    handle: Handle;
    startX: number;
    origin: TrimRange;
  } | null>(null);
  const [peaks, setPeaks] = useState<number[]>(() => buildFallbackPeaks(64, Math.round(durationSec * 1000)));
  const [playing, setPlaying] = useState(false);

  const duration = Math.max(MIN_SPAN, durationSec || 0);
  const range = useMemo(
    () => clampRange(value.startSec, value.endSec || duration, duration),
    [value.startSec, value.endSec, duration],
  );

  useEffect(() => {
    let cancelled = false;
    if (!src || mode !== 'audio') {
      setPeaks(buildFallbackPeaks(64, Math.round(duration * 1000)));
      return undefined;
    }
    void (async () => {
      const next = await extractPeaks(src, 72);
      if (!cancelled) {
        setPeaks(next || buildFallbackPeaks(72, Math.round(duration * 1000)));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [src, mode, duration]);

  useEffect(() => {
    const media = mediaRef.current;
    if (!media) {
      return undefined;
    }
    const onTime = (): void => {
      if (media.currentTime >= range.endSec - 0.05) {
        media.pause();
        media.currentTime = range.startSec;
        setPlaying(false);
      }
    };
    const onEnded = (): void => setPlaying(false);
    media.addEventListener('timeupdate', onTime);
    media.addEventListener('ended', onEnded);
    return () => {
      media.removeEventListener('timeupdate', onTime);
      media.removeEventListener('ended', onEnded);
    };
  }, [range.endSec, range.startSec]);

  const secToRatio = useCallback((sec: number) => sec / duration, [duration]);
  const ratioToSec = useCallback((ratio: number) => ratio * duration, [duration]);

  useEffect(() => {
    const onMove = (event: PointerEvent): void => {
      const drag = dragRef.current;
      const track = trackRef.current;
      if (!drag || !track || disabled) {
        return;
      }
      const rect = track.getBoundingClientRect();
      const dxRatio = (event.clientX - drag.startX) / Math.max(1, rect.width);
      const dxSec = dxRatio * duration;
      const o = drag.origin;
      if (drag.handle === 'start') {
        onChange(clampRange(o.startSec + dxSec, o.endSec, duration));
      } else if (drag.handle === 'end') {
        onChange(clampRange(o.startSec, o.endSec + dxSec, duration));
      } else {
        const span = o.endSec - o.startSec;
        let nextStart = o.startSec + dxSec;
        nextStart = Math.max(0, Math.min(nextStart, duration - span));
        onChange(clampRange(nextStart, nextStart + span, duration));
      }
    };
    const onUp = (): void => {
      dragRef.current = null;
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [disabled, duration, onChange]);

  const startDrag = (handle: Handle, event: ReactPointerEvent<HTMLElement>): void => {
    if (disabled) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    dragRef.current = {
      handle,
      startX: event.clientX,
      origin: { ...range },
    };
  };

  const seekFromClick = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (disabled || dragRef.current) {
      return;
    }
    const track = trackRef.current;
    if (!track) {
      return;
    }
    const rect = track.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    const sec = ratioToSec(ratio);
    const media = mediaRef.current;
    if (media) {
      media.currentTime = sec;
    }
  };

  const togglePlay = async (): Promise<void> => {
    const media = mediaRef.current;
    if (!media || disabled) {
      return;
    }
    if (playing) {
      media.pause();
      setPlaying(false);
      return;
    }
    if (media.currentTime < range.startSec || media.currentTime >= range.endSec) {
      media.currentTime = range.startSec;
    }
    try {
      await media.play();
      setPlaying(true);
    } catch {
      setPlaying(false);
    }
  };

  const left = secToRatio(range.startSec) * 100;
  const width = Math.max(0.5, (secToRatio(range.endSec) - secToRatio(range.startSec)) * 100);

  return (
    <div className={`timeline-trim ${mode}`}>
      {src ? (
        mode === 'video' ? (
          <video
            ref={mediaRef as RefObject<HTMLVideoElement>}
            className="timeline-media"
            src={src}
            playsInline
            preload="metadata"
          />
        ) : (
          <audio ref={mediaRef as RefObject<HTMLAudioElement>} src={src} preload="auto" />
        )
      ) : null}

      <div className="timeline-toolbar">
        <button type="button" className="btn-secondary timeline-play" disabled={disabled || !src} onClick={() => { void togglePlay(); }}>
          {playing ? '暂停' : mode === 'video' ? '预览选区' : '试听选区'}
        </button>
        <p className="hint">
          选区 {formatTime(range.startSec)} – {formatTime(range.endSec)}
          <span> · 共 {formatTime(range.endSec - range.startSec)}</span>
        </p>
      </div>

      <div
        className="timeline-track"
        ref={trackRef}
        onPointerDown={seekFromClick}
      >
        <div className="timeline-wave" aria-hidden>
          {peaks.map((peak, index) => (
            <span
              key={index}
              className="timeline-bar"
              style={{ height: `${Math.round(peak * 100)}%` }}
            />
          ))}
        </div>
        <div className="timeline-shade left" style={{ width: `${left}%` }} />
        <div className="timeline-shade right" style={{ width: `${100 - left - width}%` }} />
        <div
          className="timeline-selection"
          style={{ left: `${left}%`, width: `${width}%` }}
          onPointerDown={(event) => startDrag('move', event)}
        >
          <button
            type="button"
            className="timeline-handle start"
            aria-label="调整开始"
            disabled={disabled}
            onPointerDown={(event) => startDrag('start', event)}
          />
          <button
            type="button"
            className="timeline-handle end"
            aria-label="调整结束"
            disabled={disabled}
            onPointerDown={(event) => startDrag('end', event)}
          />
        </div>
      </div>

      <div className="timeline-ruler">
        <span>0:00</span>
        <span>{formatTime(duration / 2)}</span>
        <span>{formatTime(duration)}</span>
      </div>
    </div>
  );
}
