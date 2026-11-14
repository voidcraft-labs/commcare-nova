import { describe, expect, it } from "vitest";
import { activeActions } from "../../../hq/publishedCaseBlocks";
import type { DraftModule } from "../../context";
import { formTypeRow, readFormType } from "../formType";

const ALWAYS = { type: "always" };
const IF = { type: "if", question: "/data/q", answer: "yes", operator: "=" };

function menu(caseType: string | undefined): DraftModule {
	return { module: caseType === undefined ? {} : { caseType } } as DraftModule;
}

/** A form's actions with the named ones active, as HQ's Case Management saves them. */
function actions(active: Record<string, unknown>): Record<string, unknown> {
	return {
		open_case: { condition: active.open_case ?? { type: "never" } },
		update_case: {
			condition: active.update_case ?? { type: "never" },
			update: {},
		},
		close_case: { condition: active.close_case ?? { type: "never" } },
		subcases: active.subcases ?? [],
	};
}

function typeOf(
	requires: string,
	active: Record<string, unknown>,
	caseType = "patient",
) {
	const stored = actions(active);
	return readFormType(
		requires,
		activeActions(stored, requires),
		menu(caseType),
		(stored.open_case as { condition: { type: string } }).condition.type,
	);
}

function entryOf(
	requires: string,
	active: Record<string, unknown>,
	caseType?: string,
) {
	const stored = actions(active);
	return formTypeRow(
		requires,
		activeActions(stored, requires),
		(stored.open_case as { condition: { type: string } }).condition.type,
		menu(caseType),
	).requires.entry;
}

describe("a basic form's type, by the eleven rows of Form types", () => {
	it("reads an open with no close as a registration", () => {
		expect(typeOf("none", { open_case: ALWAYS })).toBe("registration");
		expect(entryOf("none", { open_case: ALWAYS }, "patient")).toBe(
			"forms-and-case-writes/form-requires-none-open-case-active-close-case-inactive",
		);
	});

	it("reads a conditional open as a registration under its own row", () => {
		expect(typeOf("none", { open_case: IF })).toBe("registration");
		expect(entryOf("none", { open_case: IF }, "patient")).toBe(
			"forms-and-case-writes/form-requires-none-open-case-condition-if",
		);
	});

	it("reads an open beside a close as a registration that closes its case", () => {
		expect(typeOf("none", { open_case: ALWAYS, close_case: ALWAYS })).toBe(
			"registration",
		);
		expect(
			entryOf("none", { open_case: ALWAYS, close_case: ALWAYS }, "patient"),
		).toBe(
			"forms-and-case-writes/form-requires-none-open-case-close-case-active",
		);
	});

	it("reads a form that requires a case as a follow-up, or as a close where it closes", () => {
		expect(typeOf("case", {})).toBe("followup");
		expect(typeOf("case", { close_case: ALWAYS })).toBe("close");
		expect(typeOf("case", { close_case: IF })).toBe("close");
	});

	it("reads a form with no case action, and one whose close has no open in a menu with a case type, as a survey", () => {
		expect(typeOf("none", {})).toBe("survey");
		expect(typeOf("none", { close_case: ALWAYS })).toBe("survey");
		expect(entryOf("none", { close_case: ALWAYS }, "patient")).toBe(
			"forms-and-case-writes/form-requires-none-with-close-case-active-and-no-open-in-a-module-with-a",
		);
	});

	it("refuses an update, a child case or a close with no open, and a referral", () => {
		expect(typeOf("none", { update_case: ALWAYS })).toEqual({
			kind: "finding",
			entry:
				"forms-and-case-writes/form-requires-none-with-update-case-active-and-no-open",
		});
		expect(
			typeOf("none", { subcases: [{ case_type: "child", condition: ALWAYS }] }),
		).toEqual({
			kind: "finding",
			entry:
				"forms-and-case-writes/form-requires-none-with-child-cases-but-no-open",
		});
		expect(typeOf("none", { close_case: ALWAYS }, "")).toEqual({
			kind: "finding",
			entry:
				"forms-and-case-writes/form-requires-none-with-close-case-active-and-no-open-in-a-module-with-no",
		});
		expect(typeOf("referral", {})).toEqual({
			kind: "finding",
			entry: "forms-and-case-writes/form-requires-referral",
		});
	});

	it("never reads a registration as a survey, which would drop its case", () => {
		for (const close of [undefined, ALWAYS, IF])
			expect(
				typeOf("none", {
					open_case: ALWAYS,
					...(close && { close_case: close }),
				}),
			).toBe("registration");
	});
});
