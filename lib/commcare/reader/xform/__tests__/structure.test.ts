/**
 * Where a form's structure is decided by the data tree and the body together
 * (8.3 and 8.5): a control's place agrees with its node's place whatever
 * order the body writes them in; a question bound to a node with children is
 * refused at the question and what it holds stays in the document under it;
 * and a bind on the data root, which Core applies to the whole form, is
 * refused rather than dropped as a bind on no node. It would catch a data
 * parent read only when its control comes first, a node silently left out of
 * the document (or an expression with no owner throwing the reading), and a
 * root condition the first publish would remove.
 */

import { describe, expect, it } from "vitest";
import type { Finding } from "@/lib/publish/hqFindings";
import {
	readerInput,
	retainedSourceBody,
	sourceFromBody,
} from "../../__tests__/readerInput";
import { readHqApp } from "../../index";
import {
	codesAt,
	formFindings,
	readFields,
	readForm,
	XMLNS,
	xformSource,
} from "./formReading";

const Q = (id: string) => `questions/${id}`;

/** The codes at the question at `path` but `unrecognized`, which marks the logic only the
 *  expression stage claims, a stage these readings stop before. */
function refusalsAt(
	reading: Awaited<ReturnType<typeof readForm>>,
	path: string,
): string[] {
	return codesAt(reading, path).filter((code) => code !== "unrecognized");
}

/** A form's source read through every stage of a whole reading. */
async function readWhole(source: string) {
	const body = {
		...retainedSourceBody("shell/app-source"),
		modules: [
			{
				doc_type: "Module",
				unique_id: "m-reader",
				name: { en: "Menu" },
				case_type: "",
				forms: [
					{
						doc_type: "Form",
						unique_id: "r1",
						xmlns: XMLNS,
						name: { en: "Form" },
					},
				],
			},
		],
		_attachments: { "r1.xml": source },
	};
	const input = readerInput(await sourceFromBody(body));
	return readHqApp({ ...input, recordDialect: () => undefined });
}

function findingsOf(outcome: ReturnType<typeof readHqApp>): readonly Finding[] {
	return outcome.kind === "account" ? outcome.findings : [];
}

/** Each field as `[path, kind, parent id, stand-in]`. */
function shape(reading: Awaited<ReturnType<typeof readForm>>) {
	return readFields(reading.xform ?? ({} as never)).map((field) => [
		field.node.path.join("/"),
		field.kind,
		field.parent?.id ?? null,
		field.standIn,
	]);
}

describe("a control whose node lies under another group than the control", () => {
	const DATA_PARENT = Q(
		"data-parent-data-node-under-another-group-than-its-control",
	);
	const groupFirst = xformSource({
		data: "<g><q/><other/></g>",
		model:
			'<bind nodeset="/data/g" relevant="1 = 1"/><bind nodeset="/data/g/q" type="xsd:string"/><bind nodeset="/data/g/other" type="xsd:string"/>',
		body: '<group ref="/data/g"><input ref="/data/g/other"/></group><input ref="/data/g/q"/>',
	});
	const questionFirst = xformSource({
		data: "<g><q/><other/></g>",
		model:
			'<bind nodeset="/data/g" relevant="1 = 1"/><bind nodeset="/data/g/q" type="xsd:string"/><bind nodeset="/data/g/other" type="xsd:string"/>',
		body: '<input ref="/data/g/q"/><group ref="/data/g"><input ref="/data/g/other"/></group>',
	});

	it("is refused at the question whichever of the two controls the body writes first", async () => {
		for (const source of [groupFirst, questionFirst]) {
			const reading = await readForm(source);
			expect(refusalsAt(reading, "g/q")).toEqual([DATA_PARENT]);
			expect(refusalsAt(reading, "g/other")).toEqual([]);
			expect(refusalsAt(reading, "g")).toEqual([]);
		}
	});

	it("is refused at any depth where the data parent's control comes later", async () => {
		const reading = await readForm(
			xformSource({
				data: "<a><b><q/></b></a>",
				model:
					'<bind nodeset="/data/a/b/q" type="xsd:string"/><bind nodeset="/data/a"/><bind nodeset="/data/a/b"/>',
				body: '<group ref="/data/a"><input ref="/data/a/b/q"/><group ref="/data/a/b"><label>B</label></group></group>',
			}),
		);
		expect(refusalsAt(reading, "a/b/q")).toEqual([DATA_PARENT]);
	});

	it("is refused as crossing a repeat where the repeat's control comes later", async () => {
		const reading = await readForm(
			xformSource({
				data: `<r jr:template=""><q/><n/></r>`,
				model:
					'<bind nodeset="/data/r/q" type="xsd:string"/><bind nodeset="/data/r/n" type="xsd:string"/>',
				body: '<input ref="/data/r/q"/><group><repeat nodeset="/data/r"><input ref="/data/r/n"/></repeat></group>',
			}),
		);
		expect(refusalsAt(reading, "r/q")).toEqual([
			Q("data-parent-crossing-a-repeat"),
		]);
		expect(refusalsAt(reading, "r/n")).toEqual([]);
	});
});

