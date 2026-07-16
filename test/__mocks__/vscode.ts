/**
 * Hand-rolled stand-in for the `vscode` module. Not type-checked against @types/vscode (tests
 * live outside tsconfig's `include`) — only needs to be runtime-compatible with how src/ uses it.
 * Extra exports beyond the real API (createTextDocument, __reset, _emitters) are test-only helpers.
 */

// ---------- Uri ----------

export class Uri {
  private constructor(
    public readonly scheme: string,
    public readonly authority: string,
    public readonly path: string
  ) {}

  get fsPath(): string {
    return this.path;
  }

  toString(): string {
    return `${this.scheme}://${this.authority}${this.path}`;
  }

  toJSON(): string {
    return this.toString();
  }

  static file(p: string): Uri {
    const normalized = p.replace(/\\/g, '/');
    const path = normalized.startsWith('/') ? normalized : `/${normalized}`;
    return new Uri('file', '', path);
  }

  static parse(value: string): Uri {
    const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/]*)(\/.*)?$/.exec(value);
    if (!m) {
      return Uri.file(value);
    }
    return new Uri(m[1], m[2] ?? '', m[3] ?? '');
  }

  static joinPath(base: Uri, ...segments: string[]): Uri {
    let path = base.path;
    for (const raw of segments) {
      const seg = raw.replace(/\\/g, '/');
      path = path.endsWith('/') ? path + seg : `${path}/${seg}`;
    }
    return new (Uri as any)(base.scheme, base.authority, path);
  }
}

// ---------- Position / Range / Selection ----------

export class Position {
  constructor(public readonly line: number, public readonly character: number) {}
}

export class Range {
  public readonly start: Position;
  public readonly end: Position;

  constructor(startLine: number | Position, startCharOrEnd: number | Position, endLine?: number, endChar?: number) {
    if (startLine instanceof Position) {
      this.start = startLine;
      this.end = startCharOrEnd as Position;
    } else {
      this.start = new Position(startLine, startCharOrEnd as number);
      this.end = new Position(endLine as number, endChar as number);
    }
  }
}

export class Selection extends Range {
  public readonly anchor: Position;
  public readonly active: Position;
  constructor(anchor: Position, active: Position) {
    super(anchor, active);
    this.anchor = anchor;
    this.active = active;
  }
}

// ---------- Enums (plain objects; only member access is exercised at runtime) ----------

export const FileType = { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 } as const;
export const CommentMode = { Editing: 0, Preview: 1 } as const;
export const CommentThreadCollapsibleState = { Collapsed: 0, Expanded: 1 } as const;
export const TextEditorRevealType = { Default: 0, InCenter: 1, InCenterIfOutsideViewport: 2, AtTop: 3 } as const;
export const TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 } as const;

// ---------- Simple value classes ----------

export class ThemeColor {
  constructor(public readonly id: string) {}
}

export class ThemeIcon {
  constructor(public readonly id: string, public readonly color?: ThemeColor) {}
}

export class MarkdownString {
  constructor(public value?: string) {}
}

export class TreeItem {
  public description?: string;
  public tooltip?: unknown;
  public iconPath?: unknown;
  public contextValue?: string;
  public command?: unknown;
  constructor(public label: string, public collapsibleState?: number) {}
}

export class McpHttpServerDefinition {
  constructor(public label: string, public uri: Uri, public headers: Record<string, string>) {}
}

// ---------- EventEmitter ----------

export interface Disposable {
  dispose(): void;
}

export class EventEmitter<T> {
  private listeners: Array<(e: T) => void> = [];
  event = (listener: (e: T) => void): Disposable => {
    this.listeners.push(listener);
    return {
      dispose: () => {
        this.listeners = this.listeners.filter((l) => l !== listener);
      },
    };
  };
  fire(data: T): void {
    for (const l of [...this.listeners]) {
      l(data);
    }
  }
  dispose(): void {
    this.listeners = [];
  }
}

// ---------- In-memory filesystem backing workspace.fs ----------

type FsEntry = { type: 'file'; content: Uint8Array } | { type: 'dir' };
const fsStore = new Map<string, FsEntry>();

function ensureParentDirs(uri: Uri): void {
  const parts = uri.path.split('/').filter(Boolean);
  let cur = '';
  for (let i = 0; i < parts.length - 1; i++) {
    cur += `/${parts[i]}`;
    const key = `${uri.scheme}://${uri.authority}${cur}`;
    if (!fsStore.has(key)) {
      fsStore.set(key, { type: 'dir' });
    }
  }
}

