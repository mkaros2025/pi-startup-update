import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DefaultPackageManager,
  VERSION,
} from "@earendil-works/pi-coding-agent";
import extension from "./index.ts";
const originalPackageCheck =
  DefaultPackageManager.prototype.checkForAvailableUpdates;
const originalFetch = globalThis.fetch;
const originalEnv = new Map(
  ["PI_OFFLINE", "PI_SKIP_VERSION_CHECK", "PI_CODING_AGENT_DIR"].map((key) => [
    key,
    process.env[key],
  ]),
);

async function runScenario({
  latest = VERSION,
  packages = [],
  offline = false,
  packageError = false,
  fetchError = false,
  selection,
  execResult = { code: 0, killed: false, stdout: "", stderr: "" },
  trusted = false,
  mode = "tui",
  reason = "startup",
}) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-startup-update-cwd-"));
  const agentDir = await mkdtemp(join(tmpdir(), "pi-startup-update-agent-"));
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({ lastChangelogVersion: VERSION, packages: [] }),
  );
  process.env.PI_CODING_AGENT_DIR = agentDir;
  if (offline) process.env.PI_OFFLINE = "1";
  else delete process.env.PI_OFFLINE;
  delete process.env.PI_SKIP_VERSION_CHECK;

  globalThis.fetch = async () => {
    if (fetchError) throw new Error("network unavailable");
    return { ok: true, json: async () => ({ version: latest }) };
  };
  DefaultPackageManager.prototype.checkForAvailableUpdates = async () => {
    if (packageError) throw new Error("registry unavailable");
    return packages;
  };

  const handlers = {};
  const prompts = [];
  const notifications = [];
  const execCalls = [];
  const pi = {
    on(name, handler) {
      handlers[name] = handler;
    },
    exec: async (...args) => {
      execCalls.push(args);
      return execResult;
    },
  };
  extension(pi);

  await handlers.session_start(
    { reason },
    {
      mode,
      cwd,
      isProjectTrusted: () => trusted,
      ui: {
        select: async (title, options) => {
          prompts.push({ title, options });
          return typeof selection === "function"
            ? selection(options)
            : selection;
        },
        setStatus() {},
        notify: (message, type) => notifications.push({ message, type }),
      },
    },
  );

  return { prompts, notifications, execCalls };
}

try {
  let result = await runScenario({});
  assert.equal(result.prompts.length, 0, "no updates should not prompt");
  assert.equal(result.execCalls.length, 0);

  result = await runScenario({
    latest: "0.86.0",
    packages: [{ displayName: "fake-ext" }],
    selection: undefined,
  });
  assert.equal(result.prompts.length, 1, "available updates should prompt");
  assert.equal(result.execCalls.length, 0, "cancel should not update");

  result = await runScenario({
    offline: true,
    latest: "0.86.0",
    packages: [{ displayName: "fake-ext" }],
    selection: "anything",
    fetchError: true,
    packageError: true,
  });
  assert.equal(
    result.prompts.length,
    0,
    "offline mode should skip checks and prompts",
  );
  assert.equal(result.execCalls.length, 0);

  result = await runScenario({ fetchError: true, packageError: true });
  assert.equal(
    result.prompts.length,
    0,
    "check failures should not block startup with a prompt",
  );
  assert.equal(result.execCalls.length, 0);

  result = await runScenario({
    latest: "0.86.0",
    packages: [{ displayName: "fake-ext" }],
    selection: (options) =>
      options.find((label) => label.includes("只更新 Pi")),
    execResult: { code: 0, killed: false, stdout: "updated", stderr: "" },
  });
  assert.deepEqual(result.execCalls[0]?.slice(0, 2), [
    "pi",
    ["update", "--self"],
  ]);
  assert.match(result.notifications.at(-1)?.message ?? "", /重新运行 pi/);

  result = await runScenario({
    latest: VERSION,
    packages: [{ displayName: "fake-ext" }],
    selection: (options) => options[0],
    execResult: { code: 0, killed: false, stdout: "updated", stderr: "" },
  });
  assert.deepEqual(result.execCalls[0]?.slice(0, 2), [
    "pi",
    ["update", "--extensions", "--no-approve"],
  ]);

  result = await runScenario({
    latest: "0.86.0",
    packages: [{ displayName: "fake-ext" }],
    selection: (options) => options[0],
    trusted: false,
    execResult: {
      code: 1,
      killed: false,
      stdout: "",
      stderr: "simulated failure",
    },
  });
  assert.deepEqual(result.execCalls[0]?.slice(0, 2), [
    "pi",
    ["update", "--all", "--no-approve"],
  ]);
  assert.match(result.notifications.at(-1)?.message ?? "", /部分更新/);

  result = await runScenario({
    latest: "0.86.0",
    packages: [{ displayName: "fake-ext" }],
    selection: (options) => options[0],
    trusted: true,
    execResult: { code: 0, killed: false, stdout: "updated", stderr: "" },
  });
  assert.deepEqual(result.execCalls[0]?.slice(0, 2), [
    "pi",
    ["update", "--all", "--approve"],
  ]);

  result = await runScenario({
    latest: "0.86.0",
    packages: [{ displayName: "fake-ext" }],
    mode: "json",
    selection: (options) => options[0],
  });
  assert.equal(result.prompts.length, 0, "non-TUI mode should not prompt");
  assert.equal(result.execCalls.length, 0);

  result = await runScenario({
    latest: "0.86.0",
    packages: [{ displayName: "fake-ext" }],
    reason: "reload",
    selection: (options) => options[0],
  });
  assert.equal(result.prompts.length, 0, "reload should not prompt");
  assert.equal(result.execCalls.length, 0);

  console.log("startup-update integration: ok");
} finally {
  DefaultPackageManager.prototype.checkForAvailableUpdates =
    originalPackageCheck;
  globalThis.fetch = originalFetch;
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
