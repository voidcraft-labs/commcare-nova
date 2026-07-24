// lib/case-store/postgres/submissionEnvelope.ts
//
// The atomic submission envelope's executor — the in-transaction half
// of `CaseStore.applySubmission`. The store method owns the outer
// transaction and lock order (authorize → relationship advisory →
// schema locks); this module owns the operation program's execution
// model, which mirrors the XForm emission in `lib/commcare/xform/
// caseOps.ts` phase for phase:
//
//   1. **Expand** the authored operations over the physical
//      multiplicity scopes: the root scope first, then each repeat
//      scope iteration-major — JavaRosa's document-order walk of the
//      submitted instance.
//   2. **Allocate** every create identity in TypeScript before any
//      evaluation: generated ids mint `uuidv7()`; authored keys run
//      `deriveAuthoredCaseId` (the same versioned contract the XForm
//      calculate implements) with blank/over-length outcomes held
//      until the instance is known to execute.
//   3. **Evaluate** conditions, then values and runtime targets,
//      through the AST→Kysely compiler — the case store's only
//      evaluator — anchored on the loaded session case. Everything
//      evaluates against the pre-submission snapshot: the app's
//      relationship advisory lock serializes every actor writer, and
//      no envelope DML runs until evaluation completes, so the rows
//      the SELECTs see are exactly the casedb snapshot the device's
//      calculates see.
//   4. **Resolve + reauthorize** targets: `session` is the loaded
//      case; `op` reads the allocation record; `expression` results
//      load tenant-bound and revalidate through
//      `validateCaseOperationTargetDescriptor` against the immutable
//      snapshot type. The whole resolved sequence then re-proves
//      rolling type safety with
//      `validateResolvedCaseOperationTypeSequence` before any write.
//   5. **Apply effects** in physical order — per operation: create →
//      property writes → rename/retype → close → links — then the
//      ordinary form action last, matching the wire where advanced
//      blocks precede the ordinary `FormActions` block.
//
// Every rejection is pre-effect for the rejected fact and the store's
// transaction rolls the whole envelope back, so partial success is
// unobservable.

import type { Transaction } from "kysely";
import { expressionBuilder, sql } from "kysely";
import { v7 as uuidv7 } from "uuid";
import {
	type CaseOperation,
	type CasePropertyDataType,
	casePropertyDataTypes,
	deriveAuthoredCaseId,
	prepareCaseOperationTextValue,
	type Uuid,
} from "@/lib/domain";
import {
	compilerBugMessage,
	unhandledKindMessage,
} from "@/lib/domain/predicate/errors";
import type { Predicate, ValueExpression } from "@/lib/domain/predicate/types";
import {
	type ResolvedCaseOperationTypeStep,
	validateCaseOperationTargetDescriptor,
	validateResolvedCaseOperationTypeSequence,
} from "../caseOperationTargets";
import {
	CaseNotFoundError,
	CasePropertiesValidationError,
	SubmissionRejectedError,
} from "../errors";
import {
	compileExpression,
	compilePredicate,
	expressionContextFor,
	type PredicateCompileContext,
} from "../sql";
import type { FormFieldBindingValue, TermBindings } from "../sql/compileTerm";
import type { Database, JsonObject, JsonValue } from "../sql/database";
import type { CaseUpdate } from "../store";
import type {
	ApplySubmissionArgs,
	CaseOperationProgram,
	EnvelopeCaseOperation,
	OperationEffectRecord,
	SubmissionCaseSeed,
	SubmissionEnvelopeResult,
} from "../submission";

/**
 * The store internals the executor borrows — narrow closures so the
 * store's private validator cache, merge/shed update core, and close
 * core stay private to `store.ts` while the envelope reuses them
 * verbatim (one merge semantic, one lifecycle write, whoever calls).
 */
export interface SubmissionEnvelopeHost {
	readonly projectId: string;
	readonly actorUserId: string;
	/** Throws `CasePropertiesValidationError` / `SchemaNotSyncedError`. */
	validateProperties(
		trx: Transaction<Database>,
		args: { appId: string; caseType: string; properties: JsonObject },
	): Promise<void>;
	/** The schema row's declared property names — the retype shed's
	 * source-side orphan proof. */
	declaredProperties(
		trx: Transaction<Database>,
		appId: string,
		caseType: string,
	): Promise<ReadonlySet<string>>;
	/** Single-row insert core: validation, creation stamps, parent
	 * edge — with the envelope's explicit id and owner override. */
	insertCase(
		trx: Transaction<Database>,
		args: {
			appId: string;
			seed: {
				caseType: string;
				caseName: string;
				properties: JsonObject;
				parentCaseId?: string;
			};
			caseId?: string;
			ownerId?: string;
		},
	): Promise<string>;
	/** The merge + orphan-shed + validate + stamp update core. */
	updateCase(
		trx: Transaction<Database>,
		args: { appId: string; caseId: string; patch: CaseUpdate },
	): Promise<void>;
	/** The canonical lifecycle close (idempotent, repairs status). */
	closeCase(
		trx: Transaction<Database>,
		args: { appId: string; caseId: string },
	): Promise<void>;
}

// ---------------------------------------------------------------
// Physical expansion
// ---------------------------------------------------------------

interface PhysicalInstance {
	readonly envelope: EnvelopeCaseOperation;
	readonly scopeRepeat: Uuid | undefined;
	readonly iteration: number;
	readonly formFields: ReadonlyMap<Uuid, FormFieldBindingValue>;
}

/**
 * Expand authored `(order, uuid)` sequence over the physical scopes:
 * for each scope in wire document order, for each live iteration, the
 * scope's operations in authored order. The caller supplies scopes in
 * wire order (root first, repeats in post-order traversal); the
 * executor trusts the ORDER but verifies the structure so a malformed
 * program fails loudly instead of silently dropping operations.
 */
