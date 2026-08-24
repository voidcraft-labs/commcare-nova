// The form screen's after-submit routing table (`afterSubmitRouting.ts`)
// and the module-entry landing rule it shares with the home screen
// (`moduleLanding.ts`).
//
// Pure `f(state)`: `FormScreen` reads the route and performs the effect, so
// there is no DOM to mount here. The cases are the ones a device distinguishes:
// no link fired, a link to a module (case list or form menu), a link to a form
// (with the carried case, or a blank one), and a link whose target is gone.

import { describe, expect, it, vi } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import type { FormLink } from "@/lib/domain";
import type {
	AfterSubmitChoice,
	TargetCaseSelection,
} from "@/lib/preview/engine/formLinkEvaluation";
import type { PreviewMenuSource } from "@/lib/preview/menuProjection";
import {
	afterSubmitRoute,
	previewMenuSelectionsAfterTargetCases,
	previewTargetHasSelectedCase,
} from "../screens/afterSubmitRouting";
import { moduleLanding, openModuleLanding } from "../screens/moduleLanding";

const CARE = testUuid("mod-care");
const BROWSE = testUuid("mod-browse");
const MENU = testUuid("mod-menu");
const VISIT = testUuid("frm-visit");
const NOTE = testUuid("frm-note");
const MISSING_MODULE = testUuid("mod-missing");
const MISSING_FORM = testUuid("frm-missing");
const SAME_TYPE_ROOT = testUuid("mod-same-type-root");
const SAME_TYPE_CHILD = testUuid("mod-same-type-child");

const doc = buildDoc({
	caseTypes: [{ name: "patient", properties: [] }],
	modules: [
		{
			uuid: "mod-care",
			name: "Care",
			caseType: "patient",
			forms: [{ uuid: "frm-visit", name: "Visit", type: "followup" }],
		},
		{
			uuid: "mod-browse",
			name: "Browse",
			caseType: "patient",
			caseListOnly: true,
		},
		{
			uuid: "mod-menu",
			name: "Menu",
			caseType: "patient",
			forms: [
				{ uuid: "frm-note", name: "Note", type: "survey" },
				{ uuid: "frm-register", name: "Register", type: "registration" },
			],
		},
	],
});
const caseFirstModules = new Set([CARE]);

function fired(target: FormLink["target"]): AfterSubmitChoice {
	return {
		kind: "link",
		index: 0,
		link: { uuid: testUuid("lnk"), target },
	};
}

const neverCarries = () => {
	throw new Error("carriedCase must not be asked for this target");
};
const noCaseSelections = () => [];

