/**
 * Shared text styling per field type — single source of truth for both
 * static rendering (LabelContent) and TipTap editor (InlineTextEditor).
 * Ensures flipbook parity between edit and interact modes at compile time
 * rather than relying on manual string duplication.
 */

export type FieldType = "label" | "hint";

export const FIELD_STYLES = {
	label: "text-sm font-medium text-nova-text",
	hint: "text-xs text-nova-text-muted",
} as const satisfies Record<FieldType, string>;