describe("a question bound to a node with element children", () => {
	const QUESTION_WITH_CHILDREN = Q(
		"a-question-other-than-a-group-or-repeat-whose-data-node-has",
	);

	it("is refused at the question, and what the node holds stands under it at its own path", async () => {
		const reading = await readForm(
			xformSource({
				data: "<info><score/><more><deep/></more></info><c/>",
				model:
					'<bind nodeset="/data/info/score" calculate="1 + 1"/><bind nodeset="/data/c" type="xsd:string"/>',
				body: '<trigger ref="/data/info" appearance="minimal"><label>Hi</label></trigger><input ref="/data/c"/>',
			}),
		);
		expect(shape(reading)).toEqual([
			["info", "group", null, true],
			["info/score", "hidden", "info", false],
			["info/more", "group", "info", true],
			["info/more/deep", "hidden", "more", false],
			["c", "text", null, false],
		]);
		expect(refusalsAt(reading, "info")).toEqual([QUESTION_WITH_CHILDREN]);
		// The nodes under it are covered by its refusal: no second finding for the inner one.
		expect(refusalsAt(reading, "info/more")).toEqual([]);
		expect(refusalsAt(reading, "info/score")).toEqual([]);
	});

	it("ends a whole reading in that finding, though a node under it carries logic", async () => {
		for (const control of [
			'<trigger ref="/data/info" appearance="minimal"><label>Hi</label></trigger>',
			'<input ref="/data/info"><label>Hi</label></input>',
		]) {
			const outcome = await readWhole(
				xformSource({
					data: "<info><score/></info>",
					model:
						'<bind nodeset="/data/info" type="xsd:string"/><bind nodeset="/data/info/score" calculate="1 + 1"/>',
					body: control,
				}),
			);
			expect(outcome.kind).toBe("account");
			expect(
				findingsOf(outcome)
					.filter(
						(finding) =>
							finding.place.kind === "question" &&
							finding.place.path === "info",
					)
					.map((finding) => finding.code),
			).toContain(QUESTION_WITH_CHILDREN);
		}
	});
});

describe("a bind on the data root", () => {
	const ON_ROOT = Q(
		"bind-whose-path-names-the-data-root-itself-data-data-or-a",
	);
	const source = (nodeset: string) =>
		xformSource({
			data: "<consent/><q/>",
			model: `<bind nodeset="${nodeset}" relevant="/data/consent = 'yes'"/><bind nodeset="/data/consent" type="xsd:string"/><bind nodeset="/data/q" type="xsd:string"/>`,
			body: '<input ref="/data/consent"/><input ref="/data/q"/>',
		});

	it("is refused at the form, by every spelling Core resolves to the root", async () => {
		for (const nodeset of ["/data", "/data/.", "."]) {
			const reading = await readForm(source(nodeset));
			expect(
				formFindings(reading)
					.filter((finding) => finding.place.kind === "form")
					.map((finding) => [finding.code, finding.detail.name]),
			).toEqual([[ON_ROOT, nodeset]]);
		}
	});

	it("is refused on a root attribute as a bind on any attribute no plugin owns", async () => {
		const reading = await readForm(source("/data/@version"));
		expect(
			formFindings(reading)
				.filter((finding) => finding.place.kind === "form")
				.map((finding) => [finding.code, finding.detail.name]),
		).toEqual([
			[
				Q("bind-on-an-attribute-path-not-owned-by-a-plugin-savetocase-model"),
				"/data/@version",
			],
		]);
	});

	it("leaves a bind on no node, and one above the root, dropped with no finding", async () => {
		for (const nodeset of ["/data/missing", ".."]) {
			const reading = await readForm(source(nodeset));
			expect(formFindings(reading)).toEqual([]);
		}
	});

	it("drops a bind on `/` as written, as Core ignores it, and holds the form", async () => {
		for (const nodeset of ["/", ".."]) {
			const outcome = await readWhole(source(nodeset));
			expect(findingsOf(outcome)).toEqual([]);
			expect(outcome.kind).toBe("read");
		}
	});

	it("reads a path stepping down and back up as no path, which Core cannot load", async () => {
		for (const nodeset of ["/data/consent/..", "consent/..", "/data/../data"]) {
			const outcome = await readWhole(source(nodeset));
			expect(outcome.kind).toBe("account");
			const codes = findingsOf(outcome).map((finding) => finding.code);
			expect(codes).not.toContain(ON_ROOT);
			expect(codes).toContain("unrecognized");
		}
	});

	it("refuses a control whose ref steps down and back up, not reading it as the later node", async () => {
		const reading = await readForm(
			xformSource({
				data: "<consent/><q/>",
				model:
					'<bind nodeset="/data/consent" type="xsd:string"/><bind nodeset="/data/q" type="xsd:string"/>',
				body: '<input ref="/data/consent"/><input ref="/data/consent/../q"/>',
			}),
		);
		expect(
			formFindings(reading)
				.filter((finding) => finding.place.kind === "form")
				.map((finding) => [finding.code, finding.detail.name]),
		).toEqual([[Q("a-control-whose-ref-names-no-node"), "/data/consent/../q"]]);
	});

	it("keeps the reading from holding the form without its condition", async () => {
		const outcome = await readWhole(source("/data"));
		expect(outcome.kind).toBe("account");
		expect(findingsOf(outcome).map((finding) => finding.code)).toContain(
			ON_ROOT,
		);
	});
});
