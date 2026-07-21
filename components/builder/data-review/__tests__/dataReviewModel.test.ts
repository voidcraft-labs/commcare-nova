import { describe, expect, it } from "vitest";
import type { ParkedValueEntryWire } from "@/lib/preview/engine/caseDataBindingTypes";
import {
	displayReviewValue,
	filterReviewEntries,
	groupReviewByCase,
	heldCaseCount,
	replacementDraftToValue,
	reviewCounts,
	standingPhrase,
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
		standing: "blocked",
		...over,
	};
}

describe("reviewCounts + filterReviewEntries", () => {
	const entries = [
		entry({ id: "a", standing: "fits" }),
		entry({ id: "b" }),
		entry({ id: "c", dismissedAt: "2026-07-20T10:00:00.000Z" }),
		entry({
			id: "d",
			dismissedAt: "2026-07-20T10:00:00.000Z",
			standing: "fits",
		}),
	];

	it("partitions the list into ready-to-review and dismissed", () => {
		expect(reviewCounts(entries)).toEqual({ ready: 2, dismissed: 2 });
		expect(filterReviewEntries(entries, "ready").map((e) => e.id)).toEqual([
			"a",
			"b",
		]);
		expect(filterReviewEntries(entries, "dismissed").map((e) => e.id)).toEqual([
			"c",
			"d",
		]);
	});
});

describe("heldCaseCount", () => {
	it("counts distinct cases with active entries — dismissed entries hold nothing", () => {
		expect(
			heldCaseCount([
				entry({ id: "1", caseId: "c-1" }),
				entry({ id: "2", caseId: "c-1" }),
				entry({ id: "3", caseId: "c-2" }),
				entry({
					id: "4",
					caseId: "c-3",
					dismissedAt: "2026-07-20T10:00:00.000Z",
				}),
			]),
		).toBe(2);
		expect(heldCaseCount([])).toBe(0);
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

describe("displayReviewValue", () => {
	it("renders arrays as comma-joined selections and scalars verbatim", () => {
		expect(displayReviewValue(["fever", "chills"])).toBe("fever, chills");
		expect(displayReviewValue("around 1990")).toBe("around 1990");
		expect(displayReviewValue(42)).toBe("42");
	});
});

describe("standingPhrase", () => {
	it("names what a blocked value fails to be, from the current type", () => {
		expect(standingPhrase("blocked", "date")).toBe("Isn't a date");
		expect(standingPhrase("blocked", "datetime")).toBe("Isn't a date & time");
		expect(standingPhrase("blocked", "int")).toBe("Isn't a whole number");
		expect(standingPhrase("blocked", "geopoint")).toBe("Isn't a GPS point");
		expect(standingPhrase("blocked", "text")).toBe("Isn't text");
	});

	it("phrases select blocks as choice shape — a select schema carries no option enum, so only shape can block", () => {
		expect(standingPhrase("blocked", "single_select")).toBe(
			"Isn't a single choice",
		);
		expect(standingPhrase("blocked", "multi_select")).toBe(
			"Isn't a list of choices",
		);
	});

	it("stays typeless when the client sees no declaration for a blocked entry", () => {
		expect(standingPhrase("blocked", undefined)).toBe(
			"Doesn't fit the property now",
		);
	});

	it("tells the non-blocked standings plainly", () => {
		expect(standingPhrase("fits", "text")).toBe("Fits the property again");
		expect(standingPhrase("undeclared", undefined)).toBe(
			"The property was removed",
		);
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

	it("reads clock times the way people write them — 12-hour first, bare 24-hour still accepted", () => {
		expect(replacementDraftToValue("time", "2:30 PM")).toEqual({
			ok: true,
			value: "14:30:00Z",
		});
		expect(replacementDraftToValue("time", "9:05am")).toEqual({
			ok: true,
			value: "09:05:00Z",
		});
		expect(replacementDraftToValue("time", "12:00 AM")).toEqual({
			ok: true,
			value: "00:00:00Z",
		});
		expect(replacementDraftToValue("time", "12:15 pm")).toEqual({
			ok: true,
			value: "12:15:00Z",
		});
		expect(replacementDraftToValue("time", "14:30:05")).toEqual({
			ok: true,
			value: "14:30:05Z",
		});
		expect(replacementDraftToValue("datetime", "2026-07-20T2:05 pm")).toEqual({
			ok: true,
			value: "2026-07-20T14:05:00Z",
		});
	});

	it("rejects malformed or out-of-range clock times instead of trusting the text", () => {
		expect(replacementDraftToValue("time", "25:00")).toEqual({ ok: false });
		expect(replacementDraftToValue("time", "12:60")).toEqual({ ok: false });
		expect(replacementDraftToValue("time", "13:00 PM")).toEqual({ ok: false });
		expect(replacementDraftToValue("time", "noonish")).toEqual({ ok: false });
		// A pending half of the datetime pair — date picked, time not
		// typed yet (or the reverse) — is not submittable.
		expect(replacementDraftToValue("datetime", "2026-07-20T")).toEqual({
			ok: false,
		});
		expect(replacementDraftToValue("datetime", "T2:30 PM")).toEqual({
			ok: false,
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
