import { authoredCasePropertyNameSchema } from "@/lib/domain/casePropertyName";
import { inlineResultPropertyWire } from "../../suite/case-list/inlineResultProperty";
import {
	type FormSyntax,
	needsInstanceDeclaration,
	visitSyntax,
} from "../../xpath/formSyntax";
import { serializeWire } from "../../xpath/wire/serialize";
import { sameSyntax } from "../syntaxCompare";
import { readFormSyntax } from "../syntaxRead";

function ungroup(node: FormSyntax): FormSyntax {
	while (node.kind === "group") node = node.value;
	return node;
}

/** Recognize only a complete own-row text read, with both related exclusion
 * and the identity join. Route eligibility belongs to the caller and gate. */
export function readInlineResultProperty(source: string): string | undefined {
	const incoming = readFormSyntax(source);
	if (!incoming.ok || !incoming.node) return;
	const path = ungroup(incoming.node);
	if (path.kind !== "child" || path.descendant) return;
	const leaf = ungroup(path.step);
	if (
		leaf.kind !== "name" ||
		leaf.wildcard ||
		!authoredCasePropertyNameSchema.safeParse(leaf.name).success
	)
		return;
	let hqSeesSources = true;
	visitSyntax(path, (node) => {
		if (needsInstanceDeclaration(node, source)) hqSeesSources = false;
	});
	if (!hqSeesSources) return;
	const canonical = readFormSyntax(
		serializeWire(inlineResultPropertyWire(leaf.name), {
			target: "hq-json",
			interpolation: "none",
		}).text,
	);
	return canonical.ok && canonical.node && sameSyntax(path, canonical.node)
		? leaf.name
		: undefined;
}
