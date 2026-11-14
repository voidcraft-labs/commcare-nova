/**
 * The `menu-screens` family: both exports of the targeted documents of menus
 * that show their forms in the menu above and of registration from the case
 * list, of the two documents of registration from the case list again with
 * each list's other `afterSubmit` wherever Nova's gate admits it, and of two
 * documents Nova's gate refuses, built past it as the nested-menu proofs
 * build their counterexamples.
 *
 * Each document writes `<name>.json` (the HQ import body, which HQ's step
 * builds its suite from, `proof/native/steps/suite_emission.py::menu_screens`),
 * `<name>.suite.xml` (the local archive's suite) and `<name>.screens.json`:
 * the cases the worker's device holds (`deviceCases`), what Nova's projection
 * says each screen lists (`lib/domain/menuScreens.ts`), which entries Preview
 * shows there as a device reaches the screen: for a worker holding each role
 * of `WORKER_ROLES`, with no case chosen, or, on a screen that chooses a case
 * first, once each case of the screen's type is chosen
 * (`menuProjection.ts::previewScreenEntryVisibility` and
 * `previewCaseListMenuEntry`, as `ModuleScreen` reads them), which rows of a
 * menu that shows its forms in its parent's menu that worker loses to the
 * parent's condition alone (`parentHiddenCommands`), whether Core asks for a
 * case first, which entries open in a menu whose forms read the
 * search, and where Preview lands each form after submit
 * (`engine/frameLanding.ts::screenOfFrame` over the form's after-submit
 * frame). A document with a case list that offers another menu's
 * registration form also writes `<name>.offers.json`: each host's menu, the
 * offered form's command, and where Preview lands a worker who registered
 * from the list, with a case created and without
 * (`engine/caseListRegisterAction.ts::alwaysOfferedRegistrationReturn`).
 * `MenuScreensRuntimeTest` and `RegisterFromListRuntimeTest` hold Core to
 * them.
 *
 * The two refused documents: `step-back-control`, two top-level menus above
 * each holding one follow-up form of its own case type and an ordinary menu
 * of the first type whose follow-up links to the first of them, whose link
 * frame HQ builds through the first menu with the chosen case first; and
 * `two-registrations-control`, a registration form that also creates a
 * child of its own type at its root, offered from a list, which HQ's build
 * refuses (`validate_case_list_form`, `case list form not registration`).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import AdmZip from "adm-zip";
import { testUuid } from "../../../__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "../../../lib/__tests__/docHelpers";
import type { CaseRow } from "../../../lib/case-store";
import { compileCcz } from "../../../lib/commcare/compiler";
import { expandDoc } from "../../../lib/commcare/expander";
import {
	type FormLinkProjectionContext,
	formCommandId,
	formLinkProjectionContext,
	moduleFrameChildren,
	moduleIndexOf,
	previousEntryFrameChildren,
} from "../../../lib/commcare/formLinkProjection";
import type { RuntimeTarget } from "../../../lib/commcare/runtimeTarget";
import { alwaysOfferedRegistrationMutations } from "../../../lib/doc/alwaysOfferedRegistration";
import { mutationCommitVerdict } from "../../../lib/doc/commitVerdicts";
import { hydratePersistedBlueprint } from "../../../lib/doc/fieldParent";
import type { Mutation } from "../../../lib/doc/types";
import {
	alwaysOfferedRegistrationOf,
	type BlueprintDoc,
	type CaseOperation,
	caseListRegistrationReturnOf,
	conditionModulesOf,
	effectivePostSubmit,
	type MenuScreen,
	type MenuScreenEntry,
	menuScreenEntries,
	menuScreenOf,
	moduleFormsReadSearch,
	moduleHasOwnScreen,
	moduleUuidOfForm,
	orderedUserProperties,
	proseText,
	screenChoosesCaseFirst,
	screenIsBareCaseList,
	type Uuid,
} from "../../../lib/domain";
import { formField, term } from "../../../lib/domain/expression";
import { alwaysOfferedRegistrationReturn } from "../../../lib/preview/engine/caseListRegisterAction";
import {
	type NavigationDeviceCases,
	type NavigationItemVisibility,
	navigationSelectedCase,
} from "../../../lib/preview/engine/displayConditionEvaluation";
import {
	type FrameLanding,
	screenOfFrame,
} from "../../../lib/preview/engine/frameLanding";
import type { PreviewSearchSessionValues } from "../../../lib/preview/engine/identity";
import {
	menuScreenEntryKey,
	previewCaseListMenuEntry,
	previewContributorVisibility,
	previewMenuCaseContext,
	previewModuleOwnVisibility,
	previewScreenEntryVisibility,
} from "../../../lib/preview/menuProjection";
import { lookupContextOf } from "../../corpus/documents";
import { formsInMenuAbove } from "../../targeted/documents/formsInMenuAbove";
import { formsInMenuAboveNested } from "../../targeted/documents/formsInMenuAboveNested";
import {
	formsInMenuAboveOneCase,
	formsInMenuAboveRegistrationOnly,
} from "../../targeted/documents/formsInMenuAbovePrefixes";
import {
	registerFromCaseList,
	registerFromCaseListWebApps,
} from "../../targeted/documents/registerFromCaseList";

/**
 * The deployment HQ's step builds each document's suite for
 * (`proof/native/steps/suite_emission.py::menu_screens`, `ENDPOINT_DOMAIN`
 * and the app id it names), so a frame that names a request, the case
 * fixture an inline search's return frame reads, is compared with HQ's whole.
 */
