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
import {
	AUTHORED_CASE_ID_VERSION,
	type BlueprintDoc,
	type CaseOperation,
	type CaseOperationLink,
	type CaseOperationWrite,
	type Expression,
	isCaseOperationIdentifier,
	MAX_AUTHORED_CASE_KEY_LENGTH,
	ownCaseOperationId,
	type Uuid,
} from "@/lib/domain";
import { actingUser, term, unowned } from "@/lib/domain/expression/builders";
import type { SlotContextRef } from "@/lib/domain/expression/types";
import type { FindingDetail, HqPlace } from "@/lib/publish/hqFindings";
import { expandDoc } from "../../expander";
import { USERCASE_ID_FUNCTION } from "../../usercaseWire";
import { captureUrlCalculate } from "../../xform/captureUrlNode";
import {
	caseScalarTextValueCalculation,
	type SaveToCaseBlockSegment,
	saveToCaseBlockShape,
} from "../../xform/caseOps";
import { caseSaveReferencesOf } from "../../xform/caseSaveReferences";
import { GUARD_KINDS, generatedBaseName } from "../../xform/generatedNodes";
import { type FormSyntax, readFormSyntax } from "../../xpath/formSyntax";
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
import { externalKey } from "../identity";
import { isJsonObject, sameJson } from "../jsonCursor";
import { pendingPlaceholder } from "../pendingExpressions";
import { questionPlace, whereText } from "../place";
import { readProjectionInputs } from "../projectionInputs";
import { caseReferencesOf } from "../structure";
import { sameXPathText } from "../syntaxCompare";
import type { DraftField, ReadSaveToCaseBlock, ReadXForm } from "../xform";
import { HOLE, isAllocatedName, matchesTemplate } from "../xform/generated";
import { type DataNode, pathSteps } from "../xform/model";
import { advancedCaseReading } from "./advancedActions";
import { basicCaseReading } from "./basicActions";
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
	hyphenated: derived(
		`${Q}/savetocase-property-names-with-hyphens-a-z-w-case-insensitive`,
		MUG,
	),
	owner: derived(`${Q}/savetocase-owner`, MUG),
	link: derived(
		`${Q}/savetocase-link-index-name-child-extension-and-unlink-empty`,
		MUG,
	),
	inRepeat: derived(`${Q}/savetocase-inside-a-repeat`, MUG),
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
	| { readonly kind: "session" }
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
		| { readonly kind: "capture"; readonly field: DraftField };
	readonly condition?: { readonly text: string; readonly site: ClaimSite };
}

interface ProposedLink {
	readonly identifier: string;
	readonly targetType: string;
	readonly relationship: "child" | "extension";
	readonly target:
		| null
		| { readonly kind: "op"; readonly path: string }
		| { readonly kind: "session" }
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
	readonly name?: { readonly text: string; readonly site: ClaimSite };
	readonly owner?: ProposedOwner;
	readonly rename?: { readonly text: string; readonly site: ClaimSite };
	readonly retype?: string;
	readonly writes: readonly ProposedRow[];
	readonly links: readonly ProposedLink[];
	readonly condition?: { readonly text: string; readonly site: ClaimSite };
	/** A close in the block: an operation's own close, or the own close's condition. */
	readonly closes: boolean;
	readonly closeCondition?: { readonly text: string; readonly site: ClaimSite };
	readonly place: HqPlace;
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
	/** The own close read from a block of its own. */
	ownClose?: {
		readonly path: readonly [string, ...string[]];
		readonly condition?: { readonly text: string; readonly site: ClaimSite };
	};
}

const READINGS = new WeakMap<DraftForm, FormBlocks>();

/** What pass 1 read of a form's Save to Case blocks. */
export function saveToCaseReading(form: DraftForm): FormBlocks | undefined {
	return READINGS.get(form);
}