describe("afterSubmitRoute", () => {
	it("takes the post-submit destination when no link fired", () => {
		expect(
			afterSubmitRoute({
				choice: { kind: "fallback", destination: "previous" },
				doc,
				caseFirstModules,
				caseSelections: noCaseSelections,
				carriedCase: neverCarries,
			}),
		).toEqual({ kind: "post-submit", destination: "previous" });
	});

	it("enters a case-first module on its case list", () => {
		expect(
			afterSubmitRoute({
				choice: fired({ type: "module", moduleUuid: CARE }),
				doc,
				caseFirstModules,
				caseSelections: noCaseSelections,
				carriedCase: neverCarries,
			}),
		).toEqual({
			kind: "module",
			moduleUuid: CARE,
			landing: "case-list",
			caseSelections: [],
		});
	});

	it("enters a case-first module with a retained case on its form menu", () => {
		expect(
			afterSubmitRoute({
				choice: fired({ type: "module", moduleUuid: CARE }),
				doc,
				caseFirstModules,
				caseSelections: noCaseSelections,
				hasSelectedCase: (moduleUuid) => moduleUuid === CARE,
				carriedCase: neverCarries,
			}),
		).toEqual({
			kind: "module",
			moduleUuid: CARE,
			landing: "form-menu",
			caseSelections: [],
		});
	});

	it("lets a projected inherited selection choose a case-first module's form menu", () => {
		const inheritedSelection = {
			datumId: "case_id",
			moduleUuid: MENU,
			caseType: "patient",
			caseId: "p-inherited",
		} as const;
		const hasSelectedCase = vi.fn(
			(_moduleUuid: string, selections: readonly TargetCaseSelection[]) =>
				selections.some((selection) => selection.caseId !== ""),
		);
		const route = afterSubmitRoute({
			choice: fired({ type: "module", moduleUuid: CARE }),
			doc,
			caseFirstModules,
			caseSelections: () => [inheritedSelection],
			hasSelectedCase,
			carriedCase: neverCarries,
		});

		expect(route).toMatchObject({ kind: "module", landing: "form-menu" });
		expect(hasSelectedCase).toHaveBeenCalledWith(CARE, [inheritedSelection]);
	});

	it("does not treat a projected blank selection as a selected case", () => {
		const blankSelection = {
			datumId: "case_id",
			moduleUuid: CARE,
			caseType: "patient",
			caseId: "",
		} as const;
		const route = afterSubmitRoute({
			choice: fired({ type: "module", moduleUuid: CARE }),
			doc,
			caseFirstModules,
			caseSelections: () => [blankSelection],
			hasSelectedCase: (_moduleUuid, selections) =>
				selections.some((selection) => selection.caseId !== ""),
			carriedCase: neverCarries,
		});

		expect(route).toMatchObject({ kind: "module", landing: "case-list" });
	});

	it("enters a bare case list on its case list", () => {
		expect(
			afterSubmitRoute({
				choice: fired({ type: "module", moduleUuid: BROWSE }),
				doc,
				caseFirstModules,
				caseSelections: noCaseSelections,
				carriedCase: neverCarries,
			}),
		).toEqual({
			kind: "module",
			moduleUuid: BROWSE,
			landing: "case-list",
			caseSelections: [],
		});
	});

	it("enters any other module on its form menu", () => {
		expect(
			afterSubmitRoute({
				choice: fired({ type: "module", moduleUuid: MENU }),
				doc,
				caseFirstModules,
				caseSelections: noCaseSelections,
				carriedCase: neverCarries,
			}),
		).toEqual({
			kind: "module",
			moduleUuid: MENU,
			landing: "form-menu",
			caseSelections: [],
		});
	});

	it("opens a form target with the case the link carries", () => {
		const carriedCase = vi.fn(() => ({
			kind: "carried" as const,
			caseId: "p1",
			caseName: "Pat",
		}));
		const route = afterSubmitRoute({
			choice: fired({ type: "form", moduleUuid: CARE, formUuid: VISIT }),
			doc,
			caseFirstModules,
			caseSelections: noCaseSelections,
			carriedCase,
		});
		expect(route).toEqual({
			kind: "form",
			moduleUuid: CARE,
			formUuid: VISIT,
			carried: { kind: "carried", caseId: "p1", caseName: "Pat" },
			caseSelections: [],
		});
		expect(carriedCase).toHaveBeenCalledTimes(1);
	});

	it("carries every projected target selection alongside a nested form route", () => {
		const caseSelections = [
			{
				datumId: "case_id",
				moduleUuid: MENU,
				caseType: "household",
				caseId: "h1",
				caseName: "Household one",
			},
			{
				datumId: "case_id_patient",
				moduleUuid: CARE,
				caseType: "patient",
				caseId: "p1",
				caseName: "Patient one",
			},
		] as const;
		const route = afterSubmitRoute({
			choice: fired({ type: "form", moduleUuid: CARE, formUuid: VISIT }),
			doc,
			caseFirstModules,
			caseSelections: () => caseSelections,
			carriedCase: () => ({
				kind: "carried",
				caseId: "p1",
				caseName: "Patient one",
			}),
		});

		expect(route).toMatchObject({
			kind: "form",
			moduleUuid: CARE,
			formUuid: VISIT,
			caseSelections,
		});
	});

	it("opens a form target that selects no case with nothing carried", () => {
		expect(
			afterSubmitRoute({
				choice: fired({ type: "form", moduleUuid: MENU, formUuid: NOTE }),
				doc,
				caseFirstModules,
				caseSelections: noCaseSelections,
				carriedCase: () => ({ kind: "none" }),
			}),
		).toEqual({
			kind: "form",
			moduleUuid: MENU,
			formUuid: NOTE,
			carried: { kind: "none" },
			caseSelections: [],
		});
	});

	it("reports a target module that is not in the document", () => {
		const route = afterSubmitRoute({
			choice: fired({ type: "module", moduleUuid: MISSING_MODULE }),
			doc,
			caseFirstModules,
			caseSelections: noCaseSelections,
			carriedCase: neverCarries,
		});
		expect(route.kind).toBe("unresolvable");
		expect(route.kind === "unresolvable" && route.reason).toContain(
			MISSING_MODULE,
		);
	});

	it("reports a target form that is not in its module", () => {
		const gone = afterSubmitRoute({
			choice: fired({ type: "form", moduleUuid: CARE, formUuid: MISSING_FORM }),
			doc,
			caseFirstModules,
			caseSelections: noCaseSelections,
			carriedCase: neverCarries,
		});
		expect(gone.kind).toBe("unresolvable");
		// A form that exists, but in another module, is not the named target.
		const elsewhere = afterSubmitRoute({
			choice: fired({ type: "form", moduleUuid: CARE, formUuid: NOTE }),
			doc,
			caseFirstModules,
			caseSelections: noCaseSelections,
			carriedCase: neverCarries,
		});
		expect(elsewhere.kind).toBe("unresolvable");
	});
});