const MENU_SCREENS_TARGET: RuntimeTarget = {
	server: "production",
	domain: "test-domain",
	appId: "menu-screens-evidence",
};

const output = process.argv[2];
if (!output)
	throw new Error(
		"Usage: node --import tsx proof/native/producers/emit-menu-screens-evidence.ts OUTPUT_DIRECTORY",
	);
mkdirSync(output, { recursive: true });

/**
 * The worker roles each screen is listed for: blank, and each value of the
 * worker's `role` a display condition of the targeted documents compares
 * with, so every condition is read both holding and not
 * (`assertEveryMenuConditionHolds`), and a submenu's condition joined with its
 * parent's is read both holding and failing on the parent's side alone
 * (`assertEveryConjunctionIsRead`). The documents that compare it declare
 * `role` as a worker property, so a publish asks the project space for the
 * field (`lib/deployment/setupArtifact.ts`, worker information), and a worker
 * the project space holds no value for has it blank: HQ's restore gives every
 * worker each user field the project space defines, `''` where none is set
 * (`user_data.py::UserData.to_dict`), as Preview reads a declared property.
 */
const WORKER_ROLES = ["", "registrar", "visitor", "checker"] as const;

/**
 * The property values of the cases the device holds of each case type a
 * screen chooses first, one case per entry, so a form's display condition
 * that reads the chosen case is read both holding and not
 * (`assertEveryCaseConditionIsRead`). A type not named holds one case with no
 * properties.
 */
const CASE_VALUES: Readonly<
	Record<string, readonly Readonly<Record<string, string>>[]>
> = {
	household: [{ village: "north" }, { village: "south" }],
};

/** A case the worker's device holds, which Core's case storage holds alike
 *  (`MenuScreensRuntimeTest.session`). */
interface DeviceCase {
	readonly id: string;
	readonly type: string;
	readonly properties: Readonly<Record<string, string>>;
}

/** One reading of a screen: the worker's role and, on a screen that chooses
 *  a case first, the case chosen there and the menu that chose it. */
interface Reading {
	readonly role: string;
	readonly chosen?: { readonly moduleUuid: Uuid; readonly case: DeviceCase };
}

/** The menu screen a module's own screen is. */
function ownScreen(moduleUuid: Uuid): MenuScreen {
	return { kind: "menu", moduleUuid };
}

/** Whether a worker chooses a case on the screen before Core lists it: a menu
 *  screen that chooses a case first, as the module screen reads it
 *  (`useModuleIds.ts::moduleScreenIsCaseFirst`). A bare case list chooses a
 *  case too, and lists nothing once one is chosen. */
function chosenFirst(doc: BlueprintDoc, screen: MenuScreen): boolean {
	return (
		screen.kind === "menu" &&
		(screenChoosesCaseFirst(doc, screen) || screenIsBareCaseList(doc, screen))
	);
}

/** The cases the worker's device holds: those of every case type a screen
 *  chooses first. */
