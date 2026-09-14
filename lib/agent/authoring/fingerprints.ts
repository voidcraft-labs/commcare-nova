import { createHash } from "node:crypto";
import type { TranslationEntry, TranslationUnit } from "@/lib/domain";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";

/** A transport token for the canonical source proof. The stored proof and its
 * equality checks remain owned by localization. */
export function authoringFingerprint(canonical: string): string {
	return `source:${createHash("sha256").update(canonical).digest("base64url")}`;
}

/** Review names the exact source and translation read, without echoing either. */
export function translationReviewRevision(
	language: string,
	unit: Pick<TranslationUnit, "id" | "sourceFingerprint">,
	entry: TranslationEntry,
): string {
	return canonicalJsonDigest({
		language,
		unitId: unit.id,
		sourceFingerprint: unit.sourceFingerprint,
		entry,
	});
}
