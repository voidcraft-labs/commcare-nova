/**
 * Save to Case blocks (`vellum:role="SaveToCase"`) read into case operations,
 * in the one shape Nova's emitter writes them. A block is Nova's own exactly
 * where four tests hold: it stands under Nova's wrappers alone (position);
 * its content gives one operation whose block shape has its path's segments
 * (shape); every guard beside it belongs to an operation read here (guards);
 * and the emitter, given the document, writes the same block (content,
 * `settleSaveToCase`). Every other block is one finding at its place.
 *
 * Each value is read through the wrapper the emitter writes around it, taken
 * off by syntax (`matchesTemplate` over the emitter's own builders), and what
 * is inside is registered for the expression stage once, so no text is ever
 * wrapped twice.
 */
import type { Element } from "domhandler";
import { isTag } from "domhandler";
import { caseOperationConditionalGuardUuids } from "@/lib/doc/caseOperationOrder";
import {
	AUTHORED_CASE_ID_VERSION,
	type BlueprintDoc,
	type CaseOperation,
	type CaseOperationLink,
	type CaseOperationWrite,
	caseSelectionCardinality,
	type Expression,
	isCaseOperationIdentifier,
	isCaseScalarTextProperty,
	MAX_AUTHORED_CASE_KEY_LENGTH,
	ownCaseOperationId,
	type Uuid,
} from "@/lib/domain";
import {
	actingUser,
	and,
	term,
	unowned,
} from "@/lib/domain/expression/builders";
import type { SlotContextRef } from "@/lib/domain/expression/types";
import { moduleUuidOfForm } from "@/lib/domain/postSubmit";
import type { FindingDetail, HqPlace } from "@/lib/publish/hqFindings";
import { planFormCaseWire } from "../../casePlacementPlan";
import { expandDoc } from "../../expander";
import { sessionDataRef } from "../../formLinkProjection";
import { isMultiSelectMenu } from "../../hq/publishedCaseBlocks";
import { planPlacements } from "../../placement";
import { USERCASE_ID_FUNCTION } from "../../usercaseWire";
import { DERIVED_WIRE_IDENTITY } from "../../wireIdentity";
import { captureUrlCalculate } from "../../xform/captureUrlNode";
import {
	caseScalarTextValueCalculation,
	type SaveToCaseBlockSegment,
	saveToCaseBlockShape,
} from "../../xform/caseOps";
import { caseSaveReferencesOf } from "../../xform/caseSaveReferences";
import {
	GUARD_KINDS,
	type GuardKind,
	generatedBaseName,
	operationGuardKinds,
} from "../../xform/generatedNodes";
import type { FormSyntax } from "../../xpath/formSyntax";
import { w } from "../../xpath/wire/builders";
import {
	storedClockValue,
	storedInstantValue,
	typedInstantValue,
} from "../../xpath/wire/instant";
import { caseById } from "../../xpath/wire/rowScope";
import { serializeWire } from "../../xpath/wire/serialize";
import type { WireExpr } from "../../xpath/wire/tree";
import type { ClaimSite } from "../accounting";
import { withCandidate } from "../candidate";
import { type Claim, defineClaims, derived, refuse, take } from "../claims";
import type { DraftForm, DraftModule, ReadContext } from "../context";
import { externalKey, mintEntityUuid } from "../identity";
import { externalIdentityMap } from "../identityMap";
import { isJsonObject, sameJson } from "../jsonCursor";
import { pendingPlaceholder } from "../pendingExpressions";
import { questionPlace, whereText } from "../place";
import { readProjectionInputs } from "../projectionInputs";
import { caseReferencesOf } from "../structure";
import { sameXPathText } from "../syntaxCompare";
import { readFormSyntax } from "../syntaxRead";
import type { ReadMenuAndFormIdentities } from "../types";
import type { DraftField, ReadSaveToCaseBlock, ReadXForm } from "../xform";
import { HOLE, isAllocatedName, matchesTemplate } from "../xform/generated";
import { type DataNode, pathSteps } from "../xform/model";
import {
	advancedCaseReading,
	nameAdvancedOperationsPast,
} from "./advancedActions";
import {
	basicCaseReading,
	dropCreateNameRequired,
	nameBasicOperationsPast,
} from "./basicActions";
import {
	blockTreesEqual,
	emittedFormSource,
	storedFormSource,
} from "./saveToCaseCompare";

const Q = "questions";
const F = "forms-and-case-writes";
const MUG = "mug:SaveToCase";

export const SAVE_TO_CASE_CLAIMS = defineClaims("caseManagement.saveToCase", {
	outsideShape: refuse(
		`${Q}/savetocase-block-outside-nova-s-own-block-shape`,
		MUG,
	),
	linkName: refuse(
		`${Q}/savetocase-link-name-outside-nova-s-identifier-grammar`,
		MUG,
	),
	caseTypeXPath: refuse(`${Q}/savetocase-case-type-given-as-an-xpath`, MUG),
	authoredCreateId: refuse(
		`${Q}/savetocase-create-with-an-authored-non-uuid-case-id-xpath-inside`,
		"xform:setvalue@value",
	),
	blankCreateId: refuse(
		`${Q}/savetocase-create-at-the-form-root-whose-authored-case-id-xpath`,
		"jr-action:setvalue",
	),
	ownerCondition: refuse(`${Q}/savetocase-owner-id-condition`, MUG),
	closeOnlyCondition: refuse(
		`${Q}/a-close-only-savetocase-block-with-a-close-condition`,
		MUG,
	),
	writeAndClose: refuse(
		`${Q}/a-savetocase-block-that-creates-or-updates-and-also-closes-under`,
		MUG,
	),
	blockRelevance: refuse(
		`${Q}/relevance-bound-on-the-savetocase-node-itself`,
		"xform:model/bind@relevant",
	),
	leafConstraint: refuse(
		`${Q}/constraint-on-savetocase-case-leaves`,
		"xform:model/bind@constraint",
	),
	leafType: refuse(
		`${Q}/type-on-a-savetocase-property-leaf-a-create-update-or-index`,
		"jr-type:string",
	),
	attachment: refuse(
		`${Q}/attachment-inside-a-savetocase-block`,
		"xform:model/instance//*",
	),
	reservedType: refuse(
		`${Q}/savetocase-create-close-or-link-of-commcare-user-or-type-user`,
		"vellum-markup:model/instance//*@vellum:case_type",
	),

	create: take(
		`${Q}/savetocase-create-case-type-literal-case-name-owner-id-uuid-case`,
		MUG,
	),
	createBind: derived(
		`${Q}/savetocase-create-case-type-literal-case-name-owner-id-uuid-case`,
		"xform:model/bind@calculate",
	),
	createSetvalue: derived(
		`${Q}/savetocase-create-case-type-literal-case-name-owner-id-uuid-case`,
		"xform:setvalue",
	),
	update: take(`${Q}/savetocase-update-case-id-xpath`, MUG),
	updateBind: derived(
		`${Q}/savetocase-update-case-id-xpath`,
		"xform:model/bind@calculate",
	),
	rows: derived(
		`${Q}/savetocase-property-rows-calculation-condition-lifting-into`,
		MUG,
	),
	hyphenated: take(
		`${Q}/savetocase-property-names-with-hyphens-a-z-w-case-insensitive`,
		MUG,
	),
	owner: derived(`${Q}/savetocase-owner`, MUG),
	link: derived(
		`${Q}/savetocase-link-index-name-child-extension-and-unlink-empty`,
		MUG,
	),
	inRepeat: take(`${Q}/savetocase-inside-a-repeat`, MUG),
	conditionGroup: derived(
		`${Q}/savetocase-inside-a-group-whose-display-condition-gates-it`,
		MUG,
	),

	saveEqual: take(
		`${F}/case-references-data-save-equal-to-vellum-s-computation-from-the`,
		"schema:CaseReferences.save",
	),
	saveDiffering: refuse(
		`${F}/case-references-data-save-differing-from-that-computation`,
		"schema:CaseReferences.save",
	),
});

/** The register row a date and time saved in the spelling Nova wrote before falls under. */
const DATETIME_REGISTER = "date-and-time-saved-as-hq-stores-it";

// ── Paths ───────────────────────────────────────────────────────────────

/** A path read from `context`, a node path with an optional final `@name`. */
function resolvePath(
	node: FormSyntax,
	context: readonly string[],
	root: string,
): string[] | undefined {
	const steps: string[] = [];
	let start: "root" | "current" | undefined;
	const walk = (at: FormSyntax): boolean => {
		switch (at.kind) {
			case "group":
				return walk(at.value);
			case "child":
				if (at.descendant) return false;
				if (at.left === undefined) start = "root";
				else if (!walk(at.left)) return false;
				return walk(at.step);
			case "call":
				if (at.name !== "current" || at.args.length > 0 || start !== undefined)
					return false;
				start = "current";
				return true;
			case "name":
				if (at.wildcard) return false;
				steps.push(at.name);
				return true;
			case "self":
				steps.push(".");
				return true;
			case "parent":
				steps.push("..");
				return true;
			case "axis":
				if (at.axis !== "attribute" || at.value.kind !== "name") return false;
				steps.push(`@${at.value.name}`);
				return true;
			default:
				return false;
		}
	};
	if (!walk(node) || start === undefined) return undefined;
	let at: string[];
	let rest = steps;
	if (start === "root") {
		if (steps[0] !== root) return undefined;
		at = [];
		rest = steps.slice(1);
	} else at = [...context];
	for (const step of rest) {
		if (step === ".") continue;
		if (step === "..") {
			if (at.length === 0) return undefined;
			at.pop();
			continue;
		}
		at.push(step);
	}
	return at;
}

function parse(text: string | undefined): FormSyntax | undefined {
	if (text === undefined) return undefined;
	const read = readFormSyntax(text);
	return read.ok ? read.node : undefined;
}

/** A tree of one string literal, read as its value. */
function literalOf(text: string | undefined): string | undefined {
	let node = parse(text);
	while (node?.kind === "group") node = node.value;
	return node?.kind === "string" ? node.value : undefined;
}

function isCall(text: string | undefined, name: string): boolean {
	let node = parse(text);
	while (node?.kind === "group") node = node.value;
	return node?.kind === "call" && node.name === name && node.args.length === 0;
}

/** What `template`'s hole holds in `text`, as the source's own text. */
function inside(text: string, template: WireExpr): string | undefined {
	const hole = matchesTemplate(text, template, HOLE);
	return hole === undefined ? undefined : text.slice(hole.from, hole.to);
}

const holeWire = (): WireExpr => w.context([w.step(HOLE)]);

/** `text` with the emitter's trim taken off, or itself. */
function untrimmed(text: string): {
	readonly text: string;
	readonly trimmed: boolean;
} {
	const inner = inside(text, caseScalarTextValueCalculation(holeWire()));
	return inner === undefined
		? { text, trimmed: false }
		: { text: inner, trimmed: true };
}

// ── What pass 1 proposes ────────────────────────────────────────────────

/** A text registered for the expression stage, with the slot it fills. */
interface Registered {
	readonly index: number;
}

type ProposedOwner =
	| { readonly kind: "meta-user" }
	| { readonly kind: "unowned" }
	| { readonly kind: "text"; readonly text: string; readonly site: ClaimSite };

type ProposedTarget =
	| {
			readonly kind: "new";
			readonly idFrom?: DraftField;
			/** The prefix a keyed create's id stands under in the source. */
			readonly idPrefix?: string;
	  }
	| { readonly kind: "op"; readonly path: string }
	| { readonly kind: "worker-record" }
	/** Every other id: the session's case, or the id a create of the form's
	 *  Case Management has from its entry, by its source `text`. */
	| { readonly kind: "session"; readonly text: string }
	| {
			readonly kind: "expression";
			readonly text: string;
			readonly site: ClaimSite;
	  };

interface ProposedRow {
	readonly property: string;
	readonly value:
		| {
				readonly kind: "text";
				readonly text: string;
				readonly site: ClaimSite;
				/** The question whose answer the text is, read as a path alone
				 *  (the catalog's choices follow it). */
				readonly readsField?: DraftField;
		  }
		| { readonly kind: "capture"; readonly field: DraftField }
		/** A question's answer as it is, in a child's block the emitter
		 *  writes from the question paths of HQ's child case action: the
		 *  question's own term, which no expression reading binds. */
		| {
				readonly kind: "answer";
				readonly field: DraftField;
				readonly site: ClaimSite;
		  };
	readonly condition?: { readonly text: string; readonly site: ClaimSite };
	/**
	 * A row of a block of the session's case that saves an answer as it is: the
	 * emitter writes the form's own arm there with the presence conjunct
	 * `count(A) > 0` ahead of the row's condition, and any other update with
	 * the row's condition alone. `led` says whether the stored condition leads
	 * with that conjunct, and `rest` is what follows it.
	 */
	readonly answerAsIs?: {
		readonly led: boolean;
		readonly rest?: { readonly text: string; readonly site: ClaimSite };
	};
}

interface ProposedLink {
	readonly identifier: string;
	readonly targetType: string;
	readonly relationship: "child" | "extension";
	readonly target:
		| null
		| { readonly kind: "op"; readonly path: string }
		| { readonly kind: "session"; readonly text: string }
		| {
				readonly kind: "expression";
				readonly text: string;
				readonly site: ClaimSite;
		  };
}

export interface ProposedBlock {
	readonly uuid: Uuid;
	readonly id: string;
	readonly action: "own" | "create" | "update" | "close";
	readonly caseType: string;
	readonly block: ReadSaveToCaseBlock;
	/** The segments its path's wrappers say, then `block`. */
	readonly segments: readonly SaveToCaseBlockSegment[];
	readonly target: ProposedTarget;
	readonly name?: {
		readonly text: string;
		readonly site: ClaimSite;
		/** The question whose answer the name is, where the block reads the
		 *  question's trimmed value the way a child's block written from HQ's
		 *  child case action does: its term, which no expression reading binds. */
		readonly answer?: DraftField;
		/** The question whose answer the name is, read as a path alone. */
		readonly readsField?: DraftField;
	};
	readonly owner?: ProposedOwner;
	readonly rename?: {
		readonly text: string;
		readonly site: ClaimSite;
		/** The question whose answer the own arm's name is, where its row
		 *  reads the question's trimmed value: its term, which no expression
		 *  reading binds. */
		readonly answer?: DraftField;
	};
	readonly retype?: string;
	readonly writes: readonly ProposedRow[];
	readonly links: readonly ProposedLink[];
	readonly condition?: { readonly text: string; readonly site: ClaimSite };
	/** A close in the block: an operation's own close, or the own close's condition. */
	readonly closes: boolean;
	readonly closeCondition?: { readonly text: string; readonly site: ClaimSite };
	readonly place: HqPlace;
	/**
	 * The block read as a several-case form's shared update of every selected
	 * case, where it stands in that shape and prints as it: each row present
	 * only while its value is (`count(S) > 0 and string(S) != ''` for a
	 * question's answer as it is, else `string(S) != ''`), its group present
	 * while some row is, or always where the block links. By property, each
	 * row's condition after that presence and the generated sibling its value
	 * reads; the name's and the owner's rows have no condition of their own.
	 */
	readonly shared?: ReadonlyMap<string, SharedRow>;
}

