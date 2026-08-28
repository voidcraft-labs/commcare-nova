/**
 * EngineController — per-field reactive coordination layer.
 *
 * A plain TypeScript class (not a React hook) that mediates between the
 * blueprint store and the engine's Zustand runtime store. Lives on
 * BuilderEngine with the same lifecycle.
 *
 * ## Architecture
 *
 * Two Zustand stores with a unidirectional flow: blueprint → runtime.
 *
 * - **Blueprint store** (existing): normalized entities, Immer structural
 *   sharing, undo history. Source of truth for form structure.
 * - **Runtime store** (owned by this controller): UUID-keyed per-field
 *   computed state (visibility, required, validation, resolved labels).
 *   Ephemeral — never persisted, never in undo history.
 *
 * ## Per-field subscriptions
 *
 * One Zustand subscription per field on the blueprint store. Immer
 * structural sharing means `s.fields[uuid]` only gets a new reference
 * when THAT specific field was mutated.
 *
 * When a subscription fires, the controller classifies what changed:
 * - **Label/hint without refs, options, kind** → do nothing
 * - **Field kind change (retype)** → drop the stale value, re-init the field
 * - **Expression field** → rebuild DAG, re-evaluate that field + cascade
 * - **Label/hint with hashtag refs** → re-evaluate resolved labels only
 * - **Field ID rename** → already handled by the preceding batch-topology pass
 * - **Default value** → re-evaluate default + cascade
 *
 * ## Incremental, with one atomic topology boundary
 *
 * Ordinary field edits remain targeted. A committed batch that changes
 * authored paths is the exception: one whole-document subscription compares
 * the complete pre/post UUID→path projections and moves every retained value
 * in one atomic engine call before the per-field callbacks run. That boundary
 * is what makes two independent renames and cross-parent subtree moves safe;
 * processing either field against a half-updated path map loses the other.
 *
 * ## Domain types
 *
 * All traversal uses the normalized doc directly (`fields` / `fieldOrder`).
 * There is no conversion to a legacy nested-form shape. The engine walks
 * a rose-tree built at construction time — see `fieldTree.ts`.
 */
import { shallow } from "zustand/shallow";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { BlueprintDocStore } from "@/lib/doc/provider";
import type { BlueprintDocState } from "@/lib/doc/store";
import {
	type Field,
	type Form,
	fieldCaseWrite,
	isCaptureFieldKind,
	isContainer,
	type LanguageTag,
	materializableCaseTypes,
	projectLocalizedFields,
	resolveAppLanguage,
	type Uuid,
} from "@/lib/domain";
import { compilerBugMessage } from "@/lib/domain/predicate/errors";
import type { ProseTemplate } from "@/lib/domain/prose";
import type { XPathValue } from "../xpath/types";
import type { XPathRuntime } from "../xpath/workerClient";
import { deserializeXPathWorkerValue } from "../xpath/workerProjection";
import type { XPathWorkerInstances } from "../xpath/workerProtocol";
import type { SubmissionMutation } from "./caseDataBindingTypes";
import type { FieldTreeNode } from "./fieldTree";
import { buildFieldTree } from "./fieldTree";
import {
	type CaseDataByType,
	FormEngine,
	type FormEngineAsyncEvaluator,
	type FormEngineInput,
	type InvalidFieldTarget,
	type SectionPage,
} from "./formEngine";
import type { FormLinkAsyncEvaluator } from "./formLinkEvaluation";
import { type ResolvedPreviewIdentity, samePreviewIdentity } from "./identity";
import type { PreviewLookupData } from "./lookupEvaluation";
import { type FieldState, fieldStatesEqual } from "./types";
import type { CaseDatabaseSnapshot } from "./xpathInstances";

// ── Runtime store types ─────────────────────────────────────────────────

/** Per-field computed runtime state. Keyed by UUID, aligned with the
 *  blueprint store. Components subscribe via `useStore(store, s => s[uuid])`. */
export type RuntimeState = FieldState;

/** The Zustand store shape — flat map of UUID → RuntimeState. */
export type RuntimeStoreState = Record<string, RuntimeState>;

/** One submission mutation paired with the exact blueprint store revision its
 * reconciled engine consumed. Callers must retain this state identity through
 * their save barrier and derive the submitted blueprint from this snapshot. */
export interface EngineSubmissionSnapshot {
	readonly mutation: SubmissionMutation;
	readonly documentState: BlueprintDocState;
}

/** Reactive form-entry identity. Unlike `entryKey`'s imperative getter, this
 * store notifies FormScreen when a materially changed worker rotates the
 * controller without first causing a parent React render. */
export interface EngineEntryState {
	readonly entryKey: string | undefined;
	readonly formUuid: Uuid | undefined;
	readonly revision: number;
	/** True only after the active engine has finished its initial worker pass,
	 * published runtime state, and installed its document subscriptions. */
	readonly ready: boolean;
	/** True while the current entry/revision is still evaluating in its worker. */
	readonly settling: boolean;
	/** True while a repeat add/remove owns an indivisible topology revision.
	 * Interactive controls stay inert so an event cannot retain a positional
	 * path across compaction. */
	readonly topologySettling: boolean;
	/** A failed runtime is an internal valid-by-construction invariant breach,
	 * never a draft/document state. The raw exception deliberately stays out of
	 * this observable UI contract. */
	readonly fault: EngineRuntimeFault | undefined;
	/** A casedb-dependent form requested before its device snapshot is ready.
	 * This is resource readiness, not an invalid-document fault. */
	readonly caseDatabaseWait:
		| { readonly formUuid: Uuid; readonly status: "loading" | "error" }
		| undefined;
}

export type CaseDatabaseControllerState =
	| { readonly required: false }
	| { readonly required: true; readonly status: "loading" | "error" }
	| {
			readonly required: true;
			readonly status: "ready";
			readonly snapshot: CaseDatabaseSnapshot;
	  };

export type EngineFaultOperation =
	| "activate"
	| "rebuild"
	| "document-update"
	| "value-change"
	| "validation"
	| "repeat-change"
	| "reset"
	| "submission";

export interface EngineRuntimeFault {
	readonly formUuid: Uuid;
	readonly operation: EngineFaultOperation;
}

export type EngineFaultReporter = (
	fault: EngineRuntimeFault,
	error: unknown,
) => void;

export interface RepeatCompactionEvent {
	readonly entryKey: string;
	readonly removedPrefix: string;
	readonly moves: ReadonlyArray<{
		readonly fromPrefix: string;
		readonly toPrefix: string;
	}>;
}

export interface AuthoredCapturePathMigrationEvent {
	readonly entryKey: string;
	readonly moves: ReadonlyArray<
		| {
				readonly kind: "retained";
				readonly fieldUuid: string;
				readonly previous: {
					readonly pathTemplate: string;
					readonly segmentKeys: readonly string[];
					readonly captureKind?: string;
				};
				/**
				 * A retained non-capture field still carries its post-change path
				 * projection with `captureKind` omitted. The explicit variant keeps
				 * a malformed missing `current` from being mistaken for deletion.
				 */
				readonly current: {
					readonly pathTemplate: string;
					readonly segmentKeys: readonly string[];
					readonly captureKind?: string;
				};
		  }
		| {
				readonly kind: "deleted";
				readonly fieldUuid: string;
				readonly previous: {
					readonly pathTemplate: string;
					readonly segmentKeys: readonly string[];
					readonly captureKind: string;
				};
		  }
	>;
}

/** Stable fallback for UUIDs that don't exist. Frozen so Zustand selectors
 *  always return the same reference — no spurious re-renders. */
export const DEFAULT_RUNTIME_STATE: RuntimeState = Object.freeze({
	path: "",
	value: "",
	visible: true,
	required: false,
	valid: true,
	touched: false,
});

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * Assemble the `FormEngineInput` for a given form from the current doc state.
 *
 * The engine takes domain types directly: the flat `fields` map, the
 * adjacency list in `fieldOrder`, and the form entity. There is no
 * intermediate wire-format representation — the engine's internal walkers
 * build a rose tree from these maps and operate on domain `Field` entities
 * throughout.
 */
function buildEngineInput(
	state: BlueprintDocState,
	formUuid: Uuid,
	language: LanguageTag | null,
): FormEngineInput | undefined {
	const form = state.forms[formUuid];
	if (!form) return undefined;
	return {
		form: form as Form,
		formUuid,
		...(language === null
			? {}
			: { language: resolveAppLanguage(state.localization, language) }),
		fields:
			language === null
				? (state.fields as unknown as Record<string, Field>)
				: projectLocalizedFields(
						state,
						resolveAppLanguage(state.localization, language),
					),
		fieldOrder: state.fieldOrder as unknown as Record<string, Uuid[]>,
		caseTypes: materializableCaseTypes(state),
		userProperties: state.userProperties,
	};
}

/**
 * Locate the module that owns a given form by scanning `formOrder`.
 *
 * The blueprint doc stores forms and modules as separate entity maps with
 * `formOrder[moduleUuid]: Uuid[]` acting as the parent→children adjacency
 * list. There is no back-pointer on the form entity itself (see
 * `lib/domain/forms.ts`), so to resolve "which module owns this form" we
 * walk `moduleOrder` and check each module's child list. The controller
 * only needs this answer to fetch the owning module's `caseType` for
 * engine construction / metadata subscriptions — called at most a handful
 * of times per form activation. The loop bounds are tiny (N_modules *
 * avg_forms_per_module) and complexity stays well inside the budget.
 */
function findModuleForForm(
	state: Pick<BlueprintDocState, "moduleOrder" | "formOrder">,
	formUuid: Uuid,
): Uuid | undefined {
	for (const moduleUuid of state.moduleOrder) {
		if (state.formOrder[moduleUuid]?.includes(formUuid)) {
			return moduleUuid;
		}
	}
	return undefined;
}

/**
 * Build bidirectional UUID ↔ XForm path maps by walking the field tree.
 *
 * Paths are the ones the engine uses internally: `/data/<id>` at the root,
 * `/data/<group>/<child>` for groups, `/data/<repeat>[0]/<child>` for
 * repeats. We only materialise the `[0]` template here — per-instance paths
 * are derived on demand when a repeat value is read.
 */
function buildPathMaps(
	tree: FieldTreeNode[],
	prefix = "/data",
): {
	uuidToPath: Map<string, string>;
	pathToUuid: Map<string, string>;
	uuidToSegmentKeys: Map<string, readonly string[]>;
} {
	const uuidToPath = new Map<string, string>();
	const pathToUuid = new Map<string, string>();
	const uuidToSegmentKeys = new Map<string, readonly string[]>();
	function walk(
		nodes: FieldTreeNode[],
		pfx: string,
		ancestorUuids: readonly string[],
	) {
		for (const node of nodes) {
			const f = node.field;
			const path = `${pfx}/${f.id}`;
			uuidToPath.set(f.uuid, path);
			pathToUuid.set(path, f.uuid);
			const segmentKeys = ["$data", ...ancestorUuids, f.uuid];
			uuidToSegmentKeys.set(f.uuid, segmentKeys);
			if (node.children) {
				const childPrefix = f.kind === "repeat" ? `${path}[0]` : path;
				walk(node.children, childPrefix, [...ancestorUuids, f.uuid]);
			}
		}
	}
	walk(tree, prefix, []);
	return { uuidToPath, pathToUuid, uuidToSegmentKeys };
}

/** Recursively collect all field UUIDs belonging to a form. */
function collectFormUuids(
	rootUuid: Uuid,
	fieldOrder: Readonly<Record<string, readonly Uuid[]>>,
): Uuid[] {
	const result: Uuid[] = [];
	function walk(parentId: Uuid) {
		const children = fieldOrder[parentId];
		if (!children) return;
		for (const uuid of children) {
			result.push(uuid);
			walk(uuid);
		}
	}
	walk(rootUuid);
	return result;
}

/** Classify what changed between two domain `Field` entity versions. */
function classifyChange(
	current: Field,
	previous: Field,
):
	| "none"
	| "expression"
	| "label_refs"
	| "id_rename"
	| "default_value"
	| "options_source"
	| "kind_change" {
	// Checked FIRST — before the id-first short-circuit and the
	// expression/label fall-through. A `convertField` keeps the field's uuid
	// and id, so a same-id retype otherwise classifies as `none`/`expression`
	// and the stale value survives under the new kind. A combined retype+rename
	// (kind AND id both differ) also routes here — `onKindChanged` rebuilds the
	// path maps, so it subsumes `onIdRenamed`'s work.
	if (current.kind !== previous.kind) return "kind_change";

	if (current.id !== previous.id) return "id_rename";

	// Expression-carrying keys live on most but not all variants. Reading
	// through the variants' common intersection keeps the access type-safe
	// without switching on `kind` for every property. The AST-stored slots
	// (`calculate` / `relevant` / `required` / `validate` / `default_value`)
	// compare by REFERENCE: an untouched slot keeps its object identity
	// through Immer, and any commit installs a freshly parsed value — so
	// identity diff ≡ "this slot was written", which is exactly the rebuild
	// trigger.
	const cur = current as Field & {
		calculate?: unknown;
		relevant?: unknown;
		required?: unknown;
		validate?: unknown;
		default_value?: unknown;
		label?: ProseTemplate;
		hint?: ProseTemplate;
	};
	const prev = previous as Field & {
		calculate?: unknown;
		relevant?: unknown;
		required?: unknown;
		validate?: unknown;
		default_value?: unknown;
		label?: ProseTemplate;
		hint?: ProseTemplate;
	};

	if (
		cur.calculate !== prev.calculate ||
		cur.relevant !== prev.relevant ||
		cur.required !== prev.required ||
		cur.validate !== prev.validate
	) {
		return "expression";
	}

	// Every select owns exactly one required options source. Reference compare,
	// same rationale as the AST slots above: a commit installs a fresh object,
	// so identity diff ≡ "this source was written". Checked BEFORE
	// default_value: a single commit writing both slots must reach the
	// options_source dispatch (which also reapplies the default) or the choices
	// list would keep the previous source.
	if (
		(current.kind === "single_select" || current.kind === "multi_select") &&
		(previous.kind === "single_select" || previous.kind === "multi_select") &&
		current.optionsSource !== previous.optionsSource
	) {
		return "options_source";
	}

	if (cur.default_value !== prev.default_value) return "default_value";

	const labelChanged = cur.label !== prev.label;
	const hintChanged = cur.hint !== prev.hint;
	if (labelChanged || hintChanged) {
		/* A reference is a typed part, not a `#` in the text. Scanning for the
		 * character both threw — a `ProseTemplate` has no `.includes` — and
		 * asked the wrong question: a label reading "Ward #3" carries no
		 * reference, while one carrying a `field-ref` part may contain no `#`
		 * at all. */
		const hasRefs = [cur.label, prev.label, cur.hint, prev.hint].some(
			(template) =>
				template?.parts.some((part) => part.kind !== "text") ?? false,
		);
		if (hasRefs) return "label_refs";
	}

	return "none";
}

