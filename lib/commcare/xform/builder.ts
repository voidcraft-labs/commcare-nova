import { caseOptionsNodeset, fieldTakesCaseChoices } from "../caseOptions";
import { caseTypeDepthMap } from "../caseTypeDepths";
/**
 * XForm XML emitter.
 *
 * Walks a single form in the normalized `BlueprintDoc` and emits its
 * complete XForm XML: `<instance>` data nodes, `<bind>` elements, setvalues,
 * body controls (input, select, group, repeat, trigger, upload, secret),
 * itext translation entries, Connect data blocks, and the secondary
 * instance declarations required by any XPath or label that references
 * `#case/`, `#user/`, or the commcare session.
 *
 * The emitter CONSTRUCTS a `domhandler` element tree and serializes it once
 * with `serializeXml`; it never assembles XML by string concatenation. This
 * is a deliberate totality property: a string-concatenated emitter can produce
 * malformed bytes (an unescaped `<` in a label, an unbalanced tag from a
 * mishandled edge case), and only a test can catch it after the fact. A
 * constructed tree is well-formed BY CONSTRUCTION — the serializer owns every
 * byte of escaping and tag balancing, so malformed output is unrepresentable,
 * not merely untested. `escapeXml` is intentionally absent from this file:
 * hand-escaping a value and then handing it to the serializer would
 * double-encode it (`&` → `&amp;` → `&amp;amp;`), so the serializer is the
 * single, exclusive escaping authority here.
 *
 * Walkers consume `doc.fieldOrder[parentUuid]` and `doc.fields[fieldUuid]`,
 * using `doc.fieldOrder[fieldUuid]` being defined as the "this field is a
 * container" marker. The caller supplies the random xmlns and optional
 * Connect config via `BuildXFormOptions`.
 *
 * Every CommCare wire invariant this file encodes — the dual `vellum:*`
 * attribute pattern, markdown-form itext duplication, hashtag-prose
 * wrapping, `jr:itext(...)` constraint messages, `jr-insert` defaults
 * inside repeats, secondary-instance accumulation — is part of what
 * HQ and the Vellum editor expect on import. Do not "simplify" the
 * emitted bytes.
 */

import { type ChildNode, type Element, isTag } from "domhandler";
import { decodeXML } from "entities";
import {
	effectiveAssessmentUserScore,
	effectiveDeliverEntities,
} from "@/lib/commcare/connectDefaults";
import {
	connectConfigWritesBlocks,
	type ResolvedConnectConfig,
} from "@/lib/commcare/connectSlugs";
import {
	el,
	text,
	type WireElementContext,
	type WireElementSpec,
	xel,
} from "@/lib/commcare/elementBuilders";
import { commCareLocalization } from "@/lib/commcare/localization";
import type { LookupWireNaming } from "@/lib/commcare/lookup/naming";
import type { AssetManifest } from "@/lib/commcare/multimedia/assetWirePath";
import { itextMediaValues } from "@/lib/commcare/multimedia/itextMedia";
import { serializeXml } from "@/lib/commcare/serializeXml";
import { newCaseIdDatumId } from "@/lib/commcare/session";
import type {
	HqCaseSaveReference,
	OpenSubCaseAction,
	UpdateCaseAction,
} from "@/lib/commcare/types";
import {
	UPLOAD_APPEARANCE_BY_CAPTURE_KIND,
	UPLOAD_MEDIATYPE_BY_CAPTURE_KIND,
} from "@/lib/commcare/xform/captureUpload";
import {
	type AttachmentUrlTarget,
	captureUrlCalculate,
	captureUrlNodePath,
} from "@/lib/commcare/xform/captureUrlNode";
import {
	attachCaseOperationBody,
	attachCaseOperationData,
	bindLookupFilterFieldPaths,
	buildCaseOperations,
	caseScalarTextValueCalculation,
	caseScalarTextValueGuard,
	collectFieldLocations,
	type FieldLocation,
} from "@/lib/commcare/xform/caseOps";
import { caseSaveReferences } from "@/lib/commcare/xform/caseSaveReferences";
import { planConstraintCollections } from "@/lib/commcare/xform/constraintCollections";
import { xformDataRootRuntimeAttributes } from "@/lib/commcare/xform/dataRootAttributes";
import { FormPath } from "@/lib/commcare/xform/formPath";
import { orderedFieldUuids } from "@/lib/doc/fieldWalk";
import {
	type BlueprintDoc,
	type CaseScalarTextGuard,
	caseCreateNameFields,
	caseScalarTextGuardIsChecked,
	caseScalarTextGuards,
	expressionSlotValue,
	type Field,
	type FieldKind,
	fieldKindCarriesValidation,
	isCaptureField,
	isCaptureFieldKind,
	isContainer,
	type Media,
	type ProseReferencePart,
	type ProseTemplate,
	proseTemplateIsEmpty,
	type Uuid,
	userPropertySlugsByUuid,
} from "@/lib/domain";
import { effectiveCaseTypes } from "@/lib/domain/effectiveCaseTypes";
import { isMatchAll } from "@/lib/domain/expression/builders";
import { simplifyForEmission } from "@/lib/domain/expression/simplify";
import type { DatumRef, Expression } from "@/lib/domain/expression/types";
import { fieldValueType } from "@/lib/domain/fieldValueType";
import { formWireName } from "@/lib/domain/formWireName";
import type { LookupOptionsSource } from "@/lib/domain/lookupCarriers";
import { moduleUuidOfForm } from "@/lib/domain/postSubmit";
import {
	entryDatumIdResolver,
	entryDatumIds,
	formLinkProjectionContext,
} from "../formLinkProjection";
import { w } from "../xpath/wire/builders";
import { toWire } from "../xpath/wire/fromExpression";
import {
	InstanceSink,
	lookupInstance,
	sessionInstance,
} from "../xpath/wire/instances";
import { caseById, casePropertyStep } from "../xpath/wire/rowScope";
import type { WireExpr } from "../xpath/wire/tree";
import { protectConstraintMessage } from "./constraintMessage";
import {
	datetimeCaseValueCalculate,
	datetimeCaseValuePath,
} from "./datetimeCaseValue";
import {
	type FormExpressionEmission,
	formExpressionEmission,
} from "./formExpressions";
import {
	type GeneratedNodePlan,
	planGeneratedNodes,
	trimmedValuePath,
} from "./generatedNodes";
import {
	fieldItextKey,
	formItextUnits,
	itextProseSlot,
	itextTranslationUnitId,
} from "./itextIds";

interface ItextRegistration {
	readonly registered: boolean;
	readonly protectedConstraint?: WireExpr;
}
type AddItext = (
	id: string,
	label: ProseTemplate | undefined,
	media?: Media,
	force?: boolean,
	protectConstraint?: boolean,
) => ItextRegistration;

function isConsumerWhitespace(value: string): boolean {
	for (let index = 0; index < value.length; index++) {
		const unit = value.charCodeAt(index);
		// Core removes Java String.trim()-empty text nodes; HQ's lxml indent
		// additionally replaces whitespace-only tails using Python's isspace.
		if (
			unit > 0x20 &&
			unit !== 0x85 &&
			unit !== 0xa0 &&
			unit !== 0x1680 &&
			!(unit >= 0x2000 && unit <= 0x200a) &&
			unit !== 0x2028 &&
			unit !== 0x2029 &&
			unit !== 0x202f &&
			unit !== 0x205f &&
			unit !== 0x3000
		) {
			return false;
		}
	}
	return true;
}

function whitespaceOutput(value: string, context: WireElementContext): Element {
	if (Array.from(value).every((unit) => unit.charCodeAt(0) <= 0x20)) {
		return xel("output", { xpath: { value: w.str(value) } }, context);
	}
	// Vellum's XML serializer replaces every literal NBSP, including those
	// inside attributes. ASCII JSON escapes survive that save and HQ's indent;
	// Core's json-property decodes the exact characters at substitution time.
	// The input is whitespace only, so the XPath literal cannot contain '.
	const json = JSON.stringify({ v: value });
	let ascii = "";
	for (let index = 0; index < json.length; index++) {
		const unit = json.charCodeAt(index);
		ascii +=
			unit > 0x7f ? `\\u${unit.toString(16).padStart(4, "0")}` : json[index];
	}
	return xel(
		"output",
		{ xpath: { value: w.call("json-property", [w.str(ascii), w.str("v")]) } },
		context,
	);
}

function literalLabelNodes(
	literal: string,
	context: WireElementContext,
): ChildNode[] {
	if (isConsumerWhitespace(literal))
		return [whitespaceOutput(literal, context)];
	// NBSP is also replaced inside ordinary prose, not just between outputs.
	const fragments = literal.split("\u00a0");
	return fragments.flatMap((fragment, index) => [
		...(index > 0 ? [whitespaceOutput("\u00a0", context)] : []),
		...(fragment.length > 0
			? [
					isConsumerWhitespace(fragment)
						? whitespaceOutput(fragment, context)
						: text(fragment),
				]
			: []),
	]);
}

/**
 * Build the ordered itext-value node list for one typed prose template, letting
 * `serializeXml` (at final assembly) own ALL escaping.
 *
 * A label is natural-language prose whose references are explicit typed atoms,
 * not hashtag-looking substrings and not markup.
 *
 * Instead we CONSTRUCT a DOM directly and never parse the label as markup:
 *
 *   - Non-whitespace prose runs become a `Text` node
 *     whose data is `decodeXML(run)`. Decoding normalizes any pre-escaped
 *     entity the author may have typed (the historical `&lt;` workaround → `<`)
 *     so the serializer re-escapes it exactly once — `&lt;`, never the
 *     double-escaped `&amp;lt;` that would show a literal `&lt;` on device.
 *   - Whitespace-only runs become `<output>` nodes.
 *     Core's `XFormParser.getXMLDocument` discards text nodes whose Java
 *     `String.trim()` result is empty before it parses label outputs. A
 *     literal output preserves those separators, including paragraph breaks.
 *     HQ's build also replaces Unicode whitespace-only tails. ASCII runs
 *     use XPath literals; Unicode runs use ASCII JSON escapes consumed by
 *     Core's json-property. Embedded NBSP uses the same protected spelling
 *     because Vellum replaces literal NBSP throughout its serialized XML.
 *   - Each typed reference atom becomes a constructed self-closing `<output>`
 *     element. Its runtime value and eligible Vellum shadow serialize the
 *     same typed tree; the serializer withholds unsupported editor vocabulary.
 *
 * Author-written `<output ...>` markup or hashtag-looking literal text is
 * deliberately not recognized. Both serialize as ordinary escaped text.
 *
 * Returns a fresh node array on every call: the dual `<value>` + `<value
 * form="markdown">` itext duplicate needs INDEPENDENT node instances under the
 * two `<value>` parents (a domhandler node has a single parent pointer, so
 * sharing instances would re-parent and corrupt the first `<value>`), and
 * calling this builder once per `<value>` is how the caller gets them.
 */
