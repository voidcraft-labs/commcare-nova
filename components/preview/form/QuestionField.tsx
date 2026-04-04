"use client";
import type { Question } from "@/lib/schemas/blueprint";
import type { QuestionState } from "@/lib/preview/engine/types";
import { TextField } from "./fields/TextField";
import { NumberField } from "./fields/NumberField";
import { DateField } from "./fields/DateField";
import { SelectOneField } from "./fields/SelectOneField";
import { SelectMultiField } from "./fields/SelectMultiField";
import { LabelField } from "./fields/LabelField";
import { MediaField } from "./fields/MediaField";

interface QuestionFieldProps {
	question: Question;
	state: QuestionState;
	onChange: (value: string) => void;
	onBlur: () => void;
}

const MEDIA_TYPES = new Set([
	"geopoint",
	"image",
	"audio",
	"video",
	"signature",
	"barcode",
]);

export function QuestionField({
	question,
	state,
	onChange,
	onBlur,
}: QuestionFieldProps) {
	if (MEDIA_TYPES.has(question.type)) {
		return <MediaField question={question} />;
	}

	switch (question.type) {
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
			return null;
	}
}