/**
 * True only when a publication can change the active form's UUID-to-path
 * projection. Most Builder writes replace one field entity while preserving
 * its identity, kind, and every active adjacency-list reference; those writes
 * cannot move an answer and should not rebuild two complete field trees just
 * to rediscover that fact.
 */
function activeFormTopologyChanged(
	current: BlueprintDocState,
	previous: BlueprintDocState,
	formUuid: Uuid,
	trackedUuids: ReadonlySet<string>,
): boolean {
	if (current.fieldOrder[formUuid] !== previous.fieldOrder[formUuid]) {
		return true;
	}
	for (const uuid of trackedUuids) {
		if (current.fieldOrder[uuid] !== previous.fieldOrder[uuid]) return true;
		const currentField = current.fields[uuid];
		const previousField = previous.fields[uuid];
		if (currentField === previousField) continue;
		if (
			currentField === undefined ||
			previousField === undefined ||
			currentField.id !== previousField.id ||
			currentField.kind !== previousField.kind
		) {
			return true;
		}
	}
	return false;
}

/**
 * The worker consumes only the active form projection. Case-write targets,
 * plain authored copy, and other Builder-only field metadata are intentionally
 * absent from that runtime contract. Keep the check conservative around every
 * shared input, then use the same per-field classifier as the synchronous
 * subscriptions for the one part that can change independently.
 */
function activeFormRuntimeChanged(
	current: BlueprintDocState,
	previous: BlueprintDocState,
	formUuid: Uuid,
	trackedUuids: ReadonlySet<string>,
	presentationLanguage: LanguageTag | null,
): boolean {
	if (
		activeFormTopologyChanged(current, previous, formUuid, trackedUuids) ||
		current.forms[formUuid] !== previous.forms[formUuid] ||
		current.caseTypes !== previous.caseTypes ||
		current.userProperties !== previous.userProperties ||
		(presentationLanguage !== null &&
			current.localization !== previous.localization)
	) {
		return true;
	}

	const currentModuleUuid = findModuleForForm(current, formUuid);
	const previousModuleUuid = findModuleForForm(previous, formUuid);
	if (
		currentModuleUuid !== previousModuleUuid ||
		(currentModuleUuid !== undefined &&
			current.modules[currentModuleUuid]?.caseType !==
				previous.modules[currentModuleUuid]?.caseType)
	) {
		return true;
	}

	for (const uuid of trackedUuids) {
		const currentField = current.fields[uuid];
		const previousField = previous.fields[uuid];
		if (currentField === previousField) continue;
		if (
			currentField === undefined ||
			previousField === undefined ||
			classifyChange(currentField as Field, previousField as Field) !== "none"
		) {
			return true;
		}
	}
	return false;
}

// ── EngineController ────────────────────────────────────────────────────

export class EngineController {
	/** UUID-keyed Zustand runtime store. Components subscribe via
	 *  `useStore(controller.store, s => s[uuid])`. */
	readonly store: StoreApi<RuntimeStoreState>;
	/** Form-level lifecycle store; updated only when entry identity changes. */
	readonly entryStore: StoreApi<EngineEntryState>;

	/** The computation engine — DataInstance, TriggerDag, expression evaluation. */
	private engine: FormEngine | undefined;

	/** Bidirectional UUID ↔ XForm path mapping. */
	private uuidToPath = new Map<string, string>();
	private pathToUuid = new Map<string, string>();

	/** UUID of the form this controller is currently activated for. Undefined
	 *  between `deactivate()` and the next `activateForm()`. Subscription
	 *  callbacks and the `currentEngineInput()` helper read this to re-derive
	 *  the owning module + form state from the latest doc snapshot. */
	private activeFormUuid: Uuid | undefined;
	private activeCaseData: CaseDataByType | undefined;

	/**
	 * Identifies THIS form entry to the attachment lane.
	 *
	 * One activation is one entry, so the key is minted in `activateForm`
	 * and dropped in `deactivate`. It is preserved across same-entry engine
	 * rebuilds and is the exact idempotency/reservation scope the atomic
	 * submission intent claims.
	 *
	 * The lifecycle below is load-bearing and worth being explicit about,
	 * because a future change to it silently changes the attachment
	 * contract. **This controller does not resume a form.** `activateForm`
	 * begins by calling `deactivate`, which resets the whole runtime store,
	 * and nothing persists answers to storage — so leaving a form and
	 * returning starts a new entry with a new key. The preview owner
	 * best-effort deletes the previous entry's staged attachments at that
	 * boundary; the scheduled row sweep and staging TTL collect anything a
	 * dropped request leaves behind.
	 *
	 * If preview ever gains resume, it must carry the entry key forward
	 * with the answers or every resumed attachment is orphaned. Resume is
	 * also the point at which a signature question first becomes able to
	 * hold an answer it cannot draw: the real runtime shows a blank pad
	 * over a live signature (`entries.js::SignatureEntry`'s `afterRender`
	 * sets `signatureData = null` and reads nothing back), so the faithful
	 * behavior then is to leave the pad blank — not to helpfully restore
	 * it. Today no such state exists, which is why nothing here simulates
	 * one.
	 */
	private currentEntryKey: string | undefined;
	/** Fatal runtime state for the selected form. This is containment for a
	 * supposedly unreachable compiler/runtime parity breach, not support for an
	 * invalid persisted expression. */
	private runtimeFault: EngineRuntimeFault | undefined;
	private faultReporter: EngineFaultReporter | undefined;
	private requestedActivation:
		| {
				readonly formUuid: Uuid;
				readonly caseData?: CaseDataByType;
				readonly caseDatabase?: CaseDatabaseSnapshot;
		  }
		| undefined;
	private repeatCompactionListeners = new Set<
		(event: RepeatCompactionEvent) => void
	>();
	private authoredCapturePathMigrationListeners = new Set<
		(event: AuthoredCapturePathMigrationEvent) => void
	>();

	/** Field UUIDs with active per-field subscriptions. */
	private trackedUuids = new Set<string>();

	/** Cleanup functions for all subscriptions. */
	private unsubscribers: (() => void)[] = [];

	/** Reference to the doc store — installed by SyncBridge when the
	 *  BlueprintDocProvider mounts, cleared on unmount. */
	private docStore: BlueprintDocStore | undefined;
	/** Exact Zustand revision the active engine has fully reconciled. This is
	 * the submission-side bridge between ephemeral answers and their owning
	 * blueprint; a newer publication makes the pair unusable until reconciliation
	 * installs that newer state here. */
	private reconciledDocumentState: BlueprintDocState | undefined;

	/** The resolved identity `#user/*` and future identity-backed reads
	 *  evaluate against. Session-scoped — installed by the provider from
	 *  the client auth session and deliberately NOT cleared by
	 *  `deactivate()`, which is a per-form lifecycle. */
	private previewIdentity: ResolvedPreviewIdentity | null = null;
	/** A selected persona disappeared. Never fall through to anonymous form
	 * execution while the user is deciding which identity to use instead. */
	private previewIdentityBlocked = false;

	/** The builder session's lookup fixture snapshot. Session-scoped like
	 *  the identity — engines CAPTURE it at activation (per-form-session
	 *  choice stability), so a refreshed snapshot ordinarily reaches the
	 *  NEXT activation; an arrival rebuilds the active engine only while
	 *  its capture fails to COVER the form's carriers (cold load, or a
	 *  valid rebind the capture predates), with touched values restored. */
	private lookupData: PreviewLookupData | null = null;
	/** Device-case snapshot captured by XPath secondary-instance evaluation.
	 * Like lookup fixtures, a material arrival rebuilds one coherent form world
	 * rather than changing answers underneath a live engine. */
	/** Commit-phase activation gate. The casedb provider installs this in a
	 * layout effect before descendant passive activation; render never mutates
	 * it. `caseDatabaseState` is the last post-commit reconciliation. */
	private caseDatabaseGate: CaseDatabaseControllerState = { required: false };
	private caseDatabaseState: CaseDatabaseControllerState = { required: false };
	private caseDatabaseSnapshot: CaseDatabaseSnapshot | null = null;
	private mountedCaseDatabaseSnapshot: CaseDatabaseSnapshot | null | undefined;
	/** Selected worker-content language for presentation-bearing engine input.
	 * `null` keeps standalone/non-Builder controller consumers canonical. */
	private presentationLanguage: LanguageTag | null = null;
	private readonly xpathRuntime: XPathRuntime | undefined;
	private runtimeRevision = 0;
	private lifecycleGeneration = 0;
	private currentAbort: AbortController | undefined;
	private pendingWork: Promise<void> = Promise.resolve();
	/** Topology revisions are indivisible within one live entry. Browser events
	 * arriving after an add/remove queue behind it instead of retiring work
	 * after the repeat shape has already changed but before defaults/cascade and
	 * attachment compaction have finished. Entry retirement may still discard
	 * the whole engine. */
	private atomicRevisionsPending = 0;
	/** Raw edits staged synchronously but not yet reconciled by a successful
	 * worker revision. A newer edit can retire older work without losing paths. */
	private pendingValuePaths = new Set<string>();
	/** Fields whose untouched default must be evaluated by the worker after a
	 * live document edit. UUID identity survives same-batch path changes; a
	 * retired revision leaves the entry queued for its successor. */
	private pendingDefaultFieldUuids = new Set<Uuid>();
	private entryReady = false;
	private settling = false;

	constructor(xpathRuntime?: XPathRuntime) {
		this.xpathRuntime = xpathRuntime;
		this.store = createStore<RuntimeStoreState>(() => ({}));
		this.entryStore = createStore<EngineEntryState>(() => ({
			entryKey: undefined,
			formUuid: undefined,
			revision: 0,
			ready: false,
			settling: false,
			topologySettling: false,
			fault: undefined,
			caseDatabaseWait: undefined,
		}));
	}

	private caseDatabaseWait(): EngineEntryState["caseDatabaseWait"] {
		if (
			this.requestedActivation === undefined ||
			this.requestedActivation.caseDatabase !== undefined ||
			!this.caseDatabaseGate.required ||
			this.caseDatabaseGate.status === "ready"
		) {
			return undefined;
		}
		return {
			formUuid: this.requestedActivation.formUuid,
			status: this.caseDatabaseGate.status,
		};
	}

	private caseDatabaseOverrideFor(
		formUuid: Uuid,
	): CaseDatabaseSnapshot | undefined {
		return this.requestedActivation?.formUuid === formUuid
			? this.requestedActivation.caseDatabase
			: undefined;
	}

	private publishEntryState(): void {
		const current = this.entryStore.getState();
		const caseDatabaseWait = this.caseDatabaseWait();
		if (
			current.entryKey === this.currentEntryKey &&
			current.formUuid === this.activeFormUuid &&
			current.ready === this.entryReady &&
			current.settling === this.settling &&
			current.topologySettling === this.atomicRevisionsPending > 0 &&
			current.fault === this.runtimeFault &&
			current.caseDatabaseWait?.formUuid === caseDatabaseWait?.formUuid &&
			current.caseDatabaseWait?.status === caseDatabaseWait?.status
		) {
			return;
		}
		this.entryStore.setState(
			{
				entryKey: this.currentEntryKey,
				formUuid: this.activeFormUuid,
				revision: current.revision + 1,
				ready: this.entryReady,
				settling: this.settling,
				topologySettling: this.atomicRevisionsPending > 0,
				fault: this.runtimeFault,
				caseDatabaseWait,
			},
			true,
		);
	}

	/** Install the browser telemetry seam. Kept injectable so the engine stays
	 * independent of React/Sentry and unit tests can assert exact one-shot
	 * reporting without mocking global transports. */
	setFaultReporter(reporter: EngineFaultReporter | null): void {
		this.faultReporter = reporter ?? undefined;
	}

