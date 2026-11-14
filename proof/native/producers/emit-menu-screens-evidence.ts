/**
 * The `menu-screens` family: both exports of the targeted documents of menus
 * that show their forms in the menu above and of registration from the case
 * list, and of two documents Nova's gate refuses, built past it as the
 * nested-menu proofs build their counterexamples.
 *
 * Each document writes `<name>.json` (the HQ import body, which HQ's step
 * builds its suite from, `proof/native/steps/suite_emission.py::menu_screens`),
 * `<name>.suite.xml` (the local archive's suite) and `<name>.screens.json`:
 * what Nova's projection says each screen lists (`lib/domain/menuScreens.ts`),
 * which entries a worker meets there while every display condition is false
 * (a condition the session cannot satisfy, as Core reads it with no worker
 * data), whether Core asks for a case first, and where each form lands after
 * submit. A document with a case list that offers another menu's registration
 * form also writes `<name>.offers.json`: each host's menu, the offered form's
 * command, and where a worker goes after registering from the list
 * (`lib/domain/menuForms.ts::caseListRegistrationReturnOf`).
 * `MenuScreensRuntimeTest` and `RegisterFromListRuntimeTest` hold Core to them.
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
	menuIdOf,
	moduleIndexOf,
} from "../../../lib/commcare/formLinkProjection";
import { hydratePersistedBlueprint } from "../../../lib/doc/fieldParent";
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
	moduleHasOwnScreen,
	moduleUuidOfForm,
	proseText,
	screenChoosesCaseFirst,
	screenIsBareCaseList,
	type Uuid,
} from "../../../lib/domain";
import { formField, term } from "../../../lib/domain/expression";
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

/** Whether a module or a form is held off a worker's screen by a display
 *  condition or by being off the menu. */
function gated(
	item: { displayCondition?: unknown; hiddenFromMenu?: true } | undefined,
): boolean {
	return item?.displayCondition !== undefined || item?.hiddenFromMenu === true;
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

function listed(doc: BlueprintDoc, entry: MenuScreenEntry): boolean {
	if (entry.kind === "menu") return !gated(doc.modules[entry.moduleUuid]);
	if (
		conditionModulesOf(doc, entry.moduleUuid).some((uuid) =>
			gated(doc.modules[uuid]),
		)
	)
		return false;
	return entry.kind === "form" ? !gated(doc.forms[entry.formUuid]) : true;
}

/** The menu a form lands on after submit, by its after-submit destination,
 *  or null where it lands on no menu (Home, or the first menu, which Core
 *  reaches with no command). A form with destinations of its own is left
 *  out: its frames are the form-link proofs'. */
function landing(
	doc: BlueprintDoc,
	ctx: FormLinkProjectionContext,
	moduleUuid: Uuid,
	formUuid: Uuid,
): string | null | undefined {
	if (doc.forms[formUuid]?.formLinks !== undefined) return undefined;
	const destination = effectivePostSubmit(doc, formUuid);
	if (destination === "app_home" || destination === "firstMenu") return null;
	if (destination === "previous" || destination === "module")
		return menuIdOf(doc, ctx, moduleUuid);
	const parent = doc.modules[moduleUuid]?.parentModuleUuid;
	return parent === undefined ? null : menuIdOf(doc, ctx, parent);
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
			entries: entries.map((entry) => ({
				command: commandOf(ctx, entry),
				kind: entry.kind,
				listed: listed(doc, entry),
				...(entry.kind === "form" && {
					landsOn: landing(doc, ctx, entry.moduleUuid, entry.formUuid),
				}),
			})),
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
		const screen = menuScreenOf(doc, host);
		return [
			{
				hostMenuId: menuIdOf(doc, ctx, host),
				hostHasForms: (doc.formOrder[host] ?? []).length > 0,
				hostScreenAsksCaseFirst:
					screenChoosesCaseFirst(doc, screen) ||
					screenIsBareCaseList(doc, screen),
				formCommand: formCommandId(ctx, formModule, slot.formUuid),
				returnTo: returnTo.kind,
				formLandsOn:
					returnTo.kind === "own"
						? landing(doc, ctx, formModule, slot.formUuid)
						: undefined,
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
	if (withScreens)
		writeFileSync(
			resolve(output, `${name}.screens.json`),
			JSON.stringify({ screens: screensOf(doc, ctx) }),
		);
	const offers = offersOf(doc, ctx);
	if (offers.length > 0)
		writeFileSync(
			resolve(output, `${name}.offers.json`),
			JSON.stringify({ offers }),
		);
}

for (const [name, make] of [
	["forms-in-menu-above", formsInMenuAbove],
	["forms-in-menu-above-nested", formsInMenuAboveNested],
	["forms-in-menu-above-registration-only", formsInMenuAboveRegistrationOnly],
	["forms-in-menu-above-one-case", formsInMenuAboveOneCase],
	["register-from-case-list", registerFromCaseList],
	["register-from-case-list-web-apps", registerFromCaseListWebApps],
] as const)
	write(name, hydratePersistedBlueprint(make().doc), true);

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
