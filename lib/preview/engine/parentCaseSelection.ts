// lib/preview/engine/parentCaseSelection.ts
//
// When the running app asks for a menu's parent case
// (`Module.parentCaseModuleUuid`), and what a case chosen for it goes on to.
// Both are CommCare Core's reading of the datums the suite prints
// (`formLinkProjection.ts::entrySessionDatums`, `::caseListSessionDatums`),
// replayed by `menuDatumReplay.ts`, and both platforms read them alike:
// Formplayer's `MenuSessionRunnerService` and Android's
// `HomeScreenBaseActivity` each ask `CommCareSession.getNeededData` what the
// session needs next.
//
// Every entry a menu holds that chooses a case chooses its parent chain
// first, root first (`formLinkProjection.ts::entrySessionDatums`), and a
// registration or a survey chooses none. So a menu asks for its parent case
// before it lists anything only where every entry it lists asks for that
// datum first (`getDataNeededByAllEntries`); where one does not, Core lists
// the menu (`STATE_COMMAND_ID`) and asks for the parent case after the
// command of an entry that needs it, a form's or the case list entry's.
//
// A case chosen for a datum goes on at the row unless the datum names a
// details screen (`detail-confirm`). Formplayer reads `hasDetails` from the
// needed datum's long detail (`EntityListResponse`, `EntityScreen.getLongDetail`
// over `mNeededDatum`), and the Web Apps client's row selects at once without
// one (`menus/views.js::CaseView.rowClick`); Android's `EntitySelectActivity`
// returns the row without one (`mNoDetailMode`, `onEntitySelected`). A basic
// entry gives a details screen to its own case's datum alone, never to a
// parent case's (`formLinkProjection.ts::selectableDatums`), and an
// advanced entry keeps a parent load's where an open action indexes it.

import {
	caseListSessionDatums,
	entrySessionDatums,
	type FormLinkProjectionContext,
	formLinkProjectionContext,
} from "@/lib/commcare/formLinkProjection";
import type { SessionDatum } from "@/lib/commcare/session";
import {
	type BlueprintDoc,
	type MenuScreen,
	moduleHasOwnScreen,
	type Uuid,
} from "@/lib/domain";
import {
	collectedBefore,
	collectSharedDatums,
	screenEntryDatums,
} from "./menuDatumReplay";

const contexts = new WeakMap<BlueprintDoc, FormLinkProjectionContext>();
const askedFirst = new WeakMap<BlueprintDoc, Map<Uuid, boolean>>();

function contextOf(doc: BlueprintDoc): FormLinkProjectionContext {
	let ctx = contexts.get(doc);
	if (ctx === undefined) {
		ctx = formLinkProjectionContext(doc, { entryMetadataOnly: true });
		contexts.set(doc, ctx);
	}
	return ctx;
}

/** The modules whose cases the module's entries choose before its own, its
 *  `parentCaseModuleUuid` and that one's, and so on. */
function parentChain(doc: BlueprintDoc, moduleUuid: Uuid): Set<Uuid> {
	const chain = new Set<Uuid>();
	for (
		let current = doc.modules[moduleUuid]?.parentCaseModuleUuid;
		current !== undefined &&
		current !== moduleUuid &&
		!chain.has(current) &&
		doc.modules[current] !== undefined;
		current = doc.modules[current]?.parentCaseModuleUuid
	)
		chain.add(current);
	return chain;
}

/** Whether the datum is a parent case of the module's: a selection a module
 *  of its parent chain supplies. */
function isParentDatum(
	ctx: FormLinkProjectionContext,
	chain: ReadonlySet<Uuid>,
	datum: SessionDatum,
): boolean {
	const source = ctx.selectionSourceModules.get(datum);
	return source !== undefined && chain.has(source);
}

