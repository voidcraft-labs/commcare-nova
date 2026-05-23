// State-model coverage for the optional-slot mutation helper every
// section editor with an optional sub-config routes through. The
// load-bearing distinction the helper guarantees is "absent key"
// vs "explicitly-undefined value" — the doc store applies module
// patches via `Object.assign`, so a `key: undefined` source would
// land as an own enumerable property and fool downstream
// `key in obj` presence checks.

import { describe, expect, it } from "vitest";
import { setOptionalSlot } from "@/components/builder/shared/setOptionalSlot";

interface SearchConfig {
	readonly searchScreenTitle?: string;
	readonly searchScreenSubtitle?: string;
	readonly excludedOwnerIds?: string;
}

describe("setOptionalSlot — set arm", () => {
	it("writes the slot on an undefined parent, materializing an empty object as the base", () => {
		const next = setOptionalSlot<SearchConfig, "searchScreenTitle">(
			undefined,
			"searchScreenTitle",
			"Find a patient",
		);
		expect(next).toEqual({ searchScreenTitle: "Find a patient" });
	});

	it("writes the slot on an existing parent, preserving every other slot", () => {
		const before: SearchConfig = {
			searchScreenTitle: "Find a patient",
			searchScreenSubtitle: "Existing subtitle",
		};
		const next = setOptionalSlot(before, "excludedOwnerIds", "owner-a");
		expect(next).toEqual({
			searchScreenTitle: "Find a patient",
			searchScreenSubtitle: "Existing subtitle",
			excludedOwnerIds: "owner-a",
		});
	});

	it("returns a fresh object rather than mutating the input", () => {
		const before: SearchConfig = { searchScreenTitle: "Hello" };
		const next = setOptionalSlot(before, "searchScreenSubtitle", "Sub");
		expect(next).not.toBe(before);
		expect(before).toEqual({ searchScreenTitle: "Hello" });
	});

	it("overwrites an existing slot value", () => {
		const before: SearchConfig = { searchScreenTitle: "Old" };
		const next = setOptionalSlot(before, "searchScreenTitle", "New");
		expect(next.searchScreenTitle).toBe("New");
	});
});

describe("setOptionalSlot — drop arm", () => {
	it("removes the slot key entirely when next is undefined (key absent, not key:undefined)", () => {
		const before: SearchConfig = {
			searchScreenTitle: "Title",
			excludedOwnerIds: "owner-a",
		};
		const next = setOptionalSlot(before, "excludedOwnerIds", undefined);
		// The load-bearing claim: the key is NOT present on the
		// resulting object (no own enumerable property).
		expect("excludedOwnerIds" in next).toBe(false);
		// The other keys are intact.
		expect(next).toEqual({ searchScreenTitle: "Title" });
	});

	it("returns an empty object when dropping a slot on an undefined parent", () => {
		// The `current ?? {}` short-circuit lets sections whose parent
		// slot is itself optional route through with the same helper.
		const next = setOptionalSlot<SearchConfig, "searchScreenTitle">(
			undefined,
			"searchScreenTitle",
			undefined,
		);
		expect(next).toEqual({});
		expect("searchScreenTitle" in next).toBe(false);
	});

	it("returns an empty object when dropping a slot on an empty parent", () => {
		const next = setOptionalSlot<SearchConfig, "searchScreenTitle">(
			{},
			"searchScreenTitle",
			undefined,
		);
		expect("searchScreenTitle" in next).toBe(false);
	});

	it("leaves other present slots untouched while dropping one", () => {
		const before: SearchConfig = {
			searchScreenTitle: "Title",
			searchScreenSubtitle: "Subtitle",
			excludedOwnerIds: "owner-a",
		};
		const next = setOptionalSlot(before, "searchScreenSubtitle", undefined);
		expect("searchScreenSubtitle" in next).toBe(false);
		expect(next.searchScreenTitle).toBe("Title");
		expect(next.excludedOwnerIds).toBe("owner-a");
	});

	it("is idempotent on an already-absent key", () => {
		const before: SearchConfig = { searchScreenTitle: "Title" };
		const next = setOptionalSlot(before, "excludedOwnerIds", undefined);
		// The key wasn't on the input either; the output also doesn't
		// carry it. Other slots are preserved.
		expect("excludedOwnerIds" in next).toBe(false);
		expect(next.searchScreenTitle).toBe("Title");
	});
});
