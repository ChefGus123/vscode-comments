import { createTextDocument, Range } from '../__mocks__/vscode';
import { createAnchor, createAnchorFromContent, reanchor, shiftAnchorForChanges } from '../../src/anchoring/anchor';
import { hashContent } from '../../src/anchoring/hash';
import { Anchor } from '../../src/types';

function doc(lines: string[]) {
  return createTextDocument({ toString: () => 'file:///test.ts' } as any, lines.join('\n'));
}

function change(startLine: number, endLine: number, text: string) {
  return { range: new Range(startLine, 0, endLine, 0), text } as any;
}

describe('createAnchor', () => {
  it('captures line hints, content hash, and surrounding context', () => {
    const document = doc(['before', 'target1', 'target2', 'after']);
    const anchor = createAnchor(document as any, 1, 2);
    expect(anchor).toEqual({
      lineHint: 2,
      endLineHint: 3,
      contentHash: hashContent('target1\ntarget2'),
      contextBefore: 'before',
      contextAfter: 'after',
      status: 'exact',
    });
  });

  it('uses empty context when the range touches file boundaries', () => {
    const document = doc(['only']);
    const anchor = createAnchor(document as any, 0, 0);
    expect(anchor.contextBefore).toBe('');
    expect(anchor.contextAfter).toBe('');
  });
});

describe('createAnchorFromContent', () => {
  it('matches createAnchor for equivalent LF content', () => {
    const lines = ['before', 'target1', 'target2', 'after'];
    const fromDoc = createAnchor(doc(lines) as any, 1, 2);
    const fromContent = createAnchorFromContent(lines.join('\n'), 1, 2);
    expect(fromContent).toEqual(fromDoc);
  });

  it('normalizes CRLF content before hashing/context extraction', () => {
    const crlf = 'before\r\ntarget\r\nafter';
    const anchor = createAnchorFromContent(crlf, 1, 1);
    expect(anchor.contentHash).toBe(hashContent('target'));
    expect(anchor.contextBefore).toBe('before');
    expect(anchor.contextAfter).toBe('after');
  });

  it('falls back to empty context when the range covers the entire (single-line) content', () => {
    const anchor = createAnchorFromContent('onlyline', 0, 0);
    expect(anchor.contextBefore).toBe('');
    expect(anchor.contextAfter).toBe('');
  });
});

describe('shiftAnchorForChanges', () => {
  const baseAnchor: Anchor = {
    lineHint: 11,
    endLineHint: 12,
    contentHash: 'irrelevant',
    contextBefore: '',
    contextAfter: '',
    status: 'exact',
  };

  it('leaves the anchor untouched when the only change is below it', () => {
    const result = shiftAnchorForChanges(baseAnchor, [change(20, 20, 'x')]);
    expect(result).toEqual(baseAnchor);
  });

  it('shifts down when lines are inserted above the anchor', () => {
    // change spans original line 0 only (endLine0 0 < anchorStart0 9), replaced with 3 lines -> +2 delta
    const result = shiftAnchorForChanges(baseAnchor, [change(0, 0, 'a\nb\nc')]);
    expect(result).toEqual({ ...baseAnchor, lineHint: 13, endLineHint: 14 });
  });

  it('shifts up when lines are removed above the anchor', () => {
    // change spans original lines 0-2 (3 lines removed), replaced with a single line -> -2 delta
    const result = shiftAnchorForChanges(baseAnchor, [change(0, 2, 'a')]);
    expect(result).toEqual({ ...baseAnchor, lineHint: 9, endLineHint: 10 });
  });

  it('sums deltas across multiple non-overlapping changes above the anchor', () => {
    const result = shiftAnchorForChanges(baseAnchor, [change(0, 0, 'a\nb'), change(2, 2, 'x\ny\nz')]);
    expect(result).toEqual({ ...baseAnchor, lineHint: 14, endLineHint: 15 });
  });

  it('returns undefined when a change overlaps the anchor range', () => {
    const result = shiftAnchorForChanges(baseAnchor, [change(11, 11, 'x')]);
    expect(result).toBeUndefined();
  });

  it('returns undefined when a change is directly adjacent to the anchor (buffer zone)', () => {
    // changeEnd0 (10) >= anchorStart0 - 1 (10) counts as overlap
    const result = shiftAnchorForChanges(baseAnchor, [change(9, 10, 'x')]);
    expect(result).toBeUndefined();
  });
});

