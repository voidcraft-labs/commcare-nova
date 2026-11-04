// components/builder/form-links/FormLinkInspectorBody.tsx
//
// One after-submit link's settings, in the rail: a destination, or the
// otherwise link.
//
// A discrete CHOICE is here (where it goes, when it runs, whether it is the
// Otherwise, removal); the expressions are on the canvas beside this panel,
// which is already showing the same link. Every choice offered is one the
// commit gate accepts: a destination the target planner refuses is disabled
// with its reason, "Make this the otherwise" is offered by
// `planMakeOtherwise`'s refusals, "Make this a destination" turns the
// otherwise link into the last destination (`planMakeDestination`), and a
// removal that changes the Otherwise says so before it commits.

"use client";

import { Icon } from "@iconify/react/offline";
import tablerAlertCircle from "@iconify-icons/tabler/alert-circle";
import tablerChevronDown from "@iconify-icons/tabler/chevron-down";
import tablerTrash from "@iconify-icons/tabler/trash";
import { useState } from "react";
import { Button } from "@/components/shadcn/button";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/shadcn/popover";
import { useDeclaredPlatforms } from "@/lib/doc/hooks/useDeclaredPlatforms";
import { useForm, useModule } from "@/lib/doc/hooks/useEntity";
import { useFormLinkTargetVisibility } from "@/lib/doc/hooks/useFormLinkFacts";
import {
	type FormLinkWriteOutcome,
	useFormLinks,
} from "@/lib/doc/hooks/useFormLinks";
import type { Uuid } from "@/lib/doc/types";
import type { FormLink, FormLinkTarget } from "@/lib/domain";
import { useNavigate } from "@/lib/routing/hooks";
import { useCanEdit } from "@/lib/session/hooks";
import { useInlineConfirmFocus } from "@/lib/ui/hooks/useInlineConfirmFocus";
import { hiddenTargetLine, showCommitReportToast } from "./afterSubmitCopy";
import { requestConditionEditorOpen } from "./conditionEditorHint";
import { LinkTargetPickerContent } from "./LinkTargetPicker";
import { linkLead } from "./linkSentence";
import { planRefusal, removalQuestion } from "./refusalCopy";
import { retargetDropsCarriedValues, retargetLink, seedTarget } from "./seeds";
import { useLinkSentenceContext } from "./useLinkSentenceContext";

