"use client";
import { useCallback, useContext } from "react";
import { buildLintContext } from "@/lib/codemirror/buildLintContext";
import type { XPathLintContext } from "@/lib/codemirror/xpath-lint";
import { BlueprintDocContext } from "@/lib/doc/provider";
import type { Uuid } from "@/lib/doc/types";

/**
 * Produces a memoized `getLintContext()` callback for CodeMirror XPath
 * fields rendered inside connect sub-configs. Reads the doc store
 * imperatively via `getState()` so the lint context always reflects the
 * latest blueprint — subscribing would rebuild the context on every
 * unrelated doc change and cause CodeMirror to thrash.
 *
 * Delegates to `buildLintContext`, which pre-collects the thin slices
 * (valid paths, case properties, form entries) that the xpath-lint plugin
 * needs without walking the full doc on each keystroke.
 */
export function useConnectLintContext(formUuid: Uuid) {
	const docStore = useContext(BlueprintDocContext);
	return useCallback((): XPathLintContext | undefined => {
		if (!docStore) return undefined;
		return buildLintContext(docStore.getState(), formUuid);
	}, [docStore, formUuid]);
}
