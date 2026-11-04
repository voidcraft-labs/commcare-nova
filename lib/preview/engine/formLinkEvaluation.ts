/**
 * After-submit destinations in the running preview.
 *
 * Once a form's submission has landed, the device evaluates every frame the
 * form's entry pushes, in one evaluation context
 * (`session/CommCareSession.java::executeStackOperations`, each frame pushed
 * when its `if` holds), and runs the last pushed first. The preview runs the
 * same frames over the same projection the wire reads
 * (`lib/commcare/formLinkProjection.ts::projectAfterSubmit`), so what it does
 * after a submission is what a device does: never a second derivation of
 * which destination holds or of which case the next form opens with. Which
 * of the pushed frames then run is each platform's stack
 * (`lib/preview/afterSubmitStack.ts`).
 *
 * Three things this module decides, all pure:
 *
 *   - **Which frames are pushed** (`evaluateAfterSubmit`): every projected
 *     link whose emitted `xpath` holds (a blank one holds), in emitted
 *     order, then the built-in otherwise when its `xpath` holds. Each
 *     `xpath` is the projection's tree printed at the `preview` target, its
 *     condition and its held-case guards together, so a destination whose
 *     carried case is not on the device is not pushed, as on a device.
 *   - **What the evaluation can see** (`formLinkEvalContext`): the device
 *     evaluates the frames after the XForm has closed, in the entry's
 *     session scope. So `instance('commcaresession')/session/...` reads the
 *     worker's session plus the source entry's own datums, a worker read
 *     reads the worker's usercase, a case read walks the device casedb AS
 *     IT IS AFTER THE SUBMISSION, and any read of the closed form (a
 *     `/data/...` path) throws.
 *   - **Which case each next form opens with** (`carriedCaseFor`): the
 *     target's projected own-case selection datum, matched exactly the way
 *     the wire matches it, per frame. A manual datum under that projected id
 *     is evaluated; otherwise the frame reads the source datum
 *     `matchFrameToSource` picked. Each source datum is worth what the
 *     entry's session map held (`entrySessionData.ts`): the device's session
 *     does not change when the form closes, so the own-case datum is the
 *     case the form loaded, ancestor selections are the menu's choices, and
 *     a `uuid()` datum is the id the entry minted, which the submission
 *     created its case with. A datum the session did not value reads blank,
 *     as on a device.
 */

import {
	entryDatumIdResolver,
	entryFrameDatums,
	entrySelectionDatumSources,
	type FormLinkProjectionContext,
	formLinkProjectionContext,
	formLinkTargetDatumIds,
	matchFrameToSource,
	owningModuleOf,
	type ProjectedFormLink,
	projectAfterSubmit,
	projectFormLinkSessionExpression,
	selectedCaseDatumId,
	targetFrameChildren,
} from "@/lib/commcare/formLinkProjection";
import { serializeWire } from "@/lib/commcare/xpath/wire/serialize";
import {
	type BlueprintDoc,
	effectivePostSubmit,
	type FormLink,
	type FormLinkDatum,
	type FormLinkEntry,
	type FormOtherwiseLink,
	formLinkEntries,
	guardedLinkDatums,
	materializableCaseTypes,
	type OtherwiseDestination,
	type PostSubmitDestination,
	resolveFormLinkTarget,
	type Uuid,
} from "@/lib/domain";
import type {
	Expression,
	FormExpressionSlotRef,
} from "@/lib/domain/expression/types";
import { expressionSlotValues } from "@/lib/domain/referenceSlots";
import { type AfterSubmitPathStep, afterSubmitPath } from "../afterSubmitStack";
import { toBoolean, xpathToString } from "../xpath/coerce";
import { evaluate } from "../xpath/evaluator";
import { invokeGeneratedJavaRosaFunction } from "../xpath/generatedJavaRosaFunctions";
import type { XPathInstance } from "../xpath/runtimeValues";
import {
	dayNumberEpochOf,
	type EvalContext,
	type XPathValue,
} from "../xpath/types";
import { snapshotXPathWorkerInstance } from "../xpath/workerProjection";
import type { XPathWorkerInstances } from "../xpath/workerProtocol";
import { expressionReadsCaseDatabase } from "./expressionCaseReads";
import type { PreviewSearchSessionValues } from "./identity";
import type { PreviewLookupData } from "./lookupEvaluation";
import { previewWorkerPropertyBinding } from "./workerExpressionBindings";
import {
	type CaseDatabaseSnapshot,
	type SearchResultsSnapshot,
	secondaryXPathInstances,
} from "./xpathInstances";

