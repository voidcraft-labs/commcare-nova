"use client";
import type { Field } from "@/lib/domain";
import type { QuestionState } from "@/lib/preview/engine/types";
import { DateField } from "./fields/DateField";
import { LabelField } from "./fields/LabelField";
import { MediaField } from "./fields/MediaField";
import { NumberField } from "./fields/NumberField";
import { SelectMultiField } from "./fields/SelectMultiField";
import { SelectOneField } from "./fields/SelectOneField";
import { TextField } from "./fields/TextField";

interface QuestionFieldProps {
	/** Domain field entity — discriminated union narrowed by `kind` below. */
	question: Field;
	state: QuestionState;
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
export function QuestionField({
	question,
	state,
	onChange,
	onBlur,
}: QuestionFieldProps) {
	if (MEDIA_KINDS.has(question.kind)) {
		return <MediaField question={question} />;
	}

	switch (question.kind) {
		case "text":
		case "secret":
			return (
				<TextField
					question={question}
					state={state}
					onChange={onChange}
					onBlur={onBlur}
				/>
			);
		case "int":
		case "decimal":
			return (
				<NumberField
					question={question}
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
					question={question}
					state={state}
					onChange={onChange}
					onBlur={onBlur}
				/>
			);
		case "single_select":
			return (
				<SelectOneField
					question={question}
					state={state}
					onChange={onChange}
					onBlur={onBlur}
				/>
			);
		case "multi_select":
			return (
				<SelectMultiField
					question={question}
					state={state}
					onChange={onChange}
					onBlur={onBlur}
				/>
			);
		case "label":
			return <LabelField question={question} state={state} />;
		default:
			// Structural (group/repeat/hidden) kinds are rendered by callers;
			// unknown kinds fall through silently.
			return null;
	}
}
