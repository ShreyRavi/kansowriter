/**
 * A Markdown file as the editor sees it, and back. The editor works in \n line breaks with no
 * final newline of its own, so reading notes how the file was written (its line ending, a final
 * newline, a byte-order mark) and writing puts each back. A file with one kind of line ending
 * round-trips byte for byte; a file that mixes them (some CRLF, some LF, or old-Mac CR) comes
 * back with its majority ending on every line, the one change the first save makes.
 */
export interface FileFormat {
  eol: '\n' | '\r\n';
  /** the file ended with a line break (the editor doesn't show it as an empty last line) */
  finalNewline: boolean;
  bom: boolean;
}

/** A new file: POSIX style, one final newline. */
export const NEW_FILE_FORMAT: FileFormat = { eol: '\n', finalNewline: true, bom: false };

export class NotTextError extends Error {}

export function decodeMarkdown(bytes: Uint8Array): { text: string; format: FileFormat } {
  const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  let raw: string;
  try {
    raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bom ? bytes.subarray(3) : bytes);
  } catch {
    throw new NotTextError('not UTF-8');
  }
  if (raw.includes('\0')) throw new NotTextError('binary');
  const crlf = raw.match(/\r\n/g)?.length ?? 0;
  const other = raw.match(/\r(?!\n)|(?<!\r)\n/g)?.length ?? 0;
  const eol = crlf > other ? '\r\n' : '\n';
  let text = raw.replace(/\r\n?/g, '\n');
  const finalNewline = text.endsWith('\n');
  if (finalNewline) text = text.slice(0, -1);
  return { text, format: { eol, finalNewline, bom } };
}

export function encodeMarkdown(text: string, format: FileFormat): Uint8Array {
  let out = format.finalNewline ? `${text}\n` : text;
  if (format.eol === '\r\n') out = out.replace(/\n/g, '\r\n');
  const body = new TextEncoder().encode(out);
  if (!format.bom) return body;
  const withBom = new Uint8Array(body.length + 3);
  withBom.set([0xef, 0xbb, 0xbf]);
  withBom.set(body, 3);
  return withBom;
}

/**
 * A short fingerprint of a text (53-bit cyrb53 plus the length): enough to tell "changed since
 * the last sync" without keeping a copy of every linked file. Not a security hash.
 */
export function hashText(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `${(4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)}.${text.length.toString(36)}`;
}

/** The file's name without its folder or extension ("notes" for /a/notes.md). */
export function baseName(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

export function fileName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}