function expandPhysicalInstances(
	program: CaseOperationProgram,
): PhysicalInstance[] {
	const seenScopes = new Set<string>();
	for (const scope of program.scopes) {
		const key = scope.repeat ?? "";
		if (seenScopes.has(key)) {
			throw new Error(
				compilerBugMessage({
					where: "case-store.submissionEnvelope.expandPhysicalInstances",
					invariant: `the operation program carries two scope entries for ${scope.repeat === undefined ? "the root scope" : `repeat \`${scope.repeat}\``}`,
					detail:
						"Each multiplicity scope appears exactly once, carrying every live iteration. Hint: the caller assembles scopes from the form's repeat structure — deduplicate before building the program.",
				}),
			);
		}
		seenScopes.add(key);
	}

	const instances: PhysicalInstance[] = [];
	for (const scope of program.scopes) {
		const scopeOperations = program.operations.filter(
			(entry) => entry.operation.forEach?.repeat === scope.repeat,
		);
		if (scopeOperations.length === 0) continue;
		for (const [iteration, bindings] of scope.iterations.entries()) {
			for (const entry of scopeOperations) {
				instances.push({
					envelope: entry,
					scopeRepeat: scope.repeat,
					iteration,
					formFields: bindings.formFields,
				});
			}
		}
	}

	const covered = new Set(program.scopes.map((scope) => scope.repeat ?? ""));
	for (const entry of program.operations) {
		const key = entry.operation.forEach?.repeat ?? "";
		if (!covered.has(key)) {
			throw new Error(
				compilerBugMessage({
					where: "case-store.submissionEnvelope.expandPhysicalInstances",
					invariant: `operation \`${entry.operation.uuid}\` names ${key === "" ? "the root scope" : `repeat \`${key}\``}, but the program carries no matching scope entry`,
					detail:
						"Every operation's multiplicity scope must arrive with its iteration bindings, even when zero iterations are live (an empty `iterations` array). Hint: the caller derives scopes from `caseOperationMultiplicityScopes` plus the engine's live repeat counts.",
				}),
			);
		}
	}
	return instances;
}

// ---------------------------------------------------------------
// Identity allocation
// ---------------------------------------------------------------

interface CreateAllocation {
	readonly caseId: string;
	readonly authored: boolean;
	/** Held key failure — thrown only if the instance turns out to
	 * execute, mirroring the wire where an irrelevant block's
	 * calculate never runs. */
	readonly keyFailure?: {
		readonly reason: "blank" | "too-long";
		readonly maxKeyLength: number;
	};
}

/**
 * Mint every create instance's identity up front, in TypeScript, so
 * allocation records exist before any expression evaluates — `op`
 * targets and `id-of` leaves read this record, never the database.
 */
function allocateCreateIdentities(
	appId: string,
	program: CaseOperationProgram,
	instances: readonly PhysicalInstance[],
): Map<number, CreateAllocation> {
	const allocations = new Map<number, CreateAllocation>();
	for (const [index, instance] of instances.entries()) {
		const operation = instance.envelope.operation;
		if (operation.action !== "create" || operation.target.kind !== "new") {
			continue;
		}
		if (operation.target.idFrom === undefined) {
			allocations.set(index, { caseId: uuidv7(), authored: false });
			continue;
		}
		const rawKey = instance.formFields.get(operation.target.idFrom);
		const key = typeof rawKey === "string" ? rawKey : "";
		const derived = deriveAuthoredCaseId(
			{
				appId,
				formUuid: program.formUuid,
				operationUuid: operation.uuid,
				caseType: operation.caseType,
			},
			key,
		);
		allocations.set(
			index,
			derived.ok
				? { caseId: derived.caseId, authored: true }
				: {
						caseId: "",
						authored: true,
						keyFailure: {
							reason: derived.reason,
							maxKeyLength: derived.maxKeyLength,
						},
					},
		);
	}
	return allocations;
}

/**
 * The `id-of` / `op`-target allocation record one instance may read:
 * every root create, plus same-scope creates of the SAME iteration.
 * A repeated create's id never escapes its iteration — the authoring
 * gate enforces the correlation, and an uncorrelated reference here
 * surfaces as the compiler's missing-binding invariant.
 */
function operationIdsFor(
	instances: readonly PhysicalInstance[],
	allocations: ReadonlyMap<number, CreateAllocation>,
	consumerIndex: number,
): ReadonlyMap<Uuid, string> {
	const consumer = instances[consumerIndex];
	if (consumer === undefined) return new Map();
	const ids = new Map<Uuid, string>();
	for (const [index, allocation] of allocations) {
		// Only creates EARLIER in physical order resolve — the wire binds
		// `priorCreates` in document order, so a forward `id-of` reads
		// blank on device and must not resolve here either.
		if (index >= consumerIndex) continue;
		const producer = instances[index];
		if (producer === undefined) continue;
		const correlated =
			producer.scopeRepeat === undefined ||
			(producer.scopeRepeat === consumer.scopeRepeat &&
				producer.iteration === consumer.iteration);
		if (correlated)
			ids.set(producer.envelope.operation.uuid, allocation.caseId);
	}
	return ids;
}

// ---------------------------------------------------------------
// In-transaction expression evaluation
// ---------------------------------------------------------------

interface SessionAnchor {
	readonly caseId: string;
	readonly caseType: string;
}

interface EvalRequest {
	/** Physical instance index the projection belongs to. */
	readonly instance: number;
	readonly expression?: ValueExpression;
	readonly predicate?: Predicate;
}

/**
 * Evaluate a batch of expressions/predicates in one SELECT anchored on
 * the pre-submission session row (or anchor-free when the form loads
 * no case). Each projection compiles with ITS OWN instance's bindings
 * — parameters embed per expression, so one statement carries many
 * iterations' evaluations. Chunked well below Postgres's 1664-column
 * result cap.
 */
async function evaluateBatch(
	trx: Transaction<Database>,
	host: SubmissionEnvelopeHost,
	appId: string,
	program: CaseOperationProgram,
	session: SessionAnchor | undefined,
	bindingsFor: (instance: number) => TermBindings,
	requests: readonly EvalRequest[],
): Promise<unknown[]> {
	const results: unknown[] = new Array(requests.length);
	const CHUNK = 400;
	for (let start = 0; start < requests.length; start += CHUNK) {
		const chunk = requests.slice(start, start + CHUNK);
		const eb = expressionBuilder<Database, "cases">();
		const selections = chunk.map((request, offset) => {
			const alias = `e${offset}`;
			const ctx: PredicateCompileContext = {
				db: trx,
				appId,
				projectId: host.projectId,
				anchorAlias: "c",
				...(session === undefined ? {} : { currentCaseType: session.caseType }),
				caseTypeSchemas: program.caseTypeSchemas,
				bindings: bindingsFor(request.instance),
			};
			if (request.predicate !== undefined) {
				return eb
					.case()
					.when(compilePredicate(request.predicate, ctx))
					.then(true)
					.else(false)
					.end()
					.as(alias);
			}
			if (request.expression !== undefined) {
				return compileExpression(
					request.expression,
					expressionContextFor(ctx),
				).as(alias);
			}
			throw new Error(
				compilerBugMessage({
					where: "case-store.submissionEnvelope.evaluateBatch",
					invariant:
						"an evaluation request carried neither expression nor predicate",
					detail:
						"Each request is exactly one of the two shapes; the projection builders in this module construct them. Hint: an empty request indicates a builder emitted a placeholder without content.",
				}),
			);
		});
		const row =
			session === undefined
				? await trx.selectNoFrom(selections).executeTakeFirst()
				: await trx
						.selectFrom("cases as c")
						.select(selections)
						.where("c.app_id", "=", appId)
						.where("c.case_id", "=", session.caseId)
						.where("c.project_id", "=", host.projectId)
						.executeTakeFirst();
		if (row === undefined) {
			// The session row vanished between the snapshot load and this
			// SELECT — impossible while the app's relationship advisory
			// lock serializes actor writers; treat as the ordinary
			// not-found so the caller's typed arm fires.
			throw new CaseNotFoundError(session?.caseId ?? "");
		}
		const record = row as Record<string, unknown>;
		for (let offset = 0; offset < chunk.length; offset++) {
			results[start + offset] = record[`e${offset}`];
		}
	}
	return results;
}

// ---------------------------------------------------------------
// Evaluated-value → storage conversion
// ---------------------------------------------------------------

/**
 * Convert one pg-deserialized evaluation result into the JSON storage
 * shape the destination property's data type expects — the executor's
 * explicit multi-select/temporal/numeric serialization boundary. The
 * row's AJV validation (against the destination type's schema) remains
 * the authority; this conversion only maps driver shapes (a `Date`, a
 * numeric string) onto the canonical stored lexical forms.
 *
 * `undefined` means BLANK: the wire's calculate writes the empty
 * string for an absent/blank source, and Nova's storage convention
 * projects that state as key-absent (the same two-state collapse form
 * completion applies — typed properties cannot hold `''`, and
 * `is-blank` reads absent and empty identically). The caller turns
 * `undefined` into a key OMISSION on create and a key REMOVAL on
 * update, so a blank overwrite still clears the stored value exactly
 * as the device's `''` write does.
 */
export function storageValueFromEvaluation(
	value: unknown,
	dataType: CasePropertyDataType,
): JsonValue | undefined {
	if (
		value === null ||
		value === undefined ||
		value === "" ||
		(Array.isArray(value) && value.length === 0)
	) {
		return undefined;
	}
	switch (dataType) {
		case "multi_select": {
			if (Array.isArray(value)) return value.map((entry) => String(entry));
			throw new Error(
				compilerBugMessage({
					where: "case-store.submissionEnvelope.storageValueFromEvaluation",
					invariant: `a multi-select write evaluated to a non-array ${typeof value}`,
					detail:
						"Directional storage assignment admits only a real multi-select answer for a multi-select property, and the term compiler serializes that binding as a JSONB array. A scalar arriving here means the type checker's directional gate was bypassed upstream.",
				}),
			);
		}
		case "int":
		case "decimal": {
			return typeof value === "number" ? value : Number(String(value));
		}
		case "date": {
			if (value instanceof Date) {
				// node-postgres parses a `date` column in LOCAL time; read
				// the local calendar parts back so the stored lexical day
				// is the day Postgres emitted, whatever the process zone.
				const y = value.getFullYear();
				const m = `${value.getMonth() + 1}`.padStart(2, "0");
				const d = `${value.getDate()}`.padStart(2, "0");
				return `${y}-${m}-${d}`;
			}
			return String(value);
		}
		case "datetime": {
			if (value instanceof Date) return value.toISOString();
			return String(value);
		}
		case "time": {
			const text = String(value);
			// Canonical stored time is RFC 3339 full-time; a bare
			// `HH:MM:SS` from a pg `time` cast reads as UTC, the same
			// stance the migration cast engine takes.
			return /(?:Z|[+-]\d{2}:\d{2})$/.test(text) ? text : `${text}Z`;
		}
		case "text":
		case "single_select":
		case "geopoint": {
			if (value instanceof Date) return value.toISOString();
			if (Array.isArray(value)) return value.map(String).join(" ");
			return String(value);
		}
		default: {
			const _exhaustive: never = dataType;
			throw new Error(
				unhandledKindMessage({
					where: "case-store.submissionEnvelope.storageValueFromEvaluation",
					family: "CasePropertyDataType",
					received: _exhaustive,
					knownKinds: [...casePropertyDataTypes],
				}),
			);
		}
	}
}

/** Coerce an evaluated scalar to the text the wire's calculate would
 * produce — the shape names, owners, keys, and target ids ride. */
function evaluatedText(value: unknown): string {
	if (value === null || value === undefined) return "";
	if (value instanceof Date) return value.toISOString();
	return String(value);
}

// ---------------------------------------------------------------
// The executor
// ---------------------------------------------------------------

interface ResolvedInstance {
	readonly instance: PhysicalInstance;
	readonly index: number;
	readonly executed: boolean;
	/** Concrete resolved target id ("" only when skipped). */
	readonly caseId: string;
	/** Pre-submission type of an existing target row, absent for a
	 * fresh create. */
	readonly snapshotCaseType?: string;
	/** True when an authored-key create resolved to an existing row —
	 * the create-of-existing merge arm. */
	readonly mergesExisting: boolean;
	readonly preparedName?: string;
	readonly preparedRename?: string;
	readonly preparedOwner?: string;
	/** Executing writes only, in authored order, storage-converted
	 * against the operation's RESULT type (retype destination when the
	 * operation retypes — the wire applies writes and the type change in
	 * one block, so writes are destination-typed). A `value` of
	 * `undefined` is the wire's blank write: the key is omitted on
	 * create and REMOVED from the stored document on update. */
	readonly writes: ReadonlyArray<{
		property: string;
		value: JsonValue | undefined;
	}>;
	readonly links: ReadonlyArray<ResolvedLink>;
}

interface ResolvedLink {
	readonly identifier: string;
	readonly relationship: "child" | "extension";
	readonly targetType: string;
	/** Null = remove the identifier's edge. */
	readonly targetCaseId: string | null;
	readonly snapshotCaseType?: string;
}

export async function executeSubmissionEnvelope(
	trx: Transaction<Database>,
	host: SubmissionEnvelopeHost,
	args: ApplySubmissionArgs,
): Promise<SubmissionEnvelopeResult> {
	const operationRecords: OperationEffectRecord[] = [];
	let resolved: ResolvedInstance[] = [];

	if (args.operations !== undefined && args.operations.operations.length > 0) {
		resolved = await resolveOperationProgram(
			trx,
			host,
			args.appId,
			args.operations,
			args.ordinary,
		);
		for (const entry of resolved) {
			operationRecords.push({
				operationUuid: entry.instance.envelope.operation.uuid,
				iteration: entry.instance.iteration,
				action: entry.instance.envelope.operation.action,
				caseId: entry.caseId,
				executed: entry.executed,
			});
		}
		await applyOperationEffects(trx, host, args.appId, resolved);
	}

	const ordinary = await applyOrdinaryAction(trx, host, args.appId, args);
	return { ...ordinary, operations: operationRecords };
}

/** Phases 1–4: expand, allocate, evaluate, resolve, and prove the
 * program — everything before the first effect. */
async function resolveOperationProgram(
	trx: Transaction<Database>,
	host: SubmissionEnvelopeHost,
	appId: string,
	program: CaseOperationProgram,
	ordinary: ApplySubmissionArgs["ordinary"],
): Promise<ResolvedInstance[]> {
	const instances = expandPhysicalInstances(program);
	const allocations = allocateCreateIdentities(appId, program, instances);

	// The pre-submission session anchor. Loaded first (and inside the
	// transaction, after the advisory lock) so every evaluation and
	// descriptor below reads one immutable snapshot.
	const session = await loadSessionAnchor(trx, host, appId, program);

	const bindingsFor = (index: number): TermBindings => {
		const instance = instances[index];
		if (instance === undefined) {
			throw new Error(
				compilerBugMessage({
					where: "case-store.submissionEnvelope.resolveOperationProgram",
					invariant: `evaluation requested bindings for unknown instance ${index}`,
					detail:
						"Binding requests are built from the same instance list they index into; an out-of-range index is a builder bug in this module.",
				}),
			);
		}
		return {
			formFields: instance.formFields,
			operationIds: operationIdsFor(instances, allocations, index),
			actingUserId: host.actorUserId,
			...(program.sessionUser === undefined
				? {}
				: { sessionUser: program.sessionUser }),
			sessionUserFallback: "",
			...(program.sessionContext === undefined
				? {}
				: { sessionContext: program.sessionContext }),
			...(program.viewerTimeZone === undefined
				? {}
				: { viewerTimeZone: program.viewerTimeZone }),
		};
	};

	// Phase: conditions. Inherited guards AND the operation's own
	// condition, each evaluated with the INSTANCE's bindings — a
	// consumer inside a repeat evaluates its producer's guard against
	// its own iteration, exactly as the emitted wrapper relevance does.
	const conditionRequests: EvalRequest[] = [];
	const conditionSlots: Array<{ instance: number; count: number }> = [];
	for (const [index, instance] of instances.entries()) {
		const predicates = [
			...instance.envelope.guardConditions,
			...(instance.envelope.operation.condition === undefined
				? []
				: [instance.envelope.operation.condition]),
		];
		conditionSlots.push({ instance: index, count: predicates.length });
		for (const predicate of predicates) {
			conditionRequests.push({ instance: index, predicate });
		}
	}
	const conditionResults = await evaluateBatch(
		trx,
		host,
		appId,
		program,
		session,
		bindingsFor,
		conditionRequests,
	);
	const executing: boolean[] = [];
	{
		let cursor = 0;
		for (const slot of conditionSlots) {
			let passes = true;
			for (let i = 0; i < slot.count; i++) {
				if (conditionResults[cursor] !== true) passes = false;
				cursor++;
			}
			executing[slot.instance] = passes;
		}
	}

	// An executing authored-key create with a held key failure aborts
	// now — before any DML anywhere in the envelope.
	for (const [index, allocation] of allocations) {
		if (!executing[index] || allocation.keyFailure === undefined) continue;
		const instance = instances[index];
		if (instance === undefined) continue;
		throw new SubmissionRejectedError({
			kind: "authored-key",
			operationUuid: instance.envelope.operation.uuid,
			reason: allocation.keyFailure.reason,
			maxKeyLength: allocation.keyFailure.maxKeyLength,
		});
	}

	// Phase: values + runtime targets for executing instances.
	interface ValueSlot {
		readonly instance: number;
		readonly kind:
			| "name"
			| "rename"
			| "owner"
			| "target"
			| { write: number }
			| { writeCondition: number }
			| { link: number };
	}
	const valueRequests: EvalRequest[] = [];
	const valueSlots: ValueSlot[] = [];
	const request = (
		instance: number,
		kind: ValueSlot["kind"],
		content: { expression?: ValueExpression; predicate?: Predicate },
	) => {
		valueSlots.push({ instance, kind });
		valueRequests.push({ instance, ...content });
	};
	for (const [index, instance] of instances.entries()) {
		if (!executing[index]) continue;
		const operation = instance.envelope.operation;
		if (operation.name !== undefined) {
			request(index, "name", { expression: operation.name });
		}
		if (operation.rename !== undefined) {
			request(index, "rename", { expression: operation.rename });
		}
		if (operation.owner !== undefined) {
			request(index, "owner", { expression: operation.owner });
		}
		if (
			operation.action !== "create" &&
			operation.target.kind === "expression"
		) {
			request(index, "target", { expression: operation.target.expr });
		}
		for (const [writeIndex, write] of (operation.writes ?? []).entries()) {
			request(index, { write: writeIndex }, { expression: write.value });
			if (write.condition !== undefined) {
				request(
					index,
					{ writeCondition: writeIndex },
					{ predicate: write.condition },
				);
			}
		}
		for (const [linkIndex, link] of (operation.links ?? []).entries()) {
			if (link.target?.kind === "expression") {
				request(index, { link: linkIndex }, { expression: link.target.expr });
			}
		}
	}
	const valueResults = await evaluateBatch(
		trx,
		host,
		appId,
		program,
		session,
		bindingsFor,
		valueRequests,
	);
	const valuesByInstance = new Map<
		number,
		{
			name?: unknown;
			rename?: unknown;
			owner?: unknown;
			target?: unknown;
			writes: Map<number, unknown>;
			writeConditions: Map<number, unknown>;
			links: Map<number, unknown>;
		}
	>();
	for (const [slotIndex, slot] of valueSlots.entries()) {
		let bag = valuesByInstance.get(slot.instance);
		if (bag === undefined) {
			bag = {
				writes: new Map(),
				writeConditions: new Map(),
				links: new Map(),
			};
			valuesByInstance.set(slot.instance, bag);
		}
		const value = valueResults[slotIndex];
		if (slot.kind === "name") bag.name = value;
		else if (slot.kind === "rename") bag.rename = value;
		else if (slot.kind === "owner") bag.owner = value;
		else if (slot.kind === "target") bag.target = value;
		else if ("write" in slot.kind) bag.writes.set(slot.kind.write, value);
		else if ("writeCondition" in slot.kind)
			bag.writeConditions.set(slot.kind.writeCondition, value);
		else bag.links.set(slot.kind.link, value);
	}

	// Load every existing row a target may resolve to, tenant-bound,
	// still pre-effect. Expression targets additionally inherit the
	// running app's hold exclusion — a case waiting on review is
	// unreachable, exactly as it is invisible to every other runtime
	// read; the already-selected session case does not re-check it.
	const authoredIds = [...allocations.entries()]
		.filter(([index, allocation]) => executing[index] && allocation.authored)
		.map(([, allocation]) => allocation.caseId);
	const expressionIds: string[] = [];
	for (const [index] of instances.entries()) {
		if (!executing[index]) continue;
		const bag = valuesByInstance.get(index);
		if (bag?.target !== undefined) {
			expressionIds.push(evaluatedText(bag.target));
		}
		for (const value of bag?.links.values() ?? []) {
			expressionIds.push(evaluatedText(value));
		}
	}
	const knownRows = await loadTargetRows(trx, host, appId, {
		unheldIds: expressionIds.filter((id) => id !== ""),
		anyIds: [
			...authoredIds,
			...(program.sessionCaseId === undefined ? [] : [program.sessionCaseId]),
		],
	});

	// Resolve every executing instance's target + links.
	const resolvedInstances: ResolvedInstance[] = [];
	for (const [index, instance] of instances.entries()) {
		const operation = instance.envelope.operation;
		if (!executing[index]) {
			resolvedInstances.push({
				instance,
				index,
				executed: false,
				caseId: "",
				mergesExisting: false,
				writes: [],
				links: [],
			});
			continue;
		}
		const bag = valuesByInstance.get(index);
		const resolveTargetId = (): {
			caseId: string;
			snapshotCaseType?: string;
			mergesExisting: boolean;
		} => {
			const target = operation.target;
			switch (target.kind) {
				case "new": {
					const allocation = allocations.get(index);
					if (allocation === undefined) {
						throw new Error(
							compilerBugMessage({
								where: "case-store.submissionEnvelope.resolveOperationProgram",
								invariant: `create instance ${index} has no allocation record`,
								detail:
									"Every `new`-target create allocates in the identity pass; a missing record is an ordering bug in this module.",
							}),
						);
					}
					const existing = knownRows.get(allocation.caseId);
					return {
						caseId: allocation.caseId,
						...(existing === undefined
							? {}
							: { snapshotCaseType: existing.caseType }),
						mergesExisting: existing !== undefined,
					};
				}
				case "session": {
					if (program.sessionCaseId === undefined) {
						throw new SubmissionRejectedError({
							kind: "target",
							operationUuid: operation.uuid,
							slot: "target",
							reason: "not-found-or-out-of-scope",
						});
					}
					const row = knownRows.get(program.sessionCaseId);
					if (row === undefined) {
						throw new SubmissionRejectedError({
							kind: "target",
							operationUuid: operation.uuid,
							slot: "target",
							reason: "not-found-or-out-of-scope",
						});
					}
					return {
						caseId: program.sessionCaseId,
						snapshotCaseType: row.caseType,
						mergesExisting: false,
					};
				}
				case "op": {
					const producerIds = operationIdsFor(instances, allocations, index);
					const caseId = producerIds.get(target.opUuid);
					if (caseId === undefined) {
						throw new Error(
							compilerBugMessage({
								where: "case-store.submissionEnvelope.resolveOperationProgram",
								invariant: `operation \`${operation.uuid}\` references earlier create \`${target.opUuid}\` outside its correlated scope`,
								detail:
									"An `op` target reads the transaction's allocation record: root creates are visible everywhere, repeated creates only within their exact iteration. The authoring gate rejects uncorrelated references, so reaching this throw means an invalid program crossed the boundary.",
							}),
						);
					}
					return { caseId, mergesExisting: false };
				}
				case "expression": {
					const evaluated = evaluatedText(bag?.target);
					const expectedSnapshotType =
						instance.envelope.expressionSnapshotTypes.target ??
						operation.caseType;
					const row = evaluated === "" ? undefined : knownRows.get(evaluated);
					const verdict = validateCaseOperationTargetDescriptor(
						{ caseId: evaluated },
						row === undefined
							? undefined
							: {
									caseId: row.caseId,
									caseType: row.caseType,
									projectId: host.projectId,
								},
						{
							projectId: host.projectId,
							snapshotCaseType: expectedSnapshotType,
						},
					);
					if (!verdict.ok) {
						throw new SubmissionRejectedError({
							kind: "target",
							operationUuid: operation.uuid,
							slot: "target",
							reason: verdict.reason,
						});
					}
					return {
						caseId: verdict.descriptor.caseId,
						snapshotCaseType: verdict.descriptor.caseType,
						mergesExisting: false,
					};
				}
				default: {
					const _exhaustive: never = target;
					throw new Error(
						unhandledKindMessage({
							where: "case-store.submissionEnvelope.resolveOperationProgram",
							family: "CaseTarget",
							received: (_exhaustive as { kind?: unknown })?.kind,
							knownKinds: ["new", "op", "session", "expression"],
						}),
					);
				}
			}
		};
		const target = resolveTargetId();

		const links: ResolvedLink[] = [];
		for (const [linkIndex, link] of (operation.links ?? []).entries()) {
			if (link.target === null) {
				links.push({
					identifier: link.identifier,
					relationship: link.relationship,
					targetType: link.targetType,
					targetCaseId: null,
				});
				continue;
			}
			const slot = `link:${link.identifier}` as const;
			const resolveLinkTarget = (): {
				caseId: string;
				snapshotCaseType?: string;
			} => {
				const linkTarget = link.target;
				if (linkTarget === null || linkTarget.kind === "new") {
					throw new Error(
						compilerBugMessage({
							where: "case-store.submissionEnvelope.resolveOperationProgram",
							invariant: `link \`${link.identifier}\` on operation \`${operation.uuid}\` carries a \`new\` target`,
							detail:
								"A link addresses an existing identity: an earlier create by operation uuid, the loaded session case, or a runtime expression. The authoring layer never produces a `new`-target link.",
						}),
					);
				}
				if (linkTarget.kind === "op") {
					const caseId = operationIdsFor(instances, allocations, index).get(
						linkTarget.opUuid,
					);
					if (caseId === undefined) {
						throw new Error(
							compilerBugMessage({
								where: "case-store.submissionEnvelope.resolveOperationProgram",
								invariant: `link \`${link.identifier}\` on operation \`${operation.uuid}\` references create \`${linkTarget.opUuid}\` outside its correlated scope`,
								detail:
									"Same correlation contract as `op` targets: root creates everywhere, repeated creates within their exact iteration only.",
							}),
						);
					}
					return { caseId };
				}
				if (linkTarget.kind === "session") {
					if (
						program.sessionCaseId === undefined ||
						!knownRows.has(program.sessionCaseId)
					) {
						throw new SubmissionRejectedError({
							kind: "target",
							operationUuid: operation.uuid,
							slot,
							reason: "not-found-or-out-of-scope",
						});
					}
					return {
						caseId: program.sessionCaseId,
						snapshotCaseType: knownRows.get(program.sessionCaseId)?.caseType,
					};
				}
				const evaluated = evaluatedText(bag?.links.get(linkIndex));
				const expectedSnapshotType =
					instance.envelope.expressionSnapshotTypes.links.get(linkIndex) ??
					link.targetType;
				const row = evaluated === "" ? undefined : knownRows.get(evaluated);
				const verdict = validateCaseOperationTargetDescriptor(
					{ caseId: evaluated },
					row === undefined
						? undefined
						: {
								caseId: row.caseId,
								caseType: row.caseType,
								projectId: host.projectId,
							},
					{
						projectId: host.projectId,
						snapshotCaseType: expectedSnapshotType,
					},
				);
				if (!verdict.ok) {
					throw new SubmissionRejectedError({
						kind: "target",
						operationUuid: operation.uuid,
						slot,
						reason: verdict.reason,
					});
				}
				return {
					caseId: verdict.descriptor.caseId,
					snapshotCaseType: verdict.descriptor.caseType,
				};
			};
			const resolvedLink = resolveLinkTarget();
			links.push({
				identifier: link.identifier,
				relationship: link.relationship,
				targetType: link.targetType,
				targetCaseId: resolvedLink.caseId,
				...(resolvedLink.snapshotCaseType === undefined
					? {}
					: { snapshotCaseType: resolvedLink.snapshotCaseType }),
			});
		}

		// Text facets — one shared normalization contract with the XForm
		// calculate and HQ (`prepareCaseOperationTextValue`), applied to
		// every evaluated name/rename/owner INCLUDING the create's
		// default acting-user owner.
		const prepareText = (
			facet: "name" | "rename" | "owner",
			raw: string,
		): string => {
			const prepared = prepareCaseOperationTextValue(raw);
			if (!prepared.ok) {
				throw new SubmissionRejectedError({
					kind: "text-value",
					operationUuid: operation.uuid,
					facet,
					reason: prepared.reason,
				});
			}
			return prepared.value;
		};
		let preparedName: string | undefined;
		if (operation.action === "create") {
			// The wire always emits the create's `case_name` node; an
			// absent name expression calculates blank and the trailing
			// guard rejects it — same rejection here.
			preparedName = prepareText("name", evaluatedText(bag?.name));
		}
		let preparedOwner: string | undefined;
		if (operation.action === "create") {
			preparedOwner = prepareText(
				"owner",
				operation.owner === undefined
					? host.actorUserId
					: evaluatedText(bag?.owner),
			);
		} else if (operation.action === "update" && operation.owner !== undefined) {
			preparedOwner = prepareText("owner", evaluatedText(bag?.owner));
		}
		const preparedRename =
			operation.rename === undefined
				? undefined
				: prepareText("rename", evaluatedText(bag?.rename));

		// Executing writes, storage-converted against the operation's
		// RESULT type — the retype destination when the operation
		// retypes, since the validator resolves write properties against
		// `retype ?? caseType` and the wire applies the writes and the
		// type change in one block.
		const writes: Array<{ property: string; value: JsonValue | undefined }> =
			[];
		const declaredType = program.caseTypeSchemas.get(
			operation.retype ?? operation.caseType,
		);
		for (const [writeIndex, write] of (operation.writes ?? []).entries()) {
			if (
				write.condition !== undefined &&
				bag?.writeConditions.get(writeIndex) !== true
			) {
				continue;
			}
			const dataType =
				declaredType?.properties?.find(
					(property) => property.name === write.property,
				)?.data_type ?? "text";
			writes.push({
				property: write.property,
				value: storageValueFromEvaluation(
					bag?.writes.get(writeIndex),
					dataType,
				),
			});
		}

		resolvedInstances.push({
			instance,
			index,
			executed: true,
			caseId: target.caseId,
			...(target.snapshotCaseType === undefined
				? {}
				: { snapshotCaseType: target.snapshotCaseType }),
			mergesExisting: target.mergesExisting,
			...(preparedName === undefined ? {} : { preparedName }),
			...(preparedRename === undefined ? {} : { preparedRename }),
			...(preparedOwner === undefined ? {} : { preparedOwner }),
			writes,
			links,
		});
	}

	// The rolling type proof over the SERVER-resolved sequence — the
	// runtime complement of the static alias analysis, keyed by
	// concrete opaque id so runtime aliases and duplicate repeat keys
	// fold onto one identity.
	const steps: ResolvedCaseOperationTypeStep[] = [];
	for (const entry of resolvedInstances) {
		if (!entry.executed) continue;
		const operation = entry.instance.envelope.operation;
		steps.push({
			operationUuid: operation.uuid,
			action: operation.action,
			target: {
				caseId: entry.caseId,
				...(entry.snapshotCaseType === undefined
					? {}
					: { snapshotCaseType: entry.snapshotCaseType }),
			},
			expectedCaseType: operation.caseType,
			...(operation.retype === undefined
				? {}
				: { resultCaseType: operation.retype }),
			links: entry.links.flatMap((link) =>
				link.targetCaseId === null
					? []
					: [
							{
								slot: link.identifier,
								target: {
									caseId: link.targetCaseId,
									...(link.snapshotCaseType === undefined
										? {}
										: { snapshotCaseType: link.snapshotCaseType }),
								},
								expectedCaseType: link.targetType,
							},
						],
			),
		});
	}
	// The ordinary form action executes after the operations and still
	// consumes the loaded session case as its authored type: fold it as
	// the final implicit step when the caller declared that type and
	// the action is type-sensitive (a property patch or a child's
	// parent link). A write-free, child-free close stays type-blind.
	if (
		(ordinary.kind === "followup" || ordinary.kind === "close") &&
		ordinary.caseType !== undefined &&
		(Object.keys(ordinary.patch.properties).length > 0 ||
			ordinary.patch.caseName !== undefined ||
			ordinary.children.length > 0)
	) {
		const boundRow = knownRows.get(ordinary.caseId);
		steps.push({
			operationUuid: "__ordinary__",
			action: "update",
			target: {
				caseId: ordinary.caseId,
				...(boundRow === undefined
					? {}
					: { snapshotCaseType: boundRow.caseType }),
			},
			expectedCaseType: ordinary.caseType,
		});
	}
	const verdict = validateResolvedCaseOperationTypeSequence(steps);
	if (!verdict.ok) {
		throw new SubmissionRejectedError({
			kind: "sequence",
			operationUuid: verdict.operationUuid,
			slot: verdict.slot,
			reason: verdict.reason,
		});
	}

	return resolvedInstances;
}

