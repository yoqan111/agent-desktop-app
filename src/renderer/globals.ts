import type { AgentApi } from '../shared/agent';
import type { ConfirmAskPayload } from '../shared/confirm';
import type { MediaApi } from '../shared/media';
import type { PaymentApi } from '../shared/payment';
import type { PlaywrightApi } from '../shared/playwright';
import type { UpdaterApi } from '../shared/updater';

declare global {
  interface Window {
    media: MediaApi;
    payment: PaymentApi;
    playwright: PlaywrightApi;
    updater: UpdaterApi;
    agent: AgentApi;
    confirmUi: {
      onAskFromMain(handler: (payload: ConfirmAskPayload) => void): () => void;
      respondToMain(requestId: string, ok: boolean): void;
    };
  }
}

export {};
