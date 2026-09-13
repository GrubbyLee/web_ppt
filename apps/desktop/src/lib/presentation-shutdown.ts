import type { PresentationSession, Project } from "@showit/contracts";
import { publishBye, publishSnapshot } from "./audience-sync";
import { clearPresentationLaunch } from "./presentation-launch";
import { clearReadonlyProxy, clearRuntimeSession, publishAudienceSession, sendExtensionMessage, stopAudienceSession } from "./persistence";
import { clearRuntimeSecrets } from "./runtime-secrets";

type ShutdownInput = {
  project: Project;
  session: PresentationSession;
  audienceSessionId: string | null;
};

type ShutdownFailure = {
  area: string;
  error: unknown;
};

type ShutdownServices = {
  clearSecrets: (sessionId: string) => void;
  clearLaunch: (projectId: string) => void;
  publishLocalSnapshot: (project: Project, session: PresentationSession) => void;
  publishLocalBye: (session: PresentationSession) => void;
  publishRemoteSnapshot: (project: Project, session: PresentationSession) => Promise<void>;
  stopAudience: (sessionId: string) => Promise<void>;
  clearProxy: (projectId: string) => Promise<void>;
  clearRuntime: (projectId: string) => Promise<void>;
  sendExtension: (message: Record<string, unknown>) => Promise<number>;
};

const defaultServices: ShutdownServices = {
  clearSecrets: clearRuntimeSecrets,
  clearLaunch: clearPresentationLaunch,
  publishLocalSnapshot: publishSnapshot,
  publishLocalBye: publishBye,
  publishRemoteSnapshot: publishAudienceSession,
  stopAudience: stopAudienceSession,
  clearProxy: clearReadonlyProxy,
  clearRuntime: clearRuntimeSession,
  sendExtension: sendExtensionMessage
};

async function attempt(area: string, action: () => void | Promise<unknown>, failures: ShutdownFailure[]): Promise<void> {
  try {
    await action();
  } catch (error) {
    failures.push({ area, error });
  }
}

export async function shutdownPresentationRuntime(
  input: ShutdownInput,
  services: ShutdownServices = defaultServices
): Promise<ShutdownFailure[]> {
  const failures: ShutdownFailure[] = [];
  await attempt("清除运行时敏感变量", () => services.clearSecrets(input.session.id), failures);
  await attempt("清除浏览器运行快照", () => services.clearLaunch(input.project.id), failures);

  await attempt("同步本机观众结束状态", () => services.publishLocalSnapshot(input.project, input.session), failures);
  if (input.audienceSessionId) {
    await attempt("同步局域网观众结束状态", () => services.publishRemoteSnapshot(input.project, input.session), failures);
  }
  await attempt("关闭本机观众会话", () => services.publishLocalBye(input.session), failures);

  await Promise.all([
    attempt("关闭扩展请求保护", () => services.sendExtension({
      type: "configure-request-protection",
      sessionId: input.session.id,
      origin: "",
      securityMode: "interactive",
      loginPaths: [],
      logoutPaths: []
    }), failures),
    attempt("停止扩展观众投送", () => services.sendExtension({
      type: "audience-share",
      sessionId: input.session.id,
      signalUrl: "",
      deliveryMode: "p2p",
      sfuUrl: "",
      sfuToken: ""
    }), failures),
    attempt("取消扩展遮罩选择", () => services.sendExtension({
      type: "cancel-privacy-mask-picker",
      sessionId: input.session.id
    }), failures),
    attempt("停止局域网观众服务", () => input.audienceSessionId ? services.stopAudience(input.audienceSessionId) : undefined, failures),
    attempt("关闭只读代理", () => services.clearProxy(input.project.id), failures),
    attempt("清除运行恢复快照", () => services.clearRuntime(input.project.id), failures)
  ]);

  return failures;
}
