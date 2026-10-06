/**
 * Shared text styling per field type: single source of truth for both
 * static rendering (LabelContent) and TipTap editor (InlineTextEditor).
 * Ensures flipbook parity between edit and preview modes at compile time
 * rather than relying on manual string duplication.
 */

export type FieldType = "label" | "hint";

export const FIELD_STYLES = {
	label: "text-sm font-medium text-nova-text",
	hint: "text-xs text-nova-text-muted",
} as const satisfies Record<FieldType, string>;

/** Shared header geometry for edit and live group/repeat containers. Repeat
 * metadata takes a full row so it cannot crowd the authored title. */
export const CONTAINER_HEADER_STYLES = {
	row: "grid grid-cols-[2.75rem_minmax(0,1fr)] items-center gap-x-2 gap-y-1",
	toggle:
		"nova-focusable pointer-events-auto inline-flex h-11 w-11 touch-manipulation items-center justify-center rounded-lg text-nova-text-muted transition-colors hover:text-nova-text",
	title: "min-w-0",
	metadata:
		"col-span-2 flex min-w-0 flex-wrap items-center gap-1 text-xs font-medium text-nova-text-muted",
} as const;
