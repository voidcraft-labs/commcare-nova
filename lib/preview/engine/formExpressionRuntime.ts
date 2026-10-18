import { lookupTypeIndexFromNaming } from "@/lib/commcare/lookup/naming";
import { FormPath } from "@/lib/commcare/xform/formPath";
import {
	type FormNodeProjection,
	formNodeProjection,
} from "@/lib/commcare/xpath/formNodeProjection";
import { formReads } from "@/lib/commcare/xpath/wire/formReads";
import {
	toWire,
	type WireTermBindings,
} from "@/lib/commcare/xpath/wire/fromExpression";
import { serializeWire } from "@/lib/commcare/xpath/wire/serialize";
import type { BlueprintDoc, Uuid } from "@/lib/domain";
import {
	type ExpressionContext,
	slotContext,
} from "@/lib/domain/expression/context";
import type { FormNodeGraph } from "@/lib/domain/expression/formNodes";
import { formStructure } from "@/lib/domain/expression/formStructure";
import {
	type Expression,
	type ExpressionSlotRef,
	type FormNodeRef,
	formNodeKey,
} from "@/lib/domain/expression/types";
import { expressionAt } from "@/lib/domain/expressionSource";
import type { PreviewLookupData } from "./lookupEvaluation";

/** The current Preview instance stores query rows directly beneath their
 * authored repeat name. Keep that physical projection private to this runtime;
 * native emission and admission always use the complete form-node graph. */
export function previewFormNodeProjection(
	doc: BlueprintDoc,
	formUuid: Uuid,
): FormNodeProjection {
	const form = formStructure(doc, formUuid);
	if (form === undefined)
		throw new Error(`Form ${formUuid} has no expression structure.`);
	const native = formNodeProjection(doc, form);
	const path = (node: FormNodeRef) =>
		native.graph.path(node)?.filter((part, index, parts) => {
			const next = parts[index + 1];
			return !(
				part.kind === "field" &&
				part.role === "query-wrapper" &&
				next?.kind === "field" &&
				next.role === undefined &&
				next.uuid === part.uuid
			);
		});
	const graph: FormNodeGraph = {
		...native.graph,
		path,
		parent: (node) => path(node)?.at(-2),
	};
	const step: FormNodeProjection["step"] = (node) => {
		if (node.kind !== "field" || node.role !== undefined)
			return native.step(node);
		const field = form.fields.get(node.uuid);
		return field === undefined ? undefined : { name: field.id };
	};
	return {
		graph,
		step,
		path(node) {
			const coordinates = path(node);
			if (coordinates === undefined) return undefined;
			let result = FormPath.root();
			for (const coordinate of coordinates.slice(1)) {
				const projected = step(coordinate);
				if (projected === undefined) return undefined;
				result = projected.attribute
					? result.attr(projected.name)
					: result.child(projected.name);
			}
			return result;
		},
	};
}

export interface FormExpressionRuntime {
	readonly doc: BlueprintDoc;
	readonly formUuid: Uuid;
	readonly projection: FormNodeProjection;
	context(slot: ExpressionSlotRef): ExpressionContext;
	source(slot: ExpressionSlotRef): string | undefined;
	lower(expression: Expression, slot: ExpressionSlotRef): string;
}

/** Stored trees enter the shared wire emitter with their real owning slot.
 * The resulting text is an evaluator input, never a display-text round trip. */
export function formExpressionRuntime(
	doc: BlueprintDoc,
	formUuid: Uuid,
	lookup: PreviewLookupData | undefined,
	bindings: WireTermBindings,
): FormExpressionRuntime {
	const projection = previewFormNodeProjection(doc, formUuid);
	const contexts = new Map<string, ExpressionContext>();
	const context = (slot: ExpressionSlotRef): ExpressionContext => {
		const key = JSON.stringify(slot);
		const cached = contexts.get(key);
		if (cached !== undefined) return cached;
		const result = slotContext(
			doc,
			slot,
			lookupTypeIndexFromNaming(lookup?.naming) ?? new Map(),
		);
		if (result === undefined)
			throw new Error(
				`The form's ${slot.slot} expression has no owning context.`,
			);
		contexts.set(key, result);
		return result;
	};
	const lower = (expression: Expression, slot: ExpressionSlotRef): string => {
		for (const { node } of formReads(expression)) {
			if (
				(node.kind === "field" && node.role === "query-wrapper") ||
				(node.kind !== "field" && node.kind !== "repeat-row")
			)
				throw new Error(
					`Preview cannot yet evaluate the generated form node ${formNodeKey(node)}.`,
				);
		}
		return serializeWire(
			toWire(expression, {
				target: "preview",
				types: context(slot),
				form: projection,
				bindings: {
					...bindings,
					...(lookup === undefined
						? {}
						: {
								lookup: {
									naming: lookup.naming,
									instanceScope: "xform" as const,
								},
							}),
				},
			}),
			{ target: "preview" },
		).text;
	};
	return {
		doc,
		formUuid,
		projection,
		context,
		lower,
		source(slot) {
			const expression = expressionAt(doc, slot);
			return expression === undefined ? undefined : lower(expression, slot);
		},
	};
}
