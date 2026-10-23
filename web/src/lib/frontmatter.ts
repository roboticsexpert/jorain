// Minimal YAML frontmatter handling: enough for `title`, `tags`, `updated` and other flat keys.

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function splitFrontmatter(content: string): { raw: string | null; body: string } {
  const m = FM_RE.exec(content);
  if (!m) return { raw: null, body: content };
  return { raw: m[1], body: content.slice(m[0].length) };
}

function parseScalar(v: string): unknown {
  const s = v.trim();
  if (s.startsWith('[') && s.endsWith(']')) {
    return s
      .slice(1, -1)
      .split(',')
      .map((x) => unquote(x.trim()))
      .filter((x) => x !== '');
  }
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s !== '' && !Number.isNaN(Number(s))) return Number(s);
  return unquote(s);
}

const unquote = (s: string) => s.replace(/^(['"])(.*)\1$/, '$2');

export function parseFrontmatter(content: string): Record<string, unknown> {
  const { raw } = splitFrontmatter(content);
  if (!raw) return {};
  const out: Record<string, unknown> = {};
  let listKey: string | null = null;
  for (const line of raw.split(/\r?\n/)) {
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item && listKey) {
      (out[listKey] as unknown[]).push(unquote(item[1].trim()));
      continue;
    }
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    if (kv[2] === '') {
      out[kv[1]] = [];
      listKey = kv[1];
    } else {
      out[kv[1]] = parseScalar(kv[2]);
      listKey = null;
    }
  }
  return out;
}

export function buildNote(title: string, tags: string[], body: string): string {
  const date = new Date().toISOString().slice(0, 10);
  const tagStr = tags.length ? `[${tags.join(', ')}]` : '[]';
  return `---\ntitle: ${title}\ntags: ${tagStr}\nupdated: ${date}\n---\n\n${body.trim()}\n`;
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}
