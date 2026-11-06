/**
 * Media feature — renderer public API.
 * Safe for Vite renderer bundle (no Electron main / native deps).
 *
 * Note: do not re-export helpers that WelcomeScreen needs via this barrel
 * if WelcomeScreen is imported by MediaWorkspace — that creates a cycle:
 * App → renderer/index → MediaWorkspace → WelcomeScreen → renderer/index
 */

export { MediaWorkspace } from './MediaWorkspace';
export type { MediaWorkspaceProps } from './MediaWorkspace';
