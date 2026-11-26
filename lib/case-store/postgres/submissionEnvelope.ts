// lib/case-store/postgres/submissionEnvelope.ts
//
// The atomic submission envelope's executor — the in-transaction half
// of `CaseStore.applySubmission`. The store method owns the outer
// transaction and lock order (authorize → relationship advisory →
// schema locks); this module owns the operation program's execution
// model. Every case change of the form is an operation, the form's own case
// first, and the program runs them in array order: the validator keeps
// every other operation from writing, retyping or closing what the own arm
// writes (`lib/commcare/validator`, the own case's independence), so the
// array order is the wire's meaning wherever HQ places each change.
//
//   1. **Expand** the authored operations over the physical
//      multiplicity scopes: the root scope first, then each repeat
//      scope iteration-major. Form-level operations run once per
//      authored iteration; only session-targeted operations add the
//      selected-case inner axis, matching the selected-cases iteration
//      the XForm emitter builds in each scope.
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
//      shared lookup-table locks hold the Project data each expression reads,
//      no envelope DML runs until evaluation completes, so the rows
//      the SELECTs see are the current pre-effect Preview transaction.
//      Native calculates can retain an initialized form's casedb view
//      across other submissions to the same local store; this is not a
//      native current-at-submit or compare-and-set guarantee. Form-answer
//      bindings retain submitted entry values in either path.
//   4. **Resolve + reauthorize** targets: `session` is the loaded
//      case; `op` reads the allocation record; `expression` results
//      load tenant-bound and revalidate through
//      `validateCaseOperationTargetDescriptor` against the immutable
//      snapshot type. The whole resolved sequence then re-proves
//      rolling type safety with
//      `validateResolvedCaseOperationTypeSequence` before any write.
//   5. **Apply effects** in physical order — per operation: create →
//      property writes → rename/retype → close → links → the writes that
//      save through an index to a case above. The own case's change comes
//      first, as the array holds it; its close runs after its writes when
//      the form's close condition holds.
//
// Every rejection is pre-effect for the rejected fact and the store's
// transaction rolls the whole envelope back, so partial success is
// unobservable.

import type { Expression as SqlExpression, Transaction } from "kysely";
import { expressionBuilder, sql } from "kysely";
import { v7 as uuidv7 } from "uuid";
import {
	type CasePropertyDataType,
	type CaseWriteVia,
	caseOperationRunsPerSelectedCase,
	casePropertyDataTypes,
	deriveAuthoredCaseId,
	isFacetWriteThroughIndex,
	prepareCaseScalarTextValue,
	type TargetedCaseOperation,
	USERCASE_BUILT_IN_KEYS,
	USERCASE_CASE_TYPE,
	type Uuid,
} from "@/lib/domain";
import { MAX_AUTHORED_CASE_ID_LENGTH } from "@/lib/domain/caseOperationIdentity";
import { entryDatumCaseId } from "@/lib/domain/entryCaseIdentity";
import {
	compilerBugMessage,
	unhandledKindMessage,
} from "@/lib/domain/expression/errors";
import { numericAnswerText } from "@/lib/domain/expression/numberLiteral";
import type { Expression as DomainExpression } from "@/lib/domain/expression/types";
import { walkExpressionTerms } from "@/lib/domain/expression/walk";
import {
	caseDatetimeValue,
	caseInstantText,
	instantDatetimeValue,
	storageDatetimeValue,
	storageTimeValue,
} from "@/lib/domain/temporalValues";
import {
	type ResolvedCaseOperationTypeStep,
	validateCaseOperationTargetDescriptor,
	validateResolvedCaseOperationTypeSequence,
} from "../caseOperationTargets";
import {
	CaptureSubmissionRejectedError,
	CaseNotFoundError,
	CasePropertiesValidationError,
	SubmissionRejectedError,
} from "../errors";
import {
	compileExpression,
	compilePredicate,
	compileSubmittedTextValue,
	expressionContextFor,
	type PredicateCompileContext,
} from "../sql";
import {
	buildRestoreScope,
	type RestoreScopeQuery,
} from "../sql/compileRestoreScope";
import type { FormFieldBindingValue, TermBindings } from "../sql/compileTerm";
import type { Database, JsonObject, JsonValue } from "../sql/database";
import type { CaseUpdate } from "../store";
import type {
	ApplySubmissionArgs,
	CaseOperationProgram,
	EnvelopeCaseOperation,
	OperationEffectRecord,
	SubmissionEnvelopeResult,
} from "../submission";
import { replaceCaseIndex } from "./caseIndexWrites";

/**
 * The store internals the executor borrows — narrow closures so the
 * store's private validator cache, merge/shed update core, and close
 * core stay private to `store.ts` while the envelope reuses them
 * verbatim (one merge semantic, one lifecycle write, whoever calls).
 */
export interface SubmissionEnvelopeHost {
	readonly projectId: string;
	/** CommCare worker the submission runs as; authorization happened earlier. */
	readonly actingUserId: string;
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
				externalId?: string;
				locationId?: string;
				properties: JsonObject;
				parentCaseId?: string;
				parentRelationship?: "child" | "extension";
			};
			caseId?: string;
			ownerId?: string;
			/** Inserts `caseId` only if no row holds it, deciding in the insert
			 * itself; a taken id writes nothing and calls this, which throws. */
			caseIdTaken?: () => never;
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
// The program's steps
// ---------------------------------------------------------------

/**
 * One operation as the executor runs it. The own arm stores neither a case
 * type nor a target (both are the form's), so it is run as the create a
 * registration's own case is, or as the update of the case a follow-up or
 * close form loaded, with the form's conditions in the places a targeted
 * operation holds its own.
 */
interface ProgramStep extends Omit<EnvelopeCaseOperation, "operation"> {
	readonly operation: TargetedCaseOperation;
	/** The stored arm's action, which the effect record reports. */
	readonly recordAction: EnvelopeCaseOperation["operation"]["action"];
	/** The step is the form's own case. */
	readonly own: boolean;
	/**
	 * A close leaf runs after the block's writes. If its independent
	 * condition is absent it closes every time the block runs.
	 */
	readonly closeLeaf?: { readonly condition?: DomainExpression };
	/**
	 * A several-case form's own arm saves one shared answer to every
	 * selected case, so a blank answer saves nothing rather than clearing
	 * the value on all of them. CommCare HQ writes such an update only when
	 * the answer is present and not empty.
	 */
	readonly blankSavesNothing: boolean;
}

function programSteps(
	program: CaseOperationProgram,
	ordinary: ApplySubmissionArgs["ordinary"],
): ProgramStep[] {
	return program.operations.map((entry): ProgramStep => {
		const stored = entry.operation;
		if (stored.action !== "own") {
			const closes = stored.action === "close" || stored.closeAfter === true;
			return {
				...entry,
				operation: stored,
				recordAction: stored.action,
				own: false,
				...(closes && { closeLeaf: { condition: stored.closeCondition } }),
				blankSavesNothing: false,
			};
		}
		const own = program.ownCase;
		if (own === undefined) {
			throw new Error(
				compilerBugMessage({
					where: "case-store.submissionEnvelope.programSteps",
					invariant: `the program holds the own arm \`${stored.uuid}\` but no \`ownCase\``,
					detail:
						"The own arm's case type and the form's open and close conditions travel beside the operations. Hint: the program builder sets `ownCase` from the committed form whenever its operations hold the own arm.",
				}),
			);
		}
		const facets = {
			uuid: stored.uuid,
			id: stored.id,
			caseType: own.caseType,
			...(stored.owner === undefined ? {} : { owner: stored.owner }),
			...(stored.ownerOnlyIfChanged === undefined
				? {}
				: { ownerOnlyIfChanged: stored.ownerOnlyIfChanged }),
			...(stored.writes === undefined ? {} : { writes: stored.writes }),
			...(stored.links === undefined ? {} : { links: stored.links }),
		};
		if (own.formType === "registration") {
			return {
				...entry,
				operation: {
					...facets,
					action: "create",
					target: { kind: "new" },
					...(stored.name === undefined ? {} : { name: stored.name }),
					...(own.openCondition === undefined
						? {}
						: { condition: own.openCondition }),
				},
				recordAction: "own",
				own: true,
				...(own.closeCondition === undefined
					? {}
					: { closeLeaf: { condition: own.closeCondition } }),
				blankSavesNothing: false,
			};
		}
		return {
			...entry,
			operation: {
				...facets,
				action: "update",
				target: { kind: "session" },
				...(stored.name === undefined ? {} : { rename: stored.name }),
				...(stored.nameOnlyIfChanged === undefined
					? {}
					: { renameOnlyIfChanged: stored.nameOnlyIfChanged }),
			},
			recordAction: "own",
			own: true,
			...(own.formType === "close"
				? {
						closeLeaf:
							own.closeCondition === undefined
								? {}
								: { condition: own.closeCondition },
					}
				: {}),
			blankSavesNothing:
				(ordinary.kind === "followup" || ordinary.kind === "close") &&
				ordinary.selection.kind === "multiple",
		};
	});
}

// ---------------------------------------------------------------
// Physical expansion
// ---------------------------------------------------------------

interface PhysicalInstance {
	readonly envelope: ProgramStep;
	readonly scopeRepeat: Uuid | undefined;
	readonly iteration: number;
	readonly selection: number;
	/** The instance runs once for one selected case of a several-case
	 * form (`caseOperationRunsPerSelectedCase`), at `selection`. */
	readonly perSelectedCase: boolean;
	readonly sessionCaseId: string | undefined;
	readonly formFields: ReadonlyMap<Uuid, FormFieldBindingValue>;
}

/**
 * Expand authored `(order, uuid)` sequence over the physical scopes:
 * for each scope in wire document order, for each live iteration, the
 * authored sequence for a single-case form, or the form-level operations once
 * and then, for each selected case, the operations that run per selected case
 * (`caseOperationRunsPerSelectedCase`: the own arm, a session-targeted update
 * or close, a create linked to the loaded case) for a batch form.
 * Batch admission puts form-level operations before the selected-case phase.
 * The caller supplies nested rows in wire order, with their definition-local
 * iteration numbers intact. The executor verifies the schedule covers the
 * live rows exactly once and keeps each operation's repeat binding.
 */
