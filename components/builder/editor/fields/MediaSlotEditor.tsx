// components/builder/editor/fields/MediaSlotEditor.tsx
//
// Field-editor adapter for a `Media` slot (`label_media` / `hint_media`
// / `help_media` / `validate_msg_media`). Renders the same labeled-item
// shape every other addable property uses — an uppercase header with the
// control beneath it (cf. `XPathEditor` / `RequiredEditor`) — including a
// property-level delete in the header. Media has no "type then blur"
// gesture that would clear it the way a text/XPath editor self-removes on
// empty, so without an explicit delete an added-but-empty media property
// would be stranded with no way back to its Add Property pill. The
// control itself is the standalone `MediaSlot`, offering all three kinds
// since a question message can carry any of them.

"use client";

import { Icon } from "@iconify/react/offline";
import tablerTrash from "@iconify-icons/tabler/trash";
import { MediaSlot } from "@/components/builder/media/MediaSlot";
import type { Field } from "@/lib/domain";
import type { FieldEditorComponentProps } from "@/lib/domain/kinds";
import { MEDIA_KINDS, type Media } from "@/lib/domain/multimedia";

export function MediaSlotEditor<F extends Field, K extends keyof F>({
	field,
	value,
	onChange,
	label,
	keyName,
}: FieldEditorComponentProps<F, K>) {
	return (
		<div data-field-id={String(keyName)}>
			<div className="flex items-center justify-between mb-1">
				<span className="text-xs text-nova-text-muted uppercase tracking-wider flex items-center gap-1.5 min-w-0">
					{label}
				</span>
				{/* Property-level delete — always available so the property can
				    be removed the instant it's added, attached or not. Clearing
				    the whole value returns the entry to the Add Property pill;
				    the per-kind chip removes handle one attachment at a time. */}
				<button
					type="button"
					onClick={() => onChange(undefined as F[K])}
					aria-label={`Remove ${label}`}
					className="shrink-0 p-0.5 text-nova-text-muted hover:text-nova-rose transition-colors cursor-pointer"
				>
					<Icon icon={tablerTrash} width="12" height="12" />
				</button>
			</div>
			<MediaSlot
				value={value as Media | undefined}
				onChange={(next) => onChange(next as F[K])}
				kinds={MEDIA_KINDS}
				// Field uuid (rename-stable) + the `<slot>_media` key — the
				// staged-upload identity for this message slot.
				slotKey={`field:${field.uuid}:${String(keyName)}`}
				// Clean group label (no string surgery): the slot's controls
				// name themselves by kind ("Remove image"); this names the
				// group they belong to ("Label Media").
				ariaLabel={label}
			/>
		</div>
	);
}
