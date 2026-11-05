import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import type {
  PlaywrightArtifact,
  PlaywrightArtifactKind,
  PlaywrightAssertTemplate,
  PlaywrightBrowser,
  PlaywrightJobPhase,
  PlaywrightRunEvent,
  PlaywrightRunMode,
  PlaywrightScheduleConfig,
  PlaywrightStudioStatus,
  PlaywrightWorkflowDetail,
  PlaywrightWorkflowMeta,
} from '../../shared/playwright';
import {
  PLAYWRIGHT_BROWSERS,
  PLAYWRIGHT_DEFAULT_SLOW_MO_MS,
  PLAYWRIGHT_DEVICES,
  PLAYWRIGHT_RUN_MODES,
} from '../../shared/playwright';

type StudioTab = 'workflows' | 'record' | 'detail' | 'schedule';

type CaptureKind = 'screenshot' | 'pdf';

interface CaptureProgress {
  kind: CaptureKind;
  phase: PlaywrightJobPhase;
  percent: number;
  message: string;
}

const CAPTURE_STEPS: Array<{ id: string; label: string; shortLabel: string; minPercent: number }> = [
  { id: 'prepare', label: '准备', shortLabel: '准备', minPercent: 0 },
  { id: 'launch', label: '启动浏览器', shortLabel: '启动', minPercent: 15 },
  { id: 'navigate', label: '打开页面', shortLabel: '打开', minPercent: 35 },
  { id: 'capture', label: '导出内容', shortLabel: '导出', minPercent: 60 },
  { id: 'archive', label: '归档', shortLabel: '归档', minPercent: 85 },
];

function phaseLabel(phase?: PlaywrightJobPhase): string {
  switch (phase) {
    case 'recording': return '录制中';
    case 'running': return '执行中';
    case 'passed': return '通过';
    case 'failed': return '失败';
    case 'stopped': return '已停止';
    case 'idle': return '就绪';
    default: return '—';
  }
}

function browserLabel(browser: PlaywrightBrowser): string {
  if (browser === 'chrome') return '本机 Chrome';
  if (browser === 'msedge') return '本机 Edge';
  if (browser === 'firefox') return 'Firefox';
  if (browser === 'webkit') return 'WebKit';
  return 'Chromium';
}

function modeLabel(mode: PlaywrightRunMode): string {
  if (mode === 'headed') return '有头回放';
  if (mode === 'headless') return '无头回放';
  if (mode === 'ui') return 'UI 调试';
  return '逐步 Debug';
}

function artifactKindLabel(kind: PlaywrightArtifactKind): string {
  if (kind === 'trace') return 'Trace';
  if (kind === 'video') return '视频';
  if (kind === 'screenshot') return '截图';
  if (kind === 'pdf') return 'PDF';
  return '其他';
}

function jobKindLabel(kind?: string): string {
  if (kind === 'record') return '录制';
  if (kind === 'batch') return '批量回放';
  if (kind === 'capture') return '截图/PDF';
  if (kind === 'play') return '回放';
  return '任务';
}

function captureKindLabel(kind: CaptureKind): string {
  return kind === 'pdf' ? '导出 PDF' : '页面截图';
}

function captureStepState(
  minPercent: number,
  progress: CaptureProgress,
  index: number,
): 'done' | 'active' | 'pending' {
  if (progress.phase === 'passed') return 'done';
  if (progress.phase === 'failed') {
    const activeIndex = CAPTURE_STEPS.findIndex((step, i, all) => {
      const next = all[i + 1];
      return progress.percent >= step.minPercent && (!next || progress.percent < next.minPercent);
    });
    if (index < activeIndex) return 'done';
    if (index === activeIndex) return 'active';
    return 'pending';
  }
  const next = CAPTURE_STEPS[index + 1];
  if (next && progress.percent >= next.minPercent) return 'done';
  if (progress.percent >= minPercent) return 'active';
  return 'pending';
}

