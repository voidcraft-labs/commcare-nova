"""A command the harness runs leaves nothing behind, however it ends.

Contract: ``proof.processes.run`` returns, or raises ``TimedOut``, only once
every process the command started is stopped and reaped, whether the command
finished or ran past its deadline. The plausible failure: a child its leader
never waits for, as node never waits for the esbuild service every
``node --import tsx`` starts, left running past a stopped command, or left
unreaped (a zombie of the harness, its subreaper) after a finished one. A
bare ``subprocess.run`` leaves it both ways.

The command is a Node script that starts two children the way esbuild's
Node API starts its service (``esbuild/lib/main.js::ensureServiceIsRunning``:
standard input and output piped, the child and both pipes unreferenced, so
node exits without waiting for it): one that ends when its standard input
closes, as the service does once node is gone, and one that keeps running.
It prints its own pid, its children and the two services' pids as one JSON
line, then exits, or keeps running until it is stopped; the deadline is made
to pass once that line has been read, so the whole tree is running when the
stop comes. It needs nothing but node, so it runs where the lane mounts no
``node_modules`` (a CI shard) as well as where it does.
"""

import json
import os
import select
import subprocess
import time
from pathlib import Path

import pytest

from proof import processes

WORKTREE = Path(__file__).resolve().parents[1]
NODE = ["node"]
# Bounds a command that hangs before its report.
REPORT_DEADLINE_SECONDS = 120

PROBE = """
import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";

// A child started as esbuild's Node API starts its service: piped, and
// unreferenced along with its pipes, so node never waits for it.
function service(script) {
	const child = spawn(process.execPath, ["-e", script], { stdio: ["pipe", "pipe", "inherit"] });
	child.unref();
	child.stdin.unref?.();
	child.stdout.unref?.();
	return child.pid;
}

const services = [
	// Ends when its standard input closes, as the esbuild service does.
	service("process.stdin.resume(); process.stdin.on('end', () => process.exit(0));"),
	// Keeps running whatever happens to its parent.
	service("process.stdin.resume(); setInterval(() => {}, 1 << 30);"),
];

const children = [];
for (const entry of readdirSync("/proc")) {
	let stat;
	try {
		stat = readFileSync(`/proc/${entry}/stat`, "utf8");
	} catch {
		continue;
	}
	const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
	if (Number(fields[1]) === process.pid) {
		children.push({
			pid: Number(entry),
			name: stat.slice(stat.indexOf("(") + 1, stat.lastIndexOf(")")),
			group: Number(fields[2]),
		});
	}
}
process.stdout.write(`${JSON.stringify({ pid: process.pid, children, services })}\\n`);
if (process.argv[2] === "hold") setInterval(() => {}, 1 << 30);
"""


def _members(group):
    """Every process still in ``group``, running or waiting to be reaped: pid -> (state, name)."""
    found = {}
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        try:
            stat = Path("/proc", entry, "stat").read_text()
        except OSError:
            continue  # it exited while the listing was read
        fields = stat[stat.rindex(")") + 2 :].split()
        if int(fields[2]) == group:
            found[int(entry)] = (fields[0], stat[stat.index("(") + 1 : stat.rindex(")")])
    return found


def _probe(tmp_path):
    script = tmp_path / "probe.mjs"
    script.write_text(PROBE)
    return script


def _services(report):
    """The probe's two services, running as its children in its own process group when it reported."""
    children = {child["pid"]: child for child in report["children"]}
    assert len(report["services"]) == 2 and set(report["services"]) <= set(children), (
        f"The probe's services were not its running children when it reported, so this test shows nothing: {report}"
    )
    assert all(child["group"] == report["pid"] for child in report["children"]), report
    return [children[pid] for pid in report["services"]]


def _read_report(output, exited):
    """The probe's JSON line from the pipe ``output``, or what ended the reading first."""
    poller = select.poll()
    poller.register(output, select.POLLIN)
    poller.register(exited, select.POLLIN)
    deadline = time.monotonic() + REPORT_DEADLINE_SECONDS
    seen = b""
    while b"\n" not in seen:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return None, f"no report within {REPORT_DEADLINE_SECONDS} s"
        ready = {fd for fd, _ in poller.poll(int(remaining * 1000) + 1)}
        if output in ready:
            seen += os.read(output, 65536)
        elif exited in ready:
            return None, f"node exited before it reported, having written {seen!r}"
    return json.loads(seen.split(b"\n", 1)[0]), None


def test_a_finished_command_leaves_nothing_behind(tmp_path):
    output = tmp_path / "output"
    messages = tmp_path / "messages"
    with output.open("wb") as stdout, messages.open("wb") as stderr:
        status = processes.run(
            [*NODE, str(_probe(tmp_path))], timeout=REPORT_DEADLINE_SECONDS, cwd=WORKTREE, stdout=stdout, stderr=stderr
        )
    assert status == 0, messages.read_text(errors="replace")
    report = json.loads(output.read_text().splitlines()[0])
    _services(report)
    assert not _members(report["pid"]), f"The finished command left processes behind: {_members(report['pid'])}"


def test_a_command_past_its_deadline_is_stopped_whole(tmp_path, monkeypatch):
    read_end, write_end = os.pipe()
    observed = {}

    def deadline_once_reported(group, timeout):
        observed["report"], observed["missed"] = _read_report(read_end, group.fileno())
        observed["members"] = _members(group.group)
        return False

    monkeypatch.setattr(processes.ProcessGroup, "wait", deadline_once_reported)
    try:
        with (
            open(write_end, "wb") as stdout,
            (tmp_path / "messages").open("wb") as stderr,
            pytest.raises(processes.TimedOut, match="was stopped, with every process it started"),
        ):
            processes.run(
                [*NODE, str(_probe(tmp_path)), "hold"],
                timeout=REPORT_DEADLINE_SECONDS,
                cwd=WORKTREE,
                stdout=stdout,
                stderr=stderr,
            )
    finally:
        os.close(read_end)
    assert observed, "run() never waited on the command's process group, so nothing stopped the group."
    assert observed["missed"] is None, (
        f"The probe never reported ({observed['missed']}): {(tmp_path / 'messages').read_text(errors='replace')}"
    )
    report = observed["report"]
    running = {pid for pid, (state, _) in observed["members"].items() if state != "Z"}
    assert {report["pid"], *(child["pid"] for child in _services(report))} <= running, observed["members"]
    assert not _members(report["pid"]), f"The stopped command left processes behind: {_members(report['pid'])}"


def test_a_process_group_writes_to_files_only(tmp_path):
    """Nothing drains a pipe while the command runs, so a pipe is refused before anything starts."""
    for stream in ("stdin", "stdout", "stderr"):
        with pytest.raises(ValueError, match="nothing would drain a pipe"):
            processes.ProcessGroup(["true"], **{stream: subprocess.PIPE})
    with processes.ProcessGroup(["true"], stdout=subprocess.DEVNULL) as group:
        assert group.wait(REPORT_DEADLINE_SECONDS)
    assert group.returncode == 0
