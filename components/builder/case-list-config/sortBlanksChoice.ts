// components/builder/case-list-config/sortBlanksChoice.ts
//
// Where a sort rule puts blank values when the author turns its direction.
// A rule stores `blanks` only where it differs from its direction's own, so
// "the author chose this side" cannot be read from the rule alone: an
// ascending rule with blanks last, turned to descending, stores no `blanks`.
// The default order composer remembers the side the person last picked with
// the Blank values control and hands it here.

import {
	type ColumnSort,
	columnSort,
	type SortBlanks,
	type SortDirection,
} from "@/lib/domain";

/** The rule a change of direction writes: `picked` where the person picked a
 *  side with the control, else the rule's stored `blanks`, else the new
 *  direction's own. */
export function blanksAfterDirectionChange(
	rule: ColumnSort,
	direction: SortDirection,
	picked: SortBlanks | undefined,
): ColumnSort {
	return columnSort(direction, rule.priority, picked ?? rule.blanks);
}