/** Case rows after the submission, case-type name → property map. */
export type PostSubmissionCaseData = ReadonlyMap<
	string,
	ReadonlyMap<string, string>
>;

/** One source datum's value once the submission has landed. */
export interface SessionDatumValue {
	/** The session value; `""` when nothing filled the datum. */
	readonly value: string;
	/** The case's display name when the value names a case the preview
	 *  knows, so the next form's breadcrumb can name it. */
	readonly caseName?: string;
}

/** What the source form's submission produced, in the preview's terms. */
export interface CarriedSubmission {
	/** The case the source form loaded or created; absent for a survey. */
	readonly caseId?: string;
	readonly caseName?: string;
	/**
	 * The concrete child cases the submission created, enriched from each
	 * receipt record's explicit authored-child index. No caller infers authored
	 * identity from flat result order.
	 */
	readonly childCases: ReadonlyArray<{
		readonly caseType: string;
		readonly caseId: string;
		readonly caseName?: string;
	}>;
}

/** Everything a link condition or datum can read. */
export interface FormLinkEvaluationInput {
	readonly doc: BlueprintDoc;
	readonly formUuid: Uuid;
	readonly session: PreviewSearchSessionValues;
	/** The worker's usercase, which `#user/<prop>` reads. */
	readonly usercase: Readonly<Record<string, string>>;
	/** The source entry's session map once its submission landed
	 *  (`entrySessionData.ts::afterSubmitSessionDatums`). */
	readonly sessionDatums: ReadonlyMap<string, SessionDatumValue>;
	/** The entry-captured device snapshot with the committed submission patch
	 * applied. A fresh restore is not equivalent: it can omit a case the local
	 * device just closed or reassigned and still retains until sync. */
	readonly caseDatabase?: CaseDatabaseSnapshot;
	readonly lookupData?: PreviewLookupData | null;
	/** What the source entry's search returned, in a search-first module:
	 *  the session keeps it on its query step after the form closes. */
	readonly searchResults?: SearchResultsSnapshot;
}

export type FormLinkAsyncEvaluator = (
	source: string,
	instances: XPathWorkerInstances,
) => Promise<XPathValue>;

/** One post-submit session world. Secondary instances are snapshotted once;
 * every condition and manual target datum then runs against that same worker
 * world and revision, exactly like one JavaRosa form-link dispatch. */
export interface FormLinkWorkerWorld {
	readonly key: string;
	initialized: boolean;
	readonly secondary: XPathWorkerInstances["secondary"];
}

/** Whether some form's after-submit reads the device's cases: a condition
 *  or a carried value that reads them, or a carried value the held-case
 *  guard tests against `casedb` (`lib/domain/afterSubmit.ts::guardedLinkDatums`). */
export function formLinksRequireCaseDatabase(doc: BlueprintDoc): boolean {
	return Object.values(doc.forms).some(
		(form) =>
			expressionSlotValues(doc, { entity: "form", uuid: form.uuid }).some(
				({ ref, expression }) =>
					(ref.slot === "form_link_condition" ||
						ref.slot === "form_link_datum_xpath") &&
					expressionReadsCaseDatabase(expression, doc),
			) ||
			formLinkEntries(form).some(
				(entry) => guardedLinkDatums(doc, form.uuid, entry.link).length > 0,
			),
	);
}

