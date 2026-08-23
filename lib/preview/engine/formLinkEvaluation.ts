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
 *     whose condition is absent or prints to nothing is unconditional. A
 *     condition is printed through `printXPath` (unresolved references
 *     throw, because the commit gate refuses them and reaching one here
 *     means the gate was bypassed) and evaluated as Nova text by the
 *     preview evaluator, so `#patient/mood` resolves through this module's
 *     own context rather than through a lowered casedb walk.
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
 *     `matchFrameToSource` picked, and
 *     `sourceSessionDatums` says what each source datum is worth once the
 *     submission has landed: the projected own-case datum is the case the
 *     form loaded, projected ancestor/inherited selections come from the
 *     resolved menu/session case map, `case_id_new_<type>_0` on a
 *     registration is the case it created, and a subcase datum is the child
 *     case of that type the submission created. A value the preview cannot
 *     name is blank, which is what the device's session holds for a datum
 *     nothing filled.
 */

import {
	entryFrameDatums,
	entrySelectionDatumSources,
	type FrameDatum,
	formLinkIsConditional,
	formLinkProjectionContext,
	matchFrameToSource,
	moduleCaseTypeForActions,
	owningModuleOf,
	selectedCaseDatumId,
	targetFrameChildren,
} from "@/lib/commcare/formLinkProjection";
import {
	type BlueprintDoc,
	deriveCaseWriteInventory,
	type FormLink,
	type FormLinkDatum,
	type PostSubmitDestination,
	printXPath,
	type Uuid,
	type XPathExpression,
	xpathPrintContext,
} from "@/lib/domain";
import { toBoolean, xpathToString } from "../xpath/coerce";
import { evaluate } from "../xpath/evaluator";
import { invokeGeneratedJavaRosaFunction } from "../xpath/generatedJavaRosaFunctions";
import type { EvalContext } from "../xpath/types";
import type { PreviewSearchSessionValues } from "./identity";
import { sessionInstancePathValue } from "./searchExpressionEvaluation";

/** The session-data path prefix of the entry's own datums. */
const SESSION_DATA_PREFIX = "/session/data/";

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

/** A case selection already resolved in Preview's menu/session model, keyed
 * by the module whose projected entry datum consumes it. */
export interface SelectedCaseSessionValue extends SessionDatumValue {
	readonly caseType: string;
}

export type SelectedCaseSession = ReadonlyMap<Uuid, SelectedCaseSessionValue>;

