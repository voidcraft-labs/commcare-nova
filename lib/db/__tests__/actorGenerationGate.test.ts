import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { actorGenerationGateKey } from "../actorGenerationGate";

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
