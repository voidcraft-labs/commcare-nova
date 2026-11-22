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
 * `menu-landings` is built here and admitted by Nova's gate: a case-first
 * menu with a submenu, a case list menu with a submenu, a case-first menu of
 * one form, and three advanced menus whose entries ask for the datum each
 * load's tag names: a case list entry beside forms loaded under another tag,
 * two forms a published app keeps under two tags, and two forms kept under
 * the case list entry's own tag; and an advanced menu whose basic submenus'
 * entries align with its form. Every screen of every document also writes
 * where Preview opens it (`landsOnCaseList`) and, for each case-loading form
 * on it, where one step back from the form lands and what its case list
 * continues into once the worker steps back to it and chooses a case again
 * (`stepBacks`).
 *
 * `pinned-tile` is built here and admitted by Nova's gate: two lists that
 * keep their tile on screen, one a parent-select chain's parent and one its
 * child, a parent-select chain whose parent's list does not keep it, and a
 * same-type submenu under each kind of list. It writes `<name>.tiles.json`:
 * walks through Core's session, each step a command or a case chosen, and on
 * the screen each step reaches the case and detail Preview pins
 * (`pinnedCaseTile.ts::previewPinnedCaseTile` over the held cases each screen
 * hands it), and, on a list's own details, what Android's details draw.
 *
 * Four documents are read for a list of workers' data rather than roles, each
 * listing a screen as refused where a condition it reads asks for a user field
 * the worker's device lacks: `worker-place-read`, a menu whose condition reads
 * the worker's place, which a worker assigned nowhere lacks;
 * `worker-place-forms`, a case-first menu's form whose condition reads it,
 * which Core reads once the case is chosen; `worker-place-menus`, a form shown
 * on the first menu, a submenu's form shown in its parent's screen and a
 * submenu's tile, each under such a condition; and
 * `undeclared-worker-field-control`, built past the gate, a menu whose
 * condition reads a field the app never declares.
 *
 * The two other refused documents: `step-back-control`, two top-level menus above
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
import { twoMenus } from "../../../lib/commcare/__tests__/menuFormRoutesFixture";
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
	CASE_LOADING_FORM_TYPES,
	type CaseOperation,
	caseListRegistrationReturnOf,
	conditionModulesOf,
	effectivePostSubmit,
	type MenuScreen,
	type MenuScreenEntry,
	menuFormUuidsOf,
	menuScreenEntries,
	menuScreenOf,
	moduleFormsReadSearch,
	moduleHasOwnScreen,
	moduleLanding,
	moduleUuidOfForm,
	orderedUserProperties,
	plainColumn,
	proseText,
	screenChoosesCaseFirst,
	screenIsBareCaseList,
	simpleSearchInputDef,
	tileCell,
	type Uuid,
} from "../../../lib/domain";
import {
	eq,
	formField,
	literal,
	sessionUser,
	term,
} from "../../../lib/domain/expression";
import { alwaysOfferedRegistrationReturn } from "../../../lib/preview/engine/caseListRegisterAction";
import { previewDataRefusalOf } from "../../../lib/preview/engine/dataRefusal";
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
	previewLeafAsksParentCase,
	previewParentCaseBeforeMenu,
	previewParentCaseListHasDetails,
} from "../../../lib/preview/engine/parentCaseSelection";
import {
	menuScreenEntryKey,
	moduleHasChildren,
	type PreviewHeldCaseSelection,
	previewCaseFirstModuleUuids,
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
	previewModuleOwnVisibility,
	previewModuleScreenIsBareCaseList,
	previewRequestedForm,
	previewScreenEntryVisibility,
	previewSelectionsBefore,
} from "../../../lib/preview/menuProjection";
import {
	type PinnedTileSurface,
	type PreviewViewedCase,
	previewPinnedCaseTile,
} from "../../../lib/preview/pinnedCaseTile";
import { previewPlatformRules } from "../../../lib/preview/platform";
import type { PreviewMenuCaseSelection } from "../../../lib/session/types";
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
		"Usage: node --conditions=react-server --import tsx proof/native/producers/emit-menu-screens-evidence.ts OUTPUT_DIRECTORY",
	);
mkdirSync(output, { recursive: true });

/**
 * The worker roles each screen is listed for: blank, and each value of the
 * worker's `role` a display condition of the targeted documents compares
 * with, so every condition is read both holding and not
 * (`assertEveryMenuConditionHolds`), and a submenu's condition joined with its
 * parent's is read both holding and failing on the parent's side alone
 * (`assertEveryConjunctionIsRead`). The documents that compare it declare
 * `role` as a worker property, which the setup list a publish shows names for
 * someone to add on CommCare HQ (`lib/deployment/setupArtifact.ts`, worker
 * information), and a worker
 * the project space holds no value for has it blank: HQ's restore gives every
 * worker each user field the project space defines, `''` where none is set
 * (`user_data.py::UserData.to_dict`), as Preview reads a declared property.
 */
const WORKER_ROLES = ["", "registrar", "visitor", "checker"] as const;

/** The worker data Core's session holds for one reading: the key and value of
 *  each user field the worker's device holds (`MenuScreensRuntimeTest.session`
 *  sets each). */
type WorkerData = Readonly<Record<string, string>>;

/** A worker holding each role of `WORKER_ROLES`. */
const ROLE_WORKERS: readonly WorkerData[] = WORKER_ROLES.map((role) => ({
	role,
}));

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

/** One reading of a screen: the worker's data and, on a screen that chooses
 *  a case first, the case chosen there and the menu that chose it. */
