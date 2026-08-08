/**
 * The per-actor generation admission gate — key derivation golden vectors
 * (the versioned namespace is a wire-stable contract: a drifted derivation
 * would silently stop serializing the same actors across revisions) plus the
 * cross-target admission scan's classification behavior on a real Postgres.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	actorGenerationGateKey,
	scanActorGenerationTargets,
} from "../actorGenerationGate";
import { setupAppStateTestDb } from "./appStateTestDb";

const h = setupAppStateTestDb("actor_gate_");

describe("actorGenerationGateKey", () => {
	it("matches the versioned golden vectors exactly", () => {
		/* SHA-256("nova:actor-generation-admission:v1:" + actor), first 8 bytes
		 * big-endian as a SIGNED int64. Recomputed independently; a change to
		 * the namespace, hash, byte order, or signedness fails here. */
		expect(actorGenerationGateKey("user-1").toString()).toBe(
			"-3905906495618287466",
		);
		expect(actorGenerationGateKey("user-2").toString()).toBe(
			"-624199173685749957",
		);
		expect(
			actorGenerationGateKey("f47ac10b-58cc-4372-a567-0e02b2c3d479").toString(),
		).toBe("-1014019622199630657");
	});

	it("is deterministic and collision-distinct for distinct actors", () => {
		expect(actorGenerationGateKey("alice")).toBe(
			actorGenerationGateKey("alice"),
		);
		expect(actorGenerationGateKey("alice")).not.toBe(
			actorGenerationGateKey("bob"),
		);
	});

	it("stays inside PostgreSQL's signed bigint range", () => {
		const int64Min = -(BigInt(2) ** BigInt(63));
		const int64Max = BigInt(2) ** BigInt(63);
		for (const actor of ["a", "user-1", "user-2", "x".repeat(200)]) {
			const key = actorGenerationGateKey(actor);
			expect(key >= int64Min).toBe(true);
			expect(key < int64Max).toBe(true);
		}
	});

	it("refuses a blank actor id", () => {
		expect(() => actorGenerationGateKey("")).toThrow(/nonblank/);
	});
});

describe("lifecycle lock order (§11.13)", () => {
	/** Every holder/reservation LIFECYCLE writer must take the actor gate as
	 * its FIRST lock — before the authority row — while unchanged-holder
	 * writes (heartbeats) must NOT take it. The source scan slices each named
	 * function's body and compares call positions, so a refactor that swaps
	 * the order (the gate↔row deadlock shape) fails here. */
	function functionBody(source: string, name: string): string {
		const start = source.indexOf(`export async function ${name}`);
		expect(start, `missing function ${name}`).toBeGreaterThanOrEqual(0);
		const next = source.indexOf("\nexport ", start + 1);
		return source.slice(start, next === -1 ? undefined : next);
	}

	function firstIndexOfAny(body: string, needles: string[]): number {
		const hits = needles
			.map((needle) => body.indexOf(needle))
			.filter((index) => index >= 0);
		return hits.length === 0 ? -1 : Math.min(...hits);
	}

	const ROW_LOCKS = [
		"lockAppRow(",
		"lockLeaseRow(",
		"lockSessionRow(",
		"lockDesignSessionLeaseRow(",
	];
	const GATES = [
		"lockActorGenerationGate(",
		"lockActorGenerationGateForAppHolder(",
		"lockActorGenerationGateForSessionHolder(",
	];

	const GATED: Record<string, string[]> = {
		"lib/db/apps.ts": [
			"claimAndReserveRun",
			"reserveForNewBuild",
			"reacquireLease",
			"setAwaitingInput",
			"completeAndSettleRun",
			"clearRunLockAndSettle",
			"clearRunLock",
			"failApp",
			"recoverAppStatus",
		],
		"lib/db/credits.ts": [
			"refundReservation",
			"settleAndRelease",
			"refundStaleReservation",
			"refundStaleGeneration",
			"refundDesignSessionReservation",
			"refundStaleDesignSessionRun",
			"settleAndReleaseDesignSessionRun",
		],
		"lib/db/designSessions.ts": [
			"claimAndReserveDesignSessionRun",
			"reacquireDesignSessionLease",
			"setDesignSessionAwaitingInput",
			"completeAndSettleDesignSessionRun",
			"discardDesignSession",
		],
		"lib/agent/change-set/materializeGenesis.ts": ["materializeAppFromGenesis"],
	};
	const UNGATED: Record<string, string[]> = {
		"lib/db/apps.ts": ["refreshEditLease", "refreshBuildLiveness"],
		"lib/db/designSessions.ts": ["refreshDesignSessionLiveness"],
	};

	it("every lifecycle writer takes the gate before its authority row", () => {
		for (const [file, names] of Object.entries(GATED)) {
			const source = readFileSync(join(process.cwd(), file), "utf8");
			for (const name of names) {
				const body = functionBody(source, name);
				const gateAt = firstIndexOfAny(body, GATES);
				const rowAt = firstIndexOfAny(body, ROW_LOCKS);
				expect(gateAt, `${file}::${name} takes no actor gate`).toBeGreaterThan(
					-1,
				);
				if (rowAt >= 0) {
					expect(
						gateAt,
						`${file}::${name} locks its authority row before the actor gate`,
					).toBeLessThan(rowAt);
				}
			}
		}
	});

	it("unchanged-holder heartbeats stay row-first with no gate", () => {
		for (const [file, names] of Object.entries(UNGATED)) {
			const source = readFileSync(join(process.cwd(), file), "utf8");
			for (const name of names) {
				const body = functionBody(source, name);
				expect(
					firstIndexOfAny(body, GATES),
					`${file}::${name} must not take the actor gate`,
				).toBe(-1);
			}
		}
	});
});