/** One row of a block read as a several-case form's shared update. */
interface SharedRow {
	readonly rest?: { readonly text: string; readonly site: ClaimSite };
	readonly sibling?: GeneratedSibling;
}

interface FormBlocks {
	readonly proposals: ProposedBlock[];
	/** Every block that failed a test of pass 1, with the place its finding stands at. */
	readonly failed: {
		readonly block: ReadSaveToCaseBlock;
		readonly place: HqPlace;
		readonly claim: Claim<"refuse">;
		readonly detail?: FindingDetail;
	}[];
	/** Each registration index by the operation and member it fills. */
	readonly registrations: Map<string, Registered>;
	/** The own close read from a block of its own, which test 4 holds to the
	 *  emitter's print of it. */
	ownClose?: {
		readonly path: readonly [string, ...string[]];
		readonly condition?: { readonly text: string; readonly site: ClaimSite };
		readonly block: ReadSaveToCaseBlock;
		readonly segments: readonly SaveToCaseBlockSegment[];
		readonly place: HqPlace;
	};
}

/** The shapes of a form's own close block of its own
 *  (`caseOps.ts::saveToCaseBlockShape`): in a condition group of the root
 *  operations container, or, in a form whose menu selects several cases, in
 *  each selected case's row, in a condition group where the form closes
 *  under a condition. */
const OWN_CLOSE_SHAPES = {
	oneCase: new Set(["operations/condition/block"]),
	severalCases: new Set([
		"selected-cases/selected-case/operations/block",
		"selected-cases/selected-case/operations/condition/block",
	]),
} as const;

const READINGS = new WeakMap<DraftForm, FormBlocks>();

/** What pass 1 read of a form's Save to Case blocks. */
export function saveToCaseReading(form: DraftForm): FormBlocks | undefined {
	return READINGS.get(form);
}

const CONTAINER_SEGMENT: Readonly<Record<string, SaveToCaseBlockSegment>> = {
	operations: "operations",
	// The group a published placement keeps a child's block in, which the
	// emitter writes where an operations group would stand (`caseOps.ts`,
	// `keptInSubcases`), under the placement's own path.
	subcases: "operations",
	condition: "condition",
	keyed: "keyed",
	"selected-cases": "selected-cases",
	"selected-case": "selected-case",
};

const SEGMENT_ORDER: readonly SaveToCaseBlockSegment[] = [
	"selected-cases",
	"selected-case",
	"operations",
	"keyed",
	"condition",
	"block",
];

function children(element: Element): Element[] {
	return element.children.filter(isTag);
}

function localName(element: Element): string {
	const colon = element.name.indexOf(":");
	return colon < 0 ? element.name : element.name.slice(colon + 1);
}

/** The scope a block stands in: the form root, or its repeat's node or row. */
function scopeOk(xform: ReadXForm, block: ReadSaveToCaseBlock): boolean {
	const first = block.wrappers[0];
	if (first === undefined) return false;
	const parent = first.parent;
	if (parent === null) return block.repeat === null;
	const role = xform.roles.get(parent);
	if (role?.kind === "query-row") return role.repeat === block.repeat;
	return (
		role?.kind === "field" &&
		role.field.kind === "repeat" &&
		role.field === block.repeat
	);
}

/** Each bind of a form with the steps of its path, read once per form, since every block of the
 *  form looks among the same binds. */
const BIND_STEPS = new WeakMap<
	readonly Element[],
	readonly {
		readonly element: Element;
		readonly steps: readonly string[] | undefined;
	}[]
>();

/** The binds of `form` on paths under `prefix`, by path relative to it. */
function bindsUnder(
	xform: ReadXForm,
	prefix: readonly string[],
): Map<string, Element> {
	const root = xform.parsed.dataRoot.name;
	const binds = xform.parsed.binds;
	let read = BIND_STEPS.get(binds);
	if (read === undefined) {
		read = binds.map((element) => ({
			element,
			steps: pathSteps(element.attribs.nodeset ?? element.attribs.ref ?? ""),
		}));
		BIND_STEPS.set(binds, read);
	}
	const out = new Map<string, Element>();
	for (const { element, steps } of read) {
		if (steps === undefined || steps[0] !== "/" || steps[1] !== root) continue;
		const path = steps.slice(2);
		if (
			path.length < prefix.length ||
			!prefix.every((step, i) => path[i] === step)
		)
			continue;
		const key = path.slice(prefix.length).join("/");
		if (!out.has(key)) out.set(key, element);
	}
	return out;
}

function setvaluesUnder(
	xform: ReadXForm,
	prefix: readonly string[],
): Element[] {
	return xform.setvalues
		.filter(
			(one) =>
				one.target !== undefined &&
				one.target.length >= prefix.length &&
				prefix.every((step, i) => one.target?.[i] === step),
		)
		.map((one) => one.element);
}

// ── Pass 1 ─────────────────────────────────────────────────────────────

interface BlockRead {
	readonly ok: boolean;
	/** The entry a failing block is, where the manifest names its class; else 5.1's. */
	readonly claim?: Claim<"refuse">;
	readonly detail?: FindingDetail;
	readonly proposal?: Omit<ProposedBlock, "uuid" | "id" | "action"> & {
		readonly kind: "create" | "update" | "close";
	};
}

/** The questions a block's form reads, by data path, for capture links and keys. */
function fieldAt(
	xform: ReadXForm,
	path: readonly string[],
): DraftField | undefined {
	const node = xform.nodes.get(path.join("/"));
	const role = node === undefined ? undefined : xform.roles.get(node);
	return role?.kind === "field" ? role.field : undefined;
}

/**
 * The question whose trimmed value `text` reads, where it is a path alone to
 * the node the emitter writes beside a question for a case name
 * (`nova_trimmed_<question>`), the node then settled as generated; else
 * nothing, and the node left to the first pass.
 */
function trimmedValueOf(
	ctx: ReadContext,
	xform: ReadXForm,
	text: string,
	context: readonly string[],
): DraftField | undefined {
	const sibling = generatedSiblingOf(xform, text, context);
	if (sibling?.purpose !== "trimmed") return undefined;
	settleSibling(ctx, xform, sibling);
	return sibling.field;
}

/** A node the emitter writes beside a question for a case write: its link
 *  to a capture, its date and time as text, or its trimmed value. */
interface GeneratedSibling {
	readonly node: DataNode;
	readonly purpose: "url" | "datetime" | "trimmed";
	/** The question it belongs to. */
	readonly field: DraftField;
}

/** The sibling `text` reads, where it is a path alone to one; else nothing. */
function generatedSiblingOf(
	xform: ReadXForm,
	text: string,
	context: readonly string[],
): GeneratedSibling | undefined {
	const node = parse(text);
	const path =
		node === undefined
			? undefined
			: resolvePath(node, context, xform.parsed.dataRoot.name);
	const target =
		path === undefined ? undefined : xform.nodes.get(path.join("/"));
	const role = target === undefined ? undefined : xform.roles.get(target);
	if (
		target === undefined ||
		(role?.kind !== "generated" && role?.kind !== "generated-candidate") ||
		(role.purpose !== "url" &&
			role.purpose !== "datetime" &&
			role.purpose !== "trimmed") ||
		role.owner === null
	)
		return undefined;
	const ownerRole = xform.roles.get(role.owner);
	if (ownerRole?.kind !== "field") return undefined;
	return { node: target, purpose: role.purpose, field: ownerRole.field };
}

/** Settles a sibling a block reads as generated, where it is a candidate. */
function settleSibling(
	ctx: ReadContext,
	xform: ReadXForm,
	sibling: GeneratedSibling,
): void {
	const role = xform.roles.get(sibling.node);
	if (
		role?.kind === "generated-candidate" &&
		xform.candidates.includes(sibling.node)
	)
		ctx.writeDraft(() => xform.settle(sibling.node, "generated"));
}

/**
 * The value of a row, its wrappers taken off: a capture's link over the
 * capture it reads; else the text inside the date-and-time spelling of each
 * leaf (a clock read put back from its `nova_instant_` node), inside the
 * trim. `earlier` where the whole value is the spelling Nova wrote before.
 */
function rowValue(
	ctx: ReadContext,
	xform: ReadXForm,
	text: string,
	rowPath: readonly string[],
	blockName: string,
): {
	readonly value: ProposedRow["value"] | undefined;
	readonly text: string;
	readonly earlier: boolean;
} {
	const root = xform.parsed.dataRoot.name;
	const capture = inside(
		text,
		captureUrlCalculate(holeWire(), {
			origin: ctx.input.target.origin,
			domain: ctx.input.target.domain,
		}),
	);
	if (capture !== undefined) {
		const node = parse(capture);
		const path =
			node === undefined ? undefined : resolvePath(node, rowPath, root);
		const field = path === undefined ? undefined : fieldAt(xform, path);
		if (field !== undefined)
			return { value: { kind: "capture", field }, text, earlier: false };
	}
	const earlier = inside(text, typedInstantValue(holeWire()));
	if (earlier !== undefined)
		return { value: undefined, text: earlier, earlier: true };
	return {
		value: undefined,
		text: leafValues(xform, text, rowPath, blockName),
		earlier: false,
	};
}

/** `text` with each leaf's stored date-and-time spelling taken off and each
 *  clock node's read replaced by the leaf its calculate holds. A clock node
 *  is one the allocator names for the block's operation
 *  (`generatedBaseName("instant", <the block's name>, n)`); test 4 holds it
 *  to the emitter's. */
function leafValues(
	xform: ReadXForm,
	text: string,
	rowPath: readonly string[],
	blockName: string,
): string {
	const tree = parse(text);
	if (tree === undefined) return text;
	const root = xform.parsed.dataRoot.name;
	const replacements: { from: number; to: number; text: string }[] = [];
	const isClockNode = (name: string): boolean => {
		for (let n = 1; n <= xform.caseRegion.length; n += 1)
			if (
				isAllocatedName(
					name,
					generatedBaseName("instant", blockName, String(n)),
				)
			)
				return true;
		return false;
	};
	/** The leaf a `nova_instant_` node's calculate holds, where `read` is a read of one. */
	const clockLeaf = (read: FormSyntax | undefined): string | undefined => {
		if (read === undefined) return undefined;
		const path = resolvePath(read, rowPath, root);
		const target =
			path === undefined ? undefined : xform.nodes.get(path.join("/"));
		if (target === undefined || !isClockNode(target.name)) return undefined;
		const calculate = xform.binds.get(target)?.logic.calculate;
		return calculate === undefined
			? undefined
			: inside(calculate, typedInstantValue(holeWire()));
	};
	const visit = (node: FormSyntax): void => {
		const own = text.slice(node.from, node.to);
		const stored = inside(own, storedInstantValue(holeWire()));
		if (stored !== undefined && own !== stored) {
			// The typed leaf inside may itself be a clock node's read.
			replacements.push({
				from: node.from,
				to: node.to,
				text: `(${leafValues(xform, stored, rowPath, blockName)})`,
			});
			return;
		}
		// A clock read: the stored text of a `nova_instant_` node, or the node read alone.
		const clockRead = inside(own, storedClockValue(holeWire()));
		const leaf = clockLeaf(clockRead === undefined ? node : parse(clockRead));
		if (leaf !== undefined) {
			replacements.push({ from: node.from, to: node.to, text: `(${leaf})` });
			return;
		}
		for (const child of syntaxChildren(node)) visit(child);
	};
	visit(tree);
	if (replacements.length === 0) return text;
	let out = "";
	let at = 0;
	for (const one of replacements.sort((a, b) => a.from - b.from)) {
		out += text.slice(at, one.from) + one.text;
		at = one.to;
	}
	return out + text.slice(at);
}

function syntaxChildren(node: FormSyntax): FormSyntax[] {
	switch (node.kind) {
		case "group":
		case "negative":
		case "axis":
			return [node.value];
		case "child":
			return node.left === undefined ? [node.step] : [node.left, node.step];
		case "filter":
			return [node.base, node.where];
		case "binary":
			return [node.left, node.right];
		case "call":
			return [...node.args];
		default:
			return [];
	}
}

/** The conjuncts of an `and` chain, left to right, each with the brackets
 *  around it, so its span is a whole expression. */
function conjuncts(node: FormSyntax): FormSyntax[] {
	let at = node;
	while (at.kind === "group") at = at.value;
	return at.kind === "binary" && at.op === "and"
		? [...conjuncts(at.left), ...conjuncts(at.right)]
		: [node];
}

/** The conjuncts `parts` of `text` joined again by `and`: each is a whole
 *  expression with its own brackets, and an operand of `and`, so the join
 *  states their conjunction. */
function conjunction(text: string, parts: readonly FormSyntax[]): string {
	return parts.map((part) => text.slice(part.from, part.to)).join(" and ");
}

/** The operands of an `or` chain, left to right, as `conjuncts` gives an
 *  `and` chain's. */
function disjuncts(node: FormSyntax): FormSyntax[] {
	let at = node;
	while (at.kind === "group") at = at.value;
	return at.kind === "binary" && at.op === "or"
		? [...disjuncts(at.left), ...disjuncts(at.right)]
		: [node];
}

/** The segments of a several-case form's shared update of every selected
 *  case (`basicCaseSlots.ts::ownOrCreateBlockShape` for the own arm). */
const SHARED_UPDATE_SEGMENTS: readonly SaveToCaseBlockSegment[] = [
	"selected-cases",
	"selected-case",
	"operations",
	"condition",
	"block",
];

/**
 * A shared update row's relevance split at the presence the emitter leads
 * it with (`caseOps.ts`, the several-case form's own case): `count(S) > 0
 * and string(S) != ''` where the row saves a question's answer as it is,
 * else `string(S) != ''`, `S` the row's value; then the row's own condition.
 * Nothing where it does not lead so.
 */
function presenceSplit(
	relevant: string | undefined,
	value: string,
): { readonly presence: string; readonly rest?: string } | undefined {
	const tree = parse(relevant);
	if (relevant === undefined || tree === undefined) return undefined;
	const parts = conjuncts(tree);
	const holds = (part: FormSyntax | undefined, template: WireExpr): boolean => {
		if (part === undefined) return false;
		const hole = inside(relevant.slice(part.from, part.to), template);
		return (
			hole !== undefined && sameXPathText(hole, value, { ruleSet: "form" })
		);
	};
	const present = w.gt(w.call("count", [holeWire()]), w.num(0));
	const filled = w.ne(w.call("string", [holeWire()]), w.str(""));
	const lead =
		holds(parts[0], present) && holds(parts[1], filled)
			? 2
			: holds(parts[0], filled)
				? 1
				: 0;
	if (lead === 0) return undefined;
	const rest = parts.slice(lead);
	return {
		presence: conjunction(relevant, parts.slice(0, lead)),
		...(rest.length > 0 && { rest: conjunction(relevant, rest) }),
	};
}

