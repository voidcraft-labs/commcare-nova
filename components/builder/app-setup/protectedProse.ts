import {
	canonicalProseTemplate,
	type LocalizedValue,
	type ProsePart,
	type ProseReferencePart,
	type ProseTemplate,
} from "@/lib/domain";

import { canonicalJsonText } from "@/lib/utils/canonicalJsonText";

interface ProtectedToken {
	readonly token: string;
	readonly part: ProseReferencePart;
	readonly label: string;
}

function sameReference(left: ProseReferencePart, right: ProseReferencePart) {
	return canonicalJsonText(left) === canonicalJsonText(right);
}

function protectedTokens(
	source: ProseTemplate,
	target: ProseTemplate,
	projectValue: (value: LocalizedValue) => string,
): readonly ProtectedToken[] {
	const literalText = [...source.parts, ...target.parts]
		.filter((part) => part.kind === "text")
		.map((part) => part.text)
		.join("");
	let prefix = "NOVA_REF";
	while (literalText.includes(`[[${prefix}_`)) prefix += "_";
	return source.parts
		.filter((part): part is ProseReferencePart => part.kind !== "text")
		.map((part, index) => ({
			token: `[[${prefix}_${index + 1}]]`,
			part,
			label: projectValue({ parts: [part] }),
		}));
}

function serializeProse(
	value: ProseTemplate,
	tokens: readonly ProtectedToken[],
): string {
	const unused = [...tokens];
	let output = "";
	for (const part of value.parts) {
		if (part.kind === "text") {
			if (tokens.length === 0) {
				output += part.text;
				continue;
			}
			let escaped = part.text.replaceAll("\\", "\\\\");
			for (const token of tokens) {
				escaped = escaped.replaceAll(token.token, `\\${token.token}`);
			}
			output += escaped;
			continue;
		}
		const index = unused.findIndex((token) => sameReference(token.part, part));
		if (index < 0) continue;
		output += unused[index]?.token ?? "";
		unused.splice(index, 1);
	}
	return output;
}

function parseProtectedProse(
	value: string,
	tokens: readonly ProtectedToken[],
): { value?: ProseTemplate; error?: string } {
	if (tokens.length === 0) {
		return {
			value: canonicalProseTemplate(
				value.length === 0 ? [] : [{ kind: "text", text: value }],
			),
		};
	}
	const counts = new Map(tokens.map((token) => [token.token, 0]));
	const parts: ProsePart[] = [];
	let literal = "";
	const flushLiteral = () => {
		if (literal === "") return;
		parts.push({ kind: "text", text: literal });
		literal = "";
	};
	for (let index = 0; index < value.length; ) {
		if (value[index] === "\\") {
			if (index + 1 < value.length) {
				literal += value[index + 1];
				index += 2;
			} else {
				literal += "\\";
				index += 1;
			}
			continue;
		}
		const token = tokens.find((candidate) =>
			value.startsWith(candidate.token, index),
		);
		if (token === undefined) {
			literal += value[index];
			index += 1;
			continue;
		}
		flushLiteral();
		parts.push(token.part);
		counts.set(token.token, (counts.get(token.token) ?? 0) + 1);
		index += token.token.length;
	}
	flushLiteral();
	for (const token of tokens) {
		if (counts.get(token.token) !== 1) {
			return { error: `Keep ${token.token} exactly once.` };
		}
	}
	return { value: canonicalProseTemplate(parts) };
}

export interface ProtectedProseDraft {
	readonly tokens: readonly ProtectedToken[];
	readonly draft: string;
	readonly value: ProseTemplate | undefined;
	readonly error: string | undefined;
}

/** Token identities stay fixed for the lifetime of one source/target edit. */
export function createProtectedProseDraft(
	source: ProseTemplate,
	value: ProseTemplate,
	projectValue: (value: LocalizedValue) => string,
): ProtectedProseDraft {
	const tokens = protectedTokens(source, value, projectValue);
	return {
		tokens,
		draft: serializeProse(value, tokens),
		value,
		error: undefined,
	};
}

/** Invalid visible text has no committable value; correcting it clears the refusal. */
export function editProtectedProseDraft(
	state: ProtectedProseDraft,
	draft: string,
): ProtectedProseDraft {
	const parsed = parseProtectedProse(draft, state.tokens);
	return {
		tokens: state.tokens,
		draft,
		value: parsed.value,
		error: parsed.error,
	};
}
