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

/** A commit of `file` on the repository's checked-out branch, made in place. */
async function commitIn(repository: string, file: string) {
	await writeFile(join(repository, file), `${Math.random()}\n`);
	await git(repository, "add", file);
	await git(repository, "commit", "--quiet", "-m", file);
	return git(repository, "rev-parse", "HEAD");
}

/**
 * Nova's origin with main pinning one upstream at its first commit, the
 * upstream moved one commit past it, and a `gh` on PATH that answers what
 * report asks; returns a checkout of main and the origin.
 *
 * Both repositories are made in place, each commit on its own checked-out
 * branch, rather than pushed from a clone: a fetch, a clone and a push to
 * another branch read one as they read a bare repository, and the pushes
 * are no part of the claim.
 */
async function pinLane() {
	const upstream = join(root, "hq");
	await git(root, "init", "--quiet", "-b", "master", upstream);
	const pinned = await commitIn(upstream, "a.txt");

	const origin = join(root, "nova");
	await git(root, "init", "--quiet", "-b", "main", origin);
	const seed = origin;
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
	const head = await commitIn(upstream, "b.txt");

	/* A shell script, not a Node one: it answers each call without starting
	 * a runtime, and how fast `gh` answers is no part of the claim. */
	const bin = join(root, "bin");
	await mkdir(bin);
	await writeFile(
		join(bin, "gh"),
		`#!/bin/sh
case "$1 $2" in
"pr list") printf '[]' ;;
"pr create") printf 'https://github.com/o/r/pull/7\\n' ;;
esac
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

/* About 3 s through the laptop's budget: most of it is pins.mjs's own plan and
 * report over real repositories (about 2 s), which are the claim, and the
 * git and Node processes each starts. Three times that, so a slow runner does
 * not fail it. */
it("writes the lock the pin pull request commits for the candidate, so the prewarm's keys are the pull request's", {
	timeout: 9_000,
}, async () => {
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
	const prewarmNames = await cacheNames(join(prewarm, "proof/image.lock"));
	expect(prewarmNames).toBe(await cacheNames(join(pulled, "proof/image.lock")));
	expect(prewarmNames).toContain(
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
