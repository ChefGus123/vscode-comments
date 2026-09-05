import * as vscode from 'vscode';
import { CommentStore } from '../../src/storage/store';
import { archiveFileUri } from '../../src/storage/paths';
import {
  BlockRange,
  CommentLineSpan,
  MdInstance,
  createCommentsMarkdownItPlugin,
  matchCommentsToBlocks,
} from '../../src/preview/commentsMarkdownItPlugin';

const mockVscode = vscode as unknown as { __reset(): void; __setConfig(key: string, value: unknown): void };
const storageUri = vscode.Uri.file('/storage');
const repoUri = vscode.Uri.file('/repo');

async function flush(times = 20): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

afterEach(() => {
  mockVscode.__reset();
  jest.restoreAllMocks();
});

describe('matchCommentsToBlocks', () => {
  const span = (id: string, start: number, end = start): CommentLineSpan => ({ id, start, end });

  it('matches a comment to the one block that contains it', () => {
    const blocks: (BlockRange | null)[] = [{ start: 0, end: 2 }, { start: 2, end: 4 }];
    const result = matchCommentsToBlocks(blocks, [span('c1', 2)]);
    expect(result).toEqual(new Map([[1, ['c1']]]));
  });

  it('picks the innermost (smallest) of several containing blocks', () => {
    // A blockquote spanning lines 0-5 containing a paragraph spanning lines 1-2.
    const blocks: (BlockRange | null)[] = [{ start: 0, end: 5 }, { start: 1, end: 3 }];
    const result = matchCommentsToBlocks(blocks, [span('c1', 1, 2)]);
    expect(result).toEqual(new Map([[1, ['c1']]]));
  });

  it('breaks a same-width tie toward the later (more deeply nested) token', () => {
    // A tight single-item list: the list, its one item, and the item's content all share [0,1) —
    // markdown-it always emits the parent's opening token before the child's.
    const blocks: (BlockRange | null)[] = [{ start: 0, end: 1 }, { start: 0, end: 1 }];
    const result = matchCommentsToBlocks(blocks, [span('c1', 0)]);
    expect(result).toEqual(new Map([[1, ['c1']]]));
  });

  it('skips tokens with no map (null) entirely', () => {
    const blocks: (BlockRange | null)[] = [null, { start: 0, end: 2 }];
    const result = matchCommentsToBlocks(blocks, [span('c1', 0)]);
    expect(result).toEqual(new Map([[1, ['c1']]]));
  });

  it('produces no matches for a comment whose lines fall outside every block', () => {
    const blocks: (BlockRange | null)[] = [{ start: 0, end: 2 }];
    const result = matchCommentsToBlocks(blocks, [span('c1', 5)]);
    expect(result.size).toBe(0);
  });

  it('groups multiple comments that land on the same block into one entry', () => {
    const blocks: (BlockRange | null)[] = [{ start: 0, end: 2 }];
    const result = matchCommentsToBlocks(blocks, [span('c1', 0), span('c2', 1)]);
    expect(result).toEqual(new Map([[0, ['c1', 'c2']]]));
  });

  it('falls back to every top-level sibling block a multi-block comment overlaps, when nothing contains it', () => {
    // Two adjacent top-level paragraphs (0-2, 2-4) with no wrapping container token at all — a
    // gutter multi-block selection spanning both has no single containing block.
    const blocks: (BlockRange | null)[] = [{ start: 0, end: 2 }, { start: 2, end: 4 }];
    const result = matchCommentsToBlocks(blocks, [span('c1', 0, 3)]);
    expect(result).toEqual(
      new Map([
        [0, ['c1']],
        [1, ['c1']],
      ])
    );
  });

  it('excludes an ancestor container from the fallback set, keeping only the leaf-most overlapping blocks', () => {
    // outerA (0-2) wraps innerA (0-1); siblingB (2-4) is unrelated to outerA/innerA. A comment
    // spanning 0-3 doesn't fit inside any single block, so it falls back to every overlap — but
    // outerA should be dropped since innerA (nested inside it) already represents that region.
    const blocks: (BlockRange | null)[] = [
      { start: 0, end: 2 }, // outerA
      { start: 0, end: 1 }, // innerA, nested inside outerA
      { start: 2, end: 4 }, // siblingB
    ];
    const result = matchCommentsToBlocks(blocks, [span('c1', 0, 3)]);
    expect(result).toEqual(
      new Map([
        [1, ['c1']],
        [2, ['c1']],
      ])
    );
  });
});

