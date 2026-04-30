import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ApprovalPolicy } from "../src/approval-policy.js";

function tempPolicyPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent2lark-policy-"));
  return path.join(dir, "policy.json");
}

test("returns undefined when no rule matches", () => {
  const policy = new ApprovalPolicy(tempPolicyPath());
  assert.equal(policy.match({ tool: "Shell", command: "git status" }), undefined);
});

test("matches by exact tool and command prefix and increments hits", () => {
  const policyPath = tempPolicyPath();
  const policy = new ApprovalPolicy(policyPath);
  const rule = policy.add({ tool: "Shell", commandPrefix: "git status", decision: "allow" });
  assert.ok(rule.id);
  assert.equal(rule.hits, 0);

  const matched = policy.match({ tool: "Shell", command: "git status -uno" });
  assert.equal(matched.decision, "allow");
  assert.equal(matched.id, rule.id);

  const reread = JSON.parse(fs.readFileSync(policyPath, "utf8"));
  assert.equal(reread.rules[0].hits, 1);
  assert.ok(reread.rules[0].lastUsedAt > 0);
});

test("prefers the longest matching prefix when multiple rules match", () => {
  const policy = new ApprovalPolicy(tempPolicyPath());
  policy.add({ tool: "Shell", commandPrefix: "git", decision: "deny" });
  policy.add({ tool: "Shell", commandPrefix: "git status", decision: "allow" });

  assert.equal(policy.match({ tool: "Shell", command: "git status -uno" }).decision, "allow");
  assert.equal(policy.match({ tool: "Shell", command: "git push" }).decision, "deny");
});

test("does not let empty commandPrefix rules act as a wildcard for non-empty commands", () => {
  // Regression: a rule like { tool: "Write", commandPrefix: "" } previously
  // auto-approved every Write call (any path). It must now only match calls
  // whose command is also empty, so a single bad rule cannot silently
  // whitelist every invocation of a tool.
  const policy = new ApprovalPolicy(tempPolicyPath());
  policy.add({ tool: "Write", commandPrefix: "", decision: "allow" });

  assert.equal(policy.match({ tool: "Write", command: "" }).decision, "allow");
  assert.equal(policy.match({ tool: "Write", command: "/etc/passwd" }), undefined);
  assert.equal(policy.match({ tool: "Edit", command: "" }), undefined);
});

test("matches by tool + pathPrefix so one /allow! covers every file under the project", () => {
  // The headline UX win: a single /allow! on `Write` inside a project root
  // should auto-approve every subsequent Write under that root, instead of
  // forcing the user to /allow each individual file.
  const policy = new ApprovalPolicy(tempPolicyPath());
  const rule = policy.add({
    tool: "Write",
    pathPrefix: "/Users/me/projects/agent2lark-cursor/",
    decision: "allow"
  });

  assert.equal(
    policy.match({ tool: "Write", command: "/Users/me/projects/agent2lark-cursor/src/foo.js" })?.id,
    rule.id
  );
  assert.equal(
    policy.match({ tool: "Write", command: "/Users/me/projects/agent2lark-cursor/deeply/nested/bar.js" })?.id,
    rule.id
  );
  // A sibling project must not match — the trailing slash makes the prefix
  // proper-directory-scoped.
  assert.equal(
    policy.match({ tool: "Write", command: "/Users/me/projects/agent2lark-cursor-other/src/foo.js" }),
    undefined
  );
  // Different tool inside the same project must not match either.
  assert.equal(
    policy.match({ tool: "Edit", command: "/Users/me/projects/agent2lark-cursor/src/foo.js" }),
    undefined
  );
});

test("matches explicit tool-wide rules for every command of the same tool", () => {
  const policy = new ApprovalPolicy(tempPolicyPath());
  policy.add({ tool: "Shell", toolScope: true, decision: "allow" });

  assert.equal(policy.match({ tool: "Shell", command: "git status --short" })?.decision, "allow");
  assert.equal(policy.match({ tool: "Shell", command: "git diff --stat" })?.decision, "allow");
  assert.equal(policy.match({ tool: "Write", command: "/tmp/file.js" }), undefined);
});

test("removes rules by id", () => {
  const policy = new ApprovalPolicy(tempPolicyPath());
  const rule = policy.add({ tool: "Shell", commandPrefix: "rm -rf", decision: "deny" });
  assert.equal(policy.list().length, 1);

  policy.remove(rule.id);
  assert.deepEqual(policy.list(), []);
});

test("persists rules across instances pointing at the same file", () => {
  const policyPath = tempPolicyPath();
  const policy = new ApprovalPolicy(policyPath);
  policy.add({ tool: "Shell", commandPrefix: "ls", decision: "allow" });

  const fresh = new ApprovalPolicy(policyPath);
  const matched = fresh.match({ tool: "Shell", command: "ls -la" });
  assert.equal(matched.decision, "allow");
});
