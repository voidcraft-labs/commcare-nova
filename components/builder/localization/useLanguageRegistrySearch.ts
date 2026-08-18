"use client";

// The one client seam onto the full language-name registry. The ~100 KB name
// catalog loads through lib/domain/languageRegistry/load so it stays out of
// the main bundle; this hook wraps that shared promise with mount-safe state
// and a retry for a failed chunk load. Pass `enabled: false` to keep the
// registry unloaded until a surface actually needs it (the Add-language
// dialog on open; a label the baked common set cannot resolve).

import { useCallback, useEffect, useState } from "react";
import {
	type LanguageRegistrySearch,
	loadLanguageRegistrySearch,
} from "@/lib/domain/languageRegistry/load";

export interface LanguageRegistrySearchState {
	readonly data: LanguageRegistrySearch | undefined;
	readonly failed: boolean;
	retry(): void;
}

export function useLanguageRegistrySearch(
	enabled: boolean,
): LanguageRegistrySearchState {
	const [data, setData] = useState<LanguageRegistrySearch>();
	const [failed, setFailed] = useState(false);
	// A failed chunk load parks the effect until retry clears the flag, so the
	// flag is both the error state and the re-run trigger.
	useEffect(() => {
		if (!enabled || failed || data !== undefined) return;
		let cancelled = false;
		loadLanguageRegistrySearch().then(
			(loaded) => {
				if (!cancelled) setData(loaded);
			},
			() => {
				if (!cancelled) setFailed(true);
			},
		);
		return () => {
			cancelled = true;
		};
	}, [enabled, failed, data]);
	const retry = useCallback(() => {
		setFailed(false);
	}, []);
	return { data, failed, retry };
}
