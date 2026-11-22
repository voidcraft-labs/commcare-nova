"use client";

import { createContext, useContext } from "react";
import {
	type PreviewSearchCatalog,
	type PreviewSearchFacts,
	type PreviewSearchTarget,
	resolvePreviewSearchFacts,
} from "./searchSettings";

export interface PreviewSearchConfiguration {
	catalog: PreviewSearchCatalog | null;
	target: PreviewSearchTarget | undefined;
	facts: PreviewSearchFacts;
	select: (target: PreviewSearchTarget | undefined) => void;
}

export const PreviewSearchConfigurationContext =
	createContext<PreviewSearchConfiguration>({
		catalog: null,
		target: undefined,
		facts: resolvePreviewSearchFacts(null),
		select: () => {},
	});

export function usePreviewSearchConfiguration() {
	return useContext(PreviewSearchConfigurationContext);
}
