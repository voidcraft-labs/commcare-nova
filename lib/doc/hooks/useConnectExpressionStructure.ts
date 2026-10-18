"use client";
import { useMemo } from "react";
import type { FormStructureConnect } from "@/lib/domain/expression/formStructure";
import type { ConnectExpressionSlotId } from "@/lib/domain/referenceSlots";
import type { Uuid } from "@/lib/domain/uuid";
import { prepareFormConnectExpressions } from "../formExpressionStructure";
import { useLookupCommitState } from "../lookupCommitContext";
import { lookupExpressionDefinitions } from "../lookupExpressionContext";
import { useBlueprintDoc } from "./useBlueprintDoc";

/** Rebind a complete Connect draft when its real form or references change. */
export function useConnectExpressionStructure(
	formUuid: Uuid,
	mode: "learn" | "deliver",
	blocks: FormStructureConnect,
	sources: ReadonlyMap<ConnectExpressionSlotId, string>,
) {
	const doc = useBlueprintDoc((current) => current);
	const { lookupContext } = useLookupCommitState();
	return useMemo(
		() =>
			prepareFormConnectExpressions(
				doc,
				formUuid,
				mode,
				blocks,
				sources,
				lookupExpressionDefinitions(lookupContext),
			),
		[doc, formUuid, mode, blocks, sources, lookupContext],
	);
}