function deviceCasesOf(doc: BlueprintDoc): DeviceCase[] {
	const types = new Set<string>();
	for (const moduleUuid of doc.moduleOrder) {
		const caseType = doc.modules[moduleUuid]?.caseType;
		if (
			caseType !== undefined &&
			moduleHasOwnScreen(doc, moduleUuid) &&
			chosenFirst(doc, ownScreen(moduleUuid))
		)
			types.add(caseType);
	}
	return [...types].flatMap((type) =>
		(CASE_VALUES[type] ?? [{}]).map((properties, index) => ({
			id: `${type}-case-${index + 1}`,
			type,
			properties,
		})),
	);
}

/** The readings of a screen: each role, and on a screen that chooses a case
 *  first, each case of its menu's type, chosen there. */
function readingsOf(
	doc: BlueprintDoc,
	screen: MenuScreen,
	cases: readonly DeviceCase[],
): Reading[] {
	if (screen.kind !== "menu" || !chosenFirst(doc, screen))
		return WORKER_ROLES.map((role) => ({ role }));
	const { moduleUuid } = screen;
	const caseType = doc.modules[moduleUuid]?.caseType;
	const chosen = cases.filter((held) => held.type === caseType);
	if (chosen.length === 0)
		throw new Error(
			`The device holds no case for the menu "${doc.modules[moduleUuid]?.name}" to choose first.`,
		);
	return WORKER_ROLES.flatMap((role) =>
		chosen.map((held) => ({ role, chosen: { moduleUuid, case: held } })),
	);
}

/** The device's cases as Preview reads them. */
function deviceSnapshot(
	doc: BlueprintDoc,
	cases: readonly DeviceCase[],
): NavigationDeviceCases {
	return {
		snapshot: {
			rows: cases.map(
				(held): CaseRow => ({
					case_id: held.id,
					app_id: doc.appId ?? "menu-screens-evidence",
					case_type: held.type,
					owner_id: "worker-id",
					status: "open",
					opened_on: null,
					modified_on: null,
					closed_on: null,
					case_name: held.id,
					external_id: null,
					parent_case_id: null,
					properties: { ...held.properties },
				}),
			),
			indices: [],
		},
		caseTypes: doc.caseTypes ?? [],
	};
}

/** The worker Core's session holds (`MenuScreensRuntimeTest.session`), with
 *  `role` among its data, under the slug each declared worker property has. */
function workerSession(
	doc: BlueprintDoc,
	role: string,
): PreviewSearchSessionValues {
	return {
		context: { userid: "worker-id", username: "worker" },
		user: { role },
		userPropertySlugs: Object.fromEntries(
			orderedUserProperties(doc).map((property) => [
				property.uuid,
				property.slug,
			]),
		),
	};
}

/** Each module's own visibility for a worker holding `role`. */
function ownVisibility(
	doc: BlueprintDoc,
	cases: readonly DeviceCase[],
	role: string,
) {
	return previewModuleOwnVisibility(doc, {
		authoring: false,
		session: workerSession(doc, role),
		lookup: { kind: "idle" },
		deviceCases: deviceSnapshot(doc, cases),
	});
}

/** A role list that leaves some menu's condition never holding would leave
 *  that condition's effect unread: refuse it by name. */
function assertEveryMenuConditionHolds(name: string, doc: BlueprintDoc): void {
	const cases = deviceCasesOf(doc);
	const holding = WORKER_ROLES.map((role) => ownVisibility(doc, cases, role));
	for (const moduleUuid of doc.moduleOrder) {
		const mod = doc.modules[moduleUuid];
		if (mod?.displayCondition === undefined || mod.hiddenFromMenu === true)
			continue;
		if (!holding.some((visibility) => visibility.get(moduleUuid) === "shown"))
			throw new Error(
				`The condition of "${mod.name}" in ${name} holds for no role of WORKER_ROLES; add the role it compares the worker's with.`,
			);
	}
}

function commandOf(
	ctx: FormLinkProjectionContext,
	entry: MenuScreenEntry,
): string {
	const index = moduleIndexOf(ctx, entry.moduleUuid);
	if (entry.kind === "form")
		return formCommandId(ctx, entry.moduleUuid, entry.formUuid);
	return entry.kind === "case-list" ? `m${index}-case-list` : `m${index}`;
}

/** What a screen is read over: the document, its projection, the device's
 *  cases and the screen. */
