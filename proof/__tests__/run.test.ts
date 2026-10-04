import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
	chmod,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	readlink,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
	laneOptions,
	proofMatrix,
	refreshTimings,
	runOutput,
	shardOptions,
} from "../run.mjs";

const run = promisify(execFile);
const WORKTREE = resolve(import.meta.dirname, "..", "..");
const RUNNER = join(WORKTREE, "proof", "run.mjs");
// Calls an export of the runner in a fresh Node: the call ([module, export, arguments]) is the program's one
// argument, as JSON, so no program text is built from a test's values.
const CALL_RUNNER =
	"const [module, name, args] = JSON.parse(process.argv[1]); import(module).then((m) => m[name](...args)).then((code) => process.exit(code), (error) => { console.error(error.message); process.exit(99); });";

let scratch: string;

beforeEach(async () => {
	scratch = await mkdtemp(join(tmpdir(), "proof-run-"));
});

afterEach(async () => {
	await rm(scratch, { recursive: true, force: true });
});

interface FakeDocker {
	/** Exit code of `docker run ... test -f /modules/.package-lock.json`. */
	installed: number;
	/** Exit code of the containerized `npm ci`. */
	npmCi: number;
	/** Exit code of `docker compose ... run harness ...` (the lane's fork server). */
	harness: number;
	/** Exit code of the surface extraction (it writes surface.json and its key on 0). */
	surface?: number;
	/** Whether the machine holds the image before any pull (default true). */
	held?: boolean;
	/** Exit code of `docker pull` (it makes the image held on 0). */
	pull?: number;
}

/** The id `docker image inspect` gives the fake's image. */
const IMAGE_ID = `sha256:${"ab".repeat(32)}`;

/**
 * Puts a `docker` executable on PATH that records every invocation and
 * answers each kind of call with the configured exit code.
 */
async function fakeDocker(behavior: FakeDocker) {
	const log = join(scratch, "docker.log");
	const script = join(scratch, "docker");
	await writeFile(
		script,
		`#!/usr/bin/env node
const { appendFileSync, existsSync, mkdirSync, writeFileSync } = require("node:fs");
const { dirname } = require("node:path");
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
const behavior = ${JSON.stringify(behavior)};
const pulled = ${JSON.stringify(join(scratch, "pulled"))};
const mount = (target) => {
	const flag = args.find((arg, index) => args[index - 1] === "-v" && arg.endsWith(":" + target));
	return flag && flag.slice(0, -(target.length + 1));
};
if (args[0] === "image" && args[1] === "inspect") {
	if (behavior.held === false && !existsSync(pulled)) process.exit(1);
	process.stdout.write(${JSON.stringify(IMAGE_ID)} + "\\n");
	process.exit(0);
}
if (args[0] === "version") {
	process.stdout.write("arm64\\n");
	process.exit(0);
}
if (args[0] === "pull") {
	if ((behavior.pull ?? 0) === 0) writeFileSync(pulled, "");
	process.exit(behavior.pull ?? 0);
}
if (args[0] === "run" && args.includes("test")) process.exit(behavior.installed);
if (args[0] === "run" && args.includes("ci")) process.exit(behavior.npmCi);
if (args[0] === "compose" && args.includes("run")) process.exit(behavior.harness);
if (args[0] === "run" && args.includes("proof.lane.extraction")) {
	if (behavior.surface !== 0) process.exit(behavior.surface);
	const out = mount("/out");
	mkdirSync(out, { recursive: true });
	writeFileSync(out + "/surface.json", JSON.stringify({ generated: true }) + "\\n");
	writeFileSync(out + "/extraction.json", JSON.stringify({ image: "the id given" }) + "\\n");
	process.exit(0);
}
process.exit(0);
`,
	);
	await chmod(script, 0o755);
	return log;
}

