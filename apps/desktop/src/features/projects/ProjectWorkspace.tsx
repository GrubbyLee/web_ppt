import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Archive, Copy, Download, FileDown, FileUp, FolderOpen, Play, Plus, RefreshCw, ShieldOff, Trash2 } from "lucide-react";
import { Button, Input, Modal } from "antd";
import type { Project } from "@showit/contracts";
import { PackagePasswordError, createProject, createSession, downloadProjectPackage, duplicateProject, parseProjectPackage } from "../../lib/project-workspace";
import { createProjectSnapshot, deleteWorkspace, listProjectVersions, listWorkspaces, saveWorkspace, setActiveProject, type Workspace } from "../../lib/persistence";
import { sampleProject } from "../../lib/sample-project";
import { ToolbarButton } from "../../components/ToolbarButton";
import { forgetProjectTrust, inspectProjectImport, projectTrustState, trustProject, type ProjectImportReview } from "../../lib/project-trust";
import { recordDiagnostic } from "../../lib/diagnostics";
import { useAppUpdate } from "../../lib/app-update";
import { beginPresentationLaunch } from "../../lib/presentation-launch";

type LibraryState = "loading" | "ready" | "error";
type PackageDialog = { mode: "export"; project: Project } | { mode: "import"; content: ArrayBuffer };

function projectStatus(status: Project["status"]): string {
  return status === "published" ? "已发布" : status === "archived" ? "已归档" : "草稿";
}

function createSampleWorkspace(): Workspace {
  return { project: sampleProject, session: createSession(sampleProject) };
}

