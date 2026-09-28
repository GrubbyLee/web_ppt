export type MarkdownInsertionKind = "heading" | "list" | "quote" | "code" | "steps";

export type MarkdownEdit = {
  value: string;
  selectionStart: number;
  selectionEnd: number;
};

export function proportionalScrollTop(
  sourceTop: number,
  sourceScrollHeight: number,
  sourceClientHeight: number,
  targetScrollHeight: number,
  targetClientHeight: number
): number {
  const sourceRange = Math.max(0, sourceScrollHeight - sourceClientHeight);
  const targetRange = Math.max(0, targetScrollHeight - targetClientHeight);
  if (sourceRange === 0 || targetRange === 0) return 0;
  return Math.max(0, Math.min(targetRange, (sourceTop / sourceRange) * targetRange));
}

function selectedLines(value: string, start: number, end: number): { start: number; end: number; text: string } {
  const lineStart = value.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
  const nextBreak = value.indexOf("\n", end);
  const lineEnd = nextBreak < 0 ? value.length : nextBreak;
  return { start: lineStart, end: lineEnd, text: value.slice(lineStart, lineEnd) };
}

function replace(value: string, start: number, end: number, text: string, selectionStart: number, selectionEnd: number): MarkdownEdit {
  return {
    value: `${value.slice(0, start)}${text}${value.slice(end)}`,
    selectionStart: start + selectionStart,
    selectionEnd: start + selectionEnd
  };
}

function blockPadding(value: string, start: number, end: number): { before: string; after: string } {
  const before = start > 0 && !value.slice(0, start).endsWith("\n\n")
    ? value[start - 1] === "\n" ? "\n" : "\n\n"
    : "";
  const after = end < value.length && !value.slice(end).startsWith("\n\n")
    ? value[end] === "\n" ? "\n" : "\n\n"
    : "";
  return { before, after };
}

export function insertMarkdown(value: string, selectionStart: number, selectionEnd: number, kind: MarkdownInsertionKind): MarkdownEdit {
  const start = Math.max(0, Math.min(value.length, selectionStart));
  const end = Math.max(start, Math.min(value.length, selectionEnd));
  const selected = value.slice(start, end);

  if (kind === "heading") {
    const lines = selectedLines(value, start, end);
    const text = lines.text || "标题";
    const replacement = `## ${text}`;
    return replace(value, lines.start, lines.end, replacement, 3, replacement.length);
  }

  if (kind === "list" || kind === "quote") {
    const lines = selectedLines(value, start, end);
    const prefix = kind === "list" ? "- " : "> ";
    const source = lines.text || (kind === "list" ? "列表项" : "引用");
    const replacement = source.split("\n").map((line) => `${prefix}${line}`).join("\n");
    return replace(value, lines.start, lines.end, replacement, prefix.length, replacement.length);
  }

  const padding = blockPadding(value, start, end);
  if (kind === "code") {
    const content = selected || "代码";
    const replacement = `${padding.before}\`\`\`\n${content}\n\`\`\`${padding.after}`;
    const contentStart = padding.before.length + 4;
    return replace(value, start, end, replacement, contentStart, contentStart + content.length);
  }

  const template = "## 演示步骤\n\n- 讲述：\n- 操作：\n- 预期：\n- 转场：";
  const replacement = `${padding.before}${template}${padding.after}`;
  const cursor = padding.before.length + template.indexOf("讲述：") + "讲述：".length;
  return replace(value, start, end, replacement, cursor, cursor);
}
