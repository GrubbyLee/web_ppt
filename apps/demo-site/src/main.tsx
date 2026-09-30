import { createRoot } from "react-dom/client";
import { DemoConsole } from "@showit/demo/DemoConsole";
import { demoNav } from "@showit/demo/views";

/**
 * Relay-hosted variant of the built-in demo console.
 *
 * Served over HTTP(S) so the session tab for `demo://` pages becomes a
 * capturable, real business page — that is what lets remote (relay)
 * viewers watch the built-in sample, since chrome-extension:// pages
 * cannot be captured. This entry has no chrome.* access by design: the
 * overlay (annotations / masks / screen covers) is rendered by the
 * injected content script.

 * Login state and demo mutations live in the page (sessionStorage + memory),
 * and the picture is captured, so remote viewers see the live state.
 */
const root = document.querySelector("#root");
if (root) {
  createRoot(root).render(<DemoConsole mode="interactive" />);
}
