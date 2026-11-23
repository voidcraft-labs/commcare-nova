import { type LookupRead, readColumnId } from "@/lib/domain/lookupRead";
import type {
	LookupColumn,
	LookupFixtureRow,
	LookupMember,
	LookupTableDefinition,
} from "@/lib/lookup/types";
import { w } from "../xpath/wire/builders";
import type { WireStep } from "../xpath/wire/tree";
import { lookupFixtureCellText } from "./cellText";
import type { LookupTableWireNaming } from "./naming";
import type { FixtureAtom } from "./row";

export interface ResolvedLookupRead {
	readonly label: string;
	readonly column?: LookupColumn;
	readonly member?: LookupMember;
}

/** Bind a reader only inside its owning table and column. */
export function resolveLookupRead(
	table: Pick<LookupTableDefinition, "columns" | "attributes">,
	read: LookupRead,
): ResolvedLookupRead | undefined {
	if (typeof read !== "string" && "attributeId" in read) {
		const member = table.attributes?.find(
			(attribute) => attribute.id === read.attributeId,
		);
		return member && { label: member.label, member };
	}
	const id = readColumnId(read);
	const column = table.columns.find((value) => value.id === id);
	if (!column) return undefined;
	if (typeof read === "string") return { label: column.label, column };
	if (!column.repeated && (read.where || read.propertyId)) return undefined;
	if (
		read.where &&
		!column.properties?.some((p) => p.id === read.where?.propertyId)
	)
		return undefined;
	if (read.propertyId !== undefined) {
		const member = column.properties?.find((p) => p.id === read.propertyId);
		return member && { label: member.label, member, column };
	}
	return { label: column.label, column };
}

/** The field position is applied after its detail filter, before projecting
 * its optional attribute. A missing returned attribute is no node. */
export function* lookupReadCandidates(
	row: LookupFixtureRow,
	read: LookupRead,
	resolved: ResolvedLookupRead,
): Generator<{ predicate?: FixtureAtom; output?: FixtureAtom }> {
	if (typeof read !== "string" && "attributeId" in read) {
		const text = row.attributes?.[read.attributeId];
		if (text !== undefined)
			yield {
				output: {
					slot: { kind: "attribute", attributeId: read.attributeId },
					text,
				},
			};
		return;
	}
	const column = resolved.column;
	if (!column) throw new Error("The selected data column is unavailable.");
	const columnId = column.id;
	const items = row.occurrences?.[columnId];
	if (!items) {
		if (typeof read === "string" || (!read.propertyId && !read.where))
			yield {
				output: {
					slot: { kind: "cell", columnId },
					text: lookupFixtureCellText(column.dataType, row.values[columnId]),
				},
			};
		return;
	}
	for (const [index, item] of items.entries()) {
		if (
			typeof read !== "string" &&
			read.positionBeforeFilter &&
			index + 1 !== read.occurrence
		)
			continue;
		const property = (
			propertyId: NonNullable<LookupColumn["properties"]>[number]["id"],
		): FixtureAtom | undefined => {
			const text = item.properties[propertyId];
			return text === undefined
				? undefined
				: { slot: { kind: "property", columnId, index, propertyId }, text };
		};
		const predicate =
			typeof read !== "string" && read.where
				? property(read.where.propertyId)
				: undefined;
		if (typeof read !== "string" && read.where && !predicate) continue;
		const output =
			typeof read !== "string" && read.propertyId
				? property(read.propertyId)
				: {
						slot: { kind: "occurrence" as const, columnId, index },
						text: item.text,
					};
		yield { predicate, output };
	}
}
export function lookupReadPosition(read: LookupRead) {
	return typeof read !== "string" && "columnId" in read
		? read.positionBeforeFilter
			? undefined
			: read.occurrence
		: undefined;
}
export function lookupReadFilter(read: LookupRead) {
	return typeof read !== "string" && "columnId" in read
		? read.where?.equals
		: undefined;
}
export function* lookupReadNodes(
	row: LookupFixtureRow,
	read: LookupRead,
	resolved: ResolvedLookupRead,
): Generator<FixtureAtom> {
	const wanted = lookupReadPosition(read);
	const equals = lookupReadFilter(read);
	let position = 0;
	for (const item of lookupReadCandidates(row, read, resolved)) {
		if (item.predicate && item.predicate.text !== equals) continue;
		position++;
		if ((wanted === undefined || wanted === position) && item.output)
			yield item.output;
		if (position === wanted) return;
	}
}
/** ItemSetUtils uses XPathConditional.evalReadable, whose FunctionUtils
 * scalar conversion rejects multiple nodes. A user can choose a position. */
export function lookupReadText(
	row: LookupFixtureRow,
	read: LookupRead,
	resolved: ResolvedLookupRead,
) {
	const values = lookupReadNodes(row, read, resolved);
	const first = values.next();
	if (first.done) return "";
	if (!values.next().done)
		throw new Error(
			`“${resolved.label}” matches several values in one row. You can choose a position or a detail that identifies one value.`,
		);
	return first.value.text;
}

export function lookupReadSteps(
	table: Pick<LookupTableWireNaming, "memberNameFor" | "wireNameFor">,
	read: LookupRead,
): readonly WireStep[] {
	if (typeof read === "string") return [w.step(table.wireNameFor(read))];
	if ("attributeId" in read)
		return [w.attr(table.memberNameFor(undefined, read.attributeId))];
	const predicates = [];
	if (read.where)
		predicates.push(
			w.eq(
				w.context([
					w.attr(table.memberNameFor(read.columnId, read.where.propertyId)),
				]),
				w.str(read.where.equals),
			),
		);
	if (read.occurrence !== undefined) {
		const position = w.num(read.occurrence);
		if (read.positionBeforeFilter) predicates.unshift(position);
		else predicates.push(position);
	}
	const steps = [w.step(table.wireNameFor(read.columnId), predicates)];
	if (read.propertyId !== undefined)
		steps.push(w.attr(table.memberNameFor(read.columnId, read.propertyId)));
	return steps;
}
