import { createRoot } from "react-dom/client";
import { App } from "./App";
import "@/components/ui.css";
import "./workbench.css";

const root = document.querySelector("#root");
if (root) createRoot(root).render(<App />);
