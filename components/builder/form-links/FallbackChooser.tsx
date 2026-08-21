// components/builder/form-links/FallbackChooser.tsx
//
// What happens when nothing matched: the one chooser for the form's
// fallback, shared by the form-settings row and the workspace's terminal
// row so both read and write one model (`afterSubmitPlan` /
// `planSetFallback`).
//
// Three built-in destinations and "Another form or module". Choosing a
// built-in while an otherwise link exists REPLACES that link, which is
// authored work leaving the app, so it asks first, inline. "Another form
// or module" differs by host: the workspace picks the destination right
// here (a new otherwise link, or the existing one retargeted), while the
// settings popover hands off to the workspace, which has the room.

"use client";

import { Icon } from "@iconify/react/offline";
import tablerArrowBackUp from "@iconify-icons/tabler/arrow-back-up";
import tablerArrowLeft from "@iconify-icons/tabler/arrow-left";
import tablerArrowRampRight from "@iconify-icons/tabler/arrow-ramp-right";
import tablerChevronDown from "@iconify-icons/tabler/chevron-down";
import tablerHome from "@iconify-icons/tabler/home";
import tablerTable from "@iconify-icons/tabler/table";
import { useState } from "react";
import { newUuid } from "@/components/builder/case-list-config/uuid";
import { Button } from "@/components/shadcn/button";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/shadcn/popover";
import { useFormLinks } from "@/lib/doc/hooks/useFormLinks";
import { useParseXPathForForm } from "@/lib/doc/hooks/useXPathSlots";
import type { Uuid } from "@/lib/doc/types";
import {
	type FormLinkTarget,
	POST_SUBMIT_DESTINATIONS,
	type PostSubmitDestination,
} from "@/lib/domain";
import { POPOVER_ROW_CLS } from "@/lib/styles";
import { useInlineConfirmFocus } from "@/lib/ui/hooks/useInlineConfirmFocus";
import {
	destinationDetail,
	destinationLabel,
	ELSE_LINK_CHOICE_LABEL,
	fallbackChangedAnnouncement,
	stopElseLinkQuestion,
} from "./afterSubmitCopy";
import { LinkTargetPickerContent } from "./LinkTargetPicker";
import { linkLead } from "./linkSentence";
import { retargetLink, seedOtherwiseLink } from "./seeds";
import { useLinkSentenceContext } from "./useLinkSentenceContext";

const DESTINATION_ICON = {
	app_home: tablerHome,
	module: tablerTable,
	previous: tablerArrowBackUp,
} as const;

export type ChooserOutcome =
	| { readonly kind: "committed"; readonly announcement: string }
	| { readonly kind: "refused"; readonly message: string };

export interface FallbackChooserProps {
	readonly formUuid: Uuid;
	readonly canEdit: boolean;
	/** What "Another form or module" does here. */
	readonly elseLink:
		| {
				readonly kind: "pick";
				/** A new otherwise link was committed; the host opens it. */
				readonly onAdded: (uuid: Uuid) => void;
		  }
		| { readonly kind: "hand-off"; readonly onHandOff: () => void };
	/** Every commit and refusal, for the host's live regions. */
	readonly onOutcome: (outcome: ChooserOutcome) => void;
	/** Labels the trigger for assistive tech when the host's visible label
	 *  is not adjacent. */
	readonly ariaLabel?: string;
}

