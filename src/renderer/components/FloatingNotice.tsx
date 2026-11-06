import { useEffect, type ReactElement } from 'react';

interface FloatingNoticeProps {
  message: string;
  tone?: 'error' | 'info' | 'ok';
  /** Auto dismiss after ms; 0 / omit keeps until closed. */
  autoCloseMs?: number;
  onClose: () => void;
}

export function FloatingNotice({
  message,
  tone = 'error',
  autoCloseMs = 0,
  onClose,
}: FloatingNoticeProps): ReactElement | null {
  const text = (message || '').trim();

  useEffect(() => {
    if (!text || !autoCloseMs || autoCloseMs <= 0) return undefined;
    const timer = window.setTimeout(() => onClose(), autoCloseMs);
    return () => window.clearTimeout(timer);
  }, [autoCloseMs, onClose, text]);

  if (!text) return null;

  return (
    <div className="floating-notice-host" role="presentation">
      <div className={`floating-notice is-${tone}`} role="alert" aria-live="assertive">
        <div className="floating-notice-copy">
          <strong>{tone === 'error' ? '出错了' : tone === 'ok' ? '完成' : '提示'}</strong>
          <p>{text}</p>
        </div>
        <button
          type="button"
          className="floating-notice-close"
          aria-label="关闭提示"
          title="关闭"
          onClick={onClose}
        >
          ×
        </button>
      </div>
    </div>
  );
}
