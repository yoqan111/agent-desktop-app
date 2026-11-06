export type PlaywrightBrowser = 'chromium' | 'chrome' | 'firefox' | 'webkit' | 'msedge';

export type PlaywrightRunMode = 'headed' | 'headless' | 'ui' | 'debug';

export type PlaywrightJobPhase = 'idle' | 'recording' | 'running' | 'passed' | 'failed' | 'stopped';

export type PlaywrightArtifactKind =
  | 'trace'
  | 'video'
  | 'screenshot'
  | 'pdf'
  | 'har'
  | 'report'
  | 'baseline'
  | 'other';

/** Agent / Studio analysis focus for a workflow. */
export type PlaywrightAnalyzeMode =
  | 'general'
  | 'test-enhance'
  | 'business-doc'
  | 'anomaly'
  | 'auto-run'
  | 'param-run';

export const PLAYWRIGHT_ANALYZE_MODES: PlaywrightAnalyzeMode[] = [
  'general',
  'test-enhance',
  'business-doc',
  'anomaly',
  'auto-run',
  'param-run',
];

/** Extracted editable step from a recorded Playwright script. */
export type PlaywrightScriptStepKind = 'goto' | 'fill' | 'type' | 'select' | 'check' | 'other';

export interface PlaywrightScriptStep {
  id: string;
  index: number;
  kind: PlaywrightScriptStepKind;
  /** Locator / selector expression text from the script. */
  target: string;
  /** Current literal value (URL / filled text / option). */
  value: string;
  /** 1-based line number in script when available. */
  line?: number;
  hint?: string;
}

export interface PlaywrightRunWithParamsRequest {
  workflowId: string;
  /**
   * Map step id → new value, or short aliases:
   * - "0" / "1" for step index
   * - selector fragment keys matched against step.target
   * - kind labels like "fill:邮箱" when hint present
   */
  params: Record<string, string>;
  mode?: PlaywrightRunMode;
  browser?: PlaywrightBrowser;
  slowMoMs?: number;
  recordHar?: boolean;
  /** Persist substituted script back to the workflow (default false; uses temp script). */
  persistScript?: boolean;
  /** Marks this run as Agent-driven automation (affects status copy only). */
  source?: 'agent' | 'manual';
}

export interface PlaywrightBaselineInfo {
  workflowId: string;
  runId: string;
  savedAt: string;
  phase: PlaywrightJobPhase;
  message: string;
  scriptHash: string;
  artifactNames: string[];
  logExcerpt?: string;
  path: string;
}

export interface PlaywrightBaselineCompareResult {
  workflowId: string;
  hasBaseline: boolean;
  baseline: PlaywrightBaselineInfo | null;
  latestRunId: string | null;
  latestPhase: PlaywrightJobPhase | null;
  latestMessage: string | null;
  scriptChanged: boolean;
  latestArtifacts: PlaywrightArtifact[];
  baselineArtifacts: PlaywrightArtifact[];
  summary: string;
}

export interface PlaywrightSaveReportRequest {
  workflowId: string;
  /** Markdown / text body. */
  content: string;
  /** Short title used in filename. */
  title?: string;
  /** Report flavor for naming. */
  kind?: 'test-enhance' | 'business-doc' | 'anomaly' | 'general';
}

export interface PlaywrightSaveBaselineRequest {
  workflowId: string;
  /** Prefer this run; default last successful / last run. */
  runId?: string;
}

export type PlaywrightAssertTemplate = 'url' | 'title' | 'body' | 'all';

export type PlaywrightCaptureKind = 'screenshot' | 'pdf';

/** When to run the linked login workflow before playback. */
export type PlaywrightAuthBeforePlay = 'off' | 'if-missing-auth' | 'always';

/** Default headed-playback slowMo for newly recorded workflows (ms between actions). */
export const PLAYWRIGHT_DEFAULT_SLOW_MO_MS = 500;

export const PLAYWRIGHT_AUTH_BEFORE_PLAY: PlaywrightAuthBeforePlay[] = [
  'if-missing-auth',
  'always',
  'off',
];

export interface PlaywrightArtifact {
  kind: PlaywrightArtifactKind;
  name: string;
  path: string;
  size: number;
  mtime: string;
  workflowId: string;
  runId: string;
}

