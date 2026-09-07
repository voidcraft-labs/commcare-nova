import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	proseTemplateSchema,
	proseText,
	type SelectOption,
} from "@/lib/domain";
import { asMediaAssetId } from "@/lib/domain/multimedia";
import {
	optionsSnapshotKey,
	removeOptionDraft,
	replaceOptionLabel,
	replaceOptionMedia,
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
	it("protects the two-option floor and removes by exact occurrence", () => {
		const pair = [red, blue];
		expect(removeOptionDraft(pair, 0)).toBe(pair);
		const third = { ...red, uuid: testUuid("other-red") };
		const three = [red, blue, third];
		expect(removeOptionDraft(three, 3)).toBe(three);
		expect(removeOptionDraft(three, 0)).toEqual([blue, third]);
		expect(removeOptionDraft(three, 2)).toEqual([red, blue]);
	});
});