/** The projection context every after-submit print reads: the device's
 *  lookup naming and the worker's record binding. */
function formLinkEvaluationProjectionContext(
	input: FormLinkEvaluationInput,
): FormLinkProjectionContext {
	return formLinkProjectionContext(input.doc, {
		entryMetadataOnly: true,
		lookupNaming: input.lookupData?.naming,
		workerProperty: previewWorkerPropertyBinding(
			input.session.context.userid,
			input.usercase,
			input.caseDatabase,
		),
	});
}

/** The native session projector owns case/datum bindings and actual slot context. */
function formLinkSource(
	input: FormLinkEvaluationInput,
	expression: Expression,
	slot: FormExpressionSlotRef,
): string {
	return serializeWire(
		projectFormLinkSessionExpression(
			input.doc,
			formLinkEvaluationProjectionContext(input),
			input.formUuid,
			expression,
			slot,
		),
		{ target: "preview" },
	).text;
}

/**
 * One frame the device pushes after a submission. A destination of
 * `formLinks`, the otherwise when it is a link, the built-in otherwise, or,
 * for a form without destinations, its after-submit destination.
 */
export type AfterSubmitFrameChoice =
	| {
			readonly kind: "destination";
			readonly link: FormLink;
			readonly index: number;
	  }
	| { readonly kind: "otherwise-link"; readonly link: FormOtherwiseLink }
	| { readonly kind: "otherwise"; readonly destination: OtherwiseDestination }
	| {
			readonly kind: "post-submit";
			readonly destination: PostSubmitDestination;
	  };

/** The link a frame follows, as every link reader reads it; `undefined` for
 *  a built-in destination. */
export function frameChoiceEntry(
	choice: AfterSubmitFrameChoice,
): FormLinkEntry | undefined {
	switch (choice.kind) {
		case "destination":
			return {
				role: "destination",
				link: choice.link,
				index: choice.index,
			};
		case "otherwise-link":
			return {
				role: "otherwise",
				link: {
					uuid: choice.link.uuid,
					target: choice.link.target,
					...(choice.link.datums === undefined
						? {}
						: { datums: choice.link.datums }),
				},
			};
		case "otherwise":
		case "post-submit":
			return undefined;
	}
}

/** One candidate frame of a submission: the printed `if` (`undefined`
 *  holds) and the choice it pushes. */
interface CandidateFrame {
	readonly source: string | undefined;
	readonly choice: AfterSubmitFrameChoice;
}

/**
 * Every frame this submission can push, in emitted order, each with the
 * `xpath` the projection prints for it. A form without destinations pushes
 * its after-submit's frame, which holds, and none for `app_home` (HQ's
 * `default`, which builds no frame,
 * `suite_xml/post_process/workflow.py::_get_static_stack_frame`).
 */
function candidateFrames(
	input: FormLinkEvaluationInput,
): readonly CandidateFrame[] {
	const { doc, formUuid } = input;
	const form = doc.forms[formUuid];
	if (form === undefined)
		throw new Error(
			"The submitted form is no longer in the app, so its next screen can't be chosen.",
		);
	if (form.formLinks === undefined) {
		const destination = effectivePostSubmit(doc, formUuid);
		return destination === undefined || destination === "app_home"
			? []
			: [{ source: undefined, choice: { kind: "post-submit", destination } }];
	}
	const projected = projectAfterSubmit(
		doc,
		formLinkEvaluationProjectionContext(input),
		formUuid,
	);
	if (projected === undefined) return [];
	const print = (link: { readonly xpath?: ProjectedFormLink["xpath"] }) =>
		link.xpath === undefined
			? undefined
			: serializeWire(link.xpath, { target: "preview" }).text;
	const frames: CandidateFrame[] = projected.links.map((link) => {
		if (link.role === "otherwise") {
			const otherwise = form.otherwise;
			if (otherwise?.kind !== "link" || otherwise.uuid !== link.uuid)
				throw new Error(
					"The form's otherwise link changed while its next screen was being chosen.",
				);
			return {
				source: print(link),
				choice: { kind: "otherwise-link", link: otherwise },
			};
		}
		const index = (form.formLinks ?? []).findIndex(
			(candidate) => candidate.uuid === link.uuid,
		);
		const authored = form.formLinks?.[index];
		if (authored === undefined)
			throw new Error(
				"A destination changed while the form's next screen was being chosen.",
			);
		return {
			source: print(link),
			choice: { kind: "destination", link: authored, index },
		};
	});
	if (projected.fallback.kind === "built-in")
		frames.push({
			source: serializeWire(projected.fallback.xpath, { target: "preview" })
				.text,
			choice: {
				kind: "otherwise",
				destination: projected.fallback.destination,
			},
		});
	return frames;
}

