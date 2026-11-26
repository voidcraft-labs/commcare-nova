import type { Uuid } from "@/lib/domain";
import type { Location } from "@/lib/routing/types";
import type { BuilderSessionState } from "@/lib/session/store";
import type {
	PreviewCaseTarget,
	PreviewMenuCaseSelection,
} from "@/lib/session/types";
import type { ReceiptRunTransition } from "./engine/formOpeningSnapshot";

export interface EntryPointSelection {
	readonly moduleUuid: Uuid;
	readonly caseIds: readonly string[];
}
export interface ListIconSource {
	readonly moduleUuid: Uuid;
	readonly columnUuid: Uuid;
}

export interface ListIconReturn {
	readonly location: Location;
	readonly state: Pick<
		BuilderSessionState,
		| "previewSessionId"
		| "previewMenuCaseSelections"
		| "previewSearchStates"
		| "previewCaseTarget"
		| "previewSelectedCase"
		| "previewParentCaseRequest"
		| "previewTaskContinuation"
		| "previewAfterSubmitStack"
		| "previewCaseListRegistrationEntry"
	>;
}

export interface EntryPointPreviewLaunch {
	readonly listIconReturn?: ListIconReturn;
	readonly receiptRunTransition?: ReceiptRunTransition;
	readonly entryPointUuid: Uuid;
	readonly expectedSeq: number;
	readonly location: Location;
	readonly personaUuid?: string;
	readonly menuSelections: Readonly<Record<string, PreviewMenuCaseSelection>>;
	readonly formTarget?: PreviewCaseTarget;
	readonly firstMenuSelections?: Readonly<
		Record<string, PreviewMenuCaseSelection>
	>;
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
			 *  frame), already written as claim rows by `launchEntryPointAction`
			 *  when it answers `ready`; empty on Android. */
			readonly claimCaseIds: readonly string[];
			/** The chosen cases the worker's phone lacks, which the form opens
			 *  without their saved values (Android). */
			readonly blankCaseIds: readonly string[];
	  }
	| { readonly kind: "refused"; readonly message: string };