async function loadSessionAnchor(
	trx: Transaction<Database>,
	host: SubmissionEnvelopeHost,
	appId: string,
	program: CaseOperationProgram,
): Promise<SessionAnchor | undefined> {
	if (program.sessionCaseId === undefined) return undefined;
	const row = await trx
		.selectFrom("cases as c")
		.select(["c.case_id", "c.case_type"])
		.where("c.app_id", "=", appId)
		.where("c.case_id", "=", program.sessionCaseId)
		.where("c.project_id", "=", host.projectId)
		.executeTakeFirst();
	if (row === undefined) throw new CaseNotFoundError(program.sessionCaseId);
	return { caseId: row.case_id, caseType: row.case_type };
}

/**
 * One tenant-bound load for every id a target may resolve to.
 * `unheldIds` (runtime expression results) additionally exclude held
 * cases; `anyIds` (the session case, authored create ids probing for
 * a merge) load regardless of hold state.
 */
async function loadTargetRows(
	trx: Transaction<Database>,
	host: SubmissionEnvelopeHost,
	appId: string,
	ids: { unheldIds: readonly string[]; anyIds: readonly string[] },
): Promise<ReadonlyMap<string, { caseId: string; caseType: string }>> {
	const rows = new Map<string, { caseId: string; caseType: string }>();
	const load = async (
		caseIds: readonly string[],
		excludeHeld: boolean,
	): Promise<void> => {
		const distinct = [...new Set(caseIds)];
		if (distinct.length === 0) return;
		let qb = trx
			.selectFrom("cases as c")
			.select(["c.case_id", "c.case_type"])
			.where("c.app_id", "=", appId)
			.where("c.project_id", "=", host.projectId)
			.where("c.case_id", "in", distinct);
		if (excludeHeld) {
			qb = qb.where(({ not, exists, selectFrom }) =>
				not(
					exists(
						selectFrom("parked_case_values as held")
							.select("held.id")
							.whereRef("held.case_id", "=", "c.case_id")
							.where("held.dismissed_at", "is", null),
					),
				),
			);
		}
		for (const row of await qb.execute()) {
			rows.set(row.case_id, { caseId: row.case_id, caseType: row.case_type });
		}
	};
	await load(ids.unheldIds, true);
	await load(ids.anyIds, false);
	return rows;
}