export type CarriedCase =
	/** The target selects no case: a module, or a form that loads none. */
	| { readonly kind: "none" }
	/**
	 * The case id the target form opens with. `""` when the session value is
	 * blank: the device opens the form with an empty case id, and the
	 * preview opens it bound to nothing and says so.
	 */
	| {
			readonly kind: "carried";
			readonly caseId: string;
			readonly caseName?: string;
	  };

/** One case-selection datum the matched target frame installs, mapped back
 * to the stable module whose running menu session owns it. `datumId` remains
 * visible so the target form's own carried-case datum can be identified
 * without re-running HQ's matching algorithm. */
export interface TargetCaseSelection {
	readonly datumId: string;
	readonly moduleUuid: Uuid;
	readonly caseType: string;
	readonly caseId: string;
	readonly caseName?: string;
}

/**
 * The evaluation context of a link condition or manual datum: the entry's
 * session scope after the form has closed.
 */
export function formLinkEvalContext(
	input: FormLinkEvaluationInput,
): EvalContext {
	const secondaryInstances = formLinkSecondaryInstances(input);
	const closedFormRead = (what: string): never => {
		throw new Error(
			`A form link cannot read ${what}: the form has already closed when its links are checked. A link can read session values, worker properties and case properties, not the form's answers.`,
		);
	};
	return {
		contextPath: "",
		position: 1,
		getValue: (path) => closedFormRead(`"${path}"`),
		resolveXPathInstance: (instanceId) => secondaryInstances.get(instanceId),
		invokeGeneratedFunction: invokeGeneratedJavaRosaFunction,
		dayNumberEpoch: dayNumberEpochOf(input.session),
	};
}

export function formLinkWorkerInstances(
	input: FormLinkEvaluationInput,
	world?: FormLinkWorkerWorld,
): XPathWorkerInstances {
	const initializeWorld = world !== undefined && !world.initialized;
	if (world !== undefined) world.initialized = true;
	return {
		...(world === undefined
			? { secondary: snapshotFormLinkSecondaryInstances(input) }
			: {
					worldKey: world.key,
					initializeWorld,
					...(initializeWorld ? { secondary: world.secondary } : {}),
				}),
		contextPath: "",
		position: 1,
	};
}

/** The instances the source entry's session holds after its form closes
 * (`org/commcare/session/CommCareSession.java::getEvaluationContext`): the
 * session with its datums, the device's cases and places, every table under
 * its suite id as the source entry declares it, and the search results its
 * query step keeps. */
function formLinkSecondaryInstances(
	input: FormLinkEvaluationInput,
): ReadonlyMap<string, XPathInstance> {
	return secondaryXPathInstances({
		session: input.session,
		lookupData: input.lookupData ?? null,
		caseDatabase: input.caseDatabase ?? null,
		caseTypes: materializableCaseTypes(input.doc),
		sessionData: Object.fromEntries(
			[...input.sessionDatums].map(([name, datum]) => [name, datum.value]),
		),
		...(input.searchResults === undefined
			? {}
			: { searchResults: input.searchResults }),
		organization: input.doc,
		includeFixtureAliases: true,
	});
}