describe('reanchor', () => {
  function anchorFor(lines: string[], start0: number, end0: number): Anchor {
    return createAnchor(doc(lines) as any, start0, end0);
  }

  it('confirms the hint when content still matches there (exact, fast path)', () => {
    const lines = ['before', 'target1', 'target2', 'after'];
    const anchor = anchorFor(lines, 1, 2);
    const result = reanchor(doc(lines) as any, anchor);
    expect(result).toEqual({ ...anchor, status: 'exact' });
  });

  it('finds content shifted within the search window and relocates it', () => {
    const original = ['a0', 'target1', 'target2', 'a1', 'a2'];
    const anchor = anchorFor(original, 1, 2);
    // insert 5 lines above the target, pushing it from line 1 to line 6 (0-indexed), well within the 200-line window
    const shifted = ['n0', 'n1', 'n2', 'n3', 'n4', 'a0', 'target1', 'target2', 'a1', 'a2'];
    const result = reanchor(doc(shifted) as any, anchor);
    expect(result.status).toBe('exact');
    expect(result.lineHint).toBe(7);
    expect(result.endLineHint).toBe(8);
  });

  it('falls back to a full-document scan when content moved outside the search window, skipping the already-checked window', () => {
    const anchor = anchorFor(['target1', 'target2'], 0, 1);
    // 230-line document: target sits at index 220/221, well past the ~[0,200] window scanned first —
    // the full scan must pass through (and skip) that window before it reaches the real match.
    const shiftedDocLines = Array.from({ length: 230 }, (_, i) =>
      i === 220 ? 'target1' : i === 221 ? 'target2' : `filler${i}`
    );
    const result = reanchor(doc(shiftedDocLines) as any, anchor);
    expect(result.status).toBe('exact');
    expect(result.lineHint).toBe(221);
    expect(result.endLineHint).toBe(222);
  });

  it('skips the hint fast-path when the hinted range no longer fits in a shrunk document', () => {
    const original = [...Array.from({ length: 290 }, (_, i) => `filler${i}`), 'target1', 'target2'];
    const anchor = anchorFor(original, 290, 291);
    const shrunkDoc = ['target1', 'target2', 'x', 'y', 'z'];
    const result = reanchor(doc(shrunkDoc) as any, anchor);
    expect(result.status).toBe('exact');
    expect(result.lineHint).toBe(1);
    expect(result.endLineHint).toBe(2);
  });

  it('falls back to approximate context matching when content hash matches nowhere', () => {
    const original = ['before', 'target1', 'target2', 'after'];
    const anchor = anchorFor(original, 1, 2);
    const edited = ['before', 'CHANGED1', 'CHANGED2', 'after'];
    const result = reanchor(doc(edited) as any, anchor);
    expect(result.status).toBe('approximate');
    expect(result.lineHint).toBe(2);
    expect(result.endLineHint).toBe(3);
  });

  it('matches on contextAfter alone when the anchor is at the top of the file (contextBefore empty)', () => {
    const original = ['target1', 'target2', 'after'];
    const anchor = anchorFor(original, 0, 1);
    expect(anchor.contextBefore).toBe('');
    const edited = ['CHANGED1', 'CHANGED2', 'after'];
    const result = reanchor(doc(edited) as any, anchor);
    expect(result.status).toBe('approximate');
    expect(result.lineHint).toBe(1);
    expect(result.endLineHint).toBe(2);
  });

  it('matches on contextBefore alone when the anchor is at the bottom of the file (contextAfter empty)', () => {
    const original = ['before', 'target1', 'target2'];
    const anchor = anchorFor(original, 1, 2);
    expect(anchor.contextAfter).toBe('');
    const edited = ['before', 'CHANGED1', 'CHANGED2'];
    const result = reanchor(doc(edited) as any, anchor);
    expect(result.status).toBe('approximate');
    expect(result.lineHint).toBe(2);
    expect(result.endLineHint).toBe(3);
  });

  it('reports orphaned when neither content hash nor context can be matched', () => {
    const original = ['before', 'target1', 'target2', 'after'];
    const anchor = anchorFor(original, 1, 2);
    const edited = ['nothing', 'CHANGED1', 'CHANGED2', 'unrelated'];
    const result = reanchor(doc(edited) as any, anchor);
    expect(result).toEqual({ ...anchor, status: 'orphaned' });
  });

  it('treats an anchor with no context as orphaned rather than approximate when hash misses', () => {
    const original = ['before', 'target1', 'target2', 'after'];
    const anchor: Anchor = { ...anchorFor(original, 1, 2), contextBefore: '', contextAfter: '' };
    const edited = ['before', 'CHANGED1', 'CHANGED2', 'after'];
    const result = reanchor(doc(edited) as any, anchor);
    expect(result.status).toBe('orphaned');
  });
});