export function FallbackChooser({
	formUuid,
	canEdit,
	elseLink,
	onOutcome,
	ariaLabel,
}: FallbackChooserProps) {
	const view = useFormLinks(formUuid);
	const sentence = useLinkSentenceContext();
	const parse = useParseXPathForForm(formUuid);
	const [open, setOpen] = useState(false);
	const [stage, setStage] = useState<"choices" | "pick-target">("choices");
	const [pending, setPending] = useState<PostSubmitDestination | null>(null);
	const { triggerRef, panelRef } = useInlineConfirmFocus(pending !== null);

	const plan = view.plan;
	if (plan === undefined) return null;
	const currentElse = plan.elseLink;
	const currentLabel =
		plan.fallback.kind === "else-link"
			? linkLead(plan.fallback.link.target, sentence)
			: destinationLabel(plan.fallback.destination);

	const report = (
		outcome:
			| { readonly ok: true }
			| { readonly ok: false; readonly messages: string[] },
		announcement: string,
	) => {
		onOutcome(
			outcome.ok
				? { kind: "committed", announcement }
				: { kind: "refused", message: outcome.messages.join(" ") },
		);
	};

	const commitBuiltIn = (next: PostSubmitDestination) => {
		report(
			view.setFallback(next),
			fallbackChangedAnnouncement(next, sentence.destinationOf),
		);
	};

	const chooseBuiltIn = (next: PostSubmitDestination) => {
		setOpen(false);
		/* Choosing what is already stored changes nothing, so it announces
		 * nothing: the planner's empty batch is the one authority on that
		 * (it knows when the form-type default means the slot stays clear). */
		const planned = view.fallbackPlan(next);
		if (planned.ok && planned.mutations.length === 0) return;
		/* Replacing the otherwise link is authored work leaving the app:
		 * ask first. Storing a built-in over a built-in is not. */
		if (currentElse !== undefined) {
			setPending(next);
			return;
		}
		commitBuiltIn(next);
	};

	const chooseTarget = (target: FormLinkTarget) => {
		setOpen(false);
		setStage("choices");
		const seed = {
			target,
			carry: view.carryVerdict(target),
			required: view.requiredDatums(target),
		};
		if (currentElse !== undefined) {
			report(
				view.update(retargetLink(currentElse, seed, parse), currentElse),
				fallbackChangedAnnouncement(
					{ kind: "else-link", target },
					sentence.destinationOf,
				),
			);
			return;
		}
		/* Through `add`, not `setFallback`: the seed carries the values a
		 * destination needs worked out by hand, which the fallback planner's
		 * bare else-link arm cannot, and an unconditional add lands last the
		 * same way. */
		const uuid = newUuid();
		const outcome = view.add(seedOtherwiseLink(seed, parse, uuid));
		report(
			outcome,
			fallbackChangedAnnouncement(
				{ kind: "else-link", target },
				sentence.destinationOf,
			),
		);
		if (outcome.ok && elseLink.kind === "pick") elseLink.onAdded(uuid);
	};

	if (pending !== null) {
		const elseName =
			currentElse === undefined
				? undefined
				: (sentence.destinationOf(currentElse.target)?.name ??
					"the otherwise link");
		return (
			<div
				ref={panelRef}
				tabIndex={-1}
				className="space-y-3 rounded-xl border border-nova-amber/30 bg-nova-amber/[0.05] p-3 outline-none"
			>
				<p className="text-[13px] leading-relaxed text-nova-text-secondary">
					{elseName === undefined
						? `Go ${destinationLabel(pending).toLocaleLowerCase()} instead? You can undo this.`
						: stopElseLinkQuestion(elseName, pending)}
				</p>
				<div className="flex flex-wrap gap-2">
					<Button
						type="button"
						variant="ghost"
						onClick={() => setPending(null)}
					>
						Cancel
					</Button>
					<Button
						type="button"
						variant="warning"
						onClick={() => {
							commitBuiltIn(pending);
							setPending(null);
						}}
					>
						Change it
					</Button>
				</div>
			</div>
		);
	}

	return (
		<Popover
			open={open}
			onOpenChange={(next) => {
				setOpen(next);
				if (!next) setStage("choices");
			}}
		>
			<PopoverTrigger
				ref={triggerRef}
				disabled={!canEdit}
				aria-label={ariaLabel ?? `Otherwise: ${currentLabel}`}
				data-form-links-fallback
				render={
					<Button type="button" variant="field" className="group w-full" />
				}
			>
				<span className="min-w-0 flex-1 break-words text-left text-nova-violet-bright">
					{currentLabel}
				</span>
				<Icon
					icon={tablerChevronDown}
					width="14"
					height="14"
					className="shrink-0 text-nova-text-muted transition-transform group-data-[popup-open]:rotate-180"
				/>
			</PopoverTrigger>
			<PopoverContent align="start" className="w-[22rem] p-2">
				{stage === "pick-target" ? (
					<div className="space-y-2">
						<p className="px-1 pt-1 text-[13px] leading-relaxed text-nova-text-secondary">
							{currentElse === undefined
								? "Where should the form go when nothing above matches?"
								: "Where should the otherwise link go instead?"}
						</p>
						<LinkTargetPickerContent
							formUuid={formUuid}
							editing={currentElse?.uuid}
							current={currentElse?.target}
							onChoose={chooseTarget}
						/>
						<Button
							type="button"
							variant="ghost"
							onClick={() => setStage("choices")}
							className="w-full justify-start text-[13px]"
						>
							<Icon icon={tablerArrowLeft} width="14" height="14" />
							Back
						</Button>
					</div>
				) : (
					<div className="space-y-1">
						{POST_SUBMIT_DESTINATIONS.map((destination) => {
							const active =
								plan.fallback.kind === "post-submit" &&
								plan.fallback.destination === destination;
							return (
								<ChoiceRow
									key={destination}
									icon={DESTINATION_ICON[destination]}
									title={destinationLabel(destination)}
									detail={destinationDetail(destination)}
									active={active}
									onClick={() => chooseBuiltIn(destination)}
								/>
							);
						})}
						<ChoiceRow
							icon={tablerArrowRampRight}
							title={ELSE_LINK_CHOICE_LABEL}
							detail={
								currentElse === undefined
									? "Send the person to a specific form or form list"
									: `Currently ${linkLead(currentElse.target, sentence).toLocaleLowerCase()}. Change where it goes`
							}
							active={plan.fallback.kind === "else-link"}
							onClick={() => {
								if (elseLink.kind === "hand-off") {
									setOpen(false);
									elseLink.onHandOff();
									return;
								}
								setStage("pick-target");
							}}
						/>
					</div>
				)}
			</PopoverContent>
		</Popover>
	);
}

function ChoiceRow({
	icon,
	title,
	detail,
	active,
	onClick,
}: {
	readonly icon: Parameters<typeof Icon>[0]["icon"];
	readonly title: string;
	readonly detail: string;
	readonly active: boolean;
	readonly onClick: () => void;
}) {
	return (
		<button
			type="button"
			aria-current={active ? "true" : undefined}
			onClick={onClick}
			className={`${POPOVER_ROW_CLS} ${active ? "bg-nova-violet/10 text-nova-violet-bright" : ""}`}
		>
			<Icon
				icon={icon}
				width="16"
				height="16"
				className={`mt-0.5 shrink-0 ${active ? "text-nova-violet-bright" : "text-nova-text-muted"}`}
			/>
			<span className="min-w-0 flex-1">
				<span className="block text-sm font-medium">{title}</span>
				<span className="block break-words text-[13px] leading-snug text-nova-text-muted">
					{detail}
				</span>
			</span>
		</button>
	);
}
