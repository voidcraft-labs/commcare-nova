// Runs the proof harness (proof/README.md): `npm run proof -- [--workers k] [pytest args]`,
// and regenerates the surface manifest's generated half: `npm run surface`.
//
// It runs the pinned harness image (proof/image.lock, or PROOF_IMAGE) beside a
// Postgres it starts and removes (proof/compose.yaml), with this checkout
// mounted read-only at /work, Linux node_modules for it, and the run's output
// directory mounted writable at /out. Inside the image one process, the lane's
// fork server (python -m proof.lane.serve), boots HQ once and forks k pytest
// workers (`--workers k`, default 1) that run what pytest collects from the
// arguments as one block it claims itself (or, with `--bin i/n`, bin i of n of
// the collected groups, each a block of its own). An argument naming a path in this
// checkout is rewritten to that path under /work, and with none the whole
// harness runs.
//
// The run's output directory is PROOF_OUT_DIR when set (a new or empty
// directory), and otherwise a directory of its own under .proof/runs, with
// .proof/out a link to the latest run. A run removes only the directories of
// earlier runs whose process has ended, so lanes running at once in one
// checkout never remove each other's output. The server records the run in
// serve.json and each block's items, outcomes and evidence under blocks/<id>/
// (proof/lane/blocks.py); `python3 -m proof.lane.gate .proof/out` holds a
// finished run to the lane's verdict.
//
// PROOF_CORPUS_SAMPLE, PROOF_CORPUS_SEED and the audit switches
// PROOF_HQ_SPEED, PROOF_HQ_DETERMINISM, PROOF_VERIFY_MEMOS,
// PROOF_EDITOR_AUDIT and PROOF_BRANCH_DOCUMENTS (proof/hq/speed.py,
// proof/hq/determinism.py, proof/hq/seams.py, proof/editors/pages.py,
// proof/hq/test_branches.py) pass through to the harness, and
// nothing else of this machine's environment does; PROOF_CORPUS names a corpus
// directory on this machine, mounted read-only for the checks to read instead
// of emitting one, and PROOF_SURFACE_EXTRACTION a directory holding a surface
// extraction (surface.json, timings.json and its key, extraction.json, as
// `npm run surface` leaves in .proof/surface), mounted read-only for the
// surface tests to read instead of extracting again when its key is the run's
// (proof/surface/conftest.py, proof/lane/extraction.py). PROOF_STORE names
// an evidence store directory on this machine (a restored snapshot,
// proof/store), mounted read-only at /store for the lane to read records and
// judgments from. Every container gets the image's content-addressed id as
// PROOF_IMAGE_ID, the image half of that key, and every lane container the
// evidence store's fingerprints of this checkout as PROOF_FINGERPRINTS
// (`python3 -m proof.store.fingerprints`): its code's partitions, the image
// (the digest its reference pins, or its id) and the Docker server's
// architecture, which every key the store keeps a record under names; where
// python3 or git cannot give them, the lane runs with the store off.
//
// `node proof/run.mjs --lane [options]` is one CI shard: the same container,
// with no node_modules (a shard runs no Nova TypeScript), serving the queues
// the workflow downloaded. `--early-queue FILE` and `--queue FILE` name them
// (the main queue may arrive later, in a directory mounted writable),
// `--claim '<command> {block}'` claims each block, `--wait-for '<command>'`
// brings the main queue and the corpus, `--bin i/n` takes a static bin instead
// of claiming, `--label` names the shard, and `--command-env A,B` passes those
// variables to the claim and wait commands only. A shard never emits the
// corpus: with `--queue`, PROOF_CORPUS must name the directory the corpus is
// downloaded or brought into (mounted writable).
//
// `node proof/run.mjs --matrix [shards|default]` prints CI's proof matrix
// (proof/timings.json's execution: shards on its runner, workers each), and
// `node proof/run.mjs --timings <output directory>...` writes the box-seconds
// per group those runs measured into proof/timings.json.

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import {
	copyFile,
	lstat,
	mkdir,
	readdir,
	readFile,
	rename,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const worktree = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const COMPOSE_FILE = join(worktree, "proof", "compose.yaml");
const TIMINGS_FILE = join(worktree, "proof", "timings.json");
const OUTPUT_ROOT = join(worktree, ".proof");

/** The variables of this machine's environment the harness reads, passed into its container unchanged. */
const PASSED_THROUGH = [
	"PROOF_CORPUS_SAMPLE",
	"PROOF_CORPUS_SEED",
	"PROOF_HQ_SPEED",
	"PROOF_HQ_DETERMINISM",
	"PROOF_VERIFY_MEMOS",
	"PROOF_EDITOR_AUDIT",
	"PROOF_BRANCH_DOCUMENTS",
];

/** Variables of the lane before its fork server, which no longer select anything. */
const RETIRED = ["PROOF_SHARD", "PROOF_WORKER"];

/** Runs a command with the terminal attached and resolves its exit code. */
function execute(command, args, options = {}) {
	return new Promise((resolveCode, reject) => {
		const child = spawn(command, args, { stdio: "inherit", ...options });
		child.on("error", reject);
		child.on("exit", (code, signal) => resolveCode(code ?? (signal ? 1 : 0)));
	});
}

/** Runs a command and resolves its exit code and what it printed on standard output. */
function capture(command, args, options = {}) {
	return new Promise((resolveResult, reject) => {
		const child = spawn(command, args, {
			stdio: ["ignore", "pipe", "ignore"],
			...options,
		});
		let stdout = "";
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.on("error", reject);
		child.on("close", (code, signal) =>
			resolveResult({ code: code ?? (signal ? 1 : 0), stdout }),
		);
	});
}

async function harnessImage() {
	if (process.env.PROOF_IMAGE) return process.env.PROOF_IMAGE;
	const lockPath = join(worktree, "proof", "image.lock");
	if (!existsSync(lockPath)) {
		throw new Error(
			"This checkout records no proof image yet (proof/image.lock is missing), and PROOF_IMAGE is not set.\n" +
				'Build the image locally (proof/README.md, "Building the image") and run again with PROOF_IMAGE=<its tag>.',
		);
	}
	const lock = JSON.parse(await readFile(lockPath, "utf8"));
	return lock.image;
}

/**
 * The image's content-addressed id (`docker image inspect`), which keys the
 * surface extraction (proof/lane/extraction.py); an image this machine does
 * not hold yet is pulled first.
 */
async function imageId(image) {
	const inspect = () =>
		capture("docker", ["image", "inspect", "--format", "{{.Id}}", image]);
	let found = await inspect();
	if (found.code !== 0) {
		const pulled = await execute("docker", ["pull", image]);
		if (pulled !== 0) {
			throw new Error(
				`This machine does not hold the proof image ${image}, and pulling it failed (docker pull exited ${pulled}); the output above says why.`,
			);
		}
		found = await inspect();
	}
	const id = found.stdout.trim();
	if (found.code !== 0 || !/^sha256:[0-9a-f]{64}$/.test(id)) {
		throw new Error(
			`docker image inspect could not give the proof image ${image}'s id (it exited ${found.code} and printed ${JSON.stringify(id)}), and the id keys the surface extraction.`,
		);
	}
	return id;
}

/**
 * The node_modules the harness mounts at /work/node_modules. On Linux the
 * checkout's own install already suits the image, so it is used in place;
 * elsewhere (a macOS checkout's native binaries cannot run in the container)
 * a Docker volume keyed by package-lock.json holds a Linux install, filled
 * with `npm ci` the first time that lock is seen.
 */
async function nodeModules(image, platform) {
	const hostInstall = join(worktree, "node_modules");
	if (
		platform === "linux" &&
		existsSync(join(hostInstall, ".package-lock.json"))
	) {
		return hostInstall;
	}
	const lock = await readFile(join(worktree, "package-lock.json"));
	const key = createHash("sha256").update(lock).digest("hex").slice(0, 16);
	const volume = `nova-proof-node-modules-${key}`;
	const installed = await execute(
		"docker",
		[
			"run",
			"--rm",
			"-v",
			`${volume}:/modules`,
			image,
			"test",
			"-f",
			"/modules/.package-lock.json",
		],
		{ stdio: "ignore" },
	);
	if (installed !== 0) {
		console.error(
			`Installing Nova's dependencies for Linux into the Docker volume ${volume} (once per package-lock.json).`,
		);
		const code = await execute("docker", [
			"run",
			"--rm",
			"-v",
			`${worktree}:/work:ro`,
			"-v",
			`${volume}:/work/node_modules`,
			"-v",
			"nova-proof-npm-cache:/root/.npm",
			"-w",
			"/work",
			image,
			"npm",
			"ci",
			"--ignore-scripts",
			"--no-audit",
			"--no-fund",
		]);
		if (code !== 0) {
			await execute("docker", ["volume", "rm", "--force", volume], {
				stdio: "ignore",
			});
			throw new Error(
				`npm ci failed inside the proof image (exit ${code}), so the harness has no Linux node_modules to run Nova's producers with.\n` +
					"The npm output above says why; the half-filled volume was removed, so the next run installs again.",
			);
		}
	}
	return volume;
}

// pytest's options whose value, written as the next argument or after `=`, names a path: rewritten under /work
// like a target, but no target itself.
const PATH_OPTIONS = new Set([
	"--ignore",
	"--ignore-glob",
	"--deselect",
	"--confcutdir",
	"--basetemp",
	"--rootdir",
	"-c",
	"--config-file",
	"--junit-xml",
	"--junitxml",
	"--log-file",
]);
// pytest's options whose value, written as the next argument, is an expression or a name, never a path.
const VALUE_OPTIONS = new Set(["-k", "-m", "-p", "-o", "--override-ini"]);

/** The path `value` names under /work, with its `::` selector, when it names one in this checkout. */
function inCheckout(value) {
	const [path, ...selector] = value.split("::");
	const absolute = resolve(process.cwd(), path);
	if (!existsSync(absolute) || relative(worktree, absolute).startsWith("..")) {
		return undefined;
	}
	return [join("/work", relative(worktree, absolute)), ...selector].join("::");
}

/** pytest's arguments for the server, with each path in this checkout rewritten under /work, and the whole
 * harness as the target when none of them is one. */
function pytestArguments(args) {
	let hasTarget = false;
	const rewritten = args.map((arg, index) => {
		const previous = args[index - 1];
		if (arg.startsWith("-")) {
			const [option, ...value] = arg.split("=");
			const moved =
				value.length > 0 && PATH_OPTIONS.has(option)
					? inCheckout(value.join("="))
					: undefined;
			return moved === undefined ? arg : `${option}=${moved}`;
		}
		if (VALUE_OPTIONS.has(previous)) return arg;
		const moved = inCheckout(arg);
		if (moved === undefined) return arg;
		if (!PATH_OPTIONS.has(previous)) hasTarget = true;
		return moved;
	});
	return [
		"-c",
		"/work/proof/pytest.ini",
		"--rootdir",
		"/work/proof",
		...rewritten,
		...(hasTarget ? [] : ["/work/proof"]),
	];
}

/** A whole number of at least one, or the refusal naming where it came from. */
function count(value, name) {
	const number = Number(value);
	if (!Number.isSafeInteger(number) || number < 1) {
		throw new Error(
			`${name} takes a whole number of at least one; got ${JSON.stringify(value)}.`,
		);
	}
	return number;
}

/** The refusal for a variable of the lane before its fork server, if one is set. */
function refuseRetired() {
	const set = RETIRED.filter((name) => process.env[name]);
	if (set.length > 0) {
		throw new Error(
			`${set.join(" and ")} ${set.length === 1 ? "is" : "are"} set, and the lane no longer splits its items by them: its server forks its own workers (--workers k), and CI shards claim blocks from a queue.\n` +
				`Unset ${set.join(" and ")}.`,
		);
	}
}

/** `i/n` with 1 <= i <= n, each written in digits alone, or the refusal naming the option. */
function position(value, name) {
	const match = /^(\d+)\/(\d+)$/.exec(value ?? "");
	const [index, total] = match ? [Number(match[1]), Number(match[2])] : [];
	if (!match || total < 1 || index < 1 || index > total) {
		throw new Error(
			`${name} names one of several as i/n, with i from 1 to n (such as 2/4); got ${JSON.stringify(value)}.`,
		);
	}
	return value;
}

/**
 * `--workers k` and `--bin i/n` taken out of the arguments, and the rest,
 * which are pytest's. With `--bin i/n` the server runs bin i of n of the
 * collected groups, so n runs over one collection run it all between them.
 */
export function laneOptions(args) {
	let workers = 1;
	let bin;
	const pytest = [];
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--workers") {
			workers = count(args[++index], "--workers");
		} else if (arg.startsWith("--workers=")) {
			workers = count(arg.slice("--workers=".length), "--workers");
		} else if (arg === "--bin") {
			bin = position(args[++index], "--bin");
		} else if (arg.startsWith("--bin=")) {
			bin = position(arg.slice("--bin=".length), "--bin");
		} else {
			pytest.push(arg);
		}
	}
	return { workers, bin, pytest };
}

