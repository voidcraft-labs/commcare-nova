"use client";

import { useEffect, useId, useState } from "react";
import { Input } from "@/components/shadcn/input";
import {
	CASE_LIST_EMPTY_TEXT_DEFAULT,
	CASE_LIST_SELECT_TEXT_DEFAULT,
} from "@/lib/domain";

export type CaseListWordingSlot = "emptyText" | "selectButtonText";

export interface CaseListWordingSettingProps {
	readonly emptyText: string | undefined;
	readonly selectButtonText: string | undefined;
	/** Whether the list lets workers choose several cases, the only Continue
	 *  the label reaches. */
	readonly several: boolean;
	readonly canEdit: boolean;
	/** `null` restores the ordinary text. */
	readonly onChange: (slot: CaseListWordingSlot, next: string | null) => void;
}

/**
 * The case list's own words: what an empty list says, and the label of
 * Continue after choosing several cases. Web Apps shows both; Android keeps
 * its own wording, which the help line says.
 */
export function CaseListWordingSetting({
	emptyText,
	selectButtonText,
	several,
	canEdit,
	onChange,
}: CaseListWordingSettingProps) {
	return (
		<section aria-labelledby="results-wording-heading">
			<div className="mb-4">
				<h2
					id="results-wording-heading"
					className="font-display tracking-tighter text-[17px] font-semibold text-nova-text"
				>
					List wording
				</h2>
				<p className="mt-1 text-[13px] leading-relaxed text-nova-text-muted">
					Web Apps shows these words. Android keeps its own.
				</p>
			</div>
			<div className="max-w-xl space-y-4 rounded-2xl border border-white/[0.08] bg-nova-surface/20 p-4">
				<WordingInput
					label="When the list is empty"
					value={emptyText}
					placeholder={CASE_LIST_EMPTY_TEXT_DEFAULT}
					canEdit={canEdit}
					onCommit={(next) => onChange("emptyText", next)}
				/>
				{several && (
					<WordingInput
						label="Continue after choosing cases"
						value={selectButtonText}
						placeholder={CASE_LIST_SELECT_TEXT_DEFAULT}
						canEdit={canEdit}
						onCommit={(next) => onChange("selectButtonText", next)}
					/>
				)}
			</div>
		</section>
	);
}

function WordingInput({
	label,
	value,
	placeholder,
	canEdit,
	onCommit,
}: {
	readonly label: string;
	readonly value: string | undefined;
	readonly placeholder: string;
	readonly canEdit: boolean;
	readonly onCommit: (next: string | null) => void;
}) {
	const id = useId();
	const [draft, setDraft] = useState(value ?? "");
	useEffect(() => setDraft(value ?? ""), [value]);
	const commit = () => {
		const next = draft.trim();
		if (next === (value ?? "")) return;
		onCommit(next === "" || next === placeholder ? null : next);
	};
	return (
		<div className="space-y-1.5">
			<label htmlFor={id} className="text-[13px] font-medium text-nova-text">
				{label}
			</label>
			<Input
				id={id}
				value={draft}
				placeholder={placeholder}
				disabled={!canEdit}
				onChange={(event) => setDraft(event.currentTarget.value)}
				onBlur={commit}
				onKeyDown={(event) => {
					if (event.key === "Enter") commit();
					if (event.key === "Escape") setDraft(value ?? "");
				}}
			/>
		</div>
	);
}
