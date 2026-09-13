import { AudienceEventSchema, type AudienceEvent, type PresentationSession, type Project } from "@showit/contracts";

const storageKey = (sessionId: string) => `showit:audience:${sessionId}`;
const channelName = (sessionId: string) => `showit:audience:${sessionId}`;
const snapshotCacheLimit = 1_500_000;

function nonce(): string {
  return `${Date.now().toString(36)}-${crypto.getRandomValues(new Uint32Array(2)).join("-")}`;
}

export function publishSnapshot(project: Project, session: PresentationSession): void {
  const event = {
    type: "snapshot" as const,
    sessionId: session.id,
    seq: session.sequence,
    nonce: nonce(),
    at: Date.now(),
    project,
    session
  };
  let cached = false;
  try {
    const serialized = JSON.stringify(event);
    if (serialized.length <= snapshotCacheLimit) {
      localStorage.setItem(storageKey(session.id), serialized);
      cached = true;
    }
  } catch {
    // A live BroadcastChannel snapshot is still available when browser cache is full.
  }
  const channel = new BroadcastChannel(channelName(session.id));
  channel.postMessage(event);
  channel.close();
  if (cached) localStorage.removeItem(storageKey(session.id));
}

export function canCacheAudienceSnapshot(value: unknown): boolean {
  try {
    return JSON.stringify(value).length <= snapshotCacheLimit;
  } catch {
    return false;
  }
}

export function publishBye(session: PresentationSession): void {
  const event = {
    type: "bye" as const,
    sessionId: session.id,
    seq: session.sequence,
    nonce: nonce(),
    at: Date.now()
  };
  const channel = new BroadcastChannel(channelName(session.id));
  channel.postMessage(event);
  channel.close();
}

export function readSnapshot(sessionId: string): { project: Project; session: PresentationSession } | null {
  try {
    const parsed = AudienceEventSchema.safeParse(JSON.parse(localStorage.getItem(storageKey(sessionId)) ?? "null"));
    return parsed.success && parsed.data.type === "snapshot"
      ? { project: parsed.data.project, session: parsed.data.session }
      : null;
  } catch {
    return null;
  }
}

export function createAudienceChannel(
  sessionId: string,
  onSnapshot: (snapshot: { project: Project; session: PresentationSession }) => void,
  onReady: () => void,
  onBye: () => void = () => undefined
): BroadcastChannel {
  const channel = new BroadcastChannel(channelName(sessionId));
  const accepts = createAudienceEventGuard(sessionId);
  channel.onmessage = (event: MessageEvent<unknown>) => {
    const parsed = AudienceEventSchema.safeParse(event.data);
    if (!parsed.success || !accepts(parsed.data)) return;
    if (parsed.data.type === "snapshot") onSnapshot({ project: parsed.data.project, session: parsed.data.session });
    if (parsed.data.type === "ready") onReady();
    if (parsed.data.type === "bye") onBye();
  };
  return channel;
}

export function createAudienceEventGuard(sessionId: string): (event: AudienceEvent) => boolean {
  const seenNonces = new Set<string>();
  let lastSequence = -1;
  return (event) => {
    if (event.sessionId !== sessionId || seenNonces.has(event.nonce)) return false;
    seenNonces.add(event.nonce);
    if (seenNonces.size > 256) seenNonces.delete(seenNonces.values().next().value!);
    if (event.type === "snapshot" || event.type === "laser") {
      if (event.seq <= lastSequence) return false;
      lastSequence = event.seq;
    }
    return true;
  };
}

export function announceAudienceReady(channel: BroadcastChannel, session: PresentationSession): void {
  channel.postMessage({
    type: "ready",
    sessionId: session.id,
    seq: session.sequence,
    nonce: nonce(),
    at: Date.now()
  });
}
