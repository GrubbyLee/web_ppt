import "@ant-design/v5-patch-for-react-19";
import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AppRouter } from "./app/App";
import { ErrorBoundary } from "./app/ErrorBoundary";
import { recordDiagnostic } from "./lib/diagnostics";
import "./styles/tokens.css";
import "./styles/runtime.css";
import "antd/dist/reset.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1
    }
  }
});

window.addEventListener("error", (event) => { recordDiagnostic("浏览器未处理错误", event.error ?? event.message); });
window.addEventListener("unhandledrejection", (event) => { recordDiagnostic("未处理 Promise", event.reason); });

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <AppRouter />
      </QueryClientProvider>
    </ErrorBoundary>
  </React.StrictMode>
);