interface ScreenRead {
	readonly doc: BlueprintDoc;
	readonly ctx: FormLinkProjectionContext;
	readonly cases: readonly DeviceCase[];
	readonly screen: MenuScreen;
}

/** The commands a worker meets on a screen in a reading, in order, as
 *  Preview shows them (`ModuleScreen`, `HomeScreen`): a menu tile by its own
 *  condition, which is all Core reads when it lists that screen, a form or
 *  case list row by `previewScreenEntryVisibility` (the menus whose condition
 *  it carries, then a form's own, read over the chosen case), and a case list
 *  row only where `previewCaseListMenuEntry` lists it. */
function listedCommands(
	read: ScreenRead,
	entries: readonly MenuScreenEntry[],
	reading: Reading,
): string[] {
	const own = ownVisibility(read.doc, read.cases, reading.role);
	const shown = entryVisibility(read, entries, own, reading);
	return entries.flatMap((entry) => {
		if (!caseListRowListed(read, entry, reading)) return [];
		const visibility =
			entry.kind === "menu"
				? (own.get(entry.moduleUuid) ?? "shown")
				: shown.get(menuScreenEntryKey(entry));
		if (visibility === "pending" || visibility === undefined)
			throw new Error(
				`Preview cannot say whether ${commandOf(read.ctx, entry)} shows for this worker.`,
			);
		return visibility === "shown" ? [commandOf(read.ctx, entry)] : [];
	});
}

/** Whether Preview lists an entry at all where it is a case list row: the
 *  first menu lists one as a forms-first menu does, and a menu screen as its
 *  module screen does, by whether it chooses a case first and has one
 *  chosen. Any other entry is listed by its visibility alone. */
function caseListRowListed(
	read: ScreenRead,
	entry: MenuScreenEntry,
	reading: Reading,
): boolean {
	if (entry.kind !== "case-list") return true;
	const isCaseFirst =
		read.screen.kind === "menu" &&
		screenChoosesCaseFirst(read.doc, read.screen);
	return (
		previewCaseListMenuEntry(read.doc, entry.moduleUuid, {
			isCaseFirst,
			hasSelectedCase: reading.chosen !== undefined,
		}) !== undefined
	);
}

/** Each entry's visibility on a screen as Preview shows it in a reading,
 *  each module's own visibility read from `own`: a form's condition reads
 *  the case its menu has chosen, as the module screen hands it
 *  (`previewMenuCaseContext`, `navigationSelectedCase`). */
function entryVisibility(
	read: ScreenRead,
	entries: readonly MenuScreenEntry[],
	own: ReadonlyMap<Uuid, NavigationItemVisibility>,
	reading: Reading,
): ReadonlyMap<string, NavigationItemVisibility> {
	const { doc } = read;
	const chosen = reading.chosen;
	const selections =
		chosen === undefined
			? {}
			: {
					[chosen.moduleUuid]: {
						caseType: chosen.case.type,
						cases: [
							{
								caseId: chosen.case.id,
								caseName: chosen.case.id,
								caseProperties: chosen.case.properties,
							},
						],
					},
				};
	return previewScreenEntryVisibility({
		doc,
		entries,
		ownModuleVisibility: own,
		authoring: false,
		session: workerSession(doc, reading.role),
		lookup: { kind: "idle" },
		deviceCases: deviceSnapshot(doc, read.cases),
		selectedCaseOf: (entry) => {
			const cases = previewMenuCaseContext(
				{ ...doc, caseTypes: doc.caseTypes ?? [] },
				entry.moduleUuid,
				selections,
			).selectedCase?.cases;
			return cases?.length === 1
				? navigationSelectedCase(
						doc,
						entry.moduleUuid,
						entry.formUuid,
						cases[0].caseId,
					)
				: undefined;
		},
	});
}

/** The commands of a menu that shows its forms in its parent's menu that a
 *  worker does not meet in a reading only because the parent's own
 *  visibility hides them: Preview would show each were the menu read by its
 *  own condition alone. Core leaves each off the screen only where the menu's
 *  relevance carries its parent's condition (`conditionModulesOf`). */
