import type { PresentationConnector } from "@showit/contracts";

export type ConnectorSessionState =
  | { state: "ready"; role: string }
  | { state: "anonymous"; reason: string }
  | { state: "role-mismatch"; role: string; reason: string }
  | { state: "error"; reason: string };

function nestedValue(value: unknown, path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

export function supportsConnectorSessionProbe(connector: PresentationConnector | undefined): boolean {
  return Boolean(connector?.sessionProbe);
}

export async function probeConnectorSession(
  frameUrl: string,
  presentationRole: string,
  connector: PresentationConnector,
  fetcher: typeof fetch = fetch,
  timeoutMs = 4_000
): Promise<ConnectorSessionState> {
  const probe = connector.sessionProbe;
  if (!probe) return { state: "ready", role: "unknown" };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = new URL(probe.path, frameUrl);
    const response = await fetcher(url, { method: "GET", credentials: "include", cache: "no-store", signal: controller.signal });
    if (!response.ok) return { state: "error", reason: `会话检查失败（HTTP ${response.status}）。请确认业务服务可用后刷新。` };
    const user = nestedValue(await response.json(), probe.userPath);
    if (!user || typeof user !== "object") return { state: "anonymous", reason: `请先登录“${presentationRole}”对应的业务账号，然后刷新业务页。` };
    const record = user as Record<string, unknown>;
    const primaryRoleValue = record[probe.primaryRoleField];
    const primaryRole = typeof primaryRoleValue === "string" ? primaryRoleValue : "unknown";
    const secondaryRoleValues = record[probe.rolesField];
    const secondaryRoles = Array.isArray(secondaryRoleValues)
      ? secondaryRoleValues.filter((item: unknown): item is string => typeof item === "string")
      : [];
    const roles = new Set([primaryRole, ...secondaryRoles]);
    const expected = probe.roleMappings.find((mapping) => mapping.presentationRole === presentationRole)?.connectorRole;
    if (!expected || roles.has(expected)) return { state: "ready", role: primaryRole };
    return { state: "role-mismatch", role: primaryRole, reason: `当前业务角色为 ${primaryRole}，需要切换至“${presentationRole}”对应账号。` };
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === "AbortError";
    return { state: "error", reason: timedOut ? "会话检查超时。请确认业务服务可用后重试。" : "无法读取业务会话状态。请确认连接器和业务服务已启动。" };
  } finally {
    clearTimeout(timeout);
  }
}
