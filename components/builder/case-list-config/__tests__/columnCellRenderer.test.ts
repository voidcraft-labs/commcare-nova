// @vitest-environment happy-dom

import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rowMatchesFilterText } from "@/components/preview/shared/listFilter";
import {
	asUuid,
	calculatedColumn,
	dateColumn,
	idMappingColumn,
	idMappingEntry,
	imageMapColumn,
	imageMapEntry,
	intervalColumn,
	phoneColumn,
	plainColumn,
} from "@/lib/domain";
import { prop, term } from "@/lib/domain/predicate";
import type { CaseRowWithCalculated } from "@/lib/preview/engine/caseDataBindingTypes";
import {
	type ColumnDisplayContext,
	formatDateForPreview,
	formatIntervalForPreview,
	projectColumnDisplay,
	renderCalculatedCell,
	renderColumnCell,
	resolveCalculatedTemporalType,
} from "../columnCellRenderer";

const originalTimeZone = process.env.TZ;
const COLUMN_UUID = asUuid("00000000-0000-4000-8000-000000000001");
const TODAY = new Date("2026-07-17T12:00:00.000Z");
const EMPTY_CONTEXT: ColumnDisplayContext = {
	calculatedTemporalTypes: new Map(),
	caseProperties: [],
	today: TODAY,
};

