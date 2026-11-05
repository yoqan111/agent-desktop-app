import path from 'node:path';
import type { ForgeConfig } from '@electron-forge/shared-types';
import type { MakerSquirrelConfig } from '@electron-forge/maker-squirrel';
import type { MakerZIPConfig } from '@electron-forge/maker-zip';
type PackagerConfig = NonNullable<ForgeConfig['packagerConfig']>;

const entitlements = path.resolve(__dirname, '../build/entitlements.mac.plist');

export const appBundleId = 'com.mediado.app';

export function updateBaseUrl(): string {
  return (process.env.UPDATE_BASE_URL ?? '').replace(/\/+$/, '');
}

export function githubRepository(): { owner: string; name: string } | undefined {
  const value = process.env.GITHUB_REPOSITORY ?? '';
  const [owner, name] = value.split('/');
  if (!owner || !name) {
    return undefined;
  }
  return { owner, name };
}

export function feedUrl(platform: string, arch: string): string | undefined {
  const base = updateBaseUrl();
  if (!base) {
    return undefined;
  }
  return `${base}/${platform}/${arch}`;
}

function hasNotarizeCredentials(): boolean {
  if (process.env.APPLE_KEYCHAIN_PROFILE) {
    return true;
  }
  if (process.env.APPLE_API_KEY && process.env.APPLE_API_KEY_ID && process.env.APPLE_API_ISSUER) {
    return true;
  }
  return Boolean(process.env.APPLE_ID && process.env.APPLE_PASSWORD && process.env.APPLE_TEAM_ID);
}

export function signingPackagerConfig(): Pick<PackagerConfig, 'osxSign' | 'osxNotarize' | 'windowsSign'> {
  const config: Pick<PackagerConfig, 'osxSign' | 'osxNotarize' | 'windowsSign'> = {};
  const shouldSignMac = process.env.APPLE_SIGN === '1'
    || Boolean(process.env.APPLE_SIGNING_IDENTITY)
    || hasNotarizeCredentials();

  if (shouldSignMac) {
    config.osxSign = {
      ...(process.env.APPLE_SIGNING_IDENTITY ? { identity: process.env.APPLE_SIGNING_IDENTITY } : {}),
      optionsForFile: () => ({
        entitlements,
        'entitlements-inherit': entitlements,
      }),
    };
  }

  if (process.env.APPLE_KEYCHAIN_PROFILE) {
    config.osxNotarize = { keychainProfile: process.env.APPLE_KEYCHAIN_PROFILE };
  } else if (process.env.APPLE_API_KEY && process.env.APPLE_API_KEY_ID && process.env.APPLE_API_ISSUER) {
    config.osxNotarize = {
      appleApiKey: process.env.APPLE_API_KEY,
      appleApiKeyId: process.env.APPLE_API_KEY_ID,
      appleApiIssuer: process.env.APPLE_API_ISSUER,
    };
  } else if (process.env.APPLE_ID && process.env.APPLE_PASSWORD && process.env.APPLE_TEAM_ID) {
    config.osxNotarize = {
      appleId: process.env.APPLE_ID,
      appleIdPassword: process.env.APPLE_PASSWORD,
      teamId: process.env.APPLE_TEAM_ID,
    };
  }

  if (process.env.AZURE_CODE_SIGNING_DLIB && process.env.AZURE_METADATA_JSON) {
    config.windowsSign = {
      ...(process.env.SIGNTOOL_PATH ? { signToolPath: process.env.SIGNTOOL_PATH } : {}),
      signWithParams: `/v /debug /dlib ${process.env.AZURE_CODE_SIGNING_DLIB} /dmdf ${process.env.AZURE_METADATA_JSON}`,
      timestampServer: 'http://timestamp.acs.microsoft.com',
    };
  }

  return config;
}

export function zipMakerConfig(arch: string): MakerZIPConfig {
  const base = feedUrl('darwin', arch);
  return base ? { macUpdateManifestBaseUrl: base } : {};
}

export function squirrelMakerConfig(arch: string): MakerSquirrelConfig {
  const config: MakerSquirrelConfig = {};
  const releases = feedUrl('win32', arch);
  if (releases && process.env.SQUIRREL_REMOTE_RELEASES === '1') {
    config.remoteReleases = releases;
  }
  if (process.env.WINDOWS_CERTIFICATE_FILE) {
    config.certificateFile = process.env.WINDOWS_CERTIFICATE_FILE;
    config.certificatePassword = process.env.WINDOWS_CERTIFICATE_PASSWORD;
  }
  if (process.env.AZURE_CODE_SIGNING_DLIB && process.env.AZURE_METADATA_JSON) {
    config.windowsSign = {
      ...(process.env.SIGNTOOL_PATH ? { signToolPath: process.env.SIGNTOOL_PATH } : {}),
      signWithParams: `/v /debug /dlib ${process.env.AZURE_CODE_SIGNING_DLIB} /dmdf ${process.env.AZURE_METADATA_JSON}`,
      timestampServer: 'http://timestamp.acs.microsoft.com',
    };
  }
  return config;
}
