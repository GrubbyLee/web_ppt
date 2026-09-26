import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Group, Panel, Separator, type Layout } from "react-resizable-panels";
import { useNavigate, useParams } from "react-router-dom";
import { Button, Input, Modal } from "antd";
import { createAudienceChannel, laserOnlyChange, publishLaser, publishSnapshot } from "../../lib/audience-sync";
import { clearReadonlyProxy, decideAudienceViewer, disconnectAllAudienceViewers, disconnectAudienceViewer, focusMainWindow, getAudienceSessionStatus, listAudienceNetworkInterfaces, listenAudienceWindowClosed, listenExtensionMessages, loadRuntimeSession, openAudienceWindow, loadWorkspace, publishAudienceSession, saveRuntimeSession, sendExtensionMessage, startAudienceSession, stopAudienceSession, type AudienceNetworkInterface, type AudienceSessionStatus, type AudienceShare } from "../../lib/persistence";
import { listRehearsals, saveRehearsal } from "../../lib/persistence";
import { autoAdvanceElapsedMs, usePresentationStore } from "../../stores/presentation-store";
import { canAutoContinueAfterVerification } from "../../lib/step-runtime";
import { BusinessStage } from "./BusinessStage";
import { NotesPanel } from "./NotesPanel";
import { PresentationFooter } from "./PresentationFooter";
import { PresenterTopBar } from "./PresenterTopBar";
import { ElementLocatorSchema, PresentationSessionSchema, ProjectSchema, type PresentationSession, type PresentationStep, type Project, type ScreenMode } from "@showit/contracts";
import type { Rehearsal } from "@showit/contracts";
import { recordDiagnostic } from "../../lib/diagnostics";
import { clearRuntimeSecrets, missingRuntimeSecrets, setRuntimeSecrets } from "../../lib/runtime-secrets";
import { applyProjectToPresentation, beginPresentationLaunch, loadPresentationLaunch, savePresentationLaunch } from "../../lib/presentation-launch";
import { resolveRecordedAction } from "../../lib/step-action";
import { shutdownPresentationRuntime } from "../../lib/presentation-shutdown";
import { inspectProjectImport, projectTrustState, trustProject } from "../../lib/project-trust";
import { startExtensionProbe, type ExtensionProbeState } from "../../lib/connector-probe";

const SettingsDrawer = lazy(() => import("./SettingsDrawer").then((module) => ({ default: module.SettingsDrawer })));

function useClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

function useNarrowLayout(): boolean {
  const [narrow, setNarrow] = useState(() => window.matchMedia("(max-width: 899px)").matches);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 899px)");
    const update = () => setNarrow(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return narrow;
}

function hasEditableTarget(event: KeyboardEvent): boolean {
  const target = event.target as HTMLElement | null;
  if (!target) return false;
  return ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || target.isContentEditable;
}

type ConnectorRuntimeState = {
  state: "ready" | "anonymous" | "role-mismatch" | "loading" | "error" | "blocked";
  role?: string;
  title?: string;
  reason?: string;
  resourceFailures?: number;
};

type StepExecutionState = { stepId: string; state: "running" | "failed" | "manual"; reason?: string } | null;
type ForceCompletionState = { stepId: string; failure: string } | null;

const connectorStates = new Set<ConnectorRuntimeState["state"]>(["ready", "anonymous", "role-mismatch", "loading", "error", "blocked"]);

function sanitizeExecutionReason(value: unknown): string {
  if (typeof value !== "string") return "步骤执行失败。";
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 200) || "步骤执行失败。";
}

