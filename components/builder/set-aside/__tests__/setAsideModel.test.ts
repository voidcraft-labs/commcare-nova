import { describe, expect, it } from "vitest";
import type { ParkedValueEntryWire } from "@/lib/preview/engine/caseDataBindingTypes";
import {
	displaySetAsideValue,
	filterSetAsideEntries,
	formatSetAsideTimestamp,
	groupSetAsideEntries,
	replacementDraftToValue,
	setAsideCounts,
} from "../setAsideModel";

function entry(over: Partial<ParkedValueEntryWire>): ParkedValueEntryWire {
	return {
		id: "e-1",
		caseId: "c-1",
		caseName: "Maya Okonkwo",
		caseType: "patient",
		property: "dob",
		originalValue: "around 1990",
		reason: "cast text→date failed",
		fromType: "text",
		toType: "date",
		createdAt: "2026-07-20T09:41:00.000Z",
		dismissedAt: null,
		restorable: false,
		blockedBy: "type",
		fitsOriginalType: true,
		...over,
	};
}

describe("setAsideCounts + filterSetAsideEntries", () => {
	const entries = [
		entry({ id: "a" }),
		entry({ id: "b", restorable: true, blockedBy: null }),
		entry({ id: "c", dismissedAt: "2026-07-19T10:00:00.000Z" }),
	];

	it("partitions active vs dismissed; restorable narrows the active list", () => {
		expect(setAsideCounts(entries)).toEqual({
			all: 2,
			restorable: 1,
			dismissed: 1,
		});
		expect(filterSetAsideEntries(entries, "all").map((e) => e.id)).toEqual([
			"a",
			"b",
		]);
		expect(
			filterSetAsideEntries(entries, "restorable").map((e) => e.id),
		).toEqual(["b"]);
		expect(
			filterSetAsideEntries(entries, "dismissed").map((e) => e.id),
		).toEqual(["c"]);
	});
});

describe("groupSetAsideEntries", () => {
	it("groups by (property, transition), newest event first, with per-group verdict rollups", () => {
		const groups = groupSetAsideEntries([
			// Two dob parks from one conversion (blocked by type, fit text).
			entry({ id: "d1", createdAt: "2026-07-20T09:41:00.000Z" }),
			entry({ id: "d2", createdAt: "2026-07-20T09:41:01.000Z" }),
			// An older age conversion whose values became restorable.
			entry({
				id: "a1",
				property: "age",
				fromType: "decimal",
				toType: "int",
				originalValue: "34.5",
				createdAt: "2026-06-12T08:00:00.000Z",
				restorable: true,
				blockedBy: null,
			}),
		]);
		expect(groups).toHaveLength(2);
		const [newest, older] = groups;
		expect(newest?.property).toBe("dob");
		expect(newest?.latestCreatedAt).toBe("2026-07-20T09:41:01.000Z");
		expect(newest?.isTypeChange).toBe(true);
		expect(newest?.restorableIds).toEqual([]);
		expect(newest?.allRestorable).toBe(false);
		// The convert-back callout's honesty condition: both blocked-by-
		// type entries still fit the original text type.
		expect(newest?.fitsOriginalCount).toBe(2);

		expect(older?.property).toBe("age");
		expect(older?.restorableIds).toEqual(["a1"]);
		expect(older?.allRestorable).toBe(true);
	});

	it("keeps a narrow-options park (same type both sides) a non-type-change group", () => {
		const groups = groupSetAsideEntries([
			entry({
				property: "color",
				fromType: "single_select",
				toType: "single_select",
				restorable: true,
				blockedBy: null,
			}),
		]);
		expect(groups[0]?.isTypeChange).toBe(false);
		expect(groups[0]?.fitsOriginalCount).toBe(0);
	});

	it("splits the same property's two different transitions into two groups", () => {
		const groups = groupSetAsideEntries([
			entry({ id: "x", fromType: "text", toType: "date" }),
			entry({ id: "y", fromType: "date", toType: "int" }),
		]);
		expect(groups).toHaveLength(2);
	});
});

describe("formatSetAsideTimestamp", () => {
	const now = new Date(2026, 6, 20, 12, 0); // local 2026-07-20 12:00

	it("names today and yesterday with the clock time", () => {
		expect(
			formatSetAsideTimestamp(new Date(2026, 6, 20, 9, 41).toISOString(), now),
		).toBe("today, 09:41");
		expect(
			formatSetAsideTimestamp(new Date(2026, 6, 19, 14, 2).toISOString(), now),
		).toBe("yesterday, 14:02");
	});

	it("collapses older dates to day-month, adding the year across years", () => {
		expect(
			formatSetAsideTimestamp(new Date(2026, 5, 12, 8, 0).toISOString(), now),
		).toBe("12 Jun");
		expect(
			formatSetAsideTimestamp(new Date(2025, 5, 12, 8, 0).toISOString(), now),
		).toBe("12 Jun 2025");
	});

	it("renders nothing for an unparseable timestamp", () => {
		expect(formatSetAsideTimestamp("not a date", now)).toBe("");
	});
});

describe("displaySetAsideValue", () => {
	it("renders arrays as comma-joined selections and scalars verbatim", () => {
		expect(displaySetAsideValue(["fever", "chills"])).toBe("fever, chills");
		expect(displaySetAsideValue("around 1990")).toBe("around 1990");
		expect(displaySetAsideValue(34.5)).toBe("34.5");
	});
});

describe("replacementDraftToValue", () => {
	it("numbers parse strictly into typed values", () => {
		expect(replacementDraftToValue("int", "42")).toEqual({
			ok: true,
			value: 42,
		});
		expect(replacementDraftToValue("int", "34.5")).toEqual({ ok: false });
		expect(replacementDraftToValue("decimal", "34.5")).toEqual({
			ok: true,
			value: 34.5,
		});
		expect(replacementDraftToValue("decimal", "abc")).toEqual({ ok: false });
	});

	it("temporal drafts pick up the explicit UTC designator the strict row schema requires", () => {
		expect(replacementDraftToValue("date", "1990-05-12")).toEqual({
			ok: true,
			value: "1990-05-12",
		});
		// Native <input type="time"> emits HH:MM — strict `format: "time"`
		// (RFC 3339 full-time) demands seconds + an offset.
		expect(replacementDraftToValue("time", "14:30")).toEqual({
			ok: true,
			value: "14:30:00Z",
		});
		// Native <input type="datetime-local"> emits YYYY-MM-DDTHH:MM.
		expect(replacementDraftToValue("datetime", "2026-01-05T14:30")).toEqual({
			ok: true,
			value: "2026-01-05T14:30:00Z",
		});
	});

	it("selections submit as their typed shapes; empties are not submittable", () => {
		expect(replacementDraftToValue("single_select", "red")).toEqual({
			ok: true,
			value: "red",
		});
		expect(replacementDraftToValue("multi_select", ["fever"])).toEqual({
			ok: true,
			value: ["fever"],
		});
		expect(replacementDraftToValue("multi_select", [])).toEqual({ ok: false });
		expect(replacementDraftToValue("multi_select", "fever")).toEqual({
			ok: false,
		});
		expect(replacementDraftToValue("text", "   ")).toEqual({ ok: false });
	});
});
