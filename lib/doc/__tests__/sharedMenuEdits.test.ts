import { expect, it } from "vitest";
import { testMediaAssetId, testUuid } from "@/__tests__/helpers/uuid";
import { caseListConfig } from "@/lib/__tests__/docHelpers";
import {
	REGISTER,
	ROUTE,
	SOURCE,
	twoMenus,
	VISIT,
} from "@/lib/commcare/__tests__/menuFormRoutesFixture";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { diffDocsToMutations } from "@/lib/doc/diffDocsToMutations";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import {
	caseListModuleMutations,
	listedFormMenuMutations,
} from "@/lib/doc/scaffolds";
import { sharedChildUuid } from "@/lib/doc/sharedFormChildren";
import {
	changeListedMenuSource,
	withListedMenuHierarchy,
} from "@/lib/doc/sharedMenuHierarchy";
import type { BlueprintDoc, Mutation } from "@/lib/doc/types";
import {
	calculatedColumn,
	idMappingColumn,
	makeTranslationUnitId,
	projectLocalizedModule,
	simpleSearchInputDef,
	tileCell,
	translationUnitsById,
} from "@/lib/domain";
import { caseMappingTextUnit } from "@/lib/domain/caseMappingRows";
import { input, literal, term } from "@/lib/domain/expression";
import { effectiveAppLocalization } from "@/lib/domain/localization";
import { navigationFilesInLanguage } from "@/lib/domain/navigationMedia";
import { previewCaseListOrderLocale } from "@/lib/preview/engine/caseListOrder";

function apply(doc: BlueprintDoc, mutations: readonly Mutation[]) {
	const verdict = mutationCommitVerdict(
		doc,
		mutations,
		LOOKUP_CONTEXT_UNAVAILABLE,
	);
	if (!verdict.ok) throw new Error(JSON.stringify(verdict.findings));
	return verdict.nextDoc;
}

it("replays per-form changes to a listed menu while preserving an unrelated form link and a concurrent exclusion", () => {
	const doc = twoMenus();
	const added = { uuid: testUuid("register-in-clinic"), id: "clinic-register" };
	const before = apply(doc, [
		{
			kind: "addEntryPoint",
			entryPoint: added,
			target: { kind: "form", moduleUuid: ROUTE, formUuid: REGISTER },
		},
	]);
	const after = apply(before, [
		{
			kind: "updateModule",
			uuid: ROUTE,
			patch: {},
			listedForm: { sourceUuid: SOURCE, formUuid: REGISTER, included: true },
		},
		{
			kind: "updateEntryPoint",
			entryPointUuid: added.uuid,
			patch: { id: "register-here" },
		},
	]);
	const edits = diffDocsToMutations(before, after);
	expect(apply(before, edits)).toEqual(after);
	const concurrent = apply(before, [
		{
			kind: "updateModule",
			uuid: ROUTE,
			patch: {},
			listedForm: { sourceUuid: SOURCE, formUuid: VISIT, included: false },
		},
	]);
	const replayed = apply(concurrent, edits).modules[ROUTE].formsFromMenu;
	expect(replayed?.excludedFormUuids).toEqual([VISIT]);
	expect(replayed?.entryPoints?.map((row) => row.entryPoint.id)).toEqual([
		"clinic-visit",
		"register-here",
	]);
	expect(apply(after, diffDocsToMutations(after, before))).toEqual(before);
	expect(
		mutationCommitVerdict(
			before,
			[
				{
					kind: "updateModule",
					uuid: ROUTE,
					patch: { formsFromMenu: { menuUuid: SOURCE, entryPoints: [] } },
				},
			],
			LOOKUP_CONTEXT_UNAVAILABLE,
		).ok,
	).toBe(false);
});

