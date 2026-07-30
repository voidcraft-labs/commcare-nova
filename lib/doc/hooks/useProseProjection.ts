// lib/doc/hooks/useProseProjection.ts
//
// The document-aware prose projector, as a hook.
//
// A `ProseTemplate` reference is a UUID or a `(caseType, property)` pair, so
// its current spelling only exists relative to a document. Without one the
// context-free projector prints `[reference needs repair]` for every field and
// custom-worker-property reference — which reads as damage on a healthy label
// AND makes a genuinely dangling reference indistinguishable from a working
// one, so the repair state stops carrying information. Every user-visible
// surface therefore projects through here.
//
// The five subscribed families are exactly what `xpathPrintContext` reads:
// paths come from `fieldParent`/`fieldOrder` up to a `forms` root, worker slugs
// from `userProperties`. Subscribing narrowly keeps a label edit from
// re-rendering every projecting surface in the app.
//
// Reference-stable while those families are, so callers can hold the returned
// function in a dependency array.

"use client";

import { useCallback } from "react";
import type { ProseTemplate } from "@/lib/domain";
import { projectProseTemplate } from "@/lib/domain/prose";
import type { XPathPrintableDoc } from "@/lib/domain/xpath/print";
import { useBlueprintDocShallow } from "./useBlueprintDoc";

/** Project a template to its current spelling against the live document. */
export type ProseProjector = (template: ProseTemplate) => string;

export function useProseProjection(): ProseProjector {
	const doc = useBlueprintDocShallow<XPathPrintableDoc>((s) => ({
		fields: s.fields,
		forms: s.forms,
		fieldOrder: s.fieldOrder,
		fieldParent: s.fieldParent,
		userProperties: s.userProperties,
	}));
	return useCallback(
		(template: ProseTemplate) => projectProseTemplate(template, doc).text,
		[doc],
	);
}
