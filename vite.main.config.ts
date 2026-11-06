import { defineConfig } from 'vite';

export default defineConfig({
  define: {
    'process.env.UPDATE_BASE_URL': JSON.stringify(process.env.UPDATE_BASE_URL ?? ''),
    'process.env.GITHUB_REPOSITORY': JSON.stringify(process.env.GITHUB_REPOSITORY ?? ''),
  },
  build: {
    rollupOptions: {
      external: [
        'ffmpeg-static',
        'ffprobe-static',
        '@cursor/sdk',
      ],
    },
  },
});
