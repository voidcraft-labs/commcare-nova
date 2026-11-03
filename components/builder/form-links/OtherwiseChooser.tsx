// components/builder/form-links/OtherwiseChooser.tsx
//
// Where the form goes when nothing it was told to run does: the one chooser
// shared by the form-settings row and the workspace's otherwise row, so both
// read and write one model (`afterSubmitPlan`).
//
// For a form with destinations it chooses the Otherwise: each built-in
// destination the form's menu offers (`otherwiseDestinationsOffered`),
// "Another form or module" (an otherwise link, through the target picker,
// leaving out the form's own menu where "This module" is offered), and "The
// app home" (no Otherwise), written through `planSetOtherwise`. The builder
// mints a new otherwise link's uuid. For a form without destinations it
// chooses where the form goes after submit: each destination its menu offers
// (`postSubmitDestinationChoices`), or "Another form or module", which adds
// the form's first destination, one that runs every time.
//
// Replacing an otherwise link with anything else is authored work leaving
// the app, so it asks first, inline. "Another form or module" differs by
// host: the workspace picks the destination right here, while the settings
// popover hands off to the workspace, which has the room.

"use client";

import { Icon } from "@iconify/react/offline";
import tablerArrowBackUp from "@iconify-icons/tabler/arrow-back-up";
import tablerArrowLeft from "@iconify-icons/tabler/arrow-left";
import tablerArrowRampRight from "@iconify-icons/tabler/arrow-ramp-right";
import tablerArrowUp from "@iconify-icons/tabler/arrow-up";
import tablerChevronDown from "@iconify-icons/tabler/chevron-down";
import tablerHome from "@iconify-icons/tabler/home";
import tablerLayoutList from "@iconify-icons/tabler/layout-list";
import tablerTable from "@iconify-icons/tabler/table";
import { useState } from "react";
import { newUuid } from "@/components/builder/case-list-config/uuid";
import { PlatformNoteRow } from "@/components/builder/shared/PlatformNoteRow";
import { Button } from "@/components/shadcn/button";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/shadcn/popover";
import { useBlueprintDocApi } from "@/lib/doc/hooks/useBlueprintDoc";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useModule } from "@/lib/doc/hooks/useEntity";
import { usePostSubmitDestinationChoices } from "@/lib/doc/hooks/useFormLinkFacts";
import {
	type FormLinkWriteReports,
	useFormLinks,
} from "@/lib/doc/hooks/useFormLinks";
import type { Uuid } from "@/lib/doc/types";
import {
	defaultPostSubmitOf,
	type FormLinkTarget,
	type FormOtherwise,
	type PostSubmitDestination,
} from "@/lib/domain";
import type { PlatformFeatureId } from "@/lib/domain/platforms";
import { POPOVER_ROW_CLS } from "@/lib/styles";
import { useInlineConfirmFocus } from "@/lib/ui/hooks/useInlineConfirmFocus";
import {
	APP_HOME_CHOICE_LABEL,
	destinationDetail,
	destinationLabel,
	OTHER_TARGET_CHOICE_LABEL,
	otherwiseChangedAnnouncement,
	otherwisePhrase,
	postSubmitChangedAnnouncement,
	showCommitReportToast,
} from "./afterSubmitCopy";
import { LinkTargetPickerContent } from "./LinkTargetPicker";
import { linkLead } from "./linkSentence";
import { OTHERWISE_UNREACHABLE_REASON, planRefusal } from "./refusalCopy";
import {
	retargetLink,
	seedEveryTimeLink,
	seedOtherwiseLink,
	seedTarget,
} from "./seeds";
import { useLinkSentenceContext } from "./useLinkSentenceContext";

const DESTINATION_ICON = {
	app_home: tablerHome,
	firstMenu: tablerLayoutList,
	module: tablerTable,
	parentMenu: tablerArrowUp,
	previous: tablerArrowBackUp,
} as const satisfies Record<PostSubmitDestination, unknown>;

export type ChooserOutcome =
	| { readonly kind: "committed"; readonly announcement: string }
	| { readonly kind: "refused"; readonly message: string };

export interface OtherwiseChooserProps {
	/** The module that holds the form; its parent names "Parent module". */
	readonly moduleUuid: Uuid;
	readonly formUuid: Uuid;
	readonly canEdit: boolean;
	/** What "Another form or module" does here. */
	readonly otherTarget:
		| {
				readonly kind: "pick";
				/** A link was committed; the host opens it. */
				readonly onAdded: (uuid: Uuid) => void;
		  }
		| { readonly kind: "hand-off"; readonly onHandOff: () => void };
	/** Every commit and refusal, for the host's live regions. */
	readonly onOutcome: (outcome: ChooserOutcome) => void;
	/** Labels the trigger for assistive tech when the host's visible label
	 *  is not adjacent. */
	readonly ariaLabel?: string;
	/** Whether the choices are open, when the host opens them (the add
	 *  control's "Otherwise, go somewhere else"); uncontrolled when absent. */
	readonly open?: boolean;
	readonly onOpenChange?: (open: boolean) => void;
}

