/**
 * A control's appearance, classified by the first appearance rule that applies.
 * Over the examples each manifest entry's item gives, it would catch an inert
 * claim for a string a runtime reads; one of the five refused classes with no
 * lane reader misread, which nothing in Python would catch; and a held token
 * not read as held. Through the reader's own stages, it would catch a control
 * missing from the inert appearances a first publish drops, or one listed
 * whose appearance made a finding.
 */

import { Element } from "domhandler";
import { describe, expect, it } from "vitest";
import { writeFieldAppearance } from "@/lib/commcare/xform/appearance";
import type { FieldKind } from "@/lib/domain";
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
	unrecognizedAt,
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
		const starts = Q(
			"a-per-row-token-the-first-token-web-apps-per-row-pattern-matches-starts",
		);
		expect(verdict(text, "xsd:string", "2receive3-per-row")).toBe(starts);
		expect(verdict(image, "binary", "2broadcast-a3-per-row")).toBe(starts);
		expect(verdict(select1, "xsd:string", "2compact3-per-row")).toBe(starts);
		// A token already spelled `<k>-per-row` drops nothing, so the other
		// words are their own rows': the string reads as its tokens.
		const multi = Q(
			"multi-token-strings-e-g-minimal-hint-as-placeholder-signature-2",
		);
		expect(verdict(text, "xsd:string", "2-per-row receive-a-b")).toBe(multi);
		expect(verdict(select1, "xsd:string", "2-per-row compact")).toBe(multi);
		expect(verdict(select1, "xsd:string", "2-per-row")).toBe(
			Q("n-per-row-any-question-or-group-other-than-a-vellum-repeat-n-one"),
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
		expect(verdict(text, "xsd:string", "intent:scan", intents)).toBe("held");
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
	it("holds the checkbox answer independently of a trigger's display tokens", async () => {
		const reading = await readForm(
			xformSource({
				data: "<list/><foo/><copy/><banner/><aligned/>",
				body: '<trigger ref="/data/list" appearance="field-list"/><trigger ref="/data/foo" appearance="foo"/><trigger ref="/data/copy" appearance="selectable"/><trigger ref="/data/banner" appearance="floating-good"/><trigger ref="/data/aligned" appearance="text-align-center"/>',
			}),
		);
		const fields = readFields(reading.xform ?? ({} as never));
		expect(
			fields.map((field) => [field.id, field.kind, field.standIn]),
		).toEqual([
			["list", "label", false],
			["foo", "label", false],
			["copy", "label", false],
			["banner", "label", false],
			["aligned", "label", false],
		]);
		expect(fields.slice(0, 2).map((field) => field.field)).toEqual([
			expect.objectContaining({ askForConfirmation: true }),
			expect.objectContaining({ askForConfirmation: true }),
		]);
		expect(codesAt(reading, "list")).toEqual([]);
		expect(codesAt(reading, "foo")).toEqual([]);
		expect(codesAt(reading, "copy")).toEqual([]);
		expect(fields[2].field.selectableText).toBe(true);
		expect(codesAt(reading, "banner")).toEqual([]);
		expect(fields[3].field.banner).toBe("good");
		expect(codesAt(reading, "aligned")).toEqual([]);
		expect(fields[4].field).toMatchObject({
			askForConfirmation: true,
			textAlignment: "center",
		});
		expect(reading.xform?.inertAppearances).toEqual(["list", "foo"]);
	});
});

