import { existsSync, readFileSync, realpathSync, writeSync } from "node:fs";
import { resolve } from "node:path";
import { getPackageDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";

export const RESTART_GUARD = "PI_STARTUP_UPDATE_RESTART_PID";

// Match Pi's CLI value options, so a value such as "--continue" is not
// accidentally mistaken for a session selector. Unknown long options follow
// Pi's extension-flag parsing convention.
const VALUE_OPTIONS = new Set([
  "--provider", "--model", "--api-key", "--system-prompt",
  "--append-system-prompt", "--name", "-n", "--mode", "--session",
  "--session-id", "--fork", "--session-dir", "--models", "--tools", "-t",
  "--exclude-tools", "-xt", "--thinking", "--extension", "-e", "--skill",
  "--prompt-template", "--theme", "--use-theme", "--tui-mode", "--export",
]);
const BOOLEAN_OPTIONS = new Set([
  "--continue", "-c", "--resume", "-r", "--no-session", "--no-tools", "-nt",
  "--no-builtin-tools", "-nbt", "--no-extensions", "-ne", "--no-skills", "-ns",
  "--no-prompt-templates", "-np", "--no-themes", "--no-context-files", "-nc",
  "--verbose", "--approve", "-a", "--no-approve", "-na", "--offline",
  "--help", "-h", "--version", "-v",
]);
const SESSION_OPTIONS = new Set([
  "--continue", "-c", "--resume", "-r", "--session", "--session-id", "--fork",
]);

export function getRestartArgs(args: string[], sessionFile?: string): string[] {
  if (!sessionFile) return [...args];
  const result = ["--session", sessionFile];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      result.push(...args.slice(i));
      break;
    }
    const next = args[i + 1];
    const hasValue = VALUE_OPTIONS.has(arg) || (
      arg.startsWith("--") && !arg.includes("=") && !BOOLEAN_OPTIONS.has(arg) &&
      next !== undefined && !next.startsWith("-") && !next.startsWith("@")
    );
    if (!SESSION_OPTIONS.has(arg)) {
      result.push(arg);
      if (hasValue && next !== undefined) result.push(next);
    }
    if (hasValue) i++;
  }
  return result;
}

export interface RestartSupport {
  consumeGuard(): boolean;
  prepare(ctx: ExtensionContext): (() => Promise<void>) | undefined;
}

export function createRestartSupport(packageDir = getPackageDir()): RestartSupport {
  return {
    consumeGuard() {
      const guarded = process.env[RESTART_GUARD] === String(process.pid);
      // execve preserves the PID. Other Pi processes must not skip their check.
      delete process.env[RESTART_GUARD];
      return guarded;
    },
    prepare(ctx) {
      const execve = process.execve;
      const entry = process.argv[1];
      if (
        !execve || !["linux", "darwin"].includes(process.platform) ||
        !entry || !existsSync(entry) ||
        !existsSync(process.execPath)
      ) return undefined;
      const cli = resolve(entry);
      try {
        const manifest = JSON.parse(readFileSync(resolve(packageDir, "package.json"), "utf8"));
        if (manifest.name !== "@earendil-works/pi-coding-agent" ||
            typeof manifest.bin?.pi !== "string" ||
            realpathSync(cli) !== realpathSync(resolve(packageDir, manifest.bin.pi))) {
          return undefined;
        }
      } catch {
        return undefined;
      }

      const sessionFile = ctx.sessionManager.getSessionFile();
      // Fresh sessions have a planned filename but no file on disk yet.
      const args = getRestartArgs(
        process.argv.slice(2),
        sessionFile && existsSync(sessionFile) ? sessionFile : undefined,
      );
      const executable = process.execPath;
      const argv = [executable, ...process.execArgv, cli, ...args];
      const cwd = ctx.cwd;

      return async () => {
        let interrupted = false;
        const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
        const interrupt = () => { interrupted = true; };
        const removeSignalListeners = () => {
          for (const signal of signals) process.removeListener(signal, interrupt);
        };
        const onExit = (code: number) => {
          removeSignalListeners();
          if (code !== 0 || interrupted) return;
          try {
            const env = Object.fromEntries(
              Object.entries(process.env).filter((entry): entry is [string, string] =>
                entry[1] !== undefined),
            );
            env[RESTART_GUARD] = String(process.pid);
            process.chdir(cwd);
            // Pi has stopped its TUI and awaited ALL extension cleanup before
            // process.exit. Replacing here keeps the same foreground PID/TTY.
            execve(executable, argv, env);
          } catch (error) {
            writeSync(2, `Pi 更新成功，但自动重启失败：${String(error)}。请手动重新运行 pi。\n`);
          }
        };
        for (const signal of signals) process.on(signal, interrupt);
        process.once("exit", onExit);
        try {
          ctx.shutdown();
        } catch (error) {
          process.removeListener("exit", onExit);
          removeSignalListeners();
          throw error;
        }
        // Shutdown drains terminal input asynchronously. Hold session_start so
        // the old process cannot submit CLI prompts while it is shutting down.
        await new Promise<void>(() => {});
      };
    },
  };
}

export const restartSupport = createRestartSupport();
