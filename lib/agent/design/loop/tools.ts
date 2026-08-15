/**
 * Server-gated design tools. Contract, revision, and plan authoring is a
 * durable sequence of bounded identity-addressed semantic updates. The model
 * works in one implicit workspace; the server owns artifact kind, ordering,
 * and optimistic revision fencing. A small finalizer composes, fully validates,
 * and atomically persists one immutable artifact.
 */

import { jsonSchema } from "ai";
import { type ZodError, z } from "zod";
import {
	type DesignArtifactWriteAuthority,
	insertDesignBuildPlan,
	insertDesignReview,
	insertDesignRevision,
} from "@/lib/agent/design/artifactStore";
import {
	CONTRACT_COLLECTIONS,
	type DesignArtifactKind,
	type DesignArtifactWorkspaceLineage,
	type DesignArtifactWorkspaceOperation,
	designArtifactWorkspaceOperationSchema,
	designCollectionUpdateInputSchemas,
	designWorkspaceBoundError,
	finishDesignInputSchema,
	inspectDesignInputSchema,
	inspectDesignWorkspaceCandidate,
	setDesignRootInputSchema,
	updateFindingDispositionsInputSchema,
} from "@/lib/agent/design/artifactWorkspaceOperations";
import {
	DesignArtifactWorkspaceError,
	type DesignIdentityHandleBinding,
	type inspectDesignArtifactWorkspace,
	openDesignArtifactWorkspace,
	readDesignIdentityHandleBindings,
	stageDesignArtifactWorkspace,
} from "@/lib/agent/design/artifactWorkspaceStore";
import { deriveBuildPlan } from "@/lib/agent/design/buildPlan";
import { DESIGN_EFFORT_TIME_ESTIMATES } from "@/lib/agent/design/complexity";
import {
	type AppDesignContract,
	appDesignContractSchema,
	type DesignConstructionIssue,
	designConstructionIssues,
	designConstructionQuestionRequirements,
	type OpenQuestion,
} from "@/lib/agent/design/contract";
import { DESIGN_HANDLE_PATTERN, designIdSchema } from "@/lib/agent/design/ids";
import {
	changesArchitecture,
	contractEnvelope,
	criticalFindingCount,
	leavesCriticalFinding,
	mapDispositionsToReviews,
	planEnvelope,
	reviewEnvelope,
} from "@/lib/agent/design/loop/artifacts";
import { deterministicDesignId } from "@/lib/agent/design/loop/claimSeeding";
import {
	type DesignAncestry,
	type DesignGateState,
	type DesignLoopToolName,
	type DesignRepairTracker,
	type DesignStageToolName,
	type DesignSubmissionValidationStage,
	evaluateDesignGates,
} from "@/lib/agent/design/loop/gates";
import { DESIGN_PROMPT_VERSIONS } from "@/lib/agent/design/prompts";
import {
	designRevisionResultSchemaFor,
	findingBlocksAcceptance,
	validateSensitivityNotSilentlyLowered,
} from "@/lib/agent/design/review";
import { runDesignReviewer } from "@/lib/agent/design/reviewer";
import {
	deriveFindingHandleBindings,
	RESERVED_FINDING_HANDLE_PATTERN,
} from "@/lib/agent/design/reviewVocabulary";
import type { DesignSourcePackage } from "@/lib/agent/design/sourcePackage";
import type { StructuredModelRunContext } from "@/lib/agent/modelRunContext";
import {
	strictWireJsonSchema,
	stripNullProperties,
} from "@/lib/agent/strictStructuredOutput";
import { CANONICAL_UUID_PATTERN } from "@/lib/domain/uuid";

export interface DesignLoopToolDeps {
	readonly designSessionId: string;
	readonly runId: string;
	readonly authority: DesignArtifactWriteAuthority;
	readonly currentPkg: DesignSourcePackage;
	readonly catalogText: string;
	readonly ctx: StructuredModelRunContext;
	readonly signal: AbortSignal;
	readonly repair: DesignRepairTracker;
	readonly loadAncestry: () => Promise<DesignAncestry>;
	/** Called immediately after ANY immutable ancestry artifact (revision,
	 * review, or plan) is inserted, so a memoizing `loadAncestry` reloads.
	 * The design session is single-writer (exact-holder locked), so these
	 * inserts are the only invalidation source. */
	readonly ancestryChanged: () => void;
	readonly rebuildPackageForDigest: (
		digest: string,
	) => Promise<DesignSourcePackage | null>;
	readonly requiredQuestionsWereAnswered?: (
		questions: readonly OpenQuestion[],
	) => boolean | Promise<boolean>;
	readonly onReviewActivity?: (deltaChars: number) => void;
	readonly onReviewerReasoning?: (text: string) => void;
}

async function persistDerivedPlan(
	deps: DesignLoopToolDeps,
	accepted: NonNullable<DesignGateState["head"]>,
) {
	const plan = deriveBuildPlan({
		contract: accepted.envelope.payload,
		revision: { id: accepted.id, digest: accepted.artifactDigest },
	});
	const record = await insertDesignBuildPlan({
		envelope: planEnvelope({
			accepted,
			packageDigest: accepted.sourcePackageDigest,
			plan,
			finishReason: null,
		}),
		authority: deps.authority,
	});
	deps.ancestryChanged();
	return record;
}

/** Crash recovery for the tiny accepted-revision -> derived-plan boundary. */
export async function ensureDerivedBuildPlan(
	deps: DesignLoopToolDeps,
	gates: DesignGateState,
) {
	if (
		gates.plan !== null ||
		gates.head === null ||
		gates.head.lifecycle !== "accepted" ||
		gates.blockingQuestions.length > 0 ||
		gates.head.sourcePackageDigest !== gates.currentPackageDigest
	) {
		return gates.plan;
	}
	return persistDerivedPlan(deps, gates.head);
}

function strictWireOnly(schema: z.ZodType) {
	return jsonSchema<unknown>(strictWireJsonSchema(schema) as never);
}

/** Re-exported from `ids.ts` (its home is the leaf, beside `designIdSchema`,
 * so the reviewer schema shares it without importing the loop). */
export { DESIGN_HANDLE_PATTERN };

function isJsonObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const DESIGN_HANDLE_ARM = {
	type: "object",
	properties: {
		handle: {
			type: "string",
			pattern: DESIGN_HANDLE_PATTERN.source,
		},
	},
	required: ["handle"],
	additionalProperties: false,
} as const;

/** A design-ID string node in the strict wire projection. A required slot
 * emits `type: "string"`; a formerly-optional slot emits the projection's
 * null-union spelling `type: ["string", "null"]`. Both carry the canonical
 * UUID regex as `pattern` (never `format` — `designIdSchema` is a `.regex()`),
 * so that exact pattern is the key. */
function isDesignIdStringNode(node: Record<string, unknown>): boolean {
	if (node.pattern !== CANONICAL_UUID_PATTERN.source) return false;
	return (
		node.type === "string" ||
		(Array.isArray(node.type) &&
			node.type.length === 2 &&
			node.type.includes("string") &&
			node.type.includes("null"))
	);
}

