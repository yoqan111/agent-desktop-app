import { useEffect, useMemo, useState, type ReactElement } from 'react';
import type { MediaKind } from '../../shared/media';
import { AUDIO_FORMATS, IMAGE_FORMATS, VIDEO_FORMATS } from '../../shared/media';
import type { ToolTab } from '../tools';
import { kindLabel, toolSubtitle, toolTitle, toolsForKind } from '../tools';

const KINDS: MediaKind[] = ['video', 'image', 'audio'];
const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const;
const FPS = 25;

/* Fixed heights so the waveform floor does not re-roll on every render. */
const WAVE = Array.from({ length: 64 }, (_, i) => {
  const swell = Math.sin(i * 0.34) * 0.5 + 0.5;
  const detail = Math.sin(i * 1.13 + 0.6) * 0.5 + 0.5;
  return Math.round(12 + (swell * 0.62 + detail * 0.38) * 88);
});

function listFormats(formats: readonly string[]): string {
  return formats.map((item) => item.toUpperCase()).join(' · ');
}

function timecode(frames: number): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  const total = Math.floor(frames / FPS);
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}:${pad(frames % FPS)}`;
}

type WelcomeScreenProps = {
  dragging: boolean;
  importing: boolean;
  onPick: (kind: MediaKind) => void;
  onStart: (kind: MediaKind, tab: ToolTab) => void;
  onOpenPlaywright: () => void;
};

export function WelcomeScreen({
  dragging,
  importing,
  onPick,
  onStart,
  onOpenPlaywright,
}: WelcomeScreenProps): ReactElement {
  const [benchKind, setBenchKind] = useState<MediaKind>('video');
  const [frames, setFrames] = useState(0);

  useEffect(() => {
    if (!dragging) {
      setFrames(0);
      return undefined;
    }
    const id = window.setInterval(() => setFrames((n) => n + 1), 1000 / FPS);
    return () => window.clearInterval(id);
  }, [dragging]);

  const tools = useMemo(() => toolsForKind(benchKind), [benchKind]);

  return (
    <div className="welcome">
      <header className="welcome-top">
        <span className="welcome-mark" aria-hidden>M</span>
        <span className="welcome-wordmark">MediaDo</span>
        <span className="welcome-top-scope">媒体处理</span>
        <div className="welcome-top-nav">
          <button
            type="button"
            className="welcome-nav-pw"
            disabled={importing}
            onClick={onOpenPlaywright}
          >
            Playwright Studio
          </button>
          <span className="welcome-top-state">
            <i aria-hidden className={dragging || importing ? 'is-live' : ''} />
            {importing ? '读取文件' : dragging ? '信号输入' : '待机'}
          </span>
        </div>
      </header>

      <div className="welcome-scroll">
        <section className="welcome-hero" aria-label="媒体处理">
          <div className="welcome-finder" data-drag={dragging ? 'on' : 'off'}>
            <div className="finder-margin">
              <span>VIDEO</span>
              <em>{listFormats(VIDEO_FORMATS)}</em>
              <b>16:9</b>
            </div>

            <div className="finder-frame" role="presentation">
              <i className="finder-rule finder-rule-h" aria-hidden />
              <i className="finder-rule finder-rule-h mid" aria-hidden />
              <i className="finder-rule finder-rule-v" aria-hidden />
              <i className="finder-rule finder-rule-v mid" aria-hidden />
              <i className="finder-playhead" aria-hidden />

              <span className="finder-chip">
                <i aria-hidden />
                {dragging ? '松手即导入' : '取景框 · 空'}
              </span>
              <span className="finder-tc">{timecode(frames)}</span>

              <span className="finder-wave" aria-hidden>
                {WAVE.map((height, i) => <i key={i} style={{ height: `${height}%` }} />)}
              </span>

              {HANDLES.map((pos) => <i key={pos} aria-hidden className={`finder-handle finder-handle-${pos}`} />)}

              <div className="finder-center">
                <strong>{dragging ? '信号锁定' : 'NO SIGNAL'}</strong>
                <p>{dragging ? '松开鼠标，导入这个文件' : '把文件拖进这个取景框'}</p>
              </div>
            </div>

            <div className="finder-margin">
              <span>IMAGE</span>
              <em>{listFormats(IMAGE_FORMATS)}</em>
              <span className="finder-margin-gap">AUDIO</span>
              <em>{listFormats(AUDIO_FORMATS)}</em>
            </div>
          </div>

          <div className="welcome-pitch">
            <p className="welcome-eyebrow">本地 FFmpeg 引擎 · 媒体处理</p>
            <h1>不上云的媒体处理台<span className="welcome-dot">。</span></h1>
            <p className="welcome-lede">
              视频、图片和音频都在本机用 FFmpeg 处理。先生成临时预览，确认满意后再选保存位置，源文件不会被改动。
            </p>

            <div className="welcome-pick">
              <span className="welcome-pick-label">媒体类型</span>
              <div className="welcome-kinds" role="tablist" aria-label="选择要处理的媒体类型">
                {KINDS.map((item) => (
                  <button
                    key={item}
                    type="button"
                    role="tab"
                    aria-selected={benchKind === item}
                    className={benchKind === item ? 'is-active' : ''}
                    onClick={() => setBenchKind(item)}
                  >
                    {kindLabel(item)}
                    <i>{toolsForKind(item).length}</i>
                  </button>
                ))}
              </div>
              <button
                type="button"
                className="btn-primary welcome-cta"
                disabled={importing}
                onClick={() => onPick(benchKind)}
              >
                {importing ? '读取中…' : `选择${kindLabel(benchKind)}`}
              </button>
            </div>

            <ul className="welcome-trust">
              <li>源文件只读，结果先写临时目录</li>
              <li>导出时由你选择保存位置</li>
              <li>断网也能用，素材不经过服务器</li>
            </ul>
          </div>
        </section>

        <section className="welcome-bench" aria-label="媒体处理工作台">
          <div className="bench-head">
            <h2>媒体处理</h2>
            <span className="bench-rule" aria-hidden />
            <p>{kindLabel(benchKind)} · {tools.length} 个工具</p>
          </div>

          <div className="bench-grid">
            {tools.map((tab) => (
              <button key={tab} type="button" className="bench-card" onClick={() => onStart(benchKind, tab)}>
                <strong>{toolTitle(benchKind, tab)}</strong>
                <span>{toolSubtitle(benchKind, tab)}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="welcome-automation" aria-label="浏览器自动化">
          <div className="bench-head">
            <h2 className="is-pw">浏览器自动化</h2>
            <span className="bench-rule" aria-hidden />
            <p>与媒体处理相互独立</p>
          </div>

          <button
            type="button"
            className="automation-card"
            disabled={importing}
            onClick={onOpenPlaywright}
          >
            <span className="automation-mark" aria-hidden>P</span>
            <div className="automation-copy">
              <strong>Playwright Studio</strong>
              <span>录制浏览器操作路径，管理脚本并一键回放。不依赖视频 / 图片 / 音频素材。</span>
            </div>
            <em>进入</em>
          </button>
        </section>

        <footer className="welcome-foot">
          <span>FFmpeg 随应用分发，媒体处理全部在本机完成</span>
          <span>拖入媒体文件可直接开始；自动化请从 Playwright Studio 进入</span>
        </footer>
      </div>
    </div>
  );
}
