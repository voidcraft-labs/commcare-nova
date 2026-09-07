/**
 * Local-draft editors for values whose committed schema is stricter than a
 * useful typing state. Keystrokes stay local; blur / Enter / the explicit
 * Apply action submits one born-valid mutation through the inline commit gate.
 *
 * A peer edit never gets overwritten silently. If the committed value changes
 * while this draft is dirty, the typed text stays visible and commit is
 * refused until the author presses Escape (or otherwise restores the current
 * shared value).
 */
"use client";

import {
	type FocusEvent,
	type KeyboardEvent,
	type Ref,
	useEffect,
	useId,
	useRef,
	useState,
} from "react";
import { Button } from "@/components/shadcn/button";
import { Input } from "@/components/shadcn/input";
import { Textarea } from "@/components/shadcn/textarea";
import type { CommitOutcome } from "@/lib/domain";

import {
	acceptedValuesFromDraft,
	decideDraftCommit,
	firstDraftRefusal,
} from "./draftCommitModel";

export function DraftCommitInput({
	id,
	value,
	disabled,
	onCommit,
	validate,
	normalize = (draft) => draft.trim(),
	inputRef,
	className,
	ariaDescribedBy,
	validateAsYouType = false,
}: {
	readonly id: string;
	readonly value: string;
	readonly disabled: boolean;
	readonly onCommit: (value: string) => CommitOutcome;
	readonly validate?: (value: string) => string | undefined;
	readonly normalize?: (value: string) => string;
	readonly inputRef?: Ref<HTMLInputElement>;
	readonly className?: string;
	readonly ariaDescribedBy?: string;
	readonly validateAsYouType?: boolean;
}) {
	const [draft, setDraft] = useState(value);
	const [baseValue, setBaseValue] = useState(value);
	const [refusal, setRefusal] = useState<string | undefined>(undefined);
	const problemId = `${id}-problem`;
	const dirty = draft !== baseValue;
	const liveProblem =
		refusal ??
		(validateAsYouType && dirty ? validate?.(normalize(draft)) : undefined);

	useEffect(() => {
		if (value === baseValue) return;
		if (!dirty) {
			setDraft(value);
			setBaseValue(value);
			setRefusal(undefined);
		}
	}, [baseValue, dirty, value]);

	const restore = () => {
		setDraft(value);
		setBaseValue(value);
		setRefusal(undefined);
	};

	const commit = () => {
		const decision = decideDraftCommit({
			draft,
			baseValue,
			currentValue: value,
			disabled,
			normalize,
			validate,
		});
		if (decision.kind === "ignored") return;
		if (decision.kind === "refused") {
			setRefusal(decision.message);
			return;
		}
		const next = decision.value;
		if (decision.kind === "unchanged") {
			restore();
			return;
		}

		const outcome = onCommit(next);
		const message = firstDraftRefusal(outcome);
		if (message !== undefined) {
			setRefusal(message);
			return;
		}
		setDraft(next);
		setBaseValue(next);
		setRefusal(undefined);
	};

	return (
		<>
			<Input
				ref={inputRef}
				id={id}
				value={draft}
				disabled={disabled}
				autoComplete="off"
				data-1p-ignore
				aria-invalid={liveProblem === undefined ? undefined : true}
				aria-describedby={
					[ariaDescribedBy, liveProblem === undefined ? undefined : problemId]
						.filter(Boolean)
						.join(" ") || undefined
				}
				onChange={(event) => {
					setDraft(event.target.value);
					setRefusal(undefined);
				}}
				onBlur={commit}
				onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
					if (event.key === "Enter") {
						event.preventDefault();
						event.stopPropagation();
						commit();
					} else if (event.key === "Escape") {
						event.preventDefault();
						event.stopPropagation();
						restore();
					}
				}}
				className={className}
			/>
			{liveProblem !== undefined && (
				<span
					id={problemId}
					role="alert"
					className="text-[12px] text-nova-rose"
				>
					{liveProblem}
				</span>
			)}
		</>
	);
}

/** A newline-authored list with both blur commit and an explicit Apply affordance. */
export function DraftLinesField({
	id,
	value,
	disabled,
	onCommit,
	ariaDescribedBy,
}: {
	readonly id: string;
	readonly value: readonly string[];
	readonly disabled: boolean;
	readonly onCommit: (value: readonly string[] | null) => CommitOutcome;
	readonly ariaDescribedBy?: string;
}) {
	const committedText = value.join("\n");
	const [draft, setDraft] = useState(committedText);
	const [baseValue, setBaseValue] = useState(committedText);
	const [refusal, setRefusal] = useState<string | undefined>(undefined);
	const applyRef = useRef<HTMLButtonElement>(null);
	const problemId = useId();
	const hintId = `${problemId}-hint`;
	const dirty = draft !== baseValue;

	useEffect(() => {
		if (committedText === baseValue) return;
		if (!dirty) {
			setDraft(committedText);
			setBaseValue(committedText);
			setRefusal(undefined);
		}
	}, [baseValue, committedText, dirty]);

	const restore = () => {
		setDraft(committedText);
		setBaseValue(committedText);
		setRefusal(undefined);
	};

	const commit = () => {
		const decision = decideDraftCommit({
			draft,
			baseValue,
			currentValue: committedText,
			disabled,
			normalize: (value) => acceptedValuesFromDraft(value).join("\n"),
			skipPristine: true,
		});
		if (decision.kind === "ignored") return;
		if (decision.kind === "refused") {
			setRefusal(decision.message);
			return;
		}
		const nextText = decision.value;
		if (decision.kind === "unchanged") {
			restore();
			return;
		}
		const lines = acceptedValuesFromDraft(nextText);

		const outcome = onCommit(lines.length === 0 ? null : lines);
		const message = firstDraftRefusal(outcome);
		if (message !== undefined) {
			setRefusal(message);
			return;
		}
		setDraft(nextText);
		setBaseValue(nextText);
		setRefusal(undefined);
	};

	return (
		<>
			<Textarea
				id={id}
				value={draft}
				disabled={disabled}
				autoComplete="off"
				data-1p-ignore
				rows={3}
				placeholder="One per line. Leave empty to accept any text."
				aria-invalid={refusal === undefined ? undefined : true}
				aria-describedby={
					[
						hintId,
						ariaDescribedBy,
						refusal === undefined ? undefined : problemId,
					]
						.filter(Boolean)
						.join(" ") || undefined
				}
				onChange={(event) => {
					setDraft(event.target.value);
					setRefusal(undefined);
				}}
				onBlur={(event: FocusEvent<HTMLTextAreaElement>) => {
					if (event.relatedTarget === applyRef.current) return;
					commit();
				}}
				onKeyDown={(event) => {
					if (event.key === "Escape") {
						event.preventDefault();
						event.stopPropagation();
						restore();
					} else if (
						event.key === "Enter" &&
						(event.metaKey || event.ctrlKey)
					) {
						event.preventDefault();
						event.stopPropagation();
						commit();
					}
				}}
				className="text-[13px]"
			/>
			<div className="flex items-center justify-between gap-3">
				<span id={hintId} className="text-[12px] text-nova-text-muted">
					One value per line.
				</span>
				<Button
					ref={applyRef}
					type="button"
					variant="ghost-action"
					disabled={disabled || !dirty}
					onClick={commit}
					className="shrink-0"
				>
					Apply accepted values
				</Button>
			</div>
			{refusal !== undefined && (
				<span
					id={problemId}
					role="alert"
					className="text-[12px] text-nova-rose"
				>
					{refusal}
				</span>
			)}
		</>
	);
}
