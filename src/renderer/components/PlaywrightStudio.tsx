import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import type {
  PlaywrightBrowser,
  PlaywrightJobPhase,
  PlaywrightRunEvent,
  PlaywrightRunMode,
  PlaywrightStudioStatus,
  PlaywrightWorkflowDetail,
  PlaywrightWorkflowMeta,
} from '../../shared/playwright';
import {
  PLAYWRIGHT_BROWSERS,
  PLAYWRIGHT_DEVICES,
  PLAYWRIGHT_RUN_MODES,
} from '../../shared/playwright';

type StudioTab = 'workflows' | 'record' | 'detail';

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
  const [notes, setNotes] = useState('');

  const [playMode, setPlayMode] = useState<PlaywrightRunMode>('headed');
  const [slowMo, setSlowMo] = useState('0');
  const [scriptDraft, setScriptDraft] = useState('');
  const [nameDraft, setNameDraft] = useState('');
  const [notesDraft, setNotesDraft] = useState('');

  const refresh = useCallback(async () => {
    if (!window.playwright) {
      setError('Playwright 桥接不可用，请在 Electron 窗口中打开。');
      return;
    }
    const [nextStatus, nextList] = await Promise.all([
      window.playwright.getStatus(),
      window.playwright.listWorkflows(),
    ]);
    setStatus(nextStatus);
    setList(nextList);
  }, []);

  const openDetail = useCallback(async (id: string) => {
    const item = await window.playwright.getWorkflow(id);
    setSelectedId(id);
    setDetail(item);
    setScriptDraft(item.script);
    setNameDraft(item.name);
    setNotesDraft(item.notes || '');
    setTab('detail');
  }, []);

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
      void refresh();
      if (event.workflowId === selectedId && (event.phase === 'passed' || event.phase === 'failed' || event.phase === 'stopped')) {
        void openDetail(event.workflowId).catch(() => undefined);
      }
    });
  }, [openDetail, refresh, selectedId]);

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
        notes,
      });
      setSelectedId(created.id);
      setDetail(created);
      setScriptDraft(created.script);
      setNameDraft(created.name);
      setNotesDraft(created.notes || '');
      await refresh();
      setTab('detail');
    } catch (err) {
      setError(err instanceof Error ? err.message : '录制启动失败');
      setLivePhase('failed');
    } finally {
      setBusy(false);
    }
  }

  async function handlePlay(workflowId = selectedId): Promise<void> {
    if (!workflowId) return;
    setBusy(true);
    setError('');
    setLogLines([`开始回放：${workflowId} · ${playMode}`]);
    setLivePhase('running');
    try {
      const slowMoMs = Number(slowMo);
      await window.playwright.play({
        id: workflowId,
        mode: playMode,
        slowMoMs: Number.isFinite(slowMoMs) && slowMoMs > 0 ? slowMoMs : undefined,
      });
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
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除失败');
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
            <em>录制 · 管理 · 回放</em>
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
              {tab === 'workflows' ? '工作流管理' : tab === 'record' ? '录制新流程' : '脚本与执行'}
            </h1>
            <p className="subtitle">
              浏览器里操作 → Codegen 生成脚本 → 有头 / 无头 / UI / Debug 回放
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
                <span>进行中：{status.activeJob.kind === 'record' ? '录制' : '回放'}</span>
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
                <button type="button" className="pw-inline-cta" onClick={() => setTab('record')}>
                  新建录制
                </button>
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
                  <article key={item.id} className="pw-row">
                    <div className="pw-row-main">
                      <strong>{item.name}</strong>
                      <p>{item.url}</p>
                      <div className="pw-tags">
                        <span>{browserLabel(item.browser)}</span>
                        {item.device ? <span>{item.device}</span> : null}
                        {item.hasAuth ? <span>含登录态</span> : null}
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
                          void openDetail(item.id).then(() => handlePlay(item.id));
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
              <label className="field">
                加载已有登录态
                <select value={loadAuthFromId} disabled={jobLocked} onChange={(e) => setLoadAuthFromId(e.target.value)}>
                  <option value="">不使用</option>
                  {authSources.map((item) => (
                    <option key={item.id} value={item.id}>{item.name}</option>
                  ))}
                </select>
              </label>
              <label className="field checkbox-field">
                <input type="checkbox" checked={saveAuth} disabled={jobLocked} onChange={(e) => setSaveAuth(e.target.checked)} />
                录制结束时保存登录态（storageState）
              </label>
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
                会弹出浏览器与 Playwright Inspector。在页面上点击、输入即可；关闭录制窗口后脚本写入工作流。
                默认是有界面录制；选「本机 Chrome」才用系统 Chrome，而不是 Playwright 自带 Chromium。
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
            </div>

            <aside className="pw-detail-side">
              <div className="side-block">
                <h3>回放</h3>
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
                  有头：看得见浏览器；无头：适合批量；UI / Debug：逐步排查。Codegen 默认不加断言，失败时先精简脚本再补 expect。
                </p>
              </div>
              <div className="side-block">
                <h3>元信息</h3>
                <dl className="pw-meta-list">
                  <div><dt>浏览器</dt><dd>{browserLabel(detail.browser)}</dd></div>
                  <div><dt>设备</dt><dd>{detail.device || '桌面'}</dd></div>
                  <div><dt>登录态</dt><dd>{detail.hasAuth ? '已保存' : '无'}</dd></div>
                  <div><dt>最近执行</dt><dd>{formatTime(detail.lastRunAt)}</dd></div>
                  <div><dt>状态</dt><dd>{phaseLabel(detail.lastRunStatus)}</dd></div>
                </dl>
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
      </div>
    </div>
  );
}
