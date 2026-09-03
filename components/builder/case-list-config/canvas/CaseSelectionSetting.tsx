"use client";

import { useEffect, useId, useState } from "react";
import { Input } from "@/components/shadcn/input";
import type { CaseSelection } from "@/lib/domain";
import { selectableSegmentCls } from "@/lib/styles";

const DEFAULT_MULTIPLE_MAXIMUM = 100;

export interface CaseSelectionSettingProps {
	readonly value: CaseSelection | undefined;
	readonly canEdit: boolean;
	readonly onChange: (
		next: CaseSelection | undefined,
		origin?: HTMLElement,
	) => void;
}

/**
 * Results owns how many cases move into the next form. The stored value only
 * represents the exceptional multiple-case path; choosing one case clears it.
 */
export function CaseSelectionSetting({
	value,
	canEdit,
	onChange,
}: CaseSelectionSettingProps) {
	const multiple = value?.kind === "multiple";
	const maximum = value?.maximum ?? DEFAULT_MULTIPLE_MAXIMUM;
	const selectionName = useId();
	const maximumInputId = useId();
	const maximumHelpId = `${maximumInputId}-help`;
	const maximumErrorId = `${maximumInputId}-error`;
	const [maximumDraft, setMaximumDraft] = useState(String(maximum));
	const [maximumBase, setMaximumBase] = useState(String(maximum));
	const [maximumProblem, setMaximumProblem] = useState<
		"range" | "peer-change" | null
	>(null);
	const committedMaximum = String(maximum);
	const dirty = maximumDraft !== maximumBase;
	const peerChanged = committedMaximum !== maximumBase;

	useEffect(() => {
		if (!multiple) {
			setMaximumDraft(committedMaximum);
			setMaximumBase(committedMaximum);
			setMaximumProblem(null);
			return;
		}
		if (committedMaximum === maximumBase || dirty) return;
		setMaximumDraft(committedMaximum);
		setMaximumBase(committedMaximum);
		setMaximumProblem(null);
	}, [committedMaximum, dirty, maximumBase, multiple]);

	const commitMaximum = (origin: HTMLElement) => {
		if (peerChanged) {
			setMaximumProblem("peer-change");
			return;
		}
		const parsed = Number(maximumDraft);
		if (
			maximumDraft.trim() === "" ||
			!Number.isInteger(parsed) ||
			parsed < 1 ||
			parsed > 100
		) {
			setMaximumProblem("range");
			return;
		}
		setMaximumProblem(null);
		if (parsed !== maximum) {
			onChange({ kind: "multiple", maximum: parsed }, origin);
			// The saved setting remains authoritative while its review is open.
			// A confirmed change updates `maximum` and the effect above restores the
			// new value; cancelling leaves no unsaved draft behind.
			setMaximumDraft(maximumBase);
		} else {
			setMaximumDraft(String(parsed));
		}
	};

	const modeHelp = multiple
		? `People choose up to ${maximum} ${maximum === 1 ? "case" : "cases"} and complete the form once. Existing case information does not fill this shared form. Answers entered in the shared form save to every selected case.`
		: "People choose one case. Its saved information fills the form.";
	const maximumProblemMessage =
		maximumProblem === "peer-change"
			? "This limit changed elsewhere while you were editing. Press Esc to use the shared limit, then enter your change again."
			: "Choose a whole number from 1 to 100.";

	return (
		<section aria-labelledby="results-selection-heading">
			<div className="mb-4">
				<h2
					id="results-selection-heading"
					className="font-display tracking-tighter text-[17px] font-semibold text-nova-text"
				>
					Case selection
				</h2>
				<p className="mt-1 text-[13px] leading-relaxed text-nova-text-muted">
					{modeHelp}
				</p>
			</div>

			{canEdit && (
				<div className="max-w-xl rounded-2xl border border-white/[0.08] bg-nova-surface/20 p-4">
					<fieldset className="grid grid-cols-2 gap-1 rounded-2xl bg-nova-deep/50 p-1">
						<legend className="sr-only">Cases each form works with</legend>
						<label
							className={`${selectableSegmentCls(!multiple)} has-[input:focus-visible]:border-nova-ring has-[input:focus-visible]:shadow-(--focus-ring)`}
						>
							<input
								type="radio"
								name={selectionName}
								value="one"
								checked={!multiple}
								onChange={(event) => {
									if (multiple) onChange(undefined, event.currentTarget);
								}}
								className="sr-only"
							/>
							One case
						</label>
						<label
							className={`${selectableSegmentCls(multiple)} has-[input:focus-visible]:border-nova-ring has-[input:focus-visible]:shadow-(--focus-ring)`}
						>
							<input
								type="radio"
								name={selectionName}
								value="several"
								checked={multiple}
								onChange={(event) => {
									if (!multiple) {
										onChange(
											{ kind: "multiple", maximum },
											event.currentTarget,
										);
									}
								}}
								className="sr-only"
							/>
							Several cases
						</label>
					</fieldset>

					{multiple && (
						<div className="mt-4 max-w-xs">
							<label
								htmlFor={maximumInputId}
								className="text-sm font-medium text-nova-text"
							>
								Most cases a worker can choose
							</label>
							<Input
								id={maximumInputId}
								type="number"
								min={1}
								max={100}
								step={1}
								value={maximumDraft}
								onChange={(event) => {
									setMaximumDraft(event.currentTarget.value);
									if (maximumProblem !== null) {
										setMaximumProblem(null);
									}
								}}
								onBlur={(event) => commitMaximum(event.currentTarget)}
								onKeyDown={(event) => {
									if (event.key === "Enter") {
										event.preventDefault();
										event.stopPropagation();
										commitMaximum(event.currentTarget);
									} else if (event.key === "Escape") {
										event.preventDefault();
										event.stopPropagation();
										setMaximumDraft(committedMaximum);
										setMaximumBase(committedMaximum);
										setMaximumProblem(null);
									}
								}}
								aria-invalid={maximumProblem !== null || undefined}
								aria-describedby={
									maximumProblem !== null ? maximumErrorId : maximumHelpId
								}
								className="mt-2"
							/>
							{maximumProblem !== null ? (
								<p
									id={maximumErrorId}
									role="alert"
									className="mt-1.5 text-[13px] leading-relaxed text-nova-rose"
								>
									{maximumProblemMessage}
								</p>
							) : (
								<p
									id={maximumHelpId}
									className="mt-1.5 text-[13px] leading-relaxed text-nova-text-muted"
								>
									Choose a whole number from 1 to 100.
								</p>
							)}
						</div>
					)}

					{multiple && (
						<p className="mt-4 text-[13px] leading-relaxed text-nova-text-muted">
							A question without a starting answer begins blank. Leaving it
							blank keeps each case's current value.
						</p>
					)}
				</div>
			)}
		</section>
	);
}
