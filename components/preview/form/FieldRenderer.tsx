"use client";
import { type Field, isCaptureField } from "@/lib/domain";
import type { FieldState } from "@/lib/preview/engine/types";
import { assertNever } from "@/lib/utils/assertNever";
import { AttachmentField } from "./fields/attachment/AttachmentField";
import { DateField } from "./fields/DateField";
import { GeopointField } from "./fields/geopoint/GeopointField";
import { LabelField } from "./fields/LabelField";
import { MediaField } from "./fields/MediaField";
import { NumberField } from "./fields/NumberField";
import { SelectMultiField } from "./fields/SelectMultiField";
import { SelectOneField } from "./fields/SelectOneField";
import { TextField } from "./fields/TextField";

interface FieldRendererProps {
	/** Domain field entity: discriminated union narrowed by `kind` below. */
	field: Field;
	state: FieldState;
	/** ID of the already-rendered visible question label, when present. */
	labelledBy?: string;
	/**
	 * Concrete engine path: carries the repeat index, so a capture
	 * question's replace targets exactly one instance.
	 *
	 * Optional because the EDIT-mode row renderer passes none: edit-mode
	 * rows have no instance dimension, and a capture there renders the
	 * static authoring card rather than a live control. An interactive row
	 * always supplies it, and a capture control with no path treats itself
	 * as not-yet-ready rather than guessing one.
	 */
	path?: string;
	/** App the attachment lane writes to; absent outside a loaded app. */
	appId?: string | undefined;
	/** This form entry's attachment scope (see `EngineController.entryKey`). */
	entryKey?: string | undefined;
	/** Stable capture identity, independent of positional repeat indices. */
	attachmentSlotKey?: string | undefined;
	/** Prompt association for capture accessibility. */
	questionLabelId?: string | undefined;
	questionLabelledBy?: string | undefined;
	questionDescriptionIds?: string | undefined;
	questionLabel?: string | undefined;
	onChange: (value: string) => void;
	onBlur: () => void;
	onChangeAt?: ((path: string, value: string) => void) | undefined;
	onBlurAt?: ((path: string) => void) | undefined;
}

/**
 * Interactive-mode field renderer. Dispatches on `kind` to the
 * kind-specific widget.
 *
 * Structural kinds (`group`, `repeat`) and authoring-only kinds
 * (`hidden`) never reach this component: the caller checks for them
 * and renders its own affordance. They appear here as explicit cases
 * returning `null` so the `default` branch stays an exhaustiveness
 * check rather than a silent escape hatch: every `FieldKind` is
 * consciously decided, and a new kind added to `fieldKinds` produces a
 * `tsc` error on the `assertNever` call until it's wired.
 */
export function FieldRenderer({
	field,
	state,
	labelledBy,
	path,
	appId,
	entryKey,
	attachmentSlotKey,
	questionLabelId,
	questionLabelledBy,
	questionDescriptionIds,
	questionLabel,
	onChange,
	onBlur,
	onChangeAt,
	onBlurAt,
}: FieldRendererProps) {
	// Capture kinds route to the real attachment control. Narrowed through
	// the domain predicate rather than a case list so the two cannot drift:
	// a new capture kind is a capture here the moment it is one there.
	if (isCaptureField(field)) {
		return (
			<AttachmentField
				field={field}
				state={state}
				path={path}
				appId={appId}
				entryKey={entryKey}
				attachmentSlotKey={attachmentSlotKey}
				questionLabelId={questionLabelId}
				questionLabelledBy={questionLabelledBy}
				questionDescriptionIds={questionDescriptionIds}
				questionLabel={questionLabel}
				onChangeAt={onChangeAt}
				onBlurAt={onBlurAt}
			/>
		);
	}
	switch (field.kind) {
		case "text":
		case "secret":
			return (
				<TextField
					field={field}
					state={state}
					labelledBy={labelledBy}
					onChange={onChange}
					onBlur={onBlur}
				/>
			);
		case "int":
		case "decimal":
			return (
				<NumberField
					field={field}
					state={state}
					labelledBy={labelledBy}
					onChange={onChange}
					onBlur={onBlur}
				/>
			);
		case "date":
		case "time":
		case "datetime":
			return (
				<DateField
					field={field}
					state={state}
					labelledBy={labelledBy}
					onChange={onChange}
					onBlur={onBlur}
				/>
			);
		case "single_select":
			return (
				<SelectOneField
					field={field}
					state={state}
					labelledBy={labelledBy}
					onChange={onChange}
					onBlur={onBlur}
				/>
			);
		case "multi_select":
			return (
				<SelectMultiField
					field={field}
					state={state}
					labelledBy={labelledBy}
					onChange={onChange}
					onBlur={onBlur}
				/>
			);
		case "label":
			return <LabelField field={field} state={state} />;
		// Geopoint has a real, interactive picker in preview (map + address
		// search + geolocate); it no longer shares the media placeholder.
		case "geopoint":
			return (
				<GeopointField
					field={field}
					state={state}
					labelledBy={labelledBy}
					onChange={onChange}
					onBlur={onBlur}
				/>
			);
		// Barcode is NOT a capture, its answer is the scanned text, not an
		// attachment, and it has no preview affordance yet, so it keeps the
		// placeholder card. The capture kinds are absent from this switch
		// because the narrowing above already took them; TypeScript proves
		// that, so a new capture kind needs no change here at all.
		case "barcode":
			return <MediaField field={field} />;
		// Structural + authoring-only kinds: caller renders them directly
		// (group/repeat via GroupField/RepeatField, hidden via HiddenField
		// in edit mode or dropped entirely in interactive mode). Listed
		// here so the exhaustiveness check below stays tight.
		case "group":
		case "repeat":
		case "section":
		case "hidden":
			return null;
		default:
			return assertNever(field, "FieldRenderer");
	}
}
