/**
 * The menus stages. `readMenus` reads every menu's own navigation before any
 * form's case management (a form needs its menu's case type, kind, nesting
 * and parent selection), with registration from the case list first, so a
 * hidden registration menu is folded before any other reader takes it for a
 * menu. `settleMenus` runs last of the settles: it writes every bound menu
 * slot, then expands the app once, and every acceptance of this stage reads
 * that one expansion.
 */
import type { HqApplication } from "@/lib/commcare";
import {
	type BlueprintDoc,
	formLinkEntries,
	resolveFormLinkTarget,
	type Uuid,
} from "@/lib/domain";
import { NO_ENTRIES } from "@/lib/domain/records";
import { caseListMenuItemLabelUnit } from "../../emissionPlan";
import {
	firstMenuSharedCaseFrames,
	linkCarriesFirstMenuCase,
} from "../../validator/rules/formsInMenuAbove";
import { rootSelectionTakesNewCase } from "../../validator/rules/parentSelection";
import { rethrowWorkStop } from "../../workMeter";
import { type Claim, defineClaims, derived, refuse } from "../claims";
import type { DraftApp, ReadContext } from "../context";
import { readerDefect } from "../defects";
import { levelControl } from "../expressions/printLevel";
import { printSlot, sameSlotText } from "../expressions/readExpression";
import { isJsonObject, objectMembers, sameJson } from "../jsonCursor";
import { handedOff } from "../pendingExpressions";
import { appPlace } from "../place";
import { keptMediaPaths, readExpansionSteps } from "../projectionInputs";
import { provisionalDocument } from "../provisional";
import { expressionEnvOf } from "../xform";
import {
	acceptAfterSubmit,
	readAfterSubmit,
	settleAfterSubmit,
	storedReturns,
} from "./afterSubmit";
import {
	readEntryPoints,
	settleEntryCaseCreations,
	settleEntryPoints,
} from "./entryPoints";
import {
	appLanguageCodes,
	caseListLabelAsBuilt,
	caseListMenus,
	caseListPlaceOf,
	heldLabel,
	keepsRefusedCaseType,
	labelMap,
	rawModules,
	readModules,
	settleModules,
	withReadTranslations,
} from "./modules";
import { shownBlockMedia } from "./navMedia";
import { readCaseListRegistration, settleRegistrations } from "./registration";
import { readSharedFormMenus } from "./sharedForms";

export { registerLinkExpressions } from "./afterSubmit";

const SHARED_FIRST_MENU_CASE =
	"forms-and-case-writes/form-link-or-endpoint-through-a-first-menu-that-shares-one-case";

const INCOMPATIBLE_FIRST_MENU_CASE =
	"forms-and-case-writes/first-menu-selection-used-for-different-records";
const CLAIMS = defineClaims("menus", {
	heldFirstMenuCase: derived(SHARED_FIRST_MENU_CASE, "schema:Form.form_links"),
	heldFirstMenuCaseAdvanced: derived(
		SHARED_FIRST_MENU_CASE,
		"schema:AdvancedForm.form_links",
	),
	sharedFirstMenuCase: refuse(
		INCOMPATIBLE_FIRST_MENU_CASE,
		"schema:Form.form_links",
	),
	sharedFirstMenuCaseAdvanced: refuse(
		INCOMPATIBLE_FIRST_MENU_CASE,
		"schema:AdvancedForm.form_links",
	),
	newCaseTakesRootCase: refuse(
		"menus-and-case-lists/child-menu-form-creating-a-case-of-the-type-its-root-s-first-form-chooses",
		null,
	),
}) satisfies Record<string, Claim>;

/** Every menu's registration block, its own navigation, each form's
 *  workflow word and every deep link, in that order. */
export function readMenus(ctx: ReadContext, app: DraftApp): void {
	const links = readSharedFormMenus(ctx, app);
	readCaseListRegistration(ctx, app);
	readModules(ctx, app);
	readAfterSubmit(ctx, app);
	readEntryPoints(ctx, app, links);
}

/**
 * Once every menu's structure and every form's case operations are in
 * the drafts and before the entry facts are compared: each form of a child
 * menu that creates a case of the type its root menu's first form opens a
 * chosen case of, the shape the gate refuses
 * (`validator/rules/parentSelection.ts::rootSelectionTakesNewCase`). HQ's
 * build matches the new case's datum to the root's selection by case type
 * alone (`entries.py::EntriesHelper.add_parent_datums`), so the form cannot
 * open there; the finding stands at the form, where the entry facts would
 * otherwise part.
 */
