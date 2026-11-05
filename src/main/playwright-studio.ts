import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { app, shell } from 'electron';
import type {
  PlaywrightBrowser,
  PlaywrightPlayRequest,
  PlaywrightRecordRequest,
  PlaywrightRunEvent,
  PlaywrightStudioStatus,
  PlaywrightUpdateRequest,
  PlaywrightWorkflowDetail,
  PlaywrightWorkflowMeta,
} from '../shared/playwright';

type EventSink = (event: PlaywrightRunEvent) => void;

interface ActiveJob {
  kind: 'record' | 'play';
  workflowId: string;
  runId: string;
  startedAt: string;
  child: ChildProcessWithoutNullStreams;
}

let eventSink: EventSink | null = null;
let activeJob: ActiveJob | null = null;
const runWaiters = new Map<string, {
  resolve: (event: PlaywrightRunEvent) => void;
  reject: (error: Error) => void;
}>();

function studioRoot(): string {
  const dir = path.join(app.getPath('userData'), 'playwright-studio');
  mkdirSync(dir, { recursive: true });
  mkdirSync(path.join(dir, 'workflows'), { recursive: true });
  mkdirSync(path.join(dir, 'auth'), { recursive: true });
  mkdirSync(path.join(dir, 'runs'), { recursive: true });
  mkdirSync(path.join(dir, 'browser-profiles'), { recursive: true });
  ensureStudioScaffold(dir);
  return dir;
}