describe("case-list Preview cell formatting", () => {
	beforeAll(() => {
		process.env.TZ = "America/Los_Angeles";
	});

	afterAll(() => {
		if (originalTimeZone === undefined) {
			delete process.env.TZ;
		} else {
			process.env.TZ = originalTimeZone;
		}
	});

	describe("date columns", () => {
		it("renders every semantic preset with its supported CommCare pattern", () => {
			expect(formatDateForPreview("2026-07-14", "short")).toEqual({
				kind: "value",
				text: "07/14/2026",
			});
			expect(formatDateForPreview("2026-07-14", "long")).toEqual({
				kind: "value",
				text: "July 14, 2026",
			});
			expect(formatDateForPreview("2026-07-14", "iso")).toEqual({
				kind: "value",
				text: "2026-07-14",
			});
		});

		it("honors custom JavaRosa tokens instead of substituting a locale date", () => {
			expect(formatDateForPreview("2026-07-14", "%A, %b %e (%w), %Y")).toEqual({
				kind: "value",
				text: "Tuesday, Jul 14 (2), 2026",
			});
		});

		it("keeps date-only values on their authored day and timestamps local", () => {
			expect(formatDateForPreview("2026-07-14", "%Y-%m-%d")).toEqual({
				kind: "value",
				text: "2026-07-14",
			});
			expect(
				formatDateForPreview("2026-07-14T01:30:00.000Z", "%Y-%m-%d %H:%M"),
			).toEqual({ kind: "value", text: "2026-07-13 18:30" });
		});

		it("uses an explained raw-value fallback for invalid data or a legacy style", () => {
			expect(formatDateForPreview("2026-02-31", "%Y-%m-%d")).toEqual({
				kind: "fallback",
				text: "2026-02-31",
				message: "Showing the original value because it isn’t a valid date",
			});
			expect(formatDateForPreview("2026-07-14", "%Q")).toEqual({
				kind: "fallback",
				text: "2026-07-14",
				message:
					"Showing the original value because Preview can’t use this saved date style",
			});
		});
	});

	describe("phone columns", () => {
		it("renders the promised tappable tel action and keeps the visible number", () => {
			const html = renderToStaticMarkup(
				renderColumnCell(
					phoneColumn(COLUMN_UUID, "phone", "Phone"),
					makeRow({ phone: "+1 202 555 0123" }),
					EMPTY_CONTEXT,
				),
			);
			expect(html).toContain('href="tel:+1 202 555 0123"');
			expect(html).toContain('aria-label="Call +1 202 555 0123"');
			expect(html).toContain("min-h-11");
			expect(html).toContain("min-w-11");
			expect(html).toContain("+1 202 555 0123");
		});
	});

	describe("interval columns", () => {
		it("uses the exact 30.4375-day month divisor and threshold replacement", () => {
			const withinThreshold = intervalColumn(
				COLUMN_UUID,
				"opened_on",
				"Months open",
				3,
				"months",
				"always",
				"Overdue",
			);
			expect(
				formatIntervalForPreview("2026-04-17", withinThreshold, TODAY),
			).toEqual({ kind: "value", text: "2" });

			const overdue = { ...withinThreshold, threshold: 2 };
			expect(formatIntervalForPreview("2026-04-17", overdue, TODAY)).toEqual({
				kind: "value",
				text: "Overdue",
			});
		});

		it("matches the emitted blank, boundary, and future-date branches", () => {
			const flag = intervalColumn(
				COLUMN_UUID,
				"last_visit",
				"Follow-up",
				7,
				"days",
				"flag",
				"Due",
			);
			expect(formatIntervalForPreview("", flag, TODAY)).toEqual({
				kind: "value",
				text: "Due",
			});
			expect(formatIntervalForPreview("2026-07-10", flag, TODAY)).toEqual({
				kind: "value",
				text: "",
			});

			const always = { ...flag, display: "always" as const };
			expect(formatIntervalForPreview("", always, TODAY)).toEqual({
				kind: "value",
				text: "",
			});
			expect(formatIntervalForPreview("2026-07-24", always, TODAY)).toEqual({
				kind: "value",
				text: "-7",
			});
		});

		it("uses the worker's local calendar day after UTC has crossed midnight", () => {
			const column = intervalColumn(
				COLUMN_UUID,
				"last_visit",
				"Days since visit",
				7,
				"days",
				"always",
				"Overdue",
			);
			// 02:00 UTC is still July 17 in the test's America/Los_Angeles zone.
			const localEvening = new Date("2026-07-18T02:00:00.000Z");
			expect(
				formatIntervalForPreview("2026-07-17", column, localEvening),
			).toEqual({ kind: "value", text: "0" });
		});

		it("does not invent an interval for invalid stored data", () => {
			const column = intervalColumn(
				COLUMN_UUID,
				"last_visit",
				"Follow-up",
				1,
				"weeks",
				"always",
				"Due",
			);
			expect(formatIntervalForPreview("not-a-date", column, TODAY)).toEqual({
				kind: "fallback",
				text: "not-a-date",
				message:
					"Preview can’t calculate this interval because the value isn’t a valid date",
			});
		});
	});

	it("renders calculated booleans as worker-facing answers and preserves zero", () => {
		expect(visibleText(renderToStaticMarkup(renderCalculatedCell(true)))).toBe(
			"Yes",
		);
		expect(visibleText(renderToStaticMarkup(renderCalculatedCell(false)))).toBe(
			"No",
		);
		expect(renderToStaticMarkup(renderCalculatedCell(0))).toContain("0");
	});

	it("localizes calculated dates and datetimes without exposing wire text", () => {
		const date = new Date("2026-05-06T00:00:00.000Z");
		const dateHtml = renderToStaticMarkup(renderCalculatedCell(date, "date"));
		expect(visibleText(dateHtml)).toBe(
			date.toLocaleDateString(undefined, {
				day: "numeric",
				month: "long",
				timeZone: "UTC",
				year: "numeric",
			}),
		);
		expect(visibleText(dateHtml)).not.toContain("2026-05-06T");

		// Midnight is a valid datetime too. The authored expression type, not a
		// timestamp heuristic, decides whether its clock is shown.
		const datetime = new Date("2026-05-06T00:00:00.000Z");
		const datetimeHtml = renderToStaticMarkup(
			renderCalculatedCell(datetime, "datetime"),
		);
		expect(visibleText(datetimeHtml)).toBe(
			datetime.toLocaleString(undefined, {
				day: "numeric",
				hour: "numeric",
				minute: "2-digit",
				month: "long",
				year: "numeric",
			}),
		);
		expect(visibleText(datetimeHtml)).not.toContain("2026-05-06T00:00:00.000Z");
		expect(datetimeHtml).toContain('dateTime="2026-05-06T00:00:00.000Z"');
	});

	it("resolves a calculated temporal type from the authored expression", () => {
		const context = {
			caseTypes: [
				{
					name: "patient",
					properties: [
						{
							name: "date_opened",
							label: "Date opened",
							data_type: "date" as const,
						},
					],
				},
			],
			knownInputs: [],
			currentCaseType: "patient",
		};
		expect(
			resolveCalculatedTemporalType(
				calculatedColumn(COLUMN_UUID, "Today", { kind: "today" }),
				context,
			),
		).toBe("date");
		expect(
			resolveCalculatedTemporalType(
				calculatedColumn(COLUMN_UUID, "Now", { kind: "now" }),
				context,
			),
		).toBe("datetime");
		expect(
			resolveCalculatedTemporalType(
				calculatedColumn(
					COLUMN_UUID,
					"Opened",
					term(prop("patient", "date_opened")),
				),
				context,
			),
		).toBe("date");
	});

	it("renders multi-select values as option labels rather than storage JSON", () => {
		const column = plainColumn(COLUMN_UUID, "tags", "Tags");
		const row = makeRow({ tags: ["follow_up", "imported", "vip"] });
		const context: ColumnDisplayContext = {
			...EMPTY_CONTEXT,
			caseProperties: [
				{
					name: "tags",
					label: "Tags",
					data_type: "multi_select" as const,
					options: [
						{ value: "vip", label: "VIP" },
						{ value: "follow_up", label: "Needs follow-up" },
					],
				},
			],
		};

		expect(projectColumnDisplay(column, row, context)).toEqual({
			kind: "value",
			text: "VIP Needs follow-up imported",
		});
		const html = renderToStaticMarkup(renderColumnCell(column, row, context));
		expect(html).toContain("VIP Needs follow-up imported");
		expect(html).not.toContain("[&quot;vip&quot;");
	});

	it("keeps Quick Filter aligned with every semantic cell format", () => {
		const status = idMappingColumn(
			asUuid("00000000-0000-4000-8000-000000000002"),
			"status_code",
			"Status",
			[idMappingEntry("active", "Active"), idMappingEntry("urgent", "Urgent")],
		);
		const visit = dateColumn(
			asUuid("00000000-0000-4000-8000-000000000003"),
			"visit_date",
			"Visit date",
			"long",
		);
		const followUp = intervalColumn(
			asUuid("00000000-0000-4000-8000-000000000004"),
			"visit_date",
			"Follow-up",
			1,
			"days",
			"flag",
			"Follow-up due",
		);
		const ready = calculatedColumn(
			asUuid("00000000-0000-4000-8000-000000000005"),
			"Ready",
			{ kind: "term", term: { kind: "literal", value: true } },
		);
		const row = makeRow(
			{
				status_code: ["urgent", "unknown", "active"],
				visit_date: "2026-07-14",
			},
			{ [ready.uuid]: true },
		);
		const columns = [status, visit, followUp, ready];
		const context: ColumnDisplayContext = EMPTY_CONTEXT;

		expect(rowMatchesFilterText(columns, row, "Active Urgent", context)).toBe(
			true,
		);
		expect(rowMatchesFilterText(columns, row, "July 14", context)).toBe(true);
		expect(rowMatchesFilterText(columns, row, "follow-up due", context)).toBe(
			true,
		);
		expect(rowMatchesFilterText(columns, row, "Yes", context)).toBe(true);
		expect(rowMatchesFilterText([status], row, "unknown", context)).toBe(false);
		expect(rowMatchesFilterText(columns, row, '["active"', context)).toBe(
			false,
		);
	});

	it("uses the first selected image mapping as its alt and filter text", () => {
		const column = imageMapColumn(COLUMN_UUID, "badge", "Badge", [
			imageMapEntry("primary", "asset-primary"),
			imageMapEntry("secondary", "asset-secondary"),
		]);
		const row = makeRow({ badge: ["secondary", "primary"] });
		const context: ColumnDisplayContext = {
			...EMPTY_CONTEXT,
			caseProperties: [
				{
					name: "badge",
					label: "Badge",
					data_type: "single_select",
					options: [
						{ value: "primary", label: "Primary alert" },
						{ value: "secondary", label: "Secondary alert" },
					],
				},
			],
		};

		expect(projectColumnDisplay(column, row, context)).toMatchObject({
			kind: "image",
			text: "Primary alert",
		});
		expect(rowMatchesFilterText([column], row, "primary", context)).toBe(true);
		expect(rowMatchesFilterText([column], row, "secondary", context)).toBe(
			false,
		);
	});

	it("opens malformed-value guidance from a real keyboard and touch target", async () => {
		render(
			renderColumnCell(
				dateColumn(COLUMN_UUID, "visit", "Visit", "long"),
				makeRow({ visit: "not-a-date" }),
				EMPTY_CONTEXT,
			) as ReactElement,
		);
		const trigger = screen.getByRole("button", {
			name: "not-a-date. More information",
		});
		expect(trigger.className).toContain("min-h-11");
		expect(trigger.className).toContain("min-w-11");

		fireEvent.click(trigger);
		expect(await screen.findByText("Why this value is shown")).toBeDefined();
		expect(
			screen.getByText(
				"Showing the original value because it isn’t a valid date",
			),
		).toBeDefined();
	});

	it("preserves calculated missing, invalid-date, and structured fallbacks", () => {
		const missing = renderToStaticMarkup(renderCalculatedCell(null));
		expect(missing).toContain('aria-hidden="true"');
		expect(missing).toContain("—");
		expect(missing).toContain("No value");
		expect(
			renderToStaticMarkup(renderCalculatedCell(new Date(Number.NaN))),
		).toContain("Invalid date");
		const structured = renderToStaticMarkup(
			renderCalculatedCell({ status: "ready" }),
		);
		expect(structured).toContain("Unavailable");
		expect(structured).not.toContain("status");
	});
});

function visibleText(html: string): string {
	return html.replace(/<[^>]+>/g, "");
}

function makeRow(
	properties: Record<string, unknown>,
	calculated: CaseRowWithCalculated["calculated"] = {},
): CaseRowWithCalculated {
	return {
		case_id: "11111111-1111-4111-8111-111111111111",
		case_type: "patient",
		case_name: "Example",
		app_id: "app-test",
		owner_id: "owner-test",
		status: "open",
		opened_on: null,
		modified_on: null,
		closed_on: null,
		external_id: null,
		parent_case_id: null,
		properties: properties as never,
		calculated,
	} as CaseRowWithCalculated;
}
