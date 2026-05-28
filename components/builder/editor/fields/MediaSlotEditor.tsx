// components/builder/editor/fields/MediaSlotEditor.tsx
//
// Field-editor adapter for a `Media` slot. Bridges the editor's
// `FieldEditorComponentProps` contract (value + onChange keyed to one
// field property) to the standalone `MediaSlot` primitive. Every
// message-slot media key (`label_media`, `hint_media`, `help_media`,
// `required_msg_media`, `validate_msg_media`) renders through this —
// all three kinds (image / audio / video) are offered, since a
// question message can carry any of them.

"use client";

import { MediaSlot } from "@/components/builder/media/MediaSlot";
import type { Field } from "@/lib/domain";
import type { FieldEditorComponentProps } from "@/lib/domain/kinds";
import { MEDIA_KINDS, type Media } from "@/lib/domain/multimedia";

export function MediaSlotEditor<F extends Field, K extends keyof F>({
	value,
	onChange,
}: FieldEditorComponentProps<F, K>) {
	return (
		<MediaSlot
			value={value as Media | undefined}
			onChange={(next) => onChange(next as F[K])}
			kinds={MEDIA_KINDS}
		/>
	);
}
