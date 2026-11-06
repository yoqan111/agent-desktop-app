import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import { HoverVideoControls } from './HoverVideoControls';

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

type Handle = 'move' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

interface CropEditorProps {
  src: string;
  mediaWidth: number;
  mediaHeight: number;
  mode?: 'video' | 'image';
  value: CropRect;
  disabled?: boolean;
  onChange: (next: CropRect) => void;
}

const MIN = 16;

function clampRect(rect: CropRect, maxW: number, maxH: number): CropRect {
  let { x, y, width, height } = rect;
  width = Math.max(MIN, Math.min(width, maxW));
  height = Math.max(MIN, Math.min(height, maxH));
  x = Math.max(0, Math.min(x, maxW - width));
  y = Math.max(0, Math.min(y, maxH - height));
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
  };
}

export function CropEditor({
  src,
  mediaWidth,
  mediaHeight,
  mode = 'video',
  value,
  disabled,
  onChange,
}: CropEditorProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const dragRef = useRef<{
    handle: Handle;
    startX: number;
    startY: number;
    origin: CropRect;
  } | null>(null);
  const [display, setDisplay] = useState({ left: 0, top: 0, width: 0, height: 0, scale: 1 });

  const measure = useCallback(() => {
    const stage = stageRef.current;
    if (!stage || !mediaWidth || !mediaHeight) {
      return;
    }
    const stageW = stage.clientWidth;
    const stageH = stage.clientHeight;
    // Leave room under the frame for hover transport so it never covers the crop box.
    const transportReserve = mode === 'video' ? 48 : 0;
    const fit = Math.min(stageW / mediaWidth, (stageH - transportReserve) / mediaHeight);
    const width = mediaWidth * fit;
    const height = mediaHeight * fit;
    setDisplay({
      left: (stageW - width) / 2,
      top: (stageH - transportReserve - height) / 2,
      width,
      height,
      scale: fit,
    });
  }, [mediaWidth, mediaHeight, mode]);

  useEffect(() => {
    measure();
    const stage = stageRef.current;
    if (!stage || typeof ResizeObserver === 'undefined') {
      return undefined;
    }
    const observer = new ResizeObserver(() => measure());
    observer.observe(stage);
    return () => observer.disconnect();
  }, [measure, src]);

  useEffect(() => {
    const onMove = (event: PointerEvent): void => {
      const drag = dragRef.current;
      if (!drag || disabled) {
        return;
      }
      const dx = (event.clientX - drag.startX) / display.scale;
      const dy = (event.clientY - drag.startY) / display.scale;
      const o = drag.origin;
      let next = { ...o };

      if (drag.handle === 'move') {
        next = { ...o, x: o.x + dx, y: o.y + dy };
      } else {
        if (drag.handle.includes('e')) {
          next.width = o.width + dx;
        }
        if (drag.handle.includes('s')) {
          next.height = o.height + dy;
        }
        if (drag.handle.includes('w')) {
          next.x = o.x + dx;
          next.width = o.width - dx;
        }
        if (drag.handle.includes('n')) {
          next.y = o.y + dy;
          next.height = o.height - dy;
        }
      }
      onChange(clampRect(next, mediaWidth, mediaHeight));
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
  }, [disabled, display.scale, onChange, mediaHeight, mediaWidth]);

  const startDrag = (handle: Handle, event: ReactPointerEvent<HTMLElement>): void => {
    if (disabled) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    dragRef.current = {
      handle,
      startX: event.clientX,
      startY: event.clientY,
      origin: { ...value },
    };
  };

  const box = {
    left: display.left + value.x * display.scale,
    top: display.top + value.y * display.scale,
    width: value.width * display.scale,
    height: value.height * display.scale,
  };

  return (
    <div className="crop-editor" ref={stageRef}>
      <div
        className="crop-frame"
        style={{
          left: display.left,
          top: display.top,
          width: display.width,
          height: display.height,
        }}
      >
        {mode === 'image' ? (
          <img
            ref={imageRef}
            className="crop-video"
            src={src}
            alt=""
            draggable={false}
            onLoad={measure}
          />
        ) : (
          <video
            ref={videoRef}
            className="crop-video"
            src={src}
            muted
            playsInline
            onLoadedMetadata={measure}
          />
        )}
        <div className="crop-shade" style={{ clipPath: shadeClip(box, display) }} />
        <div
          className="crop-box"
          style={{
            left: value.x * display.scale,
            top: value.y * display.scale,
            width: value.width * display.scale,
            height: value.height * display.scale,
          }}
          onPointerDown={(event) => startDrag('move', event)}
        >
          <span className="crop-rule crop-rule-h" />
          <span className="crop-rule crop-rule-h mid" />
          <span className="crop-rule crop-rule-v" />
          <span className="crop-rule crop-rule-v mid" />
          {(['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as Handle[]).map((handle) => (
            <button
              key={handle}
              type="button"
              className={`crop-handle crop-handle-${handle}`}
              aria-label={`调整 ${handle}`}
              disabled={disabled}
              onPointerDown={(event) => startDrag(handle, event)}
            />
          ))}
        </div>
      </div>

      {mode === 'video' && src ? (
        <HoverVideoControls
          videoRef={videoRef as RefObject<HTMLVideoElement | null>}
          className="crop-transport"
        />
      ) : null}

      {!src ? (
        <p className="crop-empty">
          {mode === 'image' ? '选择图片后可在画面上拖动裁剪框' : '选择视频后可在画面上拖动裁剪框'}
        </p>
      ) : null}
    </div>
  );
}

function shadeClip(
  box: { left: number; top: number; width: number; height: number },
  display: { left: number; top: number; width: number; height: number },
): string {
  // Shade is positioned over the video frame; punch a hole with evenodd polygon
  const x1 = box.left - display.left;
  const y1 = box.top - display.top;
  const x2 = x1 + box.width;
  const y2 = y1 + box.height;
  const w = display.width;
  const h = display.height;
  return `polygon(evenodd, 0 0, ${w}px 0, ${w}px ${h}px, 0 ${h}px, 0 0, ${x1}px ${y1}px, ${x1}px ${y2}px, ${x2}px ${y2}px, ${x2}px ${y1}px, ${x1}px ${y1}px)`;
}
