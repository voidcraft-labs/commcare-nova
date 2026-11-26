/**
 * The one writer of a control's `appearance`.
 *
 * `fieldAppearance` is read over one field of every kind, and the HQ
 * sources of a seeded corpus of admitted documents are read back through
 * `parseXml`, so two failures show: a control whose `appearance` changed for
 * a document that holds no display setting (the writer moved a token every
 * existing app relied on: `minimal` on a label's trigger, `signature` on a
 * signature's upload, `field-list` on a section or a group shown on one
 * screen, and nothing on any other control), and a registry value with no
 * token, which would write a control the setting does not change.
 */

import type { Element } from "domhandler";
import { isTag } from "domhandler";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	type BlueprintDoc,
	type Field,
	type FieldKind,
	fieldKinds,
	proseText,
} from "@/lib/domain";
import { blueprintDocArbitrary } from "../../__tests__/xformDocArbitrary";
import { expandDoc } from "../../expander";
import { parseXml } from "../../xmlParse";
import { fieldAppearance, writeFieldAppearance } from "../appearance";
import {
	fieldDisplayProblem,
	readFieldAppearance,
} from "../readDisplaySettings";

/** A field of `kind` with the slots its writer reads, and `extra` beside them. */
function fieldOf(kind: FieldKind, extra: Record<string, unknown> = {}): Field {
	return {
		uuid: testUuid(`appearance-${kind}`),
		id: "answer",
		kind,
		label: proseText("Answer"),
		...(kind === "repeat" ? { repeat_mode: "user_controlled" } : {}),
		...extra,
	} as Field;
}

/** The appearance each kind's control carries before any display setting. */
const KIND_TOKENS: Partial<Record<FieldKind, string>> = {
	label: "minimal",
	signature: "signature",
	section: "field-list",
};

describe("fieldAppearance", () => {
	it.each([...fieldKinds])("writes the kind's own token on %s", (kind) => {
		expect(fieldAppearance(fieldOf(kind))).toBe(KIND_TOKENS[kind]);
	});

	it("writes field-list on a group shown on one screen and nothing on any other group", () => {
		expect(fieldAppearance(fieldOf("group", { fieldList: true }))).toBe(
			"field-list",
		);
		expect(fieldAppearance(fieldOf("group"))).toBeUndefined();
	});

	it("writes numeric on a Text question with a number keypad", () => {
		expect(fieldAppearance(fieldOf("text", { keypad: "numbers" }))).toBe(
			"numeric",
		);
	});

	it.each([
		[
			"single_select",
			"fuzzy combobox",
			{ choiceLayout: { kind: "search", matchWords: "android-fuzzy" } },
			"fuzzy combobox",
		],
		[
			"single_select",
			"combobox fuzzy",
			{ choiceLayout: { kind: "search", matchWords: "fuzzy" } },
			"combobox fuzzy",
		],
		[
			"single_select",
			"quick compact-3",
			{ choiceLayout: { kind: "grid", columns: 3, advanceOnChoice: true } },
			"quick compact-3",
		],
		[
			"single_select",
			"compact-3 quick",
			{ choiceLayout: { kind: "grid", advanceOnChoice: true } },
			"quick compact",
		],
		[
			"single_select",
			"compact-2147483648",
			{ choiceLayout: { kind: "grid" } },
			"compact",
		],
		[
			"single_select",
			"label list-nolabel",
			{
				choiceLayout: {
					kind: "platforms",
					web: { kind: "row-without-label" },
					android: { kind: "ordinary" },
				},
			},
			"list-nolabel list",
		],
		[
			"multi_select",
			"label list-nolabel",
			{
				choiceLayout: {
					kind: "platforms",
					web: { kind: "headings" },
					android: { kind: "ordinary" },
				},
			},
			"label list",
		],
		[
			"single_select",
			"minimal",
			{ choiceLayout: { kind: "dropdown" } },
			"minimal",
		],
		[
			"single_select",
			"minimal hint-as-placeholder",
			{ choiceLayout: { kind: "dropdown" }, hintPlacement: "placeholder" },
			"minimal hint-as-placeholder",
		],
		[
			"image",
			"signature 2-per-row",
			{ webSignature: true, itemsPerRow: "2" },
			"signature 2-per-row",
		],
		[
			"group",
			"group-collapse\tgroup-border",
			{ collapse: "closed", border: true },
			"group-collapse group-border",
		],
		[
			"date",
			"gregorian cancel",
			{ calendar: "gregorian-with-clear" },
			"gregorian cancel",
		],
		["signature", "signature", {}, "signature"],
		["date", "ethiopian", { calendar: "ethiopian" }, "ethiopian"],
		[
			"date",
			"ethiopian 2-per-row",
			{ calendar: "ethiopian", itemsPerRow: "2" },
			"ethiopian 2-per-row",
		],
		[
			"text",
			"000123456789012345678901234567890-per-row",
			{ itemsPerRow: "123456789012345678901234567890" },
			"123456789012345678901234567890-per-row",
		],
		[
			"audio",
			"broadcast-abc-def broadcast-two",
			{ sendTopics: ["abc-def", "two"] },
			"broadcast-abc-def broadcast-two",
		],
		[
			"text",
			"receive-a-b-file",
			{ receiveFrom: { channel: "a-b", field: "file" } },
			"receive-a-b-file",
		],
	] as const)(
		"recovers %s %s with the worker and editor readings preserved",
		(kind, raw, expected, canonical) => {
			const settings = readFieldAppearance(kind, raw);
			expect(settings).toEqual(expected);
			expect(settings && writeFieldAppearance(kind, settings)).toBe(canonical);
		},
	);
});