function buildLabelNodes(
	template: ProseTemplate,
	lower: (part: ProseReferencePart) => WireExpr,
	context: WireElementContext,
): ChildNode[] {
	const nodes: ChildNode[] = [];
	for (const part of template.parts) {
		if (part.kind === "text") {
			nodes.push(...literalLabelNodes(decodeXML(part.text), context));
			continue;
		}
		const value = lower(part);
		nodes.push(
			xel("output", { xpath: { value, "vellum:value": value } }, context),
		);
	}
	return nodes;
}

const CONNECT_XMLNS = "http://commcareconnect.com/data/v1/learn";

/**
 * Build the Connect data blocks + matching binds for a form.
 *
 * Each Connect entity uses a two-level wrapper Vellum recognizes via the
 * `vellum:role` attribute: without it, HQ treats the wrapper as a plain
 * hidden XForm node and the child binds (user_score, entity_id, etc.)
 * fail at runtime. Each wrapper gets its own `vellum:nodeset` bind plus
 * a bind per declared sub-node so CommCare has paths to write to.
 */
function buildConnectBlocks(
	connect: ResolvedConnectConfig | undefined,
	context: WireElementContext,
	expressions: FormExpressionEmission,
): { dataElements: Element[]; binds: Element[] } {
	const dataElements: Element[] = [];
	const binds: Element[] = [];

	if (!connectConfigWritesBlocks(connect)) return { dataElements, binds };

	if (connect.learn_module) {
		const lm = connect.learn_module;
		// `lm.id` is the connect block's id — already a valid, unique, ≤50
		// slug (forced correct at the source; the resolver only passed it
		// through). It threads identically into the wrapper element name, the
		// `id=` attribute, and the bind nodeset below, so all three references
		// to this block always agree.
		const lmId = lm.id;
		const lmPath = FormPath.root().child(lmId);
		dataElements.push(
			el(lmId, { "vellum:role": "ConnectLearnModule" }, [
				el("module", { xmlns: CONNECT_XMLNS, id: lmId }, [
					el("name", {}, [text(lm.name)]),
					el("description", {}, [text(lm.description)]),
					el("time_estimate", {}, [text(String(lm.time_estimate))]),
				]),
			]),
		);
		binds.push(
			xel(
				"bind",
				{
					xpath: {
						"vellum:nodeset": lmPath.toWire("hashtag"),
						nodeset: lmPath.toWire(),
					},
				},
				context,
			),
		);
	}

	if (connect.assessment) {
		const assessId = connect.assessment.id;
		// `user_score` is optional in the domain. `effectiveAssessmentUserScore`
		// resolves it against the canonical default — same helper the
		// session-preload builder calls, so the bind XML and the
		// case-references load map agree on which XPath actually runs at
		// form-fill time.
		const userScore = effectiveAssessmentUserScore(connect.assessment);
		const assessPath = FormPath.root().child(assessId);
		dataElements.push(
			el(assessId, { "vellum:role": "ConnectAssessment" }, [
				el("assessment", { xmlns: CONNECT_XMLNS, id: assessId }, [
					el("user_score", {}),
				]),
			]),
		);
		binds.push(
			xel(
				"bind",
				{
					xpath: {
						"vellum:nodeset": assessPath.toWire("hashtag"),
						nodeset: assessPath.toWire(),
					},
				},
				context,
			),
			xel(
				"bind",
				{
					xpath: {
						nodeset: assessPath
							.child("assessment")
							.child("user_score")
							.toWire(),
						calculate: expressions.lower(userScore, {
							entity: "form",
							uuid: expressions.form.formUuid,
							slot: "assessment_user_score",
						}),
					},
				},
				context,
			),
		);
	}

	if (connect.deliver_unit) {
		const du = connect.deliver_unit;
		const duId = du.id;
		// `entity_id` / `entity_name` are optional in the domain.
		// `effectiveDeliverEntities` resolves them against the canonical
		// defaults — same helper the session-preload builder calls, so
		// the bind XML and the case-references load map agree on which
		// XPaths actually run at form-fill time.
		const { entityId, entityName } = effectiveDeliverEntities(du);
		const duPath = FormPath.root().child(duId);
		dataElements.push(
			el(duId, { "vellum:role": "ConnectDeliverUnit" }, [
				// HQ's form builder lists `work_area_id` after `entity_name` and
				// writes it with a bare bind (`commcareConnect.js`,
				// `ConnectDeliverUnit.childNodes`); Connect reads the empty value
				// as no work area (`form_receiver/processor.py::
				// process_deliver_unit`).
				el("deliver", { xmlns: CONNECT_XMLNS, id: duId }, [
					el("name", {}, [text(du.name)]),
					el("entity_id", {}),
					el("entity_name", {}),
					el("work_area_id", {}),
				]),
			]),
		);
		binds.push(
			xel(
				"bind",
				{
					xpath: {
						"vellum:nodeset": duPath.toWire("hashtag"),
						nodeset: duPath.toWire(),
					},
				},
				context,
			),
			xel(
				"bind",
				{
					xpath: {
						nodeset: duPath.child("deliver").child("entity_id").toWire(),
						calculate: expressions.lower(entityId, {
							entity: "form",
							uuid: expressions.form.formUuid,
							slot: "deliver_entity_id",
						}),
					},
				},
				context,
			),
			xel(
				"bind",
				{
					xpath: {
						nodeset: duPath.child("deliver").child("entity_name").toWire(),
						calculate: expressions.lower(entityName, {
							entity: "form",
							uuid: expressions.form.formUuid,
							slot: "deliver_entity_name",
						}),
					},
				},
				context,
			),
			xel(
				"bind",
				{
					xpath: {
						nodeset: duPath.child("deliver").child("work_area_id").toWire(),
					},
				},
				context,
			),
		);
	}

	if (connect.task) {
		const t = connect.task;
		const taskId = t.id;
		const taskPath = FormPath.root().child(taskId);
		dataElements.push(
			el(taskId, { "vellum:role": "ConnectTask" }, [
				el("task", { xmlns: CONNECT_XMLNS, id: taskId }, [
					el("name", {}, [text(t.name)]),
					el("description", {}, [text(t.description)]),
				]),
			]),
		);
		binds.push(
			xel(
				"bind",
				{
					xpath: {
						"vellum:nodeset": taskPath.toWire("hashtag"),
						nodeset: taskPath.toWire(),
					},
				},
				context,
			),
		);
	}

	return { dataElements, binds };
}

/**
 * Options threaded into `buildXForm`. `xmlns` is the random instance
 * namespace HQ expects on every form (generated once per form by the
 * expander); `connect` is the resolved Connect config to embed (the
 * pass-through output of `buildConnectSlugMap`, whose ids are valid by
 * construction at the source) — omitted when the app-level `connectType` is
 * unset or the form carries no Connect block.
 */
export interface BuildXFormOptions {
	xmlns: string;
	connect?: ResolvedConnectConfig;
	/**
	 * The owning module's case type — the form's own loaded case. Drives the
	 * reachable-case-type depth map so `#<case_type>/<prop>` refs resolve to the
	 * right parent-index walk. `undefined` for survey-only/case-less modules:
	 * the depth map is then empty and only `#form/` and `#user/` resolve.
	 */
	moduleCaseType?: string;
	/** Session reference of the selected own case. Nested child menus may use
	 * an HQ-aligned id such as `case_id_guppy`. */
	selectedCaseIdRef?: WireExpr;
	/**
	 * The search answers a no-matches registration form reads (`#search/`):
	 * the inline search's search-input instance and the host module's prompt
	 * names. The instance is declared when a `#search/` read is present.
	 */
	searchAnswers?: {
		readonly instanceId: `search-input:${string}`;
		readonly names: ReadonlyMap<Uuid, string>;
	};
	/** Canonical authored ownership before a wire-only menu placement. */
	expressionDoc?: BlueprintDoc;
	/** The entry's emitted datum names, resolved from domain identity. */
	datumId?: (datum: DatumRef) => string | undefined;
	/** Collection-valued selected-entities instance for a multi-select entry. */
	selectedCasesInstanceId?: string;
	/** Ordinary primary writes lowered through the selected-case iteration. */
	multiSelectPrimaryUpdate?: UpdateCaseAction["update"];
	/** Ordinary child actions; extensions and several-case creates ride source. */
	ordinarySubcases?: readonly OpenSubCaseAction[];
	/**
	 * Resolved media assets for this emission run. When present, the
	 * itext entries gain `<value form="image|audio|video">` siblings for
	 * any field/option media slot, and leaf controls gain a `<help>` ref.
	 * When `undefined`, media emission is off (the validation loop and
	 * any preview that doesn't load assets) and the XForm carries no
	 * media references — structurally valid, just media-free.
	 */
	assets?: AssetManifest;
	/**
	 * Lookup wire vocabulary for this emission run, derived from the exact
	 * validated definitions snapshot. Present only on the local-CCZ path —
	 * the sole path allowed to lower lookup carriers. When `undefined`, a
	 * carrier reaching an emitter throws, because every non-CCZ surface
	 * rejects carriers before emission.
	 */
	lookupNaming?: LookupWireNaming;
	/**
	 * The CommCare HQ origin and project space a capture's case-bound URL
	 * resolves against, when one is known.
	 *
	 * `undefined` means no deployment target has been resolved for this
	 * emission, so a URL-mode capture emits its `<upload>` question and
	 * nothing else: no address node, no bind, and no case update. There is
	 * no placeholder origin, because a link that looks deliberate and
	 * resolves nowhere is worse than an absent one. `buildFormActions`
	 * drops the same writers from the same input, so the two cannot
	 * disagree about whether the property is written.
	 */
	attachmentTarget?: AttachmentUrlTarget;
}

