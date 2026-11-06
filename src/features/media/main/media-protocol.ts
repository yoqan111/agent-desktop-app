import { net, protocol } from 'electron';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { MEDIA_SCHEME } from '../shared/media';

export { MEDIA_SCHEME, toMediaPreviewUrl } from '../shared/media';

export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: MEDIA_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        bypassCSP: true,
        corsEnabled: true,
      },
    },
  ]);
}

export function installMediaProtocol(): void {
  protocol.handle(MEDIA_SCHEME, (request) => {
    try {
      const url = new URL(request.url);
      const filePath = url.searchParams.get('path');
      if (!filePath) {
        return new Response('Missing path', { status: 400 });
      }
      const absolute = path.resolve(filePath);
      if (!path.isAbsolute(absolute) || !existsSync(absolute)) {
        return new Response('Not Found', { status: 404 });
      }
      return net.fetch(pathToFileURL(absolute).href);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Bad Request';
      return new Response(message, { status: 500 });
    }
  });
}
