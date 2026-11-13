/**
 * The document `targeted-hyphenated-question-ids`, whose question IDs hold
 * hyphens as HQ's form builder writes them, beside every name a hyphen could
 * make collide: the group `a` holding `b-c` beside the group `a-b` holding
 * `c`, labelled apart in two languages; the choice list of `mood` beside the
 * question `mood-opt0`; the query repeat `kin` beside the question
 * `kin-query`; and a default reading `current()/../first-name`. Its sources
 * pass the XForm and binding oracles, and every bind's nodeset, every
 * `vellum:nodeset`, every control's reference and every itext read names
 * something the form holds, so a path, a shadow or an itext id written
 * wrongly for a hyphen fails here.
 */
import type { Element } from "domhandler";
import { isTag } from "domhandler";
import { describe, expect, it } from "vitest";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import { hyphenatedQuestionIds } from "../../../../proof/targeted/documents/hyphenatedQuestionIds";
import { checkCompilerEvidence } from "../../__tests__/compilerEvidence";
import { expandDoc } from "../../expander";
import { parseXml } from "../../xmlParse";
import { parser } from "../../xpath";
import { FormPath } from "../formPath";

function hyphenatedDoc() {
	return hydratePersistedBlueprint(hyphenatedQuestionIds().doc);
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

/** Every element of the registration's source, and the paths its data
 * instance holds, attributes included. */
function registrationSource() {
	const doc = hyphenatedDoc();
	const hq = expandDoc(doc);
	const sources = Object.values(hq._attachments)
		.filter((value): value is string => typeof value === "string")
		.map((source) => parseXml(source).children.filter(isTag).flatMap(elements));
	const tags = sources.find((all) =>
		all.some(
			(element) => element.name === "h:title" && textOf(element) === "Register",
		),
	);
	if (tags === undefined) throw new Error("no source for the registration");
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
		for (const name of Object.keys(element.attribs))
			if (!name.includes(":") && name !== "xmlns")
				paths.add(`${path}/@${name}`);
		for (const child of element.children.filter(isTag))
			collect(child, `${path}/${child.name}`);
	};
	collect(data, "/data");
	return { tags, paths };
}

function textOf(element: Element): string {
	return element.children
		.map((child) => ("data" in child ? String(child.data) : ""))
		.join("");
}

/** The label text an itext id holds in a translation, its plain value. */
function itextLabel(tags: Element[], lang: string, id: string): string {
	const translation = tags.find(
		(element) =>
			element.name === "translation" && element.attribs.lang === lang,
	);
	if (translation === undefined) throw new Error(`no translation ${lang}`);
	const texts = translation.children
		.filter(isTag)
		.filter((text) => text.attribs.id === id);
	expect(texts, `${lang} ${id}`).toHaveLength(1);
	const plain = texts[0].children
		.filter(isTag)
		.find((value) => value.attribs.form === undefined);
	if (plain === undefined) throw new Error(`no plain value for ${id}`);
	return textOf(plain);
}

describe("a form whose question IDs hold hyphens", () => {
	it("passes the XForm, suite, HQ JSON and binding oracles", () => {
		checkCompilerEvidence(hyphenatedDoc());
	});

	it("names only nodes the form holds in its binds, shadows, controls and setvalues", () => {
		const { tags, paths } = registrationSource();
		for (const id of [
			"/data/first-name",
			"/data/nova_trimmed_first-name",
			"/data/copy-1-of-age",
			"/data/a-",
			"/data/a/b-c",
			"/data/a-b/c",
			"/data/mood",
			"/data/mood-opt0",
			"/data/visit-rows/visit-note",
			"/data/nova_count_visit-rows",
			"/data/kin/item/kin-id",
			"/data/kin-query",
			"/data/age-before",
			"/data/called",
		])
			expect(paths.has(id), id).toBe(true);
		const binds = tags.filter((element) => element.name === "bind");
		expect(binds.length).toBeGreaterThan(0);
		for (const bind of binds) {
			const nodeset = bind.attribs.nodeset ?? "";
			expect(paths.has(nodeset), nodeset).toBe(true);
			const path = FormPath.parse(nodeset);
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
		const references = tags.flatMap((element) => {
			if (element.name === "setvalue") return [element.attribs.ref];
			if (element.name === "repeat") return [element.attribs.nodeset];
			if (
				["input", "select1", "select", "trigger", "group"].includes(
					element.name,
				)
			)
				return element.attribs.ref === undefined ? [] : [element.attribs.ref];
			return [];
		});
		expect(references.length).toBeGreaterThan(0);
		for (const reference of references)
			expect(paths.has(reference ?? ""), reference).toBe(true);
		/* The default reads its sibling relative to itself, and that sibling
		 * is the hyphenated question. */
		const called = tags.find(
			(element) =>
				element.name === "setvalue" && element.attribs.ref === "/data/called",
		);
		expect(called?.attribs.value).toBe("current()/../first-name");
	});

	it("gives each itext key one entry, and every read one it holds", () => {
		const { tags } = registrationSource();
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
		/* `a`/`b-c` and `a-b`/`c` keep two keys, each its own label in each
		 * language, and the choice `mood`'s first option keeps a key apart
		 * from the question `mood-opt0`. */
		expect(itextLabel(tags, "en", "a-b--c-label")).toBe("In the first group");
		expect(itextLabel(tags, "en", "a--b-c-label")).toBe("In the second group");
		expect(itextLabel(tags, "fr", "a-b--c-label")).toBe(
			"Dans le premier groupe",
		);
		expect(itextLabel(tags, "fr", "a--b-c-label")).toBe(
			"Dans le deuxième groupe",
		);
		expect(itextLabel(tags, "fr", "a-label")).toBe("Premier groupe");
		expect(itextLabel(tags, "fr", "a--b-label")).toBe("Deuxième groupe");
		expect(itextLabel(tags, "en", "mood-opt0-label")).toBe("Calm");
		expect(itextLabel(tags, "en", "mood--opt0-label")).toBe(
			"Anything else about the mood",
		);
		expect(itextLabel(tags, "en", "kin-label")).toBe("Relative");
		expect(itextLabel(tags, "en", "kin--query-label")).toBe("Who else to ask");
		expect(itextLabel(tags, "en", "copy--1--of--age-label")).toBe("Age");
	});
});
