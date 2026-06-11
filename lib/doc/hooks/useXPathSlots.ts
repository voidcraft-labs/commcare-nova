/**
 * Hooks for components that edit AST-stored XPath slots.
 *
 * Display is a live PROJECTION: `useXPathText` subscribes to the doc
 * and prints the expression per render-relevant change, so a rename of
 * a referenced field updates the shown text with no slot write.
 * Commit is the inverse: `useParseXPathForField` parses the authored
 * text against the CURRENT doc at commit time (non-subscribing — a
 * commit reads the moment's truth, it doesn't re-render on it).
 */

"use client";

import { useCallback } from "react";
import { parseXPathForField } from "@/lib/doc/expressionText";
import {
	useBlueprintDoc,
	useBlueprintDocApi,
} from "@/lib/doc/hooks/useBlueprintDoc";
import type { Uuid } from "@/lib/doc/types";
import {
	printXPath,
	type XPathExpression,
	xpathPrintContext,
} from "@/lib/domain";

/** The printed text of an AST-stored slot value, kept current against
 *  doc changes (renames/moves of referenced fields re-print). An
 *  absent slot reads as `""` — the editor's empty state. */
export function useXPathText(expr: XPathExpression | undefined): string {
	return useBlueprintDoc((doc) =>
		expr === undefined ? "" : printXPath(expr, xpathPrintContext(doc)),
	);
}

/** A committer-side parser scoped to one field: text → stored AST,
 *  resolved against the doc as of the commit. */
export function useParseXPathForField(
	fieldUuid: Uuid,
): (text: string) => XPathExpression {
	const api = useBlueprintDocApi();
	return useCallback(
		(text: string) => parseXPathForField(api.getState(), fieldUuid, text),
		[api, fieldUuid],
	);
}