export interface PlaywrightWorkflowMeta {
  id: string;
  name: string;
  url: string;
  browser: PlaywrightBrowser;
  device: string;
  fileName: string;
  hasAuth: boolean;
  /** Recorded with Studio persistent browser profile (user-data-dir). */
  usePersistentProfile?: boolean;
  /** Preferred playback slowMo in ms; filled at record time, updated when user adjusts and plays. */
  slowMoMs?: number;
  /**
   * Optional login workflow to run before this one.
   * After a successful login run, storageState is copied onto this workflow.
   */
  authWorkflowId?: string;
  /**
   * When to run authWorkflowId. Default if-missing-auth when authWorkflowId is set.
   * - if-missing-auth: only when this workflow has no storageState file
   * - always: every playback
   * - off: never auto-run (manual only)
   */
  authBeforePlay?: PlaywrightAuthBeforePlay;
  /** Mark this workflow as a login/setup flow (UI hint). */
  isAuthWorkflow?: boolean;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  lastRunId?: string;
  lastRunStatus?: PlaywrightJobPhase;
  lastRunMessage?: string;
  /** Count of artifacts from the latest play/capture run. */
  lastArtifactCount?: number;
  notes?: string;
  /** Run id promoted as regression baseline. */
  baselineRunId?: string;
  /** ISO time when baseline was saved. */
  baselineSavedAt?: string;
}

export interface PlaywrightWorkflowDetail extends PlaywrightWorkflowMeta {
  script: string;
  scriptPath: string;
  authPath?: string;
}

export interface PlaywrightRecordRequest {
  name: string;
  url: string;
  browser?: PlaywrightBrowser;
  device?: string;
  /** Reuse saved login state if present on an existing workflow. */
  loadAuthFromId?: string;
  /** Save storage state after recording finishes (user closes codegen). */
  saveAuth?: boolean;
  /**
   * Reuse Studio's persistent browser profile (Playwright --user-data-dir).
   * Keeps cookies/localStorage across recordings for the same browser.
   * Not the user's everyday Chrome window — a dedicated automation profile.
   */
  usePersistentProfile?: boolean;
  /** Preferred playback slowMo saved onto the workflow (default 500). */
  slowMoMs?: number;
  notes?: string;
}

export interface PlaywrightPlayRequest {
  id: string;
  mode?: PlaywrightRunMode;
  /** Override workflow browser for this run; omit to use meta.browser. */
  browser?: PlaywrightBrowser;
  /** Override workflow slowMo for this run; omit to use meta.slowMoMs. */
  slowMoMs?: number;
  workers?: number;
  /** Skip linked authWorkflowId precondition (used internally to avoid recursion). */
  skipAuthPrecondition?: boolean;
  /**
   * After this run succeeds, save browser storageState to this path
   * (injected into a temporary copy of the script).
   */
  saveStorageTo?: string;
  /**
   * After a successful play, save storageState back to this workflow's auth file.
   * Default true so cookies from the run persist for the next play.
   * Pass false to skip.
   */
  saveAuthAfterPlay?: boolean;
  /** Record network HAR into this run's artifact folder. */
  recordHar?: boolean;
  /** After a successful play, promote this run as the workflow baseline. */
  saveBaseline?: boolean;
  /** Marks this run as Agent-driven automation (affects status copy only). */
  source?: 'agent' | 'manual';
}

export interface PlaywrightBatchPlayRequest {
  ids: string[];
  mode?: PlaywrightRunMode;
  /** Override browser for every workflow in this batch. */
  browser?: PlaywrightBrowser;
  slowMoMs?: number;
}

export interface PlaywrightCaptureRequest {
  id: string;
  kind: PlaywrightCaptureKind;
  /** Full-page screenshot (ignored for pdf). Default true. */
  fullPage?: boolean;
}

export interface PlaywrightAssertRequest {
  id: string;
  /** Templates to inject; default all. */
  templates?: PlaywrightAssertTemplate[];
}

export interface PlaywrightScheduleConfig {
  enabled: boolean;
  /** Interval in minutes (minimum 1). */
  intervalMinutes: number;
  workflowIds: string[];
  mode: PlaywrightRunMode;
  slowMoMs?: number;
  lastRunAt?: string;
  nextRunAt?: string;
  lastMessage?: string;
}

export interface PlaywrightUpdateRequest {
  id: string;
  name?: string;
  notes?: string;
  script?: string;
  url?: string;
  browser?: PlaywrightBrowser;
  device?: string;
  slowMoMs?: number;
  authWorkflowId?: string | null;
  authBeforePlay?: PlaywrightAuthBeforePlay;
  isAuthWorkflow?: boolean;
}

export interface PlaywrightRunEvent {
  workflowId: string;
  runId: string;
  phase: PlaywrightJobPhase;
  percent: number;
  message: string;
  line?: string;
  exitCode?: number | null;
  artifacts?: PlaywrightArtifact[];
}

export interface PlaywrightStudioStatus {
  rootDir: string;
  playwrightReady: boolean;
  browsersHint: string;
  /** Studio-managed persistent profiles root (per browser subdirs). */
  persistentProfilesDir: string;
  schedule: PlaywrightScheduleConfig;
  activeJob: null | {
    kind: 'record' | 'play' | 'batch' | 'capture';
    workflowId: string;
    runId: string;
    startedAt: string;
  };
}