/**
 * `setvalues` ordered by where each target stands in the primary instance,
 * an attribute at its element. Setvalues on one element keep their order.
 */
function inDataTreeOrder(
	setvalues: readonly Element[],
	data: Element,
): Element[] {
	const position = new Map<string, number>();
	const visit = (element: Element, path: FormPath): void => {
		position.set(path.toXPath(), position.size);
		for (const child of element.children) {
			if (isTag(child)) visit(child, path.child(child.name));
		}
	};
	visit(data, FormPath.root());
	const at = (setvalue: Element): number => {
		const ref = setvalue.attribs.ref ?? "";
		const target = FormPath.parse(ref);
		return (
			position.get(
				(target.endsInAttribute() ? target.parent() : target).toXPath(),
			) ?? position.size
		);
	};
	return setvalues
		.map((setvalue, index) => ({ setvalue, index, at: at(setvalue) }))
		.sort((a, b) => a.at - b.at || a.index - b.index)
		.map(({ setvalue }) => setvalue);
}

/**
 * The questions of one form a case name or an external id comes from
 * (`lib/domain/caseScalarTextGuard.ts`): each takes a trimmed sibling, a
 * visible one carries the check, and one that names a created case is
 * required.
 */
interface FormCaseScalarText {
	readonly guards: ReadonlyMap<Uuid, CaseScalarTextGuard>;
	readonly createNames: ReadonlySet<Uuid>;
}

/** A form's source and the `case_references_data.save` map derived from it. */
export interface XFormSource {
	xml: string;
	caseSaveReferences: Record<string, HqCaseSaveReference>;
}

/** Emit the full XForm XML for `formUuid` (`buildXFormSource`'s `xml`). */
export function buildXForm(
	doc: BlueprintDoc,
	formUuid: Uuid,
	opts: BuildXFormOptions,
): string {
	return buildXFormSource(doc, formUuid, opts).xml;
}

/**
 * Emit the full XForm XML for `formUuid` and its Save to Case references.
 * Walks the form's field order (plus any container children), accumulates
 * data / binds / setvalues / body / itext / instances as constructed
 * elements, assembles them under the `<h:html>` root, derives the
 * `case_references_data.save` map from that tree, and serializes the tree
 * once.
 */
export function buildXFormSource(
	doc: BlueprintDoc,
	formUuid: Uuid,
	opts: BuildXFormOptions,
): XFormSource {
	const localization = commCareLocalization(doc);

	// The case types this form can READ, name → parent-index hop depth (own = 0,
	// parent = 1, …). Built from the owning module's case type via the shared
	// `caseTypeDepthMap` — the SAME construction `buildCaseReferencesLoad`
	// translates its load entries through, and the same `reachableCaseTypes`
	// source the deep validator's accept map reads — so a `#<type>/<prop>` ref
	// the validator accepted resolves on the wire to the matching
	// `…/index/parent × depth …/<prop>` walk and the load map names the same
	// case as the binds. Empty when the module has no case type.
	const caseTypeDepths = caseTypeDepthMap(
		opts.moduleCaseType,
		doc.caseTypes ?? [],
	);
	const instances = new InstanceSink();
	const context: WireElementContext = {
		mode: { target: "xform", constraint: false },
		instances,
	};
	const lookupSelects = deriveLookupSelectKit(
		doc,
		formUuid,
		opts.lookupNaming,
		caseTypeDepths,
		opts.selectedCaseIdRef,
		opts.moduleCaseType,
	);
	const dataElements: Element[] = [];
	const binds: Element[] = [];
	const setvalues: Element[] = [];
	const bodyElements: Element[] = [];
	const itextEntries = new Map(
		localization.languages.map((language) => [language, [] as Element[]]),
	);
	let datumId = opts.datumId;
	const expressions = formExpressionEmission(
		doc,
		formUuid,
		opts.lookupNaming,
		{
			formCaseProperty: lookupSelects.formCaseProperty,
			userPropertySlugs: lookupSelects.userPropertySlugs,
			organizationLevels: doc.organizationLevels ?? {},
			...(opts.lookupNaming === undefined
				? {}
				: { lookup: { naming: opts.lookupNaming, instanceScope: "xform" } }),
			...(opts.searchAnswers === undefined
				? {}
				: {
						searchInputInstanceId: opts.searchAnswers.instanceId,
						searchInputNames: opts.searchAnswers.names,
					}),
			datumId: (ref) => {
				if (datumId === undefined) {
					const moduleUuid = moduleUuidOfForm(doc, formUuid);
					if (moduleUuid === undefined)
						throw new Error("A form datum needs its owning module.");
					const entryContext = formLinkProjectionContext(doc, {
						expressionDoc: opts.expressionDoc,
						entryMetadataOnly: true,
						attachmentTarget: opts.attachmentTarget ?? null,
						lookupNaming: opts.lookupNaming,
					});
					datumId = entryDatumIdResolver(
						entryDatumIds(doc, entryContext, moduleUuid, formUuid),
					);
				}
				return datumId(ref);
			},
		},
		opts.expressionDoc,
	);
	const itextUnits = formItextUnits(expressions.form);
	const itextUnitIds = new Map(
		[...itextUnits].map(([id, unit]) => [id, itextTranslationUnitId(unit)]),
	);

	// The OpenRosa `<meta>` block is NOT emitted here. It is a CCHQ build-time
	// artifact (`xform.py::_add_meta_2`): the HQ-upload source omits it and CCHQ
	// regenerates it on render, while the local `.ccz` path injects it via
	// `xform/metaBlock.ts::addMetaBlock` (same split as the case transaction
	// blocks). A meta block in the uploaded source can't be opened in CCHQ's form
	// builder, so it belongs only on the `.ccz` where bytes ship without a render
	// step. This emitter therefore requires `commcaresession` only when a field
	// XPath, case datum, or Connect expression actually references it — never
	// unconditionally.

	// Register an itext `<text>` entry. Every entry emits both the plain value
	// AND a `<value form="markdown">` duplicate — CommCare only renders
	// markdown when the markdown form is present, and it's a no-op for plain
	// text. Without the duplicate, `**bold**` renders as literal asterisks on
	// device. `buildLabelNodes` is called ONCE PER `<value>` so each gets
	// independent node instances (a domhandler node has a single parent).
	//
	// `media` appends `<value form="image|audio|video">jr://file/...` siblings
	// after the text values (the CCHQ shape — see `multimedia/itextMedia.ts`).
	// An entry with media but no text still emits — the text `<value>` is just
	// empty (`buildLabelNodes("")` yields no children), matching CCHQ's
	// media-only itext shape — so a slot can carry media without text. An
	// entry blank in every language with no media is skipped, and its body
	// ref with it: HQ's form builder writes no such item and drops the
	// reference to it on save (`javaRosa/util.js::getItextItemsFromMugs`), so
	// a leaf whose label is blank everywhere carries no `<label>`. Only an
	// option label is `force`d: each `<item>` needs its `<label>`, and the
	// validator refuses a written choice with no label and no media
	// (`SELECT_OPTION_LABEL_EMPTY`) before emission.
	const addItext: AddItext = (
		id: string,
		label: ProseTemplate | undefined,
		media?: Media,
		force = false,
		protectConstraint = false,
	): ItextRegistration => {
		// Every localized prose value contributes instance reads when its output
		// attributes are serialized; untranslated or unused text declares nothing.
		const sourceMediaValues = itextMediaValues(
			media,
			opts.assets,
			"buildXForm",
		);
		const sourceTemplate = label ?? { parts: [] };
		const unitId = itextUnitIds.get(id);
		const unit = itextUnits.get(id);
		const lowerProse = (part: ProseReferencePart): WireExpr => {
			if (unit === undefined)
				throw new Error(`The reference in ${id} has no owning prose slot.`);
			return expressions.prose(part, itextProseSlot(unit));
		};
		const localizedTemplates = localization.languages.map((language) =>
			unitId === undefined
				? sourceTemplate
				: localization.prose(language, unitId),
		);
		if (
			!force &&
			localizedTemplates.every(proseTemplateIsEmpty) &&
			sourceMediaValues.length === 0
		)
			return { registered: false };
		const protectedMessage = protectConstraint
			? protectConstraintMessage(
					id,
					localization.languages.map((language, index) => ({
						language,
						template: localizedTemplates[index] ?? sourceTemplate,
					})),
					lowerProse,
				)
			: undefined;
		for (const [index, language] of localization.languages.entries()) {
			const languageEntries = itextEntries.get(language);
			if (languageEntries === undefined) {
				throw new Error(`Missing XForm itext table for ${language}.`);
			}
			const labelTemplate = localizedTemplates[index] ?? sourceTemplate;
			languageEntries.push(
				el("text", { id }, [
					el("value", {}, buildLabelNodes(labelTemplate, lowerProse, context)),
					el(
						"value",
						{ form: "markdown" },
						buildLabelNodes(labelTemplate, lowerProse, context),
					),
					...itextMediaValues(media, opts.assets, "buildXForm"),
					...(protectedMessage?.forms.get(language) ?? []),
				]),
			);
		}
		return {
			registered: true,
			protectedConstraint: protectedMessage?.expression,
		};
	};
	// Every name the form's generated nodes carry, from the one allocator the
	// case-operation emitter and `formActions.ts` read too.
	const generatedNodes = planGeneratedNodes(doc, formUuid);
	const caseScalarText: FormCaseScalarText = {
		guards: caseScalarTextGuards(doc, formUuid),
		createNames: caseCreateNameFields(doc, formUuid),
	};

	for (const fieldUuid of orderedFieldUuids(doc, formUuid)) {
		buildFieldParts(
			doc,
			fieldUuid,
			FormPath.root(),
			dataElements,
			binds,
			setvalues,
			bodyElements,
			false,
			addItext,
			context,
			expressions,
			opts.assets,
			lookupSelects,
			opts.attachmentTarget,
			generatedNodes,
			caseScalarText,
		);
	}

	// Connect data + binds are data-only (no body elements).
	const connectParts = buildConnectBlocks(opts.connect, context, expressions);
	dataElements.push(...connectParts.dataElements);
	binds.push(...connectParts.binds);

	// `<h:title>` and the data node's `name` both carry the form's name in
	// the app's default language, the name HQ's form builder writes into both
	// on a save in that editing language.
	const wireName = formWireName(doc, formUuid);
	const dataRootRuntimeAttributes = xformDataRootRuntimeAttributes(wireName);

	// Assemble the model: primary instance (the data tree), then the
	// accumulated secondary instances, binds, setvalues, and the itext block.
	// Element ORDER within the model is significant to JavaRosa's parse, so it
	// mirrors the prior emitter's sequence exactly: instance → secondary
	// instances → binds → setvalues → itext.
	const dataEl = el(
		"data",
		{
			xmlns: opts.xmlns,
			"xmlns:jrm": "http://dev.commcarehq.org/jr/xforms",
			...dataRootRuntimeAttributes,
		},
		dataElements,
	);

	// Advanced case operations are authored source, shared by HQ upload and
	// local CCZ compilation. Their data containers splice under `/data` or the
	// exact referenced repeat template; their model binds/setvalues join the
	// normal accumulation before instances are materialized.
	const caseOperations = buildCaseOperations(
		doc,
		formUuid,
		generatedNodes,
		opts.moduleCaseType,
		instances,
		expressions,
		opts.lookupNaming,
		opts.selectedCaseIdRef,
		opts.selectedCasesInstanceId,
		opts.multiSelectPrimaryUpdate,
		opts.ordinarySubcases,
	);
	if (caseOperations !== null) {
		attachCaseOperationData(dataEl, caseOperations.dataChildren);
		binds.push(...caseOperations.binds);
		setvalues.push(...caseOperations.setvalues);
	}

	const modelChildren: ChildNode[] = [
		el("instance", {}, [dataEl]),
		...instances
			.declarations()
			.map(({ id, src }) => el("instance", { src, id })),
		...binds,
		// HQ's form builder writes setvalues in the order their targets stand
		// in the data tree (`writer.js::createSetValues`). Core runs the
		// setvalues of one event in document order, so a row's identity is
		// still set before a nested repeat reads it.
		...inDataTreeOrder(setvalues, dataEl),
		el("itext", {}, [
			...localization.languages.map((language) =>
				el(
					"translation",
					{
						lang: language,
						...(language === localization.defaultLanguage
							? { default: "" }
							: {}),
					},
					itextEntries.get(language) ?? [],
				),
			),
		]),
	];

	// The head holds no `<vellum:hashtags>` or `<vellum:hashtagTransforms>`:
	// shadows carry `#form/` alone, which the editor knows on every form, and
	// a case read is raw casedb XPath that the editor's reverse map names
	// itself.
	const headChildren: ChildNode[] = [
		el("h:title", {}, [text(wireName)]),
		el("model", {}, modelChildren),
	];
	const body = el("h:body", {}, bodyElements);
	if (caseOperations !== null) {
		attachCaseOperationBody(body, caseOperations.bodyChildren);
	}

	const html = el(
		"h:html",
		{
			"xmlns:h": "http://www.w3.org/1999/xhtml",
			// `orx:` declared on the root unconditionally, matching Vellum's own
			// writer. This emitter's output uses no `orx:` element, but the `.ccz`
			// path splices the `<orx:meta>` block in (`xform/metaBlock.ts`), and the
			// prefix must already be in scope at the root or that block is malformed
			// XML. Declaring it here keeps both paths' bytes well-formed.
			"xmlns:orx": "http://openrosa.org/jr/xforms",
			xmlns: "http://www.w3.org/2002/xforms",
			"xmlns:xsd": "http://www.w3.org/2001/XMLSchema",
			"xmlns:jr": "http://openrosa.org/javarosa",
			"xmlns:vellum": "http://commcarehq.org/xforms/vellum",
		},
		[el("h:head", {}, headChildren), body],
	);

	// Single serialization of the whole tree. The XML declaration is the one
	// byte the serializer doesn't emit, so it's prepended literally.
	return {
		xml: `<?xml version="1.0"?>\n${serializeXml(html)}`,
		caseSaveReferences: caseSaveReferences(html),
	};
}

