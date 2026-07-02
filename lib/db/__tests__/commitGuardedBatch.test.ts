/**
 * commitGuardedBatch — the seq-recompute-on-RETRY guarantee, deterministically.
 *
 * The durable-stream ordering property (P3) is: `mutation_seq` is a LITERAL
 * `(fresh.mutation_seq ?? 0) + 1` READ INSIDE the transaction closure, so a
 * Firestore abort-and-retry (the SDK re-invokes the whole closure) re-reads the
 * now-advanced `mutation_seq` and recomputes — never reuses a stale value captured
 * OUTSIDE the closure. A regression that cached the seq outside the closure would
 * leave a GAP or a DUPLICATE on retry (the exact hazard the guarantee guards).
 *
 * The emulator can't test this: its `ReactiveLockManager` LIVELOCKS even 2-way
 * single-doc contention (see `commitGuardedBatch.integration.test.ts` + the
 * `credits.integration.test.ts` docblock), so it never produces the clean
 * abort-and-retry. This drives the REAL closure with a fake `runTransaction` that
 * INVOKES IT TWICE — the second invocation reads an ADVANCED `mutation_seq`,
 * exactly as the SDK's retry would — and asserts the recompute. Deterministic,
 * no emulator, no livelock. The reservation path's abort-retry is covered the same
 * way in `credits.test.ts`.
 */

import { FieldValue, Timestamp } from "@google-cloud/firestore";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import type { Mutation } from "@/lib/doc/types";
import type { BlueprintDoc } from "@/lib/domain";

const APP_ID = "app-1";
const OWNER = "user-owner";

/* A minimal valid registration doc — the REAL commit verdict runs against it, so
 * it must be a legal blueprint (two case properties on a `patient` type). */
function minDoc(): BlueprintDoc {
	return buildDoc({
		appName: "Test",
		modules: [
			{
				name: "Mod",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						name: "Form",
						type: "registration",
						fields: [
							f({
								kind: "text",
								id: "case_name",
								label: "Name",
								case_property_on: "patient",
							}),
							f({
								kind: "text",
								id: "village",
								label: "Village",
								case_property_on: "patient",
							}),
						],
					},
				],
			},
		],
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "case_name", label: "Name" },
					{ name: "village", label: "Village" },
				],
			},
		],
	});
}

function villageUuid(doc: BlueprintDoc): string {
	const uuid = Object.values(doc.fields).find(
		(fld) => fld.id === "village",
	)?.uuid;
	if (!uuid) throw new Error("village field missing");
	return uuid;
}

function renameVillageLabel(doc: BlueprintDoc, label: string): Mutation[] {
	return [
		{
			kind: "updateField",
			uuid: villageUuid(doc),
			targetKind: "text",
			patch: { label },
		} as Mutation,
	];
}

/* The fake app-doc state the closure reads. `mutation_seq` is mutated BETWEEN the
 * two closure invocations to model a competing commit landing during the retry. */
type AppState = {
	owner: string;
	project_id: string | null;
	mutation_seq: number;
	blueprint: unknown;
};

/* One opaque ref per collection/doc the closure touches. `.get()` resolves off the
 * shared `state`; the writers are spied. `runTransaction` invokes the closure the
 * scripted number of times (an abort-retry simulation), each a FRESH read. */
const { getDbMock, appUpdateSpy, state, invokeCount } = vi.hoisted(() => {
	const state: {
		app: AppState | null;
		dedupExists: boolean;
		invocations: number;
	} = { app: null, dedupExists: false, invocations: 0 };
	const invokeCount = { runs: 1 };
	const appUpdateSpy = vi.fn();
	const snapshotOf = (data: unknown) => ({
		exists: data != null,
		data: () => data,
	});
	const makeTx = () => ({
		get: async (ref: { kind: string }) => {
			if (ref.kind === "dedup")
				return snapshotOf(state.dedupExists ? {} : null);
			return snapshotOf(state.app);
		},
		update: (ref: { kind: string }, data: Record<string, unknown>) => {
			if (ref.kind === "app") appUpdateSpy(data);
		},
		set: () => {},
		delete: () => {},
	});
	const getDbMock = () => ({
		runTransaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
			let last: T | undefined;
			for (let i = 0; i < invokeCount.runs; i++) {
				state.invocations += 1;
				last = await fn(makeTx());
			}
			return last as T;
		},
	});
	return { getDbMock, appUpdateSpy, state, invokeCount };
});