function parentHiddenCommands(
	read: ScreenRead,
	entries: readonly MenuScreenEntry[],
	reading: Reading,
): string[] {
	const { doc } = read;
	const own = ownVisibility(doc, read.cases, reading.role);
	const shown = entryVisibility(read, entries, own, reading);
	return entries.flatMap((entry) => {
		const parent =
			entry.kind === "menu"
				? undefined
				: conditionModulesOf(doc, entry.moduleUuid)[1];
		if (
			parent === undefined ||
			own.get(parent) !== "hidden" ||
			!caseListRowListed(read, entry, reading)
		)
			return [];
		const key = menuScreenEntryKey(entry);
		const alone = entryVisibility(
			read,
			[entry],
			new Map([...own, [parent, "shown"]]),
			reading,
		);
		return shown.get(key) === "hidden" && alone.get(key) === "shown"
			? [commandOf(read.ctx, entry)]
			: [];
	});
}

/** A menu that shows its forms in a parent's menu, both carrying a
 *  condition, is read through the conjunction of the two. A document whose
 *  readings never show one of its rows with both conditions holding, and
 *  never hide one by the parent's condition alone, would leave that
 *  conjunction's effect unread: refuse it by name. */
function assertEveryConjunctionIsRead(
	name: string,
	doc: BlueprintDoc,
	ctx: FormLinkProjectionContext,
): void {
	const cases = deviceCasesOf(doc);
	for (const moduleUuid of doc.moduleOrder) {
		const [, parentUuid] = conditionModulesOf(doc, moduleUuid);
		const mod = doc.modules[moduleUuid];
		const parent =
			parentUuid === undefined ? undefined : doc.modules[parentUuid];
		if (
			mod?.displayCondition === undefined ||
			parent?.displayCondition === undefined ||
			mod.hiddenFromMenu === true ||
			parent.hiddenFromMenu === true
		)
			continue;
		const screen = menuScreenOf(doc, moduleUuid);
		const read = { doc, ctx, cases, screen };
		const entries = menuScreenEntries(doc, screen).filter(
			(entry) => entry.kind !== "menu" && entry.moduleUuid === moduleUuid,
		);
		const readings = readingsOf(doc, screen, cases);
		if (
			!readings.some(
				(reading) => listedCommands(read, entries, reading).length > 0,
			) ||
			!readings.some(
				(reading) => parentHiddenCommands(read, entries, reading).length > 0,
			)
		)
			throw new Error(
				`No reading both sees a row of "${mod.name}" in ${name} and loses one to the condition of "${parent.name}" alone; give the menu a row its conditions alone decide, and conditions some role holds together and some role holds only the menu's.`,
			);
	}
}

/** A form's display condition on a screen that chooses a case first reads
 *  the chosen case. Where its menus show it in some reading, a document whose
 *  device cases never both show and hide it there would leave that
 *  condition's effect unread: refuse it by name. */
function assertEveryCaseConditionIsRead(
	name: string,
	doc: BlueprintDoc,
	ctx: FormLinkProjectionContext,
	screen: MenuScreen,
): void {
	if (screen.kind !== "menu" || !chosenFirst(doc, screen)) return;
	const cases = deviceCasesOf(doc);
	const read = { doc, ctx, cases, screen };
	const entries = menuScreenEntries(doc, screen);
	for (const entry of entries) {
		if (
			entry.kind !== "form" ||
			doc.forms[entry.formUuid]?.displayCondition === undefined
		)
			continue;
		const seen = new Set<NavigationItemVisibility | undefined>();
		for (const reading of readingsOf(doc, screen, cases)) {
			const own = ownVisibility(doc, cases, reading.role);
			if (previewContributorVisibility(doc, own, entry.moduleUuid) !== "shown")
				continue;
			seen.add(
				entryVisibility(read, [entry], own, reading).get(
					menuScreenEntryKey(entry),
				),
			);
		}
		if (!seen.has("shown") || !seen.has("hidden"))
			throw new Error(
				`The condition of "${doc.forms[entry.formUuid]?.name}" in ${name} is never both met and not by a case the device holds; give CASE_VALUES a case of each.`,
			);
	}
}

/** The command a frame's landing leaves Core's session on: the form command
 *  where the frame names a form, else the menu of its screen, or none on the
 *  first menu, which Core reaches with no command. */
