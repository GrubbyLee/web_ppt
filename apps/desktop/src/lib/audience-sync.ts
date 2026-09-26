import { AudienceEventSchema, type AudienceEvent, type LaserPoint, type PresentationSession, type Project } from "@showit/contracts";

const channelName = (sessionId: string) => `showit:audience:${sessionId}`;

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
  const channel = new BroadcastChannel(channelName(session.id));
  channel.postMessage(event);
  channel.close();
}

// Returns undefined when the change is more than a laser move (a full snapshot
// must be published), the moved laser point, or null when the laser cleared.
export function laserOnlyChange(previous: PresentationSession, next: PresentationSession): LaserPoint | null | undefined {
  if (previous.laser === next.laser) return undefined;
  for (const key of Object.keys(next) as Array<keyof PresentationSession>) {
    if (key === "laser" || key === "sequence") continue;
    if (previous[key] !== next[key]) return undefined;
  }
  return next.laser;
}

// Laser moves arrive at up to ~30 Hz; publish the tiny delta instead of
// cloning the whole project for every throttled pointer sample.
export function publishLaser(session: PresentationSession, laser: LaserPoint | null): void {
  const event = {
    type: "laser" as const,
    sessionId: session.id,
    seq: session.sequence,
    nonce: nonce(),
    at: Date.now(),
    laser
  };
  const channel = new BroadcastChannel(channelName(session.id));
  channel.postMessage(event);
  channel.close();
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

export function createAudienceChannel(
  sessionId: string,
  onSnapshot: (snapshot: { project: Project; session: PresentationSession }) => void,
  onReady: () => void,
  onBye: () => void = () => undefined,
  onLaser: (laser: LaserPoint | null) => void = () => undefined
): BroadcastChannel {
  const channel = new BroadcastChannel(channelName(sessionId));
  const accepts = createAudienceEventGuard(sessionId);
  channel.onmessage = (event: MessageEvent<unknown>) => {
    const parsed = AudienceEventSchema.safeParse(event.data);
    if (!parsed.success || !accepts(parsed.data)) return;
    if (parsed.data.type === "snapshot") onSnapshot({ project: parsed.data.project, session: parsed.data.session });
    if (parsed.data.type === "laser") onLaser(parsed.data.laser);
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

export function announceAudienceReady(channel: BroadcastChannel, session: Pick<PresentationSession, "id" | "sequence">): void {
  channel.postMessage({
    type: "ready",
    sessionId: session.id,
    seq: session.sequence,
    nonce: nonce(),
    at: Date.now()
  });
}
