/**
 * The guarded (transactional) commit path of `applyBlueprintChange` —
 * the MCP surface's race protection. What must hold:
 *
 *   1. The committed doc is recomputed FROM THE FRESH stored blueprint
 *      (the transaction's read), not the caller's stale prospective —
 *      a concurrent committed batch survives the write.
 *   2. A batch the fresh doc's verdict rejects throws
 *      `BlueprintCommitRejectedError` and writes nothing.
 *   3. A rejection after the Postgres phase compensates the case-store
 *      work (the saga's existing contract, now reachable from the
 *      guard).
 *
 * `updateAppForRunTransactional` is mocked to run the body against a
 * controllable "fresh" doc — the real Firestore transaction machinery is
 * a thin read/body/update wrapper; what this file pins is the
 * read-evaluate-write composition, with the REAL reducers + verdict
 * running inside the body.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import type { AppDoc } from "@/lib/db/types";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import type { Mutation } from "@/lib/doc/types";
import type { BlueprintDoc, PersistableDoc } from "@/lib/domain";
import {
	applyBlueprintChange,
	BlueprintCommitRejectedError,
} from "../applyBlueprintChange";

const {
	loadAppMock,
	updateAppMock,
	updateAppForRunMock,
	updateAppForRunTransactionalMock,
	updateAppGuardedByBasisMock,
} = vi.hoisted(() => ({
	loadAppMock: vi.fn(),
	updateAppMock: vi.fn(),
	updateAppForRunMock: vi.fn(),
	updateAppForRunTransactionalMock: vi.fn(),
	updateAppGuardedByBasisMock: vi.fn(),
}));

const { applySchemaChangeMock, withOwnerContextMock } = vi.hoisted(() => ({
	applySchemaChangeMock: vi.fn(),
	withOwnerContextMock: vi.fn(),
}));

vi.mock("@/lib/db/apps", () => ({
	loadApp: loadAppMock,
	updateApp: updateAppMock,
	updateAppForRun: updateAppForRunMock,
	updateAppForRunTransactional: updateAppForRunTransactionalMock,
	updateAppGuardedByBasis: updateAppGuardedByBasisMock,
	BlueprintBasisStaleError: class BlueprintBasisStaleError extends Error {},
}));

vi.mock("@/lib/case-store", async () => {
	const actual = (await vi.importActual("@/lib/case-store")) as Record<
		string,
		unknown
	>;
	return {
		...actual,
		withOwnerContext: withOwnerContextMock,
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

function freshAppDoc(blueprint: BlueprintDoc): AppDoc {
	return {
		blueprint: toPersistableDoc(blueprint),
		owner: "user-1",
		status: "complete",
	} as unknown as AppDoc;
}

/** Drive the mock transaction: the body runs against `fresh`. */
function armTransactionalWith(fresh: BlueprintDoc) {
	updateAppForRunTransactionalMock.mockImplementation(
		async (
			_appId: string,
			_runId: string,
			body: (doc: AppDoc) => PersistableDoc,
		) => body(freshAppDoc(fresh)),
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	loadAppMock.mockImplementation(async () => null);
	withOwnerContextMock.mockResolvedValue({
		applySchemaChange: applySchemaChangeMock,
		dropSchema: vi.fn(),
	});
});

