import type { SelectOption } from "../fields";
import type { Uuid } from "../uuid";
import type { Choice } from "./types";
/** Resolve static choice identities in their saved authored order. */
export function choiceValue(
	choice: Choice,
	optionsByField: ReadonlyMap<
		Uuid,
		readonly Pick<SelectOption, "uuid" | "value">[]
	>,
): string {
	const options = optionsByField.get(choice.field);
	if (options === undefined)
		throw new Error(
			`Cannot read this choice because field "${choice.field}" has no static options.`,
		);
	return choice.options
		.map((uuid) => {
			const option = options.find((candidate) => candidate.uuid === uuid);
			if (option === undefined)
				throw new Error(
					`Cannot read this choice because option "${uuid}" is missing from field "${choice.field}".`,
				);
			return option.value;
		})
		.join(" ");
}

/**
 * The selections a multiple select answer's text names, as Core casts it:
 * `org/javarosa/core/model/data/SelectMultiData.java::cast` splits the text
 * with `org/javarosa/core/util/DataUtil.java::splitOnSpaces`, which reads
 * empty text as no selection and otherwise runs Java's `split("[ ]+")`. Runs
 * of U+0020 separate tokens (a tab or a no-break space is part of a token),
 * trailing empty tokens are dropped, and a leading one is kept: `" a"` names
 * `""` and `"a"`, while `"a "` and `"a  b"` name only their words and text of
 * spaces alone names none. Core then matches each token to a choice
 * (`Selection.java::attachChoice`), and no choice matches `""`.
 */
export function selectAnswerTokens(text: string): readonly string[] {
	if (text === "") return [];
	const tokens = text.split(/ +/);
	while (tokens.length > 0 && tokens[tokens.length - 1] === "") tokens.pop();
	return tokens;
}
