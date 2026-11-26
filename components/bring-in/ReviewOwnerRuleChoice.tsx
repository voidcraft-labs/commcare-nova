/**
 * One owner rule the places CommCare HQ holds cannot satisfy: the forms that
 * use it, why the places give it no one place, and the one explicit rule Nova
 * offers, never chosen for the person. Choosing one place stays a row that
 * says why it can't be chosen here: the places change in CommCare HQ.
 *
 * Every word is `lib/publish/ownerRuleCopy.ts`'s. The bring-in review and the
 * HQ-changes panel both draw it. Where a press found it unanswered, it brings
 * itself into view and moves focus to its answer.
 */
"use client";

import { type ReactElement, useEffect, useId, useRef } from "react";
import { FieldLegend, FieldSet } from "@/components/shadcn/field";
import { RadioGroup, RadioGroupItem } from "@/components/shadcn/radio-group";
import type { OwnerRuleChoice, ReviewOwnerRule } from "@/lib/deployment";
import {
	OWNER_RULE_NEEDS_ANSWER,
	OWNER_RULE_ONE_PLACE_LABEL,
	OWNER_RULE_ONE_PLACE_REASON,
	OWNER_RULE_WORKER_DETAIL,
	OWNER_RULE_WORKER_LABEL,
	ownerRuleBody,
	ownerRuleTitle,
} from "@/lib/publish/ownerRuleCopy";
import { useDeferredFocus } from "@/lib/ui/hooks/useDeferredFocus";

/** The value of the row no one can choose here. */
const ONE_PLACE = "one-place";

export function ReviewOwnerRuleChoice({
	rule,
	domain,
	value,
	onValueChange,
	needsChoice,
}: {
	readonly rule: ReviewOwnerRule;
	/** The project space the places are read from. */
	readonly domain: string;
	/** The answer given, or null where none is. */
	readonly value: OwnerRuleChoice | null;
	readonly onValueChange: (choice: OwnerRuleChoice) => void;
	/** Set where a press found this rule unanswered; each new `nonce` focuses it again. */
	readonly needsChoice: { readonly nonce: number } | null;
}): ReactElement {
	const legendId = useId();
	const bodyId = useId();
	const fieldsetRef = useRef<HTMLFieldSetElement>(null);
	const focusLater = useDeferredFocus();
	const nonce = needsChoice?.nonce ?? null;

	useEffect(() => {
		if (nonce === null) return;
		return focusLater(() => {
			const fieldset = fieldsetRef.current;
			if (fieldset === null) return;
			fieldset.scrollIntoView({ block: "nearest", behavior: "smooth" });
			fieldset
				.querySelector<HTMLElement>(
					'[role="radio"]:not([aria-disabled="true"])',
				)
				?.focus();
		});
	}, [nonce, focusLater]);

	return (
		<FieldSet
			ref={fieldsetRef}
			className="gap-2 rounded-lg border border-nova-border bg-nova-well px-3 py-3"
			data-review-owner-rule={rule.level}
		>
			<FieldLegend
				id={legendId}
				className="mb-0 text-[15px] font-medium text-nova-text [overflow-wrap:anywhere]"
			>
				{ownerRuleTitle(rule)}
			</FieldLegend>
			<p
				id={bodyId}
				className="text-[13px] leading-relaxed text-nova-text-secondary [overflow-wrap:anywhere]"
			>
				{ownerRuleBody(rule, domain)}
			</p>
			<RadioGroup<string | null>
				aria-labelledby={legendId}
				aria-describedby={bodyId}
				value={value}
				onValueChange={(choice) => {
					if (choice === "worker") onValueChange(choice);
				}}
			>
				<RadioGroupItem<string | null>
					value="worker"
					description={OWNER_RULE_WORKER_DETAIL}
				>
					{OWNER_RULE_WORKER_LABEL}
				</RadioGroupItem>
				<RadioGroupItem<string | null>
					value={ONE_PLACE}
					unavailableReason={OWNER_RULE_ONE_PLACE_REASON}
				>
					{OWNER_RULE_ONE_PLACE_LABEL}
				</RadioGroupItem>
			</RadioGroup>
			{needsChoice !== null && value === null ? (
				<p role="alert" className="text-[13px] font-medium text-nova-text">
					{OWNER_RULE_NEEDS_ANSWER}
				</p>
			) : null}
		</FieldSet>
	);
}
