import { defineConfig } from "wxt";

export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  srcDir: ".",
  dev: { server: { port: 6666, strictPort: true } },
  manifest: {
    name: "Showit",
    short_name: "Showit",
    description: "本地优先的网页演示控制台：真实标签页 + 侧边栏演讲者控制台",
    default_locale: undefined,
    permissions: [
      "sidePanel",
      "tabs",
      "scripting",
      "activeTab",
      "contextMenus",
      "tabCapture",
      "storage",
      "unlimitedStorage",
      "declarativeNetRequest",
      "offscreen"
    ],
    optional_host_permissions: ["http://*/*", "https://*/*"],
    // Loopback relay endpoints must be reachable from the service worker
    // without an interactive grant (fetch from SW ignores optional grants).
    host_permissions: ["http://127.0.0.1/*"],
    icons: {
      16: "icons/icon-16.png",
      32: "icons/icon-32.png",
      48: "icons/icon-48.png",
      128: "icons/icon-128.png"
    },
    action: {
      default_title: "Showit 控制台",
      default_icon: {
        16: "icons/icon-16.png",
        32: "icons/icon-32.png",
        48: "icons/icon-48.png",
        128: "icons/icon-128.png"
      }
    },
    content_security_policy: {
      extension_pages: "script-src 'self'; object-src 'self'; connect-src 'self' http: https: ws: wss:"
    },
    web_accessible_resources: [],
    commands: {
      "authorize-capture": {
        suggested_key: { default: "Ctrl+Shift+9" },
        description: "授权 Showit 捕获当前演示画面标签"
      }
    }
  }
});
