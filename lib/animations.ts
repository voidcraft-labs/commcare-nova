/**
 * Shared popover entrance animation — Web Animations API variant.
 *
 * Used by all FloatingPortal-based dropdowns and panels (AccountMenu,
 * FormTypeDropdown, FormSettingsPanel, AppConnectSettings) for a
 * consistent scale-up + fade entrance.
 *
 * The matching Motion (framer-motion) variant lives in ExportDropdown
 * and other AnimatePresence-based components as inline props — those
 * use the same values but in the Motion config format.
 */

/** Scale-up + fade entrance keyframes for Web Animations API. */
export const POPOVER_ENTER_KEYFRAMES: Keyframe[] = [
  { opacity: 0, transform: 'scale(0.97) translateY(-4px)' },
  { opacity: 1, transform: 'scale(1) translateY(0)' },
]

/** 150ms ease-out timing for popover entrance. */
export const POPOVER_ENTER_OPTIONS: KeyframeAnimationOptions = {
  duration: 150,
  easing: 'cubic-bezier(0.4, 0, 0.2, 1)',
}
