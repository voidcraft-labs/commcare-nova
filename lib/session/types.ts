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
 * `caseId` / `caseName` are filled once the user picks a case and continues.
 * PreviewShell reads `caseId` to preload that form with the chosen case;
 * the breadcrumb reads `caseName` to name the bound case on the form. It's
 * cleared on every preview-mode toggle so each preview session starts caseless.
 */
export interface PreviewCaseTarget {
	formUuid: Uuid;
	caseId?: string;
	caseName?: string;
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

/** Progress stages within a generation run. Live builds move
 *  data model → structure → modules → forms (plan, then one
 *  `createModule` per planned module). `Validate` / `Fix` are
 *  HISTORICAL ONLY — stages of the retired validate-fix loop, kept so
 *  runs logged before its retirement still replay with their original
 *  progress states. */
export enum GenerationStage {
	DataModel = "data-model",
	Structure = "structure",
	Modules = "modules",
	Forms = "forms",
	Validate = "validate",
	Fix = "fix",
}

/** Error state during generation — metadata, not a phase. The session
 *  stays in agent-active mode; this describes what went wrong. */
export type GenerationError = {
	message: string;
	severity: "recovering" | "failed";
} | null;

/** Status label for each generation stage, shown in the Signal Grid panel. */
export const STAGE_LABELS: Record<GenerationStage, string> = {
	[GenerationStage.DataModel]: "Designing data model",
	[GenerationStage.Structure]: "Designing app structure",
	[GenerationStage.Modules]: "Building app content",
	[GenerationStage.Forms]: "Building app content",
	[GenerationStage.Validate]: "Validating blueprint",
	[GenerationStage.Fix]: "Fixing validation errors",
};

/* The canonical session state type is `BuilderSessionState` in `store.ts`.
 * It includes both fields and actions. The types above are shared between
 * the store, hooks, and consumers. */
