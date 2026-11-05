import { useEffect, useRef, useState, type RefObject } from 'react';

interface HoverVideoControlsProps {
  videoRef: RefObject<HTMLVideoElement | null>;
  /** Extra class on the transport bar (positioning). */
  className?: string;
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

/** Custom playhead / mute bar; parent should show it on hover via CSS. */
export function HoverVideoControls({ videoRef, className }: HoverVideoControlsProps) {
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(true);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const seekingRef = useRef(false);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) {
      return undefined;
    }

    const sync = (): void => {
      if (!seekingRef.current) {
        setCurrent(video.currentTime);
      }
      setDuration(Number.isFinite(video.duration) ? video.duration : 0);
      setPlaying(!video.paused && !video.ended);
      setMuted(video.muted);
    };

    sync();
    video.addEventListener('timeupdate', sync);
    video.addEventListener('loadedmetadata', sync);
    video.addEventListener('play', sync);
    video.addEventListener('pause', sync);
    video.addEventListener('ended', sync);
    video.addEventListener('volumechange', sync);
    return () => {
      video.removeEventListener('timeupdate', sync);
      video.removeEventListener('loadedmetadata', sync);
      video.removeEventListener('play', sync);
      video.removeEventListener('pause', sync);
      video.removeEventListener('ended', sync);
      video.removeEventListener('volumechange', sync);
    };
  }, [videoRef]);

  function togglePlay(): void {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    if (video.paused || video.ended) {
      void video.play();
    } else {
      video.pause();
    }
  }

  function toggleMute(): void {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    video.muted = !video.muted;
    setMuted(video.muted);
  }

  function seekTo(ratio: number): void {
    const video = videoRef.current;
    if (!video || !Number.isFinite(video.duration) || video.duration <= 0) {
      return;
    }
    const next = Math.max(0, Math.min(1, ratio)) * video.duration;
    video.currentTime = next;
    setCurrent(next);
  }

  const progress = duration > 0 ? Math.min(100, (current / duration) * 100) : 0;

  return (
    <div
      className={`hover-video-controls ${className || ''}`.trim()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        className="hover-video-btn"
        aria-label={playing ? '暂停' : '播放'}
        onClick={togglePlay}
      >
        {playing ? (
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden>
            <rect x="6" y="5" width="4" height="14" fill="currentColor" rx="1" />
            <rect x="14" y="5" width="4" height="14" fill="currentColor" rx="1" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden>
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
              d="M5 9v6h4l5 5V4L9 9H5zm12.5 3c0-1.8-1-3.3-2.5-4v8c1.5-.7 2.5-2.2 2.5-4zM14 3.2v2.1c2.9.9 5 3.5 5 6.7s-2.1 5.8-5 6.7v2.1c4-.9 7-4.5 7-8.8s-3-7.9-7-8.8z"
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
  );
}
