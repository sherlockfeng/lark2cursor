import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { inferRuleScope, isRiskyPreToolUse, toApprovalRequest } from "../src/normalize.js";

function tempProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent2lark-normalize-"));
  fs.mkdirSync(path.join(root, ".git"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  return root;
}

test("maps beforeShellExecution to a Shell approval request", () => {
  const message = toApprovalRequest({
    command: "npm test",
    cwd: "/tmp/example",
    sessionId: "s1"
  }, "beforeShellExecution");

  assert.equal(message.type, "cursor_approval_request");
  assert.equal(message.kind, "shell");
  assert.equal(message.tool, "Shell");
  assert.equal(message.command, "npm test");
  assert.equal(message.cwd, "/tmp/example");
  assert.equal(message.session_id, "s1");
});

test("maps beforeMCPExecution to an mcp tool name", () => {
  const message = toApprovalRequest({
    server: "user-Playwright",
    toolName: "browser_click",
    arguments: { selector: "#submit" }
  }, "beforeMCPExecution");

  assert.equal(message.type, "cursor_approval_request");
  assert.equal(message.tool, "mcp__user-Playwright__browser_click");
  assert.deepEqual(message.payload.arguments, { selector: "#submit" });
});

test("preserves the Shell tool name without remapping", () => {
  const message = toApprovalRequest({
    toolName: "Shell",
    toolInput: { command: "date" }
  }, "preToolUse");

  assert.equal(message.kind, "tool");
  assert.equal(message.tool, "Shell");
  assert.equal(isRiskyPreToolUse(message.tool), true);
});

test("detects low-risk tools", () => {
  assert.equal(isRiskyPreToolUse("ReadFile"), false);
  assert.equal(isRiskyPreToolUse("ApplyPatch"), true);
  assert.equal(isRiskyPreToolUse("mcp__server__tool"), true);
});

test("remembers path-based tools by project root", () => {
  const root = tempProject();
  assert.deepEqual(
    inferRuleScope({
      tool: "Write",
      command: path.join(root, "src", "file.js"),
      cwd: root
    }),
    { commandPrefix: "", pathPrefix: `${root}/` }
  );
});

test("prefers the target file's project root over Cursor hook cwd for path-based tools", () => {
  const root = tempProject();
  assert.deepEqual(
    inferRuleScope({
      tool: "Write",
      command: path.join(root, "src", "database.test.ts"),
      cwd: path.join(os.homedir(), ".cursor")
    }),
    { commandPrefix: "", pathPrefix: `${root}/` }
  );
});

test("extracts nested MultiEdit paths for project-scoped approvals", () => {
  const root = tempProject();
  const target = path.join(root, "src", "database.test.ts");
  const message = toApprovalRequest({
    toolName: "MultiEdit",
    toolInput: {
      edits: [
        {
          file_path: target,
          old_string: "old",
          new_string: "new"
        }
      ]
    },
    cwd: path.join(os.homedir(), ".cursor")
  }, "preToolUse");

  assert.equal(message.command, target);
  assert.deepEqual(
    inferRuleScope({
      tool: message.tool,
      command: message.command,
      cwd: message.cwd
    }),
    { commandPrefix: "", pathPrefix: `${root}/` }
  );
});

test("extracts ApplyPatch file paths from patch payloads for project-scoped approvals", () => {
  const root = tempProject();
  const target = path.join(root, "src", "file.js");
  const message = toApprovalRequest({
    toolName: "ApplyPatch",
    toolInput: {
      patch: `*** Begin Patch\n*** Update File: ${target}\n@@\n-old\n+new\n*** End Patch\n`
    },
    cwd: path.join(os.homedir(), ".cursor")
  }, "preToolUse");

  assert.equal(message.command, target);
  assert.deepEqual(
    inferRuleScope({
      tool: message.tool,
      command: message.command,
      cwd: message.cwd
    }),
    { commandPrefix: "", pathPrefix: `${root}/` }
  );
});

test("remembers shell approvals by the first two command tokens", () => {
  assert.deepEqual(
    inferRuleScope({
      tool: "Shell",
      command: "git push --force",
      cwd: "/Users/me/project"
    }),
    { commandPrefix: "git push", pathPrefix: "" }
  );
});

test("remembers package-manager shell approvals by command family", () => {
  assert.deepEqual(
    inferRuleScope({
      tool: "Shell",
      command: "pnpm rebuild sqlite3",
      cwd: "/Users/me/project"
    }),
    { commandPrefix: "pnpm", pathPrefix: "" }
  );
});

test("remembers MCP approvals by exact tool instead of argument JSON", () => {
  assert.deepEqual(
    inferRuleScope({
      tool: "mcp__update_doc_first",
      command: "{}",
      cwd: "/Users/me/project"
    }),
    { commandPrefix: "", pathPrefix: "", toolScope: true }
  );
});