/** The model names semantic design elements; the server mints their stable
 * UUIDs. Every design-ID slot — required or optional, declaration or
 * reference — widens to `uuid | { handle }` (plus a null arm where the slot
 * was optional) so the strict provider grammar can express a handle; a slot
 * left bare would pin the model to raw UUIDs the server then refuses.
 * Persisted schemas remain UUID-only. Design IDs are the only
 * canonical-UUID-pattern strings in these tool schemas — a Blueprint or media
 * UUID slot added here would widen too and must first grow a distinguishable
 * emission; `toolWireSchemas.test.ts` pins the widened inventory. */
function widenDesignIdsToHandles(node: unknown): unknown {
	if (Array.isArray(node)) return node.map(widenDesignIdsToHandles);
	if (!isJsonObject(node)) return node;
	if (isDesignIdStringNode(node)) {
		const nullable = Array.isArray(node.type);
		return {
			anyOf: [
				nullable ? { ...node, type: "string" } : node,
				DESIGN_HANDLE_ARM,
				...(nullable ? [{ type: "null" }] : []),
			],
		};
	}
	return Object.fromEntries(
		Object.entries(node).map(([key, value]) => [
			key,
			widenDesignIdsToHandles(value),
		]),
	);
}

/** The exact provider-facing JSON grammar of a handle-widened design tool.
 * Exported so tests can prove the wire admits a handle object everywhere a
 * design identity is expressible. */
export function designToolWireSchema(schema: z.ZodType): unknown {
	return widenDesignIdsToHandles(strictWireJsonSchema(schema));
}

function strictWireWithHandles(schema: z.ZodType) {
	return jsonSchema<unknown>(designToolWireSchema(schema) as never);
}

export function resolveDesignWorkspaceHandles(
	value: unknown,
	designSessionId: string,
): unknown {
	if (Array.isArray(value)) {
		return value.map((entry) =>
			resolveDesignWorkspaceHandles(entry, designSessionId),
		);
	}
	if (!isJsonObject(value)) return value;
	if (
		Object.keys(value).length === 1 &&
		typeof value.handle === "string" &&
		DESIGN_HANDLE_PATTERN.test(value.handle)
	) {
		return designIdSchema.parse(
			deterministicDesignId(
				`design-workspace-v1:${designSessionId}:${value.handle}`,
			),
		);
	}
	return Object.fromEntries(
		Object.entries(value).map(([key, entry]) => [
			key,
			resolveDesignWorkspaceHandles(entry, designSessionId),
		]),
	);
}

const DESIGN_COLLECTION_ENTITY_KINDS = {
	actors: "actor",
	records: "record",
	workflows: "workflow",
	lists: "list",
	access: "access",
	navigation: "navigation",
	moduleCompositions: "module_composition",
	formCompositions: "form_composition",
	externalRequirements: "external_requirement",
	decisions: "decision",
	assumptions: "assumption",
	openQuestions: "open_question",
} as const;

function handleValue(value: unknown): string | null {
	return isJsonObject(value) &&
		Object.keys(value).length === 1 &&
		typeof value.handle === "string" &&
		DESIGN_HANDLE_PATTERN.test(value.handle)
		? value.handle
		: null;
}

export function collectDesignIdentityHandleBindings(
	input: unknown,
	designSessionId: string,
): DesignIdentityHandleBinding[] {
	if (!isJsonObject(input)) return [];
	const bindings: DesignIdentityHandleBinding[] = [];
	const add = (value: unknown, entityKind: string): void => {
		const handle = handleValue(value);
		if (handle === null) return;
		bindings.push({
			handle,
			designId: designIdSchema.parse(
				deterministicDesignId(
					`design-workspace-v1:${designSessionId}:${handle}`,
				),
			),
			entityKind,
		});
	};
	if (isJsonObject(input.root)) add(input.root.id, "contract");
	if (!Array.isArray(input.collections)) return bindings;
	for (const collection of input.collections) {
		if (
			!isJsonObject(collection) ||
			!Array.isArray(collection.upserts) ||
			typeof collection.collection !== "string" ||
			collection.collection === "dispositions"
		) {
			continue;
		}
		const kind =
			DESIGN_COLLECTION_ENTITY_KINDS[
				collection.collection as keyof typeof DESIGN_COLLECTION_ENTITY_KINDS
			];
		if (kind === undefined) continue;
		for (const item of collection.upserts) {
			if (!isJsonObject(item)) continue;
			add(item.id, kind);
			if (
				collection.collection === "records" &&
				Array.isArray(item.properties)
			) {
				for (const property of item.properties) {
					if (isJsonObject(property)) add(property.id, "property");
				}
			}
			if (
				collection.collection === "formCompositions" &&
				isJsonObject(item.layout)
			) {
				const sections = Array.isArray(item.layout.sections)
					? item.layout.sections
					: [];
				for (const section of sections) {
					if (!isJsonObject(section)) continue;
					add(section.id, "composition_section");
					if (Array.isArray(section.items))
						for (const compositionItem of section.items) {
							if (isJsonObject(compositionItem))
								add(compositionItem.id, "composition_item");
						}
				}
				if (Array.isArray(item.layout.items))
					for (const compositionItem of item.layout.items) {
						if (isJsonObject(compositionItem))
							add(compositionItem.id, "composition_item");
					}
			}
		}
	}
	return bindings;
}

function collectDesignHandleReferences(value: unknown): string[] {
	const handles: string[] = [];
	const visit = (entry: unknown): void => {
		if (Array.isArray(entry)) {
			for (const nested of entry) visit(nested);
			return;
		}
		if (!isJsonObject(entry)) return;
		const handle = handleValue(entry);
		if (handle !== null) {
			handles.push(handle);
			return;
		}
		for (const nested of Object.values(entry)) visit(nested);
	};
	visit(value);
	return handles;
}

/** The ledger's marker kind for a handle first seen as a REFERENCE. The
 * identity is already final (minting is deterministic per session+handle);
 * the declaring item later upgrades the row to its real kind, and submit's
 * reference-closure proof names this handle if the element never arrives. */
export const REFERENCED_HANDLE_KIND = "referenced";

/** Staging is order-free: a reference may precede its declaration, in any
 * call. The one reference rejection left is the reserved `@f<N>` namespace —
 * those are the server's finding projections, and outside a disposition's
 * pre-resolved findingId slot they can never name a design element. */
export function designReservedReferenceIssue(input: unknown): string | null {
	const reserved = collectDesignHandleReferences(input).find((handle) =>
		RESERVED_FINDING_HANDLE_PATTERN.test(handle),
	);
	return reserved === undefined
		? null
		: `Handles like ${reserved} are the server's names for review findings; they can appear only as a disposition's findingId, never as a design element reference. Use the element's own handle instead.`;
}

/** Every handle this call references without declaring, absent from the
 * ledger, becomes a `referenced` binding: the deterministic identity is
 * durable from first sight, so later declarations converge on it and the
 * submit diagnostics can name the symbol. */