/** A row's condition, its presence conjunct `count(A) > 0` taken off where
 *  the row saves the answer `A` as it is. */
function rowCondition(
	relevant: string | undefined,
	value: string,
	presenceApplies: boolean,
): string | undefined {
	if (relevant === undefined) return undefined;
	if (!presenceApplies) return relevant;
	const tree = parse(relevant);
	if (tree === undefined) return relevant;
	const parts = conjuncts(tree);
	const first = parts[0];
	if (first === undefined) return relevant;
	const presence = inside(
		relevant.slice(first.from, first.to),
		w.gt(w.call("count", [holeWire()]), w.num(0)),
	);
	if (
		presence === undefined ||
		!sameXPathText(presence, value, { ruleSet: "form" })
	)
		return relevant;
	const rest = parts.slice(1);
	if (rest.length === 0) return undefined;
	return conjunction(relevant, rest);
}

/** Reads one block's content into its proposal, or the finding it is. */
function readBlock(
	ctx: ReadContext,
	form: DraftForm,
	xform: ReadXForm,
	block: ReadSaveToCaseBlock,
	place: HqPlace,
	earlierCreates: ReadonlyMap<string, true>,
): BlockRead {
	const root = xform.parsed.dataRoot.name;
	const fail = (claim: Claim<"refuse">, detail?: FindingDetail): BlockRead => ({
		ok: false,
		claim,
		...(detail !== undefined && { detail }),
	});
	const caseElement = children(block.element).find(
		(child) => localName(child) === "case",
	);
	if (caseElement === undefined) return { ok: false };
	const caseType = block.element.attribs["vellum:case_type"];
	if (caseType === undefined || caseType === "") return { ok: false };
	const parts = new Map(
		children(caseElement).map((child) => [localName(child), child]),
	);
	// The worker's record is a case a block only updates: a create, a close or
	// a link of it, and any block of HQ's owner mapping, is the reserved entry.
	if (
		caseType === "user-owner-mapping-case" ||
		(caseType === "commcare-user" &&
			(parts.has("create") || parts.has("close") || parts.has("index")))
	)
		return fail(SAVE_TO_CASE_CLAIMS.reservedType, { name: caseType });
	const binds = bindsUnder(xform, block.path);
	const bindAt = (key: string) => binds.get(key);
	const calc = (key: string) => bindAt(key)?.attribs.calculate;
	// A bind on the block's own node, and a constraint or a type on a leaf.
	if (bindAt("")?.attribs.relevant !== undefined)
		return fail(SAVE_TO_CASE_CLAIMS.blockRelevance);
	for (const [key, bind] of binds) {
		if (key.includes("@")) continue;
		if (bind.attribs.constraint !== undefined)
			return fail(SAVE_TO_CASE_CLAIMS.leafConstraint);
		if (key !== "" && key !== "case" && bind.attribs.type !== undefined)
			return fail(SAVE_TO_CASE_CLAIMS.leafType);
	}
	if (parts.has("attachment")) return fail(SAVE_TO_CASE_CLAIMS.attachment);
	for (const name of parts.keys())
		if (!["create", "update", "close", "index"].includes(name))
			return { ok: false };
	const site = (key: string, attribute: string): ClaimSite => {
		const element = bindAt(key) as Element;
		return { element, attribute };
	};
	const casePath = [...block.path, "case"];
	const idPath = [...casePath, "@case_id"];
	const creates = parts.has("create");
	const segments: SaveToCaseBlockSegment[] = [];
	for (const wrapper of block.wrappers) {
		const role = xform.roles.get(wrapper);
		const container = role?.kind === "case-region" ? role.container : undefined;
		const segment =
			container === undefined ? undefined : CONTAINER_SEGMENT[container];
		if (segment === undefined) return { ok: false };
		segments.push(segment);
	}
	segments.push("block");
	let last = -1;
	for (const segment of segments) {
		const at = SEGMENT_ORDER.indexOf(segment);
		if (at <= last) return { ok: false };
		last = at;
	}
	const keyed = segments.includes("keyed");
	if (keyed && !creates) return { ok: false };
	const conditionWrapper = block.wrappers.find((wrapper) => {
		const role = xform.roles.get(wrapper);
		return role?.kind === "case-region" && role.container === "condition";
	});

	// The target.
	let target: ProposedTarget;
	if (creates) {
		const createType = literalOf(calc("case/create/case_type"));
		if (createType === undefined)
			return fail(SAVE_TO_CASE_CLAIMS.caseTypeXPath);
		if (createType !== caseType) return { ok: false };
		const rootSetvalue = xform.setvalues.find(
			(one) =>
				one.event === "xforms-ready" &&
				one.target?.join("/") === idPath.join("/"),
		);
		const idCalculate = calc("case/@case_id");
		// A keyed create holds its id as a bind: in a one-row repeat of its
		// own at the form root, directly in a repeat's row.
		const keyedId =
			rootSetvalue === undefined ? keyedKey(idCalculate) : undefined;
		if (keyed || keyedId !== undefined) {
			const node = keyedId === undefined ? undefined : parse(keyedId.key);
			const path =
				node === undefined ? undefined : resolvePath(node, idPath, root);
			const field = path === undefined ? undefined : fieldAt(xform, path);
			if (field === undefined || keyedId === undefined)
				return fail(SAVE_TO_CASE_CLAIMS.authoredCreateId);
			target = { kind: "new", idFrom: field, idPrefix: keyedId.prefix };
		} else if (rootSetvalue !== undefined) {
			if (!isCall(rootSetvalue.value, "uuid"))
				return fail(
					blankOnOpening(xform, rootSetvalue, idPath)
						? SAVE_TO_CASE_CLAIMS.blankCreateId
						: SAVE_TO_CASE_CLAIMS.authoredCreateId,
				);
			target = { kind: "new" };
		} else if (idCalculate !== undefined && isCall(idCalculate, "uuid"))
			target = { kind: "new" };
		else return fail(SAVE_TO_CASE_CLAIMS.authoredCreateId);
	} else {
		const idText = calc("case/@case_id");
		if (idText === undefined) return { ok: false };
		target = readTarget(
			xform,
			idText,
			idPath,
			caseType,
			earlierCreates,
			site("case/@case_id", "calculate"),
		);
		// The worker's record is read only where an update of `commcare-user` names it.
		if ((target.kind === "worker-record") !== (caseType === "commcare-user"))
			return { ok: false };
	}

	// The name and the owner of a create.
	let name: ProposedBlock["name"];
	let owner: ProposedOwner | undefined;
	if (creates) {
		const nameText = calc("case/create/case_name");
		if (nameText === undefined) return { ok: false };
		const unwrapped = untrimmed(nameText);
		const trimmed = unwrapped.trimmed
			? undefined
			: trimmedValueOf(ctx, xform, nameText, [
					...casePath,
					"create",
					"case_name",
				]);
		const nameNode = parse(unwrapped.text);
		const namePath =
			nameNode === undefined
				? undefined
				: resolvePath(nameNode, [...casePath, "create", "case_name"], root);
		const nameField =
			namePath === undefined ? undefined : fieldAt(xform, namePath);
		name = {
			text: unwrapped.text,
			site: site("case/create/case_name", "calculate"),
			...(trimmed !== undefined && { answer: trimmed }),
			...(nameField !== undefined && { readsField: nameField }),
		};
		const ownerBind = bindAt("case/create/owner_id");
		if (ownerBind?.attribs.relevant !== undefined)
			return fail(SAVE_TO_CASE_CLAIMS.ownerCondition);
		const ownerText = ownerBind?.attribs.calculate;
		if (ownerText === undefined) return { ok: false };
		owner = readOwner(
			untrimmed(ownerText).text,
			root,
			site("case/create/owner_id", "calculate"),
		);
	}

	// The update rows.
	let rename: ProposedBlock["rename"];
	let retype: string | undefined;
	const writes: ProposedRow[] = [];
	const update = parts.get("update");
	// The worker's record always takes the presence conjunct; the session's
	// case takes it only as the form's own arm, which is decided once every
	// block is read, so its rows keep both readings.
	const presenceApplies = !creates && target.kind === "worker-record";
	const presenceMayApply = !creates && target.kind === "session";
	// The shape a several-case form's shared update of every selected case
	// stands in; whether the block is that update is decided once every
	// block is read, so its rows keep both readings.
	const sharedShape =
		!creates &&
		target.kind === "session" &&
		segments.join("/") === SHARED_UPDATE_SEGMENTS.join("/");
	let sharedHolds = sharedShape;
	const sharedRows = new Map<string, SharedRow>();
	const presences: string[] = [];
	let ownerLed = false;
	if (update !== undefined) {
		const rows = children(update);
		for (const row of rows) {
			const property = row.name;
			const key = `case/update/${property}`;
			const bind = bindAt(key);
			const text = bind?.attribs.calculate;
			if (bind === undefined || text === undefined) return { ok: false };
			if (property === "case_type") {
				const literal = literalOf(text);
				if (literal === undefined)
					return fail(SAVE_TO_CASE_CLAIMS.caseTypeXPath);
				if (literal !== caseType) retype = literal;
				else if (rows.length > 1) retype = literal;
				continue;
			}
			const rowPath = [...casePath, "update", property];
			if (sharedShape) {
				const split = presenceSplit(bind.attribs.relevant, text);
				// The name's and the owner's rows carry their presence alone.
				if (
					split === undefined ||
					(split.rest !== undefined &&
						(property === "case_name" || property === "owner_id"))
				)
					sharedHolds = false;
				else {
					presences.push(split.presence);
					const sibling = generatedSiblingOf(xform, text, rowPath);
					sharedRows.set(property, {
						...(split.rest !== undefined && {
							rest: {
								text: split.rest,
								site: { element: bind, attribute: "relevant" },
							},
						}),
						...(sibling !== undefined && { sibling }),
					});
				}
			}
			if (property === "case_name") {
				rename = {
					text: untrimmed(text).text,
					site: { element: bind, attribute: "calculate" },
				};
				continue;
			}
			if (property === "owner_id") {
				if (bind.attribs.relevant !== undefined) {
					if (!sharedShape) return fail(SAVE_TO_CASE_CLAIMS.ownerCondition);
					ownerLed = true;
				}
				owner = readOwner(untrimmed(text).text, root, {
					element: bind,
					attribute: "calculate",
				});
				continue;
			}
			const value = rowValue(
				ctx,
				xform,
				property === "external_id" ? untrimmed(text).text : text,
				rowPath,
				block.path[block.path.length - 1] as string,
			);
			if (value.earlier) {
				const readId =
					ctx.input.source.modules[form.menu]?.forms[form.index]?.readUniqueId;
				ctx.facts.sameStateRewrites.push({
					entry: SAVE_TO_CASE_CLAIMS.rows.entry,
					path: `/_attachments/${readId ?? form.xmlns}.xml`,
					register: DATETIME_REGISTER,
				});
			}
			const condition = rowCondition(
				bind.attribs.relevant,
				value.text,
				presenceApplies && value.value === undefined,
			);
			const valueNode = parse(value.text);
			const valuePath =
				valueNode === undefined
					? undefined
					: resolvePath(valueNode, [...casePath, "update", property], root);
			const readsField =
				valuePath === undefined ? undefined : fieldAt(xform, valuePath);
			let answerAsIs: ProposedRow["answerAsIs"];
			if (
				presenceMayApply &&
				value.value === undefined &&
				readsField !== undefined
			) {
				const rest = rowCondition(bind.attribs.relevant, value.text, true);
				const led =
					bind.attribs.relevant !== undefined && rest !== bind.attribs.relevant;
				answerAsIs = {
					led,
					...(led &&
						rest !== undefined && {
							rest: {
								text: rest,
								site: { element: bind, attribute: "relevant" },
							},
						}),
				};
			}
			// A child's block written from HQ's child case action: each row a
			// question's answer, saved while the question is answered.
			if (name?.answer !== undefined && value.value === undefined) {
				const presence =
					readsField === undefined
						? undefined
						: rowCondition(bind.attribs.relevant, value.text, true);
				if (
					readsField !== undefined &&
					bind.attribs.relevant !== undefined &&
					presence === undefined
				) {
					writes.push({
						property,
						value: {
							kind: "answer",
							field: readsField,
							site: { element: bind, attribute: "calculate" },
						},
					});
					continue;
				}
			}
			writes.push({
				property,
				value: value.value ?? {
					kind: "text",
					text: value.text,
					site: { element: bind, attribute: "calculate" },
					...(readsField !== undefined && { readsField }),
				},
				...(condition !== undefined && {
					condition: {
						text: condition,
						site: { element: bind, attribute: "relevant" },
					},
				}),
				...(answerAsIs !== undefined && { answerAsIs }),
			});
		}
	}

	// The links.
	const links: ProposedLink[] = [];
	const index = parts.get("index");
	if (index !== undefined)
		for (const link of children(index)) {
			const identifier = link.name;
			if (!isCaseOperationIdentifier(identifier))
				return fail(SAVE_TO_CASE_CLAIMS.linkName, { name: identifier });
			const targetType = link.attribs.case_type;
			const relationship = link.attribs.relationship;
			if (
				targetType === undefined ||
				(relationship !== "child" && relationship !== "extension")
			)
				return { ok: false };
			if (targetType === "commcare-user")
				return fail(SAVE_TO_CASE_CLAIMS.reservedType, { name: targetType });
			const key = `case/index/${identifier}`;
			const text = calc(key);
			const linkPath = [...casePath, "index", identifier];
			let linkTarget: ProposedLink["target"] = null;
			if (text !== undefined && literalOf(text) !== "") {
				const read = readTarget(
					xform,
					text,
					linkPath,
					targetType,
					earlierCreates,
					site(key, "calculate"),
				);
				if (read.kind === "worker-record" || read.kind === "new")
					return { ok: false };
				linkTarget = read;
			}
			links.push({ identifier, targetType, relationship, target: linkTarget });
		}

	// The condition: a create's on its `case`, an update's or a close's on its group.
	let condition: ProposedBlock["condition"];
	if (creates) {
		const relevant = bindAt("case")?.attribs.relevant;
		if (relevant !== undefined)
			condition = { text: relevant, site: site("case", "relevant") };
	} else if (conditionWrapper !== undefined) {
		const bind = xform.binds.get(conditionWrapper);
		const relevant = bind?.logic.relevant;
		if (relevant !== undefined && bind !== undefined)
			condition = {
				text: relevant,
				site: { element: bind.element, attribute: "relevant" },
			};
	}

	// The close.
	const closes = parts.has("close");
	let closeCondition: ProposedBlock["closeCondition"];
	const closeRelevant = bindAt("case/close")?.attribs.relevant;
	if (closes && closeRelevant !== undefined)
		closeCondition = {
			text: closeRelevant,
			site: site("case/close", "relevant"),
		};
	if (closes && creates) return fail(SAVE_TO_CASE_CLAIMS.writeAndClose);

	// The shared update's group is present while some row is, or always
	// where the block links.
	if (sharedHolds && !closes) {
		const relevant = condition?.text;
		const tree = parse(relevant);
		const parts = tree === undefined ? [] : disjuncts(tree);
		sharedHolds =
			links.length > 0
				? relevant === undefined
				: relevant !== undefined &&
					parts.length === presences.length &&
					parts.every((part, at) =>
						sameXPathText(
							relevant.slice(part.from, part.to),
							presences[at] as string,
							{ ruleSet: "form" },
						),
					);
	} else sharedHolds = false;
	if (ownerLed && !sharedHolds) return fail(SAVE_TO_CASE_CLAIMS.ownerCondition);

	return {
		ok: true,
		proposal: {
			kind: creates ? "create" : closes ? "close" : "update",
			caseType,
			block,
			segments,
			target,
			...(name !== undefined && { name }),
			...(owner !== undefined && { owner }),
			...(rename !== undefined && { rename }),
			...(retype !== undefined && { retype }),
			writes,
			links,
			...(condition !== undefined && { condition }),
			closes,
			...(closeCondition !== undefined && { closeCondition }),
			place,
			...(sharedHolds && { shared: sharedRows }),
		},
	};
}

