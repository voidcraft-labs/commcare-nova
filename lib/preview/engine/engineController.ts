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
	isCaptureFieldKind,
	type LanguageCode,
	materializableCaseTypes,
	projectLocalizedFields,
	resolveAppLanguage,
	type Uuid,
} from "@/lib/domain";
import { compilerBugMessage } from "@/lib/domain/predicate/errors";
import type { ProseTemplate } from "@/lib/domain/prose";
import type { SubmissionMutation } from "./caseDataBindingTypes";
import type { FieldTreeNode } from "./fieldTree";
import { buildFieldTree } from "./fieldTree";
import {
	type CaseDataByType,
	FormEngine,
	type FormEngineInput,
	type InvalidFieldTarget,
} from "./formEngine";
import { type ResolvedPreviewIdentity, samePreviewIdentity } from "./identity";
import type { PreviewLookupData } from "./lookupEvaluation";
import { type FieldState, fieldStatesEqual } from "./types";

// ── Runtime store types ─────────────────────────────────────────────────

/** Per-field computed runtime state. Keyed by UUID, aligned with the
 *  blueprint store. Components subscribe via `useStore(store, s => s[uuid])`. */
export type RuntimeState = FieldState;

/** The Zustand store shape — flat map of UUID → RuntimeState. */
export type RuntimeStoreState = Record<string, RuntimeState>;

/** Reactive form-entry identity. Unlike `entryKey`'s imperative getter, this
 * store notifies FormScreen when a materially changed worker rotates the
 * controller without first causing a parent React render. */
