/**
 * Shared test fixtures for the dedicated media SA tools.
 *
 * The doc carries enough surface to exercise every media carrier the
 * tools target: one case-carrying module, one form, a `text` field (which
 * carries label / hint / help / validate_msg media slots), a
 * `single_select` field (which carries options), and a `hidden` field
 * (which carries NO message-media slot beyond identity — the negative
 * case for the slot-availability guard). `makeMediaFixture` bundles the
 * doc with the chat-side `GenerationContext` shim; `makeMediaMcpFixture`
 * is the MCP-surface sibling for cross-surface parity.
 */

import { xp } from "@/lib/__tests__/docHelpers";
import {
	backfillOptionUuids,
	backfillOrderKeys,
} from "@/lib/doc/order/backfill";
import {
	asUuid,
	type BlueprintDoc,
	type Field,
	type Form,
	type Module,
} from "@/lib/domain";
import type { AssetKind, MediaAssetStatus } from "@/lib/domain/multimedia";
import {
	type MakeMcpTestContextHandles,
	makeMcpTestContext,
	makeStubToolContext,
	type StubToolContextHandles,
} from "../../../__tests__/fixtures";

// ── In-memory asset table behind the `@/lib/db/mediaAssets` mock ─────
//
// The attach tools verify the asset row before committing
// (`attachGuardedMutate` → `mediaAttachVerdict` → `loadAssetsByIds`),
// so the test files mock `@/lib/db/mediaAssets` at the import boundary
// (Firestore never constructs) and point `loadAssetsByIds` at this
// table. `resetTestAssets()` (call it in `beforeEach`) restores the
// canonical READY rows the happy-path tests attach; a test exercising a
// rejection seeds its own row via `seedTestAsset` or simply names an id
// that isn't here.

/** The row fields the attach verdict reads, plus the id. */
export interface TestAssetRow {
	id: string;
	project_id: string;
	status: MediaAssetStatus;
	kind: AssetKind;
	sizeBytes: number;
}

const testAssetRows = new Map<string, TestAssetRow>();

/** The ready, in-Project rows every happy-path attach test relies on. */
const CANONICAL_ASSETS: ReadonlyArray<[string, AssetKind]> = [
	["asset-img-1", "image"],
	["asset-aud-1", "audio"],
	["asset-icon", "image"],
	["asset-audio", "audio"],
	["asset-logo", "image"],
];

/** Seed (or overwrite) one asset row. Defaults: project "project-1" (the test
 *  app's Project), ready, 1 KiB. */
export function seedTestAsset(
	id: string,
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

/** Mock implementation of `loadAssetsByIds` — Project-filtered like the
 *  real one (a foreign-Project row reads as missing). */
export async function loadAssetsByIdsMock(
	ids: readonly string[],
	projectId: string,
): Promise<TestAssetRow[]> {
	return [...new Set(ids)]
		.map((id) => testAssetRows.get(id))
		.filter((row): row is TestAssetRow => row !== undefined)
		.filter((row) => row.project_id === projectId);
}

/* Stable uuids the per-tool tests reference against the post-mutation
 * doc. */
export const MOD_A = asUuid("11111111-1111-1111-1111-111111111111");
export const FORM_A = asUuid("22222222-2222-2222-2222-222222222222");
export const TEXT_FIELD = asUuid("33333333-3333-3333-3333-333333333333");
export const SELECT_FIELD = asUuid("44444444-4444-4444-4444-444444444444");
export const HIDDEN_FIELD = asUuid("55555555-5555-5555-5555-555555555555");

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
		label: "Patient name",
		case_property_on: "case_name",
	} as Field;
	const selectField: Field = {
		uuid: SELECT_FIELD,
		id: "symptom",
		kind: "single_select",
		label: "Primary symptom",
		options: [
			{ value: "fever", label: "Fever" },
			{ value: "cough", label: "Cough" },
		],
	} as Field;
	const hiddenField: Field = {
		uuid: HIDDEN_FIELD,
		id: "computed_score",
		kind: "hidden",
		calculate: xp("0"),
	} as Field;
	const doc: BlueprintDoc = {
		appId: "test-app",
		appName: "Clinic Intake",
		connectType: null,
		caseTypes: [
			{
				name: "patient",
				properties: [{ name: "case_name", label: "Full name" }],
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
	// Mirror the production hydration boundary (`loadAppBlueprint`): backfill
	// order keys + option uuids so a granular `updateOption` can key the option
	// by uuid (a hand-built fixture lacks them otherwise).
	backfillOrderKeys(doc);
	backfillOptionUuids(doc);
	return doc;
}

/** Bundle of doc + a lightweight chat-surface `ToolExecutionContext` stub
 *  (its `recordMutations` echoes the passed post-mutation doc as the committed
 *  doc; the media-expectations arg still rides through for assertion). */
export interface MediaFixture extends StubToolContextHandles {
	doc: BlueprintDoc;
}

/** Bundle of doc + MCP `McpContext`. */
export interface MediaMcpFixture extends MakeMcpTestContextHandles {
	doc: BlueprintDoc;
}

/** Build a `{ doc, ctx, ... }` bundle for the chat surface. */
export function makeMediaFixture(): MediaFixture {
	return { ...makeStubToolContext(), doc: makeMediaDoc() };
}

/** Build a `{ doc, ctx, ... }` bundle for the MCP surface. */
export function makeMediaMcpFixture(): MediaMcpFixture {
	return { ...makeMcpTestContext(), doc: makeMediaDoc() };
}

/** Narrow a mutating-tool result to its error string, failing the test on
 *  success — the shared assertion helper of the batch media tool tests. */
export function errorOf(result: { result: unknown }): string {
	const r = result.result as { error?: string };
	if (r.error === undefined) throw new Error("expected error result");
	return r.error;
}
