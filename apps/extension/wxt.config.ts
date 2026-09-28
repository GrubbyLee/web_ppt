import { defineConfig } from "wxt";

export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  srcDir: ".",
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
