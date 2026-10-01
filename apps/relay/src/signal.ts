/** Signal message validation: the relay forwards envelopes it can parse and
 *  rejects everything else (size limits, unknown types, malformed shapes). */

export const MAX_SIGNAL_BYTES = 128 * 1_024;

export type SignalEnvelope = {
  type: "join" | "offer" | "answer" | "ice" | "leave" | "preference";
  to?: string;
  from: string;
  displayName?: string;
  description?: { type: string; sdp: string };
  candidate?: unknown;
  mode?: string;
};

const TYPES = new Set(["join", "offer", "answer", "ice", "leave", "preference"]);

function boundedText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

export function sanitizeSignalMessage(value: unknown): SignalEnvelope | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (!boundedText(candidate.type, 16) || !TYPES.has(candidate.type)) return null;
  if (!boundedText(candidate.from, 64)) return null;
  if (candidate.to !== undefined && !boundedText(candidate.to, 64)) return null;
  if (candidate.displayName !== undefined && !boundedText(candidate.displayName, 40)) return null;
  const envelope: SignalEnvelope = { type: candidate.type as SignalEnvelope["type"], from: candidate.from };
  if (candidate.to !== undefined) envelope.to = candidate.to;
  if (candidate.displayName !== undefined) envelope.displayName = candidate.displayName;

  if (candidate.type === "offer" || candidate.type === "answer") {
    const description = candidate.description as { type?: unknown; sdp?: unknown } | undefined;
    if (!description || typeof description !== "object") return null;
    if (typeof description.sdp !== "string" || description.sdp.length === 0) return null;
    if (description.sdp.length > MAX_SIGNAL_BYTES) return null;
    envelope.description = { type: String(description.type ?? candidate.type), sdp: description.sdp };
  }

  if (candidate.type === "ice") {
    if (candidate.candidate === undefined || candidate.candidate === null) return null;
    envelope.candidate = candidate.candidate;
  }

  if (candidate.type === "preference") {
    if (candidate.mode !== undefined && candidate.mode !== "low" && candidate.mode !== "high") return null;
    if (candidate.mode !== undefined) envelope.mode = candidate.mode;
  }

  return envelope;
}
