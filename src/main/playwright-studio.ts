import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { app, shell } from 'electron';

const requireFromMain = createRequire(__filename);
import { PLAYWRIGHT_DEFAULT_SLOW_MO_MS } from '../shared/playwright';
import type {
  PlaywrightArtifact,
  PlaywrightArtifactKind,
  PlaywrightAssertRequest,
  PlaywrightAssertTemplate,
  PlaywrightBatchPlayRequest,
  PlaywrightBrowser,
  PlaywrightCaptureRequest,
  PlaywrightJobPhase,
  PlaywrightPlayRequest,
  PlaywrightRecordRequest,
  PlaywrightRunEvent,
  PlaywrightRunMode,
  PlaywrightScheduleConfig,
  PlaywrightStudioStatus,
  PlaywrightUpdateRequest,
  PlaywrightWorkflowDetail,
  PlaywrightWorkflowMeta,
} from '../shared/playwright';

type EventSink = (event: PlaywrightRunEvent) => void;

interface ActiveJob {
  kind: 'record' | 'play' | 'batch' | 'capture';
  workflowId: string;
  runId: string;
  startedAt: string;
  child: ChildProcessWithoutNullStreams | null;
}

const ASSERT_MARKER_START = '// --- Studio 断言助手 ---';
const ASSERT_MARKER_END = '// --- /Studio 断言助手 ---';
const DEFAULT_SCHEDULE: PlaywrightScheduleConfig = {
  enabled: false,
  intervalMinutes: 60,
  workflowIds: [],
  mode: 'headless',
  slowMoMs: 0,
};

let scheduleTimer: ReturnType<typeof setInterval> | null = null;
let scheduleRunning = false;

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
  mkdirSync(path.join(dir, 'artifacts'), { recursive: true });
  mkdirSync(path.join(dir, 'browser-profiles'), { recursive: true });
  ensureStudioScaffold(dir);
  return dir;
}

function artifactsRoot(): string {
  return path.join(studioRoot(), 'artifacts');
}

function artifactRunDir(workflowId: string, runId: string): string {
  const dir = path.join(artifactsRoot(), workflowId, runId);
  mkdirSync(dir, { recursive: true });
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
    // retries=0, so retain-on-failure (not on-first-retry) is required to keep traces.
    trace: 'retain-on-failure',
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

function normalizeSlowMoMs(value: unknown, fallback = 0): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.round(n);
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
    if (activeJob.kind === 'record') throw new Error('已有录制任务在进行。');
    if (activeJob.kind === 'capture') throw new Error('已有截图/PDF 任务在进行。');
    if (activeJob.kind === 'batch') throw new Error('已有批量回放在进行。');
    throw new Error('已有回放任务在进行。');
  }
}

function schedulePath(): string {
  return path.join(studioRoot(), 'schedule.json');
}

function readSchedule(): PlaywrightScheduleConfig {
  const file = schedulePath();
  if (!existsSync(file)) {
    return { ...DEFAULT_SCHEDULE };
  }
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<PlaywrightScheduleConfig>;
    return normalizeSchedule(raw);
  } catch {
    return { ...DEFAULT_SCHEDULE };
  }
}

function normalizeSchedule(raw: Partial<PlaywrightScheduleConfig>): PlaywrightScheduleConfig {
  const intervalMinutes = Math.max(1, Math.round(Number(raw.intervalMinutes) || DEFAULT_SCHEDULE.intervalMinutes));
  const workflowIds = Array.isArray(raw.workflowIds)
    ? raw.workflowIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
    : [];
  const mode = (['headed', 'headless', 'ui', 'debug'] as PlaywrightRunMode[]).includes(raw.mode as PlaywrightRunMode)
    ? (raw.mode as PlaywrightRunMode)
    : DEFAULT_SCHEDULE.mode;
  return {
    enabled: Boolean(raw.enabled),
    intervalMinutes,
    workflowIds,
    mode,
    slowMoMs: typeof raw.slowMoMs === 'number' ? normalizeSlowMoMs(raw.slowMoMs, 0) : DEFAULT_SCHEDULE.slowMoMs,
    lastRunAt: typeof raw.lastRunAt === 'string' ? raw.lastRunAt : undefined,
    nextRunAt: typeof raw.nextRunAt === 'string' ? raw.nextRunAt : undefined,
    lastMessage: typeof raw.lastMessage === 'string' ? raw.lastMessage : undefined,
  };
}

