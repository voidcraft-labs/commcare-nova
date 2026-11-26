import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { simpleSearchInputDef } from "@/lib/domain";
import { rawRangeCriterion } from "../dateRangeInputValidation";
import {
	androidSelectedRangeDay,
	androidStartingRangeLabel,
	startingSearchRange,
	webSearchRangeDraft,
} from "../searchRangeAnswer";

const range = simpleSearchInputDef(
	testUuid("search-range-proof"),
	"period",
	"Dates",
	"date-range",
	"period",
);

describe("the query manager's starting dates", () => {
	it.each([
		["UTC", "2024-03-10", "2024-03-11"],
		["America/New_York", "2024-03-09", "2024-03-10"],
		["Asia/Kolkata", "2024-03-10", "2024-03-11"],
		["Pacific/Kiritimati", "2024-03-10", "2024-03-11"],
	])("reads the pinned formatter in %s", (zone, from, to) => {
		expect(androidSelectedRangeDay("2024-03-10", zone)).toBe(from);
		expect(
			startingSearchRange("2024-03-10 to 2024-03-11", "device-zone", zone),
		).toEqual({ kind: "pair", from, to });
		expect(
			startingSearchRange(
				"__range__2024-03-10__2024-03-11",
				"device-zone",
				zone,
			),
		).toEqual({ kind: "pair", from: "2024-03-10", to: "2024-03-11" });
	});
	it("keeps lenient calendar input, reversed bounds and an incomplete starting value distinct", () => {
		expect(startingSearchRange("2024-02-30 to 2024-2-28tail", "utc")).toEqual({
			kind: "pair",
			from: "2024-03-01",
			to: "2024-02-28",
		});
		expect(startingSearchRange("2024-01-01 to ", "utc")).toEqual({
			kind: "unparsed",
			text: "2024-01-01 to ",
		});
		expect(startingSearchRange("", "utc")).toEqual({
			kind: "unparsed",
			text: "",
		});
	});
	it("preserves Core’s split and HQ’s blank-or-range criterion on malformed default fallback", () => {
		const period = "__range__2024-01-01__2024-12-31";
		expect(androidStartingRangeLabel("__range__soon__later")).toBe(
			"soon to later",
		);
		expect(rawRangeCriterion(`#,#${period}`)).toEqual({
			kind: "range",
			from: "2024-01-01",
			to: "2024-12-31",
			missing: true,
		});
		expect(rawRangeCriterion(`${period}#,#later`)).toEqual({
			kind: "bad-range",
		});
		expect(rawRangeCriterion("")).toEqual({
			kind: "text",
			values: [],
			missing: true,
		});
		expect(rawRangeCriterion("a#,#b#,#")).toEqual({
			kind: "text",
			values: ["a", "b"],
			missing: false,
		});
	});
	it.each([
		["UTC", "2024-01-03", "2024-01-04"],
		["America/Los_Angeles", "2024-01-02", "2024-01-03"],
	])(
		"shows HQ's midnight rollover and hour-only offset in %s",
		(zone, from, to) => {
			const value = "__range__2024-01-02T24:00:00Z__2024-01-04T00:00:00+00";
			const project = (text: string) =>
				webSearchRangeDraft(
					[range],
					new Map([["period:starting", text]]),
					zone,
				);
			expect(Object.fromEntries(project(value).draft)).toEqual({
				"period:from": from,
				"period:to": to,
			});
			expect(
				project(value.replace("24:00:00", "24:00:01")).unavailable?.inputUuid,
			).toBe(range.uuid);
		},
	);
	it("displays the Web Apps date spellings and identifies a field that cannot open", () => {
		const values = (text: string) => new Map([["period:starting", text]]);
		expect(
			Object.fromEntries(
				webSearchRangeDraft([range], values("1/2/2024 to 3/9/2024")).draft,
			),
		).toEqual({ "period:from": "2024-01-02", "period:to": "2024-03-09" });
		expect(
			Object.fromEntries(
				webSearchRangeDraft([range], values("2024-04-01")).draft,
			),
		).toEqual({ "period:starting": "__range__2024-04-01" });
		const stamp = values("2024-01-01T00:00:00+00:00");
		expect(
			webSearchRangeDraft([range], stamp, "America/Los_Angeles").labels?.get(
				"period",
			),
		).toBe("12/31/2023");
		expect(
			webSearchRangeDraft([range], stamp, "UTC").labels?.get("period"),
		).toBe("1/1/2024");
		const raw = "2024-01-02__2024-02-12__2024-05-21";
		const visible = webSearchRangeDraft([range], values(raw));
		expect(visible.unavailable).toBeUndefined();
		expect(visible.labels?.get("period")).toBe(
			"1/2/2024 to 2/12/2024 to 5/21/2024",
		);
		expect(visible.draft.get("period:starting")).toBe(`__range__${raw}`);
		expect(webSearchRangeDraft([range], visible.draft)).toEqual(visible);
		expect(rawRangeCriterion(raw).kind).toBe("text");
		expect(
			rawRangeCriterion(visible.draft.get("period:starting") ?? "").kind,
		).toBe("bad-range");
		expect(
			webSearchRangeDraft(
				[range],
				values("2024-01-02 to 2024-02-12 to 2024-05-21"),
			).unavailable?.inputUuid,
		).toBe(range.uuid);
		expect(
			webSearchRangeDraft([range], values("tomorrow")).unavailable,
		).toEqual({ inputUuid: range.uuid, input: "Dates" });
		expect(
			webSearchRangeDraft([range], values("first#,#second")).draft.size,
		).toBe(0);
	});
});
