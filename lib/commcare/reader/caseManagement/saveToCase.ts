/**
 * Save to Case blocks (`vellum:role="SaveToCase"`) read into case operations,
 * in the one shape Nova's emitter writes them. A block is Nova's own exactly
 * where four tests hold: 1, it stands under Nova's wrappers alone
 * (position); 2, its content gives one operation whose block shape has its
 * path's segments (shape); 3, every guard beside it belongs to an operation
 * read here (guards); and 4, the emitter, given the document, writes the same
 * block (content, `settleSaveToCase`). Every other block is one finding at its place.
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
	type BlueprintDoc,
	type CaseOperation,
	type CaseOperationLink,
	type CaseOperationWrite,
	caseDataTypeForFieldKind,
	caseScalarTextGuardIsChecked,
	caseSelectionCardinality,
	type Expression,
	formFieldCanKeyCreate,
	isAuthoredCaseIdPrefix,
	isCaseOperationIdentifier,
	isCaseOperationProperty,
	isCaseScalarTextProperty,
	MAX_AUTHORED_CASE_KEY_LENGTH,
	ownCaseOperationId,
	prepareCaseScalarTextValue,
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
import {
	caseOperationLinkNameProblem,
	sourceWritePropertyProblem,
	stopsFormBuilder,
} from "@/lib/domain/questionId";
import { NO_ENTRIES, recordFromEntries } from "@/lib/domain/records";
import { FORBIDDEN_CASE_OPERATION_WRITE_PROPERTIES } from "@/lib/domain/standardCaseProperties";
import type { FindingDetail, HqPlace } from "@/lib/publish/hqFindings";
import { planFormCaseWire } from "../../casePlacementPlan";
import {
	MAX_CASE_INDEX_IDENTIFIER_LENGTH,
	MAX_CASE_PROPERTY_LENGTH,
} from "../../constants";
import { expandDoc } from "../../expander";
import { sessionDataRef } from "../../formLinkProjection";
import { isMultiSelectMenu } from "../../hq/publishedCaseBlocks";
import { planPlacements } from "../../placement";
import { type SourceTable, tableOf } from "../../sourceKeys";
import { USERCASE_ID_FUNCTION } from "../../usercaseWire";
import { caseOperationCaseTypeNameProblem } from "../../validator/rules/caseOperations";
import { DERIVED_WIRE_IDENTITY } from "../../wireIdentity";
import { rethrowWorkStop } from "../../workMeter";
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
import { attributeNamespace, VELLUM_NS } from "../../xmlNamespaces";
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
import { EXPRESSION_CLAIMS } from "../expressions/findings";
import { printSlot } from "../expressions/readExpression";
import { externalKey } from "../identity";
import { externalIdentityMap, reReadUuidOf } from "../identityMap";
import { isJsonObject, sameJson } from "../jsonCursor";
import { pendingPlaceholder } from "../pendingExpressions";
import { questionPlace, whereText } from "../place";
import { readProjectionInputs } from "../projectionInputs";
import { caseReferencesOf } from "../structure";
import { sameXPathText, sourceFormExpression } from "../syntaxCompare";
import { readFormSyntax } from "../syntaxRead";
import type { ReadMenuAndFormIdentities } from "../types";
import { holdsWorkerRecordWrite } from "../worldEntities";
import {
	type DraftField,
	expressionEnvOf,
	type ReadSaveToCaseBlock,
	type ReadXForm,
} from "../xform";
import { coreControlPath } from "../xform/body";
import { X } from "../xform/claims";
import {
	HOLE,
	isAllocatedName,
	matchesTemplate,
	matchesTemplateIn,
} from "../xform/generated";
import { type DataNode, pathSteps, resolveContextPath } from "../xform/model";
import type { StandingRefusal } from "../xform/refusals";
import { qualifiedAttribute, type XmlNode } from "../xmlCursor";
import {
	advancedCaseReading,
	nameAdvancedOperationsPast,
} from "./advancedActions";
import {
	basicCaseReading,
	dropCreateNameRequired,
	nameBasicOperationsPast,
	refusedCaseManagement,
} from "./basicActions";
import {
	blockTreesEqual,
	type EarlierSpelling,
	emittedFormSource,
	type FormSourceModel,
	type HeldSlotPrint,
	modelNodeAt,
	storedFormSource,
} from "./saveToCaseCompare";

const Q = "questions";
const F = "forms-and-case-writes";
const MUG = "mug:SaveToCase";

/** A Save to Case expression outside the typed vocabulary of its slot, the
 *  expression stage's entry. */
