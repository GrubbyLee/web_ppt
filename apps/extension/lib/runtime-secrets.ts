import type { SensitiveRuntimeVariable } from "@showit/contracts";

type RuntimeSecret = {
  value: string;
  expiresAt: number;
};

const secretsBySession = new Map<string, Map<string, RuntimeSecret>>();

function wipe(secret: RuntimeSecret): void {
  secret.value = "";
  secret.expiresAt = 0;
}

export function setRuntimeSecrets(
  sessionId: string,
  definitions: SensitiveRuntimeVariable[],
  values: Record<string, string>,
  now = Date.now()
): void {
  clearRuntimeSecrets(sessionId);
  const secrets = new Map<string, RuntimeSecret>();
  for (const definition of definitions) {
    const value = values[definition.key] ?? "";
    if (!value && !definition.required) continue;
    if (!value) throw new Error(`敏感变量“${definition.label}”不能为空。`);
    secrets.set(definition.key, {
      value,
      expiresAt: now + definition.expiresAfterMinutes * 60_000
    });
  }
  if (secrets.size > 0) secretsBySession.set(sessionId, secrets);
}

export function getRuntimeSecret(sessionId: string, key: string, now = Date.now()): string | null {
  const secrets = secretsBySession.get(sessionId);
  const secret = secrets?.get(key);
  if (!secrets || !secret) return null;
  if (secret.expiresAt <= now) {
    wipe(secret);
    secrets.delete(key);
    if (secrets.size === 0) secretsBySession.delete(sessionId);
    return null;
  }
  return secret.value;
}

export function missingRuntimeSecrets(
  sessionId: string,
  definitions: SensitiveRuntimeVariable[],
  now = Date.now()
): SensitiveRuntimeVariable[] {
  return definitions.filter((definition) => definition.required && getRuntimeSecret(sessionId, definition.key, now) === null);
}

export function clearRuntimeSecrets(sessionId?: string): void {
  const sessionIds = sessionId ? [sessionId] : [...secretsBySession.keys()];
  for (const id of sessionIds) {
    const secrets = secretsBySession.get(id);
    if (!secrets) continue;
    for (const secret of secrets.values()) wipe(secret);
    secrets.clear();
    secretsBySession.delete(id);
  }
}

export function hasRuntimeSecretSession(sessionId: string): boolean {
  return secretsBySession.has(sessionId);
}
