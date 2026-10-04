// Races proof/ci/claim.mjs against itself on GitHub's artifact service, to
// settle which claim mode the proof lane may use (proof-claim-race.yml):
//
//   node proof/ci/race.mjs run --racer I --racers N --rounds R [--lead SECONDS] [--gap SECONDS]
//     [--meet-deadline SECONDS] [--poll SECONDS] [--prefix TEXT] --out FILE
//   node proof/ci/race.mjs count --racers N --rounds R FILE...
//
// `run` is one racer. It first meets the others: it creates the artifact
// PREFIX-ready-I and lists the run's artifacts every --poll seconds until the
// ready marks of all N racers are listed (or --meet-deadline seconds pass,
// which fails it, naming the racers that never came). The first round then
// starts --lead seconds after the latest mark's creation, as the service
// stamped it: every racer reads the same N marks, so every racer computes the
// same start, and a racer queued behind other jobs delays the race instead
// of joining it late. For each mode (create, then steal) and each round, it
// waits for the round's start on the wall clock (the first round's start plus
// the round's place times --gap), so every racer's claim of the round's one
// name leaves at the same moment, runs claim.mjs, and appends the claim's
// record, with the racer, mode, round and how many milliseconds after the
// round's start it started the claim (`late`), to FILE as one JSON line.
// Racers on different machines agree on the moment through their clocks,
// which hosted runners keep in sync.
//
// `count` reads every racer's records and, per mode and round, counts the
// claimants that owned the name, the ones told it was taken, the ones that saw
// a second creation of it (create mode), and the ones whose claim failed, and
// prints the table as Markdown (appending it to GITHUB_STEP_SUMMARY when set).
// A round holds when each of the N racers (--racers) claimed in it once,
// exactly one owned the name, no claim failed, and the claims raced: every
// claim started before the first of them ended (a claim ends `late` plus the
// seconds claim.mjs reports after the round's start), so at one moment every
// claim was in flight. A claim that started after another had
// already settled the name is told the name is taken without contending for
// it, which says nothing of the service under contention. R (--rounds)
// rounds of each mode are expected, so a racer that never ran, or stopped
// early, fails the rounds it left out instead of passing them with fewer
// claimants. It exits 0 when every round of every mode held, and 1
// otherwise, naming each round that did not and why.

import { spawn } from "node:child_process";
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { create, listAll } from "./artifacts.mjs";

const MODES = ["create", "steal"];
const CLAIM = join(import.meta.dirname, "claim.mjs");

function whole(value, name) {
	const number = Number(value);
	if (!Number.isSafeInteger(number) || number < 1) {
		throw new Error(
			`${name} takes a whole number of at least one; got ${JSON.stringify(value)}.`,
		);
	}
	return number;
}

function seconds(value, name) {
	const number = Number(value);
	if (!Number.isFinite(number) || number < 0) {
		throw new Error(
			`${name} takes a number of seconds; got ${JSON.stringify(value)}.`,
		);
	}
	return number;
}

function claim(args) {
	return new Promise((resolveClaim, reject) => {
		const child = spawn(process.execPath, [CLAIM, ...args], {
			stdio: ["ignore", "pipe", "inherit"],
		});
		let stdout = "";
		child.stdout.setEncoding("utf8").on("data", (chunk) => {
			stdout += chunk;
		});
		child.on("error", reject);
		child.on("close", (code) => {
			let record;
			try {
				record = JSON.parse(stdout.trim().split("\n").at(-1) ?? "");
			} catch {
				record = { outcome: "failed", reason: "claim.mjs wrote no record" };
			}
			resolveClaim({ code, record });
		});
	});
}

/**
 * Marks this racer ready, waits until every racer's mark is listed, and
 * resolves the first round's start: the latest mark's creation plus the
 * lead, in milliseconds since 1970, the same for every racer.
 */
