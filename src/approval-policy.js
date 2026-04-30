import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_APPROVAL_POLICY_PATH } from "./constants.js";

function emptyState() {
  return { rules: [] };
}

function readState(policyPath) {
  if (!fs.existsSync(policyPath)) {
    return emptyState();
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(policyPath, "utf8"));
    return {
      ...emptyState(),
      ...parsed,
      rules: Array.isArray(parsed?.rules) ? parsed.rules : []
    };
  } catch {
    return emptyState();
  }
}

function writeState(policyPath, state) {
  fs.mkdirSync(path.dirname(policyPath), { recursive: true });
  fs.writeFileSync(policyPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function ensureTrailingSlash(value) {
  const text = String(value || "");
  if (!text) return "";
  return text.endsWith("/") ? text : `${text}/`;
}

function isAbsolutePathLike(value) {
  return path.isAbsolute(String(value || "").split(/\s+/, 1)[0] || "");
}

function ruleMatches(rule, { tool, command, cwd }) {
  if (rule.tool !== tool) return false;
  if (rule.toolScope === true) return true;
  const pathPrefix = rule.pathPrefix || "";
  if (pathPrefix) {
    // Path-prefix rules cover all file/path operations under that directory
    // (e.g. one /allow! on a Write inside the project root then auto-approves
    // every subsequent Write under the same project). They never act as a
    // tool-wide wildcard because an empty pathPrefix is not honoured here.
    const normalizedPrefix = ensureTrailingSlash(pathPrefix);
    const commandText = String(command || "");
    if (isAbsolutePathLike(commandText)) {
      return commandText.startsWith(normalizedPrefix);
    }
    return ensureTrailingSlash(cwd).startsWith(normalizedPrefix);
  }
  const prefix = rule.commandPrefix || "";
  if (!prefix) {
    // Empty-prefix rules only match when the incoming command is also empty,
    // never as a wildcard. Otherwise a stale broad rule could silently
    // auto-approve every invocation of a tool.
    return !String(command || "").trim();
  }
  return String(command || "").startsWith(prefix);
}

function rankRule(rule) {
  // Prefer the most specific scope. pathPrefix and commandPrefix are
  // mutually exclusive in inferred rules, but we still take the longer of the
  // two so legacy mixed rules pick the more specific one.
  return Math.max(
    String(rule.pathPrefix || "").length,
    String(rule.commandPrefix || "").length
  );
}

export class ApprovalPolicy {
  constructor(policyPath = DEFAULT_APPROVAL_POLICY_PATH) {
    this.policyPath = policyPath;
  }

  list() {
    return readState(this.policyPath).rules;
  }

  add({ tool, commandPrefix = "", pathPrefix = "", toolScope = false, decision }) {
    if (!tool) throw new Error("ApprovalPolicy.add requires tool");
    if (decision !== "allow" && decision !== "deny") {
      throw new Error(`ApprovalPolicy.add requires decision allow|deny, got ${decision}`);
    }

    const state = readState(this.policyPath);
    const rule = {
      id: `rule_${crypto.randomBytes(6).toString("hex")}`,
      tool,
      commandPrefix,
      pathPrefix,
      ...(toolScope ? { toolScope: true } : {}),
      decision,
      hits: 0,
      createdAt: Date.now(),
      lastUsedAt: 0
    };
    state.rules.push(rule);
    writeState(this.policyPath, state);
    return rule;
  }

  remove(id) {
    const state = readState(this.policyPath);
    state.rules = state.rules.filter((rule) => rule.id !== id);
    writeState(this.policyPath, state);
  }

  match({ tool, command, cwd } = {}) {
    const state = readState(this.policyPath);
    const candidates = state.rules.filter((rule) => ruleMatches(rule, { tool, command, cwd }));
    if (candidates.length === 0) return undefined;

    candidates.sort((a, b) => rankRule(b) - rankRule(a));
    const winner = candidates[0];
    winner.hits = (winner.hits || 0) + 1;
    winner.lastUsedAt = Date.now();
    writeState(this.policyPath, state);
    return winner;
  }
}
