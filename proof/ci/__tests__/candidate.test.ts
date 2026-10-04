// proof/ci/candidate.mjs records a candidate image in a checkout's lock, so a
// lane run of the candidate (the pin pull request's prewarm) keys its records
// as the pin pull request's own run will. The contract is agreement with what
// the pull request carries: the lock proof/upstream/pins.mjs::report commits
// to upstream/pins. The plausible failure is a prewarm whose lock differs from
// it (another image, the old pins, other bytes), so every record it saved is
// keyed where the pull request never looks. So the oracle here is report
// itself, run against local repositories and a controlled `gh`, and the
// store's cache names (proof/ci/store-keys.mjs) read from both locks.

import { execFile } from "node:child_process";
import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, it } from "vitest";
import { CI } from "./scripts";

const exec = promisify(execFile);
const WORKTREE = resolve(CI, "..", "..");
const PINS_SCRIPT = join(WORKTREE, "proof", "upstream", "pins.mjs");
const IMAGE = "ghcr.io/voidcraft-labs/commcare-nova-proof";

let root: string;
let env: NodeJS.ProcessEnv;

const tabbed = (value: unknown) => `${JSON.stringify(value, null, "\t")}\n`;

async function git(cwd: string, ...args: string[]) {
	const { stdout } = await exec("git", args, { cwd, env });
	return stdout.trim();
}

async function commitTo(work: string, branch: string, file: string) {
	await writeFile(join(work, file), `${Math.random()}\n`);
	await git(work, "add", file);
	await git(work, "commit", "--quiet", "-m", file);
	await git(work, "push", "--quiet", "origin", branch);
	return git(work, "rev-parse", "HEAD");
}

/**
 * Nova's origin with main pinning one upstream at its first commit, the
 * upstream moved one commit past it, and a `gh` on PATH that answers what
 * report asks; returns a checkout of main and the origin.
 */
async function pinLane() {
	const upstream = join(root, "hq.git");
	await git(root, "init", "--quiet", "--bare", "-b", "master", upstream);
	const upstreamWork = join(root, "hq-work");
	await git(root, "clone", "--quiet", upstream, upstreamWork);
	await git(upstreamWork, "checkout", "--quiet", "-b", "master");
	const pinned = await commitTo(upstreamWork, "master", "a.txt");

	const origin = join(root, "nova.git");
	await git(root, "init", "--quiet", "--bare", "-b", "main", origin);
	const seed = join(root, "nova-seed");
	await git(root, "clone", "--quiet", origin, seed);
	await git(seed, "checkout", "--quiet", "-b", "main");
	await mkdir(join(seed, "proof"), { recursive: true });
	await mkdir(join(seed, "lib/commcare/surface/entries"), { recursive: true });
	await writeFile(
		join(seed, "proof/pins.json"),
		tabbed({
			"commcare-hq": {
				repository: `file://${upstream}`,
				defaultBranch: "master",
				commit: pinned,
			},
		}),
	);
	await writeFile(
		join(seed, "proof/image.lock"),
		tabbed({
			image: `${IMAGE}@sha256:${"a".repeat(64)}`,
			pins: { "commcare-hq": pinned },
		}),
	);
	await writeFile(
		join(seed, "lib/commcare/surface/surface.json"),
		tabbed({ items: {} }),
	);
	await writeFile(
		join(seed, "lib/commcare/surface/entries/gates.json"),
		"[]\n",
	);
	await git(seed, "add", ".");
	await git(seed, "commit", "--quiet", "-m", "main");
	await git(seed, "push", "--quiet", "origin", "main");
	const head = await commitTo(upstreamWork, "master", "b.txt");

	const bin = join(root, "bin");
	await mkdir(bin);
	await writeFile(
		join(bin, "gh"),
		`#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "pr" && args[1] === "list") process.stdout.write("[]");
if (args[0] === "pr" && args[1] === "create") process.stdout.write("https://github.com/o/r/pull/7\\n");
`,
	);
	await chmod(join(bin, "gh"), 0o755);
	env = { ...env, PATH: `${bin}:${process.env.PATH}` };

	const checkout = join(root, "checkout");
	await git(root, "clone", "--quiet", "--branch", "main", origin, checkout);
	return { origin, checkout, head };
}

