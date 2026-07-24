"use client";
import { MediaDisplay } from "@/components/builder/media/MediaDisplay";
import { bySortKey } from "@/lib/doc/order/compare";
import type { SingleSelectField } from "@/lib/domain";
import { PreviewMarkdown } from "@/lib/markdown";
import type { FieldState } from "@/lib/preview/engine/types";
import { useEditMode } from "@/lib/session/hooks";
import { LookupChoicesEmpty, LookupChoicesLoading } from "./LookupChoiceStates";
import { ValidationError } from "./ValidationError";

interface SelectOneFieldProps {
	/** A single-select field; `options` is required on this kind. */
	field: SingleSelectField;
	state: FieldState;
	onChange: (value: string) => void;
	onBlur: () => void;
}

/**
 * Single-select radio field for form preview. Each option renders a real
 * `<input type="radio">` (visually hidden via sr-only) inside a `<label>`.
 * The outer `<fieldset>` groups the radios semantically and captures `onBlur`
 * for touch tracking.
 */
export function SelectOneField({
	field,
	state,
	onChange,
	onBlur,
}: SelectOneFieldProps) {
	// Static options render in DISPLAY order (`sort-by-(order, uuid)`, the
	// same sequence the wire XForm emits its `<item>`s in), never `options`
	// array position. A lookup-backed select instead reads the ENGINE's
	// live filtered choices (already in authored row order); while the
	// fixture snapshot is still loading they are undefined and the list
	// shows its loading state.
	const lookupBacked = field.optionsSource !== undefined;
	// `key` is display identity: static options are validator-unique by
	// value; lookup rows guarantee neither unique nor non-blank values,
	// so their choices carry the source row id.
	const options: ReadonlyArray<{
		key: string;
		value: string;
		label: string;
		media?: (typeof field.options)[number]["media"];
	}> = lookupBacked
		? (state.choices ?? [])
		: [...(field.options ?? [])]
				.sort(bySortKey)
				.map((opt) => ({ ...opt, key: opt.value }));
	const showError = state.touched && !state.valid;
	const isEditMode = useEditMode() === "edit";

	if (lookupBacked && state.choices === undefined) {
		return <LookupChoicesLoading />;
	}
	return (
		<fieldset className="m-0 border-none p-0" onBlur={onBlur}>
			<div className="space-y-1.5">
				{lookupBacked && options.length === 0 && <LookupChoicesEmpty />}
				{options.map((opt) => {
					/* A blank value cell must not render pre-selected: the engine
					 * stores "" for an unanswered field, and the device treats an
					 * unanswered question as no selection, not as the blank
					 * choice. (Blank values are export-rejected; this keeps the
					 * transient state honest.) */
					const isSelected = opt.value !== "" && state.value === opt.value;
					return (
						<label
							key={opt.key}
							className={`flex items-center gap-3 px-3 py-2 rounded-lg cursor-pointer transition-colors ${
								isSelected
									? "bg-pv-accent/10 border border-pv-accent/30"
									: showError
										? "bg-pv-input-bg border border-nova-rose/30 hover:border-nova-rose/50"
										: "bg-pv-input-bg border border-pv-input-border hover:border-pv-input-focus"
							}`}
						>
							<input
								type="radio"
								name={state.path}
								value={opt.value}
								checked={isSelected}
								onChange={() => onChange(opt.value)}
								className="sr-only"
							/>
							<div
								className={`w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 ${
									isSelected ? "border-pv-accent" : "border-nova-text-muted"
								}`}
							>
								{isSelected && (
									<div className="w-2 h-2 rounded-full bg-pv-accent" />
								)}
							</div>
							<span className="preview-markdown text-sm text-nova-text">
								<PreviewMarkdown inline>{opt.label}</PreviewMarkdown>
							</span>
							{/* Per-option media (the image/audio that makes a visual
						    choice concrete) — compact so a list of options stays
						    scannable. */}
							<MediaDisplay
								media={opt.media}
								interactive={!isEditMode}
								imageClassName="max-h-24 max-w-full rounded object-contain"
							/>
						</label>
					);
				})}
			</div>
			{showError && state.errorMessage && (
				<ValidationError
					message={state.errorMessage}
					media={
						"validate_msg_media" in field ? field.validate_msg_media : undefined
					}
				/>
			)}
		</fieldset>
	);
}
