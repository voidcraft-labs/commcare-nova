/**
 * Step 5, `declare-read-properties` (part 09 §5, §8): each `(caseType,
 * property)` a lifted typed read names (a `prop` in a `cases` row or a
 * `project`, a `form-case`) that the case type's effective catalog does not
 * hold joins `apps.case_types` as `{ name, label: <the name>, data_type }`,
 * with the least type its reads admit: `decimal` where a read does
 * arithmetic on it or orders it against a number, `date` / `datetime` where
 * a read orders it against one, else `text`. Two reads that admit no common
 * type are `declared-property-type-conflict`, and the property is left
 * undeclared for the author. A declared property whose key the app's
 * `cases` rows of that type already hold is
 * `declared-property-has-stored-values`: an orphan the declaration would
 * make readable and validated again, for a person to look at.
 *
 * Then every slot step 4 refused only with `case-query-untyped` is parsed
 * again against the document with the declarations, so a query that now
 * has one declaring type binds. They are parsed in step 4's order, a
 * repeat's query first, against the structure that carries every lifted
 * value another slot's typing reads, step 4's and these. A query the one
 * declaring type binds types the property it filters on, not its rows, so
 * a row read step 4 lifted reads the same against the target; step 7 holds
 * every slot to that.
 */

import type { CasePropertyDataType } from "@/lib/domain/casePropertyTypes";
import type { ExpressionNode } from "@/lib/domain/expression/children";
import type { ExpressionContext } from "@/lib/domain/expression/context";
import { scalarDataType, typeOf } from "@/lib/domain/expression/typeChecker";
import type {
	ComparisonKind,
	Expression,
	Term,
} from "@/lib/domain/expression/types";
import { proseText } from "@/lib/domain/prose";
import type { JsonRecord } from "../oldShape";
import type {
	BlockerPlace,
	CutoverBlocker,
	DocumentChange,
	ExpressionsStep,
} from "../types";
import { liftFormSlot } from "./formLogicLift";
import {
	appEntity,
	entityName,
	noticeText,
	slotForm,
	walkWithContext,
} from "./shared";
import { inDependencyOrder } from "./working";

/** What one read asks of its property's type. */
export type ReadUse = "print" | "arithmetic" | "number" | "date" | "datetime";

const ORDERINGS: ReadonlySet<ComparisonKind> = new Set([
	"lt",
	"lte",
	"gt",
	"gte",
]);

/**
 * The least type a property's reads admit, or `conflict` where two reads
 * admit no common one. `text` is what a read that only prints admits.
 */
export function leastReadType(
	uses: Iterable<ReadUse>,
): CasePropertyDataType | "conflict" {
	const needed = new Set<CasePropertyDataType>();
	for (const use of uses) {
		if (use === "arithmetic" || use === "number") needed.add("decimal");
		else if (use === "date" || use === "datetime") needed.add(use);
	}
	if (needed.size === 0) return "text";
	if (needed.size === 1) return [...needed][0];
	return "conflict";
}

/** The property a read operand names: a projected row value or a form's case. */
function readOf(
	operand: Expression,
): { caseType: string; property: string } | undefined {
	const term: Term | undefined =
		operand.kind === "project"
			? operand.value
			: operand.kind === "term"
				? operand.term
				: undefined;
	if (term === undefined) return undefined;
	if (
		(term.kind === "prop" || term.kind === "form-case") &&
		term.caseType !== undefined
	)
		return { caseType: term.caseType, property: term.property };
	return undefined;
}

/** What an operand opposite the read asks of it, by its type. */
function oppositeUse(opposite: Expression, ctx: ExpressionContext): ReadUse {
	const data = scalarDataType(typeOf(opposite, ctx)?.data);
	if (data === "int" || data === "decimal") return "number";
	if (data === "date") return "date";
	if (data === "datetime") return "datetime";
	return "print";
}

/** Every typed read in one tree, with what each asks of its property. */
export function propertyReads(
	expression: Expression,
	ctx: ExpressionContext,
): { caseType: string; property: string; use: ReadUse }[] {
	const reads: { caseType: string; property: string; use: ReadUse }[] = [];
	const used = new Set<ExpressionNode>();
	walkWithContext(expression, ctx, (node, nodeCtx) => {
		if (node.kind === "arith") {
			for (const operand of [node.left, node.right]) {
				const read = readOf(operand);
				if (read !== undefined) {
					reads.push({ ...read, use: "arithmetic" });
					used.add(operand);
				}
			}
		} else if (
			ORDERINGS.has(node.kind as ComparisonKind) &&
			"left" in node &&
			"right" in node
		) {
			const { left, right } = node as { left: Expression; right: Expression };
			for (const [operand, opposite] of [
				[left, right],
				[right, left],
			] as const) {
				const read = readOf(operand);
				if (read !== undefined) {
					reads.push({ ...read, use: oppositeUse(opposite, nodeCtx) });
					used.add(operand);
				}
			}
		} else if (
			(node.kind === "project" || node.kind === "term") &&
			!used.has(node)
		) {
			const read = readOf(node);
			if (read !== undefined) reads.push({ ...read, use: "print" });
		}
	});
	return reads;
}

