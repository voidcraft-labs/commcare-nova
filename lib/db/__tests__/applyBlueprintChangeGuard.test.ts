/**
 * The guarded commit path of `applyBlueprintChange` — the cross-store saga's
 * wiring around the ONE Firestore chokepoint, `commitGuardedBatch` (in
 * `apps.ts`). This file mocks `commitGuardedBatch` + `loadApp` and pins the
 * saga's composition:
 *
 *   1. Every persist threads the unified writer's args verbatim — `batchId`,
 *      `kind`, `runId` (when present), `actorUserId` (the caller's `userId`),
 *      the guard's `mutations`, and any `mediaExpectations`.
 *   2. The result surfaces `seq` + the writer's hydrated `committedDoc`.
 *   3. A top-level `batchId` dedup hit (the latch already exists) short-circuits
 *      the WHOLE saga — no Postgres, no `loadApp`, no commit — returning the
 *      recorded `{ seq, basisToken }` with no `committedDoc`.
 *   4. A rejection from the writer (`BlueprintCommitRejectedError` /
 *      `CommitReauthError`) propagates and, after the Postgres phase ran,
 *      compensates the case-store work.
 *
 * The deep read-evaluate-write behavior the writer itself owns (re-apply on the
 * FRESH stored doc, the concurrent-delete guard, the fresh-doc re-verdict, the
 * per-commit reauth, the legacy-doc hydration) is exercised against the REAL
 * Firestore transaction in `commitGuardedBatch.integration.test.ts`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import type { Mutation } from "@/lib/doc/types";
import type { BlueprintDoc } from "@/lib/domain";
import { applyBlueprintChange } from "../applyBlueprintChange";
import {
	BlueprintCommitRejectedError,
	CommitReauthError,
} from "../commitGuard";

const { loadAppMock, commitGuardedBatchMock } = vi.hoisted(() => ({
	loadAppMock: vi.fn(),
	commitGuardedBatchMock: vi.fn(),
}));

const { applySchemaChangeMock, dropSchemaMock, withSchemaContextMock } =
	vi.hoisted(() => ({
		applySchemaChangeMock: vi.fn(),
		dropSchemaMock: vi.fn(),
		withSchemaContextMock: vi.fn(),
	}));

const { batchDedupRawGetMock } = vi.hoisted(() => ({
	batchDedupRawGetMock: vi.fn(),
}));

vi.mock("@/lib/db/apps", () => ({
	loadApp: loadAppMock,
	commitGuardedBatch: commitGuardedBatchMock,
}));

// The top-level dedup read is `docs.batchDedupRaw(appId, batchId).get()`. Stub
// the firestore doc-ref factory so the non-transactional read is controllable
// without a live Firestore.
vi.mock("@/lib/db/firestore", () => ({
	docs: {
		batchDedupRaw: () => ({ get: batchDedupRawGetMock }),
	},
}));

vi.mock("@/lib/case-store", async () => {
	const actual = (await vi.importActual("@/lib/case-store")) as Record<
		string,
		unknown
	>;
	return {
		...actual,
		withSchemaContext: withSchemaContextMock,
	};
});

/** Valid one-module registration doc writing two case properties. */
function minDoc(appName = "Test"): BlueprintDoc {
	return buildDoc({
		appName,
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

beforeEach(() => {
	vi.clearAllMocks();
	loadAppMock.mockImplementation(async () => null);
	// Default: no prior dedup latch — the saga proceeds to the guarded commit.
	batchDedupRawGetMock.mockResolvedValue({ exists: false });
	withSchemaContextMock.mockResolvedValue({
		applySchemaChange: applySchemaChangeMock,
		dropSchema: dropSchemaMock,
	});
});

describe("applyBlueprintChange — routes the guard through commitGuardedBatch", () => {
	it("threads batchId + kind + runId + actorUserId + mutations to the writer and returns its seq + committedDoc", async () => {
		const fresh = minDoc();
		const committed: BlueprintDoc = { ...fresh, appName: "Renamed" };
		commitGuardedBatchMock.mockResolvedValue({
			seq: 7,
			basisToken: "token-next",
			committedDoc: committed,
			deduped: false,
		});
		loadAppMock.mockResolvedValue({ blueprint: toPersistableDoc(fresh) });

		const mutations: Mutation[] = [{ kind: "setAppName", name: "Renamed" }];
		const result = await applyBlueprintChange({
			appId: "app-1",
			userId: "user-1",
			prospective: toPersistableDoc(fresh),
			runId: "run-1",
			batchId: "batch-uuid-1",
			kind: "mcp",
			guard: { mutations },
		});

		expect(commitGuardedBatchMock).toHaveBeenCalledTimes(1);
		const args = commitGuardedBatchMock.mock.calls[0]?.[0];
		expect(args).toMatchObject({
			appId: "app-1",
			batchId: "batch-uuid-1",
			runId: "run-1",
			actorUserId: "user-1",
			kind: "mcp",
			mutations,
		});
		// The saga surfaces the writer's committed seq + hydrated doc.
		expect(result.seq).toBe(7);
		expect(result.basisToken).toBe("token-next");
		expect(result.committedDoc).toBe(committed);
	});

	it("passes mediaExpectations through to the writer for a media-attaching batch", async () => {
		const fresh = minDoc();
		commitGuardedBatchMock.mockResolvedValue({
			seq: 1,
			basisToken: "t",
			committedDoc: fresh,
			deduped: false,
		});
		loadAppMock.mockResolvedValue({ blueprint: toPersistableDoc(fresh) });

		await applyBlueprintChange({
			appId: "app-1",
			userId: "user-1",
			prospective: toPersistableDoc(fresh),
			batchId: "batch-uuid-media",
			kind: "autosave",
			guard: {
				mutations: [{ kind: "setAppLogo", logo: "asset-live" } as Mutation],
				mediaExpectations: [
					{ assetId: "asset-live", kind: "image", slot: "the app logo" },
				],
			},
		});

		const args = commitGuardedBatchMock.mock.calls[0]?.[0];
		expect(args?.mediaExpectations).toEqual([
			{ assetId: "asset-live", kind: "image", slot: "the app logo" },
		]);
		// An autosave omits runId entirely (not `undefined`).
		expect("runId" in (args ?? {})).toBe(false);
	});

	it("propagates a BlueprintCommitRejectedError from the writer (nothing swallowed)", async () => {
		const fresh = minDoc();
		loadAppMock.mockResolvedValue({ blueprint: toPersistableDoc(fresh) });
		commitGuardedBatchMock.mockRejectedValue(
			new BlueprintCommitRejectedError("removed by someone else"),
		);

		await expect(
			applyBlueprintChange({
				appId: "app-1",
				userId: "user-1",
				priorBlueprint: toPersistableDoc(fresh),
				batchId: "batch-uuid-2",
				kind: "autosave",
				guard: {
					mutations: [{ kind: "setAppName", name: "Renamed" } as Mutation],
				},
			}),
		).rejects.toBeInstanceOf(BlueprintCommitRejectedError);
	});

	it("propagates a terminal CommitReauthError from the writer", async () => {
		const fresh = minDoc();
		loadAppMock.mockResolvedValue({ blueprint: toPersistableDoc(fresh) });
		commitGuardedBatchMock.mockRejectedValue(
			new CommitReauthError("You no longer have edit access."),
		);

		await expect(
			applyBlueprintChange({
				appId: "app-1",
				userId: "user-1",
				priorBlueprint: toPersistableDoc(fresh),
				batchId: "batch-uuid-3",
				kind: "autosave",
				guard: {
					mutations: [{ kind: "setAppName", name: "Renamed" } as Mutation],
				},
			}),
		).rejects.toBeInstanceOf(CommitReauthError);
	});
});

describe("applyBlueprintChange — top-level batchId dedup", () => {
	it("short-circuits the whole saga on a pre-existing latch, doing zero commit / loadApp / Postgres work", async () => {
		batchDedupRawGetMock.mockResolvedValue({
			exists: true,
			data: () => ({ seq: 42, basisToken: "prior-token" }),
		});

		const result = await applyBlueprintChange({
			appId: "app-1",
			userId: "user-1",
			prospective: toPersistableDoc(minDoc()),
			batchId: "already-committed",
			kind: "mcp",
			guard: {
				mutations: [{ kind: "setAppName", name: "Renamed" } as Mutation],
			},
		});

		// The recorded seq/basis come straight off the latch — no committedDoc.
		expect(result).toEqual({ seq: 42, basisToken: "prior-token" });
		expect(result.committedDoc).toBeUndefined();
		// Nothing downstream ran.
		expect(commitGuardedBatchMock).not.toHaveBeenCalled();
		expect(loadAppMock).not.toHaveBeenCalled();
		expect(withSchemaContextMock).not.toHaveBeenCalled();
	});
});

describe("applyBlueprintChange — Postgres saga around the guarded commit", () => {
	it("compensates the case-store phase when the guarded commit rejects after schema work", async () => {
		const prior = minDoc();
		// The prospective adds a NEW case type (schema-affecting → the Postgres
		// phase runs) and the writer then rejects, so the saga must compensate
		// the added case type (added-in-prospective → dropSchema is the inverse).
		const prospective = structuredClone(toPersistableDoc(prior));
		prospective.caseTypes = [
			...(prospective.caseTypes ?? []),
			{ name: "household", properties: [{ name: "case_name", label: "N" }] },
		];
		loadAppMock.mockResolvedValue({ blueprint: toPersistableDoc(prior) });
		commitGuardedBatchMock.mockRejectedValue(
			new BlueprintCommitRejectedError("rejected against the fresh doc"),
		);

		await expect(
			applyBlueprintChange({
				appId: "app-1",
				userId: "user-1",
				prospective,
				runId: "run-1",
				batchId: "batch-uuid-4",
				kind: "mcp",
				guard: {
					mutations: [{ kind: "setAppName", name: "x" } as Mutation],
				},
			}),
		).rejects.toBeInstanceOf(BlueprintCommitRejectedError);

		// Phase 1 ran for the added case type, and the rejection compensated it.
		expect(applySchemaChangeMock).toHaveBeenCalled();
		expect(dropSchemaMock).toHaveBeenCalledWith({
			appId: "app-1",
			caseType: "household",
		});
	});

	it("skips Postgres entirely for a non-case-type batch (fast path)", async () => {
		const fresh = minDoc();
		commitGuardedBatchMock.mockResolvedValue({
			seq: 2,
			basisToken: "t",
			committedDoc: fresh,
			deduped: false,
		});
		loadAppMock.mockResolvedValue({ blueprint: toPersistableDoc(fresh) });

		await applyBlueprintChange({
			appId: "app-1",
			userId: "user-1",
			prospective: toPersistableDoc(fresh),
			batchId: "batch-uuid-5",
			kind: "autosave",
			guard: {
				mutations: [{ kind: "setAppName", name: "Renamed" } as Mutation],
			},
		});

		expect(commitGuardedBatchMock).toHaveBeenCalledTimes(1);
		expect(withSchemaContextMock).not.toHaveBeenCalled();
	});
});
