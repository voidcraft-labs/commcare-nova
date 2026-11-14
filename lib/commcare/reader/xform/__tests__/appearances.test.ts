/**
 * A control's appearance, classified by the first rule of 9.2 that applies.
 * Over the examples each manifest entry's item gives, it would catch an inert
 * claim for a string a runtime reads; one of the five refused classes with no
 * lane reader misread, which nothing in Python would catch; and a held token
 * not read as held. Through the reader's own stages, it would catch a control
 * missing from the inert appearances a first publish drops, or one listed
 * whose appearance made a finding.
 */

import { Element } from "domhandler";
import { describe, expect, it } from "vitest";
import {
	type AppearanceForm,
	appearanceFacts,
	appearanceReads,
	classifyAppearance,
} from "../appearances";
import type { ControlNode } from "../body";
import type { BindFacts } from "../model";
import {
	codesAt,
	formFindings,
	readFields,
	readForm,
	xformSource,
} from "./formReading";

const Q = (id: string) => `questions/${id}`;

function control(
	tag: ControlNode["tag"],
	options: {
		readonly mediaType?: string;
		readonly children?: readonly ControlNode[];
	} = {},
): ControlNode {
	return {
		element: new Element(tag, {}),
		tag,
		node: undefined,
		parent: null,
		children: options.children ?? [],
		appearance: undefined,
		mediaType: options.mediaType,
		path: "ref",
	};
}

function bind(type: string | undefined): BindFacts {
	return { element: new Element("bind", {}), type, logic: {} };
}

/** The entry a value is claimed under on a control, `held`, or `unclaimed`. */
function verdict(
	on: ControlNode,
	type: string | undefined,
	value: string,
	form?: AppearanceForm,
): string {
	const read = classifyAppearance(on, bind(type), value, form);
	return read.kind === "claim" ? read.claim.entry : read.kind;
}

const text = control("input");
const select1 = control("select1");
const select = control("select");
const trigger = control("trigger");
const image = control("upload", { mediaType: "image/*" });
const group = control("group");

