import { authoredCasePropertyNameSchema } from "@/lib/domain/casePropertyName";
import { visitSyntax } from "../../xpath/formSyntax";
import { sameXPathText } from "../syntaxCompare";
import { readFormSyntax } from "../syntaxRead";

/**
 * Core's restored case tree has flat property leaves. Its only nested
 * containers are index and attachments. An ordinary leaf's missing child
 * unpacks to empty text in a scalar equality.
 */
export function requiredCaseChildAsBlank(source: string): string | undefined {
	const result = readFormSyntax(source);
	if (!result.ok || result.node === undefined) return;
	const root = result.node;
	if (
		root.kind !== "binary" ||
		root.op !== ">" ||
		root.right.kind !== "number" ||
		root.right.value !== 0 ||
		root.left.kind !== "call" ||
		root.left.name !== "count" ||
		root.left.args.length !== 1
	)
		return;
	const parts: {
		type?: string;
		equality?: {
			property: string;
			parent: string;
			child: string;
			from: number;
			to: number;
		};
	} = {};
	visitSyntax(root.left.args[0], (node) => {
		if (node.kind !== "binary" || node.op !== "=") return;
		if (
			node.left.kind === "axis" &&
			node.left.axis === "attribute" &&
			node.left.value.kind === "name" &&
			node.left.value.name === "case_type" &&
			node.right.kind === "string"
		)
			parts.type = source.slice(node.right.from, node.right.to);
		if (
			node.left.kind === "name" &&
			!node.left.wildcard &&
			node.right.kind === "child" &&
			!node.right.descendant &&
			node.right.left?.kind === "name" &&
			!node.right.left.wildcard &&
			node.right.step.kind === "name" &&
			!node.right.step.wildcard
		) {
			parts.equality = {
				property: node.left.name,
				parent: node.right.left.name,
				child: node.right.step.name,
				from: node.right.from,
				to: node.right.to,
			};
		}
	});
	const { type, equality } = parts;
	if (type === undefined || equality === undefined) return;
	const { property, parent, child, from, to } = equality;
	if (
		parent === "index" ||
		parent === "attachments" ||
		![property, parent, child].every(
			(name) => authoredCasePropertyNameSchema.safeParse(name).success,
		) ||
		!sameXPathText(
			source,
			`count(instance('casedb')/casedb/case[@case_type = ${type}][${property} = ${parent}/${child}]) > 0`,
		)
	)
		return;
	return `${source.slice(0, from)}''${source.slice(to)}`;
}
