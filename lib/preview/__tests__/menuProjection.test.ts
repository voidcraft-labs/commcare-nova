import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import {
	type BlueprintDoc,
	fieldSchema,
	type Module,
	makeTranslationUnitId,
} from "@/lib/domain";
import { eq, literal, sessionUser } from "@/lib/domain/expression";
import {
	combineNavigationVisibility,
	inheritedModuleVisibility,
	previewCaseDescendantModuleUuids,
	previewCaseListMenuEntry,
	previewContributorVisibility,
	previewMenuCaseContext,
	previewModuleOwnVisibility,
	previewModuleVisibility,
	previewRunningModuleScreen,
	previewScreenEntries,
	previewScreenEntryVisibility,
} from "../menuProjection";
import { assertAdmittedPreviewDoc } from "./fixtures/admittedDoc";

const ROOT = testUuid("root");
const CHILD = testUuid("child");
const OTHER_ROOT = testUuid("other-root");
const SURVEY_ROOT = testUuid("survey-root");
const ROOT_FORM = testUuid("root-form");
const CHILD_FORM = testUuid("child-form");
const OTHER_ROOT_FORM = testUuid("other-root-form");
const SURVEY_FORM = testUuid("survey-form");

function module(
	uuid: typeof ROOT,
	caseType: string,
	parentModuleUuid?: typeof ROOT,
): Module {
	return {
		uuid,
		id: `m_${uuid.replaceAll("-", "")}`,
		name: uuid,
		caseType,
		caseListConfig: caseListConfig([{ field: "case_name", header: "Name" }]),
		...(parentModuleUuid ? { parentModuleUuid } : {}),
	};
}

function source(
	childCaseType = "household",
): BlueprintDoc & { caseTypes: NonNullable<BlueprintDoc["caseTypes"]> } {
	const caseTypes = [
		{ name: "household", properties: [] },
		{ name: "person", parent_type: "household", properties: [] },
		{ name: "visit", properties: [] },
		{ name: "clinic", properties: [] },
	];
	const doc = buildDoc({
		caseTypes,
		modules: (
			[
				[ROOT, "household", ROOT_FORM, undefined],
				[CHILD, childCaseType, CHILD_FORM, ROOT],
				[OTHER_ROOT, "visit", OTHER_ROOT_FORM, undefined],
			] as const
		).map(([uuid, caseType, formUuid]) => ({
			uuid,
			name: `Module ${uuid}`,
			caseType,
			caseListConfig: caseListConfig([{ field: "case_name", header: "Name" }]),
			forms: [
				{
					uuid: formUuid,
					name: "Follow-up",
					type: "followup" as const,
					fields: [f({ kind: "text", id: "notes" })],
				},
			],
		})),
	});
	doc.modules[CHILD].parentModuleUuid = ROOT;
	if (childCaseType === "person")
		doc.modules[CHILD].parentCaseModuleUuid = ROOT;
	assertAdmittedPreviewDoc(doc);
	return { ...doc, caseTypes };
}

