import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DefaultPackageManager,
  VERSION,
} from "@earendil-works/pi-coding-agent";
import extension from "./index.ts";

const NEXT_VERSION = VERSION.replace(
  /\d+$/,
  (patch) => String(Number(patch) + 1),
);
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
  skipVersionCheck = false,
  execError = false,
  selection,
  execResult = { code: 0, killed: false, stdout: "", stderr: "" },
  trusted = false,
  mode = "tui",
  reason = "startup",
}) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-startup-update-cwd-"));
  const agentDir = await mkdtemp(join(tmpdir(), "pi-startup-update-agent-"));
  const fetchCalls = [];
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({ lastChangelogVersion: VERSION, packages: [] }),
  );
  process.env.PI_CODING_AGENT_DIR = agentDir;
  if (offline) process.env.PI_OFFLINE = "1";
  else delete process.env.PI_OFFLINE;
  if (skipVersionCheck) process.env.PI_SKIP_VERSION_CHECK = "1";
  else delete process.env.PI_SKIP_VERSION_CHECK;

  globalThis.fetch = async () => {
    fetchCalls.push(true);
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
  const statuses = [];
  const pi = {
    on(name, handler) {
      handlers[name] = handler;
    },
    exec: async (...args) => {
      execCalls.push(args);
      if (execError) throw new Error("simulated exec failure");
      return execResult;
    },
  };
  extension(pi);

  try {
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
          setStatus: (id, value) => statuses.push({ id, value }),
          notify: (message, type) => notifications.push({ message, type }),
        },
      },
    );
  } finally {
    await Promise.all([
      rm(cwd, { recursive: true, force: true }),
      rm(agentDir, { recursive: true, force: true }),
    ]);
  }

  return { prompts, notifications, execCalls, statuses, fetchCalls };
}

try {
  let result = await runScenario({});
  assert.equal(result.prompts.length, 0, "no updates should not prompt");
  assert.equal(result.execCalls.length, 0);

  result = await runScenario({
    latest: NEXT_VERSION,
    packages: [{ displayName: "fake-ext" }],
    selection: undefined,
  });
  assert.equal(result.prompts.length, 1, "available updates should prompt");
  assert.ok(
    (result.prompts[0]?.title ?? "").includes(
      [
        "确认后将调用 Pi 内置更新命令。",
        "更新扩展时，会按配置中的包列表处理可更新包。",
        "固定到指定 Git 提交/标签（ref）的包不会升级，但本地 checkout 可能会切换到对应 ref。",
      ].join("\n"),
    ),
    "extension prompt should explain Git ref behavior",
  );
  assert.equal(result.execCalls.length, 0, "cancel should not update");

  result = await runScenario({
    latest: NEXT_VERSION,
    packages: [{ displayName: "fake-ext" }],
    selection: "暂不更新",
  });
  assert.equal(result.execCalls.length, 0, "explicit skip should not update");
  assert.equal(result.notifications.length, 0, "explicit skip should be quiet");

  result = await runScenario({
    offline: true,
    latest: NEXT_VERSION,
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

  result = await runScenario({
    skipVersionCheck: true,
    latest: NEXT_VERSION,
  });
  assert.equal(result.fetchCalls.length, 0, "version check should be skipped");
  assert.equal(result.prompts.length, 0, "no package updates should not prompt");

  result = await runScenario({ fetchError: true, packageError: true });
  assert.equal(
    result.prompts.length,
    0,
    "check failures should not block startup with a prompt",
  );
  assert.equal(result.execCalls.length, 0);

  result = await runScenario({
    latest: NEXT_VERSION,
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
  assert.deepEqual(result.statuses.at(-1), {
    id: "startup-update",
    value: undefined,
  });

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
    latest: NEXT_VERSION,
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
  assert.deepEqual(result.statuses.at(-1), {
    id: "startup-update",
    value: undefined,
  });

  result = await runScenario({
    latest: NEXT_VERSION,
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
    latest: NEXT_VERSION,
    packages: [{ displayName: "fake-ext" }],
    selection: (options) => options[0],
    execResult: {
      code: 0,
      killed: true,
      stdout: "",
      stderr: "terminated",
    },
  });
  assert.match(result.notifications.at(-1)?.message ?? "", /部分更新/);
  assert.deepEqual(result.statuses.at(-1), {
    id: "startup-update",
    value: undefined,
  });

  result = await runScenario({
    latest: NEXT_VERSION,
    packages: [{ displayName: "fake-ext" }],
    selection: (options) => options[0],
    execError: true,
  });
  assert.match(result.notifications.at(-1)?.message ?? "", /simulated exec failure/);
  assert.deepEqual(result.statuses.at(-1), {
    id: "startup-update",
    value: undefined,
  });

  result = await runScenario({
    latest: NEXT_VERSION,
    packages: [{ displayName: "fake-ext" }],
    mode: "json",
    selection: (options) => options[0],
  });
  assert.equal(result.prompts.length, 0, "non-TUI mode should not prompt");
  assert.equal(result.execCalls.length, 0);

  result = await runScenario({
    latest: NEXT_VERSION,
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
