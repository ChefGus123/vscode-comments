import * as vscode from 'vscode';
import { Anchor } from '../types';
import { hashContent, normalizeLineEndings } from './hash';

const SEARCH_WINDOW = 200;

function lineText(document: vscode.TextDocument, line0: number): string {
  if (line0 < 0 || line0 >= document.lineCount) {
    return '';
  }
  return document.lineAt(line0).text;
}

function rangeContent(document: vscode.TextDocument, start0: number, end0: number): string {
  const lines: string[] = [];
  for (let i = start0; i <= end0; i++) {
    lines.push(lineText(document, i));
  }
  return lines.join('\n');
}

/** Builds a fresh anchor for a newly-created comment on [startLine0, endLine0] (0-indexed, inclusive). */
export function createAnchor(document: vscode.TextDocument, startLine0: number, endLine0: number): Anchor {
  return {
    lineHint: startLine0 + 1,
    endLineHint: endLine0 + 1,
    contentHash: hashContent(rangeContent(document, startLine0, endLine0)),
    contextBefore: normalizeLineEndings(lineText(document, startLine0 - 1)),
    contextAfter: normalizeLineEndings(lineText(document, endLine0 + 1)),
    status: 'exact',
  };
}

/**
 * Builds a fresh anchor from raw file content rather than a live TextDocument — used by the MCP
 * `add_comment` tool, which routinely targets files that aren't open in any editor tab (§3.3).
 */
export function createAnchorFromContent(content: string, startLine0: number, endLine0: number): Anchor {
  const lines = normalizeLineEndings(content).split('\n');
  const at = (i: number): string => (i >= 0 && i < lines.length ? lines[i] : '');
  const rangeLines: string[] = [];
  for (let i = startLine0; i <= endLine0; i++) {
    rangeLines.push(at(i));
  }
  return {
    lineHint: startLine0 + 1,
    endLineHint: endLine0 + 1,
    contentHash: hashContent(rangeLines.join('\n')),
    contextBefore: at(startLine0 - 1),
    contextAfter: at(endLine0 + 1),
    status: 'exact',
  };
}

/**
 * Shifts an anchor's line numbers by a batch of simultaneous content changes (e.g. a multi-cursor
 * edit) without any hashing, for edits that don't touch the anchor's own lines. Keeps far-away
 * comments cheap to track (§4: only the changed range gets rehashed) while still following
 * line-number drift from edits elsewhere in the file. Returns undefined if any change overlaps the
 * anchor's lines — the caller must re-anchor instead.
 *
 * All entries in a single onDidChangeTextDocument batch carry ranges relative to the document as
 * it was *before any of them were applied* — they are not sequentially re-based against each
 * other. So every change must be evaluated against the anchor's one original position and the
 * resulting deltas summed, rather than shifting the anchor after each change and comparing the
 * next change's (still-original-coordinate) range against an already-moved target — the latter
 * double-shifts whenever an earlier change in the array pushes the anchor's line count across a
 * later change's original position.
 */
export function shiftAnchorForChanges(
  anchor: Anchor,
  changes: readonly vscode.TextDocumentContentChangeEvent[]
): Anchor | undefined {
  const anchorStart0 = anchor.lineHint - 1;
  const anchorEnd0 = anchor.endLineHint - 1;
  let totalDelta = 0;

  for (const change of changes) {
    const changeStart0 = change.range.start.line;
    const changeEnd0 = change.range.end.line;

    const overlaps = changeStart0 <= anchorEnd0 + 1 && changeEnd0 >= anchorStart0 - 1;
    if (overlaps) {
      return undefined;
    }

    if (changeEnd0 < anchorStart0) {
      const insertedLines = change.text.split('\n').length - 1;
      const removedLines = changeEnd0 - changeStart0;
      totalDelta += insertedLines - removedLines;
    }
  }

  return {
    ...anchor,
    lineHint: anchor.lineHint + totalDelta,
    endLineHint: anchor.endLineHint + totalDelta,
  };
}

/**
 * Recomputes an anchor's location/status against the current document contents. Tries, in order:
 * the recorded line hint, a bounded window around it, then a full-document scan for the content
 * hash (exact); falls back to matching surrounding context (approximate); else orphaned.
 */
export function reanchor(document: vscode.TextDocument, anchor: Anchor): Anchor {
  const lineCount = anchor.endLineHint - anchor.lineHint;
  const hintStart0 = anchor.lineHint - 1;
  const hintEnd0 = hintStart0 + lineCount;

  if (hintStart0 >= 0 && hintEnd0 < document.lineCount) {
    if (hashContent(rangeContent(document, hintStart0, hintEnd0)) === anchor.contentHash) {
      return { ...anchor, status: 'exact' };
    }
  }

  const windowStart = Math.max(0, hintStart0 - SEARCH_WINDOW);
  const windowEnd = Math.min(document.lineCount - 1, hintStart0 + SEARCH_WINDOW);
  for (let start0 = windowStart; start0 <= windowEnd - lineCount; start0++) {
    const end0 = start0 + lineCount;
    if (hashContent(rangeContent(document, start0, end0)) === anchor.contentHash) {
      return relocate(anchor, start0, end0, 'exact');
    }
  }

  for (let start0 = 0; start0 + lineCount < document.lineCount; start0++) {
    if (start0 >= windowStart && start0 <= windowEnd - lineCount) {
      continue;
    }
    const end0 = start0 + lineCount;
    if (hashContent(rangeContent(document, start0, end0)) === anchor.contentHash) {
      return relocate(anchor, start0, end0, 'exact');
    }
  }

  if (anchor.contextBefore || anchor.contextAfter) {
    for (let start0 = 0; start0 + lineCount < document.lineCount; start0++) {
      const end0 = start0 + lineCount;
      const before = normalizeLineEndings(lineText(document, start0 - 1));
      const after = normalizeLineEndings(lineText(document, end0 + 1));
      const beforeMatches = anchor.contextBefore ? before === anchor.contextBefore : true;
      const afterMatches = anchor.contextAfter ? after === anchor.contextAfter : true;
      if (beforeMatches && afterMatches) {
        return relocate(anchor, start0, end0, 'approximate');
      }
    }
  }

  return { ...anchor, status: 'orphaned' };
}

function relocate(anchor: Anchor, start0: number, end0: number, status: Anchor['status']): Anchor {
  return {
    ...anchor,
    lineHint: start0 + 1,
    endLineHint: end0 + 1,
    status,
  };
}
