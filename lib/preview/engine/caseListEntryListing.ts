// lib/preview/engine/caseListEntryListing.ts
//
// Whether the running app lists a menu's case list entry
// (`Module.caseListMenuItem`) on the screen that lists it.
//
// The entry is a view command: it holds no form. CommCare Core lists a view
// only while the session still needs one of its datums
// (`MenuLoader.addRelevantCommandEntries`: `if (e.isView())`, skipped where
// `getNeededDatum(e) == null`), and Formplayer and Android both list a screen
// through `MenuLoader`. Before Core lists a screen it collects every datum the
// screen's entries all need first, one at a time
// (`CommCareSession.getNeededData` → `getDataNeededByAllEntries`), which is
// how a screen chooses its case first; the screens a worker passed through on
// the way collected theirs the same way. So on a screen that chose its case
// first the entry is listed only where its own datums go past what was
// collected, and choosing it then opens the list of the first one it still
// needs. The datums are the ones the suite prints
// (`formLinkProjection.ts::entrySessionDatums`, `::caseListSessionDatums`).

import {
	caseListSessionDatums,
	entrySessionDatums,
	type FormLinkProjectionContext,
	formLinkProjectionContext,
} from "@/lib/commcare/formLinkProjection";
import {
	type BlueprintDoc,
	type MenuScreen,
	menuScreenEntries,
	menuScreenOf,
	menuTileScreenOf,
	type Uuid,
} from "@/lib/domain";

const listedByDoc = new WeakMap<BlueprintDoc, Map<Uuid, boolean>>();

/**
 * Whether Core lists the module's case list entry on the screen that lists
 * it, as a device reaches that screen: every screen on the way to it, and the
 * screen itself, having collected the datums all of its entries need first.
 * True where one of the entry's datums is still missing then.
 */
export function caseListEntryStillNeedsDatum(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
): boolean {
	let byModule = listedByDoc.get(doc);
	if (byModule === undefined) {
		byModule = new Map();
		listedByDoc.set(doc, byModule);
	}
	const held = byModule.get(moduleUuid);
	if (held !== undefined) return held;
	const ctx = formLinkProjectionContext(doc, { entryMetadataOnly: true });
	const collected = new Set<string>();
	for (const screenModuleUuid of screensOnTheWay(
		doc,
		menuScreenOf(doc, moduleUuid),
	))
		collectSharedDatums(
			screenEntryDatums(doc, ctx, {
				kind: "menu",
				moduleUuid: screenModuleUuid,
			}),
			collected,
		);
	const needs = caseListSessionDatums(doc, ctx, moduleUuid).some(
		(datum) => !collected.has(datum.id),
	);
	byModule.set(moduleUuid, needs);
	return needs;
}

/** The modules whose screens a worker opens to reach `screen`, top first,
 *  `screen`'s own last. The first menu collects nothing: Core asks for a
 *  command there before any entry is chosen. */
function screensOnTheWay(doc: BlueprintDoc, screen: MenuScreen): Uuid[] {
	const path: Uuid[] = [];
	let current: MenuScreen | undefined = screen;
	while (current?.kind === "menu" && !path.includes(current.moduleUuid)) {
		path.unshift(current.moduleUuid);
		current = menuTileScreenOf(doc, current.moduleUuid);
	}
	return path;
}

/** The datum list of every entry the screen's command holds, relevant or
 *  not, as `CommCareSession.getEntriesForCommand` gathers them: each form
 *  and case list entry the screen lists (`menuScreens.ts::menuScreenEntries`). */
function screenEntryDatums(
	doc: BlueprintDoc,
	ctx: FormLinkProjectionContext,
	screen: MenuScreen,
): (readonly { readonly id: string }[])[] {
	return menuScreenEntries(doc, screen).flatMap((entry) => {
		if (entry.kind === "form")
			return [entrySessionDatums(doc, ctx, entry.moduleUuid, entry.formUuid)];
		if (entry.kind === "case-list")
			return [caseListSessionDatums(doc, ctx, entry.moduleUuid)];
		return [];
	});
}

/** Core's `getDataNeededByAllEntries`, asked until it has no answer: while
 *  every entry's first missing datum is one datum, the session collects it. */
function collectSharedDatums(
	lists: readonly (readonly { readonly id: string }[])[],
	collected: Set<string>,
): void {
	for (;;) {
		let shared: string | undefined;
		for (const list of lists) {
			const missing = list.find((datum) => !collected.has(datum.id));
			if (missing === undefined) return;
			if (shared === undefined) shared = missing.id;
			else if (missing.id !== shared) return;
		}
		if (shared === undefined) return;
		collected.add(shared);
	}
}
