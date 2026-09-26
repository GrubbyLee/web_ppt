function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isSafePath(value) {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || value.includes("\\") || /[?#]/.test(value)) return false;
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

export function buildProtectionRules(origin, allowedPaths) {
  const blockRuleId = 910_000;
  const methods = ["post", "put", "patch", "delete"];
  const resourceTypes = ["main_frame", "sub_frame", "xmlhttprequest", "ping", "other"];
  const rules = [{
    id: blockRuleId,
    priority: 1,
    action: { type: "block" },
    condition: {
      regexFilter: `^${escapeRegex(origin)}(?:[/?#]|$)`,
      requestMethods: methods,
      resourceTypes
    }
  }];
  sanitizeProtectionPaths(allowedPaths).forEach((path, index) => {
    rules.push({
      id: blockRuleId + index + 1,
      priority: 2,
      action: { type: "allow" },
      condition: {
        regexFilter: `^${escapeRegex(origin + path)}(?:[/?#]|$)`,
        requestMethods: methods,
        resourceTypes
      }
    });
  });
  return rules;
}