/**
 * Read the inline arm of a select field's final options-source union.
 * Lookup-backed selects emit an itemset and therefore have no inline choices.
 */
function readOptions(
	field: Field,
): Array<{ value: string; label: ProseTemplate; media?: Media }> | undefined {
	if (
		(field.kind !== "single_select" && field.kind !== "multi_select") ||
		field.optionsSource.kind !== "inline"
	) {
		return undefined;
	}
	// The inline array is the authored display sequence. This one accessor feeds
	// both itext registration and `<item>` emission, so their positional keys
	// cannot diverge.
	return [...field.optionsSource.options];
}

/**
 * Read a field's `Media` slot (`label_media` / `help_media`) regardless
 * of which kind declares it — the same union-wide lookup as `readOptions`. Returns `undefined` for kinds that don't carry the
 * slot (so the caller emits no media for it).
 */
function readFieldMedia(field: Field, key: string): Media | undefined {
	const value = (field as unknown as Record<string, unknown>)[key];
	return value as Media | undefined;
}

/**
 * Recursively emit the four XForm parts for a single field:
 *
 *   - `dataElements`: one `<instance>` data node per field
 *   - `binds`:       `<bind>` with expanded XPath + dual `vellum:*` attrs
 *   - `setvalues`:   `<setvalue>` for fields with a `default_value`
 *   - `bodyElements` + `itextEntries`: the `<h:body>` control + its labels
 *
 * Group / repeat containers recurse through `doc.fieldOrder[fieldUuid]` to
 * emit nested parts, then build their parent data element + container bind
 * from the children that were collected.
 *
 * Generated count values are siblings of their repeat. Data and bind slots
 * are rewritten in place after children are assembled.
 *
 * Itext IDs follow the logical field ancestry in `itextIds.ts`. Physical
 * query-repeat item steps never enter those IDs, and cousin fields with the
 * same authored id remain distinct in the form's flat itext namespace.
 */