export interface EngineEntryState {
	readonly entryKey: string | undefined;
	readonly formUuid: Uuid | undefined;
	readonly revision: number;
}

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
	language: LanguageCode | null,
): FormEngineInput | undefined {
	const form = state.forms[formUuid];
	if (!form) return undefined;
	return {
		form: form as Form,
		formUuid,
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
	/** Selected worker-content language for presentation-bearing engine input.
	 * `null` keeps standalone/non-Builder controller consumers canonical. */
	private presentationLanguage: LanguageCode | null = null;

	constructor() {
		this.store = createStore<RuntimeStoreState>(() => ({}));
		this.entryStore = createStore<EngineEntryState>(() => ({
			entryKey: undefined,
			formUuid: undefined,
			revision: 0,
		}));
	}

	private publishEntryState(): void {
		const current = this.entryStore.getState();
		if (
			current.entryKey === this.currentEntryKey &&
			current.formUuid === this.activeFormUuid
		) {
			return;
		}
		this.entryStore.setState(
			{
				entryKey: this.currentEntryKey,
				formUuid: this.activeFormUuid,
				revision: current.revision + 1,
			},
			true,
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
				this.rebuildActiveForm(formUuid, this.activeCaseData);
			} else {
				// A different concrete worker (or sign-out) is a new answer world,
				// not a same-entry rebuild. Rotate the capture namespace with it.
				this.activateForm(formUuid, this.activeCaseData);
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
		this.rebuildActiveForm(formUuid, this.activeCaseData);
	}

	/**
	 * Install the selected worker-content language. A live form rebuilds in the
	 * same entry so dynamic prose, option labels, and validation messages use
	 * the same projection as the rendered field without rotating attachments or
	 * discarding touched answers.
	 */
	setPresentationLanguage(language: LanguageCode | null): void {
		if (this.presentationLanguage === language) return;
		this.presentationLanguage = language;
		const formUuid = this.activeFormUuid;
		if (formUuid !== undefined) {
			this.rebuildActiveForm(formUuid, this.activeCaseData, true);
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
	activateForm(formUuid: Uuid, caseData?: CaseDataByType): void {
		if (this.previewIdentityBlocked) {
			this.deactivate();
			return;
		}
		this.mountForm(formUuid, caseData, crypto.randomUUID());
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
		const entryKey =
			this.activeFormUuid === formUuid && this.currentEntryKey !== undefined
				? this.currentEntryKey
				: crypto.randomUUID();
		const values = this.engine?.getValueSnapshot({
			includeAllValues: preserveAllValues,
		});
		const repeatCounts = this.engine?.getRepeatCountSnapshot();
		const repeatInstanceKeys = this.engine?.getRepeatInstanceKeySnapshot();
		this.mountForm(formUuid, caseData, entryKey);
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
	}

	private mountForm(
		formUuid: Uuid,
		caseData: CaseDataByType | undefined,
		entryKey: string,
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
		this.engine = new FormEngine(
			input,
			mod?.caseType,
			caseData,
			this.previewIdentity,
			this.lookupData,
		);

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
		this.publishEntryState();
	}

	private clearActiveForm(): void {
		for (const unsub of this.unsubscribers) unsub();
		this.unsubscribers = [];
		this.trackedUuids.clear();
		this.engine = undefined;
		this.uuidToPath.clear();
		this.pathToUuid.clear();
		this.activeFormUuid = undefined;
		this.activeCaseData = undefined;
		this.currentEntryKey = undefined;
		this.store.setState({}, true);
	}

	/** Clean up all subscriptions and reset state. */
	deactivate(): void {
		this.clearActiveForm();
		this.publishEntryState();
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

	/**
	 * End the current answer world and synchronously mount a fresh entry for
	 * the same form, case preload, lookup capture, and preview identity.
	 */
	restartActiveEntry(): string | undefined {
		const formUuid = this.activeFormUuid;
		if (formUuid === undefined) return undefined;
		this.mountForm(formUuid, this.activeCaseData, crypto.randomUUID());
		return this.currentEntryKey;
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
		this.engine.setValue(path, value);
		const affectedPaths = [path, ...this.engine.getAffectedPaths(path)];
		this.syncPathsToStore(affectedPaths);
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
		this.engine.touch(path);
		this.syncPathsToStore([path]);
	}

	/** Validate all visible fields. Returns true if valid. */
	validateAll(): boolean {
		if (!this.engine) return true;
		const result = this.engine.validateAll();
		/* validateAll touches many fields (marks touched, runs validation).
		 * Sync all paths but only write those that actually changed. */
		this.syncAllPathsSelectively();
		return result;
	}

	/** First invalid runtime question plus the collapsed ancestors that hide it. */
	firstInvalidFieldTarget(): InvalidFieldTarget | undefined {
		return this.engine?.firstInvalidFieldTarget();
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
		this.engine.reset();
		this.syncAllToStore();
	}

	/** Clear touched/validation state (for mode switches). */
	resetValidation(): void {
		if (!this.engine) return;
		this.engine.resetValidation();
		this.syncAllPathsSelectively();
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
		const result = this.engine.addRepeat(path);
		// Cardinality changes touch the repeat's own `repeatCount`, the
		// new instance's per-path states, and any outside dependents —
		// the selective sweep diff-writes only entries that actually
		// changed, so untouched rows keep their references.
		this.syncAllPathsSelectively();
		return result;
	}

	/** Remove a repeat instance. Same gate as `addRepeat` — only
	 *  `user_controlled` repeats can shed instances at runtime. */
	removeRepeat(uuid: string, index: number, atPath?: string): void {
		if (!this.engine) return;
		if (!this.isUserControlledRepeat(uuid)) return;
		const path = atPath ?? this.uuidToPath.get(uuid);
		if (!path) return;
		const count = this.engine.getRepeatCount(path);
		const entryKey = this.currentEntryKey;
		this.engine.removeRepeat(path, index);
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
		return this.engine.computeSubmissionMutation({
			...args,
			entryKey: this.currentEntryKey,
		});
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
			if (!this.engine) return;
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

			this.engine.renamePaths(pathPairs);
			const removedPaths = [...previousUuids]
				.filter((uuid) => !currentUuids.has(uuid))
				.map((uuid) => previousMaps.uuidToPath.get(uuid))
				.filter((path): path is string => path !== undefined);
			if (removedPaths.length > 0) {
				this.engine.removeFieldStates(removedPaths);
			}
			this.uuidToPath = currentMaps.uuidToPath;
			this.pathToUuid = currentMaps.pathToUuid;
			this.publishAuthoredCapturePathMigration(captureMoves);
			this.engine.rebuildDag(currentInput);
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
					this.engine.ensureFieldStates(newPath, field);
				}
			}
			const allPaths = this.engine.getAllPaths();
			if (allPaths.length > 0) this.engine.evaluatePathsInto(allPaths);
			this.syncAllPathsSelectively();
		});
		this.unsubscribers.push(unsub);
	}

	/**
	 * One Zustand subscription per field. Immer structural sharing means
	 * the callback only fires when THAT specific field was mutated.
	 *
	 * classifyChange determines what happened:
	 * - "none" → zero engine work
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
				const currentSet = new Set(currentUuids);
				const previousSet = new Set(previousUuids);
				const added = currentUuids.filter((u) => !previousSet.has(u));
				const removed = previousUuids.filter((u) => !currentSet.has(u));

				if (added.length > 0) this.onFieldsAdded(added);
				if (removed.length > 0) this.onFieldsRemoved(removed);
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
			() => this.onMetadataChanged(),
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
			() => this.onUserPropertiesChanged(),
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
					this.rebuildActiveForm(formUuid, this.activeCaseData, true);
				}
			},
		);
		this.unsubscribers.push(unsub);
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
		const isContainerConversion =
			field?.kind === "group" || field?.kind === "repeat";

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

		/* Re-evaluate the default value — engine handles the cascade */
		this.engine.reevaluateDefault(path, field);

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
