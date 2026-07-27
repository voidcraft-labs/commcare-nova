// components/builder/shared/cards/expression/IdOfCard.tsx
//
// "The case an earlier change made" as a value.
//
// The offered set is the creates already in scope at this point in the
// sequence — the same set the type checker admits
// (`TypeContext.operationIds`) — so the picker cannot author a reference
// to a case that does not exist yet. Outside a case operation the
// context carries no scope at all, and the card preserves the saved
// reference read-only rather than pretending it can be retargeted here.

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
import { Input } from "@/components/shadcn/input";
import { asUuid } from "@/lib/domain";
import { idOf, type ValueExpression } from "@/lib/domain/predicate";
import { usePredicateEditContext } from "../../editorContext";
import type { ExpressionEditContext } from "../../expressionEditorSchemas";
import type { EditorPath } from "../../path";

export function idOfDefault(
	ctx: ExpressionEditContext,
): Extract<ValueExpression, { kind: "id-of" }> {
	// The nearest earlier create is what an author reaching for this almost
	// always means. A surface with no creates in scope never offers the kind,
	// so the placeholder below is unreachable through the menu and exists only
	// to keep the seed total.
	const nearest = ctx.operationScope?.creates.at(-1);
	return idOf(nearest?.uuid ?? asUuid("00000000-0000-4000-8000-000000000000"));
}

export function IdOfCard({
	value,
	onChange,
}: {
	readonly value: Extract<ValueExpression, { kind: "id-of" }>;
	readonly onChange: (next: ValueExpression) => void;
	readonly path: EditorPath;
}) {
	const { operationScope } = usePredicateEditContext();
	const triggerRef = useRef<HTMLButtonElement>(null);

	if (operationScope === undefined) {
		return (
			<div className="space-y-1.5">
				<Input
					value={value.opUuid}
					readOnly
					aria-label="Referenced case change"
				/>
				<p className="text-[13px] leading-relaxed text-nova-text-muted">
					Uses the case an earlier change creates. Open the form’s case changes
					to choose a different one.
				</p>
			</div>
		);
	}

	const creates = operationScope.creates;
	const current = creates.find((create) => create.uuid === value.opUuid);
	const missing = current === undefined;

	return (
		<div className="space-y-1.5">
			<DropdownMenu>
				<DropdownMenuTrigger
					ref={triggerRef}
					aria-label={`Case from an earlier change: ${current?.label ?? "choose a change"}${missing ? ", not available at this point" : ""}`}
					render={
						<Button
							type="button"
							variant="outline"
							size="xl"
							className="group h-auto min-h-11 w-full justify-between rounded-lg border border-white/[0.06] bg-nova-deep/50 px-3 py-2 text-sm whitespace-normal not-disabled:hover:border-nova-violet/30 dark:bg-nova-deep/50 dark:not-disabled:hover:bg-nova-deep/50"
						/>
					}
				>
					<span className="min-w-0 flex-1 text-left">
						<span className="block break-words text-nova-violet-bright">
							{current?.label ?? "Choose an earlier change"}
						</span>
						{missing ? (
							<span className="block text-xs font-normal text-nova-rose">
								Not available at this point in the sequence
							</span>
						) : null}
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
							{creates.length === 0 ? (
								<div
									className="px-3 py-2.5 text-[13px] leading-5 text-nova-text-secondary"
									role="presentation"
								>
									No earlier change creates a case yet.
								</div>
							) : null}
							{creates.map((create) => (
								<DropdownMenuItem
									key={create.uuid}
									onClick={() => onChange(idOf(create.uuid))}
									className={
										create.uuid === value.opUuid
											? "bg-nova-violet/10 text-nova-violet-bright"
											: ""
									}
								>
									<span className="min-w-0 flex-1 break-words">
										{create.label}
									</span>
								</DropdownMenuItem>
							))}
						</DropdownMenuPopup>
					</DropdownMenuPositioner>
				</DropdownMenuPortal>
			</DropdownMenu>
			<p className="text-[13px] leading-relaxed text-nova-text-muted">
				Uses the case that change creates
			</p>
		</div>
	);
}
