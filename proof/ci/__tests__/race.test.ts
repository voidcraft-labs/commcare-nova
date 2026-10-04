// proof/ci/race.mjs is what the one-time claim-race workflow runs, so its
// verdict decides the lane's claim mode. These tests race real racers (each
// running the real claim.mjs) against a controlled artifact service, and hold
// the count to rounds whose owners and timing are known: an exclusive service
// gives each round one owner; a round with two owners, a failed claim, a
// missing racer, or a claim that started after another had already ended
// fails it. The racers meet before the first round, so a racer that starts
// late delays the race, and one that never comes stops it by name.

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, expect, it } from "vitest";
import { ArtifactService } from "./artifactService";
import { type Finished, Scripts } from "./scripts";

let scratch: string;
let service: ArtifactService;
let scripts: Scripts;

beforeEach(async () => {
	scratch = await mkdtemp(join(tmpdir(), "proof-ci-race-"));
	service = new ArtifactService();
	await service.start();
	scripts = new Scripts(service, scratch);
});

afterEach(async () => {
	await scripts.join();
	await service.stop();
	await rm(scratch, { recursive: true, force: true });
});

function racer(
	index: number,
	racers: number,
	extra: string[] = [],
): Promise<Finished> {
	return scripts.run(
		"race.mjs",
		[
			"run",
			"--racer",
			String(index),
			"--racers",
			String(racers),
			"--rounds",
			"1",
			"--lead",
			"0.5",
			"--gap",
			"1.5",
			"--poll",
			"0.05",
			"--out",
			join(scratch, `racer-${index}.jsonl`),
			...extra,
		],
		{ job: `racer-${index}` },
	);
}

function count(racers: number, rounds: number, files: string[]) {
	return scripts.run("race.mjs", [
		"count",
		"--racers",
		String(racers),
		"--rounds",
		String(rounds),
		...files,
	]);
}

async function records(index: number) {
	return (await readFile(join(scratch, `racer-${index}.jsonl`), "utf8"))
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
}

/** The service's sequence number of the first call `match` accepts. */
function firstCall(match: (call: (typeof service.calls)[number]) => boolean) {
	const call = service.calls.find(match);
	if (!call) throw new Error("The service received no such call.");
	return call.sequence;
}

it("races three racers through a round of each mode and finds one owner a round", async () => {
	const finished = await Promise.all([1, 2, 3].map((index) => racer(index, 3)));
	expect(finished.map((result) => result.code)).toEqual([0, 0, 0]);
	expect((await records(1)).map((line) => [line.mode, line.round])).toEqual([
		["create", 1],
		["steal", 1],
	]);
	const counted = await count(
		3,
		1,
		[1, 2, 3].map((index) => join(scratch, `racer-${index}.jsonl`)),
	);
	expect(counted.code).toBe(0);
	expect(counted.stdout).toContain(
		"Every round raced and had exactly one owner.",
	);
	expect(counted.stdout).toMatch(
		/\| create \| 1 \| 3 \| 1 \| 2 \| 0 \| 0 \| \d+ \| \d+ \| yes \|/,
	);
}, 30_000);

it("waits for a racer that starts late, so the race starts with every racer at once", async () => {
	const early = [1, 2].map((index) => racer(index, 3));
	// Racer 3's job starts two seconds after the others', as a job queued behind others does.
	await sleep(2_000);
	const late = racer(3, 3);
	const finished = await Promise.all([...early, late]);
	expect(finished.map((result) => result.code)).toEqual([0, 0, 0]);
	// No racer claimed the round's name before racer 3 had marked itself ready.
	const ready = firstCall(
		(call) =>
			call.method === "FinalizeArtifact" &&
			call.name === "proof-claim-race-ready-3",
	);
	const raced = firstCall(
		(call) =>
			call.method === "CreateArtifact" &&
			call.name === "proof-claim-race-create-1",
	);
	expect(raced).toBeGreaterThan(ready);
	// Every racer read the same marks, so every racer set the same start.
	const starts = finished.map(
		(result) => /the first round starts at (\S+)\./.exec(result.stderr)?.[1],
	);
	expect(starts[0]).toBeDefined();
	expect(new Set(starts).size).toBe(1);
	for (const index of [1, 2, 3]) {
		for (const line of await records(index)) {
			expect(line.late).toBeLessThan(500);
		}
	}
	const counted = await count(
		3,
		1,
		[1, 2, 3].map((index) => join(scratch, `racer-${index}.jsonl`)),
	);
	expect(counted.code).toBe(0);
}, 30_000);

it("stops every racer at the meeting's deadline, naming the racer that never came", async () => {
	const finished = await Promise.all(
		[1, 2].map((index) => racer(index, 3, ["--meet-deadline", "1"])),
	);
	expect(finished.map((result) => result.code)).toEqual([2, 2]);
	for (const result of finished) {
		expect(result.stderr).toContain(
			"Racer 3 did not mark itself ready within 1 s of this racer's mark, so the race did not start",
		);
	}
	// Neither racer claimed anything.
	expect(
		service.calls.filter(
			(call) =>
				call.method === "CreateArtifact" &&
				!call.name?.startsWith("proof-claim-race-ready-"),
		),
	).toEqual([]);
}, 30_000);

