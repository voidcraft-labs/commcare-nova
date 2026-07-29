/**
 * User-facing mutation API for the BlueprintDoc store — domain-native.
 *
 * Every consumer that edits a module, form, or field calls this hook
 * and dispatches via the returned action object. All signatures take
 * uuid-first parameters and domain types (`Field`, `Form`, `Module`).
 * `updateField` is per-kind: callers pass the target field's `kind` so
 * the patch type narrows to that variant's partial shape — see the
 * method signature below for the contract.
 *
 * Internally, each method:
 *   1. Reads the CURRENT doc snapshot via `store.getState()` (not the
 *      snapshot at hook construction) so uuid validation always targets
 *      the freshest state, even after intervening mutations.
 *   2. Validates the uuid exists in the current doc (form, field, or
 *      module entity map).
 *   3. Dispatches a `Mutation` through `store.getState().applyMany([...])`
 *      — the ONE public write path — which the reducer in
 *      `lib/doc/mutations/index.ts` translates into draft edits on the
 *      Immer-backed store. The two mutations that produce metadata
 *      (`renameField`, `moveField`) destructure position `[0]` of the
 *      returned `MutationResult[]`.
 *
 * Missing references (unknown uuid) are silently swallowed with a
 * `console.warn`. The engine behaved the same way: no-op rather than
 * throw, so the UI never crashes on a stale selection held over a
 * reload or undo.
 *
 * **Every dispatch is gated.** Before any batch reaches `applyMany`, it
 * runs through the shared commit verdict
 * (`lib/doc/commitVerdicts.ts::mutationCommitVerdict` — the
 * `identifierVerdicts` pattern generalized to the whole validator). An
 * edit that would introduce a validator finding is rejected: nothing
 * dispatches, the rejection surfaces each finding's CONCISE builder copy
 * (`userFacingErrors` — the SA keeps the verbose `ValidationError.message`),
 * and the method returns its no-op shape.
 * Undo/redo (the temporal store), hydration (`load`), the agent stream
 * (`streamDispatcher`), and replay all write through other paths and
 * deliberately bypass this gate — they replay already-committed
 * states.
 */

"use client";

import { useContext, useMemo } from "react";
import type { CaseDisplaySurface } from "@/components/builder/case-list-config/workspaceProjection";
import {
	type CaseTypeRetirement,
	planCaseTypeRetirementOnRemove,
	planCaseTypeRetirementOnRetype,
} from "@/lib/doc/caseTypeRetirement";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { duplicateFieldMutations } from "@/lib/doc/duplicateFieldMutations";
import type { FieldPath } from "@/lib/doc/fieldPath";
import { fieldSlotAfter } from "@/lib/doc/fieldSlot";
import { findRenameSiblingConflict } from "@/lib/doc/identifierVerdicts";
import { planKindConversion } from "@/lib/doc/kindConversionCascade";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { modulePatchMutations } from "@/lib/doc/modulePatchMutations";
import { notifyRejectedCommit } from "@/lib/doc/mutations/notify";
import { withOptionUuids } from "@/lib/doc/optionIdentity";
import {
	BlueprintDocContext,
	BlueprintEditableContext,
} from "@/lib/doc/provider";
import {
	caseListModuleMutations,
	caseTypeCatalogMutations,
	declareCaseTypeForField,
	declareCaseTypeMutations,
	formScaffoldMutations,
	surveyModuleMutations,
} from "@/lib/doc/scaffolds";
import type {
	BlueprintDoc,
	FieldRenameMeta,
	MoveFieldResult,
	Mutation,
	MutationResult,
	Uuid,
} from "@/lib/doc/types";
import { userFacingErrors } from "@/lib/doc/userFacingErrors";
import {
	addPersonaMutations,
	addUserPropertyMutations,
	addUserTypeMutations,
	type RemoveUserPropertyPlan,
	removePersonaMutations,
	removeUserPropertyPlan,
	removeUserTypePlan,
	updatePersonaMutations,
	updatePersonaValueMutations,
	updateUserTypeMutations,
	updateUserTypeValueMutations,
} from "@/lib/doc/userMutations";
import {
	asUuid,
	type CarrierBlindField,
	type CaseProperty,
	type CaseType,
	type CommitOutcome,
	type ConnectType,
	DEFAULT_SELECT_OPTIONS,
	type Field,
	type FieldKind,
	type FieldPatchFor,
	type Form,
	type FormIconRef,
	type FormType,
	fieldRegistry,
	HIDDEN_INERT_DEFAULT_VALUE,
	type MediaAssetId,
	type Module,
	type ModuleIconRef,
	ownRecordValue,
	type Persona,
	type SelectOption,
	type UserProperty,
	type UserType,
} from "@/lib/domain";

/**
 * Outcome of an entity-adding dispatch: the minted uuid on success, the
 * gate's findings on a rejection (`messages` empty for a silent no-op —
 * an unresolvable parent/target the dispatch couldn't act on).
 */
export type AddCommitOutcome =
	| { ok: true; uuid: Uuid }
	| { ok: false; messages: string[] };

/**
 * A patch over one user-collection entity: any subset of its mutable
 * slots, with a cleared optional slot spelled `null` (JSON drops
 * `undefined`, so `null` is the only clear that survives the wire).
 * `uuid` and `order` never appear — the first is the patch's key, the
 * second is sequence, which these surfaces do not reorder.
 */
export type UserEntityPatch<T> = {
	[K in Exclude<keyof T, "uuid" | "order">]?: T[K] | null;
};

export type { CommitOutcome };

const COMMITTED: CommitOutcome = { ok: true };

/** The silent-no-op rejection (a stale uuid, nothing dispatched) — no
 *  messages, so editors keep the legacy quiet behavior. */
const NOOP_REJECTION: CommitOutcome & { ok: false } = {
	ok: false,
	messages: [],
};

/**
 * Result of a `renameField` dispatch.
 *
 * `conflict: true` short-circuits the dispatch — the hook checks sibling
 * ids BEFORE calling the reducer so the UI can surface a "name already
 * taken" message without unwinding a half-applied mutation. When a
 * conflict is reported, every count field is zero and `newPath` is empty
 * (the rename never ran).
 *
 * The remaining fields carry the reducer's cascade metadata — see
 * `FieldRenameMeta` in `lib/doc/mutations/fields.ts` for the full
 * contract. Callers surface these as toast copy ("N references updated")
 * and to decide whether a cross-form view needs refreshing.
 */
export interface FieldRenameResult {
	newPath: FieldPath;
	xpathFieldsRewritten: number;
	peerFieldsRenamed: number;
	columnsRewritten: number;
	formWiringRewritten: number;
	moduleRefsRewritten: number;
	catalogEntryRenamed: boolean;
	cascadedAcrossForms: boolean;
	conflict?: boolean;
	/** Present when the commit gate rejected the rename — the findings'
	 *  person-to-person messages. The rename never ran; the caller keeps
	 *  the user's typed id on screen and surfaces these inline. */
	rejected?: string[];
}

