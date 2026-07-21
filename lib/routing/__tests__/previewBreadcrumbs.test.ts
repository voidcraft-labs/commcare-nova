/**
 * Tests for the preview-mode breadcrumb derivation.
 *
 * `previewBreadcrumbTrail` is the running-app wayfinding rewrite, pulled out
 * of `BreadcrumbStrip` so the whole class of "the trail names a screen the app
 * isn't on" bugs is provable here rather than only observable in the browser.
 * The headline case is the regression that prompted the extraction: a stale
 * `previewCaseTarget` from a follow-up form must NOT name a case on a register
 * form (or on a different case-loading form) — the breadcrumb gates the case
 * crumb on the SAME predicate the preview engine grafts the case with, so the
 * named case and the loaded case can never disagree.
 */

import { describe, expect, it } from "vitest";
import { asUuid } from "@/lib/domain";
import type { BreadcrumbItem } from "@/lib/routing/hooks";
import {
	type PreviewTrailForm,
	previewBreadcrumbTrail,
	previewCaseTargetBindsLocation,
} from "@/lib/routing/previewBreadcrumbs";
import type { Location } from "@/lib/routing/types";

const moduleUuid = asUuid("module-1");
const registerUuid = asUuid("form-register");
const followupUuid = asUuid("form-followup");
const closeUuid = asUuid("form-close");

/** A case-managing module: one register + two case-loading forms. */
const forms: PreviewTrailForm[] = [
	{ uuid: registerUuid, name: "Register Household", type: "registration" },
	{ uuid: followupUuid, name: "Household Visit", type: "followup" },
	{ uuid: closeUuid, name: "Close Household", type: "close" },
];

const home: BreadcrumbItem = {
	key: "home",
	label: "Home",
	location: { kind: "home" },
};
const moduleCrumb: BreadcrumbItem = {
	key: `m:${moduleUuid}`,
	label: "Households",
	location: { kind: "module", moduleUuid },
};

const formLoc = (formUuid: ReturnType<typeof asUuid>): Location => ({
	kind: "form",
	moduleUuid,
	formUuid,
});

/** The base trail `useBreadcrumbs` produces for a form/cases screen — only its
 *  home + module crumbs are reused. */
const baseFor = (loc: Location): BreadcrumbItem[] =>
	loc.kind === "form"
		? [
				home,
				moduleCrumb,
				{ key: `f:${loc.formUuid}`, label: "?", location: loc },
			]
		: [home, moduleCrumb];

function run(args: {
	loc: Location;
	moduleForms?: PreviewTrailForm[];
	previewCaseTarget?: { formUuid: string; caseId?: string; caseName?: string };
	previewSelectedCase?: { caseId: string; caseName: string };
}) {
	return previewBreadcrumbTrail({
		loc: args.loc,
		baseBreadcrumbs: baseFor(args.loc),
		moduleUuid: args.loc.kind === "home" ? undefined : moduleUuid,
		moduleForms: args.moduleForms ?? forms,
		previewCaseTarget: args.previewCaseTarget as never,
		previewSelectedCase: args.previewSelectedCase,
	});
}

describe("previewCaseTargetBindsLocation", () => {
	it("binds when the target names the form the user is on", () => {
		expect(
			previewCaseTargetBindsLocation(formLoc(followupUuid), {
				formUuid: followupUuid,
				caseId: "c1",
				caseName: "Ana",
			}),
		).toBe(true);
	});

	it("does NOT bind when the target names a different form", () => {
		expect(
			previewCaseTargetBindsLocation(formLoc(registerUuid), {
				formUuid: followupUuid,
				caseId: "c1",
				caseName: "Ana",
			}),
		).toBe(false);
	});

	it("does NOT bind with no target", () => {
		expect(
			previewCaseTargetBindsLocation(formLoc(followupUuid), undefined),
		).toBe(false);
	});

	it("does NOT bind off a form screen (e.g. the case list)", () => {
		expect(
			previewCaseTargetBindsLocation(
				{ kind: "cases", moduleUuid },
				{ formUuid: followupUuid, caseId: "c1", caseName: "Ana" },
			),
		).toBe(false);
	});
});