export function readRootSelectionsTaken(ctx: ReadContext, app: DraftApp): void {
	let taken: readonly { readonly formUuid?: string }[];
	try {
		taken = rootSelectionTakesNewCase(provisionalDocument(ctx), {
			kind: "unavailable",
		}).map((error) => ({ formUuid: error.location.formUuid }));
	} catch (error) {
		rethrowWorkStop(error);
		// A document the projection cannot walk is the entry facts' to report.
		return;
	}
	for (const { formUuid } of taken) {
		const form = app.modules
			.flatMap((module) => module.forms)
			.find((one) => one.uuid === formUuid);
		if (form !== undefined)
			ctx.accounting.finding(CLAIMS.newCaseTakesRootCase, form.place);
	}
}

type JsonObject = Readonly<Record<string, unknown>>;

type DisplayConditionRef =
	| {
			readonly entity: "module";
			readonly uuid: Uuid;
			readonly slot: "module_display_condition";
	  }
	| {
			readonly entity: "form";
			readonly uuid: Uuid;
			readonly slot: "form_display_condition";
	  };

/** Whether two stored display conditions are one: both absent or blank, or
 *  one tree as HQ's build interpolates the slot (`sameSlotText`). */
function sameFilter(
	doc: BlueprintDoc,
	ref: DisplayConditionRef,
	a: unknown,
	b: unknown,
): boolean {
	const blank = (value: unknown) =>
		typeof value !== "string" || value.trim() === "";
	if (blank(a) || blank(b)) return blank(a) && blank(b);
	return sameSlotText(doc, ref, a as string, b as string);
}

/** The index of a display condition's registration, or -1 where the menu or form registered none. */
function registrationOf(ctx: ReadContext, ref: DisplayConditionRef): number {
	const registrations = ctx.pending.list();
	return (
		ctx.pending
			.of(ref.entity, ref.uuid)
			.find((index) => registrations[index]?.ref.slot === ref.slot) ?? -1
	);
}

/**
 * Whether a stored display condition is the one Nova's print writes: the same text, a print at
 * the level the expression stage held it at, or a slot that stage handed to project data, whose
 * print is project data's one finding at the table (`pendingExpressions.ts::handedOff`).
 */
function sameDisplayCondition(
	ctx: ReadContext,
	doc: BlueprintDoc,
	ref: DisplayConditionRef,
	stored: unknown,
	ours: unknown,
): boolean {
	const index = registrationOf(ctx, ref);
	if (index >= 0 && handedOff(ctx.pending.outcome(index))) return true;
	return (
		sameFilter(doc, ref, stored, ours) ||
		heldAtLevel(ctx, doc, ref, stored, ours)
	);
}

/**
 * Whether a display condition the expression stage held at a level other than exact
 * (`expressions/printLevel.ts`) is the stored one: the document still holds the tree the stage
 * stored, the slot's own print (`readExpression.ts::printSlot`) with no control is the
 * expansion's, so it is the function the expansion printed the slot with, and its print at the
 * held level is the stored text. The reading has recorded each rewrite the level withholds.
 */
function heldAtLevel(
	ctx: ReadContext,
	doc: BlueprintDoc,
	ref: DisplayConditionRef,
	stored: unknown,
	ours: unknown,
): boolean {
	if (typeof stored !== "string") return false;
	const index = registrationOf(ctx, ref);
	if (index < 0) return false;
	const { expression, level } = ctx.pending.outcome(index);
	const tree =
		ref.entity === "module"
			? doc.modules[ref.uuid]?.displayCondition
			: doc.forms[ref.uuid]?.displayCondition;
	if (
		expression === undefined ||
		level === undefined ||
		tree === undefined ||
		!sameJson(tree, expression)
	)
		return false;
	const env = expressionEnvOf(ctx);
	try {
		return (
			sameFilter(doc, ref, printSlot(doc, ref, expression, env), ours) &&
			sameFilter(
				doc,
				ref,
				printSlot(doc, ref, expression, env, {
					rewrites: levelControl(level),
				}),
				stored,
			)
		);
	} catch (error) {
		rethrowWorkStop(error);
		return false;
	}
}

/**
 * The last settle: every bound menu slot written (display conditions,
 * parent selections, workflow words, link conditions and carried values),
 * the app expanded once under the reading's inputs, and every menu reading
 * accepted against that one expansion: registration blocks and folded menus,
 * case list menu item labels, media, display conditions, after-submit and
 * deep links.
 */
export function settleMenus(ctx: ReadContext, app: DraftApp): void {
	const steps = settleMenusSteps(ctx, app);
	while (!steps.next().done);
}