async function statImpl(uri: Uri) {
  const entry = fsStore.get(uri.toString());
  if (!entry) {
    throw new Error(`ENOENT: ${uri.toString()}`);
  }
  return {
    type: entry.type === 'dir' ? FileType.Directory : FileType.File,
    ctime: 0,
    mtime: 0,
    size: entry.type === 'file' ? entry.content.length : 0,
  };
}

async function readFileImpl(uri: Uri): Promise<Uint8Array> {
  const entry = fsStore.get(uri.toString());
  if (!entry || entry.type !== 'file') {
    throw new Error(`ENOENT: ${uri.toString()}`);
  }
  return entry.content;
}

async function writeFileImpl(uri: Uri, content: Uint8Array): Promise<void> {
  ensureParentDirs(uri);
  fsStore.set(uri.toString(), { type: 'file', content });
}

async function createDirectoryImpl(uri: Uri): Promise<void> {
  ensureParentDirs(uri);
  const existing = fsStore.get(uri.toString());
  if (!existing) {
    fsStore.set(uri.toString(), { type: 'dir' });
  }
}

async function deleteImpl(uri: Uri, options?: { recursive?: boolean; useTrash?: boolean }): Promise<void> {
  const key = uri.toString();
  if (!fsStore.has(key)) {
    throw new Error(`ENOENT: ${key}`);
  }
  fsStore.delete(key);
  if (options?.recursive) {
    const prefix = `${key}/`;
    for (const k of Array.from(fsStore.keys())) {
      if (k.startsWith(prefix)) {
        fsStore.delete(k);
      }
    }
  }
}

async function readDirectoryImpl(uri: Uri): Promise<[string, number][]> {
  const prefix = `${uri.toString()}/`;
  const seen = new Set<string>();
  const results: [string, number][] = [];
  for (const [k, v] of fsStore) {
    if (!k.startsWith(prefix)) {
      continue;
    }
    const rest = k.slice(prefix.length);
    if (rest.length === 0) {
      continue;
    }
    const name = rest.split('/')[0];
    if (seen.has(name)) {
      continue;
    }
    seen.add(name);
    const isDirectEntry = !rest.includes('/');
    const type = isDirectEntry && v.type === 'file' ? FileType.File : FileType.Directory;
    results.push([name, type]);
  }
  return results;
}

// ---------- TextDocument helper (test-only, but shaped like vscode.TextDocument) ----------

export function createTextDocument(uri: Uri, content: string) {
  let text = content;
  return {
    uri,
    getText: (): string => text,
    get lineCount(): number {
      return text.split('\n').length;
    },
    lineAt: (line: number) => {
      const lines = text.split('\n');
      if (line < 0 || line >= lines.length) {
        throw new Error(`Illegal line ${line}`);
      }
      const raw = lines[line];
      return { text: raw, lineNumber: line, range: new Range(line, 0, line, raw.length) };
    },
    __setText: (newText: string): void => {
      text = newText;
    },
  };
}
export type MockTextDocument = ReturnType<typeof createTextDocument>;

function createTextEditor(document: MockTextDocument) {
  return {
    document,
    selection: new Selection(new Position(0, 0), new Position(0, 0)),
    revealRange: jest.fn(),
  };
}
export type MockTextEditor = ReturnType<typeof createTextEditor>;

// ---------- Event emitters backing workspace/window subscriptions ----------

export const _emitters = {
  didOpenTextDocument: new EventEmitter<MockTextDocument>(),
  didChangeTextDocument: new EventEmitter<{ document: MockTextDocument; contentChanges: unknown[] }>(),
  didCloseTextDocument: new EventEmitter<MockTextDocument>(),
  didChangeVisibleTextEditors: new EventEmitter<MockTextEditor[]>(),
};

// ---------- configuration ----------

const configStore = new Map<string, unknown>();

/** Test-only helper: `key` is the fully-qualified setting id, e.g. "agenticComments.mcp.snippetMaxChars". */
export function __setConfig(key: string, value: unknown): void {
  configStore.set(key, value);
}

// ---------- workspace ----------

