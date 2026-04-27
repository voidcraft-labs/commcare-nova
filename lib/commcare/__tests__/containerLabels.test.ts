/**
 * End-to-end tests for empty-label container behavior in the XForm
 * emission path.
 *
 * The schema permits `group` / `repeat` fields with an empty or absent
 * `label` (via `containerFieldBase`). The wire emitter must coordinate:
 *
 *   1. No itext entry registered for empty labels (`addItext` already
 *      gates on truthy text).
 *   2. No `<label ref="jr:itext('${id}-label')"/>` element in the body
 *      output — emitting one with no matching itext would produce a
 *      dangling reference that `validateXFormXml` flags as
 *      `XFORM_MISSING_ITEXT`.
 *   3. No `appearance="field-list"` on transparent (empty-label) groups
 *      — that attribute drives single-page layout chrome, which
 *      contradicts the "no visual impact" runtime semantic.
 *
 * These tests round-trip a doc through `expandDoc` (which calls
 * `buildXForm` internally), pull the form's XForm attachment, and
 * assert the wire output. Renderer-side behavior (transparent group
 * via `InteractiveFormRenderer`'s short-circuit; empty-label repeat
 * keeps chrome but drops title text via `RepeatField.tsx`) is not
 * covered by these tests — the docstrings on `lib/domain/fields/group.ts`
 * and `lib/domain/fields/repeat.ts` document the runtime contract those
 * components implement, kept in lockstep with this wire-side behavior.
 */

import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { expandDoc } from "@/lib/commcare/expander";
import { validateXFormXml } from "@/lib/commcare/validator/xformValidator";

/**
 * Pull the first form's XForm XML out of an expanded HQ application's
 * `_attachments` map. The expander stores the XForm under a key
 * derived from the form's identifier; tests here only ever build a
 * single form so the first-and-only attachment is what we want.
 */
function firstFormXml(doc: ReturnType<typeof buildDoc>): string {
	const attachments = expandDoc(doc)._attachments;
	const first = Object.values(attachments)[0];
	if (typeof first !== "string") {
		throw new Error("expected the first attachment to be the XForm XML");
	}
	return first;
}

describe("empty-label containers — XForm emission", () => {
	it("emits no <label> and no appearance attribute for an empty-label group", () => {
		const doc = buildDoc({
			appName: "Empty-label group",
			modules: [
				{
					name: "M",
					forms: [
						{
							name: "F",
							type: "survey",
							fields: [
								f({
									kind: "group",
									id: "structural_only",
									label: "",
									children: [
										f({ kind: "text", id: "answer", label: "Answer" }),
									],
								}),
							],
						},
					],
				},
			],
		});
		const xml = firstFormXml(doc);
		// The dangling itext reference would be exactly this string.
		// Asserting its absence is the load-bearing check.
		expect(xml).not.toContain("jr:itext('structural_only-label')");
		// `appearance="field-list"` is suppressed for transparent groups —
		// dropping it matches the "no visual impact" runtime semantic.
		expect(xml).toContain('<group ref="/data/structural_only">');
		expect(xml).not.toMatch(
			/<group ref="\/data\/structural_only" appearance="field-list">/,
		);
		// Sanity: the child's input + label still render. Confirms we
		// stripped only the container's chrome, not the whole subtree.
		expect(xml).toContain('<input ref="/data/structural_only/answer">');
		expect(xml).toContain("jr:itext('answer-label')");
		// And the XForm passes Nova's own structural validator (which is
		// what `XFORM_MISSING_ITEXT` would have surfaced under).
		expect(validateXFormXml(xml, "F", "M")).toEqual([]);
	});

	it("emits no <label> element for an empty-label repeat", () => {
		const doc = buildDoc({
			appName: "Empty-label repeat",
			modules: [
				{
					name: "M",
					forms: [
						{
							name: "F",
							type: "survey",
							fields: [
								f({
									kind: "repeat",
									id: "iterations",
									label: "",
									children: [f({ kind: "text", id: "value", label: "Value" })],
								}),
							],
						},
					],
				},
			],
		});
		const xml = firstFormXml(doc);
		expect(xml).not.toContain("jr:itext('iterations-label')");
		// The `<repeat nodeset="...">` wrapper itself must still emit —
		// only its outer `<label>` is conditionally skipped.
		expect(xml).toContain('<repeat nodeset="/data/iterations">');
		expect(validateXFormXml(xml, "F", "M")).toEqual([]);
	});

	it("still emits the <label> element and appearance attribute for a labelled group (regression)", () => {
		// Confirms the fix only changes behavior for empty-label
		// containers — labelled groups continue to register their itext
		// entry, reference it from the body, AND keep
		// `appearance="field-list"` (Nova's default for visible groups).
		const doc = buildDoc({
			appName: "Labelled group",
			modules: [
				{
					name: "M",
					forms: [
						{
							name: "F",
							type: "survey",
							fields: [
								f({
									kind: "group",
									id: "section",
									label: "Visible Section",
									children: [
										f({ kind: "text", id: "answer", label: "Answer" }),
									],
								}),
							],
						},
					],
				},
			],
		});
		const xml = firstFormXml(doc);
		expect(xml).toContain("jr:itext('section-label')");
		expect(xml).toContain("<value>Visible Section</value>");
		expect(xml).toContain(
			'<group ref="/data/section" appearance="field-list">',
		);
		expect(validateXFormXml(xml, "F", "M")).toEqual([]);
	});
});
