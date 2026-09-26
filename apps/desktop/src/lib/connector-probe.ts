export type ExtensionProbeState =
  | { state: "loading" }
  | { state: "error"; reason: string };

type ProbeController = {
  settle: () => void;
  dispose: () => void;
};

export function startExtensionProbe(
  send: () => Promise<number>,
  onState: (state: ExtensionProbeState) => void,
  timeoutMs = 5_000
): ProbeController {
  let disposed = false;
  let settled = false;
  const timeoutId = setTimeout(() => {
    if (disposed || settled) return;
    settled = true;
    onState({ state: "error", reason: "扩展响应超时。请刷新业务页，确认 Showit 扩展已获当前站点权限。" });
  }, timeoutMs);
  onState({ state: "loading" });

  void send()
    .then((receivers) => {
      if (disposed || settled) return;
      if (receivers <= 0) {
        settled = true;
        clearTimeout(timeoutId);
        onState({ state: "error", reason: "浏览器扩展未连接。请打开已配置的业务页并启用 Showit 扩展后重试。" });
      }
    })
    .catch(() => {
      if (disposed || settled) return;
      settled = true;
      clearTimeout(timeoutId);
      onState({ state: "error", reason: "无法连接浏览器扩展。请重新启用扩展后重试。" });
    });

  return {
    settle() {
      if (disposed) return;
      settled = true;
      clearTimeout(timeoutId);
    },
    dispose() {
      disposed = true;
      clearTimeout(timeoutId);
    }
  };
}