function expandPhysicalInstances(
	program: CaseOperationProgram,
	steps: readonly ProgramStep[],
	ordinary: ApplySubmissionArgs["ordinary"],
): PhysicalInstance[] {
	const scopes = new Map(program.scopes.map((scope) => [scope.repeat, scope]));
	const malformed = () =>
		new Error(
			compilerBugMessage({
				where: "case-store.submissionEnvelope.expandPhysicalInstances",
				invariant:
					"the operation program must schedule each live row once in a declared scope",
				detail:
					"The committed form orders each repeat row and the operations inside it. Its program must keep every scope, even a repeat with no live rows.",
			}),
		);
	if (
		scopes.size !== program.scopes.length ||
		steps.some(({ operation }) => !scopes.has(operation.forEach?.repeat))
	)
		throw malformed();

	const operationsByScope = new Map(
		program.scopes.map(({ repeat }) => [
			repeat,
			steps.filter((entry) => entry.operation.forEach?.repeat === repeat),
		]),
	);
	const defaultOrder =
		program.scopeOrder ??
		program.scopes.flatMap((scope) =>
			scope.iterations.map((_, iteration) => ({
				repeat: scope.repeat,
				iteration,
			})),
		);
	const expectedRows = program.scopes.reduce(
		(count, scope) => count + scope.iterations.length,
		0,
	);
	if (defaultOrder.length !== expectedRows) throw malformed();

	const byOperation = new Map(steps.map((step) => [step.operation.uuid, step]));
	const seenRows = new Set<string>();
	const seenEffects = new Set<string>();
	const order =
		program.effectOrder ??
		defaultOrder.map(({ repeat, iteration }) => {
			const key = JSON.stringify([repeat, iteration]);
			if (seenRows.has(key)) throw malformed();
			seenRows.add(key);
			return {
				repeat,
				iteration,
				operationUuids: (operationsByScope.get(repeat) ?? []).map(
					({ operation }) => operation.uuid,
				),
			};
		});
	const expectedEffects = program.scopes.reduce(
		(count, scope) =>
			count +
			scope.iterations.length *
				(operationsByScope.get(scope.repeat)?.length ?? 0),
		0,
	);

	// A batch form keeps its selected-case phase even when just one case was chosen.
	const multiple =
		ordinary.kind === "followup" || ordinary.kind === "close"
			? ordinary.selection.kind === "multiple"
			: (program.sessionCaseIds?.length ?? 0) > 1;
	const selectedCases = program.sessionCaseIds ?? [];
	const instances: PhysicalInstance[] = [];
	for (const slot of order) {
		const { repeat, iteration, operationUuids } = slot;
		const bindings = scopes.get(repeat)?.iterations[iteration];
		if (!bindings) throw malformed();
		const operations = operationUuids.map((uuid) => {
			const step = byOperation.get(uuid);
			const key = JSON.stringify([repeat, iteration, uuid]);
			if (
				!step ||
				step.operation.forEach?.repeat !== repeat ||
				seenEffects.has(key)
			)
				throw malformed();
			seenEffects.add(key);
			return step;
		});
		if ("absent" in slot && slot.absent === true) continue;

		const append = (
			operations: readonly ProgramStep[],
			sessionCaseId: string | undefined,
			selection: number,
			perSelectedCase: boolean,
		): void => {
			for (const envelope of operations) {
				instances.push({
					envelope,
					scopeRepeat: repeat,
					iteration,
					selection,
					perSelectedCase,
					sessionCaseId,
					formFields: bindings.formFields,
				});
			}
		};
		if (multiple) {
			const formOperations = operations.filter(
				({ operation }) => !caseOperationRunsPerSelectedCase(operation),
			);
			const selectedOperations = operations.filter(({ operation }) =>
				caseOperationRunsPerSelectedCase(operation),
			);
			append(formOperations, undefined, 0, false);
			for (const [selection, caseId] of selectedCases.entries())
				append(selectedOperations, caseId, selection, true);
		} else append(operations, selectedCases[0], 0, false);
	}
	if (seenEffects.size !== expectedEffects) throw malformed();

	return instances;
}

// ---------------------------------------------------------------
// Identity allocation
// ---------------------------------------------------------------