/** The chooser's platform note: where App home and First menu lead. */
const AFTER_SUBMIT_HOME_NOTE: readonly PlatformFeatureId[] = [
	"after-submit-home",
];

/** A built-in choice: a destination, or "The app home" for no Otherwise. */
type BuiltInChoice =
	| {
			readonly kind: "destination";
			readonly destination: PostSubmitDestination;
	  }
	| { readonly kind: "app-home" };

export function OtherwiseChooser({
	moduleUuid,
	formUuid,
	canEdit,
	otherTarget,
	onOutcome,
	ariaLabel,
	open: openProp,
	onOpenChange,
}: OtherwiseChooserProps) {
	const view = useFormLinks(formUuid);
	const docApi = useBlueprintDocApi();
	const { inline } = useBlueprintMutations();
	const postSubmitChoices = usePostSubmitDestinationChoices(formUuid);
	const parentName = useModule(useModule(moduleUuid)?.parentModuleUuid)?.name;
	const sentence = useLinkSentenceContext(formUuid);
	const [openLocal, setOpenLocal] = useState(false);
	const open = openProp ?? openLocal;
	const setOpen = (next: boolean) => {
		if (openProp === undefined) setOpenLocal(next);
		onOpenChange?.(next);
	};
	const [stage, setStage] = useState<"choices" | "pick-target">("choices");
	const [pending, setPending] = useState<BuiltInChoice | null>(null);
	const { triggerRef, panelRef } = useInlineConfirmFocus(pending !== null);

	const plan = view.plan;
	if (plan === undefined) return null;
	/* A form without destinations chooses its after-submit; a form with
	 * them chooses its Otherwise. */
	const choosingOtherwise = plan.postSubmit === undefined;
	const otherwise = plan.otherwise;
	const otherwiseLink = otherwise?.kind === "link" ? otherwise : undefined;
	const destinations: readonly PostSubmitDestination[] = choosingOtherwise
		? view.otherwiseDestinationsOffered
		: postSubmitChoices;
	const nameOf = sentence.destinationOf;

	const currentLabel = !choosingOtherwise
		? destinationLabel(plan.postSubmit?.destination ?? "app_home", parentName)
		: otherwise === undefined
			? APP_HOME_CHOICE_LABEL
			: otherwise.kind === "destination"
				? destinationLabel(otherwise.destination, parentName)
				: linkLead(otherwise.target, sentence);

	const report = (
		outcome:
			| ({ readonly ok: true } & FormLinkWriteReports)
			| { readonly ok: false; readonly messages: string[] },
		announcement: string,
	): boolean => {
		if (!outcome.ok) {
			onOutcome({ kind: "refused", message: outcome.messages.join(" ") });
			return false;
		}
		onOutcome({ kind: "committed", announcement });
		showCommitReportToast(outcome);
		return true;
	};

	const choiceAsOtherwise = (choice: BuiltInChoice): FormOtherwise | null =>
		choice.kind === "app-home" || choice.destination === "app_home"
			? null
			: { kind: "destination", destination: choice.destination };

	const commitBuiltIn = (choice: BuiltInChoice) => {
		if (choosingOtherwise) {
			const next = choiceAsOtherwise(choice);
			report(
				view.setOtherwise(next),
				otherwiseChangedAnnouncement(next, nameOf),
			);
			return;
		}
		if (choice.kind !== "destination") return;
		/* The form-type default needs no stored slot: storing it would be a
		 * second spelling of the same after-submit. */
		const stored =
			choice.destination === defaultPostSubmitOf(docApi.getState(), formUuid)
				? null
				: choice.destination;
		report(
			inline.updateForm(formUuid, { postSubmit: stored }),
			postSubmitChangedAnnouncement(choice.destination),
		);
	};

	const isActive = (choice: BuiltInChoice): boolean => {
		if (!choosingOtherwise) {
			return (
				choice.kind === "destination" &&
				plan.postSubmit?.destination === choice.destination
			);
		}
		return choice.kind === "app-home"
			? otherwise === undefined
			: otherwise?.kind === "destination" &&
					otherwise.destination === choice.destination;
	};

	/* A built-in the planner would refuse here (the Otherwise is not
	 * reachable now) is shown disabled with the planner's sentence. */
	const builtInRefusal = (choice: BuiltInChoice): string | undefined =>
		choosingOtherwise
			? planRefusal(
					view.otherwisePlan(choiceAsOtherwise(choice)),
					(uuid) => nameOf({ type: "module", moduleUuid: uuid })?.name,
				)
			: undefined;

	const chooseBuiltIn = (choice: BuiltInChoice) => {
		setOpen(false);
		if (isActive(choice)) return;
		/* Replacing the otherwise link is authored work leaving the app:
		 * ask first. Storing a built-in over a built-in is not. */
		if (choosingOtherwise && otherwiseLink !== undefined) {
			setPending(choice);
			return;
		}
		commitBuiltIn(choice);
	};

	const chooseTarget = (target: FormLinkTarget) => {
		setOpen(false);
		setStage("choices");
		const seed = seedTarget(view, target);
		if (!choosingOtherwise) {
			/* The form's first destination, running every time: through
			 * `add`, so the form's after-submit settles in the same batch. */
			const link = seedEveryTimeLink(seed);
			const committed = report(
				view.add(link),
				`After submit, this form now goes ${otherwisePhrase(
					{ kind: "link", uuid: link.uuid, target },
					nameOf,
				)}.`,
			);
			if (committed && otherTarget.kind === "pick")
				otherTarget.onAdded(link.uuid);
			return;
		}
		const next =
			otherwiseLink === undefined
				? seedOtherwiseLink(seed, newUuid())
				: retargetLink(otherwiseLink, seed);
		const committed = report(
			view.setOtherwise(next),
			otherwiseChangedAnnouncement(next, nameOf),
		);
		if (committed && otherTarget.kind === "pick")
			otherTarget.onAdded(next.uuid);
	};

	if (pending !== null) {
		const linkName =
			otherwiseLink === undefined
				? "the otherwise link"
				: linkLead(otherwiseLink.target, sentence);
		const nextPhrase = otherwisePhrase(
			choiceAsOtherwise(pending) ?? undefined,
			nameOf,
		);
		return (
			<div
				ref={panelRef}
				tabIndex={-1}
				className="space-y-3 rounded-xl border border-nova-amber/30 bg-nova-amber/[0.05] p-3 outline-none"
			>
				<p className="text-[13px] leading-relaxed text-nova-text-secondary">
					{`Stop the Otherwise “${linkName}”? When no destination with a condition or a carried case runs, the form will go ${nextPhrase} instead. You can undo this.`}
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

	const showsHomeNote =
		choosingOtherwise ||
		destinations.some(
			(destination) =>
				destination === "app_home" || destination === "firstMenu",
		);
	/* An otherwise link is refused, like a built-in, while nothing might not
	 * run; the planner's reason is the one sentence for both. */
	const otherTargetRefusal =
		choosingOtherwise && !plan.otherwiseOffered
			? OTHERWISE_UNREACHABLE_REASON
			: undefined;
	const omitMenuUuid = destinations.includes("module") ? moduleUuid : undefined;

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
				aria-label={
					ariaLabel ??
					(choosingOtherwise
						? `Otherwise: ${currentLabel}`
						: `After submit: ${currentLabel}`)
				}
				data-form-links-otherwise
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
							{!choosingOtherwise
								? "Where should the form go after submit?"
								: otherwiseLink === undefined
									? "Where should the form go when no destination with a condition or a carried case runs?"
									: "Where should the Otherwise go instead?"}
						</p>
						<LinkTargetPickerContent
							formUuid={formUuid}
							current={otherwiseLink?.target}
							omitMenuUuid={omitMenuUuid}
							refusalOf={(target) =>
								view.newCaseRefusal(seedEveryTimeLink(seedTarget(view, target)))
							}
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
						{destinations.map((destination) => {
							const choice = { kind: "destination", destination } as const;
							return (
								<ChoiceRow
									key={destination}
									icon={DESTINATION_ICON[destination]}
									title={destinationLabel(destination, parentName)}
									detail={destinationDetail(destination)}
									active={isActive(choice)}
									disabledReason={builtInRefusal(choice)}
									onClick={() => chooseBuiltIn(choice)}
								/>
							);
						})}
						<ChoiceRow
							icon={tablerArrowRampRight}
							title={OTHER_TARGET_CHOICE_LABEL}
							detail={
								otherwiseLink === undefined
									? "Send the person to a specific form or form list"
									: `Currently ${linkLead(otherwiseLink.target, sentence).toLocaleLowerCase()}. Change where it goes`
							}
							active={otherwiseLink !== undefined}
							disabledReason={otherTargetRefusal}
							onClick={() => {
								if (otherTarget.kind === "hand-off") {
									setOpen(false);
									otherTarget.onHandOff();
									return;
								}
								setStage("pick-target");
							}}
						/>
						{choosingOtherwise && (
							<ChoiceRow
								icon={DESTINATION_ICON.app_home}
								title={APP_HOME_CHOICE_LABEL}
								detail={destinationDetail("app_home")}
								active={isActive({ kind: "app-home" })}
								onClick={() => chooseBuiltIn({ kind: "app-home" })}
							/>
						)}
						{/* App home and First menu open one screen in Web Apps and two
						 *  on Android: the platform note says so where either is
						 *  offered, for the platforms the app runs on. */}
						{showsHomeNote && (
							<PlatformNoteRow
								features={AFTER_SUBMIT_HOME_NOTE}
								className="px-2 pt-1"
							/>
						)}
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
	disabledReason,
	onClick,
}: {
	readonly icon: Parameters<typeof Icon>[0]["icon"];
	readonly title: string;
	readonly detail: string;
	readonly active: boolean;
	/** Why this choice is not available; `undefined` when it is. */
	readonly disabledReason?: string;
	readonly onClick: () => void;
}) {
	return (
		<button
			type="button"
			aria-current={active ? "true" : undefined}
			disabled={disabledReason !== undefined && !active}
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
					{disabledReason ?? detail}
				</span>
			</span>
		</button>
	);
}
