import { randomBytes, createHash } from "node:crypto";

/** Room management for the audience relay: tokens, join control, lifecycle. */

export type ViewerStatus = "pending" | "approved" | "connected";

export type RemoteViewer = {
  viewerId: string;
  displayName: string;
  joinedAt: number;
  status: ViewerStatus;
  peerId: string;
};

export type Room = {
  roomCode: string;
  presenterToken: string;
  viewerToken: string;
  viewerUrl: string;
  signalUrl: string;
  capacity: "p2p" | "sfu";
  createdAt: number;
  lastActiveAt: number;
  ended: boolean;
  snapshot: unknown | null;
  joinMode: "direct" | "approval";
  viewers: Map<string, RemoteViewer>;
};

export type RoomSummary = {
  roomCode: string;
  viewerUrl: string;
  /** Viewer link with the token embedded in its fragment. */
  viewerLink: string;
  signalUrl: string;
  presenterToken: string;
  capacity: "p2p" | "sfu";
  joinMode: "direct" | "approval";
};

const ROOM_CODE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const IDLE_ROOM_TTL_MS = 15 * 60 * 1_000;
const MAX_ROOMS = 64;
const MAX_VIEWERS_PER_ROOM = 20;

function randomToken(bytes = 16): string {
  return randomBytes(bytes).toString("base64url");
}

function randomRoomCode(): string {
  const alphabet = ROOM_CODE_ALPHABET;
  const bytes = randomBytes(8);
  return [...bytes].map((byte) => alphabet[byte % alphabet.length]!).join("");
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export class RoomStore {
  private rooms = new Map<string, Room>();
  private roomsByPresenterToken = new Map<string, string>();

  activeRoomCount(): number {
    return [...this.rooms.values()].filter((room) => !room.ended).length;
  }

  createRoom(options: { baseUrl: string; capacity: "p2p" | "sfu"; joinMode: "direct" | "approval" }): RoomSummary {
    if (this.rooms.size >= MAX_ROOMS) this.evictIdleRooms(new Date());
    if (this.rooms.size >= MAX_ROOMS) throw new RelayError("rooms-exhausted", "中继房间数量已达上限，请稍后重试。", 503);

    const roomCode = randomRoomCode();
    const room: Room = {
      roomCode,
      presenterToken: randomToken(24),
      viewerToken: randomToken(16),
      viewerUrl: `${options.baseUrl.replace(/\/$/, "")}/watch/${roomCode}`,
      signalUrl: "",
      capacity: options.capacity,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      ended: false,
      snapshot: null,
      joinMode: options.joinMode,
      viewers: new Map()
    };
    room.signalUrl = `${options.baseUrl.replace(/\/$/, "")}/signal/${roomCode}`;
    this.rooms.set(roomCode, room);
    this.roomsByPresenterToken.set(hashToken(room.presenterToken), roomCode);
    return this.summarize(room);
  }

  /** Resolve a room by presenter token (hashed in memory). */
  roomByPresenterToken(token: string): Room | null {
    const roomCode = this.roomsByPresenterToken.get(hashToken(token));
    if (!roomCode) return null;
    return this.rooms.get(roomCode) ?? null;
  }

  roomByCode(code: string): Room | null {
    return this.rooms.get(code) ?? null;
  }

  /** Validate a viewer token for a room; viewer links embed the raw token. */
  verifyViewerToken(code: string, token: string): Room | null {
    const room = this.rooms.get(code);
    if (!room || room.ended) return null;
    // Constant-time-ish comparison over the fixed-length random tokens.
    if (room.viewerToken.length !== token.length) return null;
    let mismatch = 0;
    for (let index = 0; index < token.length; index += 1) {
      mismatch |= room.viewerToken.charCodeAt(index) ^ token.charCodeAt(index);
    }
    return mismatch === 0 ? room : null;
  }

  registerViewer(room: Room, viewerId: string, displayName: string, peerId: string): RemoteViewer | { error: string } {
    if (room.ended) return { error: "房间已结束。" };
    const existing = room.viewers.get(viewerId);
    if (existing) {
      existing.status = "connected";
      existing.peerId = peerId;
      room.lastActiveAt = Date.now();
      return existing;
    }
    if (room.viewers.size >= MAX_VIEWERS_PER_ROOM) return { error: `观众数量已达上限（${MAX_VIEWERS_PER_ROOM}）。` };
    if (room.joinMode === "approval") {
      const viewer: RemoteViewer = { viewerId, displayName: displayName.slice(0, 40), joinedAt: Date.now(), status: "pending", peerId };
      room.viewers.set(viewerId, viewer);
      room.lastActiveAt = Date.now();
      return viewer;
    }
    const viewer: RemoteViewer = { viewerId, displayName: displayName.slice(0, 40), joinedAt: Date.now(), status: "approved", peerId };
    room.viewers.set(viewerId, viewer);
    room.lastActiveAt = Date.now();
    return viewer;
  }

  decideViewer(room: Room, viewerId: string, approve: boolean): boolean {
    const viewer = room.viewers.get(viewerId);
    if (!viewer || viewer.status !== "pending") return false;
    if (!approve) {
      room.viewers.delete(viewerId);
      return true;
    }
    viewer.status = "approved";
    room.lastActiveAt = Date.now();
    return true;
  }

  markViewerConnected(room: Room, peerId: string): void {
    for (const viewer of room.viewers.values()) {
      if (viewer.peerId === peerId) {
        viewer.status = "connected";
        room.lastActiveAt = Date.now();
        return;
      }
    }
  }

  removeViewerByPeerId(room: Room, peerId: string): void {
    for (const [viewerId, viewer] of room.viewers.entries()) {
      if (viewer.peerId === peerId) {
        room.viewers.delete(viewerId);
        return;
      }
    }
  }

  kickViewer(room: Room, viewerId: string): boolean {
    return room.viewers.delete(viewerId);
  }

  endRoom(room: Room): void {
    room.ended = true;
    room.viewers.clear();
    room.snapshot = null;
    this.rooms.delete(room.roomCode);
    this.roomsByPresenterToken.delete(hashToken(room.presenterToken));
  }

  touch(room: Room, at = new Date()): void {
    room.lastActiveAt = at.getTime();
  }

  evictIdleRooms(now: Date): number {
    let evicted = 0;
    const threshold = now.getTime() - IDLE_ROOM_TTL_MS;
    for (const [code, room] of this.rooms.entries()) {
      if (room.lastActiveAt < threshold) {
        this.rooms.delete(code);
        this.roomsByPresenterToken.delete(hashToken(room.presenterToken));
        evicted += 1;
      }
    }
    return evicted;
  }

  summarize(room: Room): RoomSummary {
    return {
      roomCode: room.roomCode,
      viewerUrl: room.viewerUrl,
      viewerLink: `${room.viewerUrl}#t=${room.viewerToken}`,
      signalUrl: room.signalUrl,
      presenterToken: room.presenterToken,
      capacity: room.capacity,
      joinMode: room.joinMode
    };
  }

  viewerList(room: Room): Array<{ viewerId: string; displayName: string; status: ViewerStatus; joinedAt: number }> {
    return [...room.viewers.values()].map((viewer) => ({
      viewerId: viewer.viewerId,
      displayName: viewer.displayName,
      status: viewer.status,
      joinedAt: viewer.joinedAt
    }));
  }
}

export class RelayError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message);
    this.name = "RelayError";
  }
}