async function meet({ prefix, racer, racers, lead, deadline, poll }) {
	const mark = `${prefix}-ready-`;
	await create(`${mark}${racer}`, `${JSON.stringify({ racer })}\n`);
	const started = performance.now();
	for (;;) {
		const ready = new Map();
		for (const artifact of await listAll()) {
			if (!artifact.name.startsWith(mark)) continue;
			const rest = artifact.name.slice(mark.length);
			const index = /^\d+$/.test(rest) ? Number(rest) : 0;
			if (index < 1 || index > racers) continue;
			ready.set(index, Math.max(ready.get(index) ?? 0, artifact.createdAt));
		}
		if (ready.size === racers) {
			const last = Math.max(...ready.values());
			if (!Number.isFinite(last)) {
				throw new Error(
					"The service listed every racer's ready mark without the time it created one, and the race starts from the latest of those times, so it did not start.",
				);
			}
			return last + lead * 1000;
		}
		if (performance.now() - started > deadline * 1000) {
			const missing = [];
			for (let index = 1; index <= racers; index++) {
				if (!ready.has(index)) missing.push(index);
			}
			throw new Error(
				`Racer ${missing.join(", ")} did not mark itself ready within ${deadline} s of this racer's mark, so the race did not start: every racer waits for all ${racers}, so that none of them races late.\n` +
					"The jobs of the racers that never came say why they did not reach their marks; a job queued behind others never started.",
			);
		}
		await sleep(poll * 1000);
	}
}

async function run(argv) {
	const { values } = parseArgs({
		args: argv,
		options: {
			racer: { type: "string" },
			racers: { type: "string" },
			rounds: { type: "string" },
			lead: { type: "string", default: "15" },
			gap: { type: "string", default: "6" },
			"meet-deadline": { type: "string", default: "1200" },
			poll: { type: "string", default: "2" },
			prefix: { type: "string", default: "proof-claim-race" },
			out: { type: "string" },
		},
	});
	const racer = whole(values.racer, "--racer");
	const racers = whole(values.racers, "--racers");
	const rounds = whole(values.rounds, "--rounds");
	if (racer > racers) {
		throw new Error(
			`--racer is this racer's place among the --racers ${racers}; got ${racer}.`,
		);
	}
	const gap = seconds(values.gap, "--gap");
	if (!values.out) {
		throw new Error("race.mjs run takes --out, the file its records go to.");
	}
	const at = await meet({
		prefix: values.prefix,
		racer,
		racers,
		lead: seconds(values.lead, "--lead"),
		deadline: seconds(values["meet-deadline"], "--meet-deadline"),
		poll: seconds(values.poll, "--poll"),
	});
	process.stderr.write(
		`All ${racers} racers are ready; the first round starts at ${new Date(at).toISOString()}.\n`,
	);
	let place = 0;
	for (const mode of MODES) {
		for (let round = 1; round <= rounds; round++, place++) {
			const start = at + place * gap * 1000;
			const early = start - Date.now();
			if (early > 0) await sleep(early);
			const late = Date.now() - start;
			const name = `${values.prefix}-${mode}-${round}`;
			const args =
				mode === "steal"
					? [
							"--mode",
							"steal",
							"--shard",
							`${racer}/${racers}`,
							"--by",
							`racer-${racer}`,
							name,
						]
					: ["--by", `racer-${racer}`, name];
			const { code, record } = await claim(args);
			await appendFile(
				values.out,
				`${JSON.stringify({ racer, mode, round, late, code, ...record })}\n`,
			);
		}
	}
}

/** Why a round's tally does not hold, as short phrases; empty when it holds. */
function faults(counted, racers, rounds) {
	const found = [];
	if (
		!MODES.includes(counted.mode) ||
		!Number.isSafeInteger(counted.round) ||
		counted.round < 1 ||
		counted.round > rounds
	) {
		found.push("not a round of this race");
	}
	if (
		counted.claims !== racers ||
		counted.racers.size !== racers ||
		![...counted.racers].every(
			(racer) => Number.isSafeInteger(racer) && racer >= 1 && racer <= racers,
		)
	) {
		found.push(
			`${counted.claims} claims from ${counted.racers.size} of the ${racers} racers`,
		);
	}
	if (counted.claimed !== 1) found.push(`${counted.claimed} owners`);
	if (counted.failed > 0) found.push(`${counted.failed} failed claims`);
	if (counted.claims > 0 && !counted.raced) {
		found.push(
			Number.isFinite(counted.latest) && Number.isFinite(counted.earliest)
				? `not raced: a claim started ${counted.latest} ms after the round's start, when the first claim to end had ended at ${counted.earliest} ms`
				: "not raced: a claim's record leaves out when it started or how long it took",
		);
	}
	return found;
}

