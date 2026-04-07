/**
 * Frosted-glass popover — Level 1 (base layer).
 * Semi-transparent with backdrop blur for primary floating panels. The outer border is
 * structural; the inset box-shadow is a bright inner highlight that catches the light
 * like a glass edge.
 */
export const POPOVER_GLASS =
	"rounded-xl bg-[rgba(10,10,26,0.4)] backdrop-blur-[10px] [-webkit-backdrop-filter:blur(10px)] border border-white/[0.06] shadow-[inset_0_0_0_1px_rgba(200,200,255,0.18),0_24px_48px_rgba(0,0,0,0.5)]";

/**
 * Elevated popover — Level 2 (stacked above glass).
 * Nearly opaque surface with no backdrop-blur, so it sits cleanly on top of a frosted
 * panel without glass-on-glass interference.
 */
export const POPOVER_ELEVATED =
	"rounded-xl bg-[rgba(16,16,36,0.95)] border border-white/[0.06] shadow-[inset_0_0_0_1px_rgba(200,200,255,0.15),0_16px_40px_rgba(0,0,0,0.6)]";

/* ── Base UI Menu shared styles ────────────────────────────────────────────
 * Used by ContextualEditorHeader (overflow menu) and QuestionTypePickerPopup
 * (insertion menu). Glass surface lives on the Positioner because Base UI's
 * `will-change: transform` on that layer creates a compositing boundary —
 * placing `backdrop-filter` on a descendant would sample the empty layer. */

/** Base classes shared by every menu item (normal, disabled, submenu trigger). */
export const MENU_ITEM_BASE =
	"flex w-full items-center gap-2.5 px-3 py-2 text-sm outline-none select-none transition-colors";

/** Interactive item: subtle highlight on hover / keyboard focus. */
export const MENU_ITEM_CLS = `${MENU_ITEM_BASE} text-nova-text cursor-pointer data-[highlighted]:bg-white/[0.06]`;

/** Disabled item: muted and non-interactive. */
export const MENU_ITEM_DISABLED_CLS = `${MENU_ITEM_BASE} opacity-40 cursor-not-allowed`;

/** Glass-surfaced positioner (L1) for primary menu panels. */
export const MENU_POSITIONER_CLS =
	"outline-none z-popover-top rounded-xl bg-[rgba(10,10,26,0.4)] backdrop-blur-[10px] [-webkit-backdrop-filter:blur(10px)] outline-[rgba(255,255,255,0.06)] outline-1 shadow-[inset_0_0_0_1px_rgba(200,200,255,0.18),0_24px_48px_rgba(0,0,0,0.5)]";

/** Elevated positioner (L2) for submenus stacked above a glass parent. */
export const MENU_SUBMENU_POSITIONER_CLS =
	"outline-none z-popover-top rounded-xl bg-[rgba(16,16,36,0.95)] outline-[rgba(255,255,255,0.06)] outline-1 shadow-[inset_0_0_0_1px_rgba(200,200,255,0.15),0_16px_40px_rgba(0,0,0,0.6)]";

/** Popup animation — scale + fade entrance/exit via Base UI data attributes. */
export const MENU_POPUP_CLS =
	"overflow-hidden rounded-xl origin-[var(--transform-origin)] transition-[transform,scale,opacity] data-[ending-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0";
