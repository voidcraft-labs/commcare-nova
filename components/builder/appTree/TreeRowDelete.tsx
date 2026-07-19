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
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/shadcn/button";
import { SimpleTooltip } from "@/components/shadcn/tooltip";
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
	const idleRef = useRef<HTMLButtonElement>(null);
	const confirmRef = useRef<HTMLButtonElement>(null);
	const restoreFocusRef = useRef(false);
	const canEdit = useCanEdit();

	useEffect(() => {
		if (armed) {
			confirmRef.current?.focus();
			return;
		}
		if (restoreFocusRef.current) {
			restoreFocusRef.current = false;
			idleRef.current?.focus();
		}
	}, [armed]);

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
				<Button
					ref={confirmRef}
					type="button"
					variant="destructive"
					size="xl"
					aria-label={`Confirm ${label.toLowerCase()}`}
					onKeyDown={(event) => event.stopPropagation()}
					onClick={(e) => {
						e.stopPropagation();
						if (!onDelete()) setArmed(false);
					}}
					className="h-11 rounded-lg px-3 text-xs"
				>
					Delete
				</Button>
				<Button
					type="button"
					variant="ghost"
					size="icon-lg"
					aria-label="Cancel delete"
					onKeyDown={(event) => event.stopPropagation()}
					onClick={(e) => {
						e.stopPropagation();
						setArmed(false);
					}}
					className="size-11 text-nova-text-muted hover:bg-white/[0.06] hover:text-nova-text"
				>
					<Icon icon={tablerX} width="16" height="16" />
				</Button>
			</span>
		);
	}

	return (
		<SimpleTooltip content={label}>
			<Button
				ref={idleRef}
				type="button"
				variant="ghost"
				size="icon-lg"
				aria-label={label}
				onKeyDown={(event) => event.stopPropagation()}
				onClick={(e) => {
					e.stopPropagation();
					restoreFocusRef.current = true;
					setArmed(true);
				}}
				className="size-11 shrink-0 text-nova-text-muted opacity-0 hover:bg-nova-rose/[0.08] hover:text-nova-rose focus-visible:opacity-100 group-hover:opacity-100"
			>
				<Icon icon={tablerTrash} width="16" height="16" />
			</Button>
		</SimpleTooltip>
	);
}