async function count(argv) {
	const { values, positionals: files } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: {
			racers: { type: "string" },
			rounds: { type: "string" },
		},
	});
	const racers = whole(values.racers, "--racers");
	const rounds = whole(values.rounds, "--rounds");
	if (files.length === 0) {
		throw new Error(
			"race.mjs count takes the racers' records files after --racers and --rounds.",
		);
	}
	const records = [];
	for (const file of files) {
		for (const line of (await readFile(file, "utf8")).split("\n")) {
			if (line.trim()) records.push(JSON.parse(line));
		}
	}
	const tallies = new Map();
	const tally = (mode, round) => {
		const key = `${mode} ${round}`;
		if (!tallies.has(key)) {
			tallies.set(key, {
				mode,
				round,
				claimed: 0,
				taken: 0,
				duplicate: 0,
				failed: 0,
				racers: new Set(),
				claims: 0,
				// When the last claim started, and when the first claim ended, in milliseconds after the round's start.
				latest: Number.NEGATIVE_INFINITY,
				earliest: Number.POSITIVE_INFINITY,
				timed: true,
			});
		}
		return tallies.get(key);
	};
	for (const mode of MODES) {
		for (let round = 1; round <= rounds; round++) tally(mode, round);
	}
	for (const record of records) {
		const counted = tally(record.mode, record.round);
		counted.claims += 1;
		counted.racers.add(record.racer);
		counted[
			["claimed", "taken", "duplicate"].includes(record.outcome)
				? record.outcome
				: "failed"
		] += 1;
		const late = Number(record.late);
		// claim.mjs reports whole milliseconds as seconds.
		const took = Math.round(Number(record.seconds) * 1000);
		if (
			typeof record.late !== "number" ||
			typeof record.seconds !== "number" ||
			!Number.isFinite(late) ||
			!Number.isFinite(took)
		) {
			counted.timed = false;
			continue;
		}
		counted.latest = Math.max(counted.latest, late);
		counted.earliest = Math.min(counted.earliest, late + took);
	}
	const ordered = [...tallies.values()].sort(
		(a, b) =>
			MODES.indexOf(a.mode) - MODES.indexOf(b.mode) || a.round - b.round,
	);
	for (const counted of ordered) {
		counted.raced =
			counted.claims > 0 && counted.timed && counted.latest < counted.earliest;
		if (!counted.timed) {
			counted.latest = Number.NaN;
			counted.earliest = Number.NaN;
		}
	}
	const shown = (value) => (Number.isFinite(value) ? `${value}` : "-");
	const wrong = ordered
		.map((counted) => ({ counted, found: faults(counted, racers, rounds) }))
		.filter(({ found }) => found.length > 0);
	const lines = [
		"## Claim race",
		"",
		`${records.length} claims in ${ordered.length} rounds, of ${racers} racers and ${rounds} rounds a mode. A round holds when each racer claimed in it once, exactly one owned its name, no claim failed, and every claim started before the first of them ended.`,
		"",
		"| Mode | Round | Claims | Owned | Taken | Second creation seen | Failed | Last start (ms) | First end (ms) | Raced |",
		"|---|---|---|---|---|---|---|---|---|---|",
		...ordered.map(
			(counted) =>
				`| ${counted.mode} | ${counted.round} | ${counted.claims} | ${counted.claimed} | ${counted.taken} | ${counted.duplicate} | ${counted.failed} | ${shown(counted.latest)} | ${shown(counted.earliest)} | ${counted.raced ? "yes" : "no"} |`,
		),
		"",
		...(wrong.length === 0
			? ["Every round raced and had exactly one owner."]
			: [
					`${wrong.length} rounds did not hold:`,
					...wrong.map(
						({ counted, found }) =>
							`- ${counted.mode} ${counted.round}: ${found.join("; ")}.`,
					),
				]),
	];
	const text = `${lines.join("\n")}\n`;
	process.stdout.write(text);
	if (process.env.GITHUB_STEP_SUMMARY) {
		await appendFile(process.env.GITHUB_STEP_SUMMARY, text);
	}
	return wrong.length === 0 ? 0 : 1;
}

const [command, ...rest] = process.argv.slice(2);
try {
	if (command === "run") {
		await run(rest);
	} else if (command === "count") {
		process.exitCode = await count(rest);
	} else {
		throw new Error(
			"race.mjs takes `run` (one racer) or `count` (the table of every racer's records).",
		);
	}
} catch (error) {
	process.stderr.write(`${error.message}\n`);
	process.exitCode = 2;
}
