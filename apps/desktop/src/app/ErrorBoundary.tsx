import { Component, type ErrorInfo, type ReactNode } from "react";
import { recordDiagnostic } from "../lib/diagnostics";

type Props = {
  children: ReactNode;
};

type State = {
  error: Error | null;
  traceId: string | null;
};

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null, traceId: null };

  static getDerivedStateFromError(error: Error): State {
    return { error, traceId: null };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    const traceId = recordDiagnostic("React 运行时", error);
    this.setState({ traceId });
    console.error("showit-runtime-error", {
      message: error.message,
      stack: error.stack,
      componentStack: info.componentStack
    });
  }

  override render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <main className="fatal-screen" role="alert">
        <strong>运行时异常</strong>
        <span>演示外壳已停止渲染。请刷新或查看本机日志。</span>
        <code>{this.state.traceId ? `错误追踪 ID：${this.state.traceId}` : this.state.error.message}</code>
      </main>
    );
  }
}