vi.mock("../firestore", () => ({
	getDb: getDbMock,
	docs: {
		batchDedupRaw: () => ({ kind: "dedup" }),
		app: () => ({ kind: "app" }),
		appRaw: () => ({ kind: "app" }),
		acceptedMutation: () => ({ kind: "accepted" }),
		batchDedup: () => ({ kind: "batchDedup" }),
	},
	collections: {},
	FieldValue,
	Timestamp,
}));

const { commitGuardedBatch } = await import("../apps");

describe("commitGuardedBatch — seq recompute on transaction retry", () => {
	beforeEach(() => {
		appUpdateSpy.mockClear();
		state.invocations = 0;
		invokeCount.runs = 1;
	});

	it("re-reads the ADVANCED mutation_seq on a retry — recomputes (fresh + 1), never a stale cached seq", async () => {
		const doc = minDoc();
		state.app = {
			owner: OWNER,
			project_id: null, // owner path — reauth passes on owner === actor
			mutation_seq: 0,
			blueprint: toPersistableDoc(doc),
		};
		state.dedupExists = false;

		// The abort-retry simulation: the closure is invoked TWICE. Between the two
		// invocations a competing commit lands, advancing the doc's mutation_seq
		// 0 → 5. The SDK's real retry re-reads the doc, so the fake advances the state
		// after the FIRST invocation (which itself computes off 0).
		invokeCount.runs = 2;
		const firstUpdate: { seq?: number } = {};
		appUpdateSpy.mockImplementation((data: { mutation_seq: number }) => {
			if (firstUpdate.seq === undefined) {
				firstUpdate.seq = data.mutation_seq;
				// A competing commit advanced the doc while we were "aborting".
				if (state.app) state.app.mutation_seq = 5;
			}
		});

		await commitGuardedBatch({
			appId: APP_ID,
			batchId: crypto.randomUUID(),
			mutations: renameVillageLabel(doc, "Home"),
			actorUserId: OWNER,
			kind: "autosave",
			preauthorized: { projectId: null }, // skip loadAppProjectId (no query fake)
		});

		// The closure ran twice (abort-retry), and each computed the seq off the
		// value it RE-READ inside the closure:
		expect(state.invocations).toBe(2);
		// First invocation read mutation_seq 0 → wrote 1.
		expect(firstUpdate.seq).toBe(1);
		// The retry re-read the ADVANCED 5 → recomputed 6 (NOT the stale 1). A
		// regression caching the seq outside the closure would write 1 again here.
		const lastUpdate = appUpdateSpy.mock.calls.at(-1)?.[0] as {
			mutation_seq: number;
		};
		expect(lastUpdate.mutation_seq).toBe(6);
	});

	it("computes the literal (fresh + 1) off whatever mutation_seq the doc carries (no cached zero)", async () => {
		const doc = minDoc();
		state.app = {
			owner: OWNER,
			project_id: null,
			mutation_seq: 41, // a doc already advanced by 41 prior commits
			blueprint: toPersistableDoc(doc),
		};
		state.dedupExists = false;

		await commitGuardedBatch({
			appId: APP_ID,
			batchId: crypto.randomUUID(),
			mutations: renameVillageLabel(doc, "Home"),
			actorUserId: OWNER,
			kind: "autosave",
			preauthorized: { projectId: null },
		});

		const update = appUpdateSpy.mock.calls.at(-1)?.[0] as {
			mutation_seq: number;
		};
		expect(update.mutation_seq).toBe(42);
	});
});
