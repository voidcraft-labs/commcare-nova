/**
 * Frosted-glass popover — Level 1 (base layer).
 * Semi-transparent with backdrop blur for primary floating panels. The outer border is
 * structural; the inset box-shadow is a bright inner highlight that catches the light
 * like a glass edge.
 */
export const POPOVER_GLASS =
	"nova-floating rounded-xl bg-nova-glass backdrop-blur-[10px] [-webkit-backdrop-filter:blur(10px)] border border-nova-glass-border shadow-glass";

/* ── Base UI Menu shared styles ────────────────────────────────────────────
 * Glass/elevated surfaces live on the Positioner, not the Popup — Base UI's
 * `will-change: transform` on the Positioner creates a compositing boundary,
 * so `backdrop-filter` on a descendant would sample that empty layer instead
 * of the page behind it. This constraint applies to all floating elements
 * (menus, popovers, tooltips).
 *
 * These constants are the ONE definition of Nova's floating chrome: the
 * shadcn wrappers (`components/shadcn/{dropdown-menu,select,popover}.tsx`)
 * and the raw Base UI call sites both consume them, so the two layers cannot
 * drift apart visually.
 *
 * Every constant carries `nova-floating`: scroll containers inside a floating
 * surface drop the app-wide reserved scrollbar gutter (`globals.css`) — these
 * surfaces are self-sized, so a reserved gutter beside a short list reads as
 * dead space right of the items.
 *
 * These constants describe a SURFACE — glass or elevated, its radius, blur,
 * outline and shadow. They deliberately carry no `z-*`: which plane a floating
 * element occupies depends on where it is opened from, not on what it looks
 * like, so the positioner states it (`FLOATING_LAYER_CLS`). Folding a tier back
 * in here would mean every call site that wants a different plane appends a
 * second `z-*` and leaves tailwind-merge to arbitrate the pair — which is how a
 * Select popup meant for `z-modal` shipped at `z-popover-top`, behind the very
 * dialog that opened it. */

/**
 * The one plane every portaled floating surface occupies.
 *
 * Base UI portals menus, selects, popovers and comboboxes to `document.body`,
 * so they all stack in the root context against dialogs. Co-planar with a
 * dialog (`z-modal`) is what lets a select opened INSIDE one float above it,
 * with portal order — later mount paints later — settling any tie between two
 * floating surfaces. Tooltips are the deliberate exception: `z-tooltip` sits
 * above this, because a tooltip on a control inside a dialog must never be
 * occluded by it.
 *
 * The named tiers below `z-modal` (`z-popover`, `z-popover-top`) are for
 * IN-FLOW overlays — an absolutely-positioned notice that stacks inside its own
 * ancestor rather than escaping to the body.
 */
export const FLOATING_LAYER_CLS = "z-modal";

/** Base classes shared by every menu item (normal, disabled, submenu trigger).
 *  An item wraps and grows past the 44px touch floor when its content needs a
 *  second line (a label plus a description or a disabled reason), and its
 *  content stays vertically centered at every height — so a one-line item in a
 *  menu whose other items are taller does not sit top-heavy in its own row.
 *  Call sites style content, never this box: an item that re-aligns or re-pads
 *  itself is the bug this centralizes away.
 *
 *  `text-left` is not decoration. A row rendered as a native `<button>` gets
 *  the UA's `text-align: center`, which is invisible on a single-line item
 *  that shrinks to fit and unmistakable on a two-line one. */
export const MENU_ITEM_BASE =
	"flex min-h-11 w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm whitespace-normal outline-none select-none transition-colors";

/** Interactive item: subtle highlight on hover / keyboard focus. */
export const MENU_ITEM_CLS = `${MENU_ITEM_BASE} cursor-pointer text-nova-text data-[highlighted]:bg-white/[0.06] data-disabled:cursor-not-allowed data-disabled:opacity-(--disabled-opacity)`;