/** Dedicated Playwright user-data-dir per browser channel (not the OS daily profile). */
function persistentProfileDir(browser: PlaywrightBrowser): string {
  const dir = path.join(studioRoot(), 'browser-profiles', browser);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function ensureStudioScaffold(root: string): void {
  const configPath = path.join(root, 'playwright.config.ts');
  const workflowsDir = path.join(root, 'workflows');
  // Always refresh the base config so testDir stays absolute and discoverable.
  writeFileSync(configPath, `import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: ${JSON.stringify(workflowsDir)},
  testMatch: /\\.spec\\.(ts|js|mjs)$/,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: {
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], browserName: 'chromium' } },
  ],
});
`, 'utf8');

  const pkgPath = path.join(root, 'package.json');
  if (!existsSync(pkgPath)) {
    writeFileSync(pkgPath, `${JSON.stringify({
      name: 'mediado-playwright-studio',
      private: true,
      version: '1.0.0',
    }, null, 2)}\n`, 'utf8');
  }

  // Prefer app-local Playwright so studio runs without a separate npm install.
  const nodeModules = path.join(root, 'node_modules');
  const appPlaywright = path.join(app.getAppPath(), 'node_modules', '@playwright');
  const appPlaywrightTest = path.join(app.getAppPath(), 'node_modules', '@playwright', 'test');
  const link = path.join(nodeModules, '@playwright');
  if (!existsSync(link) && existsSync(appPlaywrightTest)) {
    mkdirSync(nodeModules, { recursive: true });
    try {
      symlinkSync(appPlaywright, link, 'dir');
    } catch {
      // Fall through — CLI still resolves via app node_modules path.
    }
  }
}

function spawnEnv(command: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (command === process.execPath) {
    env.ELECTRON_RUN_AS_NODE = '1';
  }
  return env;
}

function metaPath(id: string): string {
  return path.join(studioRoot(), 'workflows', id, 'meta.json');
}

function workflowDir(id: string): string {
  return path.join(studioRoot(), 'workflows', id);
}

function readMeta(id: string): PlaywrightWorkflowMeta {
  const file = metaPath(id);
  if (!existsSync(file)) {
    throw new Error('工作流不存在。');
  }
  return JSON.parse(readFileSync(file, 'utf8')) as PlaywrightWorkflowMeta;
}

function writeMeta(meta: PlaywrightWorkflowMeta): void {
  const dir = workflowDir(meta.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(metaPath(meta.id), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
}

function scriptPathFor(meta: PlaywrightWorkflowMeta): string {
  return path.join(workflowDir(meta.id), meta.fileName);
}

function authPathFor(id: string): string {
  return path.join(studioRoot(), 'auth', `${id}.json`);
}

function slugify(name: string): string {
  const base = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return base || 'flow';
}

function nowIso(): string {
  return new Date().toISOString();
}

function emit(partial: Omit<PlaywrightRunEvent, 'percent'> & { percent?: number }): void {
  const event: PlaywrightRunEvent = {
    percent: partial.percent ?? 0,
    ...partial,
  };
  eventSink?.(event);
  if (
    event.phase === 'passed'
    || event.phase === 'failed'
    || event.phase === 'stopped'
  ) {
    const waiter = runWaiters.get(event.runId);
    if (waiter) {
      runWaiters.delete(event.runId);
      waiter.resolve(event);
    }
  }
}

function registerRunWaiter(runId: string, timeoutMs = 30 * 60 * 1000): Promise<PlaywrightRunEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      runWaiters.delete(runId);
      reject(new Error(`等待任务超时（${Math.round(timeoutMs / 1000)} 秒）。`));
    }, timeoutMs);
    runWaiters.set(runId, {
      resolve: (event) => {
        clearTimeout(timer);
        resolve(event);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
  });
}

/** Wait until a record/play run finishes (passed / failed / stopped). */
export function waitForRun(runId: string, timeoutMs = 30 * 60 * 1000): Promise<PlaywrightRunEvent> {
  if (!activeJob || activeJob.runId !== runId) {
    return Promise.resolve({
      workflowId: '',
      runId,
      phase: 'failed',
      percent: 0,
      message: '任务已结束或不存在。',
    });
  }
  return registerRunWaiter(runId, timeoutMs);
}

function resolvePlaywrightCli(): { command: string; prefixArgs: string[] } {
  const candidates = [
    path.join(app.getAppPath(), 'node_modules', '@playwright', 'test', 'cli.js'),
    path.join(process.cwd(), 'node_modules', '@playwright', 'test', 'cli.js'),
    path.join(studioRoot(), 'node_modules', '@playwright', 'test', 'cli.js'),
  ];
  for (const cli of candidates) {
    if (existsSync(cli)) {
      return { command: process.execPath, prefixArgs: [cli] };
    }
  }
  // Last resort: system npx (needs network / global install)
  return { command: process.platform === 'win32' ? 'npx.cmd' : 'npx', prefixArgs: ['playwright'] };
}

function playwrightReady(): boolean {
  const { command, prefixArgs } = resolvePlaywrightCli();
  if (prefixArgs[0]?.endsWith('cli.js')) {
    return existsSync(prefixArgs[0]);
  }
  return command.includes('npx');
}

function assertNoActiveJob(): void {
  if (activeJob) {
    throw new Error(activeJob.kind === 'record' ? '已有录制任务在进行。' : '已有回放任务在进行。');
  }
}

/** Playwright `use` fragment for the workflow's browser choice. */
function browserUseSnippet(browser: PlaywrightBrowser, device: string): string {
  const deviceKey = device || 'Desktop Chrome';
  if (browser === 'chrome' || browser === 'msedge') {
    return `{ ...devices[${JSON.stringify(device || 'Desktop Chrome')}], channel: ${JSON.stringify(browser)} }`;
  }
  if (browser === 'firefox') {
    return `{ ...devices[${JSON.stringify(device || 'Desktop Firefox')}], browserName: 'firefox' }`;
  }
  if (browser === 'webkit') {
    return `{ ...devices[${JSON.stringify(device || 'Desktop Safari')}], browserName: 'webkit' }`;
  }
  // Playwright-bundled Chromium
  return `{ ...devices[${JSON.stringify(deviceKey)}], browserName: 'chromium' }`;
}

function needsBundledBrowser(browser: PlaywrightBrowser): boolean {
  return browser === 'chromium' || browser === 'firefox' || browser === 'webkit';
}

function playwrightBrowsersJson(): string | null {
  const candidates = [
    path.join(app.getAppPath(), 'node_modules', 'playwright-core', 'browsers.json'),
    path.join(process.cwd(), 'node_modules', 'playwright-core', 'browsers.json'),
  ];
  return candidates.find((file) => existsSync(file)) || null;
}

function playwrightBrowsersCacheDir(): string {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) {
    return process.env.PLAYWRIGHT_BROWSERS_PATH;
  }
  const home = app.getPath('home');
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Caches', 'ms-playwright');
  }
  if (process.platform === 'win32') {
    return path.join(home, 'AppData', 'Local', 'ms-playwright');
  }
  return path.join(home, '.cache', 'ms-playwright');
}

