/**
 * Vellum's shadows and `requiredCondition`. `shadowAgrees` is
 * held over pairs of real and shadow text with the head's metadata: agreeing
 * through `#form/`, through a `hashtags` entry and through a transform's exact
 * prefix; disagreeing; with no expansion; a hashtag the map holds as `null`,
 * met twice over one subtree and twice over two. The form stage's judgment is
 * held over whole sources: a disagreement is `shadow-disagrees` at the
 * question, a form saved with rich text off has inert shadows, and the three
 * `requiredCondition` rows each take their entry.
 *
 * Plausible failures: a disagreement read as agreement; an inert shadow
 * refused; a form HQ's form builder reads through a `null` hashtag sent back
 * to be fixed; the longest key taken where Vellum takes the exact prefix.
 */

import { describe, expect, it } from "vitest";
import type { FormSyntax } from "../../../xpath/formSyntax";
import type { HashtagMetadata } from "../parse";
import { SHADOWED_ATTRIBUTES, shadowAgrees } from "../shadow";
import {
	codesAt,
	formFindings,
	readForm,
	unrecognizedAt,
	xformSource,
} from "./formReading";

const NO_HEAD: HashtagMetadata = { hashtags: {}, transforms: {} };

function metadata(head: HashtagMetadata = NO_HEAD) {
	return { head, bindings: new Map<string, FormSyntax>(), root: "data" };
}

describe("the shadowed attributes", () => {
	it("are the surface's vellum-markup family, its markers left out", () => {
		expect(SHADOWED_ATTRIBUTES.bind?.map((pair) => pair.real).sort()).toEqual(
			["calculate", "constraint", "nodeset", "ref", "relevant"].sort(),
		);
		expect(SHADOWED_ATTRIBUTES.repeat).toContainEqual({
			real: "jr:count",
			shadow: "jr__count",
		});
		expect(SHADOWED_ATTRIBUTES.input?.map((pair) => pair.real).sort()).toEqual(
			["bind", "nodeset", "ref"].sort(),
		);
		expect(SHADOWED_ATTRIBUTES.output).toEqual([
			{ real: "value", shadow: "value" },
		]);
		expect(
			SHADOWED_ATTRIBUTES.setvalue?.map((pair) => pair.real).sort(),
		).toEqual(["ref", "value"]);
	});
});

