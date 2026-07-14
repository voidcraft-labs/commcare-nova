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
 *     preserved in `vellum:jr__count` when the count contains hashtags
 *     and the count is a direct path (the hoisted shape carries no shadow).
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
import { validateXForm } from "@/lib/commcare/validator/xformOracle";

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
		// User-controlled repeats need NO repeat-bookkeeping setvalues
		// (those are query-bound's `<id>/@ids`/@count/@index/@id chain).
		// The always-on <meta> block contributes its own xforms-ready
		// setvalues, so we can't blanket-reject the event — assert
		// structurally on the repeat-bookkeeping refs instead.
		expect(xml).not.toMatch(
			/<setvalue[^>]*ref="\/data\/members[^"]*@(?:ids|count|index|id)"/,
		);
		// Children sit under the repeat's nodeset directly (no /item).
		expect(xml).toContain('<bind vellum:nodeset="#form/members/name"');
		expect(validateXForm(xml, "F", "M")).toEqual([]);
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
		// Hashtag-shorthand round-trip: the original `#form/...` is preserved in
		// `vellum:jr__count` — the shadow name Vellum actually reads for
		// `jr:count` (`parseVellumAttrs` maps `:` → `__`); the expanded path
		// lands on `jr:count`.
		expect(xml).toContain('vellum:jr__count="#form/desired_count"');
		expect(xml).toContain('jr:count="/data/desired_count"');
		expect(xml).toContain('jr:noAddRemove="true()"');
		// Repeat targets the parent path (no /item nesting in count_bound).
		expect(xml).toContain('<repeat nodeset="/data/iterations"');
		// Children sit at /data/iterations/<id>.
		expect(xml).toContain('<bind vellum:nodeset="#form/iterations/value"');
		expect(validateXForm(xml, "F", "M")).toEqual([]);
	});

	it("count_bound hoists a literal count into a hidden node (issue #14)", () => {
		// JavaRosa parses `jr:count` through `new XPathReference(countRef)`,
		// which throws `XPathTypeMismatchException("Expected XPath path, got
		// XPath expression: [...]")` when the value isn't a location path
		// (commcare-core XPathReference.java::getPathExpr). A literal `3`
		// would be rejected, so the emitter materializes a hidden node, seeds
		// it via setvalue on xforms-ready, and points jr:count at the node —
		// the canonical shape of group_relevancy_in_repeat.xml.
		const doc = buildDoc({
			appName: "Literal count",
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
									id: "rounds",
									label: "Rounds",
									repeat_mode: "count_bound",
									repeat_count: "3",
									children: [f({ kind: "text", id: "note", label: "Note" })],
								}),
							],
						},
					],
				},
			],
		});
		const xml = firstFormXml(doc);
		// The hidden count node sits at form root, seeded on xforms-ready.
		expect(xml).toContain("<__nova_count_rounds/>");
		expect(xml).toContain(
			'<bind nodeset="/data/__nova_count_rounds" type="xsd:int"/>',
		);
		expect(xml).toContain(
			'<setvalue event="xforms-ready" ref="/data/__nova_count_rounds" value="3"/>',
		);
		// jr:count points at the node, not the literal.
		expect(xml).toContain(
			'jr:count="/data/__nova_count_rounds" jr:noAddRemove="true()"',
		);
		expect(xml).not.toContain('jr:count="3"');
		// No editor shadow on the hoisted shape: `vellum:jr__count` is what
		// Vellum reads as the count's source of truth, and shadowing the raw
		// expression would make its next save write a non-path into `jr:count`.
		expect(xml).not.toContain("vellum:jr__count=");
		expect(xml).not.toContain("vellum:count=");
		expect(validateXForm(xml, "F", "M")).toEqual([]);
	});

	it("count_bound hoists an expression count into a hidden node (issue #14)", () => {
		const doc = buildDoc({
			appName: "Expression count",
			modules: [
				{
					name: "M",
					forms: [
						{
							name: "F",
							type: "survey",
							fields: [
								f({ kind: "int", id: "base", label: "Base" }),
								f({
									kind: "repeat",
									id: "slots",
									label: "Slots",
									repeat_mode: "count_bound",
									// Arithmetic over a form field — a non-path expression
									// JavaRosa would reject on `jr:count` directly.
									repeat_count: "#form/base + 2",
									children: [f({ kind: "text", id: "v", label: "V" })],
								}),
							],
						},
					],
				},
			],
		});
		const xml = firstFormXml(doc);
		expect(xml).toContain("<__nova_count_slots/>");
		// The expanded expression lands on the setvalue, not jr:count.
		expect(xml).toContain(
			'<setvalue event="xforms-ready" ref="/data/__nova_count_slots" value="/data/base + 2"/>',
		);
		expect(xml).toContain('jr:count="/data/__nova_count_slots"');
		// No editor shadow on the hoisted shape (see the literal-count test).
		expect(xml).not.toContain("vellum:jr__count=");
		expect(validateXForm(xml, "F", "M")).toEqual([]);
	});

	it("count_bound nested in a group hoists the count node to FORM ROOT", () => {
		// The synthetic count node must be a form-root sibling, never nested
		// inside the group — the `xforms-ready` setvalue fires at form load
		// and must have a node to write to outside any container scope.
		const doc = buildDoc({
			appName: "Nested count",
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
									id: "outer",
									label: "Outer",
									children: [
										f({
											kind: "repeat",
											id: "inner",
											label: "Inner",
											repeat_mode: "count_bound",
											repeat_count: "4",
											children: [f({ kind: "text", id: "x", label: "X" })],
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
		// Node + bind + setvalue all address /data/__nova_count_inner (root),
		// NOT /data/outer/__nova_count_inner.
		expect(xml).toContain(
			'<bind nodeset="/data/__nova_count_inner" type="xsd:int"/>',
		);
		expect(xml).toContain(
			'<setvalue event="xforms-ready" ref="/data/__nova_count_inner" value="4"/>',
		);
		expect(xml).toContain('jr:count="/data/__nova_count_inner"');
		expect(xml).not.toContain("/data/outer/__nova_count_inner");
		// The hidden node lives at the form-root data section, as a sibling
		// of the group — confirm it is NOT inside <outer>...</outer>.
		expect(xml).toMatch(
			/<__nova_count_inner\/>\s*<outer>|<outer>[\s\S]*?<\/outer>[\s\S]*?<__nova_count_inner\/>|<__nova_count_inner\/>[\s\S]*?<outer>/,
		);
		expect(validateXForm(xml, "F", "M")).toEqual([]);
	});

	it("two cousin count_bound repeats sharing an id hoist to distinct nodes", () => {
		// Field ids are unique only among SIBLINGS — cousins may share an id
		// (validator `duplicateFieldIds` scopes uniqueness to one level). The
		// hidden count node lives in the flat /data namespace, so naming it by
		// id alone would collide for two cousin count_bound repeats both named
		// `items`: duplicate data nodes/binds/setvalues and two repeats whose
		// `jr:count` point at the same node (one steals the other's
		// cardinality) — malformed XForm. The emitter must give each hoisted
		// node a form-wide-unique name.
		const doc = buildDoc({
			appName: "Cousin counts",
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
									id: "outer_a",
									label: "Outer A",
									children: [
										f({
											kind: "repeat",
											id: "items",
											label: "Items A",
											repeat_mode: "count_bound",
											repeat_count: "3",
											children: [f({ kind: "text", id: "a", label: "A" })],
										}),
									],
								}),
								f({
									kind: "group",
									id: "outer_b",
									label: "Outer B",
									children: [
										f({
											kind: "repeat",
											id: "items",
											label: "Items B",
											repeat_mode: "count_bound",
											repeat_count: "5",
											children: [f({ kind: "text", id: "b", label: "B" })],
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
		// Two distinct hidden nodes — the first cousin (document order) keeps
		// the bare name, the second is auto-suffixed.
		expect(xml).toContain("<__nova_count_items/>");
		expect(xml).toContain("<__nova_count_items_1/>");
		// Each carries its own count value and its own bind.
		expect(xml).toContain(
			'<setvalue event="xforms-ready" ref="/data/__nova_count_items" value="3"/>',
		);
		expect(xml).toContain(
			'<setvalue event="xforms-ready" ref="/data/__nova_count_items_1" value="5"/>',
		);
		expect(xml).toContain(
			'<bind nodeset="/data/__nova_count_items" type="xsd:int"/>',
		);
		expect(xml).toContain(
			'<bind nodeset="/data/__nova_count_items_1" type="xsd:int"/>',
		);
		// Each repeat's jr:count points at its OWN node — no shared target.
		expect(xml).toContain('jr:count="/data/__nova_count_items"');
		expect(xml).toContain('jr:count="/data/__nova_count_items_1"');
		// The cousins' itext LABEL ids are also disambiguated — by ancestry
		// prefix, not the count-node auto-suffix. Each repeat's label-itext id
		// carries its parent group's id, so the two `items` cousins land on
		// distinct `<text>` ids instead of both emitting `items-label` (which
		// JavaRosa rejects as a duplicate itext id at parse). This pins the
		// fix: the ancestry-threaded key, not just the absence of the error.
		expect(xml).toContain('<text id="outer_a-items-label">');
		expect(xml).toContain('<text id="outer_b-items-label">');
		// The serializer encodes `'` as `&apos;` (XML-spec-equivalent), so itext
		// references read `jr:itext(&apos;...&apos;)` on the wire.
		expect(xml).toContain("jr:itext(&apos;outer_a-items-label&apos;)");
		expect(xml).toContain("jr:itext(&apos;outer_b-items-label&apos;)");
		// Neither cousin emits the bare, colliding `items-label` id anymore.
		expect(xml).not.toContain('<text id="items-label">');
		// Well-formed and valid — no duplicate node path, no duplicate itext id.
		expect(validateXForm(xml, "F", "M")).toEqual([]);
	});

	it("count_bound with a path count still emits jr:count directly (regression)", () => {
		// Path counts (the existing `#form/...` shape) keep today's
		// behavior: jr:count points straight at the expanded path, no hoist.
		const doc = buildDoc({
			appName: "Path count",
			modules: [
				{
					name: "M",
					forms: [
						{
							name: "F",
							type: "survey",
							fields: [
								f({ kind: "int", id: "desired_count", label: "How many?" }),
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
		expect(xml).toContain('jr:count="/data/desired_count"');
		// No hidden node hoisted for a path count.
		expect(xml).not.toContain("__nova_count_iterations");
		expect(validateXForm(xml, "F", "M")).toEqual([]);
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
		// attribute, jr:noAddRemove suppresses Add/Remove. The repeat
		// serializes self-closing (`/>`) here because its only child is a
		// `hidden` field, which contributes no body element.
		expect(xml).toContain(
			'<repeat nodeset="/data/service_cases/item" jr:count="/data/service_cases/@count" jr:noAddRemove="true()"/>',
		);

		// Setvalue setup — four elements per Vellum's modeliteration
		// pattern. The serializer encodes single quotes inside the value
		// attributes as `&apos;` (XML-spec-equivalent — a conforming parser
		// decodes them back to `'`), so `join(' ', ...)` reads
		// `join(&apos; &apos;, ...)` on the wire.
		// xforms-ready: seed @ids and @count.
		expect(xml).toContain(
			`<setvalue event="xforms-ready" ref="/data/service_cases/@ids" value="join(&apos; &apos;, /data/service_case_ids)"/>`,
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

		expect(validateXForm(xml, "F", "M")).toEqual([]);
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
		expect(validateXForm(xml, "F", "M")).toEqual([]);
	});
});
