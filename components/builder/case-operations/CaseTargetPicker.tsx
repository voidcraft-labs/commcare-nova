// components/builder/case-operations/CaseTargetPicker.tsx
//
// Which case a change acts on, in the author's terms.
//
// Targeting is where the platform's own surface concentrates everything
// hard about this feature and offers a bare XPath box for it. Nova's
// model is four named intents instead, and this picker offers exactly
// the ones that are legal here: the session case only where the module
// chooses one before opening its forms, an earlier change's case only
// where such a change exists before this one. Anything it cannot offer
// is disabled with the reason, never hidden.
//
// A runtime expression is preserved and editable when one already exists.
// A parent may also open a local expression draft. The picker never invents
// or commits an empty persisted expression itself.

"use client";

import { Icon } from "@iconify/react/offline";
import tablerChevronDown from "@iconify-icons/tabler/chevron-down";
import { useRef } from "react";
import { Button } from "@/components/shadcn/button";
import {
	DropdownMenu,
	DropdownMenuItem,
	DropdownMenuPopup,
	DropdownMenuPortal,
	DropdownMenuPositioner,
	DropdownMenuTrigger,
} from "@/components/shadcn/dropdown-menu";
import type { Uuid } from "@/lib/doc/types";
import type { CaseTarget } from "@/lib/domain";

export interface TargetChoiceContext {
	/** Earlier creates whose case this target may name, in execution order. */
	readonly priorCreates: readonly {
		readonly uuid: Uuid;
		readonly label: string;
	}[];
	/** Why the session case is unavailable, or `undefined` when it is. */
	readonly sessionUnavailableReason: string | undefined;
	/**
	 * Whether a brand-new case is the ONLY legal target here.
	 *
	 * A create brings its case into existence, so `validateFacets` refuses
	 * every other target kind on one: the choice is not "new is also
	 * allowed", it is "new is all there is". Offering the rest would be
	 * offer-then-reject.
	 */
	readonly newOnly: boolean;
	/** Whether "no case" is legal: an unlink, on a link target only. */
	readonly allowsNone: boolean;
	/**
	 * A target this slot may not point at because it names the operation's
	 * OWN case: a case cannot connect to itself
	 * (`CASE_OPERATION_LINK_INVALID`).
	 */
	readonly excludes?: CaseTarget;
}

/** Whether two targets name the same case identity, for the self-check. */
function sameTarget(left: CaseTarget, right: CaseTarget): boolean {
	if (left.kind !== right.kind) return false;
	if (left.kind === "session") return true;
	if (left.kind === "op" && right.kind === "op") {
		return left.opUuid === right.opUuid;
	}
	return false;
}

/** Why this target is unavailable because it is the change's own case. */
function selfReason(
	target: CaseTarget,
	context: TargetChoiceContext,
): string | undefined {
	return context.excludes !== undefined && sameTarget(target, context.excludes)
		? "This is the case the change itself acts on, and a case cannot connect to itself"
		: undefined;
}

type TargetChoiceVerdict =
	| { readonly ok: true }
	| { readonly ok: false; readonly reason: string };

function rejectedReason(
	target: CaseTarget | null,
	choiceVerdict:
		| ((candidate: CaseTarget | null) => TargetChoiceVerdict)
		| undefined,
): string | undefined {
	const verdict = choiceVerdict?.(target);
	return verdict !== undefined && !verdict.ok ? verdict.reason : undefined;
}

function label(
	target: CaseTarget | null,
	context: TargetChoiceContext,
): string {
	if (target === null) return "Remove this connection";
	switch (target.kind) {
		case "new":
			return "A new case";
		case "session":
			return "The case this form opened";
		case "op": {
			const producer = context.priorCreates.find(
				(create) => create.uuid === target.opUuid,
			);
			return producer === undefined
				? "A case made earlier in this form"
				: `The case from “${producer.label}”`;
		}
		case "expression":
			return "A case found by a calculation";
	}
}

