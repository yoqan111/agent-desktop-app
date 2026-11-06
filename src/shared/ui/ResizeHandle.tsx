import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

interface ResizeHandleProps {
  label: string;
  onResize: (deltaX: number) => void;
}

export function ResizeHandle({ label, onResize }: ResizeHandleProps) {
  const origin = useRef(0);
  const [dragging, setDragging] = useState(false);

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>): void {
    event.preventDefault();
    origin.current = event.clientX;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>): void {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) {
      return;
    }
    const next = event.clientX;
    onResize(next - origin.current);
    origin.current = next;
  }

  function onPointerUp(event: ReactPointerEvent<HTMLDivElement>): void {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setDragging(false);
  }

  return (
    <div
      className={dragging ? 'pane-resize is-dragging' : 'pane-resize'}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    />
  );
}
