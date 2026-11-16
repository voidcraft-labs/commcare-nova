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
import { formLaunch, moduleScreenLanding } from "@/lib/domain/navigation";

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

	it("opens a case-first parent's case list before its submenus, and its menu once the case is chosen", () => {
		// CommCare asks for the case before it lists anything on the screen,
		// submenu tiles included (`CommCareSession.getNeededData` over the
		// entries of every `<menu>` with the screen's id; a submenu is a
		// `<menu root>` of its own, no entry of them), and `MenuLoader` lists
		// the forms and the submenus once the case is chosen. The Core class
		// `MenuScreensRuntimeTest` holds this landing on the menu-screens
		// documents.
		expect(
			moduleScreenLanding({
				...CASE_FIRST,
				mode: "preview",
				hasChildren: true,
			}),
		).toEqual({ kind: "open-case-list" });
		for (const hasChildren of [false, true])
			expect(
				moduleScreenLanding({
					...CASE_FIRST,
					mode: "preview",
					hasChildren,
					hasSelectedCase: true,
				}),
			).toEqual({ kind: "form-menu" });
	});

	it("opens a bare case list with submenus on its list, and lists the submenus once its case is chosen", () => {
		const bare = {
			hasModule: true,
			isBareCaseList: true,
			isCaseFirst: false,
			hasChildren: true,
		} as const;
		expect(moduleScreenLanding({ ...bare, mode: "preview" })).toEqual({
			kind: "replace-with-case-list",
		});
		expect(
			moduleScreenLanding({ ...bare, mode: "preview", hasSelectedCase: true }),
		).toEqual({ kind: "form-menu" });
		// Authoring keeps the menu, where the author reaches the submenus.
		expect(moduleScreenLanding({ ...bare, mode: "edit" })).toEqual({
			kind: "form-menu",
		});
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

it("retains the actual module-menu step for a bare module endpoint", () => {
	expect(
		moduleScreenLanding({
			hasModule: true,
			isBareCaseList: true,
			isCaseFirst: true,
			mode: "preview",
			preserveEntryPointMenu: true,
		}),
	).toEqual({ kind: "form-menu" });
});

import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import type { Uuid } from "@/lib/domain";
import { previewParentCaseBeforeMenu } from "@/lib/preview/engine/parentCaseSelection";
import type { Location } from "@/lib/routing/types";
import type { PreviewCaseTarget } from "@/lib/session/types";
import {
	choosePreviewMenuTile,
	previewModuleAsksParentCase,
	previewParentCaseRequestFor,
	previewParentCaseResumeLocation,
	previewTargetKeptForParentCase,
} from "../moduleScreenNavigation";

const MODULE_UUID = testUuid("parent-case-resume-module");
const FORM_UUID = testUuid("parent-case-resume-form");
const FIELD_UUID = testUuid("parent-case-resume-field");

describe("previewParentCaseResumeLocation", () => {
	it.each<Location>([
		{
			kind: "form",
			moduleUuid: MODULE_UUID,
			formUuid: FORM_UUID,
			selectedUuid: FIELD_UUID,
		},
		{
			kind: "cases",
			moduleUuid: MODULE_UUID,
			caseId: "requested-case",
		},
	])("preserves the exact $kind leaf", (location) => {
		expect(previewParentCaseResumeLocation(location, MODULE_UUID)).toBe(
			location,
		);
	});

	it("does not turn an ordinary module menu into a resumable leaf", () => {
		expect(
			previewParentCaseResumeLocation(
				{ kind: "module", moduleUuid: MODULE_UUID },
				MODULE_UUID,
			),
		).toBeUndefined();
	});

	it("does not resume a leaf owned by another module", () => {
		expect(
			previewParentCaseResumeLocation(
				{
					kind: "form",
					moduleUuid: testUuid("another-module"),
					formUuid: FORM_UUID,
				},
				MODULE_UUID,
			),
		).toBeUndefined();
	});
});

describe("previewParentCaseRequestFor", () => {
	const SELECTOR_UUID = testUuid("parent-case-request-selector");
	const GRANDPARENT_UUID = testUuid("parent-case-request-grandparent");
	const STRUCTURAL_PARENT_UUID = testUuid("parent-case-request-menu");
	const leaf: Location = {
		kind: "form",
		moduleUuid: MODULE_UUID,
		formUuid: FORM_UUID,
	};

	it("starts a selection that resumes the leaf its URL names and cancels to its menu", () => {
		expect(
			previewParentCaseRequestFor({
				loc: leaf,
				moduleUuid: MODULE_UUID,
				selectorModuleUuid: SELECTOR_UUID,
				structuralParentUuid: STRUCTURAL_PARENT_UUID,
				pending: undefined,
			}),
		).toEqual({
			selectingModuleUuid: SELECTOR_UUID,
			returnModuleUuids: [MODULE_UUID],
			resumeLocation: leaf,
			cancelLocation: { kind: "module", moduleUuid: STRUCTURAL_PARENT_UUID },
		});
	});

	it("continues a pending selection at a selector that needs its own parent, keeping the leaf rather than resuming the selector's case list", () => {
		const pending = {
			selectingModuleUuid: SELECTOR_UUID,
			returnModuleUuids: [MODULE_UUID],
			resumeLocation: leaf,
			cancelLocation: { kind: "home" } as const,
		};
		expect(
			previewParentCaseRequestFor({
				loc: { kind: "cases", moduleUuid: SELECTOR_UUID },
				moduleUuid: SELECTOR_UUID,
				selectorModuleUuid: GRANDPARENT_UUID,
				structuralParentUuid: STRUCTURAL_PARENT_UUID,
				pending,
			}),
		).toEqual({
			selectingModuleUuid: GRANDPARENT_UUID,
			returnModuleUuids: [SELECTOR_UUID, MODULE_UUID],
			resumeLocation: leaf,
			cancelLocation: { kind: "home" },
		});
	});

	it("resumes no leaf when the pending selection started from a menu", () => {
		expect(
			previewParentCaseRequestFor({
				loc: { kind: "cases", moduleUuid: SELECTOR_UUID },
				moduleUuid: SELECTOR_UUID,
				selectorModuleUuid: GRANDPARENT_UUID,
				structuralParentUuid: null,
				pending: {
					selectingModuleUuid: SELECTOR_UUID,
					returnModuleUuids: [MODULE_UUID],
					cancelLocation: { kind: "home" },
				},
			}).resumeLocation,
		).toBeUndefined();
	});
});

describe("previewTargetKeptForParentCase", () => {
	const HOUSEHOLDS = testUuid("kept-target-households");
	const MEMBERS = testUuid("kept-target-members");
	const REGISTER = testUuid("kept-target-register");
	const VISIT = testUuid("kept-target-visit");
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
						uuid: testUuid("kept-target-household-visit"),
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
						uuid: REGISTER,
						name: "Register member",
						type: "registration" as const,
						fields: [f({ kind: "text", id: "case_name" })],
					},
					{
						uuid: VISIT,
						name: "Member visit",
						type: "followup" as const,
						fields: [f({ kind: "text", id: "notes" })],
					},
				],
			},
		],
	});
	const source = { ...doc, caseTypes };
	const requestFrom = (loc: Location) =>
		previewParentCaseRequestFor({
			loc,
			moduleUuid: MEMBERS,
			selectorModuleUuid: HOUSEHOLDS,
			structuralParentUuid: null,
			pending: undefined,
		});
	const membersList: Location = { kind: "cases", moduleUuid: MEMBERS };

	it("keeps the form the list it resumes holds, chosen before its cases", () => {
		// A form crumb re-entered Members' list holding the visit, and the
		// household it asks for first was cut away.
		expect(
			previewTargetKeptForParentCase(
				source,
				{ formUuid: VISIT, cases: [{ caseId: "p1" }] },
				requestFrom(membersList),
			),
		).toEqual({ formUuid: VISIT });
		expect(
			previewTargetKeptForParentCase(
				source,
				{ formUuid: VISIT },
				requestFrom({ kind: "data-review", moduleUuid: MEMBERS }),
			),
		).toEqual({ formUuid: VISIT });
	});

	it("lets any other target go", () => {
		const kept = (target: PreviewCaseTarget | undefined, loc: Location) =>
			previewTargetKeptForParentCase(source, target, requestFrom(loc));
		// A form chosen from a menu after its case: the list holds no form.
		expect(
			kept(
				{
					formUuid: VISIT,
					cases: [{ caseId: "p1" }],
					formChosenAfterCase: { caseListModuleUuid: MEMBERS },
				},
				membersList,
			),
		).toBeUndefined();
		// A registration form, which no case list holds.
		expect(kept({ formUuid: REGISTER }, membersList)).toBeUndefined();
		// A form the module's menu or the form's own URL resumes.
		expect(
			kept({ formUuid: VISIT }, { kind: "module", moduleUuid: MEMBERS }),
		).toBeUndefined();
		expect(
			kept(
				{ formUuid: VISIT },
				{ kind: "form", moduleUuid: MEMBERS, formUuid: VISIT },
			),
		).toBeUndefined();
		expect(kept(undefined, membersList)).toBeUndefined();
	});
});

