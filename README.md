# pi-startup-update

Ask whether to update Pi and its extensions when a TUI session starts.

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
- A failed or slow check does not block startup.
- Lets you update Pi, extensions, everything, or skip.
- Uses Pi's built-in update commands and asks Pi to reconcile configured Git refs.
- Fixed Git commits or tags are not advanced to newer refs, though their local checkout may be switched to the configured ref.
- Restart Pi after an update so the new version and extensions are loaded.

Set `PI_SKIP_VERSION_CHECK=1` to skip the Pi version check while still checking package updates.

## Development

```bash
npm install
npm run check
npm pack --dry-run
```

The extension imports Pi's core API as a peer dependency and requires Node.js 22.19 or newer.
