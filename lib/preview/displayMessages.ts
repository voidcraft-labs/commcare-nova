import type { Field, SingleSelectField } from "@/lib/domain";
import { proseTemplateText } from "@/lib/domain";
import { choiceLayoutForPlatform } from "@/lib/domain/questionDisplay";
import type { FieldState } from "./engine/types";

/** HQ creates one form-level channel hub and a new hub for each concrete
 * repeat instance. Paths are those built by the preview engine. */
export function questionChannelScope(path: string): string {
	return path.slice(0, path.lastIndexOf("]") + 1);
}

export type QuestionMessage = Readonly<Record<string, string>> | null;

export function receivedAnswer(
	field: Field & { receiveFrom?: { channel: string; field: string } },
	state: FieldState,
	message: QuestionMessage,
): string | undefined {
	if (!field.receiveFrom) return undefined;
	const property = field.receiveFrom.field;
	if (field.kind === "text" || field.kind === "barcode")
		return message && Object.hasOwn(message, property) ? message[property] : "";
	if (field.kind !== "single_select") return undefined;
	return receivedChoice(field, state, property, message);
}

function receivedChoice(
	field: SingleSelectField,
	state: FieldState,
	property: string,
	message: QuestionMessage,
): string | undefined {
	const layout = choiceLayoutForPlatform(field, "web-apps");
	if (layout && layout.kind !== "search") return undefined;
	// SingleSelectEntry.receiveMessage passes a numeric index to the writer
	// of rawAnswer, which searches an array of string labels for that number.
	// It clears the radio answer even if the incoming text matches a label.
	if (!message || !layout) return "";
	const options =
		field.optionsSource.kind === "inline"
			? field.optionsSource.options.map((option) => ({
					label:
						state.resolvedOptionLabels?.[option.uuid] ??
						proseTemplateText(option.label),
					value: option.value,
				}))
			: (state.choices ?? []);
	for (const key of property.split("||")) {
		if (!Object.hasOwn(message, key)) continue;
		const option = options.find((option) => option.label === message[key]);
		if (option) return option.value;
	}
	return "";
}