interface Reading {
	readonly user: WorkerData;
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

/** The readings of a screen: each worker, and on a screen that chooses a case
 *  first, each case of its menu's type, chosen there. */
function readingsOf(
	doc: BlueprintDoc,
	screen: MenuScreen,
	cases: readonly DeviceCase[],
	workers: readonly WorkerData[] = ROLE_WORKERS,
): Reading[] {
	if (screen.kind !== "menu" || !chosenFirst(doc, screen))
		return workers.map((user) => ({ user }));
	const { moduleUuid } = screen;
	const caseType = doc.modules[moduleUuid]?.caseType;
	const chosen = cases.filter((held) => held.type === caseType);
	if (chosen.length === 0)
		throw new Error(
			`The device holds no case for the menu "${doc.modules[moduleUuid]?.name}" to choose first.`,
		);
	return workers.flatMap((user) =>
		chosen.map((held) => ({ user, chosen: { moduleUuid, case: held } })),
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
 *  `user` as its data, under the slug each declared worker property has. */
function workerSession(
	doc: BlueprintDoc,
	user: WorkerData,
): PreviewSearchSessionValues {
	return {
		context: { userid: "worker-id", username: "worker" },
		user: { ...user },
		userPropertySlugs: Object.fromEntries(
			orderedUserProperties(doc).map((property) => [
				property.uuid,
				property.slug,
			]),
		),
	};
}

/** Each module's own visibility for a worker holding `user`, each read when
 *  a screen asks for it (`menuProjection.ts::previewModuleOwnVisibility`). */
function ownVisibility(
	doc: BlueprintDoc,
	cases: readonly DeviceCase[],
	user: WorkerData,
) {
	return previewModuleOwnVisibility(doc, {
		authoring: false,
		session: workerSession(doc, user),
		lookup: { kind: "idle" },
		deviceCases: deviceSnapshot(doc, cases),
	});
}

/** A role list that leaves some menu's condition never holding would leave
 *  that condition's effect unread: refuse it by name. */
function assertEveryMenuConditionHolds(name: string, doc: BlueprintDoc): void {
	const cases = deviceCasesOf(doc);
	const holding = ROLE_WORKERS.map((user) => ownVisibility(doc, cases, user));
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

/** `own` with one module read as shown, every other module read from `own`
 *  only when asked, as a screen asks. */
function withModuleShown(
	own: ReadonlyMap<Uuid, NavigationItemVisibility>,
	shownUuid: Uuid,
): ReadonlyMap<Uuid, NavigationItemVisibility> {
	return new Proxy(own, {
		get(target, key) {
			if (key === "get")
				return (uuid: Uuid) =>
					uuid === shownUuid ? "shown" : target.get(uuid);
			const value: unknown = Reflect.get(target, key, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
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
	const own = ownVisibility(read.doc, read.cases, reading.user);
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
 *  chosen, and whether the entry still needs a case past the ones chosen
 *  (`previewCaseListMenuEntry`). Any other entry is listed by its
 *  visibility alone. */
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
		session: workerSession(doc, reading.user),
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
	const own = ownVisibility(doc, read.cases, reading.user);
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
			withModuleShown(own, parent),
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
			const own = ownVisibility(doc, cases, reading.user);
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

/** What Preview shows a worker on a screen in a reading: the commands it
 *  lists and those a parent's condition alone takes off it, or, where a
 *  condition the screen reads refuses data the device lacks
 *  (`engine/dataRefusal.ts::previewDataRefusalOf`), the refusal that stands in
 *  for the whole screen, as Core's `MenuLoader` lists nothing there and holds
 *  its load exception. */
function listingOf(
	read: ScreenRead,
	entries: readonly MenuScreenEntry[],
	reading: Reading,
) {
	try {
		return {
			refused: false,
			commands: listedCommands(read, entries, reading),
			parentHides: parentHiddenCommands(read, entries, reading),
		};
	} catch (error) {
		if (previewDataRefusalOf(error) === undefined) throw error;
		return { refused: true, commands: [], parentHides: [] };
	}
}

/**
 * Whether Preview opens a menu's screen on a case list when a worker chooses
 * the menu: the parent's list where the menu asks for its parent case before
 * it lists its screen (`parentCaseSelection.ts::previewParentCaseBeforeMenu`,
 * which `moduleScreenNavigation.ts::choosePreviewMenuTile` reads), else the
 * landing the home screen's tile takes (`navigation.ts::moduleLanding`, over
 * the menu's own screen, its submenus included), a menu that lists its forms
 * first listing them though one asks for a parent case after its command.
 * The first menu is reached with no command.
 */
function landsOnCaseList(doc: BlueprintDoc, screen: MenuScreen): boolean {
	if (screen.kind !== "menu") return false;
	const { moduleUuid } = screen;
	if (
		previewMenuCaseContext(
			{ ...doc, caseTypes: doc.caseTypes ?? [] },
			moduleUuid,
			{},
		).requiredParentCase !== undefined &&
		previewParentCaseBeforeMenu(doc, moduleUuid)
	)
		return true;
	return (
		moduleLanding({
			isCaseFirst: previewCaseFirstModuleUuids(doc).has(moduleUuid),
			isBareCaseList: previewModuleScreenIsBareCaseList(doc, moduleUuid),
			hasChildren: moduleHasChildren(doc, moduleUuid),
		}) === "case-list"
	);
}

/** How many step backs, over every document, are read on a screen that
 *  chooses its case first and then lists exactly one form: the shape where
 *  Preview once opened that form by itself. */
let loneFormStepBacks = 0;

/**
 * For each case-loading form a worker can choose on the screen, where Preview
 * lands once the worker steps back off the form, and what the case list
 * continues into once the worker steps back to it and chooses a case again,
 * as Preview decides it. The worker chooses the form as the screen offers
 * it: from the menu after the case on a screen that chooses its case first
 * (the mark `CaseListScreen` writes, `previewCaseListMenuChoice`, where
 * choosing the case went on into the list's own form menu,
 * `previewCaseListContinuation`, and otherwise the one `ModuleScreen` writes,
 * `previewMenuScreenChoice`, over the selection the list wrote), before any
 * case otherwise.
 *
 * `oneStepBack` is the screen one Back lands on: `menu`, the screen's menu
 * with the case held, where the form was chosen after its case, else
 * `case-list`, where the list holds the form. It follows from where the
 * screen model has the form chosen (`asksCaseFirst`, from
 * `screenChoosesCaseFirst`): the held menu handed to
 * `previewCaseListHeldChoices` and the selection handed to
 * `previewMenuScreenLanding` are this producer's own, written exactly where
 * the form is chosen after its case, so both give back what they were given.
 * `MenuScreensRuntimeTest` therefore holds Core's `stepBack` to the screen
 * model; that Preview's screens hold the menu and the selection
 * (`CaseListScreen`'s `holdFormMenu`, `ModuleScreen`'s selection) is held by
 * the browser journeys (`e2e/tests/app/preview-form-refused.spec.ts`,
 * `preview-menu-held-case.spec.ts`). `afterStepBack` is the form's command where the list a route back
 * reaches (`previewCaseListReturn`) opens the form once a case is chosen
 * (`previewCaseListFormRequest`, then `previewRequestedForm`), or null where
 * it lists the menu. A form whose menu reads the
 * search is left out: its search step is no case list a worker steps back
 * to. `MenuScreensRuntimeTest` replays the same path in Core and steps back
 * with `CommCareSession.stepBack`.
 */
function stepBacksOf(
	read: ScreenRead,
	entries: readonly MenuScreenEntry[],
	readings: readonly Reading[],
	asksCaseFirst: boolean,
) {
	const { doc, ctx, screen } = read;
	return entries.flatMap((entry) => {
		if (entry.kind !== "form") return [];
		const mod = doc.modules[entry.moduleUuid];
		const type = doc.forms[entry.formUuid]?.type;
		if (
			mod?.caseType === undefined ||
			type === undefined ||
			!CASE_LOADING_FORM_TYPES.has(type) ||
			moduleFormsReadSearch(mod)
		)
			return [];
		for (const reading of readings) {
			if (asksCaseFirst !== (reading.chosen !== undefined)) continue;
			let shown: ReadonlyMap<string, NavigationItemVisibility>;
			try {
				shown = entryVisibility(
					read,
					entries,
					ownVisibility(doc, read.cases, reading.user),
					reading,
				);
			} catch (error) {
				if (previewDataRefusalOf(error) === undefined) throw error;
				continue;
			}
			const forms = entries.flatMap((candidate) =>
				candidate.kind === "form"
					? [
							{
								entry: candidate,
								form: { uuid: candidate.formUuid },
								visibility:
									shown.get(menuScreenEntryKey(candidate)) ?? "hidden",
							},
						]
					: [],
			);
			if (
				forms.find((form) => form.form.uuid === entry.formUuid)?.visibility !==
				"shown"
			)
				continue;
			if (
				asksCaseFirst &&
				forms.filter((form) => form.visibility === "shown").length === 1
			)
				loneFormStepBacks++;
			const caseLoadingOf = (moduleUuid: Uuid) =>
				menuFormUuidsOf(doc, moduleUuid).filter((uuid) => {
					const formType = doc.forms[uuid]?.type;
					return (
						formType !== undefined && CASE_LOADING_FORM_TYPES.has(formType)
					);
				});
			const caseId = reading.chosen?.case.id ?? "case-one";
			const cases = [{ caseId }];
			/* What Preview holds once the worker has chosen the form: a form
			 * chosen before any case is the list's held form; one chosen after
			 * the case carries the mark the screen that listed it writes, the
			 * list's own form menu where choosing the case went on into it
			 * (`CaseListScreen`), else the menu screen that holds the case in
			 * the selection the list wrote for it (`ModuleScreen`). */
			const listModuleUuid =
				screen.kind === "menu" ? screen.moduleUuid : entry.moduleUuid;
			const source = { ...doc, doc, caseTypes: doc.caseTypes ?? [] };
			const listsOwnFormMenu =
				previewCaseListContinuation(doc, listModuleUuid) === "form-menu";
			const selections =
				reading.chosen === undefined || listsOwnFormMenu
					? {}
					: {
							[listModuleUuid]: {
								caseType: reading.chosen.case.type,
								cases,
							},
						};
			const chosen =
				reading.chosen === undefined
					? { formUuid: entry.formUuid, cases }
					: {
							formUuid: entry.formUuid,
							cases,
							formChosenAfterCase: listsOwnFormMenu
								? previewCaseListMenuChoice(listModuleUuid)
								: previewMenuScreenChoice(source, entry.moduleUuid, selections),
						};
			/* One step back: the list's history entry the form was opened from,
			 * where choosing the case on the list held its form menu
			 * (`CaseListScreen`'s `holdFormMenu`), shows that menu for the held
			 * case (`previewCaseListHeldChoices`), or the menu screen lands on
			 * its menu for the case its selection holds
			 * (`previewMenuScreenLanding`). */
			const heldOnList = previewCaseListHeldChoices(
				reading.chosen !== undefined && listsOwnFormMenu
					? { moduleUuid: listModuleUuid, cases }
					: undefined,
				{
					moduleUuid: listModuleUuid,
					continuation: previewCaseListContinuation(doc, listModuleUuid),
				},
			);
			const menuHoldsCase =
				reading.chosen !== undefined &&
				!listsOwnFormMenu &&
				previewMenuScreenLanding(source, listModuleUuid, selections, {
					mode: "preview",
				}).kind === "form-menu";
			const back = previewCaseListReturn(chosen, {
				moduleUuid: entry.moduleUuid,
				formUuid: entry.formUuid,
			});
			const opened = previewRequestedForm(
				caseLoadingOf(back.moduleUuid),
				previewCaseListFormRequest(back.target, caseLoadingOf(back.moduleUuid)),
			);
			return [
				{
					command: formCommandId(ctx, entry.moduleUuid, entry.formUuid),
					caseId,
					oneStepBack:
						heldOnList !== undefined || menuHoldsCase ? "menu" : "case-list",
					afterStepBack:
						opened === undefined
							? null
							: formCommandId(ctx, back.moduleUuid, opened),
				},
			];
		}
		return [];
	});
}

function screensOf(
	doc: BlueprintDoc,
	ctx: FormLinkProjectionContext,
	cases: readonly DeviceCase[],
	workers: readonly WorkerData[],
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
		const asksCaseFirst = chosenFirst(doc, screen);
		const readings = readingsOf(doc, screen, cases, workers);
		return {
			menuId:
				screen.kind === "first-menu"
					? "root"
					: `m${moduleIndexOf(ctx, screen.moduleUuid)}`,
			asksCaseFirst,
			landsOnCaseList: landsOnCaseList(doc, screen),
			listings: readings.map((reading) => ({
				user: reading.user,
				caseId: reading.chosen?.case.id ?? null,
				...listingOf(read, entries, reading),
			})),
			stepBacks: stepBacksOf(read, entries, readings, asksCaseFirst),
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

/** How a document is read: each screen for a worker holding each role
 *  (`roles`), each screen for each worker of a list (`workers`), or not at
 *  all (`none`, the step-back and two-registrations controls). */
type Readings =
	| { readonly kind: "roles" }
	| { readonly kind: "workers"; readonly workers: readonly WorkerData[] }
	| { readonly kind: "none" };

const ROLES: Readings = { kind: "roles" };
const NONE: Readings = { kind: "none" };

/** A document read for a list of workers witnesses a refusal: some screen
 *  must refuse for some worker and list for another, or the list leaves the
 *  refusal, or its absence, unread. */
function assertEveryScreenIsReadBothWays(
	name: string,
	screens: readonly {
		readonly menuId: string;
		readonly listings: readonly { readonly refused: boolean }[];
	}[],
): void {
	const read = screens.some(
		(screen) =>
			screen.listings.some((listing) => listing.refused) &&
			screen.listings.some((listing) => !listing.refused),
	);
	if (!read)
		throw new Error(
			`No screen of ${name} both refuses for one worker and lists for another; give the worker list a worker who lacks the field and one who holds it.`,
		);
}

function write(name: string, doc: BlueprintDoc, readings: Readings): void {
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
	if (readings.kind === "roles") {
		assertEveryMenuConditionHolds(name, doc);
		assertEveryConjunctionIsRead(name, doc, ctx);
		for (const moduleUuid of ctx.moduleOrder)
			if (moduleHasOwnScreen(doc, moduleUuid))
				assertEveryCaseConditionIsRead(name, doc, ctx, ownScreen(moduleUuid));
	}
	if (readings.kind !== "none") {
		const cases = deviceCasesOf(doc);
		const screens = screensOf(
			doc,
			ctx,
			cases,
			readings.kind === "workers" ? readings.workers : ROLE_WORKERS,
		);
		if (readings.kind === "workers")
			assertEveryScreenIsReadBothWays(name, screens);
		writeFileSync(
			resolve(output, `${name}.screens.json`),
			JSON.stringify({ deviceCases: cases, screens }),
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
	write(name, doc, ROLES);
	if (name.startsWith("register-from-case-list"))
		write(
			`${name}-other-returns`,
			otherReturns(name, doc, document.lookup),
			ROLES,
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

/** The first menu lists a case-loading form directly. Previous ends at a
 * commandless frame; the ordinary menu's follow-up consumes the same datum. */
function previousOnFirstMenu(): BlueprintDoc {
	const doc = buildDoc({
		appName: "Return to visits",
		caseTypes: [{ name: "patient", properties: [] }],
		modules: ["Daily visits", "Reviews"].map((name, i) => ({
			uuid: `first-menu-previous-menu-${i}`,
			name,
			caseType: "patient",
			caseListConfig: caseListConfig([{ field: "case_name", header: "Name" }]),
			forms: [
				{
					uuid: `first-menu-previous-form-${i}`,
					name: i === 0 ? "Visit patient" : "Review visit",
					type: "followup",
					fields: [f({ kind: "text", id: "note", label: proseText("Note") })],
				},
			],
		})),
	});
	doc.modules[testUuid("first-menu-previous-menu-0")].formsInMenuAbove = true;
	doc.forms[testUuid("first-menu-previous-form-0")].postSubmit = "previous";
	return doc;
}
write("first-menu-previous", previousOnFirstMenu(), ROLES);
write("step-back-control", stepBackControl(), NONE);
write("two-registrations-control", twoRegistrationsControl(), NONE);

/** A survey menu of one form with one question. */
function surveyMenu(key: string, name: string, extra: object = {}) {
	return {
		uuid: key,
		name,
		...extra,
		forms: [
			{
				uuid: `${key}-form`,
				name,
				type: "survey" as const,
				fields: [f({ kind: "text", id: "note", label: proseText("Note") })],
			},
		],
	};
}

/** The worker data of a worker assigned to `place`, which HQ writes as all
 *  three place keys or none (`models.py::get_user_session_data`). */
function placedAt(place: string): WorkerData {
	return {
		commcare_location_id: place,
		commcare_location_ids: place,
		commcare_primary_case_sharing_id: place,
	};
}

/**
 * The worker-place document: a menu whose condition reads the worker's
 * primary place from the session (`external-user('commcare_location_id')`),
 * which Nova's gate admits, beside a menu with no condition. HQ writes the
 * place keys only for a worker assigned somewhere, so for a worker assigned
 * nowhere Core refuses the read: the first menu, which reads the condition,
 * and the menu's own screen list nothing and hold the load exception, while
 * the other menu's screen, which never reads it, lists its form. Preview
 * shows that refusal on those two screens alone.
 */
function workerPlaceRead(): BlueprintDoc {
	const doc = buildDoc({
		appName: "Worker place read",
		modules: [
			surveyMenu("worker-place-placed", "Placed visits", {
				displayCondition: eq(
					sessionUser("commcare_location_id"),
					literal("place-north"),
				),
			}),
			surveyMenu("worker-place-anyone", "Anyone"),
		],
	});
	const verdict = mutationCommitVerdict(doc, [], lookupContextOf(undefined));
	if (!verdict.ok)
		throw new Error(
			`Nova's commit gate refused the worker-place document (${verdict.findings
				.map((finding) => finding.code)
				.join(", ")}).`,
		);
	return doc;
}

/**
 * The undeclared-field control: built past the gate, which refuses a read of
 * worker data the app never declares (`undeclared-worker-field`). The menu's
 * condition reads `region` from the session. A project space that defines
 * the field gives every worker the key, `''` where unset
 * (`user_data.py::UserData.to_dict`); one that does not gives none, and Core
 * refuses the read, which is why Nova's gate asks for the field to be
 * declared, so the setup list a publish shows names it for someone to add on
 * CommCare HQ.
 */
function undeclaredWorkerFieldControl(): BlueprintDoc {
	const doc = buildDoc({
		appName: "Undeclared worker field control",
		modules: [
			surveyMenu("undeclared-field-region", "North visits", {
				displayCondition: eq(sessionUser("region"), literal("north")),
			}),
			surveyMenu("undeclared-field-anyone", "Anyone"),
		],
	});
	const verdict = mutationCommitVerdict(doc, [], lookupContextOf(undefined));
	if (
		verdict.ok ||
		!verdict.findings.some(
			(finding) => finding.details?.checkCode === "undeclared-worker-field",
		)
	)
		throw new Error(
			"Nova's commit gate no longer refuses a read of a worker field the app never declares.",
		);
	return doc;
}

/** The commit gate's verdict on a worker-place document, which must admit
 *  it: each reads the worker's place by name, as Nova admits. */
function admitted(name: string, doc: BlueprintDoc): BlueprintDoc {
	const verdict = mutationCommitVerdict(doc, [], lookupContextOf(undefined));
	if (!verdict.ok)
		throw new Error(
			`Nova's commit gate refused the ${name} document (${verdict.findings
				.map((finding) => finding.code)
				.join(", ")}).`,
		);
	return verdict.nextDoc;
}

/** A condition that holds for a worker placed at `place-north`, and that Core
 *  refuses for a worker assigned nowhere. */
function placedNorth() {
	return eq(sessionUser("commcare_location_id"), literal("place-north"));
}

/**
 * The worker-place forms document: a case-first menu, "Visits", whose second
 * form's condition reads the worker's place. Core reads a form's condition
 * once the case is chosen (`MenuLoader.addRelevantCommandEntries`), so for a
 * worker assigned nowhere the menu's screen fails with the case chosen, and
 * Preview's form menu shows the refusal there; the first menu, which reads no
 * such condition, lists the menu.
 */
function workerPlaceForms(): BlueprintDoc {
	const followUp = (uuid: string, name: string, extra: object = {}) => ({
		uuid,
		name,
		type: "followup" as const,
		...extra,
		fields: [f({ kind: "text", id: "note", label: proseText("Note") })],
	});
	return admitted(
		"worker-place forms",
		buildDoc({
			appName: "Worker place forms",
			caseTypes: [{ name: "visit", properties: [] }],
			modules: [
				{
					uuid: "worker-place-visits",
					name: "Visits",
					caseType: "visit",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [
						followUp("worker-place-visit-check", "Check visit"),
						followUp("worker-place-visit-placed", "Placed visit", {
							displayCondition: placedNorth(),
						}),
					],
				},
			],
		}),
	);
}

/**
 * The worker-place menus document, one refusing read per screen:
 *
 * - "Placed reports" shows its form on the first menu with a condition that
 *   reads the worker's place, so that form's row carries it
 *   (`menus.py::_generate_menu`) and the first menu fails for a worker
 *   assigned nowhere.
 * - "Districts" keeps its screen, and its submenu "District rounds" shows its
 *   form there under a condition that reads the place, conjoined into the
 *   `<menu>` Districts' screen reads: that screen fails.
 * - "Wards" keeps its screen, and its submenu "Ward notes" keeps its own
 *   under a condition that reads the place: Wards' screen, which lists that
 *   submenu's tile, fails, and so does the submenu's own screen.
 */
function workerPlaceMenus(): BlueprintDoc {
	const doc = buildDoc({
		appName: "Worker place menus",
		modules: [
			surveyMenu("worker-place-reports", "Placed reports", {
				displayCondition: placedNorth(),
			}),
			surveyMenu("worker-place-districts", "Districts"),
			surveyMenu("worker-place-district-rounds", "District rounds", {
				displayCondition: placedNorth(),
			}),
			surveyMenu("worker-place-wards", "Wards"),
			surveyMenu("worker-place-ward-notes", "Ward notes", {
				displayCondition: placedNorth(),
			}),
		],
	});
	doc.modules[testUuid("worker-place-reports")].formsInMenuAbove = true;
	doc.modules[testUuid("worker-place-district-rounds")].parentModuleUuid =
		testUuid("worker-place-districts");
	doc.modules[testUuid("worker-place-district-rounds")].formsInMenuAbove = true;
	doc.modules[testUuid("worker-place-ward-notes")].parentModuleUuid =
		testUuid("worker-place-wards");
	return admitted("worker-place menus", doc);
}

/** A worker assigned nowhere, and one at each of two places. */
const PLACE_WORKERS: readonly WorkerData[] = [
	{},
	placedAt("place-north"),
	placedAt("place-south"),
];

write("worker-place-read", workerPlaceRead(), {
	kind: "workers",
	workers: PLACE_WORKERS,
});
write("worker-place-forms", workerPlaceForms(), {
	kind: "workers",
	workers: PLACE_WORKERS,
});
write("worker-place-menus", workerPlaceMenus(), {
	kind: "workers",
	workers: PLACE_WORKERS,
});
write("undeclared-worker-field-control", undeclaredWorkerFieldControl(), {
	kind: "workers",
	workers: [{}, { region: "north" }, { region: "" }],
});

/**
 * The menu-landings document: where Preview opens each menu, and what it
 * shows once the case is chosen, on the shapes it once read apart from Core.
 *
 * - "Wards" asks for its ward first and keeps a submenu, "Ward beds", with a
 *   screen of its own: Core opens the wards' case list before it lists the
 *   submenu's tile.
 * - "Clinics" is only its case list, with a submenu, "Clinic rooms": Core
 *   opens the list, and lists the submenu once a clinic is chosen.
 * - "Rooms" asks for its room first and holds one form: Core lists that form
 *   once the room is chosen and never opens it by itself.
 * - "Patients" is emitted advanced (its kind held by a publish,
 *   `Module.heldKind`) and lists two follow-up forms beside its case list
 *   entry, which asks for HQ's `case_id_case_patient` while the forms load
 *   `case_id_load_patient0`: no one datum is first for every entry, so Core
 *   lists forms first, the entry among them.
 * - "Reviews" is emitted advanced, and a publish keeps its second form's
 *   load under the tag `review` (`placement`), so that form asks for
 *   `case_id_review` while the first asks for `case_id_load_review0`: Core
 *   lists forms first.
 * - "Checks" is emitted advanced, beside its case list entry, and a publish
 *   keeps both forms' loads under the tag `case_check`, so every entry asks
 *   for `case_id_case_check` first: Core asks for the check first.
 * - "Visits" is emitted advanced and holds two basic submenus of visits:
 *   "Visit list", which shows its case list entry in the visits' screen and
 *   holds nothing else, and "Visit notes", which keeps its screen and holds a
 *   follow-up form and its case list entry. HQ aligns each basic entry with
 *   the visits' form, so every entry on both screens asks for the parent's
 *   `case_id_load_visit0` first: Core asks for the visit first on both.
 *
 * Each step back from a form of a case-first menu here lands on a list that
 * holds no form, and from a form of a forms-first one on a list that holds it.
 */
function menuLandings(): BlueprintDoc {
	const list = () => caseListConfig([{ field: "case_name", header: "Name" }]);
	const followUp = (uuid: string, name: string) => ({
		uuid,
		name,
		type: "followup" as const,
		fields: [f({ kind: "text", id: "note", label: proseText("Note") })],
	});
	const doc = buildDoc({
		appName: "Menu landings",
		caseTypes: [
			{ name: "ward", properties: [] },
			{ name: "clinic", properties: [] },
			{ name: "room", properties: [] },
			{ name: "patient", properties: [] },
			{ name: "review", properties: [] },
			{ name: "check", properties: [] },
			{ name: "visit", properties: [] },
		],
		modules: [
			{
				uuid: "landings-wards",
				name: "Wards",
				caseType: "ward",
				caseListConfig: list(),
				forms: [followUp("landings-ward-round", "Ward round")],
			},
			{
				uuid: "landings-ward-beds",
				name: "Ward beds",
				caseType: "ward",
				caseListConfig: list(),
				forms: [followUp("landings-bed-check", "Bed check")],
			},
			{
				uuid: "landings-clinics",
				name: "Clinics",
				caseType: "clinic",
				caseListMenuItem: {},
				caseListConfig: list(),
				forms: [],
			},
			{
				uuid: "landings-clinic-rooms",
				name: "Clinic rooms",
				caseType: "clinic",
				caseListConfig: list(),
				forms: [followUp("landings-clinic-inspection", "Inspect clinic")],
			},
			{
				uuid: "landings-rooms",
				name: "Rooms",
				caseType: "room",
				caseListConfig: list(),
				forms: [followUp("landings-room-clean", "Clean room")],
			},
			{
				uuid: "landings-patients",
				name: "Patients",
				caseType: "patient",
				caseListMenuItem: {},
				caseListConfig: list(),
				forms: [
					followUp("landings-patient-check", "Check patient"),
					followUp("landings-patient-review", "Review patient"),
				],
			},
			{
				uuid: "landings-reviews",
				name: "Reviews",
				caseType: "review",
				caseListConfig: list(),
				forms: [
					followUp("landings-review-open", "Open review"),
					followUp("landings-review-close", "Close review"),
				],
			},
			{
				uuid: "landings-checks",
				name: "Checks",
				caseType: "check",
				caseListMenuItem: {},
				caseListConfig: list(),
				forms: [
					followUp("landings-check-start", "Start check"),
					followUp("landings-check-finish", "Finish check"),
				],
			},
			{
				uuid: "landings-visits",
				name: "Visits",
				caseType: "visit",
				caseListConfig: list(),
				forms: [followUp("landings-visit-check", "Check visit")],
			},
			{
				uuid: "landings-visit-list",
				name: "Visit list",
				caseType: "visit",
				caseListMenuItem: {},
				caseListConfig: list(),
				forms: [],
			},
			{
				uuid: "landings-visit-notes",
				name: "Visit notes",
				caseType: "visit",
				caseListMenuItem: {},
				caseListConfig: list(),
				forms: [followUp("landings-visit-note", "Note visit")],
			},
		],
	});
	/* Where a publish keeps a form's own load: its own case operation's
	 * held placement, the tag HQ's case configuration holds. */
	const keepLoadUnder = (formKey: string, tag: string) => {
		const own = doc.forms[testUuid(formKey)]?.caseOperations?.find(
			(operation) => operation.action === "own",
		);
		if (own === undefined)
			throw new Error(`"${formKey}" holds no own case to keep a load for.`);
		own.placement = { kind: "advanced", tag };
	};
	doc.modules[testUuid("landings-ward-beds")].parentModuleUuid =
		testUuid("landings-wards");
	doc.modules[testUuid("landings-clinic-rooms")].parentModuleUuid =
		testUuid("landings-clinics");
	doc.modules[testUuid("landings-patients")].heldKind = "advanced";
	doc.modules[testUuid("landings-reviews")].heldKind = "advanced";
	keepLoadUnder("landings-review-close", "review");
	doc.modules[testUuid("landings-checks")].heldKind = "advanced";
	keepLoadUnder("landings-check-start", "case_check");
	keepLoadUnder("landings-check-finish", "case_check");
	doc.modules[testUuid("landings-visits")].heldKind = "advanced";
	doc.modules[testUuid("landings-visit-list")].parentModuleUuid =
		testUuid("landings-visits");
	doc.modules[testUuid("landings-visit-list")].formsInMenuAbove = true;
	doc.modules[testUuid("landings-visit-notes")].parentModuleUuid =
		testUuid("landings-visits");
	const verdict = mutationCommitVerdict(doc, [], lookupContextOf(undefined));
	if (!verdict.ok)
		throw new Error(
			`Nova's commit gate refused the menu-landings document (${verdict.findings
				.map((finding) => finding.code)
				.join(", ")}).`,
		);
	return verdict.nextDoc;
}

const landings = menuLandings();
// The visits' two screens ask for the visit first only where Nova reads each
// basic entry as aligned with the advanced parent's form, so a witness that
// read them forms first would hold Core to nothing about that alignment.
for (const key of ["landings-visits", "landings-visit-notes"])
	if (!screenChoosesCaseFirst(landings, ownScreen(testUuid(key))))
		throw new Error(
			`The menu-landings screen "${landings.modules[testUuid(key)]?.name}" no longer asks for the visit first, so it witnesses nothing about a basic entry under an advanced parent.`,
		);
write("menu-landings", landings, ROLES);

/**
 * The pinned-tile document: which held case the pinned tile names, screen by
 * screen. Both platforms walk the session's steps back from the latest and
 * keep the last datum whose definition names a persistent detail
 * (`MenuSessionRunnerService.getStepToFrame`, `BreadcrumbBarHelper.loadTile`,
 * over `CommCareSession.findDatumDefinition`), so the tile is the EARLIEST
 * chosen case whose list keeps its tile on screen.
 *
 * - "Households" keeps its tile and holds a same-type submenu, "Household
 *   rounds", which goes on with the household chosen there: the household's
 *   tile from the menu on.
 * - "Members" chooses its household first on Households' list, then its
 *   member on its own list, which keeps its tile too: the household's tile,
 *   the earlier, from the member list on.
 * - "Villages" chooses households on a list that does not keep its tile, and
 *   holds a same-type submenu, "Village rounds", whose own list asks to keep
 *   it but chooses nothing: no tile anywhere.
 * - "Residents" chooses its village household first on Villages' list, then
 *   its member on its own list, which keeps its tile: the member's tile once
 *   the member is chosen, and none before.
 * - "Member visits" chooses its member under a household Households' list
 *   chooses, and lists its forms first, a survey beside a follow-up: Core
 *   lists the menu, asks for the household after the follow-up's command
 *   (`CommCareSession.getNeededData`, `getDataNeededByAllEntries`), and the
 *   survey opens with no case. The household's datum names no details screen
 *   though Households' own list shows details, so the row goes on at once:
 *   the household's tile from the member list on.
 * - "Household clinics" is a submenu of Households whose case type, clinic,
 *   is not related to the household: the household chosen on Households'
 *   list stays a step of the session (`[m, household, m-clinics, clinic]`),
 *   so its tile stays above the clinic list, the clinic menu and its form.
 * - "Patients" keeps its tile and offers a Search action its forms do not
 *   read: a result is chosen for the remote request's `search_case_id`, which
 *   names no persistent detail (`searchSession.ts::buildSearchSession`), so
 *   Android's details of a result draw no tile; once the claim posts and the
 *   request rewinds the chosen case into the list's own datum, its tile shows.
 */
function pinnedTileDocument(): BlueprintDoc {
	const list = (key: string, keepsTile: boolean) => {
		const name = plainColumn(testUuid(`${key}-name`), "case_name", "Name", {
			...(keepsTile && { tile: tileCell(0, 0, 6, 1) }),
		});
		return {
			...(keepsTile && { tile: { persistOnForms: true as const } }),
			columns: [name],
			listColumnOrder: [name.uuid],
			detailColumnOrder: [name.uuid],
			searchInputs: [],
		};
	};
	const followUp = (uuid: string, name: string) => ({
		uuid,
		name,
		type: "followup" as const,
		fields: [f({ kind: "text", id: "note", label: proseText("Note") })],
	});
	const doc = buildDoc({
		appName: "Pinned tile",
		caseTypes: [
			{ name: "household", properties: [] },
			{ name: "member", parent_type: "household", properties: [] },
			{ name: "clinic", properties: [] },
			{ name: "patient", properties: [] },
		],
		modules: [
			{
				uuid: "tiles-households",
				name: "Households",
				caseType: "household",
				caseListConfig: list("tiles-households", true),
				forms: [followUp("tiles-household-visit", "Visit household")],
			},
			{
				uuid: "tiles-household-rounds",
				name: "Household rounds",
				caseType: "household",
				caseListConfig: list("tiles-household-rounds", false),
				forms: [followUp("tiles-household-round", "Round")],
			},
			{
				uuid: "tiles-household-clinics",
				name: "Household clinics",
				caseType: "clinic",
				caseListConfig: list("tiles-household-clinics", false),
				forms: [followUp("tiles-household-clinic-visit", "Visit clinic")],
			},
			{
				uuid: "tiles-members",
				name: "Members",
				caseType: "member",
				caseListConfig: list("tiles-members", true),
				forms: [followUp("tiles-member-check", "Check member")],
			},
			{
				uuid: "tiles-villages",
				name: "Villages",
				caseType: "household",
				caseListConfig: list("tiles-villages", false),
				forms: [followUp("tiles-village-survey", "Survey village")],
			},
			{
				uuid: "tiles-village-rounds",
				name: "Village rounds",
				caseType: "household",
				caseListConfig: list("tiles-village-rounds", true),
				forms: [followUp("tiles-village-round", "Village round")],
			},
			{
				uuid: "tiles-residents",
				name: "Residents",
				caseType: "member",
				caseListConfig: list("tiles-residents", true),
				forms: [followUp("tiles-resident-check", "Check resident")],
			},
			{
				uuid: "tiles-member-visits",
				name: "Member visits",
				caseType: "member",
				caseListConfig: list("tiles-member-visits", false),
				forms: [
					{
						uuid: "tiles-member-notes",
						name: "Member notes",
						type: "survey" as const,
						fields: [f({ kind: "text", id: "note", label: proseText("Note") })],
					},
					followUp("tiles-member-visit", "Visit member"),
				],
			},
			{
				uuid: "tiles-patients",
				name: "Patients",
				caseType: "patient",
				caseListConfig: {
					...list("tiles-patients", true),
					searchInputs: [
						simpleSearchInputDef(
							testUuid("tiles-patients-input"),
							"patient_name",
							"Patient name",
							"text",
							"case_name",
						),
					],
				},
				forms: [followUp("tiles-patient-visit", "Visit patient")],
			},
		],
	});
	doc.modules[testUuid("tiles-household-rounds")].parentModuleUuid =
		testUuid("tiles-households");
	doc.modules[testUuid("tiles-members")].parentCaseModuleUuid =
		testUuid("tiles-households");
	doc.modules[testUuid("tiles-village-rounds")].parentModuleUuid =
		testUuid("tiles-villages");
	doc.modules[testUuid("tiles-household-clinics")].parentModuleUuid =
		testUuid("tiles-households");
	doc.modules[testUuid("tiles-residents")].parentCaseModuleUuid =
		testUuid("tiles-villages");
	doc.modules[testUuid("tiles-member-visits")].parentCaseModuleUuid =
		testUuid("tiles-households");
	return admitted("pinned-tile", doc);
}

/** The screen a walk's step reaches, as Preview reads it: a case list
 *  asking for its case, a menu (its own screen or a list's own form menu)
 *  listing what the session goes on to, or a form. */
type TileScreen =
	| { readonly surface: "case-list"; readonly listModuleUuid: Uuid }
	| { readonly surface: "menu" | "form"; readonly moduleUuid: Uuid };

/** One step of a walk: a command chosen, or a case chosen on a list. */
type TileWalkStep =
	| { readonly command: string; readonly reaches: TileScreen }
	| {
			/** The Search action of `searchOn`'s list run, its results the
			 *  cases listed. */
			readonly searchOn: Uuid;
			readonly results: readonly string[];
			readonly reaches: TileScreen;
	  }
	| {
			readonly listModuleUuid: Uuid;
			readonly caseId: string;
			/** The datum the list chooses for where it shows a case's details
			 *  (`PreviewViewedDatum`): its own case, the one datum HQ's build
			 *  gives a details screen on a list (`entries.py`, `detail_confirm`
			 *  only at the chain's index 0), or a search action's result, its
			 *  remote request's; absent on a parent's list, which shows none. */
			readonly details?: Exclude<PreviewViewedCase["datum"], "parent">;
			/** On a parent's list, the menu whose entry asked for its case and
			 *  the form chosen before it, if any: the entry whose datum Core
			 *  asks the list for. */
			readonly parentFor?: {
				readonly moduleUuid: Uuid;
				readonly formUuid?: Uuid;
			};
			readonly reaches: TileScreen;
	  };

/** What both platforms answer for the tile on menus, case lists and forms. */
const TILE_RULES = [
	previewPlatformRules("web-apps"),
	previewPlatformRules("android"),
] as const;

/**
 * The tile Preview pins on a screen, written as Core names it: the case and
 * the detail its datum's persistent detail names, `m<index>_case_short` of
 * the list that keeps its tile (`compiler.ts`, `formLinkProjection.ts`).
 * Each held list is handed the rule as each screen hands it: a case list its
 * selections before its own (`CaseListScreen`, `previewSelectionsBefore`), a
 * menu and a form the menu's held cases (`ModuleScreen`,
 * `previewMenuHeldSelections`, which a form whose case was chosen on its
 * menu's list holds alike, `FormScreen`'s `heldCases`). Both platforms
 * answer alike on these screens, which the producer refuses otherwise.
 */
function pinnedTileOf(
	doc: BlueprintDoc,
	ctx: FormLinkProjectionContext,
	held: readonly PreviewHeldCaseSelection[],
	surface: PinnedTileSurface,
	viewing?: PreviewViewedCase,
	rules: readonly ReturnType<typeof previewPlatformRules>[] = TILE_RULES,
) {
	const answers = rules.map((platform) => {
		const pinned = previewPinnedCaseTile(
			doc.modules,
			held,
			surface,
			platform,
			viewing,
		);
		return pinned === undefined
			? null
			: {
					detail: `m${moduleIndexOf(ctx, pinned.moduleUuid)}_case_short`,
					caseId: pinned.caseId,
				};
	});
	const [first, ...rest] = answers;
	if (rest.some((answer) => JSON.stringify(answer) !== JSON.stringify(first)))
		throw new Error(
			`Web Apps and Android pin different tiles on a ${surface}, which the pinned-tile walks read once for both.`,
		);
	return first ?? null;
}

/** Each walk's steps as Core takes them, with the tile Preview pins on the
 *  screen each reaches, and, on a list's own details, the tile Android's
 *  details draw before the case is chosen. */
function tileWalksOf(
	doc: BlueprintDoc,
	walks: readonly {
		readonly name: string;
		readonly steps: readonly TileWalkStep[];
	}[],
) {
	const ctx = formLinkProjectionContext(doc);
	const source = { ...doc, caseTypes: doc.caseTypes ?? [] };
	const heldOn = (
		screen: TileScreen,
		selections: Readonly<Record<string, PreviewMenuCaseSelection>>,
	) =>
		screen.surface === "case-list"
			? previewSelectionsBefore(source, screen.listModuleUuid, selections)
			: previewMenuHeldSelections(source, screen.moduleUuid, selections);
	return walks.map((walk) => {
		let selections: Record<string, PreviewMenuCaseSelection> = {};
		const steps = walk.steps.map((step) => {
			let details: ReturnType<typeof pinnedTileOf> | undefined;
			/* Whether the parent's list opens a case's details before the choice
			 * goes on, as `CaseListScreen` decides it for a parent request. */
			const confirms =
				"listModuleUuid" in step && step.parentFor !== undefined
					? previewParentCaseListHasDetails(doc, {
							selectorModuleUuid: step.listModuleUuid,
							requestingModuleUuid: step.parentFor.moduleUuid,
							...(step.parentFor.formUuid !== undefined && {
								formUuid: step.parentFor.formUuid,
							}),
						})
					: undefined;
			if ("listModuleUuid" in step) {
				if (step.details !== undefined)
					details = pinnedTileOf(
						doc,
						ctx,
						previewSelectionsBefore(source, step.listModuleUuid, selections),
						"case-details",
						{
							moduleUuid: step.listModuleUuid,
							caseId: step.caseId,
							datum: step.details,
						},
						[previewPlatformRules("android")],
					);
				const caseType = doc.modules[step.listModuleUuid]?.caseType;
				if (caseType === undefined)
					throw new Error(
						`A pinned-tile walk chooses on a list with no case type.`,
					);
				selections = {
					...selections,
					[step.listModuleUuid]: {
						caseType,
						cases: [{ caseId: step.caseId }],
					},
				};
			}
			const surface = step.reaches.surface;
			return {
				...("command" in step
					? { command: step.command }
					: "searchOn" in step
						? {
								search: `search_command.m${moduleIndexOf(ctx, step.searchOn)}`,
								results: step.results,
							}
						: {
								case: step.caseId,
								/* A search action's result is claimed, and its request
								 * rewinds the case into the list's own datum. */
								...(step.details === "search-results" && { claims: true }),
							}),
				...(details !== undefined && { details }),
				...(confirms !== undefined && { confirms }),
				asks: surface,
				tile: pinnedTileOf(doc, ctx, heldOn(step.reaches, selections), surface),
			};
		});
		return { name: walk.name, steps };
	});
}

const tiles = pinnedTileDocument();
{
	const ctx = formLinkProjectionContext(tiles);
	const uuid = (key: string) => testUuid(`tiles-${key}`);
	const menu = (key: string) => `m${moduleIndexOf(ctx, uuid(key))}`;
	const form = (moduleKey: string, formKey: string) =>
		formCommandId(ctx, uuid(moduleKey), uuid(formKey));
	const onMenu = (key: string) => ({
		surface: "menu" as const,
		moduleUuid: uuid(key),
	});
	const onForm = (key: string) => ({
		surface: "form" as const,
		moduleUuid: uuid(key),
	});
	const onList = (key: string) => ({
		surface: "case-list" as const,
		listModuleUuid: uuid(key),
	});
	const choose = (
		listKey: string,
		caseId: string,
		ownCase: boolean,
		reaches: TileScreen,
		parentFor?: { readonly moduleKey: string; readonly formKey?: string },
	) => ({
		listModuleUuid: uuid(listKey),
		caseId,
		...(ownCase && { details: "list" as const }),
		...(parentFor !== undefined && {
			parentFor: {
				moduleUuid: uuid(parentFor.moduleKey),
				...(parentFor.formKey !== undefined && {
					formUuid: uuid(parentFor.formKey),
				}),
			},
		}),
		reaches,
	});
	/* Where Preview opens a menu that needs its parent case: the parent's
	 * list where it asks for it before listing its screen, else its screen
	 * (`choosePreviewMenuTile`); and where a form of it opens: the parent's
	 * list where its entry asks for it (`previewLeafAsksParentCase`, the
	 * admission `usePreviewScreenForLocation` makes), else the form. */
	const onMenuNeeding = (key: string, selectorKey: string) =>
		previewParentCaseBeforeMenu(tiles, uuid(key))
			? onList(selectorKey)
			: onMenu(key);
	const onFormNeeding = (key: string, formKey: string, selectorKey: string) =>
		previewLeafAsksParentCase(tiles, uuid(key), uuid(formKey))
			? onList(selectorKey)
			: onForm(key);
	write("pinned-tile", tiles, NONE);
	const walks = tileWalksOf(tiles, [
		{
			name: "a same-type submenu goes on with the case a list that keeps its tile chose",
			steps: [
				{ command: menu("households"), reaches: onList("households") },
				choose("households", "household-case-1", true, onMenu("households")),
				{
					command: menu("household-rounds"),
					reaches: onMenu("household-rounds"),
				},
				{
					command: form("household-rounds", "household-round"),
					reaches: onForm("household-rounds"),
				},
			],
		},
		{
			name: "a menu's own form under the tile of the case its list chose",
			steps: [
				{ command: menu("households"), reaches: onList("households") },
				choose("households", "household-case-2", true, onMenu("households")),
				{
					command: form("households", "household-visit"),
					reaches: onForm("households"),
				},
			],
		},
		{
			name: "a parent-select chain whose two lists keep their tile pins the parent",
			steps: [
				{
					command: menu("members"),
					reaches: onMenuNeeding("members", "households"),
				},
				choose("households", "household-case-1", false, onList("members"), {
					moduleKey: "members",
				}),
				choose("members", "member-case-1", true, onMenu("members")),
				{
					command: form("members", "member-check"),
					reaches: onForm("members"),
				},
			],
		},
		{
			name: "a same-type submenu under a list that does not keep its tile pins none",
			steps: [
				{ command: menu("villages"), reaches: onList("villages") },
				choose("villages", "household-case-2", true, onMenu("villages")),
				{
					command: menu("village-rounds"),
					reaches: onMenu("village-rounds"),
				},
				{
					command: form("village-rounds", "village-round"),
					reaches: onForm("village-rounds"),
				},
			],
		},
		{
			name: "a submenu of an unrelated case type keeps the tile of the case the menu above chose",
			steps: [
				{ command: menu("households"), reaches: onList("households") },
				choose("households", "household-case-1", true, onMenu("households")),
				{
					command: menu("household-clinics"),
					reaches: onList("household-clinics"),
				},
				choose(
					"household-clinics",
					"clinic-case-1",
					true,
					onMenu("household-clinics"),
				),
				{
					command: form("household-clinics", "household-clinic-visit"),
					reaches: onForm("household-clinics"),
				},
			],
		},
		{
			name: "a search action's result is chosen for a datum that names no persistent detail, and its claim pins it",
			steps: [
				{ command: menu("patients"), reaches: onList("patients") },
				{
					searchOn: uuid("patients"),
					results: ["patient-case-1"],
					reaches: onList("patients"),
				},
				{
					listModuleUuid: uuid("patients"),
					caseId: "patient-case-1",
					details: "search-results" as const,
					reaches: onMenu("patients"),
				},
				{
					command: form("patients", "patient-visit"),
					reaches: onForm("patients"),
				},
			],
		},
		{
			name: "a parent-select chain whose parent's list does not keep its tile pins the child",
			steps: [
				{
					command: menu("residents"),
					reaches: onMenuNeeding("residents", "villages"),
				},
				choose("villages", "household-case-1", false, onList("residents"), {
					moduleKey: "residents",
				}),
				choose("residents", "member-case-2", true, onMenu("residents")),
				{
					command: form("residents", "resident-check"),
					reaches: onForm("residents"),
				},
			],
		},
		{
			name: "a menu that lists its forms first asks for its parent case after a form's command, on a list that goes on at the row",
			steps: [
				{
					command: menu("member-visits"),
					reaches: onMenuNeeding("member-visits", "households"),
				},
				{
					command: form("member-visits", "member-visit"),
					reaches: onFormNeeding("member-visits", "member-visit", "households"),
				},
				choose(
					"households",
					"household-case-2",
					false,
					onList("member-visits"),
					{ moduleKey: "member-visits", formKey: "member-visit" },
				),
				choose("member-visits", "member-case-1", true, onForm("member-visits")),
			],
		},
		{
			name: "a survey of a menu that asks for its parent case after a form's command opens with no case",
			steps: [
				{
					command: menu("member-visits"),
					reaches: onMenuNeeding("member-visits", "households"),
				},
				{
					command: form("member-visits", "member-notes"),
					reaches: onFormNeeding("member-visits", "member-notes", "households"),
				},
			],
		},
	]);
	/* A witness that never pins, never pins the earlier of two, never pins
	 * the later where the earlier keeps none, or never draws Android's
	 * details tile holds Core to nothing about that branch. */
	const tilesOf = walks.flatMap((walk) => walk.steps.map((step) => step.tile));
	const pins = (detail: string, caseId: string) =>
		tilesOf.some((tile) => tile?.detail === detail && tile.caseId === caseId);
	const households = `${menu("households")}_case_short`;
	const residents = `${menu("residents")}_case_short`;
	if (
		!pins(households, "household-case-1") ||
		!pins(residents, "member-case-2") ||
		!tilesOf.some((tile) => tile === null) ||
		!walks.some((walk) =>
			walk.steps.some(
				(step) =>
					"details" in step &&
					"case" in step &&
					step.details?.caseId === step.case,
			),
		) ||
		!walks.some((walk) =>
			walk.steps.some(
				(step) =>
					"claims" in step && "details" in step && step.details === null,
			),
		)
	)
		throw new Error(
			"The pinned-tile walks no longer read every branch of the rule: the earlier of two lists that keep their tile, the later where the earlier keeps none, a screen with none, Android's details drawing the case they show, and a search action's result whose details draw none.",
		);
	/* A parent's list whose own list shows details must be read going on at
	 * the row, and a menu that lists its forms first must be read listing
	 * them, or the walks hold Core to nothing about either. */
	const steps = walks.flatMap((walk) => walk.steps);
	if (
		!steps.some((step) => "confirms" in step && step.confirms === false) ||
		!steps.some(
			(step) =>
				"command" in step &&
				step.command === menu("member-visits") &&
				step.asks === "menu",
		)
	)
		throw new Error(
			"The pinned-tile walks no longer read a parent's list going on at the row, or a menu that lists its forms before it asks for its parent case.",
		);
	writeFileSync(
		resolve(output, "pinned-tile.tiles.json"),
		JSON.stringify({
			deviceCases: [
				{ id: "household-case-1", type: "household", properties: {} },
				{ id: "household-case-2", type: "household", properties: {} },
				{ id: "member-case-1", type: "member", properties: {} },
				{ id: "member-case-2", type: "member", properties: {} },
				{ id: "clinic-case-1", type: "clinic", properties: {} },
				// Claimed once chosen from the search's results.
				{ id: "patient-case-1", type: "patient", properties: {} },
			],
			walks,
		}),
	);
}

// Some step back is read on a screen that chooses its case first and lists one
// form, where Core lists the menu and Preview once opened the form by itself.
if (loneFormStepBacks === 0)
	throw new Error(
		"No step back is read on a case-first screen that lists one form; give a document a case-first menu of one form.",
	);

write("listed-source-forms", twoMenus(), ROLES);