const CONTAINER_SEGMENT: Readonly<Record<string, SaveToCaseBlockSegment>> = {
	operations: "operations",
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

/** The binds of `form` on paths under `prefix`, by path relative to it. */
function bindsUnder(
	xform: ReadXForm,
	prefix: readonly string[],
): Map<string, Element> {
	const root = xform.parsed.dataRoot.name;
	const out = new Map<string, Element>();
	for (const element of xform.parsed.binds) {
		const steps = pathSteps(
			element.attribs.nodeset ?? element.attribs.ref ?? "",
		);
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
		if (keyed) {
			const keyedId = keyedKey(idCalculate);
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
		name = {
			text: untrimmed(nameText).text,
			site: site("case/create/case_name", "calculate"),
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
	const presenceApplies =
		!creates && (target.kind === "session" || target.kind === "worker-record");
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
			if (property === "case_name") {
				rename = {
					text: untrimmed(text).text,
					site: { element: bind, attribute: "calculate" },
				};
				continue;
			}
			if (property === "owner_id") {
				if (bind.attribs.relevant !== undefined)
					return fail(SAVE_TO_CASE_CLAIMS.ownerCondition);
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
				[...casePath, "update", property],
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
	const selected = inside(
		text,
		w.append(caseById(holeWire(), "casedb", caseType), [w.attr("case_id")]),
	);
	if (selected !== undefined)
		return { kind: "expression", text: selected, site };
	return { kind: "session" };
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

/** The conjuncts of `text` that the inherited conditions of `conditions` restate, taken off the front. */
function withoutInherited(
	text: string,
	inherited: readonly string[],
): string | undefined {
	const tree = parse(text);
	if (tree === undefined || inherited.length === 0) return text;
	const parts = conjuncts(tree);
	let drop = 0;
	for (const part of parts) {
		const own = text.slice(part.from, part.to);
		if (!inherited.some((one) => sameXPathText(one, own, { ruleSet: "form" })))
			break;
		drop += 1;
	}
	if (drop === 0) return text;
	if (drop >= parts.length) return undefined;
	return conjunction(text, parts.slice(drop));
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
			reading.failed.push({
				block,
				place,
				claim: read.claim ?? SAVE_TO_CASE_CLAIMS.outsideShape,
				...(read.detail !== undefined && { detail: read.detail }),
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
		proposed.map(
			({ read }) => read.block.path[read.block.path.length - 1] as string,
		),
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
	const ownCandidate =
		!ownTaken &&
		menuType !== undefined &&
		(type === "followup" || type === "close")
			? proposed.find(
					({ read }) =>
						read.kind !== "create" &&
						read.caseType === menuType &&
						read.target.kind === "session" &&
						read.block.repeat === null &&
						read.segments.join("/") === "operations/block",
				)
			: undefined;

	// Mint, register and record each proposal.
	// Free among the form's ids: its root questions' and the operations its
	// actions already gave.
	const takenIds = new Set<string>();
	for (const field of xform.childrenOf(null)) takenIds.add(field.id);
	for (const one of basicCaseReading(form)?.operations ?? [])
		takenIds.add(one.id);
	for (const one of advancedCaseReading(form)?.operations ?? [])
		takenIds.add(one.id);
	const counts = new Map<string, number>();
	for (const { read } of proposed) {
		const own = read === ownCandidate?.read;
		const action: ProposedBlock["action"] = own ? "own" : read.kind;
		const blockName = read.block.path[read.block.path.length - 1] as string;
		const id =
			isCaseOperationIdentifier(blockName) && !takenIds.has(blockName)
				? blockName
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
		reading.proposals.push({ ...read, uuid, id, action });
	}
	// The own close in a block of its own: a close-only block of the own case
	// in a condition group under the root operations container.
	if (type === "followup" || type === "close" || type === "registration") {
		const ownClose = reading.proposals.find(
			(one) =>
				one.action === "close" &&
				one.caseType === menuType &&
				one.target.kind === "session" &&
				one.block.repeat === null &&
				one.writes.length === 0 &&
				one.segments.join("/") === "operations/condition/block" &&
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
			};
		}
	}
	// The inherited guards: an operation that reads an earlier conditional
	// create stands under that create's condition too.
	const createConditions = new Map<string, string>();
	for (const one of reading.proposals)
		if (one.action === "create" && one.condition !== undefined)
			createConditions.set(
				`/${root}/${[...one.block.path, "case", "@case_id"].join("/")}`,
				one.condition.text,
			);
	reading.proposals.forEach((one, i) => {
		if (one.action === "create" || one.condition === undefined) return;
		const inherited: string[] = [];
		if (one.target.kind === "op") {
			const text = createConditions.get(one.target.path);
			if (text !== undefined) inherited.push(text);
		}
		for (const link of one.links)
			if (link.target !== null && link.target.kind === "op") {
				const text = createConditions.get(link.target.path);
				if (text !== undefined) inherited.push(text);
			}
		const own = withoutInherited(one.condition.text, inherited);
		reading.proposals[i] =
			own === undefined
				? withoutCondition(one)
				: { ...one, condition: { text: own, site: one.condition.site } };
	});

	for (const failed of reading.failed) refuseBlock(xform, failed);
	claimAccepted(ctx, xform, reading);
	registerTexts(ctx, form, reading);
	READINGS.set(form, reading);
}

function withoutCondition(one: ProposedBlock): ProposedBlock {
	const { condition: _condition, ...rest } = one;
	return rest;
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
		note(one.name?.site);
		if (one.owner?.kind === "text") note(one.owner.site);
		note(one.rename?.site);
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
			claim:
				one.action === "create" || one.action === "own"
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
		if (one.name !== undefined)
			register(
				`${op} name`,
				caseSlot(form.uuid, "case_operation_name", op),
				one.name.text,
				one.name.site,
				one.place,
				CALC,
			);
		if (one.rename !== undefined)
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
		if (one.condition !== undefined)
			register(
				`${op} condition`,
				caseSlot(form.uuid, "case_operation_condition", op),
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
					? one.action === "create" && ownerChoice === "absent"
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
	const common = {
		uuid: one.uuid,
		id: one.id,
		...(writes.length > 0 && { writes }),
		placement,
	};
	if (one.action === "own")
		return {
			...common,
			action: "own",
			...(one.rename !== undefined && { name: placeholder("value") }),
			...(owner !== undefined && { owner }),
			...(links.length > 0 && { links }),
		} as CaseOperation;
	if (one.action === "create") {
		const idFrom =
			one.target.kind === "new" ? one.target.idFrom?.uuid : undefined;
		return {
			...common,
			action: "create",
			caseType: one.caseType,
			target: { kind: "new", ...(idFrom !== undefined && { idFrom }) },
			name: placeholder("value"),
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
		if (one.action === "create")
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
	// Each proposal's block and wrappers are judged with it, never as another's guard.
	const apart = new Set(
		reading.proposals.flatMap((one) => [
			one.block.path.join("/"),
			...one.block.wrappers.map((wrapper) => wrapper.path.join("/")),
		]),
	);
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

/** The owner a create holds where the stored one is the acting user's id. */
function withOwner(
	doc: BlueprintDoc,
	formUuid: Uuid,
	ops: readonly ProposedBlock[],
	choice: "acting-user",
): BlueprintDoc {
	return withCandidate(doc, (draft) => {
		const operations = draft.forms[formUuid]?.caseOperations ?? [];
		for (const one of ops) {
			if (one.action !== "create" || one.owner?.kind !== "meta-user") continue;
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
 * acting user's id. A block that fails is the one finding of 5.1.
 */
export function settleSaveToCase(ctx: ReadContext, form: DraftForm): void {
	const reading = READINGS.get(form);
	const doc = ctx.doc;
	if (reading === undefined) {
		judgeSaveReferences(ctx, form, []);
		return;
	}
	if (
		doc === undefined ||
		doc.forms[form.uuid] === undefined ||
		reading.proposals.length === 0
	) {
		judgeSaveReferences(ctx, form, reading.failed);
		return;
	}
	let failing = blocksHold(ctx, doc, form, reading);
	const owners = failing.filter(
		(one) => one.action === "create" && one.owner?.kind === "meta-user",
	);
	if (owners.length > 0) {
		const candidate = withOwner(doc, form.uuid, owners, "acting-user");
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
	for (const one of failing)
		ctx.accounting.finding(SAVE_TO_CASE_CLAIMS.outsideShape, one.place);
	// The stored `save` map is judged once every block is: a form whose block
	// is outside Nova's shape has that finding alone.
	judgeSaveReferences(ctx, form, [
		...reading.failed,
		...failing.map((one) => ({
			block: one.block,
			place: one.place,
			claim: SAVE_TO_CASE_CLAIMS.outsideShape,
		})),
	]);
}