async function calls(log: string): Promise<string[][]> {
	const text = await readFile(log, "utf8").catch(() => "");
	return text
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

/**
 * Runs one of the runner's entry points (`main` for `npm run proof`, `shard`
 * for `--lane`) as its command line would, writing into an output directory
 * of the test's own.
 */
async function runner(
	entry: "main" | "shard",
	args: string[],
	platform: string,
	env: Record<string, string> = {},
) {
	const environment: NodeJS.ProcessEnv = {
		...process.env,
		PATH: `${scratch}:${process.env.PATH}`,
		PROOF_IMAGE: "proof-image:test",
		PROOF_OUT_DIR: join(scratch, "out"),
		...env,
	};
	for (const name of [
		"PROOF_SHARD",
		"PROOF_WORKER",
		"PROOF_CORPUS",
		"PROOF_SURFACE_EXTRACTION",
		"PROOF_STORE",
	]) {
		if (!(name in env)) delete environment[name];
	}
	try {
		const { stdout, stderr } = await run(
			process.execPath,
			[
				"--input-type=module",
				"-e",
				CALL_RUNNER,
				JSON.stringify([RUNNER, entry, [args, { platform }]]),
			],
			{ cwd: WORKTREE, env: environment },
		);
		return { code: 0, stdout, stderr };
	} catch (error) {
		const failure = error as { code: number; stdout: string; stderr: string };
		return {
			code: failure.code,
			stdout: failure.stdout,
			stderr: failure.stderr,
		};
	}
}

const proof = (
	args: string[],
	platform: string,
	env: Record<string, string> = {},
) => runner("main", args, platform, env);

const composeRun = (call: string[]) =>
	call[0] === "compose" && call.includes("run");
const composeDown = (call: string[]) =>
	call[0] === "compose" && call.includes("down");
const flagValue = (call: string[] | undefined, name: string) =>
	call
		?.find(
			(arg, index) => call[index - 1] === "-e" && arg.startsWith(`${name}=`),
		)
		?.slice(name.length + 1);
const passed = (call: string[] | undefined) =>
	(call ?? [])
		.filter((_, index) => call?.[index - 1] === "-e")
		.map((flag) => flag.split("=")[0]);
const mountOf = (call: string[] | undefined, target: string) =>
	call
		?.find(
			(arg, index) => call[index - 1] === "-v" && arg.endsWith(`:${target}`),
		)
		?.slice(0, -(target.length + 1));
/** The fork server's own arguments: everything after `python -m proof.lane.serve`. */
const served = (call: string[] | undefined) =>
	call?.slice(call.indexOf("proof.lane.serve") + 1);

it("fills a Linux node_modules volume once, serves the selected checks under /work, and removes the lane", async () => {
	const log = await fakeDocker({ installed: 1, npmCi: 0, harness: 0 });
	const result = await proof(
		["--workers", "2", "proof/hq", "-k", "publish"],
		"darwin",
	);
	expect(result.code).toBe(0);

	const invoked = await calls(log);
	const install = invoked.find(
		(call) => call[0] === "run" && call.includes("ci"),
	);
	expect(install).toBeDefined();
	const volume = install?.[install.indexOf("-v", 3) + 1]?.split(":")[0];
	expect(volume).toMatch(/^nova-proof-node-modules-[0-9a-f]{16}$/);

	const harness = invoked.find(composeRun);
	expect(harness).toContain(`${WORKTREE}:/work:ro`);
	expect(harness).toContain(`${volume}:/work/node_modules`);
	expect(harness?.slice(harness.indexOf("harness") + 1, -1)).toEqual([
		"python",
		"-m",
		"proof.lane.serve",
		"--out",
		"/out",
		"--workers",
		"2",
		"--claim",
		"static",
		"--",
		"-c",
		"/work/proof/pytest.ini",
		"--rootdir",
		"/work/proof",
		"/work/proof/hq",
		"-k",
	]);
	expect(harness?.at(-1)).toBe("publish");
	expect(invoked.filter(composeRun)).toHaveLength(1);
	expect(invoked.filter(composeDown)).toHaveLength(1);
	expect(
		invoked.indexOf(invoked.find(composeDown) as string[]),
	).toBeGreaterThan(invoked.indexOf(harness as string[]));
});

it("rewrites a path option's value under /work without taking it for the target, and leaves an expression alone", async () => {
	const log = await fakeDocker({ installed: 0, npmCi: 0, harness: 0 });
	const result = await proof(
		[
			"--ignore",
			"proof/editors",
			"--deselect=proof/hq/test_boot.py::test_x",
			"-k",
			"proof",
		],
		"darwin",
	);
	expect(result.code).toBe(0);
	const args = served((await calls(log)).find(composeRun));
	expect(args?.slice((args?.indexOf("--") ?? 0) + 1)).toEqual([
		"-c",
		"/work/proof/pytest.ini",
		"--rootdir",
		"/work/proof",
		"--ignore",
		"/work/proof/editors",
		"--deselect=/work/proof/hq/test_boot.py::test_x",
		"-k",
		"proof",
		"/work/proof",
	]);
});

it("passes a bin of the collected groups to the server, for runs that split the lane between them", async () => {
	const log = await fakeDocker({ installed: 0, npmCi: 0, harness: 0 });
	expect((await proof(["--bin=2/3", "--workers", "4"], "darwin")).code).toBe(0);
	const harness = (await calls(log)).find(composeRun);
	expect(served(harness)?.slice(0, 9)).toEqual([
		"--out",
		"/out",
		"--workers",
		"4",
		"--claim",
		"static",
		"--bin",
		"2/3",
		"--",
	]);
});

it("reuses a filled volume and serves the whole harness with one worker when nothing is selected", async () => {
	const log = await fakeDocker({ installed: 0, npmCi: 1, harness: 0 });
	expect((await proof([], "darwin")).code).toBe(0);
	const invoked = await calls(log);
	expect(invoked.some((call) => call.includes("ci"))).toBe(false);
	const harness = invoked.find(composeRun);
	expect(harness?.at(-1)).toBe("/work/proof");
	expect(served(harness)?.slice(0, 6)).toEqual([
		"--out",
		"/out",
		"--workers",
		"1",
		"--claim",
		"static",
	]);
});

it("mounts the checkout's own node_modules on Linux instead of a volume", async () => {
	const log = await fakeDocker({ installed: 1, npmCi: 1, harness: 0 });
	expect((await proof([], "linux")).code).toBe(0);
	const invoked = await calls(log);
	expect(invoked.some((call) => call[0] === "run")).toBe(false);
	expect(invoked.find(composeRun)).toContain(
		`${join(WORKTREE, "node_modules")}:/work/node_modules`,
	);
});

it("returns the server's exit code and still removes the lane when checks fail", async () => {
	const log = await fakeDocker({ installed: 0, npmCi: 0, harness: 3 });
	expect((await proof([], "darwin")).code).toBe(3);
	expect((await calls(log)).filter(composeDown)).toHaveLength(1);
});

it("stops before starting the lane when the Linux install fails, and removes the half-filled volume", async () => {
	const log = await fakeDocker({ installed: 1, npmCi: 7, harness: 0 });
	const result = await proof([], "darwin");
	expect(result.code).toBe(99);
	expect(result.stderr).toContain(
		"npm ci failed inside the proof image (exit 7)",
	);
	const invoked = await calls(log);
	expect(invoked.some(composeRun)).toBe(false);
	expect(invoked.some((call) => call[0] === "volume" && call[1] === "rm")).toBe(
		true,
	);
});

it("passes the corpus selection and the audit switches through and nothing else, and mounts a named corpus read-only", async () => {
	const corpus = join(scratch, "corpus");
	await mkdir(corpus);
	await writeFile(join(corpus, "index.json"), "{}\n");
	const log = await fakeDocker({ installed: 0, npmCi: 0, harness: 0 });
	const result = await proof(["proof/checks"], "darwin", {
		PROOF_CORPUS: corpus,
		PROOF_CORPUS_SAMPLE: "7",
		PROOF_CORPUS_SEED: "11",
		PROOF_HQ_DETERMINISM: "0",
		PROOF_EDITOR_AUDIT: "0.03",
		PROOF_SOMETHING_ELSE: "1",
	});
	expect(result.code).toBe(0);
	const harness = (await calls(log)).find(composeRun);
	expect(passed(harness).sort()).toEqual([
		"PROOF_CORPUS",
		"PROOF_CORPUS_SAMPLE",
		"PROOF_CORPUS_SEED",
		"PROOF_EDITOR_AUDIT",
		"PROOF_FINGERPRINTS",
		"PROOF_HQ_DETERMINISM",
		"PROOF_IMAGE_ID",
	]);
	expect(flagValue(harness, "PROOF_IMAGE_ID")).toBe(IMAGE_ID);
	// The evidence store's keys name this checkout's code, the image the lane runs (its id: the reference pins no
	// digest) and the Docker server's architecture.
	const fingerprints = JSON.parse(
		flagValue(harness, "PROOF_FINGERPRINTS") ?? "{}",
	);
	expect([fingerprints.image, fingerprints.arch]).toEqual([IMAGE_ID, "arm64"]);
	expect(fingerprints.observation).toMatch(/^[0-9a-f]{64}$/);
	expect(flagValue(harness, "PROOF_CORPUS")).toBe("/corpus");
	expect(flagValue(harness, "PROOF_CORPUS_SAMPLE")).toBe("7");
	expect(harness).toContain(`${corpus}:/corpus:ro`);
	expect(mountOf(harness, "/out")).toBe(join(scratch, "out"));
});

it("runs the lane with the evidence store off, and says so, where its fingerprints cannot be computed", async () => {
	const log = await fakeDocker({ installed: 0, npmCi: 0, harness: 0 });
	await writeFile(join(scratch, "python3"), "#!/bin/sh\nexit 3\n");
	await chmod(join(scratch, "python3"), 0o755);
	const result = await proof(["proof/checks"], "darwin");
	expect(result.code).toBe(0);
	const harness = (await calls(log)).find(composeRun);
	expect(passed(harness)).not.toContain("PROOF_FINGERPRINTS");
	expect(result.stderr).toContain(
		"exited 3), so the lane runs with the store off",
	);
});

it("mounts a named surface extraction read-only for the surface tests, and refuses one without its timings or key before starting anything", async () => {
	const extraction = join(scratch, "surface");
	await mkdir(extraction);
	await writeFile(join(extraction, "surface.json"), "{}\n");
	await writeFile(join(extraction, "timings.json"), "{}\n");
	await writeFile(join(extraction, "extraction.json"), "{}\n");
	const log = await fakeDocker({ installed: 0, npmCi: 0, harness: 0 });
	const result = await proof(["proof/surface"], "darwin", {
		PROOF_SURFACE_EXTRACTION: extraction,
	});
	expect(result.code).toBe(0);
	const harness = (await calls(log)).find(composeRun);
	expect(harness).toContain(`${extraction}:/surface-extraction:ro`);
	expect(flagValue(harness, "PROOF_SURFACE_EXTRACTION")).toBe(
		"/surface-extraction",
	);

	await rm(join(extraction, "timings.json"));
	const before = (await calls(log)).length;
	const refused = await proof(["proof/surface"], "darwin", {
		PROOF_SURFACE_EXTRACTION: extraction,
	});
	expect(refused.code).toBe(99);
	expect(refused.stderr).toContain("holds no timings.json");
	await writeFile(join(extraction, "timings.json"), "{}\n");
	await rm(join(extraction, "extraction.json"));
	const unkeyed = await proof(["proof/surface"], "darwin", {
		PROOF_SURFACE_EXTRACTION: extraction,
	});
	expect(unkeyed.code).toBe(99);
	expect(unkeyed.stderr).toContain("holds no extraction.json");
	expect((await calls(log)).length).toBe(before);
});

it("mounts a named evidence store read-only for the lane, and refuses one that does not exist before starting anything", async () => {
	const store = join(scratch, "store");
	await mkdir(store);
	const log = await fakeDocker({ installed: 0, npmCi: 0, harness: 0 });
	const result = await proof(["proof/lane"], "darwin", { PROOF_STORE: store });
	expect(result.code).toBe(0);
	const harness = (await calls(log)).find(composeRun);
	expect(harness).toContain(`${store}:/store:ro`);
	expect(flagValue(harness, "PROOF_STORE")).toBe("/store");

	const before = (await calls(log)).length;
	const refused = await proof(["proof/lane"], "darwin", {
		PROOF_STORE: join(scratch, "no-store"),
	});
	expect(refused.code).toBe(99);
	expect(refused.stderr).toContain("no evidence store to read");
	expect((await calls(log)).length).toBe(before);
});

it("pulls an image this machine does not hold before reading its id, and stops when the pull fails", async () => {
	const log = await fakeDocker({
		installed: 0,
		npmCi: 0,
		harness: 0,
		held: false,
	});
	expect((await proof([], "darwin")).code).toBe(0);
	const invoked = await calls(log);
	const kinds = invoked
		.filter((call) => call[0] === "image" || call[0] === "pull")
		.map((call) => call[0]);
	expect(kinds).toEqual(["image", "pull", "image"]);
	expect(flagValue(invoked.find(composeRun), "PROOF_IMAGE_ID")).toBe(IMAGE_ID);

	await rm(join(scratch, "pulled"));
	await rm(join(scratch, "out"), { recursive: true });
	const failing = await fakeDocker({
		installed: 0,
		npmCi: 0,
		harness: 0,
		held: false,
		pull: 1,
	});
	await writeFile(failing, "");
	const refused = await proof([], "darwin");
	expect(refused.code).toBe(99);
	expect(refused.stderr).toContain("pulling it failed (docker pull exited 1)");
	expect((await calls(failing)).some(composeRun)).toBe(false);
});

it("refuses a named corpus that holds no index, before starting anything", async () => {
	const log = await fakeDocker({ installed: 0, npmCi: 0, harness: 0 });
	const result = await proof([], "darwin", {
		PROOF_CORPUS: join(scratch, "nowhere"),
	});
	expect(result.code).toBe(99);
	expect(result.stderr).toContain("holds no index.json");
	expect(await calls(log)).toEqual([]);
});

it("refuses PROOF_SHARD and PROOF_WORKER, which select nothing any more, and --workers without a whole number", async () => {
	const log = await fakeDocker({ installed: 0, npmCi: 0, harness: 0 });
	const shard = await proof([], "darwin", { PROOF_SHARD: "1/2" });
	expect(shard.code).toBe(99);
	expect(shard.stderr).toContain("PROOF_SHARD is set");
	expect(shard.stderr).toContain("Unset PROOF_SHARD");
	const worker = await proof(["--workers", "2"], "darwin", {
		PROOF_WORKER: "1/2",
	});
	expect(worker.stderr).toContain("PROOF_WORKER is set");
	const zero = await proof(["--workers=0"], "darwin");
	expect(zero.code).toBe(99);
	expect(zero.stderr).toContain("--workers takes a whole number");
	expect(await calls(log)).toEqual([]);
	expect(laneOptions(["-x", "--workers=3", "proof/hq"])).toEqual({
		workers: 3,
		bin: undefined,
		pytest: ["-x", "proof/hq"],
	});
	expect(laneOptions(["--bin", "2/3", "proof/hq"]).bin).toBe("2/3");
	for (const bin of ["0/3", "4/3", "2", "a/b", "1/0"]) {
		expect(() => laneOptions(["--bin", bin])).toThrow(
			"--bin names one of several",
		);
	}
});

it("writes into PROOF_OUT_DIR when it is empty, and refuses one that holds an earlier run's files without touching them", async () => {
	const log = await fakeDocker({ installed: 0, npmCi: 0, harness: 0 });
	expect((await proof([], "darwin")).code).toBe(0);
	expect(mountOf((await calls(log)).find(composeRun), "/out")).toBe(
		join(scratch, "out"),
	);

	await writeFile(join(scratch, "out", "evidence.json"), "earlier\n");
	const refused = await proof([], "darwin");
	expect(refused.code).toBe(99);
	expect(refused.stderr).toContain("already holds 1 entries (evidence.json)");
	expect(await readFile(join(scratch, "out", "evidence.json"), "utf8")).toBe(
		"earlier\n",
	);
});

/** A process that has exited, whose pid the test then names as a finished run's owner. */
async function finishedPid() {
	const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
	await new Promise((done) => child.on("exit", done));
	return child.pid as number;
}

it("gives each run its own output directory, linked as out, and removes only finished runs' output", async () => {
	const root = join(scratch, ".proof");
	const runs = join(root, "runs");
	await mkdir(join(runs, "running"), { recursive: true });
	await writeFile(join(runs, "running", "evidence.json"), "in use\n");
	await writeFile(
		join(runs, "running.owner"),
		JSON.stringify({ pid: process.pid }),
	);
	await mkdir(join(runs, "finished"));
	await writeFile(
		join(runs, "finished.owner"),
		JSON.stringify({ pid: await finishedPid() }),
	);
	await mkdir(join(root, "out"));
	await writeFile(join(root, "out", "evidence.json"), "an earlier runner's\n");

	const earlier = async () =>
		(await readdir(runs)).filter((name) => name.startsWith("earlier-"));
	const previous = process.env.PROOF_OUT_DIR;
	delete process.env.PROOF_OUT_DIR;
	try {
		const first = await runOutput({ root });
		expect(existsSync(join(runs, "finished"))).toBe(false);
		expect(existsSync(join(runs, "finished.owner"))).toBe(false);
		expect(resolve(root, await readlink(join(root, "out")))).toBe(first);
		// The directory an earlier runner wrote at out is moved aside, not removed, by the run that links out.
		const [moved] = await earlier();
		expect(await readFile(join(runs, moved, "evidence.json"), "utf8")).toBe(
			"an earlier runner's\n",
		);

		const second = await runOutput({ root });
		expect(resolve(root, await readlink(join(root, "out")))).toBe(second);
		// The first run's process (this one) is still running, so its output stays; the moved one is no run's.
		expect(existsSync(first)).toBe(true);
		expect(await earlier()).toEqual([]);
	} finally {
		if (previous !== undefined) process.env.PROOF_OUT_DIR = previous;
	}
	expect(await readFile(join(runs, "running", "evidence.json"), "utf8")).toBe(
		"in use\n",
	);
});

it("keeps a run whose owner file is still being written or cannot be read, and a run starting beside it keeps its own", async () => {
	const root = join(scratch, ".proof");
	const runs = join(root, "runs");
	await mkdir(join(runs, "starting"), { recursive: true });
	// The state between another start's open of its owner file and its write.
	await writeFile(join(runs, "starting.owner"), "");
	await mkdir(join(runs, "garbled"));
	await writeFile(join(runs, "garbled.owner"), "{not json");
	await mkdir(join(runs, "ownerless"));
	await mkdir(join(runs, "finished"));
	await writeFile(
		join(runs, "finished.owner"),
		JSON.stringify({ pid: await finishedPid() }),
	);
	const previous = process.env.PROOF_OUT_DIR;
	delete process.env.PROOF_OUT_DIR;
	try {
		// Two runs starting at once in one checkout.
		const [first, second] = await Promise.all([
			runOutput({ root }),
			runOutput({ root }),
		]);
		expect(first).not.toBe(second);
		for (const kept of ["starting", "garbled"]) {
			expect(existsSync(join(runs, kept))).toBe(true);
			expect(existsSync(join(runs, `${kept}.owner`))).toBe(true);
		}
		expect(existsSync(join(runs, "ownerless"))).toBe(false);
		expect(existsSync(join(runs, "finished"))).toBe(false);
		expect(existsSync(join(runs, "finished.owner"))).toBe(false);
		for (const started of [first, second]) {
			expect(existsSync(started)).toBe(true);
			const owner = JSON.parse(await readFile(`${started}.owner`, "utf8"));
			expect(owner.pid).toBe(process.pid);
		}
		// Nothing half written is left beside the runs.
		expect((await readdir(root)).sort()).toEqual(["out", "runs"]);
		// A third start finds both live and keeps them.
		await runOutput({ root });
		expect(existsSync(first) && existsSync(second)).toBe(true);
	} finally {
		if (previous !== undefined) process.env.PROOF_OUT_DIR = previous;
	}
});

it("runs a CI shard over the queues: commands inside, the main queue's directory and the corpus writable, the store read-only, no node_modules", async () => {
	const early = join(scratch, "early-queue.json");
	await writeFile(early, "{}\n");
	const queue = join(scratch, "arrives", "queue.json");
	const corpus = join(scratch, "corpus-to-come");
	const store = join(scratch, "store", "read");
	await mkdir(store, { recursive: true });
	const log = await fakeDocker({ installed: 1, npmCi: 1, harness: 0 });
	const result = await runner(
		"shard",
		[
			"--label",
			"shard-3",
			"--early-queue",
			early,
			"--queue",
			queue,
			"--claim",
			"node proof/ci/claim.mjs {block}",
			"--wait-for",
			"node proof/ci/wait.mjs proof-queue",
			"--command-env",
			"ACTIONS_RUNTIME_TOKEN,ACTIONS_RESULTS_URL",
		],
		"linux",
		{
			PROOF_CORPUS: corpus,
			PROOF_STORE: store,
			ACTIONS_RUNTIME_TOKEN: "token",
			ACTIONS_RESULTS_URL: "https://results.example",
			GITHUB_TOKEN: "not for the harness",
		},
	);
	expect(result.code).toBe(0);
	const invoked = await calls(log);
	expect(invoked.some((call) => call[0] === "run")).toBe(false); // no node_modules install or probe
	const harness = invoked.find(composeRun);
	expect(mountOf(harness, "/work/node_modules")).toBeUndefined();
	expect(harness).toContain(`${WORKTREE}:/work:ro`);
	expect(harness).toContain(`${early}:/lane/early-queue.json:ro`);
	expect(harness).toContain(`${join(scratch, "arrives")}:/lane/queue`);
	expect(harness).toContain(`${corpus}:/corpus`);
	expect(harness).toContain(`${store}:/store:ro`);
	expect(flagValue(harness, "PROOF_STORE")).toBe("/store");
	expect(existsSync(corpus) && existsSync(join(scratch, "arrives"))).toBe(true);
	expect(passed(harness).sort()).toEqual([
		"ACTIONS_RESULTS_URL",
		"ACTIONS_RUNTIME_TOKEN",
		"PROOF_CORPUS",
		"PROOF_FINGERPRINTS",
		"PROOF_IMAGE_ID",
		"PROOF_STORE",
	]);
	expect(served(harness)).toEqual([
		"--out",
		"/out",
		"--workers",
		"4",
		"--label",
		"shard-3",
		"--early-queue",
		"/lane/early-queue.json",
		"--queue",
		"/lane/queue/queue.json",
		"--claim",
		"node proof/ci/claim.mjs {block}",
		"--wait-for",
		"node proof/ci/wait.mjs proof-queue",
		"--command-env",
		"ACTIONS_RUNTIME_TOKEN,ACTIONS_RESULTS_URL",
	]);
	expect(invoked.filter(composeDown)).toHaveLength(1);
});

it("refuses a shard with no queue, a main queue without a corpus, a missing early queue, or an option without its value", async () => {
	const log = await fakeDocker({ installed: 0, npmCi: 0, harness: 0 });
	const none = await runner("shard", ["--label", "x"], "linux");
	expect(none.stderr).toContain("name them with --early-queue and --queue");
	const corpusless = await runner(
		"shard",
		["--queue", join(scratch, "arrives", "queue.json")],
		"linux",
	);
	expect(corpusless.code).toBe(99);
	expect(corpusless.stderr).toContain(
		"--queue runs the corpus's documents, and PROOF_CORPUS names no corpus",
	);
	const missing = await runner(
		"shard",
		["--early-queue", join(scratch, "absent.json")],
		"linux",
	);
	expect(missing.code).toBe(99);
	expect(missing.stderr).toContain("download it before starting the shard");
	expect(() => shardOptions(["--queue"])).toThrow("without one");
	expect(() => shardOptions(["--queue", "q", "--bins", "1/2"])).toThrow(
		'"--bins"',
	);
	expect(await calls(log)).toEqual([]);
});

it("plans CI's shards on the execution's runner, or as many as asked for", () => {
	const timings = {
		execution: { shards: 14, workers: 4, runner: "ubuntu-24.04-arm" },
		groups: { g: 1 },
	};
	const matrix = proofMatrix("default", timings);
	expect(matrix.include).toHaveLength(14);
	expect(matrix.include[0]).toEqual({
		shard: 1,
		total: 14,
		workers: 4,
		runner: "ubuntu-24.04-arm",
	});
	expect(matrix.include.at(-1)?.shard).toBe(14);
	expect(proofMatrix("3", timings).include.map((entry) => entry.total)).toEqual(
		[3, 3, 3],
	);
	expect(() => proofMatrix("0", timings)).toThrow("whole number");
	expect(() =>
		proofMatrix("default", { execution: { shards: 2, workers: 4 } }),
	).toThrow("names no runner");
});

it("writes each group's box-seconds the workers measured, averaging runs, with the servers' fixed costs", async () => {
	const first = join(scratch, "first");
	const second = join(scratch, "second");
	await mkdir(join(first, "timings"), { recursive: true });
	await mkdir(join(second, "timings"), { recursive: true });
	await writeFile(
		join(first, "timings", "shard-1-w1.json"),
		JSON.stringify({
			worker: 1,
			workers: 4,
			groups: { "corpus:a": 8, "proof/hq": 40 },
			shared: 3,
		}),
	);
	await writeFile(
		join(first, "timings", "shard-1-w2.json"),
		JSON.stringify({
			worker: 2,
			workers: 4,
			groups: { "proof/native": 80 },
			shared: 5,
		}),
	);
	await writeFile(
		join(first, "serve.json"),
		JSON.stringify({
			fixed: { boot: 2, template: 1, bootSteps: { django_setup: 1 } },
		}),
	);
	await writeFile(
		join(second, "timings", "local-w1.json"),
		JSON.stringify({
			worker: 1,
			workers: 2,
			groups: { "corpus:a": 8, "proof/native": 60 },
			shared: 7,
		}),
	);
	await writeFile(
		join(second, "serve.json"),
		// A shard's wait for the main queue is time spent on another job, not one of its fixed costs.
		JSON.stringify({ fixed: { boot: 4, template: 1 }, waits: { queue: 90 } }),
	);
	const refreshed = await refreshTimings([first, second], {
		execution: { shards: 14, workers: 4, runner: "ubuntu-24.04-arm" },
		groups: { stale: 1 },
	});
	expect(refreshed.execution).toEqual({
		shards: 14,
		workers: 4,
		runner: "ubuntu-24.04-arm",
	});
	expect(refreshed.measured.sessions).toBe(3);
	expect(refreshed.measured.sharedSeconds).toBe(5);
	expect(refreshed.measured.fixed).toEqual({ boot: 3, template: 1 });
	// corpus:a: 8/4 and 8/2; proof/native: 80/4 and 60/2.
	expect(refreshed.groups).toEqual({
		"corpus:a": 3,
		"proof/hq": 10,
		"proof/native": 25,
	});
	await expect(refreshTimings([scratch], {})).rejects.toThrow(
		"holds no timings/ from a lane run",
	);
	await expect(refreshTimings([], {})).rejects.toThrow(
		"Name the output directory",
	);
	await writeFile(
		join(second, "timings", "local-w2.json"),
		JSON.stringify({ groups: { x: 1 } }),
	);
	await expect(refreshTimings([second], {})).rejects.toThrow(
		"local-w2.json's workers takes a whole number",
	);
});

/** `npm run surface`, writing the extraction into the test's own `output` and the surface to `destination`. */
async function regenerate(destination: string, output: string) {
	const call = JSON.stringify([RUNNER, "surface", [{ destination, output }]]);
	try {
		await run(
			process.execPath,
			["--input-type=module", "-e", CALL_RUNNER, call],
			{
				cwd: WORKTREE,
				env: {
					...process.env,
					PATH: `${scratch}:${process.env.PATH}`,
					PROOF_IMAGE: "proof-image:test",
				},
			},
		);
		return 0;
	} catch (error) {
		return (error as { code: number }).code;
	}
}

it("regenerates the surface offline and writes it where the manifest keeps it", async () => {
	const log = await fakeDocker({
		installed: 0,
		npmCi: 0,
		harness: 0,
		surface: 0,
	});
	const destination = join(scratch, "surface.json");
	const output = join(scratch, "extraction");
	expect(await regenerate(destination, output)).toBe(0);
	expect(await readFile(destination, "utf8")).toBe('{"generated":true}\n');
	const extraction = (await calls(log)).find((call) =>
		call.includes("proof.lane.extraction"),
	);
	expect(extraction?.slice(0, 4)).toEqual(["run", "--rm", "--network", "none"]);
	expect(extraction).toContain(`${WORKTREE}:/work:ro`);
	// The extraction, its timings and its key stay together, so PROOF_SURFACE_EXTRACTION can name the directory.
	expect(mountOf(extraction, "/out")).toBe(output);
	expect(flagValue(extraction, "PROOF_IMAGE_ID")).toBe(IMAGE_ID);
	expect(extraction?.slice(-2)).toEqual(["--out", "/out"]);
	expect(existsSync(join(output, "extraction.json"))).toBe(true);
});

it("leaves the committed surface alone when the extraction fails", async () => {
	await fakeDocker({ installed: 0, npmCi: 0, harness: 0, surface: 4 });
	const destination = join(scratch, "surface.json");
	await writeFile(destination, "committed\n");
	expect(await regenerate(destination, join(scratch, "extraction"))).toBe(4);
	expect(await readFile(destination, "utf8")).toBe("committed\n");
});
