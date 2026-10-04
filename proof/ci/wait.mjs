// Brings the proof lane's main queue and the corpus it runs over into a
// shard, once the job that emits them has uploaded them:
//
//   node proof/ci/wait.mjs --queue NAME --corpus NAME --failed NAME
//     [--queue-to FILE] [--corpus-to DIR] [--deadline SECONDS] [--poll SECONDS] [--once]
//
// NAME are artifacts of this workflow run: the queue (one JSON file), the
// corpus (one zstd-compressed tar of the emitted corpus directory), and the
// marker the emitting job uploads when it fails before the queue. The emitting
// job uploads the corpus before the queue, so a listing that holds the queue
// holds the corpus. The queue is written to --queue-to (default
// PROOF_LANE_QUEUE, which the lane's server sets for its wait command) and the
// corpus unpacked into --corpus-to (default PROOF_CORPUS), which must be empty:
// the corpus first, then the queue, staged beside its destination and moved
// into place whole, so a queue in place always has its corpus.
//
// It lists the run's artifacts every --poll seconds (2 by default) until the
// queue is there, the marker is there, or --deadline seconds (600 by default)
// have passed on the monotonic clock. Exit status, as the lane's server reads
// it (proof/lane/serve.py): 0 when the queue and corpus are in place, 3 when
// the emission failed, 4 when the deadline passed, 5 with --once when neither
// is there yet (it then lists once and changes nothing), and 2 when the
// service or the files failed. Standard output carries one JSON line: what
// was found, how long it waited, how many listings it took, and what the
// download and the unpacking cost.

import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, readdir, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pipeline } from "node:stream/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import zlib from "node:zlib";
import { download, EXIT, listAll, recordsOnStdout } from "./artifacts.mjs";

const USAGE =
	"node proof/ci/wait.mjs --queue NAME --corpus NAME --failed NAME [--queue-to FILE] [--corpus-to DIR] [--deadline SECONDS] [--poll SECONDS] [--once]";

class Refusal extends Error {}

// tar stops reading at the archive's end-of-archive blocks (bsdtar reads none of the padding after them), and its
// exit ends the pipe under any write still under way: the write fails (EPIPE), or Node closes the exited child's
// stdin first (a premature close, or a write after it). What tar left unread follows the archive, so its exit
// status, not the pipe's, says whether it read the archive whole.
const TAR_GONE = new Set([
	"EPIPE",
	"ERR_STREAM_PREMATURE_CLOSE",
	"ERR_STREAM_DESTROYED",
]);

function seconds(value, option) {
	const number = Number(value);
	if (!Number.isFinite(number) || number < 0) {
		throw new Refusal(
			`${option} takes a number of seconds; got ${JSON.stringify(value)}.`,
		);
	}
	return number;
}

function options(argv) {
	const { values, positionals } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: {
			queue: { type: "string" },
			corpus: { type: "string" },
			failed: { type: "string" },
			"queue-to": { type: "string" },
			"corpus-to": { type: "string" },
			deadline: { type: "string", default: "600" },
			poll: { type: "string", default: "2" },
			once: { type: "boolean", default: false },
		},
	});
	const missing = ["queue", "corpus", "failed"].filter((name) => !values[name]);
	if (positionals.length > 0 || missing.length > 0) {
		throw new Refusal(
			`wait.mjs names the queue, the corpus and the failure marker it waits for${missing.length ? `; --${missing.join(", --")} ${missing.length === 1 ? "is" : "are"} missing` : ""}${positionals.length ? `; it takes no other arguments (got ${positionals.join(" ")})` : ""}.\nUsage: ${USAGE}`,
		);
	}
	const queueTo = values["queue-to"] ?? process.env.PROOF_LANE_QUEUE;
	const corpusTo = values["corpus-to"] ?? process.env.PROOF_CORPUS;
	if (!queueTo || !corpusTo) {
		throw new Refusal(
			"wait.mjs writes the queue to --queue-to (or PROOF_LANE_QUEUE) and unpacks the corpus into --corpus-to (or PROOF_CORPUS), and " +
				`${!queueTo ? "no queue destination" : "no corpus destination"} is named.`,
		);
	}
	return {
		queue: values.queue,
		corpus: values.corpus,
		failed: values.failed,
		queueTo: resolve(queueTo),
		corpusTo: resolve(corpusTo),
		deadline: seconds(values.deadline, "--deadline"),
		poll: seconds(values.poll, "--poll"),
		once: values.once,
	};
}

