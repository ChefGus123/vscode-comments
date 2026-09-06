import * as vscode from 'vscode';
import { CommentStore } from '../storage/store';
import { hideResolvedCommentsEnabled } from '../comments/controller';
import { toWorkspaceRelativePath } from '../storage/paths';
import { truncateSnippet } from '../anchoring/snippet';
import { AuthorType, StoredComment } from '../types';

/** Minimal local shape of the markdown-it API this plugin touches. There's no @types/markdown-it
 * installed and the real `markdown-it` package ships no type declarations of its own — VS Code
 * hands `extendMarkdownIt` a live instance built from the real library at runtime, so this only
 * needs to describe the handful of members we actually call, not the whole library. */
interface MdToken {
  type: string;
  map: [number, number] | null;
  attrJoin(name: string, value: string): void;
  attrSet(name: string, value: string): void;
}

interface MdCoreState {
  env: Record<string, unknown>;
  tokens: MdToken[];
}

export interface MdInstance {
  core: {
    ruler: {
      push(name: string, rule: (state: MdCoreState) => void): void;
    };
  };
}

export interface BlockRange {
  /** Inclusive, 0-based — straight from markdown-it's `token.map[0]`. */
  start: number;
  /** Exclusive, 0-based — straight from markdown-it's `token.map[1]`. */
  end: number;
}

export interface CommentLineSpan {
  id: string;
  /** Inclusive, 0-based start/end line — already converted from this codebase's 1-based
   * `Anchor.lineHint`/`endLineHint`. */
  start: number;
  end: number;
}

/** For each comment, finds the innermost block whose range fully contains it — markdown-it block
 * `.map` ranges are strictly hierarchical (a child's range always sits fully inside its parent's,
 * never overlapping a sibling's), so "smallest range that fully contains the comment's line span"
 * is a deterministic choice, not a heuristic. A tie (a container and its sole child sharing the
 * exact same range, e.g. a tight single-item list) breaks toward the later index, which is always
 * the more deeply nested one — markdown-it always emits a parent's opening token before any
 * child's.
 *
 * If no single block fully contains the comment (it spans multiple sibling blocks — e.g. a
 * multi-paragraph selection anchored from the gutter), it's marked once, on the earliest-starting
 * of the blocks it overlaps that isn't itself a container of another overlapping block for that
 * same comment — one marker for the whole span, not one per block it touches (a comment covering
 * a table's rows or a list's items would otherwise paint a marker on every single one of them).
 *
 * Pure and markdown-it-free so it can be unit tested directly. */
export function matchCommentsToBlocks(
  blocks: readonly (BlockRange | null)[],
  comments: readonly CommentLineSpan[]
): Map<number, string[]> {
  const result = new Map<number, string[]>();
  const addMatch = (index: number, id: string): void => {
    const existing = result.get(index);
    if (existing) {
      existing.push(id);
    } else {
      result.set(index, [id]);
    }
  };

  for (const comment of comments) {
    const containing: number[] = [];
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      if (b && b.start <= comment.start && comment.end < b.end) {
        containing.push(i);
      }
    }
    if (containing.length > 0) {
      let best = containing[0];
      for (const i of containing) {
        const width = blocks[i]!.end - blocks[i]!.start;
        const bestWidth = blocks[best]!.end - blocks[best]!.start;
        if (width < bestWidth || (width === bestWidth && i > best)) {
          best = i;
        }
      }
      addMatch(best, comment.id);
      continue;
    }

    const overlapping = blocks
      .map((b, i) => ({ b, i }))
      .filter((x): x is { b: BlockRange; i: number } => x.b !== null && x.b.start <= comment.end && comment.start < x.b.end);
    const leaves = overlapping.filter(
      ({ b, i }) =>
        !overlapping.some(({ b: other, i: j }) => j !== i && other.start >= b.start && other.end <= b.end && (other.start > b.start || other.end < b.end))
    );
    // A single marker for the whole span, not one per block it touches — placed on the
    // earliest-starting leaf block, so a comment covering many short blocks (a table's rows, a
    // list's items) doesn't paint a marker on every one of them.
    let first = leaves[0];
    for (const leaf of leaves) {
      if (leaf.b.start < first.b.start || (leaf.b.start === first.b.start && leaf.i < first.i)) {
        first = leaf;
      }
    }
    if (first) {
      addMatch(first.i, comment.id);
    }
  }

  return result;
}