/**
 * Whether a root create's id setvalue is blank on every opening, by what the
 * form's load gives it: the empty literal, or a bare read of a question that
 * no earlier load-time setvalue fills, or fills only with the empty literal.
 * An id whose blankness depends on anything else is the authored id.
 */
function blankOnOpening(
	xform: ReadXForm,
	setvalue: ReadXForm["setvalues"][number],
	idPath: readonly string[],
): boolean {
	if (literalOf(setvalue.value) === "") return true;
	const node = parse(setvalue.value);
	const root = xform.parsed.dataRoot.name;
	const path = node === undefined ? undefined : resolvePath(node, idPath, root);
	if (path === undefined || fieldAt(xform, path) === undefined) return false;
	const at = xform.setvalues.indexOf(setvalue);
	return xform.setvalues
		.slice(0, at)
		.filter(
			(one) =>
				one.event === "xforms-ready" &&
				one.target?.join("/") === path.join("/"),
		)
		.every((one) => literalOf(one.value) === "");
}

/** The key a keyed create's id reads and the prefix it stands under:
 *  `authoredCaseIdCalculation`'s shape, whatever the namespace prefix. The
 *  prefix derives from the app, form and operation that wrote it, which the
 *  reading's own identities are not, so the comparison prints it back as
 *  read. */
function keyedKey(
	text: string | undefined,
): { readonly key: string; readonly prefix: string } | undefined {
	if (text === undefined) return undefined;
	let node = parse(text);
	while (node?.kind === "group") node = node.value;
	if (node?.kind !== "call" || node.name !== "if" || node.args.length !== 3)
		return undefined;
	const concat = node.args[1];
	if (
		concat?.kind !== "call" ||
		concat.name !== "concat" ||
		concat.args.length !== 2
	)
		return undefined;
	const prefix = concat.args[0];
	const key = concat.args[1] as FormSyntax;
	if (
		prefix?.kind !== "string" ||
		!prefix.value.startsWith(`${AUTHORED_CASE_ID_VERSION}:`)
	)
		return undefined;
	const keyText = text.slice(key.from, key.to);
	const length = w.call("string-length", [holeWire()]);
	const template = w.call("if", [
		w.and(
			w.gt(length, w.num(0)),
			w.lte(length, w.num(MAX_AUTHORED_CASE_KEY_LENGTH)),
		),
		w.call("concat", [w.str(prefix.value), holeWire()]),
		w.str(""),
	]);
	const matched = inside(text, template);
	return matched !== undefined &&
		sameXPathText(matched, keyText, { ruleSet: "form" })
		? { key: keyText, prefix: prefix.value }
		: undefined;
}

/** An owner inside its trim: the acting user's id, no owner, or an authored value. */
function readOwner(text: string, root: string, site: ClaimSite): ProposedOwner {
	if (sameXPathText(text, `/${root}/meta/userID`, { ruleSet: "form" }))
		return { kind: "meta-user" };
	if (literalOf(text) === "-") return { kind: "unowned" };
	return { kind: "text", text, site };
}

/** A case id a block reads: an earlier create's, the worker's record, a
 *  runtime expression inside its typed selector, or the session's case. */
function readTarget(
	xform: ReadXForm,
	text: string,
	context: readonly string[],
	caseType: string,
	earlierCreates: ReadonlyMap<string, true>,
	site: ClaimSite,
): ProposedTarget {
	const root = xform.parsed.dataRoot.name;
	const node = parse(text);
	const path =
		node === undefined ? undefined : resolvePath(node, context, root);
	if (path !== undefined) {
		const absolute = `/${root}/${path.join("/")}`;
		if (earlierCreates.has(absolute)) return { kind: "op", path: absolute };
	}
	if (
		sameXPathText(text, serializeForm(USERCASE_ID_FUNCTION), {
			ruleSet: "form",
		})
	)
		return { kind: "worker-record" };
	// The selector names the type the case holds before the submission, which
	// an earlier retype of the form leaves apart from the block's own: the
	// block's type first, then each type another block of the form names.
	const types = [
		caseType,
		...xform.saveToCaseBlocks.flatMap((block) => {
			const named = block.element.attribs["vellum:case_type"];
			return named === undefined || named === caseType ? [] : [named];
		}),
	];
	for (const type of new Set(types)) {
		const selected = inside(
			text,
			w.append(caseById(holeWire(), "casedb", type), [w.attr("case_id")]),
		);
		if (selected !== undefined)
			return { kind: "expression", text: selected, site };
	}
	return { kind: "session", text };
}

/** The emitter's print of a fixed tree, for a comparison of trees. */
function serializeForm(expr: WireExpr): string {
	return serializeWire(expr, { target: "xform", constraint: false }).text;
}

/** Whether `name` is the allocator's name for a guard of an operation whose
 *  id is one of `ids`: its base name (`generatedBaseName`), or that base with
 *  the suffix the allocator takes past a sibling of that name. Test 4 then
 *  holds the guard to the one the emitter writes for its operation. */
function guardOf(name: string, ids: ReadonlySet<string>): boolean {
	for (const id of ids)
		for (const kind of GUARD_KINDS)
			if (isAllocatedName(name, generatedBaseName("guard", id, kind)))
				return true;
	return false;
}

/** Whether `block` stands in the group a published placement keeps a
 *  child's block in. */
function keptInSubcases(xform: ReadXForm, block: ReadSaveToCaseBlock): boolean {
	const parent = block.wrappers[block.wrappers.length - 1];
	const role = parent === undefined ? undefined : xform.roles.get(parent);
	return role?.kind === "case-region" && role.container === "subcases";
}

/** The operation id the guard right after `block` is named after
 *  (`generatedBaseName("guard", id, kind)`), for a block in the group a
 *  published placement keeps a child's block in, whose own name is the
 *  placement's and names no operation. */
function keptName(
	xform: ReadXForm,
	block: ReadSaveToCaseBlock,
	guards: readonly ReadSaveToCaseBlock[],
): string | undefined {
	if (!keptInSubcases(xform, block)) return undefined;
	const siblings = (block.element.parent as Element | null)?.children.filter(
		isTag,
	);
	const next = siblings?.[siblings.indexOf(block.element) + 1];
	const guard = guards.find((one) => one.element === next);
	if (guard === undefined) return undefined;
	const name = guard.path[guard.path.length - 1] as string;
	const HOLE_ID = "\u0000";
	for (const kind of GUARD_KINDS) {
		const [prefix, suffix] = generatedBaseName("guard", HOLE_ID, kind).split(
			HOLE_ID,
		) as [string, string];
		// The allocator may have suffixed the base past a sibling of its name.
		for (const base of [name, name.slice(0, name.lastIndexOf("_"))]) {
			if (
				!base.startsWith(prefix) ||
				!base.endsWith(suffix) ||
				base.length <= prefix.length + suffix.length
			)
				continue;
			const id = base.slice(prefix.length, base.length - suffix.length);
			if (isAllocatedName(name, generatedBaseName("guard", id, kind)))
				return id;
		}
	}
	return undefined;
}

/** The kinds of the guards that stand beside `block` under its operation's
 *  name (`guardOf`'s names), in `GUARD_KINDS` order. */
function guardKindsBeside(
	block: ReadSaveToCaseBlock,
	guards: readonly ReadSaveToCaseBlock[],
): GuardKind[] {
	const parent = block.path.slice(0, -1).join("/");
	const name = block.path[block.path.length - 1] as string;
	return GUARD_KINDS.filter((kind) =>
		guards.some(
			(guard) =>
				guard.path.slice(0, -1).join("/") === parent &&
				isAllocatedName(
					guard.path[guard.path.length - 1] as string,
					generatedBaseName("guard", name, kind),
				),
		),
	);
}

function sameKinds(a: readonly GuardKind[], b: readonly GuardKind[]): boolean {
	return a.length === b.length && a.every((kind) => b.includes(kind));
}

/**
 * A shared update of every selected case read as the own arm: its group's
 * presence is derived, so it has no condition of its own; each row's
 * condition is what follows its presence; and a row or a name that reads a
 * question's generated sibling is the question's own value (its link, for a
 * capture's), the sibling settled as generated.
 */
function sharedOwn(
	ctx: ReadContext,
	xform: ReadXForm,
	read: NonNullable<BlockRead["proposal"]>,
	rows: ReadonlyMap<string, SharedRow>,
): NonNullable<BlockRead["proposal"]> {
	const { condition: _group, ...block } = read;
	const writes = read.writes.map((row): ProposedRow => {
		const one = rows.get(row.property);
		const sibling = one?.sibling;
		const value: ProposedRow["value"] =
			sibling === undefined || row.value.kind !== "text"
				? row.value
				: sibling.purpose === "url"
					? { kind: "capture", field: sibling.field }
					: { kind: "answer", field: sibling.field, site: row.value.site };
		if (value !== row.value && sibling !== undefined)
			settleSibling(ctx, xform, sibling);
		return {
			property: row.property,
			value,
			...(one?.rest !== undefined && { condition: one.rest }),
		};
	});
	const name = rows.get("case_name")?.sibling;
	if (read.rename !== undefined && name?.purpose === "trimmed")
		settleSibling(ctx, xform, name);
	return {
		...block,
		writes,
		...(read.rename !== undefined &&
			name?.purpose === "trimmed" && {
				rename: { ...read.rename, answer: name.field },
			}),
	};
}

/**
 * Whether the form holds what the emitter writes for a registration's own arm
 * beside its block: each question whose answer the arm saves as it is as the
 * case's name or external id carries its trimmed sibling
 * (`nova_trimmed_<question>`), because the own arm guards those questions
 * wherever it is kept (`placement.ts::placedBasic`,
 * `caseScalarTextGuard.ts::caseScalarTextGuards`), while a create in a block
 * guards none.
 */
function ownGuardsPrinted(
	xform: ReadXForm,
	read: NonNullable<BlockRead["proposal"]>,
): boolean {
	const guarded = [
		read.name?.readsField,
		...read.writes.map((row) =>
			isCaseScalarTextProperty(row.property) && row.value.kind === "text"
				? row.value.readsField
				: undefined,
		),
	].filter((field): field is DraftField => field !== undefined);
	if (guarded.length === 0) return true;
	const trimmed = new Set<DataNode>();
	for (const role of xform.roles.values())
		if (
			(role.kind === "generated" || role.kind === "generated-candidate") &&
			role.purpose === "trimmed" &&
			role.owner !== null
		)
			trimmed.add(role.owner);
	return guarded.every((field) => trimmed.has(field.node));
}

/** A block of the session's case as the form's own arm, as far as the
 *  guards the emitter gives an operation read it (`operationGuardKinds`):
 *  its name, owner, rows and links, and no rename, which the own arm states
 *  as its name. */
function ownShape(read: NonNullable<BlockRead["proposal"]>): CaseOperation {
	return {
		action: "own",
		...(read.owner !== undefined && { owner: placeholder("value") }),
		writes: read.writes.map((row) => ({
			property: row.property,
			value: placeholder("value"),
		})),
		links: read.links.map((link) => ({
			identifier: link.identifier,
			targetType: link.targetType,
			relationship: link.relationship,
			target:
				link.target === null
					? null
					: link.target.kind === "expression"
						? { kind: "expression", expr: placeholder("value") }
						: { kind: "session" },
		})),
	} as unknown as CaseOperation;
}

/** The same block as an update of the session's case, for the guards it
 *  takes (`operationGuardKinds`). */
function updateShape(read: NonNullable<BlockRead["proposal"]>): CaseOperation {
	return {
		...(ownShape(read) as object),
		action: "update",
		caseType: read.caseType,
		target: { kind: "session" },
		...(read.rename !== undefined && { rename: placeholder("value") }),
		...(read.owner !== undefined && { owner: placeholder("value") }),
	} as unknown as CaseOperation;
}

/**
 * Pass 1: reads every Save to Case block of `form` by the four tests, the
 * last of which waits for the bound document. Each block that passes the
 * first three is proposed as one operation, its texts registered for the
 * expression stage; each that fails is one finding at its place. Claims
 * every block, its binds and setvalues, and the wrappers it stands under.
 */
