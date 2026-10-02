import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { browser } from "wxt/browser";
import {
  ProjectSchema,
  type ElementLocator,
  type ExpectedCondition,
  type PresentationConnector,
  type PresentationPage,
  type PresentationStep,
  type PresentationVariable,
  type Project,
  type ProjectVersion,
  type RecordedAction,
  type SensitiveRuntimeVariable,
  type StepKind
} from "@showit/contracts";
import { createId, createPage, createSession, duplicatePage, duplicateProject, normalizeProject } from "@/lib/project-workspace";
import { runProjectPreflight } from "@/lib/preflight";
import { downloadMarkdownScript } from "@/lib/export";
import { diffProjects } from "@/lib/project-diff";
import { createProjectSnapshot, listProjectVersions, loadWorkspace, publishProjectVersion, saveWorkspace, setActiveProject, type Workspace } from "@/lib/persistence";
import { recordDiagnostic } from "@/lib/diagnostics";
import { beginPresentationLaunch } from "@/lib/presentation-launch";
import { parseOfflineHtmlPackage, requestedOfflineOrigins } from "@/lib/offline-package";
import { projectTrustState, trustProject } from "@/lib/project-trust";
import { clearProjectDraft, loadProjectDraft, saveProjectDraft } from "@/lib/project-draft";
import { insertMarkdown, proportionalScrollTop, type MarkdownInsertionKind } from "@/lib/markdown-edit";
import { ToolbarButton } from "@/components/ToolbarButton";
import { MarkdownView } from "@/components/MarkdownView";
import type { RecorderState, WorkbenchPort } from "./App";
import { Camera, Check, ChevronDown, ChevronLeft, ChevronUp, CircleDot, Code2, Copy, FileDown, FileUp, GitCompare, Heading2, History, Link2, List, ListChecks, Play, Plus, Quote, RotateCcw, Save, Send, Square, Trash2, TriangleAlert, X } from "lucide-react";

type SaveStatus = "loading" | "dirty" | "saving" | "saved" | "error";

const PUBLISHER_STORAGE_KEY = "showit:publisher-name:v1";

const stepLabels: Record<StepKind, string> = { say: "讲述", act: "操作", expect: "预期", transition: "转场" };
const executionLabels: Record<PresentationStep["execution"], string> = { hint: "仅提示", highlight: "高亮", assist: "辅助执行", auto: "自动执行" };
const conditionLabels: Record<ExpectedCondition["type"], string> = { url: "URL 等于", title: "标题包含", element: "元素存在", text: "文本出现" };

// Chinese IMEs happily produce ，and ：— accept them wherever lists and
// name/value pairs are typed so entries never glue together into one item.
function splitListValue(value: string): string[] {
  return value.split(/[,，]/).map((item) => item.trim()).filter(Boolean);
}

const sandboxPermissionHints: Record<"allow-scripts" | "allow-same-origin" | "allow-forms", string> = {
  "allow-scripts": "允许业务页运行自身脚本；关闭后多数系统无法使用",
  "allow-same-origin": "允许业务页保留 Cookie 和登录态",
  "allow-forms": "允许业务页提交表单（如站内搜索）"
};

function recordedActionLabel(action: RecordedAction): string {
  if (action.type === "navigate") return `跳转到 ${new URL(action.url).pathname}`;
  if (action.type === "scroll") return `滚动页面到 ${action.y}px`;
  if (action.type === "focus") return "聚焦输入位置";
  if (action.type === "fill") return action.label ? `填写“${action.label}”` : "填写目标字段";
  return action.label ? `点击“${action.label}”` : "点击目标元素";
}

function defaultExpectedCondition(step: PresentationStep, page: PresentationPage, type: ExpectedCondition["type"]): ExpectedCondition {
  if (type === "url") {
    const value = step.recordedAction?.type === "navigate"
      ? step.recordedAction.url
      : page.url && !page.url.includes("{{") ? page.url : "https://example.com";
    return { type, value };
  }
  if (type === "title") return { type, value: page.title || "页面标题" };
  if (type === "text") return { type, value: step.text || "预期文本" };
  const locator = step.recordedAction && "locator" in step.recordedAction
    ? step.recordedAction.locator
    : { strategy: "testid" as const, value: "target" };
  return { type, locator };
}

function updatePage(project: Project, activePageId: string, change: (page: PresentationPage) => PresentationPage): Project {
  return normalizeProject({ ...project, pages: project.pages.map((page) => (page.id === activePageId ? change(page) : page)) });
}

function updateVariable(values: PresentationVariable[], index: number, change: (variable: PresentationVariable) => PresentationVariable): PresentationVariable[] {
  return values.map((variable, valueIndex) => valueIndex === index ? change(variable) : variable);
}

function updateSensitiveVariable(values: SensitiveRuntimeVariable[], index: number, change: (variable: SensitiveRuntimeVariable) => SensitiveRuntimeVariable): SensitiveRuntimeVariable[] {
  return values.map((variable, valueIndex) => valueIndex === index ? change(variable) : variable);
}

async function readBrandImage(file: File): Promise<string> {
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) throw new Error("品牌图仅支持 PNG、JPEG 或 WebP 格式。");
  if (file.size > 1_000_000) throw new Error("品牌图不能超过 1 MB。");
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("品牌图无法读取。"));
    reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("品牌图无法读取。"));
    reader.readAsDataURL(file);
  });
}

async function readMaskImage(file: File): Promise<string> {
  if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.type)) throw new Error("遮挡动图仅支持 PNG、JPEG、WebP 或 GIF 格式。");
  if (file.size > 1_000_000) throw new Error("遮挡动图不能超过 1 MB。");
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("遮挡动图无法读取。"));
    reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("遮挡动图无法读取。"));
    reader.readAsDataURL(file);
  });
}

async function readOfflineMedia(file: File, kind: "image" | "video"): Promise<string> {
  const allowed = kind === "image" ? ["image/png", "image/jpeg", "image/webp"] : ["video/mp4", "video/webm"];
  const limit = kind === "image" ? 10_000_000 : 45_000_000;
  if (!allowed.includes(file.type)) throw new Error(kind === "image" ? "离线图片仅支持 PNG、JPEG 或 WebP。" : "离线视频仅支持 MP4 或 WebM。");
  if (file.size > limit) throw new Error(`离线${kind === "image" ? "图片" : "视频"}不能超过 ${limit / 1_000_000} MB。`);
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("离线备用文件无法读取。"));
    reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("离线备用文件无法读取。"));
    reader.readAsDataURL(file);
  });
}

async function originPatternsForProject(project: Project): Promise<string[]> {
  const origins = new Set<string>();
  for (const connector of project.connectors) {
    try {
      origins.add(new URL(connector.origin).origin);
      connector.allowedOrigins.forEach((origin) => origins.add(new URL(origin).origin));
    } catch {
      // Invalid connector origins are surfaced by preflight.
    }
  }
  for (const page of project.pages) {
    if (!page.url) continue;
    try {
      origins.add(new URL(page.url.replace(/{{[^}]+}}/g, "showit-value")).origin);
    } catch {
      // Skip malformed templates.
    }
  }
  return [...origins].filter((origin) => origin.startsWith("https:") || origin.startsWith("http:")).map((origin) => `${origin}/*`);
}

