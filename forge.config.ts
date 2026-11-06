import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerRpm } from '@electron-forge/maker-rpm';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';
import { PublisherGithub } from '@electron-forge/publisher-github';
import { PublisherS3 } from '@electron-forge/publisher-s3';
import { copyRuntimePackages, pruneElectronLocales } from './forge/native';
import { appBundleId, githubRepository, signingPackagerConfig, squirrelMakerConfig, zipMakerConfig } from './forge/release';

const repository = githubRepository();
const bucket = process.env.S3_BUCKET;
const publishers: ForgeConfig['publishers'] = [];
if (repository) {
  publishers.push(new PublisherGithub({
    repository,
    prerelease: false,
  }));
}
if (bucket) {
  publishers.push(new PublisherS3({
    bucket,
    public: true,
    folder: process.env.S3_FOLDER || 'agent-desktop-app',
    ...(process.env.S3_REGION ? { region: process.env.S3_REGION } : {}),
  }));
}

const config: ForgeConfig = {
  packagerConfig: {
    name: 'MediaDo',
    executableName: 'MediaDo',
    icon: './build/icon',
    asar: {
      unpack: '**/node_modules/{ffmpeg-static,ffprobe-static}/**',
    },
    appBundleId,
    extendInfo: {
      CFBundleName: 'MediaDo',
      CFBundleDisplayName: 'MediaDo',
    },
    ...signingPackagerConfig(),
  },
  rebuildConfig: {},
  hooks: {
    packageAfterExtract: async (_config, extractPath) => {
      await pruneElectronLocales(extractPath);
    },
    packageAfterCopy: async (_config, buildPath, _electronVersion, platform, arch) => {
      await copyRuntimePackages(buildPath, platform as NodeJS.Platform, arch);
    },
  },
  makers: [
    new MakerSquirrel((arch) => squirrelMakerConfig(arch)),
    new MakerZIP((arch) => zipMakerConfig(arch), ['darwin']),
    new MakerRpm({}),
    new MakerDeb({}),
  ],
  publishers,
  plugins: [
    new AutoUnpackNativesPlugin({}),
    new VitePlugin({
      build: [
        {
          entry: 'src/app/main.ts',
          config: 'vite.main.config.ts',
          target: 'main',
        },
        {
          entry: 'src/app/preload.ts',
          config: 'vite.preload.config.ts',
          target: 'preload',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.ts',
        },
      ],
    }),
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
