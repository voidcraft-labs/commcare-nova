// components/builder/form-links/AddLinkControl.tsx
//
// Adding is chooser-first: the question is what KIND of link it is,
// because that answer decides where the link may sit (a conditional link
// above the otherwise, the otherwise last) and whether it needs a
// condition at all. Then where it goes. Every choice lands a complete,
// valid link and opens it.

"use client";

import { Icon } from "@iconify/react/offline";
import tablerArrowLeft from "@iconify-icons/tabler/arrow-left";
import tablerArrowRampRight from "@iconify-icons/tabler/arrow-ramp-right";
import tablerArrowRight from "@iconify-icons/tabler/arrow-right";
import tablerPlus from "@iconify-icons/tabler/plus";
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

export type LinkKind = "conditional" | "otherwise";

export function AddLinkControl({
	formUuid,
	view,
	open,
	onOpenChange,
	onAdd,
}: {
	readonly formUuid: Uuid;
	readonly view: FormLinksView;
	readonly open: boolean;
	readonly onOpenChange: (open: boolean) => void;
	readonly onAdd: (kind: LinkKind, target: FormLinkTarget) => void;
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
				<span className="flex-1 text-left">Add a link</span>
			</PopoverTrigger>
			<PopoverContent align="start" className="w-[22rem] p-2">
				{intent !== null ? (
					<div className="space-y-2">
						<p className="px-1 pt-1 text-[13px] leading-relaxed text-nova-text-secondary">
							{intent === "conditional"
								? "Where should the form go when the condition is true?"
								: "Where should the form go when nothing else matched?"}
						</p>
						<LinkTargetPickerContent
							formUuid={formUuid}
							editing={undefined}
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
							icon={tablerArrowRampRight}
							title="Go somewhere when a condition is true"
							detail="Checked in order; the first true condition is followed"
							onClick={() => setIntent("conditional")}
						/>
						<IntentRow
							icon={tablerArrowRight}
							title="Otherwise go somewhere else"
							detail={
								otherwiseReason ??
								"Where the form goes when no condition above is true"
							}
							disabledReason={otherwiseReason}
							onClick={() => setIntent("otherwise")}
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
