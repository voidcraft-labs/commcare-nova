"use client";

import { Input } from "@/components/shadcn/input";
import type { CaseSelection } from "@/lib/domain";
import { selectableSegmentCls } from "@/lib/styles";

const DEFAULT_MULTIPLE_MAXIMUM = 100;

export interface CaseSelectionSettingProps {
	readonly value: CaseSelection | undefined;
	readonly canEdit: boolean;
	readonly onChange: (next: CaseSelection | undefined) => void;
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
					{canEdit
						? "Choose whether each form opens with one case or several."
						: multiple
							? `People can choose up to ${maximum} cases before continuing`
							: "People choose one case before continuing"}
				</p>
			</div>

			{canEdit && (
				<div className="max-w-xl rounded-2xl border border-white/[0.08] bg-nova-surface/20 p-4">
					<fieldset className="grid grid-cols-2 gap-1 rounded-2xl bg-nova-deep/50 p-1">
						<legend className="sr-only">Cases each form works with</legend>
						<label
							className={`${selectableSegmentCls(!multiple)} has-focus-visible:border-nova-ring has-focus-visible:shadow-(--focus-ring)`}
						>
							<input
								type="radio"
								name="case-selection"
								checked={!multiple}
								onChange={() => onChange(undefined)}
								className="sr-only"
							/>
							One case
						</label>
						<label
							className={`${selectableSegmentCls(multiple)} has-focus-visible:border-nova-ring has-focus-visible:shadow-(--focus-ring)`}
						>
							<input
								type="radio"
								name="case-selection"
								checked={multiple}
								onChange={() => onChange({ kind: "multiple", maximum })}
								className="sr-only"
							/>
							Several cases
						</label>
					</fieldset>

					{multiple && (
						<div className="mt-4 max-w-xs">
							<label
								htmlFor="case-selection-maximum"
								className="text-sm font-medium text-nova-text"
							>
								Most cases a worker can choose
							</label>
							<Input
								id="case-selection-maximum"
								type="number"
								min={1}
								max={100}
								step={1}
								value={maximum}
								onChange={(event) => {
									const parsed = event.currentTarget.valueAsNumber;
									if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
										return;
									}
									onChange({ kind: "multiple", maximum: parsed });
								}}
								aria-describedby="case-selection-maximum-help"
								className="mt-2"
							/>
							<p
								id="case-selection-maximum-help"
								className="mt-1.5 text-[13px] leading-relaxed text-nova-text-muted"
							>
								Choose a number from 1 to 100
							</p>
						</div>
					)}
				</div>
			)}
		</section>
	);
}