describe("applyBlueprintChange — guarded transactional commit", () => {
	it("recomputes the committed doc from the FRESH blueprint, preserving a concurrent commit", async () => {
		const stalePrior = minDoc("Original");
		// A concurrent writer renamed the app AFTER the tool loaded its
		// snapshot — the fresh stored doc carries "Renamed Concurrently"
		// (same entities/uuids; only the concurrent edit differs).
		const fresh: BlueprintDoc = {
			...structuredClone(stalePrior),
			appName: "Renamed Concurrently",
		};
		armTransactionalWith(fresh);

		const target = Object.values(stalePrior.fields).find(
			(fl) => fl.id === "village",
		);
		const mutations: Mutation[] = [
			{
				kind: "updateField",
				uuid: target?.uuid,
				targetKind: "text",
				patch: { label: "Home village" },
			} as Mutation,
		];
		// The tool's own (stale) candidate — built before the concurrent
		// rename landed.
		const staleProspective = toPersistableDoc(stalePrior);

		loadAppMock.mockResolvedValue({ blueprint: staleProspective });

		await applyBlueprintChange({
			appId: "app-1",
			userId: "user-1",
			prospective: staleProspective,
			runId: "run-1",
			guard: { mutations },
		});

		expect(updateAppForRunTransactionalMock).toHaveBeenCalledTimes(1);
		const committed =
			await updateAppForRunTransactionalMock.mock.results[0]?.value;
		// The concurrent rename SURVIVES (committed builds on fresh)…
		expect(committed.appName).toBe("Renamed Concurrently");
		// …and this batch's own edit landed on top of it.
		const village = Object.values(
			committed.fields as BlueprintDoc["fields"],
		).find((fl) => fl.id === "village");
		expect(village && "label" in village && village.label).toBe("Home village");
		// The blind writers never ran.
		expect(updateAppForRunMock).not.toHaveBeenCalled();
		expect(updateAppMock).not.toHaveBeenCalled();
	});

	it("throws BlueprintCommitRejectedError when the fresh doc's verdict rejects, writing nothing", async () => {
		const prior = minDoc();
		armTransactionalWith(prior);
		const target = Object.values(prior.fields).find(
			(fl) => fl.id === "village",
		);
		const mutations: Mutation[] = [
			{
				kind: "updateField",
				uuid: target?.uuid,
				targetKind: "text",
				// Unparseable XPath — soundness, rejected in every phase.
				patch: { relevant: "if(" },
			} as Mutation,
		];
		loadAppMock.mockResolvedValue({ blueprint: toPersistableDoc(prior) });

		await expect(
			applyBlueprintChange({
				appId: "app-1",
				userId: "user-1",
				prospective: toPersistableDoc(prior),
				runId: "run-1",
				guard: { mutations },
			}),
		).rejects.toBeInstanceOf(BlueprintCommitRejectedError);

		expect(updateAppForRunMock).not.toHaveBeenCalled();
		expect(updateAppMock).not.toHaveBeenCalled();
	});

	it("compensates the Postgres phase when the guarded commit rejects after schema work", async () => {
		const prior = minDoc();
		armTransactionalWith(prior);

		// The prospective adds a NEW case type (schema-affecting → the saga
		// runs the Postgres phase) AND the mutation batch is one the fresh
		// verdict rejects, so the commit aborts after applySchemaChange ran.
		const prospective = structuredClone(toPersistableDoc(prior));
		prospective.caseTypes = [
			...(prospective.caseTypes ?? []),
			{ name: "household", properties: [{ name: "case_name", label: "N" }] },
		];
		const target = Object.values(prior.fields).find(
			(fl) => fl.id === "village",
		);
		const mutations: Mutation[] = [
			{
				kind: "updateField",
				uuid: target?.uuid,
				targetKind: "text",
				patch: { relevant: "if(" },
			} as Mutation,
		];
		loadAppMock.mockResolvedValue({ blueprint: toPersistableDoc(prior) });

		const dropSchemaMock = vi.fn();
		withOwnerContextMock.mockResolvedValue({
			applySchemaChange: applySchemaChangeMock,
			dropSchema: dropSchemaMock,
		});

		await expect(
			applyBlueprintChange({
				appId: "app-1",
				userId: "user-1",
				prospective,
				runId: "run-1",
				guard: { mutations },
			}),
		).rejects.toBeInstanceOf(BlueprintCommitRejectedError);

		// Phase 1 ran for the added case type, and the rejection compensated
		// it (added-in-prospective → dropSchema is the inverse).
		expect(applySchemaChangeMock).toHaveBeenCalled();
		expect(dropSchemaMock).toHaveBeenCalledWith({
			appId: "app-1",
			caseType: "household",
		});
	});
});

describe("applyBlueprintChange — basis-guarded auto-save commit", () => {
	it("routes a basis-bearing save through the basis writer and returns the rotated token", async () => {
		const prior = minDoc();
		updateAppGuardedByBasisMock.mockResolvedValue("token-next");

		const result = await applyBlueprintChange({
			appId: "app-1",
			userId: "user-1",
			prospective: toPersistableDoc(prior),
			priorBlueprint: toPersistableDoc(prior),
			basis: { token: "token-prev" },
		});

		expect(updateAppGuardedByBasisMock).toHaveBeenCalledTimes(1);
		const [appId, , basisToken] = updateAppGuardedByBasisMock.mock.calls[0];
		expect(appId).toBe("app-1");
		expect(basisToken).toBe("token-prev");
		expect(result.basisToken).toBe("token-next");
		// The blind writers never ran — the basis compare is the commit path.
		expect(updateAppMock).not.toHaveBeenCalled();
		expect(updateAppForRunMock).not.toHaveBeenCalled();
	});

	it("propagates a stale-basis rejection without falling back to a blind write", async () => {
		const prior = minDoc();
		const stale = new Error("stale basis");
		updateAppGuardedByBasisMock.mockRejectedValue(stale);

		await expect(
			applyBlueprintChange({
				appId: "app-1",
				userId: "user-1",
				prospective: toPersistableDoc(prior),
				priorBlueprint: toPersistableDoc(prior),
				basis: { token: null },
			}),
		).rejects.toBe(stale);

		expect(updateAppMock).not.toHaveBeenCalled();
		expect(updateAppForRunMock).not.toHaveBeenCalled();
	});
});