it("admits the legacy filename receiver and prints its canonical spelling", () => {
	const field = fieldOf("text", {
		receiveFrom: { channel: "document", field: "indexed" },
	});
	expect(fieldDisplayProblem(field)).toBeUndefined();
	expect(fieldAppearance(field)).toBe("receive-document-filename");
	expect(readFieldAppearance("text", "receive-document-indexed")).toEqual({
		receiveFrom: { channel: "document", field: "filename" },
	});
});

/** Every element below `root`, in document order. */
function elements(root: Element): Element[] {
	const out: Element[] = [];
	const walk = (element: Element) => {
		out.push(element);
		for (const child of element.children.filter(isTag)) walk(child);
	};
	walk(root);
	return out;
}

/** How many of the document's fields of each display shape a form holds. */
function expectedControls(doc: BlueprintDoc): Record<string, number> {
	const counts: Record<string, number> = {
		"trigger minimal": 0,
		"upload signature": 0,
		"group field-list": 0,
	};
	for (const field of Object.values(doc.fields)) {
		if (field === undefined) continue;
		if (field.kind === "label") counts["trigger minimal"]++;
		if (field.kind === "signature") counts["upload signature"]++;
		if (
			field.kind === "section" ||
			(field.kind === "group" && field.fieldList === true)
		)
			counts["group field-list"]++;
	}
	return counts;
}

describe("the emitted appearance of existing documents", () => {
	it("is unchanged over a seeded corpus of admitted documents", () => {
		const docs = fc.sample(blueprintDocArbitrary, {
			seed: 20261113,
			numRuns: 60,
		});
		let controls = 0;
		for (const doc of docs) {
			const hq = expandDoc(doc);
			const found: Record<string, number> = {
				"trigger minimal": 0,
				"upload signature": 0,
				"group field-list": 0,
			};
			const others: string[] = [];
			for (const source of Object.values(hq._attachments)) {
				if (typeof source !== "string") continue;
				for (const top of parseXml(source).children.filter(isTag))
					for (const element of elements(top)) {
						if (element.name === "trigger")
							expect(element.attribs.appearance).toBe("minimal");
						const appearance = element.attribs.appearance;
						if (appearance === undefined) continue;
						const shape = `${element.name} ${appearance}`;
						if (shape in found) found[shape]++;
						else others.push(shape);
						controls++;
					}
			}
			expect(others).toEqual([]);
			expect(found).toEqual(expectedControls(doc));
		}
		expect(controls).toBeGreaterThan(20);
	});
});
