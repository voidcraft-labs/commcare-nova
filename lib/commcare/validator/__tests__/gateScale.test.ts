import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { type BlueprintDoc, blueprintDocSchema, proseText } from "@/lib/domain";
import {
	buildDoc,
	caseListConfig,
	f,
	type ModuleSpec,
	xp,
} from "../../../__tests__/docHelpers";
import { evaluateBoundary } from "../gate";

/**
 * Deterministic large fixture: 30 modules × 4 forms × 25 fields = 3,000
 * fields, chained expression references, case-property writers
 * feeding real case lists, and nested groups so the tree walks recurse.
 */
function largeDoc(): BlueprintDoc {
	const modules: ModuleSpec[] = [];
	for (let m = 0; m < 30; m++) {
		const caseType = `case_type_${m}`;
		modules.push({
			name: `Module ${m}`,
			caseType,
			caseListConfig: caseListConfig([
				{ field: "case_name", header: "Name" },
				{ field: "q_0", header: "First" },
			]),
			forms: Array.from({ length: 4 }, (_, fm) => ({
				name: `Form ${m}-${fm}`,
				type: fm === 0 ? ("registration" as const) : ("followup" as const),
				fields: [
					f({
						kind: "text",
						id: "case_name",
						label: proseText("Name"),
						caseWrite: { caseType, property: "case_name" },
					}),
					...Array.from({ length: 20 }, (_, q) =>
						f({
							kind: "int",
							id: `q_${q}`,
							label: `Question ${q}`,
							relevant: q > 0 ? `#form/q_${q - 1} > 0` : undefined,
							required: "true()",
							...(fm > 0 && q < 3
								? {
										caseWrite: {
											caseType,
											property: `q_${q}`,
										},
									}
								: {}),
						}),
					),
					f({
						kind: "group",
						id: "grp",
						label: proseText("Group"),
						children: Array.from({ length: 3 }, (_, q) =>
							f({
								kind: "hidden",
								id: `calc_${q}`,
								calculate: `#form/q_${q} + 1`,
							}),
						),
					}),
				],
			})),
		});
	}
	return buildDoc({
		appName: "Perf Fixture",
		modules,
		caseTypes: Array.from({ length: 30 }, (_, m) => ({
			name: `case_type_${m}`,
			properties: [
				{ name: "case_name", label: "Name" },
				...Array.from({ length: 3 }, (_, q) => ({
					name: `q_${q}`,
					label: proseText(`Number ${q}`),
					data_type: "int" as const,
				})),
			],
		})),
	});
}

describe("complete validation of a large app", () => {
	it("accepts 3,000 fields, then finds a broken reference in the last form", () => {
		const doc = largeDoc();
		blueprintDocSchema.parse(toPersistableDoc(doc));
		expect(Object.keys(doc.fields)).toHaveLength(3_000);
		expect(
			evaluateBoundary(doc, new Map(), LOOKUP_CONTEXT_UNAVAILABLE),
		).toEqual([]);
		const lastField = Object.values(doc.fields).at(-1);
		if (lastField?.kind !== "hidden")
			throw new Error("Expected the final calculation field");
		const broken = produce(doc, (draft) => {
			draft.fields[lastField.uuid] = {
				...lastField,
				calculate: xp("#form/missing"),
			};
		});
		blueprintDocSchema.parse(toPersistableDoc(broken));
		const findings = evaluateBoundary(
			broken,
			new Map(),
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(
			findings.map(({ code, location }) => ({
				code,
				fieldUuid: location.fieldUuid,
			})),
		).toEqual([{ code: "INVALID_REF", fieldUuid: lastField.uuid }]);
	});
});
