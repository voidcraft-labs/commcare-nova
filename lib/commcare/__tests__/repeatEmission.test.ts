// lib/commcare/__tests__/repeatEmission.test.ts
//
// The XForm a query repeat writes in each placement, and the node a count
// repeat's `jr:count` names. Every document is built through the production
// helpers, admitted by the validator, expanded to HQ's source and read back
// as a parsed XML tree; the assertions name elements, attributes and their
// order in that tree. The bytes are held by independent consumers: Core runs
// both placements in the native container family, and the proof lane's two
// form-builder saves hold what HQ's editor keeps. This test holds the
// decisions those runs check.
//
// Plausible failures: a model-iteration repeat written with Nova's live
// `@count` or a relative `@current_index` (which a save rewrites), its
// condition on the wrapper (which a save drops); a count-placement row that
// stays relevant past the end of the result; a generated bind asking for a
// `vellum:calculate`; the position or index node written when nothing reads
// it, or missing when something does; a generated name that ignores an
// authored sibling; a nested count placement whose paths leave the outer row;
// a direct count copied through a carrier, or a carrier dropped.

import AdmZip from "adm-zip";
import { type Element, isTag } from "domhandler";
import { findAll } from "domutils";
import { parseDocument } from "htmlparser2";
import { describe, expect, it } from "vitest";
import {
	buildDoc,
	caseListConfig,
	type FieldSpec,
	f,
} from "@/lib/__tests__/docHelpers";
import { compileCcz } from "@/lib/commcare/compiler";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { type BlueprintDoc, blueprintDocSchema, proseText } from "@/lib/domain";
import { expandDoc } from "../expander";
import { runValidation } from "../validator/runner";
import { TEST_RUNTIME_TARGET } from "./runtimeTargetFixture";

const tags = (element: Element): Element[] => element.children.filter(isTag);
const names = (element: Element): string[] => tags(element).map((e) => e.name);
function only(elements: readonly Element[]): Element {
	expect(elements).toHaveLength(1);
	const [element] = elements;
	if (element === undefined) throw new Error("Missing XML element.");
	return element;
}
const child = (parent: Element, name: string): Element =>
	only(tags(parent).filter((e) => e.name === name));

function admitted(doc: BlueprintDoc): BlueprintDoc {
	blueprintDocSchema.parse(toPersistableDoc(doc));
	expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
	return doc;
}

function survey(fields: FieldSpec[]): BlueprintDoc {
	return admitted(
		buildDoc({
			appName: "Repeats",
			modules: [
				{ name: "Visits", forms: [{ name: "Visit", type: "survey", fields }] },
			],
		}),
	);
}

/** The parsed source HQ receives for the document's one form. */
function source(doc: BlueprintDoc) {
	const xml = Object.values(expandDoc(doc)._attachments)[0];
	if (typeof xml !== "string") throw new Error("Missing form attachment.");
	return parsedForm(xml);
}

function parsedForm(xml: string) {
	const html = only(
		parseDocument(xml, { xmlMode: true }).children.filter(isTag),
	);
	const model = child(child(html, "h:head"), "model");
	const data = child(
		only(
			tags(model).filter(
				(e) => e.name === "instance" && e.attribs.src === undefined,
			),
		),
		"data",
	);
	const binds = tags(model).filter((e) => e.name === "bind");
	return {
		data,
		body: child(html, "h:body"),
		binds,
		bind: (nodeset: string) =>
			only(binds.filter((e) => e.attribs.nodeset === nodeset)).attribs,
		setvalues: tags(model).filter((e) => e.name === "setvalue"),
		repeats: findAll((e) => e.name === "repeat", [html]),
	};
}

const text = (id: string) => f({ kind: "text", id, label: proseText(id) });
const queryRepeat = (
	id: string,
	idsQuery: string,
	children: FieldSpec[],
	extra: Partial<FieldSpec> = {},
) =>
	f({
		kind: "repeat",
		id,
		label: proseText(id),
		repeat_mode: "query_bound",
		data_source: { ids_query: idsQuery },
		children,
		...extra,
	} as FieldSpec);