/** Whether the process `pid` is still running on this machine. */
function running(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error.code === "EPERM";
	}
}

/**
 * What a run's owner file says of the run: "none" when there is no owner
 * file, "finished" when it names a process that has ended, and "live" when
 * the process still runs or the file cannot be read as an owner (which only
 * a run can explain, so its output is kept).
 */
async function ownerState(owner) {
	let text;
	try {
		text = await readFile(owner, "utf8");
	} catch (error) {
		return error.code === "ENOENT" ? "none" : "live";
	}
	let pid;
	try {
		pid = JSON.parse(text).pid;
	} catch {
		return "live";
	}
	if (!Number.isSafeInteger(pid) || pid < 1) return "live";
	return running(pid) ? "live" : "finished";
}

/**
 * Remove the output of every earlier run whose process has ended. Each run
 * directory under .proof/runs has an owner file beside it naming its
 * process, moved into place whole before the directory is made, so a
 * directory without one belongs to no run (an output an earlier runner left
 * at .proof/out, moved aside), and one whose owner is unreadable is kept.
 */
async function removeFinishedRuns(runs) {
	for (const entry of await readdir(runs, { withFileTypes: true })) {
		const id = entry.name.endsWith(".owner")
			? entry.name.slice(0, -".owner".length)
			: entry.name;
		const owner = join(runs, `${id}.owner`);
		if ((await ownerState(owner)) === "live") continue;
		await rm(join(runs, id), { recursive: true, force: true });
		await rm(owner, { force: true });
	}
}

