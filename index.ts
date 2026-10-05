import {
  DefaultPackageManager,
  getAgentDir,
  SettingsManager,
  VERSION,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  getUpdateOptions,
  isNewerVersion,
  type UpdateChoice,
  type UpdateInfo,
} from "./logic.ts";
import { restartSupport, type RestartSupport } from "./restart.ts";

const LATEST_VERSION_URL = "https://pi.dev/api/latest-version";
const CHECK_TIMEOUT_MS = 10_000;
const UPDATE_TIMEOUT_MS = 10 * 60_000;
const STATUS_ID = "startup-update";

async function getLatestPiVersion(): Promise<string | undefined> {
  if (process.env.PI_SKIP_VERSION_CHECK) return undefined;

  const response = await fetch(LATEST_VERSION_URL, {
    headers: { accept: "application/json", "User-Agent": `pi/${VERSION}` },
    signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
  });
  if (!response.ok) return undefined;

  const data = (await response.json()) as { version?: unknown };
  return typeof data.version === "string" &&
    isNewerVersion(data.version, VERSION)
    ? data.version.trim()
    : undefined;
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T | undefined> {
  // ponytail: this bounds startup waiting only; PackageManager has no AbortSignal API,
  // so a late read-only check may finish in the background.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function getAvailablePackages(ctx: ExtensionContext): Promise<string[]> {
  const agentDir = getAgentDir();
  const settingsManager = SettingsManager.create(ctx.cwd, agentDir, {
    projectTrusted: ctx.isProjectTrusted(),
  });
  const packageManager = new DefaultPackageManager({
    cwd: ctx.cwd,
    agentDir,
    settingsManager,
  });

  const updates = await withTimeout(
    packageManager.checkForAvailableUpdates(),
    CHECK_TIMEOUT_MS,
  );
  return updates
    ? [...new Set(updates.map((update) => update.displayName))]
    : [];
}

async function collectUpdates(ctx: ExtensionContext): Promise<UpdateInfo> {
  const [piVersion, packageNames] = await Promise.all([
    getLatestPiVersion().catch(() => undefined),
    getAvailablePackages(ctx).catch(() => []),
  ]);
  return { piVersion, packageNames };
}

function getUpdateArgs(
  choice: UpdateChoice,
  projectTrusted: boolean,
): string[] {
  const args = ["update"];
  if (choice === "all") args.push("--all");
  else if (choice === "pi") args.push("--self");
  else args.push("--extensions");

  if (choice !== "pi") args.push(projectTrusted ? "--approve" : "--no-approve");
  return args;
}

async function update(
  choice: UpdateChoice,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  restart: RestartSupport,
): Promise<void> {
  const restartPi = restart.prepare(ctx);
  const args = getUpdateArgs(choice, ctx.isProjectTrusted());
  ctx.ui.setStatus(STATUS_ID, `正在运行 pi ${args.slice(1).join(" ")}...`);

  try {
    const result = await pi.exec("pi", args, {
      cwd: ctx.cwd,
      timeout: UPDATE_TIMEOUT_MS,
    });
    if (result.killed || result.code !== 0) {
      const detail = (result.stderr || result.stdout)
        .trim()
        .split("\n")
        .slice(-3)
        .join(" ");
      ctx.ui.notify(
        `更新命令失败，Pi 或扩展可能已经部分更新。${detail ? ` ${detail}` : " 请稍后手动运行更新命令。"}`,
        "error",
      );
      return;
    }

  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(
      `更新命令失败，Pi 或扩展可能已经部分更新：${message}`,
      "error",
    );
    return;
  } finally {
    ctx.ui.setStatus(STATUS_ID, undefined);
  }

  if (!restartPi) {
    ctx.ui.notify("更新完成。当前环境不支持自动重启，请退出当前 pi 后重新运行 pi。", "warning");
    return;
  }
  ctx.ui.notify("更新完成，正在自动重启 Pi…", "info");
  try {
    await restartPi();
  } catch (error) {
    ctx.ui.notify(`更新已完成，但自动重启失败：${String(error)}。请手动重新运行 pi。`, "error");
  }
}

export default function (pi: ExtensionAPI, restart: RestartSupport = restartSupport) {
  pi.on("session_start", async (event, ctx) => {
    if (
      event.reason !== "startup" ||
      ctx.mode !== "tui" ||
      process.env.PI_OFFLINE
    )
      return;
    if (restart.consumeGuard()) return;

    const info = await collectUpdates(ctx);
    const options = getUpdateOptions(info, VERSION);
    if (options.length === 1) return;

    const details = [
      info.piVersion ? `Pi ${VERSION} → ${info.piVersion}` : "",
      info.packageNames.length > 0
        ? `扩展：${info.packageNames.join(", ")}`
        : "",
    ]
      .filter(Boolean)
      .join("；");
    const updateNote =
      info.packageNames.length > 0
        ? [
            "确认后将调用 Pi 内置更新命令；成功后自动重启 Pi。",
            "更新扩展时，会按配置中的包列表处理可更新包。",
            "固定到指定 Git 提交/标签（ref）的包不会升级，但本地 checkout 可能会切换到对应 ref。",
          ].join("\n")
        : "确认后将调用 Pi 内置更新命令；成功后自动重启 Pi。";
    const selected = await ctx.ui.select(
      `发现可用更新（${details}）。\n${updateNote}\n请选择：`,
      options.map((option) => option.label),
    );
    const choice = options.find((option) => option.label === selected)?.choice;
    if (choice && choice !== "skip") await update(choice, pi, ctx, restart);
  });
}
