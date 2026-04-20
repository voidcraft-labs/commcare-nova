"use client";
import type { Field } from "@/lib/domain";
import type { FieldState } from "@/lib/preview/engine/types";
import { DateField } from "./fields/DateField";
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
 * Kinds whose interactive rendering is a "press this button to capture
 * media / GPS / signature" experience — they all dispatch to
 * `MediaField`. `geopoint` is grouped here despite being a coordinate
 * pair because its UI affordance matches the media capture pattern.
 */
const MEDIA_KINDS = new Set<Field["kind"]>([
	"geopoint",
	"image",
	"audio",
	"video",
	"signature",
	"barcode",
]);

/**
 * Interactive-mode field renderer. Dispatches on `kind` to the
 * kind-specific widget. Structural kinds (`group`, `repeat`, `hidden`)
 * don't reach this component — the caller renders them directly or
 * skips them.
 */
export function FieldRenderer({
	field,
	state,
	onChange,
	onBlur,
}: FieldRendererProps) {
	if (MEDIA_KINDS.has(field.kind)) {
		return <MediaField field={field} />;
	}

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
			return (
				<SelectOneField
					field={field}
					state={state}
					onChange={onChange}
					onBlur={onBlur}
				/>
			);
		case "multi_select":
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
		default:
			// Structural (group/repeat/hidden) kinds are rendered by callers;
			// unknown kinds fall through silently.
			return null;
	}
}