/** Point `latest` (.proof/out) at `directory`, moving an output directory an earlier runner left there into `runs`. */
async function pointLatestAt(latest, runs, directory) {
	const existing = await lstat(latest).catch(() => undefined);
	if (existing?.isDirectory()) {
		// A run starting at the same moment may have moved it first.
		await rename(
			latest,
			join(runs, `earlier-${randomBytes(4).toString("hex")}`),
		).catch((error) => {
			if (error.code !== "ENOENT") throw error;
		});
	}
	const staged = `${latest}.${randomBytes(4).toString("hex")}`;
	await symlink(relative(dirname(latest), directory), staged);
	await rename(staged, latest);
}

/**
 * The run's output directory: PROOF_OUT_DIR, which must be new or empty so
 * nothing an earlier run left there stands in for this run's evidence, or a
 * directory of this run's own under .proof/runs, which .proof/out then
 * links to.
 */
export async function runOutput({ root = OUTPUT_ROOT } = {}) {
	const named = process.env.PROOF_OUT_DIR;
	if (named) {
		const directory = resolve(process.cwd(), named);
		await mkdir(directory, { recursive: true });
		const held = await readdir(directory);
		if (held.length > 0) {
			throw new Error(
				`PROOF_OUT_DIR names ${directory}, which already holds ${held.length} entries (${held.slice(0, 3).join(", ")}${held.length > 3 ? ", …" : ""}).\n` +
					"The lane writes into a new or empty directory, so nothing an earlier run left there can stand in for this run's evidence. Name another directory, or empty this one.",
			);
		}
		return directory;
	}
	const runs = join(root, "runs");
	await mkdir(runs, { recursive: true });
	await removeFinishedRuns(runs);
	const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}`;
	// The owner file is written beside runs/ and moved in whole, so a run
	// starting at the same moment never reads it half written.
	const staged = join(root, `.${id}.owner`);
	await writeFile(staged, `${JSON.stringify({ pid: process.pid })}\n`);
	await rename(staged, join(runs, `${id}.owner`));
	const directory = join(runs, id);
	await mkdir(directory);
	await pointLatestAt(join(root, "out"), runs, directory);
	return directory;
}

/** The corpus directory PROOF_CORPUS names on this machine, if it names one. */
function namedCorpus() {
	const named = process.env.PROOF_CORPUS;
	if (!named) return undefined;
	const directory = resolve(process.cwd(), named);
	if (!existsSync(join(directory, "index.json"))) {
		throw new Error(
			`PROOF_CORPUS names ${directory}, which holds no index.json, so it is not a corpus the checks can read.\n` +
				"Name a directory proof/corpus/emit.ts wrote (proof/README.md), or unset PROOF_CORPUS to have the lane emit one.",
		);
	}
	return directory;
}

/**
 * The mount and variable for the surface extraction PROOF_SURFACE_EXTRACTION
 * names on this machine, if it names one: the surface tests read it instead
 * of extracting again, and the surface block keeps a copy for the gate.
 */
function namedExtraction() {
	const named = process.env.PROOF_SURFACE_EXTRACTION;
	if (!named) return { mounts: [], environment: [] };
	const directory = resolve(process.cwd(), named);
	const missing = ["surface.json", "timings.json", "extraction.json"].filter(
		(name) => !existsSync(join(directory, name)),
	);
	if (missing.length > 0) {
		throw new Error(
			`PROOF_SURFACE_EXTRACTION names ${directory}, which holds no ${missing.join(" or ")}, so it is not an extraction the surface tests can read.\n` +
				"Name the directory `npm run surface` writes (.proof/surface), or unset PROOF_SURFACE_EXTRACTION to have the surface tests extract again.",
		);
	}
	return {
		mounts: ["-v", `${directory}:/surface-extraction:ro`],
		environment: ["-e", "PROOF_SURFACE_EXTRACTION=/surface-extraction"],
	};
}

/**
 * The mount and variable for the evidence store PROOF_STORE names on this
 * machine, if it names one: the lane reads it, read-only, at /store.
 */
function namedStore() {
	const named = process.env.PROOF_STORE;
	if (!named) return { mounts: [], environment: [] };
	const directory = resolve(process.cwd(), named);
	if (!existsSync(directory)) {
		throw new Error(
			`PROOF_STORE names ${directory}, which does not exist, so there is no evidence store to read.\n` +
				"Name the directory a store snapshot was restored or merged into, or unset PROOF_STORE to run with no store.",
		);
	}
	return {
		mounts: ["-v", `${directory}:/store:ro`],
		environment: ["-e", "PROOF_STORE=/store"],
	};
}

/**
 * The `-e` flag carrying the evidence store's fingerprints of this checkout
 * into the lane (PROOF_FINGERPRINTS), or none, with a note, where they cannot
 * be computed here: the store then keeps and reads nothing.
 */
async function laneFingerprints(image, id) {
	const pinned = /@(sha256:[0-9a-f]{64})$/.exec(image)?.[1];
	const server = await capture("docker", [
		"version",
		"--format",
		"{{.Server.Arch}}",
	]).catch(() => ({ code: 1, stdout: "" }));
	const arch = server.stdout.trim();
	const found = await capture(
		"python3",
		[
			"-m",
			"proof.store.fingerprints",
			"--image",
			pinned ?? id,
			...(["arm64", "amd64"].includes(arch) ? ["--arch", arch] : []),
		],
		{ cwd: worktree },
	).catch(() => ({ code: 1, stdout: "" }));
	if (found.code !== 0 || !found.stdout.trim()) {
		console.error(
			"The evidence store's fingerprints of this checkout could not be computed (python3 -m proof.store.fingerprints" +
				` exited ${found.code}), so the lane runs with the store off: nothing is read from it or kept for it.`,
		);
		return [];
	}
	return ["-e", `PROOF_FINGERPRINTS=${found.stdout.trim()}`];
}

/** `-e` flags for the variables the harness reads from this machine's environment. */
function passedThrough(names = PASSED_THROUGH) {
	return names.flatMap((name) =>
		process.env[name] ? ["-e", `${name}=${process.env[name]}`] : [],
	);
}

/**
 * Regenerates lib/commcare/surface/surface.json from the upstream checkouts
 * the harness image holds at the pins (`python -m proof.lane.extraction`),
 * leaving the extraction, its timings and its key (the image's id and the
 * extractor code's digest) in `output`, .proof/surface by default, where
 * PROOF_SURFACE_EXTRACTION can name it. The extraction reads code, never data
 * or the network, so it runs with no network at all.
 */
export async function surface({
	destination = join(worktree, "lib", "commcare", "surface", "surface.json"),
	output = join(worktree, ".proof", "surface"),
} = {}) {
	const image = await harnessImage();
	const id = await imageId(image);
	await rm(output, { recursive: true, force: true });
	await mkdir(output, { recursive: true });
	const code = await execute("docker", [
		"run",
		"--rm",
		"--network",
		"none",
		"-v",
		`${worktree}:/work:ro`,
		"-v",
		`${output}:/out`,
		"-e",
		`PROOF_IMAGE_ID=${id}`,
		image,
		"python",
		"-m",
		"proof.lane.extraction",
		"--out",
		"/out",
	]);
	if (code !== 0) return code;
	await copyFile(join(output, "surface.json"), destination);
	console.error(`Wrote ${relative(worktree, destination)}.`);
	return 0;
}

/**
 * Runs the harness container, `serve` its fork server's arguments, `mounts`
 * and `environment` its own, and removes the lane (Postgres and its volume)
 * however the run ends.
 */
async function runServer({ image, mounts, environment, serve }) {
	const project = `nova-proof-${randomBytes(4).toString("hex")}`;
	const compose = ["compose", "-f", COMPOSE_FILE, "-p", project];
	const env = { ...process.env, PROOF_IMAGE: image };
	const down = () =>
		execute("docker", [...compose, "down", "--volumes", "--remove-orphans"], {
			env,
			stdio: "ignore",
		});
	const interrupted = () => {
		down().finally(() => process.exit(130));
	};
	process.once("SIGINT", interrupted);
	process.once("SIGTERM", interrupted);
	try {
		return await execute(
			"docker",
			[
				...compose,
				"run",
				"--rm",
				...mounts,
				...environment,
				"harness",
				"python",
				"-m",
				"proof.lane.serve",
				"--out",
				"/out",
				...serve,
			],
			{ env },
		);
	} finally {
		process.off("SIGINT", interrupted);
		process.off("SIGTERM", interrupted);
		await down();
	}
}

/** `npm run proof`: the whole lane, or what the arguments select, on this machine. */
export async function main(
	args,
	{ platform = process.platform, outputRoot = OUTPUT_ROOT } = {},
) {
	refuseRetired();
	const lane = laneOptions(args);
	const corpus = namedCorpus();
	const extraction = namedExtraction();
	const store = namedStore();
	const image = await harnessImage();
	const id = await imageId(image);
	const modules = await nodeModules(image, platform);
	const output = await runOutput({ root: outputRoot });
	console.error(`The proof lane writes its output into ${output}.`);
	return runServer({
		image,
		mounts: [
			"-v",
			`${worktree}:/work:ro`,
			"-v",
			`${modules}:/work/node_modules`,
			"-v",
			`${output}:/out`,
			...(corpus ? ["-v", `${corpus}:/corpus:ro`] : []),
			...extraction.mounts,
			...store.mounts,
		],
		environment: [
			...passedThrough(),
			"-e",
			`PROOF_IMAGE_ID=${id}`,
			...(await laneFingerprints(image, id)),
			...(corpus ? ["-e", "PROOF_CORPUS=/corpus"] : []),
			...extraction.environment,
			...store.environment,
		],
		serve: [
			"--workers",
			String(lane.workers),
			"--claim",
			"static",
			...(lane.bin ? ["--bin", lane.bin] : []),
			"--",
			...pytestArguments(lane.pytest),
		],
	});
}

/** The `--lane` options, each a value taken from the arguments. */
export function shardOptions(args) {
	const options = {
		workers: undefined,
		label: undefined,
		earlyQueue: undefined,
		queue: undefined,
		claim: undefined,
		bin: undefined,
		waitFor: undefined,
		commandEnv: [],
	};
	const names = {
		"--workers": "workers",
		"--label": "label",
		"--early-queue": "earlyQueue",
		"--queue": "queue",
		"--claim": "claim",
		"--bin": "bin",
		"--wait-for": "waitFor",
		"--command-env": "commandEnv",
	};
	for (let index = 0; index < args.length; index++) {
		const name = names[args[index]];
		const value = args[index + 1];
		if (name === undefined || value === undefined) {
			throw new Error(
				`--lane takes ${Object.keys(names).join(", ")}, each with a value; got ${JSON.stringify(args[index])}${value === undefined ? " without one" : ""}.`,
			);
		}
		options[name] =
			name === "commandEnv" ? value.split(",").filter(Boolean) : value;
		index++;
	}
	if (options.workers !== undefined)
		options.workers = count(options.workers, "--workers");
	if (!options.earlyQueue && !options.queue) {
		throw new Error(
			"--lane runs a shard over the lane's queues: name them with --early-queue and --queue.",
		);
	}
	return options;
}

/**
 * One CI shard: the harness container serving the queues, with the claim
 * and wait commands running inside it from /work. The main queue's
 * directory and the corpus directory are mounted writable, since the wait
 * command fills them; nothing of Nova's node_modules is mounted, so the
 * shard never emits the corpus, and a main queue needs PROOF_CORPUS.
 */
export async function shard(args, { outputRoot = OUTPUT_ROOT } = {}) {
	refuseRetired();
	const options = shardOptions(args);
	if (options.queue && !process.env.PROOF_CORPUS) {
		throw new Error(
			"--queue runs the corpus's documents, and PROOF_CORPUS names no corpus; a shard never emits one.\n" +
				"Download the corpus (or name the directory the --wait-for command brings it into) and set PROOF_CORPUS to it.",
		);
	}
	const early =
		options.earlyQueue && resolve(process.cwd(), options.earlyQueue);
	if (early && !existsSync(early)) {
		throw new Error(
			`The early queue ${early} does not exist; download it before starting the shard.`,
		);
	}
	const extraction = namedExtraction();
	const store = namedStore();
	const timings = JSON.parse(await readFile(TIMINGS_FILE, "utf8"));
	const workers =
		options.workers ??
		count(timings.execution?.workers, "The timings' worker count");
	const image = await harnessImage();
	const id = await imageId(image);
	const output = await runOutput({ root: outputRoot });
	const mounts = [
		"-v",
		`${worktree}:/work:ro`,
		"-v",
		`${output}:/out`,
		...extraction.mounts,
		...store.mounts,
	];
	const environment = [
		...passedThrough(),
		...passedThrough(options.commandEnv),
		"-e",
		`PROOF_IMAGE_ID=${id}`,
		...(await laneFingerprints(image, id)),
		...extraction.environment,
		...store.environment,
	];
	const serve = ["--workers", String(workers)];
	if (options.label) serve.push("--label", options.label);
	if (early) {
		mounts.push("-v", `${early}:/lane/early-queue.json:ro`);
		serve.push("--early-queue", "/lane/early-queue.json");
	}
	if (options.queue) {
		const queue = resolve(process.cwd(), options.queue);
		await mkdir(dirname(queue), { recursive: true });
		mounts.push("-v", `${dirname(queue)}:/lane/queue`);
		serve.push("--queue", `/lane/queue/${basename(queue)}`);
	}
	if (process.env.PROOF_CORPUS) {
		const corpus = resolve(process.cwd(), process.env.PROOF_CORPUS);
		await mkdir(corpus, { recursive: true });
		mounts.push("-v", `${corpus}:/corpus`);
		environment.push("-e", "PROOF_CORPUS=/corpus");
	}
	serve.push("--claim", options.claim ?? "static");
	if (options.bin) serve.push("--bin", options.bin);
	if (options.waitFor) serve.push("--wait-for", options.waitFor);
	if (options.commandEnv.length > 0)
		serve.push("--command-env", options.commandEnv.join(","));
	console.error(`The proof shard writes its output into ${output}.`);
	return runServer({ image, mounts, environment, serve });
}

/**
 * CI's proof matrix: `shards` jobs (`default`: proof/timings.json's
 * execution) on the execution's runner, each a fork server of the
 * execution's workers.
 */
export function proofMatrix(shards, timings) {
	const execution = timings.execution ?? {};
	const total = count(
		shards === "default" ? execution.shards : shards,
		"The shard count",
	);
	const workers = count(execution.workers, "The worker count");
	if (typeof execution.runner !== "string" || !execution.runner) {
		throw new Error(
			"proof/timings.json's execution names no runner for the shards (execution.runner).",
		);
	}
	return {
		include: Array.from({ length: total }, (_, index) => ({
			shard: index + 1,
			total,
			workers,
			runner: execution.runner,
		})),
	};
}

function mean(values) {
	return values.length === 0
		? null
		: Math.round(
				(values.reduce((sum, value) => sum + value, 0) / values.length) * 1000,
			) / 1000;
}

/**
 * proof/timings.json with each group's box-seconds measured by the runs whose
 * output directories are given: each worker's record (`timings/*.json`)
 * holds its groups' seconds and how many workers shared its box, and a
 * group's box-seconds are its seconds divided by that count (the mean where
 * several runs measured it). The mean of what a worker's session shares and
 * of the servers' fixed costs (serve.json) are kept beside them, with the
 * execution settings as they were.
 */
