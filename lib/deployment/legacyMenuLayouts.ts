/**
 * Menu layouts a deployment made before Nova wrote them.
 *
 * An HQ update merges the body over the stored app
 * (`models/applications.py::_merge_source_into_app`), so while Nova sent no
 * `use_grid_menus` or `grid_form_menus`, a choice a person saved in HQ stayed
 * there through every publish, and a menu's `display_style` was the one
 * thing a publish reset. Nova now writes all three, so the first publish
 * over such a target would replace what HQ holds. Neither HQ read can show
 * that as a change since the baseline when both agree, so the comparison is
 * of HQ's choices against the document's, under this target's menu ids,
 * until a baseline accounts for the layouts (`AppOwnership.menuLayouts`).
 */

import type { HqAppSource } from "@/lib/commcare/hq/appSource";
import { replacedMenuLayouts } from "@/lib/commcare/hq/menuLayoutReplacements";
import type { WireIdentity } from "@/lib/commcare/wireIdentity";
import type { BlueprintDoc } from "@/lib/domain";
import type { AppOwnership } from "./types";

/**
 * The choices on CommCare HQ this publish would replace that no baseline
 * accounts for, as lines the app's change lists before anything else.
 * Empty once a baseline accounts for menu layouts.
 */
export function legacyMenuLayoutLines(input: {
	readonly doc: BlueprintDoc;
	readonly identity: WireIdentity;
	readonly source: HqAppSource;
	readonly ownership: AppOwnership | null;
}): readonly string[] {
	if (input.ownership?.menuLayouts) return [];
	return replacedMenuLayouts(input.doc, input.identity, input.source);
}

/**
 * The ownership a baseline records over `source`: it accounts for menu
 * layouts only where the document holds every choice the read shows. An
 * import body always writes them, so the read after a publish or the read
 * an adoption or bring-in took is what decides it.
 */
export function observedMenuLayoutOwnership(
	ownership: AppOwnership,
	doc: BlueprintDoc,
	identity: WireIdentity,
	source: HqAppSource,
): AppOwnership {
	if (
		!ownership.menuLayouts ||
		replacedMenuLayouts(doc, identity, source).length === 0
	)
		return ownership;
	const { menuLayouts: _unrepresented, ...accounted } = ownership;
	return accounted;
}

/** Said after the parts of an app change that lists layout replacements. */
export const MENU_LAYOUT_REPLACEMENT_NOTE =
	"Nova now publishes menu layouts. You can keep these choices by matching them in App settings and in each menu's settings, or publish over them.";