// ---------------------------------------------------------------
// Effects
// ---------------------------------------------------------------

async function applyOperationEffects(
	trx: Transaction<Database>,
	host: SubmissionEnvelopeHost,
	appId: string,
	resolved: readonly ResolvedInstance[],
): Promise<void> {
	// Ids this envelope has already created: a later duplicate-key
	// create of the SAME submission (duplicate repeat values) merges
	// onto the in-transaction row exactly as it would merge onto a
	// prior submission's row — the resolution-time probe only sees
	// pre-envelope rows.
	const createdInEnvelope = new Set<string>();
	for (const entry of resolved) {
		if (!entry.executed) continue;
		const operation = entry.instance.envelope.operation;

		if (operation.action === "create") {
			await applyCreateEffect(
				trx,
				host,
				appId,
				entry,
				operation,
				createdInEnvelope,
			);
		} else {
			await applyMutationEffect(trx, host, appId, entry, operation);
		}

		if (operation.action === "close") {
			await host.closeCase(trx, { appId, caseId: entry.caseId });
		}

		for (const link of entry.links) {
			await applyLinkEffect(trx, host, appId, entry.caseId, link);
		}

		// Every emitted case block advances `@date_modified`, including a
		// pure index write. A link-only update touches no other stamping
		// path, so stamp it here; every other arm (create, writes,
		// rename, owner, retype, a genuine close transition) already
		// stamps. A re-close deliberately keeps its repair semantics.
		if (
			operation.action === "update" &&
			entry.links.length > 0 &&
			entry.writes.length === 0 &&
			entry.preparedRename === undefined &&
			entry.preparedOwner === undefined &&
			(operation.retype === undefined ||
				operation.retype === operation.caseType)
		) {
			await stampModified(trx, host, appId, entry.caseId);
		}
	}
}