function snapshotFormLinkSecondaryInstances(
	input: FormLinkEvaluationInput,
): NonNullable<XPathWorkerInstances["secondary"]> {
	return [...formLinkSecondaryInstances(input).values()].map(
		snapshotXPathWorkerInstance,
	);
}

export function createFormLinkWorkerWorld(
	input: FormLinkEvaluationInput,
	key: string,
): FormLinkWorkerWorld {
	return {
		key,
		initialized: false,
		secondary: snapshotFormLinkSecondaryInstances(input),
	};
}

/**
 * The frames the device pushes after this submission, in push order (the
 * last is on top). For a form with destinations: each projected link whose
 * emitted `xpath` holds (blank holds), in emitted order, then the built-in
 * otherwise when its `xpath` holds. For a form without: its after-submit's
 * frame, none for `app_home`. Every `xpath` is the projection's
 * (`projectAfterSubmit`) printed by `serializeWire`, and all are evaluated in
 * the one post-submit world, as Core evaluates them in one context.
 */
export function evaluateAfterSubmit(args: {
	readonly input: FormLinkEvaluationInput;
}): readonly AfterSubmitFrameChoice[] {
	const evalCtx = formLinkEvalContext(args.input);
	return candidateFrames(args.input).flatMap((frame) =>
		frame.source === undefined || toBoolean(evaluate(frame.source, evalCtx))
			? [frame.choice]
			: [],
	);
}

export async function evaluateAfterSubmitAsync(args: {
	readonly input: FormLinkEvaluationInput;
	readonly evaluate: FormLinkAsyncEvaluator;
	readonly world?: FormLinkWorkerWorld;
}): Promise<readonly AfterSubmitFrameChoice[]> {
	const pushed: AfterSubmitFrameChoice[] = [];
	for (const frame of candidateFrames(args.input)) {
		if (frame.source === undefined) {
			pushed.push(frame.choice);
			continue;
		}
		const result = await args.evaluate(
			frame.source,
			formLinkWorkerInstances(args.input, args.world),
		);
		if (toBoolean(result)) pushed.push(frame.choice);
	}
	return pushed;
}

/** The string value of a manual datum's XPath in the entry's session scope. */
export function evaluateLinkDatum(
	datum: FormLinkDatum,
	input: FormLinkEvaluationInput,
	linkUuid: Uuid,
): string {
	return xpathToString(
		evaluate(
			formLinkSource(input, datum.xpath, {
				entity: "form",
				uuid: input.formUuid,
				slot: "form_link_datum_xpath",
				member: { linkUuid, datum: datum.name },
			}),
			formLinkEvalContext(input),
		),
	);
}

export async function evaluateLinkDatumAsync(
	datum: FormLinkDatum,
	input: FormLinkEvaluationInput,
	linkUuid: Uuid,
	evaluateAsync: FormLinkAsyncEvaluator,
	world?: FormLinkWorkerWorld,
): Promise<string> {
	const source = formLinkSource(input, datum.xpath, {
		entity: "form",
		uuid: input.formUuid,
		slot: "form_link_datum_xpath",
		member: { linkUuid, datum: datum.name },
	});
	const value = await evaluateAsync(
		source,
		formLinkWorkerInstances(input, world),
	);
	return xpathToString(value);
}

/** The target a frame's link names, `this-form` resolved to the source
 *  form in its own menu. The gate keeps every link's target resolvable, so
 *  a miss is a bypass the caller reports. */
function resolvedEntryTarget(
	doc: BlueprintDoc,
	formUuid: Uuid,
	entry: FormLinkEntry,
) {
	const target = resolveFormLinkTarget(doc, formUuid, entry.link.target);
	if (target === undefined)
		throw new Error(
			"This destination starts the form again, but the form is in no menu.",
		);
	return target;
}

/**
 * The case the target form of `entry` opens with, or `none` when the target
 * selects no case. The caller has already checked that the target exists in
 * the document; a missing target throws here exactly as it does in the
 * projector.
 */