describe("generationTargets stays a type leaf", () => {
	/* The union + column mappers are imported across the whole protocol
	 * layer (threads, streams, usage, run summaries, the agent contexts).
	 * A runtime import added here lands in every one of those graphs —
	 * pulling `designSessions`/`apps` (and through them the commit kernel)
	 * in is the exact shape that deadlocked the agent media suites'
	 * mocked-module factories under vitest (a `vi.mock` factory's dynamic
	 * import re-entered a module still evaluating in the same graph). The
	 * database-reading resolver belongs in `generationTargetScope.ts`. */
	it("imports nothing but zod", () => {
		const source = readFileSync(
			join(process.cwd(), "lib/db/generationTargets.ts"),
			"utf8",
		);
		const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
		expect(imports).toEqual(["zod"]);
	});
});

describe("scanActorGenerationTargets", () => {
	const ACTOR = "scan-actor";
	const NONCE = "00000000-0000-4000-8000-00000000aa01";

	it("counts a live design-session build against the actor and skips other actors'", async () => {
		await h.seedDesignSession({
			owner_user_id: ACTOR,
			run_id: "run-live",
			run_holder_nonce: NONCE,
			run_actor_user_id: ACTOR,
			run_lease_expires_at: new Date(Date.now() + 60_000),
			reservation: {
				period: "2026-08",
				reserved: 100,
				settled: false,
				userId: ACTOR,
				runId: "run-live",
			},
		});
		await h.seedDesignSession({
			owner_user_id: "someone-else",
			run_id: "run-other",
			run_holder_nonce: NONCE,
			run_actor_user_id: "someone-else",
			run_lease_expires_at: new Date(Date.now() + 60_000),
			reservation: {
				period: "2026-08",
				reserved: 100,
				settled: false,
				userId: "someone-else",
				runId: "run-other",
			},
		});
		const scan = await h.withTransaction((tx) =>
			scanActorGenerationTargets(tx, ACTOR),
		);
		expect(scan.live).toBe(true);
		expect(scan.reapable).toEqual([]);
	});

	it("classifies a lapsed design-session lease as reapable, not live", async () => {
		const sessionId = await h.seedDesignSession({
			owner_user_id: ACTOR,
			run_id: "run-stale",
			run_holder_nonce: NONCE,
			run_actor_user_id: ACTOR,
			run_lease_expires_at: new Date(Date.now() - 60_000),
			reservation: {
				period: "2026-08",
				reserved: 100,
				settled: false,
				userId: ACTOR,
				runId: "run-stale",
			},
		});
		const scan = await h.withTransaction((tx) =>
			scanActorGenerationTargets(tx, ACTOR),
		);
		expect(scan.live).toBe(false);
		expect(scan.reapable).toEqual([
			{
				kind: "design-session",
				designSessionId: sessionId,
				identity: { mode: "build", runId: "run-stale", nonce: NONCE },
			},
		]);
	});

	it("excludes the named session and still sees live APP builds (the union)", async () => {
		const sessionId = await h.seedDesignSession({
			owner_user_id: ACTOR,
			run_id: "run-mine",
			run_holder_nonce: NONCE,
			run_actor_user_id: ACTOR,
			run_lease_expires_at: new Date(Date.now() + 60_000),
			reservation: {
				period: "2026-08",
				reserved: 100,
				settled: false,
				userId: ACTOR,
				runId: "run-mine",
			},
		});
		const excluded = await h.withTransaction((tx) =>
			scanActorGenerationTargets(tx, ACTOR, { designSessionId: sessionId }),
		);
		expect(excluded.live).toBe(false);

		await h.seedApp({
			id: "app-live-build",
			owner: ACTOR,
			status: "generating",
			run_id: "run-app",
			run_holder_nonce: NONCE,
		});
		const withApp = await h.withTransaction((tx) =>
			scanActorGenerationTargets(tx, ACTOR, { designSessionId: sessionId }),
		);
		expect(withApp.live).toBe(true);
	});

	it("a paused design-session run does not read live (paused is not busy for admission)", async () => {
		await h.seedDesignSession({
			owner_user_id: ACTOR,
			awaiting_input: true,
			run_id: "run-paused",
			run_holder_nonce: NONCE,
			run_actor_user_id: ACTOR,
			run_lease_expires_at: new Date(Date.now() + 60_000),
			reservation: {
				period: "2026-08",
				reserved: 100,
				settled: false,
				userId: ACTOR,
				runId: "run-paused",
			},
		});
		const scan = await h.withTransaction((tx) =>
			scanActorGenerationTargets(tx, ACTOR),
		);
		expect(scan.live).toBe(false);
		expect(scan.reapable).toEqual([]);
	});
});
