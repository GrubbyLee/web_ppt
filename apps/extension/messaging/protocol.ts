import type { RecordedAction, PresentationSession } from "@showit/contracts";
import type { MachineState, SessionAction } from "../session/machine";

/** Port names: `showit:<ctx>` — every extension context connects to the
 *  background with one long-lived port and receives broadcasts on it. */
export type UiContext = "sidepanel" | "workbench" | "audience" | "stage" | "offscreen" | "demo";

export type ConnectorRuntimeState = {
  state: "ready" | "blocked" | "error" | "anonymous" | "role-mismatch";
  reason?: string | undefined;
  role?: string | undefined;
};

export type StepExecutionStatus = {
  stepId: string;
  state: "running" | "failed" | "manual";
  reason?: string | undefined;
};

export type DemoMutationState = Array<{ kind: "publish" | "offline" | "approve" | "quota"; assetId?: string; approvalId?: string; value?: number }>;

export type BroadcastMeta = {
  running: boolean;
  live: boolean;
  sessionTabId: number | null;
  tabKind: "business" | "stage" | "demo" | null;
  tabStatus: "loading" | "complete" | "error" | null;
  tabUnsafeOrigin: boolean;
  businessReady: boolean;
  connectorState: ConnectorRuntimeState | null;
  stepExecution: StepExecutionStatus | null;
  missingSecrets: string[];
  recorderActive: boolean;
  captureActive: boolean;
  viewerCount: number;
  offlineOriginRequest: string | null;
  message: string | null;
  demoMutations: DemoMutationState;
};

export type BroadcastState = {
  machine: MachineState;
  meta: BroadcastMeta;
};

// ---- UI → background ---------------------------------------------------------

export type UiMessage =
  | { type: "hello"; ctx: UiContext; viewerId?: string }
  | { type: "action"; action: SessionAction }
  | { type: "tick"; uiBlocked: boolean }
  | { type: "begin"; projectId: string }
  | { type: "resume" }
  | { type: "end-session" }
  | { type: "secrets"; values: Record<string, string> }
  | { type: "execute-step"; stepId: string; confirmed?: boolean }
  | { type: "pick-mask" }
  | { type: "cancel-mask-pick" }
  | { type: "open-audience" }
  | { type: "authorize-capture" }
  | { type: "stage-laser"; laser: PresentationSession["laser"] }
  | { type: "demo-connector-state"; state: "ready" | "anonymous" }
  | { type: "demo-mutation"; mutation: { kind: "publish" | "offline" | "approve" | "quota"; assetId?: string; approvalId?: string; value?: number } }
  | { type: "open-workbench" }
  | { type: "recorder-start"; recordingId: string }
  | { type: "recorder-stop"; recordingId: string }
  | { type: "rtc-signal"; to: string; from: string; data: unknown }
  | { type: "viewer-status"; viewerId: string; status: "connected" | "failed" | "closed" }
  | { type: "capture-state"; active: boolean; error?: string | undefined }
  | { type: "stage-offline-origin-request"; origin: string };

// ---- background → UI ---------------------------------------------------------

export type BgMessage =
  | { type: "state"; state: BroadcastState }
  | { type: "laser"; laser: PresentationSession["laser"] }
  | { type: "origin-authorization-required"; origin: string | null; reason?: string }
  | { type: "capture-start"; streamId: string; tabId: number }
  | { type: "capture-stop" }
  | { type: "viewer-added"; viewerId: string }
  | { type: "viewer-removed"; viewerId: string }
  | { type: "rtc-signal"; to: string; from: string; data: unknown }
  | { type: "recorder-state"; active: boolean; reason?: string | undefined; pageTitle?: string | undefined; origin?: string | undefined }
  | { type: "recorded-action"; recordingId: string; action: RecordedAction }
  | { type: "error"; message: string };

// ---- background ↔ content script (tabs.sendMessage) --------------------------

export type TabMessage =
  | { type: "showit-probe" }
  | { type: "showit-recorder-start"; recordingId: string }
  | { type: "showit-recorder-stop" }
  | { type: "showit-execute-action"; action: Record<string, unknown>; execution: string }
  | { type: "showit-check-condition"; condition: Record<string, unknown> }
  | { type: "showit-pick-privacy-mask" }
  | { type: "showit-cancel-privacy-mask" }
  | { type: "showit-resolve-privacy-masks"; items: Array<{ id: string; locator: Record<string, unknown> }> }
  | { type: "showit-session-probe"; sessionId: string; connector: Record<string, unknown>; role: string }
  | { type: "showit-overlay"; overlay: OverlayState };

export type OverlayState = {
  sessionId: string;
  pageId: string;
  screenMode: PresentationSession["screenMode"];
  annotationTool: PresentationSession["annotationTool"];
  circles: PresentationSession["circles"];
  privacyMasks: Array<{ id: string; x1: number; y1: number; x2: number; y2: number; mode: string }>;
  offlineActive: boolean;
  brand: { primaryColor: string; privacyMessage: string };
};

export type TabResponseMap = {
  "showit-probe": { origin: string; title: string; hasPasswordField: boolean; privacyRisk: string | null };
  "showit-recorder-start": { ok: boolean; url: string; title: string };
  "showit-recorder-stop": { ok: boolean };
  "showit-execute-action": { ok: boolean; performed?: string; reason?: string };
  "showit-check-condition": { ok: boolean; url: string; title: string };
  "showit-pick-privacy-mask": { ok: boolean; locator?: Record<string, unknown>; bounds?: Record<string, number>; reason?: string };
  "showit-cancel-privacy-mask": { ok: boolean };
  "showit-resolve-privacy-masks": { ok: boolean; resolved: Array<{ id: string; bounds: Record<string, number> }>; missing: string[] };
  "showit-session-probe": { state: "ready" | "anonymous" | "role-mismatch" | "error"; role?: string; reason?: string };
  "showit-overlay": { ok: boolean };
};

// ---- content script → background (runtime.sendMessage) ------------------------

export type ContentUpstream =
  | { type: "showit-privacy-risk"; origin: string; privacyRisk: string }
  | { type: "showit-resource-failures"; origin: string; count: number }
  | { type: "showit-recorded-action"; recordingId: string; action: RecordedAction }
  | { type: "showit-circle-added"; sessionId: string; circle: { id: string; x1: number; y1: number; x2: number; y2: number } }
  | { type: "business-page-message"; origin: string; title: string; payload: { type: string; state: string; role?: string } }
  | { type: "showit-session-probe-result"; sessionId: string; state: string; role?: string; reason?: string };

export const PORT_PREFIX = "showit:";
