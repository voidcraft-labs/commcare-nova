// components/builder/form-links/useLinkSentenceContext.ts
//
// The document-backed `LinkSentenceContext`: destinations resolved by
// identity, conditions printed against the current names. It reads the
// whole doc because a link can point anywhere in the app.

"use client";

import { useMemo } from "react";
import { useBlueprintDoc } from "@/lib/doc/hooks/useBlueprintDoc";
import {
	type FormLink,
	type FormLinkTarget,
	formLinkDestination,
	projectXPath,
	xpathPrintContext,
} from "@/lib/domain";
import type { LinkSentenceContext } from "./linkSentence";

export function useLinkSentenceContext(): LinkSentenceContext {
	const doc = useBlueprintDoc((state) => state);
	return useMemo<LinkSentenceContext>(
		() => ({
			destinationOf: (target: FormLinkTarget) =>
				formLinkDestination(doc, target),
			conditionText: (link: FormLink) =>
				link.condition === undefined
					? ""
					: projectXPath(link.condition, xpathPrintContext(doc)).text,
		}),
		[doc],
	);
}
