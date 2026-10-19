/**
 * After-submit links in the running preview.
 *
 * Once a form's submission has landed, the device checks the form's links
 * in order and follows the first whose condition holds; `postSubmit` is
 * where it goes when none does. The preview runs the same rule over the
 * same projection the wire reads (`lib/commcare/formLinkProjection.ts`),
 * so what it does after a submission is what a device does: never a second
 * derivation of which link fires or of which case the next form opens with.
 *
 * Three things this module decides, all pure:
 *
 *   - **Which link fires** (`evaluateFormLinks`): first true wins; a link
 *     whose condition is absent is unconditional. Each stored tree lowers
 *     through the shared wire emitter with its exact source form and link
 *     slot. Selected-record reads therefore use the same projected session
 *     datums and case-database paths as the device.
 *   - **What the evaluation can see** (`formLinkEvalContext`): the device
 *     evaluates a link after the XForm has closed, in the entry's session
 *     scope. So `instance('commcaresession')/session/...` reads the
 *     worker's session plus the source entry's own datums, `#user/<prop>`
 *     reads the worker's usercase, `#<type>/<prop>` reads the case rows AS
 *     THEY ARE AFTER THE SUBMISSION, and any read of the closed form (a
 *     `/data/...` path or `#form/...`) throws.
 *   - **Which case the next form opens with** (`carriedCaseFor`): the
 *     target's projected own-case selection datum, matched exactly the way
 *     the wire matches it. A manual datum under that projected id is
 *     evaluated; otherwise the frame reads the source datum
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
	formLinkIsConditional,
	formLinkProjectionContext,
	formLinkTargetDatumIds,
	matchFrameToSource,
	owningModuleOf,
	projectFormLinkSessionExpression,
	selectedCaseDatumId,
	targetFrameChildren,
} from "@/lib/commcare/formLinkProjection";
import { serializeWire } from "@/lib/commcare/xpath/wire/serialize";
import {
	type BlueprintDoc,
	type FormLink,
	type FormLinkDatum,
	materializableCaseTypes,
	type PostSubmitDestination,
	type Uuid,
} from "@/lib/domain";
import type {
	Expression,
	FormExpressionSlotRef,
} from "@/lib/domain/expression/types";
import { expressionSlotValues } from "@/lib/domain/referenceSlots";
import { toBoolean, xpathToString } from "../xpath/coerce";
import { evaluate } from "../xpath/evaluator";
import { invokeGeneratedJavaRosaFunction } from "../xpath/generatedJavaRosaFunctions";
import type { EvalContext, XPathValue } from "../xpath/types";
import {
	serializeXPathWorkerHashtagValue,
	snapshotXPathWorkerInstance,
	xpathWorkerHashtagReferences,
} from "../xpath/workerProjection";
import type { XPathWorkerInstances } from "../xpath/workerProtocol";
import { expressionReadsCaseDatabase } from "./expressionCaseReads";
import type { PreviewSearchSessionValues } from "./identity";
import type { PreviewLookupData } from "./lookupEvaluation";
import { previewWorkerPropertyBinding } from "./workerExpressionBindings";
import {
	type CaseDatabaseSnapshot,
	caseDatabaseXPathInstance,
	commcareSessionXPathInstance,
	lookupXPathInstances,
	previewHashtagNodeSet,
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
	readonly caseData: PostSubmissionCaseData;
	/** The entry-captured device snapshot with the committed submission patch
	 * applied. A fresh restore is not equivalent: it can omit a case the local
	 * device just closed or reassigned and still retains until sync. */
	readonly caseDatabase?: CaseDatabaseSnapshot;
	readonly lookupData?: PreviewLookupData | null;
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

export function formLinksRequireCaseDatabase(doc: BlueprintDoc): boolean {
	return Object.values(doc.forms).some((form) =>
		expressionSlotValues(doc, { entity: "form", uuid: form.uuid }).some(
			({ ref, expression }) =>
				(ref.slot === "form_link_condition" ||
					ref.slot === "form_link_datum_xpath") &&
				expressionReadsCaseDatabase(expression, doc),
		),
	);
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
			formLinkProjectionContext(input.doc, {
				entryMetadataOnly: true,
				lookupNaming: input.lookupData?.naming,
				workerProperty: previewWorkerPropertyBinding(
					input.session.context.userid,
					input.usercase,
					input.caseDatabase,
				),
			}),
			input.formUuid,
			expression,
			slot,
		),
		{ target: "preview" },
	).text;
}

function conditionSource(
	input: FormLinkEvaluationInput,
	link: FormLink,
): string {
	if (link.condition === undefined) return "true()";
	return formLinkSource(input, link.condition, {
		entity: "form",
		uuid: input.formUuid,
		slot: "form_link_condition",
		member: { linkUuid: link.uuid },
	});
}

