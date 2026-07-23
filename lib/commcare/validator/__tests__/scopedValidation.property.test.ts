import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
/**
 * The scoped-runner law, property-tested (the load-bearing oracle for the
 * gate's correctness):
 *
 *   (a) scoped-run ≡ full-run-filtered-to-scope, for `runValidation` and
 *       for `validateBlueprintDeep` directly — the runner restricts which
 *       entities are WALKED, and this property proves the restriction
 *       loses exactly the out-of-scope findings, nothing else, order
 *       preserved;
 *   (b) scope SOUNDNESS for `scopeOfMutations`: every finding a mutation
 *       batch introduces lies within the scope derived for that batch —
 *       the assumption `evaluateCommit`'s equivalence argument rests on.
 *
 * Docs come from `blueprintDocArbitrary` (valid by construction); batches
 * come from a doc-derived mutation generator biased toward error-producing
 * edits (dangling refs, colliding ids, removed writers) and applied
 * through the REAL reducers, so the validated docs carry realistic
 * findings at realistic locations.
 *
 * Each sample applies TWO batches: a DAMAGE batch first (seeding findings
 * anywhere in the doc — the legacy-broken-doc situation the gate must
 * handle), then an EDIT batch whose derived scope is what the laws are
 * asserted against. Without the damage step every finding would be
 * batch-introduced and therefore in scope by construction — the filter
 * side of law (a) would never exclude anything and the property would be
 * vacuous there (measured: 0/200 samples had out-of-scope findings under
 * the single-batch shape).
 */

import * as fc from "fast-check";
import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { buildDoc, f, xp } from "@/lib/__tests__/docHelpers";
import { rebuildFieldParent } from "@/lib/doc/fieldParent";
import { applyMutations } from "@/lib/doc/mutations";
import type { Mutation } from "@/lib/doc/types";
import { asUuid, type BlueprintDoc, type Field, type Uuid } from "@/lib/domain";
import type { LookupColumnId, LookupTableId } from "@/lib/domain/lookupIds";
import { eq, formField, literal } from "@/lib/domain/predicate";
import { blueprintDocArbitrary } from "../../__tests__/xformDocArbitrary";
import { errorIdentity } from "../gate";
import { scopeHasForm, validateBlueprintDeep } from "../index";
import { errorWithinScope, runValidation } from "../runner";
import { scopeOfMutations } from "../scopeOfMutations";

/** Fixed seed + run count so a failure reproduces exactly across runs + CI. */
const SEED = 20260609;
const NUM_RUNS = 200;

/** Generous budget — the property validates each generated doc ~7 times. */
const PROPERTY_TIMEOUT_MS = 120_000;

/** Field kinds whose updateField patch admits a `relevant` expression. */
const RELEVANT_KINDS = new Set([
	"text",
	"int",
	"decimal",
	"date",
	"time",
	"single_select",
	"multi_select",
]);

/**
 * One doc-derived mutation. Biased toward edits that CREATE findings:
 * dangling `#form/` refs, colliding/illegal ids, removed or duplicated
 * case-property writers, empty added forms — plus a slice of benign edits
 * so "nothing changed" scopes are exercised too.
 */
