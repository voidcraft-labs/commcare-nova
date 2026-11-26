import type * as Actions from "@/lib/preview/engine/caseDataBinding";
import { row } from "./preview-cases-boundary";

export * from "./preview-cases-boundary";

/** What each Results read of a search sent: its answers and whether the
 *  menu's default search ran it. The page hands them to the journey. */
export const searchReads: {
	readonly inputValues: Readonly<Record<string, string>>;
	readonly defaultSearch: boolean;
}[] = [];

export const loadCasesAction: typeof Actions.loadCasesAction = async (args) => {
	if (args.inputValues !== undefined)
		searchReads.push({
			inputValues: { ...args.inputValues },
			defaultSearch: args.defaultSearch === true,
		});
	return { kind: "rows", rows: [row], constraintSource: "unconstrained" };
};