function buildFieldParts(
	doc: BlueprintDoc,
	fieldUuid: Uuid,
	parentPath: FormPath,
	dataElements: Element[],
	binds: Element[],
	setvalues: Element[],
	bodyElements: Element[],
	insideRepeat: boolean,
	addItext: AddItext,
	context: WireElementContext,
	expressions: FormExpressionEmission,
	assets: AssetManifest | undefined,
	lookupSelects: LookupSelectEmissionKit | undefined,
	attachmentTarget: AttachmentUrlTarget | undefined,
	generatedNodes: GeneratedNodePlan,
	caseScalarText: FormCaseScalarText,
): void {
	const field = doc.fields[fieldUuid];
	const lookupSource =
		(field.kind === "single_select" || field.kind === "multi_select") &&
		field.optionsSource.kind === "lookup"
			? field.optionsSource
			: undefined;
	if (lookupSource !== undefined && lookupSelects?.naming === undefined) {
		throw new Error(
			"buildXForm: a lookup-backed select reached XForm emission with no lookup wire naming. The local-CCZ compile boundary supplies naming; every other surface should reject lookup carriers before emission.",
		);
	}
	const nodePath = parentPath.child(field.id);
	// Itext identity follows logical authored ancestry, shared with parsing
	// and expression printing even when physical repeats add an item node.
	const itextKey = fieldItextKey(expressions.form, fieldUuid);
	if (itextKey === undefined)
		throw new Error(`Field ${fieldUuid} has no reachable itext identity.`);

	const relevant = expressionSlotValue(doc, {
		entity: "field",
		uuid: fieldUuid,
		slot: "relevant",
	});
	const validate = expressionSlotValue(doc, {
		entity: "field",
		uuid: fieldUuid,
		slot: "validate",
	});
	const calculate = expressionSlotValue(doc, {
		entity: "field",
		uuid: fieldUuid,
		slot: "calculate",
	});
	const defaultValue = expressionSlotValue(doc, {
		entity: "field",
		uuid: fieldUuid,
		slot: "default_value",
	});
	const required = expressionSlotValue(doc, {
		entity: "field",
		uuid: fieldUuid,
		slot: "required",
	});
	const carrier = field as unknown as Record<string, unknown>;
	const label = carrier.label as ProseTemplate | undefined;
	const hint = carrier.hint as ProseTemplate | undefined;
	const help = carrier.help as ProseTemplate | undefined;
	const validateMsg = carrier.validate_msg as ProseTemplate | undefined;

	// Per-message media slots: a visible non-container field's label and an
	// input's help, the two a CommCare runtime draws media for. Each registers
	// `<value form="...">` siblings on its itext entry (via `addItext`). A
	// hint, a validation message and a group's or repeat's label carry text
	// alone, so none passes media. The `hint`/`help` body refs emit when the
	// slot would actually produce an entry. This is the body-ref-iff-entry
	// invariant: an optional ref must be predicated on the SAME condition
	// `addItext` uses to register the entry, not just on raw media-slot
	// presence — otherwise media-OFF (no manifest) with a media-only help set
	// would emit a body ref against a non-registered entry.
	const labelMedia = isContainer(field)
		? undefined
		: readFieldMedia(field, "label_media");
	const helpMedia = readFieldMedia(field, "help_media");
	const canValidate = fieldKindCarriesValidation(field.kind);
	const hasLabel =
		field.kind !== "hidden" &&
		addItext(`${itextKey}-label`, label, labelMedia).registered;
	const hasHint =
		field.kind !== "hidden" && addItext(`${itextKey}-hint`, hint).registered;
	const hasHelp =
		field.kind !== "hidden" &&
		addItext(`${itextKey}-help`, help, helpMedia).registered;
	const validationMessage = canValidate
		? addItext(`${itextKey}-constraintMsg`, validateMsg, undefined, false, true)
		: { registered: false };
	const hasValidationMessage = validationMessage.registered;

	// Containers replace this placeholder after assembling their children.
	const dataSlot = dataElements.length;
	dataElements.push(el(field.id, {}));

	// Both runtime and editor attributes serialize the same typed expression.
	// The Vellum serializer decides whether that expression has an editor spelling.
	const lower = (
		expression: Expression,
		slot: "required" | "relevant" | "calculate" | "default_value" | "validate",
	) =>
		expressions.lower(expression, { entity: "field", uuid: fieldUuid, slot });
	// A case name or an external id is checked at the question a worker
	// answers, on the kinds `caseScalarTextGuardIsChecked` names; Preview's
	// form engine checks the same ones.
	const scalarGuard = caseScalarText.guards.get(fieldUuid);
	const checksScalar =
		scalarGuard !== undefined && caseScalarTextGuardIsChecked(field.kind);
	const bindAttributes: Record<string, string> = {};
	const bindXPath: NonNullable<WireElementSpec<"bind">["xpath"]> = {
		"vellum:nodeset": nodePath.toWire("hashtag"),
		nodeset: nodePath.toWire(),
	};
	const bindType =
		fieldValueType(field, effectiveCaseTypes(doc)) === "datetime"
			? "xsd:dateTime"
			: getBindType(field.kind);
	if (bindType) bindAttributes.type = bindType;
	if (required) {
		// The editor's attribute for a required CONDITION is
		// `vellum:requiredCondition` (`Vellum/src/parser.js::parseBindElement`),
		// not `vellum:required` — Vellum never reads the latter, and an unread
		// `vellum:*` attribute survives into `rawBindAttributes` and accretes an
		// extra prefix on every editor save. The runtime semantics ride on the
		// real `required` attribute (JavaRosa builds its required condition from
		// it); the bare `requiredCondition` attribute Vellum itself writes is
		// deliberately NOT emitted — JavaRosa ignores it with an "unrecognized
		// attributes" parse warning, and Vellum reconstructs the condition from
		// `required` when it's absent.
		const value = lower(required, "required");
		bindXPath["vellum:requiredCondition"] = value;
		bindXPath.required = value;
	}
	// CommCare requires an answer to the question that names a case the form
	// creates. The stamp replaces an authored required condition, as HQ's
	// build merged it onto this bind (`xform.py::XFormCaseBlock.add_create_block`).
	// A Hidden Value takes no `required`: HQ's form builder marks one
	// "Required is not allowed." on every save.
	if (caseScalarText.createNames.has(fieldUuid) && field.kind !== "hidden") {
		delete bindXPath["vellum:requiredCondition"];
		bindXPath.required = w.call("true");
	}

	// Validation (constraint + constraintMsg) is meaningful only on input
	// kinds. Structural (group/repeat/label) and computed (hidden) fields have
	// no user-editable value to check — silently skip the attributes so an
	// upstream misconfiguration can't leak a garbage bind. The validator flags
	// `validate` on non-input kinds as its own error.
	// The check stands beside the author's own validation, so the author's
	// message shows for either failure; with none the runtime shows its own.
	const scalarCheck =
		scalarGuard === undefined
			? w.call("true")
			: caseScalarTextValueGuard(
					caseScalarTextValueCalculation(w.context([w.self()])),
					scalarGuard,
				);
	if (canValidate && validate) {
		const plan = planConstraintCollections(
			validate,
			fieldUuid,
			doc,
			nodePath,
			(n) => generatedNodes.constraintCount(fieldUuid, n),
		);
		const value = expressions.lower(
			plan.expression,
			{ entity: "field", uuid: fieldUuid, slot: "validate" },
			plan.overrides,
		);
		const constraint = checksScalar ? w.and(value, scalarCheck) : value;
		bindXPath["vellum:constraint"] = constraint;
		bindXPath.constraint = constraint;
		for (const calculation of plan.calculations) {
			dataElements.push(el(calculation.name, {}));
			binds.push(
				xel(
					"bind",
					{
						attributes: { type: "xsd:int" },
						xpath: {
							nodeset: calculation.path.toWire(),
							relevant: w.gt(w.call("count", [nodePath.toWire()]), w.num(0)),
							calculate: lower(calculation.expression, "validate"),
						},
					},
					context,
				),
			);
		}
	} else if (checksScalar) {
		bindXPath.constraint = scalarCheck;
	}

	// Standard messages use an itext reference. Protected messages compose
	// literal pieces and typed values in the raw expression: Core's alert
	// filler otherwise substitutes `${n}` in literal or referenced data. A
	// never-relevant label owner below retains the original itext/media in
	// HQ and Vellum even though the real question carries no alert. The gate uses the
	// same predicate `addItext` uses to register the entry, so the attribute
	// emits IFF an entry exists to back it. Media-OFF (no manifest) with only
	// media set produces no entry — the gate skips the attribute in lockstep
	// (a `jr:constraintMsg` ref against a non-registered entry is parse-fatal
	// at JavaRosa install).
	if (hasValidationMessage) {
		bindXPath["jr:constraintMsg"] =
			validationMessage.protectedConstraint ??
			w.call("jr:itext", [w.str(`${itextKey}-constraintMsg`)]);
	}

	if (relevant) {
		const value = lower(relevant, "relevant");
		bindXPath["vellum:relevant"] = value;
		bindXPath.relevant = value;
	}
	if (calculate) {
		const value = lower(calculate, "calculate");
		bindXPath["vellum:calculate"] = value;
		bindXPath.calculate = value;
	}

	// Setvalue for `default_value`. Inside a repeat group we fire on `jr-insert`
	// so each new iteration gets the default; outside, the one-shot
	// `xforms-ready` event is correct (Vellum chooses the same events). Every
	// form read prints relative to this question as `current()/...`, with no
	// `vellum:value`: HQ's form builder refuses a `#form/` reference in a
	// default and reads an absolute `/data/` path back as one.
	if (defaultValue) {
		setvalues.push(
			xel(
				"setvalue",
				{
					attributes: { event: insideRepeat ? "jr-insert" : "xforms-ready" },
					xpath: {
						"vellum:ref": nodePath.toWire("hashtag"),
						ref: nodePath.toWire(),
						value: lower(defaultValue, "default_value"),
					},
				},
				context,
			),
		);
	}

	// Record this leaf bind's slot so a container can rewrite it IN PLACE after
	// recursion — same reasoning as `dataSlot`: a descendant repeat may append
	// a generated sibling's bind to this same array, so a blind `pop()` would
	// remove the wrong entry.
	const bindSlot = binds.length;
	binds.push(
		xel(
			"bind",
			{
				attributes: bindAttributes,
				xpath: bindXPath,
			},
			context,
		),
	);

	// A capture saving to a case in URL mode carries a second node beside
	// it, holding the address of the submitted file. The capture question
	// answers with a server-minted file name; the case property wants
	// somewhere that file can be opened, and the two are different values.
	//
	// The node is a sibling rather than a hoisted form-root node so that a
	// capture inside a repeat produces one address per iteration, landing in
	// the same child-create bucket as the capture. It carries no body
	// control: nobody answers it.
	//
	// `captureUrlNodePath` reads the form's plan of generated nodes, which
	// `formActions.ts` reads too to name this exact node as the case update's
	// question path, so the two halves of the write agree.
	if (
		attachmentTarget !== undefined &&
		isCaptureField(field) &&
		field.caseWrite?.mode === "url"
	) {
		const urlPath = captureUrlNodePath(generatedNodes, fieldUuid, nodePath);
		dataElements.push(el(generatedNodes.url(fieldUuid), {}));
		binds.push(
			xel(
				"bind",
				{
					attributes: { type: "xsd:string" },
					xpath: {
						nodeset: urlPath.toWire(),
						calculate: captureUrlCalculate(nodePath, attachmentTarget),
						relevant: w.gt(w.call("count", [nodePath.toWire()]), w.num(0)),
					},
				},
				context,
			),
		);
	}

	if (
		"caseWrite" in field &&
		field.caseWrite !== undefined &&
		fieldValueType(field, effectiveCaseTypes(doc)) === "datetime"
	) {
		dataElements.push(el(generatedNodes.datetime(fieldUuid), {}));
		binds.push(
			xel(
				"bind",
				{
					attributes: { type: "xsd:string" },
					xpath: {
						nodeset: datetimeCaseValuePath(
							generatedNodes,
							fieldUuid,
							nodePath,
						).toWire(),
						calculate: datetimeCaseValueCalculate(nodePath),
						relevant: w.gt(w.call("count", [nodePath.toWire()]), w.num(0)),
					},
				},
				context,
			),
		);
	}

	// A case name or an external id is written trimmed, as Core and HQ store
	// it, from a sibling every write names. HQ's build binds an action's path
	// as it stands, so the trim lives in the source both export paths share,
	// and both store one value. A datetime answer is trimmed from its text
	// value. Like every generated sibling it leaves with its question, so a
	// question the worker never reaches leaves the case's value alone.
	if (scalarGuard !== undefined) {
		const valuePath =
			"caseWrite" in field &&
			field.caseWrite !== undefined &&
			fieldValueType(field, effectiveCaseTypes(doc)) === "datetime"
				? datetimeCaseValuePath(generatedNodes, fieldUuid, nodePath)
				: nodePath;
		dataElements.push(el(generatedNodes.trimmed(fieldUuid), {}));
		binds.push(
			xel(
				"bind",
				{
					xpath: {
						nodeset: trimmedValuePath(
							generatedNodes,
							fieldUuid,
							nodePath,
						).toWire(),
						calculate: caseScalarTextValueCalculation(valuePath.toWire()),
						relevant: w.gt(w.call("count", [nodePath.toWire()]), w.num(0)),
					},
				},
				context,
			),
		);
	}

	// Options (select kinds).
	//
	// itext ids are keyed by the option's stable array INDEX, not its `value` —
	// `${itextKey}-opt${index}-label`. Two options may legally share a `value`
	// (the domain's `selectOptionSchema` is `{ value, label }` with no
	// uniqueness constraint), but a value-keyed itext id would then collapse
	// both onto one id. CommCare's XForm parser hard-rejects a duplicate itext
	// id (`commcare-core/.../xform/parse/XFormParser.java::verifyTextMappings`,
	// reached from `parseItem`'s label-ref check), while it accepts two
	// `<item>`s sharing a `<value>` with no objection
	// (`XFormParser.java::parseItem` adds each `SelectChoice` with no
	// value-uniqueness check). So the collision lived purely in the itext
	// layer; an index key makes the id unique by construction. The `<item>`
	// emission below uses the identical scheme so no `<label ref>` dangles.
	// A lookup-backed select emits one <itemset> instead of inline <item>s,
	// so it has no option itext entries.
	const options = lookupSource !== undefined ? undefined : readOptions(field);
	if (options && options.length > 0) {
		options.forEach((opt, index) => {
			// Force-register every option's `-label` entry: each `<item>`
			// below emits an unconditional `<label ref="jr:itext(…-opt{i}-label)">`,
			// so the body-ref-iff-entry invariant forbids skipping the
			// registration even for an empty option label — a dangling ref
			// is parse-fatal in `verifyTextMappings`.
			addItext(`${itextKey}-opt${index}-label`, opt.label, opt.media, true);
		});
	}

	// Body element (varies by kind).
	if (field.kind === "hidden") {
		return; // no body; data + bind only
	}

	if (isContainer(field)) {
		buildContainer(
			doc,
			field,
			fieldUuid,
			nodePath,
			itextKey,
			hasLabel,
			relevant,
			insideRepeat,
			dataSlot,
			bindSlot,
			dataElements,
			binds,
			setvalues,
			bodyElements,
			addItext,
			context,
			expressions,
			assets,
			lookupSelects,
			attachmentTarget,
			generatedNodes,
			caseScalarText,
		);
		return;
	}

	// Leaf controls — every one carries a `<label>` referencing the field's
	// itext id, plus an optional `<hint>` and `<help>` (each emitted when its
	// text or media slot is present). The control element + any kind-specific
	// attributes are decided by `buildLeafControl`.
	const caseSource = fieldTakesCaseChoices(field)
		? field.optionsSource
		: undefined;
	let caseItemset: Element | undefined;
	if (caseSource) {
		const nodeset = caseOptionsNodeset(
			caseSource,
			expressions.context({
				entity: "field",
				uuid: fieldUuid,
				slot: "lookup_options_source",
			}),
			{
				formFields: lookupSelects?.filterFieldPaths(nodePath),
				formCaseProperty: lookupSelects?.formCaseProperty,
				userPropertySlugs: userPropertySlugsByUuid(doc),
				...(lookupSelects?.naming && {
					lookup: {
						naming: lookupSelects.naming,
						instanceScope: "xform" as const,
					},
				}),
			},
			expressions.projection,
		);
		caseItemset = xel("itemset", { xpath: { nodeset } }, context, [
			xel(
				"label",
				{
					xpath: {
						ref: w.context([casePropertyStep(caseSource.labelProperty)]),
					},
				},
				context,
			),
			xel("value", { xpath: { ref: w.context([w.attr("case_id")]) } }, context),
		]);
	}
	const itemset =
		caseItemset ??
		(lookupSource !== undefined && lookupSelects !== undefined
			? buildLookupItemset(
					lookupSource,
					lookupSelects,
					nodePath,
					context,
					expressions,
					fieldUuid,
				)
			: undefined);
	bodyElements.push(
		buildLeafControl(
			field,
			nodePath,
			itextKey,
			hasLabel,
			hasHint,
			hasHelp,
			hasValidationMessage &&
				validationMessage.protectedConstraint === undefined,
			context,
			itemset,
		),
	);
	if (validationMessage.protectedConstraint !== undefined) {
		const name = generatedNodes.constraintMessage(fieldUuid);
		const path = parentPath.child(name).toWire();
		dataElements.push(el(name, {}));
		binds.push(
			xel(
				"bind",
				{
					attributes: { type: "xsd:string" },
					xpath: {
						nodeset: path,
						relevant: w.call("false"),
						readonly: w.call("true"),
					},
				},
				context,
			),
		);
		bodyElements.push(
			xel("input", { xpath: { ref: path } }, context, [
				xel(
					"label",
					{
						xpath: {
							ref: w.call("jr:itext", [w.str(`${itextKey}-constraintMsg`)]),
						},
					},
					context,
				),
			]),
		);
	}
}

