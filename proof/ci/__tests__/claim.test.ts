// proof/ci/claim.mjs decides which shard runs each block of the proof lane's
// queue, and a block two shards both run fails the lane's gate (its outputs
// can differ), as does a block no shard runs. These tests run the script with
// the real vendored @actions/artifact client against a controlled artifact
// service (./artifactService.ts) and hold the outcome to that contract: at
// most one claimant owns a block, in every interleaving the service's
// answers can produce, and a claim that cannot be settled stops claiming
// rather than guessing. Races are built by holding the service's answers
// until every racer's request has arrived, so each interleaving is the one
// the test names, not one a scheduler happened to pick.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ownerOf } from "../artifacts.mjs";
import { ArtifactService, type ServiceOptions } from "./artifactService";
import { type Finished, Scripts } from "./scripts";

let scratch: string;
let service: ArtifactService;
let scripts: Scripts;

async function serve(options: ServiceOptions = {}) {
	service = new ArtifactService(options);
	await service.start();
	scripts = new Scripts(service, scratch);
}

beforeEach(async () => {
	scratch = await mkdtemp(join(tmpdir(), "proof-ci-claim-"));
});

afterEach(async () => {
	await scripts?.join();
	await service?.stop();
	await rm(scratch, { recursive: true, force: true });
});

const claim = (name: string, job: string, ...args: string[]) =>
	scripts.run("claim.mjs", [...args, name], { job });

const outcomes = (finished: Finished[]) =>
	finished.map((result) => [result.code, result.record.outcome]);

/** A deterministic stream of numbers in [0, 1), so a schedule the sweep builds can be built again. */
function seeded(seed: number) {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let value = Math.imul(state ^ (state >>> 15), 1 | state);
		value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
		return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
	};
}

describe("--mode create", () => {
	it("gives a block to its first claimant and tells every later one it is taken", async () => {
		await serve();
		const first = await claim("proof-claim-1-block", "shard-1");
		const second = await claim("proof-claim-1-block", "shard-2");
		expect(outcomes([first, second])).toEqual([
			[0, "claimed"],
			[1, "taken"],
		]);
		expect(first.record.listed).toEqual([first.record.artifactId]);
		expect(service.named("proof-claim-1-block")).toHaveLength(1);
		// A different block is a different name, and its own claim.
		expect((await claim("proof-claim-1-other", "shard-2")).code).toBe(0);
	});

	it("gives a block to exactly one of eight claimants whose creations reach the service together", async () => {
		await serve();
		const together = service.hold((call) => call.method === "CreateArtifact");
		const racers = Array.from({ length: 8 }, (_, index) =>
			claim("proof-claim-1-raced", `shard-${index + 1}`),
		);
		await together.arrived(8);
		together.release();
		const finished = await Promise.all(racers);
		expect(finished.filter((result) => result.code === 0)).toHaveLength(1);
		expect(finished.filter((result) => result.code === 1)).toHaveLength(7);
		expect(service.named("proof-claim-1-raced")).toHaveLength(1);
	});

	describe("on a service that accepts a second creation of one name", () => {
		it("lets no claimant own the block when both are finalized before either lists", async () => {
			await serve({ exclusive: false });
			const listings = service.hold((call) => call.method === "ListArtifacts");
			const racers = ["shard-1", "shard-2"].map((job) =>
				claim("proof-claim-1-twice", job),
			);
			await listings.arrived(2);
			listings.release();
			const finished = await Promise.all(racers);
			expect(outcomes(finished)).toEqual([
				[1, "duplicate"],
				[1, "duplicate"],
			]);
			expect(finished[0].record.listed).toEqual([1, 2]);
		});

		it("gives the block to the one that listed before the other was finalized", async () => {
			await serve({ exclusive: false });
			const late = service.hold(
				(call) => call.method === "FinalizeArtifact" && call.job === "shard-2",
			);
			const second = claim("proof-claim-1-twice", "shard-2");
			await late.arrived(1);
			const first = await claim("proof-claim-1-twice", "shard-1");
			late.release();
			expect(outcomes([first, await second])).toEqual([
				[0, "claimed"],
				[1, "duplicate"],
			]);
		});

		it("never gives one block to two claimants, over ten schedules of four", async () => {
			await serve({ exclusive: false });
			const random = seeded(20261001);
			service.latency = () => Math.floor(random() * 25);
			for (let round = 1; round <= 10; round++) {
				const finished = await Promise.all(
					[1, 2, 3, 4].map((shard) =>
						claim(`proof-claim-1-round-${round}`, `shard-${shard}`),
					),
				);
				const owners = finished.filter((result) => result.code === 0);
				expect(owners.length, `round ${round}`).toBeLessThanOrEqual(1);
				for (const result of finished.filter((item) => item.code !== 0)) {
					expect(result.record.outcome, `round ${round}`).toBe("duplicate");
				}
			}
		}, 30_000);
	});

	it("stops claiming when a listing taken after its own finalized claim does not hold it", async () => {
		await serve();
		service.revealAfter(5);
		const result = await claim("proof-claim-1-unlisted", "shard-1");
		expect([result.code, result.record.outcome]).toEqual([2, "failed"]);
		expect(result.stderr).toContain("does not hold it");
	});

	it("stops claiming when the service refuses the claim for any reason but the name", async () => {
		await serve();
		service.fail(
			"CreateArtifact",
			403,
			"permission_denied",
			"the token may not write artifacts",
		);
		const refused = await claim("proof-claim-1-forbidden", "shard-1");
		expect([refused.code, refused.record.outcome]).toEqual([2, "failed"]);
		expect(refused.stderr).toContain("(403)");
	});

	it("stops claiming, before any request, when the job's runtime credentials did not reach it", async () => {
		await serve();
		const result = await scripts.run("claim.mjs", ["proof-claim-1-x"], {
			env: { ACTIONS_RESULTS_URL: service.env("shard-1").ACTIONS_RESULTS_URL },
		});
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("ACTIONS_RUNTIME_TOKEN is not set");
		expect(service.calls).toEqual([]);
	});

	describe("--listing-cache", () => {
		async function cache(names: string[], ageSeconds: number) {
			const file = join(scratch, "listing.json");
			await writeFile(
				file,
				JSON.stringify({ at: Date.now() - ageSeconds * 1000, names }),
			);
			return file;
		}

		it("answers taken for a name a recent listing holds, without asking the service", async () => {
			await serve();
			const file = await cache(["proof-claim-1-held"], 0);
			const result = await claim(
				"proof-claim-1-held",
				"shard-1",
				"--listing-cache",
				file,
			);
			expect([result.code, result.record.outcome]).toEqual([1, "taken"]);
			expect(service.calls).toEqual([]);
		});

		it("never answers free, and is not read once older than --listing-age", async () => {
			await serve();
			service.put("proof-claim-1-held", Buffer.from("{}\n"));
			const lacking = await claim(
				"proof-claim-1-held",
				"shard-1",
				"--listing-cache",
				await cache([], 0),
			);
			expect([lacking.code, lacking.record.outcome]).toEqual([1, "taken"]);
			const old = await claim(
				"proof-claim-1-free",
				"shard-1",
				"--listing-cache",
				await cache(["proof-claim-1-free"], 60),
				"--listing-age",
				"5",
			);
			expect([old.code, old.record.outcome]).toEqual([0, "claimed"]);
			expect(
				service.calls.filter((call) => call.method === "CreateArtifact"),
			).toHaveLength(2);
		});
	});
});

