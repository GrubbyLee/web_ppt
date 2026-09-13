import { describe, expect, it } from "vitest";
import { insertMarkdown, proportionalScrollTop } from "./markdown-edit";

describe("Markdown editor insertions", () => {
  it("prefixes every selected line as a list", () => {
    const result = insertMarkdown("开始\n第一项\n第二项\n结束", 3, 10, "list");
    expect(result.value).toBe("开始\n- 第一项\n- 第二项\n结束");
    expect(result.value.slice(result.selectionStart, result.selectionEnd)).toBe("第一项\n- 第二项");
  });

  it("wraps selected text in a fenced code block", () => {
    const result = insertMarkdown("说明：示例结束", 3, 5, "code");
    expect(result.value).toBe("说明：\n\n```\n示例\n```\n\n结束");
    expect(result.value.slice(result.selectionStart, result.selectionEnd)).toBe("示例");
  });

  it("inserts a structured presentation step template", () => {
    const result = insertMarkdown("# 现场脚本", 6, 6, "steps");
    expect(result.value).toContain("## 演示步骤\n\n- 讲述：\n- 操作：\n- 预期：\n- 转场：");
    expect(result.selectionStart).toBe(result.selectionEnd);
    expect(result.value.slice(0, result.selectionStart)).toMatch(/讲述：$/);
  });

  it("maps source and preview scrolling by their available ranges", () => {
    expect(proportionalScrollTop(250, 1_000, 500, 2_000, 500)).toBe(750);
    expect(proportionalScrollTop(900, 1_000, 500, 2_000, 500)).toBe(1_500);
    expect(proportionalScrollTop(10, 100, 100, 2_000, 500)).toBe(0);
  });
});
