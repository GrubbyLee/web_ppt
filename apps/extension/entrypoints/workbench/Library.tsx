import { useEffect, useRef, useState } from "react";
import { browser } from "wxt/browser";
import type { Project } from "@showit/contracts";
import { PackagePasswordError, createProject, createSession, downloadProjectPackage, duplicateProject, parseProjectPackage } from "@/lib/project-workspace";
import { createProjectSnapshot, deleteWorkspace, ensureSampleWorkspace, listProjectVersions, listWorkspaces, saveWorkspace, setActiveProject, type Workspace } from "@/lib/persistence";
import { forgetProjectTrust, inspectProjectImport, projectTrustState, trustProject, type ProjectImportReview } from "@/lib/project-trust";
import { recordDiagnostic } from "@/lib/diagnostics";
import { beginPresentationLaunch } from "@/lib/presentation-launch";
import { ToolbarButton } from "@/components/ToolbarButton";
import type { WorkbenchPort } from "./App";
import { Archive, ChevronLeft, ChevronRight, Copy, Download, FileDown, FileUp, FolderOpen, Play, Plus, ShieldOff, TriangleAlert, Trash2 } from "lucide-react";

/** Projects per page. The library also renders inside the side panel console,
 *  where an endlessly scrolling column would be unusable. */
const LIBRARY_PAGE_SIZE = 6;

type LibraryState = "loading" | "ready" | "error";
type PackageDialog = { mode: "export"; project: Project } | { mode: "import"; content: ArrayBuffer };

function projectStatus(status: Project["status"]): string {
  return status === "published" ? "已发布" : status === "archived" ? "已归档" : "草稿";
}

async function originPatternsForProject(project: Project): Promise<string[]> {
  const origins = new Set<string>();
  for (const connector of project.connectors) {
    try {
      origins.add(new URL(connector.origin).origin);
      connector.allowedOrigins.forEach((origin) => origins.add(new URL(origin).origin));
    } catch {
      // Invalid connector origins are surfaced by preflight, not by the launch flow.
    }
  }
  for (const page of project.pages) {
    if (!page.url) continue;
    try {
      origins.add(new URL(page.url.replace(/{{[^}]+}}/g, "showit-value")).origin);
    } catch {
      // Skip malformed templates.
    }
  }
  return [...origins].filter((origin) => origin.startsWith("https:") || origin.startsWith("http:")).map((origin) => `${origin}/*`);
}

/** Renders the project library. `embedded` means "inside the side panel
 *  console": no own top bar (the console owns the chrome) and 编辑项目 opens a
 *  real tab, because the full editor cannot live in the panel. */