/**
 * Everything the itemset path needs from one emission run: the validated
 * lookup naming plus the form-wide field-path bindings for filter
 * references. Built once per form in `buildXForm`, only on the local-CCZ
 * path.
 */
interface LookupSelectEmissionKit {
	readonly naming: LookupWireNaming | undefined;
	readonly userPropertySlugs: ReadonlyMap<Uuid, string>;
	readonly formCaseProperty: (caseType: string, property: string) => WireExpr;
	readonly filterFieldPaths: (
		questionPath: FormPath,
	) => ReadonlyMap<Uuid, WireExpr>;
}

/** The kit exists exactly when naming does; the field-location walk is
 *  deferred and cached so carrier-free forms never pay for it. */
function deriveLookupSelectKit(
	doc: BlueprintDoc,
	formUuid: Uuid,
	naming: LookupWireNaming | undefined,
	caseTypeDepths: ReadonlyMap<string, number>,
	selectedCaseId: WireExpr | undefined,
	moduleCaseType: string | undefined,
): LookupSelectEmissionKit {
	let fieldLocations: ReadonlyMap<Uuid, FieldLocation> | undefined;
	return {
		naming,
		userPropertySlugs: userPropertySlugsByUuid(doc),
		formCaseProperty: (caseType, property) => {
			const depth = caseTypeDepths.get(caseType);
			if (depth === undefined)
				throw new Error("The form cannot read this record type.");
			if (
				doc.forms[formUuid].type === "registration" &&
				depth === 0 &&
				property === "case_id"
			) {
				if (moduleCaseType === undefined)
					throw new Error(
						"A registration form needs its record type to read its allocated id.",
					);
				return w.instance(sessionInstance(), [
					w.step("session"),
					w.step("data"),
					w.step(newCaseIdDatumId(moduleCaseType)),
				]);
			}
			let id: WireExpr =
				selectedCaseId ??
				w.instance(sessionInstance(), [
					w.step("session"),
					w.step("data"),
					w.step("case_id"),
				]);
			for (let hop = 0; hop < depth; hop++)
				id = w.append(caseById(id, "casedb"), [
					w.step("index"),
					w.step("parent"),
				]);
			return w.append(caseById(id, "casedb"), [casePropertyStep(property)]);
		},
		filterFieldPaths: (questionPath) => {
			fieldLocations ??= collectFieldLocations(doc, formUuid);
			return bindLookupFilterFieldPaths(fieldLocations, questionPath);
		},
	};
}

/**
 * Build the `<itemset>` for a lookup-backed select and register its
 * instance requirements.
 *
 * The nodeset iterates the embedded fixture's rows; `<label ref>` and
 * `<value ref>` name the label/value columns' current wire names as
 * row-relative steps. The filter predicate evaluates with the fixture row
 * as context and `current()` bound to the question node, so form answers
 * correlate through the shared field-path bindings; no case context exists
 * on the search screen, so the case anchor is unaddressable and any case
 * read (already validator-rejected) throws rather than emitting garbage.
 */
function buildLookupItemset(
	source: LookupOptionsSource,
	lookupSelects: LookupSelectEmissionKit,
	nodePath: FormPath,
	context: WireElementContext,
	expressions: FormExpressionEmission,
	fieldUuid: Uuid,
): Element {
	if (!lookupSelects.naming)
		throw new Error("Lookup choices need a wire naming catalog.");
	const table = lookupSelects.naming.tableFor(source.tableId);
	const predicates: WireExpr[] = [];
	if (source.filter !== undefined) {
		const filter = simplifyForEmission(source.filter);
		if (!isMatchAll(filter))
			predicates.push(
				toWire(filter, {
					target: "xform",
					types: expressions.context({
						entity: "field",
						uuid: fieldUuid,
						slot: "lookup_options_source",
					}),
					form: expressions.projection,
					anchor: { kind: "unaddressable" },
					bindings: {
						formFields: lookupSelects.filterFieldPaths(nodePath),
						userPropertySlugs: lookupSelects.userPropertySlugs,
						lookup: {
							naming: lookupSelects.naming,
							instanceScope: "xform",
							rowScope: {
								tableId: source.tableId,
								caseAnchor: { kind: "unaddressable" },
							},
						},
					},
				}),
			);
	}
	return xel(
		"itemset",
		{
			xpath: {
				nodeset: w.instance(
					lookupInstance(source.tableId, lookupSelects.naming, "xform"),
					[
						w.step(table.listElementName),
						w.step(table.rowElementName, predicates),
					],
				),
			},
		},
		context,
		[
			xel(
				"label",
				{
					xpath: {
						ref: w.context([w.step(table.wireNameFor(source.labelColumnId))]),
					},
				},
				context,
			),
			xel(
				"value",
				{
					xpath: {
						ref: w.context([w.step(table.wireNameFor(source.valueColumnId))]),
					},
				},
				context,
			),
		],
	);
}

/**
 * Build the `<h:body>` control for a non-container, non-hidden leaf field. All
 * leaf kinds share the `<label>` + optional `<hint>` itext-reference shape
 * (the `<label>` left out when the label is blank in every language and has
 * no media, as HQ's form builder leaves it); they differ only in the wrapping
 * control element and its attributes:
 *
 *   - select kinds → `<select1>` / `<select>` with one `<item>` per option;
 *   - label kind   → `<trigger appearance="minimal">`;
 *   - secret kind  → `<secret>`;
 *   - capture kinds → `<upload mediatype="...">` (+ `appearance="signature"`);
 *   - everything else (text/int/date/...) → `<input>`.
 */