export function readSaveToCaseBlocks(
	ctx: ReadContext,
	module: DraftModule,
	form: DraftForm,
): void {
	const xform = form.xform;
	if (xform === null || xform.saveToCaseBlocks.length === 0) return;
	const root = xform.parsed.dataRoot.name;
	const reading: FormBlocks = {
		proposals: [],
		failed: [],
		registrations: new Map(),
	};
	const placeOf = (block: ReadSaveToCaseBlock): HqPlace =>
		questionPlace(form.place as Extract<HqPlace, { kind: "form" }>, block.path);
	const earlierCreates = new Map<string, true>();
	const proposed: { read: NonNullable<BlockRead["proposal"]> }[] = [];
	const guards: ReadSaveToCaseBlock[] = [];
	for (const block of xform.saveToCaseBlocks) {
		const role = xform.roles.get(
			xform.nodes.get(block.path.join("/")) as DataNode,
		);
		const place = placeOf(block);
		if (role?.kind === "case-region" && role.container === "guard") {
			guards.push(block);
			continue;
		}
		if (!scopeOk(xform, block)) {
			reading.failed.push({
				block,
				place,
				claim: SAVE_TO_CASE_CLAIMS.outsideShape,
			});
			continue;
		}
		const read = readBlock(ctx, form, xform, block, place, earlierCreates);
		if (!read.ok || read.proposal === undefined) {
			// The group a published placement keeps a child's block in holds no
			// author's block: one it holds that Nova does not write today is of
			// an earlier shape of Nova's own.
			const kept = keptInSubcases(xform, block);
			reading.failed.push({
				block,
				place,
				claim: kept
					? SAVE_TO_CASE_CLAIMS.outsideShape
					: (read.claim ?? SAVE_TO_CASE_CLAIMS.outsideShape),
				...(!kept && read.detail !== undefined && { detail: read.detail }),
			});
			continue;
		}
		if (read.proposal.kind === "create")
			earlierCreates.set(
				`/${root}/${[...block.path, "case", "@case_id"].join("/")}`,
				true,
			);
		proposed.push({ read: read.proposal });
	}
	// Guards: each belongs to an operation proposed in its scope; the guard of
	// a block that is a finding is covered by that finding, at its place.
	const ids = new Set(
		proposed.flatMap(({ read }) => {
			const kept = keptName(xform, read.block, guards);
			return [
				read.block.path[read.block.path.length - 1] as string,
				...(kept === undefined ? [] : [kept]),
			];
		}),
	);
	const failedBlocks = [...reading.failed];
	for (const guard of guards) {
		const name = guard.path[guard.path.length - 1] as string;
		const owner = failedBlocks.find((one) =>
			guardOf(
				name,
				new Set([one.block.path[one.block.path.length - 1] as string]),
			),
		);
		if (owner !== undefined) reading.failed.push({ ...owner, block: guard });
		else if (!scopeOk(xform, guard) || !guardOf(name, ids))
			reading.failed.push({
				block: guard,
				place: placeOf(guard),
				claim: SAVE_TO_CASE_CLAIMS.outsideShape,
			});
	}

	// The own arm in a block, where the form's own arm stands in no slot.
	const ownTaken = (basicCaseReading(form)?.operations ?? []).some(
		(one) =>
			one.action === "own" &&
			(one.writes.length > 0 ||
				one.name !== undefined ||
				one.owner !== undefined),
	);
	const menuType = module.module.caseType;
	const type = form.form.type;
	const severalCases =
		(type === "followup" || type === "close") &&
		isMultiSelectMenu({
			case_details: module.json.peek("case_details"),
			search_config: module.json.peek("search_config"),
		});
	// The own arm where its block prints back as the own arm's: each row of an
	// answer as it is led by its presence, and the guards the own arm takes.
	// Where the form's own case also has a basic block that writes nothing,
	// a block that prints back as an update of the session's case as well is
	// that update, beside the basic block (R3). The two differ by name: the
	// emitter names a block by its operation's id, and the basic block's
	// operation takes the id the own arm would.
	const bareOwnId = basicCaseReading(form)?.bareOwnId;
	const ownCandidate =
		!ownTaken &&
		menuType !== undefined &&
		(type === "followup" || type === "close")
			? proposed.find(({ read }) => {
					if (
						read.kind === "create" ||
						read.caseType !== menuType ||
						read.target.kind !== "session" ||
						read.block.repeat !== null ||
						read.segments.join("/") !== "operations/block" ||
						read.retype !== undefined
					)
						return false;
					const present = guardKindsBeside(read.block, guards);
					const answers = read.writes.flatMap((row) =>
						row.answerAsIs === undefined ? [] : [row.answerAsIs],
					);
					const name = read.block.path[read.block.path.length - 1];
					const asOwn =
						answers.every((one) => one.led) &&
						sameKinds(present, operationGuardKinds(ownShape(read)));
					const asUpdate =
						answers.every((one) => !one.led) &&
						sameKinds(present, operationGuardKinds(updateShape(read))) &&
						name !== bareOwnId;
					return asOwn && !(bareOwnId !== undefined && asUpdate);
				})
			: undefined;
	// The own arm of a form whose menu selects several cases: one shared
	// update of every selected case, in the shape no other operation takes
	// with a group present while some row is.
	const sharedCandidate =
		ownCandidate === undefined &&
		!ownTaken &&
		menuType !== undefined &&
		severalCases
			? proposed.find(
					({ read }) =>
						read.shared !== undefined &&
						read.kind === "update" &&
						read.caseType === menuType &&
						read.block.repeat === null &&
						read.retype === undefined,
				)
			: undefined;
	// The own arm of a registration whose own case takes no slot of Case
	// Management: CommCare HQ's app holds no open action there, so the form
	// reads as a survey, and its own case is the first block of the form, a
	// create of the menu's case type in the root operations group. The
	// emitter writes that block as it writes a create's, but for the guards:
	// a create always takes its text guard, and the own arm takes the guards
	// `operationGuardKinds` gives it, so the arm is read only where the
	// guards beside the block are the arm's. Where those are a create's too
	// (the arm writes a fixed text column), the arm is read first (R3), and
	// test 4 holds its guard's content to the emitter's.
	const firstBlock = proposed[0]?.read;
	const registrationCandidate =
		!ownTaken &&
		menuType !== undefined &&
		type === "survey" &&
		advancedCaseReading(form) === undefined &&
		firstBlock !== undefined &&
		firstBlock.kind === "create" &&
		firstBlock.caseType === menuType &&
		firstBlock.target.kind === "new" &&
		firstBlock.target.idFrom === undefined &&
		firstBlock.block.repeat === null &&
		firstBlock.segments.join("/") === "operations/block" &&
		firstBlock.name?.answer === undefined &&
		!keptInSubcases(xform, firstBlock.block) &&
		sameKinds(
			guardKindsBeside(firstBlock.block, guards),
			operationGuardKinds(ownShape(firstBlock)),
		) &&
		ownGuardsPrinted(xform, firstBlock)
			? firstBlock
			: undefined;
	// Any other block whose owner row carries a condition is that entry.
	for (const one of [...proposed]) {
		const { read } = one;
		if (
			read !== sharedCandidate?.read &&
			read.shared !== undefined &&
			bindsUnder(xform, read.block.path).get("case/update/owner_id")?.attribs
				.relevant !== undefined
		) {
			reading.failed.push({
				block: read.block,
				place: read.place,
				claim: SAVE_TO_CASE_CLAIMS.ownerCondition,
			});
			proposed.splice(proposed.indexOf(one), 1);
		}
	}

	// The ids the blocks carry win over the ids Case Management's operations
	// take, which no source names: those are named past them.
	const questionIds = new Set(xform.childrenOf(null).map((field) => field.id));
	const carried = new Set<string>();
	for (const { read } of proposed) {
		const name = carriedName(
			xform,
			read,
			guards,
			read === sharedCandidate?.read,
		);
		if (name !== undefined && !questionIds.has(name)) carried.add(name);
	}
	nameBasicOperationsPast(form, carried);
	nameAdvancedOperationsPast(form, carried);

	// Mint, register and record each proposal.
	// Free among the form's ids: its root questions' and the operations its
	// actions already gave.
	const takenIds = new Set<string>(questionIds);
	for (const one of basicCaseReading(form)?.operations ?? [])
		takenIds.add(one.id);
	for (const one of advancedCaseReading(form)?.operations ?? [])
		takenIds.add(one.id);
	const counts = new Map<string, number>();
	for (const { read } of proposed) {
		const shared = read === sharedCandidate?.read;
		const own =
			read === ownCandidate?.read || shared || read === registrationCandidate;
		const action: ProposedBlock["action"] = own ? "own" : read.kind;
		const name = carriedName(xform, read, guards, shared);
		const id =
			name !== undefined && !takenIds.has(name)
				? name
				: ownCaseOperationId(read.caseType, takenIds);
		takenIds.add(id);
		const repeatPath =
			read.block.repeat === null ? [] : fieldIdsOf(read.block.repeat);
		const scopeLength = read.block.path.length - read.segments.length;
		const path = read.block.path.slice(scopeLength);
		const key = JSON.stringify([repeatPath, path, action]);
		const n = counts.get(key) ?? 0;
		counts.set(key, n + 1);
		const uuid = ctx.accounting.identity(
			ctx.resolver.claim(
				externalKey.caseOperation(
					form.xmlns,
					["save-to-case", repeatPath, path],
					action,
					n,
				),
				whereText(read.place),
			),
			read.place,
			MUG,
		);
		if (uuid === undefined) continue;
		// Only the own arm's block carries a condition on its `case/close`;
		// every other close condition Nova writes is a group's relevance, the
		// own close's in a block of its own included.
		if (!own && read.closeCondition !== undefined) {
			const closeOnly =
				read.writes.length === 0 &&
				read.rename === undefined &&
				read.owner === undefined &&
				read.links.length === 0;
			reading.failed.push({
				block: read.block,
				place: read.place,
				claim: closeOnly
					? SAVE_TO_CASE_CLAIMS.closeOnlyCondition
					: SAVE_TO_CASE_CLAIMS.writeAndClose,
			});
			continue;
		}
		// The own arm's rows of an answer as it is lead with its presence.
		const writes = own
			? read.writes.map(({ answerAsIs, condition, ...row }) =>
					answerAsIs === undefined
						? { ...row, ...(condition !== undefined && { condition }) }
						: {
								...row,
								...(answerAsIs.rest !== undefined && {
									condition: answerAsIs.rest,
								}),
							},
				)
			: read.writes;
		if (shared && read.shared !== undefined) {
			reading.proposals.push({
				...sharedOwn(ctx, xform, read, read.shared),
				uuid,
				id,
				action,
			});
			continue;
		}
		reading.proposals.push({ ...read, writes, uuid, id, action });
	}
	// The own close in a block of its own: a close-only block of the own case
	// in a condition group, its condition the group's, under the root
	// operations container, or, in a form whose menu selects several cases,
	// in each selected case's row (`OWN_CLOSE_SHAPES`). A close-only block
	// whose `case/close` carries the condition was refused above.
	if (type === "followup" || type === "close" || type === "registration") {
		const shapes = severalCases
			? OWN_CLOSE_SHAPES.severalCases
			: OWN_CLOSE_SHAPES.oneCase;
		const ownClose = reading.proposals.find(
			(one) =>
				one.action === "close" &&
				one.caseType === menuType &&
				one.target.kind === "session" &&
				one.block.repeat === null &&
				one.writes.length === 0 &&
				shapes.has(one.segments.join("/")) &&
				!reading.proposals.some(
					(other) => other.action === "own" && other.closes,
				),
		);
		if (ownClose !== undefined) {
			reading.proposals.splice(reading.proposals.indexOf(ownClose), 1);
			const scopeLength = ownClose.block.path.length - ownClose.segments.length;
			reading.ownClose = {
				path: ownClose.block.path.slice(scopeLength) as unknown as readonly [
					string,
					...string[],
				],
				...(ownClose.condition !== undefined && {
					condition: ownClose.condition,
				}),
				block: ownClose.block,
				segments: ownClose.segments,
				place: ownClose.place,
			};
		}
	}
	// A create whose name reads a question's trimmed sibling is one an action
	// carries wherever it is kept (`placement.ts::placedBasic`: a registration's
	// own case, an inert child of a several-case form), whose name question
	// takes HQ's `required` as a basic action's does.
	dropCreateNameRequired(
		ctx,
		form,
		reading.proposals.flatMap((one) => {
			if (one.action === "create")
				return one.name?.answer === undefined ? [] : [one.name.answer];
			// A registration's own arm in a block reads its name question as it
			// is beside the question's trimmed sibling (`ownGuardsPrinted`).
			if (one.action === "own" && one.name !== undefined) {
				const named = one.name.answer ?? one.name.readsField;
				return named === undefined ? [] : [named];
			}
			return [];
		}),
	);
	for (const failed of reading.failed) refuseBlock(xform, failed);
	claimAccepted(ctx, xform, reading);
	registerTexts(ctx, form, reading);
	READINGS.set(form, reading);
}

/**
 * The id a block carries for its operation: the one its guard is named after
 * where a published placement or the child's place names the block, else the
 * block's own name where it passes the identifier grammar; none for a block
 * the emitter names by its purpose (a child's block read from HQ's child case
 * action, which names its case's name from a trimmed question, and the shared
 * update of a several-case form), whose id is its case type's.
 */
function carriedName(
	xform: ReadXForm,
	read: NonNullable<BlockRead["proposal"]>,
	guards: readonly ReadSaveToCaseBlock[],
	shared: boolean,
): string | undefined {
	const named = keptName(xform, read.block, guards);
	if (named !== undefined) return named;
	const blockName = read.block.path[read.block.path.length - 1] as string;
	return read.name?.answer === undefined &&
		!shared &&
		!keptInSubcases(xform, read.block) &&
		isCaseOperationIdentifier(blockName)
		? blockName
		: undefined;
}

/** A field's ids from the form's root. */
function fieldIdsOf(field: DraftField): string[] {
	const ids: string[] = [];
	for (let at: DraftField | null = field; at !== null; at = at.parent)
		ids.unshift(at.id);
	return ids;
}

/** One finding at the block's place, covering the block, its binds and its setvalues. */
function refuseBlock(
	xform: ReadXForm,
	failed: FormBlocks["failed"][number],
): void {
	const { block, place, claim, detail } = failed;
	xform.cursor.refuseSubtree(block.element, claim, place, detail);
	for (const [key, bind] of bindsUnder(xform, block.path)) {
		if (key.includes("@"))
			xform.cursor.refuseSubtree(bind, claim, place, detail);
		else
			for (const attribute of Object.keys(bind.attribs))
				if (
					[
						"calculate",
						"relevant",
						"type",
						"constraint",
						"required",
						"readonly",
					].includes(attribute)
				)
					xform.cursor.refuse(
						{ element: bind, attribute },
						claim,
						place,
						detail,
					);
	}
	for (const setvalue of setvaluesUnder(xform, block.path))
		xform.cursor.refuseSubtree(setvalue, claim, place, detail);
}

/** Claims every accepted block, the binds and setvalues under it, and each
 *  wrapper it stands under, leaving each attribute a text is registered
 *  from to the expression stage. */