it("preserves a listed child and its edited columns on reorder, removes it with the source child, and restores its real identities", () => {
	const before = twoMenus();
	const scaffold = caseListModuleMutations(before, {
		caseType: "patient",
		name: "Neighborhood",
		parentModuleUuid: SOURCE,
	});
	const edits = withListedMenuHierarchy(before, scaffold.mutations);
	const after = apply(before, edits);
	const child = sharedChildUuid(ROUTE, scaffold.moduleUuid);
	const settings = after.modules[child]?.caseListConfig;
	const column = settings?.columns[0];
	const original =
		after.modules[scaffold.moduleUuid]?.caseListConfig?.columns[0];
	if (!column || !original)
		throw new Error("The two paths need separate columns.");
	expect(after.modules[child].parentModuleUuid).toBe(ROUTE);
	expect(after.modules[child].formsFromMenu?.menuUuid).toBe(
		scaffold.moduleUuid,
	);
	expect(column.uuid).not.toBe(original.uuid);
	const renamed = apply(after, [
		{ kind: "renameModule", uuid: child, newId: "Clinic area" },
	]);
	const reorder = withListedMenuHierarchy(renamed, [
		{ kind: "moveModule", uuid: scaffold.moduleUuid, after: null },
	]);
	expect(apply(renamed, reorder).modules[child]).toEqual(
		renamed.modules[child],
	);
	const detach = withListedMenuHierarchy(renamed, [
		{ kind: "moveModule", uuid: child, parentModuleUuid: null, after: null },
	]);
	const detached = mutationCommitVerdict(
		renamed,
		detach,
		LOOKUP_CONTEXT_UNAVAILABLE,
	);
	expect(detached).toMatchObject({
		ok: false,
		findings: expect.arrayContaining([
			expect.objectContaining({ code: "MENU_FORM_SOURCE_INVALID" }),
		]),
	});
	// Deleting the generated child alone names the steps a person can take.
	expect(
		mutationCommitVerdict(
			renamed,
			withListedMenuHierarchy(renamed, [{ kind: "removeModule", uuid: child }]),
			LOOKUP_CONTEXT_UNAVAILABLE,
		),
	).toMatchObject({
		ok: false,
		findings: expect.arrayContaining([
			expect.objectContaining({
				code: "MENU_FORM_SOURCE_INVALID",
				message:
					"“Neighborhood” appears in “Clinic” because “Patients” has it. Hide its forms in “Clinic”, or remove “Neighborhood” from “Patients”.",
			}),
		]),
	});
	const remove = withListedMenuHierarchy(renamed, [
		{ kind: "removeModule", uuid: scaffold.moduleUuid },
	]);
	const deleted = apply(renamed, remove);
	expect(deleted.modules[child]).toBeUndefined();
	expect(deleted.forms).toEqual(renamed.forms);
	expect(apply(deleted, diffDocsToMutations(deleted, renamed))).toEqual(
		renamed,
	);
});

it.each([
	{ kind: "text" as const, text: "New" },
	{ kind: "calculation" as const, expression: term(literal("3")) },
])("starts a listed child with its source child's $kind badge", (badge) => {
	const before = twoMenus();
	const scaffold = caseListModuleMutations(before, {
		caseType: "patient",
		name: "Neighborhood",
		parentModuleUuid: SOURCE,
	});
	const born = scaffold.mutations.map((mutation) =>
		mutation.kind === "addModule" &&
		mutation.module.uuid === scaffold.moduleUuid
			? { ...mutation, module: { ...mutation.module, badge } }
			: mutation,
	);
	const after = apply(before, withListedMenuHierarchy(before, born));
	expect(after.modules[scaffold.moduleUuid]?.badge).toEqual(badge);
	const child = sharedChildUuid(ROUTE, scaffold.moduleUuid);
	expect(after.modules[child]?.formsFromMenu?.menuUuid).toBe(
		scaffold.moduleUuid,
	);
	expect(after.modules[child]?.badge).toEqual(badge);
});

it("starts a listed child with its source child's localized navigation files", () => {
	const before = twoMenus();
	before.localization = {
		sourceLanguage: "eng",
		defaultLanguage: "eng",
		languageOrder: ["eng", "fra"],
		wireCodes: { eng: "en", fra: "fr" },
		translations: { fra: {} },
	};
	const scaffold = caseListModuleMutations(before, {
		caseType: "patient",
		name: "Neighborhood",
		parentModuleUuid: SOURCE,
	});
	const icon = testMediaAssetId("neighborhood-icon");
	const audioLabel = testMediaAssetId("neighborhood-audio");
	const formerlyUsed = testMediaAssetId("neighborhood-former-icon");
	const born = scaffold.mutations.map((mutation) =>
		mutation.kind === "addModule" &&
		mutation.module.uuid === scaffold.moduleUuid
			? {
					...mutation,
					module: {
						...mutation.module,
						icon: testMediaAssetId("neighborhood-shared-icon"),
						audioLabel: testMediaAssetId("neighborhood-shared-audio"),
						mediaByLanguage: {
							fra: { icon, audioLabel },
							eng: { icon: "blank" as const },
						},
						mediaByFormerCode: { fre: { icon: formerlyUsed } },
					},
				}
			: mutation,
	);
	const after = apply(before, withListedMenuHierarchy(before, born));
	const child = after.modules[sharedChildUuid(ROUTE, scaffold.moduleUuid)];
	expect(child.mediaByLanguage?.eng?.icon).toBe("blank");
	expect(child.mediaByFormerCode?.fre?.icon).toBe(formerlyUsed);
	expect(
		navigationFilesInLanguage(
			child,
			"fra",
			effectiveAppLocalization(after.localization),
		),
	).toEqual({ icon, audioLabel });
});