export function collectDesignReferenceBindings(
	input: unknown,
	existingBindings: readonly DesignIdentityHandleBinding[],
	designSessionId: string,
): DesignIdentityHandleBinding[] {
	const known = new Set(existingBindings.map((binding) => binding.handle));
	for (const declaration of collectDesignIdentityHandleBindings(
		input,
		designSessionId,
	)) {
		known.add(declaration.handle);
	}
	const bindings: DesignIdentityHandleBinding[] = [];
	for (const handle of collectDesignHandleReferences(input)) {
		if (known.has(handle)) continue;
		known.add(handle);
		bindings.push({
			handle,
			designId: designIdSchema.parse(
				deterministicDesignId(
					`design-workspace-v1:${designSessionId}:${handle}`,
				),
			),
			entityKind: REFERENCED_HANDLE_KIND,
		});
	}
	return bindings;
}

/** `@f<N>` is the server's projection vocabulary for review findings
 * (`reviewVocabulary.ts::deriveFindingHandleBindings`). A design element
 * declared under one would print the same symbol as a finding, making every
 * later projection ambiguous — so the declaration is refused before binding. */
export function designReservedHandleIssue(
	input: unknown,
	designSessionId: string,
): string | null {
	const reserved = collectDesignIdentityHandleBindings(
		input,
		designSessionId,
	).find((binding) => RESERVED_FINDING_HANDLE_PATTERN.test(binding.handle));
	return reserved === undefined
		? null
		: `Handles like ${reserved.handle} are the server's names for review findings; they cannot be declared for design elements. Pick a descriptive handle such as @follow_up_visit.`;
}

/**
 * Resolve `{ handle: "@f1" }` finding references in a revision stage's
 * dispositions BEFORE the generic workspace resolver sees them: findings are
 * server-minted identities, not session-deterministic handle mints, so the
 * generic resolver would deterministically produce a WRONG UUID that parses.
 * Walks only the dispositions collection (`upserts[].findingId` and
 * `removeIds[]`); every other slot belongs to the contract namespace and
 * keeps its existing resolution.
 */
export function resolveDesignFindingHandles(
	input: unknown,
	findingBindings: ReadonlyArray<{
		readonly handle: string;
		readonly designId: string;
	}>,
):
	| { readonly ok: true; readonly value: unknown }
	| { readonly ok: false; readonly error: string } {
	if (!isJsonObject(input) || !isJsonObject(input.dispositions)) {
		return { ok: true, value: input };
	}
	const byHandle = new Map(
		findingBindings.map((binding) => [binding.handle, binding.designId]),
	);
	let error: string | null = null;
	const resolveSlot = (value: unknown): unknown => {
		const handle = handleValue(value);
		if (handle === null) return value;
		const designId = byHandle.get(handle);
		if (designId === undefined) {
			const known = [...byHandle.keys()];
			error ??=
				known.length === 0
					? `The finding handle ${handle} does not exist — this review cycle has no open findings to disposition.`
					: `The finding handle ${handle} does not exist on this review. The open findings are ${known.join(", ")} — disposition one of those, or use the exact finding identity from the review result.`;
			return value;
		}
		return designId;
	};
	const dispositions = input.dispositions;
	const resolved = {
		...dispositions,
		...(Array.isArray(dispositions.upserts) && {
			upserts: dispositions.upserts.map((entry) =>
				isJsonObject(entry) && "findingId" in entry
					? { ...entry, findingId: resolveSlot(entry.findingId) }
					: entry,
			),
		}),
		...(Array.isArray(dispositions.removeIds) && {
			removeIds: dispositions.removeIds.map(resolveSlot),
		}),
	};
	return error !== null
		? { ok: false, error }
		: { ok: true, value: { ...input, dispositions: resolved } };
}

/** Model-facing projection: persisted artifacts remain UUID-only while every
 * identity with a durable symbol is rendered back through that symbol. */
export function projectDesignIdentityHandles(
	value: unknown,
	bindings: readonly DesignIdentityHandleBinding[],
): unknown {
	const byId = new Map(
		bindings.map((binding) => [binding.designId, binding.handle] as const),
	);
	const visit = (entry: unknown): unknown => {
		if (typeof entry === "string") {
			const handle = byId.get(entry);
			return handle === undefined ? entry : { handle };
		}
		if (Array.isArray(entry)) return entry.map(visit);
		if (!isJsonObject(entry)) return entry;
		return Object.fromEntries(
			Object.entries(entry).map(([key, nested]) => [key, visit(nested)]),
		);
	};
	return visit(value);
}

/** Replace every ledger-bound design UUID in a diagnostic line with the
 * symbol the model actually wrote — including `referenced` bindings, which is
 * what lets a never-declared forward reference name itself as its handle. */
function projectBoundIdsIntoText(
	line: string,
	bindings: readonly DesignIdentityHandleBinding[],
): string {
	return bindings.reduce(
		(text, binding) => text.split(binding.designId).join(binding.handle),
		line,
	);
}

export function renderDesignValidationIssues(
	error: ZodError,
	bindings: readonly DesignIdentityHandleBinding[] = [],
): string {
	const shown = error.issues.slice(0, 25);
	const lines = shown.map((issue) =>
		projectBoundIdsIntoText(
			`- ${issue.path.join(".") || "<root>"}: ${issue.message}`,
			bindings,
		),
	);
	const more = error.issues.length - shown.length;
	return [
		"The submission failed Nova's design validation. Correct these exact items, then finalize again:",
		...lines,
		...(more > 0 ? [`(and ${more} more issues of the same kinds)`] : []),
	].join("\n");
}

function renderDesignConstructionIssues(
	issues: ReturnType<typeof designConstructionIssues>,
	bindings: readonly DesignIdentityHandleBinding[] = [],
): string {
	return [
		"The submission cannot yet be built. Correct these exact items, then finalize again:",
		...issues.map((issue) =>
			projectBoundIdsIntoText(
				`- ${issue.path.join(".")}: ${issue.message}`,
				bindings,
			),
		),
	].join("\n");
}

interface DesignToolDiagnostic {
	readonly code: string;
	readonly validationStage?: DesignSubmissionValidationStage | "partial";
	readonly issueCount?: number;
}

interface ToolError {
	readonly error: string;
	readonly diagnostic?: DesignToolDiagnostic;
}

function zodIssueFingerprints(error: ZodError): string[] {
	return error.issues.map(
		(issue) => `${issue.path.join(".")}|${issue.code}|${issue.message}`,
	);
}

function constructionIssueFingerprint(issue: DesignConstructionIssue): string {
	return `${issue.path.join(".")}|${issue.message}`;
}

function rejectionDiagnostic(
	stage: DesignSubmissionValidationStage,
	issueCount: number,
): DesignToolDiagnostic {
	return {
		code: `design-${stage}-rejected`,
		validationStage: stage,
		issueCount,
	};
}

async function gatesFor(deps: DesignLoopToolDeps): Promise<DesignGateState> {
	return evaluateDesignGates(await deps.loadAncestry());
}

function refuse(
	deps: DesignLoopToolDeps,
	gates: DesignGateState,
	name: DesignLoopToolName,
): ToolError | null {
	const verdict = gates.verdicts[name];
	if (verdict.legal) {
		deps.repair.noteLegalCall();
		return null;
	}
	deps.repair.noteSequenceError();
	return { error: verdict.refusal };
}

function gateNameForKind(kind: DesignArtifactKind): DesignLoopToolName {
	return kind === "contract" ? "submitContract" : "submitRevision";
}

