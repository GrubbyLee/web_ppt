import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import { parseOfflineHtmlPackage, requestedOfflineOrigins } from "./offline-package";

describe("offline HTML packages", () => {
  it("imports an index and bundled resources without granting network access", () => {
    const archive = zipSync({
      "demo/index.html": strToU8('<link rel="stylesheet" href="styles/app.css"><script src="app.js"></script>'),
      "demo/styles/app.css": strToU8("body{background:url('../logo.png')}"),
      "demo/app.js": strToU8("window.ready=true; fetch('https://api.example.com/data')"),
      "demo/logo.png": new Uint8Array([0])
    });
    const fallback = parseOfflineHtmlPackage(archive);
    expect(fallback.resources!.map((resource) => resource.path)).toEqual(["styles/app.css", "app.js", "logo.png"]);
    expect(fallback.allowedNetworkOrigins).toEqual([]);
    expect(requestedOfflineOrigins(fallback)).toEqual(["https://api.example.com"]);
  });

  it("rejects packages without a root index or with unsupported files", () => {
    expect(() => parseOfflineHtmlPackage(zipSync({ "app.js": strToU8("x") }))).toThrow("index.html");
    expect(() => parseOfflineHtmlPackage(zipSync({ "index.html": strToU8("x"), "payload.exe": new Uint8Array([0]) }))).toThrow("不支持资源");
  });
});
