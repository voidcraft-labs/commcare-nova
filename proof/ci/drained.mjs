// Tells a proof shard, before it pulls the image, whether any block is left
// for it:
//
//   node proof/ci/drained.mjs --queue NAME --failed NAME --prefix PREFIX [--mode create|steal] EARLY_QUEUE
//
// EARLY_QUEUE is the early queue's file (the shard downloads it first); NAME
// are this run's artifacts of the main queue and of the emission's failure
// marker (proof/ci/wait.mjs); PREFIX is the claims' name before the block id
// (proof-claim-<attempt>-). It lists the run's artifacts once and reads the
// main queue when the run holds it. A block is held when the run holds its
// claim: the artifact PREFIX<block> with --mode create (the default), and with
// --mode steal its owner's mark or a commit (proof/ci/claim.mjs). Claims are
// never withdrawn, so a held block stays held.
//
// Standard output carries one JSON line: `left` is false only when every block
// of both queues is held (or the emission failed and every early block is
// held), so the shard has nothing to run and can end without pulling the
// image; the counts say why. A main queue the run does not hold yet leaves
// `left` true, since its blocks are still to come. Exit status 0 when it
// could tell, 2 when the service or the files failed (the shard then runs as
// if blocks were left, and its claims settle the rest).

import { readFile, rm } from "node:fs/promises";
import { parseArgs } from "node:util";
import { download, EXIT, listAll, recordsOnStdout } from "./artifacts.mjs";

const USAGE =
	"node proof/ci/drained.mjs --queue NAME --failed NAME --prefix PREFIX [--mode create|steal] EARLY_QUEUE";

class Refusal extends Error {}

function options(argv) {
	const { values, positionals } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: {
			queue: { type: "string" },
			failed: { type: "string" },
			prefix: { type: "string" },
			mode: { type: "string", default: "create" },
		},
	});
	const missing = ["queue", "failed", "prefix"].filter((name) => !values[name]);
	if (missing.length > 0 || positionals.length !== 1) {
		throw new Refusal(
			`drained.mjs names the main queue, the failure marker and the claims' prefix, and takes the early queue's file${missing.length ? `; --${missing.join(", --")} ${missing.length === 1 ? "is" : "are"} missing` : ""}.\nUsage: ${USAGE}`,
		);
	}
	if (values.mode !== "create" && values.mode !== "steal") {
		throw new Refusal(
			`--mode is create or steal; got ${JSON.stringify(values.mode)}.`,
		);
	}
	return { ...values, early: positionals[0] };
}

/** The block ids a queue file holds (the lane's queue, version 1). */
function blockIds(text, where) {
	const queue = JSON.parse(text);
	if (queue?.version !== 1 || !Array.isArray(queue.blocks)) {
		throw new Error(
			`${where} is not a lane queue of version 1 (proof/lane/blocks.py), so its blocks cannot be counted.`,
		);
	}
	return queue.blocks.map((block) => block.id);
}

async function main() {
	const record = recordsOnStdout();
	let result;
	let code = EXIT.claimed;
	try {
		const settings = options(process.argv.slice(2));
		const early = blockIds(
			await readFile(settings.early, "utf8"),
			settings.early,
		);
		const artifacts = await listAll();
		const names = new Set(artifacts.map((artifact) => artifact.name));
		const held = (id) => {
			const name = `${settings.prefix}${id}`;
			if (settings.mode === "create") return names.has(name);
			if (names.has(`${name}.owner`)) return true;
			return [...names].some((artifact) =>
				artifact.startsWith(`${name}.commit-`),
			);
		};
		const queue = artifacts
			.filter((artifact) => artifact.name === settings.queue)
			.sort((a, b) => b.id - a.id)[0];
		let main = [];
		let state = "absent";
		if (queue) {
			const fetched = await download(queue);
			try {
				main = blockIds(await readFile(fetched.file, "utf8"), settings.queue);
			} finally {
				await rm(fetched.directory, { recursive: true, force: true });
			}
			state = "present";
		} else if (names.has(settings.failed)) {
			state = "failed";
		}
		const blocks = [...early, ...main];
		const unheld = blocks.filter((id) => !held(id)).length;
		result = {
			left: state === "absent" || unheld > 0,
			main: state,
			blocks: blocks.length,
			unheld,
		};
	} catch (error) {
		code = EXIT.failed;
		result = {
			left: true,
			reason:
				error instanceof Refusal ? error.message : `${error?.message ?? error}`,
		};
		process.stderr.write(`${result.reason}\n`);
	}
	await record(result);
	return code;
}

process.exitCode = await main();