describe('createCommentsMarkdownItPlugin', () => {
  const filePath = 'doc.md';

  class FakeToken {
    attrs: Record<string, string> = {};
    private classes: string[] = [];
    constructor(public map: [number, number] | null, public type: string = 'paragraph_open') {}
    attrJoin(name: string, value: string): void {
      if (name === 'class') {
        this.classes.push(value);
        this.attrs.class = this.classes.join(' ');
      } else {
        this.attrs[name] = this.attrs[name] ? `${this.attrs[name]} ${value}` : value;
      }
    }
    attrSet(name: string, value: string): void {
      this.attrs[name] = value;
    }
  }

  function installRule(
    store: CommentStore,
    onNeedsRefresh: () => void,
    getFallbackDocumentUri: () => vscode.Uri | undefined = () => undefined
  ): Parameters<MdInstance['core']['ruler']['push']>[1] {
    type Rule = Parameters<MdInstance['core']['ruler']['push']>[1];
    let rule: Rule | undefined;
    const md: MdInstance = {
      core: {
        ruler: {
          push: (_name, fn) => {
            rule = fn;
          },
        },
      },
    };
    createCommentsMarkdownItPlugin(store, onNeedsRefresh, getFallbackDocumentUri)(md);
    if (!rule) {
      throw new Error('plugin never registered a core rule');
    }
    return rule;
  }

  beforeEach(() => {
    vscode.workspace.workspaceFolders = [{ uri: repoUri, name: 'repo', index: 0 }];
  });

  it('does nothing when the render has no current document and no fallback is available', async () => {
    const store = new CommentStore(storageUri);
    await store.initialize();
    const loadFileSpy = jest.spyOn(store, 'loadFile');
    const onNeedsRefresh = jest.fn();
    const rule = installRule(store, onNeedsRefresh);

    const tokens = [new FakeToken([0, 1])];
    rule({ env: {}, tokens });

    expect(loadFileSpy).not.toHaveBeenCalled();
    expect(tokens[0].attrs).toEqual({});
  });

  it('falls back to the last-focused Markdown editor when env.currentDocument is undefined (a plain-string render, e.g. a revived preview panel)', async () => {
    const store = new CommentStore(storageUri);
    await store.initialize();
    await store.addComment(
      filePath,
      { lineHint: 1, endLineHint: 1, contentHash: 'h', contextBefore: '', contextAfter: '', status: 'exact' },
      'hi',
      { type: 'user' }
    );
    await store.loadFile(filePath);

    const fallbackUri = vscode.Uri.joinPath(repoUri, filePath);
    const rule = installRule(store, jest.fn(), () => fallbackUri);
    const tokens = [new FakeToken([0, 1])];
    // No currentDocument in env at all — exactly what was observed against a real VS Code build
    // for a preview panel revived after a window reload.
    rule({ env: {}, tokens });

    expect(tokens[0].attrs.class).toContain('agent-comment-line');
  });

  it('renders no markers and warms the cache on a cold read, then calls onNeedsRefresh once warm', async () => {
    // Seed with one store instance (which warms its own cache as a side effect of writing), then
    // read with a second, freshly constructed instance pointed at the same storage — `initialize()`
    // only builds the lightweight index, not the per-file comment cache, so this instance's cache
    // is genuinely cold, the way a just-activated extension's would be for a file nothing has
    // opened yet this session.
    const seedStore = new CommentStore(storageUri);
    await seedStore.initialize();
    await seedStore.addComment(
      filePath,
      { lineHint: 1, endLineHint: 1, contentHash: 'h', contextBefore: '', contextAfter: '', status: 'exact' },
      'hi',
      { type: 'user' }
    );

    const store = new CommentStore(storageUri);
    await store.initialize();
    const onNeedsRefresh = jest.fn();
    const rule = installRule(store, onNeedsRefresh);

    const tokens = [new FakeToken([0, 1])];
    rule({ env: { currentDocument: vscode.Uri.joinPath(repoUri, filePath) }, tokens });

    expect(tokens[0].attrs).toEqual({});
    expect(onNeedsRefresh).not.toHaveBeenCalled();

    await flush();
    expect(onNeedsRefresh).toHaveBeenCalledTimes(1);
  });

  it('dedupes concurrent cold-cache warm-ups for the same file across two render passes', async () => {
    const seedStore = new CommentStore(storageUri);
    await seedStore.initialize();
    await seedStore.addComment(
      filePath,
      { lineHint: 1, endLineHint: 1, contentHash: 'h', contextBefore: '', contextAfter: '', status: 'exact' },
      'hi',
      { type: 'user' }
    );

    const store = new CommentStore(storageUri);
    await store.initialize();
    const loadFileSpy = jest.spyOn(store, 'loadFile');
    const onNeedsRefresh = jest.fn();
    const rule = installRule(store, onNeedsRefresh);

    // Two preview tabs on the same cold file rendering back to back, before either warm-up settles.
    rule({ env: { currentDocument: vscode.Uri.joinPath(repoUri, filePath) }, tokens: [new FakeToken([0, 1])] });
    rule({ env: { currentDocument: vscode.Uri.joinPath(repoUri, filePath) }, tokens: [new FakeToken([0, 1])] });

    expect(loadFileSpy).toHaveBeenCalledTimes(1);
    await flush();
    expect(onNeedsRefresh).toHaveBeenCalledTimes(1);
  });

  it('renders no markers when a warm cache has comments but none fall inside any block', async () => {
    const store = new CommentStore(storageUri);
    await store.initialize();
    await store.addComment(
      filePath,
      { lineHint: 10, endLineHint: 10, contentHash: 'h', contextBefore: '', contextAfter: '', status: 'exact' },
      'off the edge',
      { type: 'user' }
    );
    await store.loadFile(filePath);

    const rule = installRule(store, jest.fn());
    const tokens = [new FakeToken([0, 1])]; // covers line 0 only — the comment is on line 9 (0-based)
    rule({ env: { currentDocument: vscode.Uri.joinPath(repoUri, filePath) }, tokens });

    expect(tokens[0].attrs).toEqual({});
  });

  it('marks the matching block once the cache is warm', async () => {
    const store = new CommentStore(storageUri);
    await store.initialize();
    await store.addComment(
      filePath,
      { lineHint: 3, endLineHint: 3, contentHash: 'h', contextBefore: '', contextAfter: '', status: 'exact' },
      'looks off',
      { type: 'agent' }
    );
    await store.loadFile(filePath); // warm the cache the plugin peeks at

    const rule = installRule(store, jest.fn());
    // lineHint 3 is 1-based -> 0-based line 2, inside the second block's [2, 4) range.
    const tokens = [new FakeToken([0, 2]), new FakeToken([2, 4])];
    rule({ env: { currentDocument: vscode.Uri.joinPath(repoUri, filePath) }, tokens });

    expect(tokens[0].attrs).toEqual({});
    expect(tokens[1].attrs.class).toContain('agent-comment-line');
    expect(tokens[1].attrs.class).toContain('agent-comment-authors-agent');
    expect(tokens[1].attrs['data-agent-comment-count']).toBe('1');
    expect(tokens[1].attrs['data-agent-comment-has-unresolved']).toBe('true');
    expect(tokens[1].attrs['data-agent-comment-has-resolved']).toBe('false');
    const parsed = JSON.parse(tokens[1].attrs['data-agent-comments-json']);
    expect(parsed).toEqual([{ id: expect.any(String), author: 'agent', status: 'unresolved', text: 'looks off' }]);
    expect(tokens[1].attrs.title).toContain('looks off');
  });

  it('marks the paragraph_open token, not its inline child, even though both share the exact same map (regression: markdown-it renders inline tokens by their .children and never reads their own .attrs)', async () => {
    const store = new CommentStore(storageUri);
    await store.initialize();
    await store.addComment(
      filePath,
      { lineHint: 1, endLineHint: 1, contentHash: 'h', contextBefore: '', contextAfter: '', status: 'exact' },
      'hi',
      { type: 'user' }
    );
    await store.loadFile(filePath);

    const rule = installRule(store, jest.fn());
    // Exactly what a real paragraph produces: paragraph_open and its inline child share [0, 1).
    const paragraphOpen = new FakeToken([0, 1], 'paragraph_open');
    const inline = new FakeToken([0, 1], 'inline');
    const paragraphClose = new FakeToken(null, 'paragraph_close');
    rule({ env: { currentDocument: vscode.Uri.joinPath(repoUri, filePath) }, tokens: [paragraphOpen, inline, paragraphClose] });

    expect(paragraphOpen.attrs.class).toContain('agent-comment-line');
    expect(inline.attrs).toEqual({});
  });

  it('skips a token with no source map when locating comment blocks, and falls back to "unknown" resolver in the title', async () => {
    mockVscode.__setConfig('agenticComments.editor.hideResolvedComments', false);
    const store = new CommentStore(storageUri);
    await store.initialize();
    const added = await store.addComment(
      filePath,
      { lineHint: 1, endLineHint: 1, contentHash: 'h', contextBefore: '', contextAfter: '', status: 'exact' },
      'stale',
      { type: 'user' }
    );
    await store.resolveComment(filePath, added.id, { type: 'user' });
    // Overwrite the archive on disk with a resolvedBy-less record — not reachable through the
    // store's own resolveComment (which always sets it), same defensive case treeView.ts's own
    // fallback covers. Going through the real file + readArchive (rather than mocking the method)
    // so the store's own archiveCache is genuinely populated, the way `peekCachedComments` expects.
    await vscode.workspace.fs.writeFile(
      archiveFileUri(storageUri, filePath),
      Buffer.from(
        `${JSON.stringify({
          id: added.id,
          anchor: { lineHint: 1, endLineHint: 1, contentHash: 'h', contextBefore: '', contextAfter: '', status: 'exact' },
          author: { type: 'user' },
          text: 'stale',
          status: 'resolved',
          resolvedBy: null,
          createdAt: '',
          updatedAt: '',
          filePath,
          archivedAt: '',
        })}\n`,
        'utf8'
      )
    );
    await store.loadFile(filePath); // warms the live side; archive is still cold

    const rule = installRule(store, jest.fn());
    // An inline token (e.g. text inside a paragraph) carries no source map — the plugin must skip
    // it rather than crash, and still find the match on the mapped token that follows.
    const inlineToken = new FakeToken(null);
    const blockToken = new FakeToken([0, 1]);
    const env = { currentDocument: vscode.Uri.joinPath(repoUri, filePath) };
    rule({ env, tokens: [inlineToken, blockToken] }); // cold archive: warms it, no markers this pass
    await flush();

    rule({ env, tokens: [inlineToken, blockToken] }); // now warm: actually matches

    expect(inlineToken.attrs).toEqual({});
    expect(blockToken.attrs.title).toBe('You (resolved by unknown): stale');
  });

  it('excludes resolved comments when hideResolvedComments is on (default)', async () => {
    const store = new CommentStore(storageUri);
    await store.initialize();
    const added = await store.addComment(
      filePath,
      { lineHint: 1, endLineHint: 1, contentHash: 'h', contextBefore: '', contextAfter: '', status: 'exact' },
      'resolved one',
      { type: 'user' }
    );
    await store.resolveComment(filePath, added.id, { type: 'user' });
    await store.loadFile(filePath);

    const rule = installRule(store, jest.fn());
    const tokens = [new FakeToken([0, 1])];
    rule({ env: { currentDocument: vscode.Uri.joinPath(repoUri, filePath) }, tokens });

    expect(tokens[0].attrs).toEqual({});
  });

  it('includes resolved comments when hideResolvedComments is off, warming the archive cache too', async () => {
    mockVscode.__setConfig('agenticComments.editor.hideResolvedComments', false);
    const store = new CommentStore(storageUri);
    await store.initialize();
    const added = await store.addComment(
      filePath,
      { lineHint: 1, endLineHint: 1, contentHash: 'h', contextBefore: '', contextAfter: '', status: 'exact' },
      'resolved one',
      { type: 'user' }
    );
    await store.resolveComment(filePath, added.id, { type: 'user' });
    // Live side only — archive side is still cold.
    await store.loadFile(filePath);

    const onNeedsRefresh = jest.fn();
    const rule = installRule(store, onNeedsRefresh);
    const tokens = [new FakeToken([0, 1])];
    rule({ env: { currentDocument: vscode.Uri.joinPath(repoUri, filePath) }, tokens });

    // Archive cache was cold, so this pass still renders nothing — but warms it.
    expect(tokens[0].attrs).toEqual({});
    await flush();
    expect(onNeedsRefresh).toHaveBeenCalledTimes(1);

    // A second pass, now both caches warm, shows the resolved comment's marker.
    const tokens2 = [new FakeToken([0, 1])];
    rule({ env: { currentDocument: vscode.Uri.joinPath(repoUri, filePath) }, tokens: tokens2 });
    expect(tokens2[0].attrs['data-agent-comment-has-resolved']).toBe('true');
    expect(tokens2[0].attrs['data-agent-comment-has-unresolved']).toBe('false');
  });
});