const OUTSIDE_VOCABULARY =
	EXPRESSION_CLAIMS[
		"savetocase-expressions-outside-nova-s-typed-vocabularies-case-id"
	];

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
	/** A create outside a repeat whose id a bind calculates, which HQ's form builder writes
	 *  again as an `xforms-ready` setvalue on its next save (`saveToCase.js`). */
	liveCreateId: refuse(
		`${Q}/create-case-id-live-calculate-outside-a-repeat`,
		"xform:model/bind@calculate",
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
	reservedKey: refuse(
		`${Q}/savetocase-update-key-nova-reserves-for-a-case-s-own-facts`,
		"xform:model/instance//*",
	),
	workerKey: refuse(
		`${F}/a-write-of-the-worker-s-record-to-a-key-no-worker-property-takes`,
		"xform:model/instance//*",
	),
	workerFacet: refuse(
		`${Q}/a-savetocase-update-of-commcare-user-under-a-condition-or-inside-a-repeat`,
		MUG,
	),
	/** A form that writes the worker's record in a Save to Case block of
	 *  `commcare-user` and in another update of it, a block or Case
	 *  Management's (`index.ts::settleCaseChanges`). */
	workerTwice: refuse(
		`${Q}/a-savetocase-update-of-commcare-user-beside-another-update-of-the-worker-s-record`,
		MUG,
	),
	/** A block a device refuses on every submission: its case id is the case a
	 *  menu chooses on a form that chooses none, or a blank literal, or it links
	 *  its case to itself (`index.ts::settleCaseChanges`, over the gate; and
	 *  `readBlock`, where the source spells a blank literal id, or a link whose
	 *  value is the block's own case id, which no gate document carries). */
	deviceRefuses: refuse(
		`${Q}/a-savetocase-change-a-device-refuses-a-blank-case-id-or-a-link-of-its-case-to-itself`,
		MUG,
	),
	/** A block's, a `case_type` row's or a link's case type the gate refuses by
	 *  its name: outside the case type grammar, or longer than 255 characters
	 *  (`readBlock`, over `caseOperationCaseTypeNameProblem`). */
	caseTypeName: refuse(
		`${Q}/a-savetocase-case-type-outside-the-case-type-grammar-or-longer-than-255-characters`,
		MUG,
	),
	/** A link whose name is longer than CommCare HQ's index column holds
	 *  (`readBlock`). */
	linkTooLong: refuse(
		`${Q}/a-savetocase-link-name-longer-than-commcare-hq-stores`,
		MUG,
	),
	/** A block that names the case it changes, or a link names the case it
	 *  points to, by a type other than the one that case holds there, with no
	 *  type change behind it (`index.ts::settleCaseChanges`). */
	declaredType: refuse(
		`${Q}/a-savetocase-change-whose-case-type-is-not-the-type-of-the-case-it-reaches`,
		MUG,
	),
	/** A `case_type` row that gives a case a type holding one of the earlier
	 *  type's properties as another type (`index.ts::settleCaseChanges`). */
	retypeConverts: refuse(
		`${Q}/a-savetocase-change-of-a-case-s-type-to-a-type-that-holds-one-of-its-properties-as-another-type`,
		MUG,
	),
	/** A block that links to the case a menu chooses, or whose case id, value or
	 *  condition reads that case, on a form whose menu chooses none
	 *  (`index.ts::settleCaseChanges`). */
	readsMenuCase: refuse(
		`${Q}/a-savetocase-change-that-reads-the-case-a-menu-chooses-on-a-form-whose-menu-chooses-none`,
		MUG,
	),
	/** A form whose Save to Case block writes a property of the form's own
	 *  case the form's own change also writes, or closes that case beside it
	 *  (`index.ts::settleCaseChanges`). */
	ownCaseBeside: refuse(
		`${Q}/a-savetocase-change-of-the-form-s-own-case-beside-the-form-s-own-change-of-it`,
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
	updateBind: derived(
		`${Q}/savetocase-update-case-id-xpath`,
		"xform:model/bind@calculate",
	),
	rows: derived(
		`${Q}/savetocase-property-rows-calculation-condition-lifting-into`,
		MUG,
	),
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

// ── Where a region's claims are recorded ──────────────────────────────────

/** An element of an instance's content that is a child of the data root, as the lane names it. */
const TOP = "xform:model/instance/*/*";
/** An element of an instance's content one deeper or more. */
const NESTED = "xform:model/instance//*";

/** The surface keys a Save to Case region's nodes are recorded under, as the lane names each
 *  (`proof/checks/manifest_usage.py::xform_vocabulary`): a data node by its depth, its
 *  `jr:template` and its form builder role and case type; a bind and the attributes the region
 *  writes on one; a setvalue and its three; a body group and repeat and theirs; and the type HQ's
 *  question reader gives a node of the region (`xform.py::XForm.get_questions`: a group or a
 *  repeat its control names, a leaf no control names a Hidden Value). */
const REGION_KEYS = [
	TOP,
	NESTED,
	`${TOP}@jr:template`,
	`${NESTED}@jr:template`,
	"vellum-markup:model/instance//*@vellum:role",
	"vellum-markup:model/instance//*@vellum:case_type",
	"xform:model/bind",
	"xform:model/bind@nodeset",
	"xform:model/bind@calculate",
	"xform:model/bind@relevant",
	"xform:model/bind@type",
	"xform:setvalue",
	"xform:setvalue@event",
	"xform:setvalue@ref",
	"xform:setvalue@value",
	"xform:group",
	"xform:group@ref",
	"xform:repeat",
	"xform:repeat@nodeset",
	"xform:repeat@jr:count",
	"xform:repeat@jr:noAddRemove",
	"mug:Group",
	"mug:Repeat",
	"mug:DataBindOnly",
] as const;
type RegionKey = (typeof REGION_KEYS)[number];

/** One entry's claims of a use under each surface key of `keys`, registered as
 *  `<entry less its area>@<key>`. */
function regionClaims<U extends "take" | "derived">(
	use: U,
	entry: string,
	keys: readonly RegionKey[],
): ReadonlyMap<RegionKey, Claim<U>> {
	const short = entry.slice(entry.indexOf("/") + 1);
	const claims = new Map<RegionKey, Claim<U>>();
	const named = recordFromEntries<Claim>([]);
	for (const key of keys) {
		const claim = (
			use === "take" ? take(entry, key) : derived(entry, key)
		) as Claim<U>;
		claims.set(key, claim);
		named[`${short}@${key}`] = claim;
	}
	defineClaims("caseManagement.saveToCase", named);
	return claims;
}

/** A block's own keys: its data node, the form builder's role and case type on it, and the
 *  Hidden Value HQ's question reader reads each leaf of it as. */
const BLOCK_KEYS: readonly RegionKey[] = [
	TOP,
	NESTED,
	"vellum-markup:model/instance//*@vellum:role",
	"vellum-markup:model/instance//*@vellum:case_type",
	"mug:DataBindOnly",
];
/** The keys of a block's binds and setvalues: the bind and the attributes the region writes on
 *  one, and a setvalue and its three. */
const BIND_KEYS: readonly RegionKey[] = [
	"xform:model/bind",
	"xform:model/bind@nodeset",
	"xform:model/bind@calculate",
	"xform:model/bind@relevant",
	"xform:model/bind@type",
	"xform:setvalue",
	"xform:setvalue@event",
	"xform:setvalue@ref",
	"xform:setvalue@value",
];

/** The claims of a region's held nodes, by the entry each is claimed under and the key it is
 *  recorded at. */
const REGION = {
	create: regionClaims(
		"take",
		`${Q}/savetocase-create-case-type-literal-case-name-owner-id-uuid-case`,
		BLOCK_KEYS,
	),
	update: regionClaims(
		"take",
		`${Q}/savetocase-update-case-id-xpath`,
		BLOCK_KEYS,
	),
	inRepeat: regionClaims("take", `${Q}/savetocase-inside-a-repeat`, BLOCK_KEYS),
	hyphenated: regionClaims(
		"take",
		`${Q}/savetocase-property-names-with-hyphens-a-z-w-case-insensitive`,
		BLOCK_KEYS,
	),
	createBind: regionClaims(
		"derived",
		`${Q}/savetocase-create-case-type-literal-case-name-owner-id-uuid-case`,
		BIND_KEYS,
	),
	updateBind: regionClaims(
		"derived",
		`${Q}/savetocase-update-case-id-xpath`,
		BIND_KEYS,
	),
	link: regionClaims(
		"derived",
		`${Q}/savetocase-link-index-name-child-extension-and-unlink-empty`,
		[NESTED],
	),
	rows: regionClaims(
		"derived",
		`${Q}/savetocase-property-rows-calculation-condition-lifting-into`,
		REGION_KEYS,
	),
	conditionGroup: regionClaims(
		"derived",
		`${Q}/savetocase-inside-a-group-whose-display-condition-gates-it`,
		[
			TOP,
			NESTED,
			"xform:group",
			"xform:group@ref",
			"xform:model/bind@relevant",
			"mug:Group",
		],
	),
};

/** The surface key the lane names a node of a form's case region by, with the claims at hand;
 *  null for an attribute of an instance's content that Core copies as answer data, which no
 *  surface item holds; undefined where the lane names none of `REGION_KEYS` there. */
function regionKey(
	xform: ReadXForm,
	node: XmlNode,
): RegionKey | null | undefined {
	const { element, attribute } = node;
	const local = localName(element);
	const content = inInstanceContent(element);
	const top = element.parent === xform.parsed.dataRoot;
	if (attribute === undefined) {
		if (content) return top ? TOP : NESTED;
		if (local === "bind") return "xform:model/bind";
		if (local === "setvalue") return "xform:setvalue";
		if (local === "group") return "xform:group";
		if (local === "repeat") return "xform:repeat";
		return undefined;
	}
	const scope = xform.parsed.scope(element);
	const named = qualifiedAttribute(attribute, scope);
	if (content) {
		if (named === "jr:template")
			return top ? `${TOP}@jr:template` : `${NESTED}@jr:template`;
		if (named === "vellum:role")
			return "vellum-markup:model/instance//*@vellum:role";
		if (named === "vellum:case_type")
			return "vellum-markup:model/instance//*@vellum:case_type";
		return attributeNamespace(attribute, scope) === VELLUM_NS
			? undefined
			: null;
	}
	const key = `xform:${local === "bind" ? "model/bind" : local}@${named}`;
	return (REGION_KEYS as readonly string[]).includes(key)
		? (key as RegionKey)
		: undefined;
}

/** Whether an element is inside an instance, as answer data or an inline instance's rows. */
function inInstanceContent(element: Element): boolean {
	for (let at = element.parent; at !== null && isTag(at); at = at.parent)
		if (localName(at) === "instance") return true;
	return false;
}

/** The type HQ's question reader gives a data node of the region: a group or a repeat its body
 *  control names, else a leaf, which no control names, a Hidden Value; undefined for any other. */
function regionQuestion(
	node: Element,
	controls: ReadonlyMap<Element, "group" | "repeat">,
): RegionKey | undefined {
	const control = controls.get(node);
	if (control === "group") return "mug:Group";
	if (control === "repeat") return "mug:Repeat";
	return children(node).length === 0 ? "mug:DataBindOnly" : undefined;
}

/** Claims a node of the region under the claim of `claims` keyed by where it sits
 *  (`regionKey`): an attribute Core copies as answer data as part of the element's claim, and
 *  a node no key names under `fallback`. */
function claimRegionNode(
	xform: ReadXForm,
	node: XmlNode,
	claims: ReadonlyMap<RegionKey, Claim<"derived">>,
	fallback: Claim<"derived">,
): void {
	const key = regionKey(xform, node);
	if (key === null) {
		xform.cursor.partOf(node, fallback);
		return;
	}
	const claim = key === undefined ? undefined : claims.get(key);
	xform.cursor.derived(node, claim ?? fallback);
	const type = bindType(node);
	if (type !== undefined) xform.cursor.within(node, claim ?? fallback, [type]);
}

/** The `jr-type:` item a bind's `type` names, as Core reads it (`XFormParser.getDataType`: the
 *  part after the prefix); undefined for any other node. */
function bindType(node: XmlNode): string | undefined {
	if (node.attribute !== "type" || localName(node.element) !== "bind")
		return undefined;
	if (inInstanceContent(node.element)) return undefined;
	const text = node.element.attribs.type;
	if (text === undefined) return undefined;
	const colon = text.indexOf(":");
	return `jr-type:${colon < 0 ? text : text.slice(colon + 1)}`;
}

/** A block's case's attributes HQ's question reader reads as questions. */
const CASE_ATTRIBUTE_QUESTIONS: ReadonlySet<string> = new Set([
	"case_id",
	"user_id",
	"date_modified",
]);

/** Records, under the claim that covers a subtree, each element and attribute inside it at the
 *  key the lane names it by (`regionKey`), and the type HQ's question reader gives each data node
 *  of it (`regionQuestion`). */
function recordWithin(
	xform: ReadXForm,
	root: Element,
	claim: Claim,
	controls: ReadonlyMap<Element, "group" | "repeat">,
): void {
	for (const element of [root, ...descendants(root)]) {
		if (element !== root) {
			const key = regionKey(xform, { element });
			if (key !== undefined && key !== null)
				xform.cursor.within({ element }, claim, [key]);
		}
		if (inInstanceContent(element)) {
			const question = regionQuestion(element, controls);
			if (question !== undefined)
				xform.cursor.within({ element }, claim, [question]);
		}
		for (const attribute of Object.keys(element.attribs)) {
			if (attribute === "xmlns" || attribute.startsWith("xmlns:")) continue;
			const key = regionKey(xform, { element, attribute });
			if (key !== undefined && key !== null)
				xform.cursor.within({ element, attribute }, claim, [key]);
			// HQ's question reader reads each of a block's case's own attributes as a Hidden Value
			// (`xform.py::XForm.get_questions`, `<case>/@case_id`, `@user_id`, `@date_modified`).
			if (
				localName(element) === "case" &&
				inInstanceContent(element) &&
				CASE_ATTRIBUTE_QUESTIONS.has(attribute)
			)
				xform.cursor.within({ element, attribute }, claim, [
					"mug:DataBindOnly",
				]);
			const type = bindType({ element, attribute });
			if (type !== undefined)
				xform.cursor.within({ element, attribute }, claim, [type]);
		}
	}
}

/** The register row a date and time saved in the spelling Nova wrote before falls under. */
const DATETIME_REGISTER = "date-and-time-saved-as-hq-stores-it";

/**
 * Each stored row bind whose value is a date and time in the spelling Nova
 * wrote before (`typedInstantValue` of the whole value, with no clock node),
 * by the bind: the value inside it, the row's path and the block's name. The
 * row is the same write as Nova's current print of that value, which test 4
 * compares by the value each holds (`earlierSpelling`).
 */
const EARLIER_ROWS = new WeakMap<
	Element,
	{
		readonly value: string;
		readonly rowPath: readonly string[];
		readonly blockName: string;
	}
>();

// ── Paths ───────────────────────────────────────────────────────────────

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

/** What `template`'s hole holds in `node`, a node of the tree read from `text`, as `text`'s own
 *  text: `inside` of the node's span, with the span read once with the whole text. */
function insideNode(
	node: FormSyntax,
	text: string,
	template: WireExpr,
): string | undefined {
	const hole = matchesTemplateIn(node, template, HOLE);
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
		/** The node in the block whose value makes the class, where the refusal's record stands,
		 *  where that is not the block's own node (an attachment, a reserved row). */
		readonly at?: XmlNode;
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

/** The place of the block a reading's operation `uuid` was read from. */
export function saveToCaseBlockPlace(
	form: DraftForm,
	uuid: Uuid,
): HqPlace | undefined {
	return READINGS.get(form)?.proposals.find((one) => one.uuid === uuid)?.place;
}

/** What pass 1 read of a form's Save to Case blocks. */
export function saveToCaseReading(form: DraftForm): FormBlocks | undefined {
	return READINGS.get(form);
}

const CONTAINER_SEGMENT: SourceTable<SaveToCaseBlockSegment> = tableOf({
	operations: "operations",
	// The group a published placement keeps a child's block in, which the
	// emitter writes where an operations group would stand (`caseOps.ts`,
	// `keptInSubcases`), under the placement's own path.
	subcases: "operations",
	condition: "condition",
	keyed: "keyed",
	"selected-cases": "selected-cases",
	"selected-case": "selected-case",
});

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

/** Every element under `element`, in document order. */
function descendants(element: Element): Element[] {
	return children(element).flatMap((child) => [child, ...descendants(child)]);
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
			steps: pathSteps(element.attribs.nodeset ?? ""),
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

/** Each bind under `prefix` after the first on its node (`bindsUnder` holds
 *  the first), which the xform stage reads as no bind of its node
 *  (`xform/model.ts::readBinds`): a block that holds one is no block Nova
 *  writes, and it stands under the block's finding. */
function laterBindsUnder(
	xform: ReadXForm,
	prefix: readonly string[],
): Element[] {
	const first = new Set(bindsUnder(xform, prefix).values());
	const root = xform.parsed.dataRoot.name;
	return xform.parsed.binds.filter((element) => {
		if (first.has(element)) return false;
		const steps = pathSteps(element.attribs.nodeset ?? "");
		if (steps === undefined || steps[0] !== "/" || steps[1] !== root)
			return false;
		const path = steps.slice(2);
		return (
			path.length >= prefix.length &&
			prefix.every((step, i) => path[i] === step)
		);
	});
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
	/** The entry a failing block is, where the manifest names its class; else the block-shape entry. */
	readonly claim?: Claim<"refuse">;
	readonly detail?: FindingDetail;
	/** The node whose value makes a failing block's class, where that is not the block's own. */
	readonly at?: XmlNode;
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
			: resolveContextPath(node, context, xform.parsed.dataRoot.name);
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

/** The capture `text` builds HQ's form-attachment address over, as Nova's
 *  emitter writes it (`xform/captureUrlNode.ts::captureUrlCalculate`), where it
 *  builds one. */
function captureAddressOf(ctx: ReadContext, text: string): string | undefined {
	return inside(
		text,
		captureUrlCalculate(holeWire(), {
			origin: ctx.input.target.origin,
			domain: ctx.input.target.domain,
		}),
	);
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
	const capture = captureAddressOf(ctx, text);
	if (capture !== undefined) {
		const node = parse(capture);
		const path =
			node === undefined ? undefined : resolveContextPath(node, rowPath, root);
		const field = path === undefined ? undefined : fieldAt(xform, path);
		if (field !== undefined)
			return { value: { kind: "capture", field }, text, earlier: false };
	}
	const earlier = inside(text, typedInstantValue(holeWire()));
	if (earlier !== undefined)
		return { value: undefined, text: earlier, earlier: true };
	return {
		value: undefined,
		text: leafValues(text, rowPath, storedClockNodes(xform, blockName)),
		earlier: false,
	};
}

/**
 * Where a row's value may read a clock node: the form's root name, and the
 * calculate of the node at a path where that node is one the allocator names
 * for the block's operation (`generatedBaseName("instant", <the block's
 * name>, n)`), else undefined. The stored form's and the emitted form's are
 * read alike, so a row in the spelling Nova wrote before can be compared with
 * the emitter's by the value both hold.
 */
interface ClockNodes {
	readonly root: string;
	readonly calculateAt: (path: readonly string[]) => string | undefined;
}

/** Whether `name` is one of the first `bound` clock node names of the block named `blockName`. */
function isClockNodeName(
	name: string,
	blockName: string,
	bound: number,
): boolean {
	for (let n = 1; n <= bound; n += 1)
		if (
			isAllocatedName(name, generatedBaseName("instant", blockName, String(n)))
		)
			return true;
	return false;
}

function storedClockNodes(xform: ReadXForm, blockName: string): ClockNodes {
	return {
		root: xform.parsed.dataRoot.name,
		calculateAt: (path) => {
			const target = xform.nodes.get(path.join("/"));
			if (
				target === undefined ||
				!isClockNodeName(target.name, blockName, xform.caseRegion.length)
			)
				return undefined;
			return xform.binds.get(target)?.logic.calculate;
		},
	};
}

function emittedClockNodes(
	emitted: FormSourceModel,
	blockName: string,
): ClockNodes {
	return {
		root: emitted.dataRoot.name,
		calculateAt: (path) => {
			const node = modelNodeAt(emitted, path);
			if (
				node === undefined ||
				!isClockNodeName(node.name, blockName, emitted.binds.length)
			)
				return undefined;
			return node.calculate;
		},
	};
}

/** `text` with each leaf's stored date-and-time spelling taken off and each
 *  clock node's read replaced by the leaf its calculate holds; test 4 holds
 *  a clock node to the emitter's. */
function leafValues(
	text: string,
	rowPath: readonly string[],
	clocks: ClockNodes,
): string {
	const tree = parse(text);
	if (tree === undefined) return text;
	const replacements: { from: number; to: number; text: string }[] = [];
	/** The leaf a `nova_instant_` node's calculate holds, where `read` is a read of one. */
	const clockLeaf = (read: FormSyntax | undefined): string | undefined => {
		if (read === undefined) return undefined;
		const path = resolveContextPath(read, rowPath, clocks.root);
		const calculate = path === undefined ? undefined : clocks.calculateAt(path);
		return calculate === undefined
			? undefined
			: inside(calculate, typedInstantValue(holeWire()));
	};
	// Each node is matched against the templates as a node of the one tree read from `text`,
	// so a walk of the tree reads the text once, never once a node.
	const storedTemplate = storedInstantValue(holeWire());
	const clockTemplate = storedClockValue(holeWire());
	const visit = (node: FormSyntax): void => {
		const own = text.slice(node.from, node.to);
		const stored = insideNode(node, text, storedTemplate);
		if (stored !== undefined && own !== stored) {
			// The typed leaf inside may itself be a clock node's read.
			replacements.push({
				from: node.from,
				to: node.to,
				text: `(${leafValues(stored, rowPath, clocks)})`,
			});
			return;
		}
		// A clock read: the stored text of a `nova_instant_` node, or the node read alone.
		const clockRead = insideNode(node, text, clockTemplate);
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

/**
 * Why a block's `update/<property>` row is a write Nova holds nowhere, read
 * where the row is read so a reading holds no write the commit gate refuses
 * (`validator/rules/caseOperations.ts`). HQ's form builder takes any
 * name its grammar admits (`saveToCase.js::validatePropertyNameChars`), HQ's
 * build checks no block's keys (`IndexedFormBaseValidator.check_case_properties`
 * reads only the actions'), and HQ's server applies the block's `<update>` as
 * any other (`update_strategy.py::SqlCaseUpdateStrategy._apply_update_action`):
 *
 * - `location_id` and `hq_user_id` are rows as any other: HQ's server keeps
 *   the first as the case's location column and copies the second into its
 *   external id, as the case store does;
 * - on the worker's record, whose writes the gate holds to a worker property
 *   the reading declares (`validateWorkerRecordProperty`), every other name
 *   but one (`worldEntities.ts::holdsWorkerRecordWrite`): a key HQ's user-case
 *   sync writes over (`USERCASE_BUILT_IN_KEYS`), the block's own `case_type`,
 *   `case_name` and `owner_id` rows among them (the sync writes the case's
 *   type, name and owner, `callcenter/sync_usercase.py::_get_user_case_fields`,
 *   and the gate gives the worker's record no retype, rename or owner), or a
 *   name no worker property takes (`validator/userPropertySlug.ts`):
 *   `workerKey`;
 * - on any other case, the block's own facets are none: `case_type` (a
 *   retype) is read before this, and `case_name` (a rename) and `owner_id`
 *   (the owner) after it;
 * - every other name the gate reserves for an operation's write
 *   (`FORBIDDEN_CASE_OPERATION_WRITE_PROPERTIES`: `name`, which HQ reads as
 *   the case's name, `date_opened`, `user_id`, `status`, `closed`, …) is a
 *   fact of the case or a word CommCare HQ reserves: `reservedKey`;
 * - a name outside the operation's property grammar or past its length,
 *   which HQ's form builder marks as an error and Nova's emitter never
 *   writes, is a block outside Nova's own shape (`"outside"`).
 */
function refusedRowKey(
	property: string,
	workerRecord: boolean,
): Claim<"refuse"> | "outside" | undefined {
	if (workerRecord)
		return holdsWorkerRecordWrite(property)
			? undefined
			: SAVE_TO_CASE_CLAIMS.workerKey;
	if (property === "case_name" || property === "owner_id") return undefined;
	// A row HQ's form builder reads as the block's close
	// (`questionId.ts::sourceWritePropertyProblem`), which no block Nova
	// writes holds: the gate refuses the property
	// (`CASE_PROPERTY_NAME_FORM_BUILDER_CANNOT_KEEP`).
	if (sourceWritePropertyProblem(property) !== undefined) return "outside";
	if (FORBIDDEN_CASE_OPERATION_WRITE_PROPERTIES.has(property))
		return SAVE_TO_CASE_CLAIMS.reservedKey;
	if (
		!isCaseOperationProperty(property) ||
		property.length > MAX_CASE_PROPERTY_LENGTH
	)
		return "outside";
	return undefined;
}

/** The repeat `field` stands in, nearest first; null at the form's root. */
function enclosingRepeat(
	xform: ReadXForm,
	field: DraftField,
): DraftField | null | undefined {
	const walk = (
		parent: DraftField | null,
		repeat: DraftField | null,
	): DraftField | null | undefined => {
		for (const child of xform.childrenOf(parent)) {
			if (child === field) return repeat;
			const found = walk(child, child.kind === "repeat" ? child : repeat);
			if (found !== undefined) return found;
		}
		return undefined;
	};
	return walk(null, null);
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
	const fail = (
		claim: Claim<"refuse">,
		detail?: FindingDetail,
		at?: Element,
	): BlockRead => ({
		ok: false,
		claim,
		...(detail !== undefined && { detail }),
		...(at !== undefined && { at: { element: at } }),
	});
	// An element HQ's form builder cannot open a form holding, at any depth
	// (`questionId.ts::stopsFormBuilder`): the block's own name, which is the
	// question's id there, a row's or a link's. The gate refuses each, as the
	// operation's id (`CASE_OPERATION_INVALID_ID`), as a property a block writes
	// (`CASE_PROPERTY_NAME_FORM_BUILDER_CANNOT_KEEP`) or as a link's name
	// (`CASE_OPERATION_LINK_INVALID`).
	const unopenable = [block.element, ...descendants(block.element)].find(
		(element) => stopsFormBuilder(localName(element)),
	);
	if (unopenable !== undefined)
		return fail(X.questionIdGrammar, { name: localName(unopenable) });
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
	// A case type the gate refuses by its name (`CASE_OPERATION_INVALID_CASE_TYPE`,
	// `caseOperationCaseTypeNameProblem`): the block's, and below a `case_type`
	// row's and a link's.
	if (caseOperationCaseTypeNameProblem(caseType) !== undefined)
		return fail(SAVE_TO_CASE_CLAIMS.caseTypeName);
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
	const attachment = parts.get("attachment");
	if (attachment !== undefined)
		return fail(SAVE_TO_CASE_CLAIMS.attachment, undefined, attachment);
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
			container === undefined ? undefined : CONTAINER_SEGMENT.get(container);
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
				node === undefined ? undefined : resolveContextPath(node, idPath, root);
			const field = path === undefined ? undefined : fieldAt(xform, path);
			// An answer keys a create only where the gate takes it as a key: one
			// string (`formFieldCanKeyCreate`: not a multi-select answer, which Nova
			// holds as a list) from the create's own repeat, or the root for a
			// create at the root (`formFieldCorrelatesWithCreate`).
			if (
				field === undefined ||
				keyedId === undefined ||
				!formFieldCanKeyCreate({
					kind: field.kind,
					dataType: caseDataTypeForFieldKind(field.kind),
				}) ||
				enclosingRepeat(xform, field) !== block.repeat
			)
				return fail(SAVE_TO_CASE_CLAIMS.authoredCreateId);
			target = { kind: "new", idFrom: field, idPrefix: keyedId.prefix };
		} else if (
			rootSetvalue === undefined &&
			idCalculate !== undefined &&
			!standsInRepeat(xform, block)
		)
			return fail(SAVE_TO_CASE_CLAIMS.liveCreateId);
		else if (rootSetvalue !== undefined) {
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
		// A case id that is a blank literal names no case: Core refuses the block
		// (`CaseXmlParser.loadCase`, and `CaseXmlParserUtil.validateMandatoryProperty`
		// for an empty id) and HQ's server refuses the submission
		// (`casedb_base.py::get`, `IllegalCaseId`). Blank as the gate reads a
		// literal case id (`prepareCaseScalarTextValue`, `CASE_OPERATION_TARGET_INVALID`).
		const idLiteral = literalOf(idText);
		if (idLiteral !== undefined) {
			const prepared = prepareCaseScalarTextValue(idLiteral, "reject");
			if (!prepared.ok && prepared.reason === "blank")
				return fail(SAVE_TO_CASE_CLAIMS.deviceRefuses);
		}
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
		// Nova keeps a form's every write of the worker's record in one update
		// that runs whenever the form is submitted, once, as HQ's `usercase_update`
		// does (`validator/rules/caseOperations.ts::workerRecordFindings`, reason
		// `worker-record-facet`): a block under its condition group, or one in a
		// repeat that runs for each row, is an update Nova cannot hold.
		if (
			target.kind === "worker-record" &&
			(conditionWrapper !== undefined || block.repeat !== null)
		)
			return fail(SAVE_TO_CASE_CLAIMS.workerFacet);
	}

	// The name and the owner of a create.
	let name: ProposedBlock["name"];
	let owner: ProposedOwner | undefined;
	if (creates) {
		const nameText = calc("case/create/case_name");
		if (nameText === undefined) return { ok: false };
		const unwrapped = untrimmed(nameText);
		// A case's name is its own value, and Nova holds a link to a captured
		// file only in a property of its own (the gate's
		// `CAPTURE_CASE_WRITE_STANDARD_PROPERTY`).
		if (captureAddressOf(ctx, unwrapped.text) !== undefined)
			return fail(OUTSIDE_VOCABULARY);
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
				: resolveContextPath(
						nameNode,
						[...casePath, "create", "case_name"],
						root,
					);
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
			if (property === "case_type" && target.kind === "worker-record")
				return fail(SAVE_TO_CASE_CLAIMS.workerKey, { name: property });
			if (property === "case_type") {
				const literal = literalOf(text);
				if (literal === undefined)
					return fail(SAVE_TO_CASE_CLAIMS.caseTypeXPath);
				if (caseOperationCaseTypeNameProblem(literal) !== undefined)
					return fail(SAVE_TO_CASE_CLAIMS.caseTypeName);
				if (literal !== caseType) retype = literal;
				else if (rows.length > 1) retype = literal;
				continue;
			}
			const keyClaim = refusedRowKey(property, target.kind === "worker-record");
			if (keyClaim === "outside") return { ok: false };
			if (keyClaim !== undefined)
				return fail(keyClaim, { name: property }, row);
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
				if (captureAddressOf(ctx, untrimmed(text).text) !== undefined)
					return fail(OUTSIDE_VOCABULARY);
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
			// An external id is the case's own value, never a link to a captured
			// file (the gate's `CAPTURE_CASE_WRITE_STANDARD_PROPERTY`), so its text
			// is read as the text it builds, as a case's name is.
			const value = rowValue(
				ctx,
				xform,
				property === "external_id" ? untrimmed(text).text : text,
				rowPath,
				block.path[block.path.length - 1] as string,
			);
			// An external id is the case's own value, and Nova holds a link to a
			// captured file only in a property of its own (the gate's
			// `CAPTURE_CASE_WRITE_STANDARD_PROPERTY`): outside the vocabulary of
			// an external id's value, as a name's capture address is (above).
			if (property === "external_id" && value.value?.kind === "capture")
				return fail(OUTSIDE_VOCABULARY);
			if (value.earlier) {
				EARLIER_ROWS.set(bind, {
					value: value.text,
					rowPath,
					blockName: block.path[block.path.length - 1] as string,
				});
				const readId =
					ctx.input.source.modules[form.menu]?.forms[form.index]?.readUniqueId;
				ctx.facts.sameStateRewrites.push({
					entry: SAVE_TO_CASE_CLAIMS.rows.entry,
					path: `/_attachments/${readId ?? form.xmlns}.xml`,
					register: DATETIME_REGISTER,
					removedInputs: [
						[
							JSON.stringify([caseType, ...rowPath]),
							sourceFormExpression(value.text),
						],
					],
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
					: resolveContextPath(
							valueNode,
							[...casePath, "update", property],
							root,
						);
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
			// A name Nova's link identifier cannot spell, or one CommCare HQ's form
			// builder reads as the block's own action
			// (`questionId.ts::caseOperationLinkNameProblem`), as the gate refuses it.
			// A name it cannot open a form with was refused above.
			if (
				!isCaseOperationIdentifier(identifier) ||
				caseOperationLinkNameProblem(identifier) !== undefined
			)
				return fail(SAVE_TO_CASE_CLAIMS.linkName, { name: identifier });
			// A name longer than CommCare HQ's index column holds
			// (`CommCareCaseIndex.identifier`, 255 characters), which the gate refuses
			// (`CASE_OPERATION_LINK_INVALID`, reason `too-long`).
			if (identifier.length > MAX_CASE_INDEX_IDENTIFIER_LENGTH)
				return fail(SAVE_TO_CASE_CLAIMS.linkTooLong);
			const targetType = link.attribs.case_type;
			const relationship = link.attribs.relationship;
			if (
				targetType === undefined ||
				(relationship !== "child" && relationship !== "extension")
			)
				return { ok: false };
			if (targetType === "commcare-user")
				return fail(SAVE_TO_CASE_CLAIMS.reservedType, { name: targetType });
			if (caseOperationCaseTypeNameProblem(targetType) !== undefined)
				return fail(SAVE_TO_CASE_CLAIMS.caseTypeName);
			const key = `case/index/${identifier}`;
			const text = calc(key);
			const linkPath = [...casePath, "index", identifier];
			let linkTarget: ProposedLink["target"] = null;
			// A link whose value is the block's own case id links the case to itself,
			// which Core refuses on every submission (`CaseXmlParser.indexCase`, "cannot
			// index itself"), a create's as an update's.
			const linkNode = text === undefined ? undefined : parse(text);
			const linkValuePath =
				linkNode === undefined
					? undefined
					: resolveContextPath(linkNode, linkPath, root);
			if (
				linkValuePath !== undefined &&
				linkValuePath.join("/") === idPath.join("/")
			)
				return fail(SAVE_TO_CASE_CLAIMS.deviceRefuses);
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
	const path =
		node === undefined ? undefined : resolveContextPath(node, idPath, root);
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
 *  `authoredCaseIdCalculation`'s shape, under a prefix in the shape
 *  `authoredCaseIdPrefix` writes. The prefix derives from the app, form and
 *  operation that wrote it, which the reading's own identities are not, so
 *  the comparison prints it back as read. A prefix in any other shape is an
 *  authored id: the deployment ledger stores only the derived shape, and the
 *  key's bound keeps the id within HQ's 255 only under that shape's length. */
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
	if (prefix?.kind !== "string" || !isAuthoredCaseIdPrefix(prefix.value))
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
		node === undefined ? undefined : resolveContextPath(node, context, root);
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

/** Whether a block stands in any repeat's row, an authored repeat's or one Nova's scaffolding
 *  makes (a keyed create's, the selected cases'): a node above it is a repeat's template or a
 *  model-iteration wrapper. */
function standsInRepeat(xform: ReadXForm, block: ReadSaveToCaseBlock): boolean {
	for (
		let at = xform.nodes.get(block.path.join("/"))?.parent ?? null;
		at !== null;
		at = at.parent
	)
		if (at.template || at.role === "Repeat") return true;
	return false;
}

/** The refusal of a sibling node the form stage refused whole that a guard named `name` guards,
 *  where one stands beside the guard. */
function refusedGuardOwner(
	xform: ReadXForm,
	guard: ReadSaveToCaseBlock,
	name: string,
): StandingRefusal | undefined {
	const scope = guard.path.slice(0, -1).join("/");
	for (const node of xform.nodes.values()) {
		if (node.path.slice(0, -1).join("/") !== scope) continue;
		if (!guardOf(name, new Set([node.name]))) continue;
		const refusal = xform.refusals.over({ element: node.element });
		if (refusal !== undefined) return refusal;
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
 * case's name or external id carries the scalar check where its kind takes
 * one, because the own arm checks those questions wherever it is kept
 * (`placement.ts::placedBasic`, `caseScalarTextGuard.ts::caseScalarTextGuards`),
 * while a create in a block checks none. A Hidden Value takes no check, so a
 * question of that kind tells nothing.
 */
function ownGuardsPrinted(read: NonNullable<BlockRead["proposal"]>): boolean {
	const guarded = [
		read.name?.readsField,
		...read.writes.map((row) =>
			isCaseScalarTextProperty(row.property) && row.value.kind === "text"
				? row.value.readsField
				: undefined,
		),
	].filter((field): field is DraftField => field !== undefined);
	return guarded.every(
		(field) =>
			!caseScalarTextGuardIsChecked(field.kind) ||
			field.scalarCheck !== undefined,
	);
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
	// A block's name is its operation's id, which no two changes of a form
	// share (the gate's `CASE_OPERATION_DUPLICATE_ID`): no document prints two
	// blocks of one name, so a later block of an earlier one's name, in another
	// group (two in one group are siblings of one name, above), is outside the
	// shape Nova writes, one finding at it, and the earlier is read.
	const names = new Set<string>();
	for (const block of xform.saveToCaseBlocks) {
		// A block the data tree refused (two siblings of one name in it or at it)
		// is that one finding, at the form; the form stage claimed the block, its
		// binds and its setvalues, and what stands around it stands under it.
		if (block.refusal !== undefined) {
			reading.failed.push({
				block,
				place: block.refusal.place ?? form.place,
				claim: block.refusal.claim,
				...(block.refusal.detail === undefined
					? {}
					: { detail: block.refusal.detail }),
			});
			continue;
		}
		const role = xform.roles.get(
			xform.nodes.get(block.path.join("/")) as DataNode,
		);
		const place = placeOf(block);
		if (role?.kind === "case-region" && role.container === "guard") {
			guards.push(block);
			continue;
		}
		const name = block.path[block.path.length - 1] as string;
		if (names.has(name)) {
			reading.failed.push({
				block,
				place,
				claim: SAVE_TO_CASE_CLAIMS.outsideShape,
			});
			continue;
		}
		names.add(name);
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
				...(!kept && read.at !== undefined && { at: read.at }),
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
	const blockName = (block: ReadSaveToCaseBlock) =>
		block.path[block.path.length - 1] as string;
	// A guard follows its operation's block: where a proposed block and a
	// refused one share a name, the guard is the nearest such block's before it.
	const nearestOwner = (guard: ReadSaveToCaseBlock, name: string) => {
		const order = xform.saveToCaseBlocks;
		for (let at = order.indexOf(guard) - 1; at >= 0; at--) {
			const block = order[at] as ReadSaveToCaseBlock;
			if (!guards.includes(block) && guardOf(name, new Set([blockName(block)])))
				return block;
		}
		return undefined;
	};
	for (const guard of guards) {
		const name = guard.path[guard.path.length - 1] as string;
		const nearest = nearestOwner(guard, name);
		const owner = failedBlocks.find(
			(one) =>
				guardOf(name, new Set([blockName(one.block)])) &&
				(nearest === undefined ||
					!ids.has(blockName(one.block)) ||
					one.block === nearest),
		);
		// A guard of a block the form stage refused whole (a case block that no Save to Case
		// role marks) belongs to that block, and stands under its refusal.
		const refusedOwner =
			owner === undefined ? refusedGuardOwner(xform, guard, name) : undefined;
		if (owner !== undefined) reading.failed.push({ ...owner, block: guard });
		else if (refusedOwner !== undefined)
			reading.failed.push({
				block: guard,
				place: refusedOwner.place,
				claim: refusedOwner.claim,
				...(refusedOwner.detail === undefined
					? {}
					: { detail: refusedOwner.detail }),
				...(refusedOwner.at === undefined ? {} : { at: refusedOwner.at }),
			});
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
	// that update, beside the basic block. The two differ by name: the
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
	// (the arm writes a fixed text column), the arm is read first, and
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
		ownGuardsPrinted(firstBlock)
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
			ctx.identities.claim(
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
	// whose `case/close` carries the condition was refused above. A block whose
	// `update` holds a row is a close operation's, never the own close's: the
	// emitter writes the own close's block with no `update`, and a close
	// operation's with its idempotent `case_type` row (`xform/caseOps.ts`),
	// which the gate then judges beside the form's own change
	// (`index.ts::settleCaseChanges`). An empty `update` is neither: Core and
	// HQ's server act on no row of it beside the close, HQ's form builder drops
	// it on its next save, and no block Nova writes holds one, so the block is
	// outside Nova's shape and nothing else.
	if (type === "followup" || type === "close" || type === "registration") {
		const shapes = severalCases
			? OWN_CLOSE_SHAPES.severalCases
			: OWN_CLOSE_SHAPES.oneCase;
		const holdsUpdateRow = (block: ReadSaveToCaseBlock) =>
			children(block.element).some(
				(one) =>
					localName(one) === "case" &&
					children(one).some(
						(child) =>
							localName(child) === "update" && children(child).length > 0,
					),
			);
		const ownClose = reading.proposals.find(
			(one) =>
				one.action === "close" &&
				one.caseType === menuType &&
				one.target.kind === "session" &&
				one.block.repeat === null &&
				one.writes.length === 0 &&
				!holdsUpdateRow(one.block) &&
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
			// is, and the question carries its check (`ownGuardsPrinted`).
			if (one.action === "own" && one.name !== undefined) {
				const named = one.name.answer ?? one.name.readsField;
				return named === undefined ? [] : [named];
			}
			return [];
		}),
	);
	for (const failed of reading.failed) refuseBlock(xform, failed);
	claimAccepted(ctx, xform, reading, form);
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

/** One finding at the block's place, covering the block, its binds and its
 *  setvalues; nothing for a block the data tree refused, whose refusal the form
 *  stage made over all three. */
function refuseBlock(
	xform: ReadXForm,
	failed: FormBlocks["failed"][number],
): void {
	const { block, place, claim, detail, at } = failed;
	if (block.refusal !== undefined) return;
	// The refusal's record stands where its class is, where that is not the block's own node; a
	// guard of a refused block takes its block's.
	if (at === undefined)
		xform.cursor.refuseSubtree(block.element, claim, place, detail);
	else xform.cursor.refuseSubtreeAt(block.element, at, claim, place, detail);
	for (const [key, bind] of bindsUnder(xform, block.path)) {
		if (key.includes("@")) reachElement(xform, bind, claim);
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
					reachNode(xform, { element: bind, attribute }, claim);
	}
	for (const bind of laterBindsUnder(xform, block.path))
		reachElement(xform, bind, claim);
	for (const setvalue of setvaluesUnder(xform, block.path))
		reachElement(xform, setvalue, claim);
}

/** A node a refused block reaches outside its own element (a bind, a setvalue, a wrapper the
 *  block stands in): part of the block's refusal, with no finding of its own, and recorded under
 *  the refusal's entry only at each key the lane names the node by (`regionKey`, a bind's other
 *  attributes by their own name, a bind's `type` also by the type Core reads, `bindType`) where
 *  that entry names it, so no record names a key another node holds. */
function reachNode(xform: ReadXForm, node: XmlNode, claim: Claim): void {
	xform.cursor.partOf(node, claim);
	const region = regionKey(xform, node);
	const key =
		region === undefined &&
		node.attribute !== undefined &&
		localName(node.element) === "bind" &&
		!inInstanceContent(node.element)
			? `xform:model/bind@${qualifiedAttribute(node.attribute, xform.parsed.scope(node.element))}`
			: region;
	if (key !== undefined && key !== null)
		xform.cursor.within(node, claim, [key]);
	const type = bindType(node);
	if (type !== undefined) xform.cursor.within(node, claim, [type]);
}

/** `reachNode` of an element and each attribute it holds. */
function reachElement(xform: ReadXForm, element: Element, claim: Claim): void {
	reachNode(xform, { element }, claim);
	for (const attribute of Object.keys(element.attribs))
		if (!attribute.startsWith("xmlns:"))
			reachNode(xform, { element, attribute }, claim);
}

/** Claims every accepted block, the binds and setvalues under it, and each
 *  wrapper it stands under, leaving each attribute a text is registered
 *  from to the expression stage, and registering each other text the region
 *  holds (the emitter's own: a block's case id, its clock, a generated row's
 *  value) for the uses its syntax makes (`PendingExpression.usesOnly`). */
function claimAccepted(
	ctx: ReadContext,
	xform: ReadXForm,
	reading: FormBlocks,
	form: DraftForm,
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
	const controls = regionControls(xform);
	// The emitter's texts are read in the form's logic: under its first operation, or the own
	// close's condition where the form's only block is that close.
	const first = reading.proposals[0]?.uuid;
	const usesRef: SlotContextRef | undefined =
		first !== undefined
			? caseSlot(form.uuid, "case_operation_condition", first)
			: reading.ownClose !== undefined
				? ({
						entity: "form",
						uuid: form.uuid,
						slot: "form_close_condition",
					} as SlotContextRef)
				: undefined;
	// What was registered before this settle: a use it registers below does not count.
	const registeredBefore = ctx.pending.list().length;
	const registeredAt = (element: Element, attribute: string) => {
		if (registeredAttributes.get(element)?.has(attribute) === true) return true;
		const index = ctx.pending.firstAt(element, attribute);
		return index !== undefined && index < registeredBefore;
	};
	const registerUses = (element: Element) => {
		if (usesRef === undefined) return;
		for (const attribute of ["calculate", "relevant", "value"]) {
			const text = element.attribs[attribute];
			if (text === undefined || registeredAt(element, attribute)) continue;
			ctx.pending.register(
				{
					ref: usesRef,
					text,
					mode: { target: "xform", constraint: false },
					place: form.place,
					key: `${regionKey(xform, { element }) ?? "xform:model/bind"}@${attribute}`,
					usesOnly: true,
				},
				{ element, attribute },
			);
		}
	};
	/** A bind on an attribute, or a leaf of the region: claimed whole at its element, each
	 *  attribute recorded where it sits. Test 4 holds each to the emitter's whole
	 *  (`saveToCaseCompare.ts`, `sameBind` and `sameElementWhole`). */
	const claimWhole = (
		element: Element,
		claims: ReadonlyMap<RegionKey, Claim<"derived">>,
		fallback: Claim<"derived">,
	) => {
		const key = regionKey(xform, { element });
		const claim =
			(key === undefined || key === null ? undefined : claims.get(key)) ??
			fallback;
		xform.cursor.derivedSubtree(element, claim);
		recordWithin(xform, element, claim, controls);
		registerUses(element);
	};
	/** A setvalue: its element and the three attributes Nova writes on one, each claimed where it
	 *  sits, so any other attribute (a `bind`, which Core reads in place of `ref`) is left for the
	 *  close to report. */
	const claimSetvalue = (
		element: Element,
		claims: ReadonlyMap<RegionKey, Claim<"derived">>,
		fallback: Claim<"derived">,
	) => {
		claimRegionNode(xform, { element }, claims, fallback);
		for (const attribute of ["event", "ref", "value"])
			if (Object.hasOwn(element.attribs, attribute))
				claimRegionNode(xform, { element, attribute }, claims, fallback);
		registerUses(element);
	};
	const claimBinds = (
		prefix: readonly string[],
		binds: ReadonlyMap<RegionKey, Claim<"derived">>,
		fallback: Claim<"derived">,
	) => {
		for (const [key, bind] of bindsUnder(xform, prefix)) {
			if (key.includes("@")) {
				claimWhole(bind, binds, fallback);
				continue;
			}
			const skip = registeredAttributes.get(bind);
			for (const attribute of ["calculate", "relevant"])
				if (
					bind.attribs[attribute] !== undefined &&
					skip?.has(attribute) !== true
				)
					claimRegionNode(xform, { element: bind, attribute }, binds, fallback);
			registerUses(bind);
		}
		for (const setvalue of setvaluesUnder(xform, prefix))
			claimSetvalue(setvalue, binds, fallback);
	};
	const blocks: {
		block: ReadSaveToCaseBlock;
		claim: ReadonlyMap<RegionKey, Claim<"take">>;
		binds: ReadonlyMap<RegionKey, Claim<"derived">>;
		bindFallback: Claim<"derived">;
		links?: readonly ProposedLink[];
	}[] = [
		...reading.proposals.map((one) => ({
			block: one.block,
			links: one.links,
			// A block is claimed under the entry its own class names: one in a
			// repeat under the repeat's, one writing a property whose name holds a
			// hyphen under that one's, any other under its action's.
			claim:
				one.block.repeat !== null
					? REGION.inRepeat
					: one.writes.some((row) => row.property.includes("-"))
						? REGION.hyphenated
						: one.action === "create" || one.action === "own"
							? REGION.create
							: REGION.update,
			binds: one.action === "create" ? REGION.createBind : REGION.updateBind,
			bindFallback:
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
			claim: REGION.update,
			binds: REGION.updateBind,
			bindFallback: SAVE_TO_CASE_CLAIMS.updateBind,
		});
	for (const { block, claim, binds, bindFallback, links } of blocks) {
		// The block's data node, recorded at its own depth, and each node it holds where the
		// lane reads it (`recordWithin`).
		const own = claim.get(
			block.element.parent === xform.parsed.dataRoot ? TOP : NESTED,
		) as Claim<"take">;
		void xform.cursor.takeSubtree(block.element, own).value;
		recordWithin(xform, block.element, own, controls);
		// Each link and unlink, whatever its target, at its `index/<name>`.
		for (const link of links ?? []) {
			const at = linkElement(block.element, link.identifier);
			if (at !== undefined)
				xform.cursor.derived(
					{ element: at },
					REGION.link.get(NESTED) as Claim<"derived">,
				);
		}
		claimBinds(block.path, binds, bindFallback);
		for (const wrapper of block.wrappers) wrappers.add(wrapper);
	}
	// The wrappers, the nodes of the region that stand beside the blocks (a
	// keyed create's count, a clock read, a selected-cases query node), and
	// the controls that name them.
	for (const node of xform.caseRegion) {
		if (node.role === "SaveToCase" || isInsideBlock(node)) continue;
		const role = xform.roles.get(node);
		const container = role?.kind === "case-region" ? role.container : undefined;
		// A wrapper no read block stands in (an operations, children's or
		// condition group, a keyed create's one-row repeat, the selected cases'
		// repeat and its row) is part of the finding of the first block that
		// does, as that block's guards are: the reading holds none of what it
		// wraps, so the source's one cause is one finding. A repeat's iteration
		// (the binds and setvalues on its attributes and its row's) stands under
		// that finding with it.
		const failedIn =
			wrappers.has(node) || container === undefined
				? undefined
				: reading.failed.find((one) => one.block.wrappers.includes(node));
		if (failedIn !== undefined) {
			const { claim } = failedIn;
			if (container === "selected-cases" || container === "selected-case") {
				for (const [key, attributeBind] of bindsUnder(xform, node.path))
					if (key.startsWith("@") && !key.includes("/"))
						reachElement(xform, attributeBind, claim);
				for (const one of iterationSetvalues(xform, node))
					reachElement(xform, one.element, claim);
			}
			reachNode(xform, { element: node.element }, claim);
			for (const attribute of Object.keys(node.element.attribs))
				if (!attribute.startsWith("xmlns"))
					reachNode(xform, { element: node.element, attribute }, claim);
			const bind = xform.binds.get(node);
			if (bind?.logic.relevant !== undefined)
				reachNode(
					xform,
					{ element: bind.element, attribute: "relevant" },
					claim,
				);
			continue;
		}
		if (wrappers.has(node)) {
			const [claims, fallback] =
				container === "condition"
					? [REGION.conditionGroup, SAVE_TO_CASE_CLAIMS.conditionGroup]
					: [REGION.rows, SAVE_TO_CASE_CLAIMS.rows];
			claimRegionNode(xform, { element: node.element }, claims, fallback);
			const question = regionQuestion(node.element, controls);
			const questionClaim =
				question === undefined ? undefined : claims.get(question);
			if (question !== undefined && questionClaim !== undefined)
				xform.cursor.within({ element: node.element }, questionClaim, [
					question,
				]);
			for (const attribute of Object.keys(node.element.attribs))
				if (!attribute.startsWith("xmlns"))
					claimRegionNode(
						xform,
						{ element: node.element, attribute },
						claims,
						fallback,
					);
			// A condition the expression stage reads is its to claim.
			const bind = xform.binds.get(node);
			if (
				bind?.logic.relevant !== undefined &&
				registeredAttributes.get(bind.element)?.has("relevant") !== true
			)
				claimRegionNode(
					xform,
					{ element: bind.element, attribute: "relevant" },
					claims,
					fallback,
				);
			if (bind !== undefined) registerUses(bind.element);
			// A selected-cases repeat's own iteration: the binds and setvalues
			// on its attributes and its row's (`@current_index`, `@ids`,
			// `@count`, `item/@index`, `item/@id`), which test 4 holds to the
			// emitter's with the wrapper.
			if (container === "selected-cases" || container === "selected-case") {
				for (const [key, attributeBind] of bindsUnder(xform, node.path))
					if (key.startsWith("@") && !key.includes("/"))
						claimWhole(attributeBind, REGION.rows, fallback);
				for (const one of iterationSetvalues(xform, node))
					claimSetvalue(one.element, REGION.rows, fallback);
			}
			continue;
		}
		if (node.children.length > 0) continue;
		const parentWrapper = node.parent !== null && wrappers.has(node.parent);
		const inRegion =
			parentWrapper ||
			(node.parent !== null && xform.caseRegion.includes(node.parent));
		if (!inRegion) continue;
		claimWhole(node.element, REGION.rows, SAVE_TO_CASE_CLAIMS.rows);
		const bind = xform.binds.get(node);
		if (bind !== undefined)
			for (const attribute of ["calculate", "relevant", "type"])
				if (bind.element.attribs[attribute] !== undefined)
					claimRegionNode(
						xform,
						{ element: bind.element, attribute },
						REGION.rows,
						SAVE_TO_CASE_CLAIMS.rows,
					);
		if (bind !== undefined) registerUses(bind.element);
		for (const setvalue of setvaluesUnder(xform, node.path))
			claimSetvalue(setvalue, REGION.rows, SAVE_TO_CASE_CLAIMS.rows);
	}
	claimControls(ctx, xform);
}

/** Each data node of the case region a body group or repeat names, with the control's kind:
 *  what HQ's question reader types the node by. */
function regionControls(
	xform: ReadXForm,
): ReadonlyMap<Element, "group" | "repeat"> {
	const root = xform.parsed.dataRoot.name;
	const byPath = new Map(
		xform.caseRegion.map((node) => [node.path.join("/"), node.element]),
	);
	const found = new Map<Element, "group" | "repeat">();
	const walk = (element: Element) => {
		for (const child of children(element)) {
			const local = localName(child);
			const binding = coreControlPath(child, local);
			const ref = binding?.attribute === "bind" ? undefined : binding?.text;
			if ((local === "group" || local === "repeat") && ref !== undefined) {
				const steps = pathSteps(ref);
				const node =
					steps !== undefined && steps[0] === "/" && steps[1] === root
						? byPath.get(steps.slice(2).join("/"))
						: undefined;
				if (node !== undefined) found.set(node, local);
			}
			walk(child);
		}
	};
	walk(xform.parsed.body);
	return found;
}

/** A block's `case/index/<identifier>` element. */
function linkElement(block: Element, identifier: string): Element | undefined {
	const step = (from: Element | undefined, name: string) =>
		from === undefined
			? undefined
			: children(from).find((child) => localName(child) === name);
	return step(step(step(block, "case"), "index"), identifier);
}

/** The setvalues on an attribute of `node` itself: a repeat's iteration. */
function iterationSetvalues(
	xform: ReadXForm,
	node: DataNode,
): ReadXForm["setvalues"] {
	return xform.setvalues.filter(
		(one) =>
			one.target !== undefined &&
			one.target.length === node.path.length + 1 &&
			node.path.every((step, i) => one.target?.[i] === step) &&
			(one.target[node.path.length] as string).startsWith("@"),
	);
}

function isInsideBlock(node: DataNode): boolean {
	for (let at = node.parent; at !== null; at = at.parent)
		if (at.role === "SaveToCase") return true;
	return false;
}

/** The body controls that name a node of the case region: each group or
 *  repeat with no label, and a `<group>` with no `ref` whose one control
 *  is such a repeat. A `vellum:` shadow on one (the `vellum:ref` and
 *  `vellum:nodeset` HQ's form builder writes on every control it saves, a
 *  count-bound repeat's `vellum:jr__count`) is the shadow reader's, which
 *  holds it to its real attribute (`xform/shadow.ts::judgeShadows`). */
function claimControls(ctx: ReadContext, xform: ReadXForm): void {
	void ctx;
	const root = xform.parsed.dataRoot.name;
	const region = new Set(xform.caseRegion.map((node) => node.path.join("/")));
	const claimed = new Set<Element>();
	const walk = (element: Element) => {
		for (const child of children(element)) {
			const local = localName(child);
			const binding = coreControlPath(child, local);
			const ref = binding?.attribute === "bind" ? undefined : binding?.text;
			if ((local === "group" || local === "repeat") && ref !== undefined) {
				const steps = pathSteps(ref);
				const path =
					steps !== undefined && steps[0] === "/" && steps[1] === root
						? steps.slice(2)
						: undefined;
				if (path !== undefined && region.has(path.join("/"))) {
					claimRegionNode(
						xform,
						{ element: child },
						REGION.rows,
						SAVE_TO_CASE_CLAIMS.rows,
					);
					const scope = xform.parsed.scope(child);
					for (const attribute of Object.keys(child.attribs))
						if (attributeNamespace(attribute, scope) !== VELLUM_NS)
							claimRegionNode(
								xform,
								{ element: child, attribute },
								REGION.rows,
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
				claimRegionNode(
					xform,
					{ element: child },
					REGION.rows,
					SAVE_TO_CASE_CLAIMS.rows,
				);
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
		let attachments: Readonly<Record<string, unknown>> = NO_ENTRIES;
		try {
			attachments = expandDoc(doc, {
				...inputs,
				keyedCaseIdPrefixes: keyedCaseIdPrefixes(ctx),
			})._attachments as Record<string, unknown>;
		} catch (error) {
			rethrowWorkStop(error);
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

/** The paths of the stored blocks the reading refuses, with each wrapper no
 *  judged block stands in and a refused keyed create's count beside its
 *  repeat: what no document the reading proposes prints, which the
 *  comparison of the blocks beside them leaves out. */
function leftOutPaths(
	reading: FormBlocks,
	apart: ReadonlySet<string>,
): Set<string> {
	const out = new Set<string>();
	for (const { block } of reading.failed) {
		out.add(block.path.join("/"));
		for (const wrapper of block.wrappers) {
			const path = wrapper.path.join("/");
			if (apart.has(path)) continue;
			out.add(path);
			if (wrapper.template)
				out.add(
					[...wrapper.path.slice(0, -1), `nova_count_${wrapper.name}`].join(
						"/",
					),
				);
		}
	}
	return out;
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
	} catch (error) {
		rethrowWorkStop(error);
		shape = undefined;
	}
	const emitted = emittedForm(ctx, doc, form);
	const apart = judgedApart(reading);
	return (
		shape !== undefined &&
		shape.join("/") === ownClose.segments.join("/") &&
		emitted !== undefined &&
		blockTreesEqual(
			{ block: ownClose.block, form: storedFormSource(xform.parsed) },
			emitted,
			apart,
			heldSlotPrints(ctx, doc, reading),
			leftOutPaths(reading, apart),
			earlierSpelling(xform, reading),
		)
	);
}

/**
 * How test 4 reads a form some of whose rows hold a date and time in the
 * spelling Nova wrote before its clock nodes existed: such a row is the
 * emitter's where the value inside it is the value the emitter's row holds,
 * each clock node's read put back from that node, and a clock node the
 * emitter writes for one of those rows' blocks that the stored form does not
 * hold is no difference. Undefined where no row of the form is so spelled.
 */
function earlierSpelling(
	xform: ReadXForm,
	reading: FormBlocks,
): EarlierSpelling | undefined {
	const blockNames = new Set<string>();
	const proposed = new Set(
		reading.proposals.map((one) => one.block.path[one.block.path.length - 1]),
	);
	for (const bind of xform.parsed.binds) {
		const earlier = EARLIER_ROWS.get(bind);
		if (earlier !== undefined && proposed.has(earlier.blockName))
			blockNames.add(earlier.blockName);
	}
	if (blockNames.size === 0) return undefined;
	return {
		calculate: (stored, emitted, emittedForm) => {
			const earlier = EARLIER_ROWS.get(stored);
			if (earlier === undefined) return false;
			const value = leafValues(
				emitted,
				earlier.rowPath,
				emittedClockNodes(emittedForm, earlier.blockName),
			);
			return sameXPathText(earlier.value, value, { ruleSet: "form" });
		},
		emittedOnly: (path) => {
			const name = path[path.length - 1];
			if (name === undefined || xform.nodes.has(path.join("/"))) return false;
			for (const blockName of blockNames)
				if (isClockNodeName(name, blockName, xform.parsed.binds.length + 1))
					return true;
			return false;
		},
	};
}

/**
 * Nova's print over `doc` of the tree the expression stage held for each text
 * a block's bind holds whole, by the stored bind and attribute it was read
 * from: a block whose source spells a held slot otherwise than Nova prints it
 * (the form builder's absolute `/data/r/k` for an answer of the block's own
 * repeat, which Nova prints from `current()`) is the block Nova prints, since
 * the expression stage compared the slot with the source and reported what
 * the print changes. A text the attribute holds only part of (a name inside
 * its trim) is compared as written.
 */
function heldSlotPrints(
	ctx: ReadContext,
	doc: BlueprintDoc,
	reading: FormBlocks,
): HeldSlotPrint {
	const bySite = new Map<Element, Map<string, number>>();
	for (const { index } of reading.registrations.values()) {
		const at = ctx.pending.site(index).at;
		if (!("element" in at) || at.attribute === undefined) continue;
		const registration = ctx.pending.list()[index];
		if (registration?.text !== at.element.attribs[at.attribute]) continue;
		const attributes = bySite.get(at.element) ?? new Map<string, number>();
		attributes.set(at.attribute, index);
		bySite.set(at.element, attributes);
	}
	let env: ReturnType<typeof expressionEnvOf> | undefined;
	return (element, attribute) => {
		const index = bySite.get(element)?.get(attribute);
		if (index === undefined) return undefined;
		const tree = ctx.pending.outcome(index).expression;
		const registration = ctx.pending.list()[index];
		if (tree === undefined || registration === undefined) return undefined;
		env ??= expressionEnvOf(ctx);
		try {
			return printSlot(doc, registration.ref, tree, env);
		} catch (error) {
			rethrowWorkStop(error);
			return undefined;
		}
	};
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
	const held = heldSlotPrints(ctx, doc, reading);
	const leftOut = leftOutPaths(reading, apart);
	const earlier = earlierSpelling(xform, reading);
	const failing: ProposedBlock[] = [];
	for (const one of reading.proposals) {
		let shape: readonly SaveToCaseBlockSegment[] | undefined;
		try {
			shape = saveToCaseBlockShape(doc, form.uuid, {
				kind: "operation",
				operationUuid: one.uuid,
			});
		} catch (error) {
			rethrowWorkStop(error);
			shape = undefined;
		}
		if (
			shape === undefined ||
			shape.join("/") !== one.segments.join("/") ||
			emitted === undefined ||
			!blockTreesEqual(
				{ block: one.block, form: stored },
				emitted,
				apart,
				held,
				leftOut,
				earlier,
			)
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
		} catch (error) {
			rethrowWorkStop(error);
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
		} catch (error) {
			rethrowWorkStop(error);
			return undefined;
		}
	})();
	if (planned?.kind !== "save-to-case" || planned.repeat !== undefined)
		return doc;
	const uuid = ctx.accounting.identity(
		ctx.identities.claim(
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
	} catch (error) {
		rethrowWorkStop(error);
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
 * document those settled on. A block that fails is one finding at the block,
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
	// A block a finding already stands at (a slot of it the expression stage
	// could not hold, which the emitter then prints otherwise) is that one
	// finding: the source's one cause.
	for (const one of failing) {
		if (ctx.accounting.hasFindingAt(one.place)) continue;
		ctx.accounting.finding(SAVE_TO_CASE_CLAIMS.outsideShape, one.place);
		const xform = form.xform;
		if (xform !== null)
			for (const bind of laterBindsUnder(xform, one.block.path))
				xform.cursor.refuseSubtree(
					bind,
					SAVE_TO_CASE_CLAIMS.outsideShape,
					one.place,
				);
	}
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
		// Where the form's case management is refused, the own case's close belongs to that
		// refusal: its one finding at the form is the cause, and no own close is read.
		const refused = refusedCaseManagement(form);
		if (refused === undefined)
			ctx.accounting.finding(SAVE_TO_CASE_CLAIMS.outsideShape, ownClose.place);
		failed.push({
			block: ownClose.block,
			place: refused === undefined ? ownClose.place : form.place,
			claim: refused ?? SAVE_TO_CASE_CLAIMS.outsideShape,
		});
	}
	REFUSED_BLOCKS.set(
		form,
		failed.map((one) => one.block),
	);
	// The stored `save` map is judged once every block is: a form whose block
	// is outside Nova's shape has that finding alone.
	judgeSaveReferences(ctx, form, failed);
}

/** The blocks of each form the reading refuses, once `settleSaveToCase` has
 *  judged them. */
const REFUSED_BLOCKS = new WeakMap<DraftForm, readonly ReadSaveToCaseBlock[]>();

/** The case name and external id rows of a block, by their key under it. */
const SCALAR_ROW_KEYS = [
	"case/create/case_name",
	"case/update/case_name",
	"case/update/external_id",
] as const;

/**
 * The questions whose answer a block of `form` the reading refuses saves as a
 * case's name or external id. Each such question carries that block's scalar
 * check in its constraint where Nova printed the block
 * (`caseScalarTextGuard.ts::caseScalarTextGuards`), which the document the
 * reading proposes leaves out with the block: the check stands under the
 * block's finding (`index.ts::settleScalarChecks`).
 */
export function scalarFieldsOfRefusedBlocks(
	form: DraftForm,
): ReadonlySet<DraftField> {
	const xform = form.xform;
	const out = new Set<DraftField>();
	if (xform === null) return out;
	const root = xform.parsed.dataRoot.name;
	for (const block of REFUSED_BLOCKS.get(form) ?? []) {
		const binds = bindsUnder(xform, block.path);
		for (const key of SCALAR_ROW_KEYS) {
			const text = binds.get(key)?.attribs.calculate;
			if (text === undefined) continue;
			const context = [...block.path, ...key.split("/")];
			// The question itself, or the one whose trimmed value it reads.
			const sibling = generatedSiblingOf(xform, text, context);
			const node = parse(untrimmed(text).text);
			const path =
				node === undefined
					? undefined
					: resolveContextPath(node, context, root);
			const field =
				sibling?.purpose === "trimmed"
					? sibling.field
					: path === undefined
						? undefined
						: fieldAt(xform, path);
			if (field !== undefined) out.add(field);
		}
	}
	return out;
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
	// The own arm takes the UUID a reading gives its block's key, which `doc`
	// does not hold (`identityMap.ts::reReadUuidOf`).
	const reRead = reReadUuidOf(doc, DERIVED_WIRE_IDENTITY);
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
			arm.uuid = reRead(entry);
		}
	});
}
