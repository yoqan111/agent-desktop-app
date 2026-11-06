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
import { createHash, randomUUID } from 'node:crypto';
import { app, shell } from 'electron';

const requireFromMain = createRequire(__filename);
import { PLAYWRIGHT_DEFAULT_SLOW_MO_MS } from '../shared/playwright';
import type {
  PlaywrightArtifact,
  PlaywrightArtifactKind,
  PlaywrightAssertRequest,
  PlaywrightAssertTemplate,
  PlaywrightAuthBeforePlay,
  PlaywrightBaselineCompareResult,
  PlaywrightBaselineInfo,
  PlaywrightBatchPlayRequest,
  PlaywrightBrowser,
  PlaywrightCaptureRequest,
  PlaywrightJobPhase,
  PlaywrightPlayRequest,
  PlaywrightRecordRequest,
  PlaywrightRunEvent,
  PlaywrightRunMode,
  PlaywrightRunWithParamsRequest,
  PlaywrightSaveBaselineRequest,
  PlaywrightSaveReportRequest,
  PlaywrightScheduleConfig,
  PlaywrightScriptStep,
  PlaywrightScriptStepKind,
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
    screenshot: 'off',
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
  const meta = JSON.parse(readFileSync(file, 'utf8')) as PlaywrightWorkflowMeta;
  // Always sync from disk — meta.hasAuth can go stale after manual deletes / failed saves.
  meta.hasAuth = existsSync(authPathFor(id));
  return meta;
}

function writeMeta(meta: PlaywrightWorkflowMeta): void {
  const dir = workflowDir(meta.id);
  mkdirSync(dir, { recursive: true });
  const next: PlaywrightWorkflowMeta = {
    ...meta,
    hasAuth: existsSync(authPathFor(meta.id)),
  };
  writeFileSync(metaPath(meta.id), `${JSON.stringify(next, null, 2)}\n`, 'utf8');
}

function scriptPathFor(meta: PlaywrightWorkflowMeta): string {
  return path.join(workflowDir(meta.id), meta.fileName);
}

function authPathFor(id: string): string {
  return path.join(studioRoot(), 'auth', `${id}.json`);
}

function normalizeAuthBeforePlay(value: unknown): PlaywrightAuthBeforePlay {
  if (value === 'always' || value === 'off' || value === 'if-missing-auth') {
    return value;
  }
  return 'if-missing-auth';
}

function injectStorageSave(script: string, outPath: string): string {
  const line = `  await page.context().storageState({ path: ${JSON.stringify(outPath)} });\n`;
  const marker = '// --- Studio 保存登录态 ---';
  if (script.includes(marker)) {
    return script;
  }
  const block = `  ${marker}\n${line}`;
  const closeIdx = script.lastIndexOf('});');
  if (closeIdx >= 0) {
    return `${script.slice(0, closeIdx)}${block}${script.slice(closeIdx)}`;
  }
  return `${script.trimEnd()}\n${block}\n`;
}

/** Enable HAR capture for a temp play script via Playwright test.use contextOptions. */
function injectHarRecording(script: string, harPath: string): string {
  const marker = '// --- Studio HAR ---';
  if (script.includes(marker)) {
    return script;
  }
  const block = `${marker}
test.use({
  contextOptions: {
    recordHar: { path: ${JSON.stringify(harPath)}, mode: 'minimal' },
  },
});
`;
  const importRe = /import\s*\{[^}]*\}\s*from\s*['"]@playwright\/test['"]\s*;?/;
  const match = script.match(importRe);
  if (match && typeof match.index === 'number') {
    const insertAt = match.index + match[0].length;
    return `${script.slice(0, insertAt)}\n${block}${script.slice(insertAt)}`;
  }
  return `import { test, expect } from '@playwright/test';\n${block}${script}`;
}

function quoteScriptString(value: string, prefer: '"' | "'" = "'"): string {
  if (prefer === "'") {
    return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  }
  return JSON.stringify(value);
}

function lineNumberAt(script: string, index: number): number {
  return script.slice(0, Math.max(0, index)).split(/\n/).length;
}

