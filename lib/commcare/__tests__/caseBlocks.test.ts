/**
 * Unit tests for the case-block XForm splicer (`xform/caseBlocks.ts`).
 *
 * These exercise `addCaseBlocks` in isolation against hand-built
 * `FormActions` + a minimal host XForm, so each emission branch can be
 * asserted directly — including the branches the full compile pipeline can't
 * reach today (an active subcase `close_condition` has no authoring source,
 * so only a synthetic `FormActions` here drives it). The full-pipeline parity
 * against CCHQ fixtures lives in `compiler.test.ts`; this file pins the leaf.
 */

import { describe, expect, it } from "vitest";
import {
	alwaysCondition,
	emptyFormActions,
	type FormActions,
	ifCondition,
	neverCondition,
	type OpenSubCaseAction,
} from "@/lib/commcare";
import { addCaseBlocks } from "@/lib/commcare/xform/caseBlocks";

/**
 * The serializer is the sole escaping authority and encodes XPath `'` as
 * `&apos;` in attribute values. De-escape before substring assertions so the
 * expected strings stay readable as the XPath the runtime evaluates.
 */
function deApos(xml: string): string {
	return xml.replaceAll("&apos;", "'");
}

/**
 * Minimal host XForm with a `<data>` instance node + a `<model>` carrying one
 * bind per named field and an `<itext>`. Enough for `addCaseBlocks` to resolve
 * `<data>` / `<model>` and splice into them — mirrors the shape `buildXForm`
 * emits without dragging in the full builder.
 */
function hostXForm(fieldIds: string[]): string {
	const dataChildren = fieldIds.map((id) => `<${id}/>`).join("");
	const binds = fieldIds
		.map((id) => `<bind nodeset="/data/${id}" type="xsd:string"/>`)
		.join("");
	return (
		'<?xml version="1.0"?>\n' +
		'<h:html xmlns:h="http://www.w3.org/1999/xhtml" xmlns="http://www.w3.org/2002/xforms">' +
		"<h:head><model>" +
		`<instance><data>${dataChildren}</data></instance>` +
		binds +
		'<itext><translation lang="en"/></itext>' +
		"</model></h:head><h:body/></h:html>"
	);
}

/** Build an `OpenSubCaseAction` with sensible defaults, overridable per test. */
function subcase(overrides: Partial<OpenSubCaseAction>): OpenSubCaseAction {
	return {
		doc_type: "OpenSubCaseAction",
		case_type: "child_type",
		name_update: { question_path: "/data/child_name", update_mode: "always" },
		reference_id: "",
		case_properties: {},
		repeat_context: "",
		relationship: "child",
		close_condition: neverCondition(),
		condition: alwaysCondition(),
		...overrides,
	};
}

describe("addCaseBlocks — case preload", () => {
	it("emits a casedb-read setvalue per preloaded property", () => {
		const actions = emptyFormActions();
		actions.update_case.condition = alwaysCondition();
		actions.update_case.update = {
			weight: { question_path: "/data/weight", update_mode: "always" },
		};
		actions.case_preload.condition = alwaysCondition();
		actions.case_preload.preload = { "/data/weight": "weight" };

		const out = addCaseBlocks(hostXForm(["weight"]), actions, "patient");

		expect(deApos(out)).toContain(
			'<setvalue ref="/data/weight" event="xforms-ready" value="instance(\'casedb\')/casedb/case[@case_id=instance(\'commcaresession\')/session/data/case_id]/weight"',
		);
	});

	it("emits nothing case-related when there are no actions", () => {
		const out = addCaseBlocks(hostXForm(["q"]), emptyFormActions(), "patient");
		expect(out).not.toContain("commcarehq.org/case/transaction");
		expect(out).not.toContain("instance('casedb')");
	});
});

describe("addCaseBlocks — case-name required", () => {
	it("merges required=true() onto the case-name source field's bind", () => {
		const actions = emptyFormActions();
		actions.open_case.condition = alwaysCondition();
		actions.open_case.name_update.question_path = "/data/patient_name";

		const out = addCaseBlocks(hostXForm(["patient_name"]), actions, "patient");

		// The field's own bind gains required="true()" — not a second bind.
		expect(out).toContain(
			'<bind nodeset="/data/patient_name" type="xsd:string" required="true()"',
		);
		// Exactly one bind targets that nodeset.
		const bindCount = out.split('nodeset="/data/patient_name"').length - 1;
		expect(bindCount).toBe(1);
	});
});