	private recordRuntimeFault(
		operation: EngineFaultOperation,
		formUuid: Uuid,
		error: unknown,
	): void {
		if (this.runtimeFault !== undefined) return;
		this.requestedActivation = undefined;
		this.clearActiveForm();
		const fault = { formUuid, operation } as const;
		this.runtimeFault = fault;
		this.publishEntryState();
		try {
			this.faultReporter?.(fault, error);
		} catch {
			/* Telemetry is best effort. A reporting transport or test seam must
			 * never re-open the runtime exception this boundary just contained. */
		}
	}

	private contain<T>(
		operation: EngineFaultOperation,
		formUuid: Uuid,
		fallback: T,
		run: () => T,
	): T {
		try {
			return run();
		} catch (error) {
			this.recordRuntimeFault(operation, formUuid, error);
			return fallback;
		}
	}

	private retireRuntimeScope(): void {
		this.lifecycleGeneration += 1;
		this.currentAbort?.abort();
		this.currentAbort = undefined;
		if (this.currentEntryKey !== undefined) {
			this.xpathRuntime?.retire(this.currentEntryKey);
		}
		this.settling = false;
	}

	private evaluatorFor(
		engine: FormEngine,
		entryKey: string,
		revision: number,
		generation: number,
		signal: AbortSignal,
	): FormEngineAsyncEvaluator {
		const world = engine.createWorkerWorld(`form-${revision}`);
		const evaluate = async (
			source: string,
			path: string,
			resultMode: "scalar" | "nodeset-values-or-scalar" = "scalar",
			stateOverrides?: Parameters<FormEngineAsyncEvaluator>[3],
		) => {
			if (this.xpathRuntime === undefined) {
				throw new Error("The browser XPath runtime is unavailable.");
			}
			const result = await this.xpathRuntime.request(
				{
					entryKey,
					revision,
					profile: "form",
					source,
					instances: engine.workerInstances(
						source,
						path,
						world,
						stateOverrides,
					),
					resultMode,
				},
				{ signal },
			);
			if (
				generation !== this.lifecycleGeneration ||
				entryKey !== this.currentEntryKey ||
				revision !== this.runtimeRevision
			) {
				throw new Error("The XPath evaluation revision was retired.");
			}
			if (!result.ok) {
				throw new Error(
					`The XPath worker refused evaluation (${result.error.code}).`,
				);
			}
			if (
				resultMode === "nodeset-values-or-scalar" &&
				result.nodesetValues !== undefined
			) {
				return {
					kind: "nodeset-values" as const,
					values: result.nodesetValues,
				};
			}
			return deserializeXPathWorkerValue(result.value);
		};
		return evaluate as FormEngineAsyncEvaluator;
	}

	/** Reconcile raw input writes before every successor operation. A blur,
	 * validation, repeat click, or submit is allowed to supersede an older
	 * worker revision, but it must inherit and settle the values that revision
	 * was responsible for. */
	private async reconcilePendingValuePaths(
		revision: number,
		generation: number,
		signal: AbortSignal,
	): Promise<void> {
		if (this.pendingValuePaths.size === 0) return;
		const engine = this.engine;
		const entryKey = this.currentEntryKey;
		if (engine === undefined || entryKey === undefined) return;
		const changedPaths = [...this.pendingValuePaths];
		await engine.settleValueChangesAsync(
			changedPaths,
			this.evaluatorFor(engine, entryKey, revision, generation, signal),
		);
		if (
			engine !== this.engine ||
			entryKey !== this.currentEntryKey ||
			generation !== this.lifecycleGeneration ||
			revision !== this.runtimeRevision
		) {
			throw new Error("The XPath evaluation revision was retired.");
		}
		for (const path of changedPaths) this.pendingValuePaths.delete(path);
		this.syncAllPathsSelectively();
	}

	private executeAsyncRevision<T>(
		operation: EngineFaultOperation,
		formUuid: Uuid,
		run: (
			revision: number,
			generation: number,
			signal: AbortSignal,
		) => Promise<T>,
		fallback: T,
		waitFor: Promise<void> = Promise.resolve(),
		prepare?: () => void,
	): Promise<T> {
		const revision = ++this.runtimeRevision;
		const generation = this.lifecycleGeneration;
		this.currentAbort?.abort();
		const controller = new AbortController();
		this.currentAbort = controller;
		this.settling = true;
		this.publishEntryState();
		return waitFor
			.catch(() => undefined)
			.then(async () => {
				if (
					generation !== this.lifecycleGeneration ||
					revision !== this.runtimeRevision
				) {
					return fallback;
				}
				try {
					prepare?.();
					await this.reconcilePendingValuePaths(
						revision,
						generation,
						controller.signal,
					);
					return await run(revision, generation, controller.signal);
				} catch (error) {
					if (
						generation === this.lifecycleGeneration &&
						revision === this.runtimeRevision
					) {
						this.recordRuntimeFault(operation, formUuid, error);
					}
					return fallback;
				} finally {
					if (
						generation === this.lifecycleGeneration &&
						revision === this.runtimeRevision
					) {
						this.settling = false;
						this.currentAbort = undefined;
						this.publishEntryState();
					}
				}
			});
	}

	private runAsyncRevision<T>(
		operation: EngineFaultOperation,
		formUuid: Uuid,
		run: (
			revision: number,
			generation: number,
			signal: AbortSignal,
		) => Promise<T>,
		fallback: T,
		options: { readonly atomic?: boolean; readonly prepare?: () => void } = {},
	): Promise<T> {
		const deferReservation = this.atomicRevisionsPending > 0;
		const scheduledGeneration = this.lifecycleGeneration;
		if (options.atomic) {
			this.atomicRevisionsPending += 1;
			this.publishEntryState();
		}
		const previous = this.pendingWork.catch(() => undefined);
		const task = deferReservation
			? previous.then(() => {
					if (scheduledGeneration !== this.lifecycleGeneration) return fallback;
					return this.executeAsyncRevision(
						operation,
						formUuid,
						run,
						fallback,
						undefined,
						options.prepare,
					);
				})
			: this.executeAsyncRevision(
					operation,
					formUuid,
					run,
					fallback,
					previous,
					options.prepare,
				);
		const settled = task.finally(() => {
			if (options.atomic) {
				this.atomicRevisionsPending -= 1;
				this.publishEntryState();
			}
		});
		this.pendingWork = settled.then(
			() => undefined,
			() => undefined,
		);
		return settled;
	}

	/** Wait for the controller-owned queue. The optional identity fence makes a
	 * submit refuse when navigation rotated the entry while it waited. */
	async awaitSettled(entryKey?: string): Promise<boolean> {
		/* A document publication can schedule a rebuild and then, from a later
		 * subscriber in the same publication, append reconciliation behind it.
		 * Await until the queue identity itself is stable; awaiting only the
		 * promise captured on entry can return while that later revision is active. */
		for (;;) {
			const pending = this.pendingWork;
			await pending;
			if (pending === this.pendingWork) break;
		}
		return (
			this.runtimeFault === undefined &&
			!this.settling &&
			(entryKey === undefined || entryKey === this.currentEntryKey)
		);
	}

	/** Form-level repeat ownership subscriber. The engine stays UI-agnostic;
	 * FormScreen binds this event to the attachment coordinator. */
	subscribeRepeatCompaction(
		listener: (event: RepeatCompactionEvent) => void,
	): () => void {
		this.repeatCompactionListeners.add(listener);
		return () => this.repeatCompactionListeners.delete(listener);
	}

	/** Form-level authored-path ownership subscriber. Stable field UUIDs make
	 * this independent of which capture controls are currently mounted. */
	subscribeAuthoredCapturePathMigration(
		listener: (event: AuthoredCapturePathMigrationEvent) => void,
	): () => void {
		this.authoredCapturePathMigrationListeners.add(listener);
		return () => this.authoredCapturePathMigrationListeners.delete(listener);
	}

	private publishAuthoredCapturePathMigration(
		moves: AuthoredCapturePathMigrationEvent["moves"],
	): void {
		if (this.currentEntryKey === undefined || moves.length === 0) return;
		const event = { entryKey: this.currentEntryKey, moves };
		for (const listener of this.authoredCapturePathMigrationListeners) {
			listener(event);
		}
	}

	/** Connect to the doc store. Called by SyncBridge when the provider mounts. */
	setDocStore(docStore: BlueprintDocStore | null): void {
		this.docStore = docStore ?? undefined;
		if (docStore === null) this.reconciledDocumentState = undefined;
	}

	/**
	 * Install the resolved preview identity. A materially different
	 * identity rebuilds any active engine so every computed value agrees
	 * on one evaluation world — identity is engine-lifetime state, not an
	 * incremental input. A re-derived-but-identical identity (session
	 * refetches mint new object references) is a no-op, so entered
	 * preview values survive it.
	 *
	 * Values typed under the ANONYMOUS world survive an arriving
	 * identity: the cold session resolving after form activation is the
	 * same human finishing their answers, not a persona switch, so the
	 * rebuild restores user-touched values through the engine's shared
	 * snapshot/restore path (identity-backed reads still re-evaluate).
	 * Replacing a non-null identity discards — a sign-out or a different
	 * worker is a different evaluation world, and restoring would leak
	 * one worker's entries into another's session.
	 */
	setPreviewIdentity(identity: ResolvedPreviewIdentity | null): void {
		if (samePreviewIdentity(this.previewIdentity, identity)) {
			this.previewIdentity = identity;
			return;
		}
		const coldIdentityArrival =
			this.previewIdentity === null && identity !== null;
		this.previewIdentity = identity;
		const formUuid = this.activeFormUuid;
		if (formUuid !== undefined) {
			if (coldIdentityArrival) {
				if (this.xpathRuntime) {
					this.rebuildActiveFormAsync(formUuid, this.activeCaseData).catch(
						() => undefined,
					);
				} else this.rebuildActiveForm(formUuid, this.activeCaseData);
			} else {
				// A different concrete worker (or sign-out) is a new answer world,
				// not a same-entry rebuild. Rotate the capture namespace with it.
				if (this.xpathRuntime) {
					this.activateFormAsync(formUuid, this.activeCaseData).catch(
						() => undefined,
					);
				} else this.activateForm(formUuid, this.activeCaseData);
			}
		}
	}

	/** Suspend form execution while a selected persona cannot be resolved. */
	setPreviewIdentityBlocked(blocked: boolean): void {
		if (this.previewIdentityBlocked === blocked) return;
		this.previewIdentityBlocked = blocked;
		if (blocked) this.deactivate();
	}

	/**
	 * Install the builder session's lookup fixture snapshot. See the
	 * field's contract: capture-at-activation, first-arrival rebuild
	 * only. A `null` install (Project scope reset) never tears an active
	 * engine down here — the reset boundary deactivates separately.
	 */
	setLookupData(data: PreviewLookupData | null): void {
		this.lookupData = data;
		if (data === null) return;
		const formUuid = this.activeFormUuid;
		if (formUuid === undefined || this.engine === undefined) return;
		/* Rebuild only when the active engine's CAPTURED snapshot fails to
		 * cover the form's carriers — the cold-load first arrival and the
		 * valid mid-session rebind to a table/column the capture predates.
		 * A covered engine keeps its capture (per-form-session choice
		 * stability); touched values restore through the shared snapshot
		 * contract. */
		if (this.engine.lookupDataCoversForm()) return;
		if (this.xpathRuntime) {
			this.rebuildActiveFormAsync(formUuid, this.activeCaseData).catch(
				() => undefined,
			);
		} else this.rebuildActiveForm(formUuid, this.activeCaseData);
	}

	/** Reconcile the device-case resource state after commit. A required form never runs
	 * against a guessed empty casedb: its activation request waits here until a
	 * real snapshot arrives. Snapshot identity remains the material-version
	 * signal for same-entry rebuilds. */
	setCaseDatabaseState(state: CaseDatabaseControllerState): void {
		const previous = this.caseDatabaseState;
		let unchanged = !previous.required && !state.required;
		if (previous.required && state.required) {
			unchanged =
				previous.status === state.status &&
				(previous.status !== "ready" ||
					(state.status === "ready" && previous.snapshot === state.snapshot));
		}
		if (unchanged) return;

		this.caseDatabaseState = state;
		this.caseDatabaseGate = state;
		this.caseDatabaseSnapshot =
			state.required && state.status === "ready" ? state.snapshot : null;
		/* A direct post-submit form link carries the submitting entry's patched
		 * local-device snapshot. Provider refreshes still update the base snapshot
		 * for the next ordinary entry, but cannot replace or clear this entry's
		 * explicit world (notably after closing its carried case). */
		if (this.requestedActivation?.caseDatabase !== undefined) {
			this.publishEntryState();
			return;
		}

		if (state.required && state.status !== "ready") {
			if (this.activeFormUuid !== undefined) this.clearActiveForm();
			this.publishEntryState();
			return;
		}

		const requested = this.requestedActivation;
		if (requested === undefined) {
			this.publishEntryState();
			return;
		}
		if (
			this.activeFormUuid === requested.formUuid &&
			this.engine !== undefined
		) {
			if (this.mountedCaseDatabaseSnapshot === this.caseDatabaseSnapshot) {
				this.publishEntryState();
				return;
			}
			if (this.xpathRuntime) {
				this.rebuildActiveFormAsync(
					requested.formUuid,
					requested.caseData,
				).catch(() => undefined);
			} else this.rebuildActiveForm(requested.formUuid, requested.caseData);
			return;
		}
		if (this.xpathRuntime) {
			this.activateFormAsync(
				requested.formUuid,
				requested.caseData,
				requested.caseDatabase,
			).catch(() => undefined);
		} else {
			this.activateForm(
				requested.formUuid,
				requested.caseData,
				requested.caseDatabase,
			);
		}
	}

