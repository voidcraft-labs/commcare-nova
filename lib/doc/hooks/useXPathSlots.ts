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
import {
	parseXPathForField,
	parseXPathForForm,
} from "@/lib/doc/expressionText";
import {
	useBlueprintDocApi,
	useBlueprintDocShallow,
} from "@/lib/doc/hooks/useBlueprintDoc";
import type { Uuid } from "@/lib/doc/types";
import {
	projectXPath,
	type XPathExpression,
	type XPathProjectionResult,
	xpathPrintContext,
} from "@/lib/domain";

/** Structured human projection of an AST-stored slot. Callers that own an
 * editor should render the unresolved arm as a repair state rather than
 * treating its marker text as an ordinary authored expression. */
export function useXPathProjection(
	expr: XPathExpression | undefined,
): XPathProjectionResult {
	return useBlueprintDocShallow((doc) => {
		if (expr === undefined) return { ok: true, text: "" };
		return projectXPath(expr, xpathPrintContext(doc));
	});
}

/** The printed text of an AST-stored slot value, kept current against
 *  doc changes (renames/moves of referenced fields re-print). An
 *  absent slot reads as `""` — the editor's empty state. Compact
 *  read-only callers may use this convenience; editors should consume
 *  `useXPathProjection` so they preserve the repair discriminator. */
export function useXPathText(expr: XPathExpression | undefined): string {
	return useXPathProjection(expr).text;
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

/** The form-scoped twin — for form-level expression slots (the
 *  Connect-block bindings). */
export function useParseXPathForForm(
	formUuid: Uuid,
): (text: string) => XPathExpression {
	const api = useBlueprintDocApi();
	return useCallback(
		(text: string) => parseXPathForForm(api.getState(), formUuid, text),
		[api, formUuid],
	);
}