describe("shadowAgrees", () => {
	it("expands #form/ under the data root, and compares trees, not spellings", () => {
		expect(shadowAgrees("/data/a = 'x'", '#form/a = "x"', metadata(), [])).toBe(
			"agrees",
		);
		expect(
			shadowAgrees("(/data/a + 1) > 2", "#form/a + 1 > 2", metadata(), []),
		).toBe("agrees");
		expect(
			shadowAgrees("/data/a + 1 > 2", "#form/a + 2 > 2", metadata(), []),
		).toBe("disagrees");
		expect(shadowAgrees("/data/a = 'x'", "#form/b = 'x'", metadata(), [])).toBe(
			"disagrees",
		);
	});

	it("expands a hashtag the head maps, and exactly the prefix up to its last slash", () => {
		const head: HashtagMetadata = {
			hashtags: { "#case/dob": "instance('casedb')/casedb/case/dob" },
			transforms: {
				"#case/": "instance('casedb')/casedb/case/",
				"#case/parent/": "instance('casedb')/casedb/parent/",
			},
		};
		expect(
			shadowAgrees(
				"instance('casedb')/casedb/case/dob",
				"#case/dob",
				metadata(head),
				[],
			),
		).toBe("agrees");
		expect(
			shadowAgrees(
				"instance('casedb')/casedb/case/age",
				"#case/age",
				metadata(head),
				[],
			),
		).toBe("agrees");
		// `#case/parent/age` takes the prefix `#case/parent/`, never the shorter `#case/`.
		expect(
			shadowAgrees(
				"instance('casedb')/casedb/parent/age",
				"#case/parent/age",
				metadata(head),
				[],
			),
		).toBe("agrees");
		expect(
			shadowAgrees(
				"instance('casedb')/casedb/case/parent/age",
				"#case/parent/age",
				metadata(head),
				[],
			),
		).toBe("disagrees");
	});

	it("never takes a shorter prefix where the exact one is missing", () => {
		// Vellum looks up `#case/parent/` alone; `#case/` would expand the shadow to the real text.
		const head: HashtagMetadata = {
			hashtags: {},
			transforms: { "#case/": "instance('casedb')/casedb/case/" },
		};
		expect(
			shadowAgrees(
				"instance('casedb')/casedb/case/parent/age",
				"#case/parent/age",
				metadata(head),
				[],
			),
		).toBe("disagrees");
	});

	it("finds a hashtag with no expansion a disagreement", () => {
		expect(shadowAgrees("/data/a", "#case/a", metadata(), [])).toBe(
			"disagrees",
		);
	});

	it("binds a null hashtag to the subtree it meets, once per form", () => {
		const head: HashtagMetadata = {
			hashtags: { "#case/dob": null },
			transforms: {},
		};
		const form = metadata(head);
		const read = "instance('casedb')/casedb/case[@case_id = 'x']/dob";
		expect(shadowAgrees(`${read} != ''`, "#case/dob != ''", form, [])).toBe(
			"agrees",
		);
		expect(
			shadowAgrees(
				`string-length(${read})`,
				"string-length(#case/dob)",
				form,
				[],
			),
		).toBe("agrees");
		expect(
			shadowAgrees(
				"instance('casedb')/casedb/case[@case_id = 'y']/dob",
				"#case/dob",
				form,
				[],
			),
		).toBe("disagrees");
		expect(
			shadowAgrees(
				`${read} = ${read}`,
				"#case/dob = #case/dob",
				metadata(head),
				[],
			),
		).toBe("agrees");
		expect(
			shadowAgrees(
				`${read} = /data/other`,
				"#case/dob = #case/dob",
				metadata(head),
				[],
			),
		).toBe("disagrees");
	});

	it("makes a relative path absolute from its base, and tells which side does not parse", () => {
		expect(
			shadowAgrees("q", "#form/group/q", metadata(), ["data", "group"]),
		).toBe("agrees");
		expect(shadowAgrees("q", "#form/q", metadata(), ["data", "group"])).toBe(
			"disagrees",
		);
		expect(shadowAgrees("/data/a", "#form/a +", metadata(), [])).toBe(
			"shadow-unparseable",
		);
		expect(shadowAgrees("/data/a +", "#form/a", metadata(), [])).toBe(
			"real-unparseable",
		);
	});
});

const twoQuestions = (bind: string, head = "", rootAttributes = "") =>
	xformSource({
		data: "<a/><b/>",
		model: `<bind nodeset="/data/a" vellum:nodeset="#form/a" type="xsd:string"/>${bind}`,
		body: `<input ref="/data/a" vellum:ref="#form/a"/><input ref="/data/b" vellum:ref="#form/b"/>`,
		head,
		rootAttributes,
	});

