// components/builder/form-links/useLinkSentenceContext.ts
//
// The document-backed `LinkSentenceContext`: destinations resolved by
// identity, conditions printed against the current names. It reads the
// whole doc because a link can point anywhere in the app.

"use client";

import { useFormLinkProjection } from "@/lib/doc/hooks/useFormLinkChoices";
import type { LinkSentenceContext } from "./linkSentence";

export function useLinkSentenceContext(): LinkSentenceContext {
	return useFormLinkProjection();
}