function commandOfLanding(
	doc: BlueprintDoc,
	ctx: FormLinkProjectionContext,
	landing: FrameLanding,
): string | null {
	if (landing.formUuid !== undefined) {
		const moduleUuid = moduleUuidOfForm(doc, landing.formUuid);
		if (moduleUuid === undefined)
			throw new Error("A frame lands on a form in no menu.");
		return formCommandId(ctx, moduleUuid, landing.formUuid);
	}
	return landing.screen.kind === "first-menu"
		? null
		: `m${moduleIndexOf(ctx, landing.screen.moduleUuid)}`;
}

/** Where Preview lands a form after submit, read from the frame its
 *  after-submit destination writes (`screenOfFrame`): `previous` the source
 *  entry's frame less its last child, `module` the menu's frame, `parentMenu`
 *  its parent's, and Home and the first menu the empty frame. A form with
 *  destinations of its own is left out: its frames are the form-link
 *  proofs'. */
function formLanding(
	doc: BlueprintDoc,
	ctx: FormLinkProjectionContext,
	moduleUuid: Uuid,
	formUuid: Uuid,
): FrameLanding | undefined {
	if (doc.forms[formUuid]?.formLinks !== undefined) return undefined;
	const destination = effectivePostSubmit(doc, formUuid);
	if (destination === "previous")
		return screenOfFrame(
			ctx,
			previousEntryFrameChildren(doc, ctx, moduleUuid, formUuid),
		);
	if (destination === "module")
		return screenOfFrame(ctx, moduleFrameChildren(doc, ctx, moduleUuid));
	const parent = doc.modules[moduleUuid]?.parentModuleUuid;
	if (destination === "parentMenu" && parent !== undefined)
		return screenOfFrame(ctx, moduleFrameChildren(doc, ctx, parent));
	return screenOfFrame(ctx, []);
}

function screensOf(
	doc: BlueprintDoc,
	ctx: FormLinkProjectionContext,
	cases: readonly DeviceCase[],
) {
	const screens: MenuScreen[] = [
		{ kind: "first-menu" },
		...ctx.moduleOrder
			.filter((moduleUuid) => moduleHasOwnScreen(doc, moduleUuid))
			.map((moduleUuid) => ({ kind: "menu" as const, moduleUuid })),
	];
	return screens.map((screen) => {
		const entries = menuScreenEntries(doc, screen);
		const read = { doc, ctx, cases, screen };
		return {
			menuId:
				screen.kind === "first-menu"
					? "root"
					: `m${moduleIndexOf(ctx, screen.moduleUuid)}`,
			asksCaseFirst: chosenFirst(doc, screen),
			listings: readingsOf(doc, screen, cases).map((reading) => ({
				role: reading.role,
				caseId: reading.chosen?.case.id ?? null,
				commands: listedCommands(read, entries, reading),
				parentHides: parentHiddenCommands(read, entries, reading),
			})),
			entries: entries.map((entry) => {
				const mod = doc.modules[entry.moduleUuid];
				const landing =
					entry.kind === "form"
						? formLanding(doc, ctx, entry.moduleUuid, entry.formUuid)
						: undefined;
				return {
					command: commandOf(ctx, entry),
					kind: entry.kind,
					readsSearch: mod !== undefined && moduleFormsReadSearch(mod),
					...(landing !== undefined && {
						landsOn: commandOfLanding(doc, ctx, landing),
					}),
				};
			}),
		};
	});
}

function offersOf(doc: BlueprintDoc, ctx: FormLinkProjectionContext) {
	return ctx.moduleOrder.flatMap((host) => {
		const slot = alwaysOfferedRegistrationOf(doc, host);
		const formModule =
			slot === undefined ? undefined : moduleUuidOfForm(doc, slot.formUuid);
		const returnTo = caseListRegistrationReturnOf(doc, host);
		if (
			slot === undefined ||
			formModule === undefined ||
			returnTo === undefined
		)
			return [];
		/* Where Preview lands the worker, a case created or not: the return
		 * frame whose guard holds, or, where the form's own after-submit is
		 * in force, that after-submit's frame. */
		const landed = (created: boolean) => {
			const landing = alwaysOfferedRegistrationReturn(
				doc,
				slot.formUuid,
				{ hostModuleUuid: host },
				created ? "registered-case" : undefined,
			);
			if (landing !== undefined)
				return {
					command: commandOfLanding(doc, ctx, landing),
					selectsHost: landing.selectingModuleUuids.includes(host),
				};
			const own = formLanding(doc, ctx, formModule, slot.formUuid);
			if (returnTo.kind !== "own" || own === undefined)
				throw new Error(
					`Preview gives no landing for "${doc.forms[slot.formUuid]?.name}" registered from "${doc.modules[host]?.name}".`,
				);
			return { command: commandOfLanding(doc, ctx, own) };
		};
		return [
			{
				hostMenuId: `m${moduleIndexOf(ctx, host)}`,
				hostIsBareCaseList: screenIsBareCaseList(doc, menuScreenOf(doc, host)),
				formCommand: formCommandId(ctx, formModule, slot.formUuid),
				afterSubmit: slot.afterSubmit,
				returnTo: returnTo.kind,
				created: landed(true),
				notCreated: landed(false),
			},
		];
	});
}

