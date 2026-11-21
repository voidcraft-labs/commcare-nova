import { execFile } from "node:child_process";
import {
	chmod,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";

const exec = promisify(execFile);
const WORKTREE = resolve(import.meta.dirname, "..", "..", "..");
const SCRIPT = join(WORKTREE, "proof", "upstream", "pins.mjs");

// Every case builds bare git repositories and runs a stage as a subprocess
// with its own git commands: seconds each on a shared runner, where the
// default five would decide by the runner's load.
vi.setConfig({ testTimeout: 30_000 });

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
			pins: { "commcare-hq": hqCommit, "commcare-core": coreCommit },
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
		// The retained trees: a base whose stored app the new pins change and whose stale answer they drop, and a
		// group of reads they leave as it is.
		"proof/hq-apps/hq-plain/app.json": tabbed({ version: 1 }),
		"proof/hq-apps/hq-plain/stale.json": tabbed({ status: 200 }),
		"proof/hq-reads/publish/source-live.json": tabbed({ status: 200 }),
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

async function surfaceFile(checkout: string, items: Record<string, unknown>) {
	const planned: Record<string, { commit: string }> = JSON.parse(
		await readFile(join(checkout, "proof/pins.json"), "utf8"),
	);
	const pins = Object.fromEntries(
		Object.entries(planned).map(([name, pin]) => [name, pin.commit]),
	);
	const path = join(root, "new-surface.json");
	await writeFile(path, tabbed({ pins, items }));
	return path;
}

const ADOPTED = [
	"Adopted 2 directories of proof/hq-apps/.",
	"Adopted 1 directory of proof/hq-reads/.",
	"hq-new-app: new.",
	"hq-plain: its stored app and its answers changed.",
	"hq-plain: Nova's reading of it changed.",
];

/**
 * The artifact the retained job uploads, as the report job downloads it: the
 * trees as adopt left them in its checkout, and the adopt report beside them.
 */
async function retainedArtifact() {
	const directory = join(root, "upstream-retained");
	const files: Record<string, string> = {
		"hq-apps/hq-plain/app.json": tabbed({ version: 2 }),
		"hq-apps/hq-new-app/app.json": tabbed({ version: 1 }),
		"hq-reads/publish/source-live.json": tabbed({ status: 200 }),
		"adopt-report.txt": `${ADOPTED.join("\n")}\n`,
	};
	for (const [path, text] of Object.entries(files)) {
		await mkdir(join(directory, path, ".."), { recursive: true });
		await writeFile(join(directory, path), text);
	}
	return directory;
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
		expect(planned.base).toBe(await git(origin, "rev-parse", "main"));
		expect(planned.commit).toBe(
			await git(origin, "rev-parse", "upstream/pins"),
		);
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

describe("using the candidate's pin data in a trusted checkout", () => {
	it("applies only the pin data and gives downstream builds the candidate identity", async () => {
		const { checkout, origin, hq } = await lane();
		await hq.advance();
		const { base, commit, pins } = await stage(checkout, "plan");
		await git(checkout, "checkout", "--quiet", "main");
		expect(await stage(checkout, "apply", commit)).toEqual({ base, commit });
		expect(await git(checkout, "rev-parse", "HEAD")).toBe(commit);
		expect(await git(checkout, "rev-parse", "main")).toBe(base);
		expect(await git(checkout, "status", "--porcelain")).toBe("");
		expect(
			JSON.parse(await readFile(join(checkout, "proof/pins.json"), "utf8")),
		).toEqual(pins);
		expect(await branchCommit(origin)).toEqual({
			onMain: true,
			files: ["proof/pins.json"],
		});
	});

	it("refuses a different base, another file, and changed upstream configuration before changing the checkout", async () => {
		const { checkout, origin, hq } = await lane();
		await hq.advance();
		const planned = await stage(checkout, "plan");
		await git(checkout, "checkout", "--quiet", "main");
		const changedPins = { "proof/pins.json": tabbed(planned.pins) };
		const cases = [
			[
				await commit(
					origin,
					"different-base",
					{ "notes.txt": "A later commit." },
					planned.commit,
				),
				"only parent",
			],
			[
				await commit(
					origin,
					"another-file",
					{ ...changedPins, "notes.txt": "Release notes." },
					planned.base,
				),
				"only the regular file",
			],
			[
				await commit(
					origin,
					"different-config",
					{
						"proof/pins.json": tabbed({
							...planned.pins,
							"commcare-hq": {
								...planned.pins["commcare-hq"],
								defaultBranch: "stable",
							},
						}),
					},
					planned.base,
				),
				"upstream commit SHAs only",
			],
		];
		for (const [candidate, reason] of cases) {
			await expect(stage(checkout, "apply", candidate)).rejects.toThrow(reason);
			expect(await git(checkout, "rev-parse", "HEAD")).toBe(planned.base);
			expect(await git(checkout, "status", "--porcelain")).toBe("");
		}
	});
});

describe("the report stage", () => {
	it("keeps the pins alone when the surface came from the previous image", async () => {
		const { checkout, origin, hq } = await lane();
		const previous = await surfaceFile(checkout, {});
		await hq.advance();
		await stage(checkout, "plan");
		await expect(
			stage(
				checkout,
				"report",
				"--image-result",
				"success",
				"--surface-result",
				"success",
				"--surface",
				previous,
			),
		).rejects.toThrow("different upstream commits");
		expect((await branchCommit(origin)).files).toEqual(["proof/pins.json"]);
	});

	it("preserves a branch that advanced while the candidate was running", async () => {
		const { checkout, origin, hq, ghLog } = await lane();
		await hq.advance();
		const planned = await stage(checkout, "plan");
		const updated = await commit(
			origin,
			"upstream/pins",
			{ "review.txt": "reviewed\n" },
			planned.commit,
		);
		await expect(stage(checkout, "report")).rejects.toThrow(
			"The pin branch moved",
		);
		expect(await git(origin, "rev-parse", "upstream/pins")).toBe(updated);
		expect(
			(await ghCalls(ghLog)).some(
				(call) => call.args[1] === "create" || call.args[1] === "edit",
			),
		).toBe(false);
	});

	it("commits pins, lock, surface and retained trees together, opens the one pull request and says how CI starts", async () => {
		const { checkout, origin, hq, ghLog } = await lane();
		const head = await hq.advance();
		await stage(checkout, "plan");
		// A change inside a list of objects is a change; the same object with its keys reordered is not.
		const surface = await surfaceFile(checkout, {
			"toggle:KEPT": { tag: "deprecated", namespaces: ["domain"] },
			"toggle:NEW": { tag: "frozen" },
			"appearance:minimal": {
				reads: [{ file: "select.js", line: 12 }],
				"display units": "kg",
			},
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
			"--retained-result",
			"success",
			"--retained",
			await retainedArtifact(),
			"--run-url",
			"https://example.org/run/1",
			"--reviewer",
			"a-reviewer",
			"--date",
			"2026-10-05",
		);
		expect(reported.number).toBe("7");
		expect(reported.retained).toBe(true);

		// The unchanged group is no change; the answer adopt dropped is removed, not left behind; the report is no file.
		expect(await branchCommit(origin)).toEqual({
			onMain: true,
			files: [
				"lib/commcare/surface/surface.json",
				"proof/hq-apps/hq-new-app/app.json",
				"proof/hq-apps/hq-plain/app.json",
				"proof/hq-apps/hq-plain/stale.json",
				"proof/image.lock",
				"proof/pins.json",
			],
		});
		expect(
			JSON.parse(
				await git(
					origin,
					"show",
					"upstream/pins:proof/hq-apps/hq-plain/app.json",
				),
			),
		).toEqual({ version: 2 });
		expect(
			await git(
				origin,
				"ls-tree",
				"-r",
				"--name-only",
				"upstream/pins",
				"proof/hq-apps/hq-plain",
			),
		).toBe("proof/hq-apps/hq-plain/app.json");
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
			"- `appearance:minimal` (`display units`, reads): no entry names it",
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
		expect(created?.body).toContain("## Retained HQ answers and apps");
		for (const line of ADOPTED) {
			expect(created?.body).toContain(`- ${line}`);
		}
		expect(calls.map((c) => c.args[0])).not.toContain("workflow");
	});

	it("commits the lock and surface with main's retained trees, and names the retained job, when that job fails", async () => {
		const { checkout, origin, hq, ghLog } = await lane();
		await hq.advance();
		await stage(checkout, "plan");
		const reported = await stage(
			checkout,
			"report",
			"--image-result",
			"success",
			"--digest",
			`sha256:${"d".repeat(64)}`,
			"--surface-result",
			"success",
			"--surface",
			await surfaceFile(checkout, {
				"toggle:KEPT": { tag: "frozen", namespaces: ["domain"] },
			}),
			"--retained-result",
			"failure",
			// The workflow names the download's directory whatever the job's result; nothing is downloaded there.
			"--retained",
			join(root, "upstream-retained"),
			"--run-url",
			"https://example.org/run/4",
		);
		expect(reported.retained).toBe(false);
		expect(await branchCommit(origin)).toEqual({
			onMain: true,
			files: [
				"lib/commcare/surface/surface.json",
				"proof/image.lock",
				"proof/pins.json",
			],
		});
		const created = (await ghCalls(ghLog)).find((c) => c.args[1] === "create");
		expect(created?.body).toContain(
			"the retained HQ answers and apps were not made again, so CI, which starts when you approve its run on this pull request or update the branch, holds main's to the new pins",
		);
		expect(created?.body).toContain(
			"did not succeed (its result: failure), so the branch carries main's",
		);
	});

	it("leaves the retained trees out with the lock when the surface fails, whatever the retained job did", async () => {
		const { checkout, origin, hq, ghLog } = await lane();
		await hq.advance();
		await stage(checkout, "plan");
		await stage(
			checkout,
			"report",
			"--image-result",
			"success",
			"--digest",
			`sha256:${"e".repeat(64)}`,
			"--surface-result",
			"failure",
			"--surface",
			join(root, "missing.json"),
			"--retained-result",
			"success",
			"--retained",
			await retainedArtifact(),
			"--run-url",
			"https://example.org/run/5",
		);
		expect(await branchCommit(origin)).toEqual({
			onMain: true,
			files: ["proof/pins.json"],
		});
		const created = (await ghCalls(ghLog)).find((c) => c.args[1] === "create");
		expect(created?.body).toContain("the surface extraction did not succeed");
		expect(created?.body).not.toContain("## Retained HQ answers and apps");
	});

	// The report job holds the write token, so an artifact is read there as data: a refused one is handled as its
	// job failing (main's trees, or the pins alone for the surface), the description says which was refused and
	// nothing the artifact named, and the stage ends red once the pull request is updated.
	async function reportRefused(checkout: string, ...args: string[]) {
		return exec(process.execPath, [SCRIPT, "report", ...args], {
			cwd: checkout,
			env,
		}).then(
			() => {
				throw new Error("The report stage succeeded over a refused artifact.");
			},
			(error: { code: number; stderr: string }) => error,
		);
	}

	it.each([
		["a test-named file", "hq-reads/publish/x.test.ts", "export {};\n"],
		["a hidden file", "hq-apps/hq-plain/.gitattributes", "* -diff\n"],
		[
			"a report line that is not adopt's",
			"adopt-report.txt",
			"hq-plain: see [this](https://example.org).\n",
		],
	])(
		"commits main's retained trees and names the refusal when the artifact holds %s",
		async (_, path, text) => {
			const { checkout, origin, hq, ghLog } = await lane();
			await hq.advance();
			await stage(checkout, "plan");
			const artifact = await retainedArtifact();
			await writeFile(join(artifact, path), text);
			const refused = await reportRefused(
				checkout,
				"--image-result",
				"success",
				"--digest",
				`sha256:${"c".repeat(64)}`,
				"--surface-result",
				"success",
				"--surface",
				await surfaceFile(checkout, {
					"toggle:KEPT": { tag: "frozen", namespaces: ["domain"] },
				}),
				"--retained-result",
				"success",
				"--retained",
				artifact,
				"--run-url",
				"https://example.org/run/6",
			);
			expect(refused.code).toBe(1);
			expect(refused.stderr).toContain("Pull request #7 is updated");
			expect(await branchCommit(origin)).toEqual({
				onMain: true,
				files: [
					"lib/commcare/surface/surface.json",
					"proof/image.lock",
					"proof/pins.json",
				],
			});
			const created = (await ghCalls(ghLog)).find(
				(c) => c.args[1] === "create",
			);
			expect(created?.body).toContain(
				"The retained trees this run made were not committed",
			);
			expect(created?.body).toContain("this run made were refused");
			expect(created?.body).not.toContain("example.org)");
			expect(created?.body).not.toContain("x.test.ts");
			for (const line of ADOPTED) {
				expect(created?.body).not.toContain(`- ${line}`);
			}
		},
	);

	it("commits the pins alone and names the refusal when the surface artifact is a link", async () => {
		const { checkout, origin, hq, ghLog } = await lane();
		await hq.advance();
		await stage(checkout, "plan");
		const target = await surfaceFile(checkout, {
			"toggle:KEPT": { tag: "frozen" },
		});
		const linked = join(root, "linked-surface.json");
		await symlink(target, linked);
		const refused = await reportRefused(
			checkout,
			"--image-result",
			"success",
			"--digest",
			`sha256:${"f".repeat(64)}`,
			"--surface-result",
			"success",
			"--surface",
			linked,
			"--retained-result",
			"success",
			"--retained",
			await retainedArtifact(),
			"--run-url",
			"https://example.org/run/7",
		);
		expect(refused.code).toBe(1);
		expect(refused.stderr).toContain("is a link");
		expect(await branchCommit(origin)).toEqual({
			onMain: true,
			files: ["proof/pins.json"],
		});
		const created = (await ghCalls(ghLog)).find((c) => c.args[1] === "create");
		expect(created?.body).toContain(
			"the surface the extraction made was refused",
		);
		expect(created?.body).not.toContain("## Retained HQ answers and apps");
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
			await surfaceFile(checkout, {
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
			"CI, which starts when you approve its run on this pull request or update the branch, is red until",
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
			"issues",
			"packages",
			"pull-requests",
		]);
		// The image build's call alone carries the issues scope, and only because a call's grant bounds every
		// job of the workflow it calls: there, one job asks for it, the report of that workflow's own weekly
		// comparison, which a call for a ref never reaches.
		const withIssues = Object.entries(workflow.jobs)
			.filter(
				([, job]) =>
					(job as { permissions?: Record<string, string> }).permissions
						?.issues === "write",
			)
			.map(([name]) => name);
		expect(withIssues).toEqual(["image"]);
		const image = parse(
			await readFile(
				join(WORKTREE, ".github/workflows/proof-image.yml"),
				"utf8",
			),
		);
		const asking = Object.entries(image.jobs)
			.filter(
				([, job]) =>
					(job as { permissions?: Record<string, string> }).permissions
						?.issues === "write",
			)
			.map(([name]) => name);
		expect(asking).toEqual(["report"]);
		expect(image.jobs.report.if).toContain("inputs.ref == ''");
		expect(workflow.jobs.surface.permissions).toEqual({ contents: "read" });
		expect(workflow.jobs.retained.permissions).toEqual({ contents: "read" });
		expect(workflow.jobs.report.if).toContain("always()");
		const planned = `\${{ needs.plan.outputs.commit }}`;
		const source = `\${{ github.sha }}`;
		const apply = 'node proof/upstream/pins.mjs apply "$PIN_COMMIT"';
		expect(workflow.jobs.plan.steps[0].if).toContain(
			"github.ref != 'refs/heads/main'",
		);
		expect(workflow.jobs.plan.steps[0].run).toContain("exit 1");
		expect(workflow.jobs.plan.steps[1].with.ref).toBe(source);
		for (const job of [
			workflow.jobs.image,
			workflow.jobs.prewarm,
			workflow.jobs.readers,
		]) {
			expect(job.with.ref).toBe(source);
			expect(job.with["pin-candidate"]).toBe(planned);
		}
		const lane = parse(
			await readFile(
				join(WORKTREE, ".github/workflows/proof-lane.yml"),
				"utf8",
			),
		);
		for (const job of [
			image.jobs.build,
			image.jobs.publish,
			lane.jobs.emit,
			lane.jobs.shard,
			lane.jobs.gate,
			lane.jobs["android-runtime"],
		]) {
			// The hosted shard starts its work clock before checking out any repository code.
			const checkout = job === lane.jobs.shard ? 1 : 0;
			expect(job.steps[checkout].uses).toMatch(/^actions\/checkout@/);
			expect(job.steps[checkout].with.ref).toBe(
				`\${{ inputs.ref || github.sha }}`,
			);
			expect(job.steps[checkout + 1].env.PIN_COMMIT).toBe(
				`\${{ inputs.pin-candidate }}`,
			);
			expect(job.steps[checkout + 1].run).toBe(apply);
		}
		for (const job of [workflow.jobs.surface, workflow.jobs.retained]) {
			expect(job.needs).toContain("plan");
			expect(job.steps[0].with.ref).toBe(source);
			expect(job.steps[1].env.PIN_COMMIT).toBe(planned);
			expect(job.steps[1].run).toBe(apply);
		}
		const { steps } = workflow.jobs.report;
		expect(steps[0].with.ref).toBe(source);
		expect(steps[1].with.ref).toBe(source);
		expect(steps[2].env.PIN_COMMIT).toBe(planned);
		expect(steps[2].run).toContain(
			'node "$GITHUB_WORKSPACE/proof/upstream/pins.mjs" apply "$PIN_COMMIT"',
		);
		expect(steps[1].with.path).toBe(steps.at(-1)["working-directory"]);
		expect(steps.at(-1).run).toContain(
			'node "$GITHUB_WORKSPACE/proof/upstream/pins.mjs" report',
		);
		expect(JSON.stringify(workflow)).not.toMatch(/pr merge|\/merge/);
	});

	// The retained trees travel from the job that makes them to the two lanes and the commit by one artifact. The
	// plausible failures: a lane that checks main's trees while the pull request carries new ones (or the reverse),
	// a prewarm skipped because the retained job failed though its tree is still the pull request's, and a report
	// that reads a directory nothing downloaded into.
	it("hands the retained trees to both lanes and the report wherever the retained job made them", async () => {
		const expression = (text: string) => `\${{ ${text} }}`;
		const workflow = parse(
			await readFile(
				join(WORKTREE, ".github/workflows/upstream-pins.yml"),
				"utf8",
			),
		);
		const { retained, prewarm, readers, report } = workflow.jobs;
		expect(retained.needs).toContain("image");
		const given = expression(
			"needs.retained.result == 'success' && 'upstream-retained' || ''",
		);
		for (const lane of [prewarm, readers]) {
			expect(lane.needs).toContain("retained");
			expect(lane.with.retained).toBe(given);
			expect(lane.with.surface).toBe("upstream-surface");
			// Run on the image and the surface alone: main's trees are the pull request's where the job failed.
			expect(lane.if).toContain("!cancelled()");
			expect(lane.if).not.toContain("needs.retained");
		}
		const upload = retained.steps.find(
			(step: { with?: { name?: string } }) =>
				step.with?.name === "upstream-retained",
		);
		expect(upload.uses).toMatch(/^actions\/upload-artifact@/);
		expect(upload.with["if-no-files-found"]).toBe("error");
		const staging = expression("runner.temp");
		expect(upload.with.path).toBe(`${staging}/upstream-retained/`);
		const adopt = retained.steps.find((step: { run?: string }) =>
			step.run?.includes("python3 -m proof.matrix.adopt"),
		).run;
		expect(adopt).toContain('--report --corpus "$RUNNER_TEMP/corpus"');
		expect(adopt).toContain('> "$RUNNER_TEMP/adopt/adopt-report.txt"');
		expect(adopt).toContain(
			'python3 -m proof.matrix.place pack proof "$RUNNER_TEMP/upstream-retained"',
		);
		expect(adopt).toContain('--report "$RUNNER_TEMP/adopt/adopt-report.txt"');
		expect(report.needs).toContain("retained");
		const download = report.steps.find(
			(step: { with?: { name?: string } }) =>
				step.with?.name === "upstream-retained",
		);
		expect(download.uses).toMatch(/^actions\/download-artifact@/);
		expect(download.if).toBe(expression("needs.retained.result == 'success'"));
		expect(download.with.path).toBe(`${staging}/upstream-retained`);
		const reporting = report.steps.at(-1);
		expect(reporting.env.RETAINED_RESULT).toBe(
			expression("needs.retained.result"),
		);
		expect(reporting.run).toContain('--retained-result "$RETAINED_RESULT"');
		expect(reporting.run).toContain(
			'--retained "$RUNNER_TEMP/upstream-retained"',
		);
	});

	// What a container or another job wrote is data. The plausible failures: an upload that follows a link a
	// container left (upload-artifact follows links), a hidden file carried into the artifact, and a run's raw
	// output uploaded before anything sealed it.
	it("carries no hidden file and uploads a run's output only once it is sealed", async () => {
		const workflow = parse(
			await readFile(
				join(WORKTREE, ".github/workflows/upstream-pins.yml"),
				"utf8",
			),
		);
		const steps = Object.values(workflow.jobs).flatMap(
			(job) => (job as { steps?: Record<string, never>[] }).steps ?? [],
		) as {
			uses?: string;
			run?: string;
			with?: Record<string, unknown>;
		}[];
		const uploads = steps.filter((step) =>
			step.uses?.startsWith("actions/upload-artifact@"),
		);
		expect(uploads.length).toBeGreaterThan(0);
		for (const upload of uploads) {
			expect(upload.with?.["include-hidden-files"]).toBeUndefined();
		}
		const retained = workflow.jobs.retained.steps as {
			id?: string;
			if?: string;
			run?: string;
			with?: { name?: string };
		}[];
		const raw = retained.findIndex(
			(step) => step.with?.name === "upstream-retained-run",
		);
		const sealing = retained.findIndex(
			(step) =>
				step.run === 'node proof/run.mjs --seal "$RUNNER_TEMP/retained-out"',
		);
		expect(sealing).toBeGreaterThan(-1);
		expect(sealing).toBeLessThan(
			retained.findIndex((step) =>
				step.run?.includes("python3 -m proof.matrix.adopt"),
			),
		);
		expect(sealing).toBeLessThan(raw);
		expect(retained[raw].if).toContain(
			`steps.${retained[sealing].id}.outcome == 'success'`,
		);
	});

	// The run's own shell, executed as written over a controlled `node`: each test writes what HQ made before it
	// compares, so the checks' failing verdict (1) must go on to adopt, and a server that failed mid-run must not.
	it("adopts after the retained tests' failing verdict and stops on the server's own failure", async () => {
		const workflow = parse(
			await readFile(
				join(WORKTREE, ".github/workflows/upstream-pins.yml"),
				"utf8",
			),
		);
		const step = workflow.jobs.retained.steps.find(
			(candidate: { name?: string }) =>
				candidate.name === "Run the tests that write what HQ made",
		);
		expect(step.env.PROOF_READERS).toBe("0");
		const bin = join(root, "bin");
		await mkdir(bin);
		const calls = join(root, "node-calls");
		await writeFile(
			join(bin, "node"),
			`#!/bin/sh\nprintf '%s\\n' "$@" > ${quoted(calls)}\nexit "$STATUS"\n`,
		);
		await chmod(join(bin, "node"), 0o755);
		for (const [status, expected] of [
			[0, 0],
			[1, 0],
			[2, 2],
			[3, 3],
			// proof/run.mjs's own refusal of an output holding anything but plain files.
			[6, 6],
		]) {
			const code = await exec("bash", ["-e", "-c", step.run], {
				cwd: root,
				env: {
					...env,
					PATH: `${bin}:${process.env.PATH}`,
					STATUS: String(status),
				},
			}).then(
				() => 0,
				(error: { code: number }) => error.code,
			);
			expect(code, `node exited ${status}`).toBe(expected);
		}
		expect((await readFile(calls, "utf8")).trim().split("\n")).toEqual([
			"proof/run.mjs",
			"proof/matrix/test_retained.py",
			"proof/hq/test_retained_reads.py",
			"proof/editors/test_retained_reads.py",
		]);
	});
});
