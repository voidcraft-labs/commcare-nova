import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import type { PreviewScreen } from "@/lib/preview/engine/types";
import { previewMenuCaseContext } from "@/lib/preview/menuProjection";
import type { BreadcrumbItem } from "@/lib/routing/breadcrumbs";
import {
	type PreviewTrailForm,
	previewBreadcrumbLetGo,
	previewBreadcrumbTrail,
	previewCaseTargetBindsLocation,
	previewTrailHeldCases,
} from "@/lib/routing/previewBreadcrumbs";
import type { Location } from "@/lib/routing/types";
import type {
	PreviewCaseTarget,
	PreviewSelectedCase,
} from "@/lib/session/types";

const moduleUuid = testUuid("module-1");
const registerUuid = testUuid("form-register");
const followupUuid = testUuid("form-followup");
const closeUuid = testUuid("form-close");

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

const formLoc = (formUuid: ReturnType<typeof testUuid>): Location => ({
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
	language?: "eng" | "spa";
	loc: Location;
	moduleForms?: PreviewTrailForm[];
	previewCaseTarget?: PreviewCaseTarget;
	previewSelectedCase?: PreviewSelectedCase;
}) {
	return previewBreadcrumbTrail({
		language: args.language,
		loc: args.loc,
		baseBreadcrumbs: baseFor(args.loc),
		moduleUuid: args.loc.kind === "home" ? undefined : moduleUuid,
		moduleForms: args.moduleForms ?? forms,
		previewCaseTarget: args.previewCaseTarget,
		previewSelectedCase: args.previewSelectedCase,
	});
}

