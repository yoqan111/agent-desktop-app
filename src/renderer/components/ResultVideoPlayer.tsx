import { useRef } from 'react';
import { HoverVideoControls } from './HoverVideoControls';

interface ResultVideoPlayerProps {
  src: string;
}

/** Result-stage video with hover-only custom transport. */
export function ResultVideoPlayer({ src }: ResultVideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  return (
    <div className="result-player">
      <video
        ref={videoRef}
        className="result-video"
        src={src}
        playsInline
        muted
      />
      <HoverVideoControls videoRef={videoRef} />
    </div>
  );
}
