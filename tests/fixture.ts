// Isolated PTY test only: never load this in a personal Pi session.
import { appendFileSync, readFileSync } from "node:fs";
import { DefaultPackageManager, VERSION, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  const generation = readFileSync(process.env.TEST_GENERATION!, "utf8").trim();
  const log = (event: string, extra = {}) => appendFileSync(process.env.TEST_EVENTS!,
    JSON.stringify({ event, generation, pid: process.pid, ...extra }) + "\n");
  // --offline still controls the host's startup network work. Allow only this
  // extension's mocked checks; no actual updates or provider requests are made.
  delete process.env.PI_OFFLINE;
  globalThis.fetch = async () => {
    log("version-check");
    return { ok: true, json: async () => ({ version: VERSION }) } as Response;
  };
  DefaultPackageManager.prototype.checkForAvailableUpdates = async () => {
    log("package-check");
    return [{ displayName: "test-extension" }] as any;
  };
  pi.on("session_start", (_event, ctx) => {
    log("startup", {
      cwd: ctx.cwd, mode: ctx.mode, trusted: ctx.isProjectTrusted(),
      session: ctx.sessionManager.getSessionFile(),
      sessionId: ctx.sessionManager.getSessionId(),
      history: ctx.sessionManager.getEntries().some((entry) =>
        JSON.stringify(entry).includes("saved-history-marker")),
    });
  });
  pi.on("session_shutdown", async (event) => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    log("cleanup", { reason: event.reason });
  });
  pi.on("before_agent_start", async (event, ctx) => {
    log("prompt", { prompt: event.prompt });
    ctx.shutdown();
    await new Promise(() => {}); // Do not send anything to a model.
  });
  pi.on("before_provider_request", () => {
    log("unexpected-provider-request");
    throw new Error("The PTY test must never call a provider");
  });
  pi.registerCommand("test-terminal", {
    description: "Verify replacement terminal input",
    handler: async (_args, ctx) => {
      log("terminal-input");
      ctx.ui.notify("TERMINAL_INPUT_OK", "info");
    },
  });
}
