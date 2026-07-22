import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
/**
 * Per-mode + per-nest compiler tests for repeat-context subcase
 * emission. Pins the wire shape across the (repeat_mode, nest)
 * matrix:
 *
 *   - user_controlled + nest=false (one subcase per repeat): mirrors
 *     CCHQ's `subcase-repeat.xml` — `<case>` splices DIRECTLY into
 *     the repeat element with no `<subcase_N>` wrapper.
 *   - user_controlled + nest=true (multiple subcases per repeat):
 *     mirrors CCHQ's `multiple_subcase_repeat.xml` — each subcase
 *     gets its own `<subcase_N>` wrapper inside the repeat.
 *   - count_bound + nest=false / nest=true: same data-instance shape
 *     as user_controlled (CCHQ shares the JavaRosa `<X jr:template="">`
 *     wrapper across both Regular Repeat variants), plus the
 *     `jr:count` + `jr:noAddRemove` attributes on the body's <repeat>.
 *   - query_bound + nest=false / nest=true: model-iteration shape —
 *     children nest inside `<X>/<item>` so the splice target is
 *     `<item>`, not `<X>`. Binds resolve at `/data/<X>/item/...`.
 *
 * Plus two cross-shape tests:
 *   - Two distinct repeats both creating child cases of the SAME
 *     case type: post Step 6's bucketing change, each repeat
 *     produces its own subcase action with its own repeat_context.
 *   - Mixed shape — one root-level subcase + one repeat-context
 *     subcase in the same form: each splices to its correct parent;
 *     non-contiguous subcase numbering is preserved (matching CCHQ's
 *     `subcase_repeat_mixed_form_post.xml` shape with `<subcase_0>`
 *     at the root and `<subcase_2>` inside the repeat).
 *
 * The contract these tests pin is STRUCTURAL — same element nesting,
 * same bind nodesets, same case_id mint shape (uuid() calculate bind
 * vs setvalue from session datum), same session datum membership.
 * Byte-equal parity with the CCHQ fixtures isn't possible because
 * Nova's authoring model can't reproduce CCHQ's "one source field
 * feeds two distinct subcase scopes" wiring (sibling field ids must
 * be unique), but the structural shape is identical.
 */

import AdmZip from "adm-zip";
import { describe, expect, it } from "vitest";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { compileCcz } from "@/lib/commcare/compiler";
import { expandDoc } from "@/lib/commcare/expander";
import { runValidation } from "@/lib/commcare/validator/runner";

/**
 * Compile a Nova doc and return the registration form's XForm XML +
 * suite.xml. Asserts validation is clean — none of the new authoring
 * rules (PRIMARY_CASE_FIELD_IN_REPEAT / CHILD_CASE_NO_NAME_FIELD) fire
 * on any test in this file. Co-located here to keep the test bodies
 * focused on the per-mode wire-shape assertions.
 */
function compile(doc: ReturnType<typeof buildDoc>): {
	form: string;
	suite: string;
} {
	const errors = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE);
	expect(
		errors.find(
			(e) =>
				e.code === "PRIMARY_CASE_FIELD_IN_REPEAT" ||
				e.code === "CHILD_CASE_NO_NAME_FIELD",
		),
	).toBeUndefined();
	const buf = compileCcz(expandDoc(doc), "Parity", doc);
	const zip = new AdmZip(buf);
	return {
		form: zip.readAsText("modules-0/forms-0.xml"),
		suite: zip.readAsText("suite.xml"),
	};
}

/**
 * Sequence each call site uses to build the per-mode test docs.
 * Centralizes the boilerplate (module declaration, primary case
 * fields, declared case types) so the per-test body is just the
 * repeat + child fields. `childCount` controls nest:
 *   - childCount=1: single subcase per repeat → nest=false → bare
 *     `<case>` element splices directly into the repeat.
 *   - childCount=2: multiple subcases per repeat → nest=true → each
 *     gets its own `<subcase_N>` wrapper.
 */