function candidate(args: string[], cwd: string) {
	return exec(process.execPath, [join(CI, "candidate.mjs"), ...args], {
		cwd,
		env,
	});
}

async function cacheNames(lock: string) {
	const { stdout } = await exec(
		process.execPath,
		[join(CI, "store-keys.mjs"), "--arch", "arm64", "--lock", lock],
		{
			env: {
				NODE_ENV: "test",
				PATH: process.env.PATH ?? "",
				GITHUB_EVENT_NAME: "pull_request",
				PROOF_PULL_REQUEST: "7",
				GITHUB_RUN_ID: "1",
			},
		},
	);
	return stdout;
}

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "proof-ci-candidate-"));
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

it("writes the lock the pin pull request commits for the candidate, so the prewarm's keys are the pull request's", async () => {
	const { origin, checkout, head } = await pinLane();
	await exec(process.execPath, [PINS_SCRIPT, "plan"], { cwd: checkout, env });

	// The prewarm's view: the pin branch as plan pushed it, before report.
	const prewarm = join(root, "prewarm");
	await git(
		root,
		"clone",
		"--quiet",
		"--branch",
		"upstream/pins",
		origin,
		prewarm,
	);
	const digest = `sha256:${"c".repeat(64)}`;
	const { stdout } = await candidate(
		["--image", `${IMAGE}@${digest}`],
		prewarm,
	);
	const written = await readFile(join(prewarm, "proof/image.lock"), "utf8");
	expect(stdout).toBe(written);

	const surface = join(root, "surface.json");
	await writeFile(surface, tabbed({ items: {} }));
	await exec(
		process.execPath,
		[
			PINS_SCRIPT,
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
		],
		{ cwd: checkout, env },
	);
	const committed = await git(origin, "show", "upstream/pins:proof/image.lock");
	expect(written).toBe(`${committed}\n`);
	expect(JSON.parse(written).pins["commcare-hq"]).toBe(head);

	const pulled = join(root, "pull-request");
	await git(
		root,
		"clone",
		"--quiet",
		"--branch",
		"upstream/pins",
		origin,
		pulled,
	);
	expect(await cacheNames(join(prewarm, "proof/image.lock"))).toBe(
		await cacheNames(join(pulled, "proof/image.lock")),
	);
	expect(await cacheNames(join(prewarm, "proof/image.lock"))).toContain(
		"main=proof-store-arm64-cccccccccccccccc-main-",
	);
	// And the repository's own lock check accepts it.
	await exec(process.execPath, [
		join(WORKTREE, "scripts/ci/check-proof-image-lock.mjs"),
		prewarm,
	]);
});

it("refuses an image not pinned by digest, and pins it cannot read, leaving the lock as it was", async () => {
	const checkout = join(root, "checkout");
	await mkdir(join(checkout, "proof"), { recursive: true });
	const before = tabbed({
		image: `${IMAGE}@sha256:${"a".repeat(64)}`,
		pins: {},
	});
	await writeFile(join(checkout, "proof/image.lock"), before);
	await writeFile(
		join(checkout, "proof/pins.json"),
		tabbed({ "commcare-hq": { commit: "f".repeat(40) } }),
	);

	await expect(
		candidate(["--image", `${IMAGE}:latest`], checkout),
	).rejects.toMatchObject({
		code: 2,
		stderr: expect.stringContaining("pinned by its digest"),
	});
	await writeFile(
		join(checkout, "proof/pins.json"),
		tabbed({ "commcare-hq": { commit: "main" } }),
	);
	await expect(
		candidate(["--image", `${IMAGE}@sha256:${"b".repeat(64)}`], checkout),
	).rejects.toMatchObject({
		code: 2,
		stderr: expect.stringContaining("not a 40-digit commit"),
	});
	expect(await readFile(join(checkout, "proof/image.lock"), "utf8")).toBe(
		before,
	);
});
