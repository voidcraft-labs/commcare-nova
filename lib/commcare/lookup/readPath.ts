import type { LookupColumnId, LookupMemberId } from "@/lib/domain/lookupIds";
import type { LookupRead } from "@/lib/domain/lookupRead";
import { type FormSyntax, readFormSyntax } from "../xpath/formSyntax";

export interface LookupReadNames {
	column(name: string): LookupColumnId | undefined;
	attribute?(name: string): LookupMemberId | undefined;
	property?(columnId: LookupColumnId, name: string): LookupMemberId | undefined;
}

type NamedRead =
	| { attribute: string }
	| {
			column: string;
			occurrence?: number;
			positionBeforeFilter?: true;
			where?: { property: string; equals: string };
			property?: string;
	  };

function ungroup(node: FormSyntax): FormSyntax {
	let base = node;
	while (base.kind === "group") base = base.value;
	return base;
}
function relative(node: FormSyntax): FormSyntax {
	const base = ungroup(node);
	if (
		base.kind === "child" &&
		!base.descendant &&
		base.left &&
		ungroup(base.left).kind === "self"
	)
		return relative(base.step);
	return base;
}
function attribute(node: FormSyntax): string | undefined {
	const step = relative(node);
	if (step.kind !== "axis" || step.axis !== "attribute") return undefined;
	const name = ungroup(step.value);
	return name.kind === "name" && !name.wildcard ? name.name : undefined;
}

/** HQ can retain an XPath constant as a concatenation when its text contains
 * both kinds of quotes or HQ interpolation markers. The trailing backslash
 * spelling comes from the shared wire serializer. */
function constantText(node: FormSyntax): string | undefined {
	const n = ungroup(node);
	if (n.kind === "string") return n.value;
	if (n.kind !== "call") return undefined;
	if (n.name === "substr" && n.args.length === 3) {
		const [text, start, end] = n.args.map(ungroup);
		if (
			text.kind === "string" &&
			(text.value === "\\" || text.value === "\\\\") &&
			start.kind === "number" &&
			start.value === 0 &&
			end.kind === "number" &&
			end.value === 1
		)
			return "\\";
	}
	if (n.name !== "concat" || n.args.length < 2) return undefined;
	const parts = n.args.map(constantText);
	return parts.every((part) => part !== undefined) ? parts.join("") : undefined;
}

/** The same row-relative path on a field choice, Search prompt or fixture
 * projection. An ordering of predicates we cannot retain is a shape refusal. */
export function lookupReadPath(
	text: unknown,
	names: "runtime" | "stored-xml" = "runtime",
): NamedRead | undefined {
	if (typeof text !== "string") return undefined;
	const parsed = readFormSyntax(text, names);
	if (!parsed.ok || !parsed.node) return undefined;
	return lookupReadSyntax(parsed.node);
}
export function lookupReadSyntax(syntax: FormSyntax): NamedRead | undefined {
	let node = relative(syntax);
	const rowAttribute = attribute(node);
	if (rowAttribute !== undefined) return { attribute: rowAttribute };
	let property: string | undefined;
	if (node.kind === "child") {
		if (node.descendant || !node.left) return undefined;
		property = attribute(node.step);
		if (property === undefined) return undefined;
		node = relative(node.left);
	}
	let occurrence: number | undefined;
	if (node.kind === "filter") {
		const n = ungroup(node.where);
		if (n.kind === "number") {
			if (!Number.isSafeInteger(n.value) || n.value < 1) return undefined;
			occurrence = n.value;
			node = relative(node.base);
		}
	}
	let positionBeforeFilter: true | undefined;
	let where: { property: string; equals: string } | undefined;
	if (node.kind === "filter") {
		const predicate = ungroup(node.where);
		if (predicate.kind !== "binary" || predicate.op !== "=") return undefined;
		const l = ungroup(predicate.left),
			r = ungroup(predicate.right);
		const name = attribute(l) ?? attribute(r);
		const literal = attribute(l) !== undefined ? r : l;
		const equals = constantText(literal);
		if (name === undefined || equals === undefined) return undefined;
		where = { property: name, equals };
		node = relative(node.base);
		if (occurrence === undefined && node.kind === "filter") {
			const n = ungroup(node.where);
			if (n.kind !== "number" || !Number.isSafeInteger(n.value) || n.value < 1)
				return undefined;
			occurrence = n.value;
			positionBeforeFilter = true;
			node = relative(node.base);
		}
	}
	if (node.kind !== "name" || node.wildcard) return undefined;
	return {
		column: node.name,
		...(positionBeforeFilter && { positionBeforeFilter }),
		...(property !== undefined && { property }),
		...(where && { where }),
		...(occurrence !== undefined && { occurrence }),
	};
}
/** Every stored name one read prints into its path: the column or row
 * attribute, then any value detail it selects or matches. */
export function lookupReadNames(read: NamedRead): string[] {
	if ("attribute" in read) return [read.attribute];
	return [
		read.column,
		...(read.where ? [read.where.property] : []),
		...(read.property !== undefined ? [read.property] : []),
	];
}
export function bindLookupRead(
	read: NamedRead,
	names: LookupReadNames,
): LookupRead | undefined {
	if ("attribute" in read) {
		const attributeId = names.attribute?.(read.attribute);
		return attributeId === undefined ? undefined : { attributeId };
	}
	const columnId = names.column(read.column);
	if (columnId === undefined) return undefined;
	if (
		!read.where &&
		read.occurrence === undefined &&
		read.property === undefined
	)
		return columnId;
	const whereProperty =
		read.where && names.property?.(columnId, read.where.property);
	const propertyId = read.property && names.property?.(columnId, read.property);
	if (
		(read.where && !whereProperty) ||
		(read.property !== undefined && !propertyId)
	)
		return undefined;
	return {
		columnId,
		...(read.where &&
			whereProperty && {
				where: { propertyId: whereProperty, equals: read.where.equals },
			}),
		...(propertyId && { propertyId }),
		...(read.occurrence !== undefined && { occurrence: read.occurrence }),
		...(read.positionBeforeFilter && { positionBeforeFilter: true as const }),
	};
}