/** Unpacks the zstd-compressed tar `file` into `directory` with the system's tar. */
async function unpack(file, directory) {
	if (typeof zlib.createZstdDecompress !== "function") {
		throw new Error(
			`This Node (${process.version}) has no zstd in node:zlib, and the corpus is a zstd-compressed tar; run wait.mjs with Node 22.15 or later (the proof image's and .nvmrc's).`,
		);
	}
	const tar = spawn(
		"tar",
		["-x", "-f", "-", "-C", directory, "--no-same-owner"],
		{
			stdio: ["pipe", "ignore", "pipe"],
		},
	);
	let errors = "";
	tar.stderr.setEncoding("utf8");
	tar.stderr.on("data", (chunk) => {
		errors += chunk;
	});
	const exited = new Promise((resolveExit, reject) => {
		tar.on("error", reject);
		tar.on("close", (code, signal) => resolveExit(code ?? signal));
	});
	try {
		await pipeline(
			createReadStream(file),
			zlib.createZstdDecompress(),
			tar.stdin,
		);
	} catch (error) {
		if (!TAR_GONE.has(error?.code)) throw error;
	} finally {
		tar.stdin.destroy();
	}
	const code = await exited;
	if (code !== 0) {
		throw new Error(
			`tar exited ${code} unpacking the corpus into ${directory}: ${errors.trim().slice(-2000)}`,
		);
	}
}

async function fetchCorpus(artifact, directory, costs) {
	await mkdir(directory, { recursive: true });
	const held = await readdir(directory);
	if (held.length > 0) {
		throw new Refusal(
			`The corpus directory ${directory} already holds ${held.length} entries (${held.slice(0, 3).join(", ")}), and the corpus is unpacked only into an empty one, so nothing an earlier run left there mixes with it.`,
		);
	}
	let started = performance.now();
	const fetched = await download(artifact);
	costs.corpusDownload = Math.round(performance.now() - started) / 1000;
	try {
		started = performance.now();
		await unpack(fetched.file, directory);
		costs.corpusUnpack = Math.round(performance.now() - started) / 1000;
	} finally {
		await rm(fetched.directory, { recursive: true, force: true });
	}
	costs.corpusBytes = artifact.size;
}

async function fetchQueue(artifact, destination, costs) {
	await mkdir(dirname(destination), { recursive: true });
	const started = performance.now();
	const fetched = await download(artifact);
	try {
		// Staged in the destination's directory, so the move into place is one rename.
		const staged = join(
			dirname(destination),
			`.${process.pid}.${artifact.name}`,
		);
		// The download lands in the temporary directory, often another file system than the destination's.
		await copyFile(fetched.file, staged);
		await rename(staged, destination);
	} finally {
		await rm(fetched.directory, { recursive: true, force: true });
	}
	costs.queueDownload = Math.round(performance.now() - started) / 1000;
}

async function main() {
	const record = recordsOnStdout();
	const started = performance.now();
	const costs = { listings: 0 };
	let result;
	try {
		const settings = options(process.argv.slice(2));
		for (;;) {
			costs.listings += 1;
			const artifacts = await listAll();
			const named = (name) =>
				artifacts
					.filter((artifact) => artifact.name === name)
					.sort((a, b) => b.id - a.id)[0];
			const queue = named(settings.queue);
			if (queue) {
				const corpus = named(settings.corpus);
				if (!corpus) {
					throw new Error(
						`The run holds the queue ${settings.queue} and no corpus ${settings.corpus}, and the emitting job uploads the corpus first; look at its upload steps.`,
					);
				}
				await fetchCorpus(corpus, settings.corpusTo, costs);
				await fetchQueue(queue, settings.queueTo, costs);
				result = {
					outcome: "fetched",
					code: EXIT.claimed,
					reason: `The queue ${settings.queue} is at ${settings.queueTo} and the corpus ${settings.corpus} in ${settings.corpusTo}.`,
				};
				break;
			}
			if (named(settings.failed)) {
				result = {
					outcome: "emission-failed",
					code: EXIT.emissionFailed,
					reason: `The run holds ${settings.failed}: the job that emits the corpus failed before it uploaded the queue, so no document runs; its emit step says why.`,
				};
				break;
			}
			const waited = (performance.now() - started) / 1000;
			if (settings.once) {
				result = {
					outcome: "not-yet",
					code: EXIT.notYet,
					reason: `The run holds neither the queue ${settings.queue} nor ${settings.failed} yet.`,
				};
				break;
			}
			if (waited >= settings.deadline) {
				result = {
					outcome: "deadline",
					code: EXIT.deadline,
					reason: `The run held neither the queue ${settings.queue} nor ${settings.failed} after ${settings.deadline} s of waiting; look at whether the job that emits the corpus started and where it is.`,
				};
				break;
			}
			await sleep(Math.min(settings.poll, settings.deadline - waited) * 1000);
		}
	} catch (error) {
		result = {
			outcome: "failed",
			code: EXIT.failed,
			reason:
				error instanceof Refusal ? error.message : `${error?.message ?? error}`,
		};
	}
	const { code, ...rest } = result;
	await record({
		...rest,
		...costs,
		waited: Math.round(performance.now() - started) / 1000,
	});
	process.stderr.write(`${result.reason}\n`);
	return code;
}

process.exitCode = await main();
