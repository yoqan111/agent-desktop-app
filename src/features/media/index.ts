/**
 * Media feature — shared contracts only.
 * - Main process: import from `./main`
 * - Renderer: import from `./renderer` (+ `./shared` for types/constants)
 */

export {
  AUDIO_FORMATS,
  IMAGE_FORMATS,
  VIDEO_FORMATS,
  type MediaKind,
} from './shared/media';
