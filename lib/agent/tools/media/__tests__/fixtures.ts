/** Admitted domain fixtures with controlled asset-reader rows and canonical
 * workspace receipts. Actual SQL tenancy, storage and MCP transport live in
 * their native boundary suites. */
import { vi } from "vitest";
import { testMediaAssetId, testUuid } from "@/__tests__/helpers/uuid";
import { xp } from "@/lib/__tests__/docHelpers";
import {
	type BlueprintDoc,
	type Field,
	type Form,
	type Module,
	plainColumn,
} from "@/lib/domain";
import type {
	AssetKind,
	MediaAssetId,
	MediaAssetStatus,
} from "@/lib/domain/multimedia";
import { proseText } from "@/lib/domain/prose";
import { expectAdmittedDoc } from "../../../__tests__/admittedFixture";
import {
	type MakeToolWorkspaceHarnessOptions,
	makeToolWorkspaceHarness,
	type ToolWorkspaceHarness,
} from "../../../__tests__/fixtures";

// ── In-memory asset table behind the `@/lib/db/mediaAssets` mock ─────
//
// The attach tools verify the asset row before committing
// (`attachGuardedMutate` → `mediaAttachVerdict` → `loadAssetsByIds`),
// so the test files mock `@/lib/db/mediaAssets` at the import boundary
// (the db layer never constructs) and point `loadAssetsByIds` at this
// table. `resetTestAssets()` (call it in `beforeEach`) restores the
// canonical READY rows the happy-path tests attach; a test exercising a
// rejection seeds its own row via `seedTestAsset` or simply names an id
// that isn't here.

/** The row fields the attach verdict reads, plus the id. */
export interface TestAssetRow {
	id: MediaAssetId;
	project_id: string;
	status: MediaAssetStatus;
	kind: AssetKind;
	sizeBytes: number;
}

const testAssetRows = new Map<MediaAssetId, TestAssetRow>();

export const ASSET_IMG_1 = testMediaAssetId("asset-img-1");
export const ASSET_AUD_1 = testMediaAssetId("asset-aud-1");
export const ASSET_ICON = testMediaAssetId("asset-icon");
export const ASSET_AUDIO = testMediaAssetId("asset-audio");
export const ASSET_LOGO = testMediaAssetId("asset-logo");

/** The ready, in-Project rows every happy-path attach test relies on. */
const CANONICAL_ASSETS: ReadonlyArray<[MediaAssetId, AssetKind]> = [
	[ASSET_IMG_1, "image"],
	[ASSET_AUD_1, "audio"],
	[ASSET_ICON, "image"],
	[ASSET_AUDIO, "audio"],
	[ASSET_LOGO, "image"],
];

/** Seed (or overwrite) one asset row. Defaults: project "project-1" (the test
 *  app's Project), ready, 1 KiB. */
export function seedTestAsset(
	id: MediaAssetId,
	kind: AssetKind,
	overrides: Partial<Omit<TestAssetRow, "id" | "kind">> = {},
): void {
	testAssetRows.set(id, {
		id,
		kind,
		project_id: overrides.project_id ?? "project-1",
		status: overrides.status ?? "ready",
		sizeBytes: overrides.sizeBytes ?? 1024,
	});
}

/** Restore the canonical ready rows (dropping any per-test seeds). */
export function resetTestAssets(): void {
	testAssetRows.clear();
	for (const [id, kind] of CANONICAL_ASSETS) seedTestAsset(id, kind);
}
resetTestAssets();

/** Controlled reader deliberately returns requested foreign rows too, so the
 * real preflight Project check must refuse them. This does not simulate SQL. */
export const loadAssetsByIdsMock = vi.fn(
	async (
		ids: readonly MediaAssetId[],
		_projectId: string,
	): Promise<TestAssetRow[]> => {
		return [...new Set(ids)]
			.map((id) => testAssetRows.get(id))
			.filter((row): row is TestAssetRow => row !== undefined);
	},
);

/* Stable uuids the per-tool tests reference against the post-mutation
 * doc. */
