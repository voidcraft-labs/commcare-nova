import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	proseTemplateSchema,
	proseText,
	type SelectOption,
} from "@/lib/domain";
import { selectOptionSchema } from "@/lib/domain/fields/base";
import { asMediaAssetId } from "@/lib/domain/multimedia";
import {
	optionsSnapshotKey,
	optionValueRefusal,
	removeOptionDraft,
	replaceOptionLabel,
	replaceOptionMedia,
	replaceOptionPlainLabel,
} from "../optionsDraftModel";

const red: SelectOption = {
	uuid: testUuid("red"),
	value: "red",
	label: proseText("Red"),
};
const blue: SelectOption = {
	uuid: testUuid("blue"),
	value: "blue",
	label: proseText("Blue"),
};
describe("actual option draft mutations", () => {
	it("compares structural snapshots while preserving ordered rows and authored content", () => {
		const same = {
			label: { parts: [{ text: "Red", kind: "text" as const }] },
			value: "red",
			uuid: red.uuid,
		};
		expect(optionsSnapshotKey([red, blue])).toBe(
			optionsSnapshotKey([same, blue]),
		);
		expect(optionsSnapshotKey([red, blue])).not.toBe(
			optionsSnapshotKey([blue, red]),
		);
		expect(optionsSnapshotKey([red, blue])).not.toBe(
			optionsSnapshotKey([{ ...red, value: "crimson" }, blue]),
		);
	});
	it("renames only generated option tokens and skips siblings", () => {
		const generated = {
			...red,
			value: "option_1",
			label: proseText("Option 1"),
		};
		expect(
			replaceOptionLabel([generated, blue], 0, proseText("Blue"))[0],
		).toEqual({ ...generated, value: "blue_2", label: proseText("Blue") });
		const result = replaceOptionLabel([red, blue], 0, proseText("Crimson"));
		expect(result[0]).toEqual({ ...red, label: proseText("Crimson") });
		expect(result[1]).toBe(blue);
		expect(red.label).toEqual(proseText("Red"));
	});
	it("preserves a stored token when its apparently generated label carries a reference", () => {
		const authored = {
			...red,
			value: "option_1",
			label: proseTemplateSchema.parse({
				parts: [
					{ kind: "text", text: "Option 1" },
					{ kind: "field-ref", uuid: testUuid("field") },
				],
			}),
		};
		expect(
			replaceOptionLabel([authored, blue], 0, proseText("Renamed"))[0].value,
		).toBe("option_1");
	});
	it("replaces or removes only media while preserving the option identity and label", () => {
		const image = {
			image: asMediaAssetId("55555555-5555-4555-8555-555555555555"),
		};
		const attached = replaceOptionMedia([red, blue], 0, image);
		expect(attached[0]).toEqual({ ...red, media: image });
		expect(attached[1]).toBe(blue);
		const cleared = replaceOptionMedia(attached, 0, undefined);
		expect(cleared[0]).toEqual(red);
		expect(cleared[0]).not.toHaveProperty("media");
		expect(attached[0].media).toBe(image);
	});
	it("writes a choice's Format text as the stored plainLabel and clears it back to absence", () => {
		const off = replaceOptionPlainLabel([red, blue], 0, true);
		expect(off[0]).toEqual({ ...red, plainLabel: true });
		expect(off[1]).toBe(blue);
		expect(selectOptionSchema.parse(off[0])).toEqual(off[0]);
		expect(optionsSnapshotKey(off)).not.toBe(optionsSnapshotKey([red, blue]));
		const on = replaceOptionPlainLabel(off, 0, false);
		expect(on[0]).toEqual(red);
		expect(on[0]).not.toHaveProperty("plainLabel");
		expect(optionsSnapshotKey(on)).toBe(optionsSnapshotKey([red, blue]));
	});
	it("protects the one-option floor and removes by exact occurrence", () => {
		const one = [red];
		expect(removeOptionDraft(one, 0)).toBe(one);
		expect(removeOptionDraft([red, blue], 0)).toEqual([blue]);
		const third = { ...red, uuid: testUuid("other-red") };
		const three = [red, blue, third];
		expect(removeOptionDraft(three, 3)).toBe(three);
		expect(removeOptionDraft(three, 0)).toEqual([blue, third]);
		expect(removeOptionDraft(three, 2)).toEqual([red, blue]);
	});
});

describe("the value a row may keep beside its siblings", () => {
	const option = (name: string, value: string): SelectOption => ({
		uuid: testUuid(name),
		value,
		label: proseText(name),
	});

	it("refuses a value an earlier choice holds and offers one no choice holds", () => {
		const draft = [
			option("Yes", "yes"),
			option("Yes again", "yes_2"),
			option("Also yes", "yes"),
		];
		expect(optionValueRefusal(draft, 0)).toBeUndefined();
		expect(optionValueRefusal(draft, 1)).toBeUndefined();
		expect(optionValueRefusal(draft, 2)).toBe(
			'Another choice already stores "yes", so a saved answer couldn\'t say which was chosen. "yes_3" is free here.',
		);
	});

	it("keeps values that differ only in case, and leaves a blank value to the commit", () => {
		const draft = [
			option("Yes", "yes"),
			option("YES", "Yes"),
			option("Blank", ""),
			option("Blank too", ""),
		];
		expect(optionValueRefusal(draft, 1)).toBeUndefined();
		expect(optionValueRefusal(draft, 3)).toBeUndefined();
		expect(optionValueRefusal(draft, 9)).toBeUndefined();
	});

	it("keeps one kind of quote mark and refuses a value holding both", () => {
		const draft = [
			option("It's", "it's"),
			option("Say hi", 'say"hi"'),
			option("Both", `it's_"x"`),
		];
		expect(optionValueRefusal(draft, 0)).toBeUndefined();
		expect(optionValueRefusal(draft, 1)).toBeUndefined();
		expect(optionValueRefusal(draft, 2)).toBe(
			"This value holds both an apostrophe and a double quote. Keeping one kind works.",
		);
	});

	it("refuses a value CommCare HQ reads as a data source, offering the gate's repair", () => {
		// The value is the text of the choice's <value> in the form's source,
		// where HQ's build reads instance('…') as a data source; the box keeps
		// the value as typed, so the refusal stands beneath the row.
		const draft = [
			option("Clinic", "instance_abc"),
			option("Other clinic", "instance('abc')"),
			option("Spaced", "instance(\u001c'abc')"),
			option("Word", "instance"),
		];
		expect(optionValueRefusal(draft, 1)).toBe(
			'CommCare HQ reads this value as a data source when it builds the form, not as a choice. "instance_abc_2" works.',
		);
		expect(optionValueRefusal(draft, 2)).toMatch(/^CommCare HQ reads/);
		expect(optionValueRefusal(draft, 0)).toBeUndefined();
		expect(optionValueRefusal(draft, 3)).toBeUndefined();
	});
});
