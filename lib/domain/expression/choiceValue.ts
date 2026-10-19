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
 * The selections a select answer's text names: runs of U+0020 separate them
 * and empty tokens name none. Core casts a multiple select's text through
 * `org/javarosa/core/util/DataUtil.java::splitOnSpaces` (`split("[ ]+")`), so a
 * tab or a no-break space is part of a token, never a separator.
 */
export function selectAnswerTokens(text: string): readonly string[] {
	return text.split(/ +/).filter((token) => token.length > 0);
}