function buildLeafControl(
	field: Field,
	nodePath: FormPath,
	itextKey: string,
	hasLabel: boolean,
	hasHint: boolean,
	hasHelp: boolean,
	hasValidationMessage: boolean,
	context: WireElementContext,
	itemset?: Element,
): Element {
	// The shared head of every control: the label reference, then the optional
	// hint and help references (in XForm body order: label → hint → help). A
	// ref emits only when its itext entry was registered (text or media
	// present), so no `<label>`/`<hint>`/`<help>` ever dangles against a
	// missing entry.
	const head: Element[] = [];
	if (hasLabel)
		head.push(
			xel(
				"label",
				{ xpath: { ref: w.call("jr:itext", [w.str(`${itextKey}-label`)]) } },
				context,
			),
		);
	if (hasHint)
		head.push(
			xel(
				"hint",
				{ xpath: { ref: w.call("jr:itext", [w.str(`${itextKey}-hint`)]) } },
				context,
			),
		);
	if (hasHelp)
		head.push(
			xel(
				"help",
				{ xpath: { ref: w.call("jr:itext", [w.str(`${itextKey}-help`)]) } },
				context,
			),
		);
	// Core fills output templates through the question's alert; its legacy
	// bind constraint-message fallback returns the unsubstituted template.
	// Both references use the same registered entry, including media gating.
	if (hasValidationMessage) {
		head.push(
			xel(
				"alert",
				{
					xpath: {
						ref: w.call("jr:itext", [w.str(`${itextKey}-constraintMsg`)]),
					},
				},
				context,
			),
		);
	}
	const ref = nodePath.toWire();

	if (field.kind === "single_select" || field.kind === "multi_select") {
		const tag = field.kind === "single_select" ? "select1" : "select";
		// A lookup-backed select carries exactly one <itemset> and zero inline
		// <item>s (JavaRosa rejects a select mixing both). Otherwise each
		// `<item>`'s `<label ref>`
		// references the same per-INDEX itext id registered by the caller
		// (`-opt${index}-label`), so duplicate option values never collide. The
		// `<value>` emits `opt.value` verbatim — the serializer escapes it;
		// JavaRosa permits duplicate `<value>`s.
		if (itemset !== undefined) {
			return xel(tag, { xpath: { ref: ref } }, context, [...head, itemset]);
		}
		const options = readOptions(field) ?? [];
		const items = options.map((opt, index) =>
			el("item", {}, [
				xel(
					"label",
					{
						xpath: {
							ref: w.call("jr:itext", [w.str(`${itextKey}-opt${index}-label`)]),
						},
					},
					context,
				),
				el("value", {}, [text(opt.value)]),
			]),
		);
		return xel(tag, { xpath: { ref: ref } }, context, [...head, ...items]);
	}

	if (field.kind === "label") {
		return xel(
			"trigger",
			{ attributes: { appearance: "minimal" }, xpath: { ref: ref } },
			context,
			head,
		);
	}

	if (field.kind === "secret") {
		return xel("secret", { xpath: { ref: ref } }, context, head);
	}

	if (isCaptureFieldKind(field.kind)) {
		// Both attribute values come from total tables keyed on the capture
		// kind, so an unmatched `mediatype` is unrepresentable rather than
		// merely unlikely — see `captureUpload.ts` for why the difference
		// matters (an unmatched value submits the literal string
		// `Not Supported by Web Entry` instead of failing).
		const uploadAttribs: Record<string, string> = {
			mediatype: UPLOAD_MEDIATYPE_BY_CAPTURE_KIND[field.kind],
		};
		const appearance = UPLOAD_APPEARANCE_BY_CAPTURE_KIND[field.kind];
		if (appearance !== undefined) uploadAttribs.appearance = appearance;
		return xel(
			"upload",
			{ attributes: uploadAttribs, xpath: { ref } },
			context,
			head,
		);
	}

	// Remaining input kinds: text, int, decimal, date, time, datetime,
	// geopoint, barcode. They all render as `<input>`; their per-kind bind
	// `type` (XSD for the scalar kinds, a bare ODK type for geopoint/barcode)
	// is added by the caller from `BIND_TYPE_BY_KIND`.
	return xel("input", { xpath: { ref: ref } }, context, head);
}

/**
 * Build a `group` / `repeat` container: recurse through children, rewrite the
 * parent data element + bind to wrap them, and emit the `<h:body>` control.
 *
 * Extracted from `buildFieldParts` because the container path is the bulk of
 * the per-kind logic (three repeat modes, calculated count values, the
 * model-iteration setvalue setup) and keeping it inline made the field walk
 * unreadable. The slot-rewrite contract is preserved exactly: the data
 * placeholder at `dataSlot` and the bind placeholder at `bindSlot` are
 * replaced in place (never `pop()`-ed), because a descendant repeat may have
 * appended generated siblings after them.
 */
function buildContainer(
	doc: BlueprintDoc,
	field: Field,
	fieldUuid: Uuid,
	nodePath: FormPath,
	itextKey: string,
	hasLabel: boolean,
	relevant: Expression | undefined,
	insideRepeat: boolean,
	dataSlot: number,
	bindSlot: number,
	dataElements: Element[],
	binds: Element[],
	setvalues: Element[],
	bodyElements: Element[],
	addItext: AddItext,
	context: WireElementContext,
	expressions: FormExpressionEmission,
	assets: AssetManifest | undefined,
	lookupSelects: LookupSelectEmissionKit | undefined,
	attachmentTarget: AttachmentUrlTarget | undefined,
	generatedNodes: GeneratedNodePlan,
	caseScalarText: FormCaseScalarText,
): void {
	// Containers recurse through children, then rewrite the parent data element
	// to wrap them and swap the leaf bind for a container bind (relevant-only
	// when one was set).
	const childData: Element[] = [];
	const childBinds: Element[] = [];
	const childBody: Element[] = [];
	const childSetvalues: Element[] = [];
	const childInsideRepeat = field.kind === "repeat" ? true : insideRepeat;

	// Query-bound repeats nest children under an extra `<item>` level (Vellum's
	// "model iteration" pattern). The outer `<id>` element holds
	// `@ids` / `@count` / `@current_index`; the inner `<item>` is the
	// per-iteration template. Rewriting `childParentPath` here propagates
	// `/item` into every descendant's bind nodeset, body ref, and setvalue ref
	// — not just the data section. user_controlled and count_bound repeats keep
	// the flat `<id>...</id>` shape with no rewrite.
	const isQueryBoundRepeat =
		field.kind === "repeat" && field.repeat_mode === "query_bound";
	const childParentPath = isQueryBoundRepeat
		? nodePath.queryBoundIteration()
		: nodePath;

	for (const childUuid of orderedFieldUuids(doc, fieldUuid)) {
		buildFieldParts(
			doc,
			childUuid,
			childParentPath,
			childData,
			childBinds,
			childSetvalues,
			childBody,
			childInsideRepeat,
			addItext,
			context,
			expressions,
			assets,
			lookupSelects,
			attachmentTarget,
			generatedNodes,
			caseScalarText,
		);
	}

	// Rewrite the self-closing data placeholder with a proper parent wrapping
	// its children. Three shapes:
	//   - group: `<id>...</id>`
	//   - user_controlled / count_bound repeat: `<id jr:template="">...</id>`
	//   - query_bound repeat: `<id ids="" count="" current_index=""
	//       vellum:role="Repeat"><item id="" index="" jr:template="">...
	//       </item></id>`
	// The query_bound shape mirrors Vellum's model-iteration emission. The four
	// attribute slots on the outer `<id>` are load-bearing:
	//   - `ids` and `count` are seeded by setvalue at xforms-ready (or jr-insert
	//     when nested) from the configured ids_query.
	//   - `current_index` counts the wrapper's own item children. JavaRosa
	//     updates it as items materialize, and the
	//     per-iteration `@index` setvalue reads it at jr-insert time. Without
	//     this slot the model-iteration pattern collapses (every iteration reads
	//     position 0).
	//   - `vellum:role="Repeat"` is the round-trip metadata Vellum uses to
	//     recognize a model-iteration container on import.
	// Replace the container placeholder after assembling its children.
	if (isQueryBoundRepeat) {
		dataElements[dataSlot] = el(
			field.id,
			{
				ids: "",
				count: "",
				current_index: "",
				"vellum:role": "Repeat",
			},
			[el("item", { id: "", index: "", "jr:template": "" }, childData)],
		);
	} else {
		const containerAttribs: Record<string, string> =
			field.kind === "repeat" ? { "jr:template": "" } : {};
		dataElements[dataSlot] = el(field.id, containerAttribs, childData);
	}

	// Rewrite the leaf bind at its recorded slot. Containers don't carry
	// validation / calculate / required on their own node, so the leaf bind
	// becomes either a relevant-only container bind (when `relevant` is set) or
	// is dropped entirely. Child binds always append at the end (order is
	// irrelevant to JavaRosa).
	if (relevant) {
		const value = expressions.lower(relevant, {
			entity: "field",
			uuid: fieldUuid,
			slot: "relevant",
		});
		binds[bindSlot] = xel(
			"bind",
			{
				xpath: {
					"vellum:nodeset": nodePath.toWire("hashtag"),
					nodeset: nodePath.toWire(),
					relevant: value,
					"vellum:relevant": value,
				},
			},
			context,
		);
	} else {
		// Drop the leaf bind in place. `splice` (not `pop`) so any synthetic
		// bind a descendant appended after this slot is kept.
		binds.splice(bindSlot, 1);
	}
	binds.push(...childBinds);

	// `<label>` is gated on the exact result of localized itext registration.
	// Container kinds (`group`, `repeat`) carry optional label text; a target-only
	// value is enough to register the shared id and must therefore emit the body
	// ref even when the canonical source template is empty. Emitting an
	// unconditional `<label ref="jr:itext('${id}-label')"/>` would dangle
	// against a missing entry (`XFORM_MISSING_ITEXT`), and registering an entry
	// without a ref would orphan it. All languages and media empty → no element,
	// matching CommCare's transparent-container behavior.
	const labelEl = hasLabel
		? xel(
				"label",
				{ xpath: { ref: w.call("jr:itext", [w.str(`${itextKey}-label`)]) } },
				context,
			)
		: undefined;

	if (field.kind === "repeat") {
		bodyElements.push(
			buildRepeatBody(
				field,
				nodePath,
				labelEl,
				childBody,
				insideRepeat,
				setvalues,
				binds,
				dataElements,
				context,
				expressions,
				generatedNodes,
			),
		);
		// Core executes setvalues in document order: establish this row identity
		// before a nested repeat reads it to seed its own query.
		setvalues.push(...childSetvalues);
		return;
	}

	setvalues.push(...childSetvalues);
	// Group body: `<group ref>` wrapping the children. `appearance="field-list"`
	// is a CommCare semantic that drives single-page rendering of the group's
	// children (Vellum's `tests/static/all_question_types.xml` field-list
	// group is the fixture; HQ's `xform.py::_infer_vellum_type` reads the
	// attribute as `FieldList`). A SECTION is ALWAYS a field-list: that is
	// what a section is on the wire, titled or not. A LABELLED group (text OR
	// media) gets it as Nova's default; a transparent (no-label) group drops
	// the attribute — there's no group chrome to anchor a field-list layout
	// against, so leaving it on would assert a layout posture the author
	// didn't ask for. The group gate is the SAME predicate `labelEl` is
	// computed from so a media-only group label still counts as labelled (the
	// body emits `<label>` and the group renders as real chrome, not a
	// transparent wrapper); an untitled section emits the field-list group
	// with no `<label>`, legal on every runtime.
	const groupAttribs: Record<string, string> = {};
	if (field.kind === "section" || hasLabel) {
		groupAttribs.appearance = "field-list";
	}
	const groupChildren: Element[] = labelEl
		? [labelEl, ...childBody]
		: childBody;
	bodyElements.push(
		xel(
			"group",
			{ attributes: groupAttribs, xpath: { ref: nodePath.toWire() } },
			context,
			groupChildren,
		),
	);
}