function mutationArb(doc: BlueprintDoc): fc.Arbitrary<Mutation> {
	const fieldUuids = Object.keys(doc.fields) as Uuid[];
	const formUuids = Object.keys(doc.forms) as Uuid[];
	const moduleUuids = [...doc.moduleOrder];
	const relevantTargets = fieldUuids.filter((uuid) =>
		RELEVANT_KINDS.has(doc.fields[uuid].kind),
	);

	const arms: fc.Arbitrary<Mutation>[] = [];

	if (fieldUuids.length > 0) {
		arms.push(
			fc
				.tuple(
					fc.constantFrom(...fieldUuids),
					fc.constantFrom("zz_fresh_id", "case_name", "a", "b", "q1"),
				)
				.map(
					([uuid, newId]): Mutation => ({ kind: "renameField", uuid, newId }),
				),
			fc
				.constantFrom(...fieldUuids)
				.map((uuid): Mutation => ({ kind: "removeField", uuid })),
			fc
				.constantFrom(...fieldUuids)
				.map((uuid): Mutation => ({ kind: "duplicateField", uuid })),
		);
		if (formUuids.length > 0) {
			arms.push(
				fc
					.tuple(fc.constantFrom(...fieldUuids), fc.constantFrom(...formUuids))
					.map(
						([uuid, toParentUuid]): Mutation => ({
							kind: "moveField",
							uuid,
							toParentUuid,
							toIndex: 0,
						}),
					),
			);
		}
	}

	if (relevantTargets.length > 0) {
		arms.push(
			fc
				.tuple(
					fc.constantFrom(...relevantTargets),
					fc.constantFrom(
						"#form/does_not_exist = '1'",
						"if(",
						"unknown-fn(1)",
						"true()",
					),
				)
				.map(
					([uuid, relevant]): Mutation =>
						({
							kind: "updateField",
							uuid,
							targetKind: doc.fields[uuid].kind,
							patch: { relevant: xp(relevant) },
						}) as Mutation,
				),
		);
	}

	if (formUuids.length > 0) {
		const caseTypeNames = (doc.caseTypes ?? []).map((ct) => ct.name);
		arms.push(
			fc
				.tuple(
					fc.constantFrom(...formUuids),
					fc.integer({ min: 0, max: 1_000_000 }),
					fc.constantFrom("genq", "case_name", "1bad id"),
					fc.option(
						caseTypeNames.length > 0
							? fc.constantFrom(...caseTypeNames)
							: fc.constant("patient"),
						{ nil: undefined },
					),
				)
				.map(
					([parentUuid, n, id, casePropertyOn]): Mutation => ({
						kind: "addField",
						parentUuid,
						field: {
							uuid: asUuid(`genfld-${n}`),
							kind: "text",
							id,
							label: id,
							...(casePropertyOn ? { case_property_on: casePropertyOn } : {}),
						} as Field,
					}),
				),
			fc
				.constantFrom(...formUuids)
				.map(
					(uuid): Mutation => ({ kind: "renameForm", uuid, newId: "Renamed" }),
				),
			fc.constantFrom(...formUuids).map(
				(uuid): Mutation => ({
					kind: "setFormMedia",
					uuid,
					icon: null,
					audioLabel: null,
				}),
			),
		);
	}

	if (moduleUuids.length > 0) {
		arms.push(
			fc
				.tuple(
					fc.constantFrom(...moduleUuids),
					fc.integer({ min: 0, max: 1_000_000 }),
					fc.constantFrom("survey" as const, "registration" as const),
				)
				.map(
					([moduleUuid, n, type]): Mutation => ({
						kind: "addForm",
						moduleUuid,
						form: {
							uuid: asUuid(`genform-${n}`),
							id: `genform_${n}`,
							name: `Gen ${n}`,
							type,
						},
					}),
				),
			fc.constantFrom(...moduleUuids).map(
				(uuid): Mutation => ({
					kind: "updateModule",
					uuid,
					patch: { name: "Renamed Module" },
				}),
			),
			fc
				.tuple(
					fc.constantFrom(...moduleUuids),
					fc.integer({ min: 0, max: moduleUuids.length - 1 }),
				)
				.map(
					([uuid, toIndex]): Mutation => ({
						kind: "moveModule",
						uuid,
						toIndex,
					}),
				),
		);
	}

	// A full-mapping arm keeps the "full" path exercised (the property
	// short-circuits there — full ≡ full needs no comparison).
	arms.push(
		fc.constant({ kind: "setAppName", name: "Renamed App" } as Mutation),
	);

	return fc.oneof(...arms);
}

const docAndBatchesArb = blueprintDocArbitrary.chain((doc) =>
	fc.tuple(
		fc.constant(doc),
		// The damage batch — findings land wherever it strikes.
		fc.array(mutationArb(doc), { minLength: 0, maxLength: 3 }),
		// The edit batch — the scope under test derives from THIS one.
		fc.array(mutationArb(doc), { minLength: 1, maxLength: 4 }),
	),
);

