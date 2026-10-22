import type { BlueprintDoc } from "@/lib/domain/blueprint";
import type { LookupDefinitionIndex } from "@/lib/domain/expression/context";
import {
	type FormStructure,
	type FormStructureConnect,
	formStructure,
} from "@/lib/domain/expression/formStructure";
import type { Expression } from "@/lib/domain/expression/types";
import type { ConnectExpressionSlotId } from "@/lib/domain/referenceSlots";
import type { Uuid } from "@/lib/domain/uuid";
import { parseAuthoredFormExpression } from "./expressionText";

/** A complete pending Connect declaration, before its expression text is read.
 * Every block identity is already final; the view never allocates identities
 * or inserts placeholder expressions into the saved document. */
export function prepareFormConnectStructure(
	doc: BlueprintDoc,
	formUuid: Uuid,
	mode: "learn" | "deliver" | null,
	blocks: FormStructureConnect,
	expressionAt?: FormStructure["expressionAt"],
): FormStructure | undefined {
	const saved = formStructure(doc, formUuid);
	if (saved === undefined) return undefined;
	const connect: FormStructureConnect =
		mode === "learn"
			? {
					...(blocks.learn_module === undefined
						? {}
						: { learn_module: blocks.learn_module }),
					...(blocks.assessment === undefined
						? {}
						: { assessment: blocks.assessment }),
				}
			: mode === "deliver"
				? {
						...(blocks.deliver_unit === undefined
							? {}
							: { deliver_unit: blocks.deliver_unit }),
						...(blocks.task === undefined ? {} : { task: blocks.task }),
					}
				: {};
	return {
		...saved,
		connect,
		expressionAt: expressionAt ?? saved.expressionAt,
	};
}

/** Parse pending Connect sources lazily against all finalized declarations. */
export function prepareFormConnectExpressions(
	doc: BlueprintDoc,
	formUuid: Uuid,
	mode: "learn" | "deliver",
	blocks: FormStructureConnect,
	sources: ReadonlyMap<ConnectExpressionSlotId, string>,
	lookup: LookupDefinitionIndex | "unavailable",
): FormStructure | undefined {
	const resolved = new Map<ConnectExpressionSlotId, Expression>();
	const resolving = new Set<ConnectExpressionSlotId>();
	const base = prepareFormConnectStructure(doc, formUuid, mode, blocks);
	if (base === undefined) return undefined;
	const form: FormStructure = {
		...base,
		expressionAt: (slot) => {
			if (
				slot.entity !== "form" ||
				slot.uuid !== formUuid ||
				(slot.slot !== "assessment_user_score" &&
					slot.slot !== "deliver_entity_id" &&
					slot.slot !== "deliver_entity_name")
			)
				return base.expressionAt(slot);
			const source = sources.get(slot.slot);
			if (source === undefined) return undefined;
			const existing = resolved.get(slot.slot);
			if (existing !== undefined) return existing;
			if (resolving.has(slot.slot))
				throw new Error(
					"These Connect values depend on one another in a loop. Change one of their references.",
				);
			resolving.add(slot.slot);
			try {
				const expression = parseAuthoredFormExpression(
					{ doc, slot, lookup, form, current: base.expressionAt(slot) },
					source,
				);
				if (expression !== undefined) resolved.set(slot.slot, expression);
				return expression;
			} finally {
				resolving.delete(slot.slot);
			}
		},
	};
	return form;
}
