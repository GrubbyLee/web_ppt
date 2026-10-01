import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { browser } from "wxt/browser";
import type { Browser } from "wxt/browser";
import type { RecordedAction } from "@showit/contracts";
import { RecordedActionSchema } from "@showit/contracts";
import type { SessionAction } from "@/session/machine";
import type { BgMessage, BroadcastState, UiMessage } from "@/messaging/protocol";
import { PORT_PREFIX } from "@/messaging/protocol";
import { recordDiagnostic } from "@/lib/diagnostics";
import { ToolbarButton } from "@/components/ToolbarButton";
import { DemoConsole } from "@/lib/demo/DemoConsole";
import { demoViewFromUrl } from "@/lib/demo/views";
import { Library, type LibraryToolbarApi } from "./Library";
import { Editor } from "./Editor";
import { ChevronLeft, ChevronRight, CircleDot, Eraser, FileUp, FlaskConical, FolderTree, Monitor, Moon, Plus, Square, Sun, TriangleAlert } from "lucide-react";

export type WorkbenchPort = {
  send: (message: UiMessage) => void;
};

export type RecorderState = {
  active: boolean;
  reason?: string | undefined;
  pageTitle?: string | undefined;
  origin?: string | undefined;
};

export function App() {
  const [route, setRoute] = useState(() => window.location.hash || "#/");
  const portRef = useRef<Browser.runtime.Port | null>(null);
  const [recorder, setRecorder] = useState<RecorderState>({ active: false });
  const recordedHandlersRef = useRef<Array<(action: RecordedAction) => void>>([]);
  const portReadyRef = useRef(false);
  const [portReady, setPortReady] = useState(false);
  const [state, setState] = useState<BroadcastState | null>(null);
  // Library first (exactly like the old library page): the presenter picks or
  // runs a project, then it steps aside so the embedded picture takes over.
  const [libraryOpen, setLibraryOpen] = useState(true);
  const toolbarApiRef = useRef<LibraryToolbarApi | null>(null);
  const autoCloseRef = useRef(true);

  useEffect(() => {
    const onHashChange = () => setRoute(window.location.hash || "#/");
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  useEffect(() => {
    let stopped = false;
    const connect = () => {
      if (stopped) return;
      let port: Browser.runtime.Port;
      try {
        port = browser.runtime.connect({ name: `${PORT_PREFIX}workbench` });
      } catch {
        setTimeout(connect, 1000);
        return;
      }
      portRef.current = port;
      port.onMessage.addListener((message: BgMessage) => {
        if (message.type === "state") {
          setState(message.state);
          // The library steps aside the first time a demo is actually running.
          if (message.state.meta.running && autoCloseRef.current) {
            autoCloseRef.current = false;
            setLibraryOpen(false);
          }
          return;
        }
        if (message.type === "recorder-state") {
          setRecorder({ active: message.active, reason: message.reason, pageTitle: message.pageTitle, origin: message.origin });
          return;
        }
        if (message.type === "recorded-action") {
          const parsed = RecordedActionSchema.safeParse(message.action);
          if (parsed.success) recordedHandlersRef.current.forEach((handler) => handler(parsed.data));
          else recordDiagnostic("接收操作录制", parsed.error);
          return;
        }
        if (message.type === "error") {
          window.alert(message.message);
        }
      });
      port.onDisconnect.addListener(() => {
        if (portRef.current === port) portRef.current = null;
        portReadyRef.current = false;
        setPortReady(false);
        setTimeout(connect, 800);
      });
      try {
        port.postMessage({ type: "hello", ctx: "workbench" } satisfies UiMessage);
        portReadyRef.current = true;
        setPortReady(true);
      } catch {
        setTimeout(connect, 800);
      }
    };
    connect();
    return () => {
      stopped = true;
      try {
        portRef.current?.disconnect();
      } catch {
        // Already disconnected.
      }
    };
  }, []);

  const send = useCallback((message: UiMessage) => {
    try {
      portRef.current?.postMessage(message);
    } catch {
      recordDiagnostic("工作台消息", "后台连接中断");
    }
  }, []);

  const port = useMemo<WorkbenchPort>(() => ({ send }), [send]);

  const registerToolbar = useCallback((api: LibraryToolbarApi | null) => {
    toolbarApiRef.current = api;
  }, []);

  const onRecordedAction = useCallback((handler: (action: RecordedAction) => void) => {
    recordedHandlersRef.current.push(handler);
    return () => {
      recordedHandlersRef.current = recordedHandlersRef.current.filter((item) => item !== handler);
    };
  }, []);

  const projectId = route.startsWith("#/p/") ? route.slice(4) : null;

  const act = useCallback((action: SessionAction) => {
    port.send({ type: "action", action });
  }, [port]);

  const meta = state?.meta ?? null;
  const machine = state?.machine ?? null;
  const project = machine?.project ?? null;
  const session = machine?.session ?? null;
  const running = meta?.running ?? false;
  const page = project && session ? (project.pages[session.currentPageIndex] ?? null) : null;
  const previewUrl = meta?.previewUrl ?? null;
  // Built-in demo pages are mirrored in place (same component the audience
  // window uses): loading demo.html a second time would open a second
  // interactive console that fights the session tab for background state.
  const demoView = machine ? demoViewFromUrl(page?.url) : null;
  const isSlidePage = Boolean(page && (page.pageType === "fixed" || page.pageType === "end"));
  const isWebPage = Boolean(page && !demoView && page.url && (page.pageType === "business" || page.pageType === "external"));

  return (
    <div className="workbench">
      {projectId ? (
        <Editor key={projectId} projectId={projectId} port={port} recorder={recorder} onRecordedAction={onRecordedAction} portReady={portReady} />
      ) : (
        <div className="stage-desk">
          <header className="stage-bar">
            <div className="stage-bar__title">
              <strong>Showit</strong>
              <span>演示工作台</span>
            </div>
            <div className="stage-bar__status">
              {project ? <span className="stage-chip">{project.name}</span> : <span className="stage-chip stage-chip--muted">未运行演示</span>}
              {project && session ? <span className="stage-chip stage-chip--muted">{`第 ${session.currentPageIndex + 1} / ${project.pages.length} 页`}</span> : null}
              {page ? <span className="stage-chip stage-chip--muted">{page.title}</span> : null}
              {running && meta && !meta.businessReady ? <span className="stage-chip stage-chip--warn">画面未就绪</span> : null}
              {meta?.captureActive ? <span className="stage-chip stage-chip--live">画面已投送</span> : null}
            </div>
            <section className="stage-bar__actions" aria-label="项目库操作">
              <ToolbarButton icon={<FolderTree size={16} />} label="项目库" title="打开本地项目库：选择或编辑演示项目" active={libraryOpen} onClick={() => setLibraryOpen((open) => !open)} />
              <ToolbarButton icon={<FileUp size={16} />} label="导入" title="导入 .showit 项目文件" onClick={() => {
                setLibraryOpen(true);
                toolbarApiRef.current?.requestImport();
              }} />
              <ToolbarButton icon={<Plus size={16} />} label="新建项目" title="创建演示项目" variant="primary" onClick={() => {
                setLibraryOpen(true);
                toolbarApiRef.current?.requestCreate();
              }} />
            </section>
          </header>

          {/* The picture is embedded here so the presenter never has to leave
              this page (and never loses it to the console) while presenting.
              Audiences still receive the captured session tab. */}
          <section className="stage-viewport" aria-label="演示画面">
            {demoView && state ? (
              <div className="stage-mirror">
                <DemoConsole mode="mirror" view={demoView} state={state} />
              </div>
            ) : isWebPage && previewUrl ? (
              <iframe className="stage-frame" src={previewUrl} title="演示画面（演讲者预览）" referrerPolicy="no-referrer" />
            ) : isSlidePage && page ? (
              <div className="stage-frame stage-slide">
                <span className="stage-slide__section">{page.section}</span>
                <h1>{page.title}</h1>
              </div>
            ) : (
              <div className="stage-frame stage-frame--empty">
                <p>还没有运行中的演示。</p>
                <p className="stage-frame__hint">点击右上角「项目库」，选择一个项目并运行；演示画面会直接出现在这里。</p>
              </div>
            )}
          </section>

          <footer className="stage-tools" aria-label="演讲者快捷工具">
            <ToolbarButton icon={<ChevronLeft size={15} />} title="上一步" disabled={!running} onClick={() => act({ type: "previous-step" })} />
            <ToolbarButton icon={<ChevronRight size={15} />} title="下一步" disabled={!running} onClick={() => act({ type: "next-step" })} />
            <span className="stage-tools__sep" />
            <ToolbarButton icon={<CircleDot size={15} />} title="激光笔" active={session?.annotationTool === "laser"} disabled={!running} onClick={() => act({ type: "set-annotation-tool", tool: session?.annotationTool === "laser" ? "none" : "laser" })} />
            <ToolbarButton icon={<FlaskConical size={15} />} title="圈选标注" active={session?.annotationTool === "circle"} disabled={!running} onClick={() => act({ type: "set-annotation-tool", tool: session?.annotationTool === "circle" ? "none" : "circle" })} />
            <ToolbarButton icon={<Square size={15} />} title="清除本页标注" disabled={!running} onClick={() => act({ type: "clear-annotations" })} />
            <ToolbarButton icon={<Eraser size={15} />} title="框选隐私遮罩元素" disabled={!running} onClick={() => port.send({ type: "pick-mask" })} />
            <span className="stage-tools__sep" />
            <ToolbarButton icon={<Moon size={15} />} title="黑屏" active={session?.screenMode === "black"} disabled={!running} onClick={() => act({ type: "set-screen-mode", screenMode: session?.screenMode === "black" ? "normal" : "black" })} />
            <ToolbarButton icon={<Sun size={15} />} title="白屏" active={session?.screenMode === "white"} disabled={!running} onClick={() => act({ type: "set-screen-mode", screenMode: session?.screenMode === "white" ? "normal" : "white" })} />
            <ToolbarButton icon="❄" title="冻结画面" active={session?.screenMode === "frozen"} disabled={!running} onClick={() => act({ type: "set-screen-mode", screenMode: session?.screenMode === "frozen" ? "normal" : "frozen" })} />
            <ToolbarButton icon={<TriangleAlert size={15} />} title="隐私遮挡" active={session?.screenMode === "privacy"} disabled={!running} onClick={() => act({ type: "set-screen-mode", screenMode: session?.screenMode === "privacy" ? "normal" : "privacy" })} />
            <ToolbarButton icon={<Monitor size={15} />} label="共享画面" title="打开只读共享画面窗口：用于视频会议共享或第二显示器预览" disabled={!running} onClick={() => port.send({ type: "open-audience" })} />
          </footer>

          {/* Mounted even while closed: keeps 导入 / 新建项目 clickable and the
              project list warm. */}
          <div className={`workbench-library${libraryOpen ? " workbench-library--open" : ""}`} aria-hidden={!libraryOpen}>
            <button type="button" className="workbench-library__scrim" aria-label="关闭项目库" tabIndex={libraryOpen ? 0 : -1} onClick={() => setLibraryOpen(false)} />
            <div className="workbench-library__panel" role="dialog" aria-modal="true" aria-label="项目库">
              <header className="workbench-library__bar">
                <strong>项目库</strong>
                <ToolbarButton icon="✕" title="关闭项目库" onClick={() => setLibraryOpen(false)} />
              </header>
              <div className="workbench-library__body">
                <Library port={port} embedded registerToolbar={registerToolbar} />
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