function expectedBrowserRevision(browser: 'chromium' | 'firefox' | 'webkit' | 'ffmpeg'): string | null {
  const file = playwrightBrowsersJson();
  if (!file) return null;
  try {
    const json = JSON.parse(readFileSync(file, 'utf8')) as {
      browsers?: Array<{ name?: string; revision?: string }>;
    };
    const entry = json.browsers?.find((item) => item.name === browser);
    return entry?.revision || null;
  } catch {
    return null;
  }
}

function bundledBrowserInstalled(browser: PlaywrightBrowser): boolean {
  if (browser !== 'chromium' && browser !== 'firefox' && browser !== 'webkit') {
    return true;
  }
  const revision = expectedBrowserRevision(browser);
  const cache = playwrightBrowsersCacheDir();
  if (!existsSync(cache)) {
    return false;
  }
  try {
    if (revision) {
      return existsSync(path.join(cache, `${browser}-${revision}`));
    }
    return readdirSync(cache).some((name) => name.startsWith(`${browser}-`) && !name.includes('headless'));
  } catch {
    return false;
  }
}

/**
 * Video artifacts (`video: retain-on-failure`) need Playwright's bundled ffmpeg.
 * System Chrome / Edge skips browser download, but ffmpeg is still required.
 */
function ffmpegInstalled(): boolean {
  const revision = expectedBrowserRevision('ffmpeg');
  const cache = playwrightBrowsersCacheDir();
  if (!existsSync(cache)) {
    return false;
  }
  try {
    if (revision) {
      const dir = path.join(cache, `ffmpeg-${revision}`);
      if (!existsSync(dir)) return false;
      // INSTALLATION_COMPLETE is written after extract; also accept a present binary.
      if (existsSync(path.join(dir, 'INSTALLATION_COMPLETE'))) return true;
      return readdirSync(dir).some((name) => name.startsWith('ffmpeg'));
    }
    return readdirSync(cache).some((name) => name.startsWith('ffmpeg-'));
  } catch {
    return false;
  }
}

function isRuntimeDepInstalled(dep: 'chromium' | 'firefox' | 'webkit' | 'ffmpeg'): boolean {
  return dep === 'ffmpeg' ? ffmpegInstalled() : bundledBrowserInstalled(dep);
}

async function ensurePlaywrightRuntime(
  browser: PlaywrightBrowser,
): Promise<{ ok: boolean; message: string; videoEnabled: boolean }> {
  const missing: Array<'chromium' | 'firefox' | 'webkit' | 'ffmpeg'> = [];
  if (needsBundledBrowser(browser) && !bundledBrowserInstalled(browser)) {
    missing.push(browser === 'firefox' || browser === 'webkit' ? browser : 'chromium');
  }
  // Needed for retain-on-failure video, regardless of browser channel.
  if (!ffmpegInstalled()) {
    missing.push('ffmpeg');
  }
  if (missing.length === 0) {
    return { ok: true, message: 'Playwright 运行依赖已就绪。', videoEnabled: true };
  }

  const { code, output } = await runPlaywrightCommand(['install', ...missing], studioRoot());
  const stillMissing = missing.filter((item) => !isRuntimeDepInstalled(item));
  const browserStillMissing = stillMissing.filter((item) => item !== 'ffmpeg');
  if (browserStillMissing.length > 0) {
    const detail = output.trim().split(/\r?\n/).slice(-12).join('\n');
    return {
      ok: false,
      message: detail
        || `缺少 Playwright 浏览器（${browserStillMissing.join(', ')}）。请点击「安装浏览器」，或执行：npx playwright install ${browserStillMissing.join(' ')}`,
      videoEnabled: false,
    };
  }

  const videoEnabled = ffmpegInstalled();
  if (!videoEnabled) {
    const detail = output.trim().split(/\r?\n/).slice(-8).join('\n');
    return {
      ok: true,
      message: detail
        || '未安装 Playwright ffmpeg，本次回放将关闭失败视频录制后继续。可稍后点「安装浏览器」补齐。',
      videoEnabled: false,
    };
  }

  if (code === 0) {
    return { ok: true, message: `已补齐 Playwright 依赖：${missing.join(', ')}`, videoEnabled: true };
  }
  return { ok: true, message: 'Playwright 运行依赖已就绪。', videoEnabled: true };
}

