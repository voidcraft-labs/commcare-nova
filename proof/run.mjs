// Runs the proof harness (proof/README.md): `npm run proof -- [--workers k] [pytest args]`,
// and regenerates the surface manifest's generated half: `npm run surface`.
//
// It runs the pinned harness image (proof/image.lock, or PROOF_IMAGE) beside a
// Postgres it starts and removes (proof/compose.yaml), with a view of this
// checkout mounted read-only at /work, Linux node_modules for it, read-only,
// and the run's output directory mounted writable at /out. Inside the image one process, the lane's
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
// PROOF_CORPUS_SAMPLE, PROOF_CORPUS_SEED, the lane switch PROOF_READERS
// (proof/lane/readers.py: PROOF_READERS=0 is the pull request lane, which
// hands no state to the readers and leaves every test that starts one to the
// nightly) and the audit switches PROOF_HQ_SPEED, PROOF_HQ_DETERMINISM,
// PROOF_VERIFY_MEMOS, PROOF_EDITOR_AUDIT and PROOF_BRANCH_DOCUMENTS
// (proof/hq/speed.py, proof/hq/determinism.py, proof/hq/seams.py,
// proof/editors/pages.py, proof/hq/test_branches.py) pass through to the
// harness, and nothing else of this machine's environment does; PROOF_CORPUS names a corpus
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
// (the main queue may arrive later, in a directory mounted read-only),
// `--claim '<command> {block}'` claims each block, `--wait-for '<command>'`
// brings the main queue and the corpus, `--bin i/n` takes a static bin instead
// of claiming, and `--label` names the shard. The claim and wait commands run
// here on the host, never in the container (proof/ci/hostCommands.mjs), so
// the job's artifact-service credentials stay outside it. A shard never emits
// the corpus: with `--queue`, PROOF_CORPUS must name the directory the corpus
// is downloaded or brought into (mounted read-only). Hosted CI calls `--hosted-lane`,
// which gives the server its work deadline from the start of shard preparation.
//
// What the container wrote is data (proof/ci/untrusted.mjs). It sees the
// checkout as a view of the files git lists (checkoutView: no ignored file,
// no .git), with node_modules read-only, and once it has exited the run's
// output is sealed: one holding anything but directories and plain files is
// moved to `<output>.refused` and the run exits SEAL_REFUSED (6), so no
// later step uploads, adopts or reads through a link a container left.
// `node proof/run.mjs --seal DIRECTORY` seals another job's container output
// the same way. Hosted CI uses `--seal-hosted` to stop any remaining harness writer first.
//
// `node proof/run.mjs --matrix [shards|default] [--deadline minutes]` prints
// CI's proof matrix (proof/timings.json's execution of the profile
// PROOF_READERS names: shards on its runner, workers each; a count from
// `python3 -m proof.lane.plan`, which sizes a lane from its queues), and
// `node proof/run.mjs --timings <output
// directory>... [--box-workers n]` writes the box-seconds per group those runs
// measured into proof/timings.json, under the profile they ran in.

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import {
	copyFile,
	link,
	lstat,
	mkdir,
	readdir,
	readFile,
	readlink,
	rename,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { constants } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startCheckpoints } from "./ci/checkpoints.mjs";
import { hostCommands } from "./ci/hostCommands.mjs";
import {
	HOSTED_CONTAINER,
	hostedBudget,
	hostedCutoffs,
	stopHostedWriter,
} from "./ci/hosted-shard.mjs";
import { readSurface, SEAL_REFUSED, sealOutput } from "./ci/untrusted.mjs";

const worktree = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const COMPOSE_FILE = join(worktree, "proof", "compose.yaml");
const TIMINGS_FILE = join(worktree, "proof", "timings.json");
const OUTPUT_ROOT = join(worktree, ".proof");

/** The variables of this machine's environment the harness reads, passed into its container unchanged. */
const PASSED_THROUGH = [
	"PROOF_CORPUS_SAMPLE",
	"PROOF_CORPUS_SEED",
	"PROOF_ENTROPY",
	"PROOF_READERS",
	"PROOF_HQ_SPEED",
	"PROOF_HQ_DETERMINISM",
	"PROOF_VERIFY_MEMOS",
	"PROOF_EDITOR_AUDIT",
	"PROOF_BRANCH_DOCUMENTS",
	"PROOF_REPLAY_STAGE",
];

/** Variables of the lane before its fork server, which no longer select anything. */
const RETIRED = ["PROOF_SHARD", "PROOF_WORKER"];

/**
 * The lane's profile (proof/lane/readers.py): `readers` where the served
 * states are handed to the readers, `no-readers` under PROOF_READERS=0.
 *
 * @param {boolean} readers
 */
export function profileName(readers) {
	return readers ? "readers" : "no-readers";
}

/** Whether this machine's environment runs the lane with any reader (PROOF_READERS unset, `all`, or a list): a slice of some readers is planned by the readers profile. */
function readersServed(env = process.env) {
	return env.PROOF_READERS !== "0";
}

/**
 * proof/timings.json's measures of one profile: its `execution` (CI's
 * shards, runner and workers a shard) and its `groups`.
 *
 * @param {any} timings
 * @param {boolean} readers
 */
