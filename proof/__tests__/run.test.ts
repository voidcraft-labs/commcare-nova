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
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, it } from "vitest";
import { parse } from "yaml";
import {
	HOSTED_CONTAINER,
	hostedBudget,
	hostedCutoffs,
} from "../ci/hosted-shard.mjs";
import {
	androidRuntime,
	checkoutView,
	HARNESS_PATHS,
	laneOptions,
	proofMatrix,
	refreshTimings,
	runOutput,
	shardOptions,
	statsBytes,
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
	/** Exit code of `docker run ... test -f /modules/.nova-zip64-descriptors-v1`. */
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
	/** What the surface extraction writes as surface.json: JSON text, or a link to this path. */
	surfaceFile?: { text: string } | { link: string };
	/** A link the lane's server leaves in its output, at this path under /out, to this target. */
	outputLink?: { path: string; target: string };
	/** Requests the lane's server makes through its relay before it exits: each one's answer is recorded. */
	relay?: string[];
}

/** `value` as one word of a POSIX shell command. */
const quoted = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

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
const { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } = require("node:fs");
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
// What the container is shown at /work, read-only: every path under it, as the run saw it.
const work = args.find((arg, index) => args[index - 1] === "-v" && arg.endsWith(":/work:ro"));
if (work) {
	const source = work.slice(0, -":/work:ro".length);
	appendFileSync(${JSON.stringify(join(scratch, "work-seen.log"))}, JSON.stringify(readdirSync(source, { recursive: true }).sort()) + "\\n");
}
if (args[0] === "run" && args.includes("test")) process.exit(behavior.installed);
if (args[0] === "run" && args.includes("ci")) process.exit(behavior.npmCi);
if (args[0] === "compose" && args.includes("run")) {
	if (behavior.outputLink) {
		symlinkSync(behavior.outputLink.target, mount("/out") + "/" + behavior.outputLink.path);
	}
	if (behavior.relay) {
		const requests = mount("/lane/requests");
		const answers = args.find((arg, index) => args[index - 1] === "-v" && arg.endsWith(":/lane/answers:ro")).slice(0, -":/lane/answers:ro".length);
		const answered = {};
		for (const name of behavior.relay) writeFileSync(requests + "/" + name + ".request", "");
		const deadline = Date.now() + 20000;
		while (Object.keys(answered).length < behavior.relay.length && Date.now() < deadline) {
			for (const name of behavior.relay) {
				if (existsSync(answers + "/" + name + ".code")) answered[name] = readFileSync(answers + "/" + name + ".code", "utf8").trim();
			}
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
		}
		writeFileSync(${JSON.stringify(join(scratch, "relayed.json"))}, JSON.stringify({ answered, files: readdirSync(answers).sort() }));
	}
	process.exit(behavior.harness);
}
if (args[0] === "run" && args.includes("proof.lane.extraction")) {
	if (behavior.surface !== 0) process.exit(behavior.surface);
	const out = mount("/out");
	mkdirSync(out, { recursive: true });
	const surfaceFile = behavior.surfaceFile ?? { text: JSON.stringify({ items: { generated: {} } }) + "\\n" };
	if ("link" in surfaceFile) symlinkSync(surfaceFile.link, out + "/surface.json");
	else writeFileSync(out + "/surface.json", surfaceFile.text);
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

/** Variables a test hands a run for its command environment, which CI's own steps may also hold. */
const HANDED = ["ACTIONS_RUNTIME_TOKEN", "ACTIONS_RESULTS_URL", "GITHUB_TOKEN"];

/**
 * The environment a runner under test is given: this machine's, without
 * anything the runner reads or passes into the harness, and then what the
 * test itself names. The runner reads its switches from the environment
 * (every `PROOF_` variable), and the suite runs where some are set for other
 * reasons: CI's workflow sets PROOF_READERS for its own lane, and a proof
 * machine names its Android runtime. Each test states what its run is given,
 * so the same assertions hold wherever the suite runs.
 */
function environmentOf(given: Record<string, string>): NodeJS.ProcessEnv {
	const environment = { ...process.env };
	for (const name of Object.keys(environment)) {
		if (name.startsWith("PROOF_") || HANDED.includes(name)) {
			delete environment[name];
		}
	}
	return {
		...environment,
		PATH: `${scratch}:${process.env.PATH}`,
		PROOF_IMAGE: "proof-image:test",
		...given,
	};
}

/**
 * A copy of a checkout without git, as proof/remote/run.sh leaves one: the
 * files it lists in .proof/checkout-files, beside an ignored .env it does
 * not list. The runner's view of it is what the container is shown.
 */
async function smallCheckout() {
	const checkout = join(scratch, "checkout");
	await mkdir(join(checkout, ".proof"), { recursive: true });
	await mkdir(join(checkout, "proof"), { recursive: true });
	await writeFile(join(checkout, "package-lock.json"), "{}\n");
	await writeFile(join(checkout, "proof", "pytest.ini"), "[pytest]\n");
	await writeFile(join(checkout, ".env"), "SECRET=not for the container\n");
	await writeFile(
		join(checkout, ".proof", "checkout-files"),
		"package-lock.json\0proof/pytest.ini\0",
	);
	return checkout;
}

/** Every path the container was shown at /work, one list per container started. */
async function workSeen(): Promise<string[][]> {
	const text = await readFile(join(scratch, "work-seen.log"), "utf8").catch(
		() => "",
	);
	return text
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

/**
 * Runs one of the runner's entry points (`main` for `npm run proof`, `shard`
 * for `--lane`) as its command line would, writing into an output directory
 * of the test's own, over a small checkout of the test's own.
 */
async function runner(
	entry: "main" | "shard",
	args: string[],
	platform: string,
	env: Record<string, string> = {},
) {
	const environment = environmentOf({
		PROOF_OUT_DIR: join(scratch, "out"),
		...env,
	});
	try {
		const { stdout, stderr } = await run(
			process.execPath,
			[
				"--input-type=module",
				"-e",
				CALL_RUNNER,
				JSON.stringify([
					RUNNER,
					entry,
					[args, { platform, checkout: await smallCheckout() }],
				]),
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
/** The source of the read-only mount at `target`. */
const readOnlyMountOf = (call: string[] | undefined, target: string) =>
	call
		?.find(
			(arg, index) => call[index - 1] === "-v" && arg.endsWith(`:${target}:ro`),
		)
		?.slice(0, -(target.length + 4));
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
	expect(install?.join(" ")).toContain(
		"node scripts/fix-yazl-descriptors.mjs && touch node_modules/.nova-zip64-descriptors-v1",
	);
	const volume = install?.[install.indexOf("-v", 3) + 1]?.split(":")[0];
	expect(volume).toMatch(/^nova-proof-node-modules-[0-9a-f]{16}$/);

	const harness = invoked.find(composeRun);
	// The container sees a view of the checkout: the files it lists and an empty node_modules for the install's
	// mount, never the ignored .env, and the view is gone once the run ends.
	const view = readOnlyMountOf(harness, "/work");
	expect(view?.startsWith(join(WORKTREE, ".proof", "views"))).toBe(true);
	expect(existsSync(view as string)).toBe(false);
	expect((await workSeen()).at(-1)).toEqual([
		"node_modules",
		"package-lock.json",
		"proof",
		"proof/pytest.ini",
	]);
	expect(harness).toContain(`${volume}:/work/node_modules:ro`);
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
	// A run that names no profile passes none, and the harness serves every reader.
	expect(passed(harness)).not.toContain("PROOF_READERS");
});

it("mounts the checkout's own node_modules on Linux instead of a volume", async () => {
	const log = await fakeDocker({ installed: 1, npmCi: 1, harness: 0 });
	expect((await proof([], "linux")).code).toBe(0);
	const invoked = await calls(log);
	expect(invoked.some((call) => call[0] === "run")).toBe(false);
	expect(invoked.find(composeRun)).toContain(
		`${join(WORKTREE, "node_modules")}:/work/node_modules:ro`,
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
		PROOF_ENTROPY: "real",
		PROOF_HQ_DETERMINISM: "0",
		PROOF_EDITOR_AUDIT: "0.03",
		PROOF_READERS: "formplayer,android",
		PROOF_SOMETHING_ELSE: "1",
	});
	expect(result.code).toBe(0);
	const harness = (await calls(log)).find(composeRun);
	expect(passed(harness).sort()).toEqual([
		"PROOF_CORPUS",
		"PROOF_CORPUS_SAMPLE",
		"PROOF_CORPUS_SEED",
		"PROOF_EDITOR_AUDIT",
		"PROOF_ENTROPY",
		"PROOF_FINGERPRINTS",
		"PROOF_HQ_DETERMINISM",
		"PROOF_IMAGE_ID",
		"PROOF_READERS",
	]);
	// The lane's profile reaches the harness as it was named (proof/lane/readers.py reads it there).
	expect(flagValue(harness, "PROOF_READERS")).toBe("formplayer,android");
	expect(flagValue(harness, "PROOF_ENTROPY")).toBe("real");
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
	// The run records the memory its containers used beside its evidence.
	expect(
		JSON.parse(await readFile(join(scratch, "out", "memory.json"), "utf8")),
	).toHaveProperty("peaks");

	await writeFile(join(scratch, "out", "evidence.json"), "earlier\n");
	const refused = await proof([], "darwin");
	expect(refused.code).toBe(99);
	expect(refused.stderr).toContain(
		"already holds 2 entries (evidence.json, memory.json)",
	);
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
	await writeFile(join(runs, "running.host-status.json"), "in progress");
	await mkdir(join(runs, "finished"));
	await writeFile(join(runs, "finished.host-status.json"), "closed");
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
		expect(existsSync(join(runs, "finished.host-status.json"))).toBe(false);
		expect(existsSync(join(runs, "running.host-status.json"))).toBe(true);
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

const BLOCK = "a".repeat(64);
const OTHER = "b".repeat(64);

it("runs a CI shard over the queues: commands on the host through the relay, the queue's directory, the corpus and the store read-only, no node_modules, no credential", async () => {
	const early = join(scratch, "early-queue.json");
	await writeFile(early, `${JSON.stringify({ blocks: [{ id: BLOCK }] })}\n`);
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
		],
		"linux",
		{
			PROOF_CORPUS: corpus,
			PROOF_STORE: store,
			// The pull request lane's profile, which its workflow sets for every step.
			PROOF_READERS: "0",
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
	expect(readOnlyMountOf(harness, "/work")).toBeDefined();
	// A shard is shown the harness and the surface alone.
	expect((await workSeen()).at(-1)).toEqual([
		"node_modules",
		"package-lock.json",
		"proof",
		"proof/pytest.ini",
	]);
	expect(harness).toContain(`${early}:/lane/early-queue.json:ro`);
	expect(harness).toContain(`${join(scratch, "arrives")}:/lane/queue:ro`);
	expect(harness).toContain(`${corpus}:/corpus:ro`);
	expect(harness).toContain(`${store}:/store:ro`);
	expect(mountOf(harness, "/lane/requests")).toBeDefined();
	expect(readOnlyMountOf(harness, "/lane/answers")).toBeDefined();
	expect(flagValue(harness, "PROOF_STORE")).toBe("/store");
	expect(existsSync(corpus) && existsSync(join(scratch, "arrives"))).toBe(true);
	// No credential reaches the container: the commands that use them run on the host.
	expect(passed(harness).sort()).toEqual([
		"PROOF_CORPUS",
		"PROOF_FINGERPRINTS",
		"PROOF_IMAGE_ID",
		"PROOF_READERS",
		"PROOF_STORE",
	]);
	expect(JSON.stringify(harness)).not.toContain("token");
	expect(flagValue(harness, "PROOF_READERS")).toBe("0");
	const relay =
		"python -m proof.lane.relay --requests /lane/requests --answers /lane/answers";
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
		`${relay} claim {block}`,
		"--wait-for",
		`${relay} wait`,
	]);
	expect(invoked.filter(composeDown)).toHaveLength(1);
});

// The relay's other half, end to end over the runner's own broker: the container names a request, and the host
// runs the command with the job's credentials and answers with its status. The plausible failures: a credential
// handed into the container, a command run for a block no queue holds (so a container could make the host claim,
// or run, anything), and a request left unanswered, which would hold the server for ever.
it("runs a shard's claims on the host with its credentials, for the queue's blocks alone, and answers every request", async () => {
	const early = join(scratch, "early-queue.json");
	await writeFile(early, `${JSON.stringify({ blocks: [{ id: BLOCK }] })}\n`);
	const ran = join(scratch, "ran");
	await mkdir(ran);
	const log = await fakeDocker({
		installed: 0,
		npmCi: 0,
		harness: 0,
		relay: [`claim-${BLOCK}`, `claim-${OTHER}`, "claim-not-a-block", "wait"],
	});
	const result = await runner(
		"shard",
		[
			"--early-queue",
			early,
			"--claim",
			`printf '%s %s' "$PROOF_LANE_BLOCK" "$ACTIONS_RUNTIME_TOKEN" > ${quoted(ran)}/{block}; exit 1`,
		],
		"linux",
		{ ACTIONS_RUNTIME_TOKEN: "token", ACTIONS_RESULTS_URL: "https://x" },
	);
	expect(result.code).toBe(0);
	// The early queue's block ran on the host with the token, and answered with the command's own status (taken);
	// a block no queue names, a name that is no block, and a wait this shard was given no command for were refused
	// and ran nothing.
	expect(
		JSON.parse(await readFile(join(scratch, "relayed.json"), "utf8")),
	).toEqual({
		answered: {
			[`claim-${BLOCK}`]: "1",
			[`claim-${OTHER}`]: "2",
			"claim-not-a-block": "2",
			wait: "2",
		},
		files: [
			`claim-${BLOCK}.code`,
			`claim-${OTHER}.code`,
			"claim-not-a-block.code",
			"wait.code",
		].sort(),
	});
	expect(await readdir(ran)).toEqual([BLOCK]);
	expect(await readFile(join(ran, BLOCK), "utf8")).toBe(`${BLOCK} token`);
	expect(passed((await calls(log)).find(composeRun))).not.toContain(
		"ACTIONS_RUNTIME_TOKEN",
	);
});

// What a container wrote is data. The plausible failure: a link the container left in its output is followed by
// a later host step (an upload follows links), so a host file is published. The output is moved aside instead.
it("moves aside an output the container left a link in, names it, and exits with the seal's status", async () => {
	const marker = join(scratch, "marker.txt");
	await writeFile(marker, "test fixture\n");
	await fakeDocker({
		installed: 0,
		npmCi: 0,
		harness: 0,
		outputLink: { path: "memory.json", target: marker },
	});
	const result = await proof([], "darwin");
	expect(result.code).toBe(6);
	expect(result.stderr).toContain(
		"memory.json, which is a link and not a file",
	);
	expect(existsSync(join(scratch, "out"))).toBe(false);
	expect(existsSync(join(scratch, "out.refused", "memory.json"))).toBe(true);
	expect(await readFile(marker, "utf8")).toBe("test fixture\n");
});

it("keeps an output of plain files in place and returns the server's status", async () => {
	await fakeDocker({ installed: 0, npmCi: 0, harness: 1 });
	expect((await proof([], "darwin")).code).toBe(1);
	expect(existsSync(join(scratch, "out"))).toBe(true);
	expect(existsSync(join(scratch, "out.refused"))).toBe(false);
});

// The container is shown what git lists of the checkout and nothing it ignores. The plausible failures: an ignored
// .env or key, or .git with a persisted credential, mounted into a container that runs upstream code with a network;
// an uncommitted edit left out of the run it was made for.
it("shows the container the files git lists, an uncommitted edit among them, and nothing git ignores", async () => {
	const root = join(scratch, "repository");
	await mkdir(join(root, "proof"), { recursive: true });
	const git = (...args: string[]) =>
		run("git", ["-C", root, ...args], {
			env: {
				...process.env,
				GIT_CONFIG_GLOBAL: "/dev/null",
				GIT_CONFIG_NOSYSTEM: "1",
				GIT_AUTHOR_NAME: "test",
				GIT_AUTHOR_EMAIL: "test@example.org",
				GIT_COMMITTER_NAME: "test",
				GIT_COMMITTER_EMAIL: "test@example.org",
			},
		});
	await git("init", "--quiet");
	await writeFile(join(root, ".gitignore"), ".env*\n*.pem\n");
	await writeFile(join(root, "proof", "run.mjs"), "tracked\n");
	await writeFile(join(root, "gone.txt"), "removed since\n");
	await symlink("proof/run.mjs", join(root, "AGENTS.md"));
	await git("add", ".");
	await git("commit", "--quiet", "-m", "base");
	await rm(join(root, "gone.txt"));
	await writeFile(join(root, "proof", "new.py"), "an uncommitted edit\n");
	await writeFile(join(root, ".env"), "SECRET=1\n");
	await writeFile(join(root, "proof", "key.pem"), "a key\n");
	const view = await checkoutView(join(scratch, "view"), { root });
	const { stdout } = await run("find", [".", "-not", "-type", "d"], {
		cwd: view,
	});
	expect(stdout.trim().split("\n").sort()).toEqual([
		"./.gitignore",
		"./AGENTS.md",
		"./proof/new.py",
		"./proof/run.mjs",
	]);
	expect(await readlink(join(view, "AGENTS.md"))).toBe("proof/run.mjs");
	expect(existsSync(join(view, "node_modules"))).toBe(true);
	// A shard's view holds the harness alone.
	const harness = await checkoutView(join(scratch, "harness"), {
		root,
		only: HARNESS_PATHS,
	});
	const shown = await run("find", [".", "-not", "-type", "d"], {
		cwd: harness,
	});
	expect(shown.stdout.trim().split("\n").sort()).toEqual([
		"./proof/new.py",
		"./proof/run.mjs",
	]);
});

it("refuses to show a container a checkout whose files cannot be listed", async () => {
	const root = join(scratch, "copy");
	await mkdir(root);
	await writeFile(join(root, ".env"), "SECRET=1\n");
	await expect(checkoutView(join(scratch, "view"), { root })).rejects.toThrow(
		"is no git checkout and holds no .proof/checkout-files",
	);
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
		profiles: {
			readers: {
				execution: { shards: 14, workers: 4, runner: "ubuntu-24.04-arm" },
				groups: { g: 1 },
			},
			"no-readers": {
				execution: { shards: 6, workers: 4, runner: "ubuntu-24.04" },
				groups: { g: 0.1 },
			},
		},
	};
	// Each profile plans from its own execution: the pull request lane's shards are not the nightly's.
	expect(proofMatrix("default", timings, false).include).toHaveLength(6);
	expect(proofMatrix("default", timings, false).include[0]?.runner).toBe(
		"ubuntu-24.04",
	);
	const matrix = proofMatrix("default", timings);
	expect(matrix.include).toHaveLength(14);
	expect(matrix.include[0]).toEqual({
		shard: 1,
		total: 14,
		workers: 4,
		runner: "ubuntu-24.04-arm",
		deadline: 330,
		jobDeadline: 345,
	});
	expect(matrix.include.at(-1)?.shard).toBe(14);
	expect(proofMatrix("3", timings).include.map((entry) => entry.total)).toEqual(
		[3, 3, 3],
	);
	expect(() => proofMatrix("0", timings)).toThrow("whole number");
	expect(() =>
		proofMatrix("default", {
			profiles: { readers: { execution: { shards: 2, workers: 4 } } },
		}),
	).toThrow("names no runner");
	expect(() => proofMatrix("default", timings.profiles.readers)).toThrow(
		"whole number",
	);
});

it("prints the matrix of a planned count, with the plan's deadline where it gives one", () => {
	const timings = {
		profiles: {
			readers: {
				execution: { shards: 16, workers: 4, runner: "ubuntu-24.04" },
			},
		},
	};
	const planned = proofMatrix("4", timings, true, "300");
	expect(planned.include).toHaveLength(4);
	expect(planned.include[3]).toEqual({
		shard: 4,
		total: 4,
		workers: 4,
		runner: "ubuntu-24.04",
		deadline: 300,
		jobDeadline: 315,
	});
	const counted = proofMatrix("default", timings);
	expect(counted.include).toHaveLength(16);
	expect(counted.include[0]).toMatchObject(hostedBudget());
	expect(() => proofMatrix("auto", timings)).toThrow("The shard count");
});

it("keeps the work deadline from preparation and gives an interrupted host time to write and upload its records", async () => {
	expect(hostedBudget(345)).toEqual({ deadline: 345, jobDeadline: 360 });
	expect(hostedCutoffs(100, 20, 140)).toEqual({
		stopAt: 1300,
		hostSeconds: 1340,
	});
	expect(hostedCutoffs(100, 20, 1500).hostSeconds).toBeLessThan(0);
	for (const invalid of [0, 0.5, 346, NaN])
		expect(() => hostedBudget(invalid)).toThrow();
	for (const invalid of [0, 99.5, NaN, 141])
		expect(() => hostedCutoffs(invalid, 20, 140)).toThrow();
	// The workflow reserves status 1 for completed checks; a bad job clock must fail the shard itself.
	await expect(
		run(process.execPath, [RUNNER, "--hosted-lane"], {
			env: {
				...process.env,
				PROOF_SHARD_STARTED_AT: "bad",
				PROOF_SHARD_MINUTES: "20",
			},
		}),
	).rejects.toMatchObject({ code: 2 });
});

it("reports a killed host as a signal even after the shard has launched", async () => {
	// Exercise the OS child-exit signal, which has no numeric exit code for the runner to read.
	await writeFile(join(scratch, "timeout"), "#!/bin/sh\nkill -KILL $$\n", {
		mode: 0o755,
	});
	await expect(
		run(process.execPath, [RUNNER, "--hosted-lane"], {
			env: environmentOf({
				PROOF_SHARD_STARTED_AT: String(Math.floor(Date.now() / 1000)),
				PROOF_SHARD_MINUTES: "20",
			}),
		}),
	).rejects.toMatchObject({ code: 137 });
});

it("stops a surviving hosted Docker writer before sealing, and fails the seal when Docker cannot stop it", async () => {
	const output = join(scratch, "out");
	const writer = join(scratch, "running");
	await mkdir(output);
	await writeFile(join(output, "worker.log"), "completed observation");
	await writeFile(writer, "");
	await writeFile(
		join(scratch, "docker"),
		[
			"#!/bin/sh",
			'case "$1" in',
			`  ps) [ "$5" = 'name=^/${HOSTED_CONTAINER}$' ] || exit 3; [ ! -f "$WRITER" ] || echo abcd ;;`,
			`  rm) [ "$3" = '${HOSTED_CONTAINER}' ] && [ "$REMOVABLE" = yes ] && rm "$WRITER" || exit 2 ;;`,
			"  *) exit 3 ;;",
			"esac",
		].join("\n"),
		{ mode: 0o755 },
	);
	const seal = (removable: string) =>
		run(process.execPath, [RUNNER, "--seal-hosted", output], {
			env: environmentOf({ WRITER: writer, REMOVABLE: removable }),
		});
	await expect(seal("no")).rejects.toMatchObject({ code: 1 });
	await seal("yes");
	await expect(readFile(writer)).rejects.toMatchObject({ code: "ENOENT" });
	expect(await readFile(join(output, "worker.log"), "utf8")).toBe(
		"completed observation",
	);
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
	const previous = {
		profiles: {
			readers: {
				execution: { shards: 14, workers: 4, runner: "ubuntu-24.04-arm" },
				groups: { stale: 1 },
			},
			"no-readers": {
				execution: { shards: 6, workers: 4, runner: "ubuntu-24.04" },
				groups: { kept: 2 },
			},
		},
	};
	const refreshed = (await refreshTimings([first, second], previous)).profiles
		.readers;
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
	// Runs without the readers refresh that profile alone, the other kept as it was; on a box that gives each
	// worker a vCPU, as a CI shard does, a worker-second is a CI worker's, divided by the workers a CI box holds.
	for (const directory of [first, second]) {
		const served = JSON.parse(
			await readFile(join(directory, "serve.json"), "utf8"),
		);
		await writeFile(
			join(directory, "serve.json"),
			JSON.stringify({ ...served, readers: false }),
		);
	}
	const without = await refreshTimings([first, second], previous, {
		boxWorkers: 4,
	});
	expect(without.profiles.readers).toEqual(previous.profiles.readers);
	expect(without.profiles["no-readers"].execution).toEqual(
		previous.profiles["no-readers"].execution,
	);
	// corpus:a: 8/4 twice; proof/native: 80/4 and 60/4.
	expect(without.profiles["no-readers"].groups).toEqual({
		"corpus:a": 2,
		"proof/hq": 10,
		"proof/native": 17.5,
	});
	expect(without.profiles["no-readers"].measured.basis).toContain(
		"divided by 4",
	);
	await writeFile(
		join(first, "serve.json"),
		JSON.stringify({ fixed: {}, readers: true }),
	);
	await expect(refreshTimings([first, second], previous)).rejects.toThrow(
		"both of the lane's profiles",
	);
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

it("hands the harness the Android runtime and its JDK at the paths they have here, read-only", async () => {
	// A runtime names its classpath by absolute paths, so it is mounted where it was built; a name that
	// is not there is refused, and an environment that names neither mounts nothing.
	const runtime = join(scratch, "android-runtime");
	const jdk = join(scratch, "temurin");
	await mkdir(runtime, { recursive: true });
	await mkdir(jdk, { recursive: true });
	expect(
		androidRuntime({ PROOF_ANDROID_RUNTIME: runtime, PROOF_ANDROID_JDK: jdk }),
	).toEqual({
		mounts: ["-v", `${runtime}:${runtime}:ro`, "-v", `${jdk}:${jdk}:ro`],
		environment: [
			"-e",
			`PROOF_ANDROID_RUNTIME=${runtime}`,
			"-e",
			`PROOF_ANDROID_JDK=${jdk}`,
		],
	});
	expect(androidRuntime({})).toEqual({ mounts: [], environment: [] });
	expect(() =>
		androidRuntime({ PROOF_ANDROID_RUNTIME: join(scratch, "absent") }),
	).toThrow("PROOF_ANDROID_RUNTIME names");
});

it("reads a container's memory as docker stats prints it", () => {
	expect(statsBytes("1.5GiB ")).toBe(1.5 * 1024 ** 3);
	expect(statsBytes("512MiB")).toBe(512 * 1024 ** 2);
	expect(statsBytes("10kB")).toBe(10_000);
	expect(statsBytes("--")).toBeNull();
});

/** `npm run surface`, writing the extraction into the test's own `output` and the surface to `destination`. */
async function regenerate(destination: string, output: string) {
	const call = JSON.stringify([
		RUNNER,
		"surface",
		[{ destination, output, checkout: await smallCheckout() }],
	]);
	try {
		await run(
			process.execPath,
			["--input-type=module", "-e", CALL_RUNNER, call],
			{ cwd: WORKTREE, env: environmentOf({}) },
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
	expect(await readFile(destination, "utf8")).toBe(
		'{"items":{"generated":{}}}\n',
	);
	const extraction = (await calls(log)).find((call) =>
		call.includes("proof.lane.extraction"),
	);
	expect(extraction?.slice(0, 4)).toEqual(["run", "--rm", "--network", "none"]);
	expect(readOnlyMountOf(extraction, "/work")).toBeDefined();
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

// What the extraction wrote is data: a surface that is a link, or no surface JSON, never reaches the checkout.
it.each([
	["a link to a host file", "link", 6],
	["not JSON", "text", 1],
	["JSON with no items", "itemless", 1],
] as const)(
	"leaves the committed surface alone when the extraction's surface is %s",
	async (_, kind, code) => {
		const secret = join(scratch, "secret.json");
		await writeFile(secret, '{"items":{"secret":{}}}\n');
		await fakeDocker({
			installed: 0,
			npmCi: 0,
			harness: 0,
			surface: 0,
			surfaceFile:
				kind === "link"
					? { link: secret }
					: { text: kind === "text" ? "not json\n" : '{"generated":true}\n' },
		});
		const destination = join(scratch, "surface.json");
		await writeFile(destination, "committed\n");
		expect(await regenerate(destination, join(scratch, "extraction"))).toBe(
			code,
		);
		expect(await readFile(destination, "utf8")).toBe("committed\n");
	},
);

// Execute the workflow's actual shell and the runner's real CLI; Docker alone is controlled.
// This catches a cold cache being refused before the server starts, and shell status mapping
// hiding that refusal as a check failure. No HQ image or long-running proof is needed. The CLI
// fingerprints this checkout and makes the container's view of its harness, seconds each on a
// shared runner, where the default five would decide by the runner's load.
it.each([
	{ readers: "0", warm: false, server: 0, missingQueue: false, expected: 0 },
	{ readers: "all", warm: false, server: 0, missingQueue: false, expected: 0 },
	{ readers: "0", warm: true, server: 1, missingQueue: false, expected: 0 },
	{ readers: "0", warm: false, server: 3, missingQueue: false, expected: 3 },
	{
		readers: "0",
		warm: false,
		server: 130,
		missingQueue: false,
		expected: 130,
	},
	{ readers: "0", warm: false, server: 0, missingQueue: true, expected: 2 },
])(
	"holds the shard workflow boundary: $readers, warm=$warm, server=$server, missingQueue=$missingQueue",
	async ({ readers, warm, server, missingQueue, expected }) => {
		const workflow = parse(
			await readFile(
				join(WORKTREE, ".github/workflows/proof-lane.yml"),
				"utf8",
			),
		);
		const steps = workflow.jobs.shard.steps as {
			name?: string;
			run?: string;
			with?: Record<string, string>;
		}[];
		const prepare = steps.find(
			(step) => step.name === "Prepare the shard's evidence store",
		);
		const lane = steps.find((step) => step.name === "Proof lane");
		expect(prepare?.run).toBeDefined();
		expect(lane?.run).toBeDefined();
		const clock = String(Math.floor(Date.now() / 1000));
		// The host uses Ubuntu's GNU timeout. Other test platforms can still exercise the exact workflow command.
		await writeFile(
			join(scratch, "timeout"),
			'#!/bin/sh\n[ "$1" = "--kill-after=30s" ] || exit 127\nshift 2\nexec "$@"\n',
			{ mode: 0o755 },
		);
		const store = join(scratch, "store/main");
		if (warm) {
			await mkdir(store, { recursive: true });
			await writeFile(join(store, "retained"), "restored evidence");
		}
		await mkdir(join(scratch, "lane"));
		if (!missingQueue)
			await writeFile(
				join(scratch, "lane/proof-early-queue-audit-1.json"),
				"{}\n",
			);
		const log = await fakeDocker({ installed: 0, npmCi: 0, harness: server });
		const env = environmentOf({
			PROOF_SHARD_STARTED_AT: clock,
			PROOF_SHARD_MINUTES: "20",
			RUNNER_TEMP: scratch,
			LABEL: "audit",
			ATTEMPT: "1",
			SHARD: "1/1",
			WORKERS: "1",
			LANE_ENV: "",
			CLAIMS: "static",
			PROOF_READERS: readers,
			PROOF_STORE: store,
			PROOF_CORPUS: join(scratch, "corpus"),
			PROOF_OUT_DIR: join(scratch, "out"),
		});
		await run("bash", ["-e", "-c", prepare?.run ?? ""], { cwd: WORKTREE, env });
		let code = 0;
		let stderr = "";
		try {
			await run("bash", ["-e", "-c", lane?.run ?? ""], { cwd: WORKTREE, env });
		} catch (error) {
			({ code, stderr } = error as { code: number; stderr: string });
		}
		expect(code).toBe(expected);
		const invoked = await calls(log);
		if (missingQueue) {
			expect(stderr).toContain("download it before starting the shard");
			expect(invoked).toEqual([]);
		} else {
			expect(invoked.find(composeRun)).toContain(`${store}:/store:ro`);
			expect(invoked.filter(composeDown)).toHaveLength(1);
		}
		if (warm)
			expect(await readFile(join(store, "retained"), "utf8")).toBe(
				"restored evidence",
			);
		// Even a process that dies before producing evidence must fail at the upload boundary.
		expect(
			steps.find((step) => step.with?.path?.endsWith("/proof-out/"))?.with?.[
				"if-no-files-found"
			],
		).toBe("error");
	},
	30_000,
);
