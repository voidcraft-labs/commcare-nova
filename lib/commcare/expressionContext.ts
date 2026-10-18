import type { BlueprintDoc, Uuid } from "@/lib/domain";
import {
	type ExpressionContext,
	slotContext,
} from "@/lib/domain/expression/context";
import type {
	ExpressionSlotRef,
	ModuleExpressionSlotRef,
} from "@/lib/domain/expression/types";
import {
	type LookupWireNaming,
	lookupTypeIndexFromNaming,
} from "./lookup/naming";

type ModuleSlotAddress<T = ModuleExpressionSlotRef> =
	T extends ModuleExpressionSlotRef ? Omit<T, "entity" | "uuid"> : never;

/** Every emitted carrier resolves its own committed slot and member identity. */
export type ModuleExpressionContexts = (
	address: ModuleSlotAddress,
) => ExpressionContext;

export function requireExpressionContext(
	doc: BlueprintDoc,
	ref: ExpressionSlotRef,
	lookupNaming?: LookupWireNaming,
): ExpressionContext {
	const context = slotContext(
		doc,
		ref,
		lookupTypeIndexFromNaming(lookupNaming) ?? new Map(),
	);
	if (context === undefined)
		throw new Error(
			`Expression emission could not resolve ${ref.entity} ${ref.uuid}, slot ${ref.slot}.`,
		);
	return context;
}

export function moduleExpressionContexts(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
	lookupNaming?: LookupWireNaming,
): ModuleExpressionContexts {
	return (address) =>
		requireExpressionContext(
			doc,
			{ entity: "module", uuid: moduleUuid, ...address },
			lookupNaming,
		);
}