	/**
	 * Install the selected worker-content language. A live form rebuilds in the
	 * same entry so dynamic prose, option labels, and validation messages use
	 * the same projection as the rendered field without rotating attachments or
	 * discarding touched answers.
	 */
	setPresentationLanguage(language: LanguageTag | null): void {
		if (this.presentationLanguage === language) return;
		this.presentationLanguage = language;
		const formUuid = this.activeFormUuid;
		if (formUuid !== undefined) {
			if (this.xpathRuntime) {
				this.rebuildActiveFormAsync(formUuid, this.activeCaseData, true).catch(
					() => undefined,
				);
			} else this.rebuildActiveForm(formUuid, this.activeCaseData, true);
		}
	}

	// ── Lifecycle ────────────────────────────────────────────────────

	/**
	 * Activate the engine for a specific form. Builds the computation engine,
	 * UUID↔path maps, initial runtime state, and per-field subscriptions.
	 *
	 * The form is identified by UUID — the controller resolves the owning
	 * module internally via `findModuleForForm` so callers never have to
	 * thread positional indices through React state.
	 */
	activateForm(
		formUuid: Uuid,
		caseData?: CaseDataByType,
		caseDatabase?: CaseDatabaseSnapshot,
	): void {
		if (this.previewIdentityBlocked) {
			this.deactivate();
			return;
		}
		this.requestedActivation = { formUuid, caseData, caseDatabase };
		this.runtimeFault = undefined;
		if (
			caseDatabase === undefined &&
			this.caseDatabaseGate.required &&
			this.caseDatabaseGate.status !== "ready"
		) {
			this.clearActiveForm();
			this.publishEntryState();
			return;
		}
		this.contain("activate", formUuid, undefined, () => {
			this.mountForm(formUuid, caseData, crypto.randomUUID(), caseDatabase);
		});
	}

	/** Production activation path. The entry is not published as runnable until
	 * its worker has materialized repeat topology, defaults, and the initial
	 * cascade for one fenced revision. */
	async activateFormAsync(
		formUuid: Uuid,
		caseData?: CaseDataByType,
		caseDatabase?: CaseDatabaseSnapshot,
	): Promise<boolean> {
		if (this.xpathRuntime === undefined) {
			this.activateForm(formUuid, caseData, caseDatabase);
			return this.engine !== undefined;
		}
		if (this.previewIdentityBlocked) {
			this.deactivate();
			return false;
		}
		this.requestedActivation = { formUuid, caseData, caseDatabase };
		this.runtimeFault = undefined;
		if (
			caseDatabase === undefined &&
			this.caseDatabaseGate.required &&
			this.caseDatabaseGate.status !== "ready"
		) {
			this.clearActiveForm();
			this.publishEntryState();
			return false;
		}
		return this.mountFormAsync(
			formUuid,
			caseData,
			crypto.randomUUID(),
			undefined,
			caseDatabase,
		);
	}

	async rebuildActiveFormAsync(
		formUuid: Uuid,
		caseData?: CaseDataByType,
		preserveAllValues = false,
	): Promise<boolean> {
		if (this.xpathRuntime === undefined) {
			this.rebuildActiveForm(formUuid, caseData, preserveAllValues);
			return this.engine !== undefined;
		}
		const entryKey =
			this.activeFormUuid === formUuid && this.currentEntryKey !== undefined
				? this.currentEntryKey
				: crypto.randomUUID();
		const values = this.engine?.getValueSnapshot({
			includeAllValues: preserveAllValues,
		});
		const repeatCounts = this.engine?.getRepeatCountSnapshot();
		const repeatInstanceKeys = this.engine?.getRepeatInstanceKeySnapshot();
		return this.mountFormAsync(
			formUuid,
			caseData,
			entryKey,
			{
				values,
				repeatCounts,
				repeatInstanceKeys,
				preserveAllValues,
			},
			this.caseDatabaseOverrideFor(formUuid),
		);
	}

	private async mountFormAsync(
		formUuid: Uuid,
		caseData: CaseDataByType | undefined,
		entryKey: string,
		restore?: {
			readonly values?: ReturnType<FormEngine["getValueSnapshot"]>;
			readonly repeatCounts?: ReadonlyMap<string, number>;
			readonly repeatInstanceKeys?: ReadonlyMap<string, readonly string[]>;
			readonly preserveAllValues: boolean;
		},
		caseDatabaseOverride?: CaseDatabaseSnapshot,
	): Promise<boolean> {
		this.clearActiveForm();
		if (this.previewIdentityBlocked || !this.docStore) {
			this.publishEntryState();
			return false;
		}
		/* Async initialization deliberately yields to the browser while the XPath
		 * worker settles defaults and relevance. Watch the WHOLE document during
		 * that gap: the field-specific subscriptions cannot be installed until the
		 * engine has a tree, and building them later from this captured state would
		 * otherwise miss an edit that landed while `initializeAsync` was awaiting.
		 * Once the first revision settles, rebuild from the latest document before
		 * publishing it. The ordinary subscriptions cover the tiny hand-off after
		 * this temporary watch is removed. */
		const docStore = this.docStore;
		const state = docStore.getState();
		let documentChangedDuringActivation = false;
		let watchingActivation = true;
		const unsubscribeActivation = docStore.subscribe((current) => {
			/* Zustand iterates a live listener Set. A subscription installed from
			 * inside another listener can receive the publication already being
			 * dispatched; that publication is exactly the captured `state`, not a
			 * later edit, and must not trigger an endless rebuild loop. */
			if (current !== state) documentChangedDuringActivation = true;
		});
		const stopWatchingActivation = (): void => {
			if (!watchingActivation) return;
			watchingActivation = false;
			unsubscribeActivation();
		};
		const moduleUuid = findModuleForForm(state, formUuid);
		const input = buildEngineInput(state, formUuid, this.presentationLanguage);
		if (
			!state.forms[formUuid] ||
			moduleUuid === undefined ||
			input === undefined
		) {
			stopWatchingActivation();
			this.publishEntryState();
			return false;
		}
		this.activeFormUuid = formUuid;
		this.activeCaseData = caseData;
		this.currentEntryKey = entryKey;
		const caseDatabase = caseDatabaseOverride ?? this.caseDatabaseSnapshot;
		const engine = new FormEngine(
			input,
			state.modules[moduleUuid]?.caseType,
			caseData,
			this.previewIdentity,
			this.lookupData,
			caseDatabase,
			{ stagedAsync: true },
		);
		this.engine = engine;
		this.mountedCaseDatabaseSnapshot = caseDatabase;
		let ready: boolean;
		try {
			ready = await this.runAsyncRevision(
				"activate",
				formUuid,
				async (revision, generation, signal) => {
					const evaluator = this.evaluatorFor(
						engine,
						entryKey,
						revision,
						generation,
						signal,
					);
					await engine.initializeAsync(evaluator);
					if (restore?.repeatCounts !== undefined) {
						await engine.restoreRepeatCountSnapshotAsync(
							restore.repeatCounts,
							evaluator,
						);
					}
					if (restore?.repeatInstanceKeys !== undefined) {
						engine.restoreRepeatInstanceKeySnapshot(restore.repeatInstanceKeys);
					}
					if (restore?.values !== undefined) {
						engine.restoreValues(restore.values, {
							restoreAllValues: restore.preserveAllValues,
						});
						await engine.settleAsync(evaluator);
					}
					if (entryKey !== this.currentEntryKey || engine !== this.engine)
						return false;
					const maps = buildPathMaps(engine.getFieldTree());
					this.uuidToPath = maps.uuidToPath;
					this.pathToUuid = maps.pathToUuid;
					this.syncAllToStore();
					const uuids = collectFormUuids(formUuid, state.fieldOrder);
					this.setupAuthoredPathTopologySubscription(formUuid);
					this.setupPerFieldSubscriptions(uuids);
					this.setupStructuralSubscription(formUuid);
					this.setupMetadataSubscription();
					this.setupUserPropertySubscription();
					this.setupLocalizationSubscription();
					this.setupAsyncReconciliationSubscription(formUuid);
					if (
						!documentChangedDuringActivation &&
						docStore.getState() === state
					) {
						this.reconciledDocumentState = state;
						this.entryReady = true;
					}
					return true;
				},
				false,
			);
		} finally {
			stopWatchingActivation();
		}
		if (
			documentChangedDuringActivation &&
			entryKey === this.currentEntryKey &&
			engine === this.engine
		) {
			return this.mountFormAsync(
				formUuid,
				caseData,
				entryKey,
				restore,
				caseDatabaseOverride,
			);
		}
		if (ready && entryKey === this.currentEntryKey && engine === this.engine) {
			this.reconciledDocumentState = state;
		}
		this.publishEntryState();
		return ready;
	}

	/**
	 * Rebuild the same live entry after cold identity/lookup/case context arrives.
	 * The answer world may be reconstructed, but the upload namespace must not
	 * rotate underneath already staged captures.
	 */
	rebuildActiveForm(
		formUuid: Uuid,
		caseData?: CaseDataByType,
		preserveAllValues = false,
	): void {
		if (this.runtimeFault?.formUuid === formUuid) return;
		this.runtimeFault = undefined;
		this.contain("rebuild", formUuid, undefined, () => {
			const entryKey =
				this.activeFormUuid === formUuid && this.currentEntryKey !== undefined
					? this.currentEntryKey
					: crypto.randomUUID();
			const values = this.engine?.getValueSnapshot({
				includeAllValues: preserveAllValues,
			});
			const repeatCounts = this.engine?.getRepeatCountSnapshot();
			const repeatInstanceKeys = this.engine?.getRepeatInstanceKeySnapshot();
			this.mountForm(
				formUuid,
				caseData,
				entryKey,
				this.caseDatabaseOverrideFor(formUuid),
			);
			if (repeatCounts !== undefined) {
				this.engine?.restoreRepeatCountSnapshot(repeatCounts);
			}
			if (repeatInstanceKeys !== undefined) {
				this.engine?.restoreRepeatInstanceKeySnapshot(repeatInstanceKeys);
			}
			if (values !== undefined && this.engine !== undefined) {
				this.engine.restoreValues(values, {
					restoreAllValues: preserveAllValues,
				});
				this.syncAllToStore();
			}
		});
	}

	private mountForm(
		formUuid: Uuid,
		caseData: CaseDataByType | undefined,
		entryKey: string,
		caseDatabaseOverride?: CaseDatabaseSnapshot,
	): void {
		this.clearActiveForm();
		if (this.previewIdentityBlocked || !this.docStore) {
			this.publishEntryState();
			return;
		}

		const s = this.docStore.getState();
		// Bail out silently if the form no longer exists — the hook uses an
		// effect-based lifecycle so a transient "form deleted during
		// re-render" window is normal; the next effect tick reactivates
		// against the new active form.
		if (!s.forms[formUuid]) {
			this.publishEntryState();
			return;
		}
		const moduleUuid = findModuleForForm(s, formUuid);
		if (!moduleUuid) {
			this.publishEntryState();
			return;
		}

		/* Build the FormEngine input from the doc store */
		const input = buildEngineInput(s, formUuid, this.presentationLanguage);
		if (!input) {
			this.publishEntryState();
			return;
		}

		this.activeFormUuid = formUuid;
		this.activeCaseData = caseData;
		// The Web Crypto GLOBAL, not `node:crypto`. This controller runs in
		// the browser, where importing `node:crypto` resolves to a shim whose
		// `randomUUID` is undefined — so the import form throws here at
		// runtime while typechecking and every node/jsdom test passes, both
		// of which have a real `crypto`. `lib/doc/scaffolds.ts` mints uuids
		// the same way for the same reason.
		this.currentEntryKey = entryKey;

		const mod = s.modules[moduleUuid];
		const caseDatabase = caseDatabaseOverride ?? this.caseDatabaseSnapshot;
		this.engine = new FormEngine(
			input,
			mod?.caseType,
			caseData,
			this.previewIdentity,
			this.lookupData,
			caseDatabase,
		);
		this.mountedCaseDatabaseSnapshot = caseDatabase;

		/* Build UUID ↔ path mapping from the engine's walked tree */
		const tree = this.engine.getFieldTree();
		const maps = buildPathMaps(tree);
		this.uuidToPath = maps.uuidToPath;
		this.pathToUuid = maps.pathToUuid;

		/* Sync initial engine state to the UUID-keyed runtime store */
		this.syncAllToStore();

		/* Set up subscriptions */
		const uuids = collectFormUuids(formUuid, s.fieldOrder);
		this.setupAuthoredPathTopologySubscription(formUuid);
		this.setupPerFieldSubscriptions(uuids);
		this.setupStructuralSubscription(formUuid);
		this.setupMetadataSubscription();
		this.setupUserPropertySubscription();
		this.setupLocalizationSubscription();
		this.setupAsyncReconciliationSubscription(formUuid);
		this.reconciledDocumentState = s;
		this.entryReady = true;
		this.publishEntryState();
	}