function claimAccepted(
	ctx: ReadContext,
	xform: ReadXForm,
	reading: FormBlocks,
): void {
	const registeredAttributes = new Map<Element, Set<string>>();
	const note = (site: ClaimSite | undefined) => {
		if (
			site === undefined ||
			!("element" in site) ||
			site.attribute === undefined
		)
			return;
		const set = registeredAttributes.get(site.element) ?? new Set<string>();
		set.add(site.attribute);
		registeredAttributes.set(site.element, set);
	};
	for (const one of reading.proposals) {
		if (one.name?.answer === undefined) note(one.name?.site);
		if (one.owner?.kind === "text") note(one.owner.site);
		if (one.rename?.answer === undefined) note(one.rename?.site);
		note(one.condition?.site);
		note(one.closeCondition?.site);
		if (one.target.kind === "expression") note(one.target.site);
		for (const write of one.writes) {
			if (write.value.kind === "text") note(write.value.site);
			note(write.condition?.site);
		}
		for (const link of one.links)
			if (link.target?.kind === "expression") note(link.target.site);
	}
	if (reading.ownClose?.condition !== undefined)
		note(reading.ownClose.condition.site);
	const wrappers = new Set<DataNode>();
	const claimBinds = (prefix: readonly string[], claim: Claim<"derived">) => {
		for (const [key, bind] of bindsUnder(xform, prefix)) {
			if (key.includes("@")) {
				xform.cursor.derivedSubtree(bind, claim);
				continue;
			}
			const skip = registeredAttributes.get(bind);
			for (const attribute of ["calculate", "relevant"])
				if (
					bind.attribs[attribute] !== undefined &&
					skip?.has(attribute) !== true
				)
					xform.cursor.derived({ element: bind, attribute }, claim);
		}
		for (const setvalue of setvaluesUnder(xform, prefix))
			xform.cursor.derivedSubtree(setvalue, claim);
	};
	const blocks: {
		block: ReadSaveToCaseBlock;
		claim: Claim<"take">;
		binds: Claim<"derived">;
	}[] = [
		...reading.proposals.map((one) => ({
			block: one.block,
			// A block is claimed under the entry its own class names: one in a
			// repeat under the repeat's, one writing a property whose name holds a
			// hyphen under that one's, any other under its action's.
			claim:
				one.block.repeat !== null
					? SAVE_TO_CASE_CLAIMS.inRepeat
					: one.writes.some((row) => row.property.includes("-"))
						? SAVE_TO_CASE_CLAIMS.hyphenated
						: one.action === "create" || one.action === "own"
							? SAVE_TO_CASE_CLAIMS.create
							: SAVE_TO_CASE_CLAIMS.update,
			binds:
				one.action === "create"
					? SAVE_TO_CASE_CLAIMS.createBind
					: SAVE_TO_CASE_CLAIMS.updateBind,
		})),
	];
	const guardBlocks = xform.saveToCaseBlocks.filter(
		(block) =>
			!reading.failed.some((one) => one.block === block) &&
			!reading.proposals.some((one) => one.block === block),
	);
	for (const block of guardBlocks)
		blocks.push({
			block,
			claim: SAVE_TO_CASE_CLAIMS.update,
			binds: SAVE_TO_CASE_CLAIMS.updateBind,
		});
	for (const { block, claim, binds } of blocks) {
		void xform.cursor.takeSubtree(block.element, claim).value;
		claimBinds(block.path, binds);
		for (const wrapper of block.wrappers) wrappers.add(wrapper);
	}
	// The wrappers, the nodes of the region that stand beside the blocks (a
	// keyed create's count, a clock read, a selected-cases query node), and
	// the controls that name them.
	const failedUnder = (node: DataNode) =>
		reading.failed.some((one) => one.block.wrappers.includes(node));
	for (const node of xform.caseRegion) {
		if (node.role === "SaveToCase" || isInsideBlock(node)) continue;
		const role = xform.roles.get(node);
		const container = role?.kind === "case-region" ? role.container : undefined;
		if (wrappers.has(node)) {
			if (
				failedUnder(node) &&
				![...wrappers].some((one) => one === node && !failedUnder(one))
			)
				continue;
			const claim =
				container === "condition"
					? SAVE_TO_CASE_CLAIMS.conditionGroup
					: SAVE_TO_CASE_CLAIMS.rows;
			xform.cursor.derived({ element: node.element }, claim);
			for (const attribute of Object.keys(node.element.attribs))
				if (!attribute.startsWith("xmlns"))
					xform.cursor.derived({ element: node.element, attribute }, claim);
			const bind = xform.binds.get(node);
			if (bind?.logic.relevant !== undefined)
				xform.cursor.derived(
					{ element: bind.element, attribute: "relevant" },
					claim,
				);
			// A selected-cases repeat's own iteration: the binds and setvalues
			// on its attributes and its row's (`@current_index`, `@ids`,
			// `@count`, `item/@index`, `item/@id`), which test 4 holds to the
			// emitter's with the wrapper.
			if (container === "selected-cases" || container === "selected-case") {
				for (const [key, attributeBind] of bindsUnder(xform, node.path))
					if (key.startsWith("@") && !key.includes("/"))
						xform.cursor.derivedSubtree(attributeBind, claim);
				for (const one of xform.setvalues)
					if (
						one.target !== undefined &&
						one.target.length === node.path.length + 1 &&
						node.path.every((step, i) => one.target?.[i] === step) &&
						(one.target[node.path.length] as string).startsWith("@")
					)
						xform.cursor.derivedSubtree(one.element, claim);
			}
			continue;
		}
		if (node.children.length > 0) continue;
		const parentWrapper = node.parent !== null && wrappers.has(node.parent);
		const inRegion =
			parentWrapper ||
			(node.parent !== null && xform.caseRegion.includes(node.parent));
		if (!inRegion) continue;
		xform.cursor.derivedSubtree(node.element, SAVE_TO_CASE_CLAIMS.rows);
		const bind = xform.binds.get(node);
		if (bind !== undefined)
			for (const attribute of ["calculate", "relevant", "type"])
				if (bind.element.attribs[attribute] !== undefined)
					xform.cursor.derived(
						{ element: bind.element, attribute },
						SAVE_TO_CASE_CLAIMS.rows,
					);
		for (const setvalue of setvaluesUnder(xform, node.path))
			xform.cursor.derivedSubtree(setvalue, SAVE_TO_CASE_CLAIMS.rows);
	}
	claimControls(ctx, xform);
}

function isInsideBlock(node: DataNode): boolean {
	for (let at = node.parent; at !== null; at = at.parent)
		if (at.role === "SaveToCase") return true;
	return false;
}

/** The body controls that name a node of the case region: each group or
 *  repeat with no label, and a `<group>` with no `ref` whose one control
 *  is such a repeat. */
function claimControls(ctx: ReadContext, xform: ReadXForm): void {
	void ctx;
	const root = xform.parsed.dataRoot.name;
	const region = new Set(xform.caseRegion.map((node) => node.path.join("/")));
	const claimed = new Set<Element>();
	const walk = (element: Element) => {
		for (const child of children(element)) {
			const local = localName(child);
			const ref = child.attribs.ref ?? child.attribs.nodeset;
			if ((local === "group" || local === "repeat") && ref !== undefined) {
				const steps = pathSteps(ref);
				const path =
					steps !== undefined && steps[0] === "/" && steps[1] === root
						? steps.slice(2)
						: undefined;
				if (path !== undefined && region.has(path.join("/"))) {
					xform.cursor.derived({ element: child }, SAVE_TO_CASE_CLAIMS.rows);
					for (const attribute of Object.keys(child.attribs))
						xform.cursor.derived(
							{ element: child, attribute },
							SAVE_TO_CASE_CLAIMS.rows,
						);
					claimed.add(child);
				}
			}
			walk(child);
			if (
				local === "group" &&
				ref === undefined &&
				children(child).length === 1 &&
				claimed.has(children(child)[0] as Element)
			)
				xform.cursor.derived({ element: child }, SAVE_TO_CASE_CLAIMS.rows);
		}
	};
	walk(xform.parsed.body);
}

/** The ref of one registration: the operation's slot and member. */
function caseSlot(
	formUuid: Uuid,
	slot:
		| "case_operation_name"
		| "case_operation_owner"
		| "case_operation_rename"
		| "case_operation_condition"
		| "case_operation_target_expression",
	operationUuid: Uuid,
): SlotContextRef {
	return {
		entity: "form",
		uuid: formUuid,
		slot,
		member: { operationUuid },
	} as SlotContextRef;
}

/** Registers every text a proposal holds, each once, in the mode the form's source is read in. */
function registerTexts(
	ctx: ReadContext,
	form: DraftForm,
	reading: FormBlocks,
): void {
	const mode = { target: "xform", constraint: false } as const;
	const register = (
		key: string,
		ref: SlotContextRef,
		text: string,
		site: ClaimSite,
		place: HqPlace,
		surfaceKey: string,
	) => {
		const index = ctx.pending.register(
			{ ref, text, mode, place, key: surfaceKey },
			site,
		);
		reading.registrations.set(key, { index });
	};
	const CALC = "xform:model/bind@calculate";
	const RELEVANT = "xform:model/bind@relevant";
	for (const one of reading.proposals) {
		const op = one.uuid;
		if (one.name !== undefined && one.name.answer === undefined)
			register(
				`${op} name`,
				caseSlot(form.uuid, "case_operation_name", op),
				one.name.text,
				one.name.site,
				one.place,
				CALC,
			);
		if (one.rename !== undefined && one.rename.answer === undefined)
			register(
				`${op} rename`,
				caseSlot(
					form.uuid,
					one.action === "own"
						? "case_operation_name"
						: "case_operation_rename",
					op,
				),
				one.rename.text,
				one.rename.site,
				one.place,
				CALC,
			);
		if (one.owner?.kind === "text")
			register(
				`${op} owner`,
				caseSlot(form.uuid, "case_operation_owner", op),
				one.owner.text,
				one.owner.site,
				one.place,
				CALC,
			);
		// A registration's own case opens under the form's open condition.
		if (one.condition !== undefined)
			register(
				`${op} condition`,
				one.action === "own"
					? ({
							entity: "form",
							uuid: form.uuid,
							slot: "form_open_condition",
						} as SlotContextRef)
					: caseSlot(form.uuid, "case_operation_condition", op),
				one.condition.text,
				one.condition.site,
				one.place,
				RELEVANT,
			);
		if (one.target.kind === "expression")
			register(
				`${op} target`,
				caseSlot(form.uuid, "case_operation_target_expression", op),
				one.target.text,
				one.target.site,
				one.place,
				CALC,
			);
		if (one.action === "own" && one.closeCondition !== undefined)
			register(
				`${op} close`,
				{
					entity: "form",
					uuid: form.uuid,
					slot: "form_close_condition",
				} as SlotContextRef,
				one.closeCondition.text,
				one.closeCondition.site,
				one.place,
				RELEVANT,
			);
		for (const write of one.writes) {
			const member = { operationUuid: op, property: write.property };
			if (write.value.kind === "text")
				register(
					`${op} write ${write.property}`,
					{
						entity: "form",
						uuid: form.uuid,
						slot: "case_operation_write_value",
						member,
					} as SlotContextRef,
					write.value.text,
					write.value.site,
					one.place,
					CALC,
				);
			if (write.condition !== undefined)
				register(
					`${op} when ${write.property}`,
					{
						entity: "form",
						uuid: form.uuid,
						slot: "case_operation_write_condition",
						member,
					} as SlotContextRef,
					write.condition.text,
					write.condition.site,
					one.place,
					RELEVANT,
				);
		}
		for (const link of one.links)
			if (link.target?.kind === "expression")
				register(
					`${op} link ${link.identifier}`,
					{
						entity: "form",
						uuid: form.uuid,
						slot: "case_operation_link_target_expression",
						member: { operationUuid: op, identifier: link.identifier },
					} as SlotContextRef,
					link.target.text,
					link.target.site,
					one.place,
					CALC,
				);
	}
	const ownClose = reading.ownClose?.condition;
	if (ownClose !== undefined) {
		const index = ctx.pending.register(
			{
				ref: {
					entity: "form",
					uuid: form.uuid,
					slot: "form_close_condition",
				} as SlotContextRef,
				text: ownClose.text,
				mode,
				place: form.place,
				key: RELEVANT,
			},
			ownClose.site,
		);
		reading.registrations.set("own-close", { index });
	}
}

/** Holds `case_references_data.save` to the form builder's computation over
 *  the read source. A form whose block is outside Nova's shape has that
 *  finding alone: its `save` is covered by it. */
function judgeSaveReferences(
	ctx: ReadContext,
	form: DraftForm,
	failed: FormBlocks["failed"],
): void {
	const cursor = caseReferencesOf(form);
	const xform = form.xform;
	if (cursor === undefined || xform === null) return;
	const stored = cursor.peek("save");
	if (
		stored === undefined ||
		(isJsonObject(stored) &&
			Object.keys(stored).length === 0 &&
			xform.saveToCaseBlocks.length === 0)
	)
		return;
	const computed = caseSaveReferencesOf(
		xform.parsed.model,
		xform.parsed.dataRoot,
	);
	if (sameJson(stored, computed)) {
		void cursor.take("save", SAVE_TO_CASE_CLAIMS.saveEqual, (value) => value)
			.value;
		return;
	}
	const blockFinding = ctx.accounting
		.findings()
		.find((finding) =>
			failed.some(
				(one) =>
					finding.code === one.claim.entry &&
					whereText(one.place) === whereText(finding.place),
			),
		);
	if (blockFinding !== undefined)
		ctx.accounting.cover({ json: cursor, key: "save" }, blockFinding);
	else cursor.refuse("save", SAVE_TO_CASE_CLAIMS.saveDiffering);
}

// ── The writes, once the fields have their UUIDs ────────────────────────

function placeholder(expectation: "condition" | "value"): Expression {
	return pendingPlaceholder(expectation);
}

/** A question's answer as it is: the question's own term. */
function answerOf(field: DraftField): Expression | undefined {
	return field.uuid === undefined
		? undefined
		: term({ kind: "field", uuid: field.uuid });
}