/**
 * Shared zero-valued result used when `renameField` short-circuits
 * (unknown uuid or sibling-id conflict). Keeps every exit shape valid
 * against `FieldRenameResult` without scattering literal zeros through
 * the hook body.
 */
function emptyFieldRenameResult(): FieldRenameResult {
	return {
		newPath: "" as FieldPath,
		xpathFieldsRewritten: 0,
		peerFieldsRenamed: 0,
		columnsRewritten: 0,
		formWiringRewritten: 0,
		moduleRefsRewritten: 0,
		catalogEntryRenamed: false,
		cascadedAcrossForms: false,
	};
}

/**
 * Result of a `duplicateField` dispatch.
 *
 * Returns the clone's new path and UUID so callers can focus the new
 * field in the UI immediately. Computed by diffing parent order
 * arrays before and after the dispatch (the reducer itself doesn't
 * return the new uuid). `undefined` if the dispatch was a no-op.
 */
export interface DuplicateFieldResult {
	newPath: FieldPath;
	newUuid: string;
}

type ModuleUpdatePatch = Omit<
	Partial<Omit<Module, "uuid">>,
	"caseSearchConfig"
> & {
	/** Explicit null survives JSON and clears the optional search config. */
	caseSearchConfig?: Module["caseSearchConfig"] | null;
};

/**
 * The full mutation surface returned by `useBlueprintMutations()`.
 *
 * All signatures take uuids directly — no legacy (mIdx, fIdx, path)
 * resolution. Callers read uuids from `useLocation()` or direct doc
 * store subscriptions, then pass them here.
 */
export interface BlueprintMutations {
	// ── Field mutations ───────────────────────────────────────────────────
	/**
	 * Insert a new field into a parent container (form or group/repeat).
	 *
	 * Returns the minted uuid on success so callers can drive selection
	 * or navigation, and the honest rejection otherwise — never a
	 * fabricated sentinel a caller could mistake for an identity.
	 *
	 * Accepts a Field without uuid — the hook mints one via
	 * `crypto.randomUUID()`. Callers that already own a uuid (e.g. the
	 * replay stream) can pass it through the optional `uuid` field on the
	 * input object and it will be used verbatim.
	 */
	addField: <K extends FieldKind>(
		parentUuid: Uuid,
		field: { kind: K } & Omit<
			Extract<CarrierBlindField, { kind: K }>,
			"uuid" | "kind"
		> & {
				uuid?: string;
			},
		opts?: {
			afterUuid?: Uuid;
			beforeUuid?: Uuid;
			atIndex?: number;
		},
	) => AddCommitOutcome;
	/**
	 * Update fields on an existing field entity. Callers pass `undefined` for
	 * any field value to clear it — no `null` coercion needed.
	 *
	 * The signature takes the target field's `kind` as a generic parameter
	 * (`targetKind`) and types `patch` against that variant's schema-
	 * declared properties. A patch with a key the kind doesn't carry — e.g.
	 * `{ label }` against a hidden field, which has no `label` — is a
	 * compile error at the call site rather than a silently-dropped key at
	 * runtime. The reducer reads `targetKind` to discriminate the patch
	 * against the field's current kind; a patch built for a kind the field
	 * has since converted away from is treated as stale and skipped.
	 */
	updateField: <K extends FieldKind>(
		uuid: Uuid,
		targetKind: K,
		patch: FieldPatchFor<K>,
	) => CommitOutcome;
	/**
	 * Remove a field (and its subtree). `ok: false` when it didn't
	 * dispatch — an unknown uuid (empty `messages`), or the commit gate
	 * rejecting a removal that would take the app incomplete (e.g.
	 * deleting a form's only field on a complete app). Callers that
	 * follow up with selection moves gate on `ok` so the UI never
	 * deselects a field that's still there.
	 */
	removeField: (uuid: Uuid) => CommitOutcome;
	renameField: (uuid: Uuid, newId: string) => FieldRenameResult;
	moveField: (
		uuid: Uuid,
		opts: {
			toParentUuid?: Uuid;
			afterUuid?: Uuid;
			beforeUuid?: Uuid;
			toIndex?: number;
		},
	) => MoveFieldResult;
	duplicateField: (uuid: Uuid) => DuplicateFieldResult | undefined;
	/**
	 * Convert a field to a different kind atomically.
	 *
	 * Unlike the ad-hoc `saveField("kind", ...)` path it replaces, this
	 * dispatches a `convertField` mutation that runs the kind swap inside
	 * the reducer — one atomic undo entry, one clean event log entry, and
	 * the schema-driven key reconciliation handles options / validation /
	 * hint preservation per kind's Zod schema.
	 *
	 * Silently no-ops when the uuid is unknown or when the source kind
	 * equals the target kind.
	 */
	convertField: (uuid: Uuid, toKind: FieldKind) => CommitOutcome;

	// ── Form mutations ────────────────────────────────────────────────────
	/** Insert a new form into a module. Returns the minted uuid on
	 *  success, the rejection otherwise. Accepts a form without a uuid —
	 *  the hook mints one for the new entity. */
	addForm: (
		moduleUuid: Uuid,
		form: Omit<Form, "uuid"> & { uuid?: string },
	) => AddCommitOutcome;
	/**
	 * Update fields on an existing form. Patches use camelCase domain property
	 * names (e.g. `closeCondition`, `postSubmit`).
	 */
	updateForm: (uuid: Uuid, patch: Partial<Omit<Form, "uuid">>) => CommitOutcome;
	/**
	 * Set or clear form menu media via the dedicated null-carrying mutation
	 * so clears survive JSON replay.
	 */
	setFormMedia: (
		uuid: Uuid,
		media: { icon: FormIconRef | null; audioLabel: MediaAssetId | null },
	) => CommitOutcome;
	removeForm: (uuid: Uuid) => CommitOutcome;

	// ── Module mutations ──────────────────────────────────────────────────
	updateModule: (uuid: Uuid, patch: ModuleUpdatePatch) => CommitOutcome;
	/**
	 * Move one visible case-list column to its final index on Results or
	 * Details. Computes a fractional key from the freshest store snapshot and
	 * dispatches exactly one surface-specific move mutation; neighboring rows
	 * are never resequenced.
	 */
	moveColumnOnSurface: (
		moduleUuid: Uuid,
		uuid: Uuid,
		surface: CaseDisplaySurface,
		toIndex: number,
	) => CommitOutcome;
	/**
	 * Move one search field to its final index using the freshest store
	 * snapshot. Writes only the moved input's fractional key so a concurrent
	 * gesture on another input survives guarded replay.
	 */
	moveSearchInputToIndex: (
		moduleUuid: Uuid,
		uuid: Uuid,
		toIndex: number,
	) => CommitOutcome;
	/**
	 * Set or clear the module menu-tile media (home-screen `icon` +
	 * `audioLabel`) via the dedicated null-carrying mutation. Mirrors
	 * `setFormMedia`: the generic `updateModule` patch encodes a clear as
	 * `{ key: undefined }`, which `JSON.stringify` DROPS on the SSE wire —
	 * the cleared slot would never reach the client doc and the stale ref
	 * would survive. The `setModuleMedia` kind carries an explicit
	 * `MediaAssetId | null` per slot (which survives JSON) and maps `null →
	 * undefined` inside the reducer, so both set and clear round-trip.
	 */
	setModuleMedia: (
		uuid: Uuid,
		media: { icon: ModuleIconRef | null; audioLabel: MediaAssetId | null },
	) => CommitOutcome;
	removeModule: (uuid: Uuid) => CommitOutcome;

