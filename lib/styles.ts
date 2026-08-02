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
 *  itself is the bug this centralizes away. */
export const MENU_ITEM_BASE =
	"flex min-h-11 w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm whitespace-normal outline-none select-none transition-colors";

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
