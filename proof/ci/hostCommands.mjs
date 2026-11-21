// A CI shard's claim and wait commands (proof/ci/claim.mjs, proof/ci/wait.mjs),
// run on the host and never inside the lane's container.
//
// The commands need the job's artifact-service credentials
// (ACTIONS_RUNTIME_TOKEN, ACTIONS_RESULTS_URL, proof/ci/runtime.mjs), and the
// container runs HQ and every other upstream at its pins, so the credentials
// stay in this process and the commands it starts. The lane's server asks
// for a command through a relay it runs as its claim or wait command
// (`python -m proof.lane.relay`): the relay names its request as an empty
// file in the requests directory (mounted writable at /lane/requests), and
// waits for the answer this broker writes into the answers directory
// (mounted read-only at /lane/answers): only the command's exit status, moved
// into place whole. The artifact client emits runner masking commands on its
// diagnostic stream, so the host job receives that stream directly.
//
// What the container writes is data, so the broker reads nothing from a
// request but its name. A name is `wait.request` or
// `claim-<block>.request`, where <block> is the id of a block of the early
// queue or the main queue on this host (a sha256 in hex, proof/lane/blocks.py);
// any other name is answered with REFUSED and never runs anything. Each
// command runs once, from the host's checkout, with the host's environment
// and PROOF_LANE_BLOCK (a claim) or PROOF_LANE_QUEUE (the wait, the main
// queue's path on this host) beside it.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The relay the lane's server runs as its claim and wait commands, with the two directories where it meets the broker. */
export const RELAY =
	"python -m proof.lane.relay --requests /lane/requests --answers /lane/answers";

/** The status a request the broker will not run is answered with: neither claimed (0) nor taken (1). */
export const REFUSED = 2;

const BLOCK = /^[0-9a-f]{64}$/;

/** How often the broker looks for new requests, in milliseconds. */
const POLL = 200;

/** The block ids the queue at `path` names, or none where it is not there yet. */
async function blockIds(path) {
	if (!path || !existsSync(path)) return new Set();
	const queue = JSON.parse(await readFile(path, "utf8"));
	return new Set(
		(queue.blocks ?? [])
			.map((block) => block?.id)
			.filter((id) => typeof id === "string" && BLOCK.test(id)),
	);
}

/** `text` written to `path` whole: staged beside it and moved into place. */
async function writeWhole(path, text) {
	const staged = `${path}.${process.pid}.staged`;
	await writeFile(staged, text);
	await rename(staged, path);
}

/**
 * Starts the broker for a shard whose server claims with `claim` (a command
 * naming the block as {block}, or undefined) and waits with `waitFor` (or
 * undefined), its queues at `earlyQueue` and `queue` on this host. Resolves
 * the mounts the container is given, the relay commands the server is given
 * in their place, and `close`, which stops every command still running and
 * removes the broker's directories.
 */
export async function hostCommands({
	claim,
	waitFor,
	earlyQueue,
	queue,
	cwd,
	environment = process.env,
	poll = POLL,
}) {
	let known = await blockIds(earlyQueue);
	const root = await mkdtemp(join(tmpdir(), "proof-lane-commands-"));
	const requests = join(root, "requests");
	const answers = join(root, "answers");
	await mkdir(requests);
	await mkdir(answers);
	const handled = new Set();
	const running = new Set();
	let stopped = false;

	const answer = async (name, code) => {
		await writeWhole(join(answers, `${name}.code`), `${code}\n`);
	};

	const start = (name, text, extra) =>
		new Promise((settle) => {
			const child = spawn("sh", ["-c", text], {
				cwd,
				env: { ...environment, ...extra },
				stdio: ["ignore", "inherit", "inherit"],
				detached: true,
			});
			running.add(child);
			const ended = (code) => {
				running.delete(child);
				answer(name, code).then(settle, settle);
			};
			child.on("error", () => ended(REFUSED));
			child.on("exit", (code, signal) => ended(code ?? (signal ? 1 : 0)));
		});

	const take = async (name) => {
		handled.add(name);
		if (name === "wait.request" && waitFor) {
			await start("wait", waitFor, { PROOF_LANE_QUEUE: queue });
			return;
		}
		const block = /^claim-(.+)\.request$/.exec(name)?.[1];
		if (block !== undefined && claim && BLOCK.test(block)) {
			if (!known.has(block)) {
				known = new Set([
					...(await blockIds(earlyQueue)),
					...(await blockIds(queue)),
				]);
			}
			if (!stopped && known.has(block)) {
				await start(`claim-${block}`, claim.replaceAll("{block}", block), {
					PROOF_LANE_BLOCK: block,
				});
				return;
			}
		}
		// A name no command answers: anything the container wrote that is not a request this shard makes.
		if (/^[A-Za-z0-9-]{1,80}\.request$/.test(name)) {
			await answer(name.slice(0, -".request".length), REFUSED);
		}
	};

	const pending = new Set();
	const settled = (name) => {
		const work = take(name).catch(() =>
			answer(name.slice(0, -".request".length), REFUSED).catch(() => {}),
		);
		pending.add(work);
		work.finally(() => pending.delete(work));
	};
	const look = async () => {
		const names = await readdir(requests).catch(() => []);
		for (const name of names.sort()) {
			if (!stopped && !handled.has(name) && name.endsWith(".request"))
				settled(name);
		}
	};
	let turn = Promise.resolve();
	const timer = setInterval(() => {
		turn = turn.then(look, look);
	}, poll);

	return {
		mounts: [
			"-v",
			`${requests}:/lane/requests`,
			"-v",
			`${answers}:/lane/answers:ro`,
		],
		claim: claim ? `${RELAY} claim {block}` : undefined,
		waitFor: waitFor ? `${RELAY} wait` : undefined,
		directories: { requests, answers },
		async close() {
			stopped = true;
			clearInterval(timer);
			await turn.catch(() => {});
			for (const child of running) {
				try {
					process.kill(-child.pid, "SIGKILL");
				} catch {
					// It ended between the look and the kill.
				}
			}
			await Promise.allSettled([...pending]);
			await rm(root, { recursive: true, force: true });
		},
	};
}
