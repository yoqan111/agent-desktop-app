import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactElement } from 'react';
import type {
  PlaywrightArtifact,
  PlaywrightArtifactKind,
  PlaywrightAssertTemplate,
  PlaywrightAuthBeforePlay,
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
  PLAYWRIGHT_ANALYZE_MODES,
  PLAYWRIGHT_AUTH_BEFORE_PLAY,
  PLAYWRIGHT_BROWSERS,
  PLAYWRIGHT_DEFAULT_SLOW_MO_MS,
  PLAYWRIGHT_DEVICES,
  PLAYWRIGHT_RUN_MODES,
  type PlaywrightAnalyzeMode,
} from '../../shared/playwright';
import type { AgentAnalyzeMode } from '../../shared/agent';
import { askConfirm } from '../confirm';
import { AgentChatPanel } from './AgentChatPanel';
import { FloatingNotice } from './FloatingNotice';
import { PwSelect } from './PwSelect';
import { ResizeHandle } from './ResizeHandle';

function readPaneWidth(key: string, fallback: number): number {
  try {
    const raw = window.localStorage.getItem(key);
    const value = raw ? Number(raw) : fallback;
    return Number.isFinite(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

function storePaneWidth(key: string, value: number, min: number, max: number): number {
  const next = Math.round(Math.min(max, Math.max(min, value)));
  try {
    window.localStorage.setItem(key, String(next));
  } catch {
    // ignore
  }
  return next;
}

type StudioTab = 'workflows' | 'record' | 'detail' | 'schedule' | 'agent';

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

function authBeforePlayLabel(policy?: PlaywrightAuthBeforePlay): string {
  if (policy === 'always') return '每次回放前';
  if (policy === 'off') return '关闭';
  return '缺少登录态时';
}

function artifactKindLabel(kind: PlaywrightArtifactKind): string {
  if (kind === 'trace') return 'Trace';
  if (kind === 'video') return '视频';
  if (kind === 'screenshot') return '截图';
  if (kind === 'pdf') return 'PDF';
  if (kind === 'har') return 'HAR';
  if (kind === 'report') return '报告';
  if (kind === 'baseline') return '基线';
  return '其他';
}

function analyzeModeLabel(mode: PlaywrightAnalyzeMode | AgentAnalyzeMode): string {
  if (mode === 'test-enhance') return '智能测试增强';
  if (mode === 'business-doc') return '业务理解与文档';
  if (mode === 'anomaly') return '基线异常分析';
  return '综合分析';
}

function jobKindLabel(kind?: string): string {
  if (kind === 'record') return '录制';
  if (kind === 'batch') return '批量回放';
  if (kind === 'capture') return '页面采集';
  if (kind === 'play') return '回放';
  return '任务';
}

function studioTabTitle(tab: StudioTab): string {
  switch (tab) {
    case 'workflows': return '工作流管理';
    case 'record': return '录制新流程';
    case 'schedule': return '批量与定时';
    case 'agent': return 'Agent 分析';
    default: return '详情与回放';
  }
}

function studioTabSubtitle(tab: StudioTab): string {
  switch (tab) {
    case 'workflows':
      return '管理脚本、登录态与产物；支持批量回放和一键 Agent 分析';
    case 'record':
      return 'Codegen 录制脚本；可复用持久登录目录，或加载已有 storageState';
    case 'schedule':
      return '勾选多条工作流批量顺序回放，或按间隔自动执行';
    case 'agent':
      return '基于 PDF / 脚本 / 产物分析页面与断言建议；支持 Cursor 与 OpenAI 兼容模型';
    default:
      return '编辑脚本、配置登录前置、回放执行，并可截图 / 导出 PDF';
  }
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
  const [agentAutoStart, setAgentAutoStart] = useState(false);
  const [agentCapturePdf, setAgentCapturePdf] = useState(true);
  const [agentAnalyzeMode, setAgentAnalyzeMode] = useState<AgentAnalyzeMode>('test-enhance');
  const [agentAnalyzeNote, setAgentAnalyzeNote] = useState('');
  const [agentLaunchKey, setAgentLaunchKey] = useState(0);
  const [recordHar, setRecordHar] = useState(false);
  const [saveBaselineOnPass, setSaveBaselineOnPass] = useState(false);
  const [pendingAgentAnalyze, setPendingAgentAnalyze] = useState<{
    ids: string[];
    name: string;
    capturePdf: boolean;
    mode: AgentAnalyzeMode;
    prompt: string;
  } | null>(null);
  const [railWidth, setRailWidth] = useState(() => readPaneWidth('pw-studio-rail', 220));

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

  const openDetail = useCallback(async (
    id: string,
    options?: { tab?: StudioTab },
  ): Promise<PlaywrightWorkflowDetail> => {
    const item = await window.playwright.getWorkflow(id);
    setSelectedId(id);
    setDetail(item);
    setScriptDraft(item.script);
    setNameDraft(item.name);
    setNotesDraft(item.notes || '');
    setPlayBrowser(item.browser);
    setSlowMo(String(resolveSlowMoMs(item)));
    setTab(options?.tab || 'detail');
    await refreshArtifacts(id);
    return item;
  }, [refreshArtifacts, resolveSlowMoMs]);

  useEffect(() => {
    void refresh().catch((err) => {
      setError(err instanceof Error ? err.message : '加载失败');
    });
  }, [refresh]);

  useEffect(() => {
    if (tab !== 'agent') {
      setAgentAutoStart(false);
    }
  }, [tab]);

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
    () => list
      .filter((item) => item.hasAuth)
      .sort((a, b) => {
        const authRank = Number(Boolean(b.isAuthWorkflow)) - Number(Boolean(a.isAuthWorkflow));
        if (authRank !== 0) return authRank;
        return b.updatedAt.localeCompare(a.updatedAt);
      }),
    [list],
  );

  const authSourceOptions = useMemo(
    () => [
      {
        value: '',
        label: '不使用',
        description: authSources.length
          ? '本次录制不注入已有 storageState'
          : '暂无已保存登录态；可先录制并勾选「保存登录态」',
      },
      ...authSources.map((item) => ({
        value: item.id,
        label: `${item.name}${item.isAuthWorkflow ? '（登录流）' : ''}`,
        description: `更新于 ${formatTime(item.updatedAt)}`,
      })),
    ],
    [authSources],
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
        recordHar,
        saveBaseline: saveBaselineOnPass,
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

  async function handleSaveAuthConfig(patch: {
    authWorkflowId?: string | null;
    authBeforePlay?: PlaywrightAuthBeforePlay;
    isAuthWorkflow?: boolean;
  }): Promise<void> {
    if (!selectedId) return;
    setBusy(true);
    setError('');
    try {
      const next = await window.playwright.updateWorkflow({
        id: selectedId,
        ...patch,
      });
      setDetail(next);
      await refresh();
      setLogLines((prev) => [...prev, '登录前置配置已保存']);
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存登录配置失败');
    } finally {
      setBusy(false);
    }
  }

  async function handleRefreshAuthState(): Promise<void> {
    if (!selectedId) return;
    setBusy(true);
    setError('');
    setLivePhase('running');
    setLogLines((prev) => [...prev, '刷新登录态：回放当前工作流并导出 storageState…']);
    try {
      await window.playwright.play({
        id: selectedId,
        mode: playMode === 'ui' || playMode === 'debug' ? 'headed' : playMode,
        browser: playBrowser,
        slowMoMs: Number(slowMo) || PLAYWRIGHT_DEFAULT_SLOW_MO_MS,
        skipAuthPrecondition: true,
        saveAuthAfterPlay: true,
      });
      await refresh();
      if (selectedId) {
        const next = await window.playwright.getWorkflow(selectedId);
        setDetail(next);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '刷新登录态失败');
      setLivePhase('failed');
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
    const ok = await askConfirm({
      title: '确定删除这个工作流？',
      message: '脚本与登录态都会移除。',
      confirmLabel: '删除',
      danger: true,
    });
    if (!ok) return;
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

  async function handleBatchDelete(): Promise<void> {
    if (selectedIds.length === 0) {
      setError('请先勾选要批量删除的工作流。');
      return;
    }
    const count = selectedIds.length;
    const ok = await askConfirm({
      title: `确定删除选中的 ${count} 条工作流？`,
      message: '脚本、登录态与本地产物都会移除，且不可恢复。',
      confirmLabel: `删除 ${count} 条`,
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    setError('');
    setLogLines([`批量删除：${count} 条`]);
    try {
      const ids = [...selectedIds];
      for (const id of ids) {
        await window.playwright.deleteWorkflow(id);
        setLogLines((prev) => [...prev, `已删除 ${id.slice(0, 8)}…`]);
      }
      if (selectedId && ids.includes(selectedId)) {
        setSelectedId('');
        setDetail(null);
        setTab('workflows');
      }
      setSelectedIds([]);
      await refresh();
      setLogLines((prev) => [...prev, `批量删除完成：${count} 条`]);
    } catch (err) {
      setError(err instanceof Error ? err.message : '批量删除失败');
      await refresh();
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
      setLivePhase(
        result.results.some((item) => item.phase === 'failed') ? 'failed' : 'passed',
      );
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
    const ok = await askConfirm({
      title: '确定删除产物？',
      message: label,
      confirmLabel: '删除',
      danger: true,
    });
    if (!ok) return;
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

  function requestAgentAnalyze(
    id: string,
    options?: { capturePdf?: boolean; name?: string; mode?: AgentAnalyzeMode },
  ): void {
    const workflow = list.find((item) => item.id === id);
    const name = options?.name || workflow?.name || detail?.name || '该工作流';
    const mode = options?.mode || 'test-enhance';
    const defaultPrompt = mode === 'business-doc'
      ? `请把工作流「${name}」整理成业务流程文档与用户故事，并保存报告。`
      : mode === 'anomaly'
        ? `请对比工作流「${name}」的基线与最近回放，定位回归原因并给出修复建议。`
        : mode === 'test-enhance'
          ? `请增强工作流「${name}」的可维护性：优化选择器、补全断言，必要时写回脚本并保存测试增强报告。`
          : `请分析工作流「${name}」，给出页面/流程概要、关键断言建议、风险点与后续录制建议。`;
    setPendingAgentAnalyze({
      ids: [id],
      name,
      capturePdf: options?.capturePdf === true,
      mode,
      prompt: defaultPrompt,
    });
  }

  function requestBatchAgentAnalyze(): void {
    if (selectedIds.length === 0) {
      setError('请先勾选要批量分析的工作流。');
      return;
    }
    if (selectedIds.length === 1) {
      const only = selectedIds[0];
      requestAgentAnalyze(only, {
        capturePdf: true,
        name: list.find((item) => item.id === only)?.name,
      });
      return;
    }
    const names = selectedIds
      .map((id) => list.find((item) => item.id === id)?.name || id.slice(0, 8))
      .slice(0, 6);
    const namePreview = names.join('、') + (selectedIds.length > 6 ? '…' : '');
    setPendingAgentAnalyze({
      ids: [...selectedIds],
      name: `${selectedIds.length} 条工作流`,
      capturePdf: false,
      mode: 'test-enhance',
      prompt: `请分别对以下工作流做智能测试增强（${namePreview}）：优化选择器、补全断言建议，并保存报告。`,
    });
  }

  function waitForAgentDone(timeoutMs = 15 * 60 * 1000): {
    promise: Promise<void>;
    cancel: () => void;
  } {
    let off: (() => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const promise = new Promise<void>((resolve, reject) => {
      if (!window.agent) {
        reject(new Error('Agent 桥接不可用。'));
        return;
      }
      timer = setTimeout(() => {
        off?.();
        off = null;
        timer = null;
        reject(new Error('Agent 分析超时。'));
      }, timeoutMs);
      off = window.agent.onEvent((event) => {
        if (event.type !== 'done') return;
        if (timer) clearTimeout(timer);
        timer = null;
        off?.();
        off = null;
        if (event.phase === 'failed' || event.phase === 'cancelled') {
          reject(new Error(event.message || 'Agent 分析未完成'));
          return;
        }
        resolve();
      });
    });
    return {
      promise,
      cancel: () => {
        if (timer) clearTimeout(timer);
        timer = null;
        off?.();
        off = null;
      },
    };
  }

  function confirmAgentAnalyze(): void {
    const pending = pendingAgentAnalyze;
    if (!pending || pending.ids.length === 0) return;
    const prompt = pending.prompt.trim();
    if (!prompt) {
      setError('请先填写会话 Prompt。');
      return;
    }
    setPendingAgentAnalyze(null);

    if (pending.ids.length === 1) {
      setAgentCapturePdf(pending.capturePdf);
      setAgentAnalyzeMode(pending.mode);
      setAgentAnalyzeNote(prompt);
      setAgentLaunchKey((key) => key + 1);
      setAgentAutoStart(true);
      void openDetail(pending.ids[0], { tab: 'agent' }).catch((err) => {
        setError(err instanceof Error ? err.message : '打开工作流失败');
      });
      return;
    }

    void (async () => {
      if (!window.agent) {
        setError('Agent 桥接不可用，请在 Electron 窗口中打开。');
        return;
      }
      setBusy(true);
      setError('');
      setLivePhase('running');
      setAgentAutoStart(false);
      setAgentAnalyzeMode(pending.mode);
      setTab('agent');
      setLogLines([`批量 Agent 分析（${analyzeModeLabel(pending.mode)}）：${pending.ids.length} 条`]);
      let failed = 0;
      try {
        for (let index = 0; index < pending.ids.length; index += 1) {
          const id = pending.ids[index];
          const workflow = list.find((item) => item.id === id);
          const name = workflow?.name || id.slice(0, 8);
          setLogLines((prev) => [...prev, `(${index + 1}/${pending.ids.length}) 开始分析：${name}`]);
          const waiter = waitForAgentDone();
          try {
            const created = await window.agent.createSession({
              workflowId: id,
              workflowName: name,
              title: `${analyzeModeLabel(pending.mode)} · ${name}`,
            });
            await window.agent.analyzeWorkflow({
              workflowId: id,
              capturePdf: pending.capturePdf,
              mode: pending.mode,
              note: prompt,
              chatSessionId: created.id,
            });
            await waiter.promise;
            setLogLines((prev) => [...prev, `(${index + 1}/${pending.ids.length}) 完成：${name}`]);
          } catch (err) {
            waiter.cancel();
            failed += 1;
            const message = err instanceof Error ? err.message : '分析失败';
            setLogLines((prev) => [...prev, `(${index + 1}/${pending.ids.length}) 失败：${name} · ${message}`]);
          }
        }
        setLivePhase(failed > 0 ? 'failed' : 'passed');
        setLogLines((prev) => [
          ...prev,
          failed > 0
            ? `批量 Agent 分析结束：成功 ${pending.ids.length - failed} · 失败 ${failed}`
            : `批量 Agent 分析完成：${pending.ids.length} 条`,
        ]);
        setAgentLaunchKey((key) => key + 1);
      } catch (err) {
        setError(err instanceof Error ? err.message : '批量 Agent 分析失败');
        setLivePhase('failed');
      } finally {
        setBusy(false);
      }
    })();
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

  function resizeRail(delta: number): void {
    setRailWidth((width) => storePaneWidth('pw-studio-rail', width + delta, 160, 420));
  }

  return (
    <div
      className="pw-studio"
      style={{ '--pw-rail-width': `${railWidth}px` } as CSSProperties}
    >
      <aside className="pw-rail">
        <div className="pw-brand">
          <div className="pw-brand-mark">P</div>
          <div>
            <strong>Playwright Studio</strong>
            <em>录制 · 登录 · 回放 · Agent</em>
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
            详情 / 回放
          </button>
          <button type="button" className={tab === 'schedule' ? 'active' : ''} onClick={() => setTab('schedule')}>
            批量 / 定时
          </button>
          <button
            type="button"
            className={tab === 'agent' ? 'active' : ''}
            onClick={() => {
              setAgentAutoStart(false);
              setTab('agent');
            }}
          >
            Agent 分析
          </button>
        </nav>
        <div className="pw-rail-meta">
          <span className={`pw-pill phase-${livePhase}`}>{phaseLabel(livePhase)}</span>
          <button type="button" className="btn-secondary" onClick={onBack}>返回 MediaDo</button>
        </div>
      </aside>

      <ResizeHandle label="调整导航宽度" onResize={resizeRail} />

      <div className="pw-body">
        <header className="pw-top">
          <div className="pw-top-copy">
            <h1>{studioTabTitle(tab)}</h1>
            <p className="subtitle">{studioTabSubtitle(tab)}</p>
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
                  <button
                    type="button"
                    className="pw-inline-cta"
                    disabled={jobLocked || selectedIds.length === 0}
                    onClick={requestBatchAgentAnalyze}
                  >
                    批量 Agent 分析{selectedIds.length ? ` (${selectedIds.length})` : ''}
                  </button>
                  <button
                    type="button"
                    className="pw-inline-cta is-danger"
                    disabled={jobLocked || selectedIds.length === 0}
                    onClick={() => { void handleBatchDelete(); }}
                  >
                    批量删除{selectedIds.length ? ` (${selectedIds.length})` : ''}
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
                <p>
                  用 Codegen 录一条操作路径，之后可回放、保存登录态，并交给 Agent 分析。默认示例为 TodoMVC。
                </p>
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
                        {item.isAuthWorkflow ? <span>登录流</span> : null}
                        {item.authWorkflowId ? <span>有登录前置</span> : null}
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
                        className="pw-row-btn is-primary"
                        disabled={jobLocked}
                        onClick={() => requestAgentAnalyze(item.id, {
                          capturePdf: false,
                          name: item.name,
                          mode: 'test-enhance',
                        })}
                      >
                        Agent 分析
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
                <PwSelect
                  value={browser}
                  disabled={jobLocked}
                  onChange={(next) => setBrowser(next as PlaywrightBrowser)}
                  options={PLAYWRIGHT_BROWSERS.map((item) => ({
                    value: item,
                    label: browserLabel(item),
                  }))}
                />
              </label>
              <label className="field">
                设备模拟
                <PwSelect
                  value={device}
                  disabled={jobLocked}
                  onChange={setDevice}
                  options={PLAYWRIGHT_DEVICES.map((item) => ({
                    value: item,
                    label: item || '桌面（默认）',
                  }))}
                />
              </label>
            </div>

            <div className="pw-auth-block">
              <div className="pw-auth-head">
                <strong>登录与会话</strong>
                <span>控制录制是否免登，以及回放 / 登录前置能否复用 Cookie</span>
              </div>
              <label className="field">
                加载已有登录态
                <PwSelect
                  value={loadAuthFromId}
                  disabled={jobLocked}
                  onChange={setLoadAuthFromId}
                  options={authSourceOptions}
                />
                <span className="hint">
                  {authSources.length
                    ? (loadAuthFromId
                      ? '已选择登录态：录制将优先注入 storageState（此时不会启用持久登录目录）。'
                      : '可选择曾保存过登录态的工作流；若同时勾选「持久登录目录」，以本选项为准。')
                    : '还没有可加载的登录态。请先录制并勾选「录制结束时保存登录态」，或在详情页「刷新登录态」。'}
                </span>
              </label>
              <div className="pw-option-grid">
                <label className={`pw-option-card${usePersistentProfile && !loadAuthFromId ? ' is-on' : ''}${jobLocked || Boolean(loadAuthFromId) ? ' is-disabled' : ''}`}>
                  <input
                    type="checkbox"
                    checked={usePersistentProfile && !loadAuthFromId}
                    disabled={jobLocked || Boolean(loadAuthFromId)}
                    onChange={(e) => setUsePersistentProfile(e.target.checked)}
                  />
                  <span className="pw-option-body">
                    <span className="pw-option-title">
                      复用持久登录目录
                      <em>{loadAuthFromId ? '已让位于登录态' : '推荐'}</em>
                    </span>
                    <span className="pw-option-desc">
                      {loadAuthFromId
                        ? '已选择「加载已有登录态」时不会启用持久目录，避免与 Codegen --load-storage 冲突'
                        : `同一浏览器下次录制自动带登录。Studio 专用目录，不是日常浏览器窗口${status?.persistentProfilesDir ? ` · ${browser}` : ''}`}
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
                      导出 storageState，供无痕回放与登录前置复用
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
                开始后会打开浏览器与 Playwright Inspector；操作完成后关闭录制窗口即可保存脚本（若已勾选也会导出登录态）。
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
                  <PwSelect
                    value={playBrowser}
                    disabled={jobLocked}
                    onChange={(value) => setPlayBrowser(value as PlaywrightBrowser)}
                    options={PLAYWRIGHT_BROWSERS.map((item) => ({
                      value: item,
                      label: browserLabel(item),
                    }))}
                  />
                </label>
                <label className="field">
                  模式
                  <PwSelect
                    value={playMode}
                    disabled={jobLocked}
                    onChange={(value) => setPlayMode(value as PlaywrightRunMode)}
                    options={PLAYWRIGHT_RUN_MODES.map((mode) => ({
                      value: mode,
                      label: modeLabel(mode),
                    }))}
                  />
                </label>
                <label className="field">
                  放慢 (ms)
                  <input type="number" min={0} step={100} value={slowMo} disabled={jobLocked} onChange={(e) => setSlowMo(e.target.value)} />
                </label>
                <label className={`pw-option-card${recordHar ? ' is-on' : ''}${jobLocked ? ' is-disabled' : ''}`}>
                  <input
                    type="checkbox"
                    checked={recordHar}
                    disabled={jobLocked}
                    onChange={(e) => setRecordHar(e.target.checked)}
                  />
                  <span className="pw-option-body">
                    <span className="pw-option-title">录制 HAR</span>
                    <span className="pw-option-desc">回放时捕获网络请求，供 Agent 契约 / 异常分析</span>
                  </span>
                </label>
                <label className={`pw-option-card${saveBaselineOnPass ? ' is-on' : ''}${jobLocked ? ' is-disabled' : ''}`}>
                  <input
                    type="checkbox"
                    checked={saveBaselineOnPass}
                    disabled={jobLocked}
                    onChange={(e) => setSaveBaselineOnPass(e.target.checked)}
                  />
                  <span className="pw-option-body">
                    <span className="pw-option-title">通过后设为基线</span>
                    <span className="pw-option-desc">成功回放后写入回归基线，便于后续异常对比</span>
                  </span>
                </label>
                <button type="button" className="btn-primary" disabled={jobLocked} onClick={() => { void handlePlay(); }}>
                  执行回放
                </button>
                <div className="pw-capture-actions" style={{ marginTop: 8 }}>
                  <button
                    type="button"
                    className="btn-secondary"
                    disabled={jobLocked || !detail.lastRunId}
                    onClick={() => {
                      void (async () => {
                        try {
                          const info = await window.playwright.saveBaseline({ workflowId: detail.id });
                          setLogLines((prev) => [...prev, `已设基线：${info.runId.slice(0, 8)}…`]);
                          await refresh();
                          await openDetail(detail.id);
                        } catch (err) {
                          setError(err instanceof Error ? err.message : '设置基线失败');
                        }
                      })();
                    }}
                  >
                    设为基线
                  </button>
                  <button
                    type="button"
                    className="btn-secondary"
                    disabled={jobLocked}
                    onClick={() => {
                      requestAgentAnalyze(detail.id, {
                        capturePdf: false,
                        name: detail.name,
                        mode: 'anomaly',
                      });
                    }}
                  >
                    基线异常分析
                  </button>
                </div>
                {detail.baselineRunId ? (
                  <p className="hint">
                    当前基线：{detail.baselineRunId.slice(0, 8)}…
                    {detail.baselineSavedAt ? ` · ${formatTime(detail.baselineSavedAt)}` : ''}
                  </p>
                ) : (
                  <p className="hint">尚未设置基线。建议先成功回放，再「设为基线」或勾选「通过后设为基线」。</p>
                )}
                <p className="hint">
                  支持有头 / 无头 / UI / Debug。回放会自动加载并在成功后刷新登录态（storageState），不再默认截图。
                  「本机 Chrome / Edge」走系统浏览器；放慢默认 {PLAYWRIGHT_DEFAULT_SLOW_MO_MS}ms，执行后会记住浏览器与放慢设置。
                </p>
              </div>
              <div className="side-block">
                <h3>登录前置</h3>
                <label className="field">
                  登录工作流
                  <PwSelect
                    value={detail.authWorkflowId || ''}
                    disabled={jobLocked}
                    onChange={(value) => {
                      void handleSaveAuthConfig({
                        authWorkflowId: value ? value : null,
                        authBeforePlay: value
                          ? (detail.authBeforePlay || 'if-missing-auth')
                          : 'off',
                      });
                    }}
                    options={[
                      { value: '', label: '不使用' },
                      ...list
                        .filter((item) => item.id !== detail.id)
                        .map((item) => ({
                          value: item.id,
                          label: `${item.name}${item.isAuthWorkflow ? '（登录流）' : ''}`,
                          description: item.hasAuth ? '已有登录态' : '暂无登录态文件',
                        })),
                    ]}
                  />
                </label>
                <label className="field">
                  触发策略
                  <PwSelect
                    value={detail.authBeforePlay || (detail.authWorkflowId ? 'if-missing-auth' : 'off')}
                    disabled={jobLocked || !detail.authWorkflowId}
                    onChange={(value) => {
                      void handleSaveAuthConfig({
                        authBeforePlay: value as PlaywrightAuthBeforePlay,
                      });
                    }}
                    options={PLAYWRIGHT_AUTH_BEFORE_PLAY.map((policy) => ({
                      value: policy,
                      label: authBeforePlayLabel(policy),
                    }))}
                  />
                </label>
                <label className={`pw-option-card${detail.isAuthWorkflow ? ' is-on' : ''}${jobLocked ? ' is-disabled' : ''}`}>
                  <input
                    type="checkbox"
                    checked={Boolean(detail.isAuthWorkflow)}
                    disabled={jobLocked}
                    onChange={(e) => {
                      void handleSaveAuthConfig({ isAuthWorkflow: e.target.checked });
                    }}
                  />
                  <span className="pw-option-body">
                    <span className="pw-option-title">标记为登录流</span>
                    <span className="pw-option-desc">便于业务流挑选；可单独「刷新登录态」导出最新 Cookie</span>
                  </span>
                </label>
                <div className="pw-capture-actions" style={{ marginTop: 8 }}>
                  <button
                    type="button"
                    className="btn-secondary"
                    disabled={jobLocked}
                    onClick={() => { void handleRefreshAuthState(); }}
                  >
                    刷新登录态
                  </button>
                </div>
                <p className="hint">
                  建议先录一条登录流并「刷新登录态」，再在业务流里选它作前置。
                  「缺少登录态时」仅在本流没有 storageState 时跑登录；「每次回放前」适合 Cookie 易过期的站点。
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
                  <button
                    type="button"
                    className="btn-primary"
                    disabled={jobLocked}
                    onClick={() => requestAgentAnalyze(detail.id, {
                      capturePdf: false,
                      name: detail.name,
                      mode: 'test-enhance',
                    })}
                  >
                    智能测试增强
                  </button>
                  <button
                    type="button"
                    className="btn-secondary"
                    disabled={jobLocked}
                    onClick={() => requestAgentAnalyze(detail.id, {
                      capturePdf: false,
                      name: detail.name,
                      mode: 'business-doc',
                    })}
                  >
                    生成业务文档
                  </button>
                  <button
                    type="button"
                    className="btn-secondary"
                    disabled={jobLocked}
                    onClick={() => requestAgentAnalyze(detail.id, {
                      capturePdf: true,
                      name: detail.name,
                      mode: 'general',
                    })}
                  >
                    导出 PDF 并分析
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
                  <p className="hint">
                    打开起始 URL 采集并归档到产物；也可直接「导出 PDF 并分析」。PDF 仅 Chromium / Chrome / Edge。
                  </p>
                )}
              </div>
              <div className="side-block">
                <h3>元信息</h3>
                <dl className="pw-meta-list">
                  <div><dt>浏览器</dt><dd>{browserLabel(playBrowser)}</dd></div>
                  <div><dt>设备</dt><dd>{detail.device || '桌面'}</dd></div>
                  <div><dt>放慢</dt><dd>{resolveSlowMoMs(detail)} ms</dd></div>
                  <div><dt>登录态</dt><dd>{detail.hasAuth ? '已保存' : '无'}</dd></div>
                  <div>
                    <dt>登录前置</dt>
                    <dd>
                      {detail.authWorkflowId
                        ? `${list.find((item) => item.id === detail.authWorkflowId)?.name || detail.authWorkflowId.slice(0, 8)} · ${authBeforePlayLabel(detail.authBeforePlay)}`
                        : '无'}
                    </dd>
                  </div>
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
                  <p className="hint">失败回放会保留 Trace / 视频（默认不截图）；也可主动截图、导出 PDF，供 Agent 分析使用。</p>
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

        {tab === 'agent' ? (
          <AgentChatPanel
            key={`agent-${selectedId || 'none'}-${agentLaunchKey}`}
            workflowId={selectedId || null}
            workflowName={detail?.name || list.find((item) => item.id === selectedId)?.name}
            autoStart={agentAutoStart}
            forceNewSession={agentAutoStart}
            capturePdf={agentCapturePdf}
            analyzeMode={agentAnalyzeMode}
            analyzeNote={agentAnalyzeNote}
            onAutoStarted={() => setAgentAutoStart(false)}
            onBusyChange={(agentBusy) => {
              if (agentBusy) setLivePhase('running');
            }}
          />
        ) : null}

        {tab === 'schedule' ? (
          <section className="pw-panel pw-form-panel">
            <div className="pw-auth-head">
              <strong>批量回放</strong>
              <span>在工作流列表勾选后，可从这里或列表顶部按顺序执行；会沿用各流的登录前置配置</span>
            </div>
            <div className="pw-form-grid">
              <label className="field">
                浏览器
                <PwSelect
                  value={playBrowser}
                  disabled={jobLocked}
                  onChange={(value) => setPlayBrowser(value as PlaywrightBrowser)}
                  options={PLAYWRIGHT_BROWSERS.map((item) => ({
                    value: item,
                    label: browserLabel(item),
                  }))}
                />
              </label>
              <label className="field">
                回放模式
                <PwSelect
                  value={playMode}
                  disabled={jobLocked}
                  onChange={(value) => setPlayMode(value as PlaywrightRunMode)}
                  options={PLAYWRIGHT_RUN_MODES.map((mode) => ({
                    value: mode,
                    label: modeLabel(mode),
                  }))}
                />
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
                <span>按间隔分钟自动批量回放已选工作流；应用保持运行时才会触发</span>
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
                  <PwSelect
                    value={scheduleMode}
                    disabled={jobLocked}
                    onChange={(value) => setScheduleMode(value as PlaywrightRunMode)}
                    options={[
                      { value: 'headless', label: modeLabel('headless') },
                      { value: 'headed', label: modeLabel('headed') },
                    ]}
                  />
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

      <FloatingNotice message={error} onClose={() => setError('')} />

      {pendingAgentAnalyze ? (
        <div
          className="pw-modal-backdrop"
          role="presentation"
          onClick={() => setPendingAgentAnalyze(null)}
        >
          <div
            className="pw-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="pw-agent-analyze-title"
            onClick={(event) => event.stopPropagation()}
          >
            <strong id="pw-agent-analyze-title">
              {pendingAgentAnalyze.ids.length > 1 ? '确认批量 Agent 分析' : '确认 Agent 分析'}
            </strong>
            <p>
              {pendingAgentAnalyze.ids.length > 1
                ? `即将依次分析「${pendingAgentAnalyze.name}」。填写统一会话 Prompt 并选择分析方式，确认后为每条新建会话并自动开始。`
                : `即将分析工作流「${pendingAgentAnalyze.name}」。填写会话 Prompt 并选择分析方式，确认后新建会话并自动开始。`}
            </p>
            <label className="field">
              分析模式
              <PwSelect
                value={pendingAgentAnalyze.mode}
                onChange={(value) => {
                  const mode = value as AgentAnalyzeMode;
                  setPendingAgentAnalyze((prev) => {
                    if (!prev) return prev;
                    const name = prev.name;
                    const prompt = mode === 'business-doc'
                      ? `请把「${name}」整理成业务流程文档与用户故事，并保存报告。`
                      : mode === 'anomaly'
                        ? `请对比「${name}」基线与最近回放，定位回归原因并给出修复建议。`
                        : mode === 'test-enhance'
                          ? `请增强「${name}」：优化选择器、补全断言，必要时写回脚本并保存报告。`
                          : prev.prompt;
                    return {
                      ...prev,
                      mode,
                      capturePdf: mode === 'general' ? prev.capturePdf : false,
                      prompt,
                    };
                  });
                }}
                options={PLAYWRIGHT_ANALYZE_MODES.map((mode) => ({
                  value: mode,
                  label: analyzeModeLabel(mode),
                  description: mode === 'test-enhance'
                    ? '选择器优化、断言补全、脚本写回'
                    : mode === 'business-doc'
                      ? '流程文档 / 用户故事 / 验收标准'
                      : mode === 'anomaly'
                        ? '基线对比、回归定位、修复建议'
                        : '综合概要与风险建议',
                }))}
              />
            </label>
            <label className="field">
              会话 Prompt
              <textarea
                rows={5}
                autoFocus
                value={pendingAgentAnalyze.prompt}
                placeholder="写下你希望 Agent 完成的分析任务，将作为本会话首条用户消息发送…"
                onChange={(event) => {
                  const prompt = event.target.value;
                  setPendingAgentAnalyze((prev) => (prev ? { ...prev, prompt } : prev));
                }}
              />
              <span className="hint">必填。会带入新会话作为首条消息；后台仍会附带脚本 / URL / 产物 / 基线上下文。</span>
            </label>
            <label className="field">
              上下文采集
              <PwSelect
                value={pendingAgentAnalyze.capturePdf ? 'pdf' : 'script'}
                onChange={(value) => {
                  setPendingAgentAnalyze((prev) => (
                    prev ? { ...prev, capturePdf: value === 'pdf' } : prev
                  ));
                }}
                options={[
                  {
                    value: 'script',
                    label: '脚本 / 产物 / 基线',
                    description: '不导出 PDF，适合测试增强、文档与异常分析',
                  },
                  {
                    value: 'pdf',
                    label: '导出 PDF 再分析',
                    description: '先打开起始 URL 导出 PDF，再交给 Agent',
                  },
                ]}
              />
            </label>
            <div className="pw-modal-actions">
              <button type="button" className="btn-secondary" onClick={() => setPendingAgentAnalyze(null)}>
                取消
              </button>
              <button
                type="button"
                className="btn-primary"
                disabled={!pendingAgentAnalyze.prompt.trim()}
                onClick={confirmAgentAnalyze}
              >
                {pendingAgentAnalyze.ids.length > 1
                  ? `确定并分析 (${pendingAgentAnalyze.ids.length})`
                  : '确定并分析'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