function withRepeat(
	repeat:
		| { mode: "user_controlled" }
		| { mode: "count_bound"; count: string }
		| { mode: "query_bound"; idsQuery: string },
	childCount: 1 | 2,
): ReturnType<typeof buildDoc> {
	const repeatChildren: ReturnType<typeof f>[] = [];
	const caseTypes: {
		name: string;
		properties: { name: string; label: string }[];
	}[] = [
		{ name: "parent", properties: [{ name: "case_name", label: "Name" }] },
	];
	for (let i = 0; i < childCount; i++) {
		const childType = `child${i + 1}`;
		// Each child case bucket gets its own `case_name`-id'd field
		// (required by `CHILD_CASE_NO_NAME_FIELD`). For nest=true (two
		// subcases sharing one repeat), the second child's bucket key is
		// `(child2, repeat_id)` — distinct from `(child1, repeat_id)` —
		// so it lives in its own subcase wrapper. The two `case_name`
		// fields share an element name; CommCare allows duplicate
		// sibling element names in the data tree, but Nova's
		// `duplicateFieldIds` validator rejects siblings with the same
		// field id. To stay within Nova's invariants AND emit two
		// subcases sharing one repeat_context, we wrap each child case's
		// fields in its own group inside the repeat — cousins (different
		// containers) can share an id.
		if (childCount === 1) {
			repeatChildren.push(
				f({
					kind: "text",
					id: "case_name",
					label: `${childType} name`,
					case_property_on: childType,
				}),
			);
		} else {
			repeatChildren.push(
				f({
					kind: "group",
					id: `${childType}_section`,
					label: `${childType} section`,
					children: [
						f({
							kind: "text",
							id: "case_name",
							label: `${childType} name`,
							case_property_on: childType,
						}),
					],
				}),
			);
		}
		caseTypes.push({
			name: childType,
			properties: [{ name: "case_name", label: "Name" }],
		});
	}
	const repeatField =
		repeat.mode === "count_bound"
			? f({
					kind: "repeat",
					id: "children",
					label: "Children",
					repeat_mode: "count_bound",
					repeat_count: repeat.count,
					children: repeatChildren,
				})
			: repeat.mode === "query_bound"
				? f({
						kind: "repeat",
						id: "children",
						label: "Children",
						repeat_mode: "query_bound",
						data_source: { ids_query: repeat.idsQuery },
						children: repeatChildren,
					})
				: f({
						kind: "repeat",
						id: "children",
						label: "Children",
						repeat_mode: "user_controlled",
						children: repeatChildren,
					});
	return buildDoc({
		appName: "Parity",
		modules: [
			{
				name: "Parents",
				caseType: "parent",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						name: "Register",
						type: "registration",
						fields: [
							f({
								kind: "text",
								id: "case_name",
								label: "Parent name",
								case_property_on: "parent",
							}),
							repeatField,
						],
					},
				],
			},
		],
		caseTypes,
	});
}