	// ── Compound creators (atomic, born-valid) ───────────────────────────
	/**
	 * Create a case-list module in one gated batch, born as a VIEWER: a
	 * `caseListOnly` module with a `Name` case-list column and NO form. A new
	 * `caseType` is declared in `doc.caseTypes` (empty properties) so the Name
	 * column's standard property resolves; the user adds a registration form
	 * afterward (which flips `caseListOnly` off). Returns the new module's uuid
	 * for navigation.
	 */
	// ── Worker information, roles, personas ──────────────────────────────
	//
	// Every one dispatches the planner from `lib/doc/userMutations.ts`, so a
	// removal's cleanup (rewriting the value bags that named a removed
	// property) and its refusal (a role personas still hold) are decided in
	// one place rather than per call site.

	/** Add a piece of worker information to the app's catalog. */
	addUserProperty: (
		property: Omit<UserProperty, "uuid" | "order">,
	) => AddCommitOutcome;
	/** Change one piece of worker information. A cleared slot is `null`. */
	updateUserProperty: (
		uuid: Uuid,
		patch: UserEntityPatch<UserProperty>,
	) => CommitOutcome;
	/** Remove a piece of worker information and every value recorded
	 *  against it, as one batch. Refused while a condition/calculation
	 *  references its stable identity. */
	removeUserProperty: (uuid: Uuid) => CommitOutcome;
	/** Read the same live preflight the removal dispatch enforces. */
	inspectUserPropertyRemoval: (uuid: Uuid) => RemoveUserPropertyPlan;

	/** Add a role. */
	addUserType: (userType: Omit<UserType, "uuid" | "order">) => AddCommitOutcome;
	/** Change a role's name, description, or default values. */
	updateUserType: (
		uuid: Uuid,
		patch: UserEntityPatch<UserType>,
	) => CommitOutcome;
	/** Set or remove one role default without replacing its sibling values. */
	updateUserTypeValue: (
		uuid: Uuid,
		userPropertyUuid: Uuid,
		value: string | undefined,
	) => CommitOutcome;
	/** Remove a role. Refused, with the personas named, while any persona
	 *  still holds it. */
	removeUserType: (uuid: Uuid) => CommitOutcome;

	/** Add a persona. */
	addPersona: (persona: Omit<Persona, "uuid" | "order">) => AddCommitOutcome;
	/** Change a persona's name, role, or value overrides. */
	updatePersona: (uuid: Uuid, patch: UserEntityPatch<Persona>) => CommitOutcome;
	/** Set or remove one persona override without replacing its siblings. */
	updatePersonaValue: (
		uuid: Uuid,
		userPropertyUuid: Uuid,
		value: string | undefined,
	) => CommitOutcome;
	/** Remove a persona. Case rows it owns are deliberately left alone. */
	removePersona: (uuid: Uuid) => CommitOutcome;

	createCaseListModule: (args: {
		caseType: string;
		name?: string;
		index?: number;
	}) => AddCommitOutcome;
	/** Create a survey/menu module (no case type) born with one survey form and
	 *  a starter question — the smallest valid module, since CommCare rejects a
	 *  menu with no forms and no case list. Returns the new module's uuid. */
	createSurveyModule: (args?: {
		name?: string;
		index?: number;
	}) => AddCommitOutcome;
	/**
	 * Create a new form of `type` in a module, born with a default first
	 * field (a `case_name` writer for registration, else a text question), in
	 * one gated batch. Flips a `caseListOnly` module to form-bearing as
	 * needed. Returns the new form's uuid for navigation.
	 */
	createForm: (
		moduleUuid: Uuid,
		type: FormType,
		index?: number,
	) => AddCommitOutcome;

	// ── App-level ─────────────────────────────────────────────────────────
	/**
	 * Combined app-level patch. Routes `app_name` and `connect_type`
	 * through a single `applyMany` so the entire patch collapses to ONE
	 * undo entry (no two-undo bug).
	 */
	updateApp: (patch: {
		app_name?: string;
		connect_type?: ConnectType | null;
	}) => CommitOutcome;
	/**
	 * Set or clear the app-level logo (the single image shown on the
	 * web-apps login + home screens) via the dedicated null-carrying
	 * mutation. The doc's `logo` slot is `.optional()`, not `.nullable()`,
	 * so a clear must DROP the key rather than store a literal `null` the
	 * schema rejects — and the SSE wire would silently lose an
	 * `undefined`-valued clear. Passing an explicit `MediaAssetId | null` (set
	 * vs clear) keeps the intent on the wire; the reducer maps `null →
	 * undefined` so the cleared key falls off the doc. Takes no uuid —
	 * the logo is a single app-level slot, so there is no entity to
	 * validate (mirrors `setCaseTypes`, not `setFormMedia`).
	 */
	setAppLogo: (logo: MediaAssetId | null) => CommitOutcome;
	setCaseTypes: (caseTypes: CaseType[] | null) => CommitOutcome;
	/**
	 * Update a single property on a case type's property list.
	 *
	 * Reads the current `caseTypes` from the doc, finds the matching case
	 * type by name and property by name, merges the updates, and dispatches
	 * a `setCaseTypes` mutation with the new array. Silently no-ops if the
	 * case type or property doesn't exist (fail-open, consistent with other
	 * mutation methods).
	 */
	updateCaseProperty: (
		caseTypeName: string,
		propertyName: string,
		updates: Partial<Omit<CaseProperty, "name">>,
	) => CommitOutcome;

	// ── Batch ─────────────────────────────────────────────────────────────
	/**
	 * Dispatch multiple mutations in a single atomic undo snapshot. Used
	 * by compound edits (rename-case-property, switch-connect-mode, etc.)
	 * that need to coordinate several doc changes without fragmenting
	 * history.
	 *
	 * Returns the reducer's per-mutation results in input order. Callers
	 * that need metadata from specific positions (`renameField`, `moveField`)
	 * destructure by index and narrow via `as FieldRenameMeta | undefined` /
	 * `as MoveFieldResult | undefined`.
	 */
	applyMany: (mutations: Mutation[]) => MutationResult[];
	/**
	 * Commit an atomic batch when the caller needs an honest success outcome
	 * before changing local UI state (for example, selecting a newly-added
	 * search row). Unlike `applyMany`, this does not expose reducer metadata.
	 */
	commitMany: (mutations: Mutation[]) => CommitOutcome;
}