/** Disabled item: muted and non-interactive. */
export const MENU_ITEM_DISABLED_CLS = `${MENU_ITEM_BASE} opacity-(--disabled-opacity) cursor-not-allowed`;

/**
 * A row inside a POPOVER that acts as a menu item.
 *
 * Base UI menus get their items from `MENU_ITEM_CLS` above, but the account,
 * Project and Help menus are popovers whose rows are plain buttons and links.
 * They are the same affordance and must read the same: the design system
 * publishes one menu-item treatment (14px, `--nova-text`, a white/0.06
 * highlight), and rendering one of the three through the Button primitive put
 * a 15px secondary-coloured label beside two 14px ones in the same header.
 *
 * A menu row is not a Button: it composes from the same base as the real menu
 * items, so its highlight is the same inset 12px row rather than a square
 * stripe running edge to edge. The panel supplies the inset with `p-1`, the
 * way `MENU_POPUP_CLS` does.
 */
export const POPOVER_ROW_CLS = `${MENU_ITEM_BASE} cursor-pointer text-nova-text not-disabled:hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-(--disabled-opacity)`;

/** Glass-surfaced positioner (L1) for primary menu panels. */
export const MENU_POSITIONER_CLS =
	"nova-floating outline-none rounded-xl bg-nova-glass backdrop-blur-[10px] [-webkit-backdrop-filter:blur(10px)] outline-nova-glass-border outline-1 shadow-glass";

/** Elevated positioner (L2) for submenus stacked above a glass parent. */
export const MENU_SUBMENU_POSITIONER_CLS =
	"nova-floating outline-none rounded-xl bg-nova-overlay outline-nova-glass-border outline-1 shadow-overlay-float";

/** Popup animation — scale + fade entrance/exit via Base UI data attributes. */
export const MENU_POPUP_CLS =
	"overflow-hidden rounded-xl p-1 origin-[var(--transform-origin)] transition-[transform,scale,opacity] data-[ending-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0";

/* ── Base UI Popover shared styles ────────────────────────────────────────
 * Same glass/elevated surface split as menus (see constraint above). */

/** Glass-surfaced positioner (L1) for primary popover panels. */
export const POPOVER_POSITIONER_GLASS_CLS =
	"nova-floating outline-none rounded-xl bg-nova-glass backdrop-blur-[10px] [-webkit-backdrop-filter:blur(10px)] outline-nova-glass-border outline-1 shadow-glass";

/** Elevated positioner (L2) for popovers stacked above a glass parent. */
export const POPOVER_POSITIONER_ELEVATED_CLS =
	"nova-floating outline-none rounded-xl bg-nova-overlay outline-nova-glass-border outline-1 shadow-overlay-float";

/** Popup animation — scale + fade, same motion language as menus. */
export const POPOVER_POPUP_CLS =
	"rounded-xl origin-[var(--transform-origin)] transition-[transform,scale,opacity] data-[ending-style]:scale-[0.97] data-[ending-style]:opacity-0 data-[starting-style]:scale-[0.97] data-[starting-style]:opacity-0";

/* ── Disclosure row ───────────────────────────────────────────────────────
 * The full-bleed "More settings" trigger that opens a collapsible section.
 * It is not a Button: it spans its container edge to edge, carries no inset
 * padding, and stays flat on hover, because it reveals content rather than
 * performing an action. It keeps the 44px floor and the one focus ring; its
 * content styles itself. */
export const DISCLOSURE_ROW_CLS =
	"nova-focusable group flex min-h-11 w-full cursor-pointer items-center gap-2 rounded-xl text-left";

/* ── Selectable rows, segments, and icons ─────────────────────────────────
 * A control that carries a SELECTED state: the structure sidebar's footer
 * destinations, the collapsed rail's icons, the App setup section tabs, the
 * inspector's segmented controls, the tile layout switch.
 *
 * None of these is a Button. A button performs an action and returns to
 * rest; these hold a state, and they are shaped by the strip or column they
 * live in rather than by the keycap. Three boxes share one skin, so a
 * selected tab and a selected sidebar row read as the same idea in
 * different geometry. Call sites style content, never the box.
 *
 * Radius follows what the control stands NEXT TO, which is the only thing an
 * eye can compare. A segment and a rail icon sit among buttons, so they take
 * the button's 18px; a row sits among menu items, so it takes their 12px. */
