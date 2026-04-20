/**
 * useFormLintContext — shared hook used by every XPath-valued editor
 * that needs to lint an expression against its owning form.
 *
 * XPathField needs a context carrying valid-paths, case properties,
 * and sibling form entries. The context is keyed on the form that
 * owns the field, and fields can live nested inside group/repeat
 * containers. The hook walks `fieldParent` up the entity tree until
 * it hits a form, then builds the context from the doc snapshot at
 * call time (not at hook-construction time) so the lint result
 * reflects whatever state is current when the user edits.
 *
 * Returns a stable getter that yields `undefined` when no provider
 * is mounted or the walk runs out before hitting a form. XPathField
 * treats `undefined` as "no context" and skips linting rather than
 * throwing.
 */

"use client";
import { useCallback, useContext } from "react";
import { buildLintContext } from "@/lib/codemirror/buildLintContext";
import type { XPathLintContext } from "@/lib/codemirror/xpath-lint";
import { BlueprintDocContext } from "@/lib/doc/provider";
import type { Uuid } from "@/lib/doc/types";

export function useFormLintContext(
	fieldUuid: Uuid,
): () => XPathLintContext | undefined {
	const docStore = useContext(BlueprintDocContext);
	return useCallback(() => {
		if (!docStore) return undefined;
		const s = docStore.getState();
		let parentUuid: Uuid | undefined = s.fieldParent[fieldUuid] ?? undefined;
		while (parentUuid && !s.forms[parentUuid]) {
			parentUuid = s.fieldParent[parentUuid] ?? undefined;
		}
		if (!parentUuid) return undefined;
		return buildLintContext(s, parentUuid);
	}, [docStore, fieldUuid]);
}
