import type { ConfirmOptions } from './confirm';

type ConfirmRequest = {
  options: ConfirmOptions;
  resolve: (ok: boolean) => void;
};

type ConfirmListener = (request: ConfirmRequest | null) => void;

let listener: ConfirmListener | null = null;
let pending: ConfirmRequest | null = null;
const queue: ConfirmRequest[] = [];

function publish(): void {
  listener?.(pending);
}

export function bindConfirmHost(next: ConfirmListener | null): void {
  listener = next;
  publish();
}

function dequeueNext(): void {
  pending = queue.shift() || null;
  publish();
}

/** App-wide confirm. Prefer this over window.confirm. */
export function askConfirm(options: ConfirmOptions): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const request: ConfirmRequest = { options, resolve };
    if (!pending) {
      pending = request;
      publish();
      return;
    }
    queue.push(request);
  });
}

export function resolveConfirm(ok: boolean): void {
  if (!pending) return;
  const current = pending;
  pending = null;
  publish();
  current.resolve(ok);
  dequeueNext();
}

export function getPendingConfirm(): ConfirmRequest | null {
  return pending;
}
