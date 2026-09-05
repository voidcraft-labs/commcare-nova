import type { Uuid } from "@/lib/domain";
import type { Location } from "@/lib/routing/types";
import type {
	PreviewCaseTarget,
	PreviewMenuCaseSelection,
} from "@/lib/session/types";

export interface EntryPointSelection {
	readonly moduleUuid: Uuid;
	readonly caseIds: readonly string[];
}
export interface EntryPointPreviewLaunch {
	readonly entryPointUuid: Uuid;
	readonly expectedSeq: number;
	readonly location: Location;
	readonly personaUuid?: string;
	readonly menuSelections: Readonly<Record<string, PreviewMenuCaseSelection>>;
	readonly formTarget?: PreviewCaseTarget;
	readonly ignoreDisplayConditions: boolean;
}
export type EntryPointLaunchResult =
	| { readonly kind: "ready"; readonly launch: EntryPointPreviewLaunch }
	| { readonly kind: "refused"; readonly message: string };