/**
 * The hook's full surface: the announcing dispatch plus its `inline`
 * twin. Same methods, same gate, one difference — a rejection from an
 * `inline.*` call is NOT announced via the error toast, because the call
 * site renders the returned outcome beside the control (inline notice,
 * editor tooltip, dialog footer). One rejection, one presentation: a
 * surface that shows the finding contextually dispatches through
 * `inline`; everything else stays on the announcing flavor so a refused
 * edit can never disappear silently.
 */
export type GatedBlueprintMutations = BlueprintMutations & {
	inline: BlueprintMutations;
};

/**
 * Warning for silent no-ops.
 *
 * Every mutation method bails out silently when a uuid can't be found
 * in the current doc — matching the legacy engine's behavior, which the
 * UI relies on so stale selections don't crash the tree. We still want
 * visibility into which lookups are failing so bugs don't hide behind
 * the fail-open contract.
 *
 * `console.warn`, not the structured logger: this hook is client-only,
 * and the logger's production path writes to `process.stdout`, which
 * Next's browser process shim doesn't define — it would throw on the
 * exact degraded path (a stale selection racing an agent edit) this
 * warn exists to soften.
 */
function warnUnresolved(
	method: string,
	context: Record<string, unknown>,
): void {
	console.warn(`[useBlueprintMutations.${method}] unresolved uuid`, context);
}

/**
 * Walk from a uuid up to its owning form, joining semantic ids into a
 * slash-delimited path.
 *
 * Reads the store's already-maintained `doc.fieldParent` reverse index
 * directly — rebuilding a parallel Map here would be wasted work (the
 * index is rebuilt atomically by every mutation that touches ordering).
 *
 * Returns `undefined` when the uuid is unreachable (cycle, missing
 * field entity, or the walk never hits a form). The cycle guard is
 * defensive — a well-formed `fieldParent` cannot produce a cycle, but
 * corruption shouldn't hang the UI.
 */
function computePathForUuid(doc: BlueprintDoc, uuid: Uuid): string | undefined {
	const segments: string[] = [];
	let cursor: Uuid | undefined = uuid;
	const visited = new Set<Uuid>();
	while (cursor !== undefined) {
		if (visited.has(cursor)) return undefined;
		visited.add(cursor);
		if (doc.forms[cursor] !== undefined) {
			return segments.reverse().join("/");
		}
		const field = doc.fields[cursor];
		if (!field) return undefined;
		segments.push(field.id);
		// `fieldParent` returns `null` at the form boundary and `undefined` for
		// orphans — both terminate the walk without revisiting.
		const parent: Uuid | null | undefined = doc.fieldParent[cursor];
		cursor = parent ?? undefined;
	}
	return undefined;
}

