/**
 * Media feature — main-process public API.
 * Do not import this from renderer code.
 */

export { registerMediaIpc } from './register-ipc';
export { installMediaProtocol, registerMediaScheme } from './media-protocol';
export { cleanupTempOutputs } from './media';
