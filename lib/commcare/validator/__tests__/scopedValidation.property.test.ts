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
import { expectAdmittedDoc } from "@/lib/agent/__tests__/admittedFixture";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";

import { type ValidationScope, validateBlueprintDeep } from "../index";
import { errorWithinScope, runValidation } from "../runner";

const SEED = 20260609;
const NUM_RUNS = 200;
const PROPERTY_TIMEOUT_MS = 120_000;

const docAndScopeArbitrary = fc
	.array(fc.integer({ min: 1, max: 3 }), { minLength: 1, maxLength: 3 })
	.chain((formCounts) => {
		const admitted = expectAdmittedDoc(
			buildDoc({
				modules: formCounts.map((count, moduleIndex) => ({
					name: `Module ${moduleIndex}`,
					forms: Array.from({ length: count }, (_, formIndex) => ({
						name: `Form ${formIndex}`,
						type: "survey" as const,
						fields: [f({ kind: "text", id: "answer", label: "Answer" })],
					})),
				})),
			}),
		);
		const doc = {
			...admitted,
			appName: "",
			fields: Object.fromEntries(
				Object.entries(admitted.fields).map(([uuid, field]) => [
					uuid,
					{ ...field, relevant: xp("#form/missing = 'yes'") },
				]),
			),
		};
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
		const moduleUuid = doc.moduleOrder[0];
		const formUuids = doc.formOrder[moduleUuid];
		const includedFormUuid = formUuids[0];
		const excludedFormUuid = formUuids[1];
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
		const moduleUuid = doc.moduleOrder[0];
		const scope: ValidationScope = {
			moduleUuids: new Set([moduleUuid]),
		};
		const scoped = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE, { scope });
		expect(scoped.some((finding) => finding.location.formUuid)).toBe(false);
		expect(validateBlueprintDeep(doc, scope)).toEqual([]);
	});

	it(
		"retains app findings and exactly the selected form failures across generated scopes",
		async () => {
			await fc.assert(
				fc.property(docAndScopeArbitrary, ({ doc, scope }) => {
					const full = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE);
					const scoped = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE, {
						scope,
					});
					expect(scoped).toEqual(
						full.filter(
							(finding) =>
								finding.scope === "app" ||
								(finding.location.formUuid !== undefined &&
									scope.formUuids.has(finding.location.formUuid)),
						),
					);
					expect(
						full
							.filter((finding) => finding.scope === "app")
							.map((finding) => finding.code),
					).toEqual(["EMPTY_APP_NAME"]);
					expect(
						full.filter((finding) => finding.location.formUuid !== undefined),
					).toHaveLength(Object.keys(doc.forms).length);
					expect(
						scoped.filter((finding) => finding.location.formUuid !== undefined),
					).toHaveLength(scope.formUuids.size);

					const fullDeep = validateBlueprintDeep(doc);
					const scopedDeep = validateBlueprintDeep(doc, scope);
					expect(scopedDeep).toEqual(
						fullDeep.filter((finding) => scope.formUuids.has(finding.formUuid)),
					);
				}),
				{ numRuns: NUM_RUNS, seed: SEED },
			);
		},
		PROPERTY_TIMEOUT_MS,
	);
});