export function carriedCaseFor(
	input: FormLinkEvaluationInput,
	formUuid: Uuid,
	entry: FormLinkEntry,
): CarriedCase {
	return carriedCaseFromSelections(
		input,
		entry,
		projectTargetCaseSelections(input, formUuid, entry),
	);
}

export function carriedCaseFromSelections(
	input: FormLinkEvaluationInput,
	entry: FormLinkEntry,
	selections: readonly TargetCaseSelection[],
): CarriedCase {
	const { doc } = input;
	const target = resolvedEntryTarget(doc, input.formUuid, entry);
	if (target.type !== "form") return { kind: "none" };
	const ctx = formLinkProjectionContext(doc, { entryMetadataOnly: true });
	const targetCaseDatumId = selectedCaseDatumId(
		doc,
		ctx,
		target.moduleUuid,
		target.formUuid,
	);
	if (targetCaseDatumId === undefined) return { kind: "none" };
	const selected = selections.find(
		(selection) => selection.datumId === targetCaseDatumId,
	);
	return selected === undefined
		? { kind: "carried", caseId: "" }
		: {
				kind: "carried",
				caseId: selected.caseId,
				...(selected.caseName !== undefined && {
					caseName: selected.caseName,
				}),
			};
}

/** The selection datums a frame's target installs, and the automatic match
 *  of each to a source datum when the link names no datums. */
function targetSelectionPlan(
	doc: BlueprintDoc,
	formUuid: Uuid,
	entry: FormLinkEntry,
) {
	const ctx = formLinkProjectionContext(doc, { entryMetadataOnly: true });
	const sourceModuleUuid = owningModuleOf(ctx, formUuid);
	if (sourceModuleUuid === undefined) {
		throw new Error(
			`Cannot follow a form link: the form ${formUuid} it leaves from belongs to no module`,
		);
	}
	const target = resolvedEntryTarget(doc, formUuid, entry);
	const targetChildren = targetFrameChildren(doc, ctx, target);
	const targetDatumId = entryDatumIdResolver(
		formLinkTargetDatumIds(doc, ctx, target),
	);
	const targetSelections = targetChildren.flatMap((child) =>
		child.type === "datum" &&
		child.datum.requiresSelection &&
		child.datum.caseType !== undefined &&
		child.datum.selectionSourceModuleUuid !== undefined
			? [child.datum]
			: [],
	);
	const automaticMatches =
		entry.link.datums === undefined
			? new Map(
					matchFrameToSource(
						targetChildren,
						entryFrameDatums(doc, ctx, sourceModuleUuid, formUuid),
					).matched.map((match) => [match.id, match.sourceId]),
				)
			: undefined;
	return { targetDatumId, targetSelections, automaticMatches };
}

/** The display name the entry's session holds for `value`, when it names a
 *  case the preview knows. */
function knownCaseName(
	input: FormLinkEvaluationInput,
	value: string,
): SessionDatumValue {
	const knownName = [...input.sessionDatums.values()].find(
		(candidate) =>
			candidate.value === value && candidate.caseName !== undefined,
	)?.caseName;
	return { value, ...(knownName !== undefined && { caseName: knownName }) };
}

/**
 * Every case-selection datum the target frame installs, valued exactly like
 * HQ's automatic/manual frame matching and mapped to Preview's UUID-keyed
 * menu session. A valid link resolves every selection. The total projection
 * still carries `""` for a manually omitted or structurally matched-but-empty
 * datum, mirroring Core's defined-but-blank session value.
 */
