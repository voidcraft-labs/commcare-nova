/**
 * End-to-end tests for the three `repeat_mode` variants in the XForm
 * emission path.
 *
 * Each test round-trips a doc through `expandDoc` / `buildXForm`, pulls
 * the form's XForm attachment, and asserts mode-specific wire shape:
 *
 *   - `user_controlled`: bare `<repeat nodeset="...">` — no `jr:count`,
 *     no `jr:noAddRemove`, no setvalue setup. Children's bind paths
 *     hang directly off the repeat's nodeset.
 *
 *   - `count_bound`: `<repeat nodeset="..." jr:count="<expanded XPath>"
 *     jr:noAddRemove="true()">`. The hashtag-shorthand version is
 *     preserved in `vellum:count` when the count contains hashtags.
 *
 *   - `query_bound`: Vellum's "model iteration" pattern. The data
 *     section nests `<item ...>` under the outer container, the body's
 *     `<repeat>` targets `<path>/item`, `jr:count="<path>/@count"`, and
 *     four `<setvalue>` elements seed `@ids`, `@count`, `@index`,
 *     `@id` on `xforms-ready` and `jr-insert`. Children's bind paths
 *     pick up the extra `/item` segment.
 */

import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { expandDoc } from "@/lib/commcare/expander";
import { validateXFormXml } from "@/lib/commcare/validator/xformValidator";

function firstFormXml(doc: ReturnType<typeof buildDoc>): string {
	const attachments = expandDoc(doc)._attachments;
	const first = Object.values(attachments)[0];
	if (typeof first !== "string") {
		throw new Error("expected the first attachment to be the XForm XML");
	}
	return first;
}

