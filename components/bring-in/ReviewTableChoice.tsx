/**
 * One lookup table whose tag meets a table the Project already has: what
 * differs, the two answers with what each does, neither chosen for the
 * person, and the way out to another Project. An answer that cannot be
 * chosen stays a row that says why.
 *
 * Every word and which line shows is `bringInModel.ts::tableChoiceView`'s.
 * This draws it, hands a choice up and, where Bring it in found this table
 * unanswered, brings it into view and moves focus to it.
 */
"use client";

import { type ReactElement, useEffect, useId, useRef } from "react";
import { Button } from "@/components/shadcn/button";
import { FieldLegend, FieldSet } from "@/components/shadcn/field";
import { RadioGroup, RadioGroupItem } from "@/components/shadcn/radio-group";
import type { LookupTableChoice, ReviewTable } from "@/lib/deployment";
import { BRING_IN_ACTIONS } from "@/lib/publish/bringInCopy";
import { useDeferredFocus } from "@/lib/ui/hooks/useDeferredFocus";
import { tableChoiceView } from "./bringInModel";

export function ReviewTableChoice({
	table,
	project,
	domain,
	value,
	onValueChange,
	needsChoice,
	onChooseAnotherProject,
}: {
	readonly table: ReviewTable;
	/** The name of the Project the app is added to. */
	readonly project: string;
	/** The project space the app is read from. */
	readonly domain: string;
	/** The answer given, or null where none is. */
	readonly value: LookupTableChoice | null;
	readonly onValueChange: (choice: LookupTableChoice) => void;
	/**
	 * Set where Bring it in found this table unanswered. Each new `nonce`
	 * brings the group into view and moves focus to it again.
	 */
	readonly needsChoice: { readonly nonce: number } | null;
	readonly onChooseAnotherProject: () => void;
}): ReactElement {
	const view = tableChoiceView(table, project, domain, needsChoice !== null);
	const legendId = useId();
	const bodyId = useId();
	const fieldsetRef = useRef<HTMLFieldSetElement>(null);
	const legendRef = useRef<HTMLLegendElement>(null);
	const focusLater = useDeferredFocus();
	const nonce = needsChoice?.nonce ?? null;

	useEffect(() => {
		if (nonce === null) return;
		return focusLater(() => {
			const fieldset = fieldsetRef.current;
			if (fieldset === null) return;
			fieldset.scrollIntoView({ block: "nearest", behavior: "smooth" });
			const radio = fieldset.querySelector<HTMLElement>(
				'[role="radio"]:not([aria-disabled="true"])',
			);
			(radio ?? legendRef.current)?.focus();
		});
	}, [nonce, focusLater]);

	return (
		<FieldSet
			ref={fieldsetRef}
			className="gap-2 rounded-lg border border-nova-border bg-nova-well px-3 py-3"
			data-review-table-choice={table.tag}
		>
			<FieldLegend
				ref={legendRef}
				id={legendId}
				tabIndex={-1}
				className="nova-focusable-inset mb-0 rounded-md text-[15px] font-medium text-nova-text [overflow-wrap:anywhere]"
			>
				{view.legend}
			</FieldLegend>
			<p
				id={bodyId}
				className="text-[13px] leading-relaxed text-nova-text-secondary [overflow-wrap:anywhere]"
			>
				{view.body}
			</p>
			<RadioGroup<LookupTableChoice | null>
				aria-labelledby={legendId}
				aria-describedby={bodyId}
				value={value}
				onValueChange={(choice) => {
					if (choice !== null) onValueChange(choice);
				}}
			>
				{view.rows.map((row) => (
					<RadioGroupItem<LookupTableChoice | null>
						key={row.choice}
						value={row.choice}
						description={
							row.lines.length > 0
								? row.lines.map((line) => (
										<span key={line} className="block">
											{line}
										</span>
									))
								: undefined
						}
						unavailableReason={row.unavailableReason ?? undefined}
					>
						{row.label}
					</RadioGroupItem>
				))}
			</RadioGroup>
			{view.alert !== null ? (
				<p role="alert" className="text-[13px] font-medium text-nova-text">
					{view.alert}
				</p>
			) : null}
			<div className="flex flex-col items-start gap-1">
				{view.otherProject !== null ? (
					<p className="text-[13px] text-nova-text-secondary">
						{view.otherProject}
					</p>
				) : null}
				<Button variant="ghost" onClick={onChooseAnotherProject}>
					{BRING_IN_ACTIONS.chooseAnotherProject}
				</Button>
			</div>
		</FieldSet>
	);
}
