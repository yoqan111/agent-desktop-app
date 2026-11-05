export type PlaywrightBrowser = 'chromium' | 'chrome' | 'firefox' | 'webkit' | 'msedge';

export type PlaywrightRunMode = 'headed' | 'headless' | 'ui' | 'debug';

export type PlaywrightJobPhase = 'idle' | 'recording' | 'running' | 'passed' | 'failed' | 'stopped';

/** Default headed-playback slowMo for newly recorded workflows (ms between actions). */
export const PLAYWRIGHT_DEFAULT_SLOW_MO_MS = 500;

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
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  lastRunStatus?: PlaywrightJobPhase;
  lastRunMessage?: string;
  notes?: string;
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
  /** Override workflow slowMo for this run; omit to use meta.slowMoMs. */
  slowMoMs?: number;
  workers?: number;
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
}

export interface PlaywrightRunEvent {
  workflowId: string;
  runId: string;
  phase: PlaywrightJobPhase;
  percent: number;
  message: string;
  line?: string;
  exitCode?: number | null;
}

export interface PlaywrightStudioStatus {
  rootDir: string;
  playwrightReady: boolean;
  browsersHint: string;
  /** Studio-managed persistent profiles root (per browser subdirs). */
  persistentProfilesDir: string;
  activeJob: null | {
    kind: 'record' | 'play';
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
  stopJob(): Promise<void>;
  updateWorkflow(request: PlaywrightUpdateRequest): Promise<PlaywrightWorkflowDetail>;
  deleteWorkflow(id: string): Promise<void>;
  openWorkflowFolder(id: string): Promise<void>;
  revealStudioRoot(): Promise<void>;
  installBrowsers(): Promise<{ ok: boolean; message: string }>;
  onRunEvent(handler: (event: PlaywrightRunEvent) => void): () => void;
}

export const PlaywrightIpc = {
  status: 'pw:status',
  list: 'pw:list',
  get: 'pw:get',
  record: 'pw:record',
  play: 'pw:play',
  stop: 'pw:stop',
  update: 'pw:update',
  delete: 'pw:delete',
  openFolder: 'pw:openFolder',
  revealRoot: 'pw:revealRoot',
  install: 'pw:install',
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

export const PLAYWRIGHT_DEVICES = [
  '',
  'iPhone 13',
  'iPhone 14',
  'Pixel 7',
  'iPad Pro 11',
] as const;