/* Selected still answers the pointer, and it answers the way everything else
 * does: one step toward light. A selected control that holds perfectly still
 * under the cursor is the only unresponsive thing on the screen, and the
 * shortcut of letting a neutral hover paint over the tint instead makes
 * pointing at the tab you are already on look like dimming it. */
const SELECTED_SKIN = `bg-nova-violet/15 font-medium text-nova-violet-bright shadow-[inset_0_0_0_1px_var(--nova-violet-hairline)] not-disabled:hover:bg-nova-violet/25`;
const IDLE_SKIN = `text-nova-text-secondary not-disabled:hover:bg-white/[0.06] not-disabled:hover:text-nova-text`;
const skin = (selected: boolean) => (selected ? SELECTED_SKIN : IDLE_SKIN);

/** Full-width row in a vertical list. Content aligns to the start and wraps. */
export function selectableRowCls(selected: boolean): string {
	return `${MENU_ITEM_BASE} nova-focusable cursor-pointer ${skin(selected)}`;
}

/** One segment of a horizontal strip. Shares the strip's width, never wraps. */
export function selectableSegmentCls(selected: boolean): string {
	return `nova-focusable flex min-h-11 min-w-0 cursor-pointer items-center justify-center gap-2 rounded-xl px-3 text-sm whitespace-nowrap outline-none transition-colors disabled:cursor-not-allowed disabled:opacity-(--disabled-opacity) ${skin(selected)}`;
}

/** Square icon control, for a collapsed rail where there is no room for a label. */
export function selectableIconCls(selected: boolean): string {
	return `nova-focusable flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-xl outline-none transition-colors ${skin(selected)}`;
}

/** One item in a menu, when the menu records a choice.
 *
 *  Base UI drives menu rows through `data-highlighted` rather than `:hover`, so
 *  the skin is spelled in that vocabulary. The highlight BRIGHTENS the selected
 *  tint rather than replacing it, which is the whole reason this exists: a
 *  selected background painted under `MENU_ITEM_CLS` is simply overwritten the
 *  moment the row is highlighted, so the one chosen item goes neutral under the
 *  pointer, and dropping the highlight to avoid that leaves the chosen item the
 *  only row in the menu that never responds. */
export function selectableMenuItemCls(selected: boolean): string {
	if (!selected) return MENU_ITEM_CLS;
	return `${MENU_ITEM_BASE} cursor-pointer ${SELECTED_SKIN} data-[highlighted]:bg-nova-violet/25`;
}

/* ── Full-bleed list row ──────────────────────────────────────────────────
 * The primary target filling a card row edge to edge: a case change, a
 * display field, a search field, the assigned-cases setting.
 *
 * Not a Button. Its corners are square because the card around it does the
 * clipping, and its focus ring is inset for the same reason. It grows with
 * its content and keeps the 44px floor.
 *
 * Pick by who owns the hover: `LIST_ROW_CLS` stays flat because the row it
 * fills lights up around it, while `LIST_ROW_INTERACTIVE_CLS` is the whole
 * row and lights up itself. Two rows both lighting up is the seam this
 * distinction exists to prevent. */
const LIST_ROW_BASE =
	"nova-focusable-inset flex min-h-11 w-full min-w-0 cursor-pointer items-center gap-2 px-4 py-3 text-left whitespace-normal outline-none transition-colors disabled:cursor-not-allowed disabled:opacity-(--disabled-opacity)";

export const LIST_ROW_CLS = LIST_ROW_BASE;

export const LIST_ROW_INTERACTIVE_CLS = `${LIST_ROW_BASE} not-disabled:hover:bg-white/[0.03]`;