function writeRunConfig(options: {
  root: string;
  meta: PlaywrightWorkflowMeta;
  slowMoMs?: number;
  authFile?: string;
  videoEnabled?: boolean;
}): { configPath: string; testFilter: string } {
  // Keep config under studio root so relative paths stay predictable; testDir must be absolute
  // because Playwright resolves it against the config file location.
  const configPath = path.join(options.root, 'playwright.run.config.ts');
  const workflowsDir = path.join(options.root, 'workflows');
  const slowMo = Number(options.slowMoMs) > 0 ? Number(options.slowMoMs) : 0;
  const storageLine = options.authFile
    ? `storageState: ${JSON.stringify(options.authFile)},`
    : '';
  const projectName = options.meta.browser;
  const videoMode = options.videoEnabled === false ? 'off' : 'retain-on-failure';
  // Playwright CLI args are RegExp filters against paths under testDir.
  // Use the workflow id only — avoids spaces, Chinese filenames, and "." wildcards in "*.spec.ts".
  const testFilter = options.meta.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  writeFileSync(configPath, `import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: ${JSON.stringify(workflowsDir)},
  testMatch: /\\.spec\\.(ts|js|mjs)$/,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  timeout: 120_000,
  use: {
    ${storageLine}
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: ${JSON.stringify(videoMode)},
    launchOptions: {
      slowMo: ${slowMo},
    },
  },
  projects: [
    {
      name: ${JSON.stringify(projectName)},
      use: ${browserUseSnippet(options.meta.browser, options.meta.device)},
    },
  ],
});
`, 'utf8');
  return { configPath, testFilter };
}

function runPlaywrightCommand(args: string[], cwd: string): Promise<{ code: number | null; output: string }> {
  const { command, prefixArgs } = resolvePlaywrightCli();
  return new Promise((resolve) => {
    const child = spawn(command, [...prefixArgs, ...args], {
      cwd,
      env: spawnEnv(command),
      windowsHide: true,
    });
    let output = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => { output += chunk; });
    child.stderr?.on('data', (chunk: string) => { output += chunk; });
    child.on('error', (error) => {
      resolve({ code: 1, output: error.message });
    });
    child.on('close', (code) => {
      resolve({ code, output });
    });
  });
}

function attachChildLogs(
  child: ChildProcessWithoutNullStreams,
  workflowId: string,
  runId: string,
  logFile: string,
): void {
  const append = (chunk: string) => {
    try {
      writeFileSync(logFile, chunk, { flag: 'a', encoding: 'utf8' });
    } catch {
      // ignore
    }
    for (const line of chunk.split(/\r?\n/)) {
      if (!line.trim()) continue;
      emit({
        workflowId,
        runId,
        phase: activeJob?.kind === 'record' ? 'recording' : 'running',
        percent: 40,
        message: activeJob?.kind === 'record' ? '录制中' : '执行中',
        line,
      });
    }
  };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => append(chunk));
  child.stderr.on('data', (chunk: string) => append(chunk));
}

export function setPlaywrightEventSink(sink: EventSink | null): void {
  eventSink = sink;
}

export function getStudioStatus(): PlaywrightStudioStatus {
  const chromiumReady = bundledBrowserInstalled('chromium');
  const ffmpegReady = ffmpegInstalled();
  let browsersHint: string;
  if (chromiumReady && ffmpegReady) {
    browsersHint = 'Chromium / ffmpeg 已就绪。选「本机 Chrome / Edge」时回放走系统浏览器，仍会使用 Playwright 自带的 ffmpeg 录失败视频。';
  } else if (!ffmpegReady) {
    browsersHint = '缺少 Playwright ffmpeg（失败回放视频依赖它）。请点「安装浏览器」补齐；本机 Chrome / Edge 也不能跳过这一步。';
  } else {
    browsersHint = '尚未安装与当前 Playwright 匹配的 Chromium，请点「安装浏览器」。本机 Chrome / Edge 可跳过 Chromium，但仍需 ffmpeg。';
  }
  const root = studioRoot();
  return {
    rootDir: root,
    playwrightReady: playwrightReady(),
    browsersHint,
    persistentProfilesDir: path.join(root, 'browser-profiles'),
    activeJob: activeJob
      ? {
          kind: activeJob.kind,
          workflowId: activeJob.workflowId,
          runId: activeJob.runId,
          startedAt: activeJob.startedAt,
        }
      : null,
  };
}

