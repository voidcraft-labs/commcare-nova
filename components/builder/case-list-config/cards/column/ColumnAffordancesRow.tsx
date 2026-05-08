// components/builder/case-list-config/cards/column/ColumnAffordancesRow.tsx
//
// Compact affordances row mounted on every column card by
// `ColumnEditor`. Surfaces the per-column controls that bind to the
// common optional slots (`sort`, `visibleInList`, `visibleInDetail`)
// — slots that exist on every kind, including `calculated` (which
// has no `field` row to attach them to). Sitting at the card-shell
// level keeps the affordances uniform across the six kinds without
// each per-kind card replicating the same toggles.
//
// Three controls compose left-to-right:
//
//   1. **Visibility** — list / detail eye-toggle pair. Default
//      state for both surfaces is "visible"; toggling off renders
//      the icon dimmed + struck-through to communicate "this column
//      will not appear here".
//   2. **Sort direction toggle** — neutral / ascending / descending
//      tri-state cycling. The neutral state means "this column is
//      not sorted"; clicking it sets `sort = { direction: "asc",
//      priority: <next-available> }`. Subsequent clicks flip
//      direction; "Remove sort" lives on the priority badge.
//   3. **Sort priority badge** — read-only ordinal indicator
//      ("1st", "2nd", "3rd", …) when `sort.priority` is set; no
//      badge when the column isn't sorted. Carries a small "×"
//      affordance to clear the column's sort.

"use client";
import { Icon, type IconifyIcon } from "@iconify/react/offline";
import tablerArrowsSort from "@iconify-icons/tabler/arrows-sort";
import tablerEye from "@iconify-icons/tabler/eye";
import tablerEyeOff from "@iconify-icons/tabler/eye-off";
import tablerSortAscending from "@iconify-icons/tabler/sort-ascending";
import tablerSortDescending from "@iconify-icons/tabler/sort-descending";
import tablerX from "@iconify-icons/tabler/x";
import type { Column, ColumnSort, SortDirection } from "@/lib/domain";

interface ColumnAffordancesRowProps {
	readonly value: Column;
	readonly onChange: (next: Column) => void;
	/**
	 * Total number of columns currently carrying a sort slot. Used to
	 * pick the priority for a freshly-toggled column — appended at the
	 * end of the existing priority order so the user's first sorted
	 * column is the primary, second is the first tiebreaker, etc.
	 */
	readonly sortedColumnCount: number;
	/**
	 * The column's resolved sort priority position among its sorted
	 * peers (1-based). Drives the priority badge. `undefined` when the
	 * column isn't sorted.
	 */
	readonly sortPriorityPosition: number | undefined;
}

/**
 * Per-column affordances row. Visibility eye-pair + sort direction
 * toggle + sort priority badge. Mounts in the card shell's header
 * chrome; the card body handles per-kind config (field picker,
 * threshold, expression, etc.).
 */