	private clearActiveForm(): void {
		this.retireRuntimeScope();
		this.entryReady = false;
		this.pendingValuePaths.clear();
		this.pendingDefaultFieldUuids.clear();
		for (const unsub of this.unsubscribers) unsub();
		this.unsubscribers = [];
		this.trackedUuids.clear();
		this.engine = undefined;
		this.reconciledDocumentState = undefined;
		this.mountedCaseDatabaseSnapshot = undefined;
		this.uuidToPath.clear();
		this.pathToUuid.clear();
		this.activeFormUuid = undefined;
		this.activeCaseData = undefined;
		this.currentEntryKey = undefined;
		this.store.setState({}, true);
	}

	/** Clean up all subscriptions and reset state. */
	deactivate(): void {
		this.requestedActivation = undefined;
		this.clearActiveForm();
		this.runtimeFault = undefined;
		this.publishEntryState();
	}

	/** Re-arm the provider-owned worker runtime after an effect replay. */
	resume(): void {
		this.xpathRuntime?.resume();
	}

	/**
	 * Re-armable provider cleanup. It clears form subscriptions and terminates
	 * workers, but unlike dispose() it can survive React Strict Mode replay.
	 */
	suspend(): void {
		this.deactivate();
		this.xpathRuntime?.suspend();
	}

	/** Terminal boundary for non-React owners that will never reuse this object. */
	dispose(): void {
		this.deactivate();
		this.xpathRuntime?.dispose();
	}

	/** This form entry's attachment scope, or `undefined` when no form is
	 *  active. Capture widgets stage against it; submission reconciles it. */
	get entryKey(): string | undefined {
		return this.currentEntryKey;
	}

	/** The form identity paired with `entryKey`, for queued-mutation fencing. */
	get formUuid(): Uuid | undefined {
		return this.activeFormUuid;
	}

	/** Exact worker identity captured by the live engine entry. Attachment
	 * continuations compare this imperative value after every await. */
	get previewIdentitySnapshot(): ResolvedPreviewIdentity | null {
		return this.previewIdentity;
	}

	get previewLookupDataSnapshot(): PreviewLookupData | null {
		return this.engine?.lookupDataSnapshot() ?? null;
	}

	/** Device casedb captured by the active form entry. After submit, callers
	 * patch this snapshot with the committed rows instead of performing a new
	 * restore, which could legitimately omit a just-closed or reassigned case. */
	get previewCaseDatabaseSnapshot(): CaseDatabaseSnapshot {
		return (
			this.mountedCaseDatabaseSnapshot ?? {
				rows: [],
				indices: [],
			}
		);
	}

	/**
	 * End the current answer world and synchronously mount a fresh entry for
	 * the same form, case preload, lookup capture, and preview identity.
	 */
	restartActiveEntry(): string | undefined {
		const formUuid = this.activeFormUuid;
		if (formUuid === undefined) return undefined;
		return this.contain("rebuild", formUuid, undefined, () => {
			this.mountForm(
				formUuid,
				this.activeCaseData,
				crypto.randomUUID(),
				this.caseDatabaseOverrideFor(formUuid),
			);
			return this.currentEntryKey;
		});
	}

	async restartActiveEntryAsync(): Promise<string | undefined> {
		const formUuid = this.activeFormUuid;
		if (formUuid === undefined) return undefined;
		const entryKey = crypto.randomUUID();
		return (await this.mountFormAsync(
			formUuid,
			this.activeCaseData,
			entryKey,
			undefined,
			this.caseDatabaseOverrideFor(formUuid),
		))
			? entryKey
			: undefined;
	}

	// ── Public actions (called by components) ────────────────────────

	/** Set a test-mode value and cascade through the DAG. Resolves the
	 *  uuid to its template path — edit-mode rows have no instance
	 *  dimension. Interactive rows call `setValueAt` with their concrete
	 *  path instead. */
	onValueChange(uuid: string, value: string): void {
		const path = this.uuidToPath.get(uuid);
		if (!path) return;
		this.setValueAt(path, value);
	}

	/** Set a value at a concrete engine path — the interactive renderer's
	 *  entry point, where repeat children carry per-instance indexed paths
	 *  the uuid map can't address. */
	setValueAt(path: string, value: string): void {
		if (!this.engine) return;
		const formUuid = this.activeFormUuid;
		if (formUuid === undefined) return;
		this.contain("value-change", formUuid, undefined, () => {
			this.engine?.setValue(path, value);
			const affectedPaths = [
				path,
				...(this.engine?.getAffectedPaths(path) ?? []),
			];
			this.syncPathsToStore(affectedPaths);
		});
	}

	async onValueChangeAsync(uuid: string, value: string): Promise<boolean> {
		const path = this.uuidToPath.get(uuid);
		return path === undefined ? false : this.setValueAtAsync(path, value);
	}

	async setValueAtAsync(path: string, value: string): Promise<boolean> {
		const engine = this.engine;
		const formUuid = this.activeFormUuid;
		const entryKey = this.currentEntryKey;
		if (!engine || !formUuid || !entryKey || this.xpathRuntime === undefined) {
			this.setValueAt(path, value);
			return this.engine !== undefined;
		}
		if (!this.entryReady) return false;
		/* Concrete repeat paths are positional. Never queue one across an
		 * indivisible add/remove: compaction may make the same text address a
		 * different instance. FormScreen also makes controls inert for this
		 * window; this imperative guard closes the event/render race. */
		if (this.atomicRevisionsPending > 0) return false;
		const stageValue = () => {
			if (engine !== this.engine || entryKey !== this.currentEntryKey) return;
			engine.setValue(path, value);
			this.pendingValuePaths.add(path);
			this.syncPathsToStore([path]);
		};
		stageValue();
		return this.runAsyncRevision(
			"value-change",
			formUuid,
			async () => engine === this.engine && entryKey === this.currentEntryKey,
			false,
		);
	}

	/** Mark a field as touched (on blur). Uuid-resolved template path —
	 *  see `onValueChange`. */
	onTouch(uuid: string): void {
		const path = this.uuidToPath.get(uuid);
		if (!path) return;
		this.touchAt(path);
	}

	/** Mark the field at a concrete engine path as touched (on blur). */
	touchAt(path: string): void {
		if (!this.engine) return;
		const formUuid = this.activeFormUuid;
		if (formUuid === undefined) return;
		this.contain("validation", formUuid, undefined, () => {
			this.engine?.touch(path);
			this.syncPathsToStore([path]);
		});
	}

	async onTouchAsync(uuid: string): Promise<boolean> {
		const path = this.uuidToPath.get(uuid);
		return path === undefined ? false : this.touchAtAsync(path);
	}

	async touchAtAsync(path: string): Promise<boolean> {
		const engine = this.engine;
		const formUuid = this.activeFormUuid;
		const entryKey = this.currentEntryKey;
		if (!engine || !formUuid || !entryKey || this.xpathRuntime === undefined) {
			this.touchAt(path);
			return this.engine !== undefined;
		}
		if (this.atomicRevisionsPending > 0) return false;
		return this.runAsyncRevision(
			"validation",
			formUuid,
			async (revision, generation, signal) => {
				await engine.touchAsync(
					path,
					this.evaluatorFor(engine, entryKey, revision, generation, signal),
				);
				if (engine !== this.engine || entryKey !== this.currentEntryKey)
					return false;
				this.syncPathsToStore([path]);
				return true;
			},
			false,
		);
	}

	/** Validate all visible fields. Returns true if valid. */
	validateAll(): boolean {
		if (!this.engine) {
			return (
				this.runtimeFault === undefined && this.caseDatabaseWait() === undefined
			);
		}
		const formUuid = this.activeFormUuid;
		if (formUuid === undefined) return false;
		return this.contain("validation", formUuid, false, () => {
			const result = this.engine?.validateAll() ?? false;
			/* validateAll touches many fields (marks touched, runs validation).
			 * Sync all paths but only write those that actually changed. */
			this.syncAllPathsSelectively();
			return result;
		});
	}

	async validateAllAsync(): Promise<boolean> {
		await this.pendingWork;
		const engine = this.engine;
		const formUuid = this.activeFormUuid;
		const entryKey = this.currentEntryKey;
		if (!engine || !formUuid || !entryKey || this.xpathRuntime === undefined) {
			return this.validateAll();
		}
		return this.runAsyncRevision(
			"validation",
			formUuid,
			async (revision, generation, signal) => {
				const valid = await engine.validateAllAsync(
					this.evaluatorFor(engine, entryKey, revision, generation, signal),
				);
				if (engine !== this.engine || entryKey !== this.currentEntryKey)
					return false;
				this.syncAllPathsSelectively();
				return valid;
			},
			false,
		);
	}

	/** First invalid runtime question plus the collapsed ancestors that hide
	 *  it, across the form or on one page (`withinSection`). */
	firstInvalidFieldTarget(opts?: {
		readonly withinSection?: Uuid;
	}): InvalidFieldTarget | undefined {
		return this.engine?.firstInvalidFieldTarget(opts);
	}

	/** The form's pages (root sections) with their current visibility. */
	sectionPages(): ReadonlyArray<SectionPage> {
		return this.engine?.sectionPages() ?? [];
	}

	/** Validate the visible questions on one page. Returns true if valid. */
	validateSection(sectionUuid: Uuid): boolean {
		if (!this.engine) {
			return (
				this.runtimeFault === undefined && this.caseDatabaseWait() === undefined
			);
		}
		const formUuid = this.activeFormUuid;
		if (formUuid === undefined) return false;
		return this.contain("validation", formUuid, false, () => {
			const result = this.engine?.validateSection(sectionUuid) ?? false;
			this.syncAllPathsSelectively();
			return result;
		});
	}

	async validateSectionAsync(sectionUuid: Uuid): Promise<boolean> {
		await this.pendingWork;
		const engine = this.engine;
		const formUuid = this.activeFormUuid;
		const entryKey = this.currentEntryKey;
		if (!engine || !formUuid || !entryKey || this.xpathRuntime === undefined) {
			return this.validateSection(sectionUuid);
		}
		return this.runAsyncRevision(
			"validation",
			formUuid,
			async (revision, generation, signal) => {
				const valid = await engine.validateSectionAsync(
					sectionUuid,
					this.evaluatorFor(engine, entryKey, revision, generation, signal),
				);
				if (engine !== this.engine || entryKey !== this.currentEntryKey)
					return false;
				this.syncAllPathsSelectively();
				return valid;
			},
			false,
		);
	}

	/** Resolve a concrete question to the collapsed containers that hide it. */
	fieldTarget(
		instancePath: string,
		fieldUuid?: string,
	): InvalidFieldTarget | undefined {
		return this.engine?.fieldTarget(instancePath, fieldUuid);
	}

	/** Submission-time disposition of one concrete capture path. */
	attachmentPathDisposition(path: string): "active" | "dormant" | "removed" {
		return this.engine?.attachmentPathDisposition(path) ?? "removed";
	}

	/** Full reset — reinitialize all runtime state. */
	reset(): void {
		if (!this.engine) return;
		const formUuid = this.activeFormUuid;
		if (formUuid === undefined) return;
		this.contain("reset", formUuid, undefined, () => {
			this.engine?.reset();
			this.syncAllToStore();
		});
	}

	async resetAsync(): Promise<boolean> {
		const formUuid = this.activeFormUuid;
		const entryKey = this.currentEntryKey;
		if (formUuid === undefined || entryKey === undefined) return false;
		return this.mountFormAsync(
			formUuid,
			this.activeCaseData,
			entryKey,
			undefined,
			this.caseDatabaseOverrideFor(formUuid),
		);
	}

	/** Clear touched/validation state (for mode switches). */
	resetValidation(): void {
		if (!this.engine) return;
		const formUuid = this.activeFormUuid;
		if (formUuid === undefined) return;
		this.contain("reset", formUuid, undefined, () => {
			this.engine?.resetValidation();
			this.syncAllPathsSelectively();
		});
	}

	/** Get the repeat count for a repeat group. */
	getRepeatCount(uuid: string): number {
		if (!this.engine) return 1;
		const path = this.uuidToPath.get(uuid);
		if (!path) return 1;
		return this.engine.getRepeatCount(path);
	}

	/** Stable render identity for a repeat instance even when indices compact. */
	getRepeatInstanceKey(uuid: string, index: number, atPath?: string): string {
		const path = atPath ?? this.uuidToPath.get(uuid);
		if (!this.engine || !path) return `${uuid}:${index}`;
		return this.engine.getRepeatInstanceKey(path, index);
	}

	/**
	 * Add a repeat instance. Returns the new index, or 0 (the template
	 * slot) when the call is rejected.
	 *
	 * Only `user_controlled` repeats accept add/remove at runtime —
	 * `count_bound` and `query_bound` repeats freeze their cardinality
	 * at form load (JavaRosa spec). The preview UI hides the Add button
	 * for those modes (`RepeatField.tsx` gates on `isUserControlled`),
	 * but this method is the authoritative second gate: tests, console
	 * invocations, replay, and any future caller can't mutate
	 * cardinality on a non-user-controlled repeat. Pattern matches the
	 * "UI is first defense, reducer is authoritative" rule documented
	 * for `convertField`.
	 */
	addRepeat(uuid: string, atPath?: string): number {
		if (!this.engine) return 0;
		if (!this.isUserControlledRepeat(uuid)) return 0;
		const path = atPath ?? this.uuidToPath.get(uuid);
		if (!path) return 0;
		const formUuid = this.activeFormUuid;
		if (formUuid === undefined) return 0;
		return this.contain("repeat-change", formUuid, 0, () => {
			const result = this.engine?.addRepeat(path) ?? 0;
			// Cardinality changes touch the repeat's own `repeatCount`, the
			// new instance's per-path states, and any outside dependents —
			// the selective sweep diff-writes only entries that actually
			// changed, so untouched rows keep their references.
			this.syncAllPathsSelectively();
			return result;
		});
	}

