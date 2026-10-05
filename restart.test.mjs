import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { getRestartArgs, RESTART_GUARD, restartSupport } from "./restart.ts";

assert.deepEqual(getRestartArgs(["--no-session", "hello"]), ["--no-session", "hello"]);
assert.deepEqual(getRestartArgs([
  "--model", "openai/test", "--continue", "--session", "old",
  "--session-id", "other", "--fork", "source", "--resume",
  "--session-dir", "/sessions", "--no-approve", "-e", "/extension.ts",
  "--system-prompt", "--continue", "--custom", "value",
  "@input.md", "hello", "--", "--fork", "literal",
], "/exact.jsonl"), [
  "--session", "/exact.jsonl", "--model", "openai/test",
  "--session-dir", "/sessions", "--no-approve", "-e", "/extension.ts",
  "--system-prompt", "--continue", "--custom", "value",
  "@input.md", "hello", "--", "--fork", "literal",
]);
assert.deepEqual(getRestartArgs(["-c", "-r", "--flag=true"], "/exact"), [
  "--session", "/exact", "--flag=true",
]);

const savedGuard = process.env[RESTART_GUARD];
const savedExecve = process.execve;
try {
  process.env[RESTART_GUARD] = String(process.pid);
  assert.equal(restartSupport.consumeGuard(), true);
  assert.equal(restartSupport.consumeGuard(), false);
  process.env[RESTART_GUARD] = "different-pid";
  assert.equal(restartSupport.consumeGuard(), false);
  assert.equal(restartSupport.prepare({}), undefined, "embedded/test host is unsupported");
  process.execve = undefined;
  assert.equal(restartSupport.prepare({}), undefined);
} finally {
  process.execve = savedExecve;
  if (savedGuard === undefined) delete process.env[RESTART_GUARD];
  else process.env[RESTART_GUARD] = savedGuard;
}

if (["linux", "darwin"].includes(process.platform) && process.execve) {
  const dir = await mkdtemp(join(tmpdir(), "pi-restart-process-"));
  try {
    const cli = join(dir, "cli.js");
    const log = join(dir, "events.jsonl");
    const session = join(dir, "session.jsonl");
    const launch = join(dir, "pi");
    await writeFile(join(dir, "package.json"), JSON.stringify({
      name: "@earendil-works/pi-coding-agent", type: "module", bin: { pi: "cli.js" },
    }));
    await symlink(cli, launch);
    await writeFile(session, "saved session\n");
    await writeFile(cli, `
      import { appendFileSync } from "node:fs";
      import { createRestartSupport } from ${JSON.stringify(new URL("./restart.ts", import.meta.url).href)};
      const restartSupport = createRestartSupport(process.env.TEST_PI_PACKAGE);
      const log = (event) => appendFileSync(process.env.TEST_LOG, JSON.stringify({event, pid:process.pid, argv:process.argv.slice(2), cwd:process.cwd()})+"\\n");
      if (restartSupport.consumeGuard()) {
        log("replacement");
        if (restartSupport.consumeGuard()) throw new Error("guard was not consumed");
      } else {
        log("original");
        if (process.env.TEST_THROW) process.execve = () => { throw new Error("simulated execve failure"); };
        const restart = restartSupport.prepare({
          cwd:process.env.TEST_CWD,
          sessionManager:{getSessionFile:()=>process.env.TEST_SESSION},
          shutdown:()=>{
            if (process.env.TEST_SIGNAL) setTimeout(()=>process.emit("SIGTERM"),5);
            setTimeout(()=>{log("cleanup"); process.exit(Number(process.env.TEST_EXIT || 0));},30);
          },
        });
        if (!restart) throw new Error("restart was not prepared");
        await restart();
        log("incorrect-old-prompt");
      }
    `);
    const run = async (extraEnv, args = ["--continue", "--model", "test", "hello"]) => {
      await writeFile(log, "");
      const result = spawnSync(process.execPath, ["--experimental-strip-types", launch, ...args], {
        env: { ...process.env, TEST_PI_PACKAGE: dir, TEST_LOG: log, TEST_CWD: dir, TEST_SESSION: session, ...extraEnv },
        encoding: "utf8", timeout: 5000,
      });
      const events = (await readFile(log, "utf8")).trim().split("\n").map(JSON.parse);
      return { result, events };
    };
    let { result, events } = await run({});
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(events.map(e => e.event), ["original", "cleanup", "replacement"]);
    assert.equal(events[0].pid, events[2].pid, "execve retains foreground PID");
    assert.equal(events[2].cwd, dir);
    assert.deepEqual(events[2].argv, ["--session", session, "--model", "test", "hello"]);

    ({ result, events } = await run({ TEST_SESSION: join(dir, "not-yet-created") }, ["--no-session"]));
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(events[2].argv, ["--no-session"]);

    ({ result, events } = await run({ TEST_EXIT: "1" }));
    assert.equal(result.status, 1);
    assert.deepEqual(events.map(e => e.event), ["original", "cleanup"]);

    ({ result, events } = await run({ TEST_SIGNAL: "1" }));
    assert.equal(result.status, 0);
    assert.deepEqual(events.map(e => e.event), ["original", "cleanup"], "termination cancels restart");

    ({ result, events } = await run({ TEST_THROW: "1" }));
    assert.equal(result.status, 0);
    assert.match(result.stderr, /更新成功.*自动重启失败.*simulated execve failure/);
    assert.deepEqual(events.map(e => e.event), ["original", "cleanup"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
console.log("startup-update restart (including real execve): ok");
