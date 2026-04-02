/**
 * Frosted-glass popover — Level 1 (base layer).
 * Semi-transparent with backdrop blur for primary floating panels. The outer border is
 * structural; the inset box-shadow is a bright inner highlight that catches the light
 * like a glass edge.
 */
export const POPOVER_GLASS =
  'rounded-xl bg-[rgba(10,10,26,0.4)] backdrop-blur-[10px] [-webkit-backdrop-filter:blur(10px)] border border-white/[0.06] shadow-[inset_0_0_0_1px_rgba(200,200,255,0.18),0_24px_48px_rgba(0,0,0,0.5)]'

/**
 * Elevated popover — Level 2 (stacked above glass).
 * Nearly opaque surface with no backdrop-blur, so it sits cleanly on top of a frosted
 * panel without glass-on-glass interference.
 */
export const POPOVER_ELEVATED =
  'rounded-xl bg-[rgba(16,16,36,0.95)] border border-white/[0.06] shadow-[inset_0_0_0_1px_rgba(200,200,255,0.15),0_16px_40px_rgba(0,0,0,0.6)]'

/**
 * Shared hover/focus styling for header navigation icon buttons.
 * Used by NavLinks (BuilderLayout), AccountMenu fallback, and builds page admin link.
 */
export const NAV_ICON_CLASS =
  'p-1.5 text-nova-text-muted hover:text-nova-text transition-colors rounded-lg hover:bg-nova-surface'