/** Split resolved writes into the additive patch and the blank-write
 * key removals (the wire's `''` write projected onto typed storage). */
function partitionWrites(writes: ResolvedInstance["writes"]): {
	patch: JsonObject;
	removals: string[];
} {
	const patch: JsonObject = {};
	const removals: string[] = [];
	for (const write of writes) {
		if (write.value === undefined) removals.push(write.property);
		else patch[write.property] = write.value;
	}
	return { patch, removals };
}

async function applyCreateEffect(
	trx: Transaction<Database>,
	host: SubmissionEnvelopeHost,
	appId: string,
	entry: ResolvedInstance,
	operation: CaseOperation,
	createdInEnvelope: Set<string>,
): Promise<void> {
	const { patch, removals } = partitionWrites(entry.writes);
	if (entry.mergesExisting || createdInEnvelope.has(entry.caseId)) {
		// Create-of-existing merges (duplicate authored key, a retry of
		// the same definition): the create block's facets apply over the
		// existing row, exactly as Core/HQ accept a create for a known
		// id. The rolling proof already refused a stored-type mismatch.
		if (entry.preparedName !== undefined || Object.keys(patch).length > 0) {
			await host.updateCase(trx, {
				appId,
				caseId: entry.caseId,
				patch: {
					...(entry.preparedName === undefined
						? {}
						: { case_name: entry.preparedName }),
					...(Object.keys(patch).length > 0 ? { properties: patch } : {}),
				},
			});
		}
		if (removals.length > 0) {
			await removeProperties(trx, host, appId, entry.caseId, removals);
		}
		if (entry.preparedOwner !== undefined) {
			await setOwner(trx, host, appId, entry.caseId, entry.preparedOwner);
		}
		return;
	}
	if (entry.preparedName === undefined) {
		throw new Error(
			compilerBugMessage({
				where: "case-store.submissionEnvelope.applyCreateEffect",
				invariant: `create \`${operation.uuid}\` reached its effect without a prepared name`,
				detail:
					"Resolution prepares every executing create's name (rejecting blank) before any effect; a missing value here is an ordering bug in this module.",
			}),
		);
	}
	// Blank writes on a fresh create simply never mint the key — the
	// same document shape the ordinary form path's two-state collapse
	// produces.
	await host.insertCase(trx, {
		appId,
		seed: {
			caseType: operation.caseType,
			caseName: entry.preparedName,
			properties: patch,
		},
		caseId: entry.caseId,
		...(entry.preparedOwner === undefined
			? {}
			: { ownerId: entry.preparedOwner }),
	});
	createdInEnvelope.add(entry.caseId);
}