/** Truncation budget for a comment's text baked into `data-agent-comments-json`, which feeds the
 * preview's click-to-expand panel — more generous than a quickpick label, since the panel has room. */
const PANEL_TEXT_MAX_CHARS = 300;
/** Truncation budget per comment inside the native `title` hover tooltip, which has to fit several
 * comments' worth of text on one line-wrapped browser tooltip. */
const TITLE_TEXT_MAX_CHARS = 200;

interface PanelCommentEntry {
  id: string;
  author: AuthorType;
  status: 'unresolved' | 'resolved';
  resolvedBy?: AuthorType;
  text: string;
}

function toPanelEntry(c: StoredComment): PanelCommentEntry {
  return {
    id: c.id,
    author: c.author.type,
    status: c.status,
    resolvedBy: c.resolvedBy?.type,
    text: truncateSnippet(c.text, PANEL_TEXT_MAX_CHARS),
  };
}

/** Plain-text summary for the native `title` attribute — hover-to-read for free, no custom tooltip
 * component needed. Plain text only (no markdown), unlike the tree view's tooltip. */
function summaryTitle(comments: StoredComment[]): string {
  return comments
    .map((c) => {
      const who = c.author.type === 'user' ? 'You' : 'Agent';
      const status = c.status === 'resolved' ? ` (resolved by ${c.resolvedBy?.type ?? 'unknown'})` : '';
      return `${who}${status}: ${truncateSnippet(c.text, TITLE_TEXT_MAX_CHARS)}`;
    })
    .join('\n\n');
}

/** Creates the `extendMarkdownIt` plugin that marks up which blocks in a rendered markdown preview
 * have comments, matching each comment's `anchor.lineHint`/`endLineHint` (1-based in this
 * codebase — `anchoring/anchor.ts` sets `lineHint: startLine0 + 1`) against markdown-it's own
 * block `.map` ranges (genuinely 0-based), converting the base before comparing.
 *
 * Comment data is read synchronously from `CommentStore`'s in-memory caches
 * (`peekCachedComments`) because markdown-it plugins run inside a synchronous render pipeline —
 * `CommentStore.loadFile`/`getArchivedComments` are async. On a cold cache for a file, this
 * renders with no markers for that pass and kicks off the real async load in the background,
 * calling `onNeedsRefresh` once it resolves so a follow-up render (the caller wires this to
 * `markdown.preview.refresh`) picks the markers up. The same callback is reused by the caller for
 * live comment-store changes — this plugin itself has no way to know a comment changed, since
 * that never touches the document's text, which is the only thing that makes VS Code's preview
 * re-render on its own.
 *
 * `getFallbackDocumentUri` covers a real gap discovered against a live VS Code build:
 * `env.currentDocument` is only set when the render call was given an actual document object —
 * some render passes (observed for a preview panel revived after a window/extension reload) pass
 * a plain markdown string instead, leaving `currentDocument` present as a key but `undefined` as a
 * value. When that happens, this falls back to whatever the caller reports as the last-focused
 * Markdown editor (`extension.ts` tracks this via `onDidChangeActiveTextEditor`) — imprecise for a
 * *locked* preview showing a file other than the active editor, but far better than never
 * rendering markers at all after any reload with a preview open. */