describe("repeat modes — XForm emission", () => {
	it("user_controlled emits a bare <repeat> with no jr:count", () => {
		const doc = buildDoc({
			appName: "User-controlled repeat",
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
									id: "members",
									label: "Household members",
									repeat_mode: "user_controlled",
									children: [f({ kind: "text", id: "name", label: "Name" })],
								}),
							],
						},
					],
				},
			],
		});
		const xml = firstFormXml(doc);
		expect(xml).toContain('<repeat nodeset="/data/members">');
		expect(xml).not.toContain("jr:count");
		expect(xml).not.toContain("jr:noAddRemove");
		// Setvalue setup is query-bound only.
		expect(xml).not.toContain("xforms-ready");
		// Children sit under the repeat's nodeset directly (no /item).
		expect(xml).toContain('<bind vellum:nodeset="#form/members/name"');
		expect(validateXFormXml(xml, "F", "M")).toEqual([]);
	});

	it("count_bound emits jr:count + jr:noAddRemove with hashtag expansion", () => {
		const doc = buildDoc({
			appName: "Count-bound repeat",
			modules: [
				{
					name: "M",
					forms: [
						{
							name: "F",
							type: "survey",
							fields: [
								f({
									kind: "int",
									id: "desired_count",
									label: "How many?",
								}),
								f({
									kind: "repeat",
									id: "iterations",
									label: "Iterations",
									repeat_mode: "count_bound",
									repeat_count: "#form/desired_count",
									children: [f({ kind: "text", id: "value", label: "Value" })],
								}),
							],
						},
					],
				},
			],
		});
		const xml = firstFormXml(doc);
		// Hashtag-shorthand round-trip: the original `#form/...` is
		// preserved in `vellum:count`; the expanded path lands on `jr:count`.
		expect(xml).toContain('vellum:count="#form/desired_count"');
		expect(xml).toContain('jr:count="/data/desired_count"');
		expect(xml).toContain('jr:noAddRemove="true()"');
		// Repeat targets the parent path (no /item nesting in count_bound).
		expect(xml).toContain('<repeat nodeset="/data/iterations"');
		// Children sit at /data/iterations/<id>.
		expect(xml).toContain('<bind vellum:nodeset="#form/iterations/value"');
		expect(validateXFormXml(xml, "F", "M")).toEqual([]);
	});

	it("query_bound emits the model-iteration setvalue setup + /item nesting", () => {
		const doc = buildDoc({
			appName: "Query-bound repeat",
			modules: [
				{
					name: "M",
					forms: [
						{
							name: "F",
							type: "survey",
							fields: [
								f({
									kind: "hidden",
									id: "service_case_ids",
									calculate:
										"join(' ', instance('casedb')/casedb/case[@case_type='service']/@case_id)",
								}),
								f({
									kind: "repeat",
									id: "service_cases",
									label: "Service cases",
									repeat_mode: "query_bound",
									data_source: { ids_query: "#form/service_case_ids" },
									children: [
										f({
											kind: "hidden",
											id: "case_id",
											calculate: "current()/../@id",
										}),
									],
								}),
							],
						},
					],
				},
			],
		});
		const xml = firstFormXml(doc);

		// Body: repeat targets /item, jr:count on the parent's @count
		// attribute, jr:noAddRemove suppresses Add/Remove.
		expect(xml).toContain(
			'<repeat nodeset="/data/service_cases/item" jr:count="/data/service_cases/@count" jr:noAddRemove="true()">',
		);

		// Setvalue setup — four elements per Vellum's modeliteration
		// pattern. Single quotes inside the value attributes are NOT
		// XML-escaped (escapeXml only escapes the wrapping quote — `"` —
		// plus `<`, `>`, `&`); they appear literal in the output.
		// xforms-ready: seed @ids and @count.
		expect(xml).toContain(
			`<setvalue event="xforms-ready" ref="/data/service_cases/@ids" value="join(' ', /data/service_case_ids)"/>`,
		);
		expect(xml).toContain(
			`<setvalue event="xforms-ready" ref="/data/service_cases/@count" value="count-selected(/data/service_cases/@ids)"/>`,
		);
		// jr-insert: per-iteration @index and @id.
		expect(xml).toContain(
			`<setvalue event="jr-insert" ref="/data/service_cases/item/@index" value="int(/data/service_cases/@current_index)"/>`,
		);
		expect(xml).toContain(
			`<setvalue event="jr-insert" ref="/data/service_cases/item/@id" value="selected-at(/data/service_cases/@ids, ../@index)"/>`,
		);

		// Data section nests <item> under the outer container. The
		// outer container carries four load-bearing attribute slots:
		// `ids` and `count` (seeded by setvalue), `current_index`
		// (driven by the `<bind calculate>` below — required for the
		// per-iteration @index setvalue to advance), and Vellum's
		// `vellum:role="Repeat"` round-trip metadata.
		expect(xml).toContain(
			'<service_cases ids="" count="" current_index="" vellum:role="Repeat"><item id="" index="" jr:template="">',
		);

		// `@current_index` calculate bind — without this, JavaRosa
		// never advances `current_index` and every iteration's @id
		// resolves to position 0.
		expect(xml).toContain(
			'<bind nodeset="/data/service_cases/@current_index" calculate="count(/data/service_cases/item)"/>',
		);

		// Children's binds pick up the /item segment.
		expect(xml).toContain(
			'<bind vellum:nodeset="#form/service_cases/item/case_id"',
		);

		expect(validateXFormXml(xml, "F", "M")).toEqual([]);
	});

	it("query_bound nested inside another repeat coerces @ids/@count setvalues to jr-insert", () => {
		// Nested model-iteration: each outer iteration must re-seed the
		// inner repeat's @ids/@count, otherwise the inner sees only the
		// first outer's context. Vellum's pattern flips both events from
		// xforms-ready to jr-insert; @index/@id stay jr-insert regardless.
		const doc = buildDoc({
			appName: "Nested query_bound",
			modules: [
				{
					name: "M",
					forms: [
						{
							name: "F",
							type: "survey",
							fields: [
								f({
									kind: "hidden",
									id: "client_ids",
									calculate:
										"join(' ', instance('casedb')/casedb/case[@case_type='client']/@case_id)",
								}),
								f({
									kind: "repeat",
									id: "clients",
									label: "Clients",
									repeat_mode: "query_bound",
									data_source: { ids_query: "#form/client_ids" },
									children: [
										f({
											kind: "hidden",
											id: "service_ids",
											calculate:
												"join(' ', instance('casedb')/casedb/case[@case_type='service'][index/parent = current()/../@id]/@case_id)",
										}),
										f({
											kind: "repeat",
											id: "services",
											label: "Services",
											repeat_mode: "query_bound",
											data_source: {
												ids_query: "#form/clients/item/service_ids",
											},
											children: [
												f({
													kind: "hidden",
													id: "service_id",
													calculate: "current()/../@id",
												}),
											],
										}),
									],
								}),
							],
						},
					],
				},
			],
		});
		const xml = firstFormXml(doc);
		// Outer repeat: not nested, fires xforms-ready as usual.
		expect(xml).toContain(
			'<setvalue event="xforms-ready" ref="/data/clients/@ids"',
		);
		expect(xml).toContain(
			'<setvalue event="xforms-ready" ref="/data/clients/@count"',
		);
		// Inner repeat: nested inside `clients` — its seed setvalues
		// must fire jr-insert, not xforms-ready, so each outer iteration
		// re-resolves the inner ids_query in its own row context.
		expect(xml).toContain(
			'<setvalue event="jr-insert" ref="/data/clients/item/services/@ids"',
		);
		expect(xml).toContain(
			'<setvalue event="jr-insert" ref="/data/clients/item/services/@count"',
		);
		// @index and @id always fire jr-insert regardless of nesting.
		expect(xml).toContain(
			'<setvalue event="jr-insert" ref="/data/clients/item/services/item/@index"',
		);
		expect(xml).toContain(
			'<setvalue event="jr-insert" ref="/data/clients/item/services/item/@id"',
		);
		expect(validateXFormXml(xml, "F", "M")).toEqual([]);
	});
});