describe("a query repeat in model iteration", () => {
	// A query reading no answer, at the root, under no changing group.
	const form = source(
		survey([
			text("show"),
			queryRepeat("r", "'a b'", [text("answer")], {
				relevant: "#form/show = 'yes'",
			}),
		]),
	);
	const wrapper = child(form.data, "r");

	it("writes HQ's form builder's data shape", () => {
		expect(wrapper.attribs).toEqual({
			ids: "",
			count: "",
			current_index: "",
			"vellum:role": "Repeat",
		});
		expect(names(wrapper)).toEqual(["item"]);
		expect(child(wrapper, "item").attribs).toEqual({
			id: "",
			index: "",
			"jr:template": "",
		});
		expect(names(child(wrapper, "item"))).toEqual(["answer"]);
	});

	it("binds @current_index first, absolute, writes no @count bind, and puts the condition on the row", () => {
		const own = form.binds
			.map((e) => e.attribs)
			.filter((attribs) => attribs.nodeset.startsWith("/data/r"));
		expect(own[0]).toEqual({
			nodeset: "/data/r/@current_index",
			calculate: "count(/data/r/item)",
		});
		expect(own[1]).toEqual({
			"vellum:nodeset": "#form/r/item",
			nodeset: "/data/r/item",
			relevant: "/data/show = 'yes'",
			"vellum:relevant": "#form/show = 'yes'",
		});
		expect(own.map((attribs) => attribs.nodeset)).not.toContain(
			"/data/r/@count",
		);
		expect(own.map((attribs) => attribs.nodeset)).not.toContain("/data/r");
	});

	it("writes the four setvalues in the form builder's order, with its events", () => {
		expect(
			form.setvalues
				.map((e) => e.attribs)
				.filter((attribs) => attribs.ref.startsWith("/data/r")),
		).toEqual([
			{
				event: "xforms-ready",
				ref: "/data/r/@ids",
				value: "join(' ', 'a b')",
			},
			{
				event: "xforms-ready",
				ref: "/data/r/@count",
				value: "count-selected(/data/r/@ids)",
			},
			{
				event: "jr-insert",
				ref: "/data/r/item/@index",
				value: "int(/data/r/@current_index)",
			},
			{
				event: "jr-insert",
				ref: "/data/r/item/@id",
				value: "selected-at(/data/r/@ids, ../@index)",
			},
		]);
	});

	it("counts the repeat from @count and shadows its row, as the form builder writes it", () => {
		const repeat = only(form.repeats);
		// The form builder's own fixture writes no `vellum:jr__count` here:
		// `@count` names no question it can spell as a hashtag
		// (Vellum `tests/static/modeliteration/case-list-iteration-with-questions.xml`).
		expect(repeat.attribs).toEqual({
			"jr:noAddRemove": "true()",
			nodeset: "/data/r/item",
			"vellum:nodeset": "#form/r/item",
			"jr:count": "/data/r/@count",
		});
		const group = repeat.parent as Element;
		expect(group.name).toBe("group");
		expect(group.attribs).toEqual({});
		expect((group.parent as Element).name).toBe("h:body");
	});
});