/** The operation a proposal writes into the draft, its texts as placeholders until the expression stage binds them. */
function operationOf(
	one: ProposedBlock,
	byPath: ReadonlyMap<string, Uuid>,
	ownerChoice: "absent" | "acting-user",
): CaseOperation | undefined {
	const repeat = one.block.repeat?.uuid;
	const scopeLength = one.block.path.length - one.segments.length;
	const path = one.block.path.slice(scopeLength) as unknown as [
		string,
		...string[],
	];
	const placement = {
		kind: "save-to-case" as const,
		...(repeat !== undefined && { repeat }),
		path,
	};
	const writes: CaseOperationWrite[] = [];
	for (const write of one.writes) {
		const value: Expression | undefined =
			write.value.kind === "capture"
				? write.value.field.uuid === undefined
					? undefined
					: term({ kind: "capture-link", field: write.value.field.uuid })
				: write.value.kind === "answer"
					? answerOf(write.value.field)
					: placeholder("value");
		if (value === undefined) return undefined;
		writes.push({
			property: write.property,
			value,
			...(write.condition !== undefined && {
				condition: placeholder("condition"),
			}),
		});
	}
	const owner: Expression | undefined =
		one.owner === undefined
			? undefined
			: one.owner.kind === "unowned"
				? unowned()
				: one.owner.kind === "meta-user"
					? one.target.kind === "new" && ownerChoice === "absent"
						? undefined
						: actingUser()
					: placeholder("value");
	const links: CaseOperationLink[] = [];
	for (const link of one.links) {
		const target =
			link.target === null
				? null
				: link.target.kind === "op"
					? byPath.has(link.target.path)
						? {
								kind: "op" as const,
								opUuid: byPath.get(link.target.path) as Uuid,
							}
						: undefined
					: link.target.kind === "session"
						? { kind: "session" as const }
						: { kind: "expression" as const, expr: placeholder("value") };
		if (target === undefined) return undefined;
		links.push({
			identifier: link.identifier,
			targetType: link.targetType,
			relationship: link.relationship,
			target,
		} as CaseOperationLink);
	}
	const forEach = repeat === undefined ? undefined : { repeat };
	// A child's block written from HQ's child case action is where the
	// emitter keeps a basic child of a several-case form, a place no
	// placement holds.
	const common = {
		uuid: one.uuid,
		id: one.id,
		...(writes.length > 0 && { writes }),
		...(one.name?.answer === undefined && { placement }),
	};
	if (one.action === "own") {
		// A registration's own arm names the case it creates; any other renames it.
		const name = one.rename ?? one.name;
		return {
			...common,
			action: "own",
			...(name !== undefined && {
				name:
					name.answer === undefined
						? placeholder("value")
						: answerOf(name.answer),
			}),
			...(owner !== undefined && { owner }),
			...(links.length > 0 && { links }),
		} as CaseOperation;
	}
	if (one.action === "create") {
		const idFrom =
			one.target.kind === "new" ? one.target.idFrom?.uuid : undefined;
		const name =
			one.name?.answer === undefined
				? placeholder("value")
				: answerOf(one.name.answer);
		if (name === undefined) return undefined;
		return {
			...common,
			action: "create",
			caseType: one.caseType,
			target: { kind: "new", ...(idFrom !== undefined && { idFrom }) },
			name,
			...(owner !== undefined && { owner }),
			...(links.length > 0 && { links }),
			...(one.condition !== undefined && {
				condition: placeholder("condition"),
			}),
			...(forEach !== undefined && { forEach }),
		} as CaseOperation;
	}
	const target =
		one.target.kind === "op"
			? byPath.has(one.target.path)
				? { kind: "op" as const, opUuid: byPath.get(one.target.path) as Uuid }
				: undefined
			: one.target.kind === "worker-record"
				? { kind: "worker-record" as const }
				: one.target.kind === "session"
					? { kind: "session" as const }
					: one.target.kind === "expression"
						? { kind: "expression" as const, expr: placeholder("value") }
						: undefined;
	if (target === undefined) return undefined;
	return {
		...common,
		action: one.action,
		caseType: one.caseType,
		target,
		...(one.action === "update" && owner !== undefined && { owner }),
		...(one.action === "update" &&
			one.rename !== undefined && { rename: placeholder("value") }),
		...(one.action === "update" &&
			one.retype !== undefined && { retype: one.retype }),
		...(one.action === "update" && links.length > 0 && { links }),
		...(one.condition !== undefined && { condition: placeholder("condition") }),
		...(forEach !== undefined && { forEach }),
	} as CaseOperation;
}

/** Each create block's `@case_id` path to its operation. */
function createPaths(form: DraftForm, reading: FormBlocks): Map<string, Uuid> {
	const root = form.xform?.parsed.dataRoot.name ?? "data";
	const byPath = new Map<string, Uuid>();
	for (const one of reading.proposals)
		if (one.target.kind === "new")
			byPath.set(
				`/${root}/${[...one.block.path, "case", "@case_id"].join("/")}`,
				one.uuid,
			);
	return byPath;
}

/**
 * Writes `form`'s Save to Case operations into its draft after every other
 * case operation, in document order, with the paths the expression reader
 * binds a block's id reads against (`DraftForm.operationIdPaths`), and the own close's block
 * where one was read.
 */
export function writeSaveToCaseOperations(
	ctx: ReadContext,
	form: DraftForm,
): void {
	const reading = READINGS.get(form);
	if (reading === undefined) return;
	const byPath = createPaths(form, reading);
	const operations: CaseOperation[] = [];
	for (const one of reading.proposals) {
		const operation = operationOf(one, byPath, "absent");
		if (operation === undefined) {
			ctx.accounting.finding(SAVE_TO_CASE_CLAIMS.outsideShape, one.place);
			continue;
		}
		operations.push(operation);
	}
	const ownInBlock = reading.proposals.find((one) => one.action === "own");
	ctx.writeDraft(() => {
		const existing = (form.form.caseOperations ?? []).filter(
			(one) => !(ownInBlock !== undefined && one.action === "own"),
		);
		const own = operations.filter((one) => one.action === "own");
		const rest = operations.filter((one) => one.action !== "own");
		const all = [...own, ...existing, ...rest];
		if (all.length > 0) form.form.caseOperations = all;
		// A registration whose own case is a block reads as a survey from
		// CommCare HQ's form actions; its block is what makes it one.
		if (ownInBlock?.target.kind === "new") {
			form.form.type = "registration";
			if (ownInBlock.condition !== undefined)
				form.form.openCondition = placeholder("condition");
		}
		if (ownInBlock?.closes === true && form.form.type === "followup")
			form.form.type = "close";
		if (ownInBlock?.closeCondition !== undefined)
			form.form.closeCondition = placeholder("condition");
		if (reading.ownClose !== undefined) {
			form.form.ownClosePlacement = {
				kind: "save-to-case",
				path: [...reading.ownClose.path] as [string, ...string[]],
			};
			if (reading.ownClose.condition !== undefined)
				form.form.closeCondition = placeholder("condition");
			if (form.form.type === "followup") form.form.type = "close";
		}
		form.operationIdPaths = byPath;
	});
}

// ── Pass 2: test 2 over the document, test 4 by re-emission ─────────────

const EMITTED = new WeakMap<
	BlueprintDoc,
	Map<Uuid, ReturnType<typeof emittedFormSource>>
>();

/** The prefix each keyed create read from a block stands under in the source, by operation. */
function keyedCaseIdPrefixes(ctx: ReadContext): Map<Uuid, string> {
	const prefixes = new Map<Uuid, string>();
	for (const module of ctx.draft.modules)
		for (const form of module.forms)
			for (const one of READINGS.get(form)?.proposals ?? [])
				if (one.target.kind === "new" && one.target.idPrefix !== undefined)
					prefixes.set(one.uuid, one.target.idPrefix);
	return prefixes;
}

/** Each keyed create `doc` holds that was read from a block, with the prefix
 *  its id stands under in the source, in form and proposal order. */
export function keyedCreatesRead(
	ctx: ReadContext,
	doc: BlueprintDoc,
): ReadMenuAndFormIdentities["keyedCreates"] {
	const read: ReadMenuAndFormIdentities["keyedCreates"][number][] = [];
	for (const module of ctx.draft.modules)
		for (const form of module.forms) {
			const held = new Set(
				(doc.forms[form.uuid]?.caseOperations ?? []).map((one) => one.uuid),
			);
			for (const one of READINGS.get(form)?.proposals ?? [])
				if (
					one.target.kind === "new" &&
					one.target.idPrefix !== undefined &&
					held.has(one.uuid)
				)
					read.push({
						operationUuid: one.uuid,
						formUuid: form.uuid,
						caseType: one.caseType,
						prefix: one.target.idPrefix,
					});
		}
	return read;
}

/** The form's source Nova's emitter writes for `doc`, under the source's ids
 *  and the source's keyed case id prefixes. */
function emittedForm(ctx: ReadContext, doc: BlueprintDoc, form: DraftForm) {
	let forms = EMITTED.get(doc);
	if (forms === undefined) {
		forms = new Map();
		const inputs = readProjectionInputs(ctx);
		let attachments: Record<string, unknown> = {};
		try {
			attachments = expandDoc(doc, {
				...inputs,
				keyedCaseIdPrefixes: keyedCaseIdPrefixes(ctx),
			})._attachments as Record<string, unknown>;
		} catch {
			attachments = {};
		}
		for (const module of ctx.draft.modules)
			for (const one of module.forms) {
				const id = inputs.identity.formUniqueId(one.uuid);
				const xml = attachments[`${id}.xml`];
				forms.set(
					one.uuid,
					typeof xml === "string" ? emittedFormSource(xml) : undefined,
				);
			}
		EMITTED.set(doc, forms);
	}
	return forms.get(form.uuid);
}

/** Each block a comparison of its own judges, with its wrappers: every
 *  proposal's, and the own close's, never judged as another's guard. */
function judgedApart(reading: FormBlocks): Set<string> {
	const blocks = [
		...reading.proposals.map((one) => one.block),
		...(reading.ownClose === undefined ? [] : [reading.ownClose.block]),
	];
	return new Set(
		blocks.flatMap((block) => [
			block.path.join("/"),
			...block.wrappers.map((wrapper) => wrapper.path.join("/")),
		]),
	);
}

/** Whether the own close read from a block of its own holds tests 2 and 4
 *  over `doc`: the place the plan gives it is the block's shape, and the
 *  emitter's block, with the close condition `doc` binds, is the stored one. */
function ownCloseHolds(
	ctx: ReadContext,
	doc: BlueprintDoc,
	form: DraftForm,
	reading: FormBlocks,
): boolean {
	const ownClose = reading.ownClose;
	const xform = form.xform;
	if (ownClose === undefined || xform === null) return true;
	let shape: readonly SaveToCaseBlockSegment[] | undefined;
	try {
		shape = saveToCaseBlockShape(doc, form.uuid, { kind: "own-close" });
	} catch {
		shape = undefined;
	}
	const emitted = emittedForm(ctx, doc, form);
	return (
		shape !== undefined &&
		shape.join("/") === ownClose.segments.join("/") &&
		emitted !== undefined &&
		blockTreesEqual(
			{ block: ownClose.block, form: storedFormSource(xform.parsed) },
			emitted,
			judgedApart(reading),
		)
	);
}

/** Whether every accepted block of `form` holds tests 2 and 4 over `doc`. */
function blocksHold(
	ctx: ReadContext,
	doc: BlueprintDoc,
	form: DraftForm,
	reading: FormBlocks,
): ProposedBlock[] {
	const xform = form.xform;
	if (xform === null) return [...reading.proposals];
	const emitted = emittedForm(ctx, doc, form);
	const stored = storedFormSource(xform.parsed);
	const apart = judgedApart(reading);
	const failing: ProposedBlock[] = [];
	for (const one of reading.proposals) {
		let shape: readonly SaveToCaseBlockSegment[] | undefined;
		try {
			shape = saveToCaseBlockShape(doc, form.uuid, {
				kind: "operation",
				operationUuid: one.uuid,
			});
		} catch {
			shape = undefined;
		}
		if (
			shape === undefined ||
			shape.join("/") !== one.segments.join("/") ||
			emitted === undefined ||
			!blockTreesEqual({ block: one.block, form: stored }, emitted, apart)
		)
			failing.push(one);
	}
	return failing;
}

/**
 * `doc` with `formUuid`'s Save to Case operations ordered so that each one
 * whose target or link names an earlier operation stands directly after it
 * (after any already placed there), every other operation keeping its place;
 * `doc` itself where that is the order it holds.
 */
function withTargetOrder(doc: BlueprintDoc, formUuid: Uuid): BlueprintDoc {
	const operations = doc.forms[formUuid]?.caseOperations ?? [];
	const named = (one: CaseOperation): Uuid | undefined => {
		if (one.placement?.kind !== "save-to-case" || one.action === "own")
			return undefined;
		if (one.target.kind === "op") return one.target.opUuid;
		const links = (one as { links?: readonly CaseOperationLink[] }).links;
		for (const link of links ?? [])
			if (link.target !== null && link.target.kind === "op")
				return link.target.opUuid;
		return undefined;
	};
	const ordered: CaseOperation[] = [];
	const followers = new Map<Uuid, number>();
	for (const one of operations) {
		const target = named(one);
		const at =
			target === undefined
				? -1
				: ordered.findIndex((candidate) => candidate.uuid === target);
		if (at < 0) {
			ordered.push(one);
			continue;
		}
		const after = at + (followers.get(target as Uuid) ?? 0) + 1;
		ordered.splice(after, 0, one);
		followers.set(target as Uuid, (followers.get(target as Uuid) ?? 0) + 1);
	}
	if (ordered.every((one, i) => one === operations[i])) return doc;
	return withCandidate(doc, (draft) => {
		const form = draft.forms[formUuid];
		if (form !== undefined)
			form.caseOperations = ordered as typeof form.caseOperations;
	});
}

/** An `and`'s clauses at every depth, left to right; any other tree alone. */
function clausesOf(expression: Expression): Expression[] {
	return expression.kind === "and"
		? expression.clauses.flatMap(clausesOf)
		: [expression];
}

/**
 * `doc` with each of `ops`' conditions read apart from what it inherits. The
 * emitter conjoins the condition of every operation a block's operation
 * stands under (`caseOperationConditionalGuardUuids`: an earlier conditional
 * create it reads, an earlier conditional retype whose type it needs) ahead
 * of the operation's own, so the stored condition leads with those
 * producers' conditions, once each, in that order; what follows is the
 * operation's own. A condition that leads with anything else is kept whole,
 * and test 4 judges it. `doc` itself where nothing is inherited.
 */
function withoutInheritedConditions(
	doc: BlueprintDoc,
	formUuid: Uuid,
	ops: readonly ProposedBlock[],
): BlueprintDoc {
	let current = doc;
	const read = new Set(ops.map((one) => one.uuid));
	for (const uuid of (doc.forms[formUuid]?.caseOperations ?? []).map(
		(one) => one.uuid,
	)) {
		if (!read.has(uuid)) continue;
		const operations = current.forms[formUuid]?.caseOperations ?? [];
		const operation = operations.find((one) => one.uuid === uuid);
		if (operation === undefined || operation.action === "own") continue;
		const condition = operation.condition;
		if (condition === undefined) continue;
		let guards: ReadonlySet<Uuid> | undefined;
		try {
			guards = caseOperationConditionalGuardUuids(current, formUuid).get(uuid);
		} catch {
			guards = undefined;
		}
		const inherited = [...(guards ?? [])].flatMap((producer) => {
			const stated = operations.find((one) => one.uuid === producer)?.condition;
			return stated === undefined ? [] : clausesOf(stated);
		});
		if (inherited.length === 0) continue;
		const clauses = clausesOf(condition);
		if (
			clauses.length < inherited.length ||
			!inherited.every((clause, i) => sameJson(clause, clauses[i]))
		)
			continue;
		const rest = clauses.slice(inherited.length);
		current = withCandidate(current, (draft) => {
			const held = draft.forms[formUuid]?.caseOperations?.find(
				(one) => one.uuid === uuid,
			) as { condition?: Expression } | undefined;
			if (held === undefined) return;
			const [first, second, ...more] = rest;
			if (first === undefined) delete held.condition;
			else
				held.condition =
					second === undefined ? first : and(first, second, ...more);
		});
	}
	return current;
}

