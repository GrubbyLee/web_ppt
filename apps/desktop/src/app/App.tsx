import { lazy, Suspense } from "react";
import { createHashRouter, Navigate, RouterProvider } from "react-router-dom";

const ProjectWorkspace = lazy(() => import("../features/projects/ProjectWorkspace").then((module) => ({ default: module.ProjectWorkspace })));
const ProjectEditor = lazy(() => import("../features/projects/ProjectEditor").then((module) => ({ default: module.ProjectEditor })));
const PresenterShell = lazy(() => import("../features/presenter/PresenterShell").then((module) => ({ default: module.PresenterShell })));
const AudienceWindow = lazy(() => import("../features/audience/AudienceWindow").then((module) => ({ default: module.AudienceWindow })));

function LazyRoute({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={<main className="project-loading">正在打开工作区...</main>}>{children}</Suspense>;
}

const router = createHashRouter([
  { path: "/", element: <Navigate to="/projects" replace /> },
  { path: "/projects", element: <LazyRoute><ProjectWorkspace /></LazyRoute> },
  { path: "/projects/:projectId/edit", element: <LazyRoute><ProjectEditor /></LazyRoute> },
  { path: "/presenter", element: <LazyRoute><PresenterShell /></LazyRoute> },
  { path: "/presenter/:projectId", element: <LazyRoute><PresenterShell /></LazyRoute> },
  { path: "/audience/:sessionId", element: <LazyRoute><AudienceWindow /></LazyRoute> }
]);

export function AppRouter() {
  return <RouterProvider router={router} />;
}