describe("Preview menu projection", () => {
	it("shows roots on Home and children only on their parent menu", () => {
		const doc = source();
		expect(previewScreenEntries(doc, { kind: "first-menu" })).toEqual([
			{ kind: "menu", moduleUuid: ROOT },
			{ kind: "menu", moduleUuid: OTHER_ROOT },
		]);
		expect(
			previewScreenEntries(doc, { kind: "menu", moduleUuid: ROOT }),
		).toEqual([
			{ kind: "form", moduleUuid: ROOT, formUuid: ROOT_FORM },
			{ kind: "menu", moduleUuid: CHILD },
		]);
	});

	it("lists the forms of a menu that shows its forms above in place, and runs its route on the screen that lists them", () => {
		const doc = source();
		doc.modules[CHILD].formsInMenuAbove = true;
		doc.modules[OTHER_ROOT].formsInMenuAbove = true;
		expect(previewScreenEntries(doc, { kind: "first-menu" })).toEqual([
			{ kind: "menu", moduleUuid: ROOT },
			{ kind: "form", moduleUuid: OTHER_ROOT, formUuid: OTHER_ROOT_FORM },
		]);
		expect(
			previewScreenEntries(doc, { kind: "menu", moduleUuid: ROOT }),
		).toEqual([
			{ kind: "form", moduleUuid: ROOT, formUuid: ROOT_FORM },
			{ kind: "form", moduleUuid: CHILD, formUuid: CHILD_FORM },
		]);
		expect(previewRunningModuleScreen(doc, CHILD)).toEqual({
			type: "module",
			moduleUuid: ROOT,
		});
		expect(previewRunningModuleScreen(doc, OTHER_ROOT)).toEqual({
			type: "home",
		});
		expect(previewRunningModuleScreen(doc, ROOT)).toEqual({
			type: "module",
			moduleUuid: ROOT,
		});
	});

	it("keeps a submenu tile shown under a parent that shows its forms above, whatever the parent's condition", () => {
		const doc = source();
		doc.modules[ROOT].formsInMenuAbove = true;
		const own = new Map([
			[ROOT, "hidden" as const],
			[CHILD, "shown" as const],
			[OTHER_ROOT, "shown" as const],
		]);
		/* HQ conjoins the parent's filter only onto a submenu that shows its
		 * forms above; this one keeps its screen and lists on the first menu. */
		expect(inheritedModuleVisibility(doc, own).get(CHILD)).toBe("shown");
		expect(previewScreenEntries(doc, { kind: "first-menu" })).toEqual([
			{ kind: "form", moduleUuid: ROOT, formUuid: ROOT_FORM },
			{ kind: "menu", moduleUuid: CHILD },
			{ kind: "menu", moduleUuid: OTHER_ROOT },
		]);
		doc.modules[ROOT].formsInMenuAbove = undefined;
		expect(inheritedModuleVisibility(doc, own).get(CHILD)).toBe("hidden");
	});

	it("hides a contributor's forms while its parent is off the menu", () => {
		const doc = source();
		doc.modules[CHILD].formsInMenuAbove = true;
		doc.modules[ROOT].hiddenFromMenu = true;
		const session = { context: {}, user: {}, userPropertySlugs: {} };
		const own = previewModuleOwnVisibility(doc, {
			authoring: false,
			session,
			lookup: { kind: "idle" },
		});
		expect(previewContributorVisibility(doc, own, CHILD)).toBe("hidden");
		const visibility = previewScreenEntryVisibility({
			doc,
			entries: previewScreenEntries(doc, { kind: "menu", moduleUuid: ROOT }),
			ownModuleVisibility: own,
			authoring: false,
			session,
			lookup: { kind: "idle" },
			selectedCaseOf: () => undefined,
		});
		expect(visibility.get(`form:${CHILD_FORM}`)).toBe("hidden");
		doc.modules[ROOT].hiddenFromMenu = undefined;
		doc.modules[CHILD].hiddenFromMenu = true;
		expect(
			previewContributorVisibility(
				doc,
				previewModuleOwnVisibility(doc, {
					authoring: false,
					session,
					lookup: { kind: "idle" },
				}),
				CHILD,
			),
		).toBe("hidden");
	});

	it("inherits three-valued visibility with hidden winning over pending", () => {
		expect(combineNavigationVisibility("pending", "hidden")).toBe("hidden");
		const doc = source();
		const projected = inheritedModuleVisibility(
			doc,
			new Map([
				[ROOT, "pending" as const],
				[CHILD, "shown" as const],
				[OTHER_ROOT, "shown" as const],
			]),
		);
		expect(projected.get(CHILD)).toBe("pending");
	});

	it("hides a module off the menu, and its child modules, without reading its condition", () => {
		const doc = source();
		doc.modules[ROOT].hiddenFromMenu = true;
		/* An unresolved worker leaves any condition pending; the flag answers
		 * before the condition is read. */
		doc.modules[ROOT].displayCondition = eq(
			sessionUser("role"),
			literal("supervisor"),
		);
		const visibility = previewModuleVisibility(doc, {
			authoring: false,
			session: {
				identityPending: true,
				context: {},
				user: {},
				userPropertySlugs: {},
			},
			lookup: { kind: "idle" },
		});
		expect(visibility.get(ROOT)).toBe("hidden");
		expect(visibility.get(CHILD)).toBe("hidden");
		expect(visibility.get(OTHER_ROOT)).toBe("shown");
		expect(
			previewModuleVisibility(doc, {
				authoring: true,
				session: { context: {}, user: {}, userPropertySlugs: {} },
				lookup: { kind: "idle" },
			}).get(ROOT),
		).toBe("shown");
	});

	it("reuses a structural parent's selection only for the same case type", () => {
		const selected = {
			caseType: "household",
			cases: [{ caseId: "h1", caseName: "Household one" }],
		};
		expect(
			previewMenuCaseContext(source(), CHILD, { [ROOT]: selected }),
		).toEqual({
			selectedCase: selected,
			selectedByModuleUuid: ROOT,
			parentCase: undefined,
			parentModuleUuid: undefined,
			requiredParentCase: undefined,
		});
	});

	it("carries an authored set only to a compatible child with enough room", () => {
		const base = source();
		const selection = {
			caseType: "household",
			cases: [{ caseId: "h1", caseName: "One" }],
		};
		const multiConfig = {
			...caseListConfig([{ field: "case_name", header: "Name" }]),
			selection: { kind: "multiple" as const, maximum: 3 },
		};
		const root = base.modules[ROOT];
		const child = base.modules[CHILD];
		if (!root || !child) throw new Error("fixture modules are missing");
		const childConfig = {
			...caseListConfig([{ field: "case_name", header: "Name" }]),
			selection: multiConfig.selection,
		};
		const compatible = {
			...base,
			// Choosing several cases runs in Web Apps alone.
			appSettings: { ...base.appSettings, runsOnlyOn: "web-apps" as const },
			modules: {
				...base.modules,
				[ROOT]: { ...root, caseListConfig: multiConfig },
				[CHILD]: {
					...child,
					caseListConfig: childConfig,
				},
			},
		};
		assertAdmittedPreviewDoc(compatible);
		expect(
			previewMenuCaseContext(compatible, CHILD, { [ROOT]: selection })
				.selectedCase,
		).toEqual(selection);

		const tooSmall = {
			...compatible,
			modules: {
				...compatible.modules,
				[CHILD]: {
					...child,
					caseListConfig: {
						...childConfig,
						selection: { kind: "multiple" as const, maximum: 2 },
					},
				},
			},
		};
		assertAdmittedPreviewDoc(tooSmall);
		expect(
			previewMenuCaseContext(tooSmall, CHILD, { [ROOT]: selection })
				.selectedCase,
		).toBeUndefined();
	});

	it("keeps a declared different-type parent as a selection constraint", () => {
		const selected = {
			caseType: "household",
			cases: [
				{ caseId: "h1", caseName: "Household one" },
				{ caseId: "h2", caseName: "Household two" },
			],
		};
		expect(
			previewMenuCaseContext(source("person"), CHILD, { [ROOT]: selected }),
		).toEqual({
			selectedCase: undefined,
			selectedByModuleUuid: undefined,
			parentCase: selected,
			parentModuleUuid: ROOT,
			requiredParentCase: undefined,
		});
	});

	it("keeps case-parent context after the child itself is selected", () => {
		const parent = {
			caseType: "household",
			cases: [{ caseId: "h1", caseName: "Household one" }],
		};
		const child = {
			caseType: "person",
			cases: [{ caseId: "p1", caseName: "Person one" }],
		};
		expect(
			previewMenuCaseContext(source("person"), CHILD, {
				[ROOT]: parent,
				[CHILD]: child,
			}),
		).toEqual({
			selectedCase: child,
			selectedByModuleUuid: CHILD,
			parentCase: parent,
			parentModuleUuid: ROOT,
			requiredParentCase: undefined,
		});
	});

	it("finds case parentage independently of the structural menu parent", () => {
		const base = source("person");
		const doc = {
			...base,
			modules: {
				...base.modules,
				[ROOT]: module(ROOT, "clinic"),
				[OTHER_ROOT]: module(OTHER_ROOT, "household"),
				[CHILD]: { ...base.modules[CHILD], parentCaseModuleUuid: OTHER_ROOT },
			},
		};
		const selected = {
			caseType: "household",
			cases: [{ caseId: "h1", caseName: "Household one" }],
		};

		assertAdmittedPreviewDoc(doc);
		expect(
			previewMenuCaseContext(doc, CHILD, { [OTHER_ROOT]: selected }),
		).toEqual({
			selectedCase: undefined,
			selectedByModuleUuid: undefined,
			parentCase: selected,
			parentModuleUuid: OTHER_ROOT,
			requiredParentCase: undefined,
		});
		expect(previewMenuCaseContext(doc, CHILD, {})).toEqual({
			selectedCase: undefined,
			selectedByModuleUuid: undefined,
			parentCase: undefined,
			parentModuleUuid: undefined,
			requiredParentCase: {
				caseType: "household",
				moduleUuid: OTHER_ROOT,
			},
		});
		expect(previewCaseDescendantModuleUuids(doc, "household")).toEqual([CHILD]);
	});

	it("takes the case chosen on the parent's screen as the parent case of a submenu that shows its forms there", () => {
		const base = source("person");
		/* The person menu names another household menu as its parent case
		 * selector, but its forms list on the household screen, where the wire
		 * gives both selections one datum id. */
		const doc = {
			...base,
			modules: {
				...base.modules,
				[OTHER_ROOT]: module(OTHER_ROOT, "household"),
				[CHILD]: {
					...base.modules[CHILD],
					parentCaseModuleUuid: OTHER_ROOT,
					formsInMenuAbove: true as const,
				},
			},
		};
		const selected = {
			caseType: "household",
			cases: [{ caseId: "h1", caseName: "Household one" }],
		};
		expect(previewMenuCaseContext(doc, CHILD, { [ROOT]: selected })).toEqual({
			selectedCase: undefined,
			selectedByModuleUuid: undefined,
			parentCase: selected,
			parentModuleUuid: ROOT,
			requiredParentCase: undefined,
		});
		/* A submenu that keeps its own screen asks its own selector. */
		const ownScreen = {
			...doc,
			modules: {
				...doc.modules,
				[CHILD]: { ...doc.modules[CHILD], formsInMenuAbove: undefined },
			},
		};
		expect(
			previewMenuCaseContext(ownScreen, CHILD, { [ROOT]: selected })
				.requiredParentCase,
		).toEqual({ caseType: "household", moduleUuid: OTHER_ROOT });
	});

	it("uses the explicit selector despite an earlier module for the same type", () => {
		const base = source("person");
		const surveyField = fieldSchema.parse({
			uuid: testUuid("survey_notes"),
			kind: "text",
			id: "survey_notes",
			label: { parts: [{ kind: "text", text: "Notes" }] },
		});
		const doc = {
			...base,
			modules: {
				...base.modules,
				[ROOT]: module(ROOT, "clinic"),
				[SURVEY_ROOT]: module(SURVEY_ROOT, "household"),
				[OTHER_ROOT]: module(OTHER_ROOT, "household"),
				[CHILD]: { ...base.modules[CHILD], parentCaseModuleUuid: OTHER_ROOT },
			},
			moduleOrder: [ROOT, CHILD, SURVEY_ROOT, OTHER_ROOT],
			forms: {
				...base.forms,
				[SURVEY_FORM]: {
					uuid: SURVEY_FORM,
					id: "survey",
					name: "Survey",
					type: "survey" as const,
				},
			},
			formOrder: {
				...base.formOrder,
				[SURVEY_ROOT]: [SURVEY_FORM],
			},
			fields: { ...base.fields, [surveyField.uuid]: surveyField },
			fieldParent: { ...base.fieldParent, [surveyField.uuid]: SURVEY_FORM },
			fieldOrder: { ...base.fieldOrder, [SURVEY_FORM]: [surveyField.uuid] },
		};

		assertAdmittedPreviewDoc(doc);
		expect(previewMenuCaseContext(doc, CHILD, {})).toMatchObject({
			requiredParentCase: {
				caseType: "household",
				moduleUuid: OTHER_ROOT,
			},
		});
	});

	describe("the case list menu entry", () => {
		const REGISTER_FORM = testUuid("register-form");
		/** OTHER_ROOT with a registration beside its follow-up: forms-first. */
		function formsFirst(
			item: NonNullable<Module["caseListMenuItem"]>,
		): BlueprintDoc {
			const doc = source();
			doc.modules[OTHER_ROOT].caseListMenuItem = item;
			doc.forms[REGISTER_FORM] = {
				uuid: REGISTER_FORM,
				id: "register",
				name: "Register",
				type: "registration",
			};
			doc.formOrder[OTHER_ROOT] = [OTHER_ROOT_FORM, REGISTER_FORM];
			return doc;
		}

		it("is listed after a forms-first menu's forms under the module's name, opening the case list", () => {
			const doc = formsFirst({});
			expect(
				previewCaseListMenuEntry(doc, OTHER_ROOT, {
					isCaseFirst: false,
					hasSelectedCase: false,
				}),
			).toEqual({
				labelUnitId: makeTranslationUnitId("module", OTHER_ROOT, "name"),
				label: doc.modules[OTHER_ROOT].name,
				icon: undefined,
				audioLabel: undefined,
				action: "open-case-list",
			});
		});

		it("takes the entry's own label unit and icon when the item holds them", () => {
			const doc = formsFirst({
				label: "All visits",
				icon: "nova-icon:household",
			});
			expect(
				previewCaseListMenuEntry(doc, OTHER_ROOT, {
					isCaseFirst: false,
					hasSelectedCase: false,
				}),
			).toMatchObject({
				labelUnitId: makeTranslationUnitId(
					"module",
					OTHER_ROOT,
					"case-list-menu-item-label",
				),
				label: "All visits",
				icon: "nova-icon:household",
			});
		});

		it("lists nothing for a bare case list, whose menu is its list", () => {
			const doc = source();
			doc.modules[OTHER_ROOT].caseListMenuItem = {};
			doc.formOrder[OTHER_ROOT] = [];
			delete doc.forms[OTHER_ROOT_FORM];
			expect(
				previewCaseListMenuEntry(doc, OTHER_ROOT, {
					isCaseFirst: false,
					hasSelectedCase: false,
				}),
			).toBeUndefined();
		});

		it("lists nothing for a module without the item", () => {
			expect(
				previewCaseListMenuEntry(source(), OTHER_ROOT, {
					isCaseFirst: false,
					hasSelectedCase: false,
				}),
			).toBeUndefined();
		});

		it("is listed in a case-first menu only once the case is chosen, as the selection itself", () => {
			const doc = source();
			doc.modules[OTHER_ROOT].caseListMenuItem = {};
			expect(
				previewCaseListMenuEntry(doc, OTHER_ROOT, {
					isCaseFirst: true,
					hasSelectedCase: false,
				}),
			).toBeUndefined();
			expect(
				previewCaseListMenuEntry(doc, OTHER_ROOT, {
					isCaseFirst: true,
					hasSelectedCase: true,
				}),
			).toMatchObject({ action: "selection" });
		});
	});
});
