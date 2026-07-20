/**
 * Frosted-glass popover — Level 1 (base layer).
 * Semi-transparent with backdrop blur for primary floating panels. The outer border is
 * structural; the inset box-shadow is a bright inner highlight that catches the light
 * like a glass edge.
 */
export const POPOVER_GLASS =
	"nova-floating rounded-xl bg-[rgba(10,10,26,0.4)] backdrop-blur-[10px] [-webkit-backdrop-filter:blur(10px)] border border-white/[0.06] shadow-[inset_0_0_0_1px_rgba(200,200,255,0.18),0_24px_48px_rgba(0,0,0,0.5)]";

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
 * dead space right of the items. */

/** Base classes shared by every menu item (normal, disabled, submenu trigger). */
export const MENU_ITEM_BASE =
	"flex min-h-11 w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm outline-none select-none transition-colors";

/** Interactive item: subtle highlight on hover / keyboard focus. */
export const MENU_ITEM_CLS = `${MENU_ITEM_BASE} cursor-pointer text-nova-text data-[highlighted]:bg-white/[0.06] data-disabled:cursor-not-allowed data-disabled:opacity-40`;

/** Disabled item: muted and non-interactive. */
export const MENU_ITEM_DISABLED_CLS = `${MENU_ITEM_BASE} opacity-40 cursor-not-allowed`;

/** Glass-surfaced positioner (L1) for primary menu panels. */
export const MENU_POSITIONER_CLS =
	"nova-floating outline-none z-popover-top rounded-xl bg-[rgba(10,10,26,0.4)] backdrop-blur-[10px] [-webkit-backdrop-filter:blur(10px)] outline-[rgba(255,255,255,0.06)] outline-1 shadow-[inset_0_0_0_1px_rgba(200,200,255,0.18),0_24px_48px_rgba(0,0,0,0.5)]";

/** Elevated positioner (L2) for submenus stacked above a glass parent. */
export const MENU_SUBMENU_POSITIONER_CLS =
	"nova-floating outline-none z-popover-top rounded-xl bg-[rgba(16,16,36,0.95)] outline-[rgba(255,255,255,0.06)] outline-1 shadow-[inset_0_0_0_1px_rgba(200,200,255,0.15),0_16px_40px_rgba(0,0,0,0.6)]";

/** Popup animation — scale + fade entrance/exit via Base UI data attributes. */
export const MENU_POPUP_CLS =
	"overflow-hidden rounded-xl p-1 origin-[var(--transform-origin)] transition-[transform,scale,opacity] data-[ending-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0";

/* ── Base UI Popover shared styles ────────────────────────────────────────
 * Same glass/elevated surface split as menus (see constraint above). */

/** Glass-surfaced positioner (L1) for primary popover panels. */
export const POPOVER_POSITIONER_GLASS_CLS =
	"nova-floating outline-none z-popover rounded-xl bg-[rgba(10,10,26,0.4)] backdrop-blur-[10px] [-webkit-backdrop-filter:blur(10px)] outline-[rgba(255,255,255,0.06)] outline-1 shadow-[inset_0_0_0_1px_rgba(200,200,255,0.18),0_24px_48px_rgba(0,0,0,0.5)]";

/** Elevated positioner (L2) for popovers stacked above a glass parent. */
export const POPOVER_POSITIONER_ELEVATED_CLS =
	"nova-floating outline-none z-popover rounded-xl bg-[rgba(16,16,36,0.95)] outline-[rgba(255,255,255,0.06)] outline-1 shadow-[inset_0_0_0_1px_rgba(200,200,255,0.15),0_16px_40px_rgba(0,0,0,0.6)]";

/** Popup animation — scale + fade, same motion language as menus. */
export const POPOVER_POPUP_CLS =
	"rounded-xl origin-[var(--transform-origin)] transition-[transform,scale,opacity] data-[ending-style]:scale-[0.97] data-[ending-style]:opacity-0 data-[starting-style]:scale-[0.97] data-[starting-style]:opacity-0";
