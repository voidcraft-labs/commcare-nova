// proof/ci/drained.mjs lets a shard that starts late end before it pulls the
// image when every block is already held. Ending too early leaves a block
// unrun (the gate fails), so the script must say "nothing left" only when it
// has seen a claim for every block of both queues, and say "left" whenever
// the main queue is still to come. These tests run it with the real vendored
// client against a controlled artifact service (./artifactService.ts).

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { ArtifactService } from "./artifactService";
import { Scripts } from "./scripts";

let scratch: string;
let service: ArtifactService;
let scripts: Scripts;

beforeEach(async () => {
	scratch = await mkdtemp(join(tmpdir(), "proof-ci-drained-"));
	service = new ArtifactService();
	await service.start();
	scripts = new Scripts(service, scratch);
});

afterEach(async () => {
	await scripts.join();
	await service.stop();
	await rm(scratch, { recursive: true, force: true });
});

const queue = (...ids: string[]) =>
	`${JSON.stringify({
		version: 1,
		blocks: ids.map((id) => ({ id, estimate: 1, groups: [] })),
		cached: [],
	})}\n`;

async function drained(early: string[], ...mode: string[]) {
	const file = join(scratch, "early.json");
	await writeFile(file, queue(...early));
	return scripts.run("drained.mjs", [
		"--queue",
		"proof-queue-1.json",
		"--failed",
		"proof-emission-failed-1",
		"--prefix",
		"proof-claim-1-",
		...mode,
		file,
	]);
}

const held = (...names: string[]) => {
	for (const name of names) service.put(name, Buffer.from("{}\n"));
};

it("finds nothing left once every block of both queues is claimed", async () => {
	service.put("proof-queue-1.json", Buffer.from(queue("m1", "m2")));
	held("proof-claim-1-e1", "proof-claim-1-m1", "proof-claim-1-m2");
	const result = await drained(["e1"]);
	expect([result.code, result.record]).toEqual([
		0,
		{ left: false, main: "present", blocks: 3, unheld: 0 },
	]);
});

it("finds a block left when one of the main queue's blocks has no claim", async () => {
	service.put("proof-queue-1.json", Buffer.from(queue("m1", "m2")));
	held("proof-claim-1-e1", "proof-claim-1-m1");
	const result = await drained(["e1"]);
	expect(result.record).toEqual({
		left: true,
		main: "present",
		blocks: 3,
		unheld: 1,
	});
});

it("keeps the shard while the main queue is still to come, even with every early block claimed", async () => {
	held("proof-claim-1-e1");
	const result = await drained(["e1"]);
	expect(result.record).toEqual({
		left: true,
		main: "absent",
		blocks: 1,
		unheld: 0,
	});
});

it("finds nothing left when the emission failed and every early block is claimed", async () => {
	held("proof-claim-1-e1", "proof-emission-failed-1");
	const result = await drained(["e1"]);
	expect(result.record).toEqual({
		left: false,
		main: "failed",
		blocks: 1,
		unheld: 0,
	});
});

it("counts an owner's mark or a commit as held under --mode steal, and an intent alone as not", async () => {
	service.put("proof-queue-1.json", Buffer.from(queue("m1", "m2", "m3")));
	held(
		"proof-claim-1-m1.owner",
		"proof-claim-1-m2.commit-3",
		"proof-claim-1-m3.intent-2",
	);
	const result = await drained([], "--mode", "steal");
	expect(result.record).toEqual({
		left: true,
		main: "present",
		blocks: 3,
		unheld: 1,
	});
});

it("says a block may be left when it cannot read the early queue", async () => {
	const result = await scripts.run("drained.mjs", [
		"--queue",
		"proof-queue-1.json",
		"--failed",
		"proof-emission-failed-1",
		"--prefix",
		"proof-claim-1-",
		join(scratch, "missing.json"),
	]);
	expect([result.code, result.record.left]).toEqual([2, true]);
});
