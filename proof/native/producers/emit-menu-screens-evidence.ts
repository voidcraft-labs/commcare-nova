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
 * what Nova's projection says each screen lists (`lib/domain/menuScreens.ts`),
 * which entries Preview shows there (`menuProjection.ts::previewScreenEntryVisibility`)
 * for a worker holding each role of `WORKER_ROLES` and no case, which rows of
 * a menu that shows its forms in its parent's menu that worker loses to the
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
	proseText,
	screenChoosesCaseFirst,
	screenIsBareCaseList,
	type Uuid,
} from "../../../lib/domain";
import { formField, term } from "../../../lib/domain/expression";
import { alwaysOfferedRegistrationReturn } from "../../../lib/preview/engine/caseListRegisterAction";
import type {
	NavigationDeviceCases,
	NavigationItemVisibility,
} from "../../../lib/preview/engine/displayConditionEvaluation";
import {
	type FrameLanding,
	screenOfFrame,
} from "../../../lib/preview/engine/frameLanding";
import type { PreviewSearchSessionValues } from "../../../lib/preview/engine/identity";
import {
	menuScreenEntryKey,
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
import { NATIVE_RUNTIME_TARGET } from "./runtimeTarget";

const output = process.argv[2];
if (!output)
	throw new Error(
		"Usage: node --import tsx proof/native/producers/emit-menu-screens-evidence.ts OUTPUT_DIRECTORY",
	);
mkdirSync(output, { recursive: true });

/**
 * The worker roles each screen is listed for: none, and each value of the
 * worker's `role` a display condition of the targeted documents compares
 * with, so every condition is read both holding and not
 * (`assertEveryMenuConditionHolds`), and a submenu's condition joined with its
 * parent's is read both holding and failing on the parent's side alone
 * (`assertEveryConjunctionIsRead`). The worker holds no case, so a condition
 * that reads the chosen case is false, as Core reads it with no case chosen.
 */
const WORKER_ROLES = [null, "registrar", "visitor", "checker"] as const;

/** The device's cases: none. */
const NO_CASES = (doc: BlueprintDoc): NavigationDeviceCases => ({
	snapshot: { rows: [], indices: [] },
	caseTypes: doc.caseTypes ?? [],
});

/** The worker Core's session holds (`MenuScreensRuntimeTest.session`), with
 *  `role` among its data where it holds one. */
function workerSession(role: string | null): PreviewSearchSessionValues {
	return {
		context: { userid: "worker-id", username: "worker" },
		user: role === null ? {} : { role },
		userPropertySlugs: {},
	};
}

/** Each module's own visibility for a worker holding `role`. */
function ownVisibility(doc: BlueprintDoc, role: string | null) {
	return previewModuleOwnVisibility(doc, {
		authoring: false,
		session: workerSession(role),
		lookup: { kind: "idle" },
		deviceCases: NO_CASES(doc),
	});
}

/** A role list that leaves some menu's condition never holding would leave
 *  that condition's effect unread: refuse it by name. */
function assertEveryMenuConditionHolds(name: string, doc: BlueprintDoc): void {
	const holding = WORKER_ROLES.map((role) => ownVisibility(doc, role));
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

/** The commands a worker holding `role` meets on a screen, in order, as
 *  Preview shows them: a menu tile by its own condition, which is all Core
 *  reads when it lists that screen, and a form or case list row by
 *  `previewScreenEntryVisibility` (the menus whose condition it carries, then
 *  a form's own). */
function listedCommands(
	doc: BlueprintDoc,
	ctx: FormLinkProjectionContext,
	entries: readonly MenuScreenEntry[],
	role: string | null,
): string[] {
	const own = ownVisibility(doc, role);
	const shown = entryVisibility(doc, entries, own, role);
	return entries.flatMap((entry) => {
		const visibility =
			entry.kind === "menu"
				? (own.get(entry.moduleUuid) ?? "shown")
				: shown.get(menuScreenEntryKey(entry));
		if (visibility === "pending" || visibility === undefined)
			throw new Error(
				`Preview cannot say whether ${commandOf(ctx, entry)} shows for a worker with no cases.`,
			);
		return visibility === "shown" ? [commandOf(ctx, entry)] : [];
	});
}

/** Each entry's visibility on a screen as Preview shows it to a worker
 *  holding `role` and no case, each module's own visibility read from
 *  `own`. */
function entryVisibility(
	doc: BlueprintDoc,
	entries: readonly MenuScreenEntry[],
	own: ReadonlyMap<Uuid, NavigationItemVisibility>,
	role: string | null,
): ReadonlyMap<string, NavigationItemVisibility> {
	return previewScreenEntryVisibility({
		doc,
		entries,
		ownModuleVisibility: own,
		authoring: false,
		session: workerSession(role),
		lookup: { kind: "idle" },
		deviceCases: NO_CASES(doc),
		selectedCaseOf: () => undefined,
	});
}

/** The commands of a menu that shows its forms in its parent's menu that a
 *  worker holding `role` does not meet only because the parent's own
 *  visibility hides them: Preview would show each were the menu read by its
 *  own condition alone. Core leaves each off the screen only where the menu's
 *  relevance carries its parent's condition (`conditionModulesOf`). */
function parentHiddenCommands(
	doc: BlueprintDoc,
	ctx: FormLinkProjectionContext,
	entries: readonly MenuScreenEntry[],
	role: string | null,
): string[] {
	const own = ownVisibility(doc, role);
	const shown = entryVisibility(doc, entries, own, role);
	return entries.flatMap((entry) => {
		const parent =
			entry.kind === "menu"
				? undefined
				: conditionModulesOf(doc, entry.moduleUuid)[1];
		if (parent === undefined || own.get(parent) !== "hidden") return [];
		const key = menuScreenEntryKey(entry);
		const alone = entryVisibility(
			doc,
			[entry],
			new Map([...own, [parent, "shown"]]),
			role,
		);
		return shown.get(key) === "hidden" && alone.get(key) === "shown"
			? [commandOf(ctx, entry)]
			: [];
	});
}

/** A menu that shows its forms in a parent's menu, both carrying a
 *  condition, is read through the conjunction of the two. A document whose
 *  roles never show one of its rows with both conditions holding, and never
 *  hide one by the parent's condition alone, would leave that conjunction's
 *  effect unread: refuse it by name. */
function assertEveryConjunctionIsRead(
	name: string,
	doc: BlueprintDoc,
	ctx: FormLinkProjectionContext,
): void {
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
		const entries = menuScreenEntries(
			doc,
			menuScreenOf(doc, moduleUuid),
		).filter(
			(entry) => entry.kind !== "menu" && entry.moduleUuid === moduleUuid,
		);
		if (
			!WORKER_ROLES.some(
				(role) => listedCommands(doc, ctx, entries, role).length > 0,
			) ||
			!WORKER_ROLES.some(
				(role) => parentHiddenCommands(doc, ctx, entries, role).length > 0,
			)
		)
			throw new Error(
				`No role of WORKER_ROLES both sees a row of "${mod.name}" in ${name} and loses one to the condition of "${parent.name}" alone; give the menu a row that reads no case, and conditions some role holds together and some role holds only the menu's.`,
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

function screensOf(doc: BlueprintDoc, ctx: FormLinkProjectionContext) {
	const screens: MenuScreen[] = [
		{ kind: "first-menu" },
		...ctx.moduleOrder
			.filter((moduleUuid) => moduleHasOwnScreen(doc, moduleUuid))
			.map((moduleUuid) => ({ kind: "menu" as const, moduleUuid })),
	];
	return screens.map((screen) => {
		const entries = menuScreenEntries(doc, screen);
		return {
			menuId:
				screen.kind === "first-menu"
					? "root"
					: `m${moduleIndexOf(ctx, screen.moduleUuid)}`,
			asksCaseFirst:
				screen.kind === "menu" &&
				(screenChoosesCaseFirst(doc, screen) ||
					screenIsBareCaseList(doc, screen)),
			listings: WORKER_ROLES.map((role) => ({
				role,
				commands: listedCommands(doc, ctx, entries, role),
				parentHides: parentHiddenCommands(doc, ctx, entries, role),
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
		compileCcz(hq, doc.appName, doc, { runtimeTarget: NATIVE_RUNTIME_TARGET }),
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
		writeFileSync(
			resolve(output, `${name}.screens.json`),
			JSON.stringify({ screens: screensOf(doc, ctx) }),
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