it("gives a listed child's detail, search and wording settings their own identities", () => {
	const before: BlueprintDoc = {
		...apply(twoMenus(), [{ kind: "removeModule", uuid: ROUTE }]),
		localization: {
			sourceLanguage: "eng",
			defaultLanguage: "eng",
			languageOrder: ["eng", "fra"],
			wireCodes: { eng: "en", fra: "fr" },
			translations: { fra: {} },
		},
	};
	const scaffold = caseListModuleMutations(before, {
		caseType: "patient",
		name: "Neighborhood",
		parentModuleUuid: SOURCE,
	});
	const text = testUuid("appointment-word");
	const row = {
		uuid: testUuid("patient-name-rule"),
		value: "Dana",
		label: "Seen",
	};
	const mapping = idMappingColumn(
		testUuid("mapping"),
		"case_name",
		"Status",
		[row],
		{ visibleInList: false },
	);
	const calculation = calculatedColumn(
		testUuid("calculation"),
		"When",
		{
			kind: "case-text",
			textUuid: text,
		},
		{ visibleInList: false, notOnList: true },
	);
	calculation.texts = [{ uuid: text, label: "Morning" }];
	const config = caseListConfig([{ field: "case_name", header: "Patient" }]);
	config.columns.push(mapping, calculation);
	config.listColumnOrder.push(mapping.uuid, calculation.uuid);
	config.detailColumnOrder.push(mapping.uuid, calculation.uuid);
	const [name] = config.columns;
	const tab = {
		uuid: testUuid("visits-tab"),
		title: "Visits",
		startColumnUuid: name.uuid,
	};
	const search = simpleSearchInputDef(
		testUuid("search-name"),
		"patient_name",
		"Patient name",
		"text",
		"case_name",
	);
	config.detailTabs = [tab];
	config.detailTile = {
		cells: Object.fromEntries(
			config.columns.map(({ uuid }, i) => [uuid, tileCell(0, i, 4, 1)]),
		),
	};
	config.calculatedSorts = [
		{
			uuid: testUuid("arrival-order"),
			direction: "asc",
			priority: 0,
			expression: term(literal(1)),
			label: "Arrival order",
		},
	];
	config.searchInputs = [search];
	config.searchFilters = [
		{
			uuid: testUuid("search-filter-name"),
			target: { kind: "record-name" },
			value: term(input(search.uuid)),
		},
	];
	const source = apply(
		before,
		scaffold.mutations.map((mutation) =>
			mutation.kind === "addModule" &&
			mutation.module.uuid === scaffold.moduleUuid
				? {
						...mutation,
						module: {
							...mutation.module,
							caseListConfig: config,
							caseSearchConfig: {},
						},
					}
				: mutation,
		),
	);
	const units = translationUnitsById(source);
	const localizedSource = apply(
		source,
		[
			[makeTranslationUnitId("detail-tab", tab.uuid, "title"), "Visites"],
			[caseMappingTextUnit(mapping.uuid, row, "mapping"), "Vu"],
			[
				makeTranslationUnitId(
					"column",
					calculation.uuid,
					"calculation-text",
					text,
				),
				"Matin",
			],
			[
				makeTranslationUnitId(
					"case-sort",
					config.calculatedSorts[0].uuid,
					"label",
				),
				"Ordre d'arrivée",
			],
		].map(([unitId, value]): Mutation => {
			const unit = units.get(unitId);
			if (!unit) throw new Error(`Missing source unit ${unitId}`);
			return {
				kind: "setTranslation",
				language: "fra",
				unitId,
				entry: {
					value,
					sourceFingerprint: unit.sourceFingerprint,
					origin: "human",
					review: "reviewed",
					translatedFrom: "eng",
				},
			};
		}),
	);
	const listing = listedFormMenuMutations(localizedSource, {
		menuUuid: SOURCE,
	});
	if (!listing.ok) throw new Error(listing.message);
	const result = apply(localizedSource, listing.mutations);
	const id = sharedChildUuid(listing.moduleUuid, scaffold.moduleUuid);
	const child = projectLocalizedModule(result, "fra", id)?.caseListConfig;
	if (!child) throw new Error("The listed child needs its own settings.");
	const [childName, childMapping, childCalculation] = child.columns;
	if (
		childMapping.kind !== "id-mapping" ||
		childCalculation.kind !== "calculated"
	)
		throw new Error("The listed child lost its columns.");
	expect(child.listColumnOrder).toEqual(child.columns.map(({ uuid }) => uuid));
	expect(child.detailTabs?.[0]).toMatchObject({
		title: "Visites",
		startColumnUuid: childName.uuid,
	});
	expect(child.detailTile?.cells).toEqual(
		Object.fromEntries(
			child.columns.map(({ uuid }, i) => [uuid, tileCell(0, i, 4, 1)]),
		),
	);
	expect(childMapping.mapping[0]).toMatchObject({ label: "Vu" });
	const word = childCalculation.texts?.[0];
	if (!word) throw new Error("The listed child's calculation needs its word.");
	expect(
		previewCaseListOrderLocale(result, "patient", "fra").calculationText(
			childCalculation,
			word,
		),
	).toBe("Matin");
	expect(childCalculation.expression).toEqual({
		kind: "case-text",
		textUuid: childCalculation.texts?.[0].uuid,
	});
	expect(child.calculatedSorts?.[0]?.label).toBe("Ordre d'arrivée");
	expect(child.searchFilters?.[0]).toMatchObject({
		value: term(input(child.searchInputs[0].uuid)),
	});
});

