// components/builder/case-operations/CaseOperationRow.tsx
//
// One case change, as a sentence.
//
// The row is a PROJECTION and decides nothing. It renders what
// `operationSentence` reads off the stored operation, plus two answers
// the doc layer supplies: the conditions it inherits from earlier
// changes, and whether the position it is being dragged onto is
// available. If this row ever seems to know something the document does
// not say, that is the bug: the planners in `lib/doc` are where a
// decision belongs.
//
// The reorder handle carries the keyboard alternative to dragging, and
// its accessible name states the position, the total, and the keys, a
// keyboard author needs to know where they are in a twenty-change list
// before they know what moving does.

"use client";

import { Icon } from "@iconify/react/offline";
import tablerArrowsSplit from "@iconify-icons/tabler/arrows-split";
import tablerCirclePlus from "@iconify-icons/tabler/circle-plus";
import tablerCircleX from "@iconify-icons/tabler/circle-x";
import tablerGripVertical from "@iconify-icons/tabler/grip-vertical";
import tablerPencil from "@iconify-icons/tabler/pencil";
import { Button } from "@/components/shadcn/button";
import { SimpleTooltip } from "@/components/shadcn/tooltip";
import type { CaseOperation } from "@/lib/domain";
import type { ReorderKey } from "./keyboardMove";
import {
	type OperationSentenceContext,
	operationSentence,
	operationSentenceText,
} from "./operationSentence";

const ACTION_ICON = {
	create: tablerCirclePlus,
	update: tablerPencil,
	close: tablerCircleX,
} as const;

export interface CaseOperationRowProps {
	readonly operation: CaseOperation;
	readonly context: OperationSentenceContext;
	readonly position: number;
	readonly total: number;
	readonly canEdit: boolean;
	/** Conditions this change inherits from earlier changes, in execution
	 *  order, already resolved to names by the caller. */
	readonly inheritedGuards: readonly string[];
	/** True while this row is the drag source. */
	readonly beingMoved: boolean;
	readonly setHandleEl: (el: HTMLElement | null) => void;
	/** Fired when the handle is pressed, before any drag can begin, the
	 *  canvas captures this row's move verdicts there so the very first
	 *  pointer move is already gated. */
	readonly onGrab: () => void;
	readonly onMove: (key: ReorderKey) => void;
	readonly onSelect: () => void;
}

export function CaseOperationRow({
	operation,
	context,
	position,
	total,
	canEdit,
	inheritedGuards,
	beingMoved,
	setHandleEl,
	onGrab,
	onMove,
	onSelect,
}: CaseOperationRowProps) {
	const sentence = operationSentence(operation, context);
	/* The guard clause has to be IN the accessible name, not merely on screen
	 * beside it: an `aria-label` REPLACES the name computed from the button's
	 * contents, so without this the one signal that a change is conditional on
	 * an earlier one: the only place the list shows it, reaches nobody using
	 * a screen reader, and they are told it runs on every submission. */
	const spoken =
		inheritedGuards.length > 0
			? `${operationSentenceText(sentence)}. Also only when ${listSentence(inheritedGuards)} runs`
			: operationSentenceText(sentence);

	const body = (
		<span className="min-w-0 flex-1">
			<span className="flex min-w-0 items-start gap-2.5">
				<Icon
					icon={ACTION_ICON[operation.action]}
					width="16"
					height="16"
					aria-hidden="true"
					className="mt-0.5 shrink-0 text-nova-violet-bright"
				/>
				<span className="min-w-0 flex-1">
					<span className="block break-words whitespace-normal text-[14px] font-semibold text-nova-text">
						{sentence.lead}
					</span>
					{sentence.details.length > 0 && (
						<span className="mt-0.5 block break-words whitespace-normal text-[13px] leading-relaxed text-nova-text-muted">
							{sentence.details.join(" · ")}
						</span>
					)}
					{inheritedGuards.length > 0 && (
						/* At rest, not on hover: an author reading the list has to be
						 * able to see that this change only runs when an earlier one
						 * does, without touching anything. */
						<span className="mt-1.5 flex min-w-0 items-start gap-1.5 text-[13px] leading-relaxed text-nova-text-secondary">
							<Icon
								icon={tablerArrowsSplit}
								width="14"
								height="14"
								aria-hidden="true"
								className="mt-0.5 shrink-0 text-nova-text-muted"
							/>
							<span className="min-w-0 break-words">
								Also only when {listSentence(inheritedGuards)} runs
							</span>
						</span>
					)}
				</span>
			</span>
		</span>
	);

	return (
		<div
			data-case-operation-row={operation.uuid}
			className={`group/operation flex min-h-16 items-stretch overflow-hidden rounded-xl border border-white/[0.07] bg-nova-deep/35 transition-colors hover:border-nova-border-bright hover:bg-white/[0.025] ${
				beingMoved ? "opacity-50" : ""
			}`}
		>
			{canEdit && (
				<SimpleTooltip content="Drag or use arrow keys" side="left">
					<Button
						type="button"
						variant="ghost"
						ref={setHandleEl}
						onPointerDown={onGrab}
						onKeyDown={(event) => {
							if (
								event.key !== "ArrowUp" &&
								event.key !== "ArrowDown" &&
								event.key !== "Home" &&
								event.key !== "End"
							) {
								return;
							}
							event.preventDefault();
							onMove(event.key);
						}}
						aria-keyshortcuts="ArrowUp ArrowDown Home End"
						aria-label={`Move ${operation.id}. Runs ${position} of ${total}. Use arrow keys or drag.`}
						className="nova-focusable-inset h-auto w-11 shrink-0 cursor-grab rounded-l-xl rounded-r-none px-0 text-nova-text-muted hover:bg-white/[0.035] dark:hover:bg-white/[0.035]"
					>
						<Icon icon={tablerGripVertical} width="17" height="17" />
					</Button>
				</SimpleTooltip>
			)}

			<Button
				type="button"
				variant="ghost"
				onClick={onSelect}
				aria-label={`${spoken}. Open this change.`}
				data-case-operation-select={operation.uuid}
				className="nova-focusable-inset h-auto min-w-0 flex-1 justify-start rounded-none px-4 py-3 text-left whitespace-normal active:not-aria-[haspopup]:translate-y-0 not-disabled:hover:bg-transparent dark:not-disabled:hover:bg-transparent"
			>
				{body}
			</Button>
		</div>
	);
}

/** "A", "A and B", "A, B and C": the same join the refusals use. */
function listSentence(names: readonly string[]): string {
	if (names.length === 1) return `“${names[0]}”`;
	const quoted = names.map((name) => `“${name}”`);
	return `${quoted.slice(0, -1).join(", ")} and ${quoted[quoted.length - 1]}`;
}