export function CaseTargetPicker({
	value,
	context,
	ariaLabel,
	choiceVerdict,
	onRequestExpression,
	disabled = false,
	onChange,
}: {
	readonly value: CaseTarget | null;
	readonly context: TargetChoiceContext;
	readonly ariaLabel: string;
	/** The shared commit verdict for an otherwise available target. */
	readonly choiceVerdict?: (
		candidate: CaseTarget | null,
	) => TargetChoiceVerdict;
	/** Opens an incomplete calculation in parent-owned local draft state. */
	readonly onRequestExpression?: () => void;
	/** Explicit read-only/viewer state for the trigger. */
	readonly disabled?: boolean;
	readonly onChange: (next: CaseTarget | null) => void;
}) {
	const triggerRef = useRef<HTMLButtonElement>(null);
	const current = label(value, context);
	const effectiveVerdict = disabled ? undefined : choiceVerdict;
	const noneReason = context.allowsNone
		? rejectedReason(null, effectiveVerdict)
		: undefined;
	/* An active target is the exact authored value, not a seed for that
	 * target kind. In particular, selecting an already-active new target must
	 * retain its identity key, and selecting an already-active expression
	 * must retain the whole AST. */
	const newTarget = value?.kind === "new" ? value : ({ kind: "new" } as const);
	const newReason = context.newOnly
		? rejectedReason(newTarget, effectiveVerdict)
		: undefined;
	const sessionTarget = { kind: "session" } as const;
	const sessionReason = context.newOnly
		? undefined
		: (selfReason(sessionTarget, context) ??
			context.sessionUnavailableReason ??
			rejectedReason(sessionTarget, effectiveVerdict));
	const expressionTarget = value?.kind === "expression" ? value : undefined;
	const expressionReason = context.newOnly
		? undefined
		: expressionTarget !== undefined
			? rejectedReason(expressionTarget, effectiveVerdict)
			: onRequestExpression === undefined
				? "This screen cannot start a case-id calculation"
				: undefined;

	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				ref={triggerRef}
				disabled={disabled}
				aria-label={`${ariaLabel}: ${current}`}
				render={
					<Button
						type="button"
						variant="outline"
						className="group h-auto min-h-11 w-full justify-between rounded-lg border border-white/[0.06] bg-nova-deep/50 px-3 py-2 text-sm whitespace-normal not-disabled:hover:border-nova-violet/30 dark:bg-nova-deep/50 dark:not-disabled:hover:bg-nova-deep/50"
					/>
				}
			>
				<span className="min-w-0 flex-1 break-words text-left text-nova-violet-bright">
					{current}
				</span>
				<Icon
					icon={tablerChevronDown}
					width="14"
					height="14"
					className="shrink-0 text-nova-text-muted transition-transform group-data-[popup-open]:rotate-180"
				/>
			</DropdownMenuTrigger>
			<DropdownMenuPortal>
				<DropdownMenuPositioner
					side="bottom"
					align="start"
					sideOffset={4}
					anchor={triggerRef}
					style={{ minWidth: "var(--anchor-width)" }}
				>
					<DropdownMenuPopup className="min-w-0">
						{context.allowsNone && (
							<Choice
								active={value === null}
								title="Remove this connection"
								detail={
									noneReason ??
									"Break the link instead of pointing it somewhere"
								}
								disabled={noneReason !== undefined}
								onClick={() => onChange(null)}
							/>
						)}
						{context.newOnly ? (
							<Choice
								active={value?.kind === "new"}
								title="A new case"
								detail={
									newReason ?? "This change brings the case into existence"
								}
								disabled={newReason !== undefined}
								onClick={() => onChange(newTarget)}
							/>
						) : (
							<>
								<Choice
									active={value?.kind === "session"}
									title="The case this form opened"
									detail={
										sessionReason ??
										"The case someone picked before opening this form"
									}
									disabled={sessionReason !== undefined}
									onClick={() => onChange(sessionTarget)}
								/>
								{context.priorCreates.map((create) => {
									const target = { kind: "op", opUuid: create.uuid } as const;
									const reason =
										selfReason(target, context) ??
										rejectedReason(target, effectiveVerdict);
									return (
										<Choice
											key={create.uuid}
											active={
												value?.kind === "op" && value.opUuid === create.uuid
											}
											title={`The case from \u201c${create.label}\u201d`}
											detail={
												reason ??
												"A case an earlier change in this form creates"
											}
											disabled={reason !== undefined}
											onClick={() => onChange(target)}
										/>
									);
								})}
								<Choice
									active={value?.kind === "expression"}
									title="A case found by a calculation"
									detail={
										expressionReason ??
										"Work the case id out from the answers \u2014 edit it on this screen"
									}
									disabled={expressionReason !== undefined}
									onClick={() => {
										if (expressionTarget !== undefined) {
											onChange(expressionTarget);
										} else {
											onRequestExpression?.();
										}
									}}
								/>
							</>
						)}
					</DropdownMenuPopup>
				</DropdownMenuPositioner>
			</DropdownMenuPortal>
		</DropdownMenu>
	);
}

function Choice({
	active,
	title,
	detail,
	disabled,
	onClick,
}: {
	readonly active: boolean;
	readonly title: string;
	readonly detail: string;
	readonly disabled?: boolean;
	readonly onClick: () => void;
}) {
	return (
		<DropdownMenuItem
			disabled={disabled === true && !active}
			onClick={() => {
				// Choosing the current value is a true no-op. Apart from avoiding a
				// needless commit, this prevents a kind seed from replacing richer
				// active state such as `new.idFrom` or an expression AST.
				if (!active) onClick();
			}}
			className={active ? "bg-nova-violet/10 text-nova-violet-bright" : ""}
		>
			<span className="min-w-0 flex-1 text-left">
				<span className="block break-words">{title}</span>
				<span className="block break-words text-xs text-nova-text-muted">
					{detail}
				</span>
			</span>
		</DropdownMenuItem>
	);
}
