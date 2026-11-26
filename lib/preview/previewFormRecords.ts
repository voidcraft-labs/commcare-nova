import type { Uuid } from "@/lib/domain";
import type {
	PreviewCaseListRegistrationEntry,
	PreviewCaseTarget,
	PreviewMenuCaseSelection,
	PreviewSearchState,
} from "@/lib/session/types";
import type { EngineController } from "./engine/engineController";
import type { PreviewDevice } from "./engine/previewDevice";

type SavedOpening = NonNullable<
	Awaited<ReturnType<EngineController["snapshotAndroidSave"]>>
>;

interface PreviewFormRecord {
	readonly entryKey: string;
	readonly appId: string;
	readonly formUuid: Uuid;
	readonly moduleUuid: Uuid;
	readonly name: string;
	readonly descriptor?: string;
	readonly savedAt: number;
}

export interface PreviewDraft extends PreviewFormRecord {
	readonly kind: "incomplete";
	readonly opened: SavedOpening;
	readonly device: PreviewDevice;
	readonly target: PreviewCaseTarget;
	readonly menuSelections: Readonly<Record<string, PreviewMenuCaseSelection>>;
	readonly searchStates: Readonly<Record<string, PreviewSearchState>>;
	readonly registration?: PreviewCaseListRegistrationEntry;
}

export type PreviewSavedForm =
	| PreviewDraft
	| (PreviewFormRecord & { readonly kind: "submitted" });