/** `settleMenus`, stopping before and after Nova's emission of the document
 *  until it is resumed. */
export function* settleMenusSteps(
	ctx: ReadContext,
	app: DraftApp,
): Generator<void, void, void> {
	if (ctx.doc === undefined) return;
	settleModules(ctx, storedReturns(ctx));
	settleEntryCaseCreations(ctx, app);
	for (const module of app.modules)
		for (const form of module.forms) settleAfterSubmit(ctx, form);
	yield;
	const doc = ctx.doc as BlueprintDoc;
	let expansion: HqApplication;
	try {
		expansion = yield* readExpansionSteps(ctx, doc);
	} catch (error) {
		rethrowWorkStop(error);
		if (!keepsRefusedCaseType(ctx))
			ctx.accounting.defect(
				appPlace(),
				"schema:Application.modules",
				readerDefect.emissionThrew(appPlace(), "expandDoc"),
			);
		return;
	}
	yield;
	const modules = expansion.modules as unknown as readonly JsonObject[];
	/* The first menu of each id and the first form of each `xmlns`, in the
	 * expansion's order, as a search of the menus, or of all their forms, finds
	 * it; the expansion is read and never written. */
	const menusById = new Map<unknown, JsonObject>();
	const formsByXmlns = new Map<unknown, JsonObject>();
	for (const one of modules) {
		if (!menusById.has(one.unique_id)) menusById.set(one.unique_id, one);
		for (const form of objectMembers(one.forms) ?? [])
			if (!formsByXmlns.has(form.xmlns)) formsByXmlns.set(form.xmlns, form);
	}
	const moduleOf = (uniqueId: string) =>
		menusById.get(uniqueId) as HqApplication["modules"][number] | undefined;
	const formOf = (xmlns: string) => formsByXmlns.get(xmlns);
	settleRegistrations(ctx, moduleOf);
	acceptMenus(
		ctx,
		app,
		moduleOf as (uniqueId: string) => JsonObject | undefined,
		formOf,
	);
	for (const module of app.modules)
		for (const form of module.forms)
			acceptAfterSubmit(ctx, form, formOf(form.xmlns));
	const settledDoc = ctx.doc as BlueprintDoc;
	for (const module of app.modules)
		for (const form of module.forms) {
			const saved = settledDoc.forms[form.uuid];
			if (!saved || ctx.accounting.hasFindingAt(form.place)) continue;
			if (
				formLinkEntries(saved).some((entry) => {
					const target = resolveFormLinkTarget(
						settledDoc,
						form.uuid,
						entry.link.target,
					);
					return target && linkCarriesFirstMenuCase(settledDoc, target);
				})
			) {
				const claim =
					form.docType === "AdvancedForm"
						? CLAIMS.heldFirstMenuCaseAdvanced
						: CLAIMS.heldFirstMenuCase;
				ctx.accounting.claimEntryClass(
					{ json: form.json, key: "form_links" },
					claim.entry,
					`schema:${form.docType}.form_links`,
					form.place,
				);
			}
		}
	settleEntryPoints(ctx);
	for (const error of firstMenuSharedCaseFrames(ctx.doc as BlueprintDoc)) {
		if (error.code !== "FORM_LINK_TARGET_SHARES_FIRST_MENU_CASE") continue;
		const form = app.modules
			.flatMap((module) => module.forms)
			.find((one) => one.uuid === error.location.formUuid);
		if (form !== undefined)
			ctx.accounting.finding(
				form.docType === "AdvancedForm"
					? CLAIMS.sharedFirstMenuCaseAdvanced
					: CLAIMS.sharedFirstMenuCase,
				form.place,
			);
	}
}

/** The menu readings of `readModules` against the expansion: each display
 *  condition, case list menu item label and media map as Nova writes it. */