export function listWorkflows(): PlaywrightWorkflowMeta[] {
  const root = path.join(studioRoot(), 'workflows');
  const ids = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  const list: PlaywrightWorkflowMeta[] = [];
  for (const id of ids) {
    try {
      list.push(readMeta(id));
    } catch {
      // skip broken dirs
    }
  }
  return list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function getWorkflow(id: string): PlaywrightWorkflowDetail {
  const meta = readMeta(id);
  const scriptFile = scriptPathFor(meta);
  const script = existsSync(scriptFile) ? readFileSync(scriptFile, 'utf8') : '';
  const auth = authPathFor(id);
  return {
    ...meta,
    script,
    scriptPath: scriptFile,
    authPath: existsSync(auth) ? auth : undefined,
  };
}

function starterScript(name: string, url: string): string {
  const safeName = name.replace(/'/g, "\\'");
  return `import { test, expect } from '@playwright/test';

test('${safeName}', async ({ page }) => {
  await page.goto('${url}');
  // Codegen 会在你操作时追加步骤；也可手动补充 expect。
});
`;
}

export async function startRecord(
  request: PlaywrightRecordRequest,
  options?: { wait?: boolean; timeoutMs?: number },
): Promise<PlaywrightWorkflowDetail & { runId?: string; runEvent?: PlaywrightRunEvent }> {
  assertNoActiveJob();
  const root = studioRoot();
  if (!playwrightReady()) {
    throw new Error('未找到 Playwright。请先安装依赖 @playwright/test，并点击「安装浏览器」。');
  }

  const url = (request.url || '').trim();
  if (!url) {
    throw new Error('请填写起始 URL。');
  }
  try {
    // eslint-disable-next-line no-new
    new URL(url);
  } catch {
    throw new Error('URL 不合法。');
  }

  const name = (request.name || '').trim() || '未命名工作流';
  const id = randomUUID();
  const browser: PlaywrightBrowser = request.browser || 'chromium';
  const device = (request.device || '').trim();
  const fileName = `${slugify(name)}.spec.ts`;
  const dir = workflowDir(id);
  mkdirSync(dir, { recursive: true });

  const usePersistentProfile = Boolean(request.usePersistentProfile);
  const meta: PlaywrightWorkflowMeta = {
    id,
    name,
    url,
    browser,
    device,
    fileName,
    hasAuth: false,
    usePersistentProfile: usePersistentProfile || undefined,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    lastRunStatus: 'recording',
    lastRunMessage: '正在打开 Codegen…',
    notes: request.notes?.trim() || '',
  };

  const scriptFile = scriptPathFor(meta);
  writeFileSync(scriptFile, starterScript(name, url), 'utf8');
  writeMeta(meta);

  const { command, prefixArgs } = resolvePlaywrightCli();
  const args = [...prefixArgs, 'codegen', '--output', scriptFile];

  if (browser === 'chrome' || browser === 'msedge') {
    args.push('--channel', browser);
  } else if (browser === 'firefox' || browser === 'webkit') {
    args.push('-b', browser);
  } else {
    args.push('-b', 'chromium');
  }

  if (device) {
    args.push('--device', device);
  }

  // Persistent profile keeps cookies across recordings (Studio-owned dir, not daily Chrome).
  if (usePersistentProfile) {
    args.push('--user-data-dir', persistentProfileDir(browser));
  }

  if (request.loadAuthFromId) {
    const loadPath = authPathFor(request.loadAuthFromId);
    if (!existsSync(loadPath)) {
      throw new Error('指定的登录态文件不存在。');
    }
    args.push('--load-storage', loadPath);
  }

  const saveAuth = Boolean(request.saveAuth);
  const authOut = authPathFor(id);
  if (saveAuth) {
    args.push('--save-storage', authOut);
  }

  args.push(url);

  const runId = randomUUID();
  const logFile = path.join(root, 'runs', `${runId}.log`);
  writeFileSync(logFile, `# record ${id}\n$ ${command} ${args.join(' ')}\n\n`, 'utf8');
  const waitPromise = options?.wait
    ? registerRunWaiter(runId, options.timeoutMs ?? 30 * 60 * 1000)
    : null;

  const child = spawn(command, args, {
    cwd: root,
    env: spawnEnv(command),
    windowsHide: false,
  });

  activeJob = {
    kind: 'record',
    workflowId: id,
    runId,
    startedAt: nowIso(),
    child,
  };

  attachChildLogs(child, id, runId, logFile);
  emit({
    workflowId: id,
    runId,
    phase: 'recording',
    percent: 5,
    message: usePersistentProfile
      ? `已启动 Codegen（持久登录目录：browser-profiles/${browser}），请在弹出的浏览器中操作`
      : '已启动 Codegen，请在弹出的浏览器中操作',
  });

  child.on('error', (error) => {
    const message = error.message || '启动录制失败';
    const next = { ...readMeta(id), updatedAt: nowIso(), lastRunStatus: 'failed' as const, lastRunMessage: message, lastRunAt: nowIso() };
    writeMeta(next);
    emit({ workflowId: id, runId, phase: 'failed', percent: 0, message });
    activeJob = null;
  });

  child.on('close', (code) => {
    if (activeJob?.runId !== runId) {
      return;
    }
    activeJob = null;
    const current = readMeta(id);
    // If codegen wrote nothing beyond starter, keep starter; otherwise keep recorded script.
    if (saveAuth && existsSync(authOut)) {
      current.hasAuth = true;
    }
    current.updatedAt = nowIso();
    current.lastRunAt = nowIso();
    if (code === 0 || code === null) {
      current.lastRunStatus = 'idle';
      current.lastRunMessage = '录制结束，可回放或编辑脚本';
      writeMeta(current);
      emit({
        workflowId: id,
        runId,
        phase: 'passed',
        percent: 100,
        message: current.lastRunMessage,
        exitCode: code,
      });
    } else {
      current.lastRunStatus = 'failed';
      current.lastRunMessage = `录制进程退出码 ${code}`;
      writeMeta(current);
      emit({
        workflowId: id,
        runId,
        phase: 'failed',
        percent: 0,
        message: current.lastRunMessage,
        exitCode: code,
      });
    }
  });

  if (waitPromise) {
    const runEvent = await waitPromise;
    return { ...getWorkflow(id), runId, runEvent };
  }
  return { ...getWorkflow(id), runId };
}

export async function playWorkflow(
  request: PlaywrightPlayRequest,
  options?: { wait?: boolean; timeoutMs?: number },
): Promise<{ runId: string; runEvent?: PlaywrightRunEvent; workflow?: PlaywrightWorkflowDetail }> {
  assertNoActiveJob();
  const root = studioRoot();
  if (!playwrightReady()) {
    throw new Error('未找到 Playwright。请先安装依赖并点击「安装浏览器」。');
  }

  const meta = readMeta(request.id);
  const scriptFile = scriptPathFor(meta);
  if (!existsSync(scriptFile)) {
    throw new Error('脚本文件缺失。');
  }

  // Bundled browsers must match @playwright/test revision (e.g. chromium-1194).
  // System Chrome / Edge skip browser download, but ffmpeg is still required for video.
  const ensured = await ensurePlaywrightRuntime(meta.browser);
  if (!ensured.ok) {
    throw new Error(
      `${ensured.message}\n请先点击「安装浏览器」，或在终端执行：npx playwright install chromium ffmpeg`,
    );
  }

  const mode = request.mode || 'headed';
  const { command, prefixArgs } = resolvePlaywrightCli();
  const authFile = authPathFor(meta.id);
  const { configPath, testFilter } = writeRunConfig({
    root,
    meta,
    slowMoMs: request.slowMoMs,
    authFile: existsSync(authFile) ? authFile : undefined,
    videoEnabled: ensured.videoEnabled,
  });

  // Pass filter relative to testDir. Absolute paths are treated as RegExp and break discovery.
  const args = [...prefixArgs, 'test', testFilter, '--config', configPath];

  if (mode === 'headed') {
    args.push('--headed');
  } else if (mode === 'ui') {
    args.push('--ui');
  } else if (mode === 'debug') {
    args.push('--debug');
  }

  if (typeof request.workers === 'number' && request.workers > 0) {
    args.push('--workers', String(request.workers));
  }

  const runId = randomUUID();
  const logFile = path.join(root, 'runs', `${runId}.log`);
  const runtimeNote = ensured.videoEnabled
    ? 'video=retain-on-failure'
    : 'video=off (ffmpeg missing)';
  writeFileSync(
    logFile,
    `# play ${meta.id}\nbrowser=${meta.browser}\nscript=${scriptFile}\nfilter=${testFilter}\n${runtimeNote}\n$ ${command} ${args.join(' ')}\n\n`,
    'utf8',
  );
  if (!ensured.videoEnabled && ensured.message) {
    writeFileSync(logFile, `${ensured.message}\n\n`, { flag: 'a', encoding: 'utf8' });
  }
  const waitPromise = options?.wait
    ? registerRunWaiter(runId, options.timeoutMs ?? 30 * 60 * 1000)
    : null;

  meta.updatedAt = nowIso();
  meta.lastRunStatus = 'running';
  meta.lastRunMessage = `回放中（${mode} · ${meta.browser}）…`;
  writeMeta(meta);

  const child = spawn(command, args, {
    cwd: root,
    env: spawnEnv(command),
    windowsHide: false,
  });

  activeJob = {
    kind: 'play',
    workflowId: meta.id,
    runId,
    startedAt: nowIso(),
    child,
  };

  attachChildLogs(child, meta.id, runId, logFile);
  emit({
    workflowId: meta.id,
    runId,
    phase: 'running',
    percent: 10,
    message: ensured.videoEnabled
      ? `开始回放 · ${mode}`
      : `开始回放 · ${mode}（未检测到 ffmpeg，已关闭失败视频）`,
  });

  child.on('error', (error) => {
    const message = error.message || '启动回放失败';
    const next = { ...readMeta(meta.id), updatedAt: nowIso(), lastRunStatus: 'failed' as const, lastRunMessage: message, lastRunAt: nowIso() };
    writeMeta(next);
    emit({ workflowId: meta.id, runId, phase: 'failed', percent: 0, message });
    activeJob = null;
  });

  child.on('close', (code) => {
    if (activeJob?.runId !== runId) {
      return;
    }
    activeJob = null;
    const current = readMeta(meta.id);
    current.updatedAt = nowIso();
    current.lastRunAt = nowIso();
    if (code === 0) {
      current.lastRunStatus = 'passed';
      current.lastRunMessage = '回放通过';
      writeMeta(current);
      emit({
        workflowId: meta.id,
        runId,
        phase: 'passed',
        percent: 100,
        message: '回放通过',
        exitCode: code,
      });
    } else {
      current.lastRunStatus = 'failed';
      current.lastRunMessage = `回放失败（退出码 ${code}）`;
      writeMeta(current);
      emit({
        workflowId: meta.id,
        runId,
        phase: 'failed',
        percent: 0,
        message: current.lastRunMessage,
        exitCode: code,
      });
    }
  });

  if (waitPromise) {
    const runEvent = await waitPromise;
    return { runId, runEvent, workflow: getWorkflow(meta.id) };
  }
  return { runId };
}

export async function stopJob(): Promise<void> {
  if (!activeJob) {
    return;
  }
  const job = activeJob;
  try {
    job.child.kill('SIGTERM');
  } catch {
    // ignore
  }
  activeJob = null;
  try {
    const meta = readMeta(job.workflowId);
    meta.updatedAt = nowIso();
    meta.lastRunAt = nowIso();
    meta.lastRunStatus = 'stopped';
    meta.lastRunMessage = '已手动停止';
    writeMeta(meta);
  } catch {
    // ignore
  }
  emit({
    workflowId: job.workflowId,
    runId: job.runId,
    phase: 'stopped',
    percent: 0,
    message: '已手动停止',
  });
}

export function updateWorkflow(request: PlaywrightUpdateRequest): PlaywrightWorkflowDetail {
  const meta = readMeta(request.id);
  if (typeof request.name === 'string' && request.name.trim()) {
    meta.name = request.name.trim();
  }
  if (typeof request.notes === 'string') {
    meta.notes = request.notes;
  }
  if (typeof request.url === 'string' && request.url.trim()) {
    meta.url = request.url.trim();
  }
  if (request.browser) {
    meta.browser = request.browser;
  }
  if (typeof request.device === 'string') {
    meta.device = request.device;
  }
  if (typeof request.script === 'string') {
    writeFileSync(scriptPathFor(meta), request.script, 'utf8');
  }
  meta.updatedAt = nowIso();
  writeMeta(meta);
  return getWorkflow(meta.id);
}

export function deleteWorkflow(id: string): void {
  if (activeJob?.workflowId === id) {
    throw new Error('该工作流正在执行，请先停止。');
  }
  const dir = workflowDir(id);
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }
  const auth = authPathFor(id);
  if (existsSync(auth)) {
    rmSync(auth, { force: true });
  }
}

export async function openWorkflowFolder(id: string): Promise<void> {
  const dir = workflowDir(id);
  if (!existsSync(dir)) {
    throw new Error('工作流目录不存在。');
  }
  await shell.openPath(dir);
}

export async function revealStudioRoot(): Promise<void> {
  await shell.openPath(studioRoot());
}

export async function installBrowsers(
  target: 'chromium' | 'firefox' | 'webkit' | 'all' = 'chromium',
): Promise<{ ok: boolean; message: string }> {
  if (!playwrightReady()) {
    return { ok: false, message: '未找到 @playwright/test，请先在项目中安装依赖。' };
  }
  const root = studioRoot();
  // Always install ffmpeg alongside browsers — retain-on-failure video depends on it,
  // including when the workflow uses system Chrome / Edge.
  const browsers = target === 'all'
    ? ['chromium', 'firefox', 'webkit', 'ffmpeg']
    : [target, 'ffmpeg'];
  const { code, output } = await runPlaywrightCommand(['install', ...browsers], root);
  if (code === 0) {
    return {
      ok: true,
      message: target === 'all'
        ? 'Chromium / Firefox / WebKit / ffmpeg 已安装，可开始录制与回放。'
        : `${browsers.filter((name) => name !== 'ffmpeg').join(', ') || target} 与 ffmpeg 已安装（与当前 Playwright 版本对齐），可开始录制与回放。`,
    };
  }
  const detail = output.trim().split(/\r?\n/).slice(-12).join('\n');
  return {
    ok: false,
    message: detail || `浏览器/ffmpeg 安装失败（退出码 ${code}）。请检查网络后重试；本机 Chrome / Edge 可不装 Chromium，但仍需 ffmpeg。`,
  };
}

/** Rename leftover for future import tooling. */
export function importScriptFile(sourcePath: string, name: string, url: string): PlaywrightWorkflowDetail {
  if (!existsSync(sourcePath)) {
    throw new Error('源文件不存在。');
  }
  const id = randomUUID();
  const fileName = `${slugify(name)}.spec.ts`;
  const meta: PlaywrightWorkflowMeta = {
    id,
    name,
    url,
    browser: 'chromium',
    device: '',
    fileName,
    hasAuth: false,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    lastRunStatus: 'idle',
    notes: '从本地脚本导入',
  };
  mkdirSync(workflowDir(id), { recursive: true });
  renameSync(sourcePath, scriptPathFor(meta));
  writeMeta(meta);
  return getWorkflow(id);
}

/** Create a workflow from Playwright script text (for external agents). */
export function createWorkflowFromScript(input: {
  name: string;
  url: string;
  script: string;
  browser?: PlaywrightBrowser;
  device?: string;
  notes?: string;
}): PlaywrightWorkflowDetail {
  const name = input.name.trim() || 'agent-flow';
  const url = input.url.trim();
  const script = input.script.trim();
  if (!url) {
    throw new Error('请填写起始 URL。');
  }
  if (!script) {
    throw new Error('请提供 Playwright 脚本内容。');
  }
  try {
    // eslint-disable-next-line no-new
    new URL(url);
  } catch {
    throw new Error('URL 不合法。');
  }
  if (!/\btest\s*\(/.test(script) && !/\btest\.(only|skip|fix)\s*\(/.test(script)) {
    throw new Error('脚本里需要包含 Playwright 的 test(...) 用例。');
  }

  const id = randomUUID();
  const fileName = `${slugify(name)}.spec.ts`;
  const meta: PlaywrightWorkflowMeta = {
    id,
    name,
    url,
    browser: input.browser || 'chromium',
    device: (input.device || '').trim(),
    fileName,
    hasAuth: false,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    lastRunStatus: 'idle',
    lastRunMessage: '由外部 Agent 创建',
    notes: input.notes?.trim() || '由外部 Agent 写入脚本',
  };
  mkdirSync(workflowDir(id), { recursive: true });
  writeFileSync(scriptPathFor(meta), script.endsWith('\n') ? script : `${script}\n`, 'utf8');
  writeMeta(meta);
  return getWorkflow(id);
}
