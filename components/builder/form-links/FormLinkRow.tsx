// components/builder/form-links/FormLinkRow.tsx
//
// One conditional after-submit link, as a sentence.
//
// The row is a PROJECTION and decides nothing. It renders what
// `linkSentence` reads off the stored link; whether the position it is
// being dragged onto is available is the doc layer's answer, captured by
// the canvas. The reorder handle carries the keyboard alternative to
// dragging, and its accessible name states the position, the total, and
// the keys.

"use client";

import { Icon } from "@iconify/react/offline";
import tablerArrowRampRight from "@iconify-icons/tabler/arrow-ramp-right";
import tablerGripVertical from "@iconify-icons/tabler/grip-vertical";
import type { ReorderKey } from "@/components/builder/shared/keyboardReorderPlan";
import { Button } from "@/components/shadcn/button";
import { SimpleTooltip } from "@/components/shadcn/tooltip";
import type { FormLink } from "@/lib/domain";
import { LIST_ROW_CLS } from "@/lib/styles";
import { type LinkSentence, linkSentenceText } from "./linkSentence";

export interface FormLinkRowProps {
	readonly link: FormLink;
	readonly sentence: LinkSentence;
	readonly position: number;
	readonly total: number;
	readonly canEdit: boolean;
	/** True while this row is the drag source. */
	readonly beingMoved: boolean;
	readonly setHandleEl: (el: HTMLElement | null) => void;
	/** Fired when the handle is pressed, before any drag can begin: the
	 *  canvas captures this row's move verdicts there so the very first
	 *  pointer move is already gated. */
	readonly onGrab: () => void;
	readonly onMove: (key: ReorderKey) => void;
	readonly onSelect: () => void;
}

export function FormLinkRow({
	link,
	sentence,
	position,
	total,
	canEdit,
	beingMoved,
	setHandleEl,
	onGrab,
	onMove,
	onSelect,
}: FormLinkRowProps) {
	const spoken = linkSentenceText(sentence);

	return (
		<div
			data-form-link-row={link.uuid}
			className={`group/link flex min-h-16 items-stretch overflow-hidden rounded-xl border border-white/[0.07] bg-nova-deep/35 transition-colors hover:border-nova-border-bright hover:bg-white/[0.025] ${
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
						aria-label={`Move ${sentence.lead}. Checked ${position} of ${total}. Use arrow keys or drag.`}
						className="nova-focusable-inset h-auto w-11 shrink-0 cursor-grab rounded-l-xl rounded-r-none px-0 text-nova-text-muted hover:bg-white/[0.035] dark:hover:bg-white/[0.035]"
					>
						<Icon icon={tablerGripVertical} width="17" height="17" />
					</Button>
				</SimpleTooltip>
			)}

			<button
				type="button"
				onClick={onSelect}
				aria-label={`${spoken}. Open this link.`}
				data-form-link-select={link.uuid}
				className={`flex-1 ${LIST_ROW_CLS}`}
			>
				<span className="flex min-w-0 flex-1 items-start gap-2.5">
					<Icon
						icon={tablerArrowRampRight}
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
							<span className="mt-0.5 block break-words whitespace-normal font-mono text-[13px] leading-relaxed text-nova-text-muted">
								{sentence.details.join(" · ")}
							</span>
						)}
					</span>
				</span>
			</button>
		</div>
	);
}