	async addRepeatAsync(uuid: string, atPath?: string): Promise<number> {
		const engine = this.engine;
		const formUuid = this.activeFormUuid;
		const entryKey = this.currentEntryKey;
		if (
			!engine ||
			!formUuid ||
			!entryKey ||
			!this.isUserControlledRepeat(uuid)
		) {
			return 0;
		}
		const path = atPath ?? this.uuidToPath.get(uuid);
		if (path === undefined || this.xpathRuntime === undefined) {
			return this.addRepeat(uuid, atPath);
		}
		return this.runAsyncRevision(
			"repeat-change",
			formUuid,
			async (revision, generation, signal) => {
				const index = await engine.addRepeatAsync(
					path,
					this.evaluatorFor(engine, entryKey, revision, generation, signal),
				);
				if (engine !== this.engine || entryKey !== this.currentEntryKey)
					return 0;
				this.syncAllPathsSelectively();
				return index;
			},
			0,
			{ atomic: true },
		);
	}

	/** Remove a repeat instance. Same gate as `addRepeat` — only
	 *  `user_controlled` repeats can shed instances at runtime. */
	removeRepeat(uuid: string, index: number, atPath?: string): void {
		if (!this.engine) return;
		if (!this.isUserControlledRepeat(uuid)) return;
		const path = atPath ?? this.uuidToPath.get(uuid);
		if (!path) return;
		const formUuid = this.activeFormUuid;
		if (formUuid === undefined) return;
		this.contain("repeat-change", formUuid, undefined, () => {
			const count = this.engine?.getRepeatCount(path) ?? 0;
			const entryKey = this.currentEntryKey;
			this.engine?.removeRepeat(path, index);
			// Selective sweep — see `addRepeat`.
			this.syncAllPathsSelectively();
			if (entryKey !== undefined && count > 1 && index >= 0 && index < count) {
				const event: RepeatCompactionEvent = {
					entryKey,
					removedPrefix: `${path}[${index}]`,
					moves: Array.from(
						{ length: Math.max(0, count - index - 1) },
						(_, offset) => {
							const fromIndex = index + offset + 1;
							return {
								fromPrefix: `${path}[${fromIndex}]`,
								toPrefix: `${path}[${fromIndex - 1}]`,
							};
						},
					),
				};
				for (const listener of this.repeatCompactionListeners) listener(event);
			}
		});
	}

	async removeRepeatAsync(
		uuid: string,
		index: number,
		atPath?: string,
	): Promise<boolean> {
		const engine = this.engine;
		const formUuid = this.activeFormUuid;
		const entryKey = this.currentEntryKey;
		if (
			!engine ||
			!formUuid ||
			!entryKey ||
			!this.isUserControlledRepeat(uuid)
		) {
			return false;
		}
		const path = atPath ?? this.uuidToPath.get(uuid);
		if (path === undefined || this.xpathRuntime === undefined) {
			this.removeRepeat(uuid, index, atPath);
			return true;
		}
		return this.runAsyncRevision(
			"repeat-change",
			formUuid,
			async (revision, generation, signal) => {
				const count = engine.getRepeatCount(path);
				await engine.removeRepeatAsync(
					path,
					index,
					this.evaluatorFor(engine, entryKey, revision, generation, signal),
				);
				if (engine !== this.engine || entryKey !== this.currentEntryKey)
					return false;
				this.syncAllPathsSelectively();
				if (count > 1 && index >= 0 && index < count) {
					const event: RepeatCompactionEvent = {
						entryKey,
						removedPrefix: `${path}[${index}]`,
						moves: Array.from(
							{ length: Math.max(0, count - index - 1) },
							(_, offset) => ({
								fromPrefix: `${path}[${index + offset + 1}]`,
								toPrefix: `${path}[${index + offset}]`,
							}),
						),
					};
					for (const listener of this.repeatCompactionListeners)
						listener(event);
				}
				return true;
			},
			false,
			{ atomic: true },
		);
	}

	/** True iff `uuid` resolves to a repeat field whose `repeat_mode`
	 *  is `user_controlled`. Defensive lookup — returns false for
	 *  unknown ids, non-repeats, and the count_bound / query_bound
	 *  modes whose cardinality is frozen. */
	private isUserControlledRepeat(uuid: string): boolean {
		if (!this.docStore) return false;
		const field = this.docStore.getState().fields[uuid];
		if (field?.kind !== "repeat") return false;
		return field.repeat_mode === "user_controlled";
	}

	/** Get the XForm path for a UUID. */
	getPath(uuid: string): string | undefined {
		return this.uuidToPath.get(uuid);
	}

	/**
	 * Walk the active form's template tree and emit one submission's
	 * worth of case-store mutations. Pass-through to
	 * `FormEngine.computeSubmissionMutation`.
	 *
	 * Requires an active engine — call `activateForm` first. Throws if
	 * the controller has no active engine, and if the active form is
	 * `followup` or `close` and no `caseId` is supplied. Consumers gate
	 * on `validateAll()` first; the engine assumes a valid form.
	 */
	computeSubmissionMutation(args: {
		caseId?: string;
		viewerTimeZone?: string;
	}): SubmissionMutation {
		if (
			this.runtimeFault !== undefined ||
			this.caseDatabaseWait() !== undefined
		) {
			throw new Error("Preview could not run this form.");
		}
		if (!this.engine) {
			throw new Error(
				compilerBugMessage({
					where: "preview.engineController.computeSubmissionMutation",
					invariant:
						"controller has no active engine; `activateForm` must be called before submission",
				}),
			);
		}
		if (this.currentEntryKey === undefined) {
			throw new Error(
				compilerBugMessage({
					where: "preview.engineController.computeSubmissionMutation",
					invariant:
						"controller has an active engine without a current entry key",
					detail:
						"Every final submission carries the controller-owned entry identity and an explicit exact attachment projection.",
				}),
			);
		}
		const formUuid = this.activeFormUuid;
		if (formUuid === undefined) {
			throw new Error("Preview could not run this form.");
		}
		try {
			return this.engine.computeSubmissionMutation({
				...args,
				entryKey: this.currentEntryKey,
			});
		} catch (error) {
			this.recordRuntimeFault("submission", formUuid, error);
			throw new Error("Preview could not run this form.");
		}
	}

	async computeSubmissionMutationAsync(
		args: { caseId?: string; viewerTimeZone?: string },
		expectedEntryKey: string,
	): Promise<EngineSubmissionSnapshot | undefined> {
		if (!(await this.awaitSettled(expectedEntryKey))) return undefined;
		const engine = this.engine;
		const documentState = this.reconciledDocumentState;
		const pending = this.pendingWork;
		if (
			engine === undefined ||
			documentState === undefined ||
			this.docStore?.getState() !== documentState ||
			this.currentEntryKey !== expectedEntryKey ||
			this.settling
		) {
			return undefined;
		}
		const mutation = this.computeSubmissionMutation(args);
		if (
			engine !== this.engine ||
			documentState !== this.reconciledDocumentState ||
			this.docStore?.getState() !== documentState ||
			pending !== this.pendingWork ||
			this.currentEntryKey !== expectedEntryKey ||
			this.settling
		) {
			return undefined;
		}
		return { mutation, documentState };
	}

	/** Post-submit session carrier evaluation on the same provider runtime. The
	 * caller supplies one entry-captured-and-patched structural world and the
	 * source entry fence; every expression shares one worker revision. */
	async evaluateFormLinkXPaths<T>(
		expectedEntryKey: string,
		run: (evaluate: FormLinkAsyncEvaluator) => Promise<T>,
	): Promise<T> {
		await this.pendingWork;
		const formUuid = this.activeFormUuid;
		if (
			this.xpathRuntime === undefined ||
			formUuid === undefined ||
			this.currentEntryKey !== expectedEntryKey
		) {
			throw new Error("Preview could not evaluate the after-submit route.");
		}
		const outcome = await this.runAsyncRevision<
			{ readonly completed: true; readonly value: T } | undefined
		>(
			"submission",
			formUuid,
			async (revision, generation, signal) => {
				const evaluate: FormLinkAsyncEvaluator = async (source, instances) => {
					const result = await this.xpathRuntime?.request(
						{
							entryKey: expectedEntryKey,
							revision,
							profile: "form-link",
							source,
							instances,
						},
						{ signal },
					);
					if (
						generation !== this.lifecycleGeneration ||
						this.currentEntryKey !== expectedEntryKey ||
						revision !== this.runtimeRevision ||
						result === undefined ||
						!result.ok
					) {
						throw new Error(
							"The after-submit XPath evaluation did not complete.",
						);
					}
					return deserializeXPathWorkerValue(result.value);
				};
				return { completed: true, value: await run(evaluate) };
			},
			undefined,
		);
		if (outcome === undefined) {
			throw new Error("Preview could not evaluate the after-submit route.");
		}
		return outcome.value;
	}

	async evaluateFormLinkXPath(
		source: string,
		instances: XPathWorkerInstances,
		expectedEntryKey: string,
	): Promise<XPathValue> {
		return this.evaluateFormLinkXPaths(expectedEntryKey, (evaluate) =>
			evaluate(source, instances),
		);
	}

	// ── Per-field subscriptions ──────────────────────────────────────

	/**
	 * Reconcile the complete pre/post path projection once per committed doc
	 * batch, before any per-field listener observes that commit.
	 *
	 * `applyMany` publishes one final Zustand state. Two fields can therefore
	 * rename together, or a whole subtree can move across group/repeat
	 * parents, without there being a meaningful per-field intermediate map.
	 * Materialize every old path first, move them in one engine call, then
	 * install the new maps and publish one capture migration event.
	 */
	private setupAuthoredPathTopologySubscription(formUuid: Uuid): void {
		if (!this.docStore) return;
		const store = this.docStore;
		const unsub = store.subscribe((current, previous) => {
			const engine = this.engine;
			if (!engine) return;
			if (
				!activeFormTopologyChanged(
					current,
					previous,
					formUuid,
					this.trackedUuids,
				)
			) {
				return;
			}
			this.contain("document-update", formUuid, undefined, () => {
				const previousInput = buildEngineInput(
					previous,
					formUuid,
					this.presentationLanguage,
				);
				const currentInput = buildEngineInput(
					current,
					formUuid,
					this.presentationLanguage,
				);
				if (previousInput === undefined || currentInput === undefined) return;

				const previousMaps = buildPathMaps(
					buildFieldTree(
						previousInput.formUuid,
						previousInput.fields,
						previousInput.fieldOrder,
					),
				);
				const currentMaps = buildPathMaps(
					buildFieldTree(
						currentInput.formUuid,
						currentInput.fields,
						currentInput.fieldOrder,
					),
				);
				const previousUuids = new Set(previousMaps.uuidToPath.keys());
				const currentUuids = new Set(currentMaps.uuidToPath.keys());
				const retainedUuids = [...previousUuids].filter((uuid) =>
					currentUuids.has(uuid),
				);
				const pathPairs: Array<{
					oldPath: string;
					newPath: string;
					oldSegmentKeys: readonly string[];
					newSegmentKeys: readonly string[];
				}> = [];
				const captureMoves: AuthoredCapturePathMigrationEvent["moves"][number][] =
					[];
				for (const uuid of retainedUuids) {
					const oldPath = previousMaps.uuidToPath.get(uuid);
					const newPath = currentMaps.uuidToPath.get(uuid);
					const oldSegmentKeys = previousMaps.uuidToSegmentKeys.get(uuid);
					const newSegmentKeys = currentMaps.uuidToSegmentKeys.get(uuid);
					const previousField = previousInput.fields[uuid];
					const currentField = currentInput.fields[uuid];
					if (
						oldPath === undefined ||
						newPath === undefined ||
						oldSegmentKeys === undefined ||
						newSegmentKeys === undefined ||
						previousField === undefined ||
						currentField === undefined
					) {
						continue;
					}
					if (oldPath !== newPath) {
						pathPairs.push({
							oldPath,
							newPath,
							oldSegmentKeys,
							newSegmentKeys,
						});
					}
					const previousCapture = isCaptureFieldKind(previousField.kind);
					const currentCapture = isCaptureFieldKind(currentField.kind);
					if (
						(previousCapture || currentCapture) &&
						(oldPath !== newPath || previousField.kind !== currentField.kind)
					) {
						captureMoves.push({
							kind: "retained",
							fieldUuid: uuid,
							previous: {
								pathTemplate: oldPath,
								segmentKeys: oldSegmentKeys,
								...(previousCapture ? { captureKind: previousField.kind } : {}),
							},
							current: {
								pathTemplate: newPath,
								segmentKeys: newSegmentKeys,
								...(currentCapture ? { captureKind: currentField.kind } : {}),
							},
						});
					}
				}
				for (const uuid of previousUuids) {
					if (currentUuids.has(uuid)) continue;
					const previousField = previousInput.fields[uuid];
					if (
						previousField === undefined ||
						!isCaptureFieldKind(previousField.kind)
					) {
						continue;
					}
					const oldPath = previousMaps.uuidToPath.get(uuid);
					const oldSegmentKeys = previousMaps.uuidToSegmentKeys.get(uuid);
					if (oldPath === undefined || oldSegmentKeys === undefined) continue;
					captureMoves.push({
						kind: "deleted",
						fieldUuid: uuid,
						previous: {
							pathTemplate: oldPath,
							segmentKeys: oldSegmentKeys,
							captureKind: previousField.kind,
						},
					});
				}
				if (pathPairs.length === 0 && captureMoves.length === 0) return;

				engine.renamePaths(pathPairs);
				const removedPaths = [...previousUuids]
					.filter((uuid) => !currentUuids.has(uuid))
					.map((uuid) => previousMaps.uuidToPath.get(uuid))
					.filter((path): path is string => path !== undefined);
				if (removedPaths.length > 0) {
					engine.removeFieldStates(removedPaths);
				}
				this.uuidToPath = currentMaps.uuidToPath;
				this.pathToUuid = currentMaps.pathToUuid;
				this.publishAuthoredCapturePathMigration(captureMoves);
				engine.rebuildDag(currentInput);
				for (const uuid of retainedUuids) {
					const oldPath = previousMaps.uuidToPath.get(uuid);
					const newPath = currentMaps.uuidToPath.get(uuid);
					const field = currentInput.fields[uuid];
					if (
						oldPath !== undefined &&
						newPath !== undefined &&
						oldPath !== newPath &&
						field !== undefined
					) {
						engine.ensureFieldStates(newPath, field);
					}
				}
				const allPaths = engine.getAllPaths();
				if (allPaths.length > 0) engine.evaluatePathsInto(allPaths);
				this.syncAllPathsSelectively();
			});
		});
		this.unsubscribers.push(unsub);
	}

