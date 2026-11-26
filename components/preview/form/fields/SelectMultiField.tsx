"use client";
import { MediaDisplay } from "@/components/builder/media/MediaDisplay";
import { useFieldTextForm } from "@/lib/doc/hooks/useFieldTextForm";
import { useProseProjection } from "@/lib/doc/hooks/useProseProjection";
import {
	labelShowsAsTyped,
	type MultiSelectField,
	type SelectOption,
} from "@/lib/domain";
import { choiceLayoutForPlatform } from "@/lib/domain/questionDisplay";
import { PREVIEW_LABEL_RENDERING, PreviewMarkdown } from "@/lib/markdown";
import type { FieldState } from "@/lib/preview/engine/types";
import { workerChoiceProse } from "@/lib/preview/workerProse";
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

interface SelectMultiFieldProps {
	/** Multi-select field: options are required on this kind. */
	field: MultiSelectField;
	state: FieldState;
	/** Visible question label rendered by InteractiveFormRenderer. */
	labelledBy?: string;
	onChange: (value: string) => void;
	onBlur: () => void;
}

/**
 * Multi-select checkbox field for form preview. Each option renders a real
 * `<input type="checkbox">` (visually hidden via sr-only) inside a `<label>`,
 * so native click-to-toggle and keyboard interaction own the answer change.
 * The outer `<fieldset>` groups the checkboxes semantically
 * and captures `onBlur` for touch tracking.
 */
export function SelectMultiField({
	field,
	state,
	labelledBy,
	onChange,
	onBlur,
}: SelectMultiFieldProps) {
	// Static options render in their authored array sequence, matching the wire
	// `<item>` order; a
	// lookup-backed select reads the ENGINE's live filtered choices, see
	// the single-select twin for the loading contract.
	const dynamicChoices = field.optionsSource.kind !== "inline";
	// Document-aware option-label projection: see the single-select twin.
	const projectProse = useProseProjection();
	const platform = usePreviewPlatform();
	const textForm = useFieldTextForm(field.uuid);
	// `key` is display identity: see the single-select twin.
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
						state.resolvedOptionLabels?.[opt.uuid] ??
						projectProse(
							workerChoiceProse(field, opt, textForm, platform).template,
						),
				}))
			: [];
	const selected = new Set(state.value ? state.value.split(" ") : []);
	const hint = field.extended_hint ?? field.hint;
	const showError = state.touched && !state.valid;
	const isEditMode = useEditMode() === "edit";
	/* Choice media draws on Android and in edit mode; Web Apps draws none
	 * (manifest `questions/choice-image`, `choice-audio-video`). */
	const rules = usePreviewPlatformRules();
	const drawChoiceMedia = isEditMode || rules.choiceMedia;
	const labelRendering = isEditMode
		? PREVIEW_LABEL_RENDERING
		: rules.labelMarkdown;
	/* A choice shown as typed (its own `plainLabel`, or its form's
	 * `plainText`) shows as written in edit mode and where the platform draws
	 * it so (Android); Web Apps formats every choice (`rules.plainChoice`). */
	const plainChoiceAsWritten = isEditMode || rules.plainChoice === "literal";

	const toggle = (optValue: string) => {
		const next = new Set(selected);
		if (next.has(optValue)) next.delete(optValue);
		else next.add(optValue);
		onChange([...next].join(" "));
	};

	if (dynamicChoices && state.choices === undefined) {
		return <LookupChoicesLoading />;
	}
	const layout = choiceLayoutForPlatform(field, platform);

	if (layout?.kind === "grid")
		return (
			<div>
				<AndroidChoiceGrid
					key={options.map((o) => o.media?.image ?? "").join(":")}
					options={options}
					columns={layout.columns}
					multiple
					labelledBy={labelledBy}
					path={state.path}
					value={state.value}
					editMode={isEditMode}
					onChoose={toggle}
					onBlur={onBlur}
				/>
				{dynamicChoices && options.length === 0 && <LookupChoicesEmpty />}
				{showError && state.errorMessage && (
					<ValidationError message={state.errorMessage} />
				)}
			</div>
		);
	const row = layout?.kind === "row-without-label" || layout?.kind === "row";
	const hideChoiceLabels = layout?.kind === "row-without-label";
	if (layout && (layout.kind === "dropdown" || layout.kind === "headings")) {
		return (
			<div>
				<ChoicePresentation
					layout={layout}
					options={options}
					labelledBy={labelledBy}
					placeholder={
						rules.hintPlacement === "as-authored" &&
						field.hintPlacement === "placeholder" &&
						hint
							? (state.resolvedHint ?? projectProse(hint))
							: undefined
					}
					value={state.value}
					onBlur={onBlur}
					onChange={onChange}
					multiple
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
					/* Blank values can never be "checked": "" splits to no tokens.
					 * The DOM id derives from the stable key, never the value:
					 * duplicate lookup values would otherwise cross-wire labels. */
					const checked = opt.value !== "" && selected.has(opt.value);
					const inputId = `${state.path}-${opt.key}`;
					return (
						<label
							key={opt.key}
							htmlFor={inputId}
							onMouseDown={isEditMode ? undefined : retainChoiceFocus}
							onClickCapture={isEditMode ? undefined : focusChosenChoice}
							className={`pv-choice-row flex items-center gap-3 px-3 py-2 rounded-lg cursor-pointer transition-colors ${
								checked
									? "bg-pv-accent/10 border border-pv-accent/30 hover:bg-pv-accent/15 hover:border-pv-accent/50"
									: showError
										? "bg-pv-input-bg border border-nova-rose/30 hover:border-nova-rose/50"
										: "bg-pv-input-bg border border-pv-input-border hover:border-pv-input-focus"
							}`}
						>
							<input
								id={inputId}
								type="checkbox"
								checked={checked}
								onChange={() => toggle(opt.value)}
								className="sr-only"
								autoComplete="off"
								data-1p-ignore
							/>
							<div
								className={`w-4 h-4 rounded border-2 flex items-center justify-center shrink-0 ${
									checked
										? "border-pv-accent bg-pv-accent"
										: "border-nova-text-muted"
								}`}
							>
								{checked && (
									<svg
										aria-hidden="true"
										width="10"
										height="10"
										viewBox="0 0 10 10"
										fill="none"
									>
										<path
											d="M2 5L4 7L8 3"
											stroke="white"
											strokeWidth="1.5"
											strokeLinecap="round"
											strokeLinejoin="round"
										/>
									</svg>
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
							{/* Per-option media: compact, same as the single-select. */}
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