function write(name: string, doc: BlueprintDoc, withScreens: boolean): void {
	const hq = expandDoc(doc);
	const zip = new AdmZip(
		compileCcz(hq, doc.appName, doc, { runtimeTarget: MENU_SCREENS_TARGET }),
	);
	writeFileSync(resolve(output, `${name}.json`), JSON.stringify(hq));
	writeFileSync(
		resolve(output, `${name}.suite.xml`),
		zip.readAsText("suite.xml"),
	);
	const ctx = formLinkProjectionContext(doc);
	if (withScreens) {
		assertEveryMenuConditionHolds(name, doc);
		assertEveryConjunctionIsRead(name, doc, ctx);
		for (const moduleUuid of ctx.moduleOrder)
			if (moduleHasOwnScreen(doc, moduleUuid))
				assertEveryCaseConditionIsRead(name, doc, ctx, ownScreen(moduleUuid));
		const cases = deviceCasesOf(doc);
		writeFileSync(
			resolve(output, `${name}.screens.json`),
			JSON.stringify({
				deviceCases: cases,
				screens: screensOf(doc, ctx, cases),
			}),
		);
	}
	const offers = offersOf(doc, ctx);
	if (offers.length > 0)
		writeFileSync(
			resolve(output, `${name}.offers.json`),
			JSON.stringify({ offers }),
		);
}

/**
 * The document with each case list's other `afterSubmit`, wherever Nova's
 * gate admits it, as the builder's switch writes it
 * (`alwaysOfferedRegistrationMutations`), so every host shape runs under
 * both values the rules admit for it. Throws where no host takes the other
 * value.
 */
function otherReturns(
	name: string,
	doc: BlueprintDoc,
	lookup: Parameters<typeof lookupContextOf>[0],
): BlueprintDoc {
	const context = lookupContextOf(lookup);
	const mutations: Mutation[] = [];
	for (const host of doc.moduleOrder) {
		const slot = alwaysOfferedRegistrationOf(doc, host);
		if (slot === undefined) continue;
		const plan = alwaysOfferedRegistrationMutations(doc, host, {
			...slot,
			afterSubmit: slot.afterSubmit === "case-list" ? "new-case" : "case-list",
		});
		if (plan.kind !== "planned") continue;
		if (mutationCommitVerdict(doc, plan.mutations, context).ok)
			mutations.push(...plan.mutations);
	}
	if (mutations.length === 0)
		throw new Error(`No case list of ${name} takes its other afterSubmit.`);
	const verdict = mutationCommitVerdict(doc, mutations, context);
	if (!verdict.ok)
		throw new Error(
			`Nova's commit gate refused ${name} with every other afterSubmit (${verdict.findings
				.map((finding) => finding.code)
				.join(", ")}).`,
		);
	return verdict.nextDoc;
}

for (const [name, make] of [
	["forms-in-menu-above", formsInMenuAbove],
	["forms-in-menu-above-nested", formsInMenuAboveNested],
	["forms-in-menu-above-registration-only", formsInMenuAboveRegistrationOnly],
	["forms-in-menu-above-one-case", formsInMenuAboveOneCase],
	["register-from-case-list", registerFromCaseList],
	["register-from-case-list-web-apps", registerFromCaseListWebApps],
] as const) {
	const document = make();
	const doc = hydratePersistedBlueprint(document.doc);
	write(name, doc, true);
	if (name.startsWith("register-from-case-list"))
		write(
			`${name}-other-returns`,
			otherReturns(name, doc, document.lookup),
			true,
		);
}

