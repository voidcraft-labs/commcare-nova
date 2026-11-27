import { w } from "../../xpath/wire/builders";
import { guardRead } from "../../xpath/wire/emptyRows";
import {
	STANDALONE_SEARCH_INPUT_INSTANCE_ID,
	searchInputInstance,
} from "../../xpath/wire/instances";

/** Resolved wire name and literal text of the first supported result-only
 * calculation. Domain callers must bind the prompt by its UUID. */
export interface ResultDetailPromptWire {
	readonly inputName: string;
	readonly prefix: string;
	readonly suffix: string;
	readonly localText: string;
}

/** Both native detail projections share one column. The outer branch never
 * touches the Search instance for a case belonging to the ordinary roster.
 * The inner guard counts this exact prompt, even when a different prompt in
 * the same instance was answered. */
export type ResultDetailTextWire =
	| ResultDetailPromptWire
	| { readonly text: string; readonly localText: string };

export function resultDetailTextWire(input: ResultDetailTextWire) {
	return guardRead(
		"text" in input ? w.str(input.text) : answeredText(input),
		w.current([w.parent(), w.parent(), w.step("results")]),
		w.str(input.localText),
	);
}

function answeredText(input: ResultDetailPromptWire) {
	const node = w.instance(
		searchInputInstance(STANDALONE_SEARCH_INPUT_INSTANCE_ID),
		[
			w.step("input"),
			w.step("field", [
				w.eq(w.context([w.attr("name")]), w.str(input.inputName)),
			]),
		],
	);
	return w.call("concat", [
		w.str(input.prefix),
		guardRead(w.call("string", [node]), node, w.str("")),
		w.str(input.suffix),
	]);
}