export function designWorkspaceLineageForGates(
	kind: DesignArtifactKind,
	gates: DesignGateState,
): DesignArtifactWorkspaceLineage {
	const base = gates.head;
	return {
		schemaVersion: 1,
		artifactKind: kind,
		sourcePackageDigest: gates.currentPackageDigest,
		...(base !== null && {
			baseRevision: { id: base.id, digest: base.artifactDigest },
		}),
		reviewArtifacts:
			kind === "revision"
				? gates.headReviews.map((review) => ({
						id: review.id,
						digest: review.artifactDigest,
					}))
				: [],
	};
}

function workspaceError(error: unknown): ToolError | null {
	if (!(error instanceof DesignArtifactWorkspaceError)) return null;
	return {
		error: error.message,
		...(error.code === "partial-invalid" && {
			diagnostic: {
				code: "design-partial-identity-rejected",
				validationStage: "partial" as const,
				...(error.issueCount !== undefined && {
					issueCount: error.issueCount,
				}),
			},
		}),
	};
}

/** Record a rejected stage call before returning it, so consecutive
 * identical rejections latch the repair tracker's stage budget instead of
 * spinning until the step budget. Gate refusals (the sequence budget) and
 * the forced-question state stay outside this accounting. */
function rejectedStage<T extends ToolError>(
	deps: DesignLoopToolDeps,
	kind: DesignStageToolName,
	result: T,
): T {
	deps.repair.noteStageRejection(
		kind,
		`${result.diagnostic?.code ?? "design-validation-rejected"}|${result.error}`,
	);
	return result;
}

/** The stage tools' shared raw-input admission cascade, in production order:
 * creation-identity handles, reserved `@f` handles, reserved references. ONE
 * spelling so the two stage tools cannot drift on codes or order. */
function stagedInputAdmissionRejection(
	deps: DesignLoopToolDeps,
	toolName: DesignStageToolName,
	stagedInput: unknown,
	workspace: {
		readonly candidate: Record<string, unknown>;
		readonly sourceContract: Record<string, unknown> | null;
	},
) {
	const identityIssue = designCreationIdentityIssue(
		stagedInput,
		workspace.candidate,
		workspace.sourceContract,
	);
	if (identityIssue !== null) {
		return rejectedStage(deps, toolName, {
			error: identityIssue,
			diagnostic: {
				code: "design-creation-handle-required",
				validationStage: "partial" as const,
				issueCount: 1,
			},
		});
	}
	const reservedIssue = designReservedHandleIssue(
		stagedInput,
		deps.designSessionId,
	);
	if (reservedIssue !== null) {
		return rejectedStage(deps, toolName, {
			error: reservedIssue,
			diagnostic: {
				code: "design-reserved-handle",
				validationStage: "partial" as const,
				issueCount: 1,
			},
		});
	}
	const reservedReferenceIssue = designReservedReferenceIssue(stagedInput);
	if (reservedReferenceIssue !== null) {
		return rejectedStage(deps, toolName, {
			error: reservedReferenceIssue,
			diagnostic: {
				code: "design-reserved-handle",
				validationStage: "partial" as const,
				issueCount: 1,
			},
		});
	}
	return null;
}

/** The stage tools' shared persistence tail: collect declarations plus eager
 * `referenced` bindings for forward references (staging is order-free and
 * submit closure names any symbol that never gets authored), enforce the
 * stage bound, and stage the operation durably. */
async function persistStagedDesignPart(args: {
	deps: DesignLoopToolDeps;
	toolName: DesignStageToolName;
	kind: "contract" | "revision";
	gates: DesignGateState;
	toolCallId: string;
	stagedInput: unknown;
	parsedInput: unknown;
	operation: DesignArtifactWorkspaceOperation;
	workspaceRevision: number;
	workspaceHandleBindings: readonly DesignIdentityHandleBinding[];
	successMessage: string;
}) {
	const handleBindings = [
		...collectDesignIdentityHandleBindings(
			args.stagedInput,
			args.deps.designSessionId,
		),
		...collectDesignReferenceBindings(
			args.stagedInput,
			args.workspaceHandleBindings,
			args.deps.designSessionId,
		),
	];
	const bound = designWorkspaceBoundError({
		input: args.parsedInput,
		operation: args.operation,
	});
	if (bound !== null) {
		return rejectedStage(args.deps, args.toolName, { error: bound });
	}
	try {
		const result = await stageDesignArtifactWorkspace({
			designSessionId: args.deps.designSessionId,
			lineage: designWorkspaceLineageForGates(args.kind, args.gates),
			authority: args.deps.authority,
			toolCallId: args.toolCallId,
			expectedRevision: args.workspaceRevision,
			operation: args.operation,
			handleBindings,
		});
		args.deps.repair.noteStageAccepted(args.toolName);
		return {
			ok: true,
			deduplicated: result.deduplicated,
			message: args.successMessage,
		};
	} catch (error) {
		const handled = workspaceError(error);
		if (handled) return rejectedStage(args.deps, args.toolName, handled);
		throw error;
	}
}

/** One spelling for a submit tool's whole-candidate schema rejection. */
function schemaSubmissionRejection(
	deps: DesignLoopToolDeps,
	toolName: "submitContract" | "submitRevision",
	error: ZodError,
	handleBindings: readonly DesignIdentityHandleBinding[],
) {
	deps.repair.noteSubmissionRejection(toolName, {
		stage: "schema",
		fingerprints: zodIssueFingerprints(error),
	});
	return {
		error: renderDesignValidationIssues(error, handleBindings),
		diagnostic: rejectionDiagnostic("schema", error.issues.length),
	};
}

/** The submit tools' shared construction gate: blocking construction issues
 * either demand the user's exact pending questions (outside the repair
 * budget) or reject with the rendered issues. Returns null when construction
 * is clean. Only the lead sentence differs per tool. */
function constructionSubmissionRejection(args: {
	deps: DesignLoopToolDeps;
	toolName: "submitContract" | "submitRevision";
	contract: AppDesignContract;
	handleBindings: readonly DesignIdentityHandleBinding[];
	needsDecisionsLine: string;
}) {
	const constructionIssues = designConstructionIssues(args.contract);
	if (constructionIssues.length === 0) return null;
	const requirements = designConstructionQuestionRequirements(
		args.contract,
		constructionIssues,
	);
	if (requirements !== null) {
		const questions = requirements.map((question) => question.question);
		args.deps.repair.requireUserQuestions(requirements);
		return {
			error: [
				args.needsDecisionsLine,
				"Call askQuestions now with up to five of the exact questions below. Do not assume answers, remove included workflows, or reinterpret their scope.",
				"Once the user answers, apply the resolution with the native semantic calls before finishing again: record each settled choice as a decision or assumption, and remove the question or mark it non-blocking.",
				...questions.map((question) => `- ${question}`),
			].join("\n"),
			needsUserInput: {
				questions,
				maxQuestionsPerRound: 5,
			},
			diagnostic: {
				code: "design-construction-needs-input",
				validationStage: "construction" as const,
				issueCount: constructionIssues.length,
			},
		};
	}
	args.deps.repair.noteSubmissionRejection(args.toolName, {
		stage: "construction",
		fingerprints: constructionIssues.map(constructionIssueFingerprint),
	});
	return {
		error: renderDesignConstructionIssues(
			constructionIssues,
			args.handleBindings,
		),
		diagnostic: rejectionDiagnostic("construction", constructionIssues.length),
	};
}