describe("previewBreadcrumbTrail — form screens", () => {
	it("passes the base trail through at home (no module context)", () => {
		const trail = previewBreadcrumbTrail({
			loc: { kind: "home" },
			baseBreadcrumbs: [home],
			moduleUuid: undefined,
			moduleForms: forms,
			previewCaseTarget: undefined,
			previewSelectedCase: undefined,
		});
		expect(trail).toEqual([home]);
	});

	it("a register form: home > module > form, no case crumb, not reselectable", () => {
		const trail = run({ loc: formLoc(registerUuid) });
		expect(trail.map((t) => t.label)).toEqual([
			"Home",
			"Households",
			"Register Household",
		]);
		expect(trail[2].reselectCaseFor).toBeUndefined();
	});

	it("a case-loading form with its bound case: appends the case, form is reselectable", () => {
		const trail = run({
			loc: formLoc(followupUuid),
			previewCaseTarget: {
				formUuid: followupUuid,
				caseId: "c1",
				caseName: "Yusuf Patel",
			},
		});
		expect(trail.map((t) => t.label)).toEqual([
			"Home",
			"Households",
			"Household Visit",
			"Yusuf Patel",
		]);
		expect(trail[2].reselectCaseFor).toBe(followupUuid);
		expect(trail[3].key).toBe("case:c1");
	});

	it("REGRESSION: a register form ignores a follow-up's leftover case target", () => {
		const trail = run({
			loc: formLoc(registerUuid),
			previewCaseTarget: {
				formUuid: followupUuid,
				caseId: "c1",
				caseName: "Yusuf Patel",
			},
		});
		// No 4th "case" crumb — the stale target binds a different form.
		expect(trail.map((t) => t.label)).toEqual([
			"Home",
			"Households",
			"Register Household",
		]);
		expect(trail.some((t) => t.label === "Yusuf Patel")).toBe(false);
	});

	it("a case-loading form ignores another case-loading form's target", () => {
		const trail = run({
			loc: formLoc(closeUuid),
			previewCaseTarget: {
				formUuid: followupUuid,
				caseId: "c1",
				caseName: "Yusuf Patel",
			},
		});
		expect(trail.map((t) => t.label)).toEqual([
			"Home",
			"Households",
			"Close Household",
		]);
		// Still reselectable (it IS a case-loading form), just no bound case.
		expect(trail[2].reselectCaseFor).toBe(closeUuid);
	});

	it("falls back to a 'Form' label when the form is unknown", () => {
		const trail = run({ loc: formLoc(asUuid("ghost")) });
		expect(trail[2].label).toBe("Form");
		expect(trail[2].reselectCaseFor).toBeUndefined();
	});
});

describe("previewBreadcrumbTrail — case-list screens", () => {
	it("names the seeded continue-target form and the open case", () => {
		const trail = run({
			loc: { kind: "cases", moduleUuid },
			previewCaseTarget: { formUuid: followupUuid },
			previewSelectedCase: { caseId: "c1", caseName: "Yusuf Patel" },
		});
		expect(trail.map((t) => t.label)).toEqual([
			"Home",
			"Households",
			"Household Visit",
			"Yusuf Patel",
		]);
		expect(trail[2].key).toBe(`pf:${followupUuid}`);
		expect(trail[3].key).toBe("case:c1");
	});

	it("omits the form crumb when several case-loading forms are unchosen", () => {
		const trail = run({ loc: { kind: "cases", moduleUuid } });
		expect(trail.map((t) => t.label)).toEqual(["Home", "Households"]);
	});

	it("names the sole case-loading form even before one is picked", () => {
		const trail = run({
			loc: { kind: "cases", moduleUuid },
			moduleForms: [
				{
					uuid: registerUuid,
					name: "Register Household",
					type: "registration",
				},
				{ uuid: followupUuid, name: "Household Visit", type: "followup" },
			],
		});
		expect(trail.map((t) => t.label)).toEqual([
			"Home",
			"Households",
			"Household Visit",
		]);
	});

	it("treats search-config / detail-config like the case list in preview", () => {
		const trail = run({
			loc: { kind: "search-config", moduleUuid },
			previewCaseTarget: { formUuid: followupUuid },
		});
		expect(trail.map((t) => t.label)).toEqual([
			"Home",
			"Households",
			"Household Visit",
		]);
	});

	it("treats the data review URL like the case list in preview", () => {
		// Preview shows the RUNNING app — the data review screen is
		// edit-only, so its URL follows the same running-app rewrite as
		// the config kinds.
		const trail = run({
			loc: { kind: "data-review", moduleUuid },
			previewCaseTarget: { formUuid: followupUuid },
		});
		expect(trail.map((t) => t.label)).toEqual([
			"Home",
			"Households",
			"Household Visit",
		]);
	});
});
