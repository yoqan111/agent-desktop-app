import path from 'node:path';
import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';

/** Packages Vite marks external that must still ship in the asar/unpacked tree. */
export const RUNTIME_PACKAGES = ['ffmpeg-static', 'ffprobe-static', '@cursor/sdk'] as const;

const FFMPEG_KEEP = new Set([
  'package.json',
  'index.js',
  'ffmpeg',
  'ffmpeg.exe',
  'ffmpeg.LICENSE',
  'LICENSE',
  'types',
]);

const FFPROBE_KEEP_ROOT = new Set([
  'package.json',
  'index.js',
  'LICENSE',
  'bin',
]);

async function copyFiltered(
  source: string,
  dest: string,
  keep: Set<string>,
): Promise<void> {
  await mkdir(dest, { recursive: true });
  const entries = await readdir(source, { withFileTypes: true });
  await Promise.all(entries.map(async (entry) => {
    if (!keep.has(entry.name)) {
      return;
    }
    await cp(path.join(source, entry.name), path.join(dest, entry.name), {
      recursive: true,
      force: true,
      dereference: true,
    });
  }));
}

/**
 * ffprobe-static ships every OS/arch binary (~300MB+).
 * Keep only the target platform/arch for this package build.
 */
async function copyFfprobeForTarget(
  sourceRoot: string,
  destRoot: string,
  platform: string,
  arch: string,
): Promise<void> {
  const source = path.join(sourceRoot, 'ffprobe-static');
  const dest = path.join(destRoot, 'ffprobe-static');
  await copyFiltered(source, dest, FFPROBE_KEEP_ROOT);

  const binRoot = path.join(dest, 'bin');
  if (!existsSync(binRoot)) {
    throw new Error('ffprobe-static/bin missing after copy');
  }

  const platforms = await readdir(binRoot);
  await Promise.all(platforms.map(async (p) => {
    if (p !== platform) {
      await rm(path.join(binRoot, p), { recursive: true, force: true });
    }
  }));

  const platformDir = path.join(binRoot, platform);
  if (!existsSync(platformDir)) {
    throw new Error(`ffprobe-static has no binary for ${platform}`);
  }

  const arches = await readdir(platformDir);
  await Promise.all(arches.map(async (a) => {
    if (a !== arch) {
      await rm(path.join(platformDir, a), { recursive: true, force: true });
    }
  }));

  const binaryName = platform === 'win32' ? 'ffprobe.exe' : 'ffprobe';
  const binaryPath = path.join(platformDir, arch, binaryName);
  if (!existsSync(binaryPath)) {
    throw new Error(`ffprobe binary missing: ${platform}/${arch}`);
  }
}

async function copyFfmpeg(sourceRoot: string, destRoot: string): Promise<void> {
  const source = path.join(sourceRoot, 'ffmpeg-static');
  const dest = path.join(destRoot, 'ffmpeg-static');
  await copyFiltered(source, dest, FFMPEG_KEEP);

  const binaryName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  if (!existsSync(path.join(dest, binaryName))) {
    // Host install may not match package target; still require a binary for this machine's package.
    throw new Error('ffmpeg-static binary missing after filtered copy');
  }
}

/** Keep Chromium .lproj packs we need; remove the rest (~45MB on macOS). */
const KEEP_ELECTRON_LOCALES = new Set([
  'en',
  'en_GB',
  'en_US',
  'zh',
  'zh_CN',
  'zh_TW',
  'zh_HK',
]);

function localeBaseName(dirName: string): string {
  return dirName.replace(/\.lproj$/i, '').replace(/_(FEMININE|MASCULINE|NEUTER)$/i, '');
}

export async function pruneElectronLocales(extractPath: string): Promise<void> {
  const resourcesDirs = [
    path.join(extractPath, 'Electron.app', 'Contents', 'Resources'),
    path.join(extractPath, 'Contents', 'Resources'),
    path.join(
      extractPath,
      'Electron.app',
      'Contents',
      'Frameworks',
      'Electron Framework.framework',
      'Versions',
      'A',
      'Resources',
    ),
    path.join(
      extractPath,
      'Contents',
      'Frameworks',
      'Electron Framework.framework',
      'Versions',
      'A',
      'Resources',
    ),
  ];

  await Promise.all(resourcesDirs.map(async (resourcesDir) => {
    if (!existsSync(resourcesDir)) {
      return;
    }
    const entries = await readdir(resourcesDir, { withFileTypes: true });
    await Promise.all(entries.map(async (entry) => {
      if (!entry.isDirectory() || !entry.name.endsWith('.lproj')) {
        return;
      }
      if (KEEP_ELECTRON_LOCALES.has(localeBaseName(entry.name))) {
        return;
      }
      await rm(path.join(resourcesDir, entry.name), { recursive: true, force: true });
    }));
  }));
}

export async function copyRuntimePackages(
  buildPath: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): Promise<void> {
  const sourceRoot = path.resolve(__dirname, '../node_modules');
  const destRoot = path.join(buildPath, 'node_modules');
  await mkdir(destRoot, { recursive: true });

  await copyFfmpeg(sourceRoot, destRoot);
  await copyFfprobeForTarget(sourceRoot, destRoot, platform, arch);

  // Cursor SDK is Vite-external; ship the package (and platform helpers if present).
  const cursorScope = path.join(sourceRoot, '@cursor');
  if (existsSync(cursorScope)) {
    await cp(cursorScope, path.join(destRoot, '@cursor'), {
      recursive: true,
      force: true,
      dereference: true,
    });
  }
}
