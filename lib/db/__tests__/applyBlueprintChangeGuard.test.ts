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
import { buildDoc, caseListConfig, f, xp } from "@/lib/__tests__/docHelpers";
import type { AppDoc } from "@/lib/db/types";
import {
	hydratePersistedBlueprint,
	toPersistableDoc,
} from "@/lib/doc/fieldParent";
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
	updateAppGuardedMutatingMock,
} = vi.hoisted(() => ({
	loadAppMock: vi.fn(),
	updateAppMock: vi.fn(),
	updateAppForRunMock: vi.fn(),
	updateAppForRunTransactionalMock: vi.fn(),
	updateAppGuardedMutatingMock: vi.fn(),
}));

const { applySchemaChangeMock, withSchemaContextMock } = vi.hoisted(() => ({
	applySchemaChangeMock: vi.fn(),
	withSchemaContextMock: vi.fn(),
}));

const { getAssetsInTransactionMock } = vi.hoisted(() => ({
	getAssetsInTransactionMock: vi.fn(),
}));

vi.mock("@/lib/db/apps", () => ({
	loadApp: loadAppMock,
	updateApp: updateAppMock,
	updateAppForRun: updateAppForRunMock,
	updateAppForRunTransactional: updateAppForRunTransactionalMock,
	updateAppGuardedMutating: updateAppGuardedMutatingMock,
}));

