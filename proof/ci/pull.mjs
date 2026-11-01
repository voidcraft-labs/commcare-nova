// Pulls what a proof lane shard runs, the proof image proof/image.lock
// records and the Postgres proof/compose.yaml names, side by side, as
// proof-lane.yml's shard step "Pull the image and Postgres" does:
//
//   node proof/ci/pull.mjs [--pauses SECONDS,SECONDS,...]
//
// Postgres comes from mirror.gcr.io, Google's mirror of Docker Hub, whose
// quota is per minute and shared by everyone who pulls through it, and a
// lane starts up to fourteen shards at once, so the mirror sometimes refuses a pull ("toomanyrequests") that nothing is wrong
// with. That refusal clears within the minute, unlike the sustained outage
// .github/actions/pull-test-image answers with a second path; the lane has no
// other path to its Postgres, and waiting past the minute is what changes the
// answer. So a pull the registry refused for throttling, or that failed in
// transit (a 5xx, a timeout, a reset connection, an early EOF), is tried
// again after each pause in turn, each lengthened by up to as much again at
// random so the shards do not ask together again: 30 to 60 seconds, then 60
// to 120, then 120 to 240 by default, four tries in all. Any other answer (a
// digest the registry does not hold, a refused login) is the same on every
// try, so it fails at once, and stops the other pull's wait for its next try
// too: the shard fails either way, so neither waits out a pause for nothing.
// Both pulls are by digest, so a later try can only fetch the same bytes. A
// failure prints the registry's own words and exits 1.

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs, promisify } from "node:util";

const run = promisify(execFile);

// What a registry or the network answers when a later try can succeed:
// throttling, a server error, or a connection lost on the way.
const TRANSIENT = [
	/toomanyrequests/i,
	/too many requests/i,
	/\b429\b/,
	/\b5\d\d (?:Internal Server Error|Bad Gateway|Service Unavailable|Gateway Timeout)\b/i,
	/HTTP (?:code |status:? )?5\d\d\b/i,
	/status(?: code)?:? 5\d\d\b/i,
	/TLS handshake timeout/i,
	/i\/o timeout/i,
	/connection reset/i,
	/\bEOF\b/,
];

const { values } = parseArgs({
	options: { pauses: { type: "string", default: "30,60,120" } },
});
const pauses = values.pauses.split(",").map(Number);
if (pauses.some((pause) => !Number.isFinite(pause) || pause < 0)) {
	process.stderr.write(
		`--pauses takes seconds separated by commas, such as 30,60,120; got ${JSON.stringify(values.pauses)}.\n`,
	);
	process.exit(2);
}

// Aborted once either pull fails in a way no later try changes.
const settled = new AbortController();

// Why a pull stopped trying again: the other pull failed for good.
class Stopped extends Error {}

function stopped(name) {
	return new Stopped(
		`Stopped trying the proof lane's ${name} again, since the other pull failed in a way no later try changes.`,
	);
}

async function pull(name, args, env) {
	try {
		return await tries(name, args, env);
	} catch (error) {
		if (!(error instanceof Stopped)) settled.abort();
		throw error;
	}
}

async function tries(name, args, env) {
	for (let attempt = 1; ; attempt++) {
		try {
			await run("docker", args, { env, maxBuffer: 16 * 1024 * 1024 });
			if (attempt > 1) {
				process.stdout.write(
					`Pulled the proof lane's ${name} on try ${attempt}.\n`,
				);
			}
			return;
		} catch (error) {
			const said =
				`${error.stdout ?? ""}${error.stderr ?? ""}`.trim() || error.message;
			if (!TRANSIENT.some((pattern) => pattern.test(said))) {
				throw new Error(
					`Pulling the proof lane's ${name} failed, and the answer is not one a later try changes (throttling or a failure in transit), so it was tried once. The registry said:\n${said}`,
				);
			}
			if (attempt > pauses.length) {
				throw new Error(
					`Pulling the proof lane's ${name} failed ${attempt} times, each refused for throttling or lost in transit. The last answer said:\n${said}`,
				);
			}
			if (settled.signal.aborted) throw stopped(name);
			const pause = pauses[attempt - 1] * (1 + Math.random());
			process.stdout.write(
				`Pulling the proof lane's ${name} failed on try ${attempt}, in a way a later try can change; trying again in ${Math.round(pause)} s. The registry said:\n${said}\n`,
			);
			try {
				await sleep(pause * 1000, undefined, { signal: settled.signal });
			} catch (error) {
				if (settled.signal.aborted) throw stopped(name);
				throw error;
			}
		}
	}
}

const { image } = JSON.parse(await readFile("proof/image.lock", "utf8"));
const outcomes = await Promise.allSettled([
	pull("image", ["pull", "--quiet", image], process.env),
	pull(
		"Postgres",
		["compose", "-f", "proof/compose.yaml", "pull", "--quiet", "postgres"],
		{ ...process.env, PROOF_IMAGE: image },
	),
]);
const failures = outcomes.filter((outcome) => outcome.status === "rejected");
for (const { reason } of failures) {
	process.stderr.write(`${reason.message}\n`);
}
process.exitCode = failures.length > 0 ? 1 : 0;
