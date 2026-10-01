import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { browser } from "wxt/browser";
import type { Browser } from "wxt/browser";
import type { RecordedAction } from "@showit/contracts";
import { RecordedActionSchema } from "@showit/contracts";
import type { BgMessage, UiMessage } from "@/messaging/protocol";
import { PORT_PREFIX } from "@/messaging/protocol";
import { recordDiagnostic } from "@/lib/diagnostics";
import { Library } from "./Library";
import { Editor } from "./Editor";

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

  const onRecordedAction = useCallback((handler: (action: RecordedAction) => void) => {
    recordedHandlersRef.current.push(handler);
    return () => {
      recordedHandlersRef.current = recordedHandlersRef.current.filter((item) => item !== handler);
    };
  }, []);

  const projectId = route.startsWith("#/p/") ? route.slice(4) : null;

  return (
    <div className="workbench">
      {projectId ? (
        <Editor key={projectId} projectId={projectId} port={port} recorder={recorder} onRecordedAction={onRecordedAction} portReady={portReady} />
      ) : (
        <Library port={port} />
      )}
    </div>
  );
}