describe("the head's odkx:intent an input names", () => {
	it("claims the action, extra, and response at their Android intent source sites", async () => {
		const reading = await readForm(
			xformSource({
				data: "<scan/><result/>",
				model:
					'<bind nodeset="/data/scan" type="intent"/><bind nodeset="/data/result" type="xsd:int"/>',
				head: `<odkx:intent id="scan" class="org.example.SCAN"><extra key="unit" ref="'litres'"/><response key="measurement" ref="/data/result"/></odkx:intent>`,
				body: '<input ref="/data/scan" appearance="intent:scan"/><input ref="/data/result"/>',
			}),
			{ mint: true },
		);
		expect(formFindings(reading)).toEqual([]);
		const entry = Q(
			"android-app-callout-input-appearance-intent-id-bind-type-intent",
		);
		const records = [...reading.closed.claims.records()]
			.filter(
				(record) =>
					record.entry === entry && record.key?.startsWith("xform:intent"),
			)
			.map(({ key, where }) => [key, where]);
		const intent = "/h:html/h:head[1]/odkx:intent[1]";
		expect(records).toHaveLength(8);
		expect(records).toEqual(
			expect.arrayContaining([
				["xform:intent@id", `${intent}/@id`],
				["xform:intent@class", `${intent}/@class`],
				["xform:intent/extra", `${intent}/extra[1]`],
				["xform:intent/extra@key", `${intent}/extra[1]/@key`],
				["xform:intent/extra@ref", `${intent}/extra[1]/@ref`],
				["xform:intent/response", `${intent}/response[1]`],
				["xform:intent/response@key", `${intent}/response[1]/@key`],
				["xform:intent/response@ref", `${intent}/response[1]/@ref`],
			]),
		);
	});

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
			Q("android-app-callout-that-cannot-be-recreated"),
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
		expect(codesAt(reading, "b")).toEqual([]);
		expect(
			(reading.xform ? readFields(reading.xform) : []).find((f) => f.id === "b")
				?.field.choiceLayout,
		).toEqual({ kind: "dropdown" });
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

/* Core opens a group screen only for the whole appearance `field-list`
 * (`FormEntryController.getQuestionPrompts`); Android reads `compact` only as
 * each widget's layout (`FormController.indexIsInCompact`). So a compact
 * group pages its questions and a worker still adds a repeat's entries. */
describe("a compact group", () => {
	const grouped = (appearance: string) =>
		readForm(
			xformSource({
				data: '<g><n><a/></n><r jr:template=""><q/></r></g>',
				model:
					'<bind nodeset="/data/g/n/a" type="xsd:string"/><bind nodeset="/data/g/r/q" type="xsd:string"/>',
				body: `<group ref="/data/g" appearance="${appearance}"><label>G</label><group ref="/data/g/n"><label>N</label><input ref="/data/g/n/a"><label>A</label></input></group><group><repeat nodeset="/data/g/r"><input ref="/data/g/r/q"><label>Q</label></input></repeat></group></group>`,
			}),
		);
	/** The question-list entries the reading claimed anything under. */
	const questionList = (reading: Awaited<ReturnType<typeof grouped>>) =>
		Object.keys(reading.closed.claims.counts).filter((entry) =>
			entry.includes("question-list"),
		);

	it("takes its setting and leaves a user repeat and a nested group as they are", async () => {
		const reading = await grouped("compact");
		expect(
			(reading.xform ? readFields(reading.xform) : []).find((f) => f.id === "g")
				?.field.compact,
		).toBe(true);
		expect(questionList(reading)).toEqual([]);
		expect(formFindings(reading)).toEqual([]);
	});

	it("differs from a field-list group, which refuses the repeat and holds the nested group", async () => {
		const reading = await grouped("field-list");
		expect(questionList(reading)).toContain(
			Q("groups-nested-in-a-question-list"),
		);
		expect(formFindings(reading).map((finding) => finding.code)).toEqual([
			Q("user-controlled-repeat-inside-a-question-list-a-group-whose"),
		]);
	});
});

/* The writer joins a row count with the control's other display words. The
 * reader must take back exactly what the writer wrote, or a publish could not
 * be brought back in once someone saves in CommCare HQ. */
describe("a row count beside the control's other display words", () => {
	const item = "<item><label>A</label><value>a</value></item>";
	const controls: Partial<
		Record<
			FieldKind,
			{ readonly type: string; readonly body: (appearance: string) => string }
		>
	> = {
		text: {
			type: "xsd:string",
			body: (a) =>
				`<input ref="/data/q" appearance="${a}"><label>Q</label></input>`,
		},
		barcode: {
			type: "barcode",
			body: (a) =>
				`<input ref="/data/q" appearance="${a}"><label>Q</label></input>`,
		},
		date: {
			type: "xsd:date",
			body: (a) =>
				`<input ref="/data/q" appearance="${a}"><label>Q</label></input>`,
		},
		single_select: {
			type: "xsd:string",
			body: (a) =>
				`<select1 ref="/data/q" appearance="${a}"><label>Q</label>${item}</select1>`,
		},
		image: {
			type: "binary",
			body: (a) =>
				`<upload ref="/data/q" mediatype="image/*" appearance="${a}"><label>Q</label></upload>`,
		},
		audio: {
			type: "binary",
			body: (a) =>
				`<upload ref="/data/q" mediatype="audio/*" appearance="${a}"><label>Q</label></upload>`,
		},
	};
	it.each<[FieldKind, Record<string, unknown>]>([
		["text", { receiveFrom: { channel: "a", field: "city" } }],
		["image", { sendTopics: ["home"] }],
		["single_select", { choiceLayout: { kind: "grid" } }],
		["single_select", { choiceLayout: { kind: "search" } }],
		["date", { calendar: "gregorian" }],
		["audio", { recorder: "legacy" }],
		["image", { overlaySize: "small" }],
		["image", { captureSource: "camera" }],
		["barcode", { canEditScan: true }],
	])("reads %s %j with two per row back as written", async (kind, extra) => {
		const settings = { ...extra, itemsPerRow: "2" };
		const appearance = writeFieldAppearance(kind, settings);
		const control = controls[kind];
		if (appearance === undefined || control === undefined)
			throw new Error(`No appearance for ${kind}.`);
		expect(appearance).toContain("2-per-row");
		const reading = await readForm(
			xformSource({
				data: "<q/>",
				model: `<bind nodeset="/data/q" type="${control.type}"/>`,
				body: control.body(appearance),
			}),
		);
		expect(codesAt(reading, "q")).toEqual([]);
		expect(
			(reading.xform ? readFields(reading.xform) : []).find((f) => f.id === "q")
				?.field,
		).toMatchObject(settings);
	});
});

describe("a lone broadcast on a question no address search sends from", () => {
	it.each([
		["text", "xsd:string"],
		["barcode", "barcode"],
	])("stands unrecognized on %s rather than vanish", async (_kind, type) => {
		const reading = await readForm(
			xformSource({
				data: "<q/>",
				model: `<bind nodeset="/data/q" type="${type}"/>`,
				body: '<input ref="/data/q" appearance="broadcast-home"><label>Q</label></input>',
			}),
		);
		expect(unrecognizedAt(reading, "q")).toEqual(["broadcast-home"]);
		expect(reading.xform?.inertAppearances ?? []).not.toContain("q");
	});

	it("is still taken beside address search", async () => {
		const reading = await readForm(
			xformSource({
				data: "<q/>",
				model: '<bind nodeset="/data/q" type="xsd:string"/>',
				body: '<input ref="/data/q" appearance="address broadcast-home"><label>Q</label></input>',
			}),
		);
		expect(codesAt(reading, "q")).toEqual([]);
		expect(
			(reading.xform ? readFields(reading.xform) : []).find((f) => f.id === "q")
				?.field,
		).toMatchObject({ addressLookup: true, sendTopics: ["home"] });
	});
});
