import { describe, expect, it } from "vitest";
import type { ParkedValueEntryWire } from "@/lib/preview/engine/caseDataBindingTypes";
import {
	convertBackNotices,
	dataTypePhrase,
	displayReviewValue,
	filterReviewEntries,
	groupReviewByCase,
	readyIds,
	replacementDraftToValue,
	reviewCounts,
} from "../dataReviewModel";

function entry(over: Partial<ParkedValueEntryWire>): ParkedValueEntryWire {
	return {
		id: "e-1",
		caseId: "c-1",
		caseName: "Maya Okonkwo",
		caseType: "patient",
		property: "next_visit",
		originalValue: "next Tuesday",
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

describe("reviewCounts + filterReviewEntries", () => {
	const entries = [
		entry({ id: "a", restorable: true, blockedBy: null }),
		entry({ id: "b" }),
		entry({ id: "c", dismissedAt: "2026-07-20T10:00:00.000Z" }),
		entry({
			id: "d",
			dismissedAt: "2026-07-20T10:00:00.000Z",
			restorable: true,
			blockedBy: null,
		}),
	];

	it("partitions active and dismissed, with ready narrowing active", () => {
		expect(reviewCounts(entries)).toEqual({ all: 2, ready: 1, dismissed: 2 });
		expect(filterReviewEntries(entries, "all").map((e) => e.id)).toEqual([
			"a",
			"b",
		]);
		expect(filterReviewEntries(entries, "ready").map((e) => e.id)).toEqual([
			"a",
		]);
		expect(filterReviewEntries(entries, "dismissed").map((e) => e.id)).toEqual([
			"c",
			"d",
		]);
	});

	it("readyIds skips dismissed entries even when they are restorable", () => {
		expect(readyIds(entries)).toEqual(["a"]);
	});
});

describe("groupReviewByCase", () => {
	it("anchors on the case, ordering cards by name and rows by property", () => {
		const groups = groupReviewByCase([
			entry({ id: "1", caseId: "c-2", caseName: "Zane Roy", property: "b_p" }),
			entry({ id: "2", caseId: "c-1", caseName: "Ada Obi", property: "z_p" }),
			entry({ id: "3", caseId: "c-2", caseName: "Zane Roy", property: "a_p" }),
			entry({ id: "4", caseId: "c-1", caseName: "Ada Obi", property: "a_p" }),
		]);
		expect(groups.map((g) => g.caseName)).toEqual(["Ada Obi", "Zane Roy"]);
		expect(groups[0]?.entries.map((e) => e.property)).toEqual(["a_p", "z_p"]);
		expect(groups[1]?.entries.map((e) => e.property)).toEqual(["a_p", "b_p"]);
	});

	it("keeps same-named cases as separate cards", () => {
		const groups = groupReviewByCase([
			entry({ id: "1", caseId: "c-1", caseName: "Ada Obi" }),
			entry({ id: "2", caseId: "c-2", caseName: "Ada Obi" }),
		]);
		expect(groups).toHaveLength(2);
	});
});

describe("convertBackNotices", () => {
	it("notices a type change whose active values are all type-blocked and still fit the original", () => {
		const notices = convertBackNotices([
			entry({ id: "1", property: "next_visit" }),
			entry({ id: "2", property: "next_visit", caseId: "c-2" }),
			// Dismissed entries stay out of the derivation.
			entry({
				id: "3",
				property: "next_visit",
				dismissedAt: "2026-07-20T10:00:00.000Z",
			}),
		]);
		expect(notices).toEqual([
			{ property: "next_visit", fromType: "text", toType: "date", count: 2 },
		]);
	});

	it("stays silent when any value is ready or occupied, and for option removals", () => {
		expect(
			convertBackNotices([
				entry({ id: "1" }),
				entry({ id: "2", restorable: true, blockedBy: null }),
			]),
		).toEqual([]);
		expect(
			convertBackNotices([
				entry({ id: "1" }),
				entry({ id: "2", blockedBy: "occupied" }),
			]),
		).toEqual([]);
		expect(
			convertBackNotices([
				entry({
					id: "1",
					property: "risk_level",
					fromType: "single_select",
					toType: "single_select",
				}),
			]),
		).toEqual([]);
	});

	it("requires at least one value that still fits the original type", () => {
		expect(
			convertBackNotices([entry({ id: "1", fitsOriginalType: false })]),
		).toEqual([]);
	});

	it("splits distinct transitions of one property into distinct notices", () => {
		const notices = convertBackNotices([
			entry({ id: "1", property: "p", fromType: "text", toType: "date" }),
			entry({ id: "2", property: "p", fromType: "int", toType: "date" }),
		]);
		expect(notices).toHaveLength(2);
	});
});

describe("dataTypePhrase", () => {
	it("adds the natural article for every countable type, none for text", () => {
		expect(dataTypePhrase("text")).toBe("text");
		expect(dataTypePhrase("date")).toBe("a date");
		expect(dataTypePhrase("int")).toBe("a whole number");
		expect(dataTypePhrase("single_select")).toBe("a select");
	});
});

describe("displayReviewValue", () => {
	it("renders arrays as comma-joined selections and scalars verbatim", () => {
		expect(displayReviewValue(["fever", "chills"])).toBe("fever, chills");
		expect(displayReviewValue("around 1990")).toBe("around 1990");
		expect(displayReviewValue(42)).toBe("42");
	});
});

describe("replacementDraftToValue", () => {
	it("normalizes numbers strictly", () => {
		expect(replacementDraftToValue("int", "42")).toEqual({
			ok: true,
			value: 42,
		});
		expect(replacementDraftToValue("int", "4.2")).toEqual({ ok: false });
		expect(replacementDraftToValue("int", "urgent")).toEqual({ ok: false });
		expect(replacementDraftToValue("decimal", "4.2")).toEqual({
			ok: true,
			value: 4.2,
		});
	});

	it("stamps the UTC designator the strict temporal schemas require", () => {
		expect(replacementDraftToValue("time", "09:30")).toEqual({
			ok: true,
			value: "09:30:00Z",
		});
		expect(replacementDraftToValue("datetime", "2026-07-20T09:30")).toEqual({
			ok: true,
			value: "2026-07-20T09:30:00Z",
		});
	});

	it("rejects empty drafts and multi-select scalar shapes", () => {
		expect(replacementDraftToValue("text", "   ")).toEqual({ ok: false });
		expect(replacementDraftToValue("multi_select", "fever")).toEqual({
			ok: false,
		});
		expect(replacementDraftToValue("multi_select", [])).toEqual({ ok: false });
		expect(replacementDraftToValue("multi_select", ["fever"])).toEqual({
			ok: true,
			value: ["fever"],
		});
	});

	it("passes text through trimmed", () => {
		expect(replacementDraftToValue("text", "  next Tuesday ")).toEqual({
			ok: true,
			value: "next Tuesday",
		});
	});
});