function parseStage<T>(schema: z.ZodType<T>, input: unknown) {
	const parsed = schema.safeParse(stripNullProperties(input));
	return parsed.success
		? ({ ok: true, data: parsed.data } as const)
		: ({
				ok: false,
				error: renderDesignValidationIssues(parsed.error),
			} as const);
}

function parseHandledStage<T>(
	schema: z.ZodType<T>,
	input: unknown,
	designSessionId: string,
) {
	return parseStage(
		schema,
		resolveDesignWorkspaceHandles(input, designSessionId),
	);
}

async function requiredQuestionRefusal(
	deps: DesignLoopToolDeps,
	candidate: Record<string, unknown>,
): Promise<ToolError | null> {
	const { dispositions: _dispositions, ...contractCandidate } = candidate;
	const parsed = appDesignContractSchema.safeParse(contractCandidate);
	if (!parsed.success) return null;
	const questions = designConstructionQuestionRequirements(
		parsed.data,
		designConstructionIssues(parsed.data),
	);
	if (
		questions === null ||
		(await deps.requiredQuestionsWereAnswered?.(questions)) === true
	) {
		return null;
	}
	return {
		error: [
			"These construction decisions still require the user's answer.",
			"Call askQuestions with the exact pending questions before updating more design work.",
		].join(" "),
		diagnostic: {
			code: "design-required-question-pending",
			validationStage: "construction",
			issueCount: questions.length,
		},
	};
}

function existingDesignIdentityKinds(
	candidate: Record<string, unknown>,
): Map<string, string> {
	const ids = new Map<string, string>();
	const add = (value: unknown, kind: string): void => {
		if (typeof value === "string") ids.set(value, kind);
	};
	add(candidate.id, "contract");
	for (const collection of CONTRACT_COLLECTIONS) {
		const members = candidate[collection];
		if (!Array.isArray(members)) continue;
		for (const member of members) {
			if (!isJsonObject(member)) continue;
			add(member.id, DESIGN_COLLECTION_ENTITY_KINDS[collection]);
			if (collection === "records" && Array.isArray(member.properties)) {
				for (const property of member.properties) {
					if (isJsonObject(property)) add(property.id, "property");
				}
			}
			if (collection === "formCompositions" && isJsonObject(member.layout)) {
				for (const section of Array.isArray(member.layout.sections)
					? member.layout.sections
					: []) {
					if (!isJsonObject(section)) continue;
					add(section.id, "composition_section");
					for (const item of Array.isArray(section.items)
						? section.items
						: []) {
						if (isJsonObject(item)) add(item.id, "composition_item");
					}
				}
				for (const item of Array.isArray(member.layout.items)
					? member.layout.items
					: []) {
					if (isJsonObject(item)) add(item.id, "composition_item");
				}
			}
		}
	}
	return ids;
}

/** New design declarations are symbolic in every phase. A raw UUID is legal
 * only when it names an identity already present in the exact workspace/base;
 * accepting a merely well-formed UUID here is what let the initial Haiti
 * design fabricate an unrelated identity graph. */
export function designCreationIdentityIssue(
	input: unknown,
	candidate: Record<string, unknown>,
	sourceContract?: Record<string, unknown> | null,
): string | null {
	if (!isJsonObject(input)) return null;
	const existing = new Set(existingDesignIdentityKinds(candidate).keys());
	if (sourceContract !== null && sourceContract !== undefined) {
		for (const id of existingDesignIdentityKinds(sourceContract).keys()) {
			existing.add(id);
		}
	}
	const declarations: Array<{ path: string; value: unknown }> = [];
	if (isJsonObject(input.root) && input.root.id !== undefined) {
		declarations.push({ path: "root.id", value: input.root.id });
	}
	if (Array.isArray(input.collections)) {
		for (const [collectionIndex, collection] of input.collections.entries()) {
			if (!isJsonObject(collection) || !Array.isArray(collection.upserts)) {
				continue;
			}
			if (collection.collection === "dispositions") continue;
			for (const [itemIndex, item] of collection.upserts.entries()) {
				if (!isJsonObject(item)) continue;
				declarations.push({
					path: `collections.${collectionIndex}.upserts.${itemIndex}.id`,
					value: item.id,
				});
				if (
					collection.collection === "records" &&
					Array.isArray(item.properties)
				) {
					for (const [propertyIndex, property] of item.properties.entries()) {
						if (!isJsonObject(property)) continue;
						declarations.push({
							path: `collections.${collectionIndex}.upserts.${itemIndex}.properties.${propertyIndex}.id`,
							value: property.id,
						});
					}
				}
				if (
					collection.collection === "formCompositions" &&
					isJsonObject(item.layout)
				) {
					for (const [sectionIndex, section] of (Array.isArray(
						item.layout.sections,
					)
						? item.layout.sections
						: []
					).entries()) {
						if (!isJsonObject(section)) continue;
						declarations.push({
							path: `collections.${collectionIndex}.upserts.${itemIndex}.layout.sections.${sectionIndex}.id`,
							value: section.id,
						});
						for (const [
							compositionItemIndex,
							compositionItem,
						] of (Array.isArray(section.items)
							? section.items
							: []
						).entries()) {
							if (!isJsonObject(compositionItem)) continue;
							declarations.push({
								path: `collections.${collectionIndex}.upserts.${itemIndex}.layout.sections.${sectionIndex}.items.${compositionItemIndex}.id`,
								value: compositionItem.id,
							});
						}
					}
					for (const [compositionItemIndex, compositionItem] of (Array.isArray(
						item.layout.items,
					)
						? item.layout.items
						: []
					).entries()) {
						if (!isJsonObject(compositionItem)) continue;
						declarations.push({
							path: `collections.${collectionIndex}.upserts.${itemIndex}.layout.items.${compositionItemIndex}.id`,
							value: compositionItem.id,
						});
					}
				}
			}
		}
	}
	for (const declaration of declarations) {
		if (
			typeof declaration.value === "string" &&
			!existing.has(declaration.value)
		) {
			return `${declaration.path} declares a new design identity with a raw UUID. Use a readable handle such as {"handle":"@name"}; raw UUIDs may reference only identities proven to exist in the accepted base.`;
		}
	}
	const declarationPaths = new Set(declarations.map(({ path }) => path));
	const occurrences: Array<{ path: string; value: string }> = [];
	const visit = (value: unknown, path: string): void => {
		if (Array.isArray(value)) {
			for (const [index, entry] of value.entries()) {
				visit(entry, `${path}.${index}`);
			}
			return;
		}
		if (!isJsonObject(value)) return;
		/* Disposition upserts and removals point into the review-finding
		 * namespace. They are deliberately not Design Contract identities. */
		if (path === "dispositions" || value.collection === "dispositions") return;
		for (const [key, entry] of Object.entries(value)) {
			const nextPath = path === "" ? key : `${path}.${key}`;
			const identitySlot =
				key === "id" ||
				key === "removeIds" ||
				key.endsWith("Id") ||
				key.endsWith("Ids");
			if (identitySlot) {
				const values = Array.isArray(entry) ? entry : [entry];
				values.forEach((identity, index) => {
					if (
						typeof identity === "string" &&
						designIdSchema.safeParse(identity).success
					) {
						occurrences.push({
							path: Array.isArray(entry) ? `${nextPath}.${index}` : nextPath,
							value: identity,
						});
					}
				});
				continue;
			}
			visit(entry, nextPath);
		}
	};
	visit(input, "");
	const unknown = occurrences.find(
		(occurrence) =>
			!existing.has(occurrence.value) && !declarationPaths.has(occurrence.path),
	);
	if (unknown !== undefined) {
		return `${unknown.path} references an unknown raw design UUID. Use the declared readable handle for new design elements; raw UUIDs may reference only identities proven to exist in the accepted base.`;
	}
	return null;
}

