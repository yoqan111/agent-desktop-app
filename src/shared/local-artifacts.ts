export interface LocalArtifactRef {
  path: string;
  name: string;
}

const FILE_EXT = String.raw`pdf|png|jpe?g|webp|gif|svg|webm|mp4|mov|mkv|wav|mp3|aac|flac|ogg|json|zip|har|md|txt|csv|html?|tsx?|jsx?|trace|log|xml|yaml|yml|docx?|xlsx?|pptx?`;

/** Keys commonly used by mediado / Playwright / MCP tool payloads. */
const PATH_KEYS = new Set([
  'path',
  'file',
  'filepath',
  'filePath',
  'file_path',
  'localPath',
  'local_path',
  'output',
  'outputPath',
  'output_path',
  'destination',
  'dest',
  'savePath',
  'save_path',
  'scriptPath',
  'script_path',
  'pdfPath',
  'pdf_path',
  'tracePath',
  'trace_path',
  'screenshotPath',
  'screenshot_path',
  'videoPath',
  'video_path',
  'tempPath',
  'temp_path',
  'artifactPath',
  'artifact_path',
  'workdir',
  'workDir',
  'workspace',
  'rootDir',
  'root_dir',
]);

const MARKDOWN_LINK = /\[[^\]]*]\((file:\/\/[^)\n]+|\/(?:Users|home|var|tmp|private|Volumes)[^)\n]+|[A-Za-z]:\\[^)\n]+)\)/g;

