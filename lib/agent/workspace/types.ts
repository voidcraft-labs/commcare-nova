/**
 * Tool Workspace vocabulary — the contract between shared tool bodies and the
 * workspace that owns their document.
 *
 * A workspace owns the current `BlueprintDoc` and the ordering of every tool
 * invocation against it. Tool bodies never receive a document argument and
 * never nominate a `prevDoc`: each invocation reads one immutable
 * `WorkspaceSnapshot` and may perform at most ONE workspace mutation
 * operation (`applyBatch`, `applyStages`, or `adoptAuthoritativeSnapshot`),
 * which the workspace verifies against the exact revision the invocation
 * read. Two host families implement the contract: the canonical host commits
 * every accepted batch through the canonical commit kernel immediately
 * (`canonicalWorkspace.ts`), and the private change-set host (a later unit)
 * stages admitted batches durably without touching canonical stores.
 */

import type { StageRequestReceipt } from "@/lib/agent/change-set/schemas";
import type { ConversionImpact } from "@/lib/case-store";
import type { ChatRunHolderCapability } from "@/lib/db/apps";
import type { AdmittedMutationBatch } from "@/lib/doc/mutationAdmission";
import type { BlueprintDoc, CasePropertyDataType } from "@/lib/domain";
import type { LookupTableId } from "@/lib/domain/lookupIds";
import type { LookupDefinitionsSnapshot } from "@/lib/lookup/types";
import type { OrganizationRevision } from "@/lib/organization/types";

/**
 * Opaque monotonic token proving which workspace snapshot a tool invocation
 * read. Callers only compare tokens; the numeric form is an implementation
 * detail of the in-process canonical workspace (a durable change-set
 * workspace persists its own monotonic revision).
 */
export type WorkspaceRevision = number;

/** One immutable view of the workspace's current document. */
export interface WorkspaceSnapshot {
	/** The current document. Reducers never mutate it in place — every
	 * accepted batch produces a NEW doc the workspace adopts. */
	readonly doc: BlueprintDoc;
	/** The revision this snapshot was taken at. A workspace write presented
	 * with a stale revision is a protocol error, never a silent retry. */
	readonly revision: WorkspaceRevision;
	/** The canonical `mutation_seq` the current document is KNOWN to be at —
	 * from the commit that produced it, the authorized reload, or an adopted
	 * authoritative proof — or `null` when no sequence accompanied it (a
	 * fresh chat run before its first batch, or an adoption that carried
	 * none). Never a stale sequence paired with a newer document. */
	readonly canonicalSeq: number | null;
	/** Project scope the workspace's document was authorized under. */
	readonly projectId: string;
	/** The change-set workspace's binding of its captured external context —
	 * the canonical digest of the accumulated external read-set entries the
	 * overlay was computed under. Absent on canonical snapshots: the
	 * canonical host fabricates none of the change-set extensions. */
	readonly externalContextDigest?: string;
}

/** Identity of one tool invocation against a workspace. */
export interface ToolInvocationIdentity {
	/** Stable per-call id — the AI SDK's `toolCallId` on the chat surface, a
	 * server-minted UUID on MCP. The durable change-set host keys request
	 * idempotency on it; the canonical host carries it for correlation. */
	readonly requestId: string;
	/** Workspace-allocated position in the serialized invocation order.
	 * Allocated synchronously at `invoke()` entry, before any await. */
	readonly invocationOrdinal: number;
	readonly toolName: string;
}

/**
 * Commit-time policy a tool may attach to its one workspace write.
 *
 * Most tools need only the fresh Blueprint rebase/re-verdict. A tool whose
 * success result projects an external app-scoped store names the exact
 * snapshot revision it used, so the authoritative writer either commits at
 * that same serialization point or rejects before persistence.
 */
export interface MutationApplicationPolicy {
	readonly expectedOrganizationRevision?: OrganizationRevision;
}

/**
 * Outcome of a workspace mutation operation. `ok: true` means the batch
 * passed the validity gate AND the host accepted it; `newDoc` is the doc the
 * tool continues against (the canonical host's committed doc, which may carry
 * a peer's concurrent edit merged in). `ok: false` means the gate rejected
 * the batch — nothing was written — and `error` is the person-to-person
 * message the tool returns in its `{ error }` envelope so the agent
 * self-corrects in its loop.
 */
export type WorkspaceMutationOutcome =
	| {
			readonly ok: true;
			readonly newDoc: BlueprintDoc;
			readonly mutations: AdmittedMutationBatch;
			/** Present exactly on the change-set host: the durable staging
			 * receipt this write committed (disposition, ordinal, handles,
			 * mutation digest, compact diagnostics). The canonical host never
			 * sets it — a canonical write's receipt is its commit. */
			readonly staged?: StageRequestReceipt;
	  }
	| { readonly ok: false; readonly error: string };

/** The impact lookup a surface injects at host construction —
 *  production passes the schema store's `conversionImpact` bound to
 *  the host's app; tests stub it. The result is the case store's
 *  own `ConversionImpact` (a type-only import — no storage code
 *  enters any graph), so a field added to the store's preview reaches
 *  every consumer or fails compile, never silently goes missing. */
