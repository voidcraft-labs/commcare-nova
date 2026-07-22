/**
 * Right-rail width constants, shared by the chat sidebar and the builder
 * layout so chat and the docked inspector always resolve to the SAME width
 * (selecting something to inspect must never reflow the canvas).
 *
 * The rail no longer coordinates a claim/portal: the inspector is rendered
 * directly from shared selection state by `ChatSidebar` via
 * `components/builder/inspector/activeInspector.tsx`. See
 * `components/builder/CLAUDE.md` § Inspector rail.
 */

/** Resting builder-rail width on roomy desktops. */
export const INSPECTOR_RAIL_WIDTH = 360;

/** Keep both sidebars open on a narrow desktop without reducing the workbench
 * to a phone-width sliver. Inspector bodies are container-responsive, and chat
 * remains a comfortable message column at this width. */
export const COMPACT_INSPECTOR_RAIL_WIDTH = 300;
export const COMPACT_BUILDER_RAIL_BREAKPOINT = 1200;
