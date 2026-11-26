import type { ProseTemplate, RepeatField } from "@/lib/domain";
import type { FieldState } from "./types";

/** Core checks the first invitation only while the repeat is empty. */
export function repeatAddCaption(
	field: RepeatField,
	state: Pick<FieldState, "resolvedAddFirstLabel" | "resolvedAddLabel">,
	count: number,
	project: (value: ProseTemplate) => string,
): string | undefined {
	if (count === 0) {
		const first =
			state.resolvedAddFirstLabel ??
			(field.addFirstLabel && project(field.addFirstLabel));
		if (first !== undefined) return first;
	}
	return state.resolvedAddLabel ?? (field.addLabel && project(field.addLabel));
}