export function ColumnAffordancesRow({
	value,
	onChange,
	sortedColumnCount,
	sortPriorityPosition,
}: ColumnAffordancesRowProps) {
	const visibleInList = value.visibleInList ?? true;
	const visibleInDetail = value.visibleInDetail ?? true;
	const sort = value.sort;

	// Visibility toggles — the canonical "visible" default is absent;
	// toggling off writes `false`, toggling back to visible writes
	// `undefined` so the slot returns to absent and the parse stays
	// clean. (Schema reads `visibleInList ?? true` so absent ≡ true.)
	const setVisibleInList = (next: boolean) => {
		onChange(replaceSlot(value, "visibleInList", next ? undefined : false));
	};
	const setVisibleInDetail = (next: boolean) => {
		onChange(replaceSlot(value, "visibleInDetail", next ? undefined : false));
	};

	// Sort cycle — undefined → asc → desc → undefined. The first
	// transition from undefined picks `priority = sortedColumnCount`
	// so the new column lands at the end of the existing priority
	// order. Subsequent transitions preserve the existing priority.
	const cycleSort = () => {
		if (sort === undefined) {
			onChange(
				replaceSlot(value, "sort", {
					direction: "asc" as SortDirection,
					priority: sortedColumnCount,
				}),
			);
			return;
		}
		if (sort.direction === "asc") {
			onChange(
				replaceSlot(value, "sort", {
					...sort,
					direction: "desc" as SortDirection,
				}),
			);
			return;
		}
		// desc → cleared. Removing the column from the sort priority
		// order leaves a gap (e.g. priorities [0, 1, 2] with column at
		// `1` cleared becomes [0, 2]); the wire emitter sorts by
		// priority ascending and the gap is harmless. The editor's
		// "drag to reorder priority" affordance is the sort-priority
		// pill stack rendered at the top of the Display section.
		onChange(replaceSlot(value, "sort", undefined));
	};

	const clearSort = () => {
		onChange(replaceSlot(value, "sort", undefined));
	};

	return (
		<div className="inline-flex items-center gap-1">
			<VisibilityToggle
				label="Visible in list"
				icon={tablerEye}
				offIcon={tablerEyeOff}
				visible={visibleInList}
				onChange={setVisibleInList}
			/>
			<VisibilityToggle
				label="Visible in detail"
				icon={tablerEye}
				offIcon={tablerEyeOff}
				visible={visibleInDetail}
				onChange={setVisibleInDetail}
				/* Detail toggle uses a slightly muted accent so the user
				 * reads "list" as the primary surface and "detail" as the
				 * secondary; the icons themselves are identical so AT
				 * users disambiguate via the labels alone. */
				accent="detail"
			/>
			<SortDirectionToggle sort={sort} onCycle={cycleSort} />
			{sort !== undefined && sortPriorityPosition !== undefined && (
				<SortPriorityBadge
					position={sortPriorityPosition}
					onClear={clearSort}
				/>
			)}
		</div>
	);
}

interface VisibilityToggleProps {
	readonly label: string;
	readonly icon: IconifyIcon;
	readonly offIcon: IconifyIcon;
	readonly visible: boolean;
	readonly onChange: (next: boolean) => void;
	readonly accent?: "list" | "detail";
}

/**
 * Single visibility toggle — eye / eye-off icon pair. Off state
 * dims the icon; on state surfaces the violet accent. The list /
 * detail discriminator changes the accent tone subtly so a glance
 * at the row tells you which surface each toggle controls.
 */
function VisibilityToggle({
	label,
	icon,
	offIcon,
	visible,
	onChange,
	accent = "list",
}: VisibilityToggleProps) {
	const tone = visible
		? accent === "list"
			? "text-nova-violet-bright"
			: "text-nova-violet-bright/70"
		: "text-nova-text-muted/40";
	return (
		<button
			type="button"
			onClick={() => onChange(!visible)}
			aria-label={`${label}: ${visible ? "on" : "off"}`}
			aria-pressed={visible}
			title={`${label} (${visible ? "on" : "off"})`}
			className={`rounded p-1 hover:bg-white/[0.05] transition-colors cursor-pointer ${tone}`}
		>
			<Icon icon={visible ? icon : offIcon} width="13" height="13" />
		</button>
	);
}

interface SortDirectionToggleProps {
	readonly sort: ColumnSort | undefined;
	readonly onCycle: () => void;
}

/**
 * Tri-state sort direction toggle. Neutral arrow-double icon means
 * "not sorted"; ascending / descending arrow icons mean the column
 * carries a sort directive. Clicking cycles
 * undefined → asc → desc → undefined.
 */
