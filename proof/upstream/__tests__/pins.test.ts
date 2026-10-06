import { execFile } from "node:child_process";
import {
	chmod,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";

const exec = promisify(execFile);
const WORKTREE = resolve(import.meta.dirname, "..", "..", "..");
const SCRIPT = join(WORKTREE, "proof", "upstream", "pins.mjs");

let root: string;
let env: NodeJS.ProcessEnv;

async function git(cwd: string, ...args: string[]) {
	const { stdout } = await exec("git", args, { cwd, env });
	return stdout.trim();
}

let counter = 0;

/**
 * One commit writing `files` onto `branch` of the bare repository `bare`,
 * after `parent` where the branch has a head, made by a single `git
 * fast-import` (a clone, an add, a commit and a push are a process each);
 * resolves the commit.
 */
async function commit(
	bare: string,
	branch: string,
	files: Record<string, string>,
	parent?: string,
) {
	const data = (text: string) => `data ${Buffer.byteLength(text)}\n${text}\n`;
	const stream = [
		`commit refs/heads/${branch}\nmark :1\ncommitter test <test@example.org> now\n`,
		data(`change ${counter}`),
		parent ? `from ${parent}\n` : "",
		...Object.entries(files).map(
			([path, text]) => `M 100644 inline ${path}\n${data(text)}`,
		),
	].join("");
	const marks = join(root, "fast-import.marks");
	const importing = exec(
		"git",
		[
			"--git-dir",
			bare,
			"fast-import",
			"--quiet",
			"--date-format=now",
			`--export-marks=${marks}`,
		],
		{ env },
	);
	importing.child.stdin?.end(stream);
	await importing;
	return (await readFile(marks, "utf8")).trim().split(" ")[1];
}

/** A bare repository standing in for an upstream, its default branch advanced a commit at a time. */
async function upstream(name: string, branch: string) {
	const bare = join(root, `${name}.git`);
	await git(root, "init", "--quiet", "--bare", "-b", branch, bare);
	let head: string | undefined;
	const advance = async () => {
		counter += 1;
		head = await commit(bare, branch, { "change.txt": `${counter}\n` }, head);
		return head;
	};
	return { bare, branch, advance };
}

const tabbed = (value: unknown) => `${JSON.stringify(value, null, "\t")}\n`;

/** `value` as one word of a POSIX shell command. */
const quoted = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

interface Lane {
	checkout: string;
	origin: string;
	hq: Awaited<ReturnType<typeof upstream>>;
	core: Awaited<ReturnType<typeof upstream>>;
	ghLog: string;
	ghState: string;
}

/**
 * Nova's origin with main holding pins at each upstream's first commit, a
 * committed surface and one entry naming one item, and a checkout of main as
 * actions/checkout leaves it; plus a `gh` on PATH that records every call and
 * answers `pr list` and `pr create` from a state file.
 */
async function lane(): Promise<Lane> {
	const hq = await upstream("hq", "master");
	const core = await upstream("core", "main");
	const hqCommit = await hq.advance();
	const coreCommit = await core.advance();

	const origin = join(root, "nova.git");
	await git(root, "init", "--quiet", "--bare", "-b", "main", origin);
	await commit(origin, "main", {
		"proof/pins.json": tabbed({
			"commcare-hq": {
				repository: `file://${hq.bare}`,
				defaultBranch: "master",
				commit: hqCommit,
			},
			"commcare-core": {
				repository: `file://${core.bare}`,
				defaultBranch: "main",
				commit: coreCommit,
			},
		}),
		"lib/commcare/surface/surface.json": tabbed({
			items: {
				"toggle:GONE": { tag: "frozen" },
				"toggle:KEPT": { tag: "frozen", namespaces: ["domain"] },
				"appearance:minimal": { reads: [{ file: "select.js", line: 10 }] },
				"format:date": { filters: { width: 2, align: "left" } },
			},
		}),
		"lib/commcare/surface/entries/gates.json": tabbed([
			{ id: "toggle/KEPT", surfaceKeys: ["toggle:KEPT"], kind: "toggle" },
		]),
	});

	const checkout = join(root, "checkout");
	await git(root, "clone", "--quiet", "--branch", "main", origin, checkout);

	const bin = join(root, "bin");
	await mkdir(bin);
	const ghLog = join(root, "gh-calls");
	await mkdir(ghLog);
	const ghState = join(root, "gh-state.json");
	await writeFile(ghState, "[]");
	// A shell script, so a call starts no interpreter beyond the shell: call n
	// keeps its arguments, each ended by a NUL, in <n>.args and the body file it
	// names in <n>.body.
	await writeFile(
		join(bin, "gh"),
		`#!/bin/sh
calls=${quoted(ghLog)}
state=${quoted(ghState)}
n=0
while [ -e "$calls/$n.args" ]; do n=$((n + 1)); done
printf '%s\\0' "$@" > "$calls/$n.args"
previous=
for argument in "$@"; do
	if [ "$previous" = --body-file ]; then cp "$argument" "$calls/$n.body"; fi
	previous=$argument
done
case "$1 $2" in
"pr list") read -r held < "$state"; printf '%s' "$held" ;;
"pr create")
	printf '[{"number":7}]' > "$state"
	echo https://github.com/voidcraft-labs/commcare-nova/pull/7 ;;
esac
`,
	);
	await chmod(join(bin, "gh"), 0o755);
	env = { ...env, PATH: `${bin}:${process.env.PATH}` };
	return { checkout, origin, hq, core, ghLog, ghState };
}

async function stage(checkout: string, ...args: string[]) {
	const { stdout } = await exec(process.execPath, [SCRIPT, ...args], {
		cwd: checkout,
		env,
	});
	return JSON.parse(stdout);
}

/** Each call the `gh` stub recorded, in order: its arguments and the body file it named. */
async function ghCalls(
	log: string,
): Promise<{ args: string[]; body: string | null }[]> {
	const names = await readdir(log);
	const count = names.filter((name) => name.endsWith(".args")).length;
	const read = (name: string) => readFile(join(log, name), "utf8");
	return Promise.all(
		Array.from({ length: count }, async (_, n) => ({
			args: (await read(`${n}.args`)).split("\0").slice(0, -1),
			body: names.includes(`${n}.body`) ? await read(`${n}.body`) : null,
		})),
	);
}

/** The files the pin branch's one commit changes, relative to main. */
async function branchCommit(origin: string) {
	const mainHead = await git(origin, "rev-parse", "main");
	const branchParent = await git(origin, "rev-parse", "upstream/pins^");
	const files = await git(
		origin,
		"diff",
		"--name-only",
		"main",
		"upstream/pins",
	);
	return { onMain: branchParent === mainHead, files: files.split("\n").sort() };
}

async function surfaceFile(items: Record<string, unknown>) {
	const path = join(root, "new-surface.json");
	await writeFile(path, tabbed({ items }));
	return path;
}

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "upstream-pins-"));
	counter = 0;
	env = {
		...process.env,
		GIT_AUTHOR_NAME: "test",
		GIT_AUTHOR_EMAIL: "test@example.org",
		GIT_COMMITTER_NAME: "test",
		GIT_COMMITTER_EMAIL: "test@example.org",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_NOSYSTEM: "1",
	};
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("the plan stage", () => {
	it("does nothing when no upstream moved past the pins", async () => {
		const { checkout, origin, ghLog } = await lane();
		expect(await stage(checkout, "plan")).toMatchObject({ action: "none" });
		expect(await git(origin, "branch", "--list", "upstream/pins")).toBe("");
		expect(await ghCalls(ghLog)).toEqual([]);
	});

	it("commits the moved heads to the pin branch as one commit on main", async () => {
		const { checkout, origin, hq } = await lane();
		const head = await hq.advance();
		const planned = await stage(checkout, "plan");
		expect(planned.action).toBe("update");
		expect(planned.pins["commcare-hq"].commit).toBe(head);
		expect(await branchCommit(origin)).toEqual({
			onMain: true,
			files: ["proof/pins.json"],
		});
		const pinned = JSON.parse(
			await git(origin, "show", "upstream/pins:proof/pins.json"),
		);
		expect(pinned["commcare-hq"].commit).toBe(head);
	});

	it("leaves the open pull request as it is when its branch already carries the heads", async () => {
		const { checkout, origin, hq, ghState } = await lane();
		await hq.advance();
		await stage(checkout, "plan");
		await writeFile(ghState, JSON.stringify([{ number: 7 }]));
		const branchBefore = await git(origin, "rev-parse", "upstream/pins");
		// The next week's run, which plans from main.
		await git(checkout, "checkout", "--quiet", "main");
		expect(await stage(checkout, "plan")).toMatchObject({
			action: "none",
			reason: "the open pin pull request already carries these heads",
		});
		expect(await git(origin, "rev-parse", "upstream/pins")).toBe(branchBefore);
	});

	it("plans the heads again when their branch has no open pull request, as after a failed report", async () => {
		const { checkout, origin, hq } = await lane();
		const head = await hq.advance();
		await stage(checkout, "plan");
		await git(checkout, "checkout", "--quiet", "main");
		const planned = await stage(checkout, "plan");
		expect(planned.action).toBe("update");
		expect(planned.pins["commcare-hq"].commit).toBe(head);
		expect(await branchCommit(origin)).toEqual({
			onMain: true,
			files: ["proof/pins.json"],
		});
	});
});