export type AfterSubmitChoice =
	| { readonly kind: "link"; readonly link: FormLink; readonly index: number }
	| { readonly kind: "fallback"; readonly destination: PostSubmitDestination };

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
	const secondaryInstances = new Map([
		[
			"commcaresession",
			commcareSessionXPathInstance(
				input.session,
				Object.fromEntries(
					[...input.sessionDatums].map(([name, datum]) => [name, datum.value]),
				),
			),
		],
		[
			"casedb",
			caseDatabaseXPathInstance(
				input.caseDatabase ?? null,
				materializableCaseTypes(input.doc),
			),
		],
		...lookupXPathInstances(input.lookupData ?? null, {
			includeFixtureAliases: true,
		}),
	] as const);
	const closedFormRead = (what: string): never => {
		throw new Error(
			`A form link cannot read ${what}: the form has already closed when its links are checked. A link can read session values, #user properties, and case properties, not the form's answers.`,
		);
	};
	const context: EvalContext = {
		contextPath: "",
		position: 1,
		getValue: (path) => closedFormRead(`"${path}"`),
		resolveXPathInstance: (instanceId) => secondaryInstances.get(instanceId),
		resolveHashtag: (ref) => {
			if (ref.startsWith("#form/")) return closedFormRead(`"${ref}"`);
			if (ref.startsWith("#user/")) {
				return input.usercase[ref.slice("#user/".length)] ?? "";
			}
			const match = /^#([^/]+)\/(.+)$/.exec(ref);
			if (match === null) return "";
			const namespace = match[1] ?? "";
			if (namespace === "case") {
				throw new Error(
					'Authored "#case/..." is not a Nova reference; Preview requires an explicit case-type namespace',
				);
			}
			return input.caseData.get(namespace)?.get(match[2] ?? "") ?? "";
		},
		invokeGeneratedFunction: invokeGeneratedJavaRosaFunction,
	};
	context.resolveHashtagValue = (ref) =>
		previewHashtagNodeSet(ref, {
			casedb: secondaryInstances.get("casedb"),
			caseData: input.caseData,
			userId: input.session.context.userid,
		}) ?? context.resolveHashtag(ref);
	return context;
}

export function formLinkWorkerInstances(
	input: FormLinkEvaluationInput,
	source: string,
	world?: FormLinkWorkerWorld,
): XPathWorkerInstances {
	const context = formLinkEvalContext(input);
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
		hashtagValues: xpathWorkerHashtagReferences(source).map((reference) =>
			serializeXPathWorkerHashtagValue(
				reference,
				context.resolveHashtagValue?.(reference) ??
					context.resolveHashtag(reference),
			),
		),
		contextPath: "",
		position: 1,
	};
}