function acceptMenus(
	ctx: ReadContext,
	app: DraftApp,
	moduleOf: (uniqueId: string) => JsonObject | undefined,
	formOf: (xmlns: string) => JsonObject | undefined,
): void {
	const doc = ctx.doc as BlueprintDoc;
	const langs = appLanguageCodes(ctx);
	const stored = rawModules(ctx);
	const folded = new Set(app.foldedMenus.map((one) => one.menu));
	const listed = caseListMenus(ctx);
	for (const module of app.modules) {
		if (folded.has(module) || doc.modules[module.uuid] === undefined) continue;
		if (ctx.accounting.hasFindingAt(module.place)) continue;
		const source = stored[module.index] ?? NO_ENTRIES;
		const ours = moduleOf(module.uniqueId);
		const unrecognized = (name: string) =>
			ctx.accounting.circumstance("unrecognized", module.place, { name });
		if (ours === undefined) {
			unrecognized(`schema:${module.docType}`);
			continue;
		}
		const own = doc.modules[module.uuid];
		if (
			!sameDisplayCondition(
				ctx,
				doc,
				{
					entity: "module",
					uuid: module.uuid,
					slot: "module_display_condition",
				},
				source.module_filter,
				ours.module_filter,
			)
		) {
			unrecognized(`schema:${module.docType}.module_filter`);
			continue;
		}
		if (
			own?.icon !== undefined &&
			!sameJson(
				keptMediaPaths(
					ctx,
					shownBlockMedia((k) => source[k], "media_image", langs),
				),
				shownBlockMedia((k) => ours[k], "media_image", langs),
			)
		)
			unrecognized(`schema:${module.docType}.media_image`);
		if (
			own?.audioLabel !== undefined &&
			!sameJson(
				keptMediaPaths(
					ctx,
					shownBlockMedia((k) => source[k], "media_audio", langs),
				),
				shownBlockMedia((k) => ours[k], "media_audio", langs),
			)
		)
			unrecognized(`schema:${module.docType}.media_audio`);
		if (
			listed.has(module) &&
			!ctx.accounting.hasFindingAt(caseListPlaceOf(module))
		) {
			const listUnrecognized = (name: string) =>
				ctx.accounting.circumstance("unrecognized", caseListPlaceOf(module), {
					name,
				});
			const sourceList = isJsonObject(source.case_list)
				? source.case_list
				: NO_ENTRIES;
			const ourList = isJsonObject(ours.case_list)
				? ours.case_list
				: NO_ENTRIES;
			// Each label as the reading holds it (`modules.ts::heldLabel`).
			const sourceLabel = heldLabel(
				ctx,
				caseListLabelAsBuilt(labelMap(sourceList.label), langs),
				"case-list-menu-item-label",
			);
			const ourLabel = heldLabel(
				ctx,
				caseListLabelAsBuilt(
					withReadTranslations(
						ctx,
						caseListMenuItemLabelUnit({ ...own, uuid: module.uuid }),
						labelMap(ourList.label),
					),
					langs,
				),
				"case-list-menu-item-label",
			);
			if (
				sourceLabel === undefined ||
				ourLabel === undefined ||
				!sameJson(sourceLabel.texts, ourLabel.texts)
			)
				listUnrecognized("schema:CaseList.label");
			const item = own?.caseListMenuItem;
			if (
				item?.icon !== undefined &&
				!sameJson(
					keptMediaPaths(
						ctx,
						shownBlockMedia((k) => sourceList[k], "media_image", langs),
					),
					shownBlockMedia((k) => ourList[k], "media_image", langs),
				)
			)
				listUnrecognized("schema:CaseList.media_image");
			if (
				item?.audioLabel !== undefined &&
				!sameJson(
					keptMediaPaths(
						ctx,
						shownBlockMedia((k) => sourceList[k], "media_audio", langs),
					),
					shownBlockMedia((k) => ourList[k], "media_audio", langs),
				)
			)
				listUnrecognized("schema:CaseList.media_audio");
		}
		for (const form of module.forms) {
			if (ctx.accounting.hasFindingAt(form.place)) continue;
			const ownForm = doc.forms[form.uuid];
			const ourForm = formOf(form.xmlns);
			if (ownForm === undefined || ourForm === undefined) continue;
			const formUnrecognized = (name: string) =>
				ctx.accounting.circumstance("unrecognized", form.place, { name });
			if (
				!sameDisplayCondition(
					ctx,
					doc,
					{ entity: "form", uuid: form.uuid, slot: "form_display_condition" },
					form.json.peek("form_filter"),
					ourForm.form_filter,
				)
			)
				formUnrecognized(`schema:${form.docType}.form_filter`);
			if (
				ownForm.icon !== undefined &&
				!sameJson(
					keptMediaPaths(
						ctx,
						shownBlockMedia((k) => form.json.peek(k), "media_image", langs),
					),
					shownBlockMedia((k) => ourForm[k], "media_image", langs),
				)
			)
				formUnrecognized(`schema:${form.docType}.media_image`);
			if (
				ownForm.audioLabel !== undefined &&
				!sameJson(
					keptMediaPaths(
						ctx,
						shownBlockMedia((k) => form.json.peek(k), "media_audio", langs),
					),
					shownBlockMedia((k) => ourForm[k], "media_audio", langs),
				)
			)
				formUnrecognized(`schema:${form.docType}.media_audio`);
		}
	}
}
