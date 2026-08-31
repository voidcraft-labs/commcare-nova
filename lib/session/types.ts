/**
 * Builder state re-architecture — ephemeral session type definitions.
 *
 * Everything in this store lives only while the builder route is mounted
 * and is NEVER undoable. Separating from BlueprintDoc means there's no
 * risk of UI state bleeding into undo history and no need for a partialize
 * allow-list — the two stores have disjoint responsibilities.
 *
 * Types are organized by concern:
 *   - Preview/sidebar primitives
 *   - Generation lifecycle — stages, errors, partial scaffold
 */

import type { Uuid } from "@/lib/doc/types";
import type { MediaKind } from "@/lib/domain/multimedia";
import type { CaseDataByType } from "@/lib/preview/engine/formEngine";
import type { CaseDatabaseSnapshot } from "@/lib/preview/engine/xpathInstances";
import type { Location } from "@/lib/routing/types";

// ── Interaction primitives ───────────────────────────────────────────────

/**
 * Visibility + stash state for one sidebar column. `open` is current
 * visibility; `stashed` records whether we should reopen when leaving
 * preview mode. See `setPreviewing` in the store.
 */
export type SidebarState = { open: boolean; stashed: boolean | undefined };

/**
 * The case-loading form a running-app case list feeds, plus the case the
 * user picked for it — the preview-mode equivalent of CommCare passing the
 * selected case datum down the navigation stack.
 *
 * `formUuid` is the destination form: seeded when the user taps a
 * case-loading form in the module menu, or defaulted by the case list to
 * the module's first case-loading form when previewing the list directly.
 * `cases` is filled once the worker continues from Results, or by a form link
 * carrying the case value the next form opens with. Absence means the
 * destination is still waiting for Results; an empty array is an explicit
 * blank link and must never auto-select; one and many cases use the same
 * ordered collection. It is cleared on every preview-mode toggle.
 */
export interface PreviewCaseChoice {
	readonly caseId: string;
	readonly caseName?: string;
}

export interface PreviewCaseTarget {
	formUuid: Uuid;
	cases?: readonly PreviewCaseChoice[];
	/** Post-submit local-device world carried by a direct form link. A fresh
	 * restore may omit a case the device just closed, but the linked form still
	 * opens against the case and casedb state the submitting entry committed. */
	caseData?: CaseDataByType;
	caseDatabase?: CaseDatabaseSnapshot;
}

/**
 * The case currently being viewed in the running-app case list (the row a
 * user clicked into the detail/confirm, before continuing). Mirrors the
 * case-list's local selection so the breadcrumb can name it while you're
 * still on the list. Cleared when the selection clears (back to results) and
 * on every preview-mode toggle.
 */
export interface PreviewSelectedCase {
	caseId: string;
	caseName: string;
}

/**
 * A case selected for one module menu. This is the Preview equivalent of a
 * menu-scoped case datum: it makes that menu's case-loading forms runnable
 * and may be inherited by a child menu that works with the same case type.
 *
 * It is deliberately separate from `PreviewCaseTarget`. Selecting a case for
 * a parent menu does not imply that any particular form should open. The map
 * that stores these values is keyed by module uuid, so reorder and rename do
 * not change the selection's owner.
 */
export interface PreviewMenuCaseSelection {
	caseType: string;
	cases: readonly (PreviewCaseChoice & {
		/** Flattened selected-row values for case-scoped form visibility. */
		readonly caseProperties?: Readonly<Record<string, string>>;
	})[];
}

/** A case-type parent selection that must happen before a target module can
 * continue. The selecting module comes from case ancestry, independently of
 * the target module's structural menu parent. */
export interface PreviewParentCaseRequest {
	selectingModuleUuid: Uuid;
	/** Immediate next selector(s), ending with the originally requested module. */
	returnModuleUuids: readonly Uuid[];
	/** Exact running leaf that initiated the chain. Absent for an ordinary
	 * menu-to-module parent selection. */
	resumeLocation?: Location;
	/** Safe running-menu destination when the worker cancels the selector. */
	cancelLocation?: Location;
}

// ── Staged media uploads ─────────────────────────────────────────────────

/**
 * Lifecycle of one staged slot upload. `uploading` carries the byte-level
 * PUT progress (0..1); `error` holds the person-readable failure the slot
 * chip shows until the user dismisses or retries. There is no terminal
 * success state — a confirmed upload dispatches the gated attach and the
 * staged record is REMOVED (the doc's committed reference takes over as
 * the slot's truth).
 */
export type StagedUploadStatus =
	| { state: "uploading"; progress: number }
	| { state: "error"; message: string };

/**
 * One in-flight (or failed) slot upload, keyed in the store by the
 * carrier slot it will attach to. Ephemeral by design: the doc must never
 * hold a reference to an asset that isn't `ready`, so until the upload
 * confirms (the hash → signed-PUT → confirm flow flips the row to ready)
 * the only trace of it anywhere is this session record — cancel or
 * failure leaves the doc untouched because nothing was ever committed.
 */
export interface StagedUpload {
	filename: string;
	kind: MediaKind;
	status: StagedUploadStatus;
}

// ── Generation lifecycle ─────────────────────────────────────────────────

/** Cumulative milestones within a generation run. Live builds establish
 *  their foundation (app settings plus an optional data model), then build
 *  content through atomic module/form tools. `Fix` is HISTORICAL ONLY — a
 *  milestone of the retired validate-fix loop, kept so old runs still replay
 *  intelligibly. */
export enum GenerationStage {
	Foundation = "foundation",
	Build = "build",
	Fix = "fix",
}

/** Error state during generation — metadata, not a phase. The session
 *  stays in agent-active mode; this describes what went wrong. */
export type GenerationError = {
	message: string;
	severity: "recovering" | "failed";
} | null;

/** Status label for each generation stage, shown in builder progress surfaces. */
export const STAGE_LABELS: Record<GenerationStage, string> = {
	[GenerationStage.Foundation]: "Setting up app",
	[GenerationStage.Build]: "Building app content",
	[GenerationStage.Fix]: "Fixing validation errors",
};

/* The canonical session state type is `BuilderSessionState` in `store.ts`.
 * It includes both fields and actions. The types above are shared between
 * the store, hooks, and consumers. */