async function recordsFile(lines: object[]) {
	const file = join(scratch, "records.jsonl");
	await writeFile(
		file,
		`${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
	);
	return file;
}

it("fails the count for a round two racers owned, or one whose claim failed", async () => {
	const timed = { late: 2, seconds: 1.2 };
	const file = await recordsFile([
		{ racer: 1, mode: "create", round: 1, outcome: "claimed", ...timed },
		{ racer: 2, mode: "create", round: 1, outcome: "claimed", ...timed },
		{ racer: 1, mode: "create", round: 2, outcome: "claimed", ...timed },
		{ racer: 2, mode: "create", round: 2, outcome: "taken", ...timed },
		{ racer: 1, mode: "steal", round: 1, outcome: "claimed", ...timed },
		{ racer: 2, mode: "steal", round: 1, outcome: "failed", ...timed },
	]);
	const counted = await count(2, 2, [file]);
	expect(counted.code).toBe(1);
	expect(counted.stdout).toContain("3 rounds did not hold:");
	expect(counted.stdout).toContain("- create 1: 2 owners.");
	expect(counted.stdout).toContain("- steal 1: 1 failed claims.");
	// steal 2 had no claims at all.
	expect(counted.stdout).toContain(
		"- steal 2: 0 claims from 0 of the 2 racers; 0 owners.",
	);
	expect(counted.stdout).not.toContain("- create 2:");
});

it("fails the rounds a racer left out, though one racer owned each of them", async () => {
	// Racer 3's job never started and racer 2's stopped after its first round:
	// every round present still has exactly one owner and no failed claim.
	const timed = { late: 1, seconds: 1 };
	const file = await recordsFile([
		{ racer: 1, mode: "create", round: 1, outcome: "claimed", ...timed },
		{ racer: 2, mode: "create", round: 1, outcome: "taken", ...timed },
		{ racer: 1, mode: "create", round: 2, outcome: "claimed", ...timed },
		{ racer: 1, mode: "steal", round: 1, outcome: "claimed", ...timed },
		{ racer: 1, mode: "steal", round: 2, outcome: "claimed", ...timed },
	]);
	const partial = await count(3, 2, [file]);
	expect(partial.code).toBe(1);
	expect(partial.stdout).toContain("4 rounds did not hold:");
	expect(partial.stdout).toContain(
		"- create 1: 2 claims from 2 of the 3 racers.",
	);
	expect(partial.stdout).toContain(
		"- steal 2: 1 claims from 1 of the 3 racers.",
	);
	// Read as a race of one racer, every round but the one a second racer also claimed in holds.
	const alone = await count(1, 2, [file]);
	expect(alone.code).toBe(1);
	expect(alone.stdout).toContain("1 rounds did not hold:");
	expect(alone.stdout).toContain(
		"- create 1: 2 claims from 2 of the 1 racers.",
	);
});

it("fails a round a racer started after another racer's claim had ended, though it had one owner", async () => {
	// Every racer claimed once and one owned each name, but in create 1 racer 3
	// started 150 s late, long after racer 1's claim (1.2 s) settled the name:
	// it was told the name was taken without ever contending for it. In create 2
	// racer 3 started 900 ms late, while every other claim was still in flight.
	const file = await recordsFile([
		{
			racer: 1,
			mode: "create",
			round: 1,
			outcome: "claimed",
			late: 0,
			seconds: 1.2,
		},
		{
			racer: 2,
			mode: "create",
			round: 1,
			outcome: "taken",
			late: 3,
			seconds: 0.4,
		},
		{
			racer: 3,
			mode: "create",
			round: 1,
			outcome: "taken",
			late: 150_000,
			seconds: 0.3,
		},
		{
			racer: 1,
			mode: "create",
			round: 2,
			outcome: "claimed",
			late: 0,
			seconds: 1.2,
		},
		{
			racer: 2,
			mode: "create",
			round: 2,
			outcome: "taken",
			late: 3,
			seconds: 1.1,
		},
		{
			racer: 3,
			mode: "create",
			round: 2,
			outcome: "taken",
			late: 900,
			seconds: 0.3,
		},
		{
			racer: 1,
			mode: "steal",
			round: 1,
			outcome: "claimed",
			late: 1,
			seconds: 2,
		},
		{
			racer: 2,
			mode: "steal",
			round: 1,
			outcome: "taken",
			late: 1,
			seconds: 2,
		},
		{
			racer: 3,
			mode: "steal",
			round: 1,
			outcome: "taken",
			late: 1,
			seconds: 2,
		},
		{
			racer: 1,
			mode: "steal",
			round: 2,
			outcome: "claimed",
			late: 0,
			seconds: 2,
		},
		{ racer: 2, mode: "steal", round: 2, outcome: "taken", late: 0 },
		{
			racer: 3,
			mode: "steal",
			round: 2,
			outcome: "taken",
			late: 0,
			seconds: 2,
		},
	]);
	const counted = await count(3, 2, [file]);
	expect(counted.code).toBe(1);
	expect(counted.stdout).toContain("2 rounds did not hold:");
	expect(counted.stdout).toContain(
		"- create 1: not raced: a claim started 150000 ms after the round's start, when the first claim to end had ended at 403 ms.",
	);
	expect(counted.stdout).toContain(
		"| create | 1 | 3 | 1 | 2 | 0 | 0 | 150000 | 403 | no |",
	);
	expect(counted.stdout).toContain(
		"| create | 2 | 3 | 1 | 2 | 0 | 0 | 900 | 1103 | yes |",
	);
	// A record that says nothing of how long its claim took cannot show the round raced.
	expect(counted.stdout).toContain(
		"- steal 2: not raced: a claim's record leaves out when it started or how long it took.",
	);
});
