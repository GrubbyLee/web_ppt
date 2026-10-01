import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AdminControlsView,
  AdminView,
  ApprovalsView,
  LoginView,
  MarketplaceView,
  OperationsView,
  OverviewView,
  PortalView,
  RegistryView,
  StudioDetailsView,
  StudioView,
  SubscriptionsView,
  demoNav,
  type DemoView
} from "./views";
import { applyDemoMutation, readDemoSession, writeDemoSession, type DemoMutation, type DemoSession } from "./data";
import type { BroadcastState } from "@/messaging/protocol";

type DemoConsoleProps = {
  /** Interactive mode: full app with hash routing and the login gate. */
  mode: "interactive";
  onSessionChange?: (session: DemoSession | null) => void;
  onMutation?: (mutation: DemoMutation) => void;
} | {
  /** Mirror mode: read-only rendering of one view (audience window).
   *  `state` supplies replicated demo mutations from the session broadcast. */
  mode: "mirror";
  view: DemoView;
  state?: BroadcastState | null;
};

const viewTitles: Record<DemoView, string> = {
  login: "登录",
  overview: "平台指挥台",
  portal: "能力门户",
  marketplace: "能力市场",
  subscriptions: "订阅中心",
  studio: "能力工作室",
  "studio-details": "资产详情",
  registry: "资产目录",
  approvals: "审批队列",
  operations: "运行洞察",
  admin: "用户与组织",
  "admin-controls": "权限与流程"
};

function parseHash(): DemoView {
  const raw = window.location.hash.replace(/^#\/?/, "");
  const known = new Set(demoNav.flatMap((group) => group.items.map((item) => item.view)));
  return known.has(raw as DemoView) ? raw as DemoView : "overview";
}

export function DemoConsole(props: DemoConsoleProps) {
  const [hashView, setHashView] = useState<DemoView>(() => parseHash());
  const [session, setSession] = useState<DemoSession | null>(() => readDemoSession());
  const [intended, setIntended] = useState<DemoView>("overview");
  const [, forceRender] = useState(0);

  // Mirror mode: apply replicated mutations from every state broadcast so
  // published/approved changes made in the session tab render here too.
  // applyDemoMutation mutates module state *outside* React, so the mirror has
  // to re-render explicitly — otherwise the replicated change only shows up on
  // the next broadcast, which may never arrive (approval stuck at 待审批).
  useEffect(() => {
    if (props.mode !== "mirror" || !props.state) return;
    for (const mutation of props.state.meta.demoMutations) applyDemoMutation(mutation as DemoMutation);
    forceRender((value) => value + 1);
  }, [props]);

  useEffect(() => {
    if (props.mode !== "interactive") return;
    const onHashChange = () => setHashView(parseHash());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, [props.mode]);

  const navigate = useCallback((view: DemoView) => {
    window.location.hash = `#/${view}`;
  }, []);

  const handleLogin = useCallback((next: DemoSession) => {
    writeDemoSession(next);
    setSession(next);
    props.mode === "interactive" && props.onSessionChange?.(next);
    navigate(intended);
  }, [intended, navigate, props]);

  const handleLogout = useCallback(() => {
    writeDemoSession(null);
    setSession(null);
    props.mode === "interactive" && props.onSessionChange?.(null);
    setIntended("overview");
    navigate("login" as DemoView);
  }, [navigate, props]);

  const bumpMutations = useCallback((mutation: DemoMutation | undefined) => {
    forceRender((value) => value + 1);
    if (props.mode === "interactive" && mutation) props.onMutation?.(mutation);
  }, [props]);

  const activeView: DemoView = props.mode === "mirror"
    ? props.view
    : session
      ? hashView
      : ("login" as DemoView);

  useEffect(() => {
    // Track where the presenter wanted to go so login returns there.
    if (props.mode === "interactive" && !session && hashView !== ("login" as DemoView)) {
      setIntended(hashView);
    }
  }, [hashView, props.mode, session]);

  const body = useMemo(() => {
    switch (activeView) {
      case "login":
        return props.mode === "interactive"
          ? <LoginView onLogin={handleLogin} />
          : <OverviewView />;
      case "overview":
        return <OverviewView />;
      case "portal":
        return <PortalView />;
      case "marketplace":
        return <MarketplaceView />;
      case "subscriptions":
        return <SubscriptionsView />;
      case "studio":
        return <StudioView />;
      case "studio-details":
        return <StudioDetailsView />;
      case "registry":
        return <RegistryView onRefresh={props.mode === "interactive" ? () => bumpMutations(undefined) : undefined} onMutate={props.mode === "interactive" ? (mutation) => bumpMutations(mutation) : undefined} />;
      case "approvals":
        return <ApprovalsView onRefresh={props.mode === "interactive" ? () => bumpMutations(undefined) : undefined} onMutate={props.mode === "interactive" ? (mutation) => bumpMutations(mutation) : undefined} />;
      case "operations":
        return <OperationsView />;
      case "admin":
        return <AdminView />;
      case "admin-controls":
        return <AdminControlsView />;
      default:
        return <OverviewView />;
    }
  }, [activeView, bumpMutations, handleLogin, props.mode]);

  if (activeView === "login" && props.mode === "interactive") {
    return <div className="demo-app demo-app--login">{body}</div>;
  }

  return (
    <div className="demo-app">
      <aside className="demo-side">
        <div className="demo-side__brand">
          <span className="demo-logo" aria-hidden="true">云枢</span>
          <div>
            <strong>云枢</strong>
            <small>能力开放平台</small>
          </div>
        </div>
        <nav aria-label="主导航">
          {demoNav.map((group) => (
            <div key={group.group} className="demo-side__group">
              <span>{group.group}</span>
              {group.items.map((item) => (
                <a
                  key={item.view}
                  {...(props.mode === "interactive" ? { href: `#/${item.view}` } : { "aria-hidden": true, tabIndex: -1 })}
                  data-testid={`nav-${item.view}`}
                  data-active={activeView === item.view || undefined}
                  aria-current={activeView === item.view ? "page" : undefined}
                >
                  {item.label}
                </a>
              ))}
            </div>
          ))}
        </nav>
      </aside>
      <div className="demo-main">
        <header className="demo-topbar">
          <span className="demo-topbar__crumb">{viewTitles[activeView]}</span>
          {props.mode === "interactive" && session ? (
            <div className="demo-topbar__user">
              <span>{session.name} · {session.role}</span>
              <button type="button" onClick={handleLogout}>退出登录</button>
            </div>
          ) : (
            <div className="demo-topbar__user">
              <span>{props.mode === "mirror" ? "观众镜像 · 只读" : ""}</span>
            </div>
          )}
        </header>
        <div className="demo-content">{body}</div>
      </div>
    </div>
  );
}
