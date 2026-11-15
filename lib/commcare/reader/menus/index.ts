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
import type { BlueprintDoc } from "@/lib/domain";
import { caseListMenuItemLabelUnit } from "../../emissionPlan";
import { expandDoc } from "../../expander";
import { firstMenuSharedCaseFrames } from "../../validator/rules/formsInMenuAbove";
import { rootSelectionTakesNewCase } from "../../validator/rules/parentSelection";
import { type Claim, defineClaims, refuse } from "../claims";
import type { DraftApp, ReadContext } from "../context";
import { readerDefect } from "../defects";
import { isJsonObject, sameJson } from "../jsonCursor";
import { appPlace } from "../place";
import { keptMediaPaths, readProjectionInputs } from "../projectionInputs";
import { provisionalDocument } from "../provisional";
import { sameXPathText } from "../syntaxCompare";
import {
	acceptAfterSubmit,
	readAfterSubmit,
	settleAfterSubmit,
} from "./afterSubmit";
import { readEntryPoints, settleEntryPoints } from "./entryPoints";
import {
	appLanguageCodes,
	caseListLabelAsBuilt,
	caseListMenus,
	caseListPlaceOf,
	labelMap,
	rawModules,
	readModules,
	settleModules,
	withReadTranslations,
} from "./modules";
import { shownBlockMedia } from "./navMedia";
import { readCaseListRegistration, settleRegistrations } from "./registration";

export { registerLinkExpressions } from "./afterSubmit";

const SHARED_FIRST_MENU_CASE =
	"forms-and-case-writes/form-link-or-endpoint-through-a-first-menu-that-shares-one-case";

const CLAIMS = defineClaims("menus", {
	sharedFirstMenuCase: refuse(SHARED_FIRST_MENU_CASE, "schema:Form.form_links"),
	sharedFirstMenuCaseAdvanced: refuse(
		SHARED_FIRST_MENU_CASE,
		"schema:AdvancedForm.form_links",
	),
	newCaseTakesRootCase: refuse(
		"menus-and-case-lists/child-menu-form-creating-a-case-of-the-type-its-root-s-first-form-chooses",
		null,
	),
}) satisfies Record<string, Claim>;

/** Step 2: every menu's registration block, its own navigation, each form's
 *  workflow word and every deep link, in that order. */
export function readMenus(ctx: ReadContext, app: DraftApp): void {
	readCaseListRegistration(ctx, app);
	readModules(ctx, app);
	readAfterSubmit(ctx, app);
	readEntryPoints(ctx, app);
}

/**
 * Step 4, once every menu's structure and every form's case operations are in
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
	} catch {
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

/** Whether two stored XPath values are one: both absent or blank, or one tree. */
function sameFilter(a: unknown, b: unknown): boolean {
	const blank = (value: unknown) =>
		typeof value !== "string" || value.trim() === "";
	if (blank(a) || blank(b)) return blank(a) && blank(b);
	return sameXPathText(a as string, b as string);
}

/**
 * Step 6, the last settle: every bound menu slot written (display conditions,
 * parent selections, workflow words, link conditions and carried values),
 * the app expanded once under the reading's inputs, and every menu reading
 * accepted against that one expansion: registration blocks and folded menus,
 * case list menu item labels, media, display conditions, after-submit and
 * deep links.
 */
export function settleMenus(ctx: ReadContext, app: DraftApp): void {
	if (ctx.doc === undefined) return;
	settleModules(ctx);
	for (const module of app.modules)
		for (const form of module.forms) settleAfterSubmit(ctx, form);
	const doc = ctx.doc as BlueprintDoc;
	let expansion: HqApplication;
	try {
		expansion = expandDoc(doc, readProjectionInputs(ctx));
	} catch {
		ctx.accounting.defect(
			appPlace(),
			"schema:Application.modules",
			readerDefect.emissionThrew(appPlace(), "expandDoc"),
		);
		return;
	}
	const modules = expansion.modules as unknown as readonly JsonObject[];
	const moduleOf = (uniqueId: string) =>
		modules.find((one) => one.unique_id === uniqueId) as
			| HqApplication["modules"][number]
			| undefined;
	const formOf = (xmlns: string) =>
		modules
			.flatMap((one) =>
				Array.isArray(one.forms) ? one.forms.filter(isJsonObject) : [],
			)
			.find((one) => one.xmlns === xmlns);
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
		const source = stored[module.index] ?? {};
		const ours = moduleOf(module.uniqueId);
		const unrecognized = (name: string) =>
			ctx.accounting.circumstance("unrecognized", module.place, { name });
		if (ours === undefined) {
			unrecognized(`schema:${module.docType}`);
			continue;
		}
		const own = doc.modules[module.uuid];
		if (!sameFilter(source.module_filter, ours.module_filter)) {
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
			const sourceList = isJsonObject(source.case_list) ? source.case_list : {};
			const ourList = isJsonObject(ours.case_list) ? ours.case_list : {};
			if (
				!sameJson(
					caseListLabelAsBuilt(labelMap(sourceList.label), langs),
					caseListLabelAsBuilt(
						withReadTranslations(
							ctx,
							caseListMenuItemLabelUnit({ ...own, uuid: module.uuid }),
							labelMap(ourList.label),
						),
						langs,
					),
				)
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
			if (!sameFilter(form.json.peek("form_filter"), ourForm.form_filter))
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
