"use client";
import { MediaDisplay } from "@/components/builder/media/MediaDisplay";
import { useFieldTextForm } from "@/lib/doc/hooks/useFieldTextForm";
import { useProseProjection } from "@/lib/doc/hooks/useProseProjection";
import {
	labelShowsAsTyped,
	type SelectOption,
	type SingleSelectField,
} from "@/lib/domain";
import { choiceLayoutForPlatform } from "@/lib/domain/questionDisplay";
import { PREVIEW_LABEL_RENDERING, PreviewMarkdown } from "@/lib/markdown";
import type { FieldState } from "@/lib/preview/engine/types";
import {
	useEditMode,
	usePreviewPlatform,
	usePreviewPlatformRules,
} from "@/lib/session/hooks";
import { AndroidChoiceGrid } from "./AndroidChoiceGrid";
import { ChoicePresentation } from "./ChoicePresentation";
import { focusChosenChoice, retainChoiceFocus } from "./choiceLabelActivation";
import { LookupChoicesEmpty, LookupChoicesLoading } from "./LookupChoiceStates";
import { ValidationError } from "./ValidationError";

interface SelectOneFieldProps {
	/** A single-select field; `options` is required on this kind. */
	field: SingleSelectField;
	state: FieldState;
	/** Visible question label rendered by InteractiveFormRenderer. */
	labelledBy?: string;
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
	labelledBy,
	onChange,
	onBlur,
}: SelectOneFieldProps) {
	// Static options render in their authored array sequence, the same sequence
	// the wire XForm emits its `<item>`s in. A lookup-backed select reads the ENGINE's
	// live filtered choices (already in authored row order); while the
	// fixture snapshot is still loading they are undefined and the list
	// shows its loading state.
	const dynamicChoices = field.optionsSource.kind !== "inline";
	// The engine only resolves option labels for a field whose label or hint
	// already carries a reference, so an option that references something on a
	// plainly-labelled question arrives here unresolved: spell it against the
	// document rather than showing repair text for a healthy reference.
	const projectProse = useProseProjection();
	// `key` is display identity: static options are validator-unique by
	// value; lookup rows guarantee neither unique nor non-blank values,
	// so their choices carry the source row id.
	const options: ReadonlyArray<{
		key: string;
		value: string;
		label: string;
		media?: SelectOption["media"];
		plainLabel?: SelectOption["plainLabel"];
	}> = dynamicChoices
		? (state.choices ?? [])
		: field.optionsSource.kind === "inline"
			? field.optionsSource.options.map((opt) => ({
					...opt,
					key: opt.value,
					label:
						state.resolvedOptionLabels?.[opt.uuid] ?? projectProse(opt.label),
				}))
			: [];
	const showError = state.touched && !state.valid;
	const isEditMode = useEditMode() === "edit";
	/* Choice media draws on Android and in edit mode; Web Apps draws none
	 * (manifest `questions/choice-image`, `choice-audio-video`). */
	const rules = usePreviewPlatformRules();
	const platform = usePreviewPlatform();
	const textForm = useFieldTextForm(field.uuid);
	const drawChoiceMedia = isEditMode || rules.choiceMedia;
	const labelRendering = isEditMode
		? PREVIEW_LABEL_RENDERING
		: rules.labelMarkdown;
	/* A choice shown as typed (its own `plainLabel`, or its form's
	 * `plainText`) shows as written in edit mode and where the platform draws
	 * it so (Android); Web Apps formats every choice (`rules.plainChoice`). */
	const plainChoiceAsWritten = isEditMode || rules.plainChoice === "literal";

	if (dynamicChoices && state.choices === undefined) {
		return <LookupChoicesLoading />;
	}
	const layout = choiceLayoutForPlatform(field, platform);

	if (layout?.kind === "grid" && platform === "android")
		return (
			<div>
				<AndroidChoiceGrid
					key={options.map((o) => o.media?.image ?? "").join(":")}
					options={options}
					columns={layout.columns}
					labelledBy={labelledBy}
					path={state.path}
					value={state.value}
					editMode={isEditMode}
					onChoose={onChange}
					onBlur={onBlur}
				/>
				{dynamicChoices && options.length === 0 && <LookupChoicesEmpty />}
				{showError && state.errorMessage && (
					<ValidationError message={state.errorMessage} />
				)}
			</div>
		);
	const row =
		layout?.kind === "row-without-label" ||
		(layout?.kind === "row" && platform === "android");
	const hideChoiceLabels = layout?.kind === "row-without-label";
	if (
		layout &&
		(layout.kind === "dropdown" ||
			layout.kind === "headings" ||
			layout.kind === "search" ||
			(layout.kind === "buttons" && platform === "web-apps"))
	) {
		return (
			<div>
				<ChoicePresentation
					layout={layout}
					options={options}
					labelledBy={labelledBy}
					placeholder={
						platform === "web-apps" &&
						field.hintPlacement === "placeholder" &&
						field.hint
							? (state.resolvedHint ?? projectProse(field.hint))
							: undefined
					}
					value={state.value}
					onBlur={onBlur}
					onChange={onChange}
				/>
				{showError && state.errorMessage && (
					<ValidationError message={state.errorMessage} />
				)}
			</div>
		);
	}
	return (
		<fieldset
			aria-labelledby={labelledBy}
			className="m-0 border-none p-0"
			onBlur={onBlur}
		>
			<div
				className={row ? "grid gap-2" : "space-y-1.5"}
				style={
					row
						? {
								gridTemplateColumns: `repeat(${Math.max(options.length, 1)}, minmax(0,1fr))`,
							}
						: undefined
				}
			>
				{dynamicChoices && options.length === 0 && <LookupChoicesEmpty />}
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
							onMouseDown={isEditMode ? undefined : retainChoiceFocus}
							onClickCapture={isEditMode ? undefined : focusChosenChoice}
							className={`pv-choice-row flex items-center gap-3 px-3 py-2 rounded-lg cursor-pointer transition-colors ${
								isSelected
									? "bg-pv-accent/10 border border-pv-accent/30 hover:bg-pv-accent/15 hover:border-pv-accent/50"
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
							<span
								className={
									hideChoiceLabels
										? "sr-only"
										: "preview-markdown text-sm text-nova-text"
								}
							>
								{labelShowsAsTyped(textForm, opt) && plainChoiceAsWritten ? (
									opt.label
								) : (
									<PreviewMarkdown inline rendering={labelRendering}>
										{opt.label}
									</PreviewMarkdown>
								)}
							</span>
							{/* Per-option media (the image/audio that makes a visual
						    choice concrete): compact so a list of options stays
						    scannable. */}
							{drawChoiceMedia && (
								<MediaDisplay
									media={opt.media}
									interactive={!isEditMode}
									imageClassName="max-h-24 max-w-full rounded-lg object-contain"
								/>
							)}
						</label>
					);
				})}
			</div>
			{showError && state.errorMessage && (
				<ValidationError message={state.errorMessage} />
			)}
		</fieldset>
	);
}
