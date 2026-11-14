import type { BlueprintDoc } from "@/lib/domain/blueprint";
import {
	type ExpressionContext,
	expressionFacts,
	referencedCountResults,
	slotContext,
} from "@/lib/domain/expression/context";
import {
	type FormStructure,
	formStructure,
} from "@/lib/domain/expression/formStructure";
import type {
	Expression,
	ProseSlotRef,
	SlotContextRef,
} from "@/lib/domain/expression/types";
import type { ProseAtomPart } from "@/lib/domain/prose";
import { proseAtomExpression } from "@/lib/domain/proseExpression";
import {
	planRepeatCountCarriers,
	type RepeatCountCarrierPlan,
} from "@/lib/domain/repeatCount";
import type { Uuid } from "@/lib/domain/uuid";
import {
	type LookupWireNaming,
	lookupTypeIndexFromNaming,
} from "../lookup/naming";
import {
	type FormNodeProjection,
	formNodeProjection,
} from "../xpath/formNodeProjection";
import { toWire, type WireTermBindings } from "../xpath/wire/fromExpression";
import type { WireExpr } from "../xpath/wire/tree";
import { itextIdFor } from "./itextIds";

export interface FormExpressionEmission {
	readonly form: FormStructure;
	readonly projection: FormNodeProjection;
	readonly counts: RepeatCountCarrierPlan;
	/** The id each session value the form reads prints as, from the entry
	 *  that opens it; the bindings of every slot the form's own emitters
	 *  lower outside `lower` carry it too. */
	readonly datumId: WireTermBindings["datumId"];
	context(slot: SlotContextRef): ExpressionContext;
	lower(
		expression: Expression,
		slot: SlotContextRef,
		overrides?: ReadonlyMap<Expression, WireExpr>,
	): WireExpr;
	/** A prose atom lowered in its slot: a reference's read, or a calculated
	 *  value's own expression. */
	prose(part: ProseAtomPart, slot: ProseSlotRef): WireExpr;
}

/** Every authored form expression enters wire lowering with its actual slot
 * and the same finite form projection used while binding its identities. */
export function formExpressionEmission(
	doc: BlueprintDoc,
	formUuid: Uuid,
	naming: LookupWireNaming | undefined,
	bindings: WireTermBindings,
	expressionDoc: BlueprintDoc = doc,
): FormExpressionEmission {
	// Wire-only menu placement can move a form to a synthetic module. Its
	// expressions still belong to the authored host, including Search inputs.
	// That projection must preserve the form and all field coordinates.
	if (
		expressionDoc !== doc &&
		(expressionDoc.forms[formUuid] !== doc.forms[formUuid] ||
			expressionDoc.fields !== doc.fields ||
			expressionDoc.fieldOrder !== doc.fieldOrder ||
			expressionDoc.fieldParent !== doc.fieldParent)
	)
		throw new Error(
			"The emitted form no longer preserves its authored question identities and paths.",
		);
	const form = formStructure(expressionDoc, formUuid);
	if (form === undefined)
		throw new Error(`Form ${formUuid} has no complete expression structure.`);
	const projection = formNodeProjection(doc, form, { surface: "wire" });
	const lookup = lookupTypeIndexFromNaming(naming) ?? new Map();
	const contexts = new Map<string, ExpressionContext>();
	const context = (slot: SlotContextRef): ExpressionContext => {
		const key = JSON.stringify(slot);
		const previous = contexts.get(key);
		if (previous !== undefined) return previous;
		const result = slotContext(expressionDoc, slot, lookup, { form });
		if (result === undefined)
			throw new Error(
				`The form expression slot ${slot.slot} has no valid owning context.`,
			);
		contexts.set(key, result);
		return result;
	};
	const lower = (
		expression: Expression,
		slot: SlotContextRef,
		overrides?: ReadonlyMap<Expression, WireExpr>,
	): WireExpr =>
		toWire(expression, {
			target: "xform",
			types: context(slot),
			form: projection,
			bindings: {
				...bindings,
				itextId: (unit) => itextIdFor(expressionDoc, unit, form),
			},
			...(overrides === undefined ? {} : { overrides }),
		});
	return {
		form,
		projection,
		counts: planRepeatCountCarriers(
			form,
			referencedCountResults(expressionDoc, formUuid),
			expressionFacts(expressionDoc),
		),
		datumId: bindings.datumId,
		context,
		lower,
		prose: (part, slot) => lower(proseAtomExpression(part), slot),
	};
}
