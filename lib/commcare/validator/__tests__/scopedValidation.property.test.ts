/**
 * The scoped runner is not an absolute boundary gate. The Builder may use it
 * only after its mutation classifier proves the complete changed footprint on
 * a prior valid snapshot. This suite preserves the underlying law:
 *
 *   scoped run = full run filtered to that explicit scope
 *
 * App-wide findings remain in every scoped run by definition. Module and form
 * footprints are independent, and their findings retain full-run order after
 * out-of-scope findings are removed.
 */

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { buildDoc, f, xp } from "@/lib/__tests__/docHelpers";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import type { Uuid } from "@/lib/domain";
import { blueprintDocArbitrary } from "../../__tests__/xformDocArbitrary";
import {
	scopeHasForm,
	type ValidationScope,
	validateBlueprintDeep,
} from "../index";
import { errorWithinScope, runValidation } from "../runner";

const SEED = 20260609;
const NUM_RUNS = 200;
const PROPERTY_TIMEOUT_MS = 120_000;

const docAndScopeArbitrary = blueprintDocArbitrary.chain((doc) => {
	const moduleUuids = [...doc.moduleOrder];
	const formUuids = moduleUuids.flatMap((moduleUuid) => [
		...(doc.formOrder[moduleUuid] ?? []),
	]);
	return fc
		.tuple(fc.subarray(moduleUuids), fc.subarray(formUuids))
		.map(([modules, forms]) => ({
			doc,
			scope: {
				moduleUuids: new Set(modules),
				formUuids: new Set(forms),
			} satisfies ValidationScope,
		}));
});

describe("scoped validation equals a full validation filtered to scope", () => {
	it("keeps the selected form's findings and excludes its peer", () => {
		const doc = buildDoc({
			appName: "Scoped validation",
			modules: [
				{
					name: "Survey",
					forms: [
						{
							name: "Included",
							type: "survey",
							fields: [
								f({
									kind: "text",
									id: "included",
									relevant: xp("#form/missing_included = 'yes'"),
								}),
							],
						},
						{
							name: "Excluded",
							type: "survey",
							fields: [
								f({
									kind: "text",
									id: "excluded",
									relevant: xp("#form/missing_excluded = 'yes'"),
								}),
							],
						},
					],
				},
			],
		});
		const moduleUuid = doc.moduleOrder[0] as Uuid;
		const formUuids = doc.formOrder[moduleUuid];
		const includedFormUuid = formUuids[0] as Uuid;
		const excludedFormUuid = formUuids[1] as Uuid;
		const scope: ValidationScope = {
			formUuids: new Set([includedFormUuid]),
		};

		const full = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE);
		const scoped = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE, { scope });
		expect(scoped).toEqual(
			full.filter((finding) => errorWithinScope(finding, scope)),
		);
		expect(
			scoped.some((finding) => finding.location.formUuid === includedFormUuid),
		).toBe(true);
		expect(
			scoped.some((finding) => finding.location.formUuid === excludedFormUuid),
		).toBe(false);
	});

	it("does not pull form work into an independently selected module", () => {
		const doc = buildDoc({
			appName: "Independent validation axes",
			modules: [
				{
					name: "Survey",
					forms: [
						{
							name: "Excluded",
							type: "survey",
							fields: [
								f({
									kind: "text",
									id: "excluded",
									relevant: xp("#form/missing = 'yes'"),
								}),
							],
						},
					],
				},
			],
		});
		const moduleUuid = doc.moduleOrder[0] as Uuid;
		const scope: ValidationScope = {
			moduleUuids: new Set([moduleUuid]),
		};
		const scoped = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE, { scope });
		expect(scoped.some((finding) => finding.location.formUuid)).toBe(false);
		expect(validateBlueprintDeep(doc, scope)).toEqual([]);
	});

	it(
		"holds for generated valid documents and generated explicit scopes",
		async () => {
			await fc.assert(
				fc.property(docAndScopeArbitrary, ({ doc, scope }) => {
					const full = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE);
					const scoped = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE, {
						scope,
					});
					expect(scoped).toEqual(
						full.filter((finding) => errorWithinScope(finding, scope)),
					);

					const fullDeep = validateBlueprintDeep(doc);
					const scopedDeep = validateBlueprintDeep(doc, scope);
					expect(scopedDeep).toEqual(
						fullDeep.filter((finding) =>
							scopeHasForm(scope, finding.moduleUuid, finding.formUuid),
						),
					);
				}),
				{ numRuns: NUM_RUNS, seed: SEED },
			);
		},
		PROPERTY_TIMEOUT_MS,
	);
});
