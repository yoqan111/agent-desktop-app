export interface ConfirmOptions {
  title: string;
  message?: string;
  /** Confirm button label. Default 确定. */
  confirmLabel?: string;
  /** Cancel button label. Default 取消. */
  cancelLabel?: string;
  /** Style confirm as destructive action. */
  danger?: boolean;
}

export interface ConfirmAskPayload extends ConfirmOptions {
  requestId: string;
}

export const ConfirmIpc = {
  /** Main → renderer: show confirm dialog. */
  ask: 'ui:confirm:ask',
  /** Renderer → main: dialog result. */
  result: 'ui:confirm:result',
  /** Renderer invoke helper (unused if local host handles it). */
  invoke: 'ui:confirm:invoke',
} as const;

export interface ConfirmApi {
  /** Show app confirm dialog; resolves true when user confirms. */
  ask(options: ConfirmOptions): Promise<boolean>;
}
