// components/builder/editor/fields/MediaSlotEditor.tsx
//
// Field-editor adapter for a `Media` slot (`label_media` / `help_media`).
// Renders the same labeled-item
// shape every other addable property uses: a quiet section header with the
// control beneath it (cf. `XPathEditor` / `RequiredEditor`), including a
// property-level delete in the header. Media has no "type then blur"
// gesture that would clear it the way a text/XPath editor self-removes on
// empty, so without an explicit delete an added-but-empty media property
// would be stranded with no way back to its Add Property pill. The
// control itself is the standalone `MediaSlot`, offering all three kinds
// since a question message can carry any of them.

"use client";

import { Icon } from "@iconify/react/offline";
import tablerTrash from "@iconify-icons/tabler/trash";
import { INSPECTOR_LABEL_CLS } from "@/components/builder/inspector/inspectorChrome";
import { useShowsSourceLanguage } from "@/components/builder/localization/BuilderLocalizationProvider";
import { FieldLanguageMedia } from "@/components/builder/media/FieldLanguageMedia";
import { useStoredField } from "@/lib/doc/hooks/useEntity";
import type { Field } from "@/lib/domain";
import type { FieldEditorComponentProps } from "@/lib/domain/kinds";
import { mediaSlotHoldsLanguageFiles } from "./mediaSlotModel";

export function MediaSlotEditor<F extends Field, K extends keyof F>({
	field,
	onChange,
	label,
	keyName,
}: FieldEditorComponentProps<F, K>) {
	const shared = useShowsSourceLanguage();
	/* Removing the slot clears every language's files, so it is offered only
	 * where no language holds files of its own, read from the stored field. */
	const hasTranslations = mediaSlotHoldsLanguageFiles(
		useStoredField(field.uuid),
		keyName === "help_media" ? "help_media" : "label_media",
	);
	return (
		<div data-field-id={String(keyName)}>
			<div className="flex items-center justify-between mb-1.5">
				<span
					className={`${INSPECTOR_LABEL_CLS} flex items-center gap-1.5 min-w-0`}
				>
					{label}
				</span>
				{/* Property-level delete: always available so the property can
				    be removed the instant it's added, attached or not. Clearing
				    the whole value returns the entry to the Add Property pill;
				    the per-kind chip removes handle one attachment at a time. */}
				{shared && !hasTranslations && (
					<button
						type="button"
						onClick={() => onChange(undefined as F[K])}
						aria-label={`Remove ${label}`}
						className="shrink-0 p-0.5 text-nova-text-muted hover:text-nova-rose transition-colors cursor-pointer"
					>
						<Icon icon={tablerTrash} width="12" height="12" />
					</button>
				)}
			</div>
			<FieldLanguageMedia
				fieldUuid={field.uuid}
				slot={keyName === "help_media" ? "help" : "label"}
				// Field uuid (rename-stable) + the `<slot>_media` key: the
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