/**
 * `doc` with the own arm of a follow-up or close form whose menu selects
 * several cases, where the arm writes nothing. Its change is a Save to Case
 * block of each selected case, and one that writes nothing is no block at
 * all, so a reading finds none; the form holds it all the same, at the place
 * the plan gives it, under the key that place spells. `doc` itself where the
 * form is no such form or already holds its own arm.
 */
function withSeveralCaseOwn(
	ctx: ReadContext,
	doc: BlueprintDoc,
	form: DraftForm,
): BlueprintDoc {
	const stored = doc.forms[form.uuid];
	const module = ctx.draft.modules.find((one) => one.forms.includes(form));
	const held = module === undefined ? undefined : doc.modules[module.uuid];
	const caseType = held?.caseType;
	if (
		stored === undefined ||
		held === undefined ||
		caseType === undefined ||
		(stored.type !== "followup" && stored.type !== "close") ||
		caseSelectionCardinality(held) !== "multiple" ||
		(stored.caseOperations ?? []).some((one) => one.action === "own")
	)
		return doc;
	const takenIds = new Set<string>([
		...(stored.caseOperations ?? []).map((one) => one.id),
		...(doc.fieldOrder[form.uuid] ?? []).flatMap((uuid) => {
			const field = doc.fields[uuid];
			return field === undefined ? [] : [field.id];
		}),
	]);
	const id = ownCaseOperationId(caseType, takenIds);
	const own = (uuid: Uuid): CaseOperation => ({ uuid, id, action: "own" });
	// The plan places the arm by what it holds, never by its identity, so a
	// stand-in identity finds the place the minted one is keyed by.
	const planned = (() => {
		try {
			return planPlacements(
				withCandidate(doc, (draft) => {
					const one = draft.forms[form.uuid];
					if (one !== undefined)
						one.caseOperations = [
							own(form.uuid),
							...(one.caseOperations ?? []),
						] as typeof one.caseOperations;
				}),
				form.uuid,
			).placements.get(form.uuid)?.placement;
		} catch {
			return undefined;
		}
	})();
	if (planned?.kind !== "save-to-case" || planned.repeat !== undefined)
		return doc;
	const uuid = ctx.accounting.identity(
		ctx.resolver.claim(
			externalKey.caseOperation(
				form.xmlns,
				["save-to-case", [], planned.path],
				"own",
				0,
			),
			whereText(form.place),
		),
		form.place,
		"schema:Form.actions",
	);
	if (uuid === undefined) return doc;
	return withCandidate(doc, (draft) => {
		const one = draft.forms[form.uuid];
		if (one !== undefined)
			one.caseOperations = [
				{ ...own(uuid), placement: planned },
				...(one.caseOperations ?? []),
			] as typeof one.caseOperations;
	});
}

/**
 * `doc` with each target and link the reading took for the session's case
 * that reads the id a create of the form's Case Management has from its entry
 * (the case a registration opens, a basic subcase outside a repeat) naming
 * that create: the emitter prints such a create's id as its entry's datum
 * (`casePlacementPlan.ts::planFormCaseWire`'s `datums`), and the session's
 * case as the selected case's. `doc` itself where none does.
 */
function withBasicCreateTargets(
	doc: BlueprintDoc,
	formUuid: Uuid,
	ops: readonly ProposedBlock[],
): BlueprintDoc {
	let datums: readonly { readonly operationUuid: Uuid; readonly id: string }[];
	try {
		datums = planFormCaseWire(doc, formUuid).datums;
	} catch {
		return doc;
	}
	if (datums.length === 0) return doc;
	const createOf = (text: string): Uuid | undefined =>
		datums.find((datum) =>
			sameXPathText(text, serializeForm(sessionDataRef(datum.id)), {
				ruleSet: "form",
			}),
		)?.operationUuid;
	const named = new Map<Uuid, { target?: Uuid; links: Map<string, Uuid> }>();
	for (const one of ops) {
		const target =
			one.target.kind === "session" ? createOf(one.target.text) : undefined;
		const links = new Map<string, Uuid>();
		for (const link of one.links)
			if (link.target?.kind === "session") {
				const create = createOf(link.target.text);
				if (create !== undefined) links.set(link.identifier, create);
			}
		if (target !== undefined || links.size > 0)
			named.set(one.uuid, { ...(target !== undefined && { target }), links });
	}
	if (named.size === 0) return doc;
	return withCandidate(doc, (draft) => {
		for (const operation of draft.forms[formUuid]?.caseOperations ?? []) {
			const read = named.get(operation.uuid);
			if (read === undefined) continue;
			const held = operation as {
				target?: { kind: string };
				links?: { identifier: string; target: unknown }[];
			};
			if (read.target !== undefined && held.target?.kind === "session")
				held.target = { kind: "op", opUuid: read.target } as { kind: string };
			for (const link of held.links ?? []) {
				const create = read.links.get(link.identifier);
				if (create !== undefined) link.target = { kind: "op", opUuid: create };
			}
		}
	});
}

/** The owner a new case holds (a create's, or a registration's own) where the stored one is the acting user's id. */
function withOwner(
	doc: BlueprintDoc,
	formUuid: Uuid,
	ops: readonly ProposedBlock[],
	choice: "acting-user",
): BlueprintDoc {
	return withCandidate(doc, (draft) => {
		const operations = draft.forms[formUuid]?.caseOperations ?? [];
		for (const one of ops) {
			if (one.target.kind !== "new" || one.owner?.kind !== "meta-user")
				continue;
			const operation = operations.find(
				(candidate) => candidate.uuid === one.uuid,
			);
			if (operation !== undefined)
				(operation as { owner?: Expression }).owner =
					choice === "acting-user" ? actingUser() : undefined;
		}
	});
}

/**
 * Pass 2 for one form: each accepted block's shape over the bound document
 * (test 2) and the emitter's block equal to the stored one (test 4), with
 * the reader's second candidate for an owner the stored block gives as the
 * acting user's id; then the own close read from a block of its own, over the
 * document those settled on. A block that fails is the one finding of 5.1,
 * and an own close that fails the finding its reading names.
 */
export function settleSaveToCase(ctx: ReadContext, form: DraftForm): void {
	const reading = READINGS.get(form);
	if (ctx.doc !== undefined) {
		const several = withSeveralCaseOwn(ctx, ctx.doc, form);
		if (several !== ctx.doc) ctx.doc = several;
	}
	const doc = ctx.doc;
	if (reading === undefined) {
		judgeSaveReferences(ctx, form, []);
		return;
	}
	if (doc === undefined || doc.forms[form.uuid] === undefined) {
		judgeSaveReferences(ctx, form, reading.failed);
		return;
	}
	const failing =
		reading.proposals.length === 0
			? []
			: settleProposals(ctx, doc, form, reading);
	for (const one of failing)
		ctx.accounting.finding(SAVE_TO_CASE_CLAIMS.outsideShape, one.place);
	const failed = [
		...reading.failed,
		...failing.map((one) => ({
			block: one.block,
			place: one.place,
			claim: SAVE_TO_CASE_CLAIMS.outsideShape,
		})),
	];
	// The own close, over the document the blocks settled on. One whose
	// condition the expression stage could not hold has that slot's finding,
	// and the emitter would print it without the condition.
	const ownClose = reading.ownClose;
	const condition = reading.registrations.get("own-close");
	if (
		ownClose !== undefined &&
		(condition === undefined ||
			ctx.pending.outcome(condition.index).expression !== undefined) &&
		!ownCloseHolds(ctx, ctx.doc ?? doc, form, reading)
	) {
		ctx.accounting.finding(SAVE_TO_CASE_CLAIMS.outsideShape, ownClose.place);
		failed.push({
			block: ownClose.block,
			place: ownClose.place,
			claim: SAVE_TO_CASE_CLAIMS.outsideShape,
		});
	}
	// The stored `save` map is judged once every block is: a form whose block
	// is outside Nova's shape has that finding alone.
	judgeSaveReferences(ctx, form, failed);
}

/**
 * Tests 2 and 4 for `form`'s proposals over `doc`, with the reader's second
 * candidate for an owner the stored block gives as the acting user's id and
 * its second order; the proposals that fail on the candidate kept, which
 * `ctx.doc` becomes.
 */
function settleProposals(
	ctx: ReadContext,
	doc: BlueprintDoc,
	form: DraftForm,
	reading: FormBlocks,
): ProposedBlock[] {
	// Each id the session holds for a create of the form's Case Management
	// read as that create, then each condition apart from those it inherits.
	const own = withoutInheritedConditions(
		withBasicCreateTargets(doc, form.uuid, reading.proposals),
		form.uuid,
		reading.proposals,
	);
	if (own !== doc) ctx.doc = own;
	let failing = blocksHold(ctx, own, form, reading);
	const owners = failing.filter(
		(one) => one.target.kind === "new" && one.owner?.kind === "meta-user",
	);
	if (owners.length > 0) {
		const candidate = withOwner(own, form.uuid, owners, "acting-user");
		const second = blocksHold(ctx, candidate, form, reading);
		if (second.length < failing.length) {
			ctx.doc = candidate;
			failing = second;
		}
	}
	// The second order: each block's operation directly after the operation
	// its target names, where document order is not the one the emitter takes.
	if (failing.length > 0 && ctx.doc !== undefined) {
		const candidate = withTargetOrder(ctx.doc, form.uuid);
		if (candidate !== ctx.doc) {
			const second = blocksHold(ctx, candidate, form, reading);
			if (second.length < failing.length) {
				ctx.doc = candidate;
				failing = second;
			}
		}
	}
	return failing;
}

/** Whether a write's value is a question's answer as it is, which the own
 *  arm's row leads with the question's presence and an update's does not. */
function writesAnswerAsIs(write: CaseOperationWrite): boolean {
	const value = write.value;
	return (
		value.kind === "term" &&
		((value.term.kind === "field" &&
			value.term.filters === undefined &&
			value.term.role === undefined) ||
			value.term.kind === "capture-link")
	);
}

/**
 * The reader's canonical choice between an update of the session's case
 * beside a form's own arm that changes nothing, and that form's own arm in a
 * block. In a follow-up or close form of a menu that chooses one case, the
 * update prints the block `nova_operations/<id>` beside the basic block of
 * the own arm, which writes nothing; where the update's id is the one a
 * reading gives that bare own arm (its menu's case type's), it writes no
 * answer as it is, and it takes the guards the own arm would, the own arm
 * in a block of that name prints the same bytes, and the reader reads it
 * (`readSaveToCaseBlocks`, `ownCandidate`). `doc` with each such update made
 * the form's own arm, in its place and under the UUID a reading of that place
 * mints for it (an operation's external key spells its action, so the key the
 * update held is no key of the reading); `doc` itself where no form holds one.
 */
export function updateBesideBareOwnAsOwnArm(doc: BlueprintDoc): BlueprintDoc {
	const changes: {
		formUuid: Uuid;
		own: Uuid;
		update: CaseOperation & { action: "update" };
	}[] = [];
	for (const [formUuid, form] of Object.entries(doc.forms) as [
		Uuid,
		BlueprintDoc["forms"][Uuid],
	][]) {
		if (form.type !== "followup" && form.type !== "close") continue;
		const moduleUuid = moduleUuidOfForm(doc, formUuid);
		const held = moduleUuid === undefined ? undefined : doc.modules[moduleUuid];
		const caseType = held?.caseType;
		if (
			held === undefined ||
			caseType === undefined ||
			caseSelectionCardinality(held) === "multiple"
		)
			continue;
		const operations = form.caseOperations ?? [];
		const own = operations.find((one) => one.action === "own");
		if (
			own === undefined ||
			(own.writes ?? []).length > 0 ||
			own.name !== undefined ||
			own.owner !== undefined ||
			(own.links ?? []).length > 0
		)
			continue;
		const { placements } = planPlacements(doc, formUuid);
		if (placements.get(own.uuid)?.placement.kind !== "basic") continue;
		const bareOwnId = ownCaseOperationId(caseType, new Set());
		const update = operations.find(
			(one): one is CaseOperation & { action: "update" } => {
				if (
					one.action !== "update" ||
					one.id !== bareOwnId ||
					one.target.kind !== "session" ||
					one.caseType !== caseType ||
					one.condition !== undefined ||
					one.forEach !== undefined ||
					one.retype !== undefined ||
					(one.writes ?? []).some(writesAnswerAsIs)
				)
					return false;
				const placement = placements.get(one.uuid)?.placement;
				if (
					placement?.kind !== "save-to-case" ||
					placement.repeat !== undefined ||
					placement.path.join("/") !== `nova_operations/${one.id}`
				)
					return false;
				const asOwn = {
					uuid: one.uuid,
					id: one.id,
					action: "own",
					...(one.rename !== undefined && { name: one.rename }),
					...(one.owner !== undefined && { owner: one.owner }),
					...(one.writes !== undefined && { writes: one.writes }),
					...(one.links !== undefined && { links: one.links }),
				} as CaseOperation;
				return sameKinds(operationGuardKinds(one), operationGuardKinds(asOwn));
			},
		);
		if (update !== undefined) changes.push({ formUuid, own: own.uuid, update });
	}
	if (changes.length === 0) return doc;
	const converted = withCandidate(doc, (draft) => {
		for (const { formUuid, own, update } of changes) {
			const form = draft.forms[formUuid];
			if (form?.caseOperations === undefined) continue;
			const arm = {
				uuid: update.uuid,
				id: update.id,
				action: "own",
				...(update.rename !== undefined && { name: update.rename }),
				...(update.owner !== undefined && { owner: update.owner }),
				...(update.writes !== undefined && { writes: update.writes }),
				...(update.links !== undefined && { links: update.links }),
				...(update.placement !== undefined && { placement: update.placement }),
			} as CaseOperation;
			form.caseOperations = [
				arm,
				...form.caseOperations.filter(
					(one) => one.uuid !== own && one.uuid !== update.uuid,
				),
			] as typeof form.caseOperations;
		}
	});
	// The own arm takes the UUID its block's key mints, as a reading gives it.
	const keyOf = new Map(
		externalIdentityMap(converted, DERIVED_WIRE_IDENTITY).map((entry) => [
			entry.uuid,
			entry,
		]),
	);
	return withCandidate(converted, (draft) => {
		for (const { formUuid, update } of changes) {
			const arm = draft.forms[formUuid]?.caseOperations?.find(
				(one) => one.uuid === update.uuid,
			);
			const entry = keyOf.get(update.uuid);
			if (arm === undefined || entry === undefined) continue;
			arm.uuid = mintEntityUuid(doc.appId, entry);
		}
	});
}
