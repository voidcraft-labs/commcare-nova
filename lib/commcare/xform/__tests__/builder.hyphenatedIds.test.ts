/**
 * A form whose question IDs hold hyphens, as HQ's form builder writes them
 * when a person duplicates a question (`copy-1-of-<id>`). Its source passes
 * the XForm and binding oracles, and every bind's nodeset, every
 * `vellum:nodeset` and every itext reference names something the form holds,
 * so a path, a shadow or an itext id written wrongly for a hyphen fails here.
 */
import { type Element, isTag } from "domhandler";
import { parseDocument } from "htmlparser2";
import { describe, expect, it } from "vitest";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { checkCompilerEvidence } from "../../__tests__/compilerEvidence";
import { expandDoc } from "../../expander";
import { parser } from "../../xpath";
import { FormPath } from "../formPath";

function hyphenatedForm() {
	return buildDoc({
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "case_name", label: "Name" },
					{ name: "visit-type", label: "Visit type" },
				],
			},
		],
		modules: [
			{
				name: "Patients",
				caseType: "patient",
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
								id: "first-name",
								label: "First name",
								hint: "As the person writes it",
								caseWrite: { caseType: "patient", property: "case_name" },
							}),
							f({
								kind: "int",
								id: "copy-1-of-age",
								label: "Age of {{first-name}}",
								validate: "#form/copy-1-of-age >= 0",
								validate_msg: "Age can't be below zero",
							}),
							f({
								kind: "single_select",
								id: "visit-type",
								label: "Visit type",
								options: [
									{ value: "home", label: "Home" },
									{ value: "clinic", label: "Clinic" },
								],
								caseWrite: { caseType: "patient", property: "visit-type" },
							}),
							f({
								kind: "group",
								id: "household-info",
								label: "Household",
								relevant: "#form/copy-1-of-age > 17",
								children: [
									f({
										kind: "text",
										id: "head-of-house",
										label: "Head of house",
										relevant: "#form/first-name != ''",
									}),
									f({ kind: "int", id: "member-count", label: "Members" }),
									f({
										kind: "repeat",
										id: "member-rows",
										label: "Member",
										repeat_mode: "count_bound",
										repeat_count: "#form/household-info/member-count",
										children: [
											f({ kind: "text", id: "member-name", label: "Name" }),
										],
									}),
								],
							}),
							f({
								kind: "repeat",
								id: "visit-rows",
								label: "Visit",
								repeat_mode: "query_bound",
								data_source: { ids_query: "'a b'" },
								children: [
									f({
										kind: "hidden",
										id: "row-id",
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
}

/** The ids every `jr:itext('<id>')` call in an XPath text reads, through the
 * grammar. */
function itextReads(text: string): string[] {
	const ids: string[] = [];
	const tree = parser.parse(text);
	tree.iterate({
		enter(node) {
			if (node.name !== "Invoke") return;
			const name = node.node.getChild("FunctionName");
			if (name === null || text.slice(name.from, name.to) !== "jr:itext")
				return;
			const literal = node.node
				.getChild("ArgumentList")
				?.getChild("StringLiteral");
			if (literal) ids.push(text.slice(literal.from + 1, literal.to - 1));
		},
	});
	return ids;
}

function elements(root: Element): Element[] {
	const out: Element[] = [];
	const walk = (element: Element) => {
		out.push(element);
		for (const child of element.children.filter(isTag)) walk(child);
	};
	walk(root);
	return out;
}

describe("a form whose question IDs hold hyphens", () => {
	it("passes the XForm, suite, HQ JSON and binding oracles", () => {
		checkCompilerEvidence(hyphenatedForm());
	});

	it("names only nodes the form holds in its binds, shadows and itext reads", () => {
		const doc = hyphenatedForm();
		const hq = expandDoc(doc);
		const [source] = Object.values(hq._attachments).filter(
			(value): value is string => typeof value === "string",
		);
		const all = parseDocument(source, { xmlMode: true }).children.filter(isTag);
		const tags = all.flatMap(elements);
		const data = tags.find(
			(element) =>
				element.name === "data" &&
				element.parent !== null &&
				(element.parent as Element).name === "instance",
		);
		if (data === undefined) throw new Error("no data instance");
		const paths = new Set<string>();
		const collect = (element: Element, path: string) => {
			paths.add(path);
			for (const child of element.children.filter(isTag))
				collect(child, `${path}/${child.name}`);
		};
		collect(data, "/data");
		const binds = tags.filter((element) => element.name === "bind");
		expect(binds.length).toBeGreaterThan(0);
		for (const bind of binds) {
			const nodeset = bind.attribs.nodeset ?? "";
			const path = FormPath.parse(nodeset);
			const node = path.endsInAttribute() ? path.parent() : path;
			expect(paths.has(node.toXPath()), nodeset).toBe(true);
			const shadow = bind.attribs["vellum:nodeset"];
			if (shadow !== undefined)
				expect(shadow).toBe(
					`#form/${path
						.segments()
						.slice(1)
						.map((segment) => segment.name)
						.join("/")}`,
				);
		}
		for (const id of [
			"first-name",
			"copy-1-of-age",
			"visit-type",
			"head-of-house",
			"member-rows",
			"member-name",
		])
			expect(
				[...paths].some((path) => path.endsWith(`/${id}`)),
				id,
			).toBe(true);
		const itextIds = new Set(
			tags
				.filter((element) => element.name === "text" && element.attribs.id)
				.map((element) => element.attribs.id),
		);
		const reads = tags.flatMap((element) =>
			Object.values(element.attribs).flatMap(itextReads),
		);
		expect(reads.length).toBeGreaterThan(0);
		for (const id of reads) expect(itextIds.has(id), id).toBe(true);
		expect(itextIds).toContain("first--name-label");
		expect(itextIds).toContain("copy--1--of--age-constraintMsg");
		expect(itextIds).toContain("household--info-head--of--house-label");
	});
});