describe("a query repeat in the count placement", () => {
	// The query reads an answer, so model iteration cannot run it.
	const countPlacement = (
		rowChildren: FieldSpec[] = [text("answer")],
		extra: Partial<FieldSpec> = {},
	) =>
		source(
			survey([
				text("pick"),
				queryRepeat("r", "#form/pick", rowChildren, extra),
			]),
		);

	it("holds its ids and count in the wrapper and its id in each row, before the authored children", () => {
		const form = countPlacement();
		const wrapper = child(form.data, "r");
		expect(wrapper.attribs).toEqual({});
		expect(names(wrapper)).toEqual([
			"nova_query_ids_r",
			"nova_query_count_r",
			"item",
		]);
		const row = child(wrapper, "item");
		expect(row.attribs).toEqual({ "jr:template": "" });
		expect(names(row)).toEqual(["nova_query_id_r", "answer"]);
		// The count placement fills its nodes by calculation alone.
		expect(form.setvalues).toEqual([]);
	});

	it("calculates the ids from the query, the count as a whole number, and each row's id by its position", () => {
		const form = countPlacement();
		expect(form.bind("/data/r/nova_query_ids_r")).toEqual({
			nodeset: "/data/r/nova_query_ids_r",
			"vellum:nodeset": "#form/r/nova_query_ids_r",
			calculate: "join(' ', /data/pick)",
		});
		expect(form.bind("/data/r/nova_query_count_r")).toEqual({
			type: "xsd:int",
			nodeset: "/data/r/nova_query_count_r",
			"vellum:nodeset": "#form/r/nova_query_count_r",
			calculate: "count-selected(../nova_query_ids_r)",
		});
		expect(form.bind("/data/r/item/nova_query_id_r")).toEqual({
			nodeset: "/data/r/item/nova_query_id_r",
			"vellum:nodeset": "#form/r/item/nova_query_id_r",
			calculate:
				"if(position(..) < ../../nova_query_count_r, selected-at(../../nova_query_ids_r, position(..)), '')",
		});
		for (const bind of form.binds.filter((e) =>
			e.attribs.nodeset.includes("nova_query_"),
		))
			expect(bind.attribs).not.toHaveProperty("vellum:calculate");
	});

	it("hides a row past the end of the result, with or without an authored condition", () => {
		expect(countPlacement().bind("/data/r/item")).toEqual({
			"vellum:nodeset": "#form/r/item",
			nodeset: "/data/r/item",
			relevant: "position(.) < ../nova_query_count_r",
		});
		const conditioned = countPlacement([text("answer")], {
			relevant: "#form/pick = 'a' or #form/pick = 'b'",
		});
		expect(conditioned.bind("/data/r/item")).toEqual({
			"vellum:nodeset": "#form/r/item",
			nodeset: "/data/r/item",
			relevant:
				"(/data/pick = 'a' or /data/pick = 'b') and position(.) < ../nova_query_count_r",
			"vellum:relevant":
				"(#form/pick = 'a' or #form/pick = 'b') and position(.) < ../nova_query_count_r",
		});
		expect(conditioned.binds.map((e) => e.attribs.nodeset)).not.toContain(
			"/data/r",
		);
	});

	it("wraps the repeat's group in a group on the wrapper with no label, appearance or bind", () => {
		const form = countPlacement();
		const repeat = only(form.repeats);
		expect(repeat.attribs).toEqual({
			"jr:noAddRemove": "true()",
			nodeset: "/data/r/item",
			"vellum:nodeset": "#form/r/item",
			"jr:count": "/data/r/nova_query_count_r",
			"vellum:jr__count": "#form/r/nova_query_count_r",
		});
		const group = repeat.parent as Element;
		expect(group.attribs).toEqual({});
		expect(names(group)).toEqual(["label", "repeat"]);
		const outer = group.parent as Element;
		expect(outer.name).toBe("group");
		expect(outer.attribs).toEqual({ ref: "/data/r" });
		expect(names(outer)).toEqual(["group"]);
		expect((outer.parent as Element).name).toBe("h:body");
	});

	it("writes the position and index nodes only while an expression reads them", () => {
		const unread = countPlacement();
		expect(names(child(unread.data, "r"))).not.toContain(
			"nova_query_position_r",
		);
		expect(names(child(child(unread.data, "r"), "item"))).not.toContain(
			"nova_query_index_r",
		);
		const read = countPlacement([
			text("answer"),
			f({ kind: "hidden", id: "ordinal", calculate: "current()/../@index" }),
			f({
				kind: "hidden",
				id: "made",
				calculate: "current()/../../@current_index",
			}),
		]);
		const wrapper = child(read.data, "r");
		expect(names(wrapper)).toEqual([
			"nova_query_ids_r",
			"nova_query_count_r",
			"nova_query_position_r",
			"item",
		]);
		expect(names(child(wrapper, "item"))).toEqual([
			"nova_query_id_r",
			"nova_query_index_r",
			"answer",
			"ordinal",
			"made",
		]);
		expect(read.bind("/data/r/nova_query_position_r")).toEqual({
			nodeset: "/data/r/nova_query_position_r",
			"vellum:nodeset": "#form/r/nova_query_position_r",
			calculate: "count(../item)",
		});
		expect(read.bind("/data/r/item/nova_query_index_r")).toEqual({
			nodeset: "/data/r/item/nova_query_index_r",
			"vellum:nodeset": "#form/r/item/nova_query_index_r",
			calculate: "position(..)",
		});
		expect(read.bind("/data/r/item/ordinal").calculate).toBe(
			"current()/../nova_query_index_r",
		);
		expect(read.bind("/data/r/item/made").calculate).toBe(
			"current()/../../nova_query_position_r",
		);
	});

	it("suffixes a generated name an authored child of the row already holds", () => {
		const form = countPlacement([
			text("nova_query_id_r"),
			text("nova_query_index_r"),
			f({ kind: "hidden", id: "ordinal", calculate: "current()/../@index" }),
			f({ kind: "hidden", id: "record", calculate: "current()/../@id" }),
		]);
		const row = child(child(form.data, "r"), "item");
		expect(names(row)).toEqual([
			"nova_query_id_r_1",
			"nova_query_index_r_1",
			"nova_query_id_r",
			"nova_query_index_r",
			"ordinal",
			"record",
		]);
		expect(form.bind("/data/r/item/record").calculate).toBe(
			"current()/../nova_query_id_r_1",
		);
		expect(form.bind("/data/r/item/ordinal").calculate).toBe(
			"current()/../nova_query_index_r_1",
		);
		expect(form.bind("/data/r/item/nova_query_id_r_1").calculate).toBe(
			"if(position(..) < ../../nova_query_count_r, selected-at(../../nova_query_ids_r, position(..)), '')",
		);
	});

	it("keeps a nested count placement's nodes inside each outer row, under a model-iteration outer repeat", () => {
		const form = source(
			survey([
				queryRepeat("outer", "'a b'", [
					f({
						kind: "hidden",
						id: "child_ids",
						calculate: "if(current()/../@id = 'a', 'a1 a2', 'b1')",
					}),
					queryRepeat("inner", "#form/outer/child_ids", [text("answer")]),
				]),
			]),
		);
		// The outer repeat reads no answer and sits in nothing: model iteration.
		expect(child(form.data, "outer").attribs["vellum:role"]).toBe("Repeat");
		const inner = child(child(child(form.data, "outer"), "item"), "inner");
		expect(names(inner)).toEqual([
			"nova_query_ids_inner",
			"nova_query_count_inner",
			"item",
		]);
		expect(form.bind("/data/outer/item/inner/nova_query_ids_inner")).toEqual({
			nodeset: "/data/outer/item/inner/nova_query_ids_inner",
			"vellum:nodeset": "#form/outer/item/inner/nova_query_ids_inner",
			calculate: "join(' ', /data/outer/item/child_ids)",
		});
		expect(
			form.bind("/data/outer/item/inner/item/nova_query_id_inner").calculate,
		).toBe(
			"if(position(..) < ../../nova_query_count_inner, selected-at(../../nova_query_ids_inner, position(..)), '')",
		);
		const [outerRepeat, innerRepeat] = form.repeats;
		// An absolute count inside a repeat resolves within the current outer
		// row (`XFormParser` reads `jr:count` through `getAbsRef`).
		expect(innerRepeat.attribs["jr:count"]).toBe(
			"/data/outer/item/inner/nova_query_count_inner",
		);
		const wrapperGroup = innerRepeat.parent?.parent as Element;
		expect(wrapperGroup.attribs).toEqual({ ref: "/data/outer/item/inner" });
		expect(wrapperGroup.parent).toBe(outerRepeat);
		// The outer model iteration seeds at form start; the inner one has no
		// setvalue at all.
		expect(form.setvalues.map((e) => [e.attribs.event, e.attribs.ref])).toEqual(
			[
				["xforms-ready", "/data/outer/@ids"],
				["xforms-ready", "/data/outer/@count"],
				["jr-insert", "/data/outer/item/@index"],
				["jr-insert", "/data/outer/item/@id"],
			],
		);
	});

	it("keeps a single repeat subcase's case block as the row's first child", () => {
		const nameWriter = (caseType: string) =>
			f({
				kind: "text",
				id: "case_name",
				caseWrite: { caseType, property: "case_name" },
			});
		const list = () => caseListConfig([{ field: "case_name", header: "Name" }]);
		const doc = admitted(
			buildDoc({
				appName: "Repeated cases",
				caseTypes: ["household", "member"].map((name) => ({
					name,
					...(name === "member" && { parent_type: "household" }),
					properties: [{ name: "case_name", label: proseText("Name") }],
				})),
				modules: [
					{
						name: "Households",
						caseType: "household",
						caseListConfig: list(),
						forms: [
							{
								name: "Register",
								type: "registration",
								fields: [
									nameWriter("household"),
									queryRepeat("members", "#form/case_name", [
										nameWriter("member"),
									]),
								],
							},
						],
					},
					{
						name: "Members",
						caseType: "member",
						caseListOnly: true,
						caseListConfig: list(),
						forms: [],
					},
				],
			}),
		);
		const zip = new AdmZip(
			compileCcz(expandDoc(doc), doc.appName, doc, {
				runtimeTarget: TEST_RUNTIME_TARGET,
			}),
		);
		const form = parsedForm(zip.readAsText("modules-0/forms-0.xml"));
		expect(names(child(child(form.data, "members"), "item"))).toEqual([
			"case",
			"nova_query_id_members",
			"case_name",
			"nova_trimmed_case_name",
		]);
	});
});