it("requires an explicit decision about active and paused form links before changing the menu that supplies forms", () => {
	const doc = twoMenus();
	const other = caseListModuleMutations(doc, {
		caseType: "patient",
		name: "Other clinic",
	});
	const before = apply(doc, other.mutations);
	expect(
		changeListedMenuSource(before, ROUTE, SOURCE, other.moduleUuid),
	).toMatchObject({
		ok: false,
		message: expect.stringContaining("clinic-visit"),
	});
	const removed = apply(before, [
		{ kind: "removeEntryPoint", entryPointUuid: testUuid("clinic-visit") },
	]);
	const switchSource = changeListedMenuSource(
		removed,
		ROUTE,
		SOURCE,
		other.moduleUuid,
	);
	if (!switchSource.ok) throw new Error(switchSource.message);
	const after = apply(
		removed,
		withListedMenuHierarchy(removed, switchSource.mutations),
	);
	expect(after.modules[ROUTE].formsFromMenu).toEqual({
		menuUuid: other.moduleUuid,
	});
	expect(apply(before, diffDocsToMutations(before, after))).toEqual(after);
	expect(apply(after, diffDocsToMutations(after, before))).toEqual(before);
	expect(
		mutationCommitVerdict(
			after,
			[
				{
					kind: "updateModule",
					uuid: ROUTE,
					patch: {},
					listedForm: {
						sourceUuid: SOURCE,
						formUuid: REGISTER,
						included: false,
					},
				},
			],
			LOOKUP_CONTEXT_UNAVAILABLE,
		).ok,
	).toBe(false);
});

it("preserves the route and external link when an HQ edit moves the form and changes that route's source together", () => {
	const initial = twoMenus();
	const other = caseListModuleMutations(initial, {
		caseType: "patient",
		name: "Outreach",
	});
	const before = apply(initial, other.mutations);
	const link = before.modules[ROUTE].formsFromMenu?.entryPoints?.[0];
	if (!link) throw new Error("The original route needs its Visit link.");
	const moved = apply(before, [
		{
			kind: "moveForm",
			uuid: VISIT,
			toModuleUuid: other.moduleUuid,
			after: null,
		},
		{
			kind: "updateModule",
			uuid: ROUTE,
			patch: { formsFromMenu: { menuUuid: other.moduleUuid } },
		},
	]);
	const next = apply(moved, [
		{
			kind: "addEntryPoint",
			target: { kind: "form", moduleUuid: ROUTE, formUuid: VISIT },
			entryPoint: link.entryPoint,
		},
	]);
	expect(apply(before, diffDocsToMutations(before, next))).toEqual(next);
	expect(apply(next, diffDocsToMutations(next, before))).toEqual(before);
});