describe("a menu that needs a parent case", () => {
	const HOUSEHOLDS = testUuid("tile-households");
	const CASE_FIRST = testUuid("tile-members-case-first");
	const FORMS_FIRST = testUuid("tile-members-forms-first");
	const PLAIN = testUuid("tile-plain");
	const list = () => caseListConfig([{ field: "case_name", header: "Name" }]);
	const followUp = (name: string) => ({
		name,
		type: "followup" as const,
		fields: [f({ kind: "text", id: "note" })],
	});
	const doc = buildDoc({
		caseTypes: [
			{ name: "household", properties: [] },
			{ name: "person", parent_type: "household", properties: [] },
		],
		modules: [
			{
				uuid: HOUSEHOLDS,
				name: "Households",
				caseType: "household",
				caseListConfig: list(),
				forms: [followUp("Visit household")],
			},
			{
				uuid: CASE_FIRST,
				name: "Members",
				caseType: "person",
				parentCaseModuleUuid: HOUSEHOLDS,
				caseListConfig: list(),
				forms: [followUp("Visit member")],
			},
			{
				uuid: FORMS_FIRST,
				name: "Member notes",
				caseType: "person",
				parentCaseModuleUuid: HOUSEHOLDS,
				caseListConfig: list(),
				forms: [
					{
						name: "Note",
						type: "survey" as const,
						fields: [f({ kind: "text", id: "note" })],
					},
					followUp("Check member"),
				],
			},
			{
				uuid: PLAIN,
				name: "Plain",
				caseType: "household",
				caseListConfig: list(),
				forms: [followUp("Plain visit")],
			},
		],
	});
	const source = { ...doc, doc, caseTypes: doc.caseTypes ?? [] };

	/** What one choice of a tile writes, in order. */
	function chooseTile(
		moduleUuid: Uuid,
		cancelLocation: Location,
		landing: "case-list" | "form-menu",
	) {
		const writes: unknown[][] = [];
		choosePreviewMenuTile(
			{
				setPreviewCaseTarget: (target) => writes.push(["target", target]),
				setPreviewParentCaseRequest: (request) =>
					writes.push(["request", request]),
				navigate: {
					push: (next) => writes.push(["push", next]),
					openCaseList: (uuid) => writes.push(["openCaseList", uuid]),
					openModule: (uuid) => writes.push(["openModule", uuid]),
				},
			},
			{ source, moduleUuid, selections: {}, cancelLocation, landing },
		);
		return writes;
	}

	it("lets the case target go before a tile asks for the parent case, from the first menu and from a menu alike", () => {
		/* A form an earlier screen held for a list must not survive into the
		 * list the menu asks: a tile is a menu's command, naming no form. */
		for (const cancelLocation of [
			{ kind: "home" },
			{ kind: "module", moduleUuid: PLAIN },
		] as const)
			expect(chooseTile(CASE_FIRST, cancelLocation, "case-list")).toEqual([
				["target", undefined],
				[
					"request",
					{
						selectingModuleUuid: HOUSEHOLDS,
						returnModuleUuids: [CASE_FIRST],
						cancelLocation,
					},
				],
				["push", { kind: "cases", moduleUuid: HOUSEHOLDS }],
			]);
	});

	it("opens a menu that lists its forms before its parent case on its forms, its target let go", () => {
		/* Core lists the menu (`STATE_COMMAND_ID`): its survey asks for no
		 * case, so no one datum is needed by every entry, and the follow-up
		 * asks for the household after its command. */
		expect(previewParentCaseBeforeMenu(doc, FORMS_FIRST)).toBe(false);
		expect(chooseTile(FORMS_FIRST, { kind: "home" }, "form-menu")).toEqual([
			["target", undefined],
			["openModule", FORMS_FIRST],
		]);
	});

	it("lets the case target go before a tile with no parent case takes its landing", () => {
		expect(chooseTile(PLAIN, { kind: "home" }, "case-list")).toEqual([
			["target", undefined],
			["openCaseList", PLAIN],
		]);
	});

	it("starts the parent case selection at a module URL only where Core asks for it before the menu, and at every leaf", () => {
		const moduleUrl: Location = { kind: "module", moduleUuid: FORMS_FIRST };
		const leaf: Location = { kind: "cases", moduleUuid: FORMS_FIRST };
		expect(
			previewModuleAsksParentCase({
				loc: moduleUrl,
				moduleUuid: FORMS_FIRST,
				parentCaseBeforeMenu: false,
			}),
		).toBe(false);
		expect(
			previewModuleAsksParentCase({
				loc: leaf,
				moduleUuid: FORMS_FIRST,
				parentCaseBeforeMenu: false,
			}),
		).toBe(true);
		expect(
			previewModuleAsksParentCase({
				loc: { kind: "module", moduleUuid: CASE_FIRST },
				moduleUuid: CASE_FIRST,
				parentCaseBeforeMenu: previewParentCaseBeforeMenu(doc, CASE_FIRST),
			}),
		).toBe(true);
	});

	it("cancels a parent case asked for after a form's command back to the menu that listed the form", () => {
		/* `CommCareSession.stepBack` pops the form's command and stops on the
		 * menu, which asks for a command. */
		const request = (listsBeforeParentCase: boolean) =>
			previewParentCaseRequestFor({
				loc: { kind: "cases", moduleUuid: FORMS_FIRST },
				moduleUuid: FORMS_FIRST,
				selectorModuleUuid: HOUSEHOLDS,
				structuralParentUuid: undefined,
				pending: undefined,
				listsBeforeParentCase,
			}).cancelLocation;
		expect(request(true)).toEqual({ kind: "module", moduleUuid: FORMS_FIRST });
		expect(request(false)).toEqual({ kind: "home" });
	});
});