async function applyMutationEffect(
	trx: Transaction<Database>,
	host: SubmissionEnvelopeHost,
	appId: string,
	entry: ResolvedInstance,
	operation: CaseOperation,
): Promise<void> {
	if (
		operation.retype !== undefined &&
		operation.retype !== operation.caseType
	) {
		// A retyping operation applies its writes, rename, and the type
		// change as ONE unit — the wire emits them in a single <update>
		// block that Core/HQ apply together, so the writes are
		// destination-typed and land on the destination-typed row.
		await applyRetypeEffect(trx, host, appId, entry, operation.retype);
	} else {
		const { patch, removals } = partitionWrites(entry.writes);
		if (Object.keys(patch).length > 0 || entry.preparedRename !== undefined) {
			await host.updateCase(trx, {
				appId,
				caseId: entry.caseId,
				patch: {
					...(entry.preparedRename === undefined
						? {}
						: { case_name: entry.preparedRename }),
					...(Object.keys(patch).length > 0 ? { properties: patch } : {}),
				},
			});
		}
		if (removals.length > 0) {
			await removeProperties(trx, host, appId, entry.caseId, removals);
		}
	}
	if (entry.preparedOwner !== undefined) {
		await setOwner(trx, host, appId, entry.caseId, entry.preparedOwner);
	}
}

