// components/builder/form-links/AddLinkControl.tsx
//
// Adding is chooser-first: the question is what KIND of destination it is,
// because that answer decides what lands: one that runs every time, one
// with a condition (seeded `false()`, so nothing changes until the author
// writes it), or the Otherwise, which opens the otherwise chooser. Then
// where. Every choice lands a complete, valid link and opens it. The
// Otherwise is offered while some destination may not run and none is
// stored (`formLinkAddChoices`), and otherwise stays visible with its
// reason.

"use client";

import { Icon } from "@iconify/react/offline";
import tablerArrowLeft from "@iconify-icons/tabler/arrow-left";
import tablerArrowRampRight from "@iconify-icons/tabler/arrow-ramp-right";
import tablerArrowRight from "@iconify-icons/tabler/arrow-right";
import tablerPlus from "@iconify-icons/tabler/plus";
import tablerRepeat from "@iconify-icons/tabler/repeat";
import { useState } from "react";
import { Button } from "@/components/shadcn/button";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/shadcn/popover";
import type { FormLinksView } from "@/lib/doc/hooks/useFormLinks";
import type { Uuid } from "@/lib/doc/types";
import type { FormLinkTarget } from "@/lib/domain";
import { POPOVER_ROW_CLS } from "@/lib/styles";
import { LinkTargetPickerContent } from "./LinkTargetPicker";
import { otherwiseUnavailableReason } from "./refusalCopy";
import { seedConditionalLink, seedEveryTimeLink, seedTarget } from "./seeds";

/** The destination kinds the add control lands directly. */
export type LinkKind = "every-time" | "conditional";

export function AddLinkControl({
	formUuid,
	view,
	open,
	onOpenChange,
	onAdd,
	onChooseOtherwise,
}: {
	readonly formUuid: Uuid;
	readonly view: FormLinksView;
	readonly open: boolean;
	readonly onOpenChange: (open: boolean) => void;
	readonly onAdd: (kind: LinkKind, target: FormLinkTarget) => void;
	/** "Otherwise, go somewhere else": the host opens the otherwise
	 *  chooser in the list's last row. */
	readonly onChooseOtherwise: () => void;
}) {
	const [intent, setIntent] = useState<LinkKind | null>(null);
	const otherwiseReason = otherwiseUnavailableReason(view.addChoices());

	return (
		<Popover
			open={open}
			onOpenChange={(next) => {
				onOpenChange(next);
				if (!next) setIntent(null);
			}}
		>
			<PopoverTrigger
				render={
					<Button
						type="button"
						variant="ghost"
						data-form-links-add
						className="nova-add-slot w-full gap-2"
					/>
				}
			>
				<Icon icon={tablerPlus} width="14" height="14" />
				<span className="flex-1 text-left">Add a destination</span>
			</PopoverTrigger>
			<PopoverContent align="start" className="w-[22rem] p-2">
				{intent !== null ? (
					<div className="space-y-2">
						<p className="px-1 pt-1 text-[13px] leading-relaxed text-nova-text-secondary">
							{intent === "conditional"
								? "Where should the form go when the condition is true?"
								: "Where should the form go every time?"}
						</p>
						<LinkTargetPickerContent
							formUuid={formUuid}
							refusalOf={(target) =>
								view.newCaseRefusal(
									intent === "conditional"
										? seedConditionalLink(seedTarget(view, target))
										: seedEveryTimeLink(seedTarget(view, target)),
								)
							}
							onChoose={(target) => {
								onAdd(intent, target);
								setIntent(null);
							}}
						/>
						<Button
							type="button"
							variant="ghost"
							onClick={() => setIntent(null)}
							className="w-full justify-start text-[13px]"
						>
							<Icon icon={tablerArrowLeft} width="14" height="14" />
							Back
						</Button>
					</div>
				) : (
					<div className="space-y-1">
						<IntentRow
							icon={tablerRepeat}
							title="Go somewhere every time"
							detail="Runs after every submission, in its place in the list"
							onClick={() => setIntent("every-time")}
						/>
						<IntentRow
							icon={tablerArrowRampRight}
							title="Go somewhere when a condition is true"
							detail="Runs only when its condition is true once the form is submitted"
							onClick={() => setIntent("conditional")}
						/>
						<IntentRow
							icon={tablerArrowRight}
							title="Otherwise, go somewhere else"
							detail={
								otherwiseReason ??
								"Where the form goes when no destination with a condition or a carried case runs"
							}
							disabledReason={otherwiseReason}
							onClick={() => {
								onOpenChange(false);
								onChooseOtherwise();
							}}
						/>
					</div>
				)}
			</PopoverContent>
		</Popover>
	);
}

function IntentRow({
	icon,
	title,
	detail,
	disabledReason,
	onClick,
}: {
	readonly icon: Parameters<typeof Icon>[0]["icon"];
	readonly title: string;
	readonly detail: string;
	readonly disabledReason?: string;
	readonly onClick: () => void;
}) {
	return (
		<button
			type="button"
			disabled={disabledReason !== undefined}
			onClick={onClick}
			className={POPOVER_ROW_CLS}
		>
			<Icon
				icon={icon}
				width="16"
				height="16"
				className="mt-0.5 shrink-0 text-nova-violet-bright"
			/>
			<span className="min-w-0 flex-1">
				<span className="block text-sm font-medium text-nova-text">
					{title}
				</span>
				<span className="block text-[13px] leading-snug text-nova-text-muted">
					{detail}
				</span>
			</span>
		</button>
	);
}
