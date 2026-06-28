// components/builder/appTree/TreeRowDelete.tsx
//
// The two-step, no-dialog delete for a tree row (module / form) — the app-card
// delete pattern (`components/ui/AppCard.tsx`) shrunk to fit a tree row. Idle:
// a hover-revealed trash icon. Armed (after one click): a rose "Delete?" pill +
// a cancel ✕; a second click on "Delete?" runs `onDelete`. Moving the pointer
// off the cluster disarms. The parent row must set `group` for the idle reveal.
//
// `onDelete` dispatches `removeModule` / `removeForm` — both gated mutations, so
// the removal is one undo entry (⌘Z restores it, including a module's cascaded
// forms/fields + any retired case-type record).

"use client";
import { Icon } from "@iconify/react/offline";
import tablerTrash from "@iconify-icons/tabler/trash";
import tablerX from "@iconify-icons/tabler/x";
import { useState } from "react";
import { Tooltip } from "@/components/ui/Tooltip";
import { useCanEdit } from "@/lib/session/hooks";

export function TreeRowDelete({
	label,
	onDelete,
}: {
	/** Accessible label, e.g. "Delete module" / "Delete form". */
	readonly label: string;
	/** Runs the (gated) removal; returns whether it committed. A success
	 *  unmounts this row with the deleted entity, so on `false` (the gate
	 *  refused — e.g. a still-referenced case type can't be retired) we disarm
	 *  rather than leave the row stuck in its "Delete?" state. */
	readonly onDelete: () => boolean;
}) {
	const [armed, setArmed] = useState(false);
	const canEdit = useCanEdit();

	// A view-only Project member can't delete rows — render nothing.
	if (!canEdit) return null;

	if (armed) {
		return (
			// Leaving the confirm cluster cancels the pending delete, so an armed
			// row never lingers once the pointer moves on.
			// biome-ignore lint/a11y/noStaticElementInteractions: the inner buttons carry the interaction + labels; this only resets hover state
			<span
				className="flex shrink-0 items-center gap-1"
				onMouseLeave={() => setArmed(false)}
			>
				<button
					type="button"
					aria-label={`Confirm — ${label}`}
					onClick={(e) => {
						e.stopPropagation();
						if (!onDelete()) setArmed(false);
					}}
					className="cursor-pointer rounded-md bg-nova-rose/15 px-2 py-1 text-[11px] font-medium text-nova-rose transition-colors hover:bg-nova-rose/25"
				>
					Delete?
				</button>
				<button
					type="button"
					aria-label="Cancel delete"
					onClick={(e) => {
						e.stopPropagation();
						setArmed(false);
					}}
					className="cursor-pointer rounded-md p-1 text-nova-text-muted transition-colors hover:bg-white/[0.06] hover:text-nova-text"
				>
					<Icon icon={tablerX} width="12" height="12" />
				</button>
			</span>
		);
	}

	return (
		<Tooltip content={label}>
			<button
				type="button"
				aria-label={label}
				onClick={(e) => {
					e.stopPropagation();
					setArmed(true);
				}}
				className="shrink-0 cursor-pointer rounded-md p-1 text-nova-text-muted opacity-0 transition-colors hover:bg-nova-rose/[0.08] hover:text-nova-rose focus-visible:opacity-100 group-hover:opacity-100"
			>
				<Icon icon={tablerTrash} width="15" height="15" />
			</button>
		</Tooltip>
	);
}
