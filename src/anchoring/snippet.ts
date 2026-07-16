/** Truncates to at most `maxChars` characters, appending a marker noting how much was cut.
 * `maxChars <= 0` is a no-op — the "0 means omit the field entirely" contract belongs to call
 * sites, not this pure trim function. */
export function truncateSnippet(text: string, maxChars: number): string {
  if (maxChars <= 0 || text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}\n… (truncated, ${text.length - maxChars} more chars)`;
}

/** No interactive expand affordance in v1 — VS Code's Comment/TreeItem markdown has no clean
 * collapsible widget — so a fixed cap plus a truncation marker is the whole UI story for now. */
export const UI_SNIPPET_MAX_CHARS = 800;

/** The "Originally: ```...```" markdown suffix shared by the comment-body renderer and the tree
 * view tooltip. Callers keep their own `status !== 'exact' && originalContent` guard since that
 * check is against differently-shaped view objects (Anchor vs ToolCommentView). */
export function formatOriginalSnippet(originalContent: string, maxChars: number): string {
  const snippet = truncateSnippet(originalContent, maxChars);
  return `\n\n---\n*Originally:*\n\`\`\`\n${snippet}\n\`\`\``;
}
