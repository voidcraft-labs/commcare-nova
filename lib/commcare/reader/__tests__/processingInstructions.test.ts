/**
 * A comment or a processing instruction in a form's source, read as CommCare
 * reads HQ's build of it.
 *
 * Contract: CommCare HQ's build removes every comment from a form
 * (`xform.py::parse_xml`, `remove_comments=True`) and joins the text around
 * it, and lxml reads a CDATA section as text, so a title spelled with either
 * reads as its text and the first publish records no `form-titles-written`.
 * A processing instruction stays in the build, and Core's parse keeps it as a
 * node of its own: `XFormParser.getXMLText` stops at it (a title it starts
 * reads null, one inside a title reads the text before it) and `getLabel`
 * writes it as `null` in a label or an itext value. So an instruction in a
 * text Core reads, whether the stage reading it claims the element or the
 * whole subtree it sits in (a markdown value), is `unrecognized`, and one in
 * an element Core reads by its element children alone stays inert.
 *
 * Plausible failures: a title holding an instruction read as the text around
 * it, so the first publish changes the title a worker reads with no record; a
 * choice's or a markdown label's text read whole while a device shows `null`
 * in it; an instruction between itext texts refused, though no runtime reads
 * it; a comment in a title read as a change of title.
 */

import {
	type ChildNode,
	Comment,
	type Element,
	isTag,
	ProcessingInstruction,
	Text,
} from "domhandler";
import { findOne } from "domutils";
import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { serializeXml } from "../../serializeXml";
import { parseXml } from "../../xmlParse";
import { readHqApp } from "../index";
import { exportedBody, inputFor } from "./novaExport";

const DOC = buildDoc({
	modules: [
		{
			name: "Menu",
			forms: [
				{
					name: "Visit",
					type: "survey",
					fields: [
						f({
							kind: "single_select",
							id: "pick",
							label: "Pick",
							options: [
								{ value: "yes", label: "Yes" },
								{ value: "no", label: "No" },
							],
						}),
					],
				},
			],
		},
	],
});

const instruction = () => new ProcessingInstruction("?x", "?x y?");

/** The form's source with `edit` applied to its parsed tree. */
function edited(edit: (root: Element[]) => void): (xml: string) => string {
	return (xml) => {
		const document = parseXml(xml);
		edit(document.children.filter(isTag));
		return serializeXml(document);
	};
}

function one(root: Element[], test: (element: Element) => boolean): Element {
	const found = findOne(test, root, true);
	if (found === null) throw new Error("The export holds no such element.");
	return found;
}

const title = (root: Element[]) =>
	one(root, (element) => element.name === "h:title");

/** The itext `<value>` of `form` (none for the plain value) whose text is `text`. */
const itextValue = (root: Element[], text: string, form?: string) =>
	one(
		root,
		(element) =>
			element.name === "value" &&
			element.attribs.form === form &&
			element.parent !== null &&
			(element.parent as Element).name === "text" &&
			element.children.length === 1 &&
			(element.children[0] as Text).data === text,
	);

function setChildren(element: Element, children: ChildNode[]): void {
	element.children = children;
	for (const child of children) child.parent = element;
}

async function read(xml: (xml: string) => string) {
	const outcome = readHqApp(await inputFor(exportedBody(DOC, { xml })), {
		claims: "full",
	});
	expect(outcome.defects).toEqual([]);
	return outcome;
}

const unrecognizedNames = (outcome: Awaited<ReturnType<typeof read>>) =>
	outcome.kind === "account"
		? outcome.findings
				.filter((finding) => finding.code === "unrecognized")
				.map((finding) => finding.detail.name)
		: [];

const titleRecords = (outcome: Awaited<ReturnType<typeof read>>) => {
	if (outcome.kind !== "read")
		throw new Error(
			`The form read to an account: ${outcome.findings.map((finding) => `${finding.code} ${finding.detail.name ?? ""}`).join(", ")}`,
		);
	return outcome.draft.facts.sameStateRewrites.filter(
		(record) => record.register === "form-titles-written",
	);
};