/**
 * Whether the running app asks for the module's parent case before it lists
 * the module's own screen: Core, having collected on each screen on the way
 * what all of its entries need first, collects a parent case on the module's
 * screen before it asks for a command. False for a module with no screen of
 * its own and for one with no parent case, and where the screen lists its
 * entries first: a registration or a survey beside a follow-up, which ask
 * for no case, so the parent case is asked for after the follow-up's
 * command.
 */
export function previewParentCaseBeforeMenu(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
): boolean {
	let byModule = askedFirst.get(doc);
	if (byModule === undefined) {
		byModule = new Map();
		askedFirst.set(doc, byModule);
	}
	const held = byModule.get(moduleUuid);
	if (held !== undefined) return held;
	const chain = parentChain(doc, moduleUuid);
	let asks = false;
	if (chain.size > 0 && moduleHasOwnScreen(doc, moduleUuid)) {
		const ctx = contextOf(doc);
		const screen: MenuScreen = { kind: "menu", moduleUuid };
		const before = collectedBefore(doc, ctx, screen);
		const collected = new Set(before);
		const entries = screenEntryDatums(doc, ctx, screen);
		collectSharedDatums(entries, collected);
		asks = entries.some((datums) =>
			datums.some(
				(datum) =>
					!before.has(datum.id) &&
					collected.has(datum.id) &&
					isParentDatum(ctx, chain, datum),
			),
		);
	}
	byModule.set(moduleUuid, asks);
	return asks;
}

/**
 * Whether a case chosen on `selectorModuleUuid`'s list for a parent case
 * `requestingModuleUuid`'s entry asks for opens its details before it goes
 * on: where the datum the list chooses for names a details screen. The entry
 * is the form the worker chose before the case where `formUuid` is one of
 * the requesting module's forms; else, where the module asks for its parent
 * case before listing its screen (`previewParentCaseBeforeMenu`), the first
 * entry its screen lists, whose datum Core reads (`getNeededDatum` takes the
 * command's first entry); else its case list entry.
 */
export function previewParentCaseListHasDetails(
	doc: BlueprintDoc,
	request: {
		readonly selectorModuleUuid: Uuid;
		readonly requestingModuleUuid: Uuid;
		readonly formUuid?: Uuid;
	},
): boolean {
	const { selectorModuleUuid, requestingModuleUuid, formUuid } = request;
	if (doc.modules[requestingModuleUuid] === undefined) return false;
	const ctx = contextOf(doc);
	const entries: (readonly SessionDatum[])[] =
		formUuid !== undefined &&
		(doc.formOrder[requestingModuleUuid] ?? []).includes(formUuid)
			? [entrySessionDatums(doc, ctx, requestingModuleUuid, formUuid)]
			: previewParentCaseBeforeMenu(doc, requestingModuleUuid)
				? screenEntryDatums(doc, ctx, {
						kind: "menu",
						moduleUuid: requestingModuleUuid,
					})
				: [caseListSessionDatums(doc, ctx, requestingModuleUuid)];
	for (const datums of entries) {
		const datum = datums.find(
			(candidate) =>
				ctx.selectionSourceModules.get(candidate) === selectorModuleUuid,
		);
		if (datum !== undefined) return datum.detailConfirm !== undefined;
	}
	return false;
}

/**
 * Whether a running leaf of the module asks for its parent case before it
 * shows: a case list of the module (Results, Search, Details, data review),
 * which lists the cases under the chosen parent, or a form whose entry
 * chooses the parent chain. A form whose entry asks for no case, a
 * registration or a survey, opens without one, as its entry holds no parent
 * datum.
 */
export function previewLeafAsksParentCase(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
	formUuid?: Uuid,
): boolean {
	const chain = parentChain(doc, moduleUuid);
	if (chain.size === 0) return false;
	if (formUuid === undefined) return true;
	if (!(doc.formOrder[moduleUuid] ?? []).includes(formUuid)) return false;
	const ctx = contextOf(doc);
	return entrySessionDatums(doc, ctx, moduleUuid, formUuid).some((datum) =>
		isParentDatum(ctx, chain, datum),
	);
}