export function Editor({ projectId, port, recorder, onRecordedAction, portReady }: {
  projectId: string;
  port: WorkbenchPort;
  recorder: RecorderState;
  onRecordedAction: (handler: (action: RecordedAction) => void) => () => void;
  portReady: boolean;
}) {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [activePageId, setActivePageId] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("loading");
  const [message, setMessage] = useState<string | null>(null);
  const [versions, setVersions] = useState<ProjectVersion[]>([]);
  const [compareVersionId, setCompareVersionId] = useState<string | null>(null);
  const [snapshotOpen, setSnapshotOpen] = useState(false);
  const [snapshotName, setSnapshotName] = useState("");
  const [publishOpen, setPublishOpen] = useState(false);
  const [publishPublisher, setPublishPublisher] = useState(() => localStorage.getItem(PUBLISHER_STORAGE_KEY) ?? "");
  const [publishSummary, setPublishSummary] = useState("");
  const [showAllVersions, setShowAllVersions] = useState(false);
  const [launchTrustOpen, setLaunchTrustOpen] = useState(false);
  const [launching, setLaunching] = useState(false);
  const markdownImport = useRef<HTMLInputElement>(null);
  const markdownEditor = useRef<HTMLTextAreaElement>(null);
  const markdownPreview = useRef<HTMLElement>(null);
  const markdownScrollOwner = useRef<"source" | "preview" | null>(null);
  const editRevision = useRef(0);

  useEffect(() => {
    loadWorkspace(projectId)
      .then((loaded) => {
        if (!loaded || loaded.project.id !== projectId) {
          setSaveStatus("error");
          setMessage("没有找到该本地项目。它可能已经被删除或尚未导入。");
          return;
        }
        const draft = loadProjectDraft(projectId);
        const recovered = draft !== null && JSON.stringify(draft) !== JSON.stringify(loaded.project);
        const next = recovered ? { ...loaded, project: draft } : loaded;
        setWorkspace(next);
        setActivePageId(next.project.pages[0]?.id ?? null);
        setSaveStatus(recovered ? "dirty" : "saved");
        if (recovered) setMessage("已恢复上次异常退出前尚未保存的编辑草稿。");
        listProjectVersions(projectId).then(setVersions).catch(() => setVersions([]));
      })
      .catch((error) => {
        recordDiagnostic("加载项目编辑器", error);
        setSaveStatus("error");
        setMessage("本地项目无法加载。");
      });
  }, [projectId]);

  const project = workspace?.project;
  const page = useMemo(() => project?.pages.find((item) => item.id === activePageId) ?? project?.pages[0], [activePageId, project]);
  const preflight = useMemo(() => project ? runProjectPreflight(project) : null, [project]);
  const compareVersion = useMemo(() => versions.find((version) => version.id === compareVersionId) ?? null, [compareVersionId, versions]);
  const differences = useMemo(() => project && compareVersion ? diffProjects(compareVersion.snapshot, project) : [], [compareVersion, project]);

  const changeProject = (change: (current: Project) => Project) => {
    editRevision.current += 1;
    setWorkspace((current) => {
      if (!current) return current;
      const changed = change(current.project);
      const nextProject = current.project.status === "published" && changed.status === "published" ? { ...changed, status: "draft" as const } : changed;
      return { ...current, project: normalizeProject(nextProject) };
    });
    setSaveStatus("dirty");
    setMessage(null);
  };

  useEffect(() => {
    if (saveStatus === "dirty" && workspace) saveProjectDraft(workspace.project);
  }, [saveStatus, workspace]);

  useEffect(() => onRecordedAction((action) => {
    editRevision.current += 1;
    setWorkspace((current) => {
      if (!current) return current;
      const targetPageId = activePageId ?? current.project.pages[0]?.id;
      const step: PresentationStep = {
        id: createId("step"),
        kind: action.type === "navigate" ? "transition" : "act",
        text: recordedActionLabel(action),
        execution: action.type === "click" || action.type === "navigate" ? "highlight" : "assist",
        recordedAction: action,
        conditionTimeoutSeconds: 8,
        risk: "normal",
        autoContinue: false
      };
      return { ...current, project: normalizeProject({ ...current.project, pages: current.project.pages.map((item) => item.id === targetPageId ? { ...item, script: { ...item.script, steps: [...item.script.steps, step] } } : item) }) };
    });
    setSaveStatus("dirty");
    setMessage("已记录一个不含输入值的操作步骤。");
  }), [activePageId, onRecordedAction]);

  useEffect(() => () => {
    if (recorder.active) port.send({ type: "recorder-stop", recordingId: projectId });
  }, [port, projectId, recorder.active]);

  const toggleRecorder = async () => {
    port.send({ type: recorder.active ? "recorder-stop" : "recorder-start", recordingId: projectId });
    if (!recorder.active && !portReady) setMessage("后台连接未就绪，无法开始操作录制。");
  };

  const authorizeRecorderOrigin = async () => {
    if (!recorder.origin) return;
    const granted = await browser.permissions.request({ origins: [`${recorder.origin}/*`] }).catch(() => false);
    if (granted) port.send({ type: "recorder-start", recordingId: projectId });
    else setMessage("站点授权被拒绝。");
  };

  const save = useCallback(async (showConfirmation = true) => {
    if (!workspace) return;
    const revision = editRevision.current;
    const projectResult = ProjectSchema.safeParse(normalizeProject(workspace.project));
    if (!projectResult.success) {
      setSaveStatus("error");
      setMessage(projectResult.error.issues[0]?.message ?? "项目配置不完整。");
      return;
    }
    setSaveStatus("saving");
    try {
      const next = { project: projectResult.data, session: workspace.session.projectId === projectResult.data.id ? workspace.session : createSession(projectResult.data) };
      await saveWorkspace(next);
      if (editRevision.current === revision) {
        clearProjectDraft(projectResult.data.id);
        setSaveStatus("saved");
        setMessage(showConfirmation ? "已保存到本机。" : null);
      } else {
        setSaveStatus("dirty");
      }
    } catch (error) {
      recordDiagnostic("保存项目编辑器", error);
      setSaveStatus("error");
      setMessage("保存失败。本次修改仍保留在编辑器中，请稍后重试。");
    }
  }, [workspace]);

  useEffect(() => {
    if (saveStatus !== "dirty") return;
    const handle = window.setTimeout(() => void save(false), 700);
    return () => window.clearTimeout(handle);
  }, [save, saveStatus]);

  const requestPublish = async () => {
    if (!workspace) return;
    const candidate = normalizeProject({ ...workspace.project, status: "published" });
    const report = runProjectPreflight(candidate);
    if (!report.canPublish) {
      setSaveStatus("error");
      setMessage(`发布前检查发现 ${report.errors.length} 项异常：${report.errors[0]?.message ?? "请修复项目配置。"}`);
      return;
    }
    const parsed = ProjectSchema.safeParse(candidate);
    if (!parsed.success) {
      setSaveStatus("error");
      setMessage(parsed.error.issues[0]?.message ?? "发布前检查未通过。");
      return;
    }
    setPublishSummary(versions.length === 0 ? "首次发布" : "发布更新");
    setPublishOpen(true);
  };

  const publish = async () => {
    if (!workspace) return;
    const candidate = normalizeProject({ ...workspace.project, status: "published" });
    const parsed = ProjectSchema.safeParse(candidate);
    if (!parsed.success) return;
    const publishedBy = publishPublisher.trim().slice(0, 120);
    if (publishedBy) localStorage.setItem(PUBLISHER_STORAGE_KEY, publishedBy);
    setSaveStatus("saving");
    try {
      const next = { ...workspace, project: parsed.data };
      await saveWorkspace(next);
      const summary = publishSummary.trim().slice(0, 500) || (versions.length === 0 ? "首次发布" : "发布更新");
      const version = await publishProjectVersion(parsed.data, summary, publishedBy);
      setWorkspace(next);
      setVersions((items) => [version, ...items]);
      setCompareVersionId(version.id);
      setSaveStatus("saved");
      setMessage(`版本 v${version.version} 已发布。`);
      setPublishOpen(false);
    } catch (error) {
      recordDiagnostic("发布项目版本", error);
      setSaveStatus("error");
      setMessage("发布失败，项目仍保留为本地草稿。");
    }
  };

  const snapshotBeforeBulkChange = async (summary: string) => {
    if (!project) return;
    try {
      const version = await createProjectSnapshot(normalizeProject(project), summary, "auto");
      setVersions((items) => [version, ...items]);
    } catch (error) {
      recordDiagnostic("批量修改前创建快照", error);
      throw error;
    }
  };

  const restoreVersion = async (version: ProjectVersion) => {
    try {
      await snapshotBeforeBulkChange(`恢复 v${version.version} 前自动快照`);
    } catch {
      setSaveStatus("error");
      setMessage("恢复前自动快照失败，未修改项目。");
      return;
    }
    editRevision.current += 1;
    const restored = { ...version.snapshot, status: "draft" as const };
    setWorkspace((current) => (current ? { ...current, project: restored } : current));
    setActivePageId(restored.pages[0]?.id ?? null);
    setSaveStatus("dirty");
    setMessage(`已恢复 v${version.version} 为草稿，保存后生效。`);
  };

  const duplicateVersion = async (version: ProjectVersion) => {
    try {
      const duplicate = duplicateProject(version.snapshot);
      await saveWorkspace({ project: duplicate, session: createSession(duplicate) });
      window.location.hash = `#/p/${duplicate.id}`;
    } catch (error) {
      recordDiagnostic("从快照复制项目", error);
      setMessage("无法从该快照复制新项目。");
    }
  };

  const createManualSnapshot = async () => {
    if (!project || !snapshotName.trim()) return;
    try {
      const version = await createProjectSnapshot(normalizeProject(project), snapshotName.trim(), "manual");
      setVersions((items) => [version, ...items]);
      setCompareVersionId(version.id);
      setSnapshotOpen(false);
      setSnapshotName("");
      setMessage(`已创建手动快照 v${version.version}。`);
    } catch (error) {
      recordDiagnostic("创建项目快照", error);
      setSaveStatus("error");
      setMessage("手动快照保存失败。");
    }
  };

  const launchProject = async (trustConfirmed = false) => {
    if (!project || !workspace) return;
    const candidate = ProjectSchema.safeParse(normalizeProject(project));
    if (!candidate.success) {
      setSaveStatus("error");
      setMessage(candidate.error.issues[0]?.message ?? "项目配置不完整。");
      return;
    }
    try {
      if (!trustConfirmed && await projectTrustState(candidate.data) !== "trusted") {
        setLaunchTrustOpen(true);
        return;
      }
      setLaunching(true);
      await saveWorkspace({ project: candidate.data, session: workspace.session });
      await createProjectSnapshot(candidate.data, "启动演示前自动快照", "auto");
      beginPresentationLaunch(candidate.data);
      setActiveProject(candidate.data.id);
      const patterns = [...new Set(await originPatternsForProject(candidate.data))];
      const missing: string[] = [];
      for (const pattern of patterns) {
        try {
          if (!await browser.permissions.contains({ origins: [pattern] })) missing.push(pattern);
        } catch {
          missing.push(pattern);
        }
      }
      if (missing.length > 0) {
        const granted = await browser.permissions.request({ origins: missing }).catch(() => false);
        if (!granted) setMessage("站点授权被拒绝：业务页面仍会打开，但连接器探测、遮罩与录制将不可用。");
      }
      try {
        const tab = await browser.tabs.getCurrent();
        if (tab?.id !== undefined) await browser.sidePanel.open({ tabId: tab.id });
      } catch {
        // Side panel not supported here; the presenter can click the toolbar icon.
      }
      port.send({ type: "begin", projectId: candidate.data.id });
      setMessage("演示已启动：控制台在浏览器侧边栏中，画面标签将在新窗口出现。");
    } catch (error) {
      recordDiagnostic("从编辑器启动演示", error);
      setSaveStatus("error");
      setMessage("演示启动失败。");
    } finally {
      setLaunching(false);
    }
  };

  const movePage = async (index: number, delta: -1 | 1) => {
    if (!project) return;
    const target = index + delta;
    if (target < 0 || target >= project.pages.length) return;
    try {
      await snapshotBeforeBulkChange("页面批量排序前自动快照");
    } catch {
      setSaveStatus("error");
      setMessage("排序前自动快照失败，未修改页面顺序。");
      return;
    }
    changeProject((current) => {
      const pages = [...current.pages];
      const [moved] = pages.splice(index, 1);
      pages.splice(target, 0, moved!);
      return { ...current, pages: pages.map((item, order) => ({ ...item, order })) };
    });
  };

  if (saveStatus === "loading") return <main className="project-loading">正在加载项目编辑器…</main>;
  if (!project || !page) {
    return (
      <main className="project-loading project-loading--error">
        <TriangleAlert size={18} />
        <span>{message ?? "项目没有可编辑页面。"}</span>
        <button type="button" onClick={() => { window.location.hash = "#/"; }}>返回项目库</button>
      </main>
    );
  }

  const setPage = (change: (current: PresentationPage) => PresentationPage) => changeProject((current) => updatePage(current, page.id, change));
  const changeStep = (stepId: string, change: (step: PresentationStep) => PresentationStep) =>
    setPage((current) => ({ ...current, script: { ...current.script, steps: current.script.steps.map((step) => (step.id === stepId ? change(step) : step)) } }));
  const changeConnector = (connectorId: string, change: (connector: PresentationConnector) => PresentationConnector) =>
    changeProject((current) => ({ ...current, connectors: current.connectors.map((connector) => (connector.id === connectorId ? change(connector) : connector)) }));

  const duplicateCurrentPage = async () => {
    try {
      await snapshotBeforeBulkChange(`复制“${page.title}”前自动快照`);
    } catch {
      setSaveStatus("error");
      setMessage("复制前自动快照失败，未修改项目。");
      return;
    }
    const duplicate = { ...duplicatePage(page, page.order + 1), title: `${page.title} 副本` };
    changeProject((current) => ({ ...current, pages: [...current.pages.slice(0, page.order + 1), duplicate, ...current.pages.slice(page.order + 1)].map((item, order) => ({ ...item, order })) }));
    setActivePageId(duplicate.id);
  };

  const deleteCurrentPage = async () => {
    if (!window.confirm(`删除“${page.title}”？`)) return;
    try {
      await snapshotBeforeBulkChange(`删除“${page.title}”前自动快照`);
    } catch {
      setSaveStatus("error");
      setMessage("删除前自动快照失败，未修改项目。");
      return;
    }
    const next = project.pages.filter((item) => item.id !== page.id).map((item, order) => ({ ...item, order }));
    changeProject((current) => ({ ...current, pages: next }));
    setActivePageId(next[Math.min(page.order, next.length - 1)]?.id ?? null);
  };

  const importMarkdown = async (file: File | undefined) => {
    if (!file) return;
    try {
      const markdown = await file.text();
      if (markdown.length > 50_000) throw new Error("Markdown 文件超过 50,000 字符限制。");
      setPage((current) => ({ ...current, script: { ...current.script, markdown } }));
      setMessage("Markdown 脚本已导入，等待自动保存。");
    } catch (error) {
      setSaveStatus("error");
      setMessage(error instanceof Error ? error.message : "Markdown 文件无法读取。");
    } finally {
      if (markdownImport.current) markdownImport.current.value = "";
    }
  };

  const insertMarkdownBlock = (kind: MarkdownInsertionKind) => {
    const editor = markdownEditor.current;
    if (!editor) return;
    const edit = insertMarkdown(page.script.markdown, editor.selectionStart, editor.selectionEnd, kind);
    setPage((current) => ({ ...current, script: { ...current.script, markdown: edit.value } }));
    window.requestAnimationFrame(() => {
      editor.focus();
      editor.setSelectionRange(edit.selectionStart, edit.selectionEnd);
    });
  };

  const synchronizeMarkdownScroll = (source: HTMLElement, target: HTMLElement, owner: "source" | "preview") => {
    if (markdownScrollOwner.current && markdownScrollOwner.current !== owner) return;
    markdownScrollOwner.current = owner;
    target.scrollTop = proportionalScrollTop(source.scrollTop, source.scrollHeight, source.clientHeight, target.scrollHeight, target.clientHeight);
    window.requestAnimationFrame(() => {
      if (markdownScrollOwner.current === owner) markdownScrollOwner.current = null;
    });
  };

  const importBrandLogo = async (file: File | undefined) => {
    if (!file) return;
    try {
      const logoDataUrl = await readBrandImage(file);
      changeProject((current) => ({ ...current, brand: { ...current.brand, logoDataUrl } }));
    } catch (error) {
      setSaveStatus("error");
      setMessage(error instanceof Error ? error.message : "品牌图无法读取。");
    }
  };

  const importMaskImage = async (file: File | undefined) => {
    if (!file) return;
    try {
      const maskImageDataUrl = await readMaskImage(file);
      changeProject((current) => ({ ...current, brand: { ...current.brand, maskImageDataUrl } }));
    } catch (error) {
      setSaveStatus("error");
      setMessage(error instanceof Error ? error.message : "遮挡动图无法读取。");
    }
  };

  const importOfflineFile = async (file: File | undefined) => {
    if (!file || !page.offline) return;
    try {
      if (page.offline.kind === "html") {
        const zipFile = file.name.toLowerCase().endsWith(".zip") || file.type === "application/zip";
        if (!zipFile && !file.name.toLowerCase().endsWith(".html") && file.type !== "text/html") throw new Error("离线 HTML 必须使用 .html 或 .zip 文件。");
        if (zipFile) {
          const fallback = parseOfflineHtmlPackage(await file.arrayBuffer());
          setPage((current) => ({ ...current, offline: fallback }));
        } else {
          if (file.size > 1_000_000) throw new Error("离线 HTML 不能超过 1 MB。");
          const content = await file.text();
          setPage((current) => ({ ...current, offline: { kind: "html", content, resources: [], allowedNetworkOrigins: [] } }));
        }
      } else {
        const kind = page.offline.kind;
        const dataUrl = await readOfflineMedia(file, kind);
        setPage((current) => ({ ...current, offline: { kind, dataUrl } }));
      }
      setMessage("离线备用内容已导入，等待自动保存。");
    } catch (error) {
      setSaveStatus("error");
      setMessage(error instanceof Error ? error.message : "离线备用文件无法读取。");
    }
  };

  return (
    <main className="project-editor">
      <header className="editor-topbar">
        <section>
          <ToolbarButton icon={<ChevronLeft size={16} />} title="返回项目库" onClick={() => { window.location.hash = "#/"; }} />
          <div><strong>Showit</strong><span>项目编辑器</span></div>
        </section>
        <section className="editor-topbar__title"><strong>{project.name}</strong><span data-state={saveStatus}>{saveStatus === "saved" ? "已保存" : saveStatus === "saving" ? "保存中" : saveStatus === "dirty" ? "未保存" : "保存失败"}</span></section>
        <section>
          <ToolbarButton icon={<Play size={16} />} label="运行" title="保存并启动演示" variant="primary" disabled={launching} onClick={() => void launchProject()} />
          <ToolbarButton icon={<Save size={16} />} label="保存" title="保存到本机" variant="primary" onClick={() => void save(true)} />
        </section>
      </header>

      {message ? <output className={`editor-message editor-message--${saveStatus}`}>{message}</output> : null}

      <section className="editor-layout">
        <aside className="editor-page-rail" aria-label="页面编排">
          <div className="editor-rail-head"><div><span>页面</span><strong>{project.pages.length}</strong></div><ToolbarButton icon={<Plus size={16} />} title="添加页面" onClick={() => {
            const next = createPage(project.pages.length, project.connectors[0]?.id);
            changeProject((current) => ({ ...current, pages: [...current.pages, next] }));
            setActivePageId(next.id);
          }} /></div>
          <nav className="editor-page-list">
            {project.pages.map((item, index) => (
              <div key={item.id} className={`editor-page-item ${item.id === page.id ? "is-active" : ""} ${item.enabled ? "" : "is-disabled"}`}>
                <button type="button" className="editor-page-item__select" onClick={() => setActivePageId(item.id)} aria-current={item.id === page.id ? "page" : undefined}>
                  <span className="editor-page-item__order">{index + 1}</span>
                  <span className="editor-page-item__copy"><strong>{item.title}</strong><small>{item.section}</small></span>
                </button>
                <span className="editor-page-item__moves">
                  <button type="button" title="上移页面" aria-label={`上移 ${item.title}`} disabled={index === 0} onClick={() => void movePage(index, -1)}><ChevronUp size={13} /></button>
                  <button type="button" title="下移页面" aria-label={`下移 ${item.title}`} disabled={index === project.pages.length - 1} onClick={() => void movePage(index, 1)}><ChevronDown size={13} /></button>
                </span>
              </div>
            ))}
          </nav>
        </aside>

        <section className="editor-form" aria-label="页面配置">
          <div className="editor-section-head"><div><span>页面 {page.order + 1}</span><h1>{page.title}</h1></div><section><ToolbarButton icon={<Copy size={16} />} title="复制当前页面" onClick={() => void duplicateCurrentPage()} /><ToolbarButton icon={<Trash2 size={16} />} title="删除当前页面" variant="danger" disabled={project.pages.length <= 1} onClick={() => void deleteCurrentPage()} /></section></div>

          <div className="editor-fields editor-fields--two">
            <label className="field"><span>页面类型</span><select value={page.pageType} onChange={(event) => setPage((current) => ({ ...current, pageType: event.target.value as PresentationPage["pageType"] }))}><option value="business">业务系统页面</option><option value="fixed">固定页面</option><option value="external">外部链接页面</option><option value="end">结束页</option></select></label>
            <label className="field"><span>运行状态</span><select value={page.enabled ? "enabled" : "disabled"} onChange={(event) => setPage((current) => ({ ...current, enabled: event.target.value === "enabled" }))}><option value="enabled">启用</option><option value="disabled">禁用并跳过</option></select></label>
            <label className="field"><span>页面标题</span><input value={page.title} maxLength={160} onChange={(event) => setPage((current) => ({ ...current, title: event.target.value }))} /></label>
            <label className="field"><span>章节</span><input value={page.section} maxLength={80} onChange={(event) => setPage((current) => ({ ...current, section: event.target.value }))} /></label>
            <label className="field"><span>页面标签（逗号分隔）</span><input value={page.tags.join(",")} maxLength={500} onChange={(event) => setPage((current) => ({ ...current, tags: splitListValue(event.target.value).slice(0, 12) }))} /></label>
            <label className="field"><span>演示角色</span><input value={page.role} maxLength={80} onChange={(event) => setPage((current) => ({ ...current, role: event.target.value }))} /></label>
            <label className="field"><span>业务画面标签</span><input value={page.businessLabel} maxLength={160} onChange={(event) => setPage((current) => ({ ...current, businessLabel: event.target.value }))} /></label>
            <label className="field"><span>预计秒数</span><input type="number" min={1} max={14400} value={page.estimatedSeconds} onChange={(event) => setPage((current) => ({ ...current, estimatedSeconds: Math.max(1, Number(event.target.value) || 1) }))} /></label>
            <label className="field"><span>自动翻页秒数</span><input type="number" min={1} max={14400} value={page.autoAdvanceSeconds ?? ""} placeholder="继承全局间隔" onChange={(event) => setPage((current) => ({ ...current, autoAdvanceSeconds: event.target.value ? Math.max(1, Number(event.target.value)) : undefined }))} /></label>
          </div>
          <label className="field editor-fields__full"><span>本页目的</span><textarea rows={2} value={page.purpose} maxLength={500} onChange={(event) => setPage((current) => ({ ...current, purpose: event.target.value }))} /></label>
          <label className="field editor-fields__full"><span>转场说明</span><textarea rows={2} value={page.transitionNote} maxLength={1000} onChange={(event) => setPage((current) => ({ ...current, transitionNote: event.target.value }))} /></label>
          <label className="field editor-fields__full"><span>异常处理</span><textarea rows={3} value={page.errorHandling} maxLength={2000} onChange={(event) => setPage((current) => ({ ...current, errorHandling: event.target.value }))} /></label>
          <div className="editor-fields editor-fields--two">
            <label className="field"><span>连接器</span><select value={page.connectorId ?? ""} onChange={(event) => setPage((current) => ({ ...current, connectorId: event.target.value || undefined }))}><option value="">未选择</option>{project.connectors.map((connector) => <option key={connector.id} value={connector.id}>{connector.name}</option>)}</select></label>
            <label className="field"><span>业务 URL 模板</span><input value={page.url ?? ""} placeholder="https://example.com/path?tenant={{project.tenant}}" onChange={(event) => setPage((current) => ({ ...current, url: event.target.value || undefined }))} /></label>
            <label className="field"><span>备用 URL 模板</span><input value={page.fallbackUrl ?? ""} placeholder="业务页不可用时使用" onChange={(event) => setPage((current) => ({ ...current, fallbackUrl: event.target.value || undefined }))} /></label>
          </div>

          <section className="offline-editor">
            <div className="editor-section-head"><div><span>离线备用</span></div></div>
            <label className="field"><span>内容类型</span><select aria-label="离线备用类型" value={page.offline?.kind ?? "none"} onChange={(event) => {
              const kind = event.target.value;
              setPage((current) => ({ ...current, offline: kind === "none" ? undefined : kind === "image" ? { kind: "image" } : kind === "video" ? { kind: "video" } : { kind: "html" } }));
            }}><option value="none">无</option><option value="image">截图</option><option value="video">预录视频</option><option value="html">隔离 HTML</option></select></label>
            {page.offline ? <label className="field"><span>备用文件</span><input aria-label="离线备用文件" type="file" accept={page.offline.kind === "image" ? "image/png,image/jpeg,image/webp" : page.offline.kind === "video" ? "video/mp4,video/webm" : ".html,.zip,text/html,application/zip"} onChange={(event) => void importOfflineFile(event.target.files?.[0])} /></label> : null}
            {page.offline?.kind === "html" ? <>
              <label className="field offline-editor__html"><span>HTML 源码</span><textarea rows={6} value={page.offline.content ?? ""} onChange={(event) => setPage((current) => ({ ...current, offline: current.offline?.kind === "html" ? { ...current.offline, content: event.target.value } : { kind: "html", content: event.target.value } }))} /></label>
              <p className="editor-muted">包内资源 {page.offline.resources?.length ?? 0} 个；脚本在无同源沙箱中运行。</p>
              <label className="field offline-editor__html"><span>允许访问的网络 Origin（每行一个）</span><textarea rows={3} value={(page.offline.allowedNetworkOrigins ?? []).join("\n")} placeholder={requestedOfflineOrigins(page.offline).join("\n") || "默认不允许外部网络"} onChange={(event) => setPage((current) => ({ ...current, offline: current.offline?.kind === "html" ? { ...current.offline, allowedNetworkOrigins: event.target.value.split(/[,\n]/).map((value) => value.trim()).filter(Boolean) } : current.offline }))} /></label>
              {requestedOfflineOrigins(page.offline).length > 0 ? <p className="offline-network-request">内容请求：{requestedOfflineOrigins(page.offline).join("、")}</p> : null}
            </> : null}
            {page.offline?.kind === "image" && page.offline.dataUrl ? <img src={page.offline.dataUrl} alt="离线备用预览" /> : null}
            {page.offline?.kind === "video" && page.offline.dataUrl ? <video src={page.offline.dataUrl} controls muted /> : null}
          </section>

          <section className="variable-editor"><div className="editor-section-head"><div><span>本页变量</span></div><ToolbarButton icon={<Plus size={15} />} title="添加页面变量" onClick={() => setPage((current) => ({ ...current, variables: [...current.variables, { key: "value", value: "" }] }))} /></div>{page.variables.length === 0 ? <p className="editor-muted">可用 {"{{page.customer}}"} 引用本页变量。</p> : page.variables.map((variable, index) => <div className="variable-editor__row" key={`${variable.key}-${index}`}><input aria-label="页面变量名称" value={variable.key} placeholder="变量名" maxLength={80} onChange={(event) => setPage((current) => ({ ...current, variables: updateVariable(current.variables, index, (item) => ({ ...item, key: event.target.value })) }))} /><input aria-label="页面变量值" value={variable.value} placeholder="变量值" maxLength={2000} onChange={(event) => setPage((current) => ({ ...current, variables: updateVariable(current.variables, index, (item) => ({ ...item, value: event.target.value })) }))} /><ToolbarButton icon={<X size={14} />} title="删除页面变量" variant="danger" onClick={() => setPage((current) => ({ ...current, variables: current.variables.filter((_item, valueIndex) => valueIndex !== index) }))} /></div>)}</section>

          <section className="editor-script-section">
            <div className="editor-section-head"><div><span>Markdown 演讲脚本</span></div><div className="editor-markdown-toolbar" role="toolbar" aria-label="Markdown 快捷插入"><ToolbarButton icon={<Heading2 size={15} />} title="插入二级标题" onClick={() => insertMarkdownBlock("heading")} /><ToolbarButton icon={<List size={15} />} title="插入列表" onClick={() => insertMarkdownBlock("list")} /><ToolbarButton icon={<Quote size={15} />} title="插入引用" onClick={() => insertMarkdownBlock("quote")} /><ToolbarButton icon={<Code2 size={15} />} title="插入代码块" onClick={() => insertMarkdownBlock("code")} /><ToolbarButton icon={<ListChecks size={15} />} title="插入演示步骤区块" onClick={() => insertMarkdownBlock("steps")} /><ToolbarButton icon={<FileUp size={15} />} title="导入 Markdown 脚本" onClick={() => markdownImport.current?.click()} /><ToolbarButton icon={<FileDown size={15} />} title="导出 Markdown 脚本" onClick={() => downloadMarkdownScript(project, page.id)} /></div></div>
            <input ref={markdownImport} className="visually-hidden" type="file" accept=".md,.markdown,text/markdown,text/plain" onChange={(event) => void importMarkdown(event.target.files?.[0])} />
            <div className="editor-script-grid">
              <label><span className="visually-hidden">Markdown 脚本</span><textarea ref={markdownEditor} rows={16} value={page.script.markdown} onScroll={(event) => { if (markdownPreview.current) synchronizeMarkdownScroll(event.currentTarget, markdownPreview.current, "source"); }} onChange={(event) => setPage((current) => ({ ...current, script: { ...current.script, markdown: event.target.value } }))} /></label>
              <article ref={markdownPreview} className="editor-markdown-preview" onScroll={(event) => { if (markdownEditor.current) synchronizeMarkdownScroll(event.currentTarget, markdownEditor.current, "preview"); }}><MarkdownView markdown={page.script.markdown} /></article>
            </div>
          </section>

          <section className="editor-script-section">
            <div className="editor-section-head"><div><span>步骤</span></div><div>
              {recorder.origin && !recorder.active ? <ToolbarButton icon={<Check size={15} />} label={`授权 ${recorder.origin}`} title="授权该站点后开始录制" onClick={() => void authorizeRecorderOrigin()} /> : null}
              <ToolbarButton icon={recorder.active ? <Square size={15} /> : <CircleDot size={15} />} label={recorder.active ? "停止录制" : "录制操作"} title={recorder.active ? "停止浏览器操作录制" : "录制活动业务标签中的操作"} active={recorder.active} onClick={() => void toggleRecorder()} />
              <ToolbarButton icon={<Plus size={16} />} label="添加步骤" title="添加结构化步骤" onClick={() => setPage((current) => ({ ...current, script: { ...current.script, steps: [...current.script.steps, { id: createId("step"), kind: "say", text: "新增步骤", execution: "hint", conditionTimeoutSeconds: 8, risk: "normal", autoContinue: false, presenterOnly: false }] } }))} />
            </div></div>
            {recorder.active ? <p className="editor-muted">{recorder.pageTitle ? `正在录制“${recorder.pageTitle}”中的操作。` : "正在录制活动业务标签中的操作。"}</p> : recorder.reason ? <p className="editor-muted">{recorder.reason}</p> : null}
            <div className="editor-steps">
              {page.script.steps.map((step, index) => <div className="editor-step" key={step.id}>
                <span>{index + 1}</span>
                <select value={step.kind} aria-label={`${step.text} 类型`} onChange={(event) => changeStep(step.id, (current) => ({ ...current, kind: event.target.value as StepKind }))}>{(Object.keys(stepLabels) as StepKind[]).map((kind) => <option key={kind} value={kind}>{stepLabels[kind]}</option>)}</select>
                <select aria-label={`${step.text} 执行方式`} value={step.execution} onChange={(event) => changeStep(step.id, (current) => ({ ...current, execution: event.target.value as PresentationStep["execution"] }))}>{(Object.keys(executionLabels) as PresentationStep["execution"][]).map((execution) => <option key={execution} value={execution}>{executionLabels[execution]}</option>)}</select>
                <select aria-label={`${step.text} 风险级别`} value={step.risk} onChange={(event) => changeStep(step.id, (current) => ({ ...current, risk: event.target.value as "normal" | "high", autoContinue: event.target.value === "high" ? false : current.autoContinue }))}><option value="normal">普通</option><option value="high">高风险确认</option></select>
                <input value={step.text} maxLength={4000} aria-label={`${step.text} 说明`} onChange={(event) => changeStep(step.id, (current) => ({ ...current, text: event.target.value }))} />
                <ToolbarButton icon={<Trash2 size={15} />} title="删除步骤" variant="danger" disabled={page.script.steps.length <= 1} onClick={() => setPage((current) => ({ ...current, script: { ...current.script, steps: current.script.steps.filter((item) => item.id !== step.id) } }))} />
                {step.recordedAction ? <small className="editor-step__recording">已配置：{recordedActionLabel(step.recordedAction)} · {step.recordedAction.type === "click" && step.execution === "auto" ? "自动点击前仍会校验连接器权限" : "运行时按执行方式处理"}</small> : null}
                <div className="editor-step__action">
                  <label className="field"><span>步骤动作</span><select aria-label={`${step.text} 步骤动作`} value={step.recordedAction?.type ?? "none"} onChange={(event) => changeStep(step.id, (current) => {
                    if (event.target.value === "none") {
                      const { recordedAction: _recordedAction, ...withoutAction } = current;
                      return withoutAction;
                    }
                    if (event.target.value !== "fill") return current;
                    const locator = current.recordedAction && "locator" in current.recordedAction ? current.recordedAction.locator : { strategy: "testid" as const, value: "field" };
                    return { ...current, kind: "act", execution: current.execution === "hint" ? "assist" : current.execution, recordedAction: { type: "fill", locator, input: { source: "fixed", value: "" } } };
                  })}>
                    <option value="none">无执行动作</option>
                    {step.recordedAction && step.recordedAction.type !== "fill" ? <option value={step.recordedAction.type}>{recordedActionLabel(step.recordedAction)}</option> : null}
                    <option value="fill">填写字段</option>
                  </select></label>
                  {step.recordedAction?.type === "fill" ? <>
                    <label className="field"><span>定位方式</span><select aria-label={`${step.text} 填写定位方式`} value={step.recordedAction.locator.strategy} onChange={(event) => changeStep(step.id, (current) => current.recordedAction?.type === "fill" ? { ...current, recordedAction: { ...current.recordedAction, locator: { ...current.recordedAction.locator, strategy: event.target.value as ElementLocator["strategy"] } } } : current)}><option value="testid">data-testid</option><option value="id">ID</option><option value="aria">ARIA 标签</option><option value="role">ARIA role</option></select></label>
                    <label className="field editor-step__action-value"><span>定位值</span><input aria-label={`${step.text} 填写定位值`} maxLength={200} value={step.recordedAction.locator.value} onChange={(event) => changeStep(step.id, (current) => current.recordedAction?.type === "fill" ? { ...current, recordedAction: { ...current.recordedAction, locator: { ...current.recordedAction.locator, value: event.target.value } } } : current)} /></label>
                    <label className="field"><span>值来源</span><select aria-label={`${step.text} 填写值来源`} value={step.recordedAction.input.source} onChange={(event) => changeStep(step.id, (current) => {
                      if (current.recordedAction?.type !== "fill") return current;
                      const source = event.target.value;
                      const input = source === "project"
                        ? { source: "project" as const, key: project.variables[0]?.key ?? "missing" }
                        : source === "page"
                          ? { source: "page" as const, key: page.variables[0]?.key ?? "missing" }
                          : source === "sensitive"
                            ? { source: "sensitive" as const, key: project.sensitiveVariables[0]?.key ?? "missing" }
                            : { source: "fixed" as const, value: "" };
                      return { ...current, recordedAction: { ...current.recordedAction, input } };
                    })}><option value="fixed">固定值</option><option value="project">项目变量</option><option value="page">页面变量</option><option value="sensitive">启动时敏感变量</option></select></label>
                    {step.recordedAction.input.source === "fixed" ? <label className="field editor-step__action-value"><span>固定值</span><input aria-label={`${step.text} 固定填写值`} maxLength={2000} value={step.recordedAction.input.value} onChange={(event) => changeStep(step.id, (current) => current.recordedAction?.type === "fill" && current.recordedAction.input.source === "fixed" ? { ...current, recordedAction: { ...current.recordedAction, input: { ...current.recordedAction.input, value: event.target.value } } } : current)} /></label> : <label className="field editor-step__action-value"><span>变量</span><select aria-label={`${step.text} 填写变量`} value={step.recordedAction.input.key} onChange={(event) => changeStep(step.id, (current) => current.recordedAction?.type === "fill" && current.recordedAction.input.source !== "fixed" ? { ...current, recordedAction: { ...current.recordedAction, input: { ...current.recordedAction.input, key: event.target.value } } } : current)}>{(step.recordedAction.input.source === "project" ? project.variables : step.recordedAction.input.source === "page" ? page.variables : project.sensitiveVariables).length === 0 ? <option value="missing">尚未配置可用变量</option> : (step.recordedAction.input.source === "project" ? project.variables : step.recordedAction.input.source === "page" ? page.variables : project.sensitiveVariables).map((variable) => <option key={variable.key} value={variable.key}>{"label" in variable ? variable.label : variable.key}</option>)}</select></label>}
                  </> : null}
                </div>
                <div className="editor-step__condition">
                  <label className="field">
                    <span>完成条件</span>
                    <select aria-label={`${step.text} 完成条件`} value={step.expectedCondition?.type ?? "none"} onChange={(event) => changeStep(step.id, (current) => {
                      const type = event.target.value;
                      if (type === "none") {
                        const { expectedCondition: _expectedCondition, ...withoutCondition } = current;
                        return withoutCondition;
                      }
                      return { ...current, expectedCondition: defaultExpectedCondition(current, page, type as ExpectedCondition["type"]) };
                    })}>
                      <option value="none">手动完成</option>
                      {(Object.keys(conditionLabels) as ExpectedCondition["type"][]).map((type) => <option key={type} value={type}>{conditionLabels[type]}</option>)}
                    </select>
                  </label>
                  {step.expectedCondition?.type === "element" ? (
                    <>
                      <label className="field"><span>定位方式</span><select aria-label={`${step.text} 条件定位方式`} value={step.expectedCondition.locator.strategy} onChange={(event) => changeStep(step.id, (current) => current.expectedCondition?.type === "element" ? { ...current, expectedCondition: { ...current.expectedCondition, locator: { ...current.expectedCondition.locator, strategy: event.target.value as ElementLocator["strategy"] } } } : current)}><option value="testid">data-testid</option><option value="id">ID</option><option value="aria">ARIA 标签</option><option value="role">ARIA role</option></select></label>
                      <label className="field editor-step__condition-value"><span>定位值</span><input aria-label={`${step.text} 条件定位值`} maxLength={200} value={step.expectedCondition.locator.value} onChange={(event) => changeStep(step.id, (current) => current.expectedCondition?.type === "element" ? { ...current, expectedCondition: { ...current.expectedCondition, locator: { ...current.expectedCondition.locator, value: event.target.value } } } : current)} /></label>
                    </>
                  ) : step.expectedCondition ? (
                    <label className="field editor-step__condition-value"><span>条件值</span><input type={step.expectedCondition.type === "url" ? "url" : "text"} aria-label={`${step.text} 条件值`} maxLength={step.expectedCondition.type === "url" ? 4000 : 300} value={step.expectedCondition.value} onChange={(event) => changeStep(step.id, (current) => current.expectedCondition && current.expectedCondition.type !== "element" ? { ...current, expectedCondition: { ...current.expectedCondition, value: event.target.value } } : current)} /></label>
                  ) : null}
                  {step.expectedCondition ? <label className="field"><span>超时（秒）</span><input aria-label={`${step.text} 条件超时`} type="number" min={1} max={30} value={step.conditionTimeoutSeconds} onChange={(event) => changeStep(step.id, (current) => ({ ...current, conditionTimeoutSeconds: Math.min(30, Math.max(1, Number(event.target.value) || 1)) }))} /></label> : null}
                  {step.risk === "normal" && index < page.script.steps.length - 1 ? <label className="editor-step__checkbox"><input type="checkbox" aria-label={`${step.text} 验证后自动继续`} checked={step.autoContinue} onChange={(event) => changeStep(step.id, (current) => ({ ...current, autoContinue: event.target.checked }))} />验证成功后自动继续</label> : null}
                  <label className="editor-step__checkbox"><input type="checkbox" aria-label={`${step.text} 仅演讲者可见`} checked={step.presenterOnly === true} onChange={(event) => changeStep(step.id, (current) => ({ ...current, presenterOnly: event.target.checked }))} />仅演讲者可见</label>
                </div>
              </div>)}
            </div>
          </section>
        </section>

        <aside className="editor-project-panel" aria-label="项目发布与连接器">
          <section><span>项目配置</span><label className="field"><span>项目名称</span><input value={project.name} maxLength={120} onChange={(event) => changeProject((current) => ({ ...current, name: event.target.value }))} /></label><label className="field"><span>项目说明</span><textarea rows={4} value={project.description} maxLength={1000} onChange={(event) => changeProject((current) => ({ ...current, description: event.target.value }))} /></label><label className="field"><span>全局自动翻页（秒）</span><input aria-label="全局自动翻页秒数" type="number" min={1} max={14400} value={project.autoAdvanceSeconds} onChange={(event) => changeProject((current) => ({ ...current, autoAdvanceSeconds: Math.min(14_400, Math.max(1, Number(event.target.value) || 1)) }))} /></label><label className="field"><span>默认浏览器会话</span><select aria-label="默认浏览器会话" value={project.browserSessionMode} onChange={(event) => changeProject((current) => ({ ...current, browserSessionMode: event.target.value as Project["browserSessionMode"] }))}><option value="daily">日常浏览器</option><option value="dedicated">专用演示环境（无痕窗口）</option></select></label><label className="field"><span>观众容量</span><select aria-label="观众容量" value={project.audienceCapacityMode} onChange={(event) => changeProject((current) => ({ ...current, audienceCapacityMode: event.target.value as Project["audienceCapacityMode"] }))}><option value="p2p-5">本机观众窗口</option></select></label><label className="field"><span>观众加入方式</span><select aria-label="观众加入方式" value={project.audienceJoinMode} onChange={(event) => changeProject((current) => ({ ...current, audienceJoinMode: event.target.value as Project["audienceJoinMode"] }))}><option value="direct">直接打开</option></select></label></section>
          <section className="brand-editor"><span>观众屏品牌</span><div className="brand-editor__colors"><label className="field"><span>主色</span><input type="color" value={project.brand.primaryColor} onChange={(event) => changeProject((current) => ({ ...current, brand: { ...current.brand, primaryColor: event.target.value } }))} /></label><label className="field"><span>状态页背景</span><input type="color" value={project.brand.statusBackgroundColor} onChange={(event) => changeProject((current) => ({ ...current, brand: { ...current.brand, statusBackgroundColor: event.target.value } }))} /></label></div><label className="field"><span>遮挡封面文案（点「遮罩」时观众看到的字）</span><input value={project.brand.maskTitle} maxLength={120} onChange={(event) => changeProject((current) => ({ ...current, brand: { ...current.brand, maskTitle: event.target.value } }))} /></label><label className="field"><span>遮挡封面动图（留空则用内置的卡通人物动画）</span><input type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={(event) => void importMaskImage(event.target.files?.[0])} /></label>{project.brand.maskImageDataUrl ? <div className="brand-editor__logo"><img src={project.brand.maskImageDataUrl} alt="遮挡动图" /><ToolbarButton icon={<X size={14} />} title="移除遮挡动图，恢复内置卡通人物" variant="danger" onClick={() => changeProject((current) => { const { maskImageDataUrl: _dropped, ...brand } = current.brand; return { ...current, brand }; })} /></div> : null}<label className="field"><span>隐私遮挡文案</span><input value={project.brand.privacyMessage} maxLength={120} onChange={(event) => changeProject((current) => ({ ...current, brand: { ...current.brand, privacyMessage: event.target.value } }))} /></label><label className="field"><span>离线备用标识</span><input value={project.brand.offlineLabel} maxLength={40} onChange={(event) => changeProject((current) => ({ ...current, brand: { ...current.brand, offlineLabel: event.target.value } }))} /></label><label className="field"><span>结束页标题</span><input value={project.brand.endTitle} maxLength={120} onChange={(event) => changeProject((current) => ({ ...current, brand: { ...current.brand, endTitle: event.target.value } }))} /></label><label className="field"><span>结束页说明</span><input value={project.brand.endDescription} maxLength={240} onChange={(event) => changeProject((current) => ({ ...current, brand: { ...current.brand, endDescription: event.target.value } }))} /></label><label className="field"><span>观众浏览器标题</span><input value={project.brand.audienceTitle} maxLength={120} onChange={(event) => changeProject((current) => ({ ...current, brand: { ...current.brand, audienceTitle: event.target.value } }))} /></label><label className="field"><span>客户或产品 Logo</span><input type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => void importBrandLogo(event.target.files?.[0])} /></label>{project.brand.logoDataUrl ? <div className="brand-editor__logo"><img src={project.brand.logoDataUrl} alt="项目 Logo" /><ToolbarButton icon={<X size={14} />} title="移除 Logo" variant="danger" onClick={() => changeProject((current) => { const { logoDataUrl: _dropped, ...brand } = current.brand; return { ...current, brand }; })} /></div> : null}</section>
          <section className="variable-editor"><div className="connector-section__head"><span>项目变量</span><ToolbarButton icon={<Plus size={15} />} title="添加项目变量" onClick={() => changeProject((current) => ({ ...current, variables: [...current.variables, { key: "value", value: "" }] }))} /></div>{project.variables.length === 0 ? <p className="editor-muted">可用 {"{{project.tenant}}"} 引用项目变量。</p> : project.variables.map((variable, index) => <div className="variable-editor__row" key={`${variable.key}-${index}`}><input aria-label="项目变量名称" value={variable.key} placeholder="变量名" maxLength={80} onChange={(event) => changeProject((current) => ({ ...current, variables: updateVariable(current.variables, index, (item) => ({ ...item, key: event.target.value })) }))} /><input aria-label="项目变量值" value={variable.value} placeholder="变量值" maxLength={2000} onChange={(event) => changeProject((current) => ({ ...current, variables: updateVariable(current.variables, index, (item) => ({ ...item, value: event.target.value })) }))} /><ToolbarButton icon={<X size={14} />} title="删除项目变量" variant="danger" onClick={() => changeProject((current) => ({ ...current, variables: current.variables.filter((_item, valueIndex) => valueIndex !== index) }))} /></div>)}</section>
          <section className="variable-editor"><div className="connector-section__head"><span>启动时敏感变量</span><ToolbarButton icon={<Plus size={15} />} title="添加仅在演示期间使用的敏感变量" onClick={() => changeProject((current) => ({ ...current, sensitiveVariables: [...current.sensitiveVariables, { key: `secret${current.sensitiveVariables.length + 1}`, label: "敏感值", required: true, expiresAfterMinutes: 60 }] }))} /></div>{project.sensitiveVariables.length === 0 ? <p className="editor-muted">密码、Token 和 API Key 应在演示启动时输入，不保存在项目中。</p> : project.sensitiveVariables.map((variable, index) => <div className="variable-editor__row variable-editor__row--secret" key={`${variable.key}-${index}`}><input aria-label="敏感变量名称" value={variable.key} placeholder="变量名" maxLength={80} onChange={(event) => changeProject((current) => ({ ...current, sensitiveVariables: updateSensitiveVariable(current.sensitiveVariables, index, (item) => ({ ...item, key: event.target.value })) }))} /><input aria-label="敏感变量显示名称" value={variable.label} placeholder="显示名称" maxLength={120} onChange={(event) => changeProject((current) => ({ ...current, sensitiveVariables: updateSensitiveVariable(current.sensitiveVariables, index, (item) => ({ ...item, label: event.target.value })) }))} /><input aria-label="敏感变量超时分钟" type="number" min={1} max={360} value={variable.expiresAfterMinutes} onChange={(event) => changeProject((current) => ({ ...current, sensitiveVariables: updateSensitiveVariable(current.sensitiveVariables, index, (item) => ({ ...item, expiresAfterMinutes: Math.min(360, Math.max(1, Number(event.target.value) || 1)) })) }))} /><label className="variable-editor__required"><input type="checkbox" checked={variable.required} onChange={(event) => changeProject((current) => ({ ...current, sensitiveVariables: updateSensitiveVariable(current.sensitiveVariables, index, (item) => ({ ...item, required: event.target.checked })) }))} />必填</label><ToolbarButton icon={<X size={14} />} title="删除敏感变量" variant="danger" onClick={() => changeProject((current) => ({ ...current, sensitiveVariables: current.sensitiveVariables.filter((_item, valueIndex) => valueIndex !== index) }))} /></div>)}</section>
          <section><span>发布状态</span><strong className={`project-status project-status--${project.status}`}>{project.status === "published" ? "已发布" : project.status === "archived" ? "已归档" : "草稿"}</strong><ToolbarButton icon={<Send size={16} />} label={versions.length === 0 ? "发布项目" : "发布新版本"} title="校验并发布版本快照" variant="primary" onClick={() => void requestPublish()} /></section>
          <section><div className="connector-section__head"><span><History size={14} /> 版本历史</span><ToolbarButton icon={<Camera size={15} />} title="创建命名快照" onClick={() => setSnapshotOpen(true)} /></div>{versions.length === 0 ? <p className="editor-muted">暂无项目快照</p> : <div className="editor-version-list">{versions.slice(0, showAllVersions ? versions.length : 12).map((version) => <div key={version.id} className={compareVersionId === version.id ? "is-selected" : ""}><button type="button" className="editor-version-list__summary" onClick={() => setCompareVersionId(version.id)}><span><strong>v{version.version}</strong><small>{version.kind === "publish" ? "发布" : version.kind === "manual" ? "手动" : "自动"} · {new Date(version.createdAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}{version.publishedBy ? ` · ${version.publishedBy}` : ""} · {version.changeSummary}</small></span></button><ToolbarButton icon={<GitCompare size={14} />} title={`比较版本 v${version.version}`} active={compareVersionId === version.id} onClick={() => setCompareVersionId(version.id)} /><ToolbarButton icon={<Copy size={14} />} title={`从版本 v${version.version} 复制新项目`} onClick={() => void duplicateVersion(version)} /><ToolbarButton icon={<RotateCcw size={14} />} title={`恢复版本 v${version.version}`} onClick={() => void restoreVersion(version)} /></div>)}{versions.length > 12 ? <button type="button" className="editor-version-list__more" onClick={() => setShowAllVersions((open) => !open)}>{showAllVersions ? "收起早期版本" : `显示全部 ${versions.length} 个版本`}</button> : null}</div>}{compareVersion ? <div className="project-diff"><span>与 v{compareVersion.version} 比较</span>{differences.length === 0 ? <p>当前草稿没有差异。</p> : differences.slice(0, 8).map((difference) => <p key={difference.id}><small>{difference.area}</small>{difference.message}</p>)}{differences.length > 8 ? <p>另有 {differences.length - 8} 项差异。</p> : null}</div> : null}</section>
          <section className="connector-section">
            <div className="connector-section__head">
              <span><Link2 size={14} /> 连接器</span>
              <ToolbarButton icon={<Plus size={15} />} title="添加连接器" onClick={() => changeProject((current) => ({
                ...current,
                connectors: [...current.connectors, {
                  id: createId("connector"),
                  name: "新连接器",
                  origin: "https://example.com",
                  mode: "extension",
                  permission: "assist",
                  securityMode: "interactive",
                  environment: "默认环境",
                  requestHeaders: [],
                  basicAuthInstructions: "",
                  loginPaths: [],
                  logoutPaths: [],
                  roleSwitchPaths: [],
                  sandboxPermissions: ["allow-scripts", "allow-same-origin"],
                  allowedOrigins: ["https://example.com"]
                }]
              }))} />
            </div>
            {project.connectors.length === 0 ? <p className="editor-muted">当前项目没有连接器</p> : (
              <div className="connector-list">
                {project.connectors.map((connector) => (
                  <div className="connector-editor" key={connector.id}>
                    <div className="connector-editor__head">
                      <strong>{connector.name}</strong>
                      <ToolbarButton icon={<X size={14} />} title="移除连接器" variant="danger" onClick={() => {
                        if (!window.confirm(`移除连接器“${connector.name}”？关联页面将改为未选择。`)) return;
                        changeProject((current) => ({
                          ...current,
                          connectors: current.connectors.filter((item) => item.id !== connector.id),
                          pages: current.pages.map((item) => item.connectorId === connector.id ? { ...item, connectorId: undefined } : item)
                        }));
                      }} />
                    </div>
                    <label className="field"><span>名称</span><input value={connector.name} maxLength={120} onChange={(event) => changeConnector(connector.id, (current) => ({ ...current, name: event.target.value }))} /></label>
                    <label className="field"><span>Origin</span><input type="url" value={connector.origin} onChange={(event) => changeConnector(connector.id, (current) => ({ ...current, origin: event.target.value, allowedOrigins: [event.target.value] }))} /></label>
                    <label className="field"><span>环境</span><input value={connector.environment} maxLength={80} onChange={(event) => changeConnector(connector.id, (current) => ({ ...current, environment: event.target.value }))} /></label>
                    <div className="connector-editor__selects">
                      <label className="field">
                        <span>打开方式</span>
                        <select value={connector.mode} onChange={(event) => changeConnector(connector.id, (current) => ({ ...current, mode: event.target.value as PresentationConnector["mode"] }))}>
                          <option value="extension">演示标签页</option>
                          <option value="iframe">演示标签页（iframe 兼容）</option>
                          <option value="window">独立浏览器窗口</option>
                        </select>
                      </label>
                      <label className="field">
                        <span>权限</span>
                        <select value={connector.permission} onChange={(event) => changeConnector(connector.id, (current) => ({ ...current, permission: event.target.value as PresentationConnector["permission"] }))}>
                          <option value="observe">仅观察</option>
                          <option value="assist">协助</option>
                          <option value="automate">自动操作</option>
                        </select>
                      </label>
                      <label className="field">
                        <span>安全模式</span>
                        <select value={connector.securityMode} onChange={(event) => changeConnector(connector.id, (current) => ({ ...current, securityMode: event.target.value as PresentationConnector["securityMode"] }))}>
                          <option value="interactive">交互模式</option>
                          <option value="request-protection">请求保护（拦截写请求）</option>
                          <option value="readonly-proxy">只读强制（拦截全部写请求）</option>
                        </select>
                      </label>
                    </div>
                    <label className="field"><span>登录放行路径（逗号分隔）</span><input value={connector.loginPaths.join(",")} placeholder="/login,/sso" onChange={(event) => changeConnector(connector.id, (current) => ({ ...current, loginPaths: splitListValue(event.target.value) }))} /></label>
                    <label className="field"><span>退出放行路径（逗号分隔）</span><input value={connector.logoutPaths.join(",")} placeholder="/logout" onChange={(event) => changeConnector(connector.id, (current) => ({ ...current, logoutPaths: splitListValue(event.target.value) }))} /></label>
                    <label className="field"><span>切换角色放行路径（逗号分隔）</span><input value={connector.roleSwitchPaths.join(",")} placeholder="/profile/switch" onChange={(event) => changeConnector(connector.id, (current) => ({ ...current, roleSwitchPaths: splitListValue(event.target.value) }))} /></label>
                    <label className="field"><span>额外受保护 Origin（逗号分隔）</span><input value={connector.allowedOrigins.join(",")} onChange={(event) => changeConnector(connector.id, (current) => ({ ...current, allowedOrigins: splitListValue(event.target.value).slice(0, 20) }))} /></label>
                    <div className="connector-editor__sandbox">
                      {(["allow-scripts", "allow-same-origin", "allow-forms"] as const).map((permission) => (
                        <label key={permission}>
                          <input
                            type="checkbox"
                            checked={connector.sandboxPermissions.includes(permission)}
                            onChange={(event) => changeConnector(connector.id, (current) => ({
                              ...current,
                              sandboxPermissions: event.target.checked
                                ? [...current.sandboxPermissions, permission].slice(0, 3)
                                : current.sandboxPermissions.filter((item) => item !== permission)
                            }))}
                          />
                          {permission}
                          <small>{sandboxPermissionHints[permission]}</small>
                        </label>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
          <section className="editor-check"><span><Check size={15} /> 发布前检查</span>{preflight?.items.slice(0, 8).map((item) => <p key={item.id} data-state={item.state}>{item.message}</p>)}{(preflight?.items.length ?? 0) > 8 ? <p data-state="warn">另有 {(preflight?.items.length ?? 0) - 8} 项，请在演示设置中查看。</p> : null}</section>
        </aside>
      </section>

      {snapshotOpen ? (
        <div className="dialog-backdrop" role="presentation">
          <div className="dialog" role="dialog" aria-modal="true" aria-label="创建命名快照">
            <h2>创建命名快照</h2>
            <label className="field"><span>快照说明</span><input autoFocus value={snapshotName} maxLength={500} placeholder="例如：客户会前确认" onChange={(event) => setSnapshotName(event.target.value)} /></label>
            <div className="dialog__actions">
              <ToolbarButton icon="✕" label="取消" onClick={() => setSnapshotOpen(false)} />
              <ToolbarButton icon={<Camera size={14} />} label="创建快照" variant="primary" disabled={!snapshotName.trim()} onClick={() => void createManualSnapshot()} />
            </div>
          </div>
        </div>
      ) : null}

      {publishOpen ? (
        <div className="dialog-backdrop" role="presentation">
          <div className="dialog" role="dialog" aria-modal="true" aria-label="发布新版本">
            <h2>发布新版本</h2>
            <label className="field"><span>发布人（可选，本机记忆）</span><input value={publishPublisher} maxLength={120} placeholder="例如：张三" onChange={(event) => setPublishPublisher(event.target.value)} /></label>
            <label className="field"><span>变更说明（可选）</span><input autoFocus value={publishSummary} maxLength={500} placeholder="本次发布的主要变化" onChange={(event) => setPublishSummary(event.target.value)} /></label>
            <div className="dialog__actions">
              <ToolbarButton icon="✕" label="取消" onClick={() => setPublishOpen(false)} />
              <ToolbarButton icon={<Send size={14} />} label="确认发布" variant="primary" onClick={() => void publish()} />
            </div>
          </div>
        </div>
      ) : null}

      {launchTrustOpen ? (
        <div className="dialog-backdrop" role="presentation">
          <div className="dialog" role="dialog" aria-modal="true" aria-label="项目需要信任">
            <h2>项目需要信任</h2>
            <p>项目尚未信任或内容与上次信任的哈希不一致。确认后将更新本机信任记录，并为本次演示创建固定快照。</p>
            <div className="dialog__actions">
              <ToolbarButton icon="✕" label="取消" onClick={() => setLaunchTrustOpen(false)} />
              <ToolbarButton icon={<Play size={14} />} label="确认信任并运行" variant="primary" onClick={() => void (async () => {
                await trustProject(project);
                setLaunchTrustOpen(false);
                await launchProject(true);
              })()} />
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}