/**
 * Build the `<group><repeat>...</repeat></group>` body for a repeat container,
 * dispatching the three `repeat_mode` wire shapes. The surrounding `<group>`
 * wrapper + optional label is mode-invariant; the `<repeat>` attributes and any
 * top-level setvalue / bind setup vary:
 *
 *   user_controlled: bare `<repeat nodeset="${nodePath}">` — runtime adds /
 *     removes instances via UI; no jr:count, no setvalues.
 *
 *   count_bound: `<repeat nodeset="${nodePath}" jr:count="..."
 *     jr:noAddRemove="true()">`. Core reads the question directly or a sibling calculated
 *     integer value during entry. Counts grow rows but never delete them.
 *
 *   query_bound: `<repeat nodeset="${nodePath}/item"
 *     jr:count="${nodePath}/@count" jr:noAddRemove="true()">` plus three
 *     top-level `<setvalue>` elements (Vellum's "model iteration" pattern):
 *       1. on xforms-ready, set ${nodePath}/@ids = join(' ', <ids_query>)
 *     A calculate bind derives @count from the snapshotted @ids, including
 *     when an initially excluded repeat becomes relevant.
 *       2. on jr-insert, set ${nodePath}/item/@index = int(@current_index)
 *       3. on jr-insert, set ${nodePath}/item/@id = selected-at(@ids, ../@index)
 *     The data section wraps children in `<item>` (handled by the caller's
 *     data-element rewrite).
 */
function buildRepeatBody(
	field: Field & { kind: "repeat" },
	nodePath: FormPath,
	labelEl: Element | undefined,
	childBody: Element[],
	insideRepeat: boolean,
	setvalues: Element[],
	binds: Element[],
	scopeDataElements: Element[],
	context: WireElementContext,
	expressions: FormExpressionEmission,
	generatedNodes: GeneratedNodePlan,
): Element {
	let repeatNodeset = nodePath.toWire();
	const repeatXPath: NonNullable<WireElementSpec<"repeat">["xpath"]> = {};
	const repeatAttributes: Record<string, string> = {};
	if (field.repeat_mode === "count_bound") {
		const carrier = expressions.counts.forRepeat(field.uuid);
		if (carrier === undefined)
			throw new Error(`Repeat ${field.id} has no count carrier plan.`);
		const countPath = carrier.materialized
			? expressions.projection.path({
					kind: "repeat",
					repeat: field.uuid,
					role: "count-result",
				})
			: carrier.directReference === undefined
				? undefined
				: expressions.projection.path({
						kind: "field",
						uuid: carrier.directReference,
					});
		if (countPath === undefined)
			throw new Error(`Repeat ${field.id} has no projected count path.`);
		if (carrier.materialized) {
			scopeDataElements.push(el(generatedNodes.count(field.uuid), {}));
			binds.push(
				xel(
					"bind",
					{
						attributes: { type: "xsd:int" },
						xpath: {
							nodeset: countPath.toWire(),
							"vellum:nodeset": countPath.toWire("hashtag"),
							calculate: expressions.lower(carrier.expression, {
								entity: "field",
								uuid: field.uuid,
								slot: "repeat_count",
							}),
						},
					},
					context,
				),
			);
		}
		// Both slots name the same node, including query-repeat item segments.
		repeatXPath["jr:count"] = countPath.toWire();
		repeatXPath["vellum:jr__count"] = countPath.toWire("hashtag");
		repeatAttributes["jr:noAddRemove"] = "true()";
	} else if (field.repeat_mode === "query_bound") {
		const itemPath = nodePath.queryBoundIteration();
		const idsAttrPath = nodePath.attr("ids").toWire();
		const countAttrPath = nodePath.attr("count").toWire();
		const currentIndexAttrPath = nodePath.attr("current_index").toWire();
		const itemIndexAttrPath = itemPath.attr("index").toWire();
		const itemIdAttrPath = itemPath.attr("id").toWire();
		repeatNodeset = itemPath.toWire();
		repeatXPath["jr:count"] = countAttrPath;
		repeatAttributes["jr:noAddRemove"] = "true()";
		const idsQuery = field.data_source.ids_query;
		if (idsQuery === undefined)
			throw new Error(`Repeat ${field.id} has no row query.`);
		const idsValue = w.call("join", [
			w.str(" "),
			expressions.lower(idsQuery, {
				entity: "field",
				uuid: field.uuid,
				slot: "ids_query",
			}),
		]);
		// Counts recalculate when a previously irrelevant repeat becomes relevant.
		binds.push(
			xel(
				"bind",
				{
					attributes: { type: "xsd:int" },
					xpath: {
						nodeset: countAttrPath,
						calculate: w.call("count-selected", [
							w.context([w.parent(), w.attr("ids")]),
						]),
					},
				},
				context,
			),
		);
		const indexValue = w.call("int", [currentIndexAttrPath]);
		const idValue = w.call("selected-at", [
			idsAttrPath,
			w.context([w.parent(), w.attr("index")]),
		]);
		// Count only this parent's item rows when nested repeats recalculate.
		binds.push(
			xel(
				"bind",
				{
					xpath: {
						nodeset: currentIndexAttrPath,
						calculate: w.call("count", [
							w.context([w.parent(), w.step("item")]),
						]),
					},
				},
				context,
			),
		);
		// The outer insertion seeds a nested query. Each item then gets its own id.
		const seedEvent = insideRepeat ? "jr-insert" : "xforms-ready";
		setvalues.push(
			xel(
				"setvalue",
				{
					attributes: { event: seedEvent },
					xpath: { ref: idsAttrPath, value: idsValue },
				},
				context,
			),
			xel(
				"setvalue",
				{
					attributes: { event: "jr-insert" },
					xpath: { ref: itemIndexAttrPath, value: indexValue },
				},
				context,
			),
			xel(
				"setvalue",
				{
					attributes: { event: "jr-insert" },
					xpath: { ref: itemIdAttrPath, value: idValue },
				},
				context,
			),
		);
	}
	// The `<repeat>` itself, then the surrounding `<group>` wrapper that holds
	// the optional label + the repeat. Children sit directly inside the
	// `<repeat>`. Attribute insertion order is `nodeset` first, then the
	// mode-specific attributes — matching the prior emitter's byte order. The
	// wrapper carries no `ref`, as HQ's form builder writes it
	// (`mugs/types/group.js`, `writeControlRefAttr: null`); Core collapses it
	// into the repeat either way.
	const repeatEl = xel(
		"repeat",
		{
			attributes: repeatAttributes,
			xpath: { nodeset: repeatNodeset, ...repeatXPath },
		},
		context,
		childBody,
	);
	const groupChildren: Element[] = labelEl ? [labelEl, repeatEl] : [repeatEl];
	return el("group", {}, groupChildren);
}

/**
 * XForm `<bind>` `type` attribute per domain `FieldKind`.
 *
 * This value is load-bearing for how an uploaded app reads back in
 * CommCare HQ: HQ infers each question's editor type from the
 * `(control-tag, bind-type, media-type, appearance)` tuple
 * (`commcare-hq/corehq/apps/app_manager/xform.py::_infer_vellum_type`
 * against the `VELLUM_TYPES` table). So the bind type is not just
 * "how the runtime parses the value" — it decides whether HQ shows a
 * GPS-capture widget or a plain text box. A geopoint emitted with the
 * wrong type uploads as a Text question.
 *
 * Most kinds carry an `xsd:*` type, but three groups carry the bare
 * ODK type HQ's table keys on — these are NOT XSD types
 * (`commcare-hq/corehq/apps/app_manager/xform_builder.py::ODK_TYPES`
 * lists them outside `XSD_TYPES`):
 *   - `geopoint` → `geopoint` (HQ `Geopoint`: `input` + `geopoint`).
 *   - `barcode`  → `barcode`  (HQ `Barcode`:  `input` + `barcode`).
 *   - the capture kinds (`image`/`audio`/`video`/`signature`/`file`) →
 *     `binary`, which is what HQ's `<upload>` types
 *     (`Image`/`Audio`/`Video`/`Document`) key on; an `xsd:string`
 *     upload matches no row and HQ fails to classify it.
 *
 * Decide the bind type here, independently of
 * `fieldRegistry[kind].dataType` — a separate descriptor serving a
 * different purpose. Their values coincide for most kinds but not all
 * (e.g. `barcode`'s registry dataType is `xsd:string` while its bind
 * type is `barcode`), so don't derive one from the other.
 *
 * Structural kinds (`group`, `repeat`, `label`) get no `type` — HQ
 * treats them as grouping nodes. Selects rely on their `<select1>` /
 * `<select>` tag for classification, so their `xsd:string` type is
 * inert (HQ's table has no typed select row to mis-match against).
 *
 * Declaring this as a `Record<FieldKind, ...>` keyed off the domain
 * tuple makes TypeScript a gate on adding a new kind: a missing entry
 * here fails `tsc`, so the compile pipeline cannot silently emit an
 * XForm without a decided bind type for a new kind.
 */
const BIND_TYPE_BY_KIND: Record<FieldKind, string | null> = {
	text: "xsd:string",
	int: "xsd:int",
	decimal: "xsd:double",
	date: "xsd:date",
	time: "xsd:time",
	datetime: "xsd:dateTime",
	geopoint: "geopoint",
	barcode: "barcode",
	image: "binary",
	audio: "binary",
	video: "binary",
	file: "binary",
	signature: "binary",
	hidden: "xsd:string",
	secret: "xsd:string",
	single_select: "xsd:string",
	multi_select: "xsd:string",
	label: null,
	group: null,
	repeat: null,
	section: null,
};

function getBindType(kind: FieldKind): string | null {
	return BIND_TYPE_BY_KIND[kind];
}