export function FormLinkInspectorBody({
	moduleUuid,
	formUuid,
	linkUuid,
}: {
	readonly moduleUuid: Uuid;
	readonly formUuid: Uuid;
	readonly linkUuid: Uuid;
}) {
	const view = useFormLinks(formUuid);
	const form = useForm(formUuid);
	const sentence = useLinkSentenceContext(formUuid);
	const navigate = useNavigate();
	const canEdit = useCanEdit();
	const [refusal, setRefusal] = useState<string | undefined>(undefined);
	const [announcement, setAnnouncement] = useState("");
	const visibility = useFormLinkTargetVisibility(formUuid, linkUuid);

	const plan = view.plan;
	const destination = plan?.destinations.find(
		(candidate) => candidate.uuid === linkUuid,
	);
	const otherwiseLink =
		plan?.otherwise?.kind === "link" && plan.otherwise.uuid === linkUuid
			? plan.otherwise
			: undefined;
	const link = destination ?? otherwiseLink;
	/* The module that holds the target form: a form target names it, and
	 * Start this form again is this form in its own menu. */
	const targetModule = useModule(
		link?.target.type === "form"
			? link.target.moduleUuid
			: link?.target.type === "this-form"
				? moduleUuid
				: undefined,
	);
	const platforms = useDeclaredPlatforms();
	if (plan === undefined || link === undefined || form === undefined)
		return null;

	const lead = linkLead(link.target, sentence);
	const menuNameOf = (uuid: Uuid) =>
		sentence.destinationOf({ type: "module", moduleUuid: uuid })?.name;
	/* A form off the menu because its module is: Web Apps lands on the
	 * app's first screen, not on the module that holds it. */
	const hiddenLine = hiddenTargetLine(
		visibility,
		link.target.type !== "module" && targetModule?.hiddenFromMenu === true,
		platforms,
	);

	const settle = (outcome: FormLinkWriteOutcome, said: string) => {
		if (outcome.ok) {
			setRefusal(undefined);
			setAnnouncement(said);
			showCommitReportToast(outcome);
		} else {
			setRefusal(outcome.messages.join(" "));
		}
		return outcome;
	};

	const retarget = (target: FormLinkTarget) => {
		const seed = seedTarget(view, target);
		const said = `Now ${linkLead(target, sentence).toLocaleLowerCase()}.`;
		if (destination !== undefined) {
			const next = retargetLink(destination, seed);
			const dropped = retargetDropsCarriedValues(destination, next);
			settle(
				view.update(next, destination),
				dropped
					? `${said} The values it carried were removed, because the new destination needs none.`
					: said,
			);
			return;
		}
		if (otherwiseLink !== undefined) {
			settle(view.setOtherwise(retargetLink(otherwiseLink, seed)), said);
		}
	};

	return (
		<div className="space-y-5" data-form-link-inspector={link.uuid}>
			<p
				role="status"
				aria-live="polite"
				aria-atomic="true"
				className="sr-only"
			>
				{announcement}
			</p>
			{refusal !== undefined && (
				<div
					role="alert"
					className="flex gap-2 rounded-xl border border-nova-rose/25 bg-nova-rose/[0.06] px-3 py-2.5 text-[13px] leading-relaxed text-nova-text-secondary"
				>
					<Icon
						icon={tablerAlertCircle}
						width="16"
						height="16"
						className="mt-0.5 shrink-0 text-nova-rose"
					/>
					<span>{refusal}</span>
				</div>
			)}

			<fieldset disabled={!canEdit} className="contents">
				<Row
					title="Where it goes"
					description="The form or form list the person lands on."
				>
					<TargetControl
						formUuid={formUuid}
						current={link.target}
						lead={lead}
						canEdit={canEdit}
						refusalOf={(target) =>
							destination === undefined
								? undefined
								: view.newCaseRefusal(
										retargetLink(destination, seedTarget(view, target)),
										destination,
									)
						}
						onChoose={retarget}
					/>
					{hiddenLine !== undefined && (
						<p
							data-form-link-hidden-target
							className="text-[13px] leading-relaxed text-nova-text-muted"
						>
							{hiddenLine}
						</p>
					)}
				</Row>

				{destination !== undefined ? (
					<DestinationKindRow
						destination={destination}
						heldCase={sentence.carriesHeldCase(destination)}
						makeOtherwiseRefusal={planRefusal(
							view.makeOtherwisePlan(destination.uuid),
							menuNameOf,
						)}
						onGiveCondition={() => {
							const outcome = settle(
								view.update(
									{ ...destination, condition: { kind: "match-none" } },
									destination,
								),
								"Added a condition. Write it on the screen beside this panel.",
							);
							if (outcome.ok) requestConditionEditorOpen(destination.uuid);
						}}
						onRunEveryTime={() => {
							const { condition: _dropped, ...rest } = destination;
							settle(
								view.update(rest, destination),
								"This destination now runs every time.",
							);
						}}
						onMakeOtherwise={() =>
							settle(
								view.makeOtherwise(destination.uuid),
								"This destination is now the Otherwise.",
							)
						}
					/>
				) : (
					<Row
						title="What kind of link"
						description="The Otherwise: it runs when no destination with a condition or a carried case runs."
					>
						<Button
							type="button"
							variant="outline"
							className="w-full"
							onClick={() =>
								settle(
									view.makeDestination(),
									"The Otherwise is now the last destination, and runs every time.",
								)
							}
						>
							Make this a destination
						</Button>
					</Row>
				)}

				{canEdit && (
					<RemoveControl
						lead={lead}
						question={
							destination !== undefined
								? removalQuestion(lead, view.removalPlan(destination.uuid))
								: `Remove the Otherwise “${lead}”? When no destination with a condition or a carried case runs, the form will go back to the app home instead. You can undo this.`
						}
						onConfirm={() => {
							const outcome =
								destination !== undefined
									? view.remove(destination.uuid)
									: view.setOtherwise(null);
							if (outcome !== undefined && !outcome.ok) {
								setRefusal(outcome.messages.join(" "));
								return;
							}
							if (outcome !== undefined) showCommitReportToast(outcome);
							navigate.openFormLinks(moduleUuid, formUuid);
						}}
					/>
				)}
			</fieldset>
		</div>
	);
}

/** Whether a destination runs every time or on a condition, and the
 *  conversions between those and the Otherwise. */
