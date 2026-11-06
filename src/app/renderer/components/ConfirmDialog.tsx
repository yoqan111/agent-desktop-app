import { useEffect, useId, useState, type ReactElement } from 'react';
import type { ConfirmAskPayload, ConfirmOptions } from '../../../shared/confirm';
import { askConfirm, bindConfirmHost, resolveConfirm } from '../confirm';

export function ConfirmDialogView({
  open,
  title,
  message,
  confirmLabel = '确定',
  cancelLabel = '取消',
  danger = false,
  onConfirm,
  onCancel,
}: ConfirmOptions & {
  open: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}): ReactElement | null {
  const titleId = useId();
  const messageId = useId();

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCancel();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div
      className="confirm-backdrop"
      role="presentation"
      onClick={onCancel}
    >
      <div
        className="confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={message ? messageId : undefined}
        onClick={(event) => event.stopPropagation()}
      >
        <strong id={titleId}>{title}</strong>
        {message ? <p id={messageId}>{message}</p> : null}
        <div className="confirm-actions">
          <button type="button" className="btn-secondary" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={danger ? 'btn-primary confirm-danger' : 'btn-primary'}
            onClick={onConfirm}
            autoFocus
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Global host: handles askConfirm() from renderer and confirm asks from main process.
 * Mount once at app root.
 */
export function ConfirmHost(): ReactElement {
  const [options, setOptions] = useState<ConfirmOptions | null>(null);

  useEffect(() => {
    bindConfirmHost((request) => {
      setOptions(request?.options ?? null);
    });
    return () => bindConfirmHost(null);
  }, []);

  useEffect(() => {
    if (!window.confirmUi?.onAskFromMain) return undefined;
    return window.confirmUi.onAskFromMain((payload: ConfirmAskPayload) => {
      void askAndRespondToMain(payload);
    });
  }, []);

  return (
    <ConfirmDialogView
      open={Boolean(options)}
      title={options?.title || ''}
      message={options?.message}
      confirmLabel={options?.confirmLabel}
      cancelLabel={options?.cancelLabel}
      danger={options?.danger}
      onCancel={() => resolveConfirm(false)}
      onConfirm={() => resolveConfirm(true)}
    />
  );
}

async function askAndRespondToMain(payload: ConfirmAskPayload): Promise<void> {
  const { requestId, ...options } = payload;
  const ok = await askConfirm(options);
  window.confirmUi?.respondToMain(requestId, ok);
}