describe("a processing instruction in a text Core reads", () => {
	it.each([
		["before the title's text", () => [instruction(), new Text("Visit")]],
		[
			"inside the title's text",
			() => [new Text("Vis"), instruction(), new Text("it")],
		],
	])(
		"is unrecognized %s, where Core reads the title as other text",
		async (_, children) => {
			const outcome = await read(
				edited((root) => setChildren(title(root), children())),
			);
			expect(unrecognizedNames(outcome)).toEqual([
				"xform:h:title/processing-instruction()",
			]);
		},
	);

	it("is unrecognized in a choice's itext value, which Core shows with `null` in it", async () => {
		const outcome = await read(
			edited((root) =>
				setChildren(itextValue(root, "Yes"), [
					new Text("Y"),
					instruction(),
					new Text("es"),
				]),
			),
		);
		expect(unrecognizedNames(outcome)).toEqual([
			"xform:value/processing-instruction()",
		]);
	});

	it("is unrecognized in a label's value and its markdown copy, which Core shows with `null` in them", async () => {
		const outcome = await read(
			edited((root) => {
				for (const value of [
					itextValue(root, "Pick"),
					itextValue(root, "Pick", "markdown"),
				])
					setChildren(value, [new Text("Pi"), instruction(), new Text("ck")]);
			}),
		);
		expect(
			outcome.kind === "account"
				? outcome.findings.map((finding) => [finding.code, finding.detail.name])
				: [],
		).toEqual([["unrecognized", "xform:value/processing-instruction()"]]);
	});
});

describe("what CommCare reads past", () => {
	it("holds an instruction between itext texts and in the head as inert", async () => {
		const outcome = await read(
			edited((root) => {
				const itext = one(root, (element) => element.name === "itext");
				const translation = itext.children.find(isTag) as Element;
				setChildren(translation, [instruction(), ...translation.children]);
				const head = one(root, (element) => element.name === "h:head");
				setChildren(head, [...head.children, instruction()]);
			}),
		);
		expect(titleRecords(outcome)).toEqual([]);
		if (outcome.kind !== "read") return;
		expect(
			[...outcome.claims.records()]
				.filter((record) => record.where.endsWith("/processing-instruction()"))
				.map((record) => record.entry),
		).toEqual([
			"questions/xml-comments-processing-instructions",
			"questions/xml-comments-processing-instructions",
		]);
	});

	it.each([
		["before the title's text", () => [new Comment("v2"), new Text("Visit")]],
		[
			"inside the title's text",
			() => [new Text("Vis"), new Comment("x"), new Text("it")],
		],
	])(
		"reads a comment %s as the title HQ's build leaves, and records no title written",
		async (_, children) => {
			const outcome = await read(
				edited((root) => setChildren(title(root), children())),
			);
			expect(titleRecords(outcome)).toEqual([]);
		},
	);

	it("reads a title in a CDATA section as its text, and records no title written", async () => {
		const plain = serializeXml(new Text("Visit"));
		const outcome = await read((xml) => {
			const document = parseXml(xml);
			const element = title(document.children.filter(isTag));
			expect(element.children.map((child) => (child as Text).data)).toEqual([
				"Visit",
			]);
			const spelled = serializeXml(element);
			const parts = xml.split(spelled);
			expect(parts).toHaveLength(2);
			return parts.join(spelled.replace(plain, "<![CDATA[Visit]]>"));
		});
		expect(titleRecords(outcome)).toEqual([]);
	});

	it("records the title a first publish writes where the title holds other text", async () => {
		const outcome = await read(
			edited((root) => setChildren(title(root), [new Text("Old name")])),
		);
		expect(titleRecords(outcome)).toHaveLength(1);
	});
});
