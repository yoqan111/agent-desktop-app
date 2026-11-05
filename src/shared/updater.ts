export type UpdatePhase = 'disabled' | 'idle' | 'checking' | 'available' | 'not-available' | 'downloaded' | 'error';

export interface UpdateState {
  phase: UpdatePhase;
  version: string;
  message: string;
}

export interface UpdaterApi {
  getState(): Promise<UpdateState>;
  check(): Promise<UpdateState>;
  install(): Promise<void>;
  onState(handler: (state: UpdateState) => void): () => void;
}

export const UpdaterIpc = {
  state: 'updater:getState',
  check: 'updater:check',
  install: 'updater:install',
  event: 'updater:event',
} as const;

export const idleUpdateState: UpdateState = {
  phase: 'idle',
  version: '',
  message: '',
};
