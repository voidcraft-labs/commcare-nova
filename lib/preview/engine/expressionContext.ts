import type { BlueprintDoc } from "@/lib/domain";
import {
	type ExpressionContext,
	slotContext,
} from "@/lib/domain/expression/context";
import type { ExpressionSlotRef } from "@/lib/domain/expression/types";
import { lookupReadTypes } from "@/lib/domain/lookupRead";
import type { PreviewLookupData } from "./lookupEvaluation";

/** Runtime expressions use the exact document slot and held Project snapshot. */
export function previewExpressionContext(
	doc: BlueprintDoc,
	ref: ExpressionSlotRef,
	lookup?: PreviewLookupData,
): ExpressionContext {
	const context = slotContext(
		doc,
		ref,
		new Map(
			(lookup?.definitions ?? []).map((table) => [
				table.id,
				lookupReadTypes(table),
			]),
		),
	);
	if (context === undefined)
		throw new Error(
			`Preview could not resolve ${ref.entity} ${ref.uuid}, slot ${ref.slot}.`,
		);
	return context;
}