export function Library({ port, embedded = false }: { port: WorkbenchPort; embedded?: boolean }) {
  const importInput = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<LibraryState>("loading");
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [packageDialog, setPackageDialog] = useState<PackageDialog | null>(null);
  const [listPage, setListPage] = useState(0);
  const [packagePassword, setPackagePassword] = useState("");
  const [packagePasswordConfirm, setPackagePasswordConfirm] = useState("");
  const [packageError, setPackageError] = useState<string | null>(null);
  const [packageBusy, setPackageBusy] = useState(false);
  const [pendingImport, setPendingImport] = useState<Project | null>(null);
  const [importReview, setImportReview] = useState<ProjectImportReview | null>(null);
  const [pendingRun, setPendingRun] = useState<Workspace | null>(null);
  const [launching, setLaunching] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        await ensureSampleWorkspace();
        const items = await listWorkspaces();
        setWorkspaces(items);
        setState("ready");
      } catch (error) {
        recordDiagnostic("project-library.load", error);
        setState("error");
        setMessage("本地项目库无法读取。");
      }
    })();
  }, []);

  const persist = async (workspace: Workspace) => {
    await saveWorkspace(workspace);
    setWorkspaces((items) => {
      const index = items.findIndex((item) => item.project.id === workspace.project.id);
      if (index < 0) return [workspace, ...items];
      return items.map((item) => (item.project.id === workspace.project.id ? workspace : item));
    });
  };

  const launchProject = async (workspace: Workspace) => {
    setLaunching(true);
    try {
      setActiveProject(workspace.project.id);
      await createProjectSnapshot(workspace.project, "启动演示前自动快照", "auto").catch((error) => {
        recordDiagnostic("project.snapshot-before-run", error);
      });
      beginPresentationLaunch(workspace.project);
      // Optional host permissions must be requested from this user gesture
      // before the background opens the session tab.
      const patterns = [...new Set(await originPatternsForProject(workspace.project))];
      const missing: string[] = [];
      for (const pattern of patterns) {
        try {
          if (!await browser.permissions.contains({ origins: [pattern] })) missing.push(pattern);
        } catch {
          missing.push(pattern);
        }
      }
      if (missing.length > 0) {
        const granted = await browser.permissions.request({ origins: missing }).catch(() => false);
        if (!granted) {
          setMessage("站点授权被拒绝：业务页面仍会打开，但连接器探测、遮罩与录制将不可用。");
        }
      }
      try {
        const tab = await browser.tabs.getCurrent();
        if (tab?.id !== undefined) await browser.sidePanel.open({ tabId: tab.id });
      } catch {
        // Side panel not supported or already open; the presenter can click the toolbar icon.
      }
      port.send({ type: "begin", projectId: workspace.project.id });
      setMessage("演示已启动：控制台已打开侧边栏，画面标签将在新窗口出现。");
    } catch (error) {
      recordDiagnostic("project.launch", error);
      setMessage(error instanceof Error ? `演示启动失败：${error.message}` : "演示启动失败。");
    } finally {
      setLaunching(false);
    }
  };

  const runProject = async (workspace: Workspace) => {
    if (await projectTrustState(workspace.project) !== "trusted") {
      setPendingRun(workspace);
      return;
    }
    await launchProject(workspace);
  };

  const submitNewProject = async (event: React.FormEvent) => {
    event.preventDefault();
    const project = createProject(name);
    await persist({ project, session: createSession(project) });
    await trustProject(project);
    setName("");
    setCreating(false);
    // In the side panel there is no route to navigate: hand the editor to a tab.
    if (embedded) {
      void browser.tabs.create({ url: browser.runtime.getURL(`/workbench.html#/p/${project.id}`) }).catch((error) => {
        recordDiagnostic("打开项目编辑器", error);
      });
      return;
    }
    window.location.hash = `#/p/${project.id}`;
  };

  const finishImport = async (project: Project) => {
    const exists = workspaces.some((item) => item.project.id === project.id);
    const imported = exists ? duplicateProject(project) : project;
    await persist({ project: imported, session: createSession(imported) });
    await trustProject(imported);
    await createProjectSnapshot(imported, "导入项目自动快照", "auto").catch((error) => {
      recordDiagnostic("project.snapshot-after-import", error);
    });
    setMessage(exists ? "同 ID 项目已存在，已作为副本导入。" : "项目已导入本地项目库。");
  };

  const queueImportReview = (project: Project) => {
    setPendingImport(project);
    setImportReview(inspectProjectImport(project));
  };

  const closePackageDialog = () => {
    setPackageDialog(null);
    setPackagePassword("");
    setPackagePasswordConfirm("");
    setPackageError(null);
    setPackageBusy(false);
  };

  const importProject = async (file: File | undefined) => {
    if (!file) return;
    try {
      const content = await file.arrayBuffer();
      try {
        queueImportReview(await parseProjectPackage(content));
      } catch (error) {
        if (error instanceof PackagePasswordError && error.code === "password-required") {
          setPackageDialog({ mode: "import", content });
          setPackageError(null);
          return;
        }
        throw error;
      }
    } catch (error) {
      recordDiagnostic("project.import-read", error);
      setMessage(error instanceof Error ? `导入失败：${error.message}` : "导入失败：无法读取项目文件。");
    } finally {
      if (importInput.current) importInput.current.value = "";
    }
  };

  const decryptImport = async () => {
    if (!packageDialog || packageDialog.mode !== "import" || !packagePassword) return;
    setPackageBusy(true);
    setPackageError(null);
    try {
      queueImportReview(await parseProjectPackage(packageDialog.content, packagePassword));
      closePackageDialog();
    } catch (error) {
      recordDiagnostic("project.import-decrypt", error);
      setPackageError(error instanceof Error ? error.message : "加密项目包无法读取。");
      setPackageBusy(false);
    }
  };

  const exportPackage = async (encrypted: boolean) => {
    if (!packageDialog || packageDialog.mode !== "export") return;
    if (encrypted && packagePassword.length < 8) {
      setPackageError("加密密码至少需要 8 个字符。");
      return;
    }
    if (encrypted && packagePassword !== packagePasswordConfirm) {
      setPackageError("两次输入的密码不一致。");
      return;
    }
    setPackageBusy(true);
    setPackageError(null);
    try {
      await downloadProjectPackage(packageDialog.project, encrypted ? packagePassword : undefined);
      setMessage(encrypted ? "加密项目包已导出。请妥善保管密码。" : "带完整性校验的项目包已导出。");
      closePackageDialog();
    } catch (error) {
      recordDiagnostic("project.export", error);
      setPackageError(error instanceof Error ? error.message : "项目包导出失败。");
      setPackageBusy(false);
    }
  };

  if (state === "loading") return <main className="project-loading">正在打开本地项目库…</main>;
  if (state === "error") return <main className="project-loading project-loading--error"><TriangleAlert size={18} /> {message}</main>;

  const pageCount = Math.max(1, Math.ceil(workspaces.length / LIBRARY_PAGE_SIZE));
  const pageIndex = Math.min(listPage, pageCount - 1);
  const visibleWorkspaces = workspaces.slice(pageIndex * LIBRARY_PAGE_SIZE, pageIndex * LIBRARY_PAGE_SIZE + LIBRARY_PAGE_SIZE);

  const openEditorTab = (id: string) => {
    void browser.tabs.create({ url: browser.runtime.getURL(`/workbench.html#/p/${id}`) }).catch((error) => {
      recordDiagnostic("打开项目编辑器", error);
    });
  };

  return (
    <main className="project-workspace">
      <header className="workspace-topbar">
        <div>
          <strong>Showit</strong>
          <span>本地演示项目</span>
        </div>
        <section className="workspace-actions" aria-label="项目库操作">
          <ToolbarButton icon={<FileUp size={16} />} label="导入" title="导入 .showit 项目文件" onClick={() => importInput.current?.click()} />
          <ToolbarButton icon={<Plus size={16} />} label="新建项目" title="创建演示项目" variant="primary" onClick={() => setCreating(true)} />
          <input ref={importInput} className="visually-hidden" type="file" accept=".showit,.json,application/json" onChange={(event) => void importProject(event.target.files?.[0])} />
        </section>
      </header>

      <section className="workspace-body" aria-label="演示项目列表">
        <div className="workspace-heading">
          <div>
            <p>项目库</p>
            <h1>{workspaces.length} 个本地项目</h1>
          </div>
          {message ? <output className="workspace-message">{message}</output> : null}
        </div>

        {creating ? (
          <form className="create-project-row" onSubmit={submitNewProject}>
            <label>
              <span>项目名称</span>
              <input autoFocus value={name} maxLength={120} placeholder="例如：客户产品演示" onChange={(event) => setName(event.target.value)} />
            </label>
            <ToolbarButton icon={<Plus size={16} />} label="创建并编辑" title="创建项目" variant="primary" />
            <ToolbarButton type="button" icon={<Archive size={16} />} title="取消创建" onClick={() => setCreating(false)} />
          </form>
        ) : null}

        <div className="project-list">
          {visibleWorkspaces.map((workspace) => {
            const { project } = workspace;
            return (
              <article className={`project-row project-row--${project.status}`} key={project.id}>
                <section className="project-row__summary">
                  <span className={`project-status project-status--${project.status}`}>{projectStatus(project.status)}</span>
                  <div>
                    <h2>{project.name}</h2>
                    <p>{project.description || "尚未填写项目说明"}</p>
                  </div>
                </section>
                <dl className="project-row__facts">
                  <div><dt>页面</dt><dd>{project.pages.length}</dd></div>
                  <div><dt>计划</dt><dd>{Math.ceil(project.totalPlannedSeconds / 60)} 分钟</dd></div>
                  <div><dt>连接器</dt><dd>{project.connectors.length}</dd></div>
                </dl>
                <section className="project-row__actions" aria-label={`${project.name} 操作`}>
                  <ToolbarButton icon={<Play size={16} />} label="运行" title="启动演示运行时" variant="primary" disabled={launching} onClick={() => {
                    if (project.status === "archived" && !window.confirm(`“${project.name}”已归档，仍要启动演示吗？`)) return;
                    void runProject(workspace);
                  }} />
                  <ToolbarButton icon={<FolderOpen size={16} />} title="编辑项目" onClick={() => {
                    if (embedded) openEditorTab(project.id);
                    else window.location.hash = `#/p/${project.id}`;
                  }} />
                  <ToolbarButton icon={<Copy size={16} />} title="复制项目" onClick={() => void (async () => {
                    const sourceTrusted = await projectTrustState(project) === "trusted";
                    const duplicate = duplicateProject(project);
                    await persist({ project: duplicate, session: createSession(duplicate) });
                    if (sourceTrusted) await trustProject(duplicate);
                    setMessage(`已创建“${project.name}”的副本${sourceTrusted ? "，并继承运行信任" : ""}。`);
                  })()} />
                  <ToolbarButton icon={<FileDown size={16} />} title="导出 .showit 文件" onClick={() => { setPackageDialog({ mode: "export", project }); setPackageError(null); }} />
                  <ToolbarButton icon={<ShieldOff size={16} />} title="取消项目信任，停止脚本和自动操作运行" onClick={() => void (async () => {
                    await forgetProjectTrust(project.id);
                    setMessage(`已取消“${project.name}”的运行信任。`);
                  })()} />
                  <ToolbarButton
                    icon={<Archive size={16} />}
                    title={project.status === "archived" ? "恢复项目" : "归档项目"}
                    onClick={() => {
                      if (project.status !== "archived") {
                        void persist({ ...workspace, project: { ...project, status: "archived" } });
                        return;
                      }
                      void listProjectVersions(project.id)
                        .then((versions): Project["status"] => versions.length > 0 ? "published" : "draft")
                        .catch((): Project["status"] => "draft")
                        .then((status) => persist({ ...workspace, project: { ...project, status } }));
                    }}
                  />
                  <ToolbarButton
                    icon={<Trash2 size={16} />}
                    title="删除项目"
                    variant="danger"
                    onClick={() => void (async () => {
                      if (!window.confirm(`删除“${project.name}”？此操作无法恢复。`)) return;
                      await deleteWorkspace(project.id);
                      await forgetProjectTrust(project.id);
                      setWorkspaces((items) => items.filter((item) => item.project.id !== project.id));
                    })()}
                  />
                </section>
              </article>
            );
          })}
        </div>

        {pageCount > 1 ? (
          <nav className="project-pager" aria-label="项目库分页">
            <ToolbarButton icon={<ChevronLeft size={14} />} title="上一页" disabled={pageIndex === 0} onClick={() => setListPage(pageIndex - 1)} />
            <span>第 {pageIndex + 1} / {pageCount} 页</span>
            <ToolbarButton icon={<ChevronRight size={14} />} title="下一页" disabled={pageIndex >= pageCount - 1} onClick={() => setListPage(pageIndex + 1)} />
          </nav>
        ) : null}
      </section>

      {packageDialog !== null ? (
        <div className="dialog-backdrop" role="presentation">
          <div className="dialog" role="dialog" aria-modal="true" aria-label={packageDialog.mode === "import" ? "打开加密项目包" : "导出项目包"}>
            <h2>{packageDialog.mode === "import" ? "打开加密项目包" : "导出项目包"}</h2>
            <label className="field">
              <span>项目包密码</span>
              <input type="password" autoComplete="off" autoFocus value={packagePassword} onChange={(event) => setPackagePassword(event.target.value)} />
            </label>
            {packageDialog.mode === "export" ? (
              <label className="field">
                <span>确认密码</span>
                <input type="password" autoComplete="off" value={packagePasswordConfirm} onChange={(event) => setPackagePasswordConfirm(event.target.value)} />
              </label>
            ) : null}
            {packageError ? <p role="alert" className="dialog__error">{packageError}</p> : null}
            <div className="dialog__actions">
              <ToolbarButton icon="✕" label="取消" disabled={packageBusy} onClick={closePackageDialog} />
              {packageDialog.mode === "import" ? (
                <ToolbarButton icon={<Download size={14} />} label="解密并导入" variant="primary" disabled={packageBusy || !packagePassword} onClick={() => void decryptImport()} />
              ) : (
                <>
                  <ToolbarButton icon={<FileDown size={14} />} label="普通导出" disabled={packageBusy} onClick={() => void exportPackage(false)} />
                  <ToolbarButton icon={<Download size={14} />} label="加密导出" variant="primary" disabled={packageBusy} onClick={() => void exportPackage(true)} />
                </>
              )}
            </div>
          </div>
        </div>
      ) : null}

      {pendingRun !== null ? (
        <div className="dialog-backdrop" role="presentation">
          <div className="dialog" role="dialog" aria-modal="true" aria-label="项目需要信任">
            <h2>项目需要信任</h2>
            {pendingRun ? <p><strong>{pendingRun.project.name}</strong> 尚未信任或内容与上次信任的哈希不一致。重新确认后将更新本机信任记录。</p> : null}
            <div className="dialog__actions">
              <ToolbarButton icon="✕" label="取消" onClick={() => setPendingRun(null)} />
              <ToolbarButton icon={<Play size={14} />} label="重新信任并运行" variant="primary" onClick={() => void (async () => {
                if (!pendingRun) return;
                await trustProject(pendingRun.project);
                const workspace = pendingRun;
                setPendingRun(null);
                await launchProject(workspace);
              })()} />
            </div>
          </div>
        </div>
      ) : null}

      {pendingImport !== null ? (
        <div className="dialog-backdrop" role="presentation">
          <div className="dialog" role="dialog" aria-modal="true" aria-label="检查导入项目">
            <h2>检查导入项目</h2>
            {pendingImport && importReview ? (
              <section className="project-import-review">
                <strong>{pendingImport.name}</strong>
                <dl>
                  <div><dt>业务域名</dt><dd>{importReview.origins.length}</dd></div>
                  <div><dt>离线 HTML</dt><dd>{importReview.offlineHtmlPages}</dd></div>
                  <div><dt>自动操作连接器</dt><dd>{importReview.automatedConnectors}</dd></div>
                  <div><dt>高风险步骤</dt><dd>{importReview.highRiskSteps}</dd></div>
                  <div><dt>嵌入资源</dt><dd>{Math.ceil(importReview.embeddedBytes / 1024)} KB</dd></div>
                </dl>
                {importReview.origins.length > 0 ? <ul>{importReview.origins.map((origin) => <li key={origin}>{origin}</li>)}</ul> : null}
              </section>
            ) : null}
            <div className="dialog__actions">
              <ToolbarButton icon="✕" label="取消" onClick={() => { setPendingImport(null); setImportReview(null); }} />
              <ToolbarButton icon={<Play size={14} />} label="确认信任并导入" variant="primary" onClick={() => void (async () => {
                if (!pendingImport) return;
                try {
                  await finishImport(pendingImport);
                  setPendingImport(null);
                  setImportReview(null);
                } catch (error) {
                  recordDiagnostic("project.import", error);
                  setMessage(error instanceof Error ? `导入失败：${error.message}` : "导入失败。");
                }
              })()} />
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}
