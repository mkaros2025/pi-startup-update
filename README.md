# pi-startup-update

Ask whether to update Pi and its extensions when a TUI session starts.

The prompt is in Chinese. Requires Node.js 22.19 or newer.

## Install

```bash
pi install npm:pi-startup-update
```

Or install directly from GitHub:

```bash
pi install git:github.com/mkaros2025/pi-startup-update
```

## Behavior

- Checks for a newer stable Pi version and available package updates at startup.
- Runs only for an online TUI startup; `PI_OFFLINE=1` disables the check.
- Each check waits at most 10 seconds; failures and timeouts do not block startup further. A package check without cancellation may finish in the background.
- Lets you update Pi, extensions, everything, or skip.
- Uses Pi's built-in update commands and asks Pi to reconcile configured Git refs.
- Fixed Git commits or tags are not advanced to newer refs, though their local checkout may be switched to the configured ref.
- After a successful update, automatically restarts the Pi CLI on Linux/macOS, after terminal and extension cleanup. The replacement retains the foreground PID, terminal, working directory, and launch options.
- Resumes the exact session if it is already saved. Fresh or `--no-session` runs restart without attempting to open a nonexistent session file.
- Startup prompts/files are retained and submitted only by the replacement process. The replacement skips the update check once to avoid a restart loop.
- Failed or interrupted updates do not restart Pi. Unsupported hosts (including Windows, embedded SDK hosts, or runtimes without `process.execve`) stay open and show a manual-restart notice.

Set `PI_SKIP_VERSION_CHECK=1` to skip the Pi version check while still checking package updates.

## Development

```bash
npm install
npm run check
npm pack --dry-run
```

For an isolated real-CLI test (Linux/macOS, Python 3.12+):

```bash
python3 tests/pty-smoke.py
```

This packs and locally installs the package into temporary Pi profiles, uses a real terminal and process replacement, and mocks network/update commands. It tests regular/fullscreen terminals, saved and ephemeral sessions, startup prompts, and failed updates without contacting a model provider.

The extension imports Pi's core API as a peer dependency and requires Node.js 22.19 or newer.
