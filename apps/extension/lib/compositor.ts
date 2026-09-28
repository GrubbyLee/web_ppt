const screenModes = new Set(["normal", "black", "white", "frozen", "privacy", "ended"]);

export type AudienceMaskLike = {
  x1?: unknown;
  y1?: unknown;
  x2?: unknown;
  y2?: unknown;
  mode?: unknown;
};

export type CompositorState = {
  screenMode?: string | undefined;
  offlineFallbackActive?: boolean;
  privacyMasks?: unknown;
};

function clamp(value: number): number {
  return Math.max(0, Math.min(1, Number(value)));
}

export function sanitizeAudienceMasks(value: unknown): Array<{ x1: number; y1: number; x2: number; y2: number; mode: "blur" | "solid" }> {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 30).flatMap((mask) => {
    if (!mask || typeof mask !== "object") return [];
    const candidate = mask as AudienceMaskLike;
    const coordinates = [candidate.x1, candidate.y1, candidate.x2, candidate.y2];
    if (coordinates.some((coordinate) => typeof coordinate !== "number" || !Number.isFinite(coordinate))) return [];
    return [{
      x1: clamp(candidate.x1 as number),
      y1: clamp(candidate.y1 as number),
      x2: clamp(candidate.x2 as number),
      y2: clamp(candidate.y2 as number),
      mode: candidate.mode === "blur" ? "blur" as const : "solid" as const
    }];
  });
}

export function resolveAudienceFrameMode(state: CompositorState | null | undefined): "normal" | "black" | "white" | "frozen" | "privacy" | "ended" {
  if (state?.offlineFallbackActive) return "privacy";
  return screenModes.has(state?.screenMode ?? "") ? state?.screenMode as CompositorState["screenMode"] as "normal" | "black" | "white" | "frozen" | "privacy" | "ended" : "privacy";
}

function paintCover(context: CanvasRenderingContext2D, mode: string, width: number, height: number): void {
  context.filter = "none";
  context.fillStyle = mode === "white" ? "#ffffff" : mode === "black" ? "#050607" : "#172533";
  context.fillRect(0, 0, width, height);
}

function paintMasks(context: CanvasRenderingContext2D, video: HTMLVideoElement, masks: unknown, width: number, height: number): void {
  for (const mask of sanitizeAudienceMasks(masks)) {
    const x = Math.min(mask.x1, mask.x2) * width;
    const y = Math.min(mask.y1, mask.y2) * height;
    const maskWidth = Math.abs(mask.x2 - mask.x1) * width;
    const maskHeight = Math.abs(mask.y2 - mask.y1) * height;
    if (maskWidth < 1 || maskHeight < 1) continue;
    if (mask.mode === "blur") {
      context.save();
      context.beginPath();
      context.rect(x, y, maskWidth, maskHeight);
      context.clip();
      context.filter = "blur(18px)";
      context.drawImage(video, 0, 0, width, height);
      context.restore();
      context.fillStyle = "rgb(10 15 20 / 45%)";
    } else {
      context.fillStyle = "#111820";
    }
    context.fillRect(x, y, maskWidth, maskHeight);
  }
}

export function createAudienceCompositor(
  sourceStream: MediaStream,
  readState: () => CompositorState | null | undefined,
  documentRef: Document = document
): { stream: MediaStream; stop(): void } {
  const sourceTrack = sourceStream.getVideoTracks()[0];
  if (!sourceTrack) throw new Error("没有可合成的视频轨道。");
  const settings = sourceTrack.getSettings();
  const canvas = documentRef.createElement("canvas");
  canvas.width = Math.max(1, Number(settings.width) || 1280);
  canvas.height = Math.max(1, Number(settings.height) || 720);
  const frozen = documentRef.createElement("canvas");
  frozen.width = canvas.width;
  frozen.height = canvas.height;
  const context = canvas.getContext("2d", { alpha: false });
  const frozenContext = frozen.getContext("2d", { alpha: false });
  if (!context || !frozenContext || typeof canvas.captureStream !== "function") throw new Error("当前浏览器不支持安全画面合成。");

  const video = documentRef.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.srcObject = sourceStream;
  void video.play().catch(() => undefined);

  let previousMode = "privacy";
  let stopped = false;
  const render = () => {
    if (stopped) return;
    const state = readState?.() ?? {};
    const mode = resolveAudienceFrameMode(state);
    const width = Math.max(1, Number(video.videoWidth) || canvas.width);
    const height = Math.max(1, Number(video.videoHeight) || canvas.height);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
      frozen.width = width;
      frozen.height = height;
      previousMode = "privacy";
    }

    if (mode === "frozen") {
      if (previousMode !== "frozen") frozenContext.drawImage(canvas, 0, 0, width, height);
      context.drawImage(frozen, 0, 0, width, height);
    } else if (mode === "normal" && video.readyState >= 2) {
      context.filter = "none";
      context.drawImage(video, 0, 0, width, height);
      paintMasks(context, video, state?.privacyMasks, width, height);
    } else {
      paintCover(context, mode, width, height);
    }
    previousMode = mode;
  };
  render();
  const timer = setInterval(render, 1000 / 30);
  const stream = canvas.captureStream(30);
  const outputTrack = stream.getVideoTracks()[0];
  if (outputTrack) outputTrack.contentHint = "detail";

  return {
    stream,
    stop() {
      stopped = true;
      clearInterval(timer);
      video.pause();
      video.srcObject = null;
      stream.getTracks().forEach((track) => track.stop());
    }
  };
}
