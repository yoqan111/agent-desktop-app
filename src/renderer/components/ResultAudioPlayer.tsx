import { useEffect, useMemo, useRef, useState } from 'react';

interface ResultAudioPlayerProps {
  src: string;
  title?: string;
}

function formatClock(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) {
    return '0:00';
  }
  const total = Math.floor(sec);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/** Deterministic faux waveform so the stage feels like a media deck, not a bare browser control. */
const WAVE_BARS = Array.from({ length: 48 }, (_, i) => {
  const swell = Math.sin(i * 0.37) * 0.5 + 0.5;
  const detail = Math.sin(i * 1.21 + 0.8) * 0.5 + 0.5;
  return 0.22 + (swell * 0.55 + detail * 0.45) * 0.78;
});

export function ResultAudioPlayer({ src, title }: ResultAudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const seekingRef = useRef(false);

  const progress = duration > 0 ? Math.min(100, (current / duration) * 100) : 0;
  const activeBars = useMemo(
    () => Math.max(0, Math.round((progress / 100) * WAVE_BARS.length)),
    [progress],
  );

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) {
      return undefined;
    }

    const sync = (): void => {
      if (!seekingRef.current) {
        setCurrent(audio.currentTime);
      }
      setDuration(Number.isFinite(audio.duration) ? audio.duration : 0);
      setPlaying(!audio.paused && !audio.ended);
      setMuted(audio.muted);
    };

    sync();
    audio.addEventListener('timeupdate', sync);
    audio.addEventListener('loadedmetadata', sync);
    audio.addEventListener('play', sync);
    audio.addEventListener('pause', sync);
    audio.addEventListener('ended', sync);
    audio.addEventListener('volumechange', sync);
    return () => {
      audio.removeEventListener('timeupdate', sync);
      audio.removeEventListener('loadedmetadata', sync);
      audio.removeEventListener('play', sync);
      audio.removeEventListener('pause', sync);
      audio.removeEventListener('ended', sync);
      audio.removeEventListener('volumechange', sync);
    };
  }, [src]);

  function togglePlay(): void {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused || audio.ended) {
      void audio.play();
    } else {
      audio.pause();
    }
  }

  function toggleMute(): void {
    const audio = audioRef.current;
    if (!audio) return;
    audio.muted = !audio.muted;
    setMuted(audio.muted);
  }

  function seekTo(ratio: number): void {
    const audio = audioRef.current;
    if (!audio || !Number.isFinite(audio.duration) || audio.duration <= 0) {
      return;
    }
    const next = Math.max(0, Math.min(1, ratio)) * audio.duration;
    audio.currentTime = next;
    setCurrent(next);
  }

  return (
    <div className={`result-audio-player${playing ? ' is-playing' : ''}`}>
      <audio ref={audioRef} src={src} preload="metadata" />

      <div className="result-audio-deck">
        <div className="result-audio-meta">
          <span className="result-audio-badge">AUDIO</span>
          <strong title={title}>{title || '临时预览'}</strong>
          <em>本机临时文件 · 确认后导出</em>
        </div>

        <button
          type="button"
          className="result-audio-wave"
          aria-label={playing ? '暂停' : '播放'}
          onClick={togglePlay}
        >
          {WAVE_BARS.map((height, index) => (
            <i
              key={index}
              className={index < activeBars ? 'is-played' : undefined}
              style={{
                height: `${Math.round(height * 100)}%`,
                animationDelay: `${(index % 12) * 40}ms`,
              }}
            />
          ))}
        </button>

        <div className="result-audio-transport">
          <button
            type="button"
            className="hover-video-btn result-audio-play"
            aria-label={playing ? '暂停' : '播放'}
            onClick={togglePlay}
          >
            {playing ? (
              <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
                <rect x="6" y="5" width="4" height="14" fill="currentColor" rx="1" />
                <rect x="14" y="5" width="4" height="14" fill="currentColor" rx="1" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
                <path d="M8 5v14l11-7z" fill="currentColor" />
              </svg>
            )}
          </button>

          <span className="hover-video-time">{formatClock(current)}</span>

          <label className="hover-video-seek" aria-label="进度">
            <input
              type="range"
              min={0}
              max={1000}
              value={Math.round(progress * 10)}
              onPointerDown={() => { seekingRef.current = true; }}
              onPointerUp={() => { seekingRef.current = false; }}
              onChange={(event) => seekTo(Number(event.target.value) / 1000)}
            />
            <span className="hover-video-seek-fill" style={{ width: `${progress}%` }} />
          </label>

          <span className="hover-video-time">{formatClock(duration)}</span>

          <button
            type="button"
            className="hover-video-btn"
            aria-label={muted ? '取消静音' : '静音'}
            onClick={toggleMute}
          >
            {muted ? (
              <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden>
                <path
                  d="M5 9v6h4l5 5V4L9 9H5zm12.5 3c0-1.8-1-3.3-2.5-4v8c1.5-.7 2.5-2.2 2.5-4z"
                  fill="currentColor"
                  opacity="0.35"
                />
                <path d="M3 3l18 18" stroke="currentColor" strokeWidth="2" fill="none" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden>
                <path
                  d="M5 9v6h4l5 5V4L9 9H5zm12.5 3c0-1.8-1-3.3-2.5-4v8c1.5-.7 2.5-2.2 2.5-4z"
                  fill="currentColor"
                />
              </svg>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