function DestinationKindRow({
	destination,
	heldCase,
	makeOtherwiseRefusal,
	onGiveCondition,
	onRunEveryTime,
	onMakeOtherwise,
}: {
	readonly destination: FormLink;
	readonly heldCase: boolean;
	readonly makeOtherwiseRefusal: string | undefined;
	readonly onGiveCondition: () => void;
	readonly onRunEveryTime: () => void;
	readonly onMakeOtherwise: () => void;
}) {
	const conditional = destination.condition !== undefined;
	const description = conditional
		? "Runs when its condition is true once the form is submitted."
		: heldCase
			? "Runs when the case it carries is on the worker's device."
			: "Runs every time the form is submitted.";
	return (
		<Row title="When it runs" description={description}>
			<div className="space-y-1.5">
				{conditional ? (
					<Button
						type="button"
						variant="outline"
						className="w-full"
						onClick={onRunEveryTime}
					>
						Run it every time
					</Button>
				) : (
					<Button
						type="button"
						variant="outline"
						className="w-full"
						onClick={onGiveCondition}
					>
						Give it a condition
					</Button>
				)}
				<Button
					type="button"
					variant="outline"
					className="w-full"
					disabled={makeOtherwiseRefusal !== undefined}
					onClick={onMakeOtherwise}
				>
					Make this the otherwise
				</Button>
				{makeOtherwiseRefusal !== undefined && (
					<p className="text-[13px] leading-relaxed text-nova-text-muted">
						{makeOtherwiseRefusal}
					</p>
				)}
			</div>
		</Row>
	);
}

function TargetControl({
	formUuid,
	current,
	lead,
	canEdit,
	refusalOf,
	onChoose,
}: {
	readonly formUuid: Uuid;
	readonly current: FormLinkTarget;
	readonly lead: string;
	readonly canEdit: boolean;
	readonly refusalOf: (target: FormLinkTarget) => string | undefined;
	readonly onChoose: (target: FormLinkTarget) => void;
}) {
	const [open, setOpen] = useState(false);
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger
				disabled={!canEdit}
				aria-label={`Where it goes: ${lead}`}
				render={
					<Button type="button" variant="field" className="group w-full" />
				}
			>
				<span className="min-w-0 flex-1 break-words text-left text-nova-violet-bright">
					{lead}
				</span>
				<Icon
					icon={tablerChevronDown}
					width="14"
					height="14"
					className="shrink-0 text-nova-text-muted transition-transform group-data-[popup-open]:rotate-180"
				/>
			</PopoverTrigger>
			<PopoverContent align="start" className="w-[22rem] p-2">
				<LinkTargetPickerContent
					formUuid={formUuid}
					current={current}
					refusalOf={refusalOf}
					onChoose={(target) => {
						setOpen(false);
						onChoose(target);
					}}
				/>
			</PopoverContent>
		</Popover>
	);
}

function RemoveControl({
	lead,
	question,
	onConfirm,
}: {
	readonly lead: string;
	readonly question: string;
	readonly onConfirm: () => void;
}) {
	const [confirming, setConfirming] = useState(false);
	const { triggerRef, panelRef } = useInlineConfirmFocus(confirming);

	if (confirming) {
		return (
			<div
				ref={panelRef}
				tabIndex={-1}
				className="space-y-3 rounded-xl border border-nova-rose/30 bg-nova-rose/[0.05] p-3 outline-none"
			>
				<p className="text-[13px] leading-relaxed text-nova-text-secondary">
					{question}
				</p>
				<div className="flex flex-wrap gap-2">
					<Button
						type="button"
						variant="ghost"
						onClick={() => setConfirming(false)}
					>
						Cancel
					</Button>
					<Button
						type="button"
						variant="destructive"
						onClick={() => {
							setConfirming(false);
							onConfirm();
						}}
					>
						Remove it
					</Button>
				</div>
			</div>
		);
	}

	return (
		<Button
			ref={triggerRef}
			type="button"
			variant="ghost-destructive"
			className="w-full justify-start"
			aria-label={`Remove this destination: ${lead}`}
			onClick={() => setConfirming(true)}
		>
			<Icon icon={tablerTrash} width="14" height="14" />
			Remove it
		</Button>
	);
}

function Row({
	title,
	description,
	children,
}: {
	readonly title: string;
	readonly description: string;
	readonly children: React.ReactNode;
}) {
	return (
		<div className="space-y-2">
			<div>
				<h3 className="text-[13px] font-medium leading-5 text-nova-text-secondary">
					{title}
				</h3>
				<p className="mt-0.5 text-[13px] leading-relaxed text-nova-text-muted">
					{description}
				</p>
			</div>
			{children}
		</div>
	);
}