export function PresenterShell() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const now = useClock();
  const narrow = useNarrowLayout();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [prompterOpen, setPrompterOpen] = useState(false);
  const [rehearsals, setRehearsals] = useState<Rehearsal[]>([]);
  const [audienceShare, setAudienceShare] = useState<AudienceShare | null>(null);
  const [audienceSessionStatus, setAudienceSessionStatus] = useState<AudienceSessionStatus | null>(null);
  const [audienceNetworkInterfaces, setAudienceNetworkInterfaces] = useState<AudienceNetworkInterface[]>([]);
  const [audienceNetworkAddress, setAudienceNetworkAddress] = useState("");
  const [connectorState, setConnectorState] = useState<ConnectorRuntimeState | null>(null);
  const [stepExecution, setStepExecution] = useState<StepExecutionState>(null);
  const [forceCompletion, setForceCompletion] = useState<ForceCompletionState>(null);
  const [forceCompletionReason, setForceCompletionReason] = useState("");
  const [maskPickerActive, setMaskPickerActive] = useState(false);
  const [notesEditing, setNotesEditing] = useState(false);
  const [businessReady, setBusinessReady] = useState(false);
  const [pageGridOpen, setPageGridOpen] = useState(false);
  const [secretValues, setSecretValues] = useState<Record<string, string>>({});
  const [secretPromptOpen, setSecretPromptOpen] = useState(false);
  const [trustBlocked, setTrustBlocked] = useState(false);
  const [offlineOriginRequest, setOfflineOriginRequest] = useState<string | null>(null);
  const {
    project,
    session,
    hydrated,
    saveState,
    lastSavedAt,
    rehearsalStartedAt,
    setWorkspace,
    setSaveState,
    setStagePercent,
    setLayoutPreset,
    setNoteFontScale,
    setActivePage,
    setPageUrl,
    updateScript,
    toggleStep,
    forceCompleteStep,
    nextStep,
    previousStep,
    confirmHighRiskStep,
    cancelHighRiskStep,
    startTimer,
    pauseTimer,
    resetTimer,
    startRehearsal,
    finishRehearsal,
    setAutoAdvance,
    setAutoAdvanceSeconds,
    setCurrentPageAutoAdvanceSeconds,
    setAutoAdvanceRunning,
    setBrowserSessionMode,
    setScreenMode,
    setOfflineFallbackActive,
    grantOfflineNetworkOrigin,
    setAnnotationTool,
    setLaser,
    addCircle,
    addPrivacyMask,
    updatePrivacyMask,
    clearAnnotations,
    clearPrivacyMasks,
    audienceReady,
    setAudienceCount,
    audienceDisconnected
  } = usePresentationStore();
  const page = project.pages[session.currentPageIndex] ?? project.pages[0];
  const pendingHighRiskStep = page?.script.steps.find((step) => step.id === session.pendingHighRiskStepId) ?? null;
  const currentStep = page?.script.steps.find((step) => !session.completedStepIds.includes(step.id)) ?? null;
  const requiredRuntimeSecrets = useMemo(() => missingRuntimeSecrets(session.id, project.sensitiveVariables), [project.sensitiveVariables, session.id]);
  const panelKey = narrow ? "vertical" : "horizontal";
  const handledCommandIds = useRef(new Set<string>());
  const pendingStepOperations = useRef(new Map<string, { sessionId: string; stepId: string }>());
  const pendingMaskPicker = useRef<{ requestId: string; pageId: string; mode: "solid" | "blur"; timeoutId: number } | null>(null);
  const lastPublished = useRef<{ project: Project; session: PresentationSession } | null>(null);
  const connectorProbe = useRef<ReturnType<typeof startExtensionProbe> | null>(null);
  const closing = useRef(false);

  const markStepFailed = useCallback((stepId: string, reason: unknown) => {
    const failure = sanitizeExecutionReason(reason);
    setStepExecution({ stepId, state: "failed", reason: failure });
    setForceCompletion({ stepId, failure });
    setForceCompletionReason("");
  }, []);

  const pickPrivacyMaskElement = useCallback(async (mode: "solid" | "blur") => {
    const current = usePresentationStore.getState();
    const currentPage = current.project.pages[current.session.currentPageIndex];
    if (!currentPage || pendingMaskPicker.current) return;
    const requestId = `mask-${current.session.id}-${Date.now().toString(36)}`.slice(0, 120);
    const timeoutId = window.setTimeout(() => {
      if (pendingMaskPicker.current?.requestId !== requestId) return;
      pendingMaskPicker.current = null;
      setMaskPickerActive(false);
      void sendExtensionMessage({ type: "cancel-privacy-mask-picker", sessionId: current.session.id });
      setConnectorState({ state: "error", reason: "选择遮罩元素已超时。" });
    }, 30_000);
    pendingMaskPicker.current = { requestId, pageId: currentPage.id, mode, timeoutId };
    setMaskPickerActive(true);
    try {
      const receivers = await sendExtensionMessage({ type: "pick-privacy-mask", requestId, sessionId: current.session.id, pageId: currentPage.id });
      if (receivers > 0) return;
      window.clearTimeout(timeoutId);
      pendingMaskPicker.current = null;
      setMaskPickerActive(false);
      setConnectorState({ state: "error", reason: "浏览器扩展未连接，无法绑定遮罩元素。" });
    } catch (error) {
      window.clearTimeout(timeoutId);
      pendingMaskPicker.current = null;
      setMaskPickerActive(false);
      recordDiagnostic("绑定隐私遮罩", error);
      setConnectorState({ state: "error", reason: "无法请求浏览器选择遮罩元素。" });
    }
  }, []);

  const beginRecordedStep = useCallback(async (activeProject: typeof project, activeSession: typeof session, step: PresentationStep) => {
    if (!step.recordedAction || step.execution === "hint") return false;
    if ([...pendingStepOperations.current.values()].some((operation) => operation.sessionId === activeSession.id && operation.stepId === step.id)) return true;
    const activePage = activeProject.pages[activeSession.currentPageIndex];
    if (!activePage) return false;
    const connector = activeProject.connectors.find((item) => item.id === activePage?.connectorId);
    let execution = step.execution;
    if (connector?.permission === "observe") execution = "highlight";
    else if (connector?.permission === "assist" && execution === "auto") execution = "assist";
    const operationId = `${activeSession.id}-${step.id}-${Date.now().toString(36)}`;
    pendingStepOperations.current.set(operationId, { sessionId: activeSession.id, stepId: step.id });
    setStepExecution({ stepId: step.id, state: "running" });
    try {
      const action = resolveRecordedAction(step.recordedAction, activeProject, activePage, activeSession.id);
      if (step.recordedAction.type === "fill" && step.recordedAction.input.source === "sensitive") setScreenMode("privacy");
      const receivers = await sendExtensionMessage({
        type: "execute-recorded-step",
        operationId,
        sessionId: activeSession.id,
        stepId: step.id,
        action,
        execution,
        expectedCondition: step.expectedCondition,
        conditionTimeoutSeconds: step.conditionTimeoutSeconds
      });
      if (receivers > 0) return true;
      pendingStepOperations.current.delete(operationId);
      markStepFailed(step.id, "浏览器扩展未连接。");
    } catch (error) {
      pendingStepOperations.current.delete(operationId);
      recordDiagnostic("执行录制步骤", error);
      if (step.recordedAction.type === "fill" && step.recordedAction.input.source === "sensitive") setSecretPromptOpen(true);
      markStepFailed(step.id, "无法将步骤发送到浏览器扩展。");
    }
    return true;
  }, [markStepFailed]);

  const runNextStep = useCallback(() => {
    const current = usePresentationStore.getState();
    const currentPage = current.project.pages[current.session.currentPageIndex];
    const next = currentPage?.script.steps.find((step) => !current.session.completedStepIds.includes(step.id));
    if (next && [...pendingStepOperations.current.values()].some((operation) => operation.sessionId === current.session.id && operation.stepId === next.id)) return;
    if (!next || !next.recordedAction || next.execution === "hint" || next.risk === "high") {
      setStepExecution(null);
      current.nextStep();
      return;
    }
    void beginRecordedStep(current.project, current.session, next);
  }, [beginRecordedStep]);

  const toggleRehearsal = useCallback(() => {
    if (usePresentationStore.getState().rehearsalStartedAt === null) {
      startRehearsal();
      return;
    }
    const record = finishRehearsal();
    if (!record) return;
    saveRehearsal(record)
      .then(() => listRehearsals(project.id))
      .then(setRehearsals)
      .catch((error) => { recordDiagnostic("保存排练记录", error); setSaveState("error"); });
  }, [finishRehearsal, project.id, setSaveState, startRehearsal]);

  useEffect(() => {
    pendingStepOperations.current.clear();
    setStepExecution(null);
    setForceCompletion(null);
    setForceCompletionReason("");
  }, [session.id]);

  useEffect(() => {
    setForceCompletion(null);
    setForceCompletionReason("");
  }, [page?.id]);

  useEffect(() => {
    if (!hydrated || currentStep?.presenterOnly !== true || session.screenMode !== "normal") return;
    setScreenMode("privacy");
  }, [currentStep?.id, currentStep?.presenterOnly, hydrated, session.screenMode, setScreenMode]);

  useEffect(() => {
    let mounted = true;
    const isTrusted = async (workspace: NonNullable<Awaited<ReturnType<typeof loadWorkspace>>>) => {
      return await projectTrustState(workspace.project) === "trusted";
    };
    const load = async (): Promise<{ workspace: Awaited<ReturnType<typeof loadWorkspace>>; trustSource: Awaited<ReturnType<typeof loadWorkspace>>; continueSession: boolean }> => {
      const launched = projectId ? loadPresentationLaunch(projectId) : null;
      if (launched) return { workspace: launched, trustSource: await loadWorkspace(projectId), continueSession: true };
      const recovered = projectId ? await loadRuntimeSession(projectId).catch(() => null) : null;
      if (recovered) return { workspace: recovered, trustSource: await loadWorkspace(projectId), continueSession: true };
      const workspace = await loadWorkspace(projectId);
      return { workspace, trustSource: workspace, continueSession: false };
    };
    load()
      .then(async ({ workspace: stored, trustSource, continueSession }) => {
        if (!mounted) return;
        if (stored && (!projectId || stored.project.id === projectId)) {
          if (!await isTrusted(trustSource ?? stored)) {
            setTrustBlocked(true);
            navigate("/projects", { replace: true });
            return;
          }
          // A remount must continue the live session (page, timers, steps),
          // not restart from the cover page mid-presentation.
          const launch = continueSession ? stored : beginPresentationLaunch(stored.project);
          savePresentationLaunch(launch);
          setWorkspace(launch.project, launch.session);
          return;
        }
        navigate("/projects", { replace: true });
      })
      .catch((error) => {
        recordDiagnostic("加载演示项目", error);
        if (mounted) navigate("/projects", { replace: true });
      });
    return () => {
      mounted = false;
    };
  }, [navigate, projectId, setWorkspace]);

  useEffect(() => {
    if (!hydrated) return;
    setSecretPromptOpen(missingRuntimeSecrets(session.id, project.sensitiveVariables).length > 0);
  }, [hydrated, project.sensitiveVariables, session.id]);

  useEffect(() => {
    if (!hydrated || project.sensitiveVariables.length === 0) return;
    const timer = window.setInterval(() => {
      if (missingRuntimeSecrets(session.id, project.sensitiveVariables).length > 0) setSecretPromptOpen(true);
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [hydrated, project.sensitiveVariables, session.id]);

  useEffect(() => () => clearRuntimeSecrets(session.id), [session.id]);

  useEffect(() => () => {
    void clearReadonlyProxy(project.id);
    void sendExtensionMessage({
      type: "configure-request-protection",
      sessionId: session.id,
      origin: "",
      securityMode: "interactive",
      loginPaths: [],
      logoutPaths: []
    });
    void sendExtensionMessage({ type: "audience-share", sessionId: session.id, signalUrl: "", deliveryMode: "p2p", sfuUrl: "", sfuToken: "" });
  }, [project.id, session.id]);

  useEffect(() => {
    if (!hydrated) return;
    setSaveState("saving");
    const handle = window.setTimeout(() => {
      const projectResult = ProjectSchema.safeParse(project);
      const sessionResult = PresentationSessionSchema.safeParse(session);
      if (!projectResult.success || !sessionResult.success) {
        setSaveState("error");
        return;
      }
      try {
        const runtimeWorkspace = { project: projectResult.data, session: sessionResult.data };
        savePresentationLaunch(runtimeWorkspace);
        void saveRuntimeSession(runtimeWorkspace)
          .then(() => setSaveState("saved"))
          .catch((error) => { recordDiagnostic("保存 SQLite 运行会话", error); setSaveState("error"); });
      } catch (error) {
        recordDiagnostic("保存运行会话快照", error);
        setSaveState("error");
      }
    }, 400);
    return () => window.clearTimeout(handle);
  }, [hydrated, project, session, setSaveState]);

  useEffect(() => {
    if (!hydrated) return;
    // Laser moves arrive at up to ~30 Hz; publish the small laser delta
    // instead of cloning the full project for every pointer sample.
    const previous = lastPublished.current;
    lastPublished.current = { project, session };
    if (previous && previous.project === project) {
      const laser = laserOnlyChange(previous.session, session);
      if (laser !== undefined) {
        publishLaser(session, laser);
      } else {
        publishSnapshot(project, session);
      }
    } else {
      publishSnapshot(project, session);
    }
    if (audienceShare?.sessionId === session.id) publishAudienceSession(project, session).catch((error) => {
      recordDiagnostic("同步局域网观众", error);
      void sendExtensionMessage({ type: "audience-share", sessionId: session.id, signalUrl: "", deliveryMode: "p2p", sfuUrl: "", sfuToken: "" });
      setAudienceShare(null);
      setAudienceSessionStatus(null);
      audienceDisconnected();
    });
    const currentPage = project.pages[session.currentPageIndex];
    sendExtensionMessage({
      type: "session-state",
      sessionId: session.id,
      pageIndex: session.currentPageIndex,
      pageCount: project.pages.length,
      pageTitle: currentPage?.title ?? "未选择页面",
      meta: `${currentPage?.section ?? ""} · ${session.timerStatus === "running" ? "计时中" : session.timerStatus === "paused" ? "已暂停" : "未开始"}`,
      stepText: currentPage?.script.steps.find((step) => !session.completedStepIds.includes(step.id))?.text ?? "本页步骤已完成",
      stepIndex: currentPage ? currentPage.script.steps.filter((step) => session.completedStepIds.includes(step.id)).length : 0,
      stepCount: currentPage?.script.steps.length ?? 0,
      timerStatus: session.timerStatus,
      totalElapsedMs: session.totalElapsedMs,
      pageElapsedMs: session.pageElapsedMs,
      timerStartedAt: session.timerStartedAt,
      screenMode: session.screenMode,
      offlineFallbackActive: session.offlineFallbackPageId === currentPage?.id,
      privacyMasks: currentPage?.privacyMasks.map(({ x1, y1, x2, y2, mode }) => ({ x1, y1, x2, y2, mode })) ?? []
    }).catch(() => undefined);
    if (audienceShare?.sessionId === session.id && audienceShare.signalUrl) {
      sendExtensionMessage({ type: "audience-share", sessionId: session.id, signalUrl: audienceShare.signalUrl, deliveryMode: audienceShare.deliveryMode, sfuUrl: audienceShare.sfuUrl ?? "", sfuToken: audienceShare.sfuToken ?? "" }).catch(() => undefined);
    }
  }, [audienceShare?.sessionId, hydrated, project, session]);

  useEffect(() => {
    if (!hydrated) return;
    listAudienceNetworkInterfaces()
      .then((interfaces) => {
        setAudienceNetworkInterfaces(interfaces);
        setAudienceNetworkAddress((current) => current || interfaces.find((item) => item.isDefault)?.address || interfaces[0]?.address || "");
      })
      .catch((error) => recordDiagnostic("读取观众网络接口", error));
  }, [hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    let unlisten: (() => void) | null = null;
    let disposed = false;
    listenExtensionMessages((message) => {
      if (!message || typeof message !== "object") return;
      const command = message as { type?: unknown; sessionId?: unknown; commandId?: unknown; operationId?: unknown; stepId?: unknown; ok?: unknown; reason?: unknown };
      const current = usePresentationStore.getState();
      if (command.type !== "focus-showit" && command.sessionId !== current.session.id) return;
      if (typeof command.commandId === "string") {
        if (handledCommandIds.current.has(command.commandId)) return;
        handledCommandIds.current.add(command.commandId);
        if (handledCommandIds.current.size > 100) handledCommandIds.current.delete(handledCommandIds.current.values().next().value!);
      }
      if (command.type === "goto-next") current.setActivePage(current.session.currentPageIndex + 1);
      if (command.type === "goto-prev") current.setActivePage(current.session.currentPageIndex - 1);
      if (command.type === "recorded-step-result") {
        if (typeof command.operationId !== "string" || typeof command.stepId !== "string") return;
        const pending = pendingStepOperations.current.get(command.operationId);
        if (!pending || pending.sessionId !== current.session.id || pending.stepId !== command.stepId) return;
        pendingStepOperations.current.delete(command.operationId);
        const activePage = current.project.pages[current.session.currentPageIndex];
        const activeStep = activePage?.script.steps.find((step) => step.id === command.stepId);
        if (!activeStep) {
          setStepExecution(null);
          return;
        }
        if (command.ok === true && activeStep.expectedCondition) {
          current.completeStep(command.stepId);
          setStepExecution(null);
          if (activePage && canAutoContinueAfterVerification(activePage, activeStep)) {
            const activePageId = activePage.id;
            window.setTimeout(() => {
              const latest = usePresentationStore.getState();
              const latestPage = latest.project.pages[latest.session.currentPageIndex];
              const next = latestPage?.script.steps.find((step) => !latest.session.completedStepIds.includes(step.id));
              if (latest.session.id !== current.session.id || latestPage?.id !== activePageId || !next || next.risk === "high") return;
              if (next.recordedAction && next.execution !== "hint") runNextStep();
            }, 0);
          }
        } else if (command.ok === true) {
          setStepExecution({ stepId: command.stepId, state: "manual", reason: "动作已完成，请手动确认本步骤。" });
        } else {
          markStepFailed(command.stepId, command.reason);
        }
      }
      if (command.type === "privacy-mask-picked") {
        const result = message as { requestId?: unknown; pageId?: unknown; ok?: unknown; locator?: unknown; bounds?: unknown; reason?: unknown };
        const pending = pendingMaskPicker.current;
        if (!pending || result.requestId !== pending.requestId || result.pageId !== pending.pageId) return;
        window.clearTimeout(pending.timeoutId);
        pendingMaskPicker.current = null;
        setMaskPickerActive(false);
        const locator = ElementLocatorSchema.safeParse(result.locator);
        const bounds = result.bounds as { x1?: unknown; y1?: unknown; x2?: unknown; y2?: unknown } | null;
        const values = bounds ? [bounds.x1, bounds.y1, bounds.x2, bounds.y2] : [];
        if (result.ok !== true || !locator.success || values.length !== 4 || values.some((value) => typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1)) {
          setConnectorState({ state: "error", reason: sanitizeExecutionReason(result.reason ?? "遮罩元素没有唯一稳定定位器。") });
          return;
        }
        current.addPrivacyMask({ id: `mask-${Date.now().toString(36)}`, x1: bounds!.x1 as number, y1: bounds!.y1 as number, x2: bounds!.x2 as number, y2: bounds!.y2 as number, mode: pending.mode, locator: locator.data });
      }
      if (command.type === "privacy-mask-resolution") {
        const result = message as { pageId?: unknown; ok?: unknown; resolved?: unknown; missing?: unknown; reason?: unknown };
        const activePage = current.project.pages[current.session.currentPageIndex];
        if (!activePage || result.pageId !== activePage.id) return;
        const boundIds = new Set(activePage.privacyMasks.filter((mask) => mask.locator).map((mask) => mask.id));
        const missing = Array.isArray(result.missing) ? result.missing.filter((id): id is string => typeof id === "string" && boundIds.has(id)) : [];
        if (result.ok !== true || missing.length > 0) {
          if (current.session.screenMode === "normal") current.setScreenMode("privacy");
          setConnectorState({ state: "blocked", reason: "绑定的隐私遮罩无法定位，观众屏已进入整页保护。" });
          return;
        }
        if (!Array.isArray(result.resolved)) return;
        for (const item of result.resolved) {
          if (!item || typeof item !== "object") continue;
          const resolution = item as { id?: unknown; bounds?: { x1?: unknown; y1?: unknown; x2?: unknown; y2?: unknown } };
          if (typeof resolution.id !== "string" || !boundIds.has(resolution.id) || !resolution.bounds) continue;
          const values = [resolution.bounds.x1, resolution.bounds.y1, resolution.bounds.x2, resolution.bounds.y2];
          if (values.some((value) => typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1)) continue;
          current.updatePrivacyMask(resolution.id, resolution.bounds as { x1: number; y1: number; x2: number; y2: number });
        }
      }
      if (command.type === "goto-next-step") runNextStep();
      if (command.type === "goto-prev-step") current.previousStep();
      if (command.type === "focus-showit") void focusMainWindow();
      if (command.type === "connector-probe") {
        const probe = message as { connectorId?: unknown; origin?: unknown; hasPasswordField?: unknown; privacyRisk?: unknown; title?: unknown; reason?: unknown; state?: unknown };
        const activePage = current.project.pages[current.session.currentPageIndex];
        const activeConnector = current.project.connectors.find((item) => item.id === activePage?.connectorId);
        let activeOrigin: string | null = null;
        try { activeOrigin = activeConnector ? new URL(activeConnector.origin).origin : null; } catch { activeOrigin = null; }
        if (!activeConnector || probe.connectorId !== activeConnector.id || probe.origin !== activeOrigin) return;
        connectorProbe.current?.settle();
        const privacyRisk = typeof probe.privacyRisk === "string" && ["password", "file", "mfa", "sso"].includes(probe.privacyRisk) ? probe.privacyRisk : null;
        const state = privacyRisk === "file" ? "blocked" : privacyRisk ? "anonymous" : connectorStates.has(probe.state as ConnectorRuntimeState["state"]) ? probe.state as ConnectorRuntimeState["state"] : "ready";
        setConnectorState({
          state,
          ...(typeof probe.title === "string" ? { title: probe.title.slice(0, 300) } : {}),
          ...(privacyRisk ? { reason: privacyRisk === "file" ? "检测到文件选择，观众屏已进入隐私保护。" : privacyRisk === "mfa" ? "检测到多因素认证，观众屏已进入隐私保护。" : privacyRisk === "sso" ? "检测到登录流程，观众屏已进入隐私保护。" : "检测到密码输入，观众屏已进入隐私保护。" } : typeof probe.reason === "string" ? { reason: probe.reason.slice(0, 200) } : {})
        });
        if (privacyRisk || probe.hasPasswordField === true) current.setScreenMode("privacy");
      }
      if (command.type === "connector-navigation") {
        const navigation = message as { state?: unknown; title?: unknown; reason?: unknown };
        const state = connectorStates.has(navigation.state as ConnectorRuntimeState["state"]) ? navigation.state as ConnectorRuntimeState["state"] : "blocked";
        setConnectorState({
          state,
          ...(typeof navigation.title === "string" ? { title: navigation.title.slice(0, 300) } : {}),
          ...(typeof navigation.reason === "string" ? { reason: navigation.reason.slice(0, 200) } : {})
        });
        if (state === "blocked") current.setScreenMode("privacy");
      }
      if (command.type === "connector-resource-failures") {
        const failures = message as { count?: unknown };
        if (typeof failures.count === "number" && Number.isInteger(failures.count) && failures.count > 0) {
          setConnectorState((state) => ({ ...(state ?? { state: "ready" }), resourceFailures: Math.min(10_000, failures.count as number) }));
        }
      }
      if (command.type === "business-page-message") {
        const payload = (message as { payload?: unknown }).payload;
        if (!payload || typeof payload !== "object") return;
        const business = payload as { type?: unknown; state?: unknown; role?: unknown };
        if (business.type !== "showit:connector-state" || !connectorStates.has(business.state as ConnectorRuntimeState["state"])) return;
        setConnectorState({
          state: business.state as ConnectorRuntimeState["state"],
          ...(typeof business.role === "string" ? { role: business.role.slice(0, 80) } : {})
        });
      }
      if (command.type === "request-protection-state") {
        const protection = message as { enabled?: unknown; reason?: unknown };
        setConnectorState({
          state: protection.enabled === true ? "ready" : protection.reason ? "error" : "ready",
          ...(typeof protection.reason === "string" ? { reason: protection.reason.slice(0, 200) } : { title: protection.enabled === true ? "请求保护已启用" : "交互模式" })
        });
      }
    }).then((cleanup) => {
      // The effect may unmount before the listener promise settles — detach
      // immediately in that case instead of leaking the subscription.
      if (disposed) { cleanup?.(); return; }
      unlisten = cleanup;
    }).catch((error) => { recordDiagnostic("连接浏览器扩展", error); });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [hydrated, markStepFailed, runNextStep]);

  useEffect(() => () => {
    const pending = pendingMaskPicker.current;
    if (!pending) return;
    window.clearTimeout(pending.timeoutId);
    pendingMaskPicker.current = null;
    setMaskPickerActive(false);
    void sendExtensionMessage({ type: "cancel-privacy-mask-picker", sessionId: session.id });
  }, [page?.id, session.id]);

  useEffect(() => {
    if (!hydrated || !page) return;
    const items = page.privacyMasks.filter((mask) => mask.locator).map((mask) => ({ id: mask.id, locator: mask.locator }));
    if (items.length === 0) return;
    const resolve = () => sendExtensionMessage({ type: "resolve-privacy-masks", sessionId: session.id, pageId: page.id, items })
      .then((receivers) => {
        if (receivers > 0) return;
        const current = usePresentationStore.getState();
        if (current.session.id === session.id && current.session.screenMode === "normal") current.setScreenMode("privacy");
        setConnectorState({ state: "blocked", reason: "无法确认绑定隐私遮罩，观众屏已进入整页保护。" });
      })
      .catch(() => {
        const current = usePresentationStore.getState();
        if (current.session.id === session.id && current.session.screenMode === "normal") current.setScreenMode("privacy");
        setConnectorState({ state: "blocked", reason: "无法确认绑定隐私遮罩，观众屏已进入整页保护。" });
      });
    void resolve();
    const timer = window.setInterval(resolve, 750);
    return () => window.clearInterval(timer);
  }, [hydrated, page, session.id]);

  useEffect(() => {
    if (!hydrated) return;
    connectorProbe.current?.dispose();
    const connector = project.connectors.find((item) => item.id === page?.connectorId);
    if (connector?.mode !== "extension") {
      connectorProbe.current = null;
      setConnectorState(null);
      return;
    }
    connectorProbe.current = startExtensionProbe(
      () => sendExtensionMessage({ type: "probe-active-tab", sessionId: session.id, connectorId: connector.id, origin: connector.origin }),
      (state: ExtensionProbeState) => setConnectorState(state)
    );
    return () => {
      connectorProbe.current?.dispose();
      connectorProbe.current = null;
    };
  }, [hydrated, page?.connectorId, project.connectors, project.id, session.currentPageIndex, session.id]);

  useEffect(() => {
    if (!hydrated) return;
    const connector = project.connectors.find((item) => item.id === page?.connectorId);
    sendExtensionMessage({
      type: "configure-request-protection",
      sessionId: session.id,
      origin: connector?.origin ?? "",
      securityMode: connector?.mode === "extension" && connector.securityMode === "request-protection" ? "request-protection" : "interactive",
      loginPaths: connector?.loginPaths ?? [],
      logoutPaths: connector?.logoutPaths ?? []
    }).catch(() => undefined);
  }, [hydrated, page?.connectorId, project.connectors, session.id]);

  useEffect(() => {
    if (!hydrated) return;
    const channel = createAudienceChannel(session.id, () => undefined, audienceReady);
    return () => channel.close();
  }, [audienceReady, hydrated, session.id]);

  useEffect(() => {
    if (!hydrated) return;
    let unlisten: (() => void) | null = null;
    let disposed = false;
    listenAudienceWindowClosed(session.id, audienceDisconnected)
      .then((cleanup) => {
        if (disposed) { cleanup?.(); return; }
        unlisten = cleanup;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [audienceDisconnected, hydrated, session.id]);

  const autoAdvanceBlocked = !hydrated
    || !page
    || session.timerStatus !== "running"
    || settingsOpen
    || notesEditing
    || !businessReady
    || (connectorState !== null && connectorState.state !== "ready")
    || session.screenMode !== "normal"
    || session.annotationTool !== "none"
    || maskPickerActive
    || pendingHighRiskStep !== null
    || forceCompletion !== null
    || stepExecution !== null
    || secretPromptOpen;

  useEffect(() => {
    setAutoAdvanceRunning(project.autoAdvanceEnabled && !autoAdvanceBlocked);
  }, [autoAdvanceBlocked, project.autoAdvanceEnabled, session.currentPageIndex, setAutoAdvanceRunning]);

  useEffect(() => {
    if (!project.autoAdvanceEnabled || autoAdvanceBlocked || !page) return;
    const limit = page.autoAdvanceSeconds ?? project.autoAdvanceSeconds;
    if (autoAdvanceElapsedMs(session, now) >= limit * 1_000 && session.currentPageIndex < project.pages.length - 1) {
      setActivePage(session.currentPageIndex + 1);
    }
  }, [autoAdvanceBlocked, now, page, project.autoAdvanceEnabled, project.autoAdvanceSeconds, project.pages.length, session, setActivePage]);

  // While a modal owns the screen, shortcuts must stay silent — otherwise pages
  // flip invisibly behind the dialog and Escape cascades into unrelated state.
  const modalOpen = settingsOpen
    || secretPromptOpen
    || offlineOriginRequest !== null
    || maskPickerActive
    || pendingHighRiskStep !== null
    || forceCompletion !== null
    || stepExecution !== null;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (modalOpen || hasEditableTarget(event) || event.ctrlKey || event.metaKey || event.altKey) return;
      if (["ArrowRight", "ArrowDown", "PageDown"].includes(event.key)) {
        event.preventDefault();
        setActivePage(session.currentPageIndex + 1);
      }
      if (["ArrowLeft", "ArrowUp", "PageUp"].includes(event.key)) {
        event.preventDefault();
        setActivePage(session.currentPageIndex - 1);
      }
      if (event.key === "Home") {
        event.preventDefault();
        setActivePage(0);
      }
      if (event.key === "End") {
        event.preventDefault();
        setActivePage(project.pages.length - 1);
      }
      if (event.key === " ") {
        event.preventDefault();
        session.timerStatus === "running" ? pauseTimer() : startTimer();
      }
      if (event.key.toLowerCase() === "l") {
        event.preventDefault();
        setAnnotationTool(session.annotationTool === "laser" ? "none" : "laser");
      }
      if (event.key.toLowerCase() === "c") {
        event.preventDefault();
        setAnnotationTool(session.annotationTool === "circle" ? "none" : "circle");
      }
      if (event.key.toLowerCase() === "x") {
        event.preventDefault();
        clearAnnotations();
      }
      if (event.key.toLowerCase() === "b") { event.preventDefault(); setScreenMode(session.screenMode === "black" ? "normal" : "black"); }
      if (event.key.toLowerCase() === "w") { event.preventDefault(); setScreenMode(session.screenMode === "white" ? "normal" : "white"); }
      if (event.key.toLowerCase() === "f") { event.preventDefault(); setScreenMode(session.screenMode === "frozen" ? "normal" : "frozen"); }
      if (event.key.toLowerCase() === "a") { event.preventDefault(); setAutoAdvance(!project.autoAdvanceEnabled); }
      if (event.key.toLowerCase() === "r") { event.preventDefault(); toggleRehearsal(); }
      if (event.key.toLowerCase() === "p") { event.preventDefault(); setPrompterOpen((open) => !open); }
      if (event.key === "?" || event.key === "/") { event.preventDefault(); setSettingsOpen(true); }
      if (event.key === "Escape") {
        event.preventDefault();
        if (session.screenMode !== "normal") setScreenMode("normal");
        else if (prompterOpen) setPrompterOpen(false);
        else if (session.annotationTool !== "none") setAnnotationTool("none");
        else setPageGridOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [clearAnnotations, modalOpen, pauseTimer, project.autoAdvanceEnabled, project.pages.length, prompterOpen, session.annotationTool, session.currentPageIndex, session.screenMode, session.timerStatus, setActivePage, setAnnotationTool, setAutoAdvance, setScreenMode, startTimer, toggleRehearsal]);

  useEffect(() => {
    if (!session.laser) return;
    const handle = window.setTimeout(() => setLaser(null), Math.max(0, session.laser.expiresAt - Date.now()));
    return () => window.clearTimeout(handle);
  }, [session.laser, setLaser]);

  const audienceUrl = useMemo(() => `${window.location.origin}${window.location.pathname}#/audience/${session.id}`, [session.id]);

  const closePresentation = useCallback(async () => {
    if (closing.current) return;
    closing.current = true;
    const current = usePresentationStore.getState();
    current.endPresentation();
    const ended = usePresentationStore.getState();
    const failures = await shutdownPresentationRuntime({
      project: ended.project,
      session: ended.session,
      audienceSessionId: audienceShare?.sessionId ?? null
    });
    for (const failure of failures) recordDiagnostic(failure.area, failure.error);
    setAudienceShare(null);
    setAudienceSessionStatus(null);
    navigate("/projects");
  }, [audienceShare?.sessionId, navigate]);

  useEffect(() => () => {
    if (audienceShare) void stopAudienceSession(audienceShare.sessionId);
  }, [audienceShare]);

  useEffect(() => {
    if (!audienceShare) return;
    let active = true;
    let failureRecorded = false;
    const refresh = () => {
      getAudienceSessionStatus(audienceShare.sessionId)
        .then((status) => {
          if (!active || !status) return;
          setAudienceCount(status.audienceCount);
          setAudienceSessionStatus(status);
        })
        .catch((error) => {
          if (failureRecorded) return;
          failureRecorded = true;
          recordDiagnostic("读取局域网观众状态", error);
        });
    };
    refresh();
    const timer = window.setInterval(refresh, 1_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [audienceShare, setAudienceCount]);

  useEffect(() => {
    if (!settingsOpen) return;
    listRehearsals(project.id).then(setRehearsals).catch(() => setRehearsals([]));
  }, [project.id, settingsOpen]);

  if (trustBlocked || !page) {
    return (
      <main className="fatal-screen">
        <strong>{trustBlocked ? "项目尚未获得运行信任" : "项目没有可演示页面"}</strong>
        <span>{trustBlocked ? "请在项目库或编辑器中确认项目内容后再运行。" : "请导入或创建至少一个页面。"}</span>
      </main>
    );
  }

  return (
    <main className={`presenter-shell ${prompterOpen ? "is-prompter" : ""}`}>
      <PresenterTopBar
        project={project}
        session={session}
        now={now}
        onToggleAutoAdvance={() => setAutoAdvance(!project.autoAdvanceEnabled)}
        onOpenProjects={() => { void closePresentation(); }}
        onOpenSettings={() => setSettingsOpen(true)}
        onApplyProjectChanges={() => {
          const current = usePresentationStore.getState();
          loadWorkspace(current.project.id)
            .then(async (stored) => {
              if (!stored) throw new Error("项目工作副本不存在。");
              const apply = () => {
                const latest = usePresentationStore.getState();
                const applied = applyProjectToPresentation({ project: latest.project, session: latest.session }, stored.project);
                setWorkspace(applied.project, applied.session);
                setConnectorState({ state: "ready", title: "已应用项目编辑器中的最新修改" });
              };
              if (await projectTrustState(stored.project) === "trusted") {
                apply();
                return;
              }
              const review = inspectProjectImport(stored.project);
              Modal.confirm({
                title: "项目修改需要重新信任",
                content: `将应用 ${review.origins.length} 个业务域名、${review.offlineHtmlPages} 个离线 HTML 页面、${review.automatedConnectors} 个自动操作连接器和 ${review.highRiskSteps} 个高风险步骤。`,
                okText: "确认信任并应用",
                cancelText: "取消",
                onOk: async () => {
                  await trustProject(stored.project);
                  apply();
                }
              });
            })
            .catch((error) => {
              recordDiagnostic("应用项目修改", error);
              setConnectorState({ state: "error", reason: "无法读取项目编辑器的最新修改。" });
            });
        }}
        prompterOpen={prompterOpen}
        onTogglePrompter={() => setPrompterOpen((open) => !open)}
        onOpenAudience={() => {
          const open = async () => {
            let share = audienceShare;
            let started = false;
            if (!share) {
              share = await startAudienceSession(project, session, audienceNetworkAddress || undefined);
              started = true;
              setAudienceShare(share);
              setAudienceSessionStatus({ audienceCount: 0, capacity: project.audienceCapacityMode === "sfu-20" ? 20 : 5, viewers: [] });
              setAudienceCount(0);
            }
            try {
              await openAudienceWindow(session.id);
            } catch (error) {
              if (started && share) {
                await stopAudienceSession(share.sessionId).catch((stopError) => recordDiagnostic("回滚观众会话", stopError));
                setAudienceShare(null);
                setAudienceSessionStatus(null);
              }
              throw error;
            }
          };
          open().catch((error) => { recordDiagnostic("打开本机观众屏", error); audienceDisconnected(); });
        }}
        onEnd={() => { void closePresentation(); }}
      />

      <section className="runtime-main" aria-label="演讲者工作区">
        <Group
          key={panelKey}
          orientation={narrow ? "vertical" : "horizontal"}
          defaultLayout={{
            stage: narrow ? 62 : project.layout.stagePercent,
            notes: narrow ? 38 : 100 - project.layout.stagePercent
          }}
          onLayoutChanged={(layout: Layout) => {
            if (!narrow && typeof layout.stage === "number") setStagePercent(layout.stage);
          }}
        >
          <Panel id="stage" className="stage-panel" minSize={narrow ? "45%" : "50%"} maxSize={narrow ? "70%" : "75%"}>
            <BusinessStage
              project={project}
              session={session}
              page={page}
              pageGridOpen={pageGridOpen}
              onPageSelect={setActivePage}
              onPageGridOpenChange={setPageGridOpen}
              onUrlChange={(url) => {
                setSaveState("saving");
                setPageUrl(url);
              }}
              onAnnotationTool={setAnnotationTool}
              onLaser={setLaser}
              onCircle={addCircle}
              onMask={addPrivacyMask}
              onBindMask={pickPrivacyMaskElement}
              maskPickerActive={maskPickerActive}
              onClear={clearAnnotations}
              onClearMasks={clearPrivacyMasks}
              onOfflineFallback={setOfflineFallbackActive}
              onOfflineNetworkOriginRequest={setOfflineOriginRequest}
              connectorState={connectorState}
              onReadinessChange={setBusinessReady}
            />
          </Panel>
          <Separator
            className="resize-handle"
            title="拖拽调整分栏，双击恢复页面优先布局"
            onDoubleClick={() => setLayoutPreset("stage")}
          />
          <Panel id="notes" className="notes-panel-container" minSize={narrow ? "30%" : "25%"}>
            <NotesPanel
              project={project}
              session={session}
              page={page}
              saveState={saveState}
              lastSavedAt={lastSavedAt}
              onMarkdownChange={updateScript}
              onStepToggle={(stepId) => {
                if (stepExecution?.stepId === stepId) setStepExecution(null);
                toggleStep(stepId);
              }}
              onNextStep={runNextStep}
              stepExecution={stepExecution}
              onFontScale={setNoteFontScale}
              onSaveIntent={() => setSaveState("saving")}
              onEditingChange={setNotesEditing}
            />
          </Panel>
        </Group>
      </section>

      <PresentationFooter
        project={project}
        session={session}
        page={page}
        now={now}
        onFirst={() => setActivePage(0)}
        onPrevious={() => setActivePage(session.currentPageIndex - 1)}
        onNext={() => setActivePage(session.currentPageIndex + 1)}
        onLast={() => setActivePage(project.pages.length - 1)}
        onStart={startTimer}
        onPause={pauseTimer}
        onReset={resetTimer}
        rehearsalActive={rehearsalStartedAt !== null}
        onRehearsal={toggleRehearsal}
      />

      {forceCompletion ? (
        <section className="force-completion-dialog" role="alertdialog" aria-modal="true" aria-label="强制完成步骤">
          <strong>步骤验证未通过</strong>
          <p>{forceCompletion.failure}</p>
          <label>
            <span>强制完成原因</span>
            <textarea
              autoFocus
              rows={3}
              maxLength={500}
              value={forceCompletionReason}
              placeholder="请说明为何跳过验证"
              onChange={(event) => setForceCompletionReason(event.target.value)}
            />
          </label>
          <small>{forceCompletionReason.trim() ? `${forceCompletionReason.trim().length}/500` : "必须填写原因后才能强制完成"}</small>
          <div>
            <button type="button" onClick={() => { setForceCompletion(null); setForceCompletionReason(""); }}>返回重试</button>
            <button
              type="button"
              disabled={!forceCompletionReason.trim()}
              onClick={() => {
                forceCompleteStep(forceCompletion.stepId, forceCompletionReason);
                setStepExecution(null);
                setForceCompletion(null);
                setForceCompletionReason("");
              }}
            >
              强制完成
            </button>
          </div>
        </section>
      ) : null}

      {pendingHighRiskStep && !forceCompletion ? (
        <section className="high-risk-confirm" role="alertdialog" aria-modal="true" aria-label="确认高风险步骤">
          <strong>确认高风险操作</strong>
          <p>{pendingHighRiskStep.text}</p>
          {stepExecution?.stepId === pendingHighRiskStep.id ? <p className={`high-risk-confirm__status is-${stepExecution.state}`} role="status">{stepExecution.state === "running" ? "正在等待浏览器执行结果..." : stepExecution.reason}</p> : null}
          <div>
            <button type="button" disabled={stepExecution?.stepId === pendingHighRiskStep.id && stepExecution.state === "running"} onClick={() => { setStepExecution(null); cancelHighRiskStep(); }}>取消</button>
            <button
              type="button"
              disabled={stepExecution?.stepId === pendingHighRiskStep.id && stepExecution.state === "running"}
              onClick={() => {
                if (stepExecution?.stepId === pendingHighRiskStep.id && stepExecution.state === "manual") {
                  setStepExecution(null);
                  confirmHighRiskStep();
                  return;
                }
                if (pendingHighRiskStep.recordedAction && pendingHighRiskStep.execution !== "hint") {
                  void beginRecordedStep(project, session, pendingHighRiskStep);
                  return;
                }
                confirmHighRiskStep();
              }}
            >
              {stepExecution?.stepId === pendingHighRiskStep.id && stepExecution.state === "failed" ? "重新执行" : stepExecution?.stepId === pendingHighRiskStep.id && stepExecution.state === "manual" ? "确认完成" : pendingHighRiskStep.recordedAction && pendingHighRiskStep.execution !== "hint" ? "确认并执行" : "确认完成"}
            </button>
          </div>
        </section>
      ) : null}

      {settingsOpen ? (
        <Suspense fallback={null}>
          <SettingsDrawer
            open={settingsOpen}
            project={project}
            session={session}
            rehearsals={rehearsals}
            audienceShareUrl={audienceShare?.url ?? null}
            audienceShare={audienceShare}
            audienceSessionStatus={audienceSessionStatus}
            audienceNetworkInterfaces={audienceNetworkInterfaces}
            audienceNetworkAddress={audienceNetworkAddress}
            onAudienceNetworkAddress={setAudienceNetworkAddress}
            onDecideViewer={(viewerId, approve) => {
              if (!audienceShare) return;
              decideAudienceViewer(audienceShare.sessionId, viewerId, approve).catch((error) => recordDiagnostic(approve ? "批准观众" : "拒绝观众", error));
            }}
            onDisconnectViewer={(viewerId) => {
              if (!audienceShare) return;
              disconnectAudienceViewer(audienceShare.sessionId, viewerId).catch((error) => recordDiagnostic("断开观众", error));
            }}
            onDisconnectAllViewers={() => {
              if (!audienceShare) return;
              disconnectAllAudienceViewers(audienceShare.sessionId).catch((error) => recordDiagnostic("断开全部观众", error));
            }}
            onStartAudienceShare={() => {
              startAudienceSession(project, session, audienceNetworkAddress || undefined)
                .then((share) => { setAudienceShare(share); setAudienceSessionStatus({ audienceCount: 0, capacity: share.deliveryMode === "sfu" ? 20 : 5, viewers: [] }); setAudienceCount(0); })
                .catch((error) => { recordDiagnostic("启动局域网观众", error); setSaveState("error"); });
            }}
            onStopAudienceShare={() => {
              if (!audienceShare) return;
              stopAudienceSession(audienceShare.sessionId)
                .then(() => {
                  void sendExtensionMessage({ type: "audience-share", sessionId: audienceShare.sessionId, signalUrl: "", deliveryMode: "p2p", sfuUrl: "", sfuToken: "" });
                  setAudienceShare(null);
                  setAudienceSessionStatus(null);
                  audienceDisconnected();
                })
                .catch((error) => { recordDiagnostic("停止局域网观众", error); setSaveState("error"); });
            }}
            onClose={() => setSettingsOpen(false)}
            onAutoAdvance={setAutoAdvance}
            onAutoAdvanceSeconds={setAutoAdvanceSeconds}
            onCurrentPageAutoAdvanceSeconds={setCurrentPageAutoAdvanceSeconds}
            onBrowserSessionMode={setBrowserSessionMode}
            onLayoutPreset={setLayoutPreset}
            onStagePercent={setStagePercent}
            onScreenMode={(mode: ScreenMode) => setScreenMode(mode)}
          />
        </Suspense>
      ) : null}

      <Modal
        title="允许离线备用访问网络"
        open={offlineOriginRequest !== null}
        onCancel={() => setOfflineOriginRequest(null)}
        footer={[
          <Button key="deny" onClick={() => setOfflineOriginRequest(null)}>保持阻止</Button>,
          <Button key="allow" type="primary" onClick={() => { if (offlineOriginRequest) grantOfflineNetworkOrigin(offlineOriginRequest); setOfflineOriginRequest(null); }}>允许本次演示</Button>
        ]}
      >
        <p>隔离 HTML 请求访问 <code>{offlineOriginRequest}</code>。授权只进入当前运行快照，项目包和观众屏不会获得该权限。</p>
      </Modal>

      <Modal
        title="输入本次演示的敏感变量"
        open={secretPromptOpen}
        closable={false}
        maskClosable={false}
        footer={[
          <Button key="leave" onClick={() => { void closePresentation(); }}>退出演示</Button>,
          <Button
            key="start"
            type="primary"
            disabled={requiredRuntimeSecrets.some((definition) => !(secretValues[definition.key] ?? "").trim())}
            onClick={() => {
              try {
                setRuntimeSecrets(session.id, project.sensitiveVariables, secretValues);
                setSecretValues({});
                setSecretPromptOpen(false);
              } catch (error) {
                recordDiagnostic("设置敏感变量", error);
              }
            }}
          >开始演示</Button>
        ]}
      >
        <div className="runtime-secret-form">
          {project.sensitiveVariables.map((definition) => (
            <label key={definition.key}>
              <span>{definition.label}{definition.required ? "（必填）" : "（可选）"}</span>
              <Input.Password
                autoComplete="off"
                value={secretValues[definition.key] ?? ""}
                maxLength={2_000}
                onChange={(event) => setSecretValues((values) => ({ ...values, [definition.key]: event.target.value }))}
              />
              <small>{definition.description ?? `将在 ${definition.expiresAfterMinutes} 分钟后自动清除。`}</small>
            </label>
          ))}
        </div>
      </Modal>

      <aside className="audience-link" aria-label="局域网观众链接">
        <span>{audienceShare ? "局域网观众链接" : "本机观众链接"}</span>
        <code>{audienceShare?.url ?? audienceUrl}</code>
      </aside>
    </main>
  );
}
