import { useEffect, useMemo, useState, type ReactElement } from 'react';
import type { MediaKind } from '../../shared/media';
import { AUDIO_FORMATS, IMAGE_FORMATS, VIDEO_FORMATS } from '../../shared/media';
import type { ToolTab } from '../tools';
import { kindLabel, toolSubtitle, toolTitle, toolsForKind } from '../tools';

const KINDS: MediaKind[] = ['video', 'image', 'audio'];
const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const;
const FPS = 25;
const STUDIO_STEPS = [
  { id: 'record', label: '录制', hint: 'Codegen 抓取操作' },
  { id: 'replay', label: '回放', hint: '带登录态批量执行' },
  { id: 'artifact', label: '产物', hint: '截图 / Trace / 视频' },
  { id: 'agent', label: 'Agent', hint: '读懂流程并给出建议' },
] as const;

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
  const [activeStep, setActiveStep] = useState(0);

  useEffect(() => {
    if (!dragging) {
      setFrames(0);
      return undefined;
    }
    const id = window.setInterval(() => setFrames((n) => n + 1), 1000 / FPS);
    return () => window.clearInterval(id);
  }, [dragging]);

  useEffect(() => {
    const id = window.setInterval(() => {
      setActiveStep((n) => (n + 1) % STUDIO_STEPS.length);
    }, 2200);
    return () => window.clearInterval(id);
  }, []);

  const tools = useMemo(() => toolsForKind(benchKind), [benchKind]);

  return (
    <div className="welcome">
      <header className="welcome-top">
        <span className="welcome-mark" aria-hidden>M</span>
        <span className="welcome-wordmark">MediaDo</span>
        <span className="welcome-top-scope is-studio">Playwright Studio</span>
        <span className="welcome-top-scope is-media">媒体处理</span>
        <div className="welcome-top-nav">
          <span className="welcome-top-state">
            <i aria-hidden className={dragging || importing ? 'is-live' : ''} />
            {importing ? '读取文件' : dragging ? '信号输入' : '待机'}
          </span>
        </div>
      </header>

      <div className="welcome-scroll">
        <section className="welcome-hero" aria-label="Playwright Studio">
          <div className="welcome-stage" aria-hidden>
            <div className="stage-frame">
              <span className="stage-chip">
                <i />
                Studio · Live
              </span>
              <span className="stage-badge">本机运行</span>
              <i className="stage-scan" />

              <div className="stage-pipeline">
                {STUDIO_STEPS.map((step, index) => (
                  <div
                    key={step.id}
                    className={`stage-step${index === activeStep ? ' is-active' : ''}${index < activeStep ? ' is-done' : ''}`}
                  >
                    <strong>{String(index + 1).padStart(2, '0')}</strong>
                    <b>{step.label}</b>
                    <span>{step.hint}</span>
                  </div>
                ))}
              </div>

              <div className="stage-footer">
                <span>Record → Replay → Artifacts → Agent</span>
                <em>Chromium · Chrome · 持久登录态</em>
              </div>
            </div>
          </div>

          <div className="welcome-pitch">
            <p className="welcome-eyebrow">Playwright Studio · 浏览器自动化</p>
            <h1>
              录制、回放，再用 Agent 读懂流程
              <span className="welcome-dot">。</span>
            </h1>
            <p className="welcome-lede">
              本机跑 Playwright：录脚本、管登录态与产物，支持批量回放；把一次流程交给 Agent，直接看懂卡点与建议。
            </p>

            <div className="welcome-cta-row">
              <button
                type="button"
                className="btn-primary welcome-cta"
                disabled={importing}
                onClick={onOpenPlaywright}
              >
                进入 Playwright Studio
              </button>
              <button
                type="button"
                className="welcome-cta-link"
                onClick={() => {
                  document.getElementById('welcome-media')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }}
              >
                或继续媒体处理
              </button>
            </div>

            <ul className="welcome-trust">
              <li>录制即脚本，关闭窗口自动保存</li>
              <li>截图 / Trace / 视频产物可回溯</li>
              <li>Agent 可分析工作流与本地产物</li>
            </ul>
          </div>
        </section>

        <section id="welcome-media" className="welcome-media" aria-label="媒体处理">
          <div className="bench-head">
            <h2>媒体处理</h2>
            <span className="bench-rule" aria-hidden />
            <p>本地 FFmpeg · 与 Studio 相互独立</p>
          </div>

          <div className="welcome-media-grid">
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

            <div className="welcome-media-side">
              <p className="welcome-media-lede">
                视频、图片和音频都在本机用 FFmpeg 处理。先出临时预览，确认后再选保存位置，源文件不会被改动。
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
                  className="btn-secondary welcome-cta"
                  disabled={importing}
                  onClick={() => onPick(benchKind)}
                >
                  {importing ? '读取中…' : `选择${kindLabel(benchKind)}`}
                </button>
              </div>

              <div className="bench-grid is-compact">
                {tools.map((tab) => (
                  <button key={tab} type="button" className="bench-card" onClick={() => onStart(benchKind, tab)}>
                    <strong>{toolTitle(benchKind, tab)}</strong>
                    <span>{toolSubtitle(benchKind, tab)}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </section>

        <footer className="welcome-foot">
          <span>Studio 与媒体处理相互独立，均可离线使用</span>
          <span>拖入媒体文件可直接开始处理</span>
        </footer>
      </div>
    </div>
  );
}