export const MOD_A = testUuid("11111111-1111-1111-1111-111111111111");
export const FORM_A = testUuid("22222222-2222-2222-2222-222222222222");
export const TEXT_FIELD = testUuid("33333333-3333-3333-3333-333333333333");
export const SELECT_FIELD = testUuid("44444444-4444-4444-4444-444444444444");
export const HIDDEN_FIELD = testUuid("55555555-5555-5555-5555-555555555555");
export const FEVER_OPTION = testUuid("66666666-6666-4666-8666-666666666666");
export const COUGH_OPTION = testUuid("77777777-7777-4777-8777-777777777777");
const RESULTS_COLUMN = testUuid("media-fixture-results-column");

/**
 * Minimal field-bearing `BlueprintDoc`: a `patient` module + a
 * registration form holding a text field, a single_select field with two
 * options, and a hidden field. The hidden field exists so the
 * slot-availability guard has a negative case (hidden carries identity
 * only — no hint/help/validate_msg media).
 */
export function makeMediaDoc(): BlueprintDoc {
	const mod: Module = {
		uuid: MOD_A,
		id: "patient",
		name: "Patient",
		caseType: "patient",
		caseListConfig: {
			columns: [plainColumn(RESULTS_COLUMN, "case_name", "Patient")],
			listColumnOrder: [RESULTS_COLUMN],
			detailColumnOrder: [RESULTS_COLUMN],
			searchInputs: [],
		},
	};
	const form: Form = {
		uuid: FORM_A,
		id: "enroll",
		name: "Enroll Patient",
		type: "registration",
	};
	const textField: Field = {
		uuid: TEXT_FIELD,
		id: "patient_name",
		kind: "text",
		label: proseText("Patient name"),
		caseWrite: { caseType: "patient", property: "case_name" },
	};
	const selectField: Field = {
		uuid: SELECT_FIELD,
		id: "symptom",
		kind: "single_select",
		label: proseText("Primary symptom"),
		optionsSource: {
			kind: "inline",
			options: [
				{
					uuid: FEVER_OPTION,
					value: "fever",
					label: proseText("Fever"),
				},
				{
					uuid: COUGH_OPTION,
					value: "cough",
					label: proseText("Cough"),
				},
			],
		},
	};
	const hiddenField: Field = {
		uuid: HIDDEN_FIELD,
		id: "computed_score",
		kind: "hidden",
		calculate: xp("0"),
	};
	const doc: BlueprintDoc = {
		appId: "test-app",
		appName: "Clinic Intake",
		connectType: null,
		caseTypes: [
			{
				name: "patient",
				properties: [],
			},
		],
		modules: { [MOD_A]: mod },
		forms: { [FORM_A]: form },
		fields: {
			[TEXT_FIELD]: textField,
			[SELECT_FIELD]: selectField,
			[HIDDEN_FIELD]: hiddenField,
		},
		moduleOrder: [MOD_A],
		formOrder: { [MOD_A]: [FORM_A] },
		fieldOrder: { [FORM_A]: [TEXT_FIELD, SELECT_FIELD, HIDDEN_FIELD] },
		fieldParent: {
			[TEXT_FIELD]: FORM_A,
			[SELECT_FIELD]: FORM_A,
			[HIDDEN_FIELD]: FORM_A,
		},
	};
	return expectAdmittedDoc(doc);
}

/** Bundle of doc + a canonical workspace over the lightweight chat-surface
 *  stub host (its `recordMutations` echoes the prepared candidate's post-mutation
 *  doc as the committed doc). */
export interface MediaFixture extends ToolWorkspaceHarness {
	doc: BlueprintDoc;
}

/** Build a `{ doc, runTool, ... }` bundle for the chat surface. `doc` seeds the
 *  workspace, so a test needing a pre-referencing document passes its own. */
export function makeMediaFixture({
	doc = makeMediaDoc(),
	...opts
}: MakeToolWorkspaceHarnessOptions & {
	doc?: BlueprintDoc;
} = {}): MediaFixture {
	return {
		...makeToolWorkspaceHarness(expectAdmittedDoc(doc), {
			projectId: "project-1",
			...opts,
		}),
		doc,
	};
}

/** Narrow a mutating-tool result to its error string, failing the test on
 *  success — the shared assertion helper of the batch media tool tests. */
export function errorOf(result: { result: unknown }): string {
	const r = result.result as { error?: string };
	if (r.error === undefined) throw new Error("expected error result");
	return r.error;
}
