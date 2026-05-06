// lib/case-store/__tests__/fixtures/simpleBlueprint.ts
//
// Shared "case-types-only" `BlueprintDoc` builder for case-store
// tests that exercise types operating against case data — the
// store contract harness, the sample generator, the
// preview-engine binding, and any future case-store consumer
// whose tests don't need the full module/form/field tree.
//
// ## Why this lives here, not inline at every test
//
// The `BlueprintDoc` shape carries every field the doc store
// holds (modules, forms, fields, ordering maps, fieldParent).
// Tests that only touch case-types end up filling the rest with
// empty defaults; that boilerplate copied verbatim across four+
// files is the duplication this fixture removes. Adding a new
// `BlueprintDoc` field surfaces an exhaustivity error at one
// site rather than four.
//
// ## Why a separate file from `storeContract.ts`
//
// `storeContract.ts` exports a function (`runStoreContract`)
// that callers invoke from inside their own `describe(...)`
// block. Pulling its private `buildBlueprint` helper out as a
// public export would conflate two concerns: contract-test
// orchestration and fixture construction. A dedicated file lets
// every consumer import the fixture without dragging the
// contract harness into their test file.
//
// ## Why the form-bridge has its own `buildFormBlueprint`
//
// `lib/case-store/form-bridge/__tests__/fixtures.ts` exports a
// `buildFormBlueprint` whose API is field-tree-aware — it takes a
// nested field-tree shape and emits a blueprint with modules +
// forms + fields populated, not just case-types. That helper
// composes `buildSimpleBlueprint` (this file's export) for the
// case-types-only base layer and overlays the form / module /
// field tree on top, so the empty-default boilerplate stays
// single-source even though the two builders distinguish along
// their input axis.

import type { BlueprintDoc, CaseType } from "@/lib/domain";

// ---------------------------------------------------------------
// `buildSimpleBlueprint`
// ---------------------------------------------------------------

/**
 * Build a `BlueprintDoc` whose `caseTypes` field contains exactly
 * the supplied case types. Every other blueprint field fills with
 * empty defaults — useful when the test cares only about case-data
 * behavior and ignores module / form / field structure.
 *
 * `appId` is parameterized so each call site pins its own value;
 * stable per-suite ids surface against the right namespace if the
 * per-test database isolation ever regresses.
 */
export function buildSimpleBlueprint(
	caseTypes: CaseType[],
	appId: string,
): BlueprintDoc {
	return {
		appId,
		appName: `${appId}-test-app`,
		connectType: null,
		caseTypes,
		modules: {},
		forms: {},
		fields: {},
		moduleOrder: [],
		formOrder: {},
		fieldOrder: {},
		fieldParent: {},
	};
}