export function projectTargetCaseSelections(
	input: FormLinkEvaluationInput,
	formUuid: Uuid,
	entry: FormLinkEntry,
): readonly TargetCaseSelection[] {
	const { targetDatumId, targetSelections, automaticMatches } =
		targetSelectionPlan(input.doc, formUuid, entry);
	const { link } = entry;
	return targetSelections.flatMap((datum) => {
		const moduleUuid = datum.selectionSourceModuleUuid;
		if (moduleUuid === undefined || datum.caseType === undefined) return [];
		let held: SessionDatumValue | undefined;
		if (link.datums !== undefined) {
			const manual = link.datums.find(
				(candidate) => targetDatumId(candidate.name) === datum.id,
			);
			held = knownCaseName(
				input,
				manual === undefined ? "" : evaluateLinkDatum(manual, input, link.uuid),
			);
		} else {
			const sourceId = automaticMatches?.get(datum.id);
			if (sourceId === undefined) return [];
			held = input.sessionDatums.get(sourceId) ?? { value: "" };
		}
		return [
			{
				datumId: datum.id,
				moduleUuid,
				caseType: datum.caseType,
				caseId: held.value,
				...(held.caseName !== undefined && { caseName: held.caseName }),
			},
		];
	});
}

export async function projectTargetCaseSelectionsAsync(
	input: FormLinkEvaluationInput,
	formUuid: Uuid,
	entry: FormLinkEntry,
	evaluateAsync: FormLinkAsyncEvaluator,
	world?: FormLinkWorkerWorld,
): Promise<readonly TargetCaseSelection[]> {
	const { targetDatumId, targetSelections, automaticMatches } =
		targetSelectionPlan(input.doc, formUuid, entry);
	const { link } = entry;
	const projected: TargetCaseSelection[] = [];
	for (const datum of targetSelections) {
		const moduleUuid = datum.selectionSourceModuleUuid;
		if (moduleUuid === undefined || datum.caseType === undefined) continue;
		let held: SessionDatumValue | undefined;
		if (link.datums !== undefined) {
			const manual = link.datums.find(
				(candidate) => targetDatumId(candidate.name) === datum.id,
			);
			held = knownCaseName(
				input,
				manual === undefined
					? ""
					: await evaluateLinkDatumAsync(
							manual,
							input,
							link.uuid,
							evaluateAsync,
							world,
						),
			);
		} else {
			const sourceId = automaticMatches?.get(datum.id);
			if (sourceId === undefined) continue;
			held = input.sessionDatums.get(sourceId) ?? { value: "" };
		}
		projected.push({
			datumId: datum.id,
			moduleUuid,
			caseType: datum.caseType,
			caseId: held.value,
			...(held.caseName !== undefined && { caseName: held.caseName }),
		});
	}
	return projected;
}

export async function carriedCaseForAsync(
	input: FormLinkEvaluationInput,
	formUuid: Uuid,
	entry: FormLinkEntry,
	evaluateAsync: FormLinkAsyncEvaluator,
	world?: FormLinkWorkerWorld,
): Promise<CarriedCase> {
	const selections = await projectTargetCaseSelectionsAsync(
		input,
		formUuid,
		entry,
		evaluateAsync,
		world,
	);
	return carriedCaseFromSelections(input, entry, selections);
}

/**
 * The path of the entry the worker submitted (`afterSubmitStack.ts`, rule
 * 6): its module chain, the cases each selection datum of its entry held
 * (`entrySelectionDatumSources`), and its form.
 */
export function submittedEntryPath(args: {
	readonly doc: BlueprintDoc;
	readonly moduleUuid: Uuid;
	readonly formUuid: Uuid;
	/** The case ids the entry held for a menu's selection. */
	readonly caseIdsOf: (moduleUuid: Uuid) => readonly string[];
}): readonly AfterSubmitPathStep[] {
	const sources = entrySelectionDatumSources(
		args.doc,
		formLinkProjectionContext(args.doc, { entryMetadataOnly: true }),
		args.moduleUuid,
		args.formUuid,
	);
	return afterSubmitPath(
		args.doc,
		{ moduleUuid: args.moduleUuid, formUuid: args.formUuid },
		sources.map((source) => ({
			moduleUuid: source.moduleUuid,
			caseIds: args.caseIdsOf(source.moduleUuid),
		})),
	);
}
