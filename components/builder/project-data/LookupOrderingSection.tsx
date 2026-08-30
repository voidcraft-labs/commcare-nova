/**
 * The Project-data inspector's keyboard- and touch-accessible ordering edit.
 *
 * The grid remains a semantic scan surface. Moving the selected UUID here
 * keeps cells selectable, gives each gesture a real 44px button, and leaves
 * focus on the same control when the refreshed order arrives.
 */
"use client";

import { Icon } from "@iconify/react/offline";
import tablerArrowDown from "@iconify-icons/tabler/arrow-down";
import tablerArrowLeft from "@iconify-icons/tabler/arrow-left";
import tablerArrowRight from "@iconify-icons/tabler/arrow-right";
import tablerArrowUp from "@iconify-icons/tabler/arrow-up";
import { useEffect, useRef } from "react";
import { Button } from "@/components/shadcn/button";
import type { LookupColumnId, LookupRowId } from "@/lib/domain/lookupIds";
import type { LookupTableSnapshot } from "@/lib/lookup/types";
import type { ProjectDataWorkspace } from "./ProjectDataWorkspaceProvider";
import { useLookupOrderingWrites } from "./useProjectDataWrites";

type LookupOrderingSectionProps =
	| {
			readonly kind: "column";
			readonly itemId: LookupColumnId;
			readonly table: LookupTableSnapshot;
			readonly workspace: ProjectDataWorkspace;
			readonly canEdit: boolean;
			readonly disabled?: boolean;
			readonly disabledReason?: string;
	  }
	| {
			readonly kind: "row";
			readonly itemId: LookupRowId;
			readonly table: LookupTableSnapshot;
			readonly workspace: ProjectDataWorkspace;
			readonly canEdit: boolean;
			readonly disabled?: boolean;
			readonly disabledReason?: string;
	  };

export function LookupOrderingSection(props: LookupOrderingSectionProps) {
	const { kind, itemId, table, workspace, canEdit } = props;
	const ordering = useLookupOrderingWrites(table, workspace.reload);
	const items = kind === "column" ? table.columns : table.rows;
	const position = items.findIndex((item) => item.id === itemId);
	const count = items.length;
	const locked = props.disabled === true || ordering.moving;
	const previousLabel = kind === "column" ? "Move left" : "Move up";
	const nextLabel = kind === "column" ? "Move right" : "Move down";
	const previousIcon = kind === "column" ? tablerArrowLeft : tablerArrowUp;
	const nextIcon = kind === "column" ? tablerArrowRight : tablerArrowDown;
	const previousRef = useRef<HTMLButtonElement>(null);
	const nextRef = useRef<HTMLButtonElement>(null);
	const pendingFocus = useRef<{
		readonly direction: "earlier" | "later";
		readonly targetIndex: number;
	} | null>(null);

	/* A move can make its own button unavailable at the first or last slot.
	 * Keep focus on the same action while it remains usable, otherwise hand it
	 * to the reciprocal move instead of leaving keyboard focus on a disabled
	 * control. The UUID-keyed inspector stays mounted across the refresh. */
	useEffect(() => {
		const pending = pendingFocus.current;
		if (
			pending === null ||
			position !== pending.targetIndex ||
			ordering.moving
		) {
			return;
		}
		const same =
			pending.direction === "earlier" ? previousRef.current : nextRef.current;
		const reciprocal =
			pending.direction === "earlier" ? nextRef.current : previousRef.current;
		const target =
			same !== null && !same.disabled
				? same
				: reciprocal !== null && !reciprocal.disabled
					? reciprocal
					: null;
		target?.focus();
		pendingFocus.current = null;
	}, [ordering.moving, position]);
	if (position < 0) return null;

	const move = async (direction: "earlier" | "later") => {
		const toIndex = direction === "earlier" ? position - 1 : position + 1;
		if (locked || toIndex < 0 || toIndex >= count) return;
		pendingFocus.current = { direction, targetIndex: toIndex };
		let moved: boolean;
		if (kind === "column") {
			moved = await ordering.moveColumn(
				itemId,
				toIndex,
				direction,
				table.tableRevision,
			);
		} else {
			moved = await ordering.moveRow(
				itemId,
				toIndex,
				direction,
				table.tableRevision,
			);
		}
		if (!moved) pendingFocus.current = null;
	};

	return (
		<fieldset className="min-w-0 space-y-2" data-project-data-ordering={kind}>
			<legend className="text-[13px] font-medium text-nova-text">
				Order in table
			</legend>
			<p className="text-[12px] text-nova-text-muted">
				Position {(position + 1).toLocaleString("en-US")} of{" "}
				{count.toLocaleString("en-US")}
			</p>
			{canEdit && (
				<div className="flex flex-wrap gap-2">
					<Button
						ref={previousRef}
						type="button"
						variant="outline"
						disabled={locked || position === 0}
						onClick={() => void move("earlier")}
					>
						<Icon
							icon={previousIcon}
							width="16"
							height="16"
							aria-hidden="true"
						/>
						{previousLabel}
					</Button>
					<Button
						ref={nextRef}
						type="button"
						variant="outline"
						disabled={locked || position === count - 1}
						onClick={() => void move("later")}
					>
						<Icon icon={nextIcon} width="16" height="16" aria-hidden="true" />
						{nextLabel}
					</Button>
				</div>
			)}
			{canEdit &&
				props.disabled === true &&
				props.disabledReason !== undefined && (
					<p className="text-[12px] leading-snug text-nova-text-muted">
						{props.disabledReason}
					</p>
				)}
			{ordering.failure !== null && (
				<p role="alert" className="text-[13px] leading-relaxed text-nova-rose">
					{ordering.failure}
				</p>
			)}
			{ordering.status !== null && (
				<p
					role="status"
					className="text-[13px] leading-relaxed text-nova-text-secondary"
				>
					{ordering.status}
				</p>
			)}
		</fieldset>
	);
}
