import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import {
	type BlueprintDoc,
	fieldSchema,
	type Module,
	makeTranslationUnitId,
	screenChoosesCaseFirst,
	simpleSearchInputDef,
} from "@/lib/domain";
import { eq, literal, sessionUser } from "@/lib/domain/expression";
import { previewDataRefusalOf } from "../engine/dataRefusal";
import {
	caseListMenuEntryOf,
	combineNavigationVisibility,
	inheritedModuleVisibility,
	previewCaseDescendantModuleUuids,
	previewCaseListContinuation,
	previewCaseListFormRequest,
	previewCaseListHeldChoices,
	previewCaseListMenuChoice,
	previewCaseListMenuEntry,
	previewCaseListReturn,
	previewContributorVisibility,
	previewMenuCaseContext,
	previewMenuHeldSelections,
	previewMenuScreenChoice,
	previewMenuScreenLanding,
	previewMenuSelectionsLetGo,
	previewModuleOwnVisibility,
	previewModuleVisibility,
	previewRequestedForm,
	previewRoutingModuleVisibility,
	previewRunningModuleScreen,
	previewScreenEntries,
	previewScreenEntryVisibility,
	previewSelectionsBefore,
	previewTargetAboveForm,
} from "../menuProjection";
import {
	pinnedTileSearchReading,
	previewPinnedCaseTile,
} from "../pinnedCaseTile";
import { previewPlatformRules } from "../platform";
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

	/* Core reads a menu's condition only on the screens that list it or are
	 * its own (`MenuLoader.getMenuDisplayables`): a condition that reads a
	 * worker key the device lacks fails those screens and no other. */
	it("reads a menu's condition only where a screen asks, so its refusal stops only those screens", () => {
		const doc = source();
		doc.modules[ROOT].displayCondition = eq(
			sessionUser("commcare_location_id"),
			literal("north"),
		);
		const session = { context: {}, user: {}, userPropertySlugs: {} };
		const own = previewModuleOwnVisibility(doc, {
			authoring: false,
			session,
			lookup: { kind: "idle" },
		});
		expect(own.get(OTHER_ROOT)).toBe("shown");
		const refusalOf = (read: () => unknown) => {
			try {
				read();
			} catch (error) {
				return previewDataRefusalOf(error)?.reason;
			}
			return undefined;
		};
		const refused = {
			kind: "empty-instance",
			instanceId: "commcaresession",
		};
		expect(refusalOf(() => own.get(ROOT))).toEqual(refused);
		// Read again, the refusal stands.
		expect(refusalOf(() => own.get(ROOT))).toEqual(refused);
		// The other menu's own screen never reads the refusing condition.
		const otherScreen = previewScreenEntryVisibility({
			doc,
			entries: previewScreenEntries(doc, {
				kind: "menu",
				moduleUuid: OTHER_ROOT,
			}),
			ownModuleVisibility: own,
			authoring: false,
			session,
			lookup: { kind: "idle" },
			selectedCaseOf: () => undefined,
		});
		expect([...otherScreen.values()].every((v) => v === "shown")).toBe(true);
		// The first menu lists the menu's tile, so it reads the condition.
		expect(
			refusalOf(() =>
				previewScreenEntryVisibility({
					doc,
					entries: previewScreenEntries(doc, { kind: "first-menu" }),
					ownModuleVisibility: own,
					authoring: false,
					session,
					lookup: { kind: "idle" },
					selectedCaseOf: () => undefined,
				}),
			),
		).toEqual(refused);
		// Routing reads the refused menu as not shown, so a location lands on
		// the screen that shows the refusal.
		const routing = previewRoutingModuleVisibility(
			doc,
			previewModuleVisibility(doc, {
				authoring: false,
				session,
				lookup: { kind: "idle" },
			}),
		);
		expect(routing.get(ROOT)).toBe("hidden");
		expect(routing.get(OTHER_ROOT)).toBe("shown");
		// A worker assigned to a place lists it by its condition.
		expect(
			previewModuleOwnVisibility(doc, {
				authoring: false,
				session: {
					context: {},
					user: { commcare_location_id: "north" },
					userPropertySlugs: {},
				},
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

		it("is never listed by a case-first menu that chooses its case, which the session already holds", () => {
			const doc = source();
			doc.modules[OTHER_ROOT].caseListMenuItem = {};
			assertAdmittedPreviewDoc(doc);
			for (const hasSelectedCase of [false, true])
				expect(
					previewCaseListMenuEntry(doc, OTHER_ROOT, {
						isCaseFirst: true,
						hasSelectedCase,
					}),
				).toBeUndefined();
			// Edit mode still shows the entry after the forms.
			expect(caseListMenuEntryOf(doc, OTHER_ROOT)).toMatchObject({
				label: doc.modules[OTHER_ROOT].name,
			});
		});

		/** ROOT (household, case first) with CHILD (person, whose parent
		 *  case is ROOT's) showing its follow-up and its case list on ROOT's
		 *  screen. */
		function childListAbove(): BlueprintDoc {
			const doc = source("person");
			doc.modules[CHILD].formsInMenuAbove = true;
			doc.modules[CHILD].caseListMenuItem = {};
			doc.modules[ROOT].caseListMenuItem = {};
			assertAdmittedPreviewDoc(doc);
			return doc;
		}

		it("is listed on a case-first screen once its case is chosen where it goes on to choose a child of that case", () => {
			const doc = childListAbove();
			const screen = { kind: "menu", moduleUuid: ROOT } as const;
			expect(previewScreenEntries(doc, screen)).toEqual([
				{ kind: "form", moduleUuid: ROOT, formUuid: ROOT_FORM },
				{ kind: "case-list", moduleUuid: ROOT },
				{ kind: "form", moduleUuid: CHILD, formUuid: CHILD_FORM },
				{ kind: "case-list", moduleUuid: CHILD },
			]);
			expect(screenChoosesCaseFirst(doc, screen)).toBe(true);
			expect(
				previewCaseListMenuEntry(doc, CHILD, {
					isCaseFirst: true,
					hasSelectedCase: false,
				}),
			).toBeUndefined();
			expect(
				previewCaseListMenuEntry(doc, CHILD, {
					isCaseFirst: true,
					hasSelectedCase: true,
				}),
			).toMatchObject({ label: doc.modules[CHILD].name });
			// The household's own entry chooses the household, already chosen.
			expect(
				previewCaseListMenuEntry(doc, ROOT, {
					isCaseFirst: true,
					hasSelectedCase: true,
				}),
			).toBeUndefined();
		});

		it("is not listed on a submenu's case-first screen whose cases the screens on the way chose", () => {
			const doc = source("person");
			doc.modules[CHILD].caseListMenuItem = {};
			assertAdmittedPreviewDoc(doc);
			expect(
				screenChoosesCaseFirst(doc, { kind: "menu", moduleUuid: CHILD }),
			).toBe(true);
			expect(
				previewCaseListMenuEntry(doc, CHILD, {
					isCaseFirst: true,
					hasSelectedCase: true,
				}),
			).toBeUndefined();
		});

		it("is listed by a forms-first menu whose list chooses its parent case first", () => {
			const doc = buildDoc({
				caseTypes: [
					{ name: "household", properties: [] },
					{ name: "person", parent_type: "household", properties: [] },
				],
				modules: [
					{
						uuid: ROOT,
						name: "Households",
						caseType: "household",
						caseListConfig: caseListConfig([
							{ field: "case_name", header: "Name" },
						]),
						forms: [
							{
								uuid: ROOT_FORM,
								name: "Visit",
								type: "followup",
								fields: [f({ kind: "text", id: "notes" })],
							},
						],
					},
					{
						uuid: CHILD,
						name: "People",
						caseType: "person",
						parentCaseModuleUuid: ROOT,
						caseListMenuItem: {},
						caseListConfig: caseListConfig([
							{ field: "case_name", header: "Name" },
						]),
						forms: [
							{
								uuid: CHILD_FORM,
								name: "Check",
								type: "followup",
								fields: [f({ kind: "text", id: "notes" })],
							},
							{
								uuid: SURVEY_FORM,
								name: "Survey",
								type: "survey",
								fields: [f({ kind: "text", id: "answer" })],
							},
						],
					},
				],
			});
			assertAdmittedPreviewDoc(doc);
			expect(
				screenChoosesCaseFirst(doc, { kind: "menu", moduleUuid: CHILD }),
			).toBe(false);
			expect(
				previewCaseListMenuEntry(doc, CHILD, {
					isCaseFirst: false,
					hasSelectedCase: false,
				}),
			).toMatchObject({ label: "People" });
		});
	});
});

describe("the form a case list holds for the case chosen on it", () => {
	// A device's session holds a form chosen before its case beneath the
	// case, and one chosen from the menu after its case above it. Stepping
	// back from the first reaches the list, which keeps the form; stepping
	// back from the second stops on the menu with the case held, and a second
	// step back reaches the list with nothing chosen (`CommCareSession.stepBack`,
	// `shouldPopNext`). `proof/native/core/MenuScreensRuntimeTest` holds the
	// screens built on this to Core.
	const menu = testUuid("menu");
	const parentMenu = testUuid("parent-menu");
	const visit = testUuid("visit");
	const review = testUuid("review");
	const forms = [visit, review];
	const ana = { caseId: "ana", caseName: "Ana" };
	const ownList = {
		moduleUuid: menu,
		continuation: "form-menu",
		session: "worker-a",
	} as const;
	/** The history entry choosing Ana on the list opened. */
	const heldMenu = { moduleUuid: menu, cases: [ana], session: "worker-a" };
	const chosenOnOwnMenu = {
		formUuid: visit,
		cases: [ana],
		formChosenAfterCase: { caseListModuleUuid: menu, fromCaseListMenu: true },
	} as const;

	it("holds a form chosen before the case, on its own list, there and after a step back", () => {
		const target = { formUuid: visit, cases: [ana] };
		expect(previewCaseListFormRequest(target, forms)).toBe(visit);
		const back = previewCaseListReturn(target, {
			moduleUuid: menu,
			formUuid: visit,
		});
		expect(back).toEqual({ moduleUuid: menu, target: { formUuid: visit } });
		expect(previewCaseListFormRequest(back.target, forms)).toBe(visit);
	});

	it("shows the list's own form menu with the case held on the entry that holds it", () => {
		expect(previewCaseListFormRequest(chosenOnOwnMenu, forms)).toBeUndefined();
		expect(previewCaseListHeldChoices(heldMenu, ownList)).toEqual([ana]);
		// The list's own entry, a step back off the menu, holds nothing.
		expect(previewCaseListHeldChoices(undefined, ownList)).toBeUndefined();
	});

	it("holds nothing on a list that continues into a menu screen, or on another list", () => {
		expect(
			previewCaseListHeldChoices(heldMenu, {
				...ownList,
				continuation: "menu-selection",
			}),
		).toBeUndefined();
		expect(
			previewCaseListHeldChoices(heldMenu, {
				...ownList,
				moduleUuid: parentMenu,
			}),
		).toBeUndefined();
		expect(
			previewCaseListHeldChoices(
				{ moduleUuid: menu, cases: [], session: "worker-a" },
				ownList,
			),
		).toBeUndefined();
	});

	it("holds nothing for a step another Preview session took", () => {
		// A worker, platform or Preview run change starts a new session; Back
		// onto the menu's entry shows the list, not the last worker's case.
		expect(
			previewCaseListHeldChoices(heldMenu, { ...ownList, session: "worker-b" }),
		).toBeUndefined();
	});

	it("returns a form chosen after its case to the list that chose the case, holding nothing", () => {
		const back = previewCaseListReturn(chosenOnOwnMenu, {
			moduleUuid: menu,
			formUuid: visit,
		});
		expect(back).toEqual({ moduleUuid: menu, target: undefined });
		expect(previewCaseListFormRequest(back.target, forms)).toBeUndefined();
		// A submenu's form whose case its parent's list chose returns there.
		expect(
			previewCaseListReturn(
				{
					formUuid: review,
					cases: [ana],
					formChosenAfterCase: { caseListModuleUuid: parentMenu },
				},
				{ moduleUuid: menu, formUuid: review },
			),
		).toEqual({ moduleUuid: parentMenu, target: undefined });
	});

	it("lets go of a case held beneath a form chosen after it on a route to a menu, and keeps any other target", () => {
		expect(previewTargetAboveForm(chosenOnOwnMenu)).toBeUndefined();
		const before = { formUuid: visit, cases: [ana] };
		expect(previewTargetAboveForm(before)).toBe(before);
	});

	it("holds no form the list does not open with a case", () => {
		expect(
			previewCaseListFormRequest({ formUuid: testUuid("register") }, forms),
		).toBeUndefined();
		expect(previewCaseListFormRequest(undefined, forms)).toBeUndefined();
	});
});

describe("the cases a screen's session holds, and the tile it pins", () => {
	// Formplayer and Android pin the tile of the EARLIEST chosen case whose
	// datum names a persistent detail (`MenuSessionRunnerService.getStepToFrame`,
	// `BreadcrumbBarHelper.loadTile`), and Nova's wire names one on every datum
	// a list that keeps its tile on screen chose.
	const ana = { caseId: "ana", caseName: "Ana" };
	const bo = { caseId: "bo", caseName: "Bo" };
	const keepsTile = (
		doc: BlueprintDoc,
		uuids: readonly string[],
	): Record<string, Module> =>
		Object.fromEntries(
			Object.entries(doc.modules).map(([uuid, mod]) => [
				uuid,
				uuids.includes(uuid) && mod.caseListConfig !== undefined
					? {
							...mod,
							caseListConfig: {
								...mod.caseListConfig,
								tile: { persistOnForms: true as const },
							},
						}
					: mod,
			]),
		);
	const web = previewPlatformRules("web-apps");
	const android = previewPlatformRules("android");

	it("holds a parent case before the menu's own, in the order they were chosen", () => {
		const doc = source("person");
		const selections = {
			[ROOT]: { caseType: "household", cases: [ana] },
			[CHILD]: { caseType: "person", cases: [bo] },
		};
		expect(previewSelectionsBefore(doc, CHILD, selections)).toEqual([
			{ moduleUuid: ROOT, cases: [ana] },
		]);
		expect(previewMenuHeldSelections(doc, CHILD, selections)).toEqual([
			{ moduleUuid: ROOT, cases: [ana] },
			{ moduleUuid: CHILD, cases: [bo] },
		]);
		// Before its own case is chosen the menu holds its parent's alone.
		expect(
			previewMenuHeldSelections(doc, CHILD, { [ROOT]: selections[ROOT] }),
		).toEqual([{ moduleUuid: ROOT, cases: [ana] }]);
	});

	it("holds a same-type case a submenu goes on with as the parent list's choice", () => {
		const doc = source();
		expect(
			previewMenuHeldSelections(doc, CHILD, {
				[ROOT]: { caseType: "household", cases: [ana] },
			}),
		).toEqual([{ moduleUuid: ROOT, cases: [ana] }]);
		expect(previewMenuHeldSelections(doc, ROOT, {})).toEqual([]);
	});

	it("holds the case a menu above chose under a submenu of an unrelated case type", () => {
		// A device's frame is [menu, household, submenu, clinic]: the household
		// stays a step of the session, and Formplayer's `getStepToFrame` and
		// Android's `loadTile` read its datum through `findDatumDefinition` over
		// the menu's own entries, so its tile stays above the submenu's list,
		// its menu and its forms.
		const doc = source("clinic");
		const held = { [ROOT]: { caseType: "household", cases: [ana] } };
		expect(previewSelectionsBefore(doc, CHILD, held)).toEqual([
			{ moduleUuid: ROOT, cases: [ana] },
		]);
		const both = { ...held, [CHILD]: { caseType: "clinic", cases: [bo] } };
		expect(previewMenuHeldSelections(doc, CHILD, both)).toEqual([
			{ moduleUuid: ROOT, cases: [ana] },
			{ moduleUuid: CHILD, cases: [bo] },
		]);
		for (const surface of ["case-list", "menu", "form"] as const)
			for (const rules of [web, android])
				expect(
					previewPinnedCaseTile(
						keepsTile(doc, [ROOT]),
						previewMenuHeldSelections(doc, CHILD, both),
						surface,
						rules,
					),
				).toEqual({ moduleUuid: ROOT, caseId: "ana" });
		// A top-level menu holds nothing another top-level menu chose.
		expect(previewSelectionsBefore(doc, OTHER_ROOT, both)).toEqual([]);
	});

	it("pins the earliest held case whose list keeps its tile on screen", () => {
		const doc = source("person");
		const held = [
			{ moduleUuid: ROOT, cases: [ana] },
			{ moduleUuid: CHILD, cases: [bo] },
		];
		expect(
			previewPinnedCaseTile(keepsTile(doc, [ROOT, CHILD]), held, "form", web),
		).toEqual({ moduleUuid: ROOT, caseId: "ana" });
		expect(
			previewPinnedCaseTile(keepsTile(doc, [CHILD]), held, "menu", android),
		).toEqual({ moduleUuid: CHILD, caseId: "bo" });
		expect(previewPinnedCaseTile(doc.modules, held, "form", web)).toBe(
			undefined,
		);
		// Several cases chosen together are a step neither platform reads.
		expect(
			previewPinnedCaseTile(
				keepsTile(doc, [ROOT, CHILD]),
				[{ moduleUuid: ROOT, cases: [ana, bo] }, held[1]],
				"case-list",
				web,
			),
		).toEqual({ moduleUuid: CHILD, caseId: "bo" });
	});

	it("pins the tile above a search on Web Apps and not on Android", () => {
		const doc = source("person");
		const held = [{ moduleUuid: ROOT, cases: [ana] }];
		expect(
			previewPinnedCaseTile(keepsTile(doc, [ROOT]), held, "search", web),
		).toEqual({ moduleUuid: ROOT, caseId: "ana" });
		expect(
			previewPinnedCaseTile(keepsTile(doc, [ROOT]), held, "search", android),
		).toBe(undefined);
	});

	it("draws the case Android's details show where no held case pins a tile, and only where its list keeps one", () => {
		// `BreadcrumbBarHelper.loadTile` falls back to the details screen's own
		// case (`EntityDetailActivity.requestEntityContext`), drawn with the
		// persistent detail of the datum being chosen; Formplayer's details
		// answer carries no tile (`MenuController.getDetails`).
		const doc = source("person");
		const viewing = { moduleUuid: CHILD, caseId: "bo", datum: "list" } as const;
		const parent = [{ moduleUuid: ROOT, cases: [ana] }];
		expect(
			previewPinnedCaseTile(
				keepsTile(doc, [CHILD]),
				parent,
				"case-details",
				android,
				viewing,
			),
		).toEqual({ moduleUuid: CHILD, caseId: "bo" });
		expect(
			previewPinnedCaseTile(
				keepsTile(doc, [CHILD]),
				parent,
				"case-details",
				web,
				viewing,
			),
		).toBe(undefined);
		// A held case whose list keeps its tile is the frame's, on both.
		for (const rules of [web, android])
			expect(
				previewPinnedCaseTile(
					keepsTile(doc, [ROOT, CHILD]),
					parent,
					"case-details",
					rules,
					viewing,
				),
			).toEqual({ moduleUuid: ROOT, caseId: "ana" });
		// A list that does not keep its tile names no persistent detail, so its
		// details draw none.
		expect(
			previewPinnedCaseTile(
				keepsTile(doc, [ROOT]),
				[],
				"case-details",
				android,
				viewing,
			),
		).toBe(undefined);
		// The case on show is no held case anywhere else.
		expect(
			previewPinnedCaseTile(
				keepsTile(doc, [CHILD]),
				parent,
				"case-list",
				android,
				viewing,
			),
		).toBe(undefined);
	});

	it("draws no tile on Android's details of a search action's results or of a parent another list asked for", () => {
		// A search action's results choose for its remote request's
		// `search_case_id`, which names `detail-confirm` and no
		// `detail-persistent` (`searchSession.ts::buildSearchSession`, as HQ's
		// `remote_requests.py` writes it), and a parent request's datum names
		// no details screen, beside which alone
		// `EntityDetailUtils.populateDetailIntent` passes a persistent detail:
		// `EntityDetailActivity` holds no entity context, so `loadTile` draws
		// none where the frame names none.
		const doc = keepsTile(source("person"), [CHILD]);
		for (const datum of ["search-results", "parent"] as const) {
			expect(
				previewPinnedCaseTile(doc, [], "case-details", android, {
					moduleUuid: CHILD,
					caseId: "bo",
					datum,
				}),
			).toBe(undefined);
			// A held case whose list keeps its tile is still the frame's.
			expect(
				previewPinnedCaseTile(
					keepsTile(source("person"), [ROOT, CHILD]),
					[{ moduleUuid: ROOT, cases: [ana] }],
					"case-details",
					android,
					{ moduleUuid: CHILD, caseId: "bo", datum },
				),
			).toEqual({ moduleUuid: ROOT, caseId: "ana" });
		}
	});

	it("reads the tile of a case a list whose forms read the search chose as that search found it, and any other list's from the device", () => {
		// Each case-loading datum of an inline search reads `results:inline`,
		// and Formplayer draws the tile from the datum's own nodeset
		// (`getPersistentDetail` → `getEntityFromID`); the claim posts only as
		// a form opens, so on the menu the device may not hold the case yet.
		const name = (menu: string) =>
			simpleSearchInputDef(
				testUuid(`tile-search-name-${menu}`),
				"name",
				"Name",
				"text",
				"case_name",
			);
		const doc = buildDoc({
			caseTypes: [{ name: "patient", properties: [] }],
			modules: [
				{
					name: "Inline",
					caseType: "patient",
					caseListConfig: {
						...caseListConfig([]),
						searchInputs: [name("inline")],
					},
					caseSearchConfig: { formsReadSearch: true },
				},
				{
					name: "Action",
					caseType: "patient",
					caseListConfig: {
						...caseListConfig([]),
						searchInputs: [name("action")],
					},
					caseSearchConfig: {},
				},
			],
		});
		const [inline, action] = doc.moduleOrder.map((uuid) => doc.modules[uuid]);
		const completed = {
			kind: "completed",
			attempt: 1,
			submission: "inline-search",
			answers: { name: "Kofi" },
			matchCount: 1,
		} as const;
		expect(pinnedTileSearchReading(inline, completed)).toEqual({
			answers: { name: "Kofi" },
		});
		// A search action's claim lands before its choice goes on: the
		// device's case.
		expect(pinnedTileSearchReading(action, completed)).toBe(undefined);
		// A search let go, or not yet complete, reads the device's.
		expect(pinnedTileSearchReading(inline, undefined)).toBe(undefined);
		expect(
			pinnedTileSearchReading(inline, {
				kind: "running",
				attempt: 2,
				submission: "again",
				answers: { name: "Ama" },
			}),
		).toBe(undefined);
	});
});

describe("what choosing a case goes on to", () => {
	const ana = { caseId: "ana", caseName: "Ana" };
	const household = { caseType: "household", cases: [ana] };

	it("continues a case-first list into its own form menu, its menu screen, or a requested form", () => {
		const doc = source();
		expect(previewCaseListContinuation(doc, OTHER_ROOT)).toBe("form-menu");
		// A menu with submenus lists them once its case is chosen.
		expect(previewCaseListContinuation(doc, ROOT)).toBe("menu-selection");
		expect(
			previewCaseListContinuation(doc, ROOT, { seededFormUuid: ROOT_FORM }),
		).toBe("form");
		expect(
			previewCaseListContinuation(doc, OTHER_ROOT, {
				retainedFormUuid: OTHER_ROOT_FORM,
			}),
		).toBe("form");
		expect(
			previewCaseListContinuation(doc, OTHER_ROOT, {
				selectsForParentRequest: true,
			}),
		).toBe("menu-selection");
	});

	it("opens a requested form whatever its condition, as Core lists no menu once its entry holds the case", () => {
		expect(previewRequestedForm([ROOT_FORM, CHILD_FORM], CHILD_FORM)).toBe(
			CHILD_FORM,
		);
		expect(previewRequestedForm([ROOT_FORM], CHILD_FORM)).toBeUndefined();
		expect(previewRequestedForm([ROOT_FORM])).toBeUndefined();
	});

	it("lands a case-first menu on its list until its case is chosen, then on its menu", () => {
		const doc = source();
		const menuSource = { ...doc, doc };
		expect(
			previewMenuScreenLanding(menuSource, ROOT, {}, { mode: "preview" }).kind,
		).toBe("open-case-list");
		expect(
			previewMenuScreenLanding(
				menuSource,
				ROOT,
				{ [ROOT]: household },
				{ mode: "preview" },
			).kind,
		).toBe("form-menu");
		expect(
			previewMenuScreenLanding(menuSource, ROOT, {}, { mode: "edit" }).kind,
		).toBe("form-menu");
	});

	it("names the list that chose the case a menu screen's form goes on with", () => {
		const doc = source();
		expect(previewMenuScreenChoice(doc, CHILD, { [ROOT]: household })).toEqual({
			caseListModuleUuid: ROOT,
		});
		expect(previewMenuScreenChoice(doc, CHILD, {})).toEqual({
			caseListModuleUuid: CHILD,
		});
		expect(previewCaseListMenuChoice(OTHER_ROOT)).toEqual({
			caseListModuleUuid: OTHER_ROOT,
			fromCaseListMenu: true,
		});
	});

	it("keeps only the cases chosen on the menus above the screen a crumb names", () => {
		const doc = source();
		const selections = {
			[ROOT]: household,
			[CHILD]: household,
			[OTHER_ROOT]: { caseType: "visit", cases: [ana] },
		};
		const sorted = (uuids: readonly string[]) => [...uuids].sort();
		// A submenu's crumb keeps its parent's case, chosen before it.
		expect(
			sorted(
				previewMenuSelectionsLetGo(doc, selections, { moduleUuid: CHILD }),
			),
		).toEqual(sorted([CHILD, OTHER_ROOT]));
		// A case's crumb keeps the case itself.
		expect(
			previewMenuSelectionsLetGo(doc, selections, {
				moduleUuid: CHILD,
				through: true,
			}),
		).toEqual([OTHER_ROOT]);
		// A top-level menu's crumb asks for its case again.
		expect(
			sorted(previewMenuSelectionsLetGo(doc, selections, { moduleUuid: ROOT })),
		).toEqual(sorted([ROOT, CHILD, OTHER_ROOT]));
		expect(
			sorted(
				previewMenuSelectionsLetGo(doc, selections, { moduleUuid: undefined }),
			),
		).toEqual(sorted([ROOT, CHILD, OTHER_ROOT]));
	});

	it("keeps the parent case a sibling menu's list chose on the crumb of the case after it", () => {
		// Visits (person) is a top-level menu whose parent case is chosen on
		// Households' list. Web Apps' crumb of the person keeps every selection
		// before it (`CloudcareUrl.spliceSelections`), the household included,
		// so the menu still has its parent case; the crumb's `keepsCasesOf` is
		// the menus the session chose up to it (`previewMenuHeldSelections`).
		const doc = source("person");
		delete doc.modules[CHILD].parentModuleUuid;
		assertAdmittedPreviewDoc(doc);
		const ana = { caseId: "ana", caseName: "Ana" };
		const bo = { caseId: "bo", caseName: "Bo" };
		const selections = {
			[ROOT]: { caseType: "household", cases: [ana] },
			[CHILD]: { caseType: "person", cases: [bo] },
		};
		const keeps = previewMenuHeldSelections(doc, CHILD, selections).map(
			(selection) => selection.moduleUuid,
		);
		expect(keeps).toEqual([ROOT, CHILD]);
		const letGo = previewMenuSelectionsLetGo(doc, selections, {
			moduleUuid: CHILD,
			through: true,
			keeps,
		});
		expect(letGo).toEqual([]);
		const after = Object.fromEntries(
			Object.entries(selections).filter(
				([uuid]) => !letGo.includes(uuid as typeof ROOT),
			),
		);
		expect(
			previewMenuCaseContext(doc, CHILD, after).requiredParentCase,
		).toBeUndefined();
		// The menu's own crumb cuts to its command, before the parent was
		// chosen, so the menu asks for its parent case again.
		const menuCut = previewMenuSelectionsLetGo(doc, selections, {
			moduleUuid: CHILD,
		});
		expect([...menuCut].sort()).toEqual([ROOT, CHILD].sort());
	});

	it("lets go the parent case a forms-first menu's list chose for its submenu on the submenu's crumb", () => {
		// Households lists a registration beside its follow-up, so it chooses
		// no case before it lists its entries; Members, its submenu of persons,
		// asks for its parent household on Households' list once its own
		// command is chosen. A device's frame is [Households, Members,
		// household, person], so Web Apps' Members crumb cuts it to
		// [Households, Members] (`CloudcareUrl.spliceSelections`) and the
		// household is asked for again, while the person's crumb keeps it.
		const caseTypes = [
			{ name: "household", properties: [] },
			{ name: "person", parent_type: "household", properties: [] },
		];
		const followup = (uuid: typeof ROOT) => ({
			uuid,
			name: "Follow-up",
			type: "followup" as const,
			fields: [f({ kind: "text", id: "notes" })],
		});
		const built = buildDoc({
			caseTypes,
			modules: [
				{
					uuid: ROOT,
					name: "Households",
					caseType: "household",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [
						followup(ROOT_FORM),
						{
							uuid: testUuid("register-household"),
							name: "Register",
							type: "registration" as const,
							fields: [
								f({
									kind: "text",
									id: "case_name",
									caseWrite: { caseType: "household", property: "case_name" },
								}),
							],
						},
					],
				},
				{
					uuid: CHILD,
					name: "Members",
					caseType: "person",
					parentCaseModuleUuid: ROOT,
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [followup(CHILD_FORM)],
				},
			],
		});
		built.modules[CHILD].parentModuleUuid = ROOT;
		assertAdmittedPreviewDoc(built);
		const doc = { ...built, caseTypes };
		expect(
			screenChoosesCaseFirst(doc, { kind: "menu", moduleUuid: ROOT }),
		).toBe(false);
		const bo = { caseId: "bo", caseName: "Bo" };
		const selections = {
			[ROOT]: household,
			[CHILD]: { caseType: "person", cases: [bo] },
		};
		// The household follows Members' command: a parent case it asked for.
		expect(previewSelectionsBefore(doc, CHILD, selections)).toEqual([
			{ moduleUuid: ROOT, cases: [ana], askedForBy: CHILD },
		]);
		const menuCut = previewMenuSelectionsLetGo(doc, selections, {
			moduleUuid: CHILD,
		});
		expect([...menuCut].sort()).toEqual([ROOT, CHILD].sort());
		expect(previewMenuCaseContext(doc, CHILD, {}).requiredParentCase).toEqual({
			caseType: "household",
			moduleUuid: ROOT,
		});
		const keeps = previewMenuHeldSelections(doc, CHILD, selections).map(
			(selection) => selection.moduleUuid,
		);
		expect(keeps).toEqual([ROOT, CHILD]);
		expect(
			previewMenuSelectionsLetGo(doc, selections, {
				moduleUuid: CHILD,
				through: true,
				keeps,
			}),
		).toEqual([]);
		// Under a case-first Households the household precedes Members'
		// command, and Members' crumb keeps it.
		const caseFirst = source("person");
		expect(previewSelectionsBefore(caseFirst, CHILD, selections)).toEqual([
			{ moduleUuid: ROOT, cases: [ana] },
		]);
		expect(
			previewMenuSelectionsLetGo(caseFirst, selections, { moduleUuid: CHILD }),
		).toEqual([CHILD]);
	});
});
