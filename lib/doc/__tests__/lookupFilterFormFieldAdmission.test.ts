import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	formFieldEntriesFor,
	lookupFilterEligibleFormFields,
} from "@/lib/doc/formFieldEntries";
import { asUuid } from "@/lib/domain";

const ROOT = asUuid("10000000-0000-4000-8000-000000000001");
const OUTER = asUuid("10000000-0000-4000-8000-000000000002");
const OUTER_VALUE = asUuid("10000000-0000-4000-8000-000000000003");
const INNER = asUuid("10000000-0000-4000-8000-000000000004");
const INNER_VALUE = asUuid("10000000-0000-4000-8000-000000000005");
const CURRENT = asUuid("10000000-0000-4000-8000-000000000006");
const LATER = asUuid("10000000-0000-4000-8000-000000000007");
const CHILD_REPEAT = asUuid("10000000-0000-4000-8000-000000000008");
const CHILD_VALUE = asUuid("10000000-0000-4000-8000-000000000009");
const SIBLING_REPEAT = asUuid("10000000-0000-4000-8000-000000000010");
const SIBLING_VALUE = asUuid("10000000-0000-4000-8000-000000000011");
const LABEL = asUuid("10000000-0000-4000-8000-000000000012");

function fixture() {
	const doc = buildDoc({
		modules: [
			{
				name: "Survey",
				forms: [
					{
						name: "Visit",
						type: "survey",
						fields: [
							f({ uuid: ROOT, kind: "text", id: "root", label: "Root" }),
							f({
								uuid: OUTER,
								kind: "repeat",
								id: "outer",
								label: "Outer",
								children: [
									f({
										uuid: OUTER_VALUE,
										kind: "text",
										id: "outer_value",
										label: "Outer value",
									}),
									f({
										uuid: INNER,
										kind: "repeat",
										id: "inner",
										label: "Inner",
										children: [
											f({
												uuid: INNER_VALUE,
												kind: "text",
												id: "inner_value",
												label: "Inner value",
											}),
											f({
												uuid: CURRENT,
												kind: "single_select",
												id: "choice",
												label: "Choice",
												optionsSource: {
													kind: "inline",
													options: [
														{
															uuid: asUuid(
																"73a565d3-8af4-4540-a6fe-2431eb3a5e9a",
															),
															value: "a",
															label: "A",
														},
														{
															uuid: asUuid(
																"8fd60ecf-3d38-4f79-ad88-1ddc8a22deba",
															),
															value: "b",
															label: "B",
														},
													],
												},
											}),
											f({
												uuid: LATER,
												kind: "text",
												id: "later",
												label: "Later",
											}),
											f({
												uuid: CHILD_REPEAT,
												kind: "repeat",
												id: "child",
												label: "Child",
												children: [
													f({
														uuid: CHILD_VALUE,
														kind: "text",
														id: "child_value",
														label: "Child value",
													}),
												],
											}),
										],
									}),
								],
							}),
							f({
								uuid: SIBLING_REPEAT,
								kind: "repeat",
								id: "sibling",
								label: "Sibling",
								children: [
									f({
										uuid: SIBLING_VALUE,
										kind: "text",
										id: "sibling_value",
										label: "Sibling value",
									}),
								],
							}),
							f({
								uuid: LABEL,
								kind: "label",
								id: "instructions",
								label: "Instructions",
							}),
						],
					},
				],
			},
		],
	});
	const moduleUuid = doc.moduleOrder[0];
	const formUuid = doc.formOrder[moduleUuid][0];
	return { doc, formUuid };
}

describe("lookup filter form-field admission", () => {
	it("offers only earlier root/current/enclosing-repeat answers", () => {
		const { doc, formUuid } = fixture();
		const entries = formFieldEntriesFor(doc, formUuid);

		expect(
			lookupFilterEligibleFormFields(entries, CURRENT).map(
				(entry) => entry.uuid,
			),
		).toEqual([ROOT, OUTER_VALUE, INNER_VALUE]);
		expect(
			lookupFilterEligibleFormFields(entries, CURRENT).map(
				(entry) => entry.uuid,
			),
		).not.toContain(LATER);
		expect(
			lookupFilterEligibleFormFields(entries, CURRENT).map(
				(entry) => entry.uuid,
			),
		).not.toContain(CHILD_VALUE);
		expect(
			lookupFilterEligibleFormFields(entries, CURRENT).map(
				(entry) => entry.uuid,
			),
		).not.toContain(SIBLING_VALUE);
		expect(
			lookupFilterEligibleFormFields(entries, CURRENT).map(
				(entry) => entry.uuid,
			),
		).not.toContain(LABEL);
	});

	it("recomputes earlier-answer admission from the current fieldOrder sequences", () => {
		const { doc, formUuid } = fixture();
		doc.fieldOrder[formUuid] = [OUTER, ROOT, SIBLING_REPEAT, LABEL];
		const entries = formFieldEntriesFor(doc, formUuid);

		expect(
			lookupFilterEligibleFormFields(entries, CURRENT).map(
				(entry) => entry.uuid,
			),
		).not.toContain(ROOT);
		expect(
			lookupFilterEligibleFormFields(entries, CURRENT).map(
				(entry) => entry.uuid,
			),
		).toEqual([OUTER_VALUE, INNER_VALUE]);
	});
});