function writeSchedule(config: PlaywrightScheduleConfig): void {
  writeFileSync(schedulePath(), `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

function computeNextRunAt(from: Date, intervalMinutes: number): string {
  return new Date(from.getTime() + intervalMinutes * 60_000).toISOString();
}

async function runScheduledBatch(): Promise<void> {
  if (scheduleRunning || activeJob) {
    return;
  }
  const config = readSchedule();
  if (!config.enabled || config.workflowIds.length === 0) {
    return;
  }
  const now = new Date();
  if (config.nextRunAt && new Date(config.nextRunAt).getTime() > now.getTime()) {
    return;
  }
  scheduleRunning = true;
  try {
    const result = await playBatch({
      ids: config.workflowIds,
      mode: config.mode === 'ui' || config.mode === 'debug' ? 'headless' : config.mode,
      slowMoMs: config.slowMoMs,
    }, { wait: true });
    const failed = result.results.filter((item) => item.phase === 'failed').length;
    const passed = result.results.filter((item) => item.phase === 'passed').length;
    const next = normalizeSchedule({
      ...config,
      lastRunAt: nowIso(),
      nextRunAt: computeNextRunAt(new Date(), config.intervalMinutes),
      lastMessage: `定时回放完成：通过 ${passed}，失败 ${failed}`,
    });
    writeSchedule(next);
  } catch (error) {
    const next = normalizeSchedule({
      ...config,
      lastRunAt: nowIso(),
      nextRunAt: computeNextRunAt(new Date(), config.intervalMinutes),
      lastMessage: error instanceof Error ? error.message : '定时回放失败',
    });
    writeSchedule(next);
  } finally {
    scheduleRunning = false;
  }
}

export function ensureScheduleTimer(): void {
  if (scheduleTimer) {
    return;
  }
  // Tick every 30s; actual cadence is controlled by nextRunAt + intervalMinutes.
  scheduleTimer = setInterval(() => {
    void runScheduledBatch();
  }, 30_000);
  // Fire once shortly after boot if overdue.
  setTimeout(() => {
    void runScheduledBatch();
  }, 5_000);
}

function buildAssertBlock(meta: PlaywrightWorkflowMeta, templates: PlaywrightAssertTemplate[]): string {
  const set = new Set(templates.includes('all') ? (['url', 'title', 'body'] as PlaywrightAssertTemplate[]) : templates);
  const lines = [`  ${ASSERT_MARKER_START}`];
  if (set.has('url') && meta.url) {
    lines.push(`  await expect(page).toHaveURL(${JSON.stringify(meta.url)});`);
  }
  if (set.has('title')) {
    lines.push('  await expect(page).toHaveTitle(/.+/);');
  }
  if (set.has('body')) {
    lines.push("  await expect(page.locator('body')).toBeVisible();");
  }
  lines.push(`  ${ASSERT_MARKER_END}`);
  return `${lines.join('\n')}\n`;
}

function injectAssertBlock(script: string, block: string): string {
  const start = script.indexOf(ASSERT_MARKER_START);
  const end = script.indexOf(ASSERT_MARKER_END);
  if (start >= 0 && end > start) {
    const lineStart = script.lastIndexOf('\n', start);
    const lineEnd = script.indexOf('\n', end);
    const from = lineStart >= 0 ? lineStart + 1 : start;
    const to = lineEnd >= 0 ? lineEnd + 1 : script.length;
    return `${script.slice(0, from)}${block}${script.slice(to)}`;
  }

  // Insert before the last closing of the test callback: look for final `});`
  const closeIdx = script.lastIndexOf('});');
  if (closeIdx >= 0) {
    return `${script.slice(0, closeIdx)}${block}${script.slice(closeIdx)}`;
  }
  return `${script.trimEnd()}\n\n${block}`;
}

function resolvePlaywrightNodeModule(): string | null {
  const candidates = [
    path.join(app.getAppPath(), 'node_modules', 'playwright'),
    path.join(process.cwd(), 'node_modules', 'playwright'),
    path.join(studioRoot(), 'node_modules', 'playwright'),
  ];
  return candidates.find((dir) => existsSync(path.join(dir, 'index.js')) || existsSync(path.join(dir, 'package.json'))) || null;
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

function classifyArtifact(filePath: string): PlaywrightArtifactKind | null {
  const base = path.basename(filePath).toLowerCase();
  if (base.endsWith('.zip')) return 'trace';
  if (/\.(webm|mp4|mkv)$/i.test(base)) return 'video';
  if (/\.(png|jpe?g|webp)$/i.test(base)) return 'screenshot';
  if (base.endsWith('.pdf')) return 'pdf';
  return null;
}

function walkFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkFiles(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

function collectArtifacts(workflowId: string, runId: string): PlaywrightArtifact[] {
  const dir = path.join(artifactsRoot(), workflowId, runId);
  const files = walkFiles(dir);
  const list: PlaywrightArtifact[] = [];
  for (const file of files) {
    const kind = classifyArtifact(file);
    if (!kind) continue;
    try {
      const st = statSync(file);
      list.push({
        kind,
        name: path.basename(file),
        path: file,
        size: st.size,
        mtime: st.mtime.toISOString(),
        workflowId,
        runId,
      });
    } catch {
      // skip unreadable
    }
  }
  const rank: Record<PlaywrightArtifactKind, number> = {
    trace: 0,
    video: 1,
    screenshot: 2,
    pdf: 3,
    other: 4,
  };
  return list.sort((a, b) => {
    const byKind = rank[a.kind] - rank[b.kind];
    if (byKind !== 0) return byKind;
    return b.mtime.localeCompare(a.mtime);
  });
}

function writeRunConfig(options: {
  root: string;
  meta: PlaywrightWorkflowMeta;
  slowMoMs?: number;
  authFile?: string;
  videoEnabled?: boolean;
  outputDir?: string;
}): { configPath: string; testFilter: string } {
  // Keep config under studio root so relative paths stay predictable; testDir must be absolute
  // because Playwright resolves it against the config file location.
  const configPath = path.join(options.root, 'playwright.run.config.ts');
  const workflowsDir = path.join(options.root, 'workflows');
  const slowMo = Number(options.slowMoMs) > 0 ? Number(options.slowMoMs) : 0;
  const storageLine = options.authFile
    ? `storageState: ${JSON.stringify(options.authFile)},`
    : '';
  const outputLine = options.outputDir
    ? `outputDir: ${JSON.stringify(options.outputDir)},`
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
  ${outputLine}
  use: {
    ${storageLine}
    trace: 'retain-on-failure',
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
    schedule: readSchedule(),
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
  const slowMoMs = normalizeSlowMoMs(
    request.slowMoMs,
    PLAYWRIGHT_DEFAULT_SLOW_MO_MS,
  );
  const meta: PlaywrightWorkflowMeta = {
    id,
    name,
    url,
    browser,
    device,
    fileName,
    hasAuth: false,
    usePersistentProfile: usePersistentProfile || undefined,
    slowMoMs,
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

  // Prefer explicit request override; otherwise use the workflow's recorded preference.
  const browser = request.browser || meta.browser;
  const slowMoMs = request.slowMoMs !== undefined
    ? normalizeSlowMoMs(request.slowMoMs, 0)
    : normalizeSlowMoMs(meta.slowMoMs, PLAYWRIGHT_DEFAULT_SLOW_MO_MS);
  let metaDirty = false;
  if (meta.browser !== browser) {
    meta.browser = browser;
    metaDirty = true;
  }
  if (meta.slowMoMs !== slowMoMs) {
    meta.slowMoMs = slowMoMs;
    metaDirty = true;
  }
  if (metaDirty) {
    meta.updatedAt = nowIso();
    writeMeta(meta);
  }

  // Bundled browsers must match @playwright/test revision (e.g. chromium-1194).
  // System Chrome / Edge skip browser download, but ffmpeg is still required for video.
  const ensured = await ensurePlaywrightRuntime(browser);
  if (!ensured.ok) {
    throw new Error(
      `${ensured.message}\n请先点击「安装浏览器」，或在终端执行：npx playwright install chromium ffmpeg`,
    );
  }

  const mode = request.mode || 'headed';
  const { command, prefixArgs } = resolvePlaywrightCli();
  const authFile = authPathFor(meta.id);
  const runId = randomUUID();
  const outputDir = artifactRunDir(meta.id, runId);
  const { configPath, testFilter } = writeRunConfig({
    root,
    meta,
    slowMoMs,
    authFile: existsSync(authFile) ? authFile : undefined,
    videoEnabled: ensured.videoEnabled,
    outputDir,
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

  const logFile = path.join(root, 'runs', `${runId}.log`);
  const runtimeNote = ensured.videoEnabled
    ? 'video=retain-on-failure · trace=retain-on-failure'
    : 'video=off (ffmpeg missing) · trace=retain-on-failure';
  writeFileSync(
    logFile,
    `# play ${meta.id}\nbrowser=${meta.browser}\nscript=${scriptFile}\nfilter=${testFilter}\noutput=${outputDir}\n${runtimeNote}\n$ ${command} ${args.join(' ')}\n\n`,
    'utf8',
  );
  if (!ensured.videoEnabled && ensured.message) {
    writeFileSync(logFile, `${ensured.message}\n\n`, { flag: 'a', encoding: 'utf8' });
  }
  const waitPromise = options?.wait
    ? registerRunWaiter(runId, options.timeoutMs ?? 30 * 60 * 1000)
    : null;

  meta.updatedAt = nowIso();
  meta.lastRunId = runId;
  meta.lastRunStatus = 'running';
  meta.lastRunMessage = `回放中（${mode} · ${browser}）…`;
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
    const next = {
      ...readMeta(meta.id),
      updatedAt: nowIso(),
      lastRunId: runId,
      lastRunStatus: 'failed' as const,
      lastRunMessage: message,
      lastRunAt: nowIso(),
      lastArtifactCount: 0,
    };
    writeMeta(next);
    emit({ workflowId: meta.id, runId, phase: 'failed', percent: 0, message, artifacts: [] });
    activeJob = null;
  });

  child.on('close', (code) => {
    if (activeJob?.runId !== runId) {
      return;
    }
    activeJob = null;
    const artifacts = collectArtifacts(meta.id, runId);
    const current = readMeta(meta.id);
    current.updatedAt = nowIso();
    current.lastRunAt = nowIso();
    current.lastRunId = runId;
    current.lastArtifactCount = artifacts.length;
    if (code === 0) {
      current.lastRunStatus = 'passed';
      current.lastRunMessage = artifacts.length
        ? `回放通过（${artifacts.length} 个产物）`
        : '回放通过';
      writeMeta(current);
      emit({
        workflowId: meta.id,
        runId,
        phase: 'passed',
        percent: 100,
        message: current.lastRunMessage,
        exitCode: code,
        artifacts,
      });
    } else {
      const hasTrace = artifacts.some((item) => item.kind === 'trace');
      current.lastRunStatus = 'failed';
      current.lastRunMessage = hasTrace
        ? `回放失败（退出码 ${code}）。已生成 Trace，可在产物面板打开。`
        : artifacts.length
          ? `回放失败（退出码 ${code}）。已生成 ${artifacts.length} 个产物。`
          : `回放失败（退出码 ${code}）`;
      writeMeta(current);
      emit({
        workflowId: meta.id,
        runId,
        phase: 'failed',
        percent: 0,
        message: current.lastRunMessage,
        exitCode: code,
        artifacts,
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
  if (job.child) {
    try {
      job.child.kill('SIGTERM');
    } catch {
      // ignore
    }
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
  if (request.slowMoMs !== undefined) {
    meta.slowMoMs = normalizeSlowMoMs(request.slowMoMs, 0);
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
  const artifacts = path.join(artifactsRoot(), id);
  if (existsSync(artifacts)) {
    rmSync(artifacts, { recursive: true, force: true });
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

export function listArtifacts(workflowId: string): PlaywrightArtifact[] {
  if (!workflowId.trim()) {
    throw new Error('工作流 ID 无效。');
  }
  // Ensure workflow exists.
  readMeta(workflowId);
  const base = path.join(artifactsRoot(), workflowId);
  if (!existsSync(base)) {
    return [];
  }
  const runIds = readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  const all: PlaywrightArtifact[] = [];
  for (const runId of runIds) {
    all.push(...collectArtifacts(workflowId, runId));
  }
  return all.sort((a, b) => b.mtime.localeCompare(a.mtime));
}

export async function openTrace(artifactPath: string): Promise<void> {
  const file = (artifactPath || '').trim();
  if (!file || !existsSync(file)) {
    throw new Error('Trace 文件不存在。');
  }
  if (!file.toLowerCase().endsWith('.zip')) {
    throw new Error('请选择 .zip Trace 产物。');
  }
  const { command, prefixArgs } = resolvePlaywrightCli();
  const child = spawn(command, [...prefixArgs, 'show-trace', file], {
    cwd: studioRoot(),
    env: spawnEnv(command),
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  child.unref();
}

export async function revealArtifact(artifactPath: string): Promise<void> {
  const file = (artifactPath || '').trim();
  if (!file || !existsSync(file)) {
    throw new Error('产物文件不存在。');
  }
  shell.showItemInFolder(file);
}

export async function openArtifactsFolder(workflowId: string): Promise<void> {
  readMeta(workflowId);
  const dir = path.join(artifactsRoot(), workflowId);
  mkdirSync(dir, { recursive: true });
  await shell.openPath(dir);
}

function assertArtifactPath(artifactPath: string): { file: string; workflowId: string; runId: string } {
  const file = path.resolve((artifactPath || '').trim());
  if (!file) {
    throw new Error('产物路径无效。');
  }
  const root = path.resolve(artifactsRoot());
  const relative = path.relative(root, file);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('只能删除 Studio 产物目录内的文件。');
  }
  const parts = relative.split(path.sep).filter(Boolean);
  if (parts.length < 3) {
    throw new Error('产物路径不完整。');
  }
  const [workflowId, runId] = parts;
  readMeta(workflowId);
  if (!existsSync(file) || !statSync(file).isFile()) {
    throw new Error('产物文件不存在。');
  }
  return { file, workflowId, runId };
}

export function deleteArtifact(artifactPath: string): {
  deleted: true;
  path: string;
  workflowId: string;
} {
  const { file, workflowId, runId } = assertArtifactPath(artifactPath);
  rmSync(file, { force: true });

  // Clean empty parent dirs under this run / workflow artifacts folder.
  const runDir = path.join(artifactsRoot(), workflowId, runId);
  try {
    if (existsSync(runDir) && walkFiles(runDir).length === 0) {
      rmSync(runDir, { recursive: true, force: true });
    }
  } catch {
    // ignore cleanup failures
  }
  const workflowArtifacts = path.join(artifactsRoot(), workflowId);
  try {
    if (existsSync(workflowArtifacts) && readdirSync(workflowArtifacts).length === 0) {
      rmSync(workflowArtifacts, { recursive: true, force: true });
    }
  } catch {
    // ignore
  }

  try {
    const remaining = listArtifacts(workflowId);
    const meta = readMeta(workflowId);
    meta.lastArtifactCount = remaining.length;
    meta.updatedAt = nowIso();
    writeMeta(meta);
  } catch {
    // ignore meta update failures
  }

  return { deleted: true, path: file, workflowId };
}

function ensureExpectImport(script: string): string {
  const importRe = /import\s*\{([^}]*)\}\s*from\s*['"]@playwright\/test['"]/;
  const match = script.match(importRe);
  if (match) {
    if (/\bexpect\b/.test(match[1])) {
      return script;
    }
    const inner = match[1].trim().replace(/,$/, '');
    return script.replace(importRe, `import { ${inner}, expect } from '@playwright/test'`);
  }
  return `import { test, expect } from '@playwright/test';\n${script}`;
}

export function injectAsserts(request: PlaywrightAssertRequest): PlaywrightWorkflowDetail {
  const meta = readMeta(request.id);
  const templates = (request.templates && request.templates.length > 0)
    ? request.templates
    : (['all'] as PlaywrightAssertTemplate[]);
  const scriptFile = scriptPathFor(meta);
  if (!existsSync(scriptFile)) {
    throw new Error('脚本文件缺失。');
  }
  const original = readFileSync(scriptFile, 'utf8');
  const withImport = ensureExpectImport(original);
  const block = buildAssertBlock(meta, templates);
  const nextScript = injectAssertBlock(withImport, block);
  writeFileSync(scriptFile, nextScript.endsWith('\n') ? nextScript : `${nextScript}\n`, 'utf8');
  meta.updatedAt = nowIso();
  meta.lastRunMessage = '已插入断言模板';
  writeMeta(meta);
  return getWorkflow(meta.id);
}

async function openCapturePage(meta: PlaywrightWorkflowMeta): Promise<{
  close: () => Promise<void>;
  page: {
    goto: (url: string, options?: { waitUntil?: string; timeout?: number }) => Promise<unknown>;
    screenshot: (options: { path: string; fullPage?: boolean }) => Promise<Buffer>;
    pdf: (options: { path: string; format?: string; printBackground?: boolean }) => Promise<Buffer>;
  };
}> {
  const moduleDir = resolvePlaywrightNodeModule();
  if (!moduleDir) {
    throw new Error('未找到 playwright 模块，请先安装依赖。');
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const playwright = requireFromMain(moduleDir) as {
    chromium: { launch: (opts?: object) => Promise<unknown>; launchPersistentContext: (userDataDir: string, opts?: object) => Promise<unknown> };
    firefox: { launch: (opts?: object) => Promise<unknown> };
    webkit: { launch: (opts?: object) => Promise<unknown> };
  };

  const authFile = authPathFor(meta.id);
  const hasAuth = existsSync(authFile);
  const launchOpts: Record<string, unknown> = { headless: true };
  if (meta.browser === 'chrome' || meta.browser === 'msedge') {
    launchOpts.channel = meta.browser;
  }

  type PwPage = {
    goto: (url: string, options?: { waitUntil?: string; timeout?: number }) => Promise<unknown>;
    screenshot: (options: { path: string; fullPage?: boolean }) => Promise<Buffer>;
    pdf: (options: { path: string; format?: string; printBackground?: boolean }) => Promise<Buffer>;
  };
  type PwContext = {
    pages: () => PwPage[];
    newPage: () => Promise<PwPage>;
    close: () => Promise<void>;
  };
  type PwBrowser = {
    newContext: (opts?: object) => Promise<PwContext>;
    close: () => Promise<void>;
  };

  if (meta.usePersistentProfile) {
    const browserType = meta.browser === 'firefox'
      ? playwright.firefox
      : meta.browser === 'webkit'
        ? playwright.webkit
        : playwright.chromium;
    if (!('launchPersistentContext' in browserType)) {
      throw new Error('当前浏览器不支持持久目录截图，请改用 Chromium / Chrome / Edge。');
    }
    const context = await (browserType as typeof playwright.chromium).launchPersistentContext(
      persistentProfileDir(meta.browser),
      launchOpts,
    ) as PwContext;
    const page = context.pages()[0] || await context.newPage();
    return {
      page,
      close: async () => {
        await context.close();
      },
    };
  }

  const browserType = meta.browser === 'firefox'
    ? playwright.firefox
    : meta.browser === 'webkit'
      ? playwright.webkit
      : playwright.chromium;
  const browser = await browserType.launch(launchOpts) as PwBrowser;
  const context = await browser.newContext(hasAuth ? { storageState: authFile } : {});
  const page = await context.newPage();
  return {
    page,
    close: async () => {
      await context.close();
      await browser.close();
    },
  };
}

export async function capturePage(request: PlaywrightCaptureRequest): Promise<{
  runId: string;
  artifacts: PlaywrightArtifact[];
  workflow: PlaywrightWorkflowDetail;
}> {
  assertNoActiveJob();
  if (!playwrightReady()) {
    throw new Error('未找到 Playwright。请先安装依赖并点击「安装浏览器」。');
  }
  const meta = readMeta(request.id);
  if (!meta.url?.trim()) {
    throw new Error('工作流缺少起始 URL，无法采集。');
  }
  const ensured = await ensurePlaywrightRuntime(meta.browser);
  if (!ensured.ok) {
    throw new Error(ensured.message);
  }

  const kind = request.kind === 'pdf' ? 'pdf' : 'screenshot';
  if (kind === 'pdf' && (meta.browser === 'firefox' || meta.browser === 'webkit')) {
    throw new Error('PDF 采集仅支持 Chromium / Chrome / Edge。');
  }

  const runId = randomUUID();
  const outputDir = artifactRunDir(meta.id, runId);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const fileName = kind === 'pdf' ? `capture-${stamp}.pdf` : `capture-${stamp}.png`;
  const filePath = path.join(outputDir, fileName);

  activeJob = {
    kind: 'capture',
    workflowId: meta.id,
    runId,
    startedAt: nowIso(),
    child: null,
  };

  const emitCapture = (percent: number, message: string, phase: PlaywrightJobPhase = 'running'): void => {
    emit({ workflowId: meta.id, runId, phase, percent, message });
  };

  emitCapture(6, kind === 'pdf' ? '准备导出 PDF…' : '准备截图…');

  let session: Awaited<ReturnType<typeof openCapturePage>> | null = null;
  try {
    emitCapture(18, `启动 ${meta.browser}…`);
    session = await openCapturePage(meta);

    emitCapture(42, '打开页面并等待加载…');
    await session.page.goto(meta.url, { waitUntil: 'networkidle', timeout: 60_000 });

    emitCapture(68, kind === 'pdf' ? '渲染并导出 PDF…' : '捕获整页截图…');
    if (kind === 'pdf') {
      await session.page.pdf({ path: filePath, format: 'A4', printBackground: true });
    } else {
      await session.page.screenshot({
        path: filePath,
        fullPage: request.fullPage !== false,
      });
    }

    emitCapture(88, '关闭浏览器并归档产物…');
    await session.close();
    session = null;

    const artifacts = collectArtifacts(meta.id, runId);
    const current = readMeta(meta.id);
    current.updatedAt = nowIso();
    current.lastRunAt = nowIso();
    current.lastRunId = runId;
    current.lastRunStatus = 'passed';
    current.lastArtifactCount = artifacts.length;
    current.lastRunMessage = kind === 'pdf' ? `已生成 PDF（${fileName}）` : `已截图（${fileName}）`;
    writeMeta(current);
    activeJob = null;
    emit({
      workflowId: meta.id,
      runId,
      phase: 'passed',
      percent: 100,
      message: current.lastRunMessage,
      artifacts,
    });
    return { runId, artifacts, workflow: getWorkflow(meta.id) };
  } catch (error) {
    if (session) {
      try {
        await session.close();
      } catch {
        // ignore
      }
    }
    const message = error instanceof Error ? error.message : '采集失败';
    const current = readMeta(meta.id);
    current.updatedAt = nowIso();
    current.lastRunAt = nowIso();
    current.lastRunId = runId;
    current.lastRunStatus = 'failed';
    current.lastRunMessage = message;
    current.lastArtifactCount = 0;
    writeMeta(current);
    activeJob = null;
    emit({
      workflowId: meta.id,
      runId,
      phase: 'failed',
      percent: 0,
      message,
      artifacts: [],
    });
    throw error;
  }
}

export async function playBatch(
  request: PlaywrightBatchPlayRequest,
  options?: { wait?: boolean },
): Promise<{
  runId: string;
  results: Array<{ id: string; phase: PlaywrightJobPhase; message: string }>;
}> {
  assertNoActiveJob();
  const ids = (request.ids || []).map((id) => id.trim()).filter(Boolean);
  if (ids.length === 0) {
    throw new Error('请至少选择一个工作流。');
  }
  for (const id of ids) {
    readMeta(id);
  }

  const runId = randomUUID();
  const mode = request.mode || 'headless';
  const wait = options?.wait !== false;
  const results: Array<{ id: string; phase: PlaywrightJobPhase; message: string }> = [];

  activeJob = {
    kind: 'batch',
    workflowId: ids[0],
    runId,
    startedAt: nowIso(),
    child: null,
  };
  emit({
    workflowId: ids[0],
    runId,
    phase: 'running',
    percent: 5,
    message: `批量回放开始（${ids.length} 条 · ${mode}）`,
  });

  try {
    for (let index = 0; index < ids.length; index += 1) {
      const id = ids[index];
      // Release batch lock so playWorkflow can become the active job.
      activeJob = null;
      emit({
        workflowId: id,
        runId,
        phase: 'running',
        percent: Math.round(((index + 0.2) / ids.length) * 100),
        message: `批量回放 ${index + 1}/${ids.length}`,
      });
      try {
        const played = await playWorkflow(
          { id, mode, browser: request.browser, slowMoMs: request.slowMoMs },
          { wait },
        );
        const phase = played.runEvent?.phase || 'passed';
        const message = played.runEvent?.message || '回放完成';
        results.push({ id, phase, message });
      } catch (error) {
        results.push({
          id,
          phase: 'failed',
          message: error instanceof Error ? error.message : '回放失败',
        });
      }
      if (index < ids.length - 1) {
        activeJob = {
          kind: 'batch',
          workflowId: ids[index + 1],
          runId,
          startedAt: nowIso(),
          child: null,
        };
      }
    }
  } finally {
    activeJob = null;
  }

  const failed = results.filter((item) => item.phase === 'failed' || item.phase === 'stopped').length;
  const passed = results.filter((item) => item.phase === 'passed').length;
  const summary = `批量回放结束：通过 ${passed}，失败 ${failed}`;
  emit({
    workflowId: ids[0],
    runId,
    phase: failed > 0 ? 'failed' : 'passed',
    percent: 100,
    message: summary,
  });
  return { runId, results };
}

export function getSchedule(): PlaywrightScheduleConfig {
  return readSchedule();
}

export function setSchedule(partial: Partial<PlaywrightScheduleConfig>): PlaywrightScheduleConfig {
  const current = readSchedule();
  const next = normalizeSchedule({
    enabled: partial.enabled !== undefined ? partial.enabled : current.enabled,
    intervalMinutes: partial.intervalMinutes !== undefined ? partial.intervalMinutes : current.intervalMinutes,
    workflowIds: partial.workflowIds !== undefined ? partial.workflowIds : current.workflowIds,
    mode: partial.mode !== undefined ? partial.mode : current.mode,
    slowMoMs: partial.slowMoMs !== undefined ? partial.slowMoMs : current.slowMoMs,
    lastRunAt: current.lastRunAt,
    nextRunAt: current.nextRunAt,
    lastMessage: current.lastMessage,
  });
  if (next.enabled && next.workflowIds.length === 0) {
    throw new Error('启用定时回放前请先选择至少一个工作流。');
  }
  if (next.enabled) {
    next.nextRunAt = current.nextRunAt && new Date(current.nextRunAt).getTime() > Date.now()
      ? current.nextRunAt
      : computeNextRunAt(new Date(), next.intervalMinutes);
    next.lastMessage = `定时已开启，每 ${next.intervalMinutes} 分钟执行一次`;
  } else {
    next.nextRunAt = undefined;
    next.lastMessage = '定时已关闭';
  }
  writeSchedule(next);
  ensureScheduleTimer();
  return next;
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
    slowMoMs: PLAYWRIGHT_DEFAULT_SLOW_MO_MS,
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
    slowMoMs: PLAYWRIGHT_DEFAULT_SLOW_MO_MS,
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