/** The step-back control: built past the gate, which refuses its link
 *  (`FORM_LINK_TARGET_SHARES_FIRST_MENU_CASE`). */
function stepBackControl(): BlueprintDoc {
	const followUp = (uuid: string, name: string, extra: object = {}) => ({
		uuid,
		name,
		type: "followup" as const,
		...extra,
		fields: [f({ kind: "text", id: "note", label: proseText("Note") })],
	});
	const list = () => caseListConfig([{ field: "case_name", header: "Name" }]);
	const doc = buildDoc({
		appName: "Step back control",
		caseTypes: [
			{ name: "alpha", properties: [] },
			{ name: "beta", properties: [] },
		],
		modules: [
			{
				uuid: "step-alpha-above",
				name: "Alpha above",
				caseType: "alpha",
				caseListConfig: list(),
				forms: [followUp("step-alpha-above-form", "Alpha check")],
			},
			{
				uuid: "step-beta-above",
				name: "Beta above",
				caseType: "beta",
				caseListConfig: list(),
				forms: [followUp("step-beta-above-form", "Beta check")],
			},
			{
				uuid: "step-alpha",
				name: "Alpha",
				caseType: "alpha",
				caseListConfig: list(),
				forms: [
					followUp("step-alpha-form", "Alpha visit", {
						formLinks: [
							{
								target: {
									type: "form",
									moduleUuid: testUuid("step-alpha-above"),
									formUuid: testUuid("step-alpha-above-form"),
								},
							},
						],
					}),
				],
			},
			{
				uuid: "step-beta",
				name: "Beta",
				caseType: "beta",
				caseListConfig: list(),
				forms: [followUp("step-beta-form", "Beta visit")],
			},
		],
	});
	doc.modules[testUuid("step-alpha-above")].formsInMenuAbove = true;
	doc.modules[testUuid("step-beta-above")].formsInMenuAbove = true;
	return doc;
}

/** The two-registrations control: built past the gate, which refuses the
 *  offer (`CASE_LIST_REGISTRATION_NOT_REGISTRATION`, reason
 *  `several-registrations`). */
function twoRegistrationsControl(): BlueprintDoc {
	const list = () => caseListConfig([{ field: "case_name", header: "Name" }]);
	const name = testUuid("two-registrations-name");
	const doc = buildDoc({
		appName: "Two registrations control",
		caseTypes: [{ name: "patient", properties: [] }],
		modules: [
			{
				uuid: "two-registrations-host",
				name: "Patients",
				caseType: "patient",
				caseListConfig: list(),
				forms: [
					{
						name: "Visit",
						type: "followup",
						fields: [f({ kind: "text", id: "note", label: proseText("Note") })],
					},
				],
			},
			{
				uuid: "two-registrations-menu",
				name: "Registration",
				caseType: "patient",
				caseListConfig: list(),
				forms: [
					{
						uuid: "two-registrations-form",
						name: "Register patient",
						type: "registration",
						fields: [
							f({
								uuid: "two-registrations-name",
								kind: "text",
								id: "case_name",
								label: proseText("Name"),
								caseWrite: { caseType: "patient", property: "case_name" },
							}),
						],
					},
				],
			},
		],
	});
	const formUuid = testUuid("two-registrations-form");
	const form = doc.forms[formUuid];
	const own = form.caseOperations?.[0];
	if (own?.action !== "own")
		throw new Error("The registration form has its own case first.");
	const second = {
		uuid: testUuid("two-registrations-second"),
		id: "second_patient",
		action: "create",
		caseType: "patient",
		target: { kind: "new" },
		name: term(formField(name)),
		links: [
			{
				identifier: "parent",
				targetType: "patient",
				target: { kind: "op", opUuid: own.uuid },
				relationship: "child",
			},
		],
	} as CaseOperation;
	doc.forms[formUuid] = {
		...form,
		caseOperations: [...(form.caseOperations ?? []), second],
	};
	doc.modules[testUuid("two-registrations-host")].caseListRegistrationForm = {
		kind: "always",
		formUuid,
		afterSubmit: "case-list",
	};
	return doc;
}

write("step-back-control", stepBackControl(), false);
write("two-registrations-control", twoRegistrationsControl(), false);