/**
 * The wirePortable retype, applied with the operation's writes and
 * rename as one unit — exactly the single `<update>` block the wire
 * emits, where the case ends as the DESTINATION type carrying the
 * written properties. Nova's storage invariant holds in two separately
 * reported steps: the RETAINED document (the stored properties minus
 * source-schema orphans, the same proof the update merge sheds by)
 * must validate under the destination schema — failure is the
 * wirePortable rejection (`retype-not-portable`) — and the FINAL
 * document (retained + destination-typed writes, minus blank-write
 * removals) must also validate, where a failure is genuine invalid
 * write data and surfaces as the standard
 * `CasePropertiesValidationError`. The richer conversion/parking plan
 * (`planCaseRetype().safe`) stays dormant until a shared wire
 * representation exists.
 */
async function applyRetypeEffect(
	trx: Transaction<Database>,
	host: SubmissionEnvelopeHost,
	appId: string,
	entry: ResolvedInstance,
	toCaseType: string,
): Promise<void> {
	const operationUuid = entry.instance.envelope.operation.uuid;
	const row = await trx
		.selectFrom("cases as c")
		.select(["c.case_type", "c.properties"])
		.where("c.app_id", "=", appId)
		.where("c.case_id", "=", entry.caseId)
		.where("c.project_id", "=", host.projectId)
		.forUpdate()
		.executeTakeFirst();
	if (row === undefined) throw new CaseNotFoundError(entry.caseId);

	const sourceDeclared = await host.declaredProperties(
		trx,
		appId,
		row.case_type,
	);
	const retained: JsonObject = {};
	for (const [key, value] of Object.entries(row.properties)) {
		if (sourceDeclared.has(key)) retained[key] = value;
	}
	try {
		await host.validateProperties(trx, {
			appId,
			caseType: toCaseType,
			properties: retained,
		});
	} catch (err) {
		if (err instanceof CasePropertiesValidationError) {
			throw new SubmissionRejectedError({
				kind: "retype-not-portable",
				operationUuid,
				caseId: entry.caseId,
				toCaseType,
				failures: err.failures,
			});
		}
		throw err;
	}

	const { patch, removals } = partitionWrites(entry.writes);
	const finalDocument: JsonObject = { ...retained, ...patch };
	for (const key of removals) delete finalDocument[key];
	if (Object.keys(patch).length > 0) {
		await host.validateProperties(trx, {
			appId,
			caseType: toCaseType,
			properties: finalDocument,
		});
	}
	await trx
		.updateTable("cases as c")
		.set({
			case_type: toCaseType,
			properties: JSON.stringify(finalDocument),
			...(entry.preparedRename === undefined
				? {}
				: { case_name: entry.preparedRename }),
			modified_on: sql<Date>`now()`,
		})
		.where("c.app_id", "=", appId)
		.where("c.case_id", "=", entry.caseId)
		.where("c.project_id", "=", host.projectId)
		.execute();
}