export function timingsProfile(timings, readers) {
	return timings?.profiles?.[profileName(readers)] ?? {};
}

// Preserve signal death at the shell boundary. Exit 1 means the checks finished with failures.
function childExit(code, signal) {
	return code ?? (signal ? 128 + constants.signals[signal] : 0);
}

/** Runs a command with the terminal attached and resolves its exit code. */
function execute(command, args, options = {}) {
	return new Promise((resolveCode, reject) => {
		const child = spawn(command, args, { stdio: "inherit", ...options });
		child.on("error", reject);
		child.on("exit", (code, signal) => resolveCode(childExit(code, signal)));
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
			resolveResult({ code: childExit(code, signal), stdout }),
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
 * The node_modules the harness mounts, read-only, at /work/node_modules. On
 * Linux the checkout's own install already suits the image, so it is used in
 * place; elsewhere (a macOS checkout's native binaries cannot run in the
 * container) a Docker volume keyed by package-lock.json holds a Linux
 * install, filled with `npm ci` over the checkout's view (`view`) the first
 * time that lock is seen. Nothing the container runs can write either: the
 * harness's own writes go to /out and the container's temporary directory.
 */
async function nodeModules(image, platform, view, replayProject) {
	const hostInstall = join(worktree, "node_modules");
	if (
		platform === "linux" &&
		existsSync(join(hostInstall, ".package-lock.json"))
	) {
		return hostInstall;
	}
	const lock = await readFile(join(worktree, "package-lock.json"));
	const key = createHash("sha256").update(lock).digest("hex").slice(0, 16);
	let volume = `nova-proof-node-modules-${key}`;
	const name = replayProject ? ["--name", `${replayProject}-deps`] : [];
	const installed = await execute(
		"docker",
		[
			"run",
			"--rm",
			...name,
			"-v",
			`${volume}:/modules`,
			image,
			"test",
			"-f",
			"/modules/.nova-zip64-descriptors-v1",
		],
		{ stdio: "ignore" },
	);
	if (installed !== 0) {
		if (replayProject) volume = `${replayProject}-modules`;
		console.error(
			`Installing Nova's dependencies for Linux into the Docker volume ${volume} (once per package-lock.json).`,
		);
		const code = await execute("docker", [
			"run",
			"--rm",
			...name,
			"-v",
			`${view}:/work:ro`,
			"-v",
			`${volume}:/work/node_modules`,
			"-v",
			"nova-proof-npm-cache:/root/.npm",
			"-w",
			"/work",
			image,
			"sh",
			"-ec",
			'"$@" && node scripts/fix-yazl-descriptors.mjs && touch node_modules/.nova-zip64-descriptors-v1',
			"install-nova-deps",
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

/** The file a copy of the checkout without git lists its files in, NUL-separated (proof/remote/run.sh writes it). */
export const CHECKOUT_FILES = join(".proof", "checkout-files");

/**
 * The checkout's files the harness's container may see: every file git
 * lists (tracked, and untracked but not ignored, so an uncommitted edit
 * runs), and nothing git ignores (an `.env`, a key, `.git` itself with any
 * credential it holds). In a copy without git (a proof machine's slot) they
 * are the ones CHECKOUT_FILES lists, and with neither the run is refused.
 */
async function checkoutFiles(root) {
	if (existsSync(join(root, ".git"))) {
		const listed = await capture("git", [
			"-C",
			root,
			"ls-files",
			"-z",
			"--cached",
			"--others",
			"--exclude-standard",
		]);
		if (listed.code !== 0) {
			throw new Error(
				`git could not list the files of ${root} (it exited ${listed.code}), and the harness's container sees only the files git lists. Look at whether ${root} is a working git checkout.`,
			);
		}
		return [...new Set(listed.stdout.split("\0").filter(Boolean))].sort();
	}
	const named = join(root, CHECKOUT_FILES);
	if (!existsSync(named)) {
		throw new Error(
			`${root} is no git checkout and holds no ${CHECKOUT_FILES}, so the files its container may see cannot be listed. Run from a git checkout, or copy the tree with proof/remote/run.sh, which lists them.`,
		);
	}
	return (await readFile(named, "utf8")).split("\0").filter(Boolean).sort();
}

/**
 * What a CI shard's container and the surface extraction read of the
 * checkout: the harness, surface, shared name ranges and dependency pins
 * (the container reads only these paths, proof/CLAUDE.md).
 */
export const HARNESS_PATHS = [
	"proof/",
	"lib/commcare/surface/",
	"lib/domain/portableNameRanges.json",
	"lib/domain/androidNameRanges.json",
	".nvmrc",
	"package.json",
	"package-lock.json",
];

/**
 * Builds the directory mounted read-only at /work: the checkout's listed
 * files (checkoutFiles), or those under `only` where it names paths (a
 * directory ending in `/`), at their paths under `into`, each a hard link to
 * the checkout's file where the file system allows one and a copy
 * otherwise, a tracked link as the same link, and an empty node_modules/ for
 * the install's mount. A file listed and since removed is left out. Returns
 * `into`.
 *
 * @param {string} into
 * @param {{ root?: string, only?: readonly string[] }} [options]
 */
export async function checkoutView(into, { root = worktree, only } = {}) {
	const files = (await checkoutFiles(root)).filter(
		(name) =>
			only === undefined ||
			only.some((path) =>
				path.endsWith("/") ? name.startsWith(path) : name === path,
			),
	);
	await rm(into, { recursive: true, force: true });
	await mkdir(join(into, "node_modules"), { recursive: true });
	const made = new Set();
	const directoryOf = async (path) => {
		const directory = dirname(path);
		if (!made.has(directory)) {
			await mkdir(directory, { recursive: true });
			made.add(directory);
		}
	};
	const place = async (name) => {
		if (name.split("/").some((part) => part === ".." || part === "")) {
			throw new Error(
				`The checkout lists ${JSON.stringify(name)}, which is no path inside it.`,
			);
		}
		const from = join(root, name);
		const to = join(into, name);
		let held;
		try {
			held = await lstat(from);
		} catch (error) {
			if (error.code === "ENOENT") return;
			throw error;
		}
		await directoryOf(to);
		if (held.isSymbolicLink()) {
			await symlink(await readlink(from), to);
		} else if (held.isFile()) {
			try {
				await link(from, to);
			} catch (error) {
				if (!["EXDEV", "EPERM", "EMLINK", "ENOTSUP"].includes(error.code)) {
					throw error;
				}
				await copyFile(from, to);
			}
		}
	};
	// A few hundred at once: each is a metadata call, and a checkout holds thousands.
	for (let start = 0; start < files.length; start += 256) {
		await Promise.all(files.slice(start, start + 256).map(place));
	}
	return into;
}

/** The outputs sealOutput moved aside in this process. */
const refusedOutputs = new Set();

/** Seals a run's output however the run ended, so no later step meets what the container left unsealed. */
async function sealed(output) {
	if ((await sealOutput(output)).length > 0) refusedOutputs.add(output);
}

/**
 * A new directory under the output root for one run's view of the checkout,
 * named by this process; the views of runs whose process has ended (one
 * killed before it removed its own) are removed first.
 */
async function viewDirectory(outputRoot) {
	const views = join(outputRoot, "views");
	await mkdir(views, { recursive: true });
	for (const name of await readdir(views)) {
		const pid = Number(name.split("-")[0]);
		if (Number.isSafeInteger(pid) && pid > 0 && running(pid)) continue;
		await rm(join(views, name), { recursive: true, force: true });
	}
	return join(views, `${process.pid}-${randomBytes(6).toString("hex")}`);
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
		const id = entry.name.replace(/(?:\.owner|\.host-status\.json)$/, "");
		const owner = join(runs, `${id}.owner`);
		if ((await ownerState(owner)) === "live") continue;
		await rm(join(runs, id), { recursive: true, force: true });
		await rm(join(runs, `${id}.host-status.json`), { force: true });
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

/**
 * The mounts and variables that hand the harness the Android reader's
 * runtime (PROOF_ANDROID_RUNTIME, proof/android/README.md) and the JDK it was
 * built with (PROOF_ANDROID_JDK), each read-only at the path it has on this
 * machine: a runtime names its classpath by absolute paths, so it is read
 * where it was built. None where neither is set; the harness then says where
 * the reader cannot run when an observation asks for it.
 *
 * @param {Record<string, string | undefined>} [env]
 */
export function androidRuntime(env = process.env) {
	const mounts = [];
	const environment = [];
	for (const name of ["PROOF_ANDROID_RUNTIME", "PROOF_ANDROID_JDK"]) {
		const named = env[name];
		if (!named) continue;
		const directory = resolve(process.cwd(), named);
		if (!existsSync(directory)) {
			throw new Error(
				`${name} names ${directory}, which does not exist. Name the directory proof/android/build-runtime.sh built (PROOF_ANDROID_RUNTIME) and the JDK it was built with (PROOF_ANDROID_JDK), or unset it.`,
			);
		}
		mounts.push("-v", `${directory}:${directory}:ro`);
		environment.push("-e", `${name}=${directory}`);
	}
	return { mounts, environment };
}

/** Bytes, from what `docker stats` prints of a container's memory (`1.25GiB / 15.6GiB`). */
export function statsBytes(usage) {
	const match = /^\s*([0-9.]+)\s*([kKMGT]?i?B)/.exec(usage ?? "");
	if (!match) return null;
	const scale = {
		B: 1,
		KiB: 1024,
		MiB: 1024 ** 2,
		GiB: 1024 ** 3,
		TiB: 1024 ** 4,
		kB: 1e3,
		KB: 1e3,
		MB: 1e6,
		GB: 1e9,
		TB: 1e12,
	}[match[2]];
	return scale === undefined ? null : Math.round(Number(match[1]) * scale);
}

function gib(bytes) {
	return bytes == null ? "?" : `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}

/**
 * Watches the memory the lane's containers and this machine use while a run
 * lasts, so a runner that dies says why: every thirty seconds each container
 * of the compose project's memory (docker stats) and this machine's free
 * memory (/proc/meminfo, where there is one) are sampled, a line is printed
 * whenever a container's use passes its last printed peak by a tenth or five
 * minutes have gone by, and the run's output gets memory.json with every
 * container's peak (its cgroup's own memory.peak where this machine shows it,
 * read at every sample, since the harness's container is gone once the run
 * ends; else the highest sample) and every sample. Returns the function that
 * stops it and writes the file.
 */
function watchMemory(output, project) {
	const peaks = new Map();
	const cgroupPeaks = new Map();
	const printed = new Map();
	const samples = [];
	let lastLine = 0;
	let hostLowest = null;
	const started = Date.now();
	const hostAvailable = async () => {
		try {
			const text = await readFile("/proc/meminfo", "utf8");
			const field = (name) => {
				const found = new RegExp(`^${name}:\\s+(\\d+) kB`, "m").exec(text);
				return found ? Number(found[1]) * 1024 : null;
			};
			return { total: field("MemTotal"), available: field("MemAvailable") };
		} catch {
			return null;
		}
	};
	const cgroupPeak = async (name) => {
		const inspected = await capture("docker", [
			"inspect",
			"--format",
			"{{.Id}}",
			name,
		]).catch(() => null);
		const id = inspected?.stdout.trim();
		if (!id) return null;
		for (const path of [
			`/sys/fs/cgroup/system.slice/docker-${id}.scope/memory.peak`,
			`/sys/fs/cgroup/docker/${id}/memory.peak`,
		]) {
			try {
				return Number((await readFile(path, "utf8")).trim());
			} catch {
				// Not this machine's layout.
			}
		}
		return null;
	};
	const tick = async () => {
		const stats = await capture("docker", [
			"stats",
			"--no-stream",
			"--format",
			"{{json .}}",
		]).catch(() => null);
		const containers = {};
		for (const line of (stats?.stdout ?? "").split("\n")) {
			if (!line.trim()) continue;
			let row;
			try {
				row = JSON.parse(line);
			} catch {
				continue;
			}
			if (!String(row.Name).startsWith(`${project}-`)) continue;
			const bytes = statsBytes(String(row.MemUsage).split("/")[0]);
			if (bytes == null) continue;
			const name = String(row.Name).slice(project.length + 1);
			containers[name] = bytes;
			peaks.set(name, Math.max(peaks.get(name) ?? 0, bytes));
		}
		await Promise.all(
			Object.keys(containers).map(async (name) => {
				const peak = await cgroupPeak(`${project}-${name}`);
				if (peak != null)
					cgroupPeaks.set(name, Math.max(cgroupPeaks.get(name) ?? 0, peak));
			}),
		);
		const host = await hostAvailable();
		if (host?.available != null)
			hostLowest = Math.min(hostLowest ?? host.available, host.available);
		samples.push({
			seconds: Math.round((Date.now() - started) / 1000),
			containers,
			host,
		});
		const rising = Object.entries(containers).some(
			([name, bytes]) => bytes > (printed.get(name) ?? 0) * 1.1,
		);
		if (rising || Date.now() - lastLine >= 300_000) {
			lastLine = Date.now();
			for (const [name, bytes] of Object.entries(containers))
				printed.set(name, Math.max(printed.get(name) ?? 0, bytes));
			const parts = Object.entries(containers).map(([name, bytes]) =>
				cgroupPeaks.has(name)
					? `${name} ${gib(bytes)} (peak ${gib(cgroupPeaks.get(name))})`
					: `${name} ${gib(bytes)}`,
			);
			if (host?.available != null)
				parts.push(`machine free ${gib(host.available)} of ${gib(host.total)}`);
			console.error(
				`Lane memory at ${samples.at(-1).seconds} s: ${parts.join(", ")}.`,
			);
		}
	};
	let running = tick();
	const timer = setInterval(() => {
		running = running.then(tick, tick);
	}, 30_000);
	return async () => {
		clearInterval(timer);
		await running.catch(() => {});
		const found = {};
		for (const [name, bytes] of peaks) {
			found[name] = { sampled: bytes };
		}
		await Promise.all(
			[...peaks.keys()].map(async (name) => {
				const peak = Math.max(
					(await cgroupPeak(`${project}-${name}`)) ?? 0,
					cgroupPeaks.get(name) ?? 0,
				);
				if (peak > 0) found[name].cgroup = peak;
			}),
		);
		await writeFile(
			join(output, "memory.json"),
			`${JSON.stringify({ peaks: found, machineLowestFree: hostLowest, samples }, null, "\t")}\n`,
			{ flag: "wx", mode: 0o600 },
		).catch(() => {});
		const summary = Object.entries(found).map(
			([name, peak]) => `${name} ${gib(peak.cgroup ?? peak.sampled)}`,
		);
		console.error(
			`Lane memory peaks: ${summary.join(", ") || "none sampled"}${hostLowest != null ? `; the machine's free memory went as low as ${gib(hostLowest)}` : ""} (memory.json in the run's output).`,
		);
	};
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
 * or the network, so it runs with no network at all. What it wrote is data:
 * the output is sealed (proof/ci/untrusted.mjs) and its surface.json read
 * without following a link, within a bound and as JSON before a byte of it
 * reaches the checkout; a refused surface leaves the committed one as it was.
 */
export async function surface({
	destination = join(worktree, "lib", "commcare", "surface", "surface.json"),
	output = join(worktree, ".proof", "surface"),
	outputRoot = OUTPUT_ROOT,
	checkout = worktree,
} = {}) {
	const image = await harnessImage();
	const id = await imageId(image);
	await rm(output, { recursive: true, force: true });
	await rm(`${output}.refused`, { recursive: true, force: true });
	await mkdir(output, { recursive: true });
	const view = await checkoutView(await viewDirectory(outputRoot), {
		root: checkout,
		only: HARNESS_PATHS,
	});
	let code;
	try {
		code = await execute("docker", [
			"run",
			"--rm",
			"--network",
			"none",
			"-v",
			`${view}:/work:ro`,
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
	} finally {
		await rm(view, { recursive: true, force: true });
	}
	if ((await sealOutput(output)).length > 0) return SEAL_REFUSED;
	if (code !== 0) return code;
	let read;
	try {
		read = await readSurface(join(output, "surface.json"));
	} catch (error) {
		console.error(
			`${error.message} So ${relative(worktree, destination)} was left as it was. Look at the extraction's log in ${output}.`,
		);
		return 1;
	}
	await writeFile(destination, read.bytes);
	console.error(`Wrote ${relative(worktree, destination)}.`);
	return 0;
}

/**
 * Runs the harness container, `serve` its fork server's arguments, `mounts`
 * and `environment` its own, and removes the lane (Postgres and its volume)
 * however the run ends.
 */
async function runServer({
	image,
	mounts,
	environment,
	serve,
	output,
	replayProject,
}) {
	const project =
		replayProject ?? `nova-proof-${randomBytes(4).toString("hex")}`;
	const compose = ["compose", "-f", COMPOSE_FILE, "-p", project];
	// Postgres's client cap (proof/compose.yaml): each worker holds HQ's
	// connections and its Formplayers' pools, so the cap grows with them.
	const workers = Number(serve[serve.indexOf("--workers") + 1]) || 1;
	const env = {
		...process.env,
		PROOF_IMAGE: image,
		PROOF_POSTGRES_MAX_CONNECTIONS: String(Math.max(500, 125 * workers)),
	};
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
	const stopWatching = output ? watchMemory(output, project) : async () => {};
	const hosted = serve.includes("--deadline-at");
	try {
		return await execute(
			"docker",
			[
				...compose,
				"run",
				"--rm",
				...(replayProject
					? ["--name", `${replayProject}-reader`]
					: hosted
						? ["--name", HOSTED_CONTAINER]
						: []),
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
		await stopWatching();
		await down();
	}
}

/** `npm run proof`: the whole lane, or what the arguments select, on this machine. */
export async function main(
	args,
	{
		platform = process.platform,
		outputRoot = OUTPUT_ROOT,
		checkout = worktree,
		replayProject = undefined,
	} = {},
) {
	refuseRetired();
	const lane = laneOptions(args);
	const corpus = namedCorpus();
	const extraction = namedExtraction();
	const store = namedStore();
	const android = androidRuntime();
	const image = await harnessImage();
	const id = await imageId(image);
	const view = await checkoutView(await viewDirectory(outputRoot), {
		root: checkout,
	});
	let modulesForCleanup;
	try {
		const modules = await nodeModules(image, platform, view, replayProject);
		modulesForCleanup = modules;
		const output = await runOutput({ root: outputRoot });
		console.error(`The proof lane writes its output into ${output}.`);
		const code = await runServer({
			image,
			mounts: [
				"-v",
				`${view}:/work:ro`,
				"-v",
				`${modules}:/work/node_modules:ro`,
				"-v",
				`${output}:/out`,
				...(corpus ? ["-v", `${corpus}:/corpus:ro`] : []),
				...extraction.mounts,
				...store.mounts,
				...android.mounts,
			],
			environment: [
				...passedThrough(),
				"-e",
				`PROOF_IMAGE_ID=${id}`,
				...(await laneFingerprints(image, id)),
				...(corpus ? ["-e", "PROOF_CORPUS=/corpus"] : []),
				...extraction.environment,
				...store.environment,
				...android.environment,
			],
			output,
			replayProject,
			serve: [
				...(replayProject
					? ["--deadline-at", process.env.PROOF_DIAGNOSTIC_DEADLINE_AT]
					: []),
				"--workers",
				String(lane.workers),
				"--claim",
				"static",
				...(lane.bin ? ["--bin", lane.bin] : []),
				"--",
				...pytestArguments(lane.pytest),
			],
		}).finally(() => (replayProject ? undefined : sealed(output)));
		return refusedOutputs.has(output) ? SEAL_REFUSED : code;
	} finally {
		if (replayProject && modulesForCleanup === `${replayProject}-modules`) {
			await execute("docker", ["volume", "rm", modulesForCleanup], {
				stdio: "ignore",
			});
		}
		await rm(view, { recursive: true, force: true });
	}
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
	};
	const names = {
		"--workers": "workers",
		"--label": "label",
		"--early-queue": "earlyQueue",
		"--queue": "queue",
		"--claim": "claim",
		"--bin": "bin",
		"--wait-for": "waitFor",
	};
	for (let index = 0; index < args.length; index++) {
		const name = names[args[index]];
		const value = args[index + 1];
		if (name === undefined || value === undefined) {
			throw new Error(
				`--lane takes ${Object.keys(names).join(", ")}, each with a value; got ${JSON.stringify(args[index])}${value === undefined ? " without one" : ""}.`,
			);
		}
		options[name] = value;
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
 * One CI shard: the harness container serving the queues. The claim and
 * wait commands run here on the host (proof/ci/hostCommands.mjs), with this
 * process's environment and so the job's artifact-service credentials, and
 * the server reaches them through its relay; nothing of the credentials
 * enters the container. The main queue's directory and the corpus directory
 * are mounted read-only, since the wait command fills them from the host;
 * nothing of Nova's node_modules is mounted, so the shard never emits the
 * corpus, and a main queue needs PROOF_CORPUS.
 */
export async function shard(
	args,
	{ outputRoot = OUTPUT_ROOT, checkout = worktree } = {},
) {
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
	const android = androidRuntime();
	const timings = JSON.parse(await readFile(TIMINGS_FILE, "utf8"));
	const workers =
		options.workers ??
		count(
			timingsProfile(timings, readersServed()).execution?.workers,
			"The timings' worker count",
		);
	const image = await harnessImage();
	const id = await imageId(image);
	const output = await runOutput({ root: outputRoot });
	const queue = options.queue && resolve(process.cwd(), options.queue);
	const claimed = options.claim && options.claim !== "static";
	const view = await checkoutView(await viewDirectory(outputRoot), {
		root: checkout,
		only: HARNESS_PATHS,
	});
	const commands =
		claimed || options.waitFor
			? await hostCommands({
					claim: claimed ? options.claim : undefined,
					waitFor: options.waitFor,
					earlyQueue: early,
					queue,
					cwd: worktree,
				})
			: undefined;
	let stopCheckpoints;
	try {
		const mounts = [
			"-v",
			`${view}:/work:ro`,
			"-v",
			`${output}:/out`,
			...extraction.mounts,
			...store.mounts,
			...android.mounts,
			...(commands?.mounts ?? []),
		];
		const fingerprints = await laneFingerprints(image, id);
		const environment = [
			...passedThrough(),
			"-e",
			`PROOF_IMAGE_ID=${id}`,
			...fingerprints,
			...extraction.environment,
			...store.environment,
			...android.environment,
		];
		const serve = ["--workers", String(workers)];
		if (process.env.PROOF_SHARD_DEADLINE_AT)
			serve.push("--deadline-at", process.env.PROOF_SHARD_DEADLINE_AT);
		if (options.label) serve.push("--label", options.label);
		if (early) {
			mounts.push("-v", `${early}:/lane/early-queue.json:ro`);
			serve.push("--early-queue", "/lane/early-queue.json");
		}
		if (queue) {
			await mkdir(dirname(queue), { recursive: true });
			mounts.push("-v", `${dirname(queue)}:/lane/queue:ro`);
			serve.push("--queue", `/lane/queue/${basename(queue)}`);
		}
		if (process.env.PROOF_CORPUS) {
			const corpus = resolve(process.cwd(), process.env.PROOF_CORPUS);
			await mkdir(corpus, { recursive: true });
			mounts.push("-v", `${corpus}:/corpus:ro`);
			environment.push("-e", "PROOF_CORPUS=/corpus");
		}
		serve.push("--claim", commands?.claim ?? "static");
		if (options.bin) serve.push("--bin", options.bin);
		if (commands?.waitFor) serve.push("--wait-for", commands.waitFor);
		if (
			process.env.PROOF_SHARD_DEADLINE_AT &&
			process.env.PROOF_HOSTED_CHECKPOINTS === "1" &&
			fingerprints.length
		) {
			try {
				stopCheckpoints = startCheckpoints({
					output,
					early,
					main: queue,
					shard: options.label,
					checkout,
					image: id,
					fingerprints: fingerprints[1],
				});
				environment.push("-e", "PROOF_CHECKPOINT_PARTS=1");
			} catch {
				console.error(
					"Reader progress could not start with a verified checkout identity.",
				);
			}
		}
		console.error(`The proof shard writes its output into ${output}.`);
		const code = await runServer({
			image,
			mounts,
			environment,
			serve,
			output,
		}).finally(() => sealed(output));
		return refusedOutputs.has(output) ? SEAL_REFUSED : code;
	} finally {
		await stopCheckpoints?.();
		await commands?.close();
		await rm(view, { recursive: true, force: true });
	}
}

/** Bound the host (including Docker startup and cleanup) separately from the fork server:
 * the server gets its full work time and three minutes to record interrupted groups before
 * this fallback. Even a stuck host leaves the workflow time to seal and upload. */
async function hostedShard(args) {
	const { stopAt, hostSeconds } = hostedCutoffs(
		process.env.PROOF_SHARD_STARTED_AT,
		process.env.PROOF_SHARD_MINUTES,
	);
	if (hostSeconds <= 0) {
		console.error(
			"The shard's work deadline and shutdown grace elapsed during preparation.",
		);
		return 124;
	}
	return execute(
		"timeout",
		[
			"--kill-after=30s",
			`${hostSeconds}s`,
			process.execPath,
			fileURLToPath(import.meta.url),
			"--lane",
			...args,
		],
		{ env: { ...process.env, PROOF_SHARD_DEADLINE_AT: String(stopAt) } },
	);
}

/**
 * CI's proof matrix: `shards` jobs (`default`: proof/timings.json's
 * execution for the profile, `readers`; or a count, which `python3 -m
 * proof.lane.plan` gives a lane it plans) on the execution's runner, each a
 * fork server of the execution's workers, with `deadline` minutes where the
 * plan gives one.
 */
export function proofMatrix(shards, timings, readers = true, deadline) {
	const execution = timingsProfile(timings, readers).execution ?? {};
	const workers = count(execution.workers, "The worker count");
	const total = count(
		shards === "default" ? execution.shards : shards,
		"The shard count",
	);
	if (typeof execution.runner !== "string" || !execution.runner) {
		throw new Error(
			`proof/timings.json's ${profileName(readers)} execution names no runner for the shards (profiles.${profileName(readers)}.execution.runner).`,
		);
	}
	const budget = hostedBudget(deadline);
	return {
		include: Array.from({ length: total }, (_, index) => ({
			shard: index + 1,
			total,
			workers,
			runner: execution.runner,
			...budget,
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
 * Whether the runs whose output directories are given served the readers (each
 * serve.json's `readers`, true where it records none), or the refusal when
 * they ran in both profiles.
 */
async function runsReaders(directories) {
	const profiles = new Set();
	for (const directory of directories) {
		const serve = join(resolve(process.cwd(), directory), "serve.json");
		const served = existsSync(serve)
			? JSON.parse(await readFile(serve, "utf8"))
			: {};
		if (Array.isArray(served.readers) && served.readers.length < 4) {
			throw new Error(
				`${directory} ran with only some readers (PROOF_READERS=${served.readers.join(",")}), a slice whose groups cost what neither of the lane's profiles does. Name the outputs of runs with every reader or with none.`,
			);
		}
		profiles.add(served.readers !== false);
	}
	if (profiles.size > 1) {
		throw new Error(
			"The runs named ran in both of the lane's profiles (their serve.json's readers), and each profile's groups cost what its own runs measure. Name the outputs of one profile's runs at a time.",
		);
	}
	return profiles.size === 0 ? true : [...profiles][0];
}

/**
 * proof/timings.json with each group's box-seconds measured by the runs whose
 * output directories are given, under the profile they ran in (each run's
 * serve.json says whether it served the readers; the runs must agree), the
 * other profile kept as it was: each worker's record (`timings/*.json`) holds
 * its groups' seconds and how many workers shared its box, and a group's
 * box-seconds are its seconds divided by that count (the mean where several
 * runs measured it), or by `boxWorkers` where given: the workers a CI box
 * holds, for a run on another box that gives each worker a vCPU as CI's does
 * (a proof VM), whose worker-seconds are a CI worker's. The mean of what a
 * worker's session shares and of the servers' fixed costs (serve.json) are
 * kept beside them, with the profile's execution settings as they were.
 */
export async function refreshTimings(
	directories,
	previous,
	{ boxWorkers } = {},
) {
	if (directories.length === 0) {
		throw new Error(
			"Name the output directory of each finished lane run to measure: node proof/run.mjs --timings <output directory>...",
		);
	}
	const readers = await runsReaders(directories);
	const measured = new Map();
	const shared = [];
	const fixed = new Map();
	let sessions = 0;
	for (const directory of directories) {
		const root = resolve(process.cwd(), directory);
		const serve = join(root, "serve.json");
		const served = existsSync(serve)
			? JSON.parse(await readFile(serve, "utf8"))
			: {};
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
			const workers = boxWorkers ?? count(record.workers, `${file}'s workers`);
			sessions += 1;
			if (typeof record.shared === "number") shared.push(record.shared);
			for (const [group, seconds] of Object.entries(record.groups ?? {})) {
				measured.set(group, [
					...(measured.get(group) ?? []),
					seconds / workers,
				]);
			}
		}
		for (const [name, seconds] of Object.entries(served.fixed ?? {})) {
			if (typeof seconds === "number") {
				fixed.set(name, [...(fixed.get(name) ?? []), seconds]);
			}
		}
	}
	const name = profileName(readers);
	const groups = Object.fromEntries(
		[...measured.keys()]
			.sort()
			.map((group) => [group, mean(measured.get(group))]),
	);
	return {
		about:
			"Box-seconds per group of the proof lane (proof/checks/sharding.py), for each profile (proof/lane/readers.py: readers, the nightly's, every state served to the readers; no-readers, the pull request lane's, PROOF_READERS=0): a group's seconds on one worker, without what the worker's session shares, divided by the workers sharing a CI box. Each profile's execution is CI's default shard count, runner and workers per shard for it. Refresh a profile from its runs: node proof/run.mjs --timings <output directory>... [--box-workers n].",
		profiles: {
			...(previous.profiles ?? {}),
			[name]: {
				execution: timingsProfile(previous, readers).execution,
				measured: {
					at: new Date().toISOString().slice(0, 10),
					sessions,
					...(boxWorkers === undefined
						? {}
						: {
								basis: `Worker-seconds of runs on a box giving each worker a vCPU, as a CI shard does, each divided by ${boxWorkers}, the workers a CI shard's box holds.`,
							}),
					// What a worker's session spends beside its groups (its services), on average.
					sharedSeconds: mean(shared),
					// What a server spends before its first fork, on average.
					fixed: Object.fromEntries(
						[...fixed.keys()]
							.sort()
							.map((fixedName) => [fixedName, mean(fixed.get(fixedName))]),
					),
				},
				groups,
			},
		},
	};
}

async function diagnostic(args) {
	const lane = laneOptions(args);
	if (
		lane.workers !== 1 ||
		lane.pytest.length !== 1 ||
		lane.pytest[0] !== "proof/diagnostics/replay.py::test_selected_stage"
	)
		throw new Error("A diagnostic runs only the selected stage on one worker.");
	const output = await runOutput({ root: OUTPUT_ROOT });
	const supervisor = spawn(
		"python3",
		[
			"-m",
			"proof.diagnostics.host",
			process.execPath,
			fileURLToPath(import.meta.url),
			"--replay-child",
			...args,
		],
		{
			cwd: worktree,
			env: { ...process.env, PROOF_OUT_DIR: output },
			stdio: "inherit",
		},
	);
	const cancel = (signal) => supervisor.kill(signal);
	const interrupt = () => cancel("SIGINT"),
		terminate = () => cancel("SIGTERM");
	process.on("SIGINT", interrupt);
	process.on("SIGTERM", terminate);
	try {
		return await new Promise((accept, reject) => {
			supervisor.once("error", reject);
			supervisor.once("exit", (code, signal) =>
				accept(childExit(code, signal)),
			);
		});
	} finally {
		process.off("SIGINT", interrupt);
		process.off("SIGTERM", terminate);
	}
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
	} else if (command === "--seal-replay" && rest.length === 2) {
		const [project, output] = rest;
		if (!/^nova-proof-replay-[a-f0-9]{16}$/.test(project))
			throw new Error("Invalid diagnostic project.");
		// Only the named harness mounts /out. The supervisor has already reaped the launcher group.
		stopHostedWriter(`${project}-reader`);
		sealOutput(resolve(output)).then(
			(foreign) => done(foreign.length > 0 ? SEAL_REFUSED : 0),
			failed,
		);
	} else if (
		(command === "--seal" || command === "--seal-hosted") &&
		rest.length === 1
	) {
		if (command === "--seal-hosted") stopHostedWriter();
		sealOutput(resolve(rest[0])).then(
			(foreign) => done(foreign.length > 0 ? SEAL_REFUSED : 0),
			failed,
		);
	} else if (command === "--lane" || command === "--hosted-lane") {
		// Exit 1 belongs to completed checks; CI leaves their verdict to the gate.
		// A runner exception is infrastructure failure and must fail the shard itself.
		(command === "--hosted-lane" ? hostedShard(rest) : shard(rest)).then(
			done,
			(error) => {
				console.error(error.message);
				process.exit(2);
			},
		);
	} else if (command === "--matrix") {
		readFile(TIMINGS_FILE, "utf8")
			.then((text) => {
				const at = rest.indexOf("--deadline");
				const deadline = at === -1 ? undefined : rest[at + 1];
				console.log(
					JSON.stringify(
						proofMatrix(
							rest[0] ?? "default",
							JSON.parse(text),
							readersServed(),
							deadline,
						),
					),
				);
				return 0;
			})
			.then(done, failed);
	} else if (command === "--timings") {
		readFile(TIMINGS_FILE, "utf8")
			.catch(() => "{}")
			.then(async (text) => {
				const at = rest.indexOf("--box-workers");
				const boxWorkers =
					at === -1 ? undefined : count(rest[at + 1], "--box-workers");
				const directories =
					at === -1 ? rest : [...rest.slice(0, at), ...rest.slice(at + 2)];
				const refreshed = await refreshTimings(directories, JSON.parse(text), {
					boxWorkers,
				});
				await writeFile(
					TIMINGS_FILE,
					`${JSON.stringify(refreshed, null, "\t")}\n`,
				);
				const name = profileName(await runsReaders(directories));
				const written = refreshed.profiles[name];
				console.error(
					`Wrote ${relative(worktree, TIMINGS_FILE)}: the ${name} profile's ${Object.keys(written.groups).length} groups from ${written.measured.sessions} worker sessions.`,
				);
				return 0;
			})
			.then(done, failed);
	} else if (command === "--replay-child") {
		const project = process.env.PROOF_DIAGNOSTIC_PROJECT;
		if (!/^nova-proof-replay-[a-f0-9]{16}$/.test(project ?? ""))
			throw new Error("Invalid diagnostic project.");
		main(rest, { replayProject: project }).then(done, failed);
	} else if (process.env.PROOF_REPLAY_STAGE !== undefined) {
		diagnostic(process.argv.slice(2)).then(done, failed);
	} else {
		main(process.argv.slice(2)).then(done, failed);
	}
}