function hintFromTarget(target: string): string {
  const text = target.trim();
  const getBy = text.match(/getBy(?:Label|Placeholder|Text|Role|TestId)\(\s*(['"`])([^'"`]+)\1/i);
  if (getBy) return getBy[2];
  const nameOpt = text.match(/name:\s*(['"`])([^'"`]+)\1/);
  if (nameOpt) return nameOpt[2];
  const css = text.match(/(['"`])([^'"`]+)\1/);
  if (css) return css[2].slice(0, 48);
  return text.slice(0, 48);
}

/** Parse recorded script for editable goto/fill/type/selectOption values. */
export function extractScriptSteps(script: string): PlaywrightScriptStep[] {
  const steps: PlaywrightScriptStep[] = [];
  const patterns: Array<{ kind: PlaywrightScriptStepKind; re: RegExp }> = [
    {
      kind: 'goto',
      re: /\.goto\(\s*(['"`])([^'"`]*?)\1/g,
    },
    {
      kind: 'fill',
      re: /\.fill\(\s*((?:[^,()]|\([^)]*\))+?)\s*,\s*(['"`])([^'"`]*?)\2/g,
    },
    {
      kind: 'type',
      re: /\.type\(\s*((?:[^,()]|\([^)]*\))+?)\s*,\s*(['"`])([^'"`]*?)\2/g,
    },
    {
      kind: 'select',
      re: /\.selectOption\(\s*((?:[^,()]|\([^)]*\))+?)\s*,\s*(['"`])([^'"`]*?)\2/g,
    },
  ];

  for (const { kind, re } of patterns) {
    re.lastIndex = 0;
    let match = re.exec(script);
    while (match) {
      const fullIndex = match.index;
      let target = '';
      let value = '';
      if (kind === 'goto') {
        target = 'page.goto';
        value = match[2] || '';
      } else {
        target = (match[1] || '').trim();
        value = match[3] || '';
      }
      const id = `${kind}-${steps.length}`;
      steps.push({
        id,
        index: steps.length,
        kind,
        target,
        value,
        line: lineNumberAt(script, fullIndex),
        hint: kind === 'goto' ? '起始 URL' : hintFromTarget(target),
      });
      match = re.exec(script);
    }
  }

  return steps.sort((a, b) => (a.line || 0) - (b.line || 0)).map((step, index) => ({
    ...step,
    index,
    id: `${step.kind}-${index}`,
  }));
}

function resolveParamForStep(
  step: PlaywrightScriptStep,
  params: Record<string, string>,
): string | undefined {
  const entries = Object.entries(params);
  if (!entries.length) return undefined;

  const direct = params[step.id] ?? params[String(step.index)] ?? params[`#${step.index}`];
  if (typeof direct === 'string') return direct;

  if (step.hint) {
    const byHint = params[step.hint] ?? params[`${step.kind}:${step.hint}`];
    if (typeof byHint === 'string') return byHint;
  }

  const targetKey = entries.find(([key]) => {
    const k = key.trim().toLowerCase();
    if (!k) return false;
    return step.target.toLowerCase().includes(k)
      || (step.hint || '').toLowerCase().includes(k)
      || k === step.kind
      || k === `${step.kind}${step.index}`;
  });
  if (targetKey) return targetKey[1];

  // Chinese / loose labels: 邮箱、密码、用户名、标题、url
  const labelMap: Array<{ keys: string[]; pred: (s: PlaywrightScriptStep) => boolean }> = [
    { keys: ['url', '链接', '地址', '页面'], pred: (s) => s.kind === 'goto' },
    { keys: ['邮箱', 'email', 'mail'], pred: (s) => /email|mail|邮箱/i.test(`${s.target} ${s.hint}`) },
    { keys: ['密码', 'password', 'pwd'], pred: (s) => /pass|pwd|密码/i.test(`${s.target} ${s.hint}`) },
    { keys: ['用户名', '账号', 'user', 'username', 'account'], pred: (s) => /user|account|name|账号|用户/i.test(`${s.target} ${s.hint}`) },
    { keys: ['手机', '电话', 'phone', 'mobile', 'tel'], pred: (s) => /phone|mobile|tel|手机/i.test(`${s.target} ${s.hint}`) },
    { keys: ['标题', 'title', '主题'], pred: (s) => /title|标题|主题/i.test(`${s.target} ${s.hint}`) },
  ];
  for (const item of labelMap) {
    if (!item.pred(step)) continue;
    for (const key of item.keys) {
      const hit = entries.find(([k]) => k.trim().toLowerCase() === key.toLowerCase());
      if (hit) return hit[1];
    }
  }
  return undefined;
}

/** Replace literal values in script for matched steps. Returns new script + applied diffs. */
export function applyParamsToScript(
  script: string,
  params: Record<string, string>,
): { script: string; applied: Array<{ stepId: string; from: string; to: string }>; steps: PlaywrightScriptStep[] } {
  const steps = extractScriptSteps(script);
  const applied: Array<{ stepId: string; from: string; to: string }> = [];
  if (!steps.length || !Object.keys(params).length) {
    return { script, applied, steps };
  }

  let nextScript = script;
  const ordered = [...steps].sort((a, b) => (b.line || 0) - (a.line || 0));
  for (const step of ordered) {
    const to = resolveParamForStep(step, params);
    if (to === undefined || to === step.value) continue;
    const escaped = step.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let replaced = false;
    if (step.kind === 'goto') {
      const re = new RegExp(`(\\.goto\\(\\s*)(['"\`])${escaped}\\2`);
      nextScript = nextScript.replace(re, (full, prefix: string, q: string) => {
        if (replaced) return full;
        replaced = true;
        return `${prefix}${quoteScriptString(to, q === '"' ? '"' : "'")}`;
      });
    } else {
      const method = step.kind === 'fill' ? 'fill' : step.kind === 'type' ? 'type' : 'selectOption';
      const re = new RegExp(`(\\.${method}\\(\\s*)([\\s\\S]*?)(,\\s*)(['"\`])${escaped}\\4(\\s*\\))`);
      nextScript = nextScript.replace(re, (full, prefix: string, target: string, comma: string, q: string, suffix: string) => {
        if (replaced) return full;
        if (step.target && !target.includes(step.target.slice(0, Math.min(12, step.target.length))) && step.target.length > 6) {
          return full;
        }
        replaced = true;
        return `${prefix}${target}${comma}${quoteScriptString(to, q === '"' ? '"' : "'")}${suffix}`;
      });
    }
    if (replaced) {
      applied.push({ stepId: step.id, from: step.value, to });
    }
  }

  return {
    script: nextScript,
    applied: applied.reverse(),
    steps: extractScriptSteps(nextScript),
  };
}

export function listScriptSteps(workflowId: string): PlaywrightScriptStep[] {
  const detail = getWorkflow(workflowId);
  return extractScriptSteps(detail.script || '');
}

export async function runWithParams(
  request: PlaywrightRunWithParamsRequest,
  options?: { wait?: boolean; timeoutMs?: number },
): Promise<{
  runId: string;
  applied: Array<{ stepId: string; from: string; to: string }>;
  steps: PlaywrightScriptStep[];
  runEvent?: import('../shared/playwright').PlaywrightRunEvent;
}> {
  const meta = readMeta(request.workflowId);
  const scriptFile = scriptPathFor(meta);
  if (!existsSync(scriptFile)) {
    throw new Error('脚本文件缺失。');
  }
  const original = readFileSync(scriptFile, 'utf8');
  const { script: patched, applied, steps } = applyParamsToScript(original, request.params || {});
  if (request.persistScript) {
    writeFileSync(scriptFile, patched.endsWith('\n') ? patched : `${patched}\n`, 'utf8');
    meta.updatedAt = nowIso();
    meta.lastRunMessage = applied.length
      ? `已按参数更新脚本（${applied.length} 处）并准备回放`
      : '参数未匹配到可替换步骤，将按原脚本回放';
    writeMeta(meta);
  }

  let tempScriptPath: string | null = null;
  let overrideId: string | null = null;
  try {
    if (!request.persistScript && applied.length > 0) {
      const runToken = randomUUID().slice(0, 8);
      overrideId = `__studio_params_${runToken}`;
      tempScriptPath = path.join(workflowDir(meta.id), `${overrideId}.spec.ts`);
      writeFileSync(tempScriptPath, patched.endsWith('\n') ? patched : `${patched}\n`, 'utf8');
    }

    // If we wrote a temp script, point play at a temporary workflow copy via update+play is heavy.
    // Instead: briefly swap script file content, play, restore — unless persistScript.
    let restoreScript: string | null = null;
    if (tempScriptPath && !request.persistScript) {
      restoreScript = original;
      writeFileSync(scriptFile, patched.endsWith('\n') ? patched : `${patched}\n`, 'utf8');
    }

    try {
      const played = await playWorkflow({
        id: meta.id,
        mode: request.mode || 'headed',
        browser: request.browser || meta.browser,
        slowMoMs: request.slowMoMs ?? meta.slowMoMs,
        recordHar: request.recordHar,
      }, {
        wait: options?.wait ?? true,
        timeoutMs: options?.timeoutMs ?? 30 * 60 * 1000,
      });
      return {
        runId: played.runId,
        applied,
        steps,
        runEvent: played.runEvent,
      };
    } finally {
      if (restoreScript != null) {
        writeFileSync(scriptFile, restoreScript.endsWith('\n') ? restoreScript : `${restoreScript}\n`, 'utf8');
      }
      if (tempScriptPath && existsSync(tempScriptPath)) {
        try {
          rmSync(tempScriptPath, { force: true });
        } catch {
          // ignore
        }
      }
    }
  } catch (error) {
    if (tempScriptPath && existsSync(tempScriptPath)) {
      try {
        rmSync(tempScriptPath, { force: true });
      } catch {
        // ignore
      }
    }
    throw error;
  }
}

function scriptHashFor(workflowId: string): string {
  try {
    const meta = readMeta(workflowId);
    const scriptFile = scriptPathFor(meta);
    if (!existsSync(scriptFile)) return '';
    return createHash('sha1').update(readFileSync(scriptFile)).digest('hex').slice(0, 16);
  } catch {
    return '';
  }
}

function baselineDir(workflowId: string): string {
  return path.join(workflowDir(workflowId), 'baseline');
}

function baselineMetaPath(workflowId: string): string {
  return path.join(baselineDir(workflowId), 'baseline.json');
}

function readLogExcerpt(runId: string, maxChars = 2500): string {
  const logFile = path.join(studioRoot(), 'runs', `${runId}.log`);
  if (!existsSync(logFile)) return '';
  try {
    const text = readFileSync(logFile, 'utf8');
    return text.length > maxChars ? text.slice(-maxChars) : text;
  } catch {
    return '';
  }
}

/** Export cookies/localStorage from Studio persistent profile into a storageState JSON. */
async function exportStorageFromPersistentProfile(
  browser: PlaywrightBrowser,
  outPath: string,
): Promise<boolean> {
  const profileDir = persistentProfileDir(browser);
  if (!existsSync(profileDir)) {
    return false;
  }
  const moduleDir = resolvePlaywrightNodeModule();
  if (!moduleDir) {
    return false;
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const playwright = requireFromMain(moduleDir) as {
    chromium: { launchPersistentContext: (userDataDir: string, opts?: object) => Promise<{
      storageState: (opts: { path: string }) => Promise<unknown>;
      close: () => Promise<void>;
    }> };
    firefox: { launchPersistentContext?: (userDataDir: string, opts?: object) => Promise<{
      storageState: (opts: { path: string }) => Promise<unknown>;
      close: () => Promise<void>;
    }> };
    webkit: { launchPersistentContext?: (userDataDir: string, opts?: object) => Promise<{
      storageState: (opts: { path: string }) => Promise<unknown>;
      close: () => Promise<void>;
    }> };
  };

  const launchOpts: Record<string, unknown> = { headless: true };
  if (browser === 'chrome' || browser === 'msedge') {
    launchOpts.channel = browser;
  }

  const browserType = browser === 'firefox'
    ? playwright.firefox
    : browser === 'webkit'
      ? playwright.webkit
      : playwright.chromium;
  if (!browserType?.launchPersistentContext) {
    return false;
  }

  let context: {
    storageState: (opts: { path: string }) => Promise<unknown>;
    close: () => Promise<void>;
  } | null = null;
  try {
    context = await browserType.launchPersistentContext(profileDir, launchOpts);
    mkdirSync(path.dirname(outPath), { recursive: true });
    await context.storageState({ path: outPath });
    return existsSync(outPath);
  } catch {
    return false;
  } finally {
    if (context) {
      try {
        await context.close();
      } catch {
        // ignore
      }
    }
  }
}

async function ensureAuthFileForPlay(meta: PlaywrightWorkflowMeta): Promise<string | null> {
  const authFile = authPathFor(meta.id);
  if (existsSync(authFile)) {
    return authFile;
  }
  if (!meta.usePersistentProfile) {
    return null;
  }
  const exported = await exportStorageFromPersistentProfile(meta.browser, authFile);
  if (exported) {
    const next = readMeta(meta.id);
    next.hasAuth = true;
    next.updatedAt = nowIso();
    writeMeta(next);
    return authFile;
  }
  return null;
}

function assertNoAuthCycle(workflowId: string, authWorkflowId: string): void {
  if (workflowId === authWorkflowId) {
    throw new Error('不能把自身设为登录前置工作流。');
  }
  const seen = new Set<string>([workflowId]);
  let current: string | undefined = authWorkflowId;
  while (current) {
    if (seen.has(current)) {
      throw new Error('登录前置工作流存在循环引用，请检查配置。');
    }
    seen.add(current);
    let meta: PlaywrightWorkflowMeta;
    try {
      meta = readMeta(current);
    } catch {
      throw new Error('登录前置工作流不存在。');
    }
    current = meta.authWorkflowId;
  }
}

function shouldRunAuthPrecondition(meta: PlaywrightWorkflowMeta): boolean {
  const authId = (meta.authWorkflowId || '').trim();
  if (!authId) return false;
  const policy = normalizeAuthBeforePlay(meta.authBeforePlay);
  if (policy === 'off') return false;
  if (policy === 'always') return true;
  return !existsSync(authPathFor(meta.id));
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
  if (base.endsWith('.har')) return 'har';
  if (base.endsWith('.md') || base.startsWith('report-') || base.includes('.report.')) return 'report';
  if (base === 'baseline.json' || base.startsWith('baseline-')) return 'baseline';
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
    har: 4,
    report: 5,
    baseline: 6,
    other: 7,
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
    screenshot: 'off',
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

  // --load-storage (storageState JSON) conflicts with --user-data-dir persistent context.
  // Prefer explicit login-state reuse when the user picked one.
  const loadAuthFromId = request.loadAuthFromId?.trim() || '';
  if (loadAuthFromId) {
    const loadPath = authPathFor(loadAuthFromId);
    if (!existsSync(loadPath)) {
      throw new Error('指定的登录态文件不存在。请先在对应工作流录制并保存登录态，或在详情页「刷新登录态」。');
    }
    args.push('--load-storage', loadPath);
  } else if (usePersistentProfile) {
    // Persistent profile keeps cookies across recordings (Studio-owned dir, not daily Chrome).
    args.push('--user-data-dir', persistentProfileDir(browser));
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
    message: loadAuthFromId
      ? `已启动 Codegen（已加载登录态：${loadAuthFromId.slice(0, 8)}…），请在弹出的浏览器中操作`
      : usePersistentProfile
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
    const finish = async () => {
      const current = readMeta(id);
      // If codegen wrote nothing beyond starter, keep starter; otherwise keep recorded script.
      if (saveAuth && existsSync(authOut)) {
        current.hasAuth = true;
      }
      // Persistent profile login lives in user-data-dir; export storageState so playback can reuse it.
      if ((code === 0 || code === null) && usePersistentProfile && !existsSync(authOut)) {
        const exported = await exportStorageFromPersistentProfile(browser, authOut);
        if (exported) {
          current.hasAuth = true;
        }
      } else if ((code === 0 || code === null) && usePersistentProfile && existsSync(authOut)) {
        current.hasAuth = true;
      }
      current.updatedAt = nowIso();
      current.lastRunAt = nowIso();
      if (code === 0 || code === null) {
        current.lastRunStatus = 'idle';
        current.lastRunMessage = current.hasAuth
          ? '录制结束，已保存登录态，可回放或编辑脚本'
          : '录制结束，可回放或编辑脚本';
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
    };
    void finish();
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

  // Login precondition: run linked auth workflow first, then refresh this workflow's storageState.
  if (!request.skipAuthPrecondition && shouldRunAuthPrecondition(meta)) {
    const authId = (meta.authWorkflowId || '').trim();
    assertNoAuthCycle(meta.id, authId);
    readMeta(authId);
    const authMode: PlaywrightRunMode = (request.mode === 'ui' || request.mode === 'debug')
      ? 'headed'
      : (request.mode || 'headed');
    const targetAuthPath = authPathFor(meta.id);
    mkdirSync(path.dirname(targetAuthPath), { recursive: true });
    emit({
      workflowId: meta.id,
      runId: 'auth-precondition',
      phase: 'running',
      percent: 3,
      message: `先执行登录前置工作流…`,
    });
    const authPlay = await playWorkflow({
      id: authId,
      mode: authMode,
      browser,
      slowMoMs,
      skipAuthPrecondition: true,
      saveStorageTo: targetAuthPath,
    }, { wait: true, timeoutMs: options?.timeoutMs });
    if (authPlay.runEvent?.phase !== 'passed') {
      const message = authPlay.runEvent?.message || '登录前置工作流失败';
      const failed = readMeta(meta.id);
      failed.updatedAt = nowIso();
      failed.lastRunAt = nowIso();
      failed.lastRunStatus = 'failed';
      failed.lastRunMessage = `登录前置失败：${message}`;
      writeMeta(failed);
      emit({
        workflowId: meta.id,
        runId: authPlay.runId,
        phase: 'failed',
        percent: 0,
        message: failed.lastRunMessage,
      });
      throw new Error(failed.lastRunMessage);
    }
    if (existsSync(targetAuthPath)) {
      const next = readMeta(meta.id);
      next.hasAuth = true;
      next.updatedAt = nowIso();
      writeMeta(next);
    }
    emit({
      workflowId: meta.id,
      runId: authPlay.runId,
      phase: 'running',
      percent: 8,
      message: '登录态已刷新，开始回放业务流…',
    });
  }

  assertNoActiveJob();

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
  // Prefer existing storageState; if missing but recorded with a persistent profile, export once.
  const authFile = (await ensureAuthFileForPlay(meta)) || authPathFor(meta.id);
  const runId = randomUUID();
  const outputDir = artifactRunDir(meta.id, runId);
  mkdirSync(outputDir, { recursive: true });
  // Default: refresh storageState after successful play so the next run keeps cookies.
  const saveStorageTo = (request.saveStorageTo || '').trim()
    || (request.saveAuthAfterPlay === false ? '' : authPathFor(meta.id));
  const recordHar = request.recordHar === true;
  const saveBaselineAfterPass = request.saveBaseline === true;
  const harPath = recordHar ? path.join(outputDir, 'network.har') : '';
  let tempScriptPath: string | null = null;
  let testFilterOverride: string | null = null;
  if (saveStorageTo || recordHar) {
    if (saveStorageTo) {
      mkdirSync(path.dirname(saveStorageTo), { recursive: true });
    }
    let patched = readFileSync(scriptFile, 'utf8');
    if (recordHar) {
      patched = injectHarRecording(patched, harPath);
    }
    if (saveStorageTo) {
      patched = injectStorageSave(patched, saveStorageTo);
    }
    tempScriptPath = path.join(workflowDir(meta.id), `__studio_save_${runId}.spec.ts`);
    writeFileSync(tempScriptPath, patched.endsWith('\n') ? patched : `${patched}\n`, 'utf8');
    testFilterOverride = `__studio_save_${runId}`;
  }
  const { configPath, testFilter } = writeRunConfig({
    root,
    meta,
    slowMoMs,
    // Always load cookies when available (including runs that also save state at the end).
    authFile: existsSync(authFile) ? authFile : undefined,
    videoEnabled: ensured.videoEnabled,
    outputDir,
  });
  const effectiveFilter = testFilterOverride || testFilter;

  // Pass filter relative to testDir. Absolute paths are treated as RegExp and break discovery.
  const args = [...prefixArgs, 'test', effectiveFilter, '--config', configPath];

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
  const runtimeNote = [
    'screenshot=off',
    ensured.videoEnabled ? 'video=retain-on-failure' : 'video=off (ffmpeg missing)',
    'trace=retain-on-failure',
    recordHar ? 'har=on' : 'har=off',
  ].join(' · ');
  writeFileSync(
    logFile,
    `# play ${meta.id}\nbrowser=${meta.browser}\nscript=${scriptFile}\nfilter=${effectiveFilter}\noutput=${outputDir}\nauth=${existsSync(authFile) ? authFile : '-'}\nsaveStorage=${saveStorageTo || '-'}\nsaveBaseline=${saveBaselineAfterPass}\n${runtimeNote}\n$ ${command} ${args.join(' ')}\n\n`,
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
    message: [
      `开始回放 · ${mode}`,
      existsSync(authFile) ? '已加载登录态' : null,
      saveStorageTo ? '结束后将刷新登录态' : null,
      recordHar ? '将录制 HAR' : null,
      saveBaselineAfterPass ? '通过后设为基线' : null,
      ensured.videoEnabled ? null : '未检测到 ffmpeg，已关闭失败视频',
    ].filter(Boolean).join(' · '),
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
    if (tempScriptPath && existsSync(tempScriptPath)) {
      try {
        rmSync(tempScriptPath, { force: true });
      } catch {
        // ignore
      }
    }
    let artifacts = collectArtifacts(meta.id, runId);
    const current = readMeta(meta.id);
    current.updatedAt = nowIso();
    current.lastRunAt = nowIso();
    current.lastRunId = runId;
    if (code === 0) {
      if (saveStorageTo && existsSync(saveStorageTo)) {
        current.hasAuth = true;
        // If we saved into another workflow's auth path, mark that workflow too.
        try {
          const authDir = path.join(studioRoot(), 'auth');
          const base = path.basename(saveStorageTo, '.json');
          if (path.resolve(path.dirname(saveStorageTo)) === path.resolve(authDir) && base && base !== meta.id) {
            const target = readMeta(base);
            target.hasAuth = true;
            target.updatedAt = nowIso();
            writeMeta(target);
          }
        } catch {
          // ignore cross-meta update failures
        }
      }
      if (saveBaselineAfterPass) {
        try {
          saveBaseline({ workflowId: meta.id, runId });
          artifacts = collectArtifacts(meta.id, runId);
        } catch {
          // baseline save should not fail the play result
        }
      }
      const refreshed = readMeta(meta.id);
      refreshed.updatedAt = nowIso();
      refreshed.lastRunAt = nowIso();
      refreshed.lastRunId = runId;
      refreshed.lastArtifactCount = artifacts.length;
      refreshed.lastRunStatus = 'passed';
      refreshed.lastRunMessage = saveStorageTo && existsSync(saveStorageTo)
        ? '回放通过（已刷新登录态）'
        : artifacts.length
          ? `回放通过（${artifacts.length} 个产物）`
          : '回放通过';
      if (saveBaselineAfterPass) {
        refreshed.lastRunMessage = `${refreshed.lastRunMessage} · 已更新基线`;
      }
      writeMeta(refreshed);
      emit({
        workflowId: meta.id,
        runId,
        phase: 'passed',
        percent: 100,
        message: refreshed.lastRunMessage,
        exitCode: code,
        artifacts,
      });
    } else {
      const hasTrace = artifacts.some((item) => item.kind === 'trace');
      current.lastArtifactCount = artifacts.length;
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
  if (request.authWorkflowId !== undefined) {
    const nextAuth = request.authWorkflowId === null ? '' : String(request.authWorkflowId).trim();
    if (!nextAuth) {
      meta.authWorkflowId = undefined;
    } else {
      assertNoAuthCycle(meta.id, nextAuth);
      readMeta(nextAuth);
      meta.authWorkflowId = nextAuth;
      if (!meta.authBeforePlay) {
        meta.authBeforePlay = 'if-missing-auth';
      }
    }
  }
  if (request.authBeforePlay !== undefined) {
    meta.authBeforePlay = normalizeAuthBeforePlay(request.authBeforePlay);
  }
  if (request.isAuthWorkflow !== undefined) {
    meta.isAuthWorkflow = Boolean(request.isAuthWorkflow) || undefined;
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

export function getBaseline(workflowId: string): PlaywrightBaselineInfo | null {
  readMeta(workflowId);
  const file = baselineMetaPath(workflowId);
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as PlaywrightBaselineInfo;
    return { ...raw, path: file };
  } catch {
    return null;
  }
}

export function saveBaseline(request: PlaywrightSaveBaselineRequest): PlaywrightBaselineInfo {
  const meta = readMeta(request.workflowId);
  const runId = (request.runId || meta.lastRunId || '').trim();
  if (!runId) {
    throw new Error('没有可设为基线的回放记录，请先成功回放一次。');
  }
  const runArtifacts = collectArtifacts(meta.id, runId).filter((item) => item.kind !== 'baseline');
  const dir = baselineDir(meta.id);
  mkdirSync(dir, { recursive: true });
  // Refresh snapshot copies under baseline/files for offline compare.
  const filesDir = path.join(dir, 'files');
  rmSync(filesDir, { recursive: true, force: true });
  mkdirSync(filesDir, { recursive: true });
  for (const item of runArtifacts.slice(0, 20)) {
    try {
      const target = path.join(filesDir, item.name);
      writeFileSync(target, readFileSync(item.path));
    } catch {
      // skip unreadable artifact
    }
  }
  const info: PlaywrightBaselineInfo = {
    workflowId: meta.id,
    runId,
    savedAt: nowIso(),
    phase: meta.lastRunStatus || 'passed',
    message: meta.lastRunMessage || '',
    scriptHash: scriptHashFor(meta.id),
    artifactNames: runArtifacts.map((item) => item.name),
    logExcerpt: readLogExcerpt(runId),
    path: baselineMetaPath(meta.id),
  };
  writeFileSync(info.path, `${JSON.stringify(info, null, 2)}\n`, 'utf8');
  // Also drop a pointer artifact into the run folder for the UI list.
  try {
    const pointer = path.join(artifactRunDir(meta.id, runId), 'baseline.json');
    writeFileSync(pointer, `${JSON.stringify(info, null, 2)}\n`, 'utf8');
  } catch {
    // ignore
  }
  meta.baselineRunId = runId;
  meta.baselineSavedAt = info.savedAt;
  meta.updatedAt = nowIso();
  meta.lastRunMessage = `已保存回放基线（${runId.slice(0, 8)}…）`;
  writeMeta(meta);
  return info;
}

export function compareBaseline(workflowId: string): PlaywrightBaselineCompareResult {
  const meta = readMeta(workflowId);
  const baseline = getBaseline(workflowId);
  const latestRunId = meta.lastRunId || null;
  const latestArtifacts = latestRunId ? collectArtifacts(workflowId, latestRunId) : [];
  const baselineArtifacts = baseline
    ? collectArtifacts(workflowId, baseline.runId)
    : [];
  const currentHash = scriptHashFor(workflowId);
  const scriptChanged = Boolean(baseline && baseline.scriptHash && baseline.scriptHash !== currentHash);
  const lines: string[] = [];
  if (!baseline) {
    lines.push('尚未设置基线。建议先成功回放一次，再点击「设为基线」。');
  } else {
    lines.push(`基线 run=${baseline.runId.slice(0, 8)}… · ${baseline.savedAt}`);
    lines.push(`基线状态：${baseline.phase} · ${baseline.message || '-'}`);
    lines.push(`基线产物：${baseline.artifactNames.join(', ') || '无'}`);
    if (latestRunId) {
      lines.push(`最近 run=${latestRunId.slice(0, 8)}… · ${meta.lastRunStatus || 'idle'} · ${meta.lastRunMessage || '-'}`);
      lines.push(`最近产物：${latestArtifacts.map((item) => `${item.kind}:${item.name}`).join(' · ') || '无'}`);
      if (baseline.runId === latestRunId) {
        lines.push('最近一次回放与基线为同一 run。');
      } else if (meta.lastRunStatus === 'failed') {
        lines.push('最近回放失败，相对基线可能存在回归，请结合 Trace / HAR / 日志分析。');
      } else if (meta.lastRunStatus === 'passed') {
        lines.push('最近回放通过；可对比产物与脚本哈希确认是否漂移。');
      }
    } else {
      lines.push('尚无最近回放记录。');
    }
    if (scriptChanged) {
      lines.push('脚本内容相对基线已变化，断言/选择器可能需要重新评估。');
    }
  }
  return {
    workflowId,
    hasBaseline: Boolean(baseline),
    baseline,
    latestRunId,
    latestPhase: meta.lastRunStatus || null,
    latestMessage: meta.lastRunMessage || null,
    scriptChanged,
    latestArtifacts,
    baselineArtifacts,
    summary: lines.join('\n'),
  };
}

export function saveReport(request: PlaywrightSaveReportRequest): PlaywrightArtifact {
  const meta = readMeta(request.workflowId);
  const content = (request.content || '').trim();
  if (!content) {
    throw new Error('报告内容不能为空。');
  }
  const kind = request.kind || 'general';
  const title = (request.title || kind).trim().replace(/[^\w\u4e00-\u9fff\-]+/g, '_').slice(0, 40) || kind;
  const runId = `report-${Date.now()}`;
  const dir = artifactRunDir(meta.id, runId);
  mkdirSync(dir, { recursive: true });
  const fileName = `report-${kind}-${title}.md`;
  const filePath = path.join(dir, fileName);
  const body = [
    `# ${request.title || kind}`,
    '',
    `> workflow: ${meta.name} (${meta.id})`,
    `> url: ${meta.url}`,
    `> generatedAt: ${nowIso()}`,
    `> kind: ${kind}`,
    '',
    content,
    '',
  ].join('\n');
  writeFileSync(filePath, body, 'utf8');
  const st = statSync(filePath);
  meta.updatedAt = nowIso();
  meta.lastRunMessage = `已保存分析报告：${fileName}`;
  meta.lastArtifactCount = listArtifacts(meta.id).length;
  writeMeta(meta);
  return {
    kind: 'report',
    name: fileName,
    path: filePath,
    size: st.size,
    mtime: st.mtime.toISOString(),
    workflowId: meta.id,
    runId,
  };
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