describe("a form's shadows", () => {
	it("reads agreeing shadows to no finding", async () => {
		const reading = await readForm(
			twoQuestions(
				'<bind nodeset="/data/b" vellum:nodeset="#form/b" type="xsd:string" relevant="/data/a = \'x\'" vellum:relevant="#form/a = \'x\'"/>',
			),
		);
		expect(codesAt(reading, "b")).not.toContain("shadow-disagrees");
		expect(codesAt(reading, "a")).not.toContain("shadow-disagrees");
	});

	it("raises shadow-disagrees at the question whose shadow means something else", async () => {
		const reading = await readForm(
			twoQuestions(
				'<bind nodeset="/data/b" vellum:nodeset="#form/b" type="xsd:string" relevant="/data/a = \'x\'" vellum:relevant="#form/a = \'y\'"/>',
			),
		);
		const found = reading.closed.findings.filter(
			(finding) =>
				finding.code === "shadow-disagrees" &&
				finding.place.kind === "question" &&
				finding.place.path === "b",
		);
		expect(found.map((finding) => finding.detail.name)).toEqual(["relevant"]);
	});

	it("raises shadow-disagrees where the real attribute is missing", async () => {
		const reading = await readForm(
			twoQuestions(
				'<bind nodeset="/data/b" vellum:nodeset="#form/b" type="xsd:string" vellum:relevant="#form/a = \'y\'"/>',
			),
		);
		expect(codesAt(reading, "b")).toContain("shadow-disagrees");
	});

	it("raises shadow-disagrees where the shadow does not parse", async () => {
		const reading = await readForm(
			twoQuestions(
				'<bind nodeset="/data/b" vellum:nodeset="#form/b" type="xsd:string" relevant="/data/a = \'x\'" vellum:relevant="#form/a = "/>',
			),
		);
		const found = reading.closed.findings.filter(
			(finding) =>
				finding.code === "shadow-disagrees" &&
				finding.place.kind === "question" &&
				finding.place.path === "b",
		);
		expect(found.map((finding) => finding.detail.name)).toEqual(["relevant"]);
	});

	it("reads a form saved with rich text off as having inert shadows, each dropped", async () => {
		const reading = await readForm(
			twoQuestions(
				'<bind nodeset="/data/b" vellum:nodeset="#form/b" type="xsd:string" relevant="/data/a = \'x\'" vellum:relevant="#form/a = \'y\'"/>',
			).replace("<h:html ", '<h:html vellum:ignore="richText" '),
		);
		const findings = formFindings(reading);
		expect(findings.map((finding) => finding.code)).not.toContain(
			"shadow-disagrees",
		);
		// Neither left unclaimed nor refused: each shadow is dropped as inert.
		const shadows = ["@vellum:relevant", "@vellum:nodeset", "@vellum:ref"];
		expect(
			findings.filter(
				(finding) =>
					finding.code === "unrecognized" &&
					shadows.some((shadow) =>
						(finding.detail.name ?? "").endsWith(shadow),
					),
			),
		).toEqual([]);
		expect(
			findings.filter(
				(finding) =>
					finding.code !== "unrecognized" &&
					(finding.place.kind === "question" || finding.place.kind === "form"),
			),
		).toEqual([]);
	});
});

describe("a bind's requiredCondition", () => {
	const required = (attributes: string) =>
		twoQuestions(
			`<bind nodeset="/data/b" vellum:nodeset="#form/b" type="xsd:string" ${attributes}/>`,
		);

	const refusals = (codes: readonly string[]) =>
		codes.filter((code) => code.startsWith("questions/requiredcondition"));

	it("drops a requiredCondition beside no required", async () => {
		const reading = await readForm(
			required("vellum:requiredCondition=\"#form/a = 'x'\""),
		);
		expect(refusals(codesAt(reading, "b"))).toEqual([]);
		expect(unrecognizedAt(reading, "b")).not.toContain(
			"xform:bind@vellum:requiredCondition",
		);
	});

	it("drops a requiredCondition beside required false() or one equal to it", async () => {
		for (const attributes of [
			'required="false()" vellum:requiredCondition="#form/a = \'x\'"',
			"required=\"/data/a = 'x'\" vellum:requiredCondition=\"#form/a = 'x'\"",
			"required=\"/data/a = 'x'\" requiredCondition=\"/data/a = 'x'\"",
		]) {
			const reading = await readForm(required(attributes));
			expect(refusals(codesAt(reading, "b"))).toEqual([]);
			expect(
				unrecognizedAt(reading, "b").filter((name) =>
					name.includes("requiredCondition"),
				),
			).toEqual([]);
		}
	});

	it("refuses a requiredCondition that differs from a present required", async () => {
		const reading = await readForm(
			required(
				"required=\"/data/a = 'x'\" vellum:requiredCondition=\"#form/a = 'y'\"",
			),
		);
		expect(codesAt(reading, "b")).toContain(
			"questions/requiredcondition-differing-from-a-present-non-false-required",
		);
	});
});