	/**
	 * One Zustand subscription per field. Immer structural sharing means
	 * the callback only fires when THAT specific field was mutated.
	 *
	 * classifyChange determines what happened:
	 * - a case-write destination change → refresh submission metadata only
	 * - "none" → zero evaluation work
	 * - "kind_change" → drop the stale value at the old path, re-init the field
	 * - "expression" → rebuild DAG, evaluate field + cascade
	 * - "label_refs" → re-evaluate resolved labels
	 * - "id_rename" → no-op here; the batch-topology subscription ran first
	 * - "default_value" → re-evaluate default + cascade
	 */
	private setupPerFieldSubscriptions(uuids: Uuid[]): void {
		if (!this.docStore) return;
		const store = this.docStore;

		for (const uuid of uuids) {
			this.trackedUuids.add(uuid);

			const unsub = store.subscribe(
				(s) => s.fields[uuid],
				(current, previous) => {
					if (!current || !previous || !this.engine) return;
					const formUuid = this.activeFormUuid;
					if (formUuid === undefined) return;
					this.contain("document-update", formUuid, undefined, () => {
						/* Case-write targets do not participate in expression evaluation, but
						 * they do determine the exact mutation emitted at submit time. Refresh
						 * that narrow document surface independently so a combined patch can
						 * still take its ordinary expression/default handler below. */
						if (fieldCaseWrite(current) !== fieldCaseWrite(previous)) {
							const input = this.currentEngineInput();
							if (input !== undefined) this.engine?.refreshCaseWriteDoc(input);
						}
						const changeType = classifyChange(
							current as Field,
							previous as Field,
						);

						switch (changeType) {
							case "none":
								return;
							case "kind_change":
								this.onKindChanged(uuid);
								return;
							case "expression":
								this.onExpressionChanged(uuid);
								return;
							case "label_refs":
								this.onLabelRefsChanged(uuid);
								return;
							case "id_rename":
								// The whole-batch topology listener already moved every
								// retained path, rebuilt the DAG, and re-evaluated once.
								return;
							case "default_value":
								this.onDefaultValueChanged(uuid, current as Field);
								return;
							case "options_source": {
								/* A combined write may also carry a default change; apply
								 * the default FIRST (it evaluates directly, no DAG needed)
								 * so the expression handler's rebuild + field-and-dependents
								 * re-evaluation then recomputes choices AND retention
								 * against the freshly defaulted value. */
								const curDefault = (
									current as Field & { default_value?: unknown }
								).default_value;
								const prevDefault = (
									previous as Field & { default_value?: unknown }
								).default_value;
								if (curDefault !== prevDefault) {
									this.onDefaultValueChanged(uuid, current as Field);
								}
								/* The choices node's edges and expression live in the DAG,
								 * so the expression handler's rebuild + field-and-dependents
								 * re-evaluation covers a filter/table/column change — the
								 * choices arm recomputes and unselects dropped values. */
								this.onExpressionChanged(uuid);
								return;
							}
						}
					});
				},
			);

			this.unsubscribers.push(unsub);
		}
	}

	/**
	 * Structural subscription — detects add/remove by watching the full set
	 * of field UUIDs in this form (recursively from fieldOrder).
	 */
	private setupStructuralSubscription(formUuid: Uuid): void {
		if (!this.docStore) return;
		const store = this.docStore;

		const unsub = store.subscribe(
			(s) => collectFormUuids(formUuid, s.fieldOrder),
			(currentUuids, previousUuids) => {
				this.contain("document-update", formUuid, undefined, () => {
					const currentSet = new Set(currentUuids);
					const previousSet = new Set(previousUuids);
					const added = currentUuids.filter((u) => !previousSet.has(u));
					const removed = previousUuids.filter((u) => !currentSet.has(u));

					if (added.length > 0) this.onFieldsAdded(added);
					if (removed.length > 0) this.onFieldsRemoved(removed);
				});
			},
			{ equalityFn: shallow },
		);

		this.unsubscribers.push(unsub);
	}

	/** Metadata subscription — form type or module case type changes. */
	private setupMetadataSubscription(): void {
		if (!this.docStore) return;
		const store = this.docStore;

		const unsub = store.subscribe(
			(s) => {
				const formUuid = this.activeFormUuid;
				const form = formUuid ? s.forms[formUuid] : undefined;
				const moduleUuid = formUuid
					? findModuleForForm(s, formUuid)
					: undefined;
				const mod = moduleUuid ? s.modules[moduleUuid] : undefined;
				return `${form?.type}|${mod?.caseType}`;
			},
			() => {
				const formUuid = this.activeFormUuid;
				if (formUuid !== undefined) {
					this.contain("document-update", formUuid, undefined, () =>
						this.onMetadataChanged(),
					);
				}
			},
		);

		this.unsubscribers.push(unsub);
	}

	/**
	 * A custom worker-property rename changes the printed `#user/<slug>` bytes
	 * without changing the field AST that holds its UUID. Rebuild the active
	 * engine's printable document whenever that catalog changes so an open form
	 * immediately evaluates the identity through its current slug.
	 */
	private setupUserPropertySubscription(): void {
		if (!this.docStore) return;
		const unsub = this.docStore.subscribe(
			(s) => s.userProperties,
			() => {
				const formUuid = this.activeFormUuid;
				if (formUuid !== undefined) {
					/* A UUID-backed property rename changes every printed
					 * `#user/<slug>` expression. The worker runtime must rebuild and run
					 * its async initialization path so untouched defaults are re-derived;
					 * synchronous `updateSchema` cannot produce worker-backed defaults. */
					if (this.xpathRuntime !== undefined) {
						this.rebuildActiveFormAsync(formUuid, this.activeCaseData).catch(
							() => undefined,
						);
					} else {
						this.contain("document-update", formUuid, undefined, () =>
							this.onUserPropertiesChanged(),
						);
					}
				}
			},
		);
		this.unsubscribers.push(unsub);
	}

	/** Target overlays are app-level state, so ordinary per-field selectors do
	 * not fire when a translated label changes. Rebuild the same entry whenever
	 * that projection changes; the rebuild path preserves answers and repeats. */
	private setupLocalizationSubscription(): void {
		if (!this.docStore || this.presentationLanguage === null) return;
		const unsub = this.docStore.subscribe(
			(s) => s.localization,
			() => {
				const formUuid = this.activeFormUuid;
				if (formUuid !== undefined) {
					if (this.xpathRuntime !== undefined) {
						this.rebuildActiveFormAsync(
							formUuid,
							this.activeCaseData,
							true,
						).catch(() => undefined);
					} else {
						this.contain("document-update", formUuid, undefined, () =>
							this.rebuildActiveForm(formUuid, this.activeCaseData, true),
						);
					}
				}
			},
		);
		this.unsubscribers.push(unsub);
	}

	/** Registered last so all synchronous topology listeners finish first. One
	 * doc publication then owns one queued worker reconciliation revision. */
	private setupAsyncReconciliationSubscription(formUuid: Uuid): void {
		if (!this.docStore) return;
		const store = this.docStore;
		const unsub = store.subscribe((documentState, previousDocumentState) => {
			const engine = this.engine;
			const entryKey = this.currentEntryKey;
			if (engine === undefined || entryKey === undefined) return;
			if (this.xpathRuntime === undefined) {
				this.reconciledDocumentState = documentState;
				return;
			}
			if (
				!activeFormRuntimeChanged(
					documentState,
					previousDocumentState,
					formUuid,
					this.trackedUuids,
					this.presentationLanguage,
				)
			) {
				this.queueRuntimeNeutralDocumentState(documentState, engine, entryKey);
				return;
			}
			this.runAsyncRevision(
				"document-update",
				formUuid,
				async (revision, generation, signal) => {
					const evaluator = this.evaluatorFor(
						engine,
						entryKey,
						revision,
						generation,
						signal,
					);
					const pendingDefaults = [...this.pendingDefaultFieldUuids];
					const input = this.currentEngineInput();
					if (input !== undefined) {
						for (const uuid of pendingDefaults) {
							const path = this.uuidToPath.get(uuid);
							const field = input.fields[uuid];
							if (
								path !== undefined &&
								field !== undefined &&
								!isContainer(field)
							) {
								await engine.reevaluateDefaultAsync(path, field, evaluator);
							}
						}
					}
					await engine.settleAsync(evaluator);
					if (
						engine !== this.engine ||
						entryKey !== this.currentEntryKey ||
						generation !== this.lifecycleGeneration ||
						revision !== this.runtimeRevision
					) {
						return undefined;
					}
					for (const uuid of pendingDefaults) {
						this.pendingDefaultFieldUuids.delete(uuid);
					}
					this.syncAllPathsSelectively();
					this.reconciledDocumentState = documentState;
				},
				undefined,
			);
		});
		this.unsubscribers.push(unsub);
	}

	/**
	 * Preserve the submission's exact document revision after a Builder-only
	 * edit without creating, aborting, or settling a worker world. Queue behind
	 * existing work so a preceding runtime-relevant publication cannot finish
	 * later and overwrite this newer, already-compatible document snapshot.
	 */
	private queueRuntimeNeutralDocumentState(
		documentState: BlueprintDocState,
		engine: FormEngine,
		entryKey: string,
	): void {
		const generation = this.lifecycleGeneration;
		const previous = this.pendingWork.catch(() => undefined);
		const task = previous.then(() => {
			if (
				generation === this.lifecycleGeneration &&
				engine === this.engine &&
				entryKey === this.currentEntryKey &&
				this.docStore?.getState() === documentState
			) {
				/* A successor value/validation revision may already be marked settling
				 * while it waits behind this task. That later work shares this exact
				 * document and never publishes a document revision of its own, so it
				 * must not suppress the snapshot that unblocks submission after it. */
				this.reconciledDocumentState = documentState;
			}
		});
		this.pendingWork = task.then(
			() => undefined,
			() => undefined,
		);
	}

	// ── Targeted change handlers ─────────────────────────────────────

	/** Helper: resolve the active form's FormEngineInput from the current
	 *  doc state. Returns undefined if the form no longer exists (deleted
	 *  mid-subscription). */
	private currentEngineInput(): FormEngineInput | undefined {
		if (!this.docStore) return undefined;
		const formUuid = this.activeFormUuid;
		if (!formUuid) return undefined;
		const s = this.docStore.getState();
		return buildEngineInput(s, formUuid, this.presentationLanguage);
	}

