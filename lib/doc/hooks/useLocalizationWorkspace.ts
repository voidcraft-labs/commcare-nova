"use client";

import { useMemo } from "react";
import { createLocalizationWorkspace } from "@/lib/doc/localizationWorkspace";
import type { LanguageTag } from "@/lib/domain";
import { useLookupCommitState } from "../lookupCommitContext";
import { lookupExpressionDefinitions } from "../lookupExpressionContext";
import { useBlueprintDoc } from "./useBlueprintDoc";

/** The translation inventory spans all authored text and protected references.
 *  A calculated value prints under the Project's live lookup definitions, as
 *  its chip does. */
export function useLocalizationWorkspace(language: LanguageTag) {
	const doc = useBlueprintDoc((state) => state);
	const { lookupContext } = useLookupCommitState();
	return useMemo(
		() =>
			createLocalizationWorkspace(
				doc,
				language,
				lookupExpressionDefinitions(lookupContext),
			),
		[doc, language, lookupContext],
	);
}