/** What the source form's submission produced, in the preview's terms. */
export interface CarriedSubmission {
	/** The case the source form loaded or created; absent for a survey. */
	readonly caseId?: string;
	readonly caseName?: string;
	/**
	 * The child cases the submission created, in the order it created
	 * them, each with its case type. The order is the one the submission
	 * mutation listed them in; the case store inserts them in that order
	 * and answers with their ids in that same order.
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
	readonly session: PreviewSearchSessionValues;
	/** The worker's usercase, which `#user/<prop>` reads. */
	readonly usercase: Readonly<Record<string, string>>;
	/** The source entry's own datums, from `sourceSessionDatums`. */
	readonly sessionDatums: ReadonlyMap<string, SessionDatumValue>;
	readonly caseData: PostSubmissionCaseData;
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

/**
 * The evaluation context of a link condition or manual datum: the entry's
 * session scope after the form has closed.
 */
export function formLinkEvalContext(
	input: FormLinkEvaluationInput,
): EvalContext {
	const closedFormRead = (what: string): never => {
		throw new Error(
			`A form link cannot read ${what}: the form has already closed when its links are checked. A link can read session values, #user properties, and case properties, not the form's answers.`,
		);
	};
	return {
		contextPath: "",
		position: 1,
		getValue: (path) => closedFormRead(`"${path}"`),
		resolveInstance: (instanceId, path) => {
			if (instanceId !== "commcaresession") return { kind: "unsupported" };
			if (path.startsWith(SESSION_DATA_PREFIX)) {
				const held = input.sessionDatums.get(
					path.slice(SESSION_DATA_PREFIX.length),
				);
				return held === undefined
					? { kind: "supported" }
					: { kind: "supported", value: held.value };
			}
			return {
				kind: "supported",
				value: sessionInstancePathValue(path, input.session),
			};
		},
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
	const printCtx = xpathPrintContext(args.input.doc);
	const print = (expression: XPathExpression): string =>
		printXPath(expression, printCtx).trim();
	const evalCtx = formLinkEvalContext(args.input);
	for (const [index, link] of args.links.entries()) {
		if (!formLinkIsConditional(link, print) || link.condition === undefined) {
			return { kind: "link", link, index };
		}
		if (toBoolean(evaluate(print(link.condition), evalCtx))) {
			return { kind: "link", link, index };
		}
	}
	return { kind: "fallback", destination: args.fallback };
}

/** The string value of a manual datum's XPath in the entry's session scope. */
export function evaluateLinkDatum(
	datum: FormLinkDatum,
	input: FormLinkEvaluationInput,
): string {
	return xpathToString(
		evaluate(
			printXPath(datum.xpath, xpathPrintContext(input.doc)),
			formLinkEvalContext(input),
		),
	);
}

/**
 * What each datum of the source form's entry holds once the submission has
 * landed, keyed by datum id. This is the ONE mapping from the wire's datum
 * vocabulary to the preview's submission result; both the automatic match
 * and a manual `instance('commcaresession')/session/data/<id>` read it.
 *
 * A datum the preview cannot value is absent from the map (its session read
 * is an absent node, its carried value blank): the worker's usercase datum,
 * the grouped-tile companion, and a subcase whose created case it cannot
 * name (see `subcaseValue`). Selected ancestors are supplied explicitly by
 * stable module UUID after Preview has resolved its menu/session context.
 */
export function sourceSessionDatums(
	doc: BlueprintDoc,
	formUuid: Uuid,
	submission: CarriedSubmission,
	selectedCases: SelectedCaseSession = new Map(),
): ReadonlyMap<string, SessionDatumValue> {
	const ctx = formLinkProjectionContext(doc);
	const moduleUuid = owningModuleOf(ctx, formUuid);
	const form = doc.forms[formUuid];
	if (moduleUuid === undefined || form === undefined) return new Map();
	const moduleCaseType = moduleCaseTypeForActions(doc, moduleUuid);
	const ownCaseDatumId = selectedCaseDatumId(doc, ctx, moduleUuid, formUuid);
	const selectionSources = new Map(
		entrySelectionDatumSources(doc, ctx, moduleUuid, formUuid).map((source) => [
			source.id,
			source,
		]),
	);
	const datums = new Map<string, SessionDatumValue>();
	const bound = (): SessionDatumValue | undefined =>
		submission.caseId === undefined
			? undefined
			: {
					value: submission.caseId,
					...(submission.caseName !== undefined && {
						caseName: submission.caseName,
					}),
				};
	let inventory: ReturnType<typeof deriveCaseWriteInventory> | undefined;
	const subcaseValue = (caseType: string): SessionDatumValue | undefined => {
		/* A subcase datum is minted for the form's ONE non-repeat child
		 * bucket of its case type (`deriveSessionDatums` skips repeat-context
		 * subcases). The submission reports its created children by case
		 * type in creation order, so when the form has no repeat bucket of
		 * that type, the one child of that type is the datum's case. With a
		 * repeat bucket of the same type the children of that type cannot be
		 * told apart, so the datum stays unvalued rather than guessed. */
		inventory ??= deriveCaseWriteInventory(
			doc,
			formUuid,
			{ caseType: moduleCaseType },
			form.type,
		);
		const ambiguous = inventory.buckets.some(
			(bucket) =>
				bucket.kind === "child" &&
				bucket.caseType === caseType &&
				bucket.repeatUuid !== undefined,
		);
		if (ambiguous) return undefined;
		const created = submission.childCases.filter(
			(child) => child.caseType === caseType,
		);
		const [child] = created;
		if (created.length !== 1 || child === undefined) return undefined;
		return {
			value: child.caseId,
			...(child.caseName !== undefined && { caseName: child.caseName }),
		};
	};
	for (const datum of entryFrameDatums(doc, ctx, moduleUuid, formUuid)) {
		const held = sourceDatumValue(datum, {
			formType: form.type,
			moduleCaseType,
			ownCaseDatumId,
			bound,
			selectedCase: (datumId, caseType) => {
				const source = selectionSources.get(datumId);
				if (source === undefined || source.caseType !== caseType)
					return undefined;
				const selected = selectedCases.get(source.moduleUuid);
				return selected?.caseType !== caseType
					? undefined
					: {
							value: selected.value,
							...(selected.caseName !== undefined && {
								caseName: selected.caseName,
							}),
						};
			},
			subcaseValue,
		});
		if (held !== undefined) datums.set(datum.id, held);
	}
	return datums;
}

function sourceDatumValue(
	datum: FrameDatum,
	source: {
		readonly formType: string;
		readonly moduleCaseType: string;
		readonly ownCaseDatumId?: string;
		readonly bound: () => SessionDatumValue | undefined;
		readonly selectedCase: (
			datumId: string,
			caseType: string,
		) => SessionDatumValue | undefined;
		readonly subcaseValue: (caseType: string) => SessionDatumValue | undefined;
	},
): SessionDatumValue | undefined {
	// The case the form loaded.
	if (datum.requiresSelection) {
		if (datum.id === source.ownCaseDatumId) return source.bound();
		return datum.caseType === undefined
			? undefined
			: source.selectedCase(datum.id, datum.caseType);
	}
	// A function datum with no case type (the grouped-tile companion) and
	// the worker's own usercase datum name nothing the submission created.
	if (datum.caseType === undefined || datum.function === undefined) {
		return undefined;
	}
	if (datum.caseType === "commcare-user") return undefined;
	// A registration's primary create datum is the case it just created; a
	// create datum of any other type is a subcase. (A self-parented type
	// could register a child of its own type too; `findBestMatch` takes the
	// first datum in source order, which is the primary, so the primary is
	// what a same-type match ever reads.)
	if (
		source.formType === "registration" &&
		datum.caseType === source.moduleCaseType
	) {
		return source.bound();
	}
	return source.subcaseValue(datum.caseType);
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
	if (link.target.type !== "form") return { kind: "none" };
	const { doc } = input;
	const ctx = formLinkProjectionContext(doc);
	const sourceModuleUuid = owningModuleOf(ctx, formUuid);
	if (sourceModuleUuid === undefined) {
		throw new Error(
			`Cannot follow a form link: the form ${formUuid} it leaves from belongs to no module`,
		);
	}
	const targetChildren = targetFrameChildren(doc, ctx, link.target);
	const targetCaseDatumId = selectedCaseDatumId(
		doc,
		ctx,
		link.target.moduleUuid,
		link.target.formUuid,
	);
	if (targetCaseDatumId === undefined) return { kind: "none" };

	if (link.datums !== undefined) {
		/* The link names the target's datums itself. A selection datum it
		 * leaves unnamed is what the validator refuses; on the wire it reads
		 * the session's own value under that name, which is blank. */
		const manual = link.datums.find(
			(datum) => datum.name === targetCaseDatumId,
		);
		return {
			kind: "carried",
			caseId: manual === undefined ? "" : evaluateLinkDatum(manual, input),
		};
	}

	const sourceDatums = entryFrameDatums(doc, ctx, sourceModuleUuid, formUuid);
	const matched = matchFrameToSource(targetChildren, sourceDatums).matched.find(
		(entry) => entry.id === targetCaseDatumId,
	);
	const held =
		matched === undefined
			? undefined
			: input.sessionDatums.get(matched.sourceId);
	return held === undefined
		? { kind: "carried", caseId: "" }
		: {
				kind: "carried",
				caseId: held.value,
				...(held.caseName !== undefined && { caseName: held.caseName }),
			};
}
