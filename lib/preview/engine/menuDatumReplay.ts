// lib/preview/engine/menuDatumReplay.ts
//
// CommCare Core's walk through the menus a worker passes, replayed over the
// datums the suite prints (`formLinkProjection.ts::entrySessionDatums`,
// `::caseListSessionDatums`). Before Core lists a screen it collects every
// datum all of the screen's entries need first, one at a time
// (`CommCareSession.getNeededData` → `getDataNeededByAllEntries`), and the
// screens a worker passed through on the way collected theirs the same way.
// `caseListEntryListing.ts` and `parentCaseSelection.ts` read Core's session
// through it.

import {
	caseListSessionDatums,
	entrySessionDatums,
	type FormLinkProjectionContext,
} from "@/lib/commcare/formLinkProjection";
import type { SessionDatum } from "@/lib/commcare/session";
import {
	type BlueprintDoc,
	type MenuScreen,
	menuScreenEntries,
	menuTileScreenOf,
	type Uuid,
} from "@/lib/domain";

/** The modules whose screens a worker opens to reach `screen`, top first,
 *  `screen`'s own last. The first menu collects nothing: Core asks for a
 *  command there before any entry is chosen. */
export function screensOnTheWay(doc: BlueprintDoc, screen: MenuScreen): Uuid[] {
	const path: Uuid[] = [];
	let current: MenuScreen | undefined = screen;
	while (current?.kind === "menu" && !path.includes(current.moduleUuid)) {
		path.unshift(current.moduleUuid);
		current = menuTileScreenOf(doc, current.moduleUuid);
	}
	return path;
}

/** The datum list of every entry the screen's command holds, relevant or
 *  not, in the order the screen lists them, as
 *  `CommCareSession.getEntriesForCommand` gathers them: each form and case
 *  list entry the screen lists (`menuScreens.ts::menuScreenEntries`). */
export function screenEntryDatums(
	doc: BlueprintDoc,
	ctx: FormLinkProjectionContext,
	screen: MenuScreen,
): (readonly SessionDatum[])[] {
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
export function collectSharedDatums(
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

/** The datums the session holds once it has listed each screen on the way to
 *  `screen`, `screen`'s own not included. */
export function collectedBefore(
	doc: BlueprintDoc,
	ctx: FormLinkProjectionContext,
	screen: MenuScreen,
): Set<string> {
	const collected = new Set<string>();
	const path = screensOnTheWay(doc, screen);
	for (const moduleUuid of path.slice(0, -1))
		collectSharedDatums(
			screenEntryDatums(doc, ctx, { kind: "menu", moduleUuid }),
			collected,
		);
	return collected;
}