function SortDirectionToggle({ sort, onCycle }: SortDirectionToggleProps) {
	const direction = sort?.direction;
	const icon =
		direction === "asc"
			? tablerSortAscending
			: direction === "desc"
				? tablerSortDescending
				: tablerArrowsSort;
	const tone =
		direction !== undefined
			? "text-nova-violet-bright"
			: "text-nova-text-muted/40";
	const label =
		direction === "asc"
			? "Sorted ascending"
			: direction === "desc"
				? "Sorted descending"
				: "Not sorted";
	return (
		<button
			type="button"
			onClick={onCycle}
			aria-label={`Sort: ${label}. Click to cycle.`}
			title={label}
			className={`rounded p-1 hover:bg-white/[0.05] transition-colors cursor-pointer ${tone}`}
		>
			<Icon icon={icon} width="13" height="13" />
		</button>
	);
}

interface SortPriorityBadgeProps {
	readonly position: number;
	readonly onClear: () => void;
}

/**
 * Read-only sort priority badge. Renders the column's ordinal
 * position among sorted columns ("1st", "2nd", …) with a small "×"
 * affordance to clear the column's sort. Drag-to-reorder priority
 * lives in the Display section's sort priority pill stack — this
 * badge is purely indicative.
 */
function SortPriorityBadge({ position, onClear }: SortPriorityBadgeProps) {
	const ordinal = formatOrdinal(position);
	return (
		<span
			role="status"
			aria-label={`Sort priority: ${ordinal}`}
			className="inline-flex items-center gap-1 rounded-md border border-nova-violet/30 bg-nova-violet/[0.08] px-1.5 py-0.5 text-[10px] font-medium text-nova-violet-bright"
		>
			<span>{ordinal}</span>
			<button
				type="button"
				onClick={onClear}
				aria-label="Clear sort"
				title="Clear sort"
				className="rounded text-nova-violet-bright/60 hover:text-nova-violet-bright hover:bg-nova-violet/[0.15] transition-colors cursor-pointer"
			>
				<Icon icon={tablerX} width="10" height="10" />
			</button>
		</span>
	);
}

/**
 * Format a 1-based position as an English ordinal suffix
 * ("1st", "2nd", "3rd", "4th", …). The wire layer never sees this;
 * it's purely the editor's at-a-glance signal.
 */
function formatOrdinal(n: number): string {
	const tens = n % 100;
	const ones = n % 10;
	if (tens >= 11 && tens <= 13) return `${n}th`;
	if (ones === 1) return `${n}st`;
	if (ones === 2) return `${n}nd`;
	if (ones === 3) return `${n}rd`;
	return `${n}th`;
}

// ── Slot replacement helper ────────────────────────────────────────
//
// `replaceSlot` produces a fresh column object with one optional slot
// replaced. Drops keys whose value is `undefined` so the output shape
// round-trips equal to a freshly-built column under the schema's
// strip-mode parse. The discriminated-union narrowing is preserved
// because `Pick<Column, "kind" | ...required>` is intersected with
// the rebuilt optional slots — TypeScript carries the kind discriminator
// through the spread on each arm.

function replaceSlot<K extends "sort" | "visibleInList" | "visibleInDetail">(
	value: Column,
	key: K,
	next: Column[K],
): Column {
	const baseSlots = {
		sort: value.sort,
		visibleInList: value.visibleInList,
		visibleInDetail: value.visibleInDetail,
	};
	const merged = { ...baseSlots, [key]: next };
	const optional: {
		sort?: ColumnSort;
		visibleInList?: boolean;
		visibleInDetail?: boolean;
	} = {};
	if (merged.sort !== undefined) optional.sort = merged.sort;
	if (merged.visibleInList !== undefined)
		optional.visibleInList = merged.visibleInList;
	if (merged.visibleInDetail !== undefined)
		optional.visibleInDetail = merged.visibleInDetail;
	// Strip the existing optional slots from the incoming column then
	// reapply the cleaned set. This keeps the column's required slots
	// (uuid, kind, field/header/etc.) intact while ensuring the
	// optional slots reflect the updated state — including absent keys
	// when the user toggles a slot back to its default.
	const {
		sort: _s,
		visibleInList: _v,
		visibleInDetail: _d,
		...required
	} = value;
	return { ...required, ...optional } as Column;
}