describe("repeat-context subcase emission — per-mode + per-nest matrix", () => {
	it("user_controlled + 1 subcase: bare <case> splices into the repeat (nest=false)", () => {
		const { form, suite } = compile(withRepeat({ mode: "user_controlled" }, 1));
		// `<children jr:template="">` holds `<case>` DIRECTLY (no
		// `<subcase_N>` wrapper). Mirrors CCHQ's subcase-repeat.xml.
		expect(form).toMatch(
			/<children jr:template="">[\s\S]*<case case_id="" date_modified="" user_id="" xmlns="http:\/\/commcarehq\.org\/case\/transaction\/v2">/,
		);
		// case_id minted per-iteration via uuid() — no setvalue, no
		// session datum.
		expect(form).toContain(
			'<bind nodeset="/data/children/case/@case_id" calculate="uuid()"/>',
		);
		expect(form).not.toMatch(
			/<setvalue ref="\/data\/children\/case\/@case_id"/,
		);
		// Parent-index pointer reads from the primary case_id.
		expect(form).toContain(
			'<bind nodeset="/data/children/case/index/parent" calculate="/data/case/@case_id"/>',
		);
		// Suite: primary case datum present; no child case datum.
		expect(suite).toContain(
			'<datum id="case_id_new_parent_0" function="uuid()"/>',
		);
		expect(suite).not.toMatch(/case_id_new_child1_\d+/);
		// Child case name's `create/case_name` binds calculate from the
		// child's IN-REPEAT path (`/data/children/case_name`), NOT the
		// parent's root `/data/case_name` field. Both fields share the
		// `case_name` id (cousins are legal in CommCare); a top-level
		// `findField` would return the parent's path first-match. The
		// `field_paths` map deriveCaseConfig records per-bucket prevents
		// the silent calculate-from-parent-name bug.
		expect(form).toContain(
			'<bind nodeset="/data/children/case/create/case_name" calculate="/data/children/case_name"',
		);
		// Hostile: assert the wrong path is NOT what the calculate points at.
		expect(form).not.toMatch(
			/<bind nodeset="\/data\/children\/case\/create\/case_name" calculate="\/data\/case_name"/,
		);
	});

	it("user_controlled + 2 subcases: <subcase_N> wrappers inside the repeat (nest=true)", () => {
		const { form, suite } = compile(withRepeat({ mode: "user_controlled" }, 2));
		// `<children>` contains BOTH `<subcase_0>` and `<subcase_1>`,
		// each wrapping a cx2 `<case>`. Mirrors CCHQ's
		// multiple_subcase_repeat.xml.
		expect(form).toMatch(
			/<children jr:template="">[\s\S]*<subcase_0>[\s\S]*<case[^>]*xmlns="http:\/\/commcarehq\.org\/case\/transaction\/v2"[\s\S]*<\/case>[\s\S]*<\/subcase_0>/,
		);
		expect(form).toMatch(
			/<children jr:template="">[\s\S]*<subcase_1>[\s\S]*<case[^>]*xmlns="http:\/\/commcarehq\.org\/case\/transaction\/v2"[\s\S]*<\/case>[\s\S]*<\/subcase_1>/,
		);
		// Both subcases use uuid() calculate for case_id.
		expect(form).toContain(
			'<bind nodeset="/data/children/subcase_0/case/@case_id" calculate="uuid()"/>',
		);
		expect(form).toContain(
			'<bind nodeset="/data/children/subcase_1/case/@case_id" calculate="uuid()"/>',
		);
		// Index pointers to primary case.
		expect(form).toContain(
			'<bind nodeset="/data/children/subcase_0/case/index/parent" calculate="/data/case/@case_id"/>',
		);
		expect(form).toContain(
			'<bind nodeset="/data/children/subcase_1/case/index/parent" calculate="/data/case/@case_id"/>',
		);
		// No child-case session datums.
		expect(suite).not.toMatch(/case_id_new_child\d_\d+/);
	});

	it("count_bound + 1 subcase: same data shape as user_controlled, plus jr:count + jr:noAddRemove on body <repeat>", () => {
		const { form } = compile(
			withRepeat({ mode: "count_bound", count: "3" }, 1),
		);
		// Data instance shape is identical to user_controlled — bare
		// `<case>` directly inside `<children>`.
		expect(form).toMatch(
			/<children jr:template="">[\s\S]*<case case_id=""[\s\S]*<\/case>/,
		);
		// Body's `<repeat>` carries the count attributes.
		expect(form).toMatch(
			/<repeat nodeset="\/data\/children"[^>]*jr:count="[^"]+"[^>]*jr:noAddRemove="true\(\)"/,
		);
		expect(form).toContain(
			'<bind nodeset="/data/children/case/@case_id" calculate="uuid()"/>',
		);
	});

	it("count_bound + 2 subcases: wrappers + count attributes coexist", () => {
		const { form } = compile(
			withRepeat({ mode: "count_bound", count: "2" }, 2),
		);
		expect(form).toMatch(/<subcase_0>[\s\S]*<\/subcase_0>/);
		expect(form).toMatch(/<subcase_1>[\s\S]*<\/subcase_1>/);
		expect(form).toMatch(
			/<repeat nodeset="\/data\/children"[^>]*jr:count="[^"]+"[^>]*jr:noAddRemove="true\(\)"/,
		);
	});

	it("query_bound + 1 subcase: <case> splices into <children>/<item> (nest=false + /item)", () => {
		const { form } = compile(
			withRepeat(
				{
					mode: "query_bound",
					idsQuery:
						"instance('casedb')/casedb/case[@case_type='child1']/@case_id",
				},
				1,
			),
		);
		// Data instance: `<children vellum:role="Repeat"><item jr:template="">`
		// holds the `<case>` directly (nest=false). Bind nodesets include
		// the /item segment — `/data/children/item/case/...`.
		expect(form).toMatch(
			/<children[^>]*vellum:role="Repeat"[^>]*>[\s\S]*<item[^>]*jr:template="">[\s\S]*<case[^>]*xmlns="http:\/\/commcarehq\.org\/case\/transaction\/v2"[\s\S]*<\/case>/,
		);
		expect(form).toContain(
			'<bind nodeset="/data/children/item/case/@case_id" calculate="uuid()"/>',
		);
		expect(form).toContain(
			'<bind nodeset="/data/children/item/case/index/parent" calculate="/data/case/@case_id"/>',
		);
		// The model-iteration body still emits the four setvalues + the
		// @current_index bind — repeat-context subcase emission doesn't
		// touch the model-iteration plumbing.
		expect(form).toContain('<bind nodeset="/data/children/@current_index"');
		expect(form).toMatch(/<repeat nodeset="\/data\/children\/item"/);
	});

	it("query_bound + 2 subcases: <subcase_N> wrappers under <item>", () => {
		const { form } = compile(
			withRepeat(
				{
					mode: "query_bound",
					idsQuery:
						"instance('casedb')/casedb/case[@case_type='child1']/@case_id",
				},
				2,
			),
		);
		expect(form).toContain(
			'<bind nodeset="/data/children/item/subcase_0/case/@case_id" calculate="uuid()"/>',
		);
		expect(form).toContain(
			'<bind nodeset="/data/children/item/subcase_1/case/@case_id" calculate="uuid()"/>',
		);
	});
});

