import { describe, expect, it } from "vitest";
import { type ColumnSort, columnSort, sortBlanks } from "@/lib/domain";
import { blanksAfterDirectionChange } from "../sortBlanksChoice";

// The Default order composer turns a rule's direction through this function,
// handing it the side the person last picked with the Blank values control.

describe("blanksAfterDirectionChange", () => {
	it("keeps blanks last through two turns of an ascending rule the person set to last", () => {
		const picked = "last" as const;
		const start = columnSort("asc", 0, picked);
		const turned = blanksAfterDirectionChange(start, "desc", picked);
		// Last is descending's own, so the stored rule holds no blanks.
		expect(turned).toEqual({ direction: "desc", priority: 0 });
		const back = blanksAfterDirectionChange(turned, "asc", picked);
		expect(back).toEqual(start);
		expect(sortBlanks(back)).toBe("last");
	});

	it("keeps a stored side the person never picked in this workspace", () => {
		const stored: ColumnSort = {
			direction: "desc",
			priority: 2,
			blanks: "first",
		};
		const turned = blanksAfterDirectionChange(stored, "asc", undefined);
		expect(turned).toEqual({ direction: "asc", priority: 2 });
		expect(sortBlanks(turned)).toBe("first");
	});

	it("follows the new direction where nothing was chosen", () => {
		const plain = columnSort("asc", 1);
		const turned = blanksAfterDirectionChange(plain, "desc", undefined);
		expect(turned).toEqual({ direction: "desc", priority: 1 });
		expect(sortBlanks(turned)).toBe("last");
	});

	it("writes the picked side against the new direction where they differ", () => {
		const turned = blanksAfterDirectionChange(
			columnSort("desc", 0),
			"asc",
			"last",
		);
		expect(turned).toEqual({ direction: "asc", priority: 0, blanks: "last" });
	});
});