export const workspace = {
  getConfiguration(section?: string) {
    return {
      get<T>(key: string, defaultValue?: T): T {
        const fullKey = section ? `${section}.${key}` : key;
        return configStore.has(fullKey) ? (configStore.get(fullKey) as T) : (defaultValue as T);
      },
    };
  },

  workspaceFolders: undefined as Array<{ uri: Uri; name: string; index: number }> | undefined,
  textDocuments: [] as MockTextDocument[],

  fs: {
    stat: statImpl,
    readFile: readFileImpl,
    writeFile: writeFileImpl,
    createDirectory: createDirectoryImpl,
    delete: deleteImpl,
    readDirectory: readDirectoryImpl,
  },

  asRelativePath(pathOrUri: Uri | string, includeWorkspaceFolder?: boolean): string {
    const p = typeof pathOrUri === 'string' ? pathOrUri : pathOrUri.path;
    const folders = workspace.workspaceFolders ?? [];
    for (const folder of folders) {
      const base = folder.uri.path;
      if (p === base || p.startsWith(`${base}/`)) {
        const rel = p === base ? '' : p.slice(base.length + 1);
        return includeWorkspaceFolder ? `${folder.name}/${rel}` : rel;
      }
    }
    return p.replace(/^\//, '');
  },

  async openTextDocument(target: Uri | string): Promise<MockTextDocument> {
    const uri = typeof target === 'string' ? Uri.file(target) : target;
    const existing = workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    if (existing) {
      return existing;
    }
    const bytes = await readFileImpl(uri);
    const doc = createTextDocument(uri, Buffer.from(bytes).toString('utf8'));
    workspace.textDocuments.push(doc);
    _emitters.didOpenTextDocument.fire(doc);
    return doc;
  },

  onDidOpenTextDocument: _emitters.didOpenTextDocument.event,
  onDidChangeTextDocument: _emitters.didChangeTextDocument.event,
  onDidCloseTextDocument: _emitters.didCloseTextDocument.event,
};

// ---------- window ----------

export const window = {
  activeTextEditor: undefined as MockTextEditor | undefined,
  visibleTextEditors: [] as MockTextEditor[],

  showWarningMessage: jest.fn(async (..._args: unknown[]) => undefined as string | undefined),
  showErrorMessage: jest.fn(async (..._args: unknown[]) => undefined as string | undefined),
  showInformationMessage: jest.fn(async (..._args: unknown[]) => undefined as string | undefined),

  onDidChangeVisibleTextEditors: _emitters.didChangeVisibleTextEditors.event,

  showTextDocument: jest.fn(async (document: MockTextDocument) => {
    const editor = createTextEditor(document);
    window.activeTextEditor = editor;
    window.visibleTextEditors.push(editor);
    return editor;
  }),

  registerFileDecorationProvider: jest.fn((_provider: unknown) => ({ dispose: jest.fn() })),
  registerTreeDataProvider: jest.fn((_id: string, _provider: unknown) => ({ dispose: jest.fn() })),
};

// ---------- commands ----------

const commandRegistry = new Map<string, (...args: unknown[]) => unknown>();

export const commands = {
  registerCommand: jest.fn((name: string, cb: (...args: unknown[]) => unknown) => {
    commandRegistry.set(name, cb);
    return { dispose: () => commandRegistry.delete(name) };
  }),
  executeCommand: jest.fn(async (name: string, ...args: unknown[]) => {
    const cb = commandRegistry.get(name);
    return cb ? cb(...args) : undefined;
  }),
};

// ---------- comments ----------

export const comments = {
  createCommentController: jest.fn((id: string, label: string) => {
    const controller = {
      id,
      label,
      commentingRangeProvider: undefined as unknown,
      createCommentThread: jest.fn((uri: Uri, range: Range, cmts: unknown[]) => ({
        uri,
        range,
        comments: cmts,
        canReply: true,
        contextValue: undefined as string | undefined,
        label: undefined as string | undefined,
        collapsibleState: TreeItemCollapsibleState.None as number,
        dispose: jest.fn(),
      })),
      dispose: jest.fn(),
    };
    return controller;
  }),
};

// ---------- lm ----------

export const lm = {
  registerMcpServerDefinitionProvider: jest.fn((_id: string, _provider: unknown) => ({ dispose: jest.fn() })),
};

// ---------- test-only reset ----------

export function __reset(): void {
  fsStore.clear();
  configStore.clear();
  workspace.workspaceFolders = undefined;
  workspace.textDocuments = [];
  window.activeTextEditor = undefined;
  window.visibleTextEditors = [];
  commandRegistry.clear();
}
