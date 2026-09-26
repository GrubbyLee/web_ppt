import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, Check, CheckCircle2, Edit3, Eye, Minus, Plus, Save, Search, TriangleAlert } from "lucide-react";
import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import type { PresentationPage, PresentationSession, Project } from "@showit/contracts";
import { ToolbarButton } from "../../components/ToolbarButton";
import type { SaveState } from "../../stores/presentation-store";
import { resolveTemplate } from "../../lib/template";

type NotesPanelProps = {
  project: Project;
  session: PresentationSession;
  page: PresentationPage;
  saveState: SaveState;
  lastSavedAt: number | null;
  onMarkdownChange: (markdown: string) => void;
  onStepToggle: (stepId: string) => void;
  onNextStep: () => void;
  stepExecution: { stepId: string; state: "running" | "failed" | "manual"; reason?: string } | null;
  onFontScale: (value: number) => void;
  onSaveIntent: () => void;
  onEditingChange: (editing: boolean) => void;
};

export function NotesPanel({
  project,
  session,
  page,
  saveState,
  lastSavedAt,
  onMarkdownChange,
  onStepToggle,
  onNextStep,
  stepExecution,
  onFontScale,
  onSaveIntent,
  onEditingChange
}: NotesPanelProps) {
  const [mode, setMode] = useState<"preview" | "edit">("preview");
  const [search, setSearch] = useState("");
  const [searchState, setSearchState] = useState("");
  const surface = useRef<HTMLElement>(null);
  const completed = useMemo(() => new Set(session.completedStepIds), [session.completedStepIds]);
  const nextStep = page.script.steps.find((step) => !completed.has(step.id));
  const resolvedMarkdown = useMemo(() => resolveTemplate(page.script.markdown, project, page, "markdown"), [page, project]);
  const resolvedPurpose = useMemo(() => resolveTemplate(page.purpose, project, page), [page, project]);
  const saveLabel =
    saveState === "saving"
      ? "保存中"
      : saveState === "error"
        ? "保存失败"
        : lastSavedAt
          ? `已保存 ${new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(lastSavedAt)}`
          : "已保存";

  const scrollKey = `showit:notes-scroll:v1:${project.id}:${page.id}:${mode}`;
  useEffect(() => {
    onEditingChange(mode === "edit");
    return () => onEditingChange(false);
  }, [mode, onEditingChange]);

  useEffect(() => {
    const saved = Number(sessionStorage.getItem(scrollKey));
    const frame = window.requestAnimationFrame(() => {
      if (surface.current && Number.isFinite(saved)) surface.current.scrollTop = Math.max(0, saved);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [scrollKey]);

  const findInNotes = () => {
    const query = search.trim().toLocaleLowerCase();
    if (!query || !surface.current) {
      setSearchState("");
      return;
    }
    if (mode === "edit") {
      const textarea = surface.current.querySelector("textarea");
      const index = textarea?.value.toLocaleLowerCase().indexOf(query) ?? -1;
      if (textarea && index >= 0) {
        textarea.focus();
        textarea.setSelectionRange(index, index + query.length);
        setSearchState("已定位");
      } else setSearchState("未找到");
      return;
    }
    const walker = document.createTreeWalker(surface.current, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      const index = node.textContent?.toLocaleLowerCase().indexOf(query) ?? -1;
      if (index >= 0) {
        const range = document.createRange();
        range.setStart(node, index);
        range.setEnd(node, index + query.length);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        (node.parentElement ?? surface.current).scrollIntoView({ block: "center" });
        setSearchState("已定位");
        return;
      }
      node = walker.nextNode();
    }
    setSearchState("未找到");
  };

  return (
    <aside className="notes-panel" aria-label="演讲备注">
      <header className="notes-head">
        <div>
          <span className="eyebrow">{page.section}</span>
          <h1>{page.title}</h1>
        </div>
        <div className="notes-actions">
          <span className={`save-state save-state--${saveState}`} title="保存到本次演示，退出时合并回项目">
            {saveState === "error" ? <TriangleAlert size={14} /> : saveState === "saving" ? <Save size={14} /> : <CheckCircle2 size={14} />}
            {saveLabel}
          </span>
          <ToolbarButton icon={<Minus size={15} />} title="缩小字号" onClick={() => onFontScale(project.layout.noteFontScale - 0.05)} />
          <ToolbarButton icon={<Plus size={15} />} title="放大字号" onClick={() => onFontScale(project.layout.noteFontScale + 0.05)} />
        </div>
      </header>

      <section className="purpose-block">
        <span>本页目的</span>
        <p>{resolvedPurpose.ok ? resolvedPurpose.value : page.purpose}</p>
      </section>

      <div className="notes-tabs" role="tablist" aria-label="脚本视图">
        <button className={mode === "preview" ? "is-active" : ""} type="button" onClick={() => setMode("preview")}>
          <Eye size={14} /> 演示预览
        </button>
        <button className={mode === "edit" ? "is-active" : ""} type="button" onClick={() => setMode("edit")}>
          <Edit3 size={14} /> Markdown
        </button>
      </div>

      <form className="notes-search" onSubmit={(event) => { event.preventDefault(); findInNotes(); }}>
        <input aria-label="搜索备注" value={search} placeholder="搜索备注" onChange={(event) => { setSearch(event.target.value); setSearchState(""); }} />
        <ToolbarButton type="submit" icon={<Search size={14} />} title="在备注中定位" />
        {searchState ? <span>{searchState}</span> : null}
      </form>

      <section className="steps-list" aria-label="演示步骤">
        <header className="steps-list__head">
          <span>{nextStep ? "当前步骤" : "本页已完成"}</span>
          <button type="button" className="steps-next" disabled={stepExecution?.state === "running"} onClick={onNextStep}>
            <ArrowRight size={13} /> 下一步骤
          </button>
        </header>
        {page.script.steps.map((step) => {
          const resolved = resolveTemplate(step.text, project, page);
          const execution = stepExecution?.stepId === step.id ? stepExecution : null;
          return (
          <button
            key={step.id}
            type="button"
            className={`${completed.has(step.id) ? "is-done" : ""} ${nextStep?.id === step.id ? "is-current" : ""} ${execution ? `is-${execution.state}` : ""}`}
            aria-current={nextStep?.id === step.id ? "step" : undefined}
            onClick={() => onStepToggle(step.id)}
          >
            <Check size={13} />
            <span>{step.kind}</span>
            <strong>{resolved.ok ? resolved.value : step.text}</strong>
            {execution ? <small role="status">{execution.state === "running" ? "正在执行..." : execution.reason}</small> : null}
          </button>
          );
        })}
      </section>

      <section ref={surface} className="markdown-surface" style={{ fontSize: `${project.layout.noteFontScale}rem` }} onScroll={(event) => sessionStorage.setItem(scrollKey, String(event.currentTarget.scrollTop))}>
        {mode === "preview" ? (
          <>
            {!resolvedMarkdown.ok ? <div className="template-error"><TriangleAlert size={14} />{resolvedMarkdown.errors.join("；")}</div> : null}
            <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>
              {resolvedMarkdown.ok ? resolvedMarkdown.value : page.script.markdown}
            </ReactMarkdown>
          </>
        ) : (
          <textarea
            aria-label="Markdown 演讲脚本"
            value={page.script.markdown}
            onChange={(event) => {
              onSaveIntent();
              onMarkdownChange(event.target.value);
            }}
          />
        )}
      </section>
    </aside>
  );
}
