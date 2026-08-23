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
import type { AfterSubmitChoice } from "@/lib/preview/engine/formLinkEvaluation";
import { afterSubmitRoute } from "../screens/afterSubmitRouting";
import { moduleLanding, openModuleLanding } from "../screens/moduleLanding";

const CARE = testUuid("mod-care");
const BROWSE = testUuid("mod-browse");
const MENU = testUuid("mod-menu");
const VISIT = testUuid("frm-visit");
const NOTE = testUuid("frm-note");
const MISSING_MODULE = testUuid("mod-missing");
const MISSING_FORM = testUuid("frm-missing");

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

describe("afterSubmitRoute", () => {
	it("takes the post-submit destination when no link fired", () => {
		expect(
			afterSubmitRoute({
				choice: { kind: "fallback", destination: "previous" },
				doc,
				caseFirstModules,
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
				carriedCase: neverCarries,
			}),
		).toEqual({ kind: "module", moduleUuid: CARE, landing: "case-list" });
	});

	it("enters a case-first module with a retained case on its form menu", () => {
		expect(
			afterSubmitRoute({
				choice: fired({ type: "module", moduleUuid: CARE }),
				doc,
				caseFirstModules,
				hasSelectedCase: (moduleUuid) => moduleUuid === CARE,
				carriedCase: neverCarries,
			}),
		).toEqual({ kind: "module", moduleUuid: CARE, landing: "form-menu" });
	});

	it("enters a bare case list on its case list", () => {
		expect(
			afterSubmitRoute({
				choice: fired({ type: "module", moduleUuid: BROWSE }),
				doc,
				caseFirstModules,
				carriedCase: neverCarries,
			}),
		).toEqual({ kind: "module", moduleUuid: BROWSE, landing: "case-list" });
	});

	it("enters any other module on its form menu", () => {
		expect(
			afterSubmitRoute({
				choice: fired({ type: "module", moduleUuid: MENU }),
				doc,
				caseFirstModules,
				carriedCase: neverCarries,
			}),
		).toEqual({ kind: "module", moduleUuid: MENU, landing: "form-menu" });
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
			carriedCase,
		});
		expect(route).toEqual({
			kind: "form",
			moduleUuid: CARE,
			formUuid: VISIT,
			carried: { kind: "carried", caseId: "p1", caseName: "Pat" },
		});
		expect(carriedCase).toHaveBeenCalledTimes(1);
	});

	it("opens a form target that selects no case with nothing carried", () => {
		expect(
			afterSubmitRoute({
				choice: fired({ type: "form", moduleUuid: MENU, formUuid: NOTE }),
				doc,
				caseFirstModules,
				carriedCase: () => ({ kind: "none" }),
			}),
		).toEqual({
			kind: "form",
			moduleUuid: MENU,
			formUuid: NOTE,
			carried: { kind: "none" },
		});
	});

	it("reports a target module that is not in the document", () => {
		const route = afterSubmitRoute({
			choice: fired({ type: "module", moduleUuid: MISSING_MODULE }),
			doc,
			caseFirstModules,
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
			carriedCase: neverCarries,
		});
		expect(gone.kind).toBe("unresolvable");
		// A form that exists, but in another module, is not the named target.
		const elsewhere = afterSubmitRoute({
			choice: fired({ type: "form", moduleUuid: CARE, formUuid: NOTE }),
			doc,
			caseFirstModules,
			carriedCase: neverCarries,
		});
		expect(elsewhere.kind).toBe("unresolvable");
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