export async function refreshTimings(directories, previous) {
	if (directories.length === 0) {
		throw new Error(
			"Name the output directory of each finished lane run to measure: node proof/run.mjs --timings <output directory>...",
		);
	}
	const measured = new Map();
	const shared = [];
	const fixed = new Map();
	let sessions = 0;
	for (const directory of directories) {
		const root = resolve(process.cwd(), directory);
		const folder = join(root, "timings");
		const files = existsSync(folder)
			? (await readdir(folder)).filter((name) => name.endsWith(".json"))
			: [];
		if (files.length === 0) {
			throw new Error(
				`${directory} holds no timings/ from a lane run, so it measures no group. Name the output directory of a finished \`npm run proof\` run or CI shard.`,
			);
		}
		for (const file of files) {
			const record = JSON.parse(await readFile(join(folder, file), "utf8"));
			const workers = count(record.workers, `${file}'s workers`);
			sessions += 1;
			if (typeof record.shared === "number") shared.push(record.shared);
			for (const [group, seconds] of Object.entries(record.groups ?? {})) {
				measured.set(group, [
					...(measured.get(group) ?? []),
					seconds / workers,
				]);
			}
		}
		const serve = join(root, "serve.json");
		if (existsSync(serve)) {
			const record = JSON.parse(await readFile(serve, "utf8"));
			for (const [name, seconds] of Object.entries(record.fixed ?? {})) {
				if (typeof seconds === "number") {
					fixed.set(name, [...(fixed.get(name) ?? []), seconds]);
				}
			}
		}
	}
	const groups = Object.fromEntries(
		[...measured.keys()]
			.sort()
			.map((group) => [group, mean(measured.get(group))]),
	);
	return {
		about:
			"Box-seconds per group of the proof lane (proof/checks/sharding.py): a group's seconds on one worker, without what the worker's session shares, divided by the workers sharing its box. execution is CI's default shard count, runner and workers per shard. Refresh from hosted runs: node proof/run.mjs --timings <output directory>...",
		execution: previous.execution,
		measured: {
			at: new Date().toISOString().slice(0, 10),
			sessions,
			// What a worker's session spends beside its groups (its services), on average.
			sharedSeconds: mean(shared),
			// What a server spends before its first fork, on average.
			fixed: Object.fromEntries(
				[...fixed.keys()].sort().map((name) => [name, mean(fixed.get(name))]),
			),
		},
		groups,
	};
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const [command, ...rest] = process.argv.slice(2);
	const done = (code) => process.exit(code);
	const failed = (error) => {
		console.error(error.message);
		process.exit(1);
	};
	if (command === "--surface") {
		surface().then(done, failed);
	} else if (command === "--lane") {
		shard(rest).then(done, failed);
	} else if (command === "--matrix") {
		readFile(TIMINGS_FILE, "utf8")
			.then((text) => {
				console.log(
					JSON.stringify(proofMatrix(rest[0] ?? "default", JSON.parse(text))),
				);
				return 0;
			})
			.then(done, failed);
	} else if (command === "--timings") {
		readFile(TIMINGS_FILE, "utf8")
			.catch(() => "{}")
			.then(async (text) => {
				const refreshed = await refreshTimings(rest, JSON.parse(text));
				await writeFile(
					TIMINGS_FILE,
					`${JSON.stringify(refreshed, null, "\t")}\n`,
				);
				console.error(
					`Wrote ${relative(worktree, TIMINGS_FILE)}: ${Object.keys(refreshed.groups).length} groups from ${refreshed.measured.sessions} worker sessions.`,
				);
				return 0;
			})
			.then(done, failed);
	} else {
		main(process.argv.slice(2)).then(done, failed);
	}
}
