// components/builder/detail/moduleSettings/menuScreenCopy.ts
//
// The words a person reads about where a menu's forms show: the switch's
// line and its added lines, the note under the menu's name and appearance
// while it shows its forms in the menu above, and the tree row's second line.
// Each is read from the one projection of which screen lists what
// (`lib/domain/menuScreens.ts`), so the copy and the running app cannot
// disagree.

import {
	type MenuScreenSource,
	type Module,
	menuAbove,
	menuScreenOf,
	moduleHasCaseListMenuItem,
	moduleShowsFormsInMenuAbove,
	screenCaseFirstBlocker,
	type Uuid,
} from "@/lib/domain";

export const MENU_SCREEN_HEADING = "Where its forms show";
export const MENU_SCREEN_SWITCH = "Show its forms in the menu above";

/** The menu above, as a sentence names it: "the app's first menu" or the
 *  parent's name. */
export function menuAboveName(doc: MenuScreenSource, moduleUuid: Uuid): string {
	const above = menuAbove(doc, moduleUuid);
	return above.kind === "first-menu" ? "the app's first menu" : above.name;
}

export interface MenuScreenLines {
	/** What the switch's state does, in one sentence. */
	readonly line: string;
	/** What else follows from it, each its own sentence. */
	readonly added: readonly string[];
}

/** The switch's line and its added lines, for the menu as the document
 *  holds it. */
export function menuScreenLines(
	doc: MenuScreenSource,
	moduleUuid: Uuid,
): MenuScreenLines {
	const module = doc.modules[moduleUuid];
	const name = module?.name ?? "";
	const parentUuid = module?.parentModuleUuid;
	const parent = parentUuid === undefined ? undefined : doc.modules[parentUuid];
	if (!moduleShowsFormsInMenuAbove(module))
		return {
			line:
				parent === undefined
					? `Workers open ${name} from the app's first menu, then choose a form.`
					: `Workers open ${name} from ${parent.name}, then choose a form.`,
			added: [],
		};
	const above = menuAboveName(doc, moduleUuid);
	const added: string[] = [];
	if (module !== undefined && moduleHasCaseListMenuItem(module))
		added.push("Its case list entry shows there too.");
	if (
		parent === undefined &&
		Object.values(doc.modules).some(
			(candidate) => candidate.parentModuleUuid === moduleUuid,
		)
	)
		added.push("Its submenus show on the app's first menu too.");
	/* The screen above lists forms first because of a form of this menu. */
	const blocker = screenCaseFirstBlocker(doc, menuScreenOf(doc, moduleUuid));
	if (
		blocker?.reason === "opens-without-a-case" &&
		blocker.moduleUuid === moduleUuid &&
		blocker.formUuid !== undefined
	)
		added.push(
			`Workers choose a form in ${above} before any case, because ${doc.forms[blocker.formUuid]?.name ?? ""} opens without one.`,
		);
	return {
		line: `${name}'s forms show in ${above}, and ${name} has no entry of its own.`,
		added,
	};
}

/** The note under the menu's name, icon and spoken label while it shows its
 *  forms in the menu above; undefined while it has its own screen. */
export function menuScreenKeptAppearanceNote(
	doc: MenuScreenSource,
	moduleUuid: Uuid,
): string | undefined {
	const module = doc.modules[moduleUuid];
	if (!moduleShowsFormsInMenuAbove(module)) return undefined;
	return `${module?.name ?? ""}'s name, icon and spoken label aren't shown while its forms show in ${menuAboveName(doc, moduleUuid)}. They're kept for when it has its own screen again.`;
}

/** The tree row's quiet second line, read from the menu and its parent
 *  alone so a row subscribes to nothing wider; undefined while the menu has
 *  its own screen. The menu above is the parent where it keeps its screen,
 *  else the app's first menu (`menuScreens.ts::menuAbove`). */
export function menuScreenTreeLine(
	module: Pick<Module, "formsInMenuAbove"> | undefined,
	parent: Pick<Module, "formsInMenuAbove" | "name"> | undefined,
): string | undefined {
	if (!moduleShowsFormsInMenuAbove(module)) return undefined;
	return `Forms show in ${
		parent === undefined || moduleShowsFormsInMenuAbove(parent)
			? "the app's first menu"
			: parent.name
	}`;
}