describe("previewCaseTargetBindsLocation", () => {
	it("binds when the target names the form the user is on", () => {
		expect(
			previewCaseTargetBindsLocation(formLoc(followupUuid), {
				formUuid: followupUuid,
				cases: [{ caseId: "c1", caseName: "Ana" }],
			}),
		).toBe(true);
	});

	it("does NOT bind when the target names a different form", () => {
		expect(
			previewCaseTargetBindsLocation(formLoc(registerUuid), {
				formUuid: followupUuid,
				cases: [{ caseId: "c1", caseName: "Ana" }],
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
				{
					formUuid: followupUuid,
					cases: [{ caseId: "c1", caseName: "Ana" }],
				},
			),
		).toBe(false);
	});
});

describe("previewBreadcrumbTrail — form screens", () => {
	it("uses the parent menu trail when a child condition renders there", () => {
		const parentUuid = testUuid("module-parent");
		const childCondition: Location = {
			kind: "module-condition",
			moduleUuid,
		};
		const trail = previewBreadcrumbTrail({
			loc: childCondition,
			baseBreadcrumbs: [
				home,
				{
					key: `m:${parentUuid}`,
					label: "Care",
					location: { kind: "module", moduleUuid: parentUuid },
				},
				moduleCrumb,
				{
					key: "module-condition",
					label: "When it appears",
					location: childCondition,
				},
			],
			moduleUuid,
			moduleForms: forms,
			previewCaseTarget: undefined,
			previewSelectedCase: undefined,
			renderedScreen: { type: "module", moduleUuid: parentUuid },
		});

		expect(trail.map((crumb) => crumb.label)).toEqual(["Home", "Care"]);
	});

	it("names each case a menu screen holds after the menu that chose it, as Web Apps' trail does", () => {
		const parentUuid = testUuid("module-parent");
		const parentCrumb: BreadcrumbItem = {
			key: `m:${parentUuid}`,
			label: "Care",
			location: { kind: "module", moduleUuid: parentUuid },
		};
		const onMenu = (
			renderedModule: typeof moduleUuid,
			menuHeldCases: Parameters<
				typeof previewBreadcrumbTrail
			>[0]["menuHeldCases"],
		) =>
			previewBreadcrumbTrail({
				loc: { kind: "module", moduleUuid: renderedModule },
				baseBreadcrumbs:
					renderedModule === parentUuid
						? [home, parentCrumb]
						: [home, parentCrumb, moduleCrumb],
				moduleUuid: renderedModule,
				moduleForms: forms,
				previewCaseTarget: undefined,
				previewSelectedCase: undefined,
				renderedScreen: { type: "module", moduleUuid: renderedModule },
				menuHeldCases,
			});
		// App / Menu / Case: the case's crumb reaches the menu holding it.
		const own = onMenu(parentUuid, [
			{ moduleUuid: parentUuid, cases: [{ caseId: "c1", caseName: "Ana" }] },
		]);
		expect(own.map((crumb) => crumb.label)).toEqual(["Home", "Care", "Ana"]);
		expect(own[2]).toMatchObject({
			location: { kind: "module", moduleUuid: parentUuid },
			holdsCaseOn: parentUuid,
		});
		// A menu screen's case crumb reaches that menu screen, never a case
		// list's form menu, whatever case target the session still holds.
		expect(own[2].holdsCaseListMenu).toBeUndefined();
		// A submenu going on with its parent's case: the case after the
		// parent's crumb, then the submenu. The parent's own parent case, which
		// a list the trail does not name chose, was asked for by the parent's
		// command, so it follows the parent's crumb, before the parent's case.
		const elsewhere = testUuid("elsewhere");
		const child = onMenu(moduleUuid, [
			{ moduleUuid: elsewhere, cases: [{ caseId: "x", caseName: "Rao" }] },
			{ moduleUuid: parentUuid, cases: [{ caseId: "c1", caseName: "Ana" }] },
		]);
		expect(child.map((crumb) => crumb.label)).toEqual([
			"Home",
			"Care",
			"Rao",
			"Ana",
			"Households",
		]);
		// Its crumb reaches the screen after it, Care's list, keeping the case
		// chosen up to it; Ana's keeps both.
		expect(child[2]).toMatchObject({
			location: { kind: "cases", moduleUuid: parentUuid },
			parentCaseOn: parentUuid,
			keepsCasesOf: [elsewhere],
		});
		expect(child[2].holdsCaseOn).toBeUndefined();
		expect(child[3]).toMatchObject({
			holdsCaseOn: parentUuid,
			keepsCasesOf: [elsewhere, parentUuid],
		});
		// Nothing held, nothing added.
		expect(onMenu(parentUuid, []).map((crumb) => crumb.label)).toEqual([
			"Home",
			"Care",
		]);
	});

	it("names no menu without a screen on a submenu's own screen, its case list or its forms", () => {
		const aboveUuid = testUuid("module-above");
		const aboveCrumb: BreadcrumbItem = {
			key: `m:${aboveUuid}`,
			label: "Care",
			location: { kind: "module", moduleUuid: aboveUuid },
		};
		const trailAt = (
			loc: Location,
			renderedScreen: Parameters<
				typeof previewBreadcrumbTrail
			>[0]["renderedScreen"],
		) =>
			previewBreadcrumbTrail({
				loc,
				baseBreadcrumbs: [
					home,
					aboveCrumb,
					moduleCrumb,
					...(loc.kind === "form"
						? [{ key: `f:${loc.formUuid}`, label: "?", location: loc }]
						: []),
				],
				moduleUuid,
				moduleForms: forms,
				previewCaseTarget: undefined,
				previewSelectedCase: undefined,
				renderedScreen,
				screenlessModuleUuids: new Set([aboveUuid]),
			}).map((crumb) => crumb.label);

		expect(
			trailAt({ kind: "module", moduleUuid }, { type: "module", moduleUuid }),
		).toEqual(["Home", "Households"]);
		expect(
			trailAt({ kind: "cases", moduleUuid }, { type: "caseList", moduleUuid }),
		).toEqual(["Home", "Households"]);
		expect(
			trailAt(formLoc(registerUuid), {
				type: "form",
				moduleUuid,
				formUuid: registerUuid,
			}),
		).toEqual(["Home", "Households", "Register Household"]);
	});

	it("uses Home when a hidden child route cannot run", () => {
		const trail = previewBreadcrumbTrail({
			loc: { kind: "form", moduleUuid, formUuid: followupUuid },
			baseBreadcrumbs: [home, moduleCrumb],
			moduleUuid,
			moduleForms: forms,
			previewCaseTarget: undefined,
			previewSelectedCase: undefined,
			renderedScreen: { type: "home" },
		});

		expect(trail).toEqual([home]);
	});

	it("retains parent and child menu ancestry before the separate case trail", () => {
		const parentUuid = testUuid("module-parent");
		const loc = formLoc(followupUuid);
		const trail = previewBreadcrumbTrail({
			loc,
			baseBreadcrumbs: [
				home,
				{
					key: `m:${parentUuid}`,
					label: "Care",
					location: { kind: "cases", moduleUuid: parentUuid },
				},
				moduleCrumb,
			],
			moduleUuid,
			moduleForms: forms,
			previewCaseTarget: {
				formUuid: followupUuid,
				cases: [{ caseId: "c1", caseName: "Yusuf Patel" }],
			},
			previewSelectedCase: undefined,
		});
		expect(trail.map((crumb) => crumb.label)).toEqual([
			"Home",
			"Care",
			"Households",
			"Household Visit",
			"Yusuf Patel",
		]);
	});

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
				cases: [{ caseId: "c1", caseName: "Yusuf Patel" }],
			},
		});
		expect(trail.map((t) => t.label)).toEqual([
			"Home",
			"Households",
			"Household Visit",
			"Yusuf Patel",
		]);
		expect(trail[2].reselectCaseFor).toBe(followupUuid);
		expect(trail[3].key).toBe("cases:c1");
	});

	it("a form chosen from the menu after its case: the case before the form, its crumb reaching the menu that holds it", () => {
		// Web Apps' trail follows the session's steps, menu then case then
		// form, and the case's crumb cuts the selections back to the case.
		const trail = run({
			loc: formLoc(followupUuid),
			previewCaseTarget: {
				formUuid: followupUuid,
				cases: [{ caseId: "c1", caseName: "Yusuf Patel" }],
				formChosenAfterCase: {
					caseListModuleUuid: moduleUuid,
					fromCaseListMenu: true,
				},
			},
		});
		expect(trail.map((t) => t.label)).toEqual([
			"Home",
			"Households",
			"Yusuf Patel",
			"Household Visit",
		]);
		// The list's own form menu held the case: the crumb carries the cases
		// that menu holds, to reach its history entry again.
		expect(trail[2]).toMatchObject({
			key: "cases:c1",
			location: { kind: "cases", moduleUuid },
			holdsCaseOn: moduleUuid,
			holdsCaseListMenu: [{ caseId: "c1", caseName: "Yusuf Patel" }],
		});
		// The form's crumb is where the worker is: it re-enters no selection.
		expect(trail[3].reselectCaseFor).toBeUndefined();
		expect(trail[3].location).toEqual(formLoc(followupUuid));
	});

	it("puts a case a parent's menu screen holds after that menu's crumb", () => {
		const parentUuid = testUuid("module-parent");
		const trail = previewBreadcrumbTrail({
			loc: formLoc(followupUuid),
			baseBreadcrumbs: [
				home,
				{
					key: `m:${parentUuid}`,
					label: "Care",
					location: { kind: "module", moduleUuid: parentUuid },
				},
				moduleCrumb,
			],
			moduleUuid,
			moduleForms: forms,
			previewCaseTarget: {
				formUuid: followupUuid,
				cases: [{ caseId: "c1", caseName: "Yusuf Patel" }],
				formChosenAfterCase: { caseListModuleUuid: parentUuid },
			},
			previewSelectedCase: undefined,
		});
		expect(trail.map((t) => t.label)).toEqual([
			"Home",
			"Care",
			"Yusuf Patel",
			"Households",
			"Household Visit",
		]);
		expect(trail[2]).toMatchObject({
			location: { kind: "module", moduleUuid: parentUuid },
			holdsCaseOn: parentUuid,
		});
		// A menu screen holds it: the crumb reaches the menu screen.
		expect(trail[2].holdsCaseListMenu).toBeUndefined();
	});

	it("REGRESSION: a register form ignores a follow-up's leftover case target", () => {
		const trail = run({
			loc: formLoc(registerUuid),
			previewCaseTarget: {
				formUuid: followupUuid,
				cases: [{ caseId: "c1", caseName: "Yusuf Patel" }],
			},
		});
		// No 4th "case" crumb — the stale target binds a different form.
		expect(trail.map((t) => t.label)).toEqual([
			"Home",
			"Households",
			"Register Household",
		]);
	});

	it("a case-loading form ignores another case-loading form's target", () => {
		const trail = run({
			loc: formLoc(closeUuid),
			previewCaseTarget: {
				formUuid: followupUuid,
				cases: [{ caseId: "c1", caseName: "Yusuf Patel" }],
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

	it("an after-submit links URL previews the form it configures", () => {
		// Preview from a configuration URL runs the thing it configures, so
		// the trail names the form, never an "After submit" crumb.
		const loc: Location = {
			kind: "form-links",
			moduleUuid,
			formUuid: followupUuid,
			linkUuid: testUuid("link-1"),
		};
		const trail = previewBreadcrumbTrail({
			loc,
			baseBreadcrumbs: [home, moduleCrumb],
			moduleUuid,
			moduleForms: forms,
			previewCaseTarget: {
				formUuid: followupUuid,
				cases: [{ caseId: "c1", caseName: "Yusuf Patel" }],
			},
			previewSelectedCase: undefined,
		});
		expect(trail.map((t) => t.label)).toEqual([
			"Home",
			"Households",
			"Household Visit",
			"Yusuf Patel",
		]);
	});

	it("falls back to a 'Form' label when the form is unknown", () => {
		const trail = run({ loc: formLoc(testUuid("ghost")) });
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

	it("names no form where the list holds none, even a lone case-loading form", () => {
		// With no form chosen before the case, choosing one lists the menu
		// (`menuProjection.ts::previewRequestedForm`), so no form is next.
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
		expect(trail.map((t) => t.label)).toEqual(["Home", "Households"]);
	});

	it("names no form chosen from the menu after its case, and names the case the menu holds", () => {
		// A step back off that form lands on the menu with the case held
		// (`CommCareSession.stepBack`), whose trail is the menu and the case.
		const trail = run({
			loc: { kind: "cases", moduleUuid },
			previewCaseTarget: {
				formUuid: followupUuid,
				cases: [{ caseId: "c1", caseName: "Yusuf Patel" }],
				formChosenAfterCase: {
					caseListModuleUuid: moduleUuid,
					fromCaseListMenu: true,
				},
			},
			previewSelectedCase: { caseId: "c1", caseName: "Yusuf Patel" },
		});
		expect(trail.map((t) => t.label)).toEqual([
			"Home",
			"Households",
			"Yusuf Patel",
		]);
	});

	it.each(["search-config", "detail-config", "data-review"] as const)(
		"%s follows the running case-list destination",
		(kind) => {
			expect(
				run({
					loc: { kind, moduleUuid },
					previewCaseTarget: { formUuid: followupUuid },
				}),
			).toEqual([
				home,
				moduleCrumb,
				{
					key: `pf:${followupUuid}`,
					label: "Household Visit",
					location: { kind: "cases", moduleUuid },
				},
			]);
		},
	);
});

/**
 * A parent case a list off the trail chose (the menu's `parentCaseModuleUuid`
 * names a menu elsewhere). Formplayer adds one breadcrumb per selection as
 * the session steps past it (`MenuSession.handleInput`), and the parent datum
 * belongs to the menu's entry, so its crumb follows the menu's command:
 * after the menu, or after the form chosen before the cases. Each crumb cuts
 * the session back to the screen after it (`CloudcareUrl.spliceSelections`).
 */
describe("previewBreadcrumbTrail: a parent case chosen off the trail", () => {
	const householdsElsewhere = testUuid("module-households-elsewhere");
	const rao = {
		moduleUuid: householdsElsewhere,
		cases: [{ caseId: "h1", caseName: "Rao household" }],
	};

	it("follows the menu's crumb on its menu screen, before the menu's own case", () => {
		const onMenu = (
			menuHeldCases: Parameters<
				typeof previewBreadcrumbTrail
			>[0]["menuHeldCases"],
		) =>
			previewBreadcrumbTrail({
				loc: { kind: "module", moduleUuid },
				baseBreadcrumbs: [home, moduleCrumb],
				moduleUuid,
				moduleForms: forms,
				previewCaseTarget: undefined,
				previewSelectedCase: undefined,
				renderedScreen: { type: "module", moduleUuid },
				menuHeldCases,
			});
		const both = onMenu([
			rao,
			{ moduleUuid, cases: [{ caseId: "p1", caseName: "Asha Rao" }] },
		]);
		expect(both.map((crumb) => crumb.label)).toEqual([
			"Home",
			"Households",
			"Rao household",
			"Asha Rao",
		]);
		// The screen after the parent is the menu's own list, asking for its
		// case under that parent: the menu's case goes, the parent stays.
		expect(both[2]).toMatchObject({
			location: { kind: "cases", moduleUuid },
			parentCaseOn: moduleUuid,
			keepsCasesOf: [householdsElsewhere],
		});
		expect(both[3]).toMatchObject({
			location: { kind: "module", moduleUuid },
			holdsCaseOn: moduleUuid,
			keepsCasesOf: [householdsElsewhere, moduleUuid],
		});
		// The parent alone: its crumb reaches the menu it was the last step to.
		const parentOnly = onMenu([rao]);
		expect(parentOnly.map((crumb) => crumb.label)).toEqual([
			"Home",
			"Households",
			"Rao household",
		]);
		expect(parentOnly[2]).toMatchObject({
			location: { kind: "module", moduleUuid },
			parentCaseOn: moduleUuid,
		});
	});

	it("follows the menu's crumb on the list that asks for the child", () => {
		const trail = previewBreadcrumbTrail({
			loc: { kind: "cases", moduleUuid },
			baseBreadcrumbs: [home, moduleCrumb],
			moduleUuid,
			moduleForms: forms,
			previewCaseTarget: undefined,
			previewSelectedCase: { caseId: "p1", caseName: "Asha Rao" },
			heldBefore: [rao],
		});
		expect(trail.map((crumb) => crumb.label)).toEqual([
			"Home",
			"Households",
			"Rao household",
			"Asha Rao",
		]);
		expect(trail[2]).toMatchObject({
			location: { kind: "cases", moduleUuid },
			parentCaseOn: moduleUuid,
			keepsCasesOf: [householdsElsewhere],
		});
	});

	it("follows the form chosen before the cases, and re-enters the selection holding it", () => {
		const trail = previewBreadcrumbTrail({
			loc: formLoc(followupUuid),
			baseBreadcrumbs: baseFor(formLoc(followupUuid)),
			moduleUuid,
			moduleForms: forms,
			previewCaseTarget: {
				formUuid: followupUuid,
				cases: [{ caseId: "p1", caseName: "Asha Rao" }],
			},
			previewSelectedCase: undefined,
			heldBefore: [rao],
		});
		expect(trail.map((crumb) => crumb.label)).toEqual([
			"Home",
			"Households",
			"Household Visit",
			"Rao household",
			"Asha Rao",
		]);
		expect(trail[3]).toMatchObject({
			parentCaseOn: moduleUuid,
			reselectCaseFor: followupUuid,
			keepsCasesOf: [householdsElsewhere],
		});
	});

	it("comes before the case of a form chosen from the menu after its cases", () => {
		const trail = previewBreadcrumbTrail({
			loc: formLoc(followupUuid),
			baseBreadcrumbs: baseFor(formLoc(followupUuid)),
			moduleUuid,
			moduleForms: forms,
			previewCaseTarget: {
				formUuid: followupUuid,
				cases: [{ caseId: "p1", caseName: "Asha Rao" }],
				formChosenAfterCase: { caseListModuleUuid: moduleUuid },
			},
			previewSelectedCase: undefined,
			heldBefore: [rao],
		});
		expect(trail.map((crumb) => crumb.label)).toEqual([
			"Home",
			"Households",
			"Rao household",
			"Asha Rao",
			"Household Visit",
		]);
		expect(trail[2]).toMatchObject({
			location: { kind: "cases", moduleUuid },
			parentCaseOn: moduleUuid,
			keepsCasesOf: [householdsElsewhere],
		});
		expect(trail[3]).toMatchObject({
			holdsCaseOn: moduleUuid,
			keepsCasesOf: [householdsElsewhere, moduleUuid],
		});
	});
});

describe("bound case cardinality", () => {
	it.each([
		{ cases: [], labels: ["Home", "Households", "Household Visit"] },
		{
			cases: [{ caseId: "c1" }],
			labels: ["Home", "Households", "Household Visit", "1 case"],
		},
		{
			cases: [{ caseId: "c1", caseName: "Ana" }, { caseId: "c2" }],
			labels: ["Home", "Households", "Household Visit", "2 cases"],
		},
	])(
		"names $cases without inventing a bound selection",
		({ cases, labels }) => {
			expect(
				run({
					loc: formLoc(followupUuid),
					previewCaseTarget: { formUuid: followupUuid, cases },
				}).map((crumb) => crumb.label),
			).toEqual(labels);
		},
	);
});

it("localizes worker breadcrumbs without losing unnamed or multiple case identities", () => {
	const target = {
		formUuid: followupUuid,
		cases: [{ caseId: "c1", caseName: "" }],
	};
	const spanish = run({
		language: "spa",
		loc: formLoc(followupUuid),
		previewCaseTarget: target,
	});
	expect(spanish[0].label).toBe("Inicio");
	expect(spanish.at(-1)).toMatchObject({
		key: "cases:c1",
		label: "1 registro",
	});
	expect(
		run({ loc: formLoc(followupUuid), previewCaseTarget: target }).at(-1)
			?.label,
	).toBe("1 case");
	expect(
		run({
			language: "spa",
			loc: formLoc(followupUuid),
			previewCaseTarget: {
				...target,
				cases: [...target.cases, { caseId: "c2", caseName: "Ana" }],
			},
		}).at(-1),
	).toMatchObject({ key: "cases:c1,c2", label: "2 registros" });
	expect(
		run({
			language: "spa",
			loc: { kind: "cases", moduleUuid },
			previewSelectedCase: { caseId: "c1", caseName: "" },
		}).at(-1),
	).toMatchObject({ key: "case:c1", label: "1 registro" });
});

/**
 * The trail of each screen as the session's own selections give it
 * (`previewTrailHeldCases` over `previewMenuHeldSelections` and
 * `previewSelectionsBefore`), and what each crumb's cut lets go
 * (`previewBreadcrumbLetGo`, the one the strip runs). Web Apps' trail
 * names one crumb per selection on every screen (`MenuSession.handleInput`),
 * and a crumb keeps every selection before it (`CloudcareUrl.spliceSelections`).
 */
describe("previewBreadcrumbTrail over the session's own selections", () => {
	const HOUSEHOLDS = testUuid("trail-households");
	const MEMBERS = testUuid("trail-members");
	const HOUSEHOLD_VISIT = testUuid("trail-household-visit");
	const MEMBER_VISIT = testUuid("trail-member-visit");
	const ana = { caseId: "h1", caseName: "Ana household" };
	const bo = { caseId: "p1", caseName: "Bo" };
	const selections = {
		[HOUSEHOLDS]: { caseType: "household", cases: [ana] },
	};

	/** Households and Members (person, whose parent cases Households
	 * chooses), Members a submenu of Households or a menu of its own. */
	function source(membersUnderHouseholds: boolean) {
		const caseTypes = [
			{ name: "household", properties: [] },
			{ name: "person", parent_type: "household", properties: [] },
		];
		const doc = buildDoc({
			caseTypes,
			modules: [
				{
					uuid: HOUSEHOLDS,
					name: "Households",
					caseType: "household",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [
						{
							uuid: HOUSEHOLD_VISIT,
							name: "Household visit",
							type: "followup" as const,
							fields: [f({ kind: "text", id: "notes" })],
						},
					],
				},
				{
					uuid: MEMBERS,
					name: "Members",
					caseType: "person",
					parentCaseModuleUuid: HOUSEHOLDS,
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [
						{
							uuid: MEMBER_VISIT,
							name: "Member visit",
							type: "followup" as const,
							fields: [f({ kind: "text", id: "notes" })],
						},
					],
				},
			],
		});
		if (membersUnderHouseholds)
			doc.modules[MEMBERS].parentModuleUuid = HOUSEHOLDS;
		return { ...doc, caseTypes };
	}
	const crumb = (uuid: typeof HOUSEHOLDS, label: string): BreadcrumbItem => ({
		key: `m:${uuid}`,
		label,
		location: { kind: "module", moduleUuid: uuid },
	});
	const trailAt = (
		menuSource: ReturnType<typeof source>,
		loc: Location,
		renderedScreen: PreviewScreen,
		target?: PreviewCaseTarget,
		previewSelectedCase?: PreviewSelectedCase,
	) => {
		const nested = menuSource.modules[MEMBERS].parentModuleUuid !== undefined;
		const base: BreadcrumbItem[] = [
			home,
			...(nested ? [crumb(HOUSEHOLDS, "Households")] : []),
			crumb(MEMBERS, "Members"),
			...(loc.kind === "form"
				? [{ key: `f:${loc.formUuid}`, label: "?", location: loc }]
				: []),
		];
		return previewBreadcrumbTrail({
			loc,
			baseBreadcrumbs: base,
			moduleUuid: MEMBERS,
			moduleForms: [
				{ uuid: MEMBER_VISIT, name: "Member visit", type: "followup" },
			],
			previewCaseTarget: target,
			previewSelectedCase,
			renderedScreen,
			...previewTrailHeldCases({
				source: menuSource,
				selections,
				loc,
				moduleUuid: MEMBERS,
				renderedScreen,
				previewCaseTarget: target,
			}),
		});
	};
	const formChosenOnMembersMenu: PreviewCaseTarget = {
		formUuid: MEMBER_VISIT,
		cases: [bo],
		formChosenAfterCase: {
			caseListModuleUuid: MEMBERS,
			fromCaseListMenu: true,
		},
	};
	const memberForm: Location = {
		kind: "form",
		moduleUuid: MEMBERS,
		formUuid: MEMBER_VISIT,
	};

	it("names the parent case a submenu goes on with on its list, its case's details and its form", () => {
		const nested = source(true);
		const list = trailAt(
			nested,
			{ kind: "cases", moduleUuid: MEMBERS },
			{ type: "caseList", moduleUuid: MEMBERS },
		);
		expect(list.map((item) => item.label)).toEqual([
			"Home",
			"Households",
			"Ana household",
			"Members",
		]);
		// Ana's crumb reaches Households' menu with Ana still chosen.
		expect(list[2]).toMatchObject({
			location: { kind: "module", moduleUuid: HOUSEHOLDS },
			holdsCaseOn: HOUSEHOLDS,
			keepsCasesOf: [HOUSEHOLDS],
		});
		expect(previewBreadcrumbLetGo(nested, selections, list[2])).toEqual([]);
		// Members' crumb comes after Ana's, so it keeps her too.
		expect(list[3]).toMatchObject({ keepsCasesOf: [HOUSEHOLDS] });
		expect(previewBreadcrumbLetGo(nested, selections, list[3])).toEqual([]);
		// Households' crumb comes before her, and asks for a household again.
		expect(previewBreadcrumbLetGo(nested, selections, list[1])).toEqual([
			HOUSEHOLDS,
		]);
		expect(
			trailAt(
				nested,
				{ kind: "cases", moduleUuid: MEMBERS, caseId: bo.caseId },
				{ type: "caseList", moduleUuid: MEMBERS },
				undefined,
				bo,
			).map((item) => item.label),
		).toEqual(["Home", "Households", "Ana household", "Members", "Bo"]);
		expect(
			trailAt(
				nested,
				memberForm,
				{ type: "form", moduleUuid: MEMBERS, formUuid: MEMBER_VISIT },
				formChosenOnMembersMenu,
			).map((item) => item.label),
		).toEqual([
			"Home",
			"Households",
			"Ana household",
			"Members",
			"Bo",
			"Member visit",
		]);
	});

	it("names a parent case a forms-first menu's list chose after its submenu's command", () => {
		/* Households lists a registration beside its follow-up, so it chooses no
		 * case before its entries, and Members asks for its household there
		 * once its own command is chosen: a device's frame is [Households,
		 * Members, household, …], and Web Apps' trail names the household
		 * after Members. Members' crumb cuts it away; the household's keeps it. */
		const nested = source(true);
		const REGISTER = testUuid("trail-register-household");
		nested.forms[REGISTER] = {
			uuid: REGISTER,
			id: "register",
			name: "Register",
			type: "registration",
		};
		nested.formOrder[HOUSEHOLDS] = [HOUSEHOLD_VISIT, REGISTER];
		const list = trailAt(
			nested,
			{ kind: "cases", moduleUuid: MEMBERS },
			{ type: "caseList", moduleUuid: MEMBERS },
		);
		expect(list.map((item) => item.label)).toEqual([
			"Home",
			"Households",
			"Members",
			"Ana household",
		]);
		expect(list[3]).toMatchObject({
			parentCaseOn: MEMBERS,
			keepsCasesOf: [HOUSEHOLDS],
		});
		expect(list[3].holdsCaseOn).toBeUndefined();
		expect(previewBreadcrumbLetGo(nested, selections, list[2])).toEqual([
			HOUSEHOLDS,
		]);
		expect(previewBreadcrumbLetGo(nested, selections, list[3])).toEqual([]);
		expect(
			trailAt(
				nested,
				memberForm,
				{ type: "form", moduleUuid: MEMBERS, formUuid: MEMBER_VISIT },
				formChosenOnMembersMenu,
			).map((item) => item.label),
		).toEqual([
			"Home",
			"Households",
			"Members",
			"Ana household",
			"Bo",
			"Member visit",
		]);
	});

	it("keeps the parent case a list off the trail chose on the crumb of the case chosen under it", () => {
		const roots = source(false);
		const form = trailAt(
			roots,
			memberForm,
			{ type: "form", moduleUuid: MEMBERS, formUuid: MEMBER_VISIT },
			formChosenOnMembersMenu,
		);
		expect(form.map((item) => item.label)).toEqual([
			"Home",
			"Members",
			"Ana household",
			"Bo",
			"Member visit",
		]);
		const boCrumb = form[3];
		expect(boCrumb).toMatchObject({
			holdsCaseOn: MEMBERS,
			keepsCasesOf: [HOUSEHOLDS, MEMBERS],
		});
		// Bo's crumb keeps the household, so Members' menu still has the
		// parent case it goes on with and asks for none.
		expect(previewBreadcrumbLetGo(roots, selections, boCrumb)).toEqual([]);
		expect(
			previewMenuCaseContext(roots, MEMBERS, selections).requiredParentCase,
		).toBeUndefined();
		// Members' own crumb, before the household's, asks for it again.
		expect(previewBreadcrumbLetGo(roots, selections, form[1])).toEqual([
			HOUSEHOLDS,
		]);
	});

	it("lets go, on the crumb of a form chosen before its cases, the parent case asked for after the form", () => {
		/* Formplayer asks a form's parent case after the form's command, so
		 * the form's crumb cuts the household away and Members' list asks for
		 * one again, holding the form. */
		const roots = source(false);
		const target: PreviewCaseTarget = { formUuid: MEMBER_VISIT, cases: [bo] };
		const form = trailAt(
			roots,
			memberForm,
			{ type: "form", moduleUuid: MEMBERS, formUuid: MEMBER_VISIT },
			target,
		);
		expect(form.map((item) => item.label)).toEqual([
			"Home",
			"Members",
			"Member visit",
			"Ana household",
			"Bo",
		]);
		expect(form[2]).toMatchObject({ reselectCaseFor: MEMBER_VISIT });
		expect(previewBreadcrumbLetGo(roots, selections, form[2])).toEqual([
			HOUSEHOLDS,
		]);
		// The household's crumb, after the form, keeps the household.
		expect(previewBreadcrumbLetGo(roots, selections, form[3])).toEqual([]);
		// The list holding the form names it the same way, its crumb cutting
		// the household away too.
		const list = trailAt(
			roots,
			{ kind: "cases", moduleUuid: MEMBERS },
			{ type: "caseList", moduleUuid: MEMBERS },
			{ formUuid: MEMBER_VISIT },
		);
		expect(list.map((item) => item.label)).toEqual([
			"Home",
			"Members",
			"Member visit",
			"Ana household",
		]);
		expect(list[2].key).toBe(`pf:${MEMBER_VISIT}`);
		expect(previewBreadcrumbLetGo(roots, selections, list[2])).toEqual([
			HOUSEHOLDS,
		]);
		// Where Members is Households' submenu, the household comes before
		// the form, and its crumb keeps it.
		const nestedForm = trailAt(
			source(true),
			memberForm,
			{ type: "form", moduleUuid: MEMBERS, formUuid: MEMBER_VISIT },
			target,
		);
		expect(nestedForm.map((item) => item.label)).toEqual([
			"Home",
			"Households",
			"Ana household",
			"Members",
			"Member visit",
			"Bo",
		]);
		expect(
			previewBreadcrumbLetGo(source(true), selections, nestedForm[4]),
		).toEqual([]);
	});
});

/**
 * A menu's crumb after a parent case a list off the trail chose keeps that
 * case, as Web Apps' crumb keeps every selection before it
 * (`CloudcareUrl.spliceSelections`): Members (person) is a menu of its own
 * whose parent case Households chooses, and Visits (visit) its submenu,
 * going on with Members' case.
 */
describe("previewBreadcrumbLetGo: a menu after a parent case chosen off the trail", () => {
	const HOUSEHOLDS = testUuid("cut-households");
	const MEMBERS = testUuid("cut-members");
	const VISITS = testUuid("cut-visits");
	const caseTypes = [
		{ name: "household", properties: [] },
		{ name: "person", parent_type: "household", properties: [] },
		{ name: "visit", parent_type: "person", properties: [] },
	];
	const followup = (uuid: typeof HOUSEHOLDS, name: string) => ({
		uuid,
		name,
		type: "followup" as const,
		fields: [f({ kind: "text", id: "notes" })],
	});
	const list = () => caseListConfig([{ field: "case_name", header: "Name" }]);
	const doc = buildDoc({
		caseTypes,
		modules: [
			{
				uuid: HOUSEHOLDS,
				name: "Households",
				caseType: "household",
				caseListConfig: list(),
				forms: [followup(testUuid("cut-household-visit"), "Household visit")],
			},
			{
				uuid: MEMBERS,
				name: "Members",
				caseType: "person",
				parentCaseModuleUuid: HOUSEHOLDS,
				caseListConfig: list(),
				forms: [followup(testUuid("cut-member-visit"), "Member visit")],
			},
			{
				uuid: VISITS,
				name: "Visits",
				caseType: "visit",
				parentCaseModuleUuid: MEMBERS,
				caseListConfig: list(),
				forms: [followup(testUuid("cut-visit-check"), "Visit check")],
			},
		],
	});
	doc.modules[VISITS].parentModuleUuid = MEMBERS;
	const source = { ...doc, caseTypes };
	const selections = {
		[HOUSEHOLDS]: {
			caseType: "household",
			cases: [{ caseId: "h1", caseName: "Ana household" }],
		},
		[MEMBERS]: {
			caseType: "person",
			cases: [{ caseId: "p1", caseName: "Bo" }],
		},
	};
	const menuCrumb = (
		uuid: typeof HOUSEHOLDS,
		label: string,
	): BreadcrumbItem => ({
		key: `m:${uuid}`,
		label,
		location: { kind: "module", moduleUuid: uuid },
	});
	const renderedScreen: PreviewScreen = {
		type: "caseList",
		moduleUuid: VISITS,
	};
	const loc: Location = { kind: "cases", moduleUuid: VISITS };
	const trail = previewBreadcrumbTrail({
		loc,
		baseBreadcrumbs: [
			home,
			menuCrumb(MEMBERS, "Members"),
			menuCrumb(VISITS, "Visits"),
		],
		moduleUuid: VISITS,
		moduleForms: [
			{
				uuid: testUuid("cut-visit-check"),
				name: "Visit check",
				type: "followup",
			},
		],
		previewCaseTarget: undefined,
		previewSelectedCase: undefined,
		renderedScreen,
		...previewTrailHeldCases({
			source,
			selections,
			loc,
			moduleUuid: VISITS,
			renderedScreen,
			previewCaseTarget: undefined,
		}),
	});

	it("names the household and the member before Visits", () => {
		expect(trail.map((item) => item.label)).toEqual([
			"Home",
			"Members",
			"Ana household",
			"Bo",
			"Visits",
		]);
	});

	it("keeps both on Visits' crumb, so Members still goes on with its household", () => {
		expect(trail[4]).toMatchObject({ keepsCasesOf: [HOUSEHOLDS, MEMBERS] });
		expect(previewBreadcrumbLetGo(source, selections, trail[4])).toEqual([]);
	});

	it("lets both go on Members' crumb and Home's, which come before them", () => {
		expect(previewBreadcrumbLetGo(source, selections, trail[1])).toEqual([
			HOUSEHOLDS,
			MEMBERS,
		]);
		expect(previewBreadcrumbLetGo(source, selections, trail[0])).toEqual([
			HOUSEHOLDS,
			MEMBERS,
		]);
	});

	it("keeps the household on Bo's crumb, and lets Bo go on the household's", () => {
		const after = (crumb: (typeof trail)[number]) => {
			const gone = new Set<string>(
				previewBreadcrumbLetGo(source, selections, crumb),
			);
			return Object.fromEntries(
				Object.entries(selections).filter(([uuid]) => !gone.has(uuid)),
			);
		};
		expect(
			previewMenuCaseContext(source, MEMBERS, after(trail[3]))
				.requiredParentCase,
		).toBeUndefined();
		expect(previewBreadcrumbLetGo(source, selections, trail[2])).toEqual([
			MEMBERS,
		]);
	});
});