function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size < 0) return '—';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTime(iso?: string): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export function PlaywrightStudio({ onBack }: { onBack: () => void }): ReactElement {
  const [tab, setTab] = useState<StudioTab>('workflows');
  const [status, setStatus] = useState<PlaywrightStudioStatus | null>(null);
  const [list, setList] = useState<PlaywrightWorkflowMeta[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [detail, setDetail] = useState<PlaywrightWorkflowDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [logLines, setLogLines] = useState<string[]>([]);
  const [logCopied, setLogCopied] = useState(false);
  const [livePhase, setLivePhase] = useState<PlaywrightJobPhase>('idle');

  const [name, setName] = useState('示例工作流');
  const [url, setUrl] = useState('https://demo.playwright.dev/todomvc');
  const [browser, setBrowser] = useState<PlaywrightBrowser>('chromium');
  const [device, setDevice] = useState('');
  const [saveAuth, setSaveAuth] = useState(false);
  const [loadAuthFromId, setLoadAuthFromId] = useState('');
  const [usePersistentProfile, setUsePersistentProfile] = useState(true);
  const [notes, setNotes] = useState('');

  const [playMode, setPlayMode] = useState<PlaywrightRunMode>('headed');
  const [playBrowser, setPlayBrowser] = useState<PlaywrightBrowser>('chromium');
  const [slowMo, setSlowMo] = useState(String(PLAYWRIGHT_DEFAULT_SLOW_MO_MS));
  const [scriptDraft, setScriptDraft] = useState('');
  const [nameDraft, setNameDraft] = useState('');
  const [notesDraft, setNotesDraft] = useState('');
  const [artifacts, setArtifacts] = useState<PlaywrightArtifact[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [schedule, setScheduleState] = useState<PlaywrightScheduleConfig | null>(null);
  const [scheduleInterval, setScheduleInterval] = useState('60');
  const [scheduleMode, setScheduleMode] = useState<PlaywrightRunMode>('headless');
  const [scheduleEnabled, setScheduleEnabled] = useState(false);
  const [captureProgress, setCaptureProgress] = useState<CaptureProgress | null>(null);

  const refresh = useCallback(async () => {
    if (!window.playwright) {
      setError('Playwright 桥接不可用，请在 Electron 窗口中打开。');
      return;
    }
    const [nextStatus, nextList, nextSchedule] = await Promise.all([
      window.playwright.getStatus(),
      window.playwright.listWorkflows(),
      window.playwright.getSchedule(),
    ]);
    setStatus(nextStatus);
    setList(nextList);
    setScheduleState(nextSchedule);
    setScheduleInterval(String(nextSchedule.intervalMinutes));
    setScheduleMode(nextSchedule.mode);
    setScheduleEnabled(nextSchedule.enabled);
    setSelectedIds((prev) => prev.filter((id) => nextList.some((item) => item.id === id)));
  }, []);

  const refreshArtifacts = useCallback(async (workflowId: string) => {
    if (!workflowId || !window.playwright) {
      setArtifacts([]);
      return;
    }
    try {
      const next = await window.playwright.listArtifacts(workflowId);
      setArtifacts(next);
    } catch {
      setArtifacts([]);
    }
  }, []);

  const resolveSlowMoMs = useCallback((item?: PlaywrightWorkflowDetail | null): number => {
    if (typeof item?.slowMoMs === 'number' && Number.isFinite(item.slowMoMs) && item.slowMoMs >= 0) {
      return Math.round(item.slowMoMs);
    }
    return PLAYWRIGHT_DEFAULT_SLOW_MO_MS;
  }, []);

  const openDetail = useCallback(async (id: string): Promise<PlaywrightWorkflowDetail> => {
    const item = await window.playwright.getWorkflow(id);
    setSelectedId(id);
    setDetail(item);
    setScriptDraft(item.script);
    setNameDraft(item.name);
    setNotesDraft(item.notes || '');
    setPlayBrowser(item.browser);
    setSlowMo(String(resolveSlowMoMs(item)));
    setTab('detail');
    await refreshArtifacts(id);
    return item;
  }, [refreshArtifacts, resolveSlowMoMs]);

  useEffect(() => {
    void refresh().catch((err) => {
      setError(err instanceof Error ? err.message : '加载失败');
    });
  }, [refresh]);

  useEffect(() => {
    if (!window.playwright) return undefined;
    return window.playwright.onRunEvent((event: PlaywrightRunEvent) => {
      setLivePhase(event.phase);
      if (event.line) {
        setLogLines((prev) => [...prev.slice(-400), event.line!]);
      } else if (event.message) {
        setLogLines((prev) => [...prev.slice(-400), `[${event.phase}] ${event.message}`]);
      }
      if (event.artifacts && event.workflowId === selectedId) {
        setArtifacts(event.artifacts);
      }

      setCaptureProgress((prev) => {
        if (!prev || prev.phase !== 'running') return prev;
        if (selectedId && event.workflowId !== selectedId) return prev;
        return {
          ...prev,
          phase: event.phase,
          percent: Math.max(0, Math.min(100, Math.round(event.percent))),
          message: event.message || prev.message,
        };
      });

      // Avoid hammering list refresh on capture percent ticks.
      const captureTicking = event.phase === 'running'
        && event.percent > 8
        && event.percent < 100
        && !event.line;
      if (!captureTicking) {
        void refresh();
      }
      if (event.workflowId === selectedId && (event.phase === 'passed' || event.phase === 'failed' || event.phase === 'stopped')) {
        void openDetail(event.workflowId).catch(() => undefined);
      }
    });
  }, [openDetail, refresh, selectedId]);

  useEffect(() => {
    if (!captureProgress || (captureProgress.phase !== 'passed' && captureProgress.phase !== 'failed')) {
      return undefined;
    }
    const timer = window.setTimeout(() => {
      setCaptureProgress((prev) => (
        prev && (prev.phase === 'passed' || prev.phase === 'failed') ? null : prev
      ));
    }, captureProgress.phase === 'passed' ? 2800 : 4200);
    return () => window.clearTimeout(timer);
  }, [captureProgress]);

  const authSources = useMemo(
    () => list.filter((item) => item.hasAuth),
    [list],
  );

  const jobLocked = Boolean(status?.activeJob) || busy;

  async function handleInstall(): Promise<void> {
    setBusy(true);
    setError('');
    try {
      const result = await window.playwright.installBrowsers();
      if (!result.ok) {
        setError(result.message);
      } else {
        setLogLines((prev) => [...prev, result.message]);
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : '安装失败');
    } finally {
      setBusy(false);
    }
  }

  async function handleRecord(): Promise<void> {
    setBusy(true);
    setError('');
    setLogLines([`开始录制：${url}`]);
    setLivePhase('recording');
    try {
      const created = await window.playwright.startRecord({
        name,
        url,
        browser,
        device,
        saveAuth,
        loadAuthFromId: loadAuthFromId || undefined,
        usePersistentProfile,
        slowMoMs: PLAYWRIGHT_DEFAULT_SLOW_MO_MS,
        notes,
      });
      setSelectedId(created.id);
      setDetail(created);
      setScriptDraft(created.script);
      setNameDraft(created.name);
      setNotesDraft(created.notes || '');
      setPlayBrowser(created.browser);
      setSlowMo(String(resolveSlowMoMs(created)));
      await refresh();
      setTab('detail');
    } catch (err) {
      setError(err instanceof Error ? err.message : '录制启动失败');
      setLivePhase('failed');
    } finally {
      setBusy(false);
    }
  }

  async function handlePlay(
    workflowId = selectedId,
    options?: { slowMoMs?: number; browser?: PlaywrightBrowser },
  ): Promise<void> {
    if (!workflowId) return;
    setBusy(true);
    setError('');
    const browser = options?.browser || playBrowser;
    setLogLines([`开始回放：${workflowId} · ${playMode} · ${browserLabel(browser)}`]);
    setLivePhase('running');
    try {
      const parsed = options?.slowMoMs ?? Number(slowMo);
      const slowMoMs = Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : PLAYWRIGHT_DEFAULT_SLOW_MO_MS;
      setSlowMo(String(slowMoMs));
      setPlayBrowser(browser);
      await window.playwright.play({
        id: workflowId,
        mode: playMode,
        browser,
        slowMoMs,
      });
      // Keep detail in sync with persisted preference written by playWorkflow.
      if (selectedId === workflowId) {
        setDetail((prev) => (prev ? { ...prev, slowMoMs, browser } : prev));
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : '回放启动失败');
      setLivePhase('failed');
    } finally {
      setBusy(false);
    }
  }

  async function handleStop(): Promise<void> {
    try {
      await window.playwright.stopJob();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : '停止失败');
    }
  }

  async function handleSaveScript(): Promise<void> {
    if (!selectedId) return;
    setBusy(true);
    setError('');
    try {
      const next = await window.playwright.updateWorkflow({
        id: selectedId,
        name: nameDraft,
        notes: notesDraft,
        script: scriptDraft,
      });
      setDetail(next);
      await refresh();
      setLogLines((prev) => [...prev, '脚本已保存']);
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败');
    } finally {
      setBusy(false);
    }
  }

  async function handleCopyLog(): Promise<void> {
    const text = logLines.join('\n').trim();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setLogCopied(true);
      window.setTimeout(() => setLogCopied(false), 1600);
    } catch {
      setError('复制日志失败，请手动选择复制。');
    }
  }

  async function handleDelete(id: string): Promise<void> {
    if (!window.confirm('确定删除这个工作流？脚本与登录态都会移除。')) {
      return;
    }
    setBusy(true);
    setError('');
    try {
      await window.playwright.deleteWorkflow(id);
      if (selectedId === id) {
        setSelectedId('');
        setDetail(null);
        setTab('workflows');
      }
      setSelectedIds((prev) => prev.filter((item) => item !== id));
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除失败');
    } finally {
      setBusy(false);
    }
  }

  function toggleSelected(id: string): void {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]));
  }

  async function handleBatchPlay(): Promise<void> {
    if (selectedIds.length === 0) {
      setError('请先勾选要批量回放的工作流。');
      return;
    }
    setBusy(true);
    setError('');
    setLogLines([`批量回放：${selectedIds.length} 条 · ${playMode}`]);
    setLivePhase('running');
    try {
      const parsed = Number(slowMo);
      const slowMoMs = Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : PLAYWRIGHT_DEFAULT_SLOW_MO_MS;
      const result = await window.playwright.playBatch({
        ids: selectedIds,
        mode: playMode === 'ui' || playMode === 'debug' ? 'headless' : playMode,
        browser: playBrowser,
        slowMoMs,
      });
      const lines = result.results.map((item) => `${item.id.slice(0, 8)}… ${item.phase}: ${item.message}`);
      setLogLines((prev) => [...prev, ...lines]);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : '批量回放失败');
      setLivePhase('failed');
    } finally {
      setBusy(false);
    }
  }

  async function handleInjectAsserts(templates: PlaywrightAssertTemplate[] = ['all']): Promise<void> {
    if (!selectedId) return;
    setBusy(true);
    setError('');
    try {
      const next = await window.playwright.injectAsserts({ id: selectedId, templates });
      setDetail(next);
      setScriptDraft(next.script);
      setLogLines((prev) => [...prev, `已插入断言：${templates.join(', ')}`]);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : '插入断言失败');
    } finally {
      setBusy(false);
    }
  }

  async function handleDeleteArtifact(item: PlaywrightArtifact): Promise<void> {
    const label = `${artifactKindLabel(item.kind)} · ${item.name}`;
    if (!window.confirm(`确定删除产物？\n${label}`)) {
      return;
    }
    setError('');
    try {
      await window.playwright.deleteArtifact(item.path);
      setArtifacts((prev) => prev.filter((entry) => entry.path !== item.path));
      setLogLines((prev) => [...prev, `已删除产物：${item.name}`]);
      await refresh();
      if (selectedId) {
        await refreshArtifacts(selectedId);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除产物失败');
    }
  }

  async function handleCapture(kind: CaptureKind): Promise<void> {
    if (!selectedId) return;
    setBusy(true);
    setError('');
    setLivePhase('running');
    setCaptureProgress({
      kind,
      phase: 'running',
      percent: 4,
      message: kind === 'pdf' ? '准备导出 PDF…' : '准备截图…',
    });
    setLogLines((prev) => [...prev, kind === 'pdf' ? '开始导出 PDF…' : '开始截图…']);
    try {
      const result = await window.playwright.capturePage({ id: selectedId, kind, fullPage: true });
      setDetail(result.workflow);
      setArtifacts(result.artifacts);
      setLogLines((prev) => [...prev, result.workflow.lastRunMessage || '采集完成']);
      setLivePhase('passed');
      setCaptureProgress({
        kind,
        phase: 'passed',
        percent: 100,
        message: result.workflow.lastRunMessage || (kind === 'pdf' ? 'PDF 已就绪' : '截图已就绪'),
      });
      await refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : '采集失败';
      setError(message);
      setLivePhase('failed');
      setCaptureProgress((prev) => ({
        kind,
        phase: 'failed',
        percent: prev?.percent || 0,
        message,
      }));
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveSchedule(): Promise<void> {
    setBusy(true);
    setError('');
    try {
      const intervalMinutes = Math.max(1, Math.round(Number(scheduleInterval)) || 60);
      const ids = selectedIds.length > 0
        ? selectedIds
        : (schedule?.workflowIds || []);
      const next = await window.playwright.setSchedule({
        enabled: scheduleEnabled,
        intervalMinutes,
        mode: scheduleMode === 'ui' || scheduleMode === 'debug' ? 'headless' : scheduleMode,
        workflowIds: ids,
        slowMoMs: 0,
      });
      setScheduleState(next);
      setScheduleInterval(String(next.intervalMinutes));
      setScheduleMode(next.mode);
      setScheduleEnabled(next.enabled);
      if (ids.length > 0) {
        setSelectedIds(ids);
      }
      setLogLines((prev) => [...prev, next.lastMessage || '定时配置已保存']);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存定时失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="pw-studio">
      <aside className="pw-rail">
        <div className="pw-brand">
          <div className="pw-brand-mark">P</div>
          <div>
            <strong>Playwright Studio</strong>
            <em>录制 · 断言 · 回放</em>
          </div>
        </div>
        <nav className="pw-nav">
          <button type="button" className={tab === 'workflows' ? 'active' : ''} onClick={() => setTab('workflows')}>
            工作流
          </button>
          <button type="button" className={tab === 'record' ? 'active' : ''} onClick={() => setTab('record')}>
            新建录制
          </button>
          <button
            type="button"
            className={tab === 'detail' ? 'active' : ''}
            disabled={!detail}
            onClick={() => setTab('detail')}
          >
            详情 / 执行
          </button>
          <button type="button" className={tab === 'schedule' ? 'active' : ''} onClick={() => setTab('schedule')}>
            批量 / 定时
          </button>
        </nav>
        <div className="pw-rail-meta">
          <span className={`pw-pill phase-${livePhase}`}>{phaseLabel(livePhase)}</span>
          <button type="button" className="btn-secondary" onClick={onBack}>返回 MediaDo</button>
        </div>
      </aside>

      <div className="pw-body">
        <header className="pw-top">
          <div className="pw-top-copy">
            <h1>
              {tab === 'workflows'
                ? '工作流管理'
                : tab === 'record'
                  ? '录制新流程'
                  : tab === 'schedule'
                    ? '批量与定时'
                    : '脚本与执行'}
            </h1>
            <p className="subtitle">
              {tab === 'schedule'
                ? '勾选多条工作流批量回放，或按间隔自动跑一遍'
                : '浏览器里操作 → Codegen 生成脚本 → 断言 / 截图 / 回放'}
            </p>
          </div>
          <div className="pw-top-actions">
            <button type="button" className="pw-tool-btn" disabled={busy} onClick={() => { void handleInstall(); }}>
              安装浏览器
            </button>
            <button type="button" className="pw-tool-btn" disabled={busy} onClick={() => { void window.playwright.revealStudioRoot(); }}>
              打开目录
            </button>
            {status?.activeJob ? (
              <button type="button" className="pw-tool-btn is-danger" onClick={() => { void handleStop(); }}>
                停止任务
              </button>
            ) : null}
          </div>
        </header>

        {status ? (
          <div className="pw-status-bar">
            <span className={status.playwrightReady ? 'is-ok' : 'is-warn'}>
              {status.playwrightReady ? 'Playwright 已就绪' : '未检测到 Playwright'}
            </span>
            <span className="pw-status-sep" aria-hidden>·</span>
            <span className="pw-status-path" title={`${status.rootDir}\n${status.browsersHint}`}>
              {status.browsersHint}
            </span>
            {status.activeJob ? (
              <>
                <span className="pw-status-sep" aria-hidden>·</span>
                <span>进行中：{jobKindLabel(status.activeJob.kind)}</span>
              </>
            ) : null}
            {status.schedule?.enabled ? (
              <>
                <span className="pw-status-sep" aria-hidden>·</span>
                <span title={status.schedule.lastMessage || ''}>
                  定时每 {status.schedule.intervalMinutes} 分
                  {status.schedule.nextRunAt ? ` · 下次 ${formatTime(status.schedule.nextRunAt)}` : ''}
                </span>
              </>
            ) : null}
          </div>
        ) : null}

        {error ? <p className="banner">{error}</p> : null}

        {tab === 'workflows' ? (
          <section className="pw-panel">
            <div className="pw-panel-head">
              <div>
                <h2>已保存的工作流</h2>
                <p className="pw-panel-sub">{list.length ? `${list.length} 条` : '暂无记录'}</p>
              </div>
              {list.length > 0 ? (
                <div className="pw-panel-actions">
                  <button
                    type="button"
                    className="pw-inline-cta"
                    disabled={jobLocked || selectedIds.length === 0}
                    onClick={() => { void handleBatchPlay(); }}
                  >
                    批量回放{selectedIds.length ? ` (${selectedIds.length})` : ''}
                  </button>
                  <button type="button" className="pw-inline-cta" onClick={() => setTab('record')}>
                    新建录制
                  </button>
                </div>
              ) : null}
            </div>
            {list.length === 0 ? (
              <div className="pw-empty">
                <strong>还没有工作流</strong>
                <p>用 Codegen 录一条操作路径，之后可反复回放。可先试 TodoMVC。</p>
                <button type="button" className="btn-primary" onClick={() => setTab('record')}>
                  新建录制
                </button>
              </div>
            ) : (
              <div className="pw-table">
                {list.map((item) => (
                  <article key={item.id} className={`pw-row${selectedIds.includes(item.id) ? ' is-selected' : ''}`}>
                    <label className="pw-row-check">
                      <input
                        type="checkbox"
                        checked={selectedIds.includes(item.id)}
                        disabled={jobLocked}
                        onChange={() => toggleSelected(item.id)}
                      />
                    </label>
                    <div className="pw-row-main">
                      <strong>{item.name}</strong>
                      <p>{item.url}</p>
                      <div className="pw-tags">
                        <span>{browserLabel(item.browser)}</span>
                        {item.device ? <span>{item.device}</span> : null}
                        {item.hasAuth ? <span>含登录态</span> : null}
                        {item.usePersistentProfile ? <span>持久目录</span> : null}
                        {item.lastArtifactCount ? <span>产物 {item.lastArtifactCount}</span> : null}
                        <span className={`phase-${item.lastRunStatus || 'idle'}`}>{phaseLabel(item.lastRunStatus)}</span>
                      </div>
                    </div>
                    <div className="pw-row-meta">
                      <span>更新 {formatTime(item.updatedAt)}</span>
                      <span>{item.lastRunMessage || '尚未执行'}</span>
                    </div>
                    <div className="pw-row-actions">
                      <button type="button" className="pw-row-btn" onClick={() => { void openDetail(item.id); }}>
                        打开
                      </button>
                      <button
                        type="button"
                        className="pw-row-btn is-primary"
                        disabled={jobLocked}
                        onClick={() => {
                          void openDetail(item.id).then((workflow) => (
                            handlePlay(workflow.id, {
                              slowMoMs: resolveSlowMoMs(workflow),
                              browser: workflow.browser,
                            })
                          ));
                        }}
                      >
                        回放
                      </button>
                      <button
                        type="button"
                        className="pw-row-btn is-danger"
                        disabled={jobLocked}
                        onClick={() => { void handleDelete(item.id); }}
                      >
                        删除
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>
        ) : null}

        {tab === 'record' ? (
          <section className="pw-panel pw-form-panel">
            <div className="pw-form-grid">
              <label className="field">
                名称
                <input value={name} disabled={jobLocked} onChange={(e) => setName(e.target.value)} placeholder="登录后创建任务" />
              </label>
              <label className="field">
                起始 URL
                <input value={url} disabled={jobLocked} onChange={(e) => setUrl(e.target.value)} placeholder="https://" />
              </label>
              <label className="field">
                浏览器
                <select value={browser} disabled={jobLocked} onChange={(e) => setBrowser(e.target.value as PlaywrightBrowser)}>
                  {PLAYWRIGHT_BROWSERS.map((item) => (
                    <option key={item} value={item}>{browserLabel(item)}</option>
                  ))}
                </select>
              </label>
              <label className="field">
                设备模拟
                <select value={device} disabled={jobLocked} onChange={(e) => setDevice(e.target.value)}>
                  {PLAYWRIGHT_DEVICES.map((item) => (
                    <option key={item || 'desktop'} value={item}>{item || '桌面（默认）'}</option>
                  ))}
                </select>
              </label>
            </div>

            <div className="pw-auth-block">
              <div className="pw-auth-head">
                <strong>登录与会话</strong>
                <span>决定录制窗口是否记住登录，以及回放能否带上 Cookie</span>
              </div>
              <label className="field">
                加载已有登录态
                <select value={loadAuthFromId} disabled={jobLocked} onChange={(e) => setLoadAuthFromId(e.target.value)}>
                  <option value="">不使用</option>
                  {authSources.map((item) => (
                    <option key={item.id} value={item.id}>{item.name}</option>
                  ))}
                </select>
              </label>
              <div className="pw-option-grid">
                <label className={`pw-option-card${usePersistentProfile ? ' is-on' : ''}${jobLocked ? ' is-disabled' : ''}`}>
                  <input
                    type="checkbox"
                    checked={usePersistentProfile}
                    disabled={jobLocked}
                    onChange={(e) => setUsePersistentProfile(e.target.checked)}
                  />
                  <span className="pw-option-body">
                    <span className="pw-option-title">
                      复用持久登录目录
                      <em>推荐</em>
                    </span>
                    <span className="pw-option-desc">
                      同一浏览器下次录制自动带登录。Studio 专用目录，不是日常 Chrome 窗口
                      {status?.persistentProfilesDir ? ` · ${browser}` : ''}
                    </span>
                  </span>
                </label>
                <label className={`pw-option-card${saveAuth ? ' is-on' : ''}${jobLocked ? ' is-disabled' : ''}`}>
                  <input
                    type="checkbox"
                    checked={saveAuth}
                    disabled={jobLocked}
                    onChange={(e) => setSaveAuth(e.target.checked)}
                  />
                  <span className="pw-option-body">
                    <span className="pw-option-title">录制结束时保存登录态</span>
                    <span className="pw-option-desc">
                      导出 storageState，供无痕回放复用 Cookie
                    </span>
                  </span>
                </label>
              </div>
            </div>

            <div className="pw-form-grid">
              <label className="field field-span">
                备注
                <textarea value={notes} disabled={jobLocked} onChange={(e) => setNotes(e.target.value)} rows={3} placeholder="这条流程做什么、账号注意点…" />
              </label>
            </div>
            <div className="pw-form-actions">
              <button type="button" className="btn-primary" disabled={jobLocked} onClick={() => { void handleRecord(); }}>
                {busy ? '启动中…' : '开始录制'}
              </button>
              <p className="hint">
                开始后会打开浏览器与 Playwright Inspector；操作完成后关闭录制窗口即可写入脚本。
              </p>
            </div>
          </section>
        ) : null}

        {tab === 'detail' && detail ? (
          <section className="pw-detail">
            <div className="pw-detail-main">
              <div className="pw-form-grid compact">
                <label className="field">
                  名称
                  <input value={nameDraft} disabled={jobLocked} onChange={(e) => setNameDraft(e.target.value)} />
                </label>
                <label className="field">
                  URL
                  <input value={detail.url} readOnly />
                </label>
                <label className="field field-span">
                  备注
                  <textarea value={notesDraft} disabled={jobLocked} onChange={(e) => setNotesDraft(e.target.value)} rows={2} />
                </label>
              </div>
              <label className="field">
                脚本（{detail.fileName}）
                <textarea
                  className="pw-script"
                  value={scriptDraft}
                  disabled={jobLocked}
                  onChange={(e) => setScriptDraft(e.target.value)}
                  spellCheck={false}
                />
              </label>
              <div className="pw-form-actions">
                <button type="button" className="btn-primary" disabled={jobLocked} onClick={() => { void handleSaveScript(); }}>
                  保存脚本
                </button>
                <button type="button" className="btn-secondary" onClick={() => { void window.playwright.openWorkflowFolder(detail.id); }}>
                  打开文件夹
                </button>
              </div>
              <div className="pw-assert-bar">
                <span>断言助手</span>
                <button type="button" className="pw-row-btn" disabled={jobLocked} onClick={() => { void handleInjectAsserts(['url']); }}>
                  URL
                </button>
                <button type="button" className="pw-row-btn" disabled={jobLocked} onClick={() => { void handleInjectAsserts(['title']); }}>
                  Title
                </button>
                <button type="button" className="pw-row-btn" disabled={jobLocked} onClick={() => { void handleInjectAsserts(['body']); }}>
                  Body
                </button>
                <button type="button" className="pw-row-btn is-primary" disabled={jobLocked} onClick={() => { void handleInjectAsserts(['all']); }}>
                  全部插入
                </button>
              </div>
            </div>

            <aside className="pw-detail-side">
              <div className="side-block">
                <h3>回放</h3>
                <label className="field">
                  浏览器
                  <select
                    value={playBrowser}
                    disabled={jobLocked}
                    onChange={(e) => setPlayBrowser(e.target.value as PlaywrightBrowser)}
                  >
                    {PLAYWRIGHT_BROWSERS.map((item) => (
                      <option key={item} value={item}>{browserLabel(item)}</option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  模式
                  <select value={playMode} disabled={jobLocked} onChange={(e) => setPlayMode(e.target.value as PlaywrightRunMode)}>
                    {PLAYWRIGHT_RUN_MODES.map((mode) => (
                      <option key={mode} value={mode}>{modeLabel(mode)}</option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  放慢 (ms)
                  <input type="number" min={0} step={100} value={slowMo} disabled={jobLocked} onChange={(e) => setSlowMo(e.target.value)} />
                </label>
                <button type="button" className="btn-primary" disabled={jobLocked} onClick={() => { void handlePlay(); }}>
                  执行回放
                </button>
                <p className="hint">
                  选「本机 Chrome / Edge」走系统浏览器，无需再装 Playwright Chromium。
                  放慢默认沿用录制值（通常 {PLAYWRIGHT_DEFAULT_SLOW_MO_MS}ms）；执行后会记住浏览器与放慢设置。
                </p>
              </div>
              <div className="side-block">
                <h3>页面采集</h3>
                <div className="pw-capture-actions">
                  <button type="button" className="btn-secondary" disabled={jobLocked} onClick={() => { void handleCapture('screenshot'); }}>
                    截图
                  </button>
                  <button type="button" className="btn-secondary" disabled={jobLocked} onClick={() => { void handleCapture('pdf'); }}>
                    导出 PDF
                  </button>
                </div>
                {captureProgress ? (
                  <div
                    className={`pw-capture-progress is-${captureProgress.phase}`}
                    role="status"
                    aria-live="polite"
                    aria-busy={captureProgress.phase === 'running'}
                  >
                    <div className="pw-capture-progress-head">
                      <div>
                        <strong>{captureKindLabel(captureProgress.kind)}</strong>
                        <span>
                          {captureProgress.phase === 'passed'
                            ? '完成'
                            : captureProgress.phase === 'failed'
                              ? '失败'
                              : '进行中'}
                        </span>
                      </div>
                      <em>{Math.round(captureProgress.percent)}%</em>
                    </div>
                    <div className="pw-capture-track" aria-hidden>
                      <div
                        className="pw-capture-fill"
                        style={{ width: `${Math.max(4, Math.min(100, captureProgress.percent))}%` }}
                      />
                    </div>
                    <ol className="pw-capture-steps">
                      {CAPTURE_STEPS.map((step, index) => {
                        const state = captureStepState(step.minPercent, captureProgress, index);
                        const label = step.id === 'capture'
                          ? (captureProgress.kind === 'pdf' ? 'PDF' : '截图')
                          : step.shortLabel;
                        return (
                          <li key={step.id} className={`is-${state}`} title={step.label}>
                            <i />
                            <span>{label}</span>
                          </li>
                        );
                      })}
                    </ol>
                    <p className="pw-capture-msg">{captureProgress.message}</p>
                  </div>
                ) : (
                  <p className="hint">打开起始 URL 采集，结果归档到产物面板。PDF 仅 Chromium / Chrome / Edge。</p>
                )}
              </div>
              <div className="side-block">
                <h3>元信息</h3>
                <dl className="pw-meta-list">
                  <div><dt>浏览器</dt><dd>{browserLabel(playBrowser)}</dd></div>
                  <div><dt>设备</dt><dd>{detail.device || '桌面'}</dd></div>
                  <div><dt>放慢</dt><dd>{resolveSlowMoMs(detail)} ms</dd></div>
                  <div><dt>登录态</dt><dd>{detail.hasAuth ? '已保存' : '无'}</dd></div>
                  <div><dt>最近执行</dt><dd>{formatTime(detail.lastRunAt)}</dd></div>
                  <div><dt>状态</dt><dd>{phaseLabel(detail.lastRunStatus)}</dd></div>
                </dl>
              </div>
              <div className="side-block">
                <div className="pw-log-head">
                  <h3>产物</h3>
                  <button
                    type="button"
                    className="pw-tool-btn"
                    onClick={() => { void window.playwright.openArtifactsFolder(detail.id); }}
                  >
                    打开目录
                  </button>
                </div>
                {artifacts.length === 0 ? (
                  <p className="hint">失败回放会保留 Trace / 视频 / 截图；也可主动截图或导出 PDF。</p>
                ) : (
                  <div className="pw-artifact-list">
                    {artifacts.map((item) => (
                      <article key={item.path} className="pw-artifact-row">
                        <div>
                          <strong>{artifactKindLabel(item.kind)}</strong>
                          <span>{item.name}</span>
                          <em>{formatBytes(item.size)} · {formatTime(item.mtime)}</em>
                        </div>
                        <div className="pw-artifact-actions">
                          {item.kind === 'trace' ? (
                            <button
                              type="button"
                              className="pw-row-btn is-primary"
                              onClick={() => {
                                void window.playwright.openTrace(item.path).catch((err) => {
                                  setError(err instanceof Error ? err.message : '打开 Trace 失败');
                                });
                              }}
                            >
                              打开 Trace
                            </button>
                          ) : null}
                          <button
                            type="button"
                            className="pw-row-btn"
                            onClick={() => {
                              void window.playwright.revealArtifact(item.path).catch((err) => {
                                setError(err instanceof Error ? err.message : '定位文件失败');
                              });
                            }}
                          >
                            定位
                          </button>
                          <button
                            type="button"
                            className="pw-row-btn is-danger"
                            disabled={jobLocked}
                            onClick={() => { void handleDeleteArtifact(item); }}
                          >
                            删除
                          </button>
                        </div>
                      </article>
                    ))}
                  </div>
                )}
              </div>
              <div className="side-block">
                <div className="pw-log-head">
                  <h3>运行日志</h3>
                  <button
                    type="button"
                    className="pw-tool-btn"
                    disabled={!logLines.length}
                    onClick={() => { void handleCopyLog(); }}
                  >
                    {logCopied ? '已复制' : '复制'}
                  </button>
                </div>
                <pre className="pw-log">{logLines.length ? logLines.join('\n') : '尚无输出'}</pre>
              </div>
            </aside>
          </section>
        ) : null}

        {tab === 'detail' && !detail ? (
          <div className="empty-state">
            <p>请先从工作流列表打开一条记录。</p>
          </div>
        ) : null}

        {tab === 'schedule' ? (
          <section className="pw-panel pw-form-panel">
            <div className="pw-auth-head">
              <strong>批量回放</strong>
              <span>在工作流列表勾选后，可从这里或列表顶部一键顺序执行</span>
            </div>
            <div className="pw-form-grid">
              <label className="field">
                浏览器
                <select
                  value={playBrowser}
                  disabled={jobLocked}
                  onChange={(e) => setPlayBrowser(e.target.value as PlaywrightBrowser)}
                >
                  {PLAYWRIGHT_BROWSERS.map((item) => (
                    <option key={item} value={item}>{browserLabel(item)}</option>
                  ))}
                </select>
              </label>
              <label className="field">
                回放模式
                <select value={playMode} disabled={jobLocked} onChange={(e) => setPlayMode(e.target.value as PlaywrightRunMode)}>
                  {PLAYWRIGHT_RUN_MODES.map((mode) => (
                    <option key={mode} value={mode}>{modeLabel(mode)}</option>
                  ))}
                </select>
              </label>
              <label className="field">
                已选工作流
                <input readOnly value={selectedIds.length ? `${selectedIds.length} 条` : '尚未勾选'} />
              </label>
            </div>
            <div className="pw-form-actions">
              <button type="button" className="btn-primary" disabled={jobLocked || selectedIds.length === 0} onClick={() => { void handleBatchPlay(); }}>
                立即批量回放
              </button>
              <button type="button" className="btn-secondary" onClick={() => setTab('workflows')}>
                去勾选工作流
              </button>
            </div>

            <div className="pw-auth-block" style={{ marginTop: 24 }}>
              <div className="pw-auth-head">
                <strong>简易定时</strong>
                <span>按间隔分钟自动批量回放已选工作流（无头优先）</span>
              </div>
              <div className="pw-form-grid">
                <label className="field">
                  间隔（分钟）
                  <input
                    type="number"
                    min={1}
                    step={1}
                    value={scheduleInterval}
                    disabled={jobLocked}
                    onChange={(e) => setScheduleInterval(e.target.value)}
                  />
                </label>
                <label className="field">
                  定时模式
                  <select
                    value={scheduleMode}
                    disabled={jobLocked}
                    onChange={(e) => setScheduleMode(e.target.value as PlaywrightRunMode)}
                  >
                    <option value="headless">{modeLabel('headless')}</option>
                    <option value="headed">{modeLabel('headed')}</option>
                  </select>
                </label>
              </div>
              <label className={`pw-option-card${scheduleEnabled ? ' is-on' : ''}${jobLocked ? ' is-disabled' : ''}`}>
                <input
                  type="checkbox"
                  checked={scheduleEnabled}
                  disabled={jobLocked}
                  onChange={(e) => setScheduleEnabled(e.target.checked)}
                />
                <span className="pw-option-body">
                  <span className="pw-option-title">启用定时回放</span>
                  <span className="pw-option-desc">
                    使用当前勾选（或已保存的定时列表）。应用保持运行时才会触发。
                  </span>
                </span>
              </label>
              {schedule ? (
                <dl className="pw-meta-list" style={{ marginTop: 12 }}>
                  <div><dt>上次</dt><dd>{formatTime(schedule.lastRunAt)}</dd></div>
                  <div><dt>下次</dt><dd>{formatTime(schedule.nextRunAt)}</dd></div>
                  <div><dt>说明</dt><dd>{schedule.lastMessage || '—'}</dd></div>
                  <div>
                    <dt>工作流</dt>
                    <dd>
                      {(schedule.workflowIds.length ? schedule.workflowIds : selectedIds)
                        .map((id) => list.find((item) => item.id === id)?.name || id.slice(0, 8))
                        .join('、') || '—'}
                    </dd>
                  </div>
                </dl>
              ) : null}
              <div className="pw-form-actions">
                <button type="button" className="btn-primary" disabled={jobLocked} onClick={() => { void handleSaveSchedule(); }}>
                  保存定时配置
                </button>
              </div>
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}