describe("--mode steal", () => {
	const TOTAL = 4;
	/** A claim name owned by shard `owner` of TOTAL, found by asking the script's own owner rule. */
	function ownedBy(owner: number, tag: string): string {
		for (let index = 0; ; index++) {
			const name = `proof-claim-1-${tag}-${index}`;
			if (ownerOf(name, TOTAL) === owner) return name;
		}
	}
	const steal = (name: string, shard: number, ...args: string[]) =>
		claim(
			name,
			`shard-${shard}`,
			"--mode",
			"steal",
			"--shard",
			`${shard}/${TOTAL}`,
			"--poll",
			"0.02",
			...args,
		);
	const markersOf = (name: string) =>
		["owner", 1, 2, 3, 4].flatMap((shard) =>
			(shard === "owner"
				? [`${name}.owner`]
				: [
						`${name}.intent-${shard}`,
						`${name}.commit-${shard}`,
						`${name}.withdraw-${shard}`,
					]
			).filter((marker) => service.named(marker).length > 0),
		);

	it("gives a block to its owner when no other shard wants it", async () => {
		await serve({ exclusive: false });
		const name = ownedBy(1, "alone");
		const result = await steal(name, 1);
		expect([result.code, result.record.outcome]).toEqual([0, "claimed"]);
		expect(markersOf(name)).toEqual([`${name}.owner`]);
	});

	it("lets another shard take a block its owner has not reached, and then tells the owner it is taken", async () => {
		await serve({ exclusive: false });
		const name = ownedBy(1, "early");
		const thief = await steal(name, 3);
		expect([thief.code, thief.record.outcome]).toEqual([0, "claimed"]);
		const owner = await steal(name, 1);
		expect([owner.code, owner.record.outcome]).toEqual([1, "taken"]);
		expect(markersOf(name)).toEqual([`${name}.intent-3`, `${name}.commit-3`]);
	});

	it("keeps a block its owner marked from every other shard", async () => {
		await serve({ exclusive: false });
		const name = ownedBy(2, "marked");
		expect((await steal(name, 2)).code).toBe(0);
		const late = await steal(name, 4);
		expect([late.code, late.record.outcome]).toEqual([1, "taken"]);
		expect(markersOf(name)).toEqual([`${name}.owner`]);
	});

	it("gives the block to its owner when the owner and three others declare together", async () => {
		await serve({ exclusive: false });
		const name = ownedBy(2, "together");
		const declarations = service.hold(
			(call) =>
				call.method === "CreateArtifact" &&
				/\.(owner|intent-\d)$/.test(call.name ?? ""),
		);
		const racers = [1, 2, 3, 4].map((shard) => steal(name, shard));
		await declarations.arrived(4);
		// Each shard lists after its declaration is finalized; held until all four list, every listing holds all four.
		const listings = service.hold((call) => call.method === "ListArtifacts");
		declarations.release();
		await listings.arrived(4);
		listings.release();
		const finished = await Promise.all(racers);
		expect(finished.map((result) => result.code)).toEqual([1, 0, 1, 1]);
		expect(markersOf(name)).toEqual([
			`${name}.owner`,
			`${name}.intent-1`,
			`${name}.withdraw-1`,
			`${name}.intent-3`,
			`${name}.withdraw-3`,
			`${name}.intent-4`,
			`${name}.withdraw-4`,
		]);
	});

	it("leaves the block to a shard that committed while its owner's mark was on the way", async () => {
		await serve({ exclusive: false });
		const name = ownedBy(1, "crossing");
		const mark = service.hold(
			(call) =>
				call.method === "CreateArtifact" && call.name === `${name}.owner`,
		);
		const owner = steal(name, 1);
		await mark.arrived(1);
		const thief = await steal(name, 2);
		mark.release();
		expect([thief.code, (await owner).code]).toEqual([0, 1]);
	});

	it("withdraws when the owner marked the block between its look and its declaration", async () => {
		await serve({ exclusive: false });
		const name = ownedBy(1, "between");
		const declaration = service.hold(
			(call) =>
				call.method === "CreateArtifact" && call.name === `${name}.intent-2`,
		);
		const thief = steal(name, 2);
		await declaration.arrived(1);
		const owner = await steal(name, 1);
		declaration.release();
		expect([owner.code, (await thief).code]).toEqual([0, 1]);
		expect(markersOf(name)).toEqual([
			`${name}.owner`,
			`${name}.intent-2`,
			`${name}.withdraw-2`,
		]);
	});

	it("makes the owner wait for a shard it saw declare, and leaves that shard the block when it commits", async () => {
		await serve({ exclusive: false });
		const name = ownedBy(1, "waiting");
		const mark = service.hold(
			(call) =>
				call.method === "CreateArtifact" && call.name === `${name}.owner`,
		);
		const commit = service.hold(
			(call) =>
				call.method === "CreateArtifact" && call.name === `${name}.commit-2`,
		);
		const owner = steal(name, 1);
		await mark.arrived(1);
		const thief = steal(name, 2);
		await commit.arrived(1);
		// The owner's second listing after its mark is a poll: it saw the declaration and is waiting on it.
		let ownerListings = 0;
		const polling = service.hold(
			(call) =>
				call.method === "ListArtifacts" &&
				call.job === "shard-1" &&
				++ownerListings === 2,
		);
		mark.release();
		const early = await Promise.race([
			polling.arrived(1).then(() => "waiting"),
			owner.then(() => "ended"),
		]);
		expect(early).toBe("waiting");
		commit.release();
		expect((await thief).code).toBe(0);
		polling.release();
		const settled = await owner;
		expect([settled.code, settled.record.outcome]).toEqual([1, "taken"]);
	});

	it("stops its owner's claiming when a declared shard never commits or withdraws", async () => {
		await serve({ exclusive: false });
		const name = ownedBy(1, "silent");
		service.put(`${name}.intent-3`, Buffer.from("{}\n"));
		// An intent with no commit does not keep the owner from marking; it then waits for that shard to settle.
		const result = await steal(name, 1, "--resolve-seconds", "0.2");
		expect([result.code, result.record.outcome]).toEqual([2, "failed"]);
		expect(result.stderr).toContain("Shard 3 declared");
	});

	it("runs every block exactly once, over ten schedules of all four shards", async () => {
		await serve({ exclusive: false });
		const random = seeded(7);
		service.latency = () => Math.floor(random() * 25);
		for (let round = 1; round <= 10; round++) {
			const name = `proof-claim-1-sweep-${round}`;
			const finished = await Promise.all(
				[1, 2, 3, 4].map((shard) => steal(name, shard)),
			);
			expect(
				finished.filter((result) => result.code === 0),
				`round ${round}: ${JSON.stringify(outcomes(finished))}`,
			).toHaveLength(1);
			expect(finished.every((result) => result.code !== 2)).toBe(true);
		}
	}, 30_000);

	it("refuses a steal claim that does not say which shard it is", async () => {
		await serve({ exclusive: false });
		const result = await claim("proof-claim-1-x", "shard-1", "--mode", "steal");
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("--mode steal needs --shard I/N");
		expect(service.calls).toEqual([]);
	});
});