describe("repeat-context subcase emission — cross-shape variants", () => {
	it("two distinct repeats producing the same child case type emit two scoped subcase actions", () => {
		// Post Step 6's bucketing change: two repeats authoring fields
		// for `child` produce two DerivedChildCase entries, one per
		// repeat. Each emits its own subcase wrapper inside its own
		// repeat, with bind nodesets scoped to that repeat.
		const doc = buildDoc({
			appName: "Parity",
			modules: [
				{
					name: "Households",
					caseType: "household",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [
						{
							name: "Register",
							type: "registration",
							fields: [
								f({
									kind: "text",
									id: "case_name",
									label: "Household name",
									case_property_on: "household",
								}),
								f({
									kind: "repeat",
									id: "family_members",
									label: "Family members",
									repeat_mode: "user_controlled",
									children: [
										f({
											kind: "text",
											id: "case_name",
											label: "Family member name",
											case_property_on: "person",
										}),
									],
								}),
								f({
									kind: "repeat",
									id: "neighbors",
									label: "Neighbors",
									repeat_mode: "user_controlled",
									children: [
										f({
											kind: "text",
											id: "case_name",
											label: "Neighbor name",
											case_property_on: "person",
										}),
									],
								}),
							],
						},
					],
				},
			],
			caseTypes: [
				{
					name: "household",
					properties: [{ name: "case_name", label: "Name" }],
				},
				{
					name: "person",
					properties: [{ name: "case_name", label: "Name" }],
				},
			],
		});
		const { form, suite } = compile(doc);
		// Each repeat holds its own bare `<case>` (nest=false — one
		// subcase per repeat). The bind nodesets are independently
		// scoped to each repeat element.
		expect(form).toContain(
			'<bind nodeset="/data/family_members/case/@case_id" calculate="uuid()"/>',
		);
		expect(form).toContain(
			'<bind nodeset="/data/neighbors/case/@case_id" calculate="uuid()"/>',
		);
		// No `case_id_new_person_*` session datums — both subcases
		// are repeat-context and mint their ids via uuid() calculate.
		expect(suite).not.toMatch(/case_id_new_person_\d+/);
		// Primary household session datum present.
		expect(suite).toContain(
			'<datum id="case_id_new_household_0" function="uuid()"/>',
		);
	});

	it("mixed root-level + repeat-context subcases: each splices to its correct parent", () => {
		// CCHQ's `subcase_repeat_mixed_form_post.xml` shape: some
		// subcases at the data root (wrapped in `<subcase_N>` under
		// `<data>`), others inside a repeat (bare `<case>` for
		// nest=false). Numbering is the global subcases list position,
		// so a repeat-context subcase at index 1 followed by a
		// root-level subcase at index 2 produces non-contiguous
		// wrapper names — the wire-shape side of CCHQ's
		// `Form.session_var_for_action` index rule.
		const doc = buildDoc({
			appName: "Parity",
			modules: [
				{
					name: "Households",
					caseType: "household",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [
						{
							name: "Register",
							type: "registration",
							fields: [
								f({
									kind: "text",
									id: "case_name",
									label: "Household name",
									case_property_on: "household",
								}),
								// Root-level subcase — wraps in `<subcase_N>`
								// under `<data>`, uses xforms-ready setvalue
								// from session datum.
								f({
									kind: "group",
									id: "guardian_section",
									label: "Guardian",
									children: [
										f({
											kind: "text",
											id: "case_name",
											label: "Guardian name",
											case_property_on: "guardian",
										}),
									],
								}),
								// Repeat-context subcase — splices DIRECTLY
								// into `<children>` (nest=false), uses uuid()
								// calculate.
								f({
									kind: "repeat",
									id: "children",
									label: "Children",
									repeat_mode: "user_controlled",
									children: [
										f({
											kind: "text",
											id: "case_name",
											label: "Child name",
											case_property_on: "child",
										}),
									],
								}),
							],
						},
					],
				},
			],
			caseTypes: [
				{
					name: "household",
					properties: [{ name: "case_name", label: "Name" }],
				},
				{
					name: "guardian",
					properties: [{ name: "case_name", label: "Name" }],
				},
				{
					name: "child",
					properties: [{ name: "case_name", label: "Name" }],
				},
			],
		});
		const { form, suite } = compile(doc);
		// Root-level guardian subcase wraps in `<subcase_N>` under
		// `<data>`. The index depends on the order subcase actions are
		// emitted (deriveCaseConfig iterates child buckets, so depends
		// on Map iteration order over insertion).
		expect(form).toMatch(
			/<subcase_\d>[\s\S]*<case[^>]*xmlns="http:\/\/commcarehq\.org\/case\/transaction\/v2"/,
		);
		// Repeat-context child subcase splices directly into `<children>`.
		expect(form).toContain(
			'<bind nodeset="/data/children/case/@case_id" calculate="uuid()"/>',
		);
		// Suite: guardian's session datum present (root-level subcase
		// emits a datum); child's datum absent (repeat-context skips).
		expect(suite).toMatch(/case_id_new_guardian_\d/);
		expect(suite).not.toMatch(/case_id_new_child_\d/);
	});
});
