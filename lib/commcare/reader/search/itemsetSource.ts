/**
 * The table an itemset's nodeset reads, where the nodeset is that table's item list: the one
 * shape a Search field's lookup choices take in Nova (`lookupOptionsSourceSchema`), read by the
 * prompt reader and compared by the settle.
 */
import { readFormSyntax } from "../syntaxRead";

/** An itemset's nodeset as `instance('item-list:<tag>')/<tag>_list/<tag>[filter]`: the tag and the
 *  filter's text, where it is that shape. */
export function itemsetSource(
	text: unknown,
): { tag: string; filter?: string } | undefined {
	if (typeof text !== "string") return undefined;
	const read = readFormSyntax(text);
	let node = read.ok ? read.node : undefined;
	let filter: string | undefined;
	if (node?.kind === "filter") {
		filter = text.slice(node.where.from, node.where.to);
		node = node.base;
	}
	if (node?.kind !== "child" || node.step.kind !== "name") return undefined;
	const item = node.step.name;
	const list = node.left;
	if (
		list?.kind !== "child" ||
		list.step.kind !== "name" ||
		list.step.name !== `${item}_list`
	)
		return undefined;
	const root = list.left;
	if (
		root?.kind !== "call" ||
		root.name !== "instance" ||
		root.args.length !== 1
	)
		return undefined;
	const id = root.args[0];
	if (id?.kind !== "string" || id.value !== `item-list:${item}`)
		return undefined;
	return filter === undefined ? { tag: item } : { tag: item, filter };
}