export function useBlueprintMutations(): GatedBlueprintMutations {
	const store = useContext(BlueprintDocContext);
	if (!store) {
		throw new Error(
			"useBlueprintMutations requires a <BlueprintDocProvider> ancestor",
		);
	}

	/* The single read-only choke point. `false` for a view-only Project member
	 * (the build page resolved their role); every gated dispatch then no-ops
	 * with a view-only explanation, so no canvas affordance can mutate the doc
	 * even if its control wasn't individually hidden. The agent-stream / replay
	 * writers bypass this hook and stay unaffected — a viewer triggers neither. */
	const canEdit = useContext(BlueprintEditableContext);

	// Memoize against the store instance so the returned action object is
	// reference-stable across re-renders. A consumer storing this in a
	// useEffect dependency array sees it as unchanging for the lifetime of
	// the provider.
	return useMemo<GatedBlueprintMutations>(() => {
		// Lazy snapshot accessor — reads the freshest state at dispatch time,
		// never at hook construction. This is critical: without it, a mutation
		// made immediately after another would validate against stale state.
		const get = () => store.getState();

		/* Two flavors of the same dispatch, differing only in who PRESENTS
		 * a rejection. The default (`announce: true`) shows the findings as
		 * the error toast — the fail-safe for call sites with no contextual
		 * anchor (toggles, deletes, drag moves), where an unannounced
		 * rejection would just vanish. The `inline` flavor returns the
		 * findings without announcing, for call sites that render the
		 * outcome beside the control (the `useCommitField` notices, the
		 * editor tooltips, the Connect dialog footer) — one rejection, one
		 * presentation, never both. */
		const makeApi = (announce: boolean): BlueprintMutations => {
			/* The gated dispatch every method routes through. Runs the shared
			 * commit verdict against the freshest doc; on rejection, shows the
			 * findings and returns `undefined` so the caller maps to its no-op
			 * return shape — the batch never reaches the store. On a pass, the
			 * VALIDATED CANDIDATE commits directly (`commitDoc`) with the
			 * candidate run's own reducer results — one reducer run per
			 * dispatch, and the committed doc is exactly the doc the gate
			 * validated. The batch is then RECORDED: it is the author's
			 * un-persisted intent until the reconciler PUTs it. */
			const guardedApply = (
				mutations: Mutation[],
			):
				| { ok: true; results: MutationResult[] }
				| { ok: false; messages: string[] } => {
				/* View-only access — no user edit reaches the store. The visible
				 * affordances are already hidden for a viewer; this is the
				 * airtight backstop for any that aren't, so a stray dispatch
				 * explains itself instead of silently mutating a doc that can
				 * never persist. */
				if (!canEdit) {
					const lines = [
						"You have view-only access to this app. Ask a Project admin for edit access to make changes.",
					];
					if (announce) notifyRejectedCommit(lines);
					return { ok: false, messages: lines };
				}
				const verdict = mutationCommitVerdict(
					get(),
					mutations,
					LOOKUP_CONTEXT_UNAVAILABLE,
				);
				if (!verdict.ok) {
					// Render to the concise BUILDER copy once — both the toast
					// and the returned `CommitOutcome.messages` speak it. The
					// SA path keeps the verbose `ValidationError.message`.
					const lines = userFacingErrors(verdict.introduced);
					if (announce) notifyRejectedCommit(lines);
					return { ok: false, messages: lines };
				}
				// The candidate commits, and the batch that produced it is kept
				// verbatim. Persistence replays exactly these commands rather than
				// re-deriving them by diffing the committed document against a base.
				store.getState().commitDoc(verdict.nextDoc, mutations);
				return { ok: true, results: verdict.results };
			};

			/** Project a `guardedApply` result onto the plain commit outcome. */
			const toOutcome = (
				applied: ReturnType<typeof guardedApply>,
			): CommitOutcome => (applied.ok ? COMMITTED : applied);

			return {
				addField(parentUuid, field, opts) {
					const doc = get();
					// Verify parent exists — must be either a form or a group/repeat
					// field that can contain children.
					if (
						doc.forms[parentUuid] === undefined &&
						doc.fields[parentUuid] === undefined
					) {
						warnUnresolved("addField", { parentUuid });
						return NOOP_REJECTION;
					}

					// Resolve the requested slot (atIndex / beforeUuid / afterUuid,
					// default append) to the uuid the new field follows.
					const fieldAfter = fieldSlotAfter(doc, parentUuid, {
						index: opts?.atIndex,
						beforeUuid: opts?.beforeUuid,
						afterUuid: opts?.afterUuid,
					});

					// Mint a uuid if the caller didn't supply one. FieldTypePicker
					// and the SA tool handlers pass shapes without uuids and rely on
					// the store to generate identity.
					const maybeUuid = field.uuid;
					const uuid = asUuid(
						typeof maybeUuid === "string" && maybeUuid.length > 0
							? maybeUuid
							: crypto.randomUUID(),
					);
					// A born select field's options each need a stable uuid + order
					// key too — the per-uuid option diff skips a keyless/uuid-less
					// option, so a picker-created select (whose starter options
					// carry neither) would lose them. Same minting the SA assembly
					// uses.
					const bornOptions = withOptionUuids(
						(field as { options?: SelectOption[] }).options,
					);
					// Field is a discriminated union; the narrowed generic input is a
					// specific variant's Omit — we stamp the uuid and cast via
					// `unknown` because the distributive Omit shape doesn't round-trip
					// back to the full union narrowly (TS limitation around Omit +
					// discriminated unions). Placement rides the mutation, not the
					// entity: where a field goes is the gesture's business, not the
					// field's.
					const entity = {
						...field,
						uuid,
						...(bornOptions && { options: bornOptions }),
					} as unknown as Field;

					// Declaration chokepoint: a field writing to a type absent from
					// the catalog prepends `declareCaseType` (the reducer no longer
					// auto-creates the type — that kept it from clobbering a
					// concurrent declaration). A no-op when the type is already
					// declared or the field writes to no case.
					const declare = declareCaseTypeForField(doc, entity);

					const applied = guardedApply([
						...declare,
						{
							kind: "addField",
							parentUuid,
							field: entity,
							after: fieldAfter,
						},
					]);
					if (!applied.ok) return applied;
					return { ok: true, uuid };
				},

				updateField(uuid, targetKind, patch) {
					const doc = get();
					if (!doc.fields[uuid]) {
						warnUnresolved("updateField", { uuid, targetKind });
						return NOOP_REJECTION;
					}
					// `targetKind` + `patch` are typed against the same variant via
					// the generic, so the spread into the mutation literal lands on
					// the discriminated `updateField` arm without further narrowing.
					// The intermediate cast is required because TypeScript can't
					// match the generic `K` back to the union of literal-keyed arms
					// in `Mutation` — at the value level the shape is structurally
					// identical, but TS treats the union arms as distinct types
					// rather than a parameterized one.
					// Declaration chokepoint: a patch RE-TARGETING `case_property_on`
					// to a type absent from the catalog prepends `declareCaseType`.
					const nextType = (patch as { case_property_on?: unknown })
						.case_property_on;
					const declare =
						typeof nextType === "string" && nextType.length > 0
							? declareCaseTypeMutations(doc, nextType)
							: [];
					return toOutcome(
						guardedApply([
							...declare,
							{
								kind: "updateField",
								uuid,
								targetKind,
								patch,
							} as Mutation,
						]),
					);
				},

				removeField(uuid) {
					const doc = get();
					if (!doc.fields[uuid]) {
						warnUnresolved("removeField", { uuid });
						return NOOP_REJECTION;
					}
					return toOutcome(guardedApply([{ kind: "removeField", uuid }]));
				},

				renameField(uuid, newId) {
					const doc = get();
					const field = doc.fields[uuid];
					if (!field) {
						warnUnresolved("renameField", { uuid });
						return emptyFieldRenameResult();
					}

					// Conflict check: reject the rename before dispatching so the
					// UI can surface a "name already taken" message without
					// unwinding a half-applied mutation. The peer-aware scan (the
					// renamed field's parent plus the parent of every
					// case-property peer that cascade-renames in lockstep) lives
					// in the shared verdict module — the same definition of
					// "conflict" the UI commit guard and the SA tools consult —
					// so the store-level backstop can't drift from the surfaces
					// it backs.
					if (findRenameSiblingConflict(doc, uuid, newId) !== undefined) {
						return { ...emptyFieldRenameResult(), conflict: true };
					}

					// Dispatch via the single write path. Position `[0]` of the
					// returned array carries the reducer's per-mutation result —
					// narrow it to `FieldRenameMeta` so we can read the cascade
					// counts. The reducer returns `undefined` if the target entity
					// vanishes between our pre-check and the Immer draft —
					// defensive fallback to zero counts so callers always see a
					// valid result shape.
					const applied = guardedApply([{ kind: "renameField", uuid, newId }]);
					if (!applied.ok) {
						return { ...emptyFieldRenameResult(), rejected: applied.messages };
					}
					const meta = applied.results[0] as FieldRenameMeta | undefined;

					/* Compute the new path AFTER dispatch — the semantic id has
					 * changed. `renameField` doesn't reparent, so `fieldParent`
					 * is unchanged, but the walk needs the post-dispatch snapshot
					 * of `fields` to read the new id. */
					const after = get();
					const newPath = (computePathForUuid(after, uuid) ?? "") as FieldPath;
					return {
						newPath,
						xpathFieldsRewritten: meta?.xpathFieldsRewritten ?? 0,
						peerFieldsRenamed: meta?.peerFieldsRenamed ?? 0,
						columnsRewritten: meta?.columnsRewritten ?? 0,
						formWiringRewritten: meta?.formWiringRewritten ?? 0,
						moduleRefsRewritten: meta?.moduleRefsRewritten ?? 0,
						catalogEntryRenamed: meta?.catalogEntryRenamed ?? false,
						cascadedAcrossForms: meta?.cascadedAcrossForms ?? false,
					};
				},

				moveField(uuid, opts) {
					const doc = get();
					const field = doc.fields[uuid];
					if (!field) {
						warnUnresolved("moveField", { uuid });
						return {};
					}

					// Default destination: the field's current parent (same-parent
					// reorder). Fall back to the field's own uuid as a guard — this
					// is unreachable in practice because every field has a parent
					// entry in `fieldOrder`. Read the parent directly from the
					// store-maintained `fieldParent` reverse index (O(1)).
					const toParentUuid =
						opts.toParentUuid ?? doc.fieldParent[uuid] ?? uuid;

					// Resolve the requested slot to a landing in the destination
					// parent's sequence, excluding the moved field from the neighbour
					// set — a same-parent reorder places it among the OTHER siblings.
					const after = fieldSlotAfter(
						doc,
						toParentUuid,
						{
							index: opts.toIndex,
							beforeUuid: opts.beforeUuid,
							afterUuid: opts.afterUuid,
						},
						uuid,
					);

					// Dispatch via the single write path. Position `[0]` of the
					// returned array carries the reducer's rename metadata (populated
					// when cross-level dedup changes the id). The reducer returns
					// `undefined` if the target entity vanishes between our pre-check
					// and the Immer draft — fallback to a zeroed result so callers
					// always see a valid `MoveFieldResult`.
					const applied = guardedApply([
						{ kind: "moveField", uuid, toParentUuid, after },
					]);
					if (!applied.ok) return {};
					return (applied.results[0] as MoveFieldResult | undefined) ?? {};
				},

				duplicateField(uuid) {
					const doc = get();
					const plan = duplicateFieldMutations(doc, uuid);
					if (plan === undefined) {
						warnUnresolved("duplicateField", { uuid });
						return undefined;
					}
					if (!guardedApply(plan.mutations).ok) return undefined;

					// The clone's path is read AFTER the commit: the batch may have
					// deduped its id against a sibling, and the path is what the
					// caller navigates to.
					const after = get();
					const clone = after.fields[plan.cloneUuid];
					if (clone === undefined) return undefined;
					const parentUuid = after.fieldParent[plan.cloneUuid] ?? undefined;
					if (parentUuid === undefined) return undefined;
					const parentPath = after.forms[parentUuid]
						? "" // parent is the form root
						: (computePathForUuid(after, parentUuid) ?? "");
					const newPath = (
						parentPath ? `${parentPath}/${clone.id}` : clone.id
					) as FieldPath;

					return { newPath, newUuid: plan.cloneUuid as string };
				},

				convertField(uuid, toKind) {
					const doc = get();
					const field = doc.fields[uuid];
					if (!field) {
						// Include `toKind` so the dev-mode warn disambiguates the caller's
						// intent — a stale UI closure and a drifted SA dispatch present
						// identically without it. Matches the debug payload shape the
						// other multi-arg mutations (updateCaseProperty, etc.) use.
						warnUnresolved("convertField", { uuid, toKind });
						return NOOP_REJECTION;
					}
					const batch: Mutation[] = [];
					// Converting to hidden must land with a value source or the
					// gate rejects on HIDDEN_NO_VALUE — and this gesture has no
					// authoring step. Seed the same inert `''` default a
					// picker-inserted hidden is born with (the user authors the
					// real calculate in the inspector right after); the seed
					// lands on the SOURCE field pre-convert (its kind declares
					// `default_value`) and carries through the kind swap. A
					// field that already has a default keeps it.
					if (
						toKind === "hidden" &&
						!("default_value" in field && field.default_value) &&
						!("calculate" in field && field.calculate)
					) {
						batch.push({
							kind: "updateField",
							uuid,
							targetKind: field.kind,
							patch: { default_value: HIDDEN_INERT_DEFAULT_VALUE },
						} as Mutation);
					}
					// The property-centric plan (shared with the SA's editField):
					// a case-bound string-scalar conversion carries the
					// property's other writers across in the same batch and
					// re-declares a stale declared data_type — one field at a
					// time can never cross the agreement gate. Select targets
					// whose source has no options get the same starter pair a
					// picker-inserted select is born with, minted fresh per
					// converted field; the user renames them in the inspector.
					const plan = planKindConversion({
						doc,
						field,
						toKind,
						mintOptions: () =>
							DEFAULT_SELECT_OPTIONS.map((option) => ({
								...option,
								uuid: asUuid(crypto.randomUUID()),
							})),
					});
					if (!plan.ok) {
						const message =
							plan.blocker.carrier === "case-operation"
								? `This field's case property is also written by case operation “${plan.blocker.id}”. Update or remove that operation before changing the property's data type.`
								: `This field's case property is also captured by a ${fieldRegistry[plan.blocker.kind].label} field in another form, which can't become a ${fieldRegistry[toKind].label}. Convert that field to Text first, then convert this one.`;
						return {
							ok: false,
							messages: [message],
						};
					}
					batch.push(...plan.mutations);
					return toOutcome(guardedApply(batch));
				},

				addForm(moduleUuid, form) {
					const doc = get();
					if (!doc.modules[moduleUuid]) {
						warnUnresolved("addForm", { moduleUuid });
						return NOOP_REJECTION;
					}
					const maybeUuid = form.uuid;
					const formUuid = asUuid(
						typeof maybeUuid === "string" && maybeUuid.length > 0
							? maybeUuid
							: crypto.randomUUID(),
					);
					const applied = guardedApply([
						{
							kind: "addForm",
							moduleUuid,
							form: { ...form, uuid: formUuid } as Form,
						},
					]);
					if (!applied.ok) return applied;
					return { ok: true, uuid: formUuid };
				},

				updateForm(uuid, patch) {
					const doc = get();
					if (!doc.forms[uuid]) {
						warnUnresolved("updateForm", { uuid });
						return NOOP_REJECTION;
					}
					return toOutcome(
						guardedApply([
							{
								kind: "updateForm",
								uuid,
								patch,
							},
						]),
					);
				},

				setFormMedia(uuid, media) {
					const doc = get();
					if (!doc.forms[uuid]) {
						warnUnresolved("setFormMedia", { uuid });
						return NOOP_REJECTION;
					}
					return toOutcome(
						guardedApply([
							{
								kind: "setFormMedia",
								uuid,
								icon: media.icon,
								audioLabel: media.audioLabel,
							},
						]),
					);
				},

				removeForm(uuid) {
					const doc = get();
					if (!doc.forms[uuid]) {
						warnUnresolved("removeForm", { uuid });
						return NOOP_REJECTION;
					}
					const mutations: Mutation[] = [{ kind: "removeForm", uuid }];
					/* Removing the LAST form of a case-managing module would leave it
					 * formless+typed (`NO_FORMS_OR_CASE_LIST`). Convert it to a
					 * case-list viewer in the same batch — the inverse of
					 * `formScaffoldMutations` flipping `caseListOnly` off when the
					 * first form is added (a form-bearing case module already carries
					 * the columns a viewer needs, `MISSING_CASE_LIST_COLUMNS`). */
					const parentId = Object.keys(doc.formOrder).find((m) =>
						doc.formOrder[m]?.includes(uuid),
					);
					const parent = parentId ? doc.modules[parentId] : undefined;
					if (
						parent?.caseType &&
						!parent.caseListOnly &&
						doc.formOrder[parentId as string]?.length === 1
					) {
						mutations.push({
							kind: "updateModule",
							uuid: asUuid(parentId as string),
							patch: { caseListOnly: true },
						});
					}
					return toOutcome(guardedApply(mutations));
				},

				updateModule(uuid, patch) {
					const doc = get();
					if (!doc.modules[uuid]) {
						warnUnresolved("updateModule", { uuid });
						return NOOP_REJECTION;
					}
					/* A case-type change (or clear — the key present, value
					 * undefined) can orphan the OLD type's record; the shared
					 * planner retires it in the same batch or rejects naming what
					 * still references it. Same cascade the SA's `updateModule`
					 * tool runs — every surface inherits it identically. */
					const retirement: CaseTypeRetirement =
						"caseType" in patch
							? planCaseTypeRetirementOnRetype(doc, uuid, patch.caseType)
							: { kind: "none" };
					if (retirement.kind === "blocked") {
						if (announce) notifyRejectedCommit([retirement.userMessage]);
						return { ok: false, messages: [retirement.userMessage] };
					}
					/* ONE catalog write covers both the retirement of the orphaned
					 * old type and the declaration of a brand-new one (re-typing a
					 * viewer to a fresh type does both at once). A brand-new type
					 * must be cataloged or the seeded `Name` column can't resolve
					 * (`CASE_LIST_COLUMN_UNKNOWN_FIELD`); composing into one
					 * `setCaseTypes` stops the two wholesale writes from clobbering
					 * each other. */
					const moduleMutations = modulePatchMutations(
						doc.modules[uuid],
						patch,
					);
					return toOutcome(
						guardedApply([
							...caseTypeCatalogMutations(doc, retirement, patch.caseType),
							...moduleMutations,
						]),
					);
				},

				moveColumnOnSurface(moduleUuid, uuid, surface, toIndex) {
					const doc = get();
					const config = doc.modules[moduleUuid]?.caseListConfig;
					if (!config?.columns.some((column) => column.uuid === uuid)) {
						warnUnresolved("moveColumnOnSurface", {
							moduleUuid,
							uuid,
							surface,
						});
						return NOOP_REJECTION;
					}
					// The requested index counts the surface's VISIBLE rows, which is
					// what the author sees; the sequence holds hidden ones too, so the
					// landing is expressed against the full sequence.
					const sequence =
						surface === "list"
							? config.listColumnOrder
							: config.detailColumnOrder;
					const visible = sequence.filter((columnUuid) => {
						const column = config.columns.find((c) => c.uuid === columnUuid);
						if (column === undefined) return false;
						return surface === "list"
							? column.visibleInList !== false
							: column.visibleInDetail !== false;
					});
					const others = visible.filter((columnUuid) => columnUuid !== uuid);
					const clamped = Math.max(0, Math.min(toIndex, others.length));
					const after = clamped === 0 ? null : (others[clamped - 1] ?? null);
					// Already there: no mutation, so no undo or autosave entry.
					const currentAfter = (() => {
						const at = sequence.indexOf(uuid);
						return at <= 0 ? null : sequence[at - 1];
					})();
					if (after === currentAfter) return COMMITTED;
					return toOutcome(
						guardedApply([
							{ kind: "moveColumn", moduleUuid, uuid, surface, after },
						]),
					);
				},

				moveSearchInputToIndex(moduleUuid, uuid, toIndex) {
					const doc = get();
					const inputs = doc.modules[moduleUuid]?.caseListConfig?.searchInputs;
					if (!inputs?.some((input) => input.uuid === uuid)) {
						warnUnresolved("moveSearchInputToIndex", { moduleUuid, uuid });
						return NOOP_REJECTION;
					}
					const others = inputs
						.map((input) => input.uuid)
						.filter((inputUuid) => inputUuid !== uuid);
					const clamped = Math.max(0, Math.min(toIndex, others.length));
					const after = clamped === 0 ? null : (others[clamped - 1] ?? null);
					const at = inputs.findIndex((input) => input.uuid === uuid);
					const currentAfter = at <= 0 ? null : inputs[at - 1].uuid;
					if (after === currentAfter) return COMMITTED;
					return toOutcome(
						guardedApply([
							{ kind: "moveSearchInput", moduleUuid, uuid, after },
						]),
					);
				},

				setModuleMedia(uuid, media) {
					const doc = get();
					if (!doc.modules[uuid]) {
						warnUnresolved("setModuleMedia", { uuid });
						return NOOP_REJECTION;
					}
					return toOutcome(
						guardedApply([
							{
								kind: "setModuleMedia",
								uuid,
								icon: media.icon,
								audioLabel: media.audioLabel,
							},
						]),
					);
				},

				removeModule(uuid) {
					const doc = get();
					if (!doc.modules[uuid]) {
						warnUnresolved("removeModule", { uuid });
						return NOOP_REJECTION;
					}
					/* When this module is the last owner of its case-type record,
					 * the same batch retires the record — or the removal rejects
					 * naming what still references the type. Same cascade the SA's
					 * `removeModule` tool runs (`lib/doc/caseTypeRetirement.ts`). */
					const retirement = planCaseTypeRetirementOnRemove(doc, uuid);
					if (retirement.kind === "blocked") {
						if (announce) notifyRejectedCommit([retirement.userMessage]);
						return { ok: false, messages: [retirement.userMessage] };
					}
					return toOutcome(
						guardedApply([
							{ kind: "removeModule", uuid },
							...(retirement.kind === "retire" ? retirement.mutations : []),
						]),
					);
				},

				addUserProperty(property) {
					const uuid = asUuid(crypto.randomUUID());
					const applied = guardedApply(
						addUserPropertyMutations(get(), uuid, property),
					);
					if (!applied.ok) return applied;
					return { ok: true, uuid };
				},

				updateUserProperty(uuid, patch) {
					if (ownRecordValue(get().userProperties, uuid) === undefined) {
						warnUnresolved("updateUserProperty", { uuid });
						return NOOP_REJECTION;
					}
					return toOutcome(
						guardedApply([{ kind: "updateUserProperty", uuid, patch }]),
					);
				},

				removeUserProperty(uuid) {
					const doc = get();
					if (ownRecordValue(doc.userProperties, uuid) === undefined) {
						warnUnresolved("removeUserProperty", { uuid });
						return NOOP_REJECTION;
					}
					const plan = removeUserPropertyPlan(doc, uuid);
					if (!plan.ok) {
						if (announce) notifyRejectedCommit([plan.userMessage]);
						return { ok: false, messages: [plan.userMessage] };
					}
					return toOutcome(guardedApply(plan.mutations));
				},

				inspectUserPropertyRemoval(uuid) {
					return removeUserPropertyPlan(get(), uuid);
				},

				addUserType(userType) {
					const uuid = asUuid(crypto.randomUUID());
					const applied = guardedApply(
						addUserTypeMutations(get(), uuid, userType),
					);
					if (!applied.ok) return applied;
					return { ok: true, uuid };
				},

				updateUserType(uuid, patch) {
					const doc = get();
					if (ownRecordValue(doc.userTypes, uuid) === undefined) {
						warnUnresolved("updateUserType", { uuid });
						return NOOP_REJECTION;
					}
					const planned = updateUserTypeMutations(doc, uuid, patch);
					if (planned.length === 0) return COMMITTED;
					return toOutcome(guardedApply(planned));
				},

				updateUserTypeValue(uuid, userPropertyUuid, value) {
					const doc = get();
					if (ownRecordValue(doc.userTypes, uuid) === undefined) {
						warnUnresolved("updateUserTypeValue", { uuid });
						return NOOP_REJECTION;
					}
					const planned = updateUserTypeValueMutations(
						doc,
						uuid,
						userPropertyUuid,
						value,
					);
					if (planned.length === 0) return COMMITTED;
					return toOutcome(guardedApply(planned));
				},

				removeUserType(uuid) {
					const doc = get();
					if (ownRecordValue(doc.userTypes, uuid) === undefined) {
						warnUnresolved("removeUserType", { uuid });
						return NOOP_REJECTION;
					}
					const plan = removeUserTypePlan(doc, uuid);
					if (!plan.ok) {
						/* A held role is a dependency refusal, not a gate finding —
						 * announce it the same way so the author sees one voice. */
						const lines = [plan.userMessage];
						if (announce) notifyRejectedCommit(lines);
						return { ok: false, messages: lines };
					}
					return toOutcome(guardedApply(plan.mutations));
				},

				addPersona(persona) {
					const uuid = asUuid(crypto.randomUUID());
					const applied = guardedApply(
						addPersonaMutations(get(), uuid, persona),
					);
					if (!applied.ok) return applied;
					return { ok: true, uuid };
				},

				updatePersona(uuid, patch) {
					const doc = get();
					if (ownRecordValue(doc.personas, uuid) === undefined) {
						warnUnresolved("updatePersona", { uuid });
						return NOOP_REJECTION;
					}
					const planned = updatePersonaMutations(doc, uuid, patch);
					if (planned.length === 0) return COMMITTED;
					return toOutcome(guardedApply(planned));
				},

				updatePersonaValue(uuid, userPropertyUuid, value) {
					const doc = get();
					if (ownRecordValue(doc.personas, uuid) === undefined) {
						warnUnresolved("updatePersonaValue", { uuid });
						return NOOP_REJECTION;
					}
					const planned = updatePersonaValueMutations(
						doc,
						uuid,
						userPropertyUuid,
						value,
					);
					if (planned.length === 0) return COMMITTED;
					return toOutcome(guardedApply(planned));
				},

				removePersona(uuid) {
					if (ownRecordValue(get().personas, uuid) === undefined) {
						warnUnresolved("removePersona", { uuid });
						return NOOP_REJECTION;
					}
					return toOutcome(guardedApply(removePersonaMutations(uuid)));
				},

				createCaseListModule({ caseType, name, index }) {
					const { mutations, moduleUuid } = caseListModuleMutations(get(), {
						caseType,
						...(name !== undefined && { name }),
						...(index !== undefined && { index }),
					});
					const applied = guardedApply(mutations);
					if (!applied.ok) return applied;
					return { ok: true, uuid: moduleUuid };
				},

				createSurveyModule(args) {
					const { mutations, moduleUuid } = surveyModuleMutations(
						get(),
						args ?? {},
					);
					const applied = guardedApply(mutations);
					if (!applied.ok) return applied;
					return { ok: true, uuid: moduleUuid };
				},

				createForm(moduleUuid, type, index) {
					const doc = get();
					if (!doc.modules[moduleUuid]) {
						warnUnresolved("createForm", { moduleUuid });
						return NOOP_REJECTION;
					}
					const scaffold = formScaffoldMutations(doc, moduleUuid, type, index);
					if (!scaffold) return NOOP_REJECTION;
					const applied = guardedApply(scaffold.mutations);
					if (!applied.ok) return applied;
					return { ok: true, uuid: scaffold.formUuid };
				},

				updateApp(patch) {
					// Collapse the combined patch into a single `applyMany` so the store
					// records exactly one undo entry. Dispatching `setAppName` and
					// `setConnectType` individually would produce TWO undo entries per
					// call — the user would have to hit ctrl-z twice to roll back a
					// single "Rename + toggle" edit.
					const mutations: Mutation[] = [];
					if (patch.app_name !== undefined) {
						mutations.push({ kind: "setAppName", name: patch.app_name });
					}
					if (patch.connect_type !== undefined) {
						// ConnectType | null is the narrower type; null means "connect
						// disabled" (absent connect_type in the blueprint schema).
						mutations.push({
							kind: "setConnectType",
							connectType: patch.connect_type,
						});
					}
					if (mutations.length === 0) return COMMITTED;
					return toOutcome(guardedApply(mutations));
				},

				setAppLogo(logo) {
					// No uuid to validate — the logo is a single app-level slot, so
					// this mirrors `setCaseTypes` (bare dispatch) rather than the
					// entity-guarded `setFormMedia` / `setModuleMedia`. The payload
					// carries an explicit `MediaAssetId | null`; the reducer maps `null →
					// undefined` so a clear drops the optional key off the doc.
					return toOutcome(guardedApply([{ kind: "setAppLogo", logo }]));
				},

				setCaseTypes(caseTypes) {
					return toOutcome(guardedApply([{ kind: "setCaseTypes", caseTypes }]));
				},

				updateCaseProperty(caseTypeName, propertyName, updates) {
					const doc = get();
					const currentCaseTypes = doc.caseTypes;
					if (!currentCaseTypes) {
						warnUnresolved("updateCaseProperty", {
							caseTypeName,
							propertyName,
						});
						return NOOP_REJECTION;
					}
					const ctIndex = currentCaseTypes.findIndex(
						(ct) => ct.name === caseTypeName,
					);
					if (ctIndex === -1) {
						warnUnresolved("updateCaseProperty", {
							caseTypeName,
							reason: "case type not found",
						});
						return NOOP_REJECTION;
					}
					const ct = currentCaseTypes[ctIndex];
					const propIndex = ct.properties.findIndex(
						(p) => p.name === propertyName,
					);
					if (propIndex === -1) {
						warnUnresolved("updateCaseProperty", {
							caseTypeName,
							propertyName,
							reason: "property not found",
						});
						return NOOP_REJECTION;
					}
					// Build a new caseTypes array with the updated property. Immutable
					// construction avoids mutating the Immer-frozen snapshot.
					const nextCaseTypes = currentCaseTypes.map((caseType, i) => {
						if (i !== ctIndex) return caseType;
						return {
							...caseType,
							properties: caseType.properties.map((p, j) =>
								j === propIndex ? { ...p, ...updates } : p,
							),
						};
					});
					return toOutcome(
						guardedApply([{ kind: "setCaseTypes", caseTypes: nextCaseTypes }]),
					);
				},

				applyMany(mutations) {
					// Batch dispatch — the store's `applyMany` wraps the whole set
					// in one `set()` call so the whole patch is one history entry.
					// Returns the reducer's per-mutation results in input order;
					// surfaced here so callers can narrow specific positions. A
					// gate rejection returns an empty array (positional reads see
					// `undefined`, the same shape a no-op reducer produces).
					const applied = guardedApply(mutations);
					return applied.ok ? applied.results : [];
				},

				commitMany(mutations) {
					return toOutcome(guardedApply(mutations));
				},
			};
		};

		return { ...makeApi(true), inline: makeApi(false) };
	}, [store, canEdit]);
}
