/**
 * Where Preview lands a worker when a menu shows its forms in the menu above:
 * a link's target read through the screens Formplayer's frame walk passes, a
 * frame read back to a screen that exists, and an entry point's off-the-menu
 * refusal. Each runs the production model over documents built by
 * `buildDoc`; none renders a screen.
 */
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import {
	formFrameChildren,
	formLinkProjectionContext,
	moduleFrameChildren,
} from "@/lib/commcare/formLinkProjection";
import type { BlueprintDoc, ResolvedFormLinkTarget } from "@/lib/domain";
import { eq, literal } from "@/lib/domain/expression";
import {
	afterSubmitRoute,
	afterSubmitTargetVisibility,
	screenOfFrame,
} from "../afterSubmitRouting";
import { WEB_APPS_RULES } from "../engine/__tests__/fixtures/previewDevices";
import { moduleEntriesOffTheMenu } from "../entryPointLaunch";
import { previewCaseFirstModuleUuids } from "../menuProjection";

const PARENT = testUuid("parent");
const ABOVE = testUuid("above");
const OWN = testUuid("own-screen");
const PARENT_FORM = testUuid("parent-form");
const ABOVE_FORM = testUuid("above-form");
const OWN_FORM = testUuid("own-form");

function followUp(uuid: string, name: string) {
	return {
		uuid,
		name,
		type: "followup" as const,
		fields: [f({ kind: "text", id: "notes" })],
	};
}

/** A top-level household menu holding two submenus: one that shows its forms
 *  on the household screen, one that keeps its own screen. */
function nested(): BlueprintDoc {
	const doc = buildDoc({
		caseTypes: [{ name: "household", properties: [] }],
		modules: [
			{
				uuid: "parent",
				name: "Households",
				caseType: "household",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [followUp("parent-form", "Visit household")],
			},
			{
				uuid: "above",
				name: "Members",
				caseType: "household",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [followUp("above-form", "Check members")],
			},
			{
				uuid: "own-screen",
				name: "Water",
				caseType: "household",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [followUp("own-form", "Check water")],
			},
		],
	});
	doc.modules[ABOVE].parentModuleUuid = PARENT;
	doc.modules[ABOVE].formsInMenuAbove = true;
	doc.modules[OWN].parentModuleUuid = PARENT;
	return doc;
}

const SESSION = { context: {}, user: {}, userPropertySlugs: {} };

function visibilityOf(doc: BlueprintDoc, target: ResolvedFormLinkTarget) {
	return afterSubmitTargetVisibility({
		doc,
		target,
		session: SESSION,
		lookup: { kind: "idle" },
		deviceCases: { snapshot: null, caseTypes: doc.caseTypes ?? [] },
		caseSelections: [],
	});
}

describe("after submit with forms in the menu above", () => {
	it("lands a link to a hidden form of a submenu shown above on the screen that lists it", () => {
		const doc = nested();
		doc.modules[ABOVE].displayCondition = eq(literal("a"), literal("b"));
		const target = {
			type: "form",
			moduleUuid: ABOVE,
			formUuid: ABOVE_FORM,
		} as const;
		const visibility = visibilityOf(doc, target);
		expect(visibility).toEqual({
			kind: "form-in-hidden-module",
			shownModuleUuid: PARENT,
		});
		expect(
			afterSubmitRoute({
				sourceFormUuid: PARENT_FORM,
				rules: WEB_APPS_RULES,
				targetVisibility: () => visibility,
				choice: {
					kind: "destination",
					index: 0,
					link: { uuid: testUuid("lnk"), target },
				},
				doc,
				caseFirstModules: previewCaseFirstModuleUuids(doc),
				caseSelections: () => [],
				carriedCase: () => ({ kind: "none" }),
			}),
		).toMatchObject({ kind: "module", moduleUuid: PARENT });
	});

	it("opens a form of a submenu that keeps its screen under a top-level menu above that is off the menu", () => {
		const doc = nested();
		doc.modules[PARENT].formsInMenuAbove = true;
		doc.modules[PARENT].hiddenFromMenu = true;
		const target = {
			type: "form",
			moduleUuid: OWN,
			formUuid: OWN_FORM,
		} as const;
		/* The submenu lists on the first menu by its own condition alone. */
		const visibility = visibilityOf(doc, target);
		expect(visibility).toBe("shown");
		expect(
			afterSubmitRoute({
				sourceFormUuid: PARENT_FORM,
				rules: WEB_APPS_RULES,
				targetVisibility: () => visibility,
				choice: {
					kind: "destination",
					index: 0,
					link: { uuid: testUuid("lnk"), target },
				},
				doc,
				caseFirstModules: previewCaseFirstModuleUuids(doc),
				caseSelections: () => [],
				carriedCase: () => ({ kind: "none" }),
			}),
		).toMatchObject({ kind: "form", moduleUuid: OWN, formUuid: OWN_FORM });
		/* Its parent's forms are off the menu; its own are not. */
		expect(moduleEntriesOffTheMenu(doc, PARENT)).toBe(true);
		expect(moduleEntriesOffTheMenu(doc, OWN)).toBe(false);
		expect(moduleEntriesOffTheMenu(doc, ABOVE)).toBe(true);
	});

	it("takes a submenu off with a parent that keeps its screen", () => {
		const doc = nested();
		doc.modules[PARENT].hiddenFromMenu = true;
		expect(moduleEntriesOffTheMenu(doc, OWN)).toBe(true);
		expect(moduleEntriesOffTheMenu(doc, ABOVE)).toBe(true);
		expect(
			visibilityOf(doc, { type: "form", moduleUuid: OWN, formUuid: OWN_FORM }),
		).toEqual({ kind: "form-in-hidden-module", shownModuleUuid: null });
	});

	it("reads every frame back to a screen that exists", () => {
		const doc = nested();
		const ctx = formLinkProjectionContext(doc, { entryMetadataOnly: true });
		const toAbove = screenOfFrame(ctx, moduleFrameChildren(doc, ctx, ABOVE));
		expect(toAbove.screen).toEqual({ kind: "menu", moduleUuid: PARENT });
		const toAboveForm = screenOfFrame(
			ctx,
			formFrameChildren(doc, ctx, ABOVE, ABOVE_FORM),
		);
		expect(toAboveForm).toMatchObject({
			screen: { kind: "menu", moduleUuid: PARENT },
			formUuid: ABOVE_FORM,
		});
		const toOwn = screenOfFrame(ctx, moduleFrameChildren(doc, ctx, OWN));
		expect(toOwn.screen).toEqual({ kind: "menu", moduleUuid: OWN });
		expect(screenOfFrame(ctx, [])).toEqual({
			screen: { kind: "first-menu" },
			selectingModuleUuids: [],
		});
	});

	it("lands a top-level menu shown above on the first menu", () => {
		const doc = nested();
		doc.modules[PARENT].formsInMenuAbove = true;
		const ctx = formLinkProjectionContext(doc, { entryMetadataOnly: true });
		for (const moduleUuid of [PARENT, ABOVE])
			expect(
				screenOfFrame(ctx, moduleFrameChildren(doc, ctx, moduleUuid)).screen,
			).toEqual({ kind: "first-menu" });
		/* A frame through the first menu holds no menu screen to keep. */
		expect(previewCaseFirstModuleUuids(doc).has(PARENT)).toBe(false);
	});
});
