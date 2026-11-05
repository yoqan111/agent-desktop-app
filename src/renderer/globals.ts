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
  }
}

export {};
