"use client";
import type { Field } from "@/lib/domain";
import type { FieldState } from "@/lib/preview/engine/types";
import { assertNever } from "@/lib/utils/assertNever";
import { DateField } from "./fields/DateField";
import { GeopointField } from "./fields/geopoint/GeopointField";
import { LabelField } from "./fields/LabelField";
import { MediaField } from "./fields/MediaField";
import { NumberField } from "./fields/NumberField";
import { SelectMultiField } from "./fields/SelectMultiField";
import { SelectOneField } from "./fields/SelectOneField";
import { TextField } from "./fields/TextField";

interface FieldRendererProps {
	/** Domain field entity — discriminated union narrowed by `kind` below. */
	field: Field;
	state: FieldState;
	onChange: (value: string) => void;
	onBlur: () => void;
}

/**
 * Interactive-mode field renderer. Dispatches on `kind` to the
 * kind-specific widget.
 *
 * Structural kinds (`group`, `repeat`) and authoring-only kinds
 * (`hidden`) never reach this component — the caller checks for them
 * and renders its own affordance. They appear here as explicit cases
 * returning `null` so the `default` branch stays an exhaustiveness
 * check rather than a silent escape hatch: every `FieldKind` is
 * consciously decided, and a new kind added to `fieldKinds` produces a
 * `tsc` error on the `assertNever` call until it's wired.
 */
export function FieldRenderer({
	field,
	state,
	onChange,
	onBlur,
}: FieldRendererProps) {
	switch (field.kind) {
		case "text":
		case "secret":
			return (
				<TextField
					field={field}
					state={state}
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
					onChange={onChange}
					onBlur={onBlur}
				/>
			);
		case "single_select":
			if (field.optionsSource !== undefined) {
				throw new Error(
					"FieldRenderer: lookup-backed select options are dormant until preview lookup execution lands.",
				);
			}
			return (
				<SelectOneField
					field={field}
					state={state}
					onChange={onChange}
					onBlur={onBlur}
				/>
			);
		case "multi_select":
			if (field.optionsSource !== undefined) {
				throw new Error(
					"FieldRenderer: lookup-backed select options are dormant until preview lookup execution lands.",
				);
			}
			return (
				<SelectMultiField
					field={field}
					state={state}
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
					onChange={onChange}
					onBlur={onBlur}
				/>
			);
		// Media-capture kinds. All dispatch to the same placeholder card;
		// the icon + label come from the field registry, so adding another
		// media kind doesn't need a new case here but DOES need the kind
		// listed explicitly.
		case "image":
		case "audio":
		case "video":
		case "signature":
		case "barcode":
			return <MediaField field={field} />;
		// Structural + authoring-only kinds — caller renders them directly
		// (group/repeat via GroupField/RepeatField, hidden via HiddenField
		// in edit mode or dropped entirely in interactive mode). Listed
		// here so the exhaustiveness check below stays tight.
		case "group":
		case "repeat":
		case "hidden":
			return null;
		default:
			return assertNever(field, "FieldRenderer");
	}
}
