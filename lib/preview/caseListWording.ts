/**
 * A case list's own wording as one platform draws it: the text an empty list
 * shows and the label of its several-case Continue. Web Apps draws both
 * (`PreviewPlatformRules.caseListDetailWording`); Android keeps its own
 * wording for each, so neither is returned there.
 */

import type { CaseListConfig } from "@/lib/domain";
import type { PreviewPlatformRules } from "./platform";

export interface CaseListOwnWording {
	/** Shown above an empty list's result. */
	readonly emptyText?: string;
	/** The several-case Continue's label. A single case's Continue keeps its own. */
	readonly continueText?: string;
}

export function caseListOwnWording(
	rules: Pick<PreviewPlatformRules, "caseListDetailWording">,
	config: Pick<CaseListConfig, "emptyText" | "selectButtonText"> | undefined,
): CaseListOwnWording {
	if (!rules.caseListDetailWording || config === undefined) return {};
	return {
		...(config.emptyText !== undefined && { emptyText: config.emptyText }),
		...(config.selectButtonText !== undefined && {
			continueText: config.selectButtonText,
		}),
	};
}