interface CreateAllocation {
	readonly caseId: string;
	readonly authored: boolean;
	/** The id the entry's session minted for this case (`entryCaseKeys`):
	 * a row already holding it refuses the submission, never merges. */
	readonly entryNamed?: boolean;
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
	entryKey: string,
	program: CaseOperationProgram,
	instances: readonly PhysicalInstance[],
): Map<number, CreateAllocation> {
	const allocations = new Map<number, CreateAllocation>();
	for (const [index, instance] of instances.entries()) {
		const operation = instance.envelope.operation;
		if (operation.action !== "create" || operation.target.kind !== "new") {
			continue;
		}
		// A case the entry's session names takes the id the form read as
		// `session/data/<datum>` while it ran, whatever its placement: every
		// create the form's wire plan gives a datum. Each has its own key, and
		// the builder names only creates outside a repeat, so no id is reused
		// within one submission.
		const entryCaseKey = program.entryCaseKeys?.get(operation.uuid);
		if (entryCaseKey !== undefined) {
			allocations.set(index, {
				caseId:
					program.suppliedCaseIds?.get(operation.uuid) ??
					entryDatumCaseId(appId, entryKey, entryCaseKey),
				authored: false,
				entryNamed: true,
			});
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
 * every root create, plus same-scope creates of the SAME authored repeat
 * iteration. A form-level create runs outside the selected-case axis; its one
 * allocation is visible to every selected-case operation in that authored
 * iteration. A create linked to the loaded case of a several-case form runs
 * once per selected case, so its allocation is visible only to the
 * operations of that same selected case, as the wire reads it inside the
 * same selected-case row. A repeated create's id never escapes its authored
 * iteration — the authoring gate enforces the correlation, and an
 * uncorrelated reference here surfaces as the compiler's missing-binding
 * invariant.
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
		const sameSelection =
			!producer.perSelectedCase ||
			(consumer.perSelectedCase && producer.selection === consumer.selection);
		const correlated =
			sameSelection &&
			(producer.scopeRepeat === undefined ||
				(producer.scopeRepeat === consumer.scopeRepeat &&
					producer.iteration === consumer.iteration));
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
	readonly operationUuid: string;
	readonly operationId: string;
	readonly slot: string;
	/** Physical instance index the projection belongs to. */
	readonly instance: number;
	readonly expression?: DomainExpression;
	readonly predicate?: DomainExpression;
	/** A value saved to a text property, whose number reads back as a
	 * double (`compileSubmittedTextValue`). */
	readonly savedAsText?: true;
}

/** Execute the normal expression compiler against the signed entry's device rows.
 * The CTEs only exist in this SELECT. The later locks and DML use current tables. */
async function readOpeningValues(
	trx: Transaction<Database>,
	program: CaseOperationProgram,
	projectId: string,
	query: SqlExpression<Record<string, unknown>>,
): Promise<Record<string, unknown> | undefined> {
	const opening = program.openingReads;
	if (!opening)
		return (await sql<Record<string, unknown>>`${query}`.execute(trx)).rows[0];
	const statement = sql<Record<string, unknown>>`
		WITH cases AS (
			SELECT opening_case.*, ${projectId}::text AS project_id
			FROM jsonb_to_recordset(${JSON.stringify(opening.cases.rows)}::jsonb) AS opening_case(
				case_id text, app_id text, case_type text, owner_id text, status text,
				opened_on timestamptz, modified_on timestamptz, closed_on timestamptz,
				case_name text, external_id text, location_id text, parent_case_id text,
				properties jsonb)
		), case_indices AS (
			SELECT * FROM jsonb_to_recordset(${JSON.stringify(opening.cases.indices)}::jsonb)
			AS opening_index(case_id text, ancestor_id text, target_case_type text, identifier text, relationship text, depth int)
		), parked_case_values AS (
			SELECT null::uuid AS id, null::text AS case_id, null::timestamptz AS dismissed_at WHERE false
		), lookup_rows AS (
			SELECT opening_lookup.*, ${projectId}::text AS project_id
			FROM jsonb_to_recordset(${JSON.stringify(opening.lookupRows)}::jsonb)
			AS opening_lookup(id uuid, table_id uuid, order_key bigint, values jsonb)
		) ${query}`;
	return (await statement.execute(trx)).rows[0];
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
	sessionFor: (instance: number) => SessionAnchor | undefined,
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
			const session = sessionFor(request.instance);
			const ctx: PredicateCompileContext = {
				// An operation's values and conditions are the form's, which a
				// device evaluates over its casedb.
				reading: "casedb",
				db: trx,
				appId,
				projectId: host.projectId,
				anchorAlias: "c",
				...(session === undefined ? {} : { currentCaseType: session.caseType }),
				caseTypeSchemas: program.caseTypeSchemas,
				formFieldTypes: program.formFieldTypes,
				...(program.formFieldHeld === undefined
					? {}
					: { formFieldHeld: program.formFieldHeld }),
				...(program.organizationLevels === undefined
					? {}
					: { organizationLevels: program.organizationLevels }),
				...(program.openingReads && {
					workerPlaceLineage: program.openingReads.locations ?? [],
				}),
				...(program.workerPlaceIds === undefined
					? {}
					: { workerPlaceIds: program.workerPlaceIds }),
				...(program.lookupTableSchemas === undefined
					? {}
					: { lookupTableSchemas: program.lookupTableSchemas }),
				bindings: bindingsFor(request.instance),
			};
			const projection =
				request.predicate !== undefined
					? eb
							.case()
							.when(compilePredicate(request.predicate, ctx))
							.then(true)
							.else(false)
							.end()
					: request.expression !== undefined
						? request.savedAsText === true
							? compileSubmittedTextValue(
									request.expression,
									expressionContextFor(ctx),
								)
							: compileExpression(request.expression, expressionContextFor(ctx))
						: undefined;
			if (projection === undefined) {
				throw new Error(
					compilerBugMessage({
						where: "case-store.submissionEnvelope.evaluateBatch",
						invariant:
							"an evaluation request carried neither expression nor predicate",
						detail:
							"Each request is exactly one of the two shapes; the projection builders in this module construct them. Hint: an empty request indicates a builder emitted a placeholder without content.",
					}),
				);
			}
			if (session === undefined) return projection.as(alias);
			return trx
				.selectFrom("cases as c")
				.select(projection.as("value"))
				.where("c.app_id", "=", appId)
				.where("c.case_id", "=", session.caseId)
				.where("c.project_id", "=", host.projectId)
				.limit(1)
				.as(alias);
		});
		await sql`SAVEPOINT submission_expression`.execute(trx);
		let row: Record<string, unknown> | undefined;
		try {
			row = await readOpeningValues(
				trx,
				program,
				host.projectId,
				trx.selectNoFrom(selections),
			);
		} catch (error) {
			const reasonFor = (failure: unknown) => {
				const code =
					failure !== null && typeof failure === "object" && "code" in failure
						? failure.code
						: undefined;
				return code === "22P02" || code === "22007" || code === "22008"
					? ("invalid-value" as const)
					: code === "22012"
						? ("division-by-zero" as const)
						: code === "22003"
							? ("numeric-overflow" as const)
							: undefined;
			};
			if (!reasonFor(error)) throw error;
			await sql`ROLLBACK TO SAVEPOINT submission_expression`.execute(trx);
			// Only a failing batch pays for diagnosis. Re-evaluate each projection in
			// the same pre-effect transaction and bindings to identify the exact slot.
			for (const [offset, selection] of selections.entries()) {
				try {
					await readOpeningValues(
						trx,
						program,
						host.projectId,
						trx.selectNoFrom(selection),
					);
				} catch (cause) {
					const reason = reasonFor(cause);
					if (!reason) throw cause;
					await sql`ROLLBACK TO SAVEPOINT submission_expression`.execute(trx);
					await sql`RELEASE SAVEPOINT submission_expression`.execute(trx);
					const request = chunk[offset];
					const fields = new Set<string>();
					const visit = (
						term: import("@/lib/domain/expression/types").Term,
					) => {
						if (term.kind === "field") fields.add(term.uuid);
					};
					if (request.expression)
						walkExpressionTerms(request.expression, visit);
					if (request.predicate) walkExpressionTerms(request.predicate, visit);
					throw new SubmissionRejectedError(
						{
							kind: "expression",
							reason,
							operationUuid: request.operationUuid,
							operationId: request.operationId,
							slot: request.slot,
							fieldUuids: [...fields],
						},
						{ cause },
					);
				}
			}
			// A non-reproducible failure is still an infrastructure error, not a guess.
			throw error;
		}
		await sql`RELEASE SAVEPOINT submission_expression`.execute(trx);
		if (row === undefined) {
			throw new Error(
				compilerBugMessage({
					where: "case-store.submissionEnvelope.evaluateBatch",
					invariant: "an expression-only SELECT returned no result row",
				}),
			);
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
 *
 * `zone` is the submitting viewer's timezone where one is known
 * (`CaseOperationProgram.viewerTimeZone`), because a form answer reaching
 * this boundary can be a wall clock a person just entered in that zone. A
 * date and time is then stored as the text CommCare HQ stores for its
 * moment, UTC with six fraction digits and `Z`, the text a phone writes
 * (`caseDatetimeValue`). It falls back to UTC for a caller with no viewer,
 * which is deterministic rather than the server's incidental zone.
 */
export function storageValueFromEvaluation(
	value: unknown,
	dataType: CasePropertyDataType,
	zone = "UTC",
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
			// One choice saved to a list of choices (`ruleSets.ts::
			// isValueStorageAssignable`): the list a device reads from the
			// text it stores, its values split on spaces.
			if (typeof value === "string") {
				const tokens = value.split(/\s+/).filter((token) => token !== "");
				return tokens.length === 0 ? undefined : tokens;
			}
			throw new Error(
				compilerBugMessage({
					where: "case-store.submissionEnvelope.storageValueFromEvaluation",
					invariant: `a multi-select write evaluated to a non-array ${typeof value}`,
					detail:
						"Directional storage assignment admits a semantically multi-select value, including a calculated answer, for a multi-select property. The term compiler serializes that binding as a JSONB array. A scalar arriving here means its declared type or runtime representation was lost upstream.",
				}),
			);
		}
		case "int":
		case "decimal": {
			return typeof value === "number" ? value : Number(String(value));
		}
		case "date": {
			if (value instanceof Date) return localDayText(value);
			return dayText(String(value), zone);
		}
		case "datetime": {
			// A date and time on a case is the text CommCare HQ stores, UTC
			// with six fraction digits and `Z`, the text a phone writes too. A
			// `Date` came back from a pg `timestamptz` and already denotes an
			// exact instant; only a string can still be the naive wall clock
			// a form answer carries, read in the viewer's zone. A moment whose
			// UTC year has no four digits (a literal's offset or a date added
			// to past 9999) keeps an offset that gives it one, as the device's
			// own spelling of such a literal does.
			if (value instanceof Date) return caseInstantText(value.getTime());
			return caseDatetimeValue(String(value), zone);
		}
		case "time": {
			// A time answer is a wall clock with no zone of its own
			// (`TimeData::uncast`), so this takes the storage tag rather
			// than an offset — see `lib/domain/temporalValues.ts`.
			return storageTimeValue(String(value));
		}
		case "text":
		case "single_select":
		case "geopoint": {
			// A number, a date or a location saved to text is the text a device
			// submits for it (`casePropertyTypes.ts::TEXT_JOINED_DATA_TYPES`; a
			// location is already its four numbers' text): a number read
			// back as a double (`compileSubmittedTextValue`) as
			// `Recalculate.wrapData` holds it, and a date, which a `date`
			// column gives in the process's local time, as its day. A date and
			// time never reaches text (`ruleSets.ts::isWriteAssignable`).
			if (typeof value === "number") return submittedNumberText(value);
			if (value instanceof Date) return localDayText(value);
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

/**
 * The day a `date` property keeps of a value's text. A date and time (a
 * date-and-time question's answer saved to a day,
 * `ruleSets.ts::isAnswerWriteAssignable`) keeps the day of its moment where
 * the device is: Core wraps it as `DateData` (`Recalculate.java::wrapData`),
 * which a device writes as its day in its own zone, the viewer's here
 * (`zone`). Any other text is kept as it is, for the schema to judge.
 */
function dayText(text: string, zone: string): string {
	const trimmed = text.trim();
	if (!trimmed.includes("T")) return text;
	const instant = Date.parse(storageDatetimeValue(trimmed, zone));
	if (Number.isNaN(instant)) return text;
	return instantDatetimeValue(instant, zone).slice(0, 10);
}

/** node-postgres parses a `date` column in LOCAL time; read the local
 * calendar parts back so the stored lexical day is the day Postgres
 * emitted, whatever the process zone. */
function localDayText(value: Date): string {
	const y = value.getFullYear();
	const m = `${value.getMonth() + 1}`.padStart(2, "0");
	const d = `${value.getDate()}`.padStart(2, "0");
	return `${y}-${m}-${d}`;
}

/** The text a device submits for a calculated number: `wrapData`'s data
 * uncast (`numericAnswerText`), and `Double.toString` of an infinity. NaN
 * is `wrapData`'s blank. */
function submittedNumberText(value: number): string | undefined {
	if (Number.isNaN(value)) return undefined;
	if (!Number.isFinite(value)) return value > 0 ? "Infinity" : "-Infinity";
	return numericAnswerText(value);
}

/** The data type of the property an operation's write saves to: the
 * operation's result type (the retype destination when it retypes, since
 * the wire applies the writes and the type change in one block), or the
 * type a write's `via` chain reaches; text where the catalog holds no
 * type. */
function writeDataType(
	program: CaseOperationProgram,
	envelope: EnvelopeCaseOperation,
	writeIndex: number,
): CasePropertyDataType {
	const operation = envelope.operation;
	const write = operation.writes?.[writeIndex];
	const caseType =
		write?.via === undefined
			? (operation.retype ?? operation.caseType)
			: envelope.viaCaseTypes?.get(writeIndex);
	const schema =
		caseType === undefined ? undefined : program.caseTypeSchemas.get(caseType);
	return (
		schema?.properties?.find((property) => property.name === write?.property)
			?.data_type ?? "text"
	);
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
	/** Holds the submitted id for HQ history without changing device state. */
	readonly childlessBlock?: true;
	/** True when an authored-key create resolved to an existing row —
	 * the create-of-existing merge arm. */
	readonly mergesExisting: boolean;
	/** A create with the id the entry's session minted for it. */
	readonly entryNamed?: boolean;
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
	/** Executing writes that save through an index to a case above, each
	 * on the case the chain reached in the pre-submission snapshot. A chain
	 * that reaches no case saves nothing, so it has no entry. */
	readonly viaWrites: ReadonlyArray<{
		caseId: string;
		property: string;
		value: JsonValue | undefined;
	}>;
	/** The case closes after its writes: a close operation, or the own arm
	 * whose close condition held. */
	readonly closes: boolean;
}

export interface ResolvedLink {
	readonly identifier: string;
	readonly relationship: "child" | "extension";
	readonly targetType: string;
	/** Null = remove the identifier's edge. */
	readonly targetCaseId: string | null;
	readonly snapshotCaseType?: string;
}

const MAX_SELECTED_CASES = 100;

/** The owner CommCare HQ's build gives a case it creates beside an
 *  `owner_id` update (`const.py::UNOWNED_EXTENSION_OWNER_ID`). */
const UNOWNED_OWNER_ID = "-";

function rejectSelection(
	rejection: Extract<
		ConstructorParameters<typeof SubmissionRejectedError>[0],
		{ kind: "selection" }
	>,
): never {
	throw new SubmissionRejectedError(rejection);
}

function validatedSelectedCaseIds(
	args: ApplySubmissionArgs,
): readonly string[] {
	const ordinary = args.ordinary;
	if (ordinary.kind !== "followup" && ordinary.kind !== "close") {
		const programCaseIds = args.operations?.sessionCaseIds;
		if (ordinary.kind === "registration" && programCaseIds !== undefined) {
			rejectSelection({
				kind: "selection",
				reason: "program-selection-mismatch",
			});
		}
		if (programCaseIds === undefined) return [];
		if (programCaseIds.length === 0) {
			rejectSelection({
				kind: "selection",
				reason: "empty",
				maximum: MAX_SELECTED_CASES,
			});
		}
		if (programCaseIds.length > MAX_SELECTED_CASES) {
			rejectSelection({
				kind: "selection",
				reason: "too-many",
				maximum: MAX_SELECTED_CASES,
			});
		}
		const seen = new Set<string>();
		for (const caseId of programCaseIds) {
			if (caseId.trim().length === 0) {
				rejectSelection({
					kind: "selection",
					reason: "not-found-or-out-of-scope",
					caseId,
				});
			}
			if (seen.has(caseId)) {
				rejectSelection({ kind: "selection", reason: "duplicate", caseId });
			}
			seen.add(caseId);
		}
		return programCaseIds;
	}
	const caseIds = ordinary.caseIds;
	const maximum = ordinary.selection.maximum;
	if (
		!Number.isInteger(maximum) ||
		maximum < 1 ||
		maximum > MAX_SELECTED_CASES ||
		(ordinary.selection.kind === "single" && maximum !== 1)
	) {
		rejectSelection({
			kind: "selection",
			reason: "too-many",
			maximum: Math.min(MAX_SELECTED_CASES, Math.max(1, maximum)),
		});
	}
	if (caseIds.length === 0) {
		rejectSelection({ kind: "selection", reason: "empty", maximum });
	}
	if (caseIds.length > maximum || caseIds.length > MAX_SELECTED_CASES) {
		rejectSelection({ kind: "selection", reason: "too-many", maximum });
	}
	const seen = new Set<string>();
	for (const caseId of caseIds) {
		if (caseId.trim().length === 0) {
			rejectSelection({
				kind: "selection",
				reason: "not-found-or-out-of-scope",
				caseId,
			});
		}
		if (seen.has(caseId)) {
			rejectSelection({ kind: "selection", reason: "duplicate", caseId });
		}
		seen.add(caseId);
	}
	if (ordinary.selection.kind === "single" && caseIds.length !== 1) {
		rejectSelection({ kind: "selection", reason: "too-many", maximum: 1 });
	}
	if (
		args.operations !== undefined &&
		(args.operations.sessionCaseIds === undefined ||
			args.operations.sessionCaseIds.length !== caseIds.length ||
			args.operations.sessionCaseIds.some(
				(caseId, index) => caseId !== caseIds[index],
			))
	) {
		rejectSelection({
			kind: "selection",
			reason: "program-selection-mismatch",
		});
	}
	if (ordinary.selection.kind === "multiple") {
		for (const entry of args.operations?.operations ?? []) {
			if (
				entry.operation.action === "create" &&
				entry.operation.target.kind === "new" &&
				entry.operation.target.idFrom !== undefined
			) {
				rejectSelection({
					kind: "selection",
					reason: "authored-key-create-not-supported",
				});
			}
			// Inside an operation that runs per selected case, a link to the
			// loaded case names that selected case; any other operation runs
			// once for the form and has no one selected case to name.
			if (
				!caseOperationRunsPerSelectedCase(entry.operation) &&
				(entry.operation.links ?? []).some(
					(link) => link.target?.kind === "session",
				)
			) {
				rejectSelection({
					kind: "selection",
					reason: "session-link-not-supported",
				});
			}
		}
	}
	return caseIds;
}

export async function executeSubmissionEnvelope(
	trx: Transaction<Database>,
	host: SubmissionEnvelopeHost,
	args: ApplySubmissionArgs,
): Promise<
	SubmissionEnvelopeResult & {
		readonly deviceExternalIds: DeviceExternalIds;
		readonly reachedWriteCaseIds: readonly string[];
	}
> {
	const deviceExternalIds: DeviceExternalIds = new Map();
	const steps =
		args.operations === undefined
			? []
			: programSteps(args.operations, args.ordinary);
	// Resolve the worker record before any effects, exactly as the device's
	// hq_user_id join does. A historical case id is never reconstructed from
	// the acting worker, and every read remains inside the bound app/Project.
	let workerRecordCaseId: string | undefined;
	if (steps.some((step) => step.operation.target.kind === "worker-record")) {
		const rows = await trx
			.selectFrom("cases")
			.select(["case_id", "status", "owner_id"])
			.where("app_id", "=", args.appId)
			.where("project_id", "=", host.projectId)
			.where("case_type", "=", USERCASE_CASE_TYPE)
			.where(sql<string>`properties->>'hq_user_id'`, "=", host.actingUserId)
			.orderBy("case_id")
			.forUpdate()
			.limit(2)
			.execute();
		if (rows.length > 1)
			throw new Error("More than one worker record exists for this app.");
		if (
			rows[0] === undefined ||
			rows[0].status !== "open" ||
			rows[0].owner_id !== host.actingUserId
		)
			throw new CaseNotFoundError(host.actingUserId);
		workerRecordCaseId = rows[0].case_id;
	}
	const selectedCaseIds = validatedSelectedCaseIds(args);
	const opening = args.operations?.openingReads;
	const currentAccess =
		opening &&
		buildRestoreScope(trx, {
			appId: args.appId,
			projectId: host.projectId,
			ownerIds: opening.currentOwnerIds,
		});
	const sessionAnchors = await loadSelectedCaseAnchors(
		trx,
		host,
		args.appId,
		args.ordinary,
		selectedCaseIds,
		currentAccess,
		opening?.submittedCaseIds,
	);
	const operationRecords: OperationEffectRecord[] = [];
	const reachedWriteCaseIds = new Set<string>();
	let registeredCaseId: string | undefined;

	if (args.operations !== undefined && steps.length > 0) {
		const program = await resolveOperationProgram(
			trx,
			host,
			args,
			args.operations,
			steps,
			sessionAnchors,
			workerRecordCaseId,
		);
		registeredCaseId = program.registeredCaseId;
		for (const entry of program.resolved) {
			for (const write of entry.viaWrites)
				reachedWriteCaseIds.add(write.caseId);
			operationRecords.push({
				operationUuid: entry.instance.envelope.operation.uuid,
				iteration: entry.instance.iteration,
				selection: entry.instance.selection,
				action: entry.instance.envelope.recordAction,
				caseId: entry.caseId,
				executed: entry.executed,
				...(entry.childlessBlock && { childlessBlock: true }),
			});
		}
		await applyOperationEffects(
			trx,
			host,
			args.appId,
			program.resolved,
			args.ordinary,
			deviceExternalIds,
		);
	}

	const ordinary = args.ordinary;
	return {
		primaryCaseIds:
			ordinary.kind === "followup" || ordinary.kind === "close"
				? ordinary.caseIds
				: registeredCaseId === undefined
					? []
					: [registeredCaseId],
		createdChildren: [],
		operations: operationRecords,
		reachedWriteCaseIds: [...reachedWriteCaseIds],
		deviceExternalIds,
	};
}

/** Phases 1–4: expand, allocate, evaluate, resolve, and prove the
 * program — everything before the first effect. */
async function resolveOperationProgram(
	trx: Transaction<Database>,
	host: SubmissionEnvelopeHost,
	args: ApplySubmissionArgs,
	program: CaseOperationProgram,
	steps: readonly ProgramStep[],
	sessions: ReadonlyMap<string, SessionAnchor>,
	workerRecordCaseId: string | undefined,
): Promise<{
	readonly resolved: ResolvedInstance[];
	/** The id a registration's own arm creates its case with, whether or not
	 * its open condition held: the id the entry's session names for it. */
	readonly registeredCaseId?: string;
}> {
	const appId = args.appId;
	const ordinary = args.ordinary;
	const revisions = program.groupDefaults?.revisions;
	if (revisions) {
		// A zero revision can mean no prior writer. Materialize both clock rows
		// before locking so the first concurrent membership or place edit also waits.
		await sql`INSERT INTO lookup_project_state(project_id) VALUES (${host.projectId}) ON CONFLICT DO NOTHING`.execute(
			trx,
		);
		await sql`INSERT INTO app_organization_state(app_id) VALUES (${appId}) ON CONFLICT DO NOTHING`.execute(
			trx,
		);
		const current = await sql<{
			project: string;
			places: string;
		}>`SELECT COALESCE((SELECT revision FROM lookup_project_state WHERE project_id=${host.projectId} FOR SHARE),0)::text project,
   COALESCE((SELECT revision FROM app_organization_state WHERE app_id=${appId} FOR SHARE),0)::text places`.execute(
			trx,
		);
		const [row] = current.rows;
		if (row.project !== revisions.project || row.places !== revisions.places)
			throw new CaptureSubmissionRejectedError(
				"The worker’s groups or places changed. You can reopen the form with their current assignments.",
			);
	}

	// Lookup writers take the table FOR UPDATE before changing definitions or
	// rows. Hold each referenced table in UUID order across every evaluation
	// phase, so a guard and its value cannot observe different generations.
	// The store already holds the app's authorization and relationship locks;
	// lookup writers never request either after acquiring a table lock.
	const lookupTableIds = [...(program.lookupTableSchemas?.keys() ?? [])].sort();
	if (lookupTableIds.length > 0) {
		const locked = await sql<{ id: string }>`
			SELECT id::text AS id FROM lookup_tables
			WHERE project_id = ${host.projectId}
				AND id IN (${sql.join(lookupTableIds)})
			ORDER BY id FOR SHARE
		`.execute(trx);
		if (locked.rows.length !== lookupTableIds.length) {
			throw new Error(
				compilerBugMessage({
					where: "case-store.submissionEnvelope.resolveOperationProgram",
					invariant:
						"an operation's lookup definitions name unavailable tables",
					detail:
						"Every definition must resolve in the authorized Project before evaluation.",
				}),
			);
		}
	}
	const instances = expandPhysicalInstances(program, steps, ordinary);
	const allocations = allocateCreateIdentities(
		appId,
		args.submissionReceipt.entryKey,
		program,
		instances,
	);
	let registeredCaseId: string | undefined;
	for (const [index, allocation] of allocations) {
		if (instances[index]?.envelope.own) registeredCaseId = allocation.caseId;
	}

	// The pre-submission session anchor. Loaded first (and inside the
	// transaction, after the advisory lock) so every evaluation and
	// descriptor below reads one immutable snapshot.
	const sessionFor = (index: number): SessionAnchor | undefined => {
		const caseId = instances[index]?.sessionCaseId;
		return caseId === undefined ? undefined : sessions.get(caseId);
	};

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
			actingUserId: host.actingUserId,
			...(program.entryDatums && { entryDatums: program.entryDatums }),
			...(program.sessionUser === undefined
				? {}
				: { sessionUser: program.sessionUser }),
			...(program.userPropertySlugs === undefined
				? {}
				: { userPropertySlugs: program.userPropertySlugs }),
			...(program.sessionUserAbsent === undefined
				? {}
				: { sessionUserAbsent: program.sessionUserAbsent }),
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
			conditionRequests.push({
				instance: index,
				predicate,
				operationUuid: instance.envelope.operation.uuid,
				operationId: instance.envelope.operation.id,
				slot: "condition",
			});
		}
	}
	const conditionResults = await evaluateBatch(
		trx,
		host,
		appId,
		program,
		sessionFor,
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

	// Resolve leaf guards before requesting values. An omitted leaf must
	// not evaluate blank numeric answers or other unused expressions. These
	// reads share the operation guards' pre-effect view under the app lock.
	const leafGuardRequests: EvalRequest[] = [];
	const leafGuardSlots: Array<{ instance: number; write?: number }> = [];
	for (const [index, instance] of instances.entries()) {
		if (!executing[index]) continue;
		const operation = instance.envelope.operation;
		if (operation.ownerCondition !== undefined) {
			leafGuardSlots.push({ instance: index });
			leafGuardRequests.push({
				instance: index,
				predicate: operation.ownerCondition,
				operationUuid: operation.uuid,
				operationId: operation.id,
				slot: "owner condition",
			});
		}
		for (const [writeIndex, write] of (operation.writes ?? []).entries()) {
			if (write.condition === undefined) continue;
			leafGuardSlots.push({ instance: index, write: writeIndex });
			leafGuardRequests.push({
				instance: index,
				predicate: write.condition,
				operationUuid: operation.uuid,
				operationId: operation.id,
				slot: `write condition: ${write.property}`,
			});
		}
	}
	const leafGuardResults = await evaluateBatch(
		trx,
		host,
		appId,
		program,
		sessionFor,
		bindingsFor,
		leafGuardRequests,
	);
	const skippedOwners = new Set<number>();
	const skippedWrites = new Map<number, Set<number>>();
	for (const [slotIndex, slot] of leafGuardSlots.entries()) {
		if (leafGuardResults[slotIndex] === true) continue;
		if (slot.write === undefined) {
			skippedOwners.add(slot.instance);
			continue;
		}
		let writes = skippedWrites.get(slot.instance);
		if (writes === undefined) {
			writes = new Set();
			skippedWrites.set(slot.instance, writes);
		}
		writes.add(slot.write);
	}

	// Phase: values + runtime targets for executing instances and writes.
	interface ValueSlot {
		readonly instance: number;
		readonly kind:
			| "name"
			| "rename"
			| "owner"
			| "target"
			| "close"
			| { write: number }
			| { link: number };
	}
	const valueRequests: EvalRequest[] = [];
	const valueSlots: ValueSlot[] = [];
	const request = (
		instance: number,
		kind: ValueSlot["kind"],
		content: {
			expression?: DomainExpression;
			predicate?: DomainExpression;
			savedAsText?: true;
		},
	) => {
		valueSlots.push({ instance, kind });
		const operation = instances[instance].envelope.operation;
		valueRequests.push({
			instance,
			...content,
			operationUuid: operation.uuid,
			operationId: operation.id,
			slot:
				typeof kind === "string"
					? kind
					: "write" in kind
						? `property: ${operation.writes?.[kind.write].property}`
						: `link: ${kind.link}`,
		});
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
		if (operation.owner !== undefined && !skippedOwners.has(index)) {
			request(index, "owner", { expression: operation.owner });
		}
		if (
			operation.action !== "create" &&
			operation.target.kind === "expression"
		) {
			request(index, "target", { expression: operation.target.expr });
		}
		for (const [writeIndex, write] of (operation.writes ?? []).entries()) {
			if (skippedWrites.get(index)?.has(writeIndex)) continue;
			request(
				index,
				{ write: writeIndex },
				{
					expression: write.value,
					...(!isScalarColumnWrite(write.property) &&
						writeDataType(program, instance.envelope, writeIndex) ===
							"text" && { savedAsText: true as const }),
				},
			);
		}
		for (const [linkIndex, link] of (operation.links ?? []).entries()) {
			if (link.target?.kind === "expression") {
				request(index, { link: linkIndex }, { expression: link.target.expr });
			}
		}
		const closeCondition = instance.envelope.closeLeaf?.condition;
		if (closeCondition !== undefined) {
			request(index, "close", { predicate: closeCondition });
		}
	}
	const valueResults = await evaluateBatch(
		trx,
		host,
		appId,
		program,
		sessionFor,
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
			close?: unknown;
			writes: Map<number, unknown>;
			links: Map<number, unknown>;
		}
	>();
	for (const [slotIndex, slot] of valueSlots.entries()) {
		let bag = valuesByInstance.get(slot.instance);
		if (bag === undefined) {
			bag = {
				writes: new Map(),
				links: new Map(),
			};
			valuesByInstance.set(slot.instance, bag);
		}
		const value = valueResults[slotIndex];
		if (slot.kind === "name") bag.name = value;
		else if (slot.kind === "rename") bag.rename = value;
		else if (slot.kind === "owner") bag.owner = value;
		else if (slot.kind === "target") bag.target = value;
		else if (slot.kind === "close") bag.close = value;
		else if ("write" in slot.kind) bag.writes.set(slot.kind.write, value);
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
	const opening = program.openingReads;
	const currentAccess =
		opening &&
		buildRestoreScope(trx, {
			appId,
			projectId: host.projectId,
			ownerIds: opening.currentOwnerIds,
		});
	const knownRows = await loadTargetRows(
		trx,
		host,
		appId,
		{
			unheldIds: expressionIds.filter((id) => id !== ""),
			anyIds: [...authoredIds, ...(program.sessionCaseIds ?? [])],
		},
		currentAccess,
		opening?.submittedCaseIds,
	);

	// Resolve every executing instance's target + links.
	const openingCaseIds =
		opening && new Set(opening.cases.rows.map((row) => row.case_id));
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
				viaWrites: [],
				closes: false,
			});
			continue;
		}
		const bag = valuesByInstance.get(index);
		const closeLeaf = instance.envelope.closeLeaf;
		const closes =
			closeLeaf !== undefined &&
			(closeLeaf.condition === undefined || bag?.close === true);
		const childlessClose =
			operation.action === "close" &&
			!closes &&
			(operation.writes?.length ?? 0) === 0;
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
					if (instance.sessionCaseId === undefined) {
						throw new SubmissionRejectedError({
							kind: "target",
							operationUuid: operation.uuid,
							slot: "target",
							reason: "not-found-or-out-of-scope",
						});
					}
					const row = knownRows.get(instance.sessionCaseId);
					if (row === undefined) {
						throw new SubmissionRejectedError({
							kind: "target",
							operationUuid: operation.uuid,
							slot: "target",
							reason: "not-found-or-out-of-scope",
						});
					}
					return {
						caseId: instance.sessionCaseId,
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
				case "worker-record": {
					// Resolved once, before any effect, from the acting worker's
					// own record in this app and Project.
					if (workerRecordCaseId === undefined) {
						throw new Error(
							compilerBugMessage({
								where: "case-store.submissionEnvelope.resolveOperationProgram",
								invariant: `operation \`${operation.uuid}\` targets the worker's record, which was not resolved`,
								detail:
									"The envelope resolves the worker's record whenever an operation targets it, before evaluation.",
							}),
						);
					}
					return {
						caseId: workerRecordCaseId,
						snapshotCaseType: USERCASE_CASE_TYPE,
						mergesExisting: false,
					};
				}
				case "expression": {
					const evaluated = evaluatedText(bag?.target);
					const expectedSnapshotType =
						instance.envelope.expressionSnapshotTypes.target ??
						operation.caseType;
					const row = evaluated === "" ? undefined : knownRows.get(evaluated);
					if (childlessClose) {
						if (!row || evaluated.length > MAX_AUTHORED_CASE_ID_LENGTH)
							throw new SubmissionRejectedError({
								kind: "target",
								operationUuid: operation.uuid,
								slot: "target",
								reason: "not-found-or-out-of-scope",
							});
						// Core does not load a childless block's ID. HQ still
						// records a transaction and can create an untyped row
						// for an unknown ID. Accept only an authorized row.
						return {
							caseId: evaluated,
							snapshotCaseType: row.caseType,
							mergesExisting: false,
						};
					}
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
							knownKinds: [
								"new",
								"op",
								"session",
								"expression",
								"worker-record",
							],
						}),
					);
				}
			}
		};
		const target = resolveTargetId();
		if (
			target.snapshotCaseType === USERCASE_CASE_TYPE &&
			(operation.action !== "update" ||
				closes ||
				operation.retype ||
				operation.owner ||
				operation.rename ||
				operation.links?.length)
		) {
			throw new SubmissionRejectedError({
				kind: "target",
				operationUuid: operation.uuid,
				slot: "target",
				reason: "managed-worker-record",
			});
		}

		if (childlessClose) {
			resolvedInstances.push({
				...target,
				instance,
				index,
				executed: false,
				childlessBlock: true,
				writes: [],
				links: [],
				viaWrites: [],
				closes: false,
			});
			continue;
		}
		if (
			openingCaseIds &&
			operation.action !== "create" &&
			operation.target.kind === "expression" &&
			(operation.closeCondition || operation.closeAfter) &&
			!openingCaseIds.has(target.caseId)
		) {
			throw new SubmissionRejectedError({
				kind: "target",
				operationUuid: operation.uuid,
				slot: "target",
				reason: "not-found-or-out-of-scope",
			});
		}

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
						instance.sessionCaseId === undefined ||
						!knownRows.has(instance.sessionCaseId)
					) {
						throw new SubmissionRejectedError({
							kind: "target",
							operationUuid: operation.uuid,
							slot,
							reason: "not-found-or-out-of-scope",
						});
					}
					return {
						caseId: instance.sessionCaseId,
						snapshotCaseType: knownRows.get(instance.sessionCaseId)?.caseType,
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
		// calculate and HQ (`prepareCaseScalarTextValue`), applied to
		// every evaluated name/rename/owner INCLUDING the create's
		// default acting-user owner.
		const prepareText = (
			facet: "name" | "rename" | "owner",
			raw: string,
		): string => {
			const prepared = prepareCaseScalarTextValue(raw, "reject");
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
		// An owner saved only when changed (`CaseFacetOnlyIfChanged`) is
		// compared with the case's `owner_id` leaf, which a case holds as an
		// attribute, so the comparison reads "" and a blank answer saves
		// nothing. On a case the form creates, CommCare HQ's build then leaves
		// the create block's own owner `-` (`autoset_owner_id_for_*`).
		const ownerKept =
			operation.ownerOnlyIfChanged === true &&
			blankText(evaluatedText(bag?.owner));
		let preparedOwner: string | undefined;
		if (operation.action === "create") {
			const groupOwner =
				operation.ownerCondition === undefined &&
				program.groupDefaults?.operations.includes(operation.uuid)
					? program.groupDefaults.owner
					: undefined;
			// HQ and Core default an omitted create/owner_id to this
			// submitting user for a fresh case. The group's default is an
			// HQ case-action feature; it does not own this Save to Case leaf.
			const ownerValue =
				skippedOwners.has(index) || operation.owner === undefined
					? (groupOwner ?? host.actingUserId)
					: (groupOwner ?? evaluatedText(bag?.owner));
			preparedOwner =
				ownerKept && operation.ownerCondition === undefined
					? UNOWNED_OWNER_ID
					: prepareText("owner", ownerValue);
		} else if (
			operation.action === "update" &&
			operation.owner !== undefined &&
			!ownerKept &&
			!(
				instance.envelope.blankSavesNothing &&
				blankText(evaluatedText(bag?.owner))
			)
		) {
			preparedOwner = prepareText("owner", evaluatedText(bag?.owner));
		}
		let preparedRename =
			operation.rename === undefined ||
			(instance.envelope.blankSavesNothing &&
				blankText(evaluatedText(bag?.rename)))
				? undefined
				: prepareText("rename", evaluatedText(bag?.rename));

		// Executing writes, storage-converted against the operation's
		// RESULT type — the retype destination when the operation
		// retypes, since the validator resolves write properties against
		// `retype ?? caseType` and the wire applies the writes and the
		// type change in one block. A write with `via` is converted against
		// the type its chain reaches and saves to that case instead.
		const writes: Array<{ property: string; value: JsonValue | undefined }> =
			[];
		const viaWrites: Array<{
			caseId: string;
			property: string;
			value: JsonValue | undefined;
		}> = [];
		const snapshots = new Map<string, StoredCaseValues | undefined>();
		const storedValuesOf = async (
			caseId: string,
		): Promise<StoredCaseValues | undefined> => {
			if (program.openingReads) {
				const row = program.openingReads.cases.rows.find(
					(row) => row.case_id === caseId,
				);
				return (
					row && {
						caseName: row.case_name,
						externalId: row.external_id,
						locationId: row.location_id ?? null,
						properties: row.properties,
					}
				);
			}
			if (!snapshots.has(caseId)) {
				snapshots.set(
					caseId,
					await readStoredCaseValues(trx, host, appId, caseId),
				);
			}
			return snapshots.get(caseId);
		};
		// A rename saved only when changed is compared with the case's name
		// when the form opened, as HQ's `case/update/case_name` relevance
		// compares the casedb `case_name` with the trimmed answer.
		if (
			operation.renameOnlyIfChanged === true &&
			preparedRename !== undefined &&
			(await storedValuesOf(target.caseId))?.caseName === preparedRename
		)
			preparedRename = undefined;
		for (const [writeIndex, write] of (operation.writes ?? []).entries()) {
			if (skippedWrites.get(index)?.has(writeIndex)) continue;
			// A write through an index saves to the case the chain reaches in
			// the pre-submission snapshot. CommCare HQ names that case through
			// the index's id, which is empty where no case is indexed, and case
			// processing drops a block with an empty id, so nothing is saved.
			let destinationCaseId = target.caseId;
			let actualType = target.snapshotCaseType;
			if (write.via !== undefined) {
				const reached = opening
					? openedAncestorId(opening.cases.indices, target.caseId, write.via)
					: await ancestorCaseId(trx, host, appId, target.caseId, write.via);
				const slot = `write:${writeIndex}` as const;
				if (!reached) {
					if (!opening) continue;
					throw new SubmissionRejectedError({
						kind: "target",
						operationUuid: operation.uuid,
						slot,
						reason: "missing-connection",
					});
				}
				const current = await loadTargetRows(
					trx,
					host,
					appId,
					{ unheldIds: [reached], anyIds: [] },
					currentAccess,
					opening?.submittedCaseIds,
				);
				const destination = current.get(reached);
				const expected = instance.envelope.viaCaseTypes?.get(writeIndex);
				if (
					!destination ||
					(expected !== undefined && destination.caseType !== expected)
				) {
					throw new SubmissionRejectedError({
						kind: "target",
						operationUuid: operation.uuid,
						slot,
						reason: destination
							? "case-type-mismatch"
							: "not-found-or-out-of-scope",
					});
				}
				actualType = destination.caseType;
				destinationCaseId = reached;
			}
			if (
				actualType === USERCASE_CASE_TYPE &&
				(USERCASE_BUILT_IN_KEYS.includes(write.property) ||
					!program.caseTypeSchemas
						.get(USERCASE_CASE_TYPE)
						?.properties?.some((property) => property.name === write.property))
			) {
				throw new SubmissionRejectedError({
					kind: "target",
					operationUuid: operation.uuid,
					slot: `write:${writeIndex}`,
					reason: "managed-worker-record",
				});
			}
			let value: JsonValue | undefined;
			if (isFacetWriteThroughIndex(write)) {
				// The name or owner of the case above, prepared as the
				// operation's own rename and owner are: CommCare HQ writes the
				// key into that case's block as its `case_name` or `owner_id`.
				const raw = evaluatedText(bag?.writes.get(writeIndex));
				if (instance.envelope.blankSavesNothing && blankText(raw)) continue;
				value = prepareText(
					write.property === "case_name" ? "rename" : "owner",
					raw,
				);
			} else if (isScalarColumnWrite(write.property)) {
				const prepared = prepareCaseScalarTextValue(
					evaluatedText(bag?.writes.get(writeIndex)),
					"allow",
				);
				if (!prepared.ok) {
					throw new SubmissionRejectedError({
						kind: "text-value",
						operationUuid: operation.uuid,
						facet: write.property,
						reason: prepared.reason,
					});
				}
				value = prepared.value;
			} else {
				value = storageValueFromEvaluation(
					bag?.writes.get(writeIndex),
					writeDataType(program, instance.envelope, writeIndex),
					program.viewerTimeZone ?? "UTC",
				);
				// CommCare HQ copies a saved `hq_user_id` into the case's
				// external id, a 255-character column, so the text it copies
				// holds to that column's bound as an external id does.
				if (write.property === "hq_user_id") {
					const copied = prepareCaseScalarTextValue(storedText(value), "allow");
					if (!copied.ok)
						throw new SubmissionRejectedError({
							kind: "text-value",
							operationUuid: operation.uuid,
							facet: "hq_user_id",
							reason: copied.reason,
						});
				}
			}
			if (instance.envelope.blankSavesNothing && blankText(storedText(value)))
				continue;
			// Saved only when the answer differs from the case's value when the
			// form opened, compared as the text each holds, as HQ's
			// `case/update` relevance compares the casedb value with the answer.
			if (write.onlyIfChanged === true) {
				const stored = await storedValuesOf(destinationCaseId);
				// CommCare Core unpacks each side of `!=` to one value, and an
				// empty node set unpacks to "" (`XPathNodeset.unpack`). So a case
				// the opening never held, or a leaf it never saved, compares as
				// "", and a non-blank answer is saved, as on a device.
				const before =
					write.property === "case_name"
						? (stored?.caseName ?? "")
						: write.property === "external_id"
							? (stored?.externalId ?? "")
							: write.property === "location_id"
								? (stored?.locationId ?? "")
								: storedText(stored?.properties[write.property]);
				if (before === storedText(value)) continue;
			}
			if (write.via !== undefined) {
				viaWrites.push({
					caseId: destinationCaseId,
					property: write.property,
					value,
				});
			} else {
				writes.push({ property: write.property, value });
			}
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
			...(allocations.get(index)?.entryNamed === true
				? { entryNamed: true }
				: {}),
			...(preparedName === undefined ? {} : { preparedName }),
			...(preparedRename === undefined ? {} : { preparedRename }),
			...(preparedOwner === undefined ? {} : { preparedOwner }),
			writes,
			links,
			viaWrites,
			closes,
		});
	}

	// The rolling type proof over the SERVER-resolved sequence — the
	// runtime complement of the static alias analysis, keyed by
	// concrete opaque id so runtime aliases and duplicate repeat keys
	// fold onto one identity.
	const typeSteps: ResolvedCaseOperationTypeStep[] = [];
	for (const entry of resolvedInstances) {
		if (!entry.executed) continue;
		const operation = entry.instance.envelope.operation;
		typeSteps.push({
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
	// The form's own case is written by Case Management's block, which
	// CommCare HQ runs after every other change of the form, so it still
	// consumes the case as the module's type once every other operation has
	// run: a later retype of the case it writes is refused, as the validator
	// refuses it where the target is proven.
	for (const entry of resolvedInstances) {
		if (!entry.executed || !entry.instance.envelope.own) continue;
		if (
			entry.writes.length === 0 &&
			entry.preparedRename === undefined &&
			entry.preparedOwner === undefined
		)
			continue;
		const operation = entry.instance.envelope.operation;
		typeSteps.push({
			operationUuid: operation.uuid,
			action: "update",
			target: {
				caseId: entry.caseId,
				...(entry.snapshotCaseType === undefined
					? {}
					: { snapshotCaseType: entry.snapshotCaseType }),
			},
			expectedCaseType: operation.caseType,
		});
	}
	const verdict = validateResolvedCaseOperationTypeSequence(typeSteps);
	if (!verdict.ok) {
		throw new SubmissionRejectedError({
			kind: "sequence",
			operationUuid: verdict.operationUuid,
			slot: verdict.slot,
			reason: verdict.reason,
		});
	}

	return {
		resolved: resolvedInstances,
		...(registeredCaseId === undefined ? {} : { registeredCaseId }),
	};
}

/** Every route to a worker record uses the same eligibility as its direct
 * worker-record supply. A typed list, a raw ID or an earlier connection
 * can supply an ID but cannot grant access to another worker's record. */
function workerRowAvailable(actingUserId: string) {
	return sql<boolean>`(c.case_type <> ${USERCASE_CASE_TYPE} or
		(c.status = 'open' and c.owner_id = ${actingUserId} and c.properties->>'hq_user_id' = ${actingUserId}))`;
}

async function loadSelectedCaseAnchors(
	trx: Transaction<Database>,
	host: SubmissionEnvelopeHost,
	appId: string,
	ordinary: ApplySubmissionArgs["ordinary"],
	caseIds: readonly string[],
	currentAccess?: RestoreScopeQuery,
	submittedCaseIds: readonly string[] = [],
): Promise<ReadonlyMap<string, SessionAnchor>> {
	if (caseIds.length === 0) return new Map();
	const select = (ids: readonly string[], restrict: boolean) => {
		const selected = (currentAccess?.creator ?? trx)
			.selectFrom("cases as c")
			.select(["c.case_id", "c.case_type"])
			.where("c.app_id", "=", appId)
			.where("c.case_id", "in", ids)
			.where("c.project_id", "=", host.projectId)
			.where(workerRowAvailable(host.actingUserId))
			.orderBy("c.case_id")
			.forUpdate("c");
		return (
			(restrict ? currentAccess?.restrict(selected, "c") : undefined) ??
			selected
		).execute();
	};
	// A case the device holds from this actor's own unsynced submission is
	// its to write though the current restore omits it (one it closed).
	const held = new Set(submittedCaseIds);
	const restricted = caseIds.filter((id) => !held.has(id));
	const exempt = caseIds.filter((id) => held.has(id));
	const rows = [
		...(restricted.length ? await select(restricted, true) : []),
		...(exempt.length ? await select(exempt, false) : []),
	];
	const byId = new Map(
		rows.map((row) => [
			row.case_id,
			{ caseId: row.case_id, caseType: row.case_type },
		]),
	);
	for (const caseId of caseIds) {
		const row = byId.get(caseId);
		if (row === undefined) {
			rejectSelection({
				kind: "selection",
				reason: "not-found-or-out-of-scope",
				caseId,
			});
		}
		if (
			(ordinary.kind === "followup" || ordinary.kind === "close") &&
			row.caseType !== ordinary.caseType
		) {
			rejectSelection({
				kind: "selection",
				reason: "case-type-mismatch",
				caseId,
				expectedCaseType: ordinary.caseType,
				actualCaseType: row.caseType,
			});
		}
	}
	return byId;
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
	currentAccess?: RestoreScopeQuery,
	submittedCaseIds: readonly string[] = [],
): Promise<ReadonlyMap<string, { caseId: string; caseType: string }>> {
	const rows = new Map<string, { caseId: string; caseType: string }>();
	// A case the device holds from this actor's own unsynced submission is
	// its to write though the current restore omits it (one it closed).
	const submitted = new Set(submittedCaseIds);
	const load = async (
		caseIds: readonly string[],
		excludeHeld: boolean,
		restrict = true,
	): Promise<void> => {
		const distinct = [...new Set(caseIds)].filter(
			(id) => submitted.has(id) !== restrict,
		);
		if (distinct.length === 0) return;
		let qb = (currentAccess?.creator ?? trx)
			.selectFrom("cases as c")
			.select(["c.case_id", "c.case_type"])
			.where("c.app_id", "=", appId)
			.where("c.project_id", "=", host.projectId)
			.where(workerRowAvailable(host.actingUserId))
			.where("c.case_id", "in", distinct)
			.orderBy("c.case_id")
			.forUpdate("c");
		if (currentAccess && restrict) qb = currentAccess.restrict(qb, "c");
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
	await load(ids.unheldIds, true, false);
	await load(ids.anyIds, false, false);
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
	ordinary: ApplySubmissionArgs["ordinary"],
	device: DeviceExternalIds,
): Promise<void> {
	// Ids this envelope has already created: a later duplicate-key
	// create of the SAME submission (duplicate repeat values) merges
	// onto the in-transaction row exactly as it would merge onto a
	// prior submission's row — the resolution-time probe only sees
	// pre-envelope rows.
	const createdInEnvelope = new Set<string>();
	const oneCaseForm =
		(ordinary.kind === "followup" || ordinary.kind === "close") &&
		ordinary.selection.kind === "single";
	for (const entry of resolved) {
		if (!entry.executed) {
			if (entry.childlessBlock && entry.snapshotCaseType !== undefined)
				await stampModified(trx, host, appId, entry.caseId);
			continue;
		}
		const operation = entry.instance.envelope.operation;

		if (operation.action === "create") {
			await applyCreateEffect(
				trx,
				host,
				appId,
				entry,
				operation,
				createdInEnvelope,
				device,
			);
		} else {
			await applyMutationEffect(trx, host, appId, entry, operation, device);
		}

		if (entry.closes) {
			await host.closeCase(trx, { appId, caseId: entry.caseId });
		}

		for (const link of entry.links) {
			await applyLinkEffect(trx, host, appId, entry.caseId, link);
		}

		// A recognized targeted action advances its timestamp even when
		// every update leaf is irrelevant. The submitted update element
		// remains present in Core, and a separate close can be idempotent.
		// Preserve the existing own-case behavior: one selected case gets
		// HQ's history timestamp; a several-case form stamps what it saves.
		const writesNothing =
			entry.writes.length === 0 &&
			entry.preparedRename === undefined &&
			entry.preparedOwner === undefined &&
			(operation.retype === undefined ||
				operation.retype === operation.caseType);
		const own = entry.instance.envelope.own;
		if (
			writesNothing &&
			(!own ||
				(operation.action === "update" &&
					!entry.closes &&
					(entry.links.length > 0 || oneCaseForm)))
		) {
			await stampModified(trx, host, appId, entry.caseId);
		}

		// The writes through an index, after the block of the case they start
		// from. CommCare HQ's build gathers the writes reaching one case into
		// one block (`xform.py::_add_case_updates`), whose known keys it
		// applies before its other keys, so each reached case takes its writes
		// as one partition, whatever their authored order.
		const byCase = new Map<string, (typeof entry.viaWrites)[number][]>();
		for (const write of entry.viaWrites) {
			const writes = byCase.get(write.caseId);
			if (writes) writes.push(write);
			else byCase.set(write.caseId, [write]);
		}
		for (const [caseId, writes] of byCase) {
			const named = writes.findLast((write) => write.property === "case_name");
			const owned = writes.findLast((write) => write.property === "owner_id");
			const part = partitionWrites(
				writes
					.filter(
						(write) =>
							write.property !== "case_name" && write.property !== "owner_id",
					)
					.map((write) => ({ property: write.property, value: write.value })),
			);
			const { patch, removals, scalars } = part;
			await noteDeviceExternalId(trx, host, appId, caseId, part, device);
			if (
				Object.keys(patch).length > 0 ||
				Object.keys(scalars).length > 0 ||
				named !== undefined
			) {
				await host.updateCase(trx, {
					appId,
					caseId,
					patch: {
						...(named !== undefined && {
							case_name: storedText(named.value),
						}),
						...scalars,
						...(Object.keys(patch).length > 0 ? { properties: patch } : {}),
					},
				});
			}
			if (removals.length > 0)
				await removeProperties(trx, host, appId, caseId, removals);
			if (owned !== undefined)
				await setOwner(trx, host, appId, caseId, storedText(owned.value));
		}
	}
}

/**
 * Split resolved writes into the additive patch, the blank-write key removals
 * (the wire's `''` write projected onto typed storage) and the row's scalar
 * columns, as CommCare HQ's server applies one block's `<update>`
 * (`update_strategy.py::SqlCaseUpdateStrategy._apply_update_action`):
 * `external_id` to its column, `location_id` to the case's location column and
 * not its properties, and `hq_user_id` to its property and, copied, to the
 * external id. HQ applies the block's known keys before its other keys, so a
 * block writing both keeps the copy as the external id.
 *
 * `deviceExternalId` is what a device holds of the external id where it
 * differs from the server's: a device applies `hq_user_id` as a property alone
 * (`CaseXmlParser.updateCase`) until its next sync, so it keeps the block's own
 * `external_id` (`explicit`) or, with none, the one the case held (`kept`).
 */
function partitionWrites(writes: ResolvedInstance["writes"]): {
	patch: JsonObject;
	removals: string[];
	scalars: { external_id?: string; location_id?: string };
	deviceExternalId?: "kept" | { readonly explicit: string };
} {
	const patch: JsonObject = {};
	const removals: string[] = [];
	const scalars: { external_id?: string; location_id?: string } = {};
	let copied: string | undefined;
	for (const write of writes) {
		if (isScalarColumnWrite(write.property)) {
			if (typeof write.value !== "string") {
				throw new Error(
					compilerBugMessage({
						where: "case-store.submissionEnvelope.partitionWrites",
						invariant: `an admitted ${write.property} write did not carry its prepared scalar string`,
						detail:
							"Resolution normalizes a scalar column's write separately before generic JSON conversion; blank is a real empty-string scalar write and must never become a JSONB removal.",
					}),
				);
			}
			scalars[write.property] = write.value;
			continue;
		}
		if (write.property === "hq_user_id") copied = storedText(write.value);
		if (write.value === undefined) removals.push(write.property);
		else patch[write.property] = write.value;
	}
	const explicit = scalars.external_id;
	if (copied === undefined) return { patch, removals, scalars };
	scalars.external_id = copied;
	return {
		patch,
		removals,
		scalars,
		deviceExternalId: explicit === undefined ? "kept" : { explicit },
	};
}

/**
 * The external id a device holds for each case whose external id this
 * submission set only through CommCare HQ's `hq_user_id` copy: the id it held
 * before the submission, or the one a later block of the submission wrote
 * explicitly. The case store holds HQ's copy; the submission's device patch
 * holds this until the device's next sync reads the server's.
 */
export type DeviceExternalIds = Map<string, string | null>;

/** Note, before a block's write lands, what a device keeps of its case's
 *  external id (`DeviceExternalIds`). */
async function noteDeviceExternalId(
	trx: Transaction<Database>,
	host: SubmissionEnvelopeHost,
	appId: string,
	caseId: string,
	part: ReturnType<typeof partitionWrites>,
	device: DeviceExternalIds,
): Promise<void> {
	const held = part.deviceExternalId;
	if (held !== undefined && held !== "kept") {
		device.set(caseId, held.explicit);
		return;
	}
	if (held === "kept") {
		if (device.has(caseId)) return;
		const row = await trx
			.selectFrom("cases as c")
			.select("c.external_id")
			.where("c.app_id", "=", appId)
			.where("c.project_id", "=", host.projectId)
			.where("c.case_id", "=", caseId)
			.executeTakeFirst();
		device.set(caseId, row?.external_id ?? null);
		return;
	}
	if (part.scalars.external_id !== undefined && device.has(caseId))
		device.set(caseId, part.scalars.external_id);
}

/** A write CommCare HQ keeps in a column of the case rather than among its
 *  properties: the external id and the case's own location. */
function isScalarColumnWrite(
	property: string,
): property is "external_id" | "location_id" {
	return property === "external_id" || property === "location_id";
}

async function applyCreateEffect(
	trx: Transaction<Database>,
	host: SubmissionEnvelopeHost,
	appId: string,
	entry: ResolvedInstance,
	operation: TargetedCaseOperation,
	createdInEnvelope: Set<string>,
	device: DeviceExternalIds,
): Promise<void> {
	const part = partitionWrites(entry.writes);
	const { patch, removals, scalars } = part;
	if (entry.mergesExisting || createdInEnvelope.has(entry.caseId)) {
		await noteDeviceExternalId(trx, host, appId, entry.caseId, part, device);
		// Create-of-existing merges (duplicate authored key, a retry of
		// the same definition): the create block's facets apply over the
		// existing row, exactly as Core/HQ accept a create for a known
		// id. The rolling proof already refused a stored-type mismatch.
		if (
			entry.preparedName !== undefined ||
			Object.keys(scalars).length > 0 ||
			Object.keys(patch).length > 0
		) {
			await host.updateCase(trx, {
				appId,
				caseId: entry.caseId,
				patch: {
					...(entry.preparedName === undefined
						? {}
						: { case_name: entry.preparedName }),
					...scalars,
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
	// two-state collapse (absent reads as blank) every storage write keeps.
	// A fresh case has no external id on the device until its next sync.
	if (part.deviceExternalId !== undefined)
		device.set(
			entry.caseId,
			part.deviceExternalId === "kept" ? null : part.deviceExternalId.explicit,
		);
	await host.insertCase(trx, {
		appId,
		seed: {
			caseType: operation.caseType,
			caseName: entry.preparedName,
			...(scalars.external_id === undefined
				? {}
				: { externalId: scalars.external_id }),
			...(scalars.location_id === undefined
				? {}
				: { locationId: scalars.location_id }),
			properties: patch,
		},
		caseId: entry.caseId,
		...(entry.preparedOwner === undefined
			? {}
			: { ownerId: entry.preparedOwner }),
		// A case the entry's session names is created with the id the form
		// read. A row already holding it, in any tenant, refuses the whole
		// submission inside this transaction rather than merging; an exact
		// retry of a saved entry replays its receipt before reaching here.
		...(entry.entryNamed
			? {
					caseIdTaken: () => {
						throw new SubmissionRejectedError({
							kind: "new-case",
							reason: "case-id-taken",
							caseId: entry.caseId,
						});
					},
				}
			: {}),
	});
	createdInEnvelope.add(entry.caseId);
}

async function applyMutationEffect(
	trx: Transaction<Database>,
	host: SubmissionEnvelopeHost,
	appId: string,
	entry: ResolvedInstance,
	operation: TargetedCaseOperation,
	device: DeviceExternalIds,
): Promise<void> {
	if (
		operation.retype !== undefined &&
		operation.retype !== operation.caseType
	) {
		// A retyping operation applies its writes, rename, and the type
		// change as ONE unit — the wire emits them in a single <update>
		// block that Core/HQ apply together, so the writes are
		// destination-typed and land on the destination-typed row.
		await applyRetypeEffect(trx, host, appId, entry, operation.retype, device);
	} else {
		const part = partitionWrites(entry.writes);
		const { patch, removals, scalars } = part;
		await noteDeviceExternalId(trx, host, appId, entry.caseId, part, device);
		if (
			Object.keys(patch).length > 0 ||
			entry.preparedRename !== undefined ||
			Object.keys(scalars).length > 0
		) {
			await host.updateCase(trx, {
				appId,
				caseId: entry.caseId,
				patch: {
					...(entry.preparedRename === undefined
						? {}
						: { case_name: entry.preparedRename }),
					...scalars,
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
	device: DeviceExternalIds,
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

	const part = partitionWrites(entry.writes);
	const { patch, removals, scalars } = part;
	await noteDeviceExternalId(trx, host, appId, entry.caseId, part, device);
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
			...scalars,
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
 * identifier also maintains the denormalized `parent_case_id`, which holds
 * the case's `parent` index alone, as every other writer keeps it
 * (`store.ts::parentColumn`). A search claim's `host` index is written here
 * too (`PostgresCaseStore.claimCases`).
 */
export async function applyLinkEffect(
	trx: Transaction<Database>,
	host: SubmissionEnvelopeHost,
	appId: string,
	caseId: string,
	link: ResolvedLink,
): Promise<void> {
	await replaceCaseIndex(
		trx,
		{ appId, projectId: host.projectId },
		caseId,
		link.identifier,
		link.targetCaseId === null
			? null
			: {
					id: link.targetCaseId,
					caseType: link.targetType,
					relationship: link.relationship,
				},
	);
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
// Reads of the pre-submission snapshot
// ---------------------------------------------------------------

/** Whether a value is blank once trimmed as Core trims a case scalar. */
function blankText(value: string): boolean {
	const prepared = prepareCaseScalarTextValue(value, "allow");
	return prepared.ok ? prepared.value === "" : false;
}

/**
 * The text a case value holds on a device: a stored string as it is, a
 * number or yes/no as its text, a multiple choice as its space-separated
 * tokens, and an absent value as blank.
 */
function storedText(value: JsonValue | undefined): string {
	if (value === undefined || value === null) return "";
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean")
		return String(value);
	if (Array.isArray(value))
		return value.map((entry) => storedText(entry)).join(" ");
	return JSON.stringify(value);
}

interface StoredCaseValues {
	readonly caseName: string;
	readonly externalId: string | null;
	readonly locationId: string | null;
	readonly properties: JsonObject;
}

/** One case's values as the pre-submission snapshot holds them. */
async function readStoredCaseValues(
	trx: Transaction<Database>,
	host: SubmissionEnvelopeHost,
	appId: string,
	caseId: string,
): Promise<StoredCaseValues | undefined> {
	const row = await trx
		.selectFrom("cases as c")
		.select(["c.case_name", "c.external_id", "c.location_id", "c.properties"])
		.where("c.app_id", "=", appId)
		.where("c.project_id", "=", host.projectId)
		.where("c.case_id", "=", caseId)
		.executeTakeFirst();
	if (row === undefined) return undefined;
	return {
		caseName: row.case_name,
		externalId: row.external_id,
		locationId: row.location_id,
		properties: row.properties,
	};
}

/**
 * The case `via`'s indices reach from `caseId` in the pre-submission
 * snapshot, each step the index of that identifier, as CommCare HQ names it
 * (`xform.py::get_case_parent_id_xpath`, one `index/<identifier>` per step).
 * Undefined where a step finds no index, or an index to no case of this app
 * and Project.
 */
function openedAncestorId(
	indices: NonNullable<
		CaseOperationProgram["openingReads"]
	>["cases"]["indices"],
	caseId: string,
	via: CaseWriteVia,
): string | undefined {
	let current = caseId;
	for (const step of via) {
		const edge = indices.find(
			(row) =>
				row.case_id === current &&
				row.identifier === step.identifier &&
				row.depth === 1,
		);
		if (!edge) return undefined;
		current = edge.ancestor_id;
	}
	return current;
}

async function ancestorCaseId(
	trx: Transaction<Database>,
	host: SubmissionEnvelopeHost,
	appId: string,
	caseId: string,
	via: CaseWriteVia,
): Promise<string | undefined> {
	let current = caseId;
	for (const step of via) {
		const row = await trx
			.selectFrom("case_indices as i")
			.innerJoin("cases as a", "a.case_id", "i.ancestor_id")
			.select("i.ancestor_id")
			.where("i.case_id", "=", current)
			.where("i.identifier", "=", step.identifier)
			.where("i.depth", "=", 1)
			.where("a.app_id", "=", appId)
			.where("a.project_id", "=", host.projectId)
			.orderBy("i.ancestor_id")
			.limit(1)
			.executeTakeFirst();
		if (row === undefined) return undefined;
		current = row.ancestor_id;
	}
	return current;
}
