import { describe, expect, it, vi } from "vitest";
import { sampleProject, sampleSession } from "./sample-project";
import { shutdownPresentationRuntime } from "./presentation-shutdown";

function createServices(events: string[]) {
  return {
    clearSecrets: vi.fn(() => events.push("clear-secrets")),
    clearLaunch: vi.fn(() => events.push("clear-launch")),
    publishLocalSnapshot: vi.fn(() => events.push("local-ended")),
    publishLocalBye: vi.fn(() => events.push("local-bye")),
    publishRemoteSnapshot: vi.fn(async () => { events.push("remote-ended"); }),
    stopAudience: vi.fn(async () => { events.push("stop-audience"); }),
    clearProxy: vi.fn(async () => { events.push("clear-proxy"); }),
    clearRuntime: vi.fn(async () => { events.push("clear-runtime"); }),
    sendExtension: vi.fn(async (message: Record<string, unknown>) => {
      events.push(`extension-${String(message.type)}`);
      return 1;
    })
  };
}

describe("presentation runtime shutdown", () => {
  it("publishes the ended state before stopping the audience service and clears all runtime resources", async () => {
    const events: string[] = [];
    const services = createServices(events);
    const endedSession = { ...sampleSession, screenMode: "ended" as const };

    const failures = await shutdownPresentationRuntime({
      project: sampleProject,
      session: endedSession,
      audienceSessionId: endedSession.id
    }, services);

    expect(failures).toEqual([]);
    expect(events.indexOf("remote-ended")).toBeLessThan(events.indexOf("stop-audience"));
    expect(services.clearSecrets).toHaveBeenCalledWith(endedSession.id);
    expect(services.clearLaunch).toHaveBeenCalledWith(sampleProject.id);
    expect(services.clearRuntime).toHaveBeenCalledWith(sampleProject.id);
    expect(services.clearProxy).toHaveBeenCalledWith(sampleProject.id);
    expect(services.sendExtension).toHaveBeenCalledWith(expect.objectContaining({ type: "configure-request-protection", securityMode: "interactive" }));
    expect(services.sendExtension).toHaveBeenCalledWith(expect.objectContaining({ type: "audience-share", signalUrl: "" }));
  });

  it("continues cleanup and reports failures when ending the remote audience state fails", async () => {
    const events: string[] = [];
    const services = createServices(events);
    services.publishRemoteSnapshot.mockRejectedValueOnce(new Error("network unavailable"));

    const failures = await shutdownPresentationRuntime({
      project: sampleProject,
      session: { ...sampleSession, screenMode: "ended" },
      audienceSessionId: sampleSession.id
    }, services);

    expect(failures.map((failure) => failure.area)).toContain("同步局域网观众结束状态");
    expect(services.stopAudience).toHaveBeenCalled();
    expect(services.clearRuntime).toHaveBeenCalled();
    expect(services.clearProxy).toHaveBeenCalled();
  });
});