vi.mock("@/lib/db/mediaAssets", () => ({
	getAssetsInTransaction: getAssetsInTransactionMock,
	loadAssetsByIds: vi.fn(),
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

function freshAppDoc(blueprint: BlueprintDoc): AppDoc {
	return {
		blueprint: toPersistableDoc(blueprint),
		owner: "user-1",
		project_id: "project-1",
		status: "complete",
	} as unknown as AppDoc;
}

/** Drive the mock transaction: the body runs against `fresh`. The fake
 *  `tx` is inert — the body's only transactional read
 *  (`getAssetsInTransaction`) is itself mocked. */
function armTransactionalWith(fresh: BlueprintDoc) {
	updateAppForRunTransactionalMock.mockImplementation(
		async (
			_appId: string,
			_runId: string,
			body: (
				doc: AppDoc,
				tx: unknown,
			) => PersistableDoc | Promise<PersistableDoc>,
		) => body(freshAppDoc(fresh), {}),
	);
}

/** Drive the tokenless guarded mutating commit (auto-save): the body runs
 *  against `fresh` and the mock returns a rotated basis token. */
function armMutatingWith(fresh: BlueprintDoc) {
	updateAppGuardedMutatingMock.mockImplementation(
		async (
			_appId: string,
			body: (
				doc: AppDoc,
				tx: unknown,
			) => PersistableDoc | Promise<PersistableDoc>,
		) => {
			await body(freshAppDoc(fresh), {});
			return "token-next";
		},
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	loadAppMock.mockImplementation(async () => null);
	getAssetsInTransactionMock.mockResolvedValue(new Map());
	withSchemaContextMock.mockResolvedValue({
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
				patch: { relevant: xp("if(") },
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

	it("rejects (as a conflict) a mutation whose target a concurrent writer removed", async () => {
		const fresh = minDoc();
		armTransactionalWith(fresh);
		loadAppMock.mockResolvedValue({ blueprint: toPersistableDoc(fresh) });
		// A field uuid absent from the fresh doc — a peer deleted the field this
		// edit targets. The reducer is total, so WITHOUT the targets-present
		// guard this would silently no-op and the verdict would PASS (invisible
		// data loss); the guard turns it into a surfaced conflict instead.
		const mutations: Mutation[] = [
			{
				kind: "updateField",
				uuid: "deleted-by-a-peer",
				targetKind: "text",
				patch: { label: "New label" },
			} as Mutation,
		];

		const err = await applyBlueprintChange({
			appId: "app-1",
			userId: "user-1",
			prospective: toPersistableDoc(fresh),
			runId: "run-1",
			guard: { mutations },
		}).catch((e) => e);

		expect(err).toBeInstanceOf(BlueprintCommitRejectedError);
		// The conflict message, not a generic verdict finding.
		expect((err as Error).message).toContain("removed by someone else");
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
				patch: { relevant: xp("if(") },
			} as Mutation,
		];
		loadAppMock.mockResolvedValue({ blueprint: toPersistableDoc(prior) });

		const dropSchemaMock = vi.fn();
		withSchemaContextMock.mockResolvedValue({
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

	it("re-verifies media expectations inside the transaction and rejects a vanished asset", async () => {
		const prior = minDoc();
		armTransactionalWith(prior);
		loadAppMock.mockResolvedValue({ blueprint: toPersistableDoc(prior) });
		// The asset the tool's pre-commit verdict approved is GONE by the
		// time the transaction reads it (a delete raced the attach).
		getAssetsInTransactionMock.mockResolvedValue(new Map());

		await expect(
			applyBlueprintChange({
				appId: "app-1",
				userId: "user-1",
				prospective: toPersistableDoc(prior),
				runId: "run-1",
				guard: {
					mutations: [{ kind: "setAppLogo", logo: "asset-raced" } as Mutation],
					mediaExpectations: [
						{ assetId: "asset-raced", kind: "image", slot: "the app logo" },
					],
				},
			}),
		).rejects.toBeInstanceOf(BlueprintCommitRejectedError);

		expect(getAssetsInTransactionMock).toHaveBeenCalledWith(expect.anything(), [
			"asset-raced",
		]);
		expect(updateAppForRunMock).not.toHaveBeenCalled();
		expect(updateAppMock).not.toHaveBeenCalled();
	});

	it("commits when the transactional media re-check passes", async () => {
		const prior = minDoc();
		armTransactionalWith(prior);
		loadAppMock.mockResolvedValue({ blueprint: toPersistableDoc(prior) });
		getAssetsInTransactionMock.mockResolvedValue(
			new Map([
				[
					"asset-live",
					{ project_id: "project-1", status: "ready", kind: "image" },
				],
			]),
		);

		await applyBlueprintChange({
			appId: "app-1",
			userId: "user-1",
			prospective: toPersistableDoc(prior),
			runId: "run-1",
			guard: {
				mutations: [{ kind: "setAppLogo", logo: "asset-live" } as Mutation],
				mediaExpectations: [
					{ assetId: "asset-live", kind: "image", slot: "the app logo" },
				],
			},
		});

		const committed =
			await updateAppForRunTransactionalMock.mock.results[0]?.value;
		expect(committed.logo).toBe("asset-live");
	});
});

/** Strip the `order` keys + select-option `uuid`s off a persisted doc to
 *  simulate a LEGACY app stored before the order-key model shipped. */
function toLegacyStored(doc: BlueprintDoc): PersistableDoc {
	const p = structuredClone(toPersistableDoc(doc)) as PersistableDoc & {
		modules: Record<string, { order?: string; caseListConfig?: unknown }>;
		forms: Record<string, { order?: string }>;
		fields: Record<string, { order?: string; options?: unknown[] }>;
	};
	for (const mod of Object.values(p.modules)) {
		delete mod.order;
		const config = mod.caseListConfig as
			| {
					columns: { order?: string }[];
					searchInputs: { order?: string }[];
			  }
			| undefined;
		if (config) {
			for (const col of config.columns) delete col.order;
			for (const input of config.searchInputs) delete input.order;
		}
	}
	for (const form of Object.values(p.forms)) delete form.order;
	for (const field of Object.values(p.fields)) {
		delete field.order;
		if (Array.isArray(field.options)) {
			for (const opt of field.options as {
				order?: string;
				uuid?: string;
			}[]) {
				delete opt.order;
				delete opt.uuid;
			}
		}
	}
	return p;
}

/** Arm the transactional writer to read an already-persisted (legacy) doc. */
function armTransactionalWithPersisted(fresh: PersistableDoc) {
	updateAppForRunTransactionalMock.mockImplementation(
		async (
			_appId: string,
			_runId: string,
			body: (
				doc: AppDoc,
				tx: unknown,
			) => PersistableDoc | Promise<PersistableDoc>,
		) =>
			body(
				{
					blueprint: fresh,
					owner: "user-1",
					project_id: "project-1",
					status: "complete",
				} as unknown as AppDoc,
				{},
			),
	);
}

describe("applyBlueprintChange — legacy stored doc hydrates before the guard", () => {
	it("resolves an updateOption keyed by the client's BACKFILLED uuid (no silent no-op) and persists the keys", async () => {
		// A stored select field with no order keys + no option uuids — a
		// pre-order-key legacy app.
		const authored = buildDoc({
			modules: [
				{
					name: "M",
					forms: [
						{
							name: "F",
							type: "survey",
							fields: [
								f({
									kind: "single_select",
									id: "color",
									label: "Color",
									options: [
										{ value: "red", label: "Red" },
										{ value: "green", label: "Green" },
									],
								}),
							],
						},
					],
				},
			],
		});
		const fieldUuid = Object.values(authored.fields).find(
			(fl) => fl.id === "color",
		)?.uuid as string;
		const legacy = toLegacyStored(authored);
		armTransactionalWithPersisted(legacy);
		loadAppMock.mockResolvedValue({ blueprint: legacy });

		// The CLIENT hydrates the same legacy doc — deterministic backfill —
		// and edits "red"'s label, referencing the backfilled uuid + order.
		const clientDoc = hydratePersistedBlueprint(legacy);
		const clientField = clientDoc.fields[fieldUuid] as {
			options: { value: string; uuid?: string; order?: string }[];
		};
		const red = clientField.options.find((o) => o.value === "red");
		const mutations: Mutation[] = [
			{
				kind: "updateOption",
				fieldUuid,
				uuid: red?.uuid,
				option: { ...red, label: "Crimson" },
			} as Mutation,
		];

		await applyBlueprintChange({
			appId: "app-1",
			userId: "user-1",
			prospective: legacy,
			runId: "run-1",
			guard: { mutations },
		});

		const committed =
			await updateAppForRunTransactionalMock.mock.results[0]?.value;
		const committedOptions = (
			committed.fields[fieldUuid] as {
				options: { value: string; label: string; uuid?: string }[];
			}
		).options;
		// The edit LANDED against the server's freshly-hydrated doc (server and
		// client backfilled the same deterministic uuid) — not a silent no-op.
		expect(committedOptions.find((o) => o.value === "red")?.label).toBe(
			"Crimson",
		);
		// And the backfilled uuids persisted forward, migrating the legacy app.
		expect(committedOptions.every((o) => o.uuid !== undefined)).toBe(true);
	});

	it("resolves a moveColumn on a legacy case list and persists a fully-keyed column order", async () => {
		const authored = buildDoc({
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					caseListOnly: true,
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
						{ field: "age", header: "Age" },
					]),
				},
			],
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "case_name", label: "Name" },
						{ name: "age", label: "Age" },
					],
				},
			],
		});
		const moduleUuid = Object.values(authored.modules).find(
			(m) => m.name === "Patients",
		)?.uuid as string;
		// The auto-generated column uuids (the helper mints them).
		const authoredCols = (authored.modules[moduleUuid].caseListConfig
			?.columns ?? []) as { uuid: string; field?: string }[];
		const c1 = authoredCols.find((c) => c.field === "case_name")
			?.uuid as string;
		const c2 = authoredCols.find((c) => c.field === "age")?.uuid as string;
		const legacy = toLegacyStored(authored);
		armTransactionalWithPersisted(legacy);
		loadAppMock.mockResolvedValue({ blueprint: legacy });

		// The client hydrates, then moves "Name" (col-1) to the END — the case
		// that lands WRONG against a partially-keyed doc (a lone keyed entity
		// sorts ahead of keyless siblings).
		const clientDoc = hydratePersistedBlueprint(legacy);
		const clientCols = clientDoc.modules[moduleUuid].caseListConfig
			?.columns as { uuid: string; order?: string }[];
		const ageOrder = clientCols.find((c) => c.uuid === c2)?.order ?? null;
		const { keyBetween } = await import("@/lib/doc/order/keys");
		const mutations: Mutation[] = [
			{
				kind: "moveColumn",
				moduleUuid,
				uuid: c1,
				order: keyBetween(ageOrder, null),
			} as Mutation,
		];

		await applyBlueprintChange({
			appId: "app-1",
			userId: "user-1",
			prospective: legacy,
			runId: "run-1",
			guard: { mutations },
		});

		const committed =
			await updateAppForRunTransactionalMock.mock.results[0]?.value;
		const cols = (
			committed.modules[moduleUuid].caseListConfig as {
				columns: { uuid: string; order?: string }[];
			}
		).columns;
		// Every column carries an order key (server backfilled the keyless
		// siblings before applying the move) …
		expect(cols.every((c) => c.order !== undefined)).toBe(true);
		// … so the display sequence puts Age before the moved-to-end Name.
		const bySort = [...cols].sort((a, b) =>
			(a.order ?? "") < (b.order ?? "") ? -1 : 1,
		);
		expect(bySort[0].uuid).toBe(c2);
		expect(bySort[1].uuid).toBe(c1);
	});
});