	/**
	 * A field's kind changed (a remote `convertField` retype). Two shapes,
	 * with opposite value semantics:
	 *
	 * - **Leaf retype** (e.g. text→secret, group→… never lands here): the
	 *   answer is meaningless under the new kind — a text value is not a valid
	 *   `int`/`date` — so the field's value is DROPPED and the field re-seeds
	 *   empty (re-applying its new default, if any).
	 * - **Container conversion** (group↔repeat): the container itself carries
	 *   no value, and its descendants' in-progress answers are still valid —
	 *   only their XForm paths shift (`/data/<c>/<child>` ↔ `/data/<c>[0]/<child>`
	 *   as the `[0]` template segment appears/disappears). Those descendant
	 *   values are RE-PATHED, not dropped, so a peer converting a group with
	 *   answered children to a repeat doesn't silently lose them.
	 *
	 * Either way the path maps + DAG rebuild (the conversion, and any
	 * co-incident rename, moves paths and rewires references), so this subsumes
	 * `onIdRenamed`'s work. When the retyped field has no path in the rebuilt
	 * tree (it was also removed in the same batch), it's cleaned up like a
	 * removal rather than left in a stale half-state.
	 */
	private onKindChanged(uuid: Uuid): void {
		if (!this.engine) return;
		const input = this.currentEngineInput();
		if (!input) return;

		const field = input.fields[uuid];
		const isContainerConversion = field !== undefined && isContainer(field);

		/* Snapshot old paths (container + every descendant) against the
		 * PRE-rebuild maps — that's where the current values live. For a
		 * container conversion these feed the descendant re-path below; for a
		 * leaf retype only the field's own old path matters (dropped). */
		const oldPath = this.uuidToPath.get(uuid);
		const oldDescendantPaths = isContainerConversion
			? new Map(
					collectFormUuids(uuid, input.fieldOrder).map(
						(d) => [d, this.uuidToPath.get(d)] as const,
					),
				)
			: undefined;

		/* A leaf retype drops its own stale value up front — at every live
		 * instance; `addFieldState` only seeds `""` when the path is absent,
		 * so deleting is what makes the re-init start empty. A container has
		 * no value of its own to drop. */
		if (!isContainerConversion && oldPath) this.engine.deleteValue(oldPath);

		/* Rebuild path MAPS — the conversion (and any co-incident rename)
		 * moves paths. The engine's DAG rebuild waits until AFTER the value
		 * moves below: old paths materialize against the pre-change topology. */
		const newTree = buildFieldTree(
			input.formUuid,
			input.fields,
			input.fieldOrder,
		);
		const maps = buildPathMaps(newTree);
		this.uuidToPath = maps.uuidToPath;
		this.pathToUuid = maps.pathToUuid;

		const newPath = this.uuidToPath.get(uuid);

		/* Re-path descendant values for a container conversion: move each
		 * descendant's value + runtime state — every live instance — from its
		 * old path to its new (reindexed) path so answered children survive.
		 * One batch call, so materialization happens before any move. */
		const newDescendantPaths: string[] = [];
		if (oldDescendantPaths && field) {
			const pairs: Array<{ oldPath: string; newPath: string }> = [];
			for (const [descendantUuid, oldDescendantPath] of oldDescendantPaths) {
				const newDescendantPath = this.uuidToPath.get(descendantUuid);
				if (!newDescendantPath) continue;
				newDescendantPaths.push(newDescendantPath);
				if (oldDescendantPath && oldDescendantPath !== newDescendantPath) {
					pairs.push({
						oldPath: oldDescendantPath,
						newPath: newDescendantPath,
					});
				}
			}
			this.engine.renamePaths(pairs);
			/* A repeat→group conversion retires the container's instance
			 * count (instances ≥ 1 were dropped by the re-path above) —
			 * `deleteValue` clears it; containers own no value key. */
			if (field.kind === "group" && oldPath) this.engine.deleteValue(oldPath);
		}

		this.engine.rebuildDag(input);

		/* No path in the rebuilt tree → the field was also removed in this
		 * batch. Clean it up like a removal so it isn't left stale-but-blank
		 * with no engine value backing it. */
		if (!newPath) {
			this.onFieldsRemoved([uuid]);
			return;
		}

		if (field) {
			/* Re-seed the field's runtime state under the new kind. For a
			 * container conversion this is only the shell (a repeat carries
			 * `repeatCount`, a group doesn't) — `addFieldState` skips the value
			 * write for containers, leaving the re-pathed descendant values
			 * intact. For a leaf retype it re-seeds empty with the new kind's
			 * required flag and default. */
			this.engine.addFieldState(newPath, field);
			if (this.xpathRuntime !== undefined && !isContainer(field)) {
				this.pendingDefaultFieldUuids.add(uuid);
			}
		}

		/* Re-evaluate the converted field + its descendants + downstream
		 * dependents at every live instance, then sync. The selective sweep
		 * also propagates the unplugged old-path entries. */
		const affectedPaths = new Set<string>();
		for (const p of [newPath, ...newDescendantPaths]) {
			for (const concrete of this.engine.materializePaths(p)) {
				affectedPaths.add(concrete);
			}
			for (const dep of this.engine.getAffectedPaths(p)) affectedPaths.add(dep);
		}
		this.engine.evaluatePathsInto([...affectedPaths]);
		this.syncAllPathsSelectively();
	}

	/** A field's expression changed. Rebuild DAG (sub-ms), then
	 *  re-evaluate that field — every live instance — plus its
	 *  downstream dependents. */
	private onExpressionChanged(uuid: Uuid): void {
		if (!this.engine) return;
		const input = this.currentEngineInput();
		if (!input) return;

		this.engine.rebuildDag(input);

		const path = this.uuidToPath.get(uuid);
		if (!path) return;
		/* A constant `required` (`true()` / `false()`) never enters the DAG,
		 * so the evaluation below cannot see it change: re-seed it first. */
		const field = input.fields[uuid];
		if (field !== undefined) this.engine.reseedRequired(path, field);
		const affectedPaths = [
			...this.engine.materializePaths(path),
			...this.engine.getAffectedPaths(path),
		];
		this.engine.evaluatePathsInto(affectedPaths);
		this.syncPathsToStore(affectedPaths);
	}

	/** A field's label/hint with hashtag references changed. Rebuild the
	 *  DAG (it carries the printDoc the output resolution reads the new
	 *  label text through), then re-resolve at every live instance. */
	private onLabelRefsChanged(uuid: Uuid): void {
		if (!this.engine) return;
		const input = this.currentEngineInput();
		if (input) this.engine.rebuildDag(input);
		const path = this.uuidToPath.get(uuid);
		if (!path) return;
		const targets = this.engine.materializePaths(path);
		this.engine.evaluatePathsInto(targets);
		this.syncPathsToStore(targets);
	}

	/** A field's default_value expression changed. Re-evaluate the
	 *  default (every live instance) and cascade through dependents. */
	private onDefaultValueChanged(uuid: Uuid, field: Field): void {
		if (!this.engine) return;
		const input = this.currentEngineInput();
		if (input) this.engine.rebuildDag(input);

		const path = this.uuidToPath.get(uuid);
		if (!path) return;

		/* Worker-backed forms apply this during the final document revision,
		 * after every synchronous topology listener has established final paths. */
		if (this.xpathRuntime !== undefined) {
			this.pendingDefaultFieldUuids.add(uuid);
		} else {
			this.engine.reevaluateDefault(path, field);
		}

		const affectedPaths = [
			...this.engine.materializePaths(path),
			...this.engine.getAffectedPaths(path),
		];
		this.syncPathsToStore(affectedPaths);
	}

	/** Fields were added to the form. Initialize their states
	 *  incrementally without rebuilding existing fields. */
	private onFieldsAdded(uuids: Uuid[]): void {
		if (!this.engine) return;
		const input = this.currentEngineInput();
		if (!input) return;

		/* Rebuild path maps and DAG to include the new fields */
		const tree = buildFieldTree(input.formUuid, input.fields, input.fieldOrder);
		const maps = buildPathMaps(tree);
		this.uuidToPath = maps.uuidToPath;
		this.pathToUuid = maps.pathToUuid;
		this.engine.rebuildDag(input);

		/* Initialize state for each new field — every live instance when the
		 * field sits inside a repeat; existing fields untouched */
		const engine = this.engine;
		for (const uuid of uuids) {
			const path = this.uuidToPath.get(uuid);
			const field = input.fields[uuid];
			if (path && field) {
				engine.addFieldState(path, field);
				if (this.xpathRuntime !== undefined && !isContainer(field)) {
					this.pendingDefaultFieldUuids.add(uuid);
				}
			}
		}

		/* Sync only the new fields' concrete paths to the runtime store */
		const newPaths = uuids
			.map((u) => this.uuidToPath.get(u))
			.filter((p): p is string => !!p)
			.flatMap((p) => engine.materializePaths(p));
		this.syncPathsToStore(newPaths);

		/* Set up per-field subscriptions for the new fields */
		this.setupPerFieldSubscriptions(uuids);
	}

	/** Fields were removed from the form. Clean up their states
	 *  without rebuilding existing fields. */
	private onFieldsRemoved(uuids: Uuid[]): void {
		if (!this.engine) return;

		/* Remove states from the engine and runtime store — every live
		 * instance in one batch (`removeFieldStates` materializes all paths
		 * before deleting, so removing a repeat container can't blind its
		 * children's instance expansion). It also drops the fields'
		 * `DataInstance` values so the path-keyed engine store and the value
		 * map stay consistent — a field re-added at the same path seeds empty
		 * rather than resurrecting the removed answer. */
		this.engine.removeFieldStates(
			uuids.map((u) => this.uuidToPath.get(u)).filter((p): p is string => !!p),
		);
		const runtimeUpdates: RuntimeStoreState = {};
		for (const uuid of uuids) {
			runtimeUpdates[uuid] = DEFAULT_RUNTIME_STATE;
			this.trackedUuids.delete(uuid);
		}
		this.store.setState(runtimeUpdates);

		/* Rebuild path maps and DAG without the removed fields */
		const input = this.currentEngineInput();
		if (input) {
			const tree = buildFieldTree(
				input.formUuid,
				input.fields,
				input.fieldOrder,
			);
			const maps = buildPathMaps(tree);
			this.uuidToPath = maps.uuidToPath;
			this.pathToUuid = maps.pathToUuid;
			this.engine.rebuildDag(input);

			/* Re-evaluate fields that depended on the removed ones.
			 * Their expressions now reference missing paths — the evaluator
			 * returns empty/default values for missing references. The
			 * selective sweep also propagates the unplugged removed-instance
			 * entries to the runtime store. */
			const allPaths = this.engine.getAllPaths();
			if (allPaths.length > 0) {
				this.engine.evaluatePathsInto(allPaths);
			}
			this.syncAllPathsSelectively();
		}
	}

	/** Form type or module case type changed. Update case data context
	 *  and re-evaluate only the affected case-property fields. */
	private onMetadataChanged(): void {
		if (!this.engine || !this.docStore) return;
		const input = this.currentEngineInput();
		if (!input) return;

		const s = this.docStore.getState();
		const moduleUuid = this.activeFormUuid
			? findModuleForForm(s, this.activeFormUuid)
			: undefined;
		const mod = moduleUuid ? s.modules[moduleUuid] : undefined;

		this.engine.refreshCaseContext(
			input,
			this.activeCaseData ?? new Map(),
			mod?.caseType,
		);

		/* Sync any paths that changed from the case data refresh */
		this.syncAllPathsSelectively();
	}

	/** Refresh UUID-backed worker XPath printing while preserving touched form
	 * answers. `updateSchema` snapshots/restores touched values and rebuilds the
	 * printable document + DAG as one operation. */
	private onUserPropertiesChanged(): void {
		if (!this.engine || !this.docStore) return;
		const input = this.currentEngineInput();
		if (!input) return;
		const state = this.docStore.getState();
		const moduleUuid = this.activeFormUuid
			? findModuleForForm(state, this.activeFormUuid)
			: undefined;
		const mod = moduleUuid ? state.modules[moduleUuid] : undefined;

		this.engine.updateSchema(input, mod?.caseType, this.activeCaseData);
		this.syncAllPathsSelectively();
	}

	// ── Store sync ───────────────────────────────────────────────────

	/**
	 * Runtime-store keys for one engine path. Every path with a uuid
	 * mapping gets its uuid key (the edit-mode rows' subscription);
	 * every path inside a repeat instance (any `[N]` segment) ALSO gets
	 * a path key — one entry per live instance, the interactive
	 * renderer's subscription. The two sets overlap on `[0]` template
	 * paths, which carry both keys. Uuid strings never start with `/`,
	 * so the two key spaces can't collide.
	 */
	private runtimeKeysFor(path: string): string[] {
		const keys: string[] = [];
		const uuid = this.pathToUuid.get(path);
		if (uuid) keys.push(uuid);
		if (path.includes("[")) keys.push(path);
		return keys;
	}

	/** Sync ALL engine state to the runtime store. Used only during
	 *  initial activation and full reset. */
	private syncAllToStore(): void {
		if (!this.engine) return;
		const engineState = this.engine.store.getState();
		const runtime: RuntimeStoreState = {};
		for (const [path, state] of Object.entries(engineState)) {
			for (const key of this.runtimeKeysFor(path)) {
				runtime[key] = state;
			}
		}
		this.store.setState(runtime, true);
	}

	/** Sync ALL paths but only write entries whose state actually changed.
	 *  Used by validateAll, resetValidation, and repeat cardinality
	 *  changes, where many fields are touched but most states don't
	 *  change. */
	private syncAllPathsSelectively(): void {
		if (!this.engine) return;
		const engineState = this.engine.store.getState();
		const currentRuntime = this.store.getState();
		const updates: RuntimeStoreState = {};
		let hasChanges = false;

		for (const [path, newState] of Object.entries(engineState)) {
			for (const key of this.runtimeKeysFor(path)) {
				const oldState = currentRuntime[key];
				if (!oldState || !fieldStatesEqual(oldState, newState)) {
					updates[key] = newState;
					hasChanges = true;
				}
			}
		}

		if (hasChanges) {
			this.store.setState(updates);
		}
	}

	/** Sync specific paths to the runtime store. The primary sync method —
	 *  used after every targeted operation. Only writes entries whose
	 *  state actually changed. */
	private syncPathsToStore(paths: string[]): void {
		if (!this.engine) return;
		const engineState = this.engine.store.getState();
		const currentRuntime = this.store.getState();
		const updates: RuntimeStoreState = {};
		let hasChanges = false;

		for (const path of paths) {
			const newState = engineState[path];
			if (!newState) continue;
			for (const key of this.runtimeKeysFor(path)) {
				const oldState = currentRuntime[key];
				if (!oldState || !fieldStatesEqual(oldState, newState)) {
					updates[key] = newState;
					hasChanges = true;
				}
			}
		}

		if (hasChanges) {
			this.store.setState(updates);
		}
	}
}