describe("addCaseBlocks — subcase owner_id (basic module always autosets)", () => {
	function withSubcase(relationship: "child" | "extension"): string {
		const actions: FormActions = emptyFormActions();
		actions.open_case.condition = alwaysCondition();
		actions.open_case.name_update.question_path = "/data/parent_name";
		actions.subcases = [
			subcase({
				relationship,
				name_update: {
					question_path: "/data/child_name",
					update_mode: "always",
				},
			}),
		];
		return addCaseBlocks(
			hostXForm(["parent_name", "child_name"]),
			actions,
			"patient",
		);
	}

	// The basic module Nova uploads runs `autoset_owner_id_for_subcase`
	// (`'owner_id' not in case_properties`, relationship-independent), so CCHQ
	// regenerates the userID owner_id bind on EVERY subcase. The unowned-
	// extension sentinel is an advanced-module-only shape Nova never emits.
	it("binds subcase owner_id to the submitting user for child AND extension", () => {
		for (const relationship of ["child", "extension"] as const) {
			const out = withSubcase(relationship);
			expect(out).not.toContain("<owner_id>-</owner_id>");
			expect(out).toContain(
				'<bind nodeset="/data/subcase_0/case/create/owner_id" calculate="/data/meta/userID"',
			);
		}
	});

	it("carries the extension relationship on the <index>, not on owner_id", () => {
		const out = withSubcase("extension");
		expect(out).toContain('relationship="extension"');
	});
});

describe("addCaseBlocks — subcase case-name required", () => {
	it("merges required=true() onto the subcase name field's bind too", () => {
		const actions = emptyFormActions();
		actions.open_case.condition = alwaysCondition();
		actions.open_case.name_update.question_path = "/data/patient_name";
		actions.subcases = [
			subcase({
				name_update: {
					question_path: "/data/child_name",
					update_mode: "always",
				},
			}),
		];
		const out = addCaseBlocks(
			hostXForm(["patient_name", "child_name"]),
			actions,
			"patient",
		);
		// Both the primary and the subcase name source fields get required.
		expect(out).toContain(
			'<bind nodeset="/data/patient_name" type="xsd:string" required="true()"',
		);
		expect(out).toContain(
			'<bind nodeset="/data/child_name" type="xsd:string" required="true()"',
		);
	});
});

describe("addCaseBlocks — subcase close (dormant branch)", () => {
	it("emits no <close> on a subcase when close_condition is never", () => {
		const actions = emptyFormActions();
		actions.open_case.condition = alwaysCondition();
		actions.open_case.name_update.question_path = "/data/parent_name";
		actions.subcases = [subcase({ close_condition: neverCondition() })];
		const out = addCaseBlocks(hostXForm(["parent_name"]), actions, "patient");
		expect(out).not.toContain('nodeset="/data/subcase_0/case/close"');
	});

	it("emits a conditional <close> + relevant bind when close_condition is active", () => {
		const actions = emptyFormActions();
		actions.open_case.condition = alwaysCondition();
		actions.open_case.name_update.question_path = "/data/parent_name";
		actions.subcases = [
			subcase({
				close_condition: ifCondition("/data/done", "yes"),
			}),
		];
		const out = addCaseBlocks(
			hostXForm(["parent_name", "done"]),
			actions,
			"patient",
		);
		// Empty elements self-close under the serializer's xmlMode opts.
		expect(out).toContain("<close/>");
		expect(deApos(out)).toContain(
			'<bind nodeset="/data/subcase_0/case/close" relevant="/data/done = \'yes\'"',
		);
		// Wire order matches CCHQ's basic-module path (create / update / close /
		// index): `add_case_updates` → `add_close_block` → `add_index_ref`, so
		// the subcase's `<update>` precedes `<close>` precedes `<index>`.
		expect(out.indexOf("<update/>")).toBeLessThan(out.indexOf("<close/>"));
		expect(out.indexOf("<close/>")).toBeLessThan(out.indexOf("<index>"));
	});
});