describe("applyBlueprintChange — guarded auto-save mutation commit", () => {
	it("re-applies the delta on the FRESH doc (no runId) and returns the rotated token", async () => {
		const fresh = minDoc();
		armMutatingWith(fresh);

		const result = await applyBlueprintChange({
			appId: "app-1",
			userId: "user-1",
			priorBlueprint: toPersistableDoc(fresh),
			guard: {
				mutations: [{ kind: "setAppName", name: "Renamed" } as Mutation],
			},
		});

		expect(updateAppGuardedMutatingMock).toHaveBeenCalledTimes(1);
		expect(updateAppGuardedMutatingMock.mock.calls[0]?.[0]).toBe("app-1");
		expect(result.basisToken).toBe("token-next");
		// The blind writers + the run-scoped writer never ran — the tokenless
		// guarded writer is the auto-save commit path.
		expect(updateAppMock).not.toHaveBeenCalled();
		expect(updateAppForRunMock).not.toHaveBeenCalled();
		expect(updateAppForRunTransactionalMock).not.toHaveBeenCalled();
	});

	it("propagates a commit rejection without falling back to a blind write", async () => {
		const rejection = new Error("commit rejected");
		updateAppGuardedMutatingMock.mockRejectedValue(rejection);

		await expect(
			applyBlueprintChange({
				appId: "app-1",
				userId: "user-1",
				priorBlueprint: toPersistableDoc(minDoc()),
				guard: {
					mutations: [{ kind: "setAppName", name: "Renamed" } as Mutation],
				},
			}),
		).rejects.toBe(rejection);

		expect(updateAppMock).not.toHaveBeenCalled();
		expect(updateAppForRunMock).not.toHaveBeenCalled();
	});
});
