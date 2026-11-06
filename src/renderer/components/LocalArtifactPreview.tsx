import { useEffect, useId, useState, type ReactElement } from 'react';
import {
  getLocalArtifactPreviewKind,
  localArtifactPreviewLabel,
  type LocalArtifactRef,
} from '../../shared/local-artifacts';
import { AgentMarkdown } from './AgentMarkdown';

const TEXT_PREVIEW_LIMIT = 400_000;

type LocalArtifactPreviewProps = {
  artifact: LocalArtifactRef;
  onClose: () => void;
  onOpenExternal: (path: string) => void;
  onReveal: (path: string) => void;
};

export function LocalArtifactPreview({
  artifact,
  onClose,
  onOpenExternal,
  onReveal,
}: LocalArtifactPreviewProps): ReactElement | null {
  const titleId = useId();
  const kind = getLocalArtifactPreviewKind(artifact.path);
  const previewUrl = typeof window.media?.previewUrl === 'function'
    ? window.media.previewUrl(artifact.path)
    : '';
  const [text, setText] = useState('');
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(kind === 'markdown' || kind === 'text');
  const [error, setError] = useState('');

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    if (kind !== 'markdown' && kind !== 'text') {
      setLoading(false);
      return undefined;
    }
    if (!previewUrl) {
      setError('无法生成预览地址。');
      setLoading(false);
      return undefined;
    }

    let cancelled = false;
    setLoading(true);
    setError('');
    setText('');
    setTruncated(false);

    void (async () => {
      try {
        const response = await fetch(previewUrl);
        if (!response.ok) {
          throw new Error(`读取失败（${response.status}）`);
        }
        const body = await response.text();
        if (cancelled) return;
        if (body.length > TEXT_PREVIEW_LIMIT) {
          setText(body.slice(0, TEXT_PREVIEW_LIMIT));
          setTruncated(true);
        } else {
          setText(body);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : '读取文件失败');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [artifact.path, kind, previewUrl]);

  if (!kind) return null;

  return (
    <div className="artifact-preview-backdrop" role="presentation" onClick={onClose}>
      <div
        className="artifact-preview-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="artifact-preview-head">
          <div className="artifact-preview-meta">
            <span className="artifact-preview-kind">{localArtifactPreviewLabel(kind)}</span>
            <strong id={titleId} title={artifact.path}>{artifact.name}</strong>
            <em title={artifact.path}>{artifact.path}</em>
          </div>
          <div className="artifact-preview-actions">
            <button
              type="button"
              className="btn-secondary"
              onClick={() => onReveal(artifact.path)}
            >
              目录
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => onOpenExternal(artifact.path)}
            >
              系统打开
            </button>
            <button type="button" className="btn-primary" onClick={onClose} autoFocus>
              关闭
            </button>
          </div>
        </header>

        <div className={`artifact-preview-body is-${kind}`}>
          {error ? (
            <p className="artifact-preview-error">{error}</p>
          ) : null}

          {!error && kind === 'image' ? (
            <img className="artifact-preview-image" src={previewUrl} alt={artifact.name} />
          ) : null}

          {!error && kind === 'video' ? (
            <video className="artifact-preview-video" src={previewUrl} controls preload="metadata" />
          ) : null}

          {!error && (kind === 'markdown' || kind === 'text') ? (
            loading ? (
              <p className="artifact-preview-loading">读取中…</p>
            ) : kind === 'markdown' ? (
              <div className="artifact-preview-markdown">
                <AgentMarkdown content={text || '_（空文件）_'} />
                {truncated ? <p className="artifact-preview-truncated">内容过长，已截断预览。</p> : null}
              </div>
            ) : (
              <pre className="artifact-preview-text">
                {text || '（空文件）'}
                {truncated ? '\n\n…内容过长，已截断预览。' : ''}
              </pre>
            )
          ) : null}
        </div>
      </div>
    </div>
  );
}
