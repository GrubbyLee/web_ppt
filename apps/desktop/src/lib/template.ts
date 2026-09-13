import { validateBusinessUrl, type PresentationPage, type Project } from "@showit/contracts";

export type TemplateMode = "text" | "markdown" | "url";

export type TemplateResult =
  | { ok: true; value: string }
  | { ok: false; errors: string[] };

const tokenPattern = /{{\s*([^{}]+?)\s*}}/g;
const markdownSpecialCharacters = /([\\`*{}\[\]()<>#+\-.!_|])/g;

function escapeMarkdownLiteral(value: string): string {
  return value.replace(markdownSpecialCharacters, "\\$1");
}

function variableMap(project: Project, page: PresentationPage): Map<string, string> {
  const values = new Map<string, string>([
    ["role", page.role],
    ["page.id", page.id],
    ["page.title", page.title]
  ]);
  for (const variable of project.variables) values.set(`project.${variable.key}`, variable.value);
  for (const variable of page.variables) values.set(`page.${variable.key}`, variable.value);
  return values;
}

function templateError(message: string, input: string, offset: number, mode: TemplateMode): string {
  if (mode !== "markdown") return message;
  const line = input.slice(0, offset).split("\n").length;
  return `第 ${line} 行：${message}`;
}

export function resolveTemplate(
  input: string,
  project: Project,
  page: PresentationPage,
  mode: TemplateMode = "text"
): TemplateResult {
  const values = variableMap(project, page);
  const errors = new Set<string>();
  const value = input.replace(tokenPattern, (_match, rawToken: string, offset: number) => {
    const token = rawToken.trim();
    const replacement = values.get(token);
    if (replacement === undefined) {
      errors.add(templateError(`未定义变量：${token}`, input, offset, mode));
      return "";
    }
    if (mode === "url") return encodeURIComponent(replacement);
    return mode === "markdown" ? escapeMarkdownLiteral(replacement) : replacement;
  });

  if (value.includes("{{") || value.includes("}}")) {
    errors.add(templateError("模板包含不完整的变量占位符。", input, Math.max(0, input.search(/{{|}}/)), mode));
  }
  return errors.size > 0 ? { ok: false, errors: [...errors] } : { ok: true, value };
}

export function resolveUrlTemplate(input: string, project: Project, page: PresentationPage): TemplateResult {
  const resolved = resolveTemplate(input, project, page, "url");
  if (!resolved.ok) return resolved;
  const validation = validateBusinessUrl(resolved.value);
  return validation.valid
    ? resolved
    : { ok: false, errors: [validation.reason ?? "业务 URL 无效。"] };
}
