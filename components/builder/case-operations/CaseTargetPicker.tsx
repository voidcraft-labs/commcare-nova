// components/builder/case-operations/CaseTargetPicker.tsx
//
// Which case a change acts on, in the author's terms.
//
// Targeting is where the platform's own surface concentrates everything
// hard about this feature and offers a bare XPath box for it. Nova's
// model is four named intents instead, and this picker offers exactly
// the ones that are legal here — the session case only where the module
// chooses one before opening its forms, an earlier change's case only
// where such a change exists before this one. Anything it cannot offer
// is disabled with the reason, never hidden.
//
// The runtime-expression arm deliberately commits a placeholder and
// hands off: an expression needs the full canvas, which is exactly
// where the detail screen edits it.

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
import { literal, term } from "@/lib/domain/predicate";

export interface TargetChoiceContext {
	/** Earlier creates whose case this target may name, in execution order. */
	readonly priorCreates: readonly {
		readonly uuid: Uuid;
		readonly label: string;
	}[];
	/** Why the session case is unavailable, or `undefined` when it is. */
	readonly sessionUnavailableReason: string | undefined;
	/** Whether a brand-new case is a legal target here (creates only). */
	readonly allowsNew: boolean;
	/** Whether "no case" is legal — an unlink, on a link target only. */
	readonly allowsNone: boolean;
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
	onChange,
}: {
	readonly value: CaseTarget | null;
	readonly context: TargetChoiceContext;
	readonly ariaLabel: string;
	readonly onChange: (next: CaseTarget | null) => void;
}) {
	const triggerRef = useRef<HTMLButtonElement>(null);
	const current = label(value, context);

	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				ref={triggerRef}
				aria-label={`${ariaLabel}: ${current}`}
				render={
					<Button
						type="button"
						variant="outline"
						size="xl"
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
								detail="Break the link instead of pointing it somewhere"
								onClick={() => onChange(null)}
							/>
						)}
						{context.allowsNew && (
							<Choice
								active={value?.kind === "new"}
								title="A new case"
								detail="This change brings the case into existence"
								onClick={() => onChange({ kind: "new" })}
							/>
						)}
						<Choice
							active={value?.kind === "session"}
							title="The case this form opened"
							detail={
								context.sessionUnavailableReason ??
								"The case someone picked before opening this form"
							}
							disabled={context.sessionUnavailableReason !== undefined}
							onClick={() => onChange({ kind: "session" })}
						/>
						{context.priorCreates.map((create) => (
							<Choice
								key={create.uuid}
								active={value?.kind === "op" && value.opUuid === create.uuid}
								title={`The case from “${create.label}”`}
								detail="A case an earlier change in this form creates"
								onClick={() => onChange({ kind: "op", opUuid: create.uuid })}
							/>
						))}
						<Choice
							active={value?.kind === "expression"}
							title="A case found by a calculation"
							detail="Work the case id out from the answers — edit it on this screen"
							onClick={() =>
								onChange({
									kind: "expression",
									expr: term(literal("")),
								})
							}
						/>
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
			onClick={onClick}
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