export function ProjectWorkspace() {
  const navigate = useNavigate();
  const importInput = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<LibraryState>("loading");
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [packageDialog, setPackageDialog] = useState<PackageDialog | null>(null);
  const [packagePassword, setPackagePassword] = useState("");
  const [packagePasswordConfirm, setPackagePasswordConfirm] = useState("");
  const [packageError, setPackageError] = useState<string | null>(null);
  const [packageBusy, setPackageBusy] = useState(false);
  const [pendingImport, setPendingImport] = useState<Project | null>(null);
  const [importReview, setImportReview] = useState<ProjectImportReview | null>(null);
  const [pendingRun, setPendingRun] = useState<Workspace | null>(null);
  const [updateDialogOpen, setUpdateDialogOpen] = useState(false);
  const update = useAppUpdate();

  useEffect(() => {
    listWorkspaces()
      .then(async (items) => {
        if (items.length > 0) {
          setWorkspaces(items);
          setState("ready");
          return;
        }
        const sample = createSampleWorkspace();
        await saveWorkspace(sample);
        await trustProject(sample.project);
        setWorkspaces([sample]);
        setState("ready");
      })
      .catch((error) => {
        recordDiagnostic("project-library.load", error);
        setState("error");
        setMessage("本地项目库无法读取。请检查应用数据目录后重试。");
      });
  }, []);

  useEffect(() => {
    void update.check(false);
  }, [update.check]);

  useEffect(() => {
    if (update.status === "available") setUpdateDialogOpen(true);
  }, [update.status]);

  const persist = async (workspace: Workspace) => {
    await saveWorkspace(workspace);
    setWorkspaces((items) => {
      const index = items.findIndex((item) => item.project.id === workspace.project.id);
      if (index < 0) return [workspace, ...items];
      return items.map((item) => (item.project.id === workspace.project.id ? workspace : item));
    });
  };

  const launchProject = async (workspace: Workspace) => {
    setActiveProject(workspace.project.id);
    await createProjectSnapshot(workspace.project, "启动演示前自动快照", "auto").catch((error) => {
      recordDiagnostic("project.snapshot-before-run", error);
    });
    beginPresentationLaunch(workspace.project);
    navigate(`/presenter/${workspace.project.id}`);
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
    navigate(`/projects/${project.id}/edit`);
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

  const approveImport = async () => {
    if (!pendingImport) return;
    try {
      await finishImport(pendingImport);
      setPendingImport(null);
      setImportReview(null);
    } catch (error) {
      recordDiagnostic("project.import", error);
      setMessage(error instanceof Error ? `导入失败：${error.message}` : "导入失败。" );
    }
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

  if (state === "loading") return <main className="project-loading">正在打开本地项目库...</main>;
  if (state === "error") return <main className="project-loading project-loading--error">{message}</main>;

  return (
    <main className="project-workspace">
      <header className="workspace-topbar">
        <div>
          <strong>Showit</strong>
          <span>本地演示项目</span>
        </div>
        <section className="workspace-actions" aria-label="项目库操作">
          <ToolbarButton
            icon={update.status === "checking" ? <RefreshCw className="is-spinning" size={16} /> : <Download size={16} />}
            {...(update.status === "available" && update.metadata ? { label: `更新 ${update.metadata.version}` } : {})}
            title={update.status === "available" ? `Showit ${update.metadata?.version} 可用` : "检查 Showit 更新"}
            active={update.status === "available"}
            disabled={update.status === "checking"}
            onClick={() => {
              setUpdateDialogOpen(true);
              if (["idle", "current", "error", "unavailable"].includes(update.status)) void update.check(true);
            }}
          />
          <ToolbarButton icon={<FileUp size={16} />} label="导入" title="导入 .showit 项目文件" onClick={() => importInput.current?.click()} />
          <ToolbarButton icon={<Plus size={16} />} label="新建项目" title="创建演示项目" variant="primary" onClick={() => setCreating(true)} />
          <input ref={importInput} className="visually-hidden" type="file" accept=".showit,.json,application/json" onChange={(event) => importProject(event.target.files?.[0])} />
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
          {workspaces.map((workspace) => {
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
                  <ToolbarButton icon={<Play size={16} />} label="运行" title="启动演示运行时" variant="primary" onClick={() => {
                    if (project.status === "archived" && !window.confirm(`“${project.name}”已归档，仍要启动演示吗？`)) return;
                    void runProject(workspace);
                  }} />
                  <ToolbarButton icon={<FolderOpen size={16} />} title="编辑项目" onClick={() => navigate(`/projects/${project.id}/edit`)} />
                  <ToolbarButton icon={<Copy size={16} />} title="复制项目" onClick={async () => {
                    const sourceTrusted = await projectTrustState(project) === "trusted";
                    const duplicate = duplicateProject(project);
                    await persist({ project: duplicate, session: createSession(duplicate) });
                    if (sourceTrusted) await trustProject(duplicate);
                    setMessage(`已创建“${project.name}”的副本${sourceTrusted ? "，并继承运行信任" : ""}。`);
                  }} />
                  <ToolbarButton icon={<FileDown size={16} />} title="导出 .showit 文件" onClick={() => { setPackageDialog({ mode: "export", project }); setPackageError(null); }} />
                  <ToolbarButton icon={<ShieldOff size={16} />} title="取消项目信任，停止脚本和自动操作运行" onClick={() => { forgetProjectTrust(project.id); setMessage(`已取消“${project.name}”的运行信任。`); }} />
                  <ToolbarButton
                    icon={<Archive size={16} />}
                    title={project.status === "archived" ? "恢复项目" : "归档项目"}
                    onClick={() => {
                      if (project.status !== "archived") {
                        persist({ ...workspace, project: { ...project, status: "archived" } });
                        return;
                      }
                      // Restoring goes back to 已发布 when the project has
                      // published versions, otherwise to a draft.
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
                    onClick={async () => {
                      if (!window.confirm(`删除“${project.name}”？此操作无法恢复。`)) return;
                      await deleteWorkspace(project.id);
                      forgetProjectTrust(project.id);
                      setWorkspaces((items) => items.filter((item) => item.project.id !== project.id));
                    }}
                  />
                </section>
              </article>
            );
          })}
        </div>
      </section>

      <Modal
        open={updateDialogOpen}
        title="Showit 稳定版更新"
        onCancel={() => setUpdateDialogOpen(false)}
        closable={update.status !== "downloading" && update.status !== "installing"}
        maskClosable={update.status !== "downloading" && update.status !== "installing"}
        footer={update.status === "available" ? [
          <Button key="later" onClick={() => setUpdateDialogOpen(false)}>稍后</Button>,
          update.distribution?.canInstallUpdate
            ? <Button key="install" type="primary" onClick={() => void update.install()}>下载并安装</Button>
            : <Button key="download" type="primary" disabled={!update.metadata?.releaseUrl} onClick={() => void update.openDownload()}>下载完整安装包</Button>
        ] : update.status === "downloading" || update.status === "installing" ? [] : [
          <Button key="close" onClick={() => setUpdateDialogOpen(false)}>关闭</Button>,
          <Button key="retry" type="primary" loading={update.status === "checking"} onClick={() => void update.check(true)}>重新检查</Button>
        ]}
      >
        <section className="app-update-dialog" aria-live="polite">
          {update.status === "checking" ? <p>正在连接稳定版更新服务...</p> : null}
          {update.status === "current" ? <p>{update.message ?? "当前已是最新稳定版。"}</p> : null}
          {update.status === "unavailable" || update.status === "error" ? <p role={update.status === "error" ? "alert" : undefined}>{update.message ?? "更新服务暂时不可用，已安装版本仍可离线使用。"}</p> : null}
          {update.metadata ? <>
            <dl>
              <div><dt>当前版本</dt><dd>{update.metadata.currentVersion}</dd></div>
              <div><dt>可用版本</dt><dd>{update.metadata.version}</dd></div>
              <div><dt>更新时间</dt><dd>{update.metadata.date ? new Date(update.metadata.date).toLocaleString("zh-CN") : "未提供"}</dd></div>
              <div><dt>更新方式</dt><dd>{update.distribution?.canInstallUpdate ? "签名校验后安装" : "下载完整安装包"}</dd></div>
            </dl>
            <h3>变更说明</h3>
            <pre>{update.metadata.notes?.trim() || "本次更新未提供变更说明。"}</pre>
          </> : null}
          {update.status === "downloading" || update.status === "installing" ? <div className="app-update-progress"><span>{update.status === "installing" ? "正在安装..." : `正在下载${update.progress === null ? "..." : ` ${update.progress}%`}`}</span><progress max="100" value={update.progress ?? undefined} /></div> : null}
          {update.message && update.metadata ? <p role="alert">{update.message}</p> : null}
        </section>
      </Modal>
      <Modal
        open={packageDialog !== null}
        title={packageDialog?.mode === "import" ? "打开加密项目包" : "导出项目包"}
        onCancel={closePackageDialog}
        closable={!packageBusy}
        maskClosable={!packageBusy}
        footer={packageDialog?.mode === "import" ? [
          <Button key="cancel" onClick={closePackageDialog} disabled={packageBusy}>取消</Button>,
          <Button key="decrypt" type="primary" loading={packageBusy} disabled={!packagePassword} onClick={() => void decryptImport()}>解密并导入</Button>
        ] : [
          <Button key="cancel" onClick={closePackageDialog} disabled={packageBusy}>取消</Button>,
          <Button key="plain" loading={packageBusy} onClick={() => void exportPackage(false)}>普通导出</Button>,
          <Button key="encrypt" type="primary" loading={packageBusy} onClick={() => void exportPackage(true)}>加密导出</Button>
        ]}
      >
        <div className="package-password-dialog">
          <label>
            <span>项目包密码</span>
            <Input.Password autoFocus value={packagePassword} autoComplete="off" onChange={(event) => setPackagePassword(event.target.value)} onPressEnter={() => packageDialog?.mode === "import" ? void decryptImport() : undefined} />
          </label>
          {packageDialog?.mode === "export" ? (
            <label>
              <span>确认密码</span>
              <Input.Password value={packagePasswordConfirm} autoComplete="off" onChange={(event) => setPackagePasswordConfirm(event.target.value)} />
            </label>
          ) : null}
          {packageError ? <p role="alert">{packageError}</p> : null}
        </div>
      </Modal>
      <Modal
        open={pendingRun !== null}
        title="项目需要信任"
        onCancel={() => setPendingRun(null)}
        footer={[
          <Button key="cancel" onClick={() => setPendingRun(null)}>取消</Button>,
          <Button key="trust" type="primary" onClick={async () => {
            if (!pendingRun) return;
            await trustProject(pendingRun.project);
            const workspace = pendingRun;
            setPendingRun(null);
            await launchProject(workspace);
          }}>重新信任并运行</Button>
        ]}
      >
        {pendingRun ? <section className="project-import-review"><strong>{pendingRun.project.name}</strong><p>项目尚未信任或内容与上次信任的哈希不一致。重新确认后将更新本机信任记录。</p></section> : null}
      </Modal>
      <Modal
        open={pendingImport !== null}
        title="检查导入项目"
        onCancel={() => { setPendingImport(null); setImportReview(null); }}
        footer={[
          <Button key="cancel" onClick={() => { setPendingImport(null); setImportReview(null); }}>取消</Button>,
          <Button key="trust" type="primary" onClick={() => void approveImport()}>确认信任并导入</Button>
        ]}
      >
        {pendingImport && importReview ? <section className="project-import-review">
          <strong>{pendingImport.name}</strong>
          <dl><div><dt>业务域名</dt><dd>{importReview.origins.length}</dd></div><div><dt>离线 HTML</dt><dd>{importReview.offlineHtmlPages}</dd></div><div><dt>自动操作连接器</dt><dd>{importReview.automatedConnectors}</dd></div><div><dt>高风险步骤</dt><dd>{importReview.highRiskSteps}</dd></div><div><dt>嵌入资源</dt><dd>{Math.ceil(importReview.embeddedBytes / 1024)} KB</dd></div></dl>
          {importReview.origins.length > 0 ? <ul>{importReview.origins.map((origin) => <li key={origin}>{origin}</li>)}</ul> : null}
        </section> : null}
      </Modal>
    </main>
  );
}