describe("a count repeat's jr:count", () => {
	const countRepeat = (id: string, count: string) =>
		f({
			kind: "repeat",
			id,
			label: proseText(id),
			repeat_mode: "count_bound",
			repeat_count: count,
			children: [text("note")],
		});
	const form = source(
		survey([
			f({ kind: "int", id: "n", label: proseText("How many") }),
			f({
				kind: "single_select",
				id: "pick",
				label: proseText("Pick"),
				options: [
					{ value: "1", label: "One" },
					{ value: "2", label: "Two" },
				],
			} as FieldSpec),
			f({ kind: "hidden", id: "calc", calculate: "#form/n + 1" }),
			countRepeat("by_question", "#form/n"),
			countRepeat("by_select", "#form/pick"),
			countRepeat("by_hidden", "#form/calc"),
			countRepeat("by_expression", "#form/n + 1"),
		]),
	);

	it("names an int question, an integer single select and an int-calculated Hidden Value directly", () => {
		expect(
			form.repeats.map((repeat) => [
				repeat.attribs.nodeset,
				repeat.attribs["jr:count"],
				repeat.attribs["vellum:jr__count"],
			]),
		).toEqual([
			["/data/by_question", "/data/n", "#form/n"],
			["/data/by_select", "/data/pick", "#form/pick"],
			["/data/by_hidden", "/data/calc", "#form/calc"],
			[
				"/data/by_expression",
				"/data/nova_count_by_expression",
				"#form/nova_count_by_expression",
			],
		]);
		expect(names(form.data)).toEqual([
			"n",
			"pick",
			"calc",
			"by_question",
			"by_select",
			"by_hidden",
			"by_expression",
			"nova_count_by_expression",
		]);
	});

	it("gives any other count a whole-number carrier", () => {
		expect(form.bind("/data/nova_count_by_expression")).toEqual({
			type: "xsd:int",
			nodeset: "/data/nova_count_by_expression",
			"vellum:nodeset": "#form/nova_count_by_expression",
			calculate: "/data/n + 1",
		});
	});
});
