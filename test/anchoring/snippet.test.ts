import { truncateSnippet } from '../../src/anchoring/snippet';

describe('truncateSnippet', () => {
  it('returns the text unchanged when under the cap', () => {
    expect(truncateSnippet('short', 10)).toBe('short');
  });

  it('truncates and appends a marker when over the cap', () => {
    const result = truncateSnippet('0123456789abcdef', 10);
    expect(result).toBe('0123456789\n… (truncated, 6 more chars)');
  });

  it('is a no-op when maxChars is 0 or negative', () => {
    expect(truncateSnippet('anything', 0)).toBe('anything');
    expect(truncateSnippet('anything', -5)).toBe('anything');
  });
});
