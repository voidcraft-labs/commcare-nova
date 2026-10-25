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
	/** The chosen cases the worker's phone lacks (Android), which the form
	 *  opens without their saved values and without a persistent case tile. */
	readonly blankCaseIds?: readonly string[];
}
export type EntryPointLaunchResult =
	| {
			readonly kind: "ready";
			readonly launch: EntryPointPreviewLaunch;
			/** The cases the launch claims for its worker (Web Apps' claim
			 *  frame), installed with the launch in one session write. */
			readonly claimCaseIds: readonly string[];
			/** The chosen cases the worker's phone lacks, which the form opens
			 *  without their saved values (Android). */
			readonly blankCaseIds: readonly string[];
	  }
	| { readonly kind: "refused"; readonly message: string };