describe("prospective after-submit menu selections", () => {
	function sameTypeNestedDoc(): PreviewMenuSource {
		const nested = buildDoc({
			caseTypes: [{ name: "patient", properties: [] }],
			modules: [
				{
					uuid: "mod-same-type-root",
					name: "Root patients",
					caseType: "patient",
					forms: [
						{ uuid: "frm-root", name: "Root follow-up", type: "followup" },
					],
				},
				{
					uuid: "mod-same-type-child",
					name: "Child patients",
					caseType: "patient",
					forms: [
						{ uuid: "frm-child", name: "Child follow-up", type: "followup" },
					],
				},
			],
		});
		nested.modules[SAME_TYPE_CHILD].parentModuleUuid = SAME_TYPE_ROOT;
		return { ...nested, caseTypes: nested.caseTypes ?? [] };
	}

	it("lets a same-type child inherit the frame's projected root selection", () => {
		const menuSource = sameTypeNestedDoc();
		const projected = [
			{
				datumId: "case_id",
				moduleUuid: SAME_TYPE_ROOT,
				caseType: "patient",
				caseId: "p-new",
				caseName: "New patient",
			},
		] as const;

		expect(
			previewTargetHasSelectedCase({
				menuSource,
				current: {
					[SAME_TYPE_CHILD]: {
						caseType: "patient",
						caseId: "p-stale",
						caseName: "Stale patient",
					},
				},
				targetModuleUuid: SAME_TYPE_CHILD,
				projected,
			}),
		).toBe(true);
		const next = previewMenuSelectionsAfterTargetCases(
			menuSource,
			{},
			projected,
		);
		expect(next[SAME_TYPE_ROOT]?.caseId).toBe("p-new");
		expect(next[SAME_TYPE_CHILD]).toBeUndefined();
	});

	it("clears a blank owning selection and its stale same-type child", () => {
		const menuSource = sameTypeNestedDoc();
		const current = {
			[SAME_TYPE_ROOT]: {
				caseType: "patient",
				caseId: "p-old",
				caseName: "Old patient",
			},
			[SAME_TYPE_CHILD]: {
				caseType: "patient",
				caseId: "p-stale",
				caseName: "Stale patient",
			},
		};
		const projected = [
			{
				datumId: "case_id",
				moduleUuid: SAME_TYPE_ROOT,
				caseType: "patient",
				caseId: "",
			},
		] as const;

		const next = previewMenuSelectionsAfterTargetCases(
			menuSource,
			current,
			projected,
		);
		expect(next[SAME_TYPE_ROOT]).toBeUndefined();
		expect(next[SAME_TYPE_CHILD]).toBeUndefined();
		expect(
			previewTargetHasSelectedCase({
				menuSource,
				current,
				targetModuleUuid: SAME_TYPE_CHILD,
				projected,
			}),
		).toBe(false);
	});
});

describe("moduleLanding", () => {
	it("lands case-first and bare-case-list modules on the case list", () => {
		expect(moduleLanding({ isCaseFirst: true, isBareCaseList: false })).toBe(
			"case-list",
		);
		expect(moduleLanding({ isCaseFirst: false, isBareCaseList: true })).toBe(
			"case-list",
		);
		expect(moduleLanding({ isCaseFirst: false, isBareCaseList: false })).toBe(
			"form-menu",
		);
	});

	it("pushes the matching screen", () => {
		const navigate = { openCaseList: vi.fn(), openModule: vi.fn() };
		openModuleLanding(navigate, CARE, "case-list");
		openModuleLanding(navigate, MENU, "form-menu");
		expect(navigate.openCaseList).toHaveBeenCalledWith(CARE);
		expect(navigate.openModule).toHaveBeenCalledWith(MENU);
	});
});