describe("scoped validation ≡ full validation filtered to scope", () => {
	it("holds for a lookup-backed select with a default/options dependency cycle", () => {
		const sourceUuid = asUuid("20000000-0000-7000-8000-0000000000a1");
		const selectUuid = asUuid("20000000-0000-7000-8000-0000000000b1");
		const lookupTable = "30000000-0000-7000-8000-0000000000a1" as LookupTableId;
		const lookupColumn =
			"40000000-0000-7000-8000-0000000000a1" as LookupColumnId;
		const doc = buildDoc({
			appName: "Scoped lookup validation",
			modules: [
				{
					name: "Survey",
					forms: [
						{
							name: "Lookup form",
							type: "survey",
							fields: [
								f({
									uuid: sourceUuid,
									kind: "text",
									id: "source",
									label: "Source",
									default_value: "/data/choice",
								}),
								f({
									uuid: selectUuid,
									kind: "single_select",
									id: "choice",
									label: "Choice",
									options: [
										{ value: "yes", label: "Yes" },
										{ value: "no", label: "No" },
									],
									optionsSource: {
										kind: "lookup-table",
										tableId: lookupTable,
										valueColumnId: lookupColumn,
										labelColumnId: lookupColumn,
										filter: eq(formField(sourceUuid), literal("yes")),
									},
								}),
							],
						},
						{
							name: "Out of scope",
							type: "survey",
							fields: [
								f({
									kind: "text",
									id: "broken",
									label: "Broken",
									relevant: "if(",
								}),
							],
						},
					],
				},
			],
		});
		const moduleUuid = doc.moduleOrder[0];
		const [lookupFormUuid, outsideFormUuid] = doc.formOrder[moduleUuid];
		const scope = { formUuids: new Set([lookupFormUuid]) };

		const full = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE);
		const scoped = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE, { scope });
		expect(scoped).toEqual(
			full.filter((finding) => errorWithinScope(finding, scope)),
		);
		expect(scoped).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					code: "CYCLE",
					location: expect.objectContaining({ formUuid: lookupFormUuid }),
				}),
				expect.objectContaining({
					code: "LOOKUP_CONTEXT_UNAVAILABLE",
					location: expect.objectContaining({ fieldUuid: selectUuid }),
				}),
			]),
		);
		expect(
			full.some(
				(finding) =>
					finding.location.formUuid === outsideFormUuid &&
					finding.code === "XPATH_SYNTAX",
			),
		).toBe(true);
		expect(
			scoped.some((finding) => finding.location.formUuid === outsideFormUuid),
		).toBe(false);

		const fullDeep = validateBlueprintDeep(doc);
		const scopedDeep = validateBlueprintDeep(doc, scope);
		expect(scopedDeep).toEqual(
			fullDeep.filter((finding) =>
				scopeHasForm(scope, finding.moduleUuid, finding.formUuid),
			),
		);
		expect(scopedDeep).toContainEqual(
			expect.objectContaining({
				kind: "cycle",
				formUuid: lookupFormUuid,
			}),
		);
		expect(
			fullDeep.some((finding) => finding.formUuid === outsideFormUuid),
		).toBe(true);
		expect(
			scopedDeep.some((finding) => finding.formUuid === outsideFormUuid),
		).toBe(false);
	});

	it(
		"holds for generated docs under generated mutation batches, and scopes are sound",
		() => {
			fc.assert(
				fc.property(docAndBatchesArb, ([doc, damageBatch, editBatch]) => {
					rebuildFieldParent(doc);
					const prevDoc = produce(doc, (draft) => {
						applyMutations(draft, damageBatch);
					});
					const scope = scopeOfMutations(prevDoc, editBatch);
					if (scope === "full") return;

					const next = produce(prevDoc, (draft) => {
						applyMutations(draft, editBatch);
					});

					// (a) runner law on the post-edit doc (where findings live)
					// AND the pre-edit doc (the gate runs both sides under one
					// scope). Damage outside the edit's scope is exactly what
					// the filter must exclude on both.
					for (const target of [next, prevDoc]) {
						const scoped = runValidation(target, LOOKUP_CONTEXT_UNAVAILABLE, {
							scope,
						});
						const filtered = runValidation(
							target,
							LOOKUP_CONTEXT_UNAVAILABLE,
						).filter((err) => errorWithinScope(err, scope));
						expect(scoped).toEqual(filtered);
					}

					// (a') same law on the deep walk directly.
					const scopedDeep = validateBlueprintDeep(next, scope);
					const filteredDeep = validateBlueprintDeep(next).filter((deep) =>
						scopeHasForm(scope, deep.moduleUuid, deep.formUuid),
					);
					expect(scopedDeep).toEqual(filteredDeep);

					// (b) scope soundness: every finding the EDIT batch
					// introduced is within its scope — out-of-scope findings
					// must all pre-exist (here: the damage batch's).
					const prevIdentities = new Set(
						runValidation(prevDoc, LOOKUP_CONTEXT_UNAVAILABLE).map(
							errorIdentity,
						),
					);
					const introducedOutOfScope = runValidation(
						next,
						LOOKUP_CONTEXT_UNAVAILABLE,
					).filter(
						(err) =>
							!errorWithinScope(err, scope) &&
							!prevIdentities.has(errorIdentity(err)),
					);
					expect(introducedOutOfScope).toEqual([]);
				}),
				{ numRuns: NUM_RUNS, seed: SEED },
			);
		},
		PROPERTY_TIMEOUT_MS,
	);
});