/**
 * The blank-write projection: remove each key from the stored
 * document, the storage state Nova reads as blank exactly as the
 * device reads the wire's `''` write. Removal cannot invalidate a
 * valid document (no generated schema marks properties required), so
 * no revalidation runs; `modified_on` advances as it does for every
 * write the wire stamps.
 */
async function removeProperties(
	trx: Transaction<Database>,
	host: SubmissionEnvelopeHost,
	appId: string,
	caseId: string,
	keys: readonly string[],
): Promise<void> {
	let expression = sql`c.properties`;
	for (const key of keys) {
		// Explicit ::text disambiguates `jsonb - text` from
		// `jsonb - integer` for the bound parameter.
		expression = sql`${expression} - ${key}::text`;
	}
	await trx
		.updateTable("cases as c")
		.set({
			properties: expression as unknown as string,
			modified_on: sql<Date>`now()`,
		})
		.where("c.app_id", "=", appId)
		.where("c.case_id", "=", caseId)
		.where("c.project_id", "=", host.projectId)
		.execute();
}

async function stampModified(
	trx: Transaction<Database>,
	host: SubmissionEnvelopeHost,
	appId: string,
	caseId: string,
): Promise<void> {
	await trx
		.updateTable("cases as c")
		.set({ modified_on: sql<Date>`now()` })
		.where("c.app_id", "=", appId)
		.where("c.case_id", "=", caseId)
		.where("c.project_id", "=", host.projectId)
		.execute();
}

async function setOwner(
	trx: Transaction<Database>,
	host: SubmissionEnvelopeHost,
	appId: string,
	caseId: string,
	ownerId: string,
): Promise<void> {
	await trx
		.updateTable("cases as c")
		.set({ owner_id: ownerId, modified_on: sql<Date>`now()` })
		.where("c.app_id", "=", appId)
		.where("c.case_id", "=", caseId)
		.where("c.project_id", "=", host.projectId)
		.execute();
}

/**
 * Identifier-keyed link CRUD, persisting the AUTHORED relationship —
 * the first writer to put a non-`child` value in
 * `case_indices.relationship`. One identifier is one slot per case: a
 * new target replaces the edge; a null target removes it, mirroring
 * the wire where an empty index value removes the link. A `parent`
 * identifier also maintains the denormalized first-parent column the
 * read paths walk.
 */
async function applyLinkEffect(
	trx: Transaction<Database>,
	host: SubmissionEnvelopeHost,
	appId: string,
	caseId: string,
	link: ResolvedLink,
): Promise<void> {
	await trx
		.deleteFrom("case_indices")
		.where("case_indices.case_id", "=", caseId)
		.where("case_indices.identifier", "=", link.identifier)
		.execute();
	if (link.targetCaseId !== null) {
		await trx
			.insertInto("case_indices")
			.values({
				case_id: caseId,
				ancestor_id: link.targetCaseId,
				identifier: link.identifier,
				relationship: link.relationship,
				depth: 1,
			})
			.execute();
	}
	if (link.identifier === "parent") {
		await trx
			.updateTable("cases as c")
			.set({ parent_case_id: link.targetCaseId })
			.where("c.app_id", "=", appId)
			.where("c.case_id", "=", caseId)
			.where("c.project_id", "=", host.projectId)
			.execute();
	}
}

// ---------------------------------------------------------------
// The ordinary form action
// ---------------------------------------------------------------

function requireCaseName(
	seed: SubmissionCaseSeed,
	role: "primary" | "child",
): string {
	if (seed.caseName === undefined) {
		throw new Error(
			compilerBugMessage({
				where: "case-store.submissionEnvelope.requireCaseName",
				invariant: `${role === "primary" ? "registration form" : "child-case op"} for case type \`${seed.caseType}\` produced no \`case_name\` value`,
				detail:
					"Every case row carries a top-level `case_name` (`cases.case_name` is `text NOT NULL`). A form that creates a case must include a leaf field with `id: \"case_name\"` bound to the destination case type via `case_property_on`; the engine's walker plucks it into the `caseName` slot. Reaching this throw means the form's field tree omits the name leaf — an upstream blueprint authoring contract violation.",
			}),
		);
	}
	return seed.caseName;
}

async function applyOrdinaryAction(
	trx: Transaction<Database>,
	host: SubmissionEnvelopeHost,
	appId: string,
	args: ApplySubmissionArgs,
): Promise<Omit<SubmissionEnvelopeResult, "operations">> {
	const ordinary = args.ordinary;
	switch (ordinary.kind) {
		case "none":
			return { childCaseIds: [] };
		case "registration": {
			const primaryCaseId = await host.insertCase(trx, {
				appId,
				seed: {
					caseType: ordinary.primary.caseType,
					caseName: requireCaseName(ordinary.primary, "primary"),
					properties: ordinary.primary.properties,
				},
			});
			const childCaseIds: string[] = [];
			for (const child of ordinary.children) {
				childCaseIds.push(
					await host.insertCase(trx, {
						appId,
						seed: {
							caseType: child.caseType,
							caseName: requireCaseName(child, "child"),
							properties: child.properties,
							parentCaseId: primaryCaseId,
						},
					}),
				);
			}
			return { primaryCaseId, childCaseIds };
		}
		case "followup":
		case "close": {
			const hasPropertyWrites =
				Object.keys(ordinary.patch.properties).length > 0;
			const hasCaseNameWrite = ordinary.patch.caseName !== undefined;
			if (hasPropertyWrites || hasCaseNameWrite) {
				await host.updateCase(trx, {
					appId,
					caseId: ordinary.caseId,
					patch: {
						...(hasPropertyWrites
							? { properties: ordinary.patch.properties }
							: {}),
						...(hasCaseNameWrite ? { case_name: ordinary.patch.caseName } : {}),
					},
				});
			}
			const childCaseIds: string[] = [];
			for (const child of ordinary.children) {
				childCaseIds.push(
					await host.insertCase(trx, {
						appId,
						seed: {
							caseType: child.caseType,
							caseName: requireCaseName(child, "child"),
							properties: child.properties,
							parentCaseId: child.parentCaseId,
						},
					}),
				);
			}
			if (ordinary.kind === "close") {
				await host.closeCase(trx, { appId, caseId: ordinary.caseId });
			}
			return { primaryCaseId: ordinary.caseId, childCaseIds };
		}
		default: {
			const _exhaustive: never = ordinary;
			throw new Error(
				unhandledKindMessage({
					where: "case-store.submissionEnvelope.applyOrdinaryAction",
					family: "OrdinarySubmissionAction",
					received: (_exhaustive as { kind?: unknown })?.kind,
					knownKinds: ["registration", "followup", "close", "none"],
				}),
			);
		}
	}
}