function cleanPath(raw: string): string {
  let value = raw.trim();
  if (value.startsWith('file://')) {
    try {
      value = decodeURIComponent(value.replace(/^file:\/\/\/?/, '/'));
      if (/^\/[A-Za-z]:\//.test(value)) {
        value = value.slice(1).replace(/\//g, '\\');
      }
    } catch {
      value = value.replace(/^file:\/\/\/?/, '/');
    }
  }
  value = value.replace(/[.,;:!?，。；：！？]+$/g, '');
  value = value.replace(/["'`)\]]+$/g, '');
  return value;
}

function basename(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  return parts[parts.length - 1] || filePath;
}

function looksLikeLocalPath(filePath: string): boolean {
  if (!filePath || filePath.length < 4) return false;
  if (
    filePath.startsWith('/Users/')
    || filePath.startsWith('/home/')
    || filePath.startsWith('/var/')
    || filePath.startsWith('/tmp/')
    || filePath.startsWith('/private/')
    || filePath.startsWith('/Volumes/')
    || filePath.startsWith('/opt/')
    || filePath.startsWith('/Library/')
  ) {
    return true;
  }
  if (/^[A-Za-z]:[\\/]/.test(filePath) || filePath.startsWith('\\\\')) return true;
  if (filePath.startsWith('/') && new RegExp(`\\.(?:${FILE_EXT})$`, 'i').test(filePath)) return true;
  return false;
}

function isProbablyArtifactPath(filePath: string): boolean {
  if (!looksLikeLocalPath(filePath)) return false;
  // Drop ultra-short truncated segments like "/Users/yuzhu/Library/Application"
  const base = basename(filePath);
  if (!base.includes('.') && base.length < 3) return false;
  // Prefer real files / known workspace roots; keep dirs under MediaDo/agent.
  if (new RegExp(`\\.(?:${FILE_EXT})$`, 'i').test(filePath)) return true;
  if (/MediaDo|playwright-studio|agent\/workspace|artifacts/i.test(filePath)) return true;
  // Absolute dirs with enough depth (>= 4 segments) may still be useful.
  const depth = filePath.replace(/\\/g, '/').split('/').filter(Boolean).length;
  return depth >= 5;
}

/** Drop shorter prefixes of a longer path (fixes "Application" vs "Application Support/..."). */
function prunePrefixPaths(paths: string[]): string[] {
  const unique = [...new Set(paths.map((item) => item.trim()).filter(Boolean))];
  unique.sort((a, b) => b.length - a.length);
  const kept: string[] = [];
  for (const candidate of unique) {
    const covered = kept.some((longer) => (
      longer === candidate
      || longer.startsWith(`${candidate}/`)
      || longer.startsWith(`${candidate} `)
      || longer.startsWith(`${candidate}\\`)
    ));
    if (!covered) {
      kept.push(candidate);
    }
  }
  return kept;
}

function collectPathsFromValue(value: unknown, out: string[], depth = 0): void {
  if (depth > 8 || value == null) return;
  if (typeof value === 'string') {
    const cleaned = cleanPath(value);
    if (looksLikeLocalPath(cleaned)) {
      out.push(cleaned);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectPathsFromValue(item, out, depth + 1);
    }
    return;
  }
  if (typeof value !== 'object') return;

  const record = value as Record<string, unknown>;
  for (const [key, child] of Object.entries(record)) {
    if (PATH_KEYS.has(key) && typeof child === 'string') {
      const cleaned = cleanPath(child);
      if (looksLikeLocalPath(cleaned)) {
        out.push(cleaned);
      }
      continue;
    }
    if (key === 'url' && typeof child === 'string' && child.startsWith('file:')) {
      out.push(cleanPath(child));
      continue;
    }
    if (
      key === 'artifacts'
      || key === 'files'
      || key === 'outputs'
      || key === 'paths'
      || key === 'result'
      || key === 'data'
      || key === 'content'
    ) {
      collectPathsFromValue(child, out, depth + 1);
      continue;
    }
    // Nested objects may still hold artifact records.
    if (child && typeof child === 'object') {
      collectPathsFromValue(child, out, depth + 1);
    }
  }
}

/** Try parse whole chunk / embedded JSON objects from tool or model returns. */
function extractFromStructuredPayloads(chunk: string, out: string[]): void {
  const trimmed = chunk.trim();
  if (!trimmed) return;

  const tryParse = (raw: string) => {
    try {
      collectPathsFromValue(JSON.parse(raw), out);
      return true;
    } catch {
      return false;
    }
  };

  if ((trimmed.startsWith('{') || trimmed.startsWith('[')) && tryParse(trimmed)) {
    return;
  }

  // Tool UIs sometimes wrap JSON in fences or prose.
  const fence = /```(?:json)?\s*([\s\S]*?)```/gi;
  let fenceMatch = fence.exec(chunk);
  while (fenceMatch) {
    tryParse(fenceMatch[1].trim());
    fenceMatch = fence.exec(chunk);
  }

  // Heuristic: scan for JSON objects/arrays that mention path-like keys.
  const objectRe = /\{[\s\S]*?(?:"path"|"filePath"|"scriptPath"|"artifacts"|"pdfPath"|"outputPath")[\s\S]*?\}/g;
  let objectMatch = objectRe.exec(chunk);
  while (objectMatch) {
    tryParse(objectMatch[0]);
    objectMatch = objectRe.exec(chunk);
  }
}

function extractFromFreeText(chunk: string, out: string[]): void {
  MARKDOWN_LINK.lastIndex = 0;
  let linkMatch = MARKDOWN_LINK.exec(chunk);
  while (linkMatch) {
    out.push(cleanPath(linkMatch[1]));
    linkMatch = MARKDOWN_LINK.exec(chunk);
  }

  // Backtick-wrapped paths (spaces allowed).
  const tickRe = /`([^`\n]{4,})`/g;
  let tick = tickRe.exec(chunk);
  while (tick) {
    const inner = tick[1].trim();
    if (inner.startsWith('/') || /^[A-Za-z]:[\\/]/.test(inner) || inner.startsWith('file:')) {
      out.push(cleanPath(inner));
    }
    tick = tickRe.exec(chunk);
  }

  // Absolute paths that end with a known artifact extension — spaces allowed inside.
  // Example: /Users/.../Application Support/MediaDo/.../file.html
  const withExt = new RegExp(
    String.raw`(?:file:\/\/\/?)?(\/(?:Users|home|var|tmp|private|Volumes|opt|Library)(?:[\t ]?[\w.@+=,-]|[\u4e00-\u9fff]|\/|\\)+?\.(?:${FILE_EXT}))(?=$|[\s\`"'<>\]\)，。；：！？,.;:!?])`,
    'gi',
  );
  let extMatch = withExt.exec(chunk);
  while (extMatch) {
    out.push(cleanPath(extMatch[1]));
    extMatch = withExt.exec(chunk);
  }

  // Windows paths with extension
  const winExt = new RegExp(
    String.raw`([A-Za-z]:\\(?:[^<>:"/|?*\n]+\\)*[^<>:"/|?*\n]+\.(?:${FILE_EXT}))(?=$|[\s\`"'<>\]\)，。；：！？,.;:!?])`,
    'gi',
  );
  let winMatch = winExt.exec(chunk);
  while (winMatch) {
    out.push(cleanPath(winMatch[1]));
    winMatch = winExt.exec(chunk);
  }
}

/**
 * Extract unique local file/dir paths from Agent reply text and tool payloads.
 * Prefers structured JSON fields (path / artifacts[].path / …), then free-text
 * paths. Handles spaces such as "Application Support".
 */
export function extractLocalArtifacts(...chunks: Array<string | null | undefined>): LocalArtifactRef[] {
  const collected: string[] = [];

  for (const chunk of chunks) {
    if (!chunk) continue;
    extractFromStructuredPayloads(chunk, collected);
    extractFromFreeText(chunk, collected);
  }

  const pruned = prunePrefixPaths(
    collected
      .map((item) => cleanPath(item))
      .filter((item) => isProbablyArtifactPath(item)),
  );

  return pruned.map((filePath) => ({
    path: filePath,
    name: basename(filePath),
  }));
}