describe("classifyAppearance", () => {
	it("reads the four tokens a kind holds as held", () => {
		expect(verdict(trigger, undefined, "minimal")).toBe("held");
		expect(verdict(image, "binary", "signature")).toBe("held");
		expect(verdict(group, undefined, "field-list")).toBe("held");
		expect(verdict(group, undefined, "Field-List")).toBe("held");
		expect(verdict(text, "xsd:string", "numeric")).toBe("held");
	});

	it("refuses a whitespace Android reads otherwise than its single-spaced form", () => {
		expect(verdict(select1, "xsd:string", "minimal ")).toBe(
			Q("an-appearance-holding-such-whitespace-that-some-runtime-reads"),
		);
		expect(verdict(select1, "xsd:string", "minimal")).toBe(
			Q("select1-minimal"),
		);
	});

	it("refuses a value Android matches inside a single string another way than Web Apps", () => {
		expect(verdict(select1, "xsd:string", "combobox2")).toBe(
			Q("any-other-single-string-no-row-names-that-holds-a-value-android"),
		);
		expect(verdict(select1, "xsd:string", "combobox")).toBe(
			Q("select1-combobox"),
		);
		expect(verdict(select1, "xsd:string", "compact2")).toBe(
			Q("a-single-string-no-row-names-that-holds-values-android-matches"),
		);
	});

	it("reads a per-row token by the digits before its first hyphen", () => {
		expect(verdict(text, "xsd:string", "x2-per-row")).toBe(
			Q(
				"a-per-row-token-the-first-token-web-apps-per-row-pattern-matches-does",
			),
		);
		expect(verdict(trigger, undefined, "floating-2-per-row")).toBe(
			Q(
				"a-per-row-token-the-first-token-web-apps-per-row-pattern-matches-does",
			),
		);
		expect(verdict(text, "xsd:string", "2-per-row")).toBe(
			Q("n-per-row-any-question-or-group-other-than-a-vellum-repeat-n-one"),
		);
		expect(verdict(text, "xsd:string", "1x2-per-row")).toBe(
			Q("any-other-per-row-token-the-first-token-web-apps-per-row-pattern"),
		);
		expect(verdict(text, "xsd:string", "2-per-row receive-a-b")).toBe(
			Q(
				"a-per-row-token-the-first-token-web-apps-per-row-pattern-matches-starts",
			),
		);
		expect(verdict(select1, "xsd:string", "2-per-row compact")).toBe(
			Q(
				"a-per-row-token-the-first-token-web-apps-per-row-pattern-matches-starts",
			),
		);
	});

	it("refuses a case variant two runtimes read differently, and holds one read alike", () => {
		expect(verdict(text, "xsd:string", "Numeric")).toBe(
			Q("a-case-variant-of-numeric-short-or-ethiopian-as-the-whole"),
		);
		expect(verdict(control("input"), "xsd:date", "Ethiopian")).toBe(
			Q("a-case-variant-of-numeric-short-or-ethiopian-as-the-whole"),
		);
		expect(verdict(text, "xsd:string", "Numbers")).toBe(
			Q("a-case-variant-of-numbers-nepali-or-maps-of-video-acquire-or-of"),
		);
		expect(verdict(group, undefined, "Compact")).toBe(
			Q("a-case-variant-of-numbers-nepali-or-maps-of-video-acquire-or-of"),
		);
	});

	it("reads an intent value against the form's intents and callout questions", () => {
		const intents = { intents: new Set(["scan"]), callouts: new Set(["scan"]) };
		expect(verdict(text, "xsd:string", "intent:scan", intents)).toBe(
			Q("intent-id-on-any-input-other-than-an-intent-typed-one-where-id"),
		);
		expect(
			verdict(text, "xsd:string", "intent:scan", {
				intents: new Set(["scan"]),
				callouts: new Set(),
			}),
		).toBe(
			Q("intent-id-naming-an-odkx-intent-that-no-callout-question-writes"),
		);
		expect(verdict(text, "xsd:string", "intent:scan")).toBe(
			Q("intent-id-on-any-input-naming-no-odkx-intent-in-the-form"),
		);
	});

	it("tells a token no runtime reads by whether dropping it keeps every reading", () => {
		expect(verdict(select1, "xsd:string", "minimal foo")).toBe(
			Q("any-other-multi-token-string-holding-a-token-no-runtime-reads-on"),
		);
		expect(
			verdict(select1, "xsd:string", "minimal hint-as-placeholder foo"),
		).toBe(Q("a-multi-token-string-holding-tokens-no-runtime-reads-on-that"));
		expect(verdict(select1, "xsd:string", "minimal hint-as-placeholder")).toBe(
			Q("multi-token-strings-e-g-minimal-hint-as-placeholder-signature-2"),
		);
	});

	it("names the row a value takes on its control", () => {
		expect(verdict(select1, "xsd:string", "compact-3")).toBe(
			Q("select1-compact-compact-n"),
		);
		expect(verdict(select, "xsd:string", "compact-3")).toBe(
			Q("select-compact-compact-n"),
		);
		expect(verdict(select, "xsd:string", "quick")).toBe(
			Q("select-combobox-quick-button-select"),
		);
		expect(verdict(group, undefined, "collapse-closed")).toBe(
			Q("group-collapse-closed"),
		);
		expect(verdict(control("input"), "xsd:int", "anything")).toBe(
			Q("numeric-input-int-decimal-any-other-value-apart-from-the-values"),
		);
	});

	it("accounts a value no runtime reads as inert, and leaves one a runtime reads that no row names", () => {
		expect(verdict(text, "xsd:string", "foo")).toBe(
			Q("any-other-value-read-by-no-runtime-not-an-intent-value-on-an"),
		);
		expect(
			appearanceReads("foo", appearanceFacts(text, bind("xsd:string"))),
		).toEqual([]);
		expect(verdict(trigger, undefined, "minimal")).toBe("held");
		expect(verdict(text, "xsd:string", "full")).toBe("unclaimed");
	});
});