export function createDesignLoopTools(deps: DesignLoopToolDeps) {
	/* The AI SDK may invoke calls from one response concurrently. Queue every
	 * design-side execute callback at invocation time so provider order becomes
	 * durable workspace order, including update -> finish -> review chains. */
	let orderedTail: Promise<void> = Promise.resolve();
	const inResponseOrder = <T>(work: () => Promise<T>): Promise<T> => {
		const result = orderedTail.then(work);
		orderedTail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	};

	const workspaceKind = (gates: DesignGateState): DesignArtifactKind =>
		gates.verdicts.submitRevision.legal || gates.headReviews.length > 0
			? "revision"
			: "contract";

	const semanticUpdate = async (args: {
		input: unknown;
		toolCallId: string;
		collection?: (typeof CONTRACT_COLLECTIONS)[number];
		root?: boolean;
		dispositions?: boolean;
	}) => {
		const gates = await gatesFor(deps);
		const kind = workspaceKind(gates);
		const repairTool: DesignStageToolName =
			kind === "contract" ? "stageContract" : "stageRevision";
		const refusal = refuse(deps, gates, gateNameForKind(kind));
		if (refusal) return refusal;
		const workspace = await openDesignArtifactWorkspace({
			designSessionId: deps.designSessionId,
			lineage: designWorkspaceLineageForGates(kind, gates),
			authority: deps.authority,
		});
		const questionRefusal = await requiredQuestionRefusal(
			deps,
			workspace.candidate,
		);
		if (questionRefusal !== null) return questionRefusal;

		const body = stripNullProperties(args.input) as Record<string, unknown>;
		const wrapped = args.root
			? { root: body, collections: [] }
			: args.dispositions
				? {
						collections: [],
						dispositions: { collection: "dispositions", ...body },
					}
				: {
						collections: [{ collection: args.collection, ...body }],
					};
		let stagedInput: unknown = wrapped;
		if (args.dispositions) {
			const findingBindings = deriveFindingHandleBindings(
				gates.headReviews.map((review) => review.envelope.payload),
			);
			const preResolved = resolveDesignFindingHandles(
				stagedInput,
				findingBindings,
			);
			if (!preResolved.ok) {
				return rejectedStage(deps, repairTool, {
					error: preResolved.error,
					diagnostic: {
						code: "design-unknown-finding-handle",
						validationStage: "partial" as const,
						issueCount: 1,
					},
				});
			}
			stagedInput = preResolved.value;
		}
		const admissionRejection = stagedInputAdmissionRejection(
			deps,
			repairTool,
			stagedInput,
			workspace,
		);
		if (admissionRejection !== null) return admissionRejection;
		const parsed = parseHandledStage(
			designArtifactWorkspaceOperationSchema,
			{ kind, ...(stagedInput as Record<string, unknown>) },
			deps.designSessionId,
		);
		if (!parsed.ok)
			return rejectedStage(deps, repairTool, { error: parsed.error });
		return persistStagedDesignPart({
			deps,
			toolName: repairTool,
			kind,
			gates,
			toolCallId: args.toolCallId,
			stagedInput,
			parsedInput: parsed.data,
			operation: parsed.data,
			workspaceRevision: workspace.workspace.revision,
			workspaceHandleBindings: workspace.handleBindings,
			successMessage:
				kind === "contract"
					? "The design update is saved. Continue with other known semantic updates, then finish the complete design."
					: "The revision update is saved. Continue with the affected design items and blocking dispositions, then finish the revision.",
		});
	};

	const semanticCollectionTool = (
		collection: (typeof CONTRACT_COLLECTIONS)[number],
		description: string,
	) => ({
		description: `${description} Upsert or remove complete items. Give each new element a readable @handle and reuse it in references. Emit this together with other known design updates in the same response.`,
		inputSchema: strictWireWithHandles(
			designCollectionUpdateInputSchemas[collection],
		),
		strict: true,
		execute: (input: unknown, options: { readonly toolCallId: string }) =>
			inResponseOrder(() =>
				semanticUpdate({
					input,
					toolCallId: options.toolCallId,
					collection,
				}),
			),
	});

	const setDesignRoot = {
		description:
			"Set the design identity and/or complete app charter in the implicit design workspace. Give a new design identity a readable @handle. Emit this with other known semantic design calls in the same response.",
		inputSchema: strictWireWithHandles(setDesignRootInputSchema),
		strict: true,
		execute: (input: unknown, options: { readonly toolCallId: string }) =>
			inResponseOrder(() =>
				semanticUpdate({
					input,
					toolCallId: options.toolCallId,
					root: true,
				}),
			),
	};
	const updateActors = semanticCollectionTool("actors", "Update app actors.");
	const updateRecords = semanticCollectionTool(
		"records",
		"Update durable record concepts and their properties.",
	);
	const updateWorkflows = semanticCollectionTool(
		"workflows",
		"Update task-complete workflow semantics.",
	);
	const updateLists = semanticCollectionTool(
		"lists",
		"Update worker queues and searches.",
	);
	const updateAccess = semanticCollectionTool(
		"access",
		"Update actor access policies.",
	);
	const updateNavigation = semanticCollectionTool(
		"navigation",
		"Update worker navigation intent.",
	);
	const updateModuleCompositions = semanticCollectionTool(
		"moduleCompositions",
		"Update worker-facing module composition.",
	);
	const updateFormCompositions = semanticCollectionTool(
		"formCompositions",
		"Update exact worker-facing form composition and layout.",
	);
	const updateExternalRequirements = semanticCollectionTool(
		"externalRequirements",
		"Update honest requirements outside the authored app.",
	);
	const updateDecisions = semanticCollectionTool(
		"decisions",
		"Update settled architecture decisions.",
	);
	const updateAssumptions = semanticCollectionTool(
		"assumptions",
		"Update explicit design assumptions.",
	);
	const updateOpenQuestions = semanticCollectionTool(
		"openQuestions",
		"Update genuinely open design questions.",
	);
	const updateFindingDispositions = {
		description:
			"Disposition blocking findings in the current reviewed revision. Use each finding's printed @f handle exactly. Advisory findings need no disposition. Emit dispositions with the affected semantic design updates in the same response.",
		inputSchema: strictWireWithHandles(updateFindingDispositionsInputSchema),
		strict: true,
		execute: (input: unknown, options: { readonly toolCallId: string }) =>
			inResponseOrder(() =>
				semanticUpdate({
					input,
					toolCallId: options.toolCallId,
					dispositions: true,
				}),
			),
	};

	const inspectDesign = {
		description:
			"Inspect the implicit authoritative design candidate. Request a compact summary, root metadata, or up to 20 exact items from one collection. During revision, sourceRoot and sourceCollection inspect the immutable reviewed parent. Use only for a narrow lookup after resume or compaction; the state packet already carries the full current candidate.",
		inputSchema: strictWireWithHandles(inspectDesignInputSchema),
		strict: true,
		execute: (input: unknown) =>
			inResponseOrder(async () => {
				const parsed = parseHandledStage(
					inspectDesignInputSchema,
					stripNullProperties(input),
					deps.designSessionId,
				);
				if (!parsed.ok) return { error: parsed.error };
				const gates = await gatesFor(deps);
				const kind = workspaceKind(gates);
				const refusal = refuse(deps, gates, gateNameForKind(kind));
				if (refusal) return refusal;
				try {
					const state = await openDesignArtifactWorkspace({
						designSessionId: deps.designSessionId,
						lineage: designWorkspaceLineageForGates(kind, gates),
						authority: deps.authority,
					});
					return {
						ok: true,
						view: projectDesignIdentityHandles(
							inspectDesignWorkspaceCandidate({
								kind,
								candidate: state.candidate,
								...(state.sourceContract !== null && {
									sourceContract: state.sourceContract,
								}),
								selection: parsed.data.selection,
							}),
							state.handleBindings,
						),
					};
				} catch (error) {
					const handled = workspaceError(error);
					if (handled) return handled;
					throw error;
				}
			}),
	};

	const finishContract = async (input: unknown) => {
		const gates = await gatesFor(deps);
		const refusal = refuse(deps, gates, "submitContract");
		if (refusal) return refusal;
		const parsedInput = parseStage(finishDesignInputSchema, input);
		if (!parsedInput.ok) return { error: parsedInput.error };
		let state: Awaited<ReturnType<typeof inspectDesignArtifactWorkspace>>;
		try {
			state = await openDesignArtifactWorkspace({
				designSessionId: deps.designSessionId,
				lineage: designWorkspaceLineageForGates("contract", gates),
				authority: deps.authority,
			});
		} catch (error) {
			const handled = workspaceError(error);
			if (handled) return handled;
			throw error;
		}
		const parsed = appDesignContractSchema.safeParse(state.candidate);
		if (!parsed.success) {
			return schemaSubmissionRejection(
				deps,
				"submitContract",
				parsed.error,
				state.handleBindings,
			);
		}
		const constructionRejection = constructionSubmissionRejection({
			deps,
			toolName: "submitContract",
			contract: parsed.data,
			handleBindings: state.handleBindings,
			needsDecisionsLine:
				"The contract needs decisions from the user before it can be finalized.",
		});
		if (constructionRejection !== null) return constructionRejection;
		const head = gates.head;
		const draft = await insertDesignRevision({
			envelope: contractEnvelope({
				designSessionId: deps.designSessionId,
				packageDigest: state.workspace.lineage.sourcePackageDigest,
				contract: parsed.data,
				revision: (head?.revision ?? 0) + 1,
				parentId: head?.id ?? null,
				inputDigests: head ? [head.artifactDigest] : [],
				promptVersion: DESIGN_PROMPT_VERSIONS.agent,
				finishReason: null,
			}),
			lifecycle: "draft",
			authority: deps.authority,
			supersedeUncommittedExecution: gates.supersedesPlanExecution,
			workspaceFinalization: {
				workspaceId: state.workspace.id,
				expectedRevision: state.workspace.revision,
				artifactKind: "contract",
			},
		});
		deps.ancestryChanged();
		deps.repair.noteAccepted("submitContract");
		return {
			ok: true,
			revisionId: draft.id,
			effortLevel: draft.envelope.complexity?.depth,
			roughTimeEstimate:
				draft.envelope.complexity === undefined
					? undefined
					: DESIGN_EFFORT_TIME_ESTIMATES[draft.envelope.complexity.depth],
			message: `The draft persisted as revision ${draft.revision}. Request its independent review with requestReview.`,
		};
	};

	const requestReviewInternal = {
		description:
			"Ask the server to run the independent fresh-context reviewer over the current draft. The persisted review's findings come back as the result; a clean review is accepted on the spot.",
		inputSchema: strictWireOnly(z.object({}).strict()),
		strict: true,
		execute: async () => {
			const gates = await gatesFor(deps);
			const refusal = refuse(deps, gates, "requestReview");
			if (refusal) return refusal;
			const draft = gates.head;
			if (draft === null) return { error: "No draft exists to review." };
			const pkg =
				draft.sourcePackageDigest === deps.currentPkg.packageDigest
					? deps.currentPkg
					: await deps.rebuildPackageForDigest(draft.sourcePackageDigest);
			if (pkg === null) {
				deps.repair.noteSequenceError();
				return {
					error:
						"The sources for this draft no longer reproduce exactly. Stage and finalize a fresh Design Contract from the current sources.",
				};
			}
			/* The session's handle ledger renders the contract in symbol
			 * vocabulary and resolves the symbols the reviewer emits — one
			 * read-only load feeds both directions. */
			const bindings = await readDesignIdentityHandleBindings({
				designSessionId: deps.designSessionId,
				authority: deps.authority,
			});
			const reviewed = await runDesignReviewer(
				deps.ctx,
				{
					pkg,
					contract: draft.envelope.payload,
					catalogText: deps.catalogText,
					bindings,
				},
				deps.signal,
				deps.onReviewActivity,
			);
			if (reviewed.kind === "not-produced") {
				deps.repair.noteSubmissionRejection("requestReview", {
					stage: "schema",
					fingerprints: [`review:${reviewed.reason}`],
				});
				return {
					error: `The independent review did not come back usable this time (${reviewed.reason}). The draft stays unreviewed; request the review again.`,
				};
			}
			if (reviewed.reasoningText) {
				deps.onReviewerReasoning?.(reviewed.reasoningText);
			}
			const review = await insertDesignReview({
				envelope: reviewEnvelope({
					draft,
					review: reviewed.artifact,
					finishReason: reviewed.finishReason,
				}),
				designRevisionId: draft.id,
				authority: deps.authority,
			});
			deps.ancestryChanged();
			deps.repair.noteAccepted("requestReview");
			const findings = review.envelope.payload.findings;
			const gated = findings.filter(findingBlocksAcceptance);
			/* The agent reads and writes symbols: finding ids project to their
			 * positional `@f` handles (what a disposition's findingId takes) and
			 * affected elements back through the ledger — the same vocabulary
			 * the next state packet prints. */
			const findingHandleBindings = deriveFindingHandleBindings([
				...gates.headReviews.map((entry) => entry.envelope.payload),
				review.envelope.payload,
			]);
			const projectedFindings = projectDesignIdentityHandles(findings, [
				...bindings,
				...findingHandleBindings,
			]);
			if (gated.length === 0) {
				const accepted = await insertDesignRevision({
					envelope: contractEnvelope({
						designSessionId: deps.designSessionId,
						packageDigest: draft.sourcePackageDigest,
						contract: draft.envelope.payload,
						revision: draft.revision + 1,
						parentId: draft.id,
						inputDigests: [draft.artifactDigest, review.artifactDigest],
						promptVersion: draft.envelope.promptVersion,
						finishReason: draft.envelope.producer.finishReason,
					}),
					lifecycle: "accepted",
					authority: deps.authority,
					dispositions: [],
				});
				deps.ancestryChanged();
				const blocking = accepted.envelope.payload.openQuestions.filter(
					(question) => question.blocking,
				);
				const plan =
					blocking.length === 0
						? await persistDerivedPlan(deps, accepted)
						: null;
				return {
					ok: true,
					reviewId: review.id,
					summary: review.envelope.payload.summary,
					findings: projectedFindings,
					accepted: true,
					acceptedRevisionId: accepted.id,
					planId: plan?.id,
					message:
						blocking.length > 0
							? "The review raised no gated findings, so the server accepted the design. Ask the user its blocking open questions."
							: "The review raised no blocking findings, so the server accepted the design and derived its build plan. Tell the user briefly that the build is starting, then stop.",
				};
			}
			const handleByFindingId = new Map(
				findingHandleBindings.map((binding) => [
					binding.designId,
					binding.handle,
				]),
			);
			const gatedHandles = gated.map(
				(finding) => handleByFindingId.get(finding.id) ?? finding.id,
			);
			return {
				ok: true,
				reviewId: review.id,
				summary: review.envelope.payload.summary,
				findings: projectedFindings,
				accepted: false,
				message: `The review has blocking design corrections or user decisions: ${gatedHandles.join(", ")}. Update the affected semantic design items and record exactly one disposition per blocking finding — a disposition's findingId is the finding's printed handle, for example {"handle":"@f1"}; advisory findings take no disposition — then finish the revision.`,
			};
		},
	};

	const finishRevision = async (input: unknown) => {
		const gates = await gatesFor(deps);
		const refusal = refuse(deps, gates, "submitRevision");
		if (refusal) return refusal;
		const head = gates.head;
		if (head === null) return { error: "No draft exists to revise." };
		const parsedInput = parseStage(finishDesignInputSchema, input);
		if (!parsedInput.ok) return { error: parsedInput.error };
		let state: Awaited<ReturnType<typeof inspectDesignArtifactWorkspace>>;
		try {
			state = await openDesignArtifactWorkspace({
				designSessionId: deps.designSessionId,
				lineage: designWorkspaceLineageForGates("revision", gates),
				authority: deps.authority,
			});
		} catch (error) {
			const handled = workspaceError(error);
			if (handled) return handled;
			throw error;
		}
		const { dispositions, ...contract } = state.candidate;
		const reviewPayloads = gates.headReviews.map(
			(review) => review.envelope.payload,
		);
		const parsed = designRevisionResultSchemaFor(reviewPayloads).safeParse({
			contract,
			dispositions,
		});
		if (!parsed.success) {
			return schemaSubmissionRejection(
				deps,
				"submitRevision",
				parsed.error,
				state.handleBindings,
			);
		}
		const constructionRejection = constructionSubmissionRejection({
			deps,
			toolName: "submitRevision",
			contract: parsed.data.contract,
			handleBindings: state.handleBindings,
			needsDecisionsLine:
				"The revision needs decisions from the user before it can be accepted.",
		});
		if (constructionRejection !== null) return constructionRejection;
		const sensitivityViolations = validateSensitivityNotSilentlyLowered(
			head.envelope.payload,
			parsed.data,
			reviewPayloads,
		);
		if (sensitivityViolations.length > 0) {
			deps.repair.noteSubmissionRejection("submitRevision", {
				stage: "sensitivity",
				fingerprints: sensitivityViolations,
			});
			return {
				error: [
					"The revision quietly lowered declared sensitivity:",
					...sensitivityViolations.map((violation) => `- ${violation}`),
				].join("\n"),
				diagnostic: rejectionDiagnostic(
					"sensitivity",
					sensitivityViolations.length,
				),
			};
		}
		const mappedDispositions = mapDispositionsToReviews(
			parsed.data,
			gates.headReviews,
		);
		const criticalFindings = criticalFindingCount(reviewPayloads);
		const secondRoundWarranted =
			gates.openCycleReviews === 1 &&
			(leavesCriticalFinding(parsed.data, reviewPayloads) ||
				criticalFindings >= 2 ||
				(criticalFindings > 0 &&
					changesArchitecture(head.envelope.payload, parsed.data.contract)));
		const lifecycle = secondRoundWarranted ? "draft" : "accepted";
		const revision = await insertDesignRevision({
			envelope: contractEnvelope({
				designSessionId: deps.designSessionId,
				packageDigest: state.workspace.lineage.sourcePackageDigest,
				contract: parsed.data.contract,
				revision: head.revision + 1,
				parentId: head.id,
				inputDigests: [
					head.artifactDigest,
					...gates.headReviews.map((review) => review.artifactDigest),
				],
				promptVersion: DESIGN_PROMPT_VERSIONS.agent,
				finishReason: null,
			}),
			lifecycle,
			authority: deps.authority,
			dispositions: mappedDispositions,
			workspaceFinalization: {
				workspaceId: state.workspace.id,
				expectedRevision: state.workspace.revision,
				artifactKind: "revision",
			},
		});
		deps.ancestryChanged();
		deps.repair.noteAccepted("submitRevision");
		if (lifecycle === "draft") {
			return {
				ok: true,
				revisionId: revision.id,
				accepted: false,
				message:
					"The revision persisted and warrants a second independent look. Request it with requestReview.",
			};
		}
		const blocking = revision.envelope.payload.openQuestions.filter(
			(question) => question.blocking,
		);
		const plan =
			blocking.length === 0 ? await persistDerivedPlan(deps, revision) : null;
		return {
			ok: true,
			revisionId: revision.id,
			accepted: true,
			planId: plan?.id,
			message:
				blocking.length > 0
					? "The accepted design carries blocking open questions. Ask the user before planning."
					: "The revision persisted as the accepted design and the server derived its build plan. Tell the user briefly that the build is starting, then stop.",
		};
	};

	const finishDesign = {
		description:
			"Finish the complete design in the implicit workspace. The server chooses contract or reviewed-revision finalization from durable state, validates the whole graph, and atomically persists it or returns exact corrections. Call only after all known semantic updates; it may follow them in the same response.",
		inputSchema: strictWireOnly(finishDesignInputSchema),
		strict: true,
		execute: (input: unknown) =>
			inResponseOrder(async () => {
				const gates = await gatesFor(deps);
				return workspaceKind(gates) === "revision"
					? finishRevision(input)
					: finishContract(input);
			}),
	};

	const requestReview = {
		...requestReviewInternal,
		execute: () => inResponseOrder(() => requestReviewInternal.execute()),
	};

	return {
		setDesignRoot,
		updateActors,
		updateRecords,
		updateWorkflows,
		updateLists,
		updateAccess,
		updateNavigation,
		updateModuleCompositions,
		updateFormCompositions,
		updateExternalRequirements,
		updateDecisions,
		updateAssumptions,
		updateOpenQuestions,
		updateFindingDispositions,
		inspectDesign,
		finishDesign,
		requestReview,
	};
}
