/**
 * NoWriterAdvisoryChip — the canvas signal for a workflow dead-end
 * (`lib/doc/noWriterAdvisories.ts`): this field's visibility or
 * validation reads a case property nothing in the app writes (and no
 * external declaration says another system does).
 *
 * Passive and persistent by design — mid-build the state is normal
 * (the gate lands before its writer form), so the chip must read as
 * "open question", never as an error. It is height-neutral (absolute
 * overlay pinned to the row's top-right corner) because the flipbook
 * requires edit and live rows at identical geometry, and edit-only
 * layout would drift the scroll sync. Clicking is the row's own
 * select — the inspector's advisory section carries the details and
 * the resolution.
 *
 * Rendered by `EditableFieldWrapper` in edit mode only, so it covers
 * every wrapped row shape (leaf fields, hidden cards, group headers)
 * without per-row wiring.
 */

"use client";
import { Icon } from "@iconify/react/offline";
import tablerPencilOff from "@iconify-icons/tabler/pencil-off";
import { SimpleTooltip } from "@/components/shadcn/tooltip";
import { useCarrierNoWriterAdvisories } from "@/lib/doc/hooks/useNoWriterAdvisories";
import type { Uuid } from "@/lib/domain";

export function NoWriterAdvisoryChip({ fieldUuid }: { fieldUuid: Uuid }) {
	const advisories = useCarrierNoWriterAdvisories(fieldUuid);
	if (advisories.length === 0) return null;
	const first = advisories[0];
	const names = advisories.map((a) => a.property).join(", ");
	return (
		<SimpleTooltip
			content={`This field's behavior depends on ${names}, which no form in this app sets. Records can only reach the gated state if something outside the app writes ${advisories.length === 1 ? "it" : "them"}. Select the field to resolve.`}
		>
			<span className="pointer-events-auto absolute -top-2 right-3 z-10 flex items-center gap-1 rounded-full border border-nova-amber/40 bg-nova-void px-1.5 py-0.5 font-mono text-[10px] text-nova-amber">
				<Icon
					icon={tablerPencilOff}
					width="11"
					height="11"
					className="shrink-0"
				/>
				waits on {first.property}
				{advisories.length > 1 ? ` +${advisories.length - 1}` : ""}
			</span>
		</SimpleTooltip>
	);
}
