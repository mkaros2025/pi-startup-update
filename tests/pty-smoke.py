"""Real Pi + packed local installation + PTY; uses only Python's stdlib.

Updates and network checks are mocked, but process replacement, extension
loading, session restoration, shutdown cleanup and terminal input are real.
"""
import argparse
import errno
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import shutil
import signal
import struct
import subprocess
import tarfile
import tempfile
import termios
import time

ROOT = Path(__file__).resolve().parent.parent


def events(path):
    return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []


def scenario(base, package, pi, name, extra_args, resume=False, failure=False, prompt=False):
    case = base / name
    case.mkdir()
    agent = case / "agent"
    agent.mkdir()
    cwd = case / "project"
    cwd.mkdir()
    generation = case / "generation"
    generation.write_text("old")
    log = case / "events.jsonl"
    bin_dir = case / "bin"
    bin_dir.mkdir()
    fake_pi = bin_dir / "pi"
    fake_pi.write_text(f'''#!{shutil.which("node")}
const fs = require("node:fs");
fs.appendFileSync(process.env.TEST_EVENTS, JSON.stringify({{event:"update", args:process.argv.slice(2)}})+"\\n");
fs.writeFileSync(process.env.TEST_GENERATION, "new");
process.exit({1 if failure else 0});
''')
    fake_pi.chmod(0o755)
    env = dict(os.environ, PI_CODING_AGENT_DIR=str(agent), PI_OFFLINE="1",
               TEST_EVENTS=str(log), TEST_GENERATION=str(generation),
               PATH=str(bin_dir) + os.pathsep + os.environ["PATH"],
               OPENAI_API_KEY="isolated-test-key-never-used", TERM="xterm-256color")
    env.pop("PI_SKIP_VERSION_CHECK", None)
    env.pop("PI_STARTUP_UPDATE_RESTART_PID", None)
    version = subprocess.check_output([pi, "--version"], env=env, text=True).strip()
    (agent / "settings.json").write_text(json.dumps({
        "lastChangelogVersion": version, "defaultProvider": "openai",
        "defaultModel": "gpt-4o", "quietStartup": True,
    }))
    install = subprocess.run([pi, "install", str(package), "--no-approve"],
                             cwd=cwd, env=env, capture_output=True, text=True, timeout=30)
    assert install.returncode == 0, install.stderr
    configured = json.loads((agent / "settings.json").read_text())["packages"]
    assert any((agent / source).resolve() == package.resolve() for source in configured), configured
    if resume:
        session = case / "saved.jsonl"
        session.write_text(json.dumps({"type": "session", "version": 3,
            "id": "12345678-1234-4234-8234-123456789abc", "cwd": str(cwd),
            "timestamp": "2026-10-05T00:00:00.000Z"}) + "\n" + json.dumps({
                "type": "message", "id": "saved-user", "parentId": None,
                "timestamp": "2026-10-05T00:00:01.000Z", "message": {
                    "role": "user", "content": [{"type": "text", "text": "saved-history-marker"}],
                    "timestamp": 1791158401000}}) + "\n")
        extra_args = ["--session", str(session)] + extra_args
    args = [pi, "--offline", "--no-approve", "--no-skills", "--no-prompt-templates",
            "--no-context-files", "--extension", str(ROOT / "tests/fixture.ts")] + extra_args
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(cwd)
        os.execve(pi, args, env)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 140, 0, 0))
    transcript = bytearray()
    exited = False

    def pump():
        if select.select([fd], [], [], 0.1)[0]:
            try:
                transcript.extend(os.read(fd, 65536))
            except OSError as exc:
                if exc.errno != errno.EIO:
                    raise

    def wait_for(predicate, description):
        end = time.monotonic() + 20
        while time.monotonic() < end:
            pump()
            if predicate():
                return
        raise AssertionError(f"{name}: timed out waiting for {description}\n" + transcript.decode(errors="replace")[-6000:])

    try:
        wait_for(lambda: "请选择".encode() in transcript, "update selection")
        os.write(fd, b"\r")
        if failure:
            wait_for(lambda: "部分更新".encode() in transcript, "update failure notice")
            os.write(fd, b"/test-terminal\r")
            wait_for(lambda: any(e["event"] == "terminal-input" for e in events(log)), "original terminal input")
            os.write(fd, b"/quit\r")
        elif prompt:
            wait_for(lambda: any(e["event"] == "prompt" for e in events(log)), "replacement startup prompt")
        else:
            wait_for(lambda: len([e for e in events(log) if e["event"] == "startup"]) == 2, "replacement startup")
            # session_start precedes editor setup; let the replacement finish init.
            for _ in range(5):
                pump()
            os.write(fd, b"/test-terminal\r")
            wait_for(lambda: any(e["event"] == "terminal-input" for e in events(log)), "replacement terminal input")
            os.write(fd, b"/quit\r")
        end = time.monotonic() + 10
        while time.monotonic() < end:
            pump()
            found, status = os.waitpid(pid, os.WNOHANG)
            if found:
                exited = True
                assert os.waitstatus_to_exitcode(status) == 0, status
                break
        assert exited, f"{name}: Pi did not exit"
        data = events(log)
        starts = [e for e in data if e["event"] == "startup"]
        assert len(starts) == (1 if failure else 2), data
        if not failure:
            assert starts[0]["pid"] == starts[1]["pid"] == pid, starts
            assert starts[0]["generation"] == "old" and starts[1]["generation"] == "new", starts
            assert starts[1]["cwd"] == str(cwd) and starts[1]["trusted"] is False, starts
            assert data.index(next(e for e in data if e["event"] == "cleanup")) < data.index(starts[1]), data
        if resume:
            assert starts[-1]["session"] == str(session) and starts[-1]["history"], starts
            assert starts[0]["sessionId"] == starts[-1]["sessionId"], starts
        # Host checks are also mocked, so their global counts are not plugin
        # counts. Reaching terminal input / the prompt proves no second update
        # dialog blocked the replacement; there must be only one update.
        assert len([e for e in data if e["event"] == "update"]) == 1, data
        assert not any(e["event"] == "unexpected-provider-request" for e in data), data
        prompts = [e for e in data if e["event"] == "prompt"]
        if prompt:
            assert len(prompts) == 1 and prompts[0]["generation"] == "new", data
            assert prompts[0]["prompt"] == "startup-prompt-marker", data
        else:
            assert not prompts, data
        assert not b"Extension Errors" in transcript, transcript.decode(errors="replace")
        print(f"{name}: PASS", flush=True)
    finally:
        (case / "terminal.log").write_bytes(transcript)
        if not exited:
            os.kill(pid, signal.SIGTERM)
            time.sleep(1)
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            os.waitpid(pid, 0)
        os.close(fd)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--package", type=Path, help="Use an already installed package directory")
    parser.add_argument("--artifacts", type=Path)
    options = parser.parse_args()
    base = options.artifacts or Path(tempfile.mkdtemp(prefix="pi-startup-update-pty-"))
    base.mkdir(exist_ok=True, parents=True)
    print(f"Artifacts: {base}", flush=True)
    if options.package:
        package = options.package.resolve()
    else:
        result = subprocess.check_output(["npm", "pack", "--json", "--pack-destination", str(base)], cwd=ROOT, text=True)
        archive = base / json.loads(result)[0]["filename"]
        with tarfile.open(archive) as tar:
            tar.extractall(base, filter="data")
        package = base / "package"
    pi = shutil.which("pi")
    for name, extra, kwargs in [
        ("fresh-regular", ["--tui-mode", "regular"], {}),
        ("resume-fullscreen", ["--tui-mode", "fullscreen"], {"resume": True}),
        ("ephemeral", ["--no-session"], {}),
        ("startup-prompt", ["startup-prompt-marker"], {"prompt": True}),
        ("failed-update", [], {"failure": True}),
    ]:
        scenario(base, package, pi, name, extra, **kwargs)
    (base / "RESULTS.txt").write_text("PASS: packed install; fresh/regular; resume/fullscreen; ephemeral; startup prompt exactly once; failed update stays open; no provider calls.\n")


if __name__ == "__main__":
    main()
