import * as crypto from 'crypto';
/** CRLF/LF normalization so a pure line-ending change never triggers a false anchor downgrade. */
export function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

export function hashContent(text: string): string {
  return crypto.createHash('sha1').update(normalizeLineEndings(text)).digest('hex');
}
