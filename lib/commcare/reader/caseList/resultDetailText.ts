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

function text(node: FormSyntax | undefined): string | undefined {
	const syntax = ungroup(node);
	return syntax?.kind === "string" ? syntax.value : undefined;
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
	const concat = call(outer?.[1], "concat", 3);
	const inner = call(concat?.[1], "if", 3);
	const scalar = call(inner?.[1], "string", 1);
	const path = ungroup(scalar?.[0]);
	const test = path?.kind === "filter" ? ungroup(path.where) : undefined;
	const inputName = test?.kind === "binary" ? text(test.right) : undefined;
	const prefix = text(concat?.[0]);
	const suffix = text(concat?.[2]);
	const localText = text(outer?.[2]);
	if (
		inputName === undefined ||
		prefix === undefined ||
		suffix === undefined ||
		localText === undefined
	)
		return;
	const recovered = { inputName, prefix, suffix, localText };
	const printed = readFormSyntax(
		serializeWire(resultDetailTextWire(recovered), { target: "suite" }).text,
	);
	return printed.ok && printed.node && sameSyntax(parsed.node, printed.node)
		? recovered
		: undefined;
}
