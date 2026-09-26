function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isSafePath(value) {
  // Percent signs are rejected outright: "%252e%252e" survives a single decode
  // as "%2e%2e", which a double-decoding upstream would turn into "..".
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || value.includes("\\") || value.includes("%") || /[?#]/.test(value)) return false;
  try {
    const decoded = decodeURIComponent(value);
    return !decoded.startsWith("//") && !decoded.includes("\\") && !decoded.split("/").some((segment) => segment === "." || segment === "..");
  } catch {
    return false;
  }
}

export function sanitizeProtectionPaths(paths) {
  return [...new Set((Array.isArray(paths) ? paths : []).filter(isSafePath))].slice(0, 40);
}

export function buildProtectionRules(origins, allowedPaths) {
  // `origins` is the connector's main origin first, followed by any extra
  // allowedOrigins: write-blocking covers every listed origin so an API host
  // cannot smuggle writes around the main-origin rules. Auth-path allows only
  // apply to the main origin, where login/logout actually happens.
  const originList = [...new Set((Array.isArray(origins) ? origins : [origins]).filter((origin) => typeof origin === "string" && origin.length > 0))].slice(0, 20);
  if (originList.length === 0) return [];
  const blockRuleBase = 910_000;
  const allowRuleBase = 910_050;
  // Every method declarativeNetRequest can match except the read-only
  // GET/HEAD/OPTIONS: an exotic method must fail closed into the block rule.
  const methods = ["post", "put", "patch", "delete", "connect", "trace"];
  const resourceTypes = ["main_frame", "sub_frame", "xmlhttprequest", "websocket", "ping", "other"];
  const rules = originList.map((origin, index) => ({
    id: blockRuleBase + index,
    priority: 1,
    action: { type: "block" },
    condition: {
      regexFilter: `^${escapeRegex(origin)}(?:[/?#]|$)`,
      requestMethods: methods,
      resourceTypes
    }
  }));
  sanitizeProtectionPaths(allowedPaths).forEach((path, index) => {
    rules.push({
      id: allowRuleBase + index,
      priority: 2,
      action: { type: "allow" },
      condition: {
        // The path continuing after the allowlisted prefix must not carry
        // percent-encoding: "%252e%252e"-style double-encoding is the classic
        // way to smuggle a traversal past a raw-prefix rule (RE2 has no
        // lookahead, so the exclusion lives in the character class).
        regexFilter: `^${escapeRegex(originList[0] + path)}(?:[/?][^?#%]*)?(?:[?#][^#]*)?(?:#.*)?$`,
        requestMethods: methods,
        resourceTypes
      }
    });
  });
  return rules;
}