export function createCommentsMarkdownItPlugin(
  store: CommentStore,
  onNeedsRefresh: () => void,
  getFallbackDocumentUri: () => vscode.Uri | undefined
): (md: MdInstance) => MdInstance {
  // Per-file in-flight guard: a cold cache can be hit by more than one render pass before the
  // first warm-up resolves (e.g. a second preview tab for the same file) — without this, each
  // would kick off its own redundant loadFile/getArchivedComments and its own refresh call.
  const warming = new Set<string>();

  function warm(filePath: string, needArchive: boolean): void {
    if (warming.has(filePath)) {
      return;
    }
    warming.add(filePath);
    const tasks: Promise<unknown>[] = [store.loadFile(filePath)];
    if (needArchive) {
      tasks.push(store.getArchivedComments(filePath));
    }
    void Promise.all(tasks).finally(() => {
      warming.delete(filePath);
      onNeedsRefresh();
    });
  }

  return (md) => {
    md.core.ruler.push('agent_comments_preview_markers', (state) => {
      const envDocument = (state.env as { currentDocument?: vscode.Uri }).currentDocument;
      const currentDocument = envDocument ?? getFallbackDocumentUri();
      if (!currentDocument) {
        return;
      }
      const filePath = toWorkspaceRelativePath(currentDocument);
      const includeResolved = !hideResolvedCommentsEnabled();
      const { live, archived } = store.peekCachedComments(filePath);
      if (live === undefined || (includeResolved && archived === undefined)) {
        warm(filePath, includeResolved);
        return;
      }

      // `archived` is guaranteed defined here when includeResolved is true — the guard above
      // already warmed and returned otherwise.
      const comments: StoredComment[] = includeResolved ? [...live, ...archived!] : live;
      if (comments.length === 0) {
        return;
      }

      // `inline` tokens inherit their exact `.map` range from their immediate parent block token
      // (e.g. paragraph_open and its inline child always share the same map) — but markdown-it's
      // renderer special-cases `type === 'inline'` to render its `.children` directly and never
      // reads the inline token's own `.attrs`, so attrJoin/attrSet on one is silently a no-op.
      // Excluded here so a same-width tie with its parent never resolves in its favor.
      const blocks: (BlockRange | null)[] = state.tokens.map((t) => (t.map && t.type !== 'inline' ? { start: t.map[0], end: t.map[1] } : null));
      const spans: CommentLineSpan[] = comments.map((c) => {
        const start = c.anchor.lineHint - 1;
        const end = Math.max(start, c.anchor.endLineHint - 1);
        return { id: c.id, start, end };
      });
      const matches = matchCommentsToBlocks(blocks, spans);
      if (matches.size === 0) {
        return;
      }

      const byId = new Map(comments.map((c) => [c.id, c] as const));
      for (const [index, ids] of matches) {
        // Every id in `matches` came from `spans`, built from this same `comments` array above —
        // `byId` is guaranteed to have an entry for each one.
        const matched = ids.map((id) => byId.get(id)!);
        const token = state.tokens[index];
        const authors = [...new Set(matched.map((c) => c.author.type))].sort();
        token.attrJoin('class', 'agent-comment-line');
        token.attrJoin('class', `agent-comment-authors-${authors.join('-')}`);
        token.attrSet('data-agent-comment-ids', matched.map((c) => c.id).join(','));
        token.attrSet('data-agent-comment-count', String(matched.length));
        // Cheap pre-filter so package.json's webview/context `when` clauses can show Resolve only
        // when there's something to resolve (and Reopen only when there's something to reopen)
        // without needing the controller round-trip first — it still does the precise per-id
        // filtering itself once an action actually runs.
        token.attrSet('data-agent-comment-has-unresolved', String(matched.some((c) => c.status === 'unresolved')));
        token.attrSet('data-agent-comment-has-resolved', String(matched.some((c) => c.status === 'resolved')));
        token.attrSet('data-agent-comments-json', JSON.stringify(matched.map(toPanelEntry)));
        token.attrSet('title', summaryTitle(matched));
      }
    });
    return md;
  };
}