describe("a trigger's appearance, read through the form's stages", () => {
	it("reads a label only where Android's widget draws no acknowledge", async () => {
		const reading = await readForm(
			xformSource({
				data: "<list/><foo/><copy/><banner/>",
				body: '<trigger ref="/data/list" appearance="field-list"/><trigger ref="/data/foo" appearance="foo"/><trigger ref="/data/copy" appearance="selectable"/><trigger ref="/data/banner" appearance="floating-good"/>',
			}),
		);
		const fields = readFields(reading.xform ?? ({} as never));
		expect(
			fields.map((field) => [field.id, field.kind, field.standIn]),
		).toEqual([
			["list", "hidden", true],
			["foo", "hidden", true],
			["copy", "label", false],
			["banner", "label", false],
		]);
		const acknowledge = Q(
			"acknowledge-label-a-trigger-whose-appearance-is-neither-exactly",
		);
		expect(codesAt(reading, "list")).toEqual([acknowledge]);
		expect(codesAt(reading, "foo")).toEqual([acknowledge]);
		expect(codesAt(reading, "copy")).toEqual([Q("trigger-selectable")]);
		expect(codesAt(reading, "banner")).toEqual([
			Q("floating-good-floating-caution-floating-bad"),
		]);
		expect(reading.xform?.inertAppearances).toEqual([]);
	});
});

describe("the head's odkx:intent an input names", () => {
	it("joins the finding of the question that names it, and leaves nothing unrecognized", async () => {
		const reading = await readForm(
			xformSource({
				data: "<scan/><other/>",
				model:
					'<bind nodeset="/data/scan" type="intent"/><bind nodeset="/data/other" type="xsd:string"/>',
				head: '<odkx:intent id="scanner" class="org.example.SCAN"><extra key="mode" ref="/data/other"/></odkx:intent><odkx:intent id="loose" class="org.example.LOOSE"/><odkx:intent id="unused" class="org.example.UNUSED"/>',
				body: '<input ref="/data/scan" appearance="intent:scanner"/><input ref="/data/other" appearance="intent:loose"/>',
			}),
		);
		expect(codesAt(reading, "scan")).toEqual([
			Q("android-app-callout-input-appearance-intent-id-bind-type-intent"),
		]);
		expect(codesAt(reading, "other")).toEqual([
			Q("intent-id-naming-an-odkx-intent-that-no-callout-question-writes"),
		]);
		expect(
			formFindings(reading).filter(
				(finding) => finding.code === "unrecognized",
			),
		).toEqual([]);
	});
});

describe("the inert appearances of a form", () => {
	it("lists a control accounted under an inert entry and no control whose appearance made a finding", async () => {
		const reading = await readForm(
			xformSource({
				data: "<g><a/></g><b/><c/>",
				model:
					'<bind nodeset="/data/g/a" type="xsd:string"/><bind nodeset="/data/b" type="xsd:string"/><bind nodeset="/data/c" type="xsd:int"/>',
				body: '<group ref="/data/g" appearance="collapse-closed"><input ref="/data/g/a"/></group><select1 ref="/data/b" appearance="minimal"><item><label>X</label><value>x</value></item></select1><input ref="/data/c" appearance="whatever"/>',
			}),
		);
		expect(reading.xform?.inertAppearances).toEqual(["g", "c"]);
		expect(codesAt(reading, "b")).toEqual([Q("select1-minimal")]);
		expect(codesAt(reading, "g")).toEqual([]);
		expect(codesAt(reading, "c")).toEqual([]);
	});

	it("lists a repeat once where its wrapping group and the repeat both carry an inert value", async () => {
		const reading = await readForm(
			xformSource({
				data: '<r jr:template=""><q/></r>',
				model: '<bind nodeset="/data/r/q" type="xsd:string"/>',
				body: '<group appearance="compact"><repeat nodeset="/data/r" appearance="compact"><input ref="/data/r/q"/></repeat></group>',
			}),
		);
		expect(reading.xform?.inertAppearances).toEqual(["r"]);
	});
});

describe("an appearance a runtime reads that no row names", () => {
	it("is unrecognized under the string as written, and under nothing else", async () => {
		const reading = await readForm(
			xformSource({
				data: "<a/>",
				model: '<bind nodeset="/data/a" type="xsd:string"/>',
				body: '<input ref="/data/a" appearance="full"/>',
			}),
		);
		expect(
			formFindings(reading)
				.filter(
					(finding) =>
						finding.code === "unrecognized" &&
						finding.place.kind === "question" &&
						finding.place.path === "a",
				)
				.map((finding) => finding.detail.name),
		).toEqual(["full"]);
	});
});
