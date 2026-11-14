/**
 * How long a case list's Register launch lasts. The launch belongs to the
 * one form entry it opened: the running app keeps it on the launched form and
 * on the parent case selection admitting that form, and ends it at any other
 * location, so the same form reached later by any route is an ordinary form.
 *
 * `walk` applies the rule as `PreviewShell` does on every location the
 * running app reaches: a launch the location is off the path of ends there,
 * and an ended launch never comes back.
 */

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import type { Location } from "@/lib/routing/types";
import type {
	PreviewCaseListRegistrationEntry,
	PreviewParentCaseRequest,
} from "@/lib/session/types";
import { caseListRegistrationEntryContinues } from "../caseListRegistrationEntry";

const HOST = testUuid("register-host-module");
const FORM_MODULE = testUuid("register-form-module");
const FORM = testUuid("register-form");
const OTHER_FORM = testUuid("register-other-form");
const SELECTOR = testUuid("register-parent-selector");
const GRANDPARENT_SELECTOR = testUuid("register-grandparent-selector");

const entry: PreviewCaseListRegistrationEntry = {
	hostModuleUuid: HOST,
	moduleUuid: FORM_MODULE,
	formUuid: FORM,
};
const launchedForm: Location = {
	kind: "form",
	moduleUuid: FORM_MODULE,
	formUuid: FORM,
};
const hostList: Location = { kind: "cases", moduleUuid: HOST };

interface Step {
	readonly loc: Location;
	readonly request?: PreviewParentCaseRequest;
}

/** The launch after each location, as the running app holds it. */
function walk(
	steps: readonly Step[],
): (PreviewCaseListRegistrationEntry | undefined)[] {
	let held: PreviewCaseListRegistrationEntry | undefined = entry;
	return steps.map(({ loc, request }) => {
		if (
			held !== undefined &&
			!caseListRegistrationEntryContinues(held, loc, request)
		)
			held = undefined;
		return held;
	});
}

describe("caseListRegistrationEntryContinues", () => {
	it("keeps the launch on the form it opened, on any of that form's pages", () => {
		expect(
			walk([
				{ loc: launchedForm },
				{ loc: { ...launchedForm, selectedUuid: testUuid("a-question") } },
				{
					loc: { kind: "form-links", moduleUuid: FORM_MODULE, formUuid: FORM },
				},
				{
					loc: {
						kind: "form-operations",
						moduleUuid: FORM_MODULE,
						formUuid: FORM,
					},
				},
				{
					loc: {
						kind: "form-condition",
						moduleUuid: FORM_MODULE,
						formUuid: FORM,
					},
				},
				{ loc: launchedForm },
			]),
		).toEqual([entry, entry, entry, entry, entry, entry]);
	});

	it("ends the launch when the worker leaves the form unsubmitted, so the same form reached again is an ordinary form", () => {
		/* Back to the host list (browser Back or the breadcrumb), then the
		 * same form again from the app tree, a finding or browser Forward. */
		expect(
			walk([{ loc: launchedForm }, { loc: hostList }, { loc: launchedForm }]),
		).toEqual([entry, undefined, undefined]);
	});

	it("ends the launch at any location off its path, whatever moved there", () => {
		for (const away of [
			{ kind: "home" },
			{ kind: "module", moduleUuid: FORM_MODULE },
			{ kind: "cases", moduleUuid: FORM_MODULE },
			{ kind: "form", moduleUuid: FORM_MODULE, formUuid: OTHER_FORM },
			{ kind: "app-setup", section: "users" },
		] as const satisfies readonly Location[])
			expect(
				walk([{ loc: launchedForm }, { loc: away }, { loc: launchedForm }]),
			).toEqual([entry, undefined, undefined]);
	});

	it("keeps the launch through the parent case selection that admits the launched form, through every selector of a chain, and on into the form", () => {
		const resume = launchedForm;
		expect(
			walk([
				{ loc: launchedForm },
				{
					loc: { kind: "cases", moduleUuid: SELECTOR },
					request: {
						selectingModuleUuid: SELECTOR,
						returnModuleUuids: [FORM_MODULE],
						resumeLocation: resume,
						cancelLocation: { kind: "home" },
					},
				},
				{
					loc: { kind: "cases", moduleUuid: GRANDPARENT_SELECTOR },
					request: {
						selectingModuleUuid: GRANDPARENT_SELECTOR,
						returnModuleUuids: [SELECTOR, FORM_MODULE],
						resumeLocation: resume,
						cancelLocation: { kind: "home" },
					},
				},
				{
					loc: {
						kind: "cases",
						moduleUuid: GRANDPARENT_SELECTOR,
						caseId: "grandparent-1",
					},
					request: {
						selectingModuleUuid: GRANDPARENT_SELECTOR,
						returnModuleUuids: [SELECTOR, FORM_MODULE],
						resumeLocation: resume,
						cancelLocation: { kind: "home" },
					},
				},
				{
					loc: { kind: "cases", moduleUuid: SELECTOR },
					request: {
						selectingModuleUuid: SELECTOR,
						returnModuleUuids: [FORM_MODULE],
						resumeLocation: resume,
						cancelLocation: { kind: "home" },
					},
				},
				{ loc: launchedForm },
			]),
		).toEqual([entry, entry, entry, entry, entry, entry]);
	});

	it("ends the launch when its parent case selection is cancelled, or left for another selection", () => {
		const request: PreviewParentCaseRequest = {
			selectingModuleUuid: SELECTOR,
			returnModuleUuids: [FORM_MODULE],
			resumeLocation: launchedForm,
			cancelLocation: { kind: "module", moduleUuid: HOST },
		};
		expect(
			walk([
				{ loc: launchedForm },
				{ loc: { kind: "cases", moduleUuid: SELECTOR }, request },
				{ loc: { kind: "module", moduleUuid: HOST } },
				{ loc: launchedForm },
			]),
		).toEqual([entry, entry, undefined, undefined]);
		expect(
			walk([
				{ loc: launchedForm },
				{
					loc: { kind: "cases", moduleUuid: SELECTOR },
					request: {
						...request,
						resumeLocation: {
							kind: "form",
							moduleUuid: FORM_MODULE,
							formUuid: OTHER_FORM,
						},
					},
				},
				{ loc: launchedForm },
			]),
		).toEqual([entry, undefined, undefined]);
	});

	it("ends the launch at a selector's case list no pending selection for the launched form asked for", () => {
		const selectorList: Location = { kind: "cases", moduleUuid: SELECTOR };
		expect(
			caseListRegistrationEntryContinues(entry, selectorList, undefined),
		).toBe(false);
		/* A request whose own selector is another module. */
		expect(
			caseListRegistrationEntryContinues(entry, selectorList, {
				selectingModuleUuid: GRANDPARENT_SELECTOR,
				returnModuleUuids: [FORM_MODULE],
				resumeLocation: launchedForm,
			}),
		).toBe(false);
		/* A selection started from a menu, which resumes no form. */
		expect(
			caseListRegistrationEntryContinues(entry, selectorList, {
				selectingModuleUuid: SELECTOR,
				returnModuleUuids: [FORM_MODULE],
				cancelLocation: { kind: "home" },
			}),
		).toBe(false);
	});
});