export interface PlaywrightApi {
  getStatus(): Promise<PlaywrightStudioStatus>;
  listWorkflows(): Promise<PlaywrightWorkflowMeta[]>;
  getWorkflow(id: string): Promise<PlaywrightWorkflowDetail>;
  startRecord(request: PlaywrightRecordRequest): Promise<PlaywrightWorkflowDetail>;
  play(request: PlaywrightPlayRequest): Promise<{ runId: string }>;
  playBatch(request: PlaywrightBatchPlayRequest): Promise<{
    runId: string;
    results: Array<{ id: string; phase: PlaywrightJobPhase; message: string }>;
  }>;
  stopJob(): Promise<void>;
  updateWorkflow(request: PlaywrightUpdateRequest): Promise<PlaywrightWorkflowDetail>;
  deleteWorkflow(id: string): Promise<void>;
  openWorkflowFolder(id: string): Promise<void>;
  revealStudioRoot(): Promise<void>;
  installBrowsers(): Promise<{ ok: boolean; message: string }>;
  listArtifacts(workflowId: string): Promise<PlaywrightArtifact[]>;
  openTrace(artifactPath: string): Promise<void>;
  revealArtifact(artifactPath: string): Promise<void>;
  openArtifactsFolder(workflowId: string): Promise<void>;
  deleteArtifact(artifactPath: string): Promise<{ deleted: true; path: string; workflowId: string }>;
  injectAsserts(request: PlaywrightAssertRequest): Promise<PlaywrightWorkflowDetail>;
  capturePage(request: PlaywrightCaptureRequest): Promise<{
    runId: string;
    artifacts: PlaywrightArtifact[];
    workflow: PlaywrightWorkflowDetail;
  }>;
  saveBaseline(request: PlaywrightSaveBaselineRequest): Promise<PlaywrightBaselineInfo>;
  getBaseline(workflowId: string): Promise<PlaywrightBaselineInfo | null>;
  compareBaseline(workflowId: string): Promise<PlaywrightBaselineCompareResult>;
  saveReport(request: PlaywrightSaveReportRequest): Promise<PlaywrightArtifact>;
  listScriptSteps(workflowId: string): Promise<PlaywrightScriptStep[]>;
  runWithParams(request: PlaywrightRunWithParamsRequest): Promise<{
    runId: string;
    applied: Array<{ stepId: string; from: string; to: string }>;
    steps: PlaywrightScriptStep[];
  }>;
  getSchedule(): Promise<PlaywrightScheduleConfig>;
  setSchedule(config: Partial<PlaywrightScheduleConfig>): Promise<PlaywrightScheduleConfig>;
  onRunEvent(handler: (event: PlaywrightRunEvent) => void): () => void;
}

export const PlaywrightIpc = {
  status: 'pw:status',
  list: 'pw:list',
  get: 'pw:get',
  record: 'pw:record',
  play: 'pw:play',
  playBatch: 'pw:playBatch',
  stop: 'pw:stop',
  update: 'pw:update',
  delete: 'pw:delete',
  openFolder: 'pw:openFolder',
  revealRoot: 'pw:revealRoot',
  install: 'pw:install',
  listArtifacts: 'pw:listArtifacts',
  openTrace: 'pw:openTrace',
  revealArtifact: 'pw:revealArtifact',
  openArtifactsFolder: 'pw:openArtifactsFolder',
  deleteArtifact: 'pw:deleteArtifact',
  injectAsserts: 'pw:injectAsserts',
  capturePage: 'pw:capturePage',
  saveBaseline: 'pw:saveBaseline',
  getBaseline: 'pw:getBaseline',
  compareBaseline: 'pw:compareBaseline',
  saveReport: 'pw:saveReport',
  listScriptSteps: 'pw:listScriptSteps',
  runWithParams: 'pw:runWithParams',
  getSchedule: 'pw:getSchedule',
  setSchedule: 'pw:setSchedule',
  event: 'pw:event',
} as const;

export const PLAYWRIGHT_BROWSERS: PlaywrightBrowser[] = [
  'chromium',
  'chrome',
  'msedge',
  'firefox',
  'webkit',
];

export const PLAYWRIGHT_RUN_MODES: PlaywrightRunMode[] = [
  'headed',
  'headless',
  'ui',
  'debug',
];

export const PLAYWRIGHT_ASSERT_TEMPLATES: PlaywrightAssertTemplate[] = [
  'url',
  'title',
  'body',
  'all',
];

export const PLAYWRIGHT_DEVICES = [
  '',
  'iPhone 13',
  'iPhone 14',
  'Pixel 7',
  'iPad Pro 11',
] as const;
