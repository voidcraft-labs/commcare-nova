/** Invocation-local memory derived from current app text and accepted batches.
 * It does not publish values or replace the durable response ledger. */
import type {
	LocalizedTranslationUnit,
	LocalizedValue,
	TranslationUnit,
} from "@/lib/domain";
import {
	boundedGlossary,
	type EncodedTranslationUnit,
	encodeTranslatedValue,
	encodeTranslationUnit,
	type TranslationGlossaryEntry,
} from "./translator";

interface MemoryEntry {
	readonly unit: TranslationUnit;
	readonly value: LocalizedValue;
}

export class TranslationMemory {
	private readonly entries: MemoryEntry[] = [];

	constructor(current: readonly LocalizedTranslationUnit[]) {
		for (const unit of current) {
			if (
				unit.explicit !== undefined &&
				(unit.status === "ready" || unit.status === "needs-review") &&
				(unit.explicit.origin !== "copied" || unit.status === "ready")
			) {
				this.accept(unit, unit.explicit.value);
			}
		}
	}

	accept(unit: TranslationUnit, value: LocalizedValue): void {
		const encoded = encodeTranslationUnit(unit);
		const target = encodeTranslatedValue(encoded, value);
		if (target === undefined) return;
		// Existing values remain untouched. Do not propagate an old malformed
		// newline spelling or erased paragraph into another screen.
		if (
			encoded.sourceText.includes("\n") &&
			(!target.includes("\n") ||
				(encoded.sourceText.includes("\n\n") && !target.includes("\n\n")) ||
				(!encoded.sourceText.includes("\\n") && target.includes("\\n")))
		)
			return;
		this.entries.push({ unit, value });
	}

	glossary(
		batch: readonly EncodedTranslationUnit[],
	): readonly TranslationGlossaryEntry[] {
		const entries = this.entries.flatMap(({ unit, value }) => {
			const encoded = encodeTranslationUnit(unit);
			const target = encodeTranslatedValue(encoded, value);
			return target === undefined
				? []
				: [
						{
							source: encoded.sourceText,
							target,
							role: unit.role,
							breadcrumb: unit.breadcrumb,
							protectedTokens: encoded.protectedTokens,
						},
					];
		});
		return boundedGlossary(entries, batch);
	}
}