function isRecord(value: unknown): value is JsonRecord {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export const declareReadPropertiesStep: ExpressionsStep = {
	id: "declare-read-properties",
	apply(doc, ctx) {
		const structure = doc.structure();
		if (!structure.ok)
			return { changes: [], blockers: [], classes: [], places: [] };
		const pending = new Map<
			string,
			{ caseType: string; property: string; uses: ReadUse[]; form?: string }
		>();
		for (const slot of doc.slots()) {
			if (slot.ruleSet !== "form") continue;
			if (slot.lifted === false || slot.lifted.value === undefined) continue;
			const slotCtx = doc.structureContext(slot);
			if (slotCtx === undefined) continue;
			for (const read of propertyReads(slot.lifted.value, slotCtx)) {
				const type = slotCtx.facts.caseTypes.find(
					(entry) => entry.name === read.caseType,
				);
				if (type === undefined) continue;
				if (type.properties.some((property) => property.name === read.property))
					continue;
				const key = JSON.stringify([read.caseType, read.property]);
				const entry = pending.get(key) ?? {
					caseType: read.caseType,
					property: read.property,
					uses: [],
					form: slotForm(doc.raw, slot),
				};
				entry.uses.push(read.use);
				pending.set(key, entry);
			}
		}

		const changes: DocumentChange[] = [];
		const places: BlockerPlace[] = [];
		let declared = 0;
		const catalog = (
			Array.isArray(doc.raw.caseTypes) ? doc.raw.caseTypes : []
		) as JsonRecord[];
		for (const entry of [...pending.values()].sort((a, b) =>
			a.caseType === b.caseType
				? a.property < b.property
					? -1
					: 1
				: a.caseType < b.caseType
					? -1
					: 1,
		)) {
			const type = leastReadType(entry.uses);
			if (type === "conflict") {
				places.push({
					code: "declared-property-type-conflict",
					entity: { kind: "app" },
					text: `${entry.caseType}/${entry.property}`,
				});
				continue;
			}
			const stored =
				ctx.storedCaseKeys.get(entry.caseType)?.get(entry.property) ?? 0;
			if (stored > 0)
				places.push({
					code: "declared-property-has-stored-values",
					entity: { kind: "app" },
					text: `${entry.caseType}/${entry.property}`,
				});
			let owner = catalog.find(
				(caseType) => isRecord(caseType) && caseType.name === entry.caseType,
			);
			if (owner === undefined) {
				owner = { name: entry.caseType, properties: [] };
				catalog.push(owner);
			}
			(owner.properties as unknown as JsonRecord[]).push({
				name: entry.property,
				label: proseText(entry.property) as unknown as JsonRecord,
				data_type: type,
			});
			declared += 1;
			doc.declared.add(JSON.stringify([entry.caseType, entry.property]));
			changes.push({
				reason: "case-property-declared",
				entity: appEntity(doc.raw),
				detail: {
					caseType: noticeText(entry.caseType),
					property: noticeText(entry.property),
					dataType: type,
					...(entry.form === undefined
						? {}
						: { form: entityName(doc.raw, "form", entry.form) }),
				},
			});
		}
		if (declared > 0) {
			if (!Array.isArray(doc.raw.caseTypes))
				(doc.raw as { caseTypes: unknown }).caseTypes = catalog;
			doc.structureChanged();
		}

		let reparsed = 0;
		if (declared > 0)
			for (const slot of inDependencyOrder(doc.slots())) {
				const refused = slot.refused;
				if (
					refused === undefined ||
					!refused.codes.every((code) => code === "case-query-untyped")
				)
					continue;
				if (liftFormSlot(doc, slot, ctx).kind === "lifted") reparsed += 1;
			}

		const blockers: CutoverBlocker[] = (
			[
				"declared-property-type-conflict",
				"declared-property-has-stored-values",
			] as const
		).flatMap((code) => {
			const count = places.filter((place) => place.code === code).length;
			return count === 0 ? [] : [{ code, count, findingCodes: [] }];
		});
		return {
			changes,
			blockers,
			classes: [
				...(declared === 0
					? []
					: [
							{
								step: "declare-read-properties" as const,
								class: "declared" as const,
								count: declared,
							},
						]),
				...(reparsed === 0
					? []
					: [
							{
								step: "declare-read-properties" as const,
								class: "reparsed" as const,
								count: reparsed,
							},
						]),
			],
			places,
		};
	},
};
