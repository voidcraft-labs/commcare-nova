export * from "./builder-data-boundary";

import type * as Actions from "@/lib/preview/engine/caseDataBinding";
export const conversionImpactAction: typeof Actions.conversionImpactAction =
	async () => {
		throw new Error("Unexpected field conversion in native tree fixture");
	};