function snapshotFormLinkSecondaryInstances(
	input: FormLinkEvaluationInput,
): NonNullable<XPathWorkerInstances["secondary"]> {
	return [
		commcareSessionXPathInstance(
			input.session,
			Object.fromEntries(
				[...input.sessionDatums].map(([name, datum]) => [name, datum.value]),
			),
		),
		caseDatabaseXPathInstance(
			input.caseDatabase ?? null,
			materializableCaseTypes(input.doc),
		),
		...lookupXPathInstances(input.lookupData ?? null, {
			includeFixtureAliases: true,
		}).values(),
	].map(snapshotXPathWorkerInstance);
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
 * First true wins. A link with no condition, or whose condition prints to
 * nothing, is unconditional and ends the walk; when no link fires the form
 * goes to `fallback` (its `postSubmit`, or the type's default).
 */
export function evaluateFormLinks(args: {
	readonly links: readonly FormLink[];
	readonly fallback: PostSubmitDestination;
	readonly input: FormLinkEvaluationInput;
}): AfterSubmitChoice {
	const evalCtx = formLinkEvalContext(args.input);
	for (const [index, link] of args.links.entries()) {
		if (!formLinkIsConditional(link) || link.condition === undefined) {
			return { kind: "link", link, index };
		}
		if (toBoolean(evaluate(conditionSource(args.input, link), evalCtx))) {
			return { kind: "link", link, index };
		}
	}
	return { kind: "fallback", destination: args.fallback };
}

export async function evaluateFormLinksAsync(args: {
	readonly links: readonly FormLink[];
	readonly fallback: PostSubmitDestination;
	readonly input: FormLinkEvaluationInput;
	readonly evaluate: FormLinkAsyncEvaluator;
	readonly world?: FormLinkWorkerWorld;
}): Promise<AfterSubmitChoice> {
	for (const [index, link] of args.links.entries()) {
		if (!formLinkIsConditional(link) || link.condition === undefined) {
			return { kind: "link", link, index };
		}
		const source = conditionSource(args.input, link);
		const result = await args.evaluate(
			source,
			formLinkWorkerInstances(args.input, source, args.world),
		);
		if (toBoolean(result)) return { kind: "link", link, index };
	}
	return { kind: "fallback", destination: args.fallback };
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
		formLinkWorkerInstances(input, source, world),
	);
	return xpathToString(value);
}

/**
 * The case the target form of `link` opens with, or `none` when the target
 * selects no case. The caller has already checked that the target exists in
 * the document; a missing target throws here exactly as it does in the
 * projector.
 */
export function carriedCaseFor(
	input: FormLinkEvaluationInput,
	formUuid: Uuid,
	link: FormLink,
): CarriedCase {
	return carriedCaseFromSelections(
		input,
		link,
		projectTargetCaseSelections(input, formUuid, link),
	);
}

export function carriedCaseFromSelections(
	input: FormLinkEvaluationInput,
	link: FormLink,
	selections: readonly TargetCaseSelection[],
): CarriedCase {
	if (link.target.type !== "form") return { kind: "none" };
	const { doc } = input;
	const ctx = formLinkProjectionContext(doc, { entryMetadataOnly: true });
	const targetCaseDatumId = selectedCaseDatumId(
		doc,
		ctx,
		link.target.moduleUuid,
		link.target.formUuid,
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
	link: FormLink,
): readonly TargetCaseSelection[] {
	const { doc } = input;
	const ctx = formLinkProjectionContext(doc, { entryMetadataOnly: true });
	const sourceModuleUuid = owningModuleOf(ctx, formUuid);
	if (sourceModuleUuid === undefined) {
		throw new Error(
			`Cannot follow a form link: the form ${formUuid} it leaves from belongs to no module`,
		);
	}
	const targetChildren = targetFrameChildren(doc, ctx, link.target);
	const targetDatumId = entryDatumIdResolver(
		formLinkTargetDatumIds(doc, ctx, link.target),
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
		link.datums === undefined
			? new Map(
					matchFrameToSource(
						targetChildren,
						entryFrameDatums(doc, ctx, sourceModuleUuid, formUuid),
					).matched.map((match) => [match.id, match.sourceId]),
				)
			: undefined;

	return targetSelections.flatMap((datum) => {
		const moduleUuid = datum.selectionSourceModuleUuid;
		if (moduleUuid === undefined || datum.caseType === undefined) return [];
		let held: SessionDatumValue | undefined;
		if (link.datums !== undefined) {
			const manual = link.datums.find(
				(candidate) => targetDatumId(candidate.name) === datum.id,
			);
			const value =
				manual === undefined ? "" : evaluateLinkDatum(manual, input, link.uuid);
			const knownName = [...input.sessionDatums.values()].find(
				(candidate) =>
					candidate.value === value && candidate.caseName !== undefined,
			)?.caseName;
			held = {
				value,
				...(knownName !== undefined && { caseName: knownName }),
			};
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
	link: FormLink,
	evaluateAsync: FormLinkAsyncEvaluator,
	world?: FormLinkWorkerWorld,
): Promise<readonly TargetCaseSelection[]> {
	const { doc } = input;
	const ctx = formLinkProjectionContext(doc, { entryMetadataOnly: true });
	const sourceModuleUuid = owningModuleOf(ctx, formUuid);
	if (sourceModuleUuid === undefined) {
		throw new Error("Cannot follow a form link whose source has no module.");
	}
	const targetChildren = targetFrameChildren(doc, ctx, link.target);
	const targetDatumId = entryDatumIdResolver(
		formLinkTargetDatumIds(doc, ctx, link.target),
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
		link.datums === undefined
			? new Map(
					matchFrameToSource(
						targetChildren,
						entryFrameDatums(doc, ctx, sourceModuleUuid, formUuid),
					).matched.map((match) => [match.id, match.sourceId]),
				)
			: undefined;
	const projected: TargetCaseSelection[] = [];
	for (const datum of targetSelections) {
		const moduleUuid = datum.selectionSourceModuleUuid;
		if (moduleUuid === undefined || datum.caseType === undefined) continue;
		let held: SessionDatumValue | undefined;
		if (link.datums !== undefined) {
			const manual = link.datums.find(
				(candidate) => targetDatumId(candidate.name) === datum.id,
			);
			const value =
				manual === undefined
					? ""
					: await evaluateLinkDatumAsync(
							manual,
							input,
							link.uuid,
							evaluateAsync,
							world,
						);
			const knownName = [...input.sessionDatums.values()].find(
				(candidate) =>
					candidate.value === value && candidate.caseName !== undefined,
			)?.caseName;
			held = {
				value,
				...(knownName !== undefined && { caseName: knownName }),
			};
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
	link: FormLink,
	evaluateAsync: FormLinkAsyncEvaluator,
	world?: FormLinkWorkerWorld,
): Promise<CarriedCase> {
	const selections = await projectTargetCaseSelectionsAsync(
		input,
		formUuid,
		link,
		evaluateAsync,
		world,
	);
	return carriedCaseFromSelections(input, link, selections);
}
