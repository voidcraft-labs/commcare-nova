// The module screen's navigation rules.
//
// These decide where a worker lands on a module URL and what a form click does,
// and they are subtle enough to be worth pinning: a bare case list must never
// leave the empty module URL in history, and the case-first redirect must NOT
// fire while authoring, because the form menu is the authoring surface.
//
// Pure `f(state)`: the component reads these and performs the effect, so there
// is no DOM to mount here.

import { describe, expect, it } from "vitest";
import { formLaunch, moduleScreenLanding } from "../moduleScreenNavigation";

const CASE_FIRST = {
	hasModule: true,
	isBareCaseList: false,
	isCaseFirst: true,
} as const;

describe("moduleScreenLanding", () => {
	it("shows the form menu for an ordinary module in either mode", () => {
		for (const mode of ["edit", "preview"] as const) {
			expect(
				moduleScreenLanding({
					hasModule: true,
					isBareCaseList: false,
					isCaseFirst: false,
					mode,
				}),
			).toEqual({ kind: "form-menu" });
		}
	});

	it("keeps the form menu for a case-first module while authoring", () => {
		// The menu IS the authoring surface: redirecting would make a case-first
		// module's forms unreachable from its own URL in the builder.
		expect(moduleScreenLanding({ ...CASE_FIRST, mode: "edit" })).toEqual({
			kind: "form-menu",
		});
	});

	it("pushes the case list for a case-first module in the running app", () => {
		// Pushes rather than replaces: the module is a real, reachable screen.
		expect(moduleScreenLanding({ ...CASE_FIRST, mode: "preview" })).toEqual({
			kind: "open-case-list",
		});
	});

	it("keeps parent and already-selected case-first modules on their menus", () => {
		expect(
			moduleScreenLanding({
				...CASE_FIRST,
				mode: "preview",
				hasChildren: true,
			}),
		).toEqual({ kind: "form-menu" });
		expect(
			moduleScreenLanding({
				...CASE_FIRST,
				mode: "preview",
				hasSelectedCase: true,
			}),
		).toEqual({ kind: "form-menu" });
	});

	it("replaces history for a bare case list in either mode", () => {
		// A formless module's URL must never become a back-button stop.
		for (const mode of ["edit", "preview"] as const) {
			expect(
				moduleScreenLanding({
					hasModule: true,
					isBareCaseList: true,
					isCaseFirst: false,
					mode,
				}),
			).toEqual({ kind: "replace-with-case-list" });
		}
	});

	it("lets the bare-case-list rule win over the case-first rule", () => {
		// Both can hold at once. Replacing is the stronger claim, and it applies
		// in edit mode where the case-first push deliberately does not.
		expect(
			moduleScreenLanding({
				hasModule: true,
				isBareCaseList: true,
				isCaseFirst: true,
				mode: "edit",
			}),
		).toEqual({ kind: "replace-with-case-list" });
	});

	it("never redirects before the module resolves from the URL", () => {
		// Redirecting on an unresolved module would navigate using an id we do
		// not have yet.
		expect(
			moduleScreenLanding({
				hasModule: false,
				isBareCaseList: true,
				isCaseFirst: true,
				mode: "preview",
			}),
		).toEqual({ kind: "form-menu" });
	});
});

describe("formLaunch", () => {
	it("sends a case-loading form through case selection", () => {
		for (const formType of ["followup", "close"] as const) {
			expect(formLaunch({ formType, moduleHasCaseType: true })).toEqual({
				kind: "select-case-first",
			});
		}
	});

	it("opens a registration form directly", () => {
		expect(
			formLaunch({ formType: "registration", moduleHasCaseType: true }),
		).toEqual({ kind: "open-form" });
	});

	it("opens a case-loading form directly when its module has no case type", () => {
		// There is no list to select from, so routing to one would dead-end.
		expect(
			formLaunch({ formType: "followup", moduleHasCaseType: false }),
		).toEqual({ kind: "open-form" });
	});
});
