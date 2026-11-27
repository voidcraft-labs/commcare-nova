import {
	type ResultDetailTextWire,
	resultDetailTextWire,
} from "../../suite/case-list/resultDetailText";
import {
	type FormSyntax,
	needsInstanceDeclaration,
	readFormSyntax,
	visitSyntax,
} from "../../xpath/formSyntax";
import { serializeWire } from "../../xpath/wire/serialize";
import { sameSyntax } from "../syntaxCompare";
import { literalText } from "./literalText";

function ungroup(node: FormSyntax | undefined): FormSyntax | undefined {
	while (node?.kind === "group") node = node.value;
	return node;
}

function call(node: FormSyntax | undefined, name: string, count: number) {
	const syntax = ungroup(node);
	if (
		syntax?.kind === "call" &&
		syntax.name === name &&
		syntax.args.length === count
	)
		return syntax.args;
}

function literalArgumentsText(args: readonly FormSyntax[]): string | undefined {
	let result = "";
	for (const argument of args) {
		const literal = literalText(ungroup(argument));
		if (literal === undefined) return undefined;
		result += literal;
	}
	return result;
}

/** Recover only the literal-text template with the exact roster and prompt
 * guards. Extract candidate text before structurally checking the whole
 * expression against the wire projection. Mode/route/identity admission
 * belongs to the caller. */
export function readResultDetailText(
	source: string,
): ResultDetailTextWire | undefined {
	const parsed = readFormSyntax(source);
	if (!parsed.ok || !parsed.node) return;
	let hqSeesSources = true;
	visitSyntax(parsed.node, (node) => {
		if (needsInstanceDeclaration(node, source)) hqSeesSources = false;
	});
	if (!hqSeesSources) return;
	const outer = call(parsed.node, "if", 3);
	const concat = ungroup(outer?.[1]);
	if (concat?.kind !== "call" || concat.name !== "concat") return;
	// The writer splits literals when HQ's lexical instance scanner would
	// mistake one for XPath. The one optional read still separates the
	// exact ordinary prefix and suffix.
	const answerAt = concat.args.findIndex((argument) => call(argument, "if", 3));
	if (answerAt < 1 || answerAt >= concat.args.length - 1) return;
	const inner = call(concat.args[answerAt], "if", 3);
	const scalar = call(inner?.[1], "string", 1);
	const path = ungroup(scalar?.[0]);
	const test = path?.kind === "filter" ? ungroup(path.where) : undefined;
	const inputName =
		test?.kind === "binary" ? literalText(ungroup(test.right)) : undefined;
	const prefix = literalArgumentsText(concat.args.slice(0, answerAt));
	const suffix = literalArgumentsText(concat.args.slice(answerAt + 1));
	const localText = literalText(ungroup(outer?.[2]));
	if (
		inputName === undefined ||
		prefix === undefined ||
		suffix === undefined ||
		localText === undefined
	)
		return;
	const recovered = { inputName, prefix, suffix, localText };
	const printed = readFormSyntax(
		serializeWire(resultDetailTextWire(recovered), {
			target: "hq-json",
			interpolation: "none",
		}).text,
	);
	return printed.ok && printed.node && sameSyntax(parsed.node, printed.node)
		? recovered
		: undefined;
}
