import type * as Actions from "@/lib/preview/engine/openSearchRangesAction";

export const openSearchRangesAction: typeof Actions.openSearchRangesAction =
	async () => {
		throw new Error(
			"This browser fixture has no authenticated Search opening.",
		);
	};