describe("the report stage", () => {
	it("commits pins, lock and surface together, opens the one pull request and says how CI starts", async () => {
		const { checkout, origin, hq, ghLog } = await lane();
		const head = await hq.advance();
		await stage(checkout, "plan");
		// A change inside a list of objects is a change; the same object with its keys reordered is not.
		const surface = await surfaceFile({
			"toggle:KEPT": { tag: "deprecated", namespaces: ["domain"] },
			"toggle:NEW": { tag: "frozen" },
			"appearance:minimal": { reads: [{ file: "select.js", line: 12 }] },
			"format:date": { filters: { align: "left", width: 2 } },
		});
		const digest = `sha256:${"b".repeat(64)}`;
		const reported = await stage(
			checkout,
			"report",
			"--image-result",
			"success",
			"--digest",
			digest,
			"--surface-result",
			"success",
			"--surface",
			surface,
			"--run-url",
			"https://example.org/run/1",
			"--reviewer",
			"a-reviewer",
			"--date",
			"2026-10-05",
		);
		expect(reported.number).toBe("7");

		expect(await branchCommit(origin)).toEqual({
			onMain: true,
			files: [
				"lib/commcare/surface/surface.json",
				"proof/image.lock",
				"proof/pins.json",
			],
		});
		const lock = JSON.parse(
			await git(origin, "show", "upstream/pins:proof/image.lock"),
		);
		expect(lock.image).toBe(
			`ghcr.io/voidcraft-labs/commcare-nova-proof@${digest}`,
		);
		expect(lock.pins["commcare-hq"]).toBe(head);

		const calls = await ghCalls(ghLog);
		const created = calls.find((c) => c.args[1] === "create");
		expect(created?.body).toContain("Latest run: 2026-10-05");
		expect(created?.body).toContain(
			"## Surface: 1 added, 1 removed, 2 changed",
		);
		expect(created?.body).toContain(
			"- `appearance:minimal` (reads): no entry names it",
		);
		expect(created?.body).not.toContain("format:date");
		expect(created?.body).toContain("- `toggle:NEW`");
		expect(created?.body).toContain("- `toggle:GONE`: no entry names it");
		expect(created?.body).toContain(
			"- `toggle:KEPT` (tag): `toggle/KEPT` (toggle)",
		);
		expect(calls.map((c) => c.args)).toContainEqual([
			"pr",
			"edit",
			"7",
			"--add-reviewer",
			"a-reviewer",
		]);
		// GitHub holds the pull request's own CI for a person; a run dispatched on the branch would be hidden by it.
		expect(created?.body).toContain(
			"CI starts when you approve its run on this pull request or update the branch",
		);
		expect(calls.map((c) => c.args[0])).not.toContain("workflow");
	});

	it("updates the open pull request in place rather than opening another", async () => {
		const { checkout, hq, ghLog, ghState } = await lane();
		await writeFile(ghState, JSON.stringify([{ number: 7 }]));
		await hq.advance();
		await stage(checkout, "plan");
		await stage(
			checkout,
			"report",
			"--image-result",
			"success",
			"--digest",
			`sha256:${"c".repeat(64)}`,
			"--surface-result",
			"success",
			"--surface",
			await surfaceFile({
				"toggle:KEPT": { tag: "frozen", namespaces: ["domain"] },
			}),
			"--run-url",
			"https://example.org/run/2",
		);
		const calls = await ghCalls(ghLog);
		expect(calls.some((c) => c.args[1] === "create")).toBe(false);
		expect(
			calls.find((c) => c.args[1] === "edit" && c.args.includes("--body-file"))
				?.args[2],
		).toBe("7");
	});

	it("still updates the pull request with the failed step and the pins alone when the image build fails", async () => {
		const { checkout, origin, hq, ghLog } = await lane();
		await hq.advance();
		await stage(checkout, "plan");
		await stage(
			checkout,
			"report",
			"--image-result",
			"failure",
			"--digest",
			"",
			"--surface-result",
			"skipped",
			"--surface",
			join(root, "missing.json"),
			"--run-url",
			"https://example.org/run/3",
		);
		expect(await branchCommit(origin)).toEqual({
			onMain: true,
			files: ["proof/pins.json"],
		});
		const calls = await ghCalls(ghLog);
		const created = calls.find((c) => c.args[1] === "create");
		expect(created?.body).toContain("the image build did not succeed");
		expect(created?.body).toContain("https://example.org/run/3");
		expect(created?.body).toContain(
			"CI starts when you approve its run on this pull request or update the branch, and is red until",
		);
		expect(calls.map((c) => c.args[0])).not.toContain("workflow");
	});
});

describe("the workflow", () => {
	it("grants each job only what it needs, never merges, and reports even when a build step fails", async () => {
		const workflow = parse(
			await readFile(
				join(WORKTREE, ".github/workflows/upstream-pins.yml"),
				"utf8",
			),
		);
		expect(workflow.permissions).toEqual({});
		const granted = new Set(
			Object.values(workflow.jobs).flatMap((job) =>
				Object.entries(
					(job as { permissions?: Record<string, string> }).permissions ?? {},
				)
					.filter(([, level]) => level === "write")
					.map(([scope]) => scope),
			),
		);
		expect([...granted].sort()).toEqual([
			"contents",
			"packages",
			"pull-requests",
		]);
		expect(workflow.jobs.surface.permissions).toEqual({ contents: "read" });
		expect(workflow.jobs.report.if).toContain("always()");
		expect(JSON.stringify(workflow)).not.toMatch(/pr merge|\/merge/);
	});
});
