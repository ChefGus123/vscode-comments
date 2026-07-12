import { hashContent, normalizeLineEndings } from '../../src/anchoring/hash';

describe('normalizeLineEndings', () => {
  it('converts CRLF to LF', () => {
    expect(normalizeLineEndings('a\r\nb')).toBe('a\nb');
  });

  it('converts lone CR to LF', () => {
    expect(normalizeLineEndings('a\rb')).toBe('a\nb');
  });

  it('leaves LF-only text unchanged', () => {
    expect(normalizeLineEndings('a\nb')).toBe('a\nb');
  });

  it('handles text with no line endings', () => {
    expect(normalizeLineEndings('abc')).toBe('abc');
  });
});

describe('hashContent', () => {
  it('produces the same hash for CRLF and LF variants of the same content', () => {
    expect(hashContent('a\r\nb')).toBe(hashContent('a\nb'));
  });

  it('produces different hashes for different content', () => {
    expect(hashContent('a')).not.toBe(hashContent('b'));
  });

  it('returns a sha1 hex digest', () => {
    expect(hashContent('hello')).toMatch(/^[0-9a-f]{40}$/);
  });
});