export type ConversionImpactFn = (args: {
	caseType: string;
	property: string;
	toType: CasePropertyDataType;
}) => Promise<ConversionImpact>;

/**
 * The narrow context a shared tool body executes against.
 *
 * It exposes what tool bodies legitimately need for their domain work and
 * nothing else: identity/scope facts, the immutable snapshot, the Project
 * data readers, and the workspace's write operations. Persistence methods
 * (`recordMutations` and friends) live on the HOST behind the workspace and
 * are deliberately unreachable from here — a tool cannot bypass the gate or
 * write twice.
 */
export interface ToolInvocationContext {
	/** Current app id. Every CANONICAL tool operates against one app; a
	 * genesis change set has no app row yet, so the change-set host widens
	 * this to `null` there. Tools whose behavior genuinely needs the app's
	 * stored record narrow through `requireInvocationAppId`. */
	readonly appId: string | null;

	/** Project scope authoritatively admitted for this tool execution. */
	readonly projectId: string;

	/** Authenticated user id. Used by tools that need to resolve
	 * user-scoped resources (e.g., KMS-encrypted HQ credentials). */
	readonly userId: string;

	/** Per-run grouping id. Stamped on every event envelope. */
	readonly runId: string;

	/**
	 * Exact chat-run capability for authoritative non-blueprint side effects.
	 * Absent on MCP, whose request authorization is independent of the chat run
	 * window. A tool must never reconstruct this from public `runId` attribution.
	 */
	readonly chatRunHolder?: ChatRunHolderCapability;

	/** The immutable snapshot this invocation reads. `snapshot.doc` replaces
	 * the `doc` argument tools used to receive. */
	readonly snapshot: WorkspaceSnapshot;

	/** This invocation's identity in the workspace's serialized order. */
	readonly invocation: ToolInvocationIdentity;

	/**
	 * Exact rows-free Project data definitions. Production chat and MCP
	 * hosts bind this to the freshly authorized Project scope; synthetic
	 * carrier-free tests may omit it. Mutating helpers request the union of
	 * lookup identities present before and after a batch so additions, edits,
	 * and clears all receive the same external validation context.
	 */
	readonly lookupDefinitions?: (
		tableIds: readonly LookupTableId[],
	) => Promise<LookupDefinitionsSnapshot>;

	/** Complete rows-free Project data catalog for author-facing read tools. */
	readonly lookupCatalog?: () => Promise<LookupDefinitionsSnapshot>;

	/**
	 * Preview what retyping `(caseType, property)` to `toType` would do
	 * to this app's stored case rows — the consent gate `editField`
	 * consults before a failable conversion commits.
	 */
	conversionImpact(
		args: Parameters<ConversionImpactFn>[0],
	): Promise<ConversionImpact>;

	/**
	 * The one write path for a single-batch mutating tool: gate the batch
	 * through the validity verdict against this invocation's exact snapshot,
	 * then hand the prepared candidate to the workspace's host. At most one
	 * workspace mutation operation per invocation; a stale snapshot revision
	 * is a protocol error.
	 */
	applyBatch(args: {
		readonly mutations: unknown;
		readonly stage?: string;
		readonly policy?: MutationApplicationPolicy;
	}): Promise<WorkspaceMutationOutcome>;

	/**
	 * The multi-stage twin of {@link applyBatch}: gate the WHOLE staged
	 * sequence as one candidate, then persist it as ONE save that keeps the
	 * per-stage event tags. A rejection anywhere commits nothing.
	 */
	applyStages(args: {
		readonly stages: unknown;
	}): Promise<WorkspaceMutationOutcome>;

	/**
	 * Adopt a FRESHER authoritative snapshot the tool proved against the
	 * server (an authoritative zero-diff proof, e.g. an automation update
	 * whose requested state is already persisted). Counts as the invocation's
	 * one workspace mutation operation. The workspace advances its revision
	 * so later invocations build on the adopted state; nothing is committed.
	 */
	adoptAuthoritativeSnapshot(args: {
		readonly doc: BlueprintDoc;
		readonly canonicalSeq?: number;
	}): void;
}

export type ToolWorkspaceMode = "canonical" | "change-set";

/**
 * The workspace contract. `invoke` owns the full critical section: allocate
 * the invocation ordinal synchronously, serialize execution strictly by that
 * ordinal, build a per-invocation context carrying the exact current
 * snapshot/revision, run the tool body, apply at most one write against that
 * same revision, and advance (or reload) the workspace snapshot before the
 * next invocation runs.
 */
export interface ToolWorkspace {
	readonly mode: ToolWorkspaceMode;

	invoke<T>(args: {
		readonly toolName: string;
		/** Stable per-call id; minted by the workspace when the surface has
		 * none to supply. */
		readonly requestId?: string;
		execute(ctx: ToolInvocationContext): Promise<T>;
	}): Promise<T>;

	/** The workspace's current snapshot — read-only introspection for the
	 * surface wrappers (result shaping, drain-end reporting). */
	currentSnapshot(): WorkspaceSnapshot;
}
