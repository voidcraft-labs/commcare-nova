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
