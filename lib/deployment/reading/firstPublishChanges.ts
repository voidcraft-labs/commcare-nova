/**
 * The first-publish register: the closed list of what Nova's first publish
 * over an app it brought in from CommCare HQ may change there, and the
 * predicate that says, of one reading under one declaration choice, which
 * entries apply.
 *
 * Nova writes every form and every setting in its own spelling. Spelling is
 * free and behavior is not, so each entry says whether a worker meets the
 * change (`touchesWorkers`), the JSON Pointers under which CommCare HQ's
 * stored app may differ because of it (`paths`), and where on one reading the
 * change stands (`at`: the places `firstPublishPlaces.ts` names, which the
 * proof lane holds each difference to). The ids, their sentences and the
 * stored list's shape are client-safe data in `lib/publish`; this module
 * holds what reads a reading.
 *
 * Pure: it reads only its arguments, so a read and the create that follows
 * it give one list for one choice.
 */

import { moduleExpressionContexts } from "@/lib/commcare/expressionContext";
import type { HqAppSource } from "@/lib/commcare/hq/appSource";
import { unreadableMediaIdentity } from "@/lib/commcare/hq/mediaMap";
import { projectCaseListForHq } from "@/lib/commcare/hqJson/caseList";
import { pythonStrip } from "@/lib/commcare/localeFile";
import {
	identityLookupWireNaming,
	lookupWireNaming,
} from "@/lib/commcare/lookup/naming";
import { readsTrimmedSibling } from "@/lib/commcare/placement";
import { renamedField } from "@/lib/commcare/reader/caseList/columns";
import { generatedKeyOwner } from "@/lib/commcare/reader/generatedTranslationKeys";
import { readerLookupNamingDefinitions } from "@/lib/commcare/reader/projectionInputs";
import type {
	MediaRecipients,
	ReaderLookupCatalog,
	ReadFacts,
	ReadFormFacts,
	ReadGeneratedNode,
} from "@/lib/commcare/reader/types";
import {
	buildRuntimeCsqlPromptValidations,
	composeXPathQueryEmission,
} from "@/lib/commcare/suite/case-search/xpathQuery";
import {
	type ColumnFieldWordRow,
	targetWireIdentity,
} from "@/lib/commcare/wireIdentity";
import type { AttachmentUrlTarget } from "@/lib/commcare/xform/captureUrlNode";
import { collectFieldLocations } from "@/lib/commcare/xform/caseOps";
import {
	type GeneratedNodePurpose,
	generatedNodePaths,
} from "@/lib/commcare/xform/generatedNodes";
import {
	type BlueprintDoc,
	type Column,
	declaresWebApps,
	type Uuid,
} from "@/lib/domain";
import { isCaseScalarTextProperty } from "@/lib/domain/caseScalarTextGuard";
import { formCaseWriteViews } from "@/lib/domain/caseWriteViews";
import { datetimeSplitFieldUuid } from "@/lib/domain/datetimeSplitIdentity";
import { effectiveCaseTypes } from "@/lib/domain/effectiveCaseTypes";
import { formLinkEntries, operationCaseType } from "@/lib/domain/forms";
import { projectedModulePreorder } from "@/lib/domain/moduleHierarchy";
import { effectiveCaseSearchConfig } from "@/lib/domain/modules";
import type { Platform } from "@/lib/domain/platforms";
import { NO_ENTRIES, ownRecordValue } from "@/lib/domain/records";
import {
	ANSWERED_FIRST_PUBLISH_CHANGES,
	CURRENT_FIRST_PUBLISH_CHANGE_IDS,
	type CurrentFirstPublishChangeId,
	FIRST_PUBLISH_CHANGE_IDS,
	FIRST_PUBLISH_PLATFORM,
	FIRST_PUBLISH_TOUCHES_WORKERS,
	type FirstPublishChangeId,
	type FirstPublishView,
} from "@/lib/publish/firstPublishChangeIds";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import type { AdoptedMediaFile, MediaPathAssignment } from "../adoption";
import { readingMediaPaths } from "./adoptionBoundary";
import {
	FIRST_PUBLISH_PLACE_KINDS,
	type FirstPublishPlaceKind,
	type FormPosition,
	type FormPositions,
	firstPublishPlaceKind,
	formPositionsOf,
	type MediaReferenceAt,
	mapPath,
	nodePlace,
	partPlace,
	placeOf,
	placeOfStoredPointer,
	placeSteps,
	placesOfMediaReference,
	placesOfSlot,
	sortedPlaces,
} from "./firstPublishPlaces";
import type { HqMediaClaim } from "./projectData/media";
import {
	ownerGivenToWorker,
	reverseHopOwnerChanges,
} from "./projectData/ownerRules";

// ── The generated difference ────────────────────────────────────────────

/** Nodes Nova's emission holds that the source did not, and the reverse. */
export interface GeneratedDifference {
	readonly added: readonly ReadGeneratedNode[];
	readonly dropped: readonly ReadGeneratedNode[];
	readonly renamed: readonly {
		readonly from: ReadGeneratedNode;
		readonly to: ReadGeneratedNode;
	}[];
}

/**
 * What each purpose of a generated node is to the register: the entry that
 * declares a node of it that the first publish adds, or `identity` where no
 * entry declares it. A guard refuses a submission, so one added or dropped
 * is acceptance's case-block difference, never a line a person is asked to
 * accept. Every other node is a Hidden Value nobody answers, a new column of
 * CommCare HQ's form export (`hidden-values-added`), and three of them also
 * change what a worker meets.
 */
export const GENERATED_NODE_CHANGE: Readonly<
	Record<GeneratedNodePurpose, FirstPublishChangeId | "identity">
> = {
	"constraint-count": "validation-counts-moved",
	"constraint-message": "validation-messages-composed",
	url: "hidden-values-added",
	datetime: "hidden-values-added",
	trimmed: "case-names-checked",
	count: "hidden-values-added",
	"query-ids": "hidden-values-added",
	"query-count": "hidden-values-added",
	"query-position": "hidden-values-added",
	"query-id": "hidden-values-added",
	"query-index": "hidden-values-added",
	"keyed-count": "hidden-values-added",
	keyed: "hidden-values-added",
	condition: "hidden-values-added",
	guard: "identity",
	owner: "hidden-values-added",
	instant: "hidden-values-added",
};

function codeUnitOrder(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * `before`: what a source held. `after`: what Nova writes for a document. One
 * list per form, at the same position in both. Within a form the nodes are
 * matched on `(purpose, owner)`; within one such pair each side is taken in
 * code-unit order of `name` and paired in that order (a question can own
 * several counts lifted from one validation): a pair whose names differ is
 * `renamed`, a node of `after` left over is `added`, a node of `before` left
 * over is `dropped`. A node whose purpose `GENERATED_NODE_CHANGE` maps to
 * `identity` is left out of both lists.
 */
export function generatedDifference(
	before: readonly (readonly ReadGeneratedNode[])[],
	after: readonly (readonly ReadGeneratedNode[])[],
): GeneratedDifference {
	const added: ReadGeneratedNode[] = [];
	const dropped: ReadGeneratedNode[] = [];
	const renamed: { from: ReadGeneratedNode; to: ReadGeneratedNode }[] = [];
	const forms = Math.max(before.length, after.length);
	for (let index = 0; index < forms; index++) {
		const groups = new Map<
			string,
			{ before: ReadGeneratedNode[]; after: ReadGeneratedNode[] }
		>();
		const group = (node: ReadGeneratedNode) => {
			const key = `${node.purpose}\u0000${node.owner}`;
			let found = groups.get(key);
			if (found === undefined) {
				found = { before: [], after: [] };
				groups.set(key, found);
			}
			return found;
		};
		for (const node of before[index] ?? [])
			if (GENERATED_NODE_CHANGE[node.purpose] !== "identity")
				group(node).before.push(node);
		for (const node of after[index] ?? [])
			if (GENERATED_NODE_CHANGE[node.purpose] !== "identity")
				group(node).after.push(node);
		for (const pair of groups.values()) {
			const was = [...pair.before].sort((a, b) =>
				codeUnitOrder(a.name, b.name),
			);
			const is = [...pair.after].sort((a, b) => codeUnitOrder(a.name, b.name));
			const paired = Math.min(was.length, is.length);
			for (let at = 0; at < paired; at++) {
				const from = was[at] as ReadGeneratedNode;
				const to = is[at] as ReadGeneratedNode;
				if (from.name !== to.name) renamed.push({ from, to });
			}
			added.push(...is.slice(paired));
			dropped.push(...was.slice(paired));
		}
	}
	return { added, dropped, renamed };
}

/**
 * What Nova writes for `doc`, as the reader would list it: one list per entry
 * of `forms`, which the caller gives in the order of `ReadFacts.forms`, each
 * form found by its `xmlns` through `draft.identities.forms`. Each node is
 * placed by `generatedNodePaths` under `attachmentTarget`, the target the
 * reading's emission is written with (a link's node is written only where a
 * target is known), and keyed as the reader keys it: a question's node by
 * the owner question's data path, an operation's node by the data path of the
 * scope it stands in, a `#`, and the operation's id.
 */
export function emittedGeneratedNodes(
	doc: BlueprintDoc,
	forms: readonly { readonly uuid: Uuid }[],
	attachmentTarget: AttachmentUrlTarget | null,
): readonly (readonly ReadGeneratedNode[])[] {
	return forms.map(({ uuid }) => {
		const locations = collectFieldLocations(doc, uuid);
		const operations = new Map(
			(doc.forms[uuid]?.caseOperations ?? []).map((operation) => [
				operation.uuid,
				operation.id,
			]),
		);
		const nodes: ReadGeneratedNode[] = [];
		for (const [path, node] of generatedNodePaths(
			doc,
			uuid,
			attachmentTarget,
		)) {
			const operationId = operations.get(node.owner);
			let owner: string;
			if (operationId !== undefined) {
				const scope = path.slice(0, path.lastIndexOf("/"));
				owner = `${scope}#${operationId}`;
			} else {
				const location = locations.get(node.owner);
				if (location === undefined)
					throw new Error(
						`Nova placed a ${node.purpose} node of form ${uuid} for ${node.owner}, which is neither a question nor a case change of that form. Every generated node belongs to one of the two.`,
					);
				owner = location.path.toXPath();
			}
			nodes.push({ purpose: node.purpose, owner, path, name: node.name });
		}
		return nodes;
	});
}

// ── The register ────────────────────────────────────────────────────────

export interface FirstPublishFacts {
	readonly source: HqAppSource;
	readonly lookup: ReaderLookupCatalog;
	readonly columnFieldWords: readonly ColumnFieldWordRow[];
	/** The document under the declaration choice being judged. */
	readonly doc: BlueprintDoc;
	readonly facts: ReadFacts;
	/** The reading's folded nodes against what Nova writes for `doc`. */
	readonly generated: GeneratedDifference;
	/** `generated` form by form, in the order of `facts.forms`, each with the form's position in
	 *  `source` (null where `source` holds no form of its `xmlns`). */
	readonly generatedByForm: readonly {
		readonly position: FormPosition | null;
		readonly form: ReadFormFacts;
		readonly difference: GeneratedDifference;
	}[];
	/** Each form's position in `source`. */
	readonly positions: FormPositions;
	/** The position of each form of `doc` the reading holds, by its UUID. */
	readonly formPositions: ReadonlyMap<Uuid, FormPosition>;
	/** `assignMediaPaths` over the held files, keyed by content. */
	readonly media: MediaPathAssignment;
	/** Media references that point at no file and are left out, by what a worker met before. */
	readonly mediaClaims: readonly HqMediaClaim[];
	readonly choice: {
		readonly runsOnlyOn: Platform | null;
		readonly split: boolean;
	};
	/**
	 * The reading's own document under the choice, where the person's answers
	 * to the review made `doc` of it (`withAnsweredChanges`); absent where
	 * `doc` is the reading's own. Only an entry a reading never gives alone
	 * reads it.
	 */
	readonly read?: BlueprintDoc;
}

export interface FirstPublishChange {
	/** Whether a worker meets the change. A `proof3` row of the lane stands only under such an entry. */
	readonly touchesWorkers: boolean;
	/**
	 * `declaration`: the predicate reads `choice.runsOnlyOn`, which a person can
	 * change in the builder afterwards, so the id is worked out again from what
	 * a list stores: a Web Apps line from the stored Web App setting, and an id
	 * a worker meets on one platform alone from its `recorded` part, which the list
	 * stores wherever the reading gives it. `reading`: every other entry. Its
	 * id is stored at the birth.
	 */
	readonly scope: "reading" | "declaration";
	applies(facts: FirstPublishFacts): boolean;
	/**
	 * For a `declaration` entry a worker meets on one platform alone
	 * (`FIRST_PUBLISH_PLATFORM`): whether the reading gives it, under any
	 * declaration. It applies where that holds and the app runs on the named platform.
	 */
	readonly recorded?: (facts: ReadFacts) => boolean;
	/**
	 * JSON Pointers over CommCare HQ's stored app, `*` for a position or an
	 * app's own key, under which the stored source may differ because of this
	 * entry. A pointer covers everything under it.
	 */
	readonly paths: readonly string[];
	/** Where the change stands on a reading it applies on. */
	readonly at: FirstPublishChangeAt;
}

/**
 * Where a change stands: `places` gives, of a reading the entry applies on,
 * every place the change makes a difference at, each of one of `kinds`
 * (`firstPublishPlaces.ts`); or the change stands everywhere, `appWide` saying
 * why, and keeps what no other change's place holds. One entry alone may be
 * app-wide (`firstPublishRegisterRefusals`).
 */
export type FirstPublishChangeAt =
	| {
			readonly kinds: readonly Exclude<FirstPublishPlaceKind, "app-wide">[];
			places(facts: FirstPublishFacts): Iterable<string>;
	  }
	| { readonly appWide: string };

/** The pointers a media reference lives under in CommCare HQ's stored app. */
export const MEDIA_REFERENCE_PATHS: readonly string[] = [
	"/_attachments/*",
	"/modules/*/media_image/*",
	"/modules/*/media_audio/*",
	"/modules/*/case_list/media_image/*",
	"/modules/*/case_list/media_audio/*",
	"/modules/*/case_list_form/media_image/*",
	"/modules/*/case_list_form/media_audio/*",
	"/modules/*/forms/*/media_image/*",
	"/modules/*/forms/*/media_audio/*",
	"/modules/*/case_details/*/columns/*/enum/*/value/*",
	"/modules/*/case_details/short/lookup_image",
	"/logo_refs/*",
];

/** The pointers an expression rewrite may change. */
const EXPRESSION_PATHS: readonly string[] = [
	"/_attachments/*",
	"/modules/*/module_filter",
	"/modules/*/forms/*/form_filter",
	"/modules/*/forms/*/form_links/*",
	"/modules/*/case_details/*",
	"/modules/*/search_config/*",
];

/** The pointers of a menu's, form's, case list item's or Register button's media map. */
const NAV_MEDIA_PATHS: readonly string[] = [
	"/modules/*",
	"/modules/*/forms/*",
	"/modules/*/case_list",
	"/modules/*/case_list_form",
].flatMap((at) => [
	`${at}/media_image`,
	`${at}/media_audio`,
	`${at}/use_default_image_for_all`,
	`${at}/use_default_audio_for_all`,
]);

/** The search config's keys HQ reads only where they hold text, or only beside a named
 *  registry, which a reading drops where they hold neither (`search/settings.ts`). */
const SEARCH_KEYS_READ_ONLY_WITH_TEXT: readonly string[] = [
	"search_button_display_condition",
	"blacklisted_owner_ids_expression",
	"data_registry",
	"custom_related_case_property",
	"instance_name",
	"data_registry_workflow",
	"additional_registry_cases",
	"additional_case_types",
];

/** The keys of a case list column HQ's Case List page saves on every column and HQ's
 *  build reads on none Nova writes (`details/bootstrap5/column.js::serialize`;
 *  `graph_configuration` HQ reads on a `graph` column alone), which Nova writes as the
 *  page saves them (`lib/commcare/hqShells.ts::detailColumn`). */
const DETAIL_COLUMN_PAGE_KEYS: readonly string[] = [
	"calc_xpath",
	"hasNodeset",
	"hasAutocomplete",
	"isTab",
	"nodeset",
	"relevant",
	"graph_configuration",
];

/**
 * The parts of a form's source `forms-and-settings-rewritten` holds: each a
 * part class of the lane's stored-app comparison
 * (`proof/checks/xform_parts.py`) that Nova's builder writes again on every
 * first publish of a form (`xform/builder.ts::buildXFormSource`), where no
 * reader reads the two spellings apart. The lane's copy of the register holds
 * exactly these rows (`proof/ci/__tests__/firstPublishChanges.test.ts`), so a
 * change of any other part of a form reaches the change whose place it is, or
 * the registers.
 */
export const RESPELLED_FORM_PARTS = [
	// `xform/dataRootAttributes.ts::xformDataRootRuntimeAttributes` writes `1`;
	// HQ's build writes the form's own version over it
	// (`models/forms.py::FormBase.add_stuff_to_xform`, `xform.py::XForm.set_version`).
	"/_attachments/*/data/@version",
	// The head holds none of the form builder's hashtag maps (`buildXFormSource`);
	// Core reads neither (`XFormParser.parseElement`).
	"/_attachments/*/:head/vellum:hashtags",
	"/_attachments/*/:head/vellum:hashtagTransforms",
	// The form declares the instances its printed expressions read, under the
	// ids Nova names them by (`xpath/wire/instances.ts::InstanceSink`,
	// `lookupInstance`); HQ's build declares any a form reads and lacks
	// (`xform.py::XForm.add_missing_instances`). An expression that reads an
	// instance is compared through the source its form declares, so a
	// declaration that moves what an expression reads shows at the expression.
	"/_attachments/*/:instance/*",
	// A translation for each of the app's languages alone (`buildXFormSource`);
	// HQ's build leaves out any other (`xform.py::XForm.exclude_languages`).
	"/_attachments/*/:unlisted-translation/*",
	// `xform/bindType.ts::fieldBindType` gives a select and a Hidden Value
	// `xsd:string`; Core reads a bind with no type as it reads that type for
	// both (`XFormParser.applyControlProperties`, `Recalculate.wrapData`,
	// `SetValueAction`). The comparison names only that addition so
	// (`xform_parts.py::_implied_string`): any other bind type a first publish
	// adds, changes or drops stays at `@type`, where no change holds it.
	"/_attachments/*/data/*/:bind/@type/:implied-string",
	// Each expression printed from Nova's typed tree
	// (`xpath/wire/serialize.ts::serializeWire`), where it is the same
	// expression written another way: its quote marks, its grouping, its
	// numbers, the ids of its instances (`proof/checks/xpath_tree.py`). A
	// changed expression is a difference of the slot itself, which only the
	// change whose place stands there holds.
	"/_attachments/*/data/*/:bind/@calculate/:respelled",
	"/_attachments/*/data/*/:bind/@constraint/:respelled",
	// `buildFieldParts` writes a required condition as `required` alone, which
	// is what Core reads (`XFormParser.parseBind` takes no `requiredCondition`).
	"/_attachments/*/data/*/:bind/@requiredCondition",
	// The form builder's copies, which HQ's build strips
	// (`xform.py::XForm.strip_vellum_ns_attributes`): `buildFieldParts` writes
	// `vellum:nodeset` on each question's bind and `serializeWire`'s `vellum`
	// mode a shadow only where an expression reads a question; `buildContainer`
	// writes no bind for a group with no condition; an escaped copy names how
	// often the form builder saved the form (`Vellum/src/util.js::writeHashtags`).
	"/_attachments/*/data/*/:bind/@vellum:nodeset",
	"/_attachments/*/data/*/:bind/@vellum:calculate",
	"/_attachments/*/data/*/:bind/@vellum:relevant",
	"/_attachments/*/data/*/:bind/@vellum:constraint",
	"/_attachments/*/data/*/:bind/@vellum:requiredCondition",
	"/_attachments/*/data/*/:bind/@vellum:required",
	"/_attachments/*/data/*/:bind/@vellum:vellum__*",
	// A default read relative to its question (`buildFieldParts`), printed by
	// `serializeWire`, where it is the same expression.
	"/_attachments/*/data/*/:setvalue/xforms-ready/@value/:respelled",
	// `buildLeafControl` writes a control's `ref` alone, `buildRepeatBody` a
	// repeat's shadows only where its count names a question, and
	// `buildLookupItemset` an itemset's rows printed by `serializeWire`, where
	// they are the same expression.
	"/_attachments/*/data/*/:control/@vellum:ref",
	"/_attachments/*/data/*/:control/@vellum:nodeset",
	"/_attachments/*/data/*/:control/@vellum:jr__count",
	"/_attachments/*/data/*/:control/itemset/@nodeset/:respelled",
	"/_attachments/*/data/*/:control/itemset/@vellum:nodeset",
	// The read of a row an itemset's label names, printed from its lookup read
	// (`buildLookupItemset`), where it is the same expression over the row: Core
	// parses it as one (`XFormParser.parseItemset`'s `labelRef`).
	"/_attachments/*/data/*/:control/itemset/label/@ref/:respelled",
	// A hint writes no markdown form (`buildXFormSource`'s itext); Core reads a
	// hint's text alone (`FormEntryPrompt.getHintText`).
	"/_attachments/*/data/*/:itext/hint/*/markdown",
	// `buildLabelNodes` writes an output's shadow only where it reads a question.
	"/_attachments/*/data/*/:itext/label/*/default/output/*/@vellum:value",
	"/_attachments/*/data/*/:itext/label/*/markdown/output/*/@vellum:value",
] as const;

/** A Search field's keys a reading takes as spelled another way (`search/prompts.ts`). */
const SEARCH_FIELD_RESPELLED_KEYS: readonly string[] = [
	"name",
	"group_key",
	"label",
	"hint",
	"receiver_expression",
	"default_value",
	"required",
	"validations/*/text",
	// The instance HQ's Case List page names an itemset's table by, which the first publish names
	// as the nodeset's (`search/prompts.ts::readPrompt`).
	"itemset/instance_id",
];

const generatedAdds =
	(id: FirstPublishChangeId) =>
	(facts: FirstPublishFacts): boolean =>
		facts.generated.added.some(
			(node) => GENERATED_NODE_CHANGE[node.purpose] === id,
		);

const rewriteReported =
	(id: FirstPublishChangeId) =>
	(facts: FirstPublishFacts): boolean =>
		facts.facts.rewrites.some((rewrite) => rewrite.id === id);

const recordedIn =
	(id: FirstPublishChangeId) =>
	(facts: ReadFacts): boolean =>
		facts.sameStateRewrites.some((record) => record.register === id);

const sameStateRecorded =
	(id: FirstPublishChangeId) =>
	(facts: FirstPublishFacts): boolean =>
		recordedIn(id)(facts.facts);

/**
 * Whether some menu of the source that offers no search stores another
 * `auto_launch` than the shell Nova writes for such a search under the
 * choice being judged: whether the app runs in Web Apps
 * (`lib/commcare/hqShells.ts::caseSearchConfigShell`). A menu offers a search
 * where its search holds a Search field or a default filter
 * (`util.py::module_offers_search`); a stored value that is not `true` is
 * HQ's default, `false` (`models/case_search.py::CaseSearch.auto_launch`).
 */
function inactiveAutoLaunchRespelled(facts: FirstPublishFacts): boolean {
	const modules = facts.source.raw.modules;
	const written = declaresWebApps(facts.doc);
	return (Array.isArray(modules) ? modules : []).some((module) => {
		const config =
			typeof module === "object" && module !== null
				? (module as { search_config?: unknown }).search_config
				: undefined;
		if (typeof config !== "object" || config === null) return false;
		const search = config as {
			readonly properties?: unknown;
			readonly default_properties?: unknown;
			readonly auto_launch?: unknown;
		};
		const holds = (rows: unknown) => Array.isArray(rows) && rows.length > 0;
		if (holds(search.properties) || holds(search.default_properties))
			return false;
		return (search.auto_launch === true) !== written;
	});
}

/**
 * The entry of a change a worker meets on one platform alone
 * (`FIRST_PUBLISH_PLATFORM`) that a reading records under `id`: the
 * reading gives it wherever it records a rewrite under the id, under any
 * declaration (`recorded`), and it applies where it is given and the app runs
 * on the platform that shows it (`firstPublishViewFromStored` uses the same rule).
 */
function platformOnlyRecorded(
	id: CurrentFirstPublishChangeId,
	entry: Pick<FirstPublishChange, "touchesWorkers" | "paths" | "at">,
): FirstPublishChange {
	const recorded = recordedIn(id);
	const platform = FIRST_PUBLISH_PLATFORM.get(id);
	if (!platform) throw new Error(`The change ${id} has no worker platform.`);
	return {
		...entry,
		scope: "declaration",
		applies: (facts) =>
			(facts.choice.runsOnlyOn === null ||
				facts.choice.runsOnlyOn === platform) &&
			recorded(facts.facts),
		recorded,
	};
}

/** The path of each `logo_refs` entry that holds one. */
function logoPaths(source: HqAppSource): Set<string> {
	const paths = new Set<string>();
	for (const entry of Object.values(source.logoRefs))
		if (
			typeof entry === "object" &&
			entry !== null &&
			typeof (entry as { path?: unknown }).path === "string"
		)
			paths.add((entry as { path: string }).path);
	return paths;
}

// ── Where each change stands ────────────────────────────────────────────

/**
 * The data nodes of the generated difference whose purpose `of` takes, each
 * at its form's position: every node added, dropped or renamed (both names),
 * and where `owners`, the question that owns it (an operation's node is
 * owned by no question, `scope#operation`, and names none).
 */
function generatedPlaces(
	facts: FirstPublishFacts,
	of: (purpose: ReadGeneratedNode["purpose"]) => boolean,
	owners: boolean,
): string[] {
	const places: string[] = [];
	for (const { position, difference } of facts.generatedByForm) {
		if (position === null) continue;
		const nodes = [
			...difference.added,
			...difference.dropped,
			...difference.renamed.flatMap((pair) => [pair.from, pair.to]),
		];
		for (const node of nodes) {
			if (!of(node.purpose)) continue;
			places.push(nodePlace(position, node.path));
			if (owners && node.owner.startsWith("/") && !node.owner.includes("#"))
				places.push(nodePlace(position, node.owner));
		}
	}
	return places;
}

/** The forms whose generated difference adds a node `GENERATED_NODE_CHANGE` files under `id`. */
function formsAdding(
	facts: FirstPublishFacts,
	id: FirstPublishChangeId,
): FormPosition[] {
	return facts.generatedByForm.flatMap(({ position, difference }) =>
		position !== null &&
		difference.added.some((node) => GENERATED_NODE_CHANGE[node.purpose] === id)
			? [position]
			: [],
	);
}

/** The places of the stored values the reading records under `register` (`ReadFacts.sameStateRewrites`). */
function recordedPlaces(
	facts: FirstPublishFacts,
	register: FirstPublishChangeId,
): string[] {
	return facts.facts.sameStateRewrites.flatMap((record) => {
		if (record.register !== register) return [];
		const place = placeOfStoredPointer(facts.positions, record.path);
		return place === null ? [] : [place];
	});
}

/** The positions of the forms a record under `register` names, by their attachment or their key. */
function recordedForms(
	facts: FirstPublishFacts,
	register: FirstPublishChangeId,
): FormPosition[] {
	return recordedPlaces(facts, register).flatMap((place) => {
		const steps = place.split("/");
		return steps[1] === "form" && steps[2] !== undefined ? [steps[2]] : [];
	});
}

/** The places of the slots the expression stage held up to the rewrite `id` (`ReadFacts.rewrites`). */
function rewritePlaces(
	facts: FirstPublishFacts,
	id: FirstPublishChangeId,
): string[] {
	return facts.facts.rewrites.flatMap((rewrite) =>
		rewrite.id === id ? placesOfSlot(facts.positions, rewrite) : [],
	);
}

/**
 * Where `search-value-guards` writes its guard as a Search field's check: in
 * each menu whose search the rewrite stands at, each stored field a value
 * CommCare HQ can't search by can come from, at its `validations`. Those are
 * the fields Nova's search attaches a guard to
 * (`suite/case-search/xpathQuery.ts::buildRuntimeCsqlPromptValidations`, over
 * the menu's composed query, as `hqJson/caseList.ts::projectCaseListForHq`
 * reads it), whose test the projection writes alone or joined to the field's
 * own (`searchPrompts.ts::buildValidation`). A field no guard names is no
 * place of the change.
 */
function guardedSearchFieldPlaces(facts: FirstPublishFacts): string[] {
	const menus = new Set<number>();
	for (const rewrite of facts.facts.rewrites) {
		if (rewrite.id !== "search-value-guards" || rewrite.pointer === undefined)
			continue;
		const [root, menu] = placeSteps(rewrite.pointer);
		const m = Number(menu);
		if (root === "modules" && menu !== "" && Number.isInteger(m)) menus.add(m);
	}
	const order = projectedModulePreorder(facts.doc);
	const places: string[] = [];
	for (const m of [...menus].sort((a, b) => a - b)) {
		const uuid = order[m];
		const mod = uuid === undefined ? undefined : facts.doc.modules[uuid];
		const config = mod?.caseListConfig;
		if (
			uuid === undefined ||
			mod === undefined ||
			config === undefined ||
			effectiveCaseSearchConfig(mod) === undefined
		)
			continue;
		// Which field a guard names reads no table's name, so every table is named by its id.
		const naming = identityLookupWireNaming();
		const guarded = buildRuntimeCsqlPromptValidations(
			composeXPathQueryEmission(
				config,
				mod.caseType,
				moduleExpressionContexts(facts.doc, uuid, naming),
				naming,
			),
		);
		asList(
			at(
				at(asList(facts.source.raw.modules)[m], "search_config"),
				"properties",
			),
		).forEach((field, index) => {
			const name = at(field, "name");
			if (typeof name === "string" && guarded.has(name))
				places.push(
					placeOf(
						"menu",
						m,
						"search_config",
						"properties",
						index,
						"validations",
					),
				);
		});
	}
	return places;
}

/** A JSON object's value at `key`, or undefined. */
function at(value: unknown, key: string): unknown {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)[key]
		: undefined;
}

/** The case types the form at `position` writes in `source`: its menu's, and each its stored
 *  actions open or load (`subcases`, `open_cases`, `load_update_cases`). */
function caseTypesOf(
	source: HqAppSource,
	position: FormPosition,
): readonly string[] {
	const [m, f] = position.split(".").map(Number) as [number, number];
	const types = new Set<string>();
	const own = source.modules[m]?.caseType;
	if (typeof own === "string" && own !== "") types.add(own);
	const modules = source.raw.modules;
	const form = Array.isArray(modules)
		? (at(modules[m], "forms") as unknown[] | undefined)?.[f]
		: undefined;
	const actions = at(form, "actions");
	for (const key of ["subcases", "open_cases", "load_update_cases"]) {
		const list = at(actions, key);
		if (!Array.isArray(list)) continue;
		for (const action of list) {
			const type = at(action, "case_type");
			if (typeof type === "string" && type !== "") types.add(type);
		}
	}
	return [...types];
}

/** The text a case block of the form at `position` writes `property` under, `<case>`'s
 *  `create` or `update` child (`caseBlocks.ts`), in any block of the form. */
function blockWritePlace(
	position: FormPosition,
	action: "create" | "update",
	property: string,
): string {
	return `${placeOf("form", position, "xform")}/**${placeOf("case", action, property)}`;
}

/**
 * The places of a case's name and external id as the form at `position`
 * writes them: its stored case actions, each case block's name and external
 * id, and each case type it writes, at those properties as a case holds them
 * (`name` in HQ's case, `case_name` in Core's case database).
 */
function caseNamePlaces(
	facts: FirstPublishFacts,
	position: FormPosition,
): string[] {
	return [
		placeOf("form", position, "actions"),
		blockWritePlace(position, "create", "case_name"),
		blockWritePlace(position, "update", "case_name"),
		blockWritePlace(position, "update", "external_id"),
		...caseTypesOf(facts.source, position).flatMap((type) => [
			placeOf("case", type, "name"),
			placeOf("case", type, "case_name"),
			placeOf("case", type, "external_id"),
		]),
	];
}

/** The form of `doc` at `position`, by its UUID (`FirstPublishFacts.formPositions`). */
function formAt(facts: FirstPublishFacts, position: FormPosition): Uuid | null {
	for (const [uuid, at] of facts.formPositions)
		if (at === position) return uuid;
	return null;
}

/**
 * Where the form at `position` saves a date and time to a case: each case
 * block's row of each property whose effective type is a date and time that
 * one of the form's case changes writes, and that property as the case holds
 * it (`xform/datetimeCaseValue.ts::datetimeCaseValue` writes the value there).
 */
function datetimeWritePlaces(
	facts: FirstPublishFacts,
	position: FormPosition,
): string[] {
	const uuid = formAt(facts, position);
	const form = uuid === null ? undefined : facts.doc.forms[uuid];
	if (uuid === null || form === undefined) return [];
	const types = new Map(
		effectiveCaseTypes(facts.doc).map((type) => [type.name, type.properties]),
	);
	const places: string[] = [];
	for (const operation of form.caseOperations ?? []) {
		const type = operationCaseType(facts.doc, uuid, operation);
		if (type === undefined) continue;
		const properties = types.get(type) ?? [];
		for (const write of operation.writes ?? []) {
			const declared = properties.find((one) => one.name === write.property);
			if (declared?.data_type !== "datetime") continue;
			places.push(
				blockWritePlace(position, "update", write.property),
				placeOf("case", type, write.property),
			);
		}
	}
	return places;
}

/**
 * The places of a form's case setting the first publish writes in Nova's
 * spelling (`case-settings-respelled`): each stored setting the reading
 * records, and what each writes elsewhere: a preload's questions, whose
 * starting value Nova writes in the form; an external id, the case property
 * it writes, the form's update of it, and the same property as each case
 * type indexed to that case reads it (`<relation>/external_id`).
 */
function caseSettingPlaces(facts: FirstPublishFacts): string[] {
	const places: string[] = [];
	for (const record of facts.facts.sameStateRewrites) {
		if (record.register !== "case-settings-respelled") continue;
		const place = placeOfStoredPointer(facts.positions, record.path);
		if (place === null) continue;
		places.push(place);
		const steps = placeSteps(place);
		const position = steps[0] === "form" ? steps[1] : undefined;
		if (position === undefined) continue;
		const last = steps.at(-1);
		if (last === "preload" || steps.includes("case_preload")) {
			for (const question of Object.keys(
				asRecord(storedAt(facts.source.raw, record.path)),
			))
				if (question.startsWith("/"))
					places.push(nodePlace(position, question));
			continue;
		}
		if (last === "external_id") {
			const type =
				facts.source.modules[Number(position.split(".")[0])]?.caseType;
			if (typeof type !== "string" || type === "") continue;
			places.push(
				placeOf("case", type, "external_id"),
				placeOf("form", position, "case_updates", type, "external_id"),
				...childRelations(facts.source, type).map(({ child, identifier }) =>
					placeOf("case", child, identifier, "external_id"),
				),
			);
		}
	}
	return places;
}

/** A JSON object's entries as a record, or none. */
function asRecord(value: unknown): Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: NO_ENTRIES;
}

/** The value of the stored app at `pointer`, or undefined. */
function storedAt(root: unknown, pointer: string): unknown {
	let value = root;
	for (const step of placeSteps(pointer)) {
		if (Array.isArray(value)) value = value[Number(step)];
		else value = ownRecordValue(asRecord(value), step);
		if (value === undefined) return undefined;
	}
	return value;
}

/**
 * Each case type a form of the source indexes to a case of `parent`, by the
 * index's name: a basic menu's child cases (`actions.subcases`, its
 * `reference_id` or HQ's `parent`), and an advanced form's open actions'
 * indices to a load of that type (`open_cases[].case_indices`).
 */
function childRelations(
	source: HqAppSource,
	parent: string,
): readonly { readonly child: string; readonly identifier: string }[] {
	const found: { child: string; identifier: string }[] = [];
	const modules = source.raw.modules;
	(Array.isArray(modules) ? modules : []).forEach((module, m) => {
		const own = source.modules[m]?.caseType;
		const forms = at(module, "forms");
		for (const form of Array.isArray(forms) ? forms : []) {
			const actions = at(form, "actions");
			for (const subcase of asList(at(actions, "subcases"))) {
				const child = at(subcase, "case_type");
				const identifier = at(subcase, "reference_id");
				if (own === parent && typeof child === "string" && child !== "")
					found.push({
						child,
						identifier:
							typeof identifier === "string" && identifier !== ""
								? identifier
								: "parent",
					});
			}
			const loads = new Map<string, unknown>();
			for (const load of asList(at(actions, "load_update_cases")))
				loads.set(String(at(load, "case_tag")), at(load, "case_type"));
			for (const open of asList(at(actions, "open_cases"))) {
				const child = at(open, "case_type");
				for (const index of asList(at(open, "case_indices"))) {
					const identifier = at(index, "reference_id");
					if (
						loads.get(String(at(index, "tag"))) === parent &&
						typeof child === "string" &&
						child !== ""
					)
						found.push({
							child,
							identifier:
								typeof identifier === "string" && identifier !== ""
									? identifier
									: "parent",
						});
				}
			}
		}
	});
	return found;
}

/** A JSON list, or none. */
function asList(value: unknown): readonly unknown[] {
	return Array.isArray(value) ? value : [];
}

/**
 * Where the first publish adds the hidden column each sort rule the reading
 * kept as one lands on (`sort-rule-kept-as-hidden-column`): in each menu a
 * record names, the short detail columns Nova's projection
 * (`hqJson/caseList.ts::projectCaseListForHq`) writes over a property no
 * stored short column of the source shows, by their index in what Nova
 * stores there.
 */
function sortColumnPlaces(facts: FirstPublishFacts): string[] {
	const fieldsByMenu = new Map<number, Set<string>>();
	for (const record of facts.facts.sameStateRewrites) {
		if (record.register !== "sort-rule-kept-as-hidden-column") continue;
		const place = placeOfStoredPointer(facts.positions, record.path);
		if (place === null) continue;
		const [root, menu] = placeSteps(place);
		const field = storedAt(facts.source.raw, record.path);
		if (root !== "menu" || menu === undefined || typeof field !== "string")
			continue;
		const m = Number(menu);
		const fields = fieldsByMenu.get(m) ?? new Set<string>();
		fields.add(renamedField(field));
		fieldsByMenu.set(m, fields);
	}
	if (fieldsByMenu.size === 0) return [];
	const naming = lookupWireNaming(readerLookupNamingDefinitions(facts.lookup));
	const { columnFieldWord } = targetWireIdentity([], facts.columnFieldWords);
	const order = projectedModulePreorder(facts.doc);
	const places: string[] = [];
	for (const [m, fields] of fieldsByMenu) {
		const uuid = order[m];
		const module = uuid === undefined ? undefined : facts.doc.modules[uuid];
		if (module === undefined) continue;
		const stored = new Map<string, number>();
		for (const column of asList(
			at(
				at(at(asList(facts.source.raw.modules)[m], "case_details"), "short"),
				"columns",
			),
		)) {
			const field = at(column, "field");
			if (
				typeof field === "string" &&
				at(column, "useXpathExpression") !== true
			)
				stored.set(field, (stored.get(field) ?? 0) + 1);
		}
		projectCaseListForHq(
			module,
			facts.doc,
			undefined,
			naming,
			undefined,
			undefined,
			columnFieldWord,
		).caseDetails.short.columns.forEach((column, index) => {
			if (column.useXpathExpression) return;
			const left = stored.get(column.field) ?? 0;
			if (left > 0) stored.set(column.field, left - 1);
			else if (
				column.format === "invisible" &&
				fields.has(renamedField(column.field))
			)
				places.push(
					placeOf("menu", m, "case_details", "short", "columns", index),
				);
		});
	}
	return places;
}

/**
 * The places of each media path a first publish moves, from the path CommCare
 * HQ holds (`from`) to the one the file goes out at (`to`): both paths' media
 * map items, and each slot that names `from`, held or handed off, as it names
 * `from` and as it names `to`, so the slot's value and its menu's or form's
 * media listing stand at both.
 */
function movedMediaPlaces(
	facts: FirstPublishFacts,
	moves: Iterable<{ readonly from: string; readonly to: string }>,
): string[] {
	const movedTo = new Map<string, string>();
	const places: string[] = [];
	for (const { from, to } of moves) {
		movedTo.set(mapPath(from), mapPath(to));
		places.push(
			placeOf("app", "multimedia_map", mapPath(from)),
			placeOf("app", "multimedia_map", mapPath(to)),
		);
	}
	for (const reference of [
		...facts.facts.mediaReferences,
		...facts.facts.pendingMedia,
	]) {
		const to = movedTo.get(mapPath(reference.path));
		if (to === undefined) continue;
		places.push(
			...placesOfMediaReference(facts.positions, reference),
			...placesOfMediaReference(facts.positions, { ...reference, path: to }),
		);
	}
	return places;
}

/** Source-only itext is omitted at its own value. A held slot keeps the form listing or app
 * mapping whenever that slot still names the path in that form or elsewhere in the app. */
function unshownMediaPlaces(facts: FirstPublishFacts): string[] {
	const retained = new Set(logoPaths(facts.source));
	const inForm = new Map<string, Set<string>>();
	for (const ref of facts.facts.mediaReferences) {
		retained.add(ref.path);
		const place = ref.place;
		if (place.kind !== "question" && place.kind !== "form") continue;
		const position = `${place.menu}.${place.form}`;
		const paths = inForm.get(position) ?? new Set<string>();
		paths.add(ref.path);
		inForm.set(position, paths);
	}
	return facts.facts.unheldMedia.flatMap((ref) => {
		const place = ref.place;
		if (place.kind !== "question") return [];
		const position = `${place.menu}.${place.form}` as const;
		const places = [
			nodePlace(position, `/data/${place.path}`) +
				placeOf(":itext", ...ref.role, ref.languageCode, ref.form),
		];
		if (!retained.has(ref.path))
			places.push(placeOf("app", "multimedia_map", ref.path));
		if (!inForm.get(position)?.has(ref.path))
			places.push(placeOf("form", position, "media", ref.path));
		return places;
	});
}

/** Each claim carries the exact source slot whose file verdict classified the removal. */
function leftOutMediaPlaces(
	facts: FirstPublishFacts,
	brokenPicture: boolean,
): string[] {
	return facts.mediaClaims
		.filter((claim) => claim.brokenPicture === brokenPicture)
		.flatMap((claim) =>
			placesOfMediaReference(facts.positions, claim.reference),
		);
}

/** A source map entry is in use even when the slot or logo that names it has no available file. */
export function unusedMediaEntries(source: HqAppSource, facts: ReadFacts) {
	// HQ's logo_paths takes the stored value verbatim. ApplicationMediaReference strips surrounding
	// whitespace from other slots, and remove_unused_mappings compares the actual map keys to those paths.
	const named = logoPaths(source);
	for (const reference of [
		...facts.unheldMedia,
		...facts.mediaReferences,
		...facts.pendingMedia,
	])
		if (reference.slot !== "app_logo") named.add(pythonStrip(reference.path));
	return (source.multimediaMap ?? []).filter((item) => !named.has(item.path));
}

/** The menus whose search the shell's `auto_launch` respells (`inactiveAutoLaunchRespelled`). */
function inactiveAutoLaunchMenus(facts: FirstPublishFacts): number[] {
	const modules = facts.source.raw.modules;
	const written = declaresWebApps(facts.doc);
	const menus: number[] = [];
	(Array.isArray(modules) ? modules : []).forEach((module, m) => {
		const search = at(module, "search_config");
		if (typeof search !== "object" || search === null) return;
		const holds = (rows: unknown) => Array.isArray(rows) && rows.length > 0;
		if (
			holds(at(search, "properties")) ||
			holds(at(search, "default_properties"))
		)
			return;
		if ((at(search, "auto_launch") === true) !== written) menus.push(m);
	});
	return menus;
}

/**
 * The places of each date and time question the split holds (`lib/doc/datetimeSplit.ts`):
 * the question, now the Hidden Value joining the two, and the date and the time questions
 * it inserted, whose identities the split derives (`datetimeSplitFieldUuid`), and the form's
 * case writes, which keep reading the question.
 */
function splitPlaces(facts: FirstPublishFacts): string[] {
	const places: string[] = [];
	for (const [formUuid, position] of facts.formPositions) {
		const locations = collectFieldLocations(facts.doc, formUuid);
		for (const [uuid, location] of locations) {
			const date = locations.get(
				datetimeSplitFieldUuid(facts.doc.appId, uuid, "date"),
			);
			const time = locations.get(
				datetimeSplitFieldUuid(facts.doc.appId, uuid, "time"),
			);
			if (date === undefined || time === undefined) continue;
			places.push(
				nodePlace(position, location.path.toXPath()),
				nodePlace(position, date.path.toXPath()),
				nodePlace(position, time.path.toXPath()),
				placeOf("form", position, "actions"),
			);
		}
	}
	return places;
}

/** The `nova_datetime_` nodes the reading folded in the form at `position`, with their questions. */
function datetimeNodePlaces(
	facts: FirstPublishFacts,
	position: FormPosition,
): string[] {
	return facts.generatedByForm.flatMap((one) =>
		one.position !== position
			? []
			: one.form.generated
					.filter((node) => node.purpose === "datetime")
					.flatMap((node) => [
						nodePlace(position, node.path),
						...(node.owner.startsWith("/") && !node.owner.includes("#")
							? [nodePlace(position, node.owner)]
							: []),
					]),
	);
}

/**
 * The register, in the order of `CURRENT_FIRST_PUBLISH_CHANGE_IDS`. Each entry's doc
 * comment names where the change comes from.
 */
export const FIRST_PUBLISH_CHANGES: Readonly<
	Record<
		Exclude<FirstPublishChangeId, "hidden-value-defaults-dropped">,
		FirstPublishChange
	>
> = {
	/**
	 * Nova writes every form and setting again in its own spelling
	 * (`lib/commcare/expander.ts::expandDoc`), and CommCare HQ's import marks
	 * every app it updates (`views/app_import_api.py::import_app_api` sets
	 * `created_from_template`, which no page and no runtime reads), and its
	 * media upload, saving the files Nova sends into the app's map, stores the
	 * `media_form_errors` its own media listing sets on the app it saves
	 * (`hqmedia/tasks.py::process_bulk_upload_zip` asks
	 * `get_all_paths_of_type`, whose `all_media` sets it, then `app.save()`),
	 * which only HQ's media page reads. Every case
	 * list column is written as HQ's Case List page saves one
	 * (`lib/commcare/hqShells.ts::detailColumn`,
	 * `details/bootstrap5/column.js::serialize`): the page's own keys
	 * (`calc_xpath`, `hasNodeset`, `hasAutocomplete`, `isTab`, `nodeset`,
	 * `relevant`), which `models/case_list.py::DetailColumn` does not declare
	 * and nothing HQ builds reads, and `graph_configuration` null, which HQ
	 * reads only on a `graph` column (`app_strings.py`,
	 * `detail_screen.py::Graph`), a format Nova never writes; a column of an
	 * app made in HQ's models holds neither the keys nor null. A list's filter
	 * and a calculated column's expression (a column's `field` where its
	 * `useXpathExpression` is true) are written in Nova's spelling of the
	 * expression the reading holds: its whitespace, its quote marks, and a
	 * three-argument `cond` as the `if` it equals
	 * (`reader/syntaxCompare.ts`). The app's two settings Nova owns are written
	 * on every publish (`targetOverlay.ts::projectApplicationForTarget`), so a
	 * stored profile that holds no properties, which an app HQ's pages made and
	 * no settings page saved holds, gains `cc-show-saved` and
	 * `cc-show-incomplete` at the value the reading read its absence as, which
	 * HQ's build writes for an absent key too
	 * (`models/applications.py::Application.create_profile`, both `no`).
	 * Applies on every reading.
	 */
	"forms-and-settings-rewritten": {
		touchesWorkers: false,
		scope: "reading",
		applies: () => true,
		at: {
			appWide:
				"Nova writes every form and every setting again in its own spelling, so the change stands wherever a first publish writes anything; it keeps each difference no other change's place holds.",
		},
		paths: [
			"/_attachments/*",
			"/modules/*/forms/*/case_references_data/load",
			"/modules/*/case_details/short/filter",
			"/modules/*/case_details/*/columns/*/field",
			"/created_from_template",
			"/media_form_errors",
			"/profile/properties/cc-show-incomplete",
			"/profile/properties/cc-show-saved",
			...DETAIL_COLUMN_PAGE_KEYS.map(
				(key) => `/modules/*/case_details/*/columns/*/${key}`,
			),
		],
	},
	/**
	 * A generated node Nova's emission holds that the source did not, or the
	 * reverse, or one under another name (`xform/generatedNodes.ts::planGeneratedNodes`):
	 * each a column of CommCare HQ's form export.
	 */
	"hidden-values-added": {
		touchesWorkers: false,
		scope: "reading",
		applies: (facts) =>
			facts.generated.added.length > 0 ||
			facts.generated.renamed.length > 0 ||
			facts.generated.dropped.length > 0,
		at: {
			kinds: ["form-node"],
			places: (facts) => generatedPlaces(facts, () => true, false),
		},
		paths: ["/_attachments/*"],
	},
	/**
	 * A `nova_trimmed_` sibling the source lacks
	 * (`xform/builder.ts::buildFieldParts`, over
	 * `lib/domain/caseScalarTextGuard.ts::caseScalarTextGuards`): the case name
	 * is required, capped and trimmed on the question a worker answers.
	 */
	"case-names-checked": {
		touchesWorkers: true,
		scope: "reading",
		applies: generatedAdds("case-names-checked"),
		at: {
			kinds: ["form-node", "form-part", "form", "case"],
			places: (facts) => [
				...generatedPlaces(
					facts,
					(purpose) => GENERATED_NODE_CHANGE[purpose] === "case-names-checked",
					true,
				),
				...formsAdding(facts, "case-names-checked").flatMap((position) =>
					caseNamePlaces(facts, position),
				),
			],
		},
		paths: ["/_attachments/*", "/modules/*/forms/*/actions"],
	},
	/** A count lifted out of a validation (`xform/constraintCollections.ts::planConstraintCollections`). */
	"validation-counts-moved": {
		touchesWorkers: true,
		scope: "reading",
		applies: generatedAdds("validation-counts-moved"),
		at: {
			kinds: ["form-node"],
			places: (facts) =>
				generatedPlaces(
					facts,
					(purpose) =>
						GENERATED_NODE_CHANGE[purpose] === "validation-counts-moved",
					true,
				),
		},
		paths: ["/_attachments/*"],
	},
	/** A validation message composed over its answer (`xform/constraintMessage.ts::protectConstraintMessage`). */
	"validation-messages-composed": {
		touchesWorkers: true,
		scope: "reading",
		applies: generatedAdds("validation-messages-composed"),
		at: {
			kinds: ["form-node"],
			places: (facts) =>
				generatedPlaces(
					facts,
					(purpose) =>
						GENERATED_NODE_CHANGE[purpose] === "validation-messages-composed",
					true,
				),
		},
		paths: ["/_attachments/*"],
	},
	/** The rewrite `instant-comparison` (`xpath/wire/fromExpression.ts::compareSides`). */
	"instant-comparison": {
		touchesWorkers: true,
		scope: "reading",
		applies: rewriteReported("instant-comparison"),
		at: {
			kinds: ["form-node", "form", "form-part", "menu", "app"],
			places: (facts) => rewritePlaces(facts, "instant-comparison"),
		},
		paths: EXPRESSION_PATHS,
	},
	/** The rewrite `empty-rows-guard` (`xpath/wire/emptyRows.ts`). */
	"empty-rows-guard": {
		touchesWorkers: true,
		scope: "reading",
		applies: rewriteReported("empty-rows-guard"),
		at: {
			kinds: ["form-node", "form", "form-part", "menu", "app"],
			places: (facts) => rewritePlaces(facts, "empty-rows-guard"),
		},
		paths: EXPRESSION_PATHS,
	},
	/** The rewrite `absent-session-value-guard` (`xpath/wire/fromExpression.ts::term`). */
	"absent-session-value-guard": {
		touchesWorkers: true,
		scope: "reading",
		applies: rewriteReported("absent-session-value-guard"),
		at: {
			kinds: ["form-node", "form", "form-part", "menu", "app"],
			places: (facts) => rewritePlaces(facts, "absent-session-value-guard"),
		},
		paths: EXPRESSION_PATHS,
	},
	/** The rewrite `row-predicate-current` (`xpath/wire/formReads.ts::formReadToWire`). */
	"row-predicate-current": {
		touchesWorkers: true,
		scope: "reading",
		applies: rewriteReported("row-predicate-current"),
		at: {
			kinds: ["form-node", "form", "form-part", "menu", "app"],
			places: (facts) => rewritePlaces(facts, "row-predicate-current"),
		},
		paths: ["/_attachments/*"],
	},
	/** The rewrite `search-value-guards` (`csql/print.ts`), and its guard written as the
	 *  check of each Search field a value it guards can come from (`guardedSearchFieldPlaces`). */
	"search-value-guards": {
		touchesWorkers: true,
		scope: "reading",
		applies: rewriteReported("search-value-guards"),
		at: {
			kinds: ["menu"],
			places: (facts) => [
				...rewritePlaces(facts, "search-value-guards"),
				...guardedSearchFieldPlaces(facts),
			],
		},
		paths: ["/modules/*/search_config/*"],
	},
	/** The rewrite `search-today-device-day` (`csql/emitter.ts::runtimeHole`). */
	"search-today-device-day": {
		touchesWorkers: true,
		scope: "reading",
		applies: () => false,
		at: {
			kinds: ["menu"],
			places: () => [],
		},
		paths: ["/modules/*/search_config/*"],
	},
	/**
	 * A form's case settings read as the same state and written in Nova's
	 * spelling: a preload as the question's default, an external id, a basic
	 * child's index name, `update_mode` (`casePlacementPlan.ts::planFormCaseWire`),
	 * recorded by the case management readers.
	 */
	"case-settings-respelled": {
		touchesWorkers: false,
		scope: "reading",
		applies: sameStateRecorded("case-settings-respelled"),
		at: {
			kinds: ["form", "form-node", "case"],
			places: caseSettingPlaces,
		},
		paths: ["/modules/*/forms/*/actions", "/_attachments/*"],
	},
	/**
	 * A question's or group's appearance written in Nova's spelling of the
	 * display settings it read (`xform/appearance.ts::writeFieldAppearance`),
	 * every runtime reading the two alike (`readDisplaySettings.ts::
	 * readFieldAppearance`), or dropped where no runtime reads it on that
	 * control: recorded by `xform/appearances.ts::claimAppearance`
	 * (`ReadFormFacts.respelledAppearances`, `inertAppearances`).
	 */
	"question-display-respelled": {
		touchesWorkers: false,
		scope: "reading",
		applies: (facts) =>
			facts.facts.forms.some(
				(form) =>
					form.respelledAppearances.length > 0 ||
					form.inertAppearances.length > 0,
			),
		at: {
			kinds: ["form-node"],
			places: (facts) =>
				facts.generatedByForm.flatMap(({ position, form }) =>
					position === null
						? []
						: [...form.respelledAppearances, ...form.inertAppearances].map(
								(path) =>
									nodePlace(
										position,
										path.startsWith("/") ? path : `/data/${path}`,
									),
							),
				),
		},
		paths: ["/_attachments/*"],
	},
	/** A search's filter rows cut another way (`hqJson/caseList.ts::projectCaseListForHq`), recorded by `search/rows.ts`. */
	"search-filter-rows-recut": {
		touchesWorkers: false,
		scope: "reading",
		applies: sameStateRecorded("search-filter-rows-recut"),
		at: {
			kinds: ["menu"],
			places: (facts) => recordedPlaces(facts, "search-filter-rows-recut"),
		},
		paths: ["/modules/*/search_config/default_properties"],
	},
	/**
	 * A sort rule over a property the list doesn't show, written as a hidden
	 * column, recorded by `caseList/order.ts` where a sort element names a
	 * property no shown column or link joins. A sort word respelled on a column
	 * the list shows is `list-settings-respelled`'s.
	 */
	"sort-rule-kept-as-hidden-column": {
		touchesWorkers: false,
		scope: "reading",
		applies: sameStateRecorded("sort-rule-kept-as-hidden-column"),
		at: {
			kinds: ["menu"],
			places: (facts) => [
				...recordedPlaces(facts, "sort-rule-kept-as-hidden-column"),
				...sortColumnPlaces(facts),
			],
		},
		paths: [
			"/modules/*/case_details/short/columns",
			"/modules/*/case_details/short/sort_elements/*/field",
			"/modules/*/case_details/short/sort_elements/*/display",
		],
	},
	/** HQ accepts stored legacy related-property text, and its editor keeps
	 * Translatable Text only on calculated columns. The worker's text and
	 * ordering are the same with the calculation's generated keys. */
	"legacy-related-case-text-rekeyed": {
		touchesWorkers: false,
		scope: "reading",
		applies: sameStateRecorded("legacy-related-case-text-rekeyed"),
		at: {
			kinds: ["menu"],
			places: (facts) =>
				recordedPlaces(facts, "legacy-related-case-text-rekeyed"),
		},
		paths: [
			"/modules/*/case_details/short/columns/*",
			"/modules/*/case_details/long/columns/*",
		],
	},
	/**
	 * A case list's, a search's or a menu's stored setting or text map Nova
	 * writes another way with nothing a device shows changed, recorded by the
	 * list, search and menu readers and by `heldText.ts::recordTextRewrite`.
	 * A search a menu does not offer is written as its shell, whose
	 * `auto_launch` is whether the app runs in Web Apps, which no reading
	 * knows, so the entry also applies where such a menu stores another value
	 * than the choice writes (`inactiveAutoLaunchRespelled`). The id has no
	 * sentence of its own (`FIRST_PUBLISH_SAID_BY`), so a list stored under
	 * one choice says what it says under another.
	 */
	"list-settings-respelled": {
		touchesWorkers: false,
		scope: "reading",
		applies: (facts) =>
			sameStateRecorded("list-settings-respelled")(facts) ||
			inactiveAutoLaunchRespelled(facts),
		at: {
			kinds: ["menu"],
			places: (facts) => [
				...recordedPlaces(facts, "list-settings-respelled"),
				...inactiveAutoLaunchMenus(facts).map((m) =>
					placeOf("menu", m, "search_config", "auto_launch"),
				),
			],
		},
		paths: [
			"/modules/*/case_details/short/max_select_value",
			"/modules/*/case_details/short/persist_tile_on_forms",
			"/modules/*/case_details/short/sort_elements",
			"/modules/*/search_config/title_label",
			"/modules/*/search_config/description",
			"/modules/*/search_config/auto_launch",
			...SEARCH_KEYS_READ_ONLY_WITH_TEXT.map(
				(key) => `/modules/*/search_config/${key}`,
			),
			...SEARCH_FIELD_RESPELLED_KEYS.map(
				(key) => `/modules/*/search_config/properties/*/${key}`,
			),
			"/modules/*/case_list/label",
			"/modules/*/case_list_form/label",
			"/modules/*/case_details/*/columns/*/header",
			"/modules/*/case_details/*/columns/*/enum/*/value",
			"/modules/*/case_details/*/no_items_text",
			"/modules/*/case_details/*/select_text",
			"/modules/*/search_config/search_button_label",
			"/modules/*/case_details/*/columns/*/enum/*/alt_text",
		],
	},
	/** A search's filter kept as one with the case list's, recorded by `search/rows.ts`. */
	"search-filter-joined-to-list": {
		touchesWorkers: false,
		scope: "reading",
		applies: () => false,
		at: {
			kinds: ["menu"],
			places: () => [],
		},
		paths: ["/modules/*/case_details/short/filter"],
	},
	/** A case list's filter sent with its search (`hqJson/caseList.ts::projectCaseListForHq`), recorded by `search/rows.ts`. */
	"search-restates-list-filter": {
		touchesWorkers: true,
		scope: "reading",
		applies: () => false,
		at: {
			kinds: ["menu"],
			places: () => [],
		},
		paths: ["/modules/*/search_config/default_properties"],
	},
	/** A held-case guard on a link that carries a case (`formLinkProjection.ts::formLinkCarriedCaseGuards`), recorded by `menus/afterSubmit.ts`. */
	"link-held-case-guards-added": {
		touchesWorkers: true,
		scope: "reading",
		applies: sameStateRecorded("link-held-case-guards-added"),
		at: {
			kinds: ["form"],
			places: (facts) => recordedPlaces(facts, "link-held-case-guards-added"),
		},
		paths: ["/modules/*/forms/*/form_links/*/xpath"],
	},
	/** A Register button's label with no text read as the words HQ's build writes, recorded by `menus/registration.ts::readLabel`. */
	"registration-label-fixed": {
		touchesWorkers: true,
		scope: "reading",
		applies: sameStateRecorded("registration-label-fixed"),
		at: {
			kinds: ["menu"],
			places: (facts) => recordedPlaces(facts, "registration-label-fixed"),
		},
		paths: ["/modules/*/case_list_form/label/*"],
	},
	/**
	 * A date and time a case saves in the spelling Nova wrote before
	 * (`xform/datetimeCaseValue.ts::datetimeCaseValue`), recorded by the form
	 * reader's fold of a `nova_datetime_` sibling and by `caseManagement/saveToCase.ts`.
	 */
	"date-and-time-saved-as-hq-stores-it": {
		touchesWorkers: true,
		scope: "reading",
		applies: sameStateRecorded("date-and-time-saved-as-hq-stores-it"),
		at: {
			kinds: ["form-node", "form-part", "case"],
			places: (facts) =>
				recordedForms(facts, "date-and-time-saved-as-hq-stores-it").flatMap(
					(position) => [
						...datetimeNodePlaces(facts, position),
						...datetimeWritePlaces(facts, position),
					],
				),
		},
		paths: ["/_attachments/*"],
	},
	/**
	 * A CommCare Connect app captures location on every form
	 * (`expander.ts::appLevelValues`, `hqShells.ts::applicationShell`,
	 * `auto_gps_capture`).
	 */
	"connect-app-captures-location": {
		touchesWorkers: true,
		scope: "reading",
		applies: (facts) =>
			facts.doc.connectRoles.length > 0 &&
			facts.source.raw.auto_gps_capture !== true,
		at: {
			kinds: ["app", "form-node"],
			places: (facts) => [
				placeOf("app", "auto_gps_capture"),
				...facts.positions.all.map((position) =>
					nodePlace(position, "/data/meta/location"),
				),
			],
		},
		paths: ["/auto_gps_capture"],
	},
	/**
	 * A generated translation key the reading read as having no effect (blank, naming no string of
	 * the app, or the string HQ's build generates there; `reader/assemble.ts::decideGeneratedKeys`):
	 * Nova words no such key, so it leaves `translations`.
	 */
	"unused-translation-keys-removed": {
		touchesWorkers: false,
		scope: "reading",
		applies: (facts) => facts.facts.unusedTranslationKeys.length > 0,
		at: {
			kinds: ["app", "menu", "form"],
			// The stored key, and the menu, form or app its built string is of, which the string HQ's
			// build no longer writes stands at.
			places: (facts) =>
				facts.facts.unusedTranslationKeys.flatMap((pointer) => {
					const stored = placeOfStoredPointer(facts.positions, pointer);
					const owner = generatedKeyOwner(placeSteps(pointer).at(-1) ?? "");
					return [
						...(stored === null ? [] : [stored]),
						owner.kind === "form"
							? placeOf("form", `${owner.menu}.${owner.form}`)
							: owner.kind === "menu"
								? placeOf("menu", owner.menu)
								: placeOf("app"),
					];
				}),
		},
		paths: ["/translations/*/*"],
	},
	/** Every app writes `location_fixture_restore: project_default` (`hqShells.ts::applicationShell`). */
	"location-list-setting-reset": {
		touchesWorkers: false,
		scope: "reading",
		applies: (facts) =>
			facts.source.raw.location_fixture_restore === "both_fixtures" ||
			facts.source.raw.location_fixture_restore === "only_flat_fixture",
		at: {
			kinds: ["app"],
			places: () => [placeOf("app", "location_fixture_restore")],
		},
		paths: ["/location_fixture_restore"],
	},
	/** `cloudcare_enabled` written from where the app runs (`hqShells.ts::applicationShell`). */
	"web-apps-turned-off": {
		touchesWorkers: true,
		scope: "declaration",
		applies: (facts) =>
			facts.source.cloudcareEnabled && facts.choice.runsOnlyOn === "android",
		at: {
			kinds: ["app"],
			places: () => [placeOf("app", "cloudcare_enabled")],
		},
		paths: ["/cloudcare_enabled"],
	},
	/** `cloudcare_enabled` written from where the app runs (`hqShells.ts::applicationShell`). */
	"web-apps-turned-on": {
		touchesWorkers: true,
		scope: "declaration",
		applies: (facts) =>
			!facts.source.cloudcareEnabled && facts.choice.runsOnlyOn !== "android",
		at: {
			kinds: ["app"],
			places: () => [placeOf("app", "cloudcare_enabled")],
		},
		paths: ["/cloudcare_enabled"],
	},
	/** Web Apps' app list shows Incomplete Forms unless every listed app explicitly stores no
	 * (cloudcare/apps/controller.js). A missing setting and no already agree in HQ's build. */
	"incomplete-forms-tile-hidden": platformOnlyRecorded(
		"incomplete-forms-tile-hidden",
		{
			touchesWorkers: true,
			at: {
				kinds: ["app"],
				places: () => [
					placeOf("app", "profile", "properties", "cc-show-incomplete"),
				],
			},
			paths: ["/profile/properties/cc-show-incomplete"],
		},
	),
	/** The split a person chose at the review (`lib/doc/datetimeSplit.ts`). */
	"date-and-time-questions-split": {
		touchesWorkers: true,
		scope: "reading",
		applies: (facts) => facts.choice.split,
		at: { kinds: ["form-node", "form"], places: splitPlaces },
		paths: ["/_attachments/*", "/modules/*/forms/*/actions"],
	},
	/** A translation left blank, filled from the first language (`lib/domain/translationFill.ts::filledProse`). */
	"blank-translations-filled": {
		touchesWorkers: true,
		scope: "reading",
		applies: (facts) =>
			facts.facts.forms.some((form) => form.blankTranslations > 0),
		at: {
			kinds: ["form-part"],
			places: (facts) =>
				facts.generatedByForm.flatMap(({ position, form }) =>
					position !== null && form.blankTranslations > 0
						? [partPlace(position, ":itext")]
						: [],
				),
		},
		paths: ["/_attachments/*"],
	},
	/** One file HQ holds under several paths, kept at one (`adoption.ts::assignMediaPaths`). */
	"media-paths-joined": {
		touchesWorkers: false,
		scope: "reading",
		applies: (facts) => facts.media.collapsed.length > 0,
		at: {
			kinds: ["app", "menu", "form", "form-node"],
			places: (facts) =>
				movedMediaPlaces(
					facts,
					facts.media.collapsed.flatMap(({ kept, dropped }) =>
						dropped.map((from) => ({ from, to: kept })),
					),
				),
		},
		paths: ["/multimedia_map/*", ...MEDIA_REFERENCE_PATHS],
	},
	/** A path Nova cannot hold, the file going out at the path it keeps, else at its derivation
	 *  (`adoption.ts::assignMediaPaths`). */
	"media-files-renamed": {
		touchesWorkers: true,
		scope: "reading",
		applies: (facts) => facts.media.rederived.length > 0,
		at: {
			kinds: ["app", "menu", "form", "form-node"],
			places: (facts) => movedMediaPlaces(facts, facts.media.rederived),
		},
		paths: ["/multimedia_map/*", ...MEDIA_REFERENCE_PATHS],
	},
	/** A reference to no file that no runtime draws, left out of the document. */
	"media-references-with-no-file-removed": {
		touchesWorkers: false,
		scope: "reading",
		applies: (facts) => facts.mediaClaims.some((claim) => !claim.brokenPicture),
		at: {
			kinds: ["app", "menu", "form", "form-node"],
			places: (facts) => leftOutMediaPlaces(facts, false),
		},
		paths: [...MEDIA_REFERENCE_PATHS, "/multimedia_map/*"],
	},
	/**
	 * A picture whose removal changes what a worker sees on a declared platform
	 * (`projectData/media.ts::noFileOutcome`).
	 */
	"broken-pictures-removed": {
		touchesWorkers: true,
		scope: "reading",
		applies: (facts) => facts.mediaClaims.some((claim) => claim.brokenPicture),
		at: {
			kinds: ["app", "menu", "form", "form-node"],
			places: (facts) => leftOutMediaPlaces(facts, true),
		},
		paths: [...MEDIA_REFERENCE_PATHS, "/multimedia_map/*"],
	},
	"unshown-form-media-removed": {
		touchesWorkers: false,
		scope: "reading",
		applies: (facts) => facts.facts.unheldMedia.length > 0,
		at: { kinds: ["app", "form", "form-node"], places: unshownMediaPlaces },
		paths: ["/_attachments/*", "/multimedia_map/*"],
	},
	/**
	 * HQ's import prunes the media map to what the app names and its logo
	 * entries (`hqmedia/models.py::ApplicationMediaMixin.remove_unused_mappings`, run by
	 * `app_manager/models/applications.py::overwrite_app_from_source` after
	 * Nova's body is merged).
	 */
	"unused-media-entries-removed": {
		touchesWorkers: false,
		scope: "reading",
		applies: (facts) =>
			unusedMediaEntries(facts.source, facts.facts).length > 0,
		at: {
			kinds: ["app"],
			places: (facts) =>
				unusedMediaEntries(facts.source, facts.facts).map(({ path }) =>
					placeOf("app", "multimedia_map", path),
				),
		},
		paths: ["/multimedia_map/*"],
	},
	/**
	 * A menu's, a form's or the app's name map read as the text HQ's build
	 * shows in each language and printed in full, recorded by
	 * `reader/structure.ts::recordNameRewrite` and `appShell.ts::holdAppName`.
	 */
	"names-respelled": {
		touchesWorkers: false,
		scope: "reading",
		applies: sameStateRecorded("names-respelled"),
		at: {
			kinds: ["app", "menu", "form"],
			places: (facts) => recordedPlaces(facts, "names-respelled"),
		},
		paths: [
			"/modules/*/name",
			"/modules/*/forms/*/name",
			"/name",
			"/translations/*/app.display.name",
			"/translations/*/homescreen.title",
		],
	},
	"badge-respelled": {
		touchesWorkers: false,
		scope: "reading",
		applies: sameStateRecorded("badge-respelled"),
		at: {
			kinds: ["menu", "form"],
			places: (facts) => recordedPlaces(facts, "badge-respelled"),
		},
		paths: [
			"/modules/*/custom_icons",
			"/modules/*/custom_icons/0/text",
			"/modules/*/custom_icons/0/xpath",
			"/modules/*/forms/*/custom_icons",
			"/modules/*/forms/*/custom_icons/0/text",
			"/modules/*/forms/*/custom_icons/0/xpath",
		],
	},

	/**
	 * A navigation media map Nova writes with other paths than HQ stores:
	 * one read under a "use for all" switch, written as each language's file
	 * with the switches off (`multimedia/navMenuMedia.ts::buildNavMediaDicts`).
	 * A sparse map, a blank entry and a former language's file are held as
	 * stored, so they predict no change. Recorded by
	 * `menus/navMedia.ts::recordRespelling`.
	 */
	"media-maps-respelled": {
		touchesWorkers: false,
		scope: "reading",
		applies: sameStateRecorded("media-maps-respelled"),
		at: {
			kinds: ["menu", "form"],
			places: (facts) => recordedPlaces(facts, "media-maps-respelled"),
		},
		paths: NAV_MEDIA_PATHS,
	},
	/**
	 * An app string a worker read as blank, or with a space or a line break at
	 * an end, held as `heldText.ts::heldText` holds it and recorded by
	 * `heldText.ts::recordTextRewrite`.
	 */
	"text-spaces-dropped": {
		touchesWorkers: true,
		scope: "reading",
		applies: sameStateRecorded("text-spaces-dropped"),
		at: {
			kinds: ["app", "menu", "form"],
			places: (facts) => recordedPlaces(facts, "text-spaces-dropped"),
		},
		paths: [
			"/modules/*/name",
			"/modules/*/forms/*/name",
			"/name",
			"/translations/*/*",
			"/modules/*/case_list/label",
			"/modules/*/case_list_form/label",
			"/modules/*/case_details/*/columns/*/header",
			"/modules/*/case_details/*/columns/*/enum/*/value",
			"/modules/*/search_config/title_label",
			"/modules/*/search_config/description",
			"/modules/*/search_config/properties/*/label",
			"/modules/*/search_config/properties/*/hint",
			"/modules/*/search_config/properties/*/required/text",
			"/modules/*/search_config/properties/*/validations/*/text",
			"/modules/*/custom_icons/0/text",
			"/modules/*/forms/*/custom_icons/0/text",
		],
	},
	/**
	 * A form's text whose source holds, in a text node, a no-break space or a
	 * bracket CommCare HQ's build would read as `instance(`: Nova writes each
	 * as a literal output (`xform/builder.ts::literalLabelNodes`), which every
	 * runtime shows as the same characters and CommCare HQ's form builder shows
	 * as an output. Recorded by `xform/prose.ts::recordTextOutputs`.
	 */
	"form-text-characters-written-as-outputs": {
		touchesWorkers: false,
		scope: "reading",
		applies: sameStateRecorded("form-text-characters-written-as-outputs"),
		at: {
			kinds: ["form-part"],
			places: (facts) =>
				recordedForms(facts, "form-text-characters-written-as-outputs").flatMap(
					(position) => [
						partPlace(position, ":itext"),
						partPlace(position, ":control"),
					],
				),
		},
		paths: ["/_attachments/*"],
	},
	/**
	 * A Hidden Value whose bind `type` the source spells another way than the
	 * one Nova writes for the same answer class (`xsd:integer` for `xsd:int`):
	 * Core reads both spellings as one data class, and the publish writes
	 * Nova's. Recorded by `reader/xform/afterBinding.ts::recordHiddenAnswerSpellings`.
	 */
	"hidden-answer-types-respelled": {
		touchesWorkers: false,
		scope: "reading",
		applies: sameStateRecorded("hidden-answer-types-respelled"),
		at: {
			kinds: ["form-node"],
			places: (facts) => recordedPlaces(facts, "hidden-answer-types-respelled"),
		},
		paths: ["/_attachments/*"],
	},
	/**
	 * A model iteration's display condition on its container's bind, which the
	 * form builder discards (`parser.js::parseBindElement`: its question is the
	 * rows, `modeliteration.js::getPathName`). The publish writes it on the rows
	 * (`buildQueryRepeat`), so while it is false the submission holds the
	 * container and its ids where the source left both out
	 * (`XFormSerializingVisitor.serializeNode`). Recorded by
	 * `reader/xform/afterBinding.ts::moveContainerConditions`.
	 */
	"model-iteration-conditions-moved-to-rows": {
		touchesWorkers: true,
		scope: "reading",
		applies: sameStateRecorded("model-iteration-conditions-moved-to-rows"),
		at: {
			kinds: ["form-node"],
			places: (facts) =>
				recordedPlaces(facts, "model-iteration-conditions-moved-to-rows"),
		},
		paths: ["/_attachments/*"],
	},
	/**
	 * A case list's `invisible` column whose sort element has display text, under
	 * a header blank in every language: CommCare HQ's build gives the column a
	 * header (`detail_screen.py::Invisible.header`) whose app string it writes as
	 * a no-break space (`commcare_translations.py::dumps`), so Android's Sort by
	 * lists an entry that shows blank (`EntitySelectActivity.getSortOptionsList`
	 * lists every header that is not empty). Nova holds no name for the rule and
	 * writes the element's display blank (`hqJson/caseList.ts::sortDisplay`), so
	 * the entry leaves Sort by. Recorded by `caseList/order.ts::readSortElements`.
	 * Web Apps shows no Sort by entry for an invisible column, so a worker meets
	 * the change only where the app runs on Android.
	 */
	"sort-by-entry-with-a-blank-name-dropped": platformOnlyRecorded(
		"sort-by-entry-with-a-blank-name-dropped",
		{
			touchesWorkers: true,
			at: {
				kinds: ["menu"],
				places: (facts) =>
					recordedPlaces(facts, "sort-by-entry-with-a-blank-name-dropped"),
			},
			paths: ["/modules/*/case_details/short/sort_elements/*/display"],
		},
	),
	/**
	 * A form whose `<h:title>` holds other text than its name in the app's
	 * first language, which Nova writes there (`formWireName`): CommCare HQ's
	 * new form holds a blank title, and a rename through Bulk App Translations
	 * leaves the old one. CommCare Android shows the title at the top of a form
	 * a worker opens again from its saved forms with no menu's title to hand it
	 * (`FormEntryActivity.getHeaderString`) and names the saved form by it
	 * (`FormEntryInstanceState.getDefaultFormTitle`); Web Apps titles a form by
	 * its menu entry's text (`FormSession.getLocalizedFormTitle`), so the
	 * change is shown only where the app runs on Android. Recorded by
	 * `reader/assemble.ts::recordTitleRewrites`.
	 */
	"form-titles-written": platformOnlyRecorded("form-titles-written", {
		touchesWorkers: true,
		at: {
			kinds: ["form-part"],
			places: (facts) =>
				recordedForms(facts, "form-titles-written").map((position) =>
					placeOf("form", position, "xform", "title"),
				),
		},
		paths: ["/_attachments/*"],
	}),
	/**
	 * A form whose source declares a fixture no expression reads that the
	 * project space may not serve (`locations`, `commcare:reports`, any but a
	 * lookup table and `user-groups`): Core initializes every declared
	 * instance when the form opens (`FormDef.initialize`), and one whose
	 * fixture the device does not hold throws
	 * (`CommCareInstanceInitializer.loadFixtureRoot`), so the form cannot open
	 * there, on Android and Web Apps alike. Nova writes a form's declarations
	 * from what it reads, so the declaration goes and the form opens wherever
	 * it could not. Recorded by `reader/provisional.ts::claimDeclarations`.
	 */
	"unread-fixture-declarations-dropped": {
		touchesWorkers: true,
		scope: "reading",
		applies: sameStateRecorded("unread-fixture-declarations-dropped"),
		at: {
			kinds: ["form-part"],
			places: (facts) =>
				recordedForms(facts, "unread-fixture-declarations-dropped").map(
					(position) => placeOf("form", position, "xform", ":instance"),
				),
		},
		paths: ["/_attachments/*"],
	},
	/**
	 * A case owner rule the places CommCare HQ holds cannot satisfy, given to
	 * the worker who fills in the form by the person's answer to the review
	 * (`projectData/ownerRules.ts::workerOwnerMutations`). No reading gives it
	 * alone: it applies where the document committed (`doc`) gives such a case
	 * change to that worker and the reading (`read`) gives it to a place
	 * (`withAnsweredChanges`, only where an answer stands behind it). It stands at each such change's owner in the
	 * form's case block, and the stored owner update.
	 */
	"owner-rule-given-to-worker": {
		touchesWorkers: true,
		scope: "reading",
		applies: (facts) =>
			facts.read !== undefined && ownerGivenToWorker(facts.read, facts.doc),
		at: {
			kinds: ["form-part"],
			places: (facts) =>
				reverseHopOwnerChanges(facts.read ?? facts.doc).flatMap(
					({ formUuid, operation }) => {
						const position = facts.formPositions.get(formUuid);
						return position === undefined
							? []
							: [
									blockWritePlace(
										position,
										operation.action === "create" ? "create" : "update",
										"owner_id",
									),
								];
					},
				),
		},
		paths: [
			"/_attachments/*",
			"/modules/*/forms/*/actions/update_case/update/owner_id",
			"/modules/*/forms/*/actions/load_update_cases/*/case_properties/owner_id",
			"/modules/*/forms/*/actions/open_cases/*/case_properties/owner_id",
		],
	},
};

/**
 * Whether the register pointer `pattern` covers the concrete pointer `path`:
 * each segment matches, `*` matching any one, over the shorter of the two,
 * and where the pattern is the longer, every segment past `path`'s end is
 * `*`. A pointer covers everything under it, and a record at a map covers
 * a pattern that names each of its keys; a record at a list or a map above
 * a key the pattern names is not covered.
 */
export function pointerCovers(pattern: string, path: string): boolean {
	const want = pattern.split("/").slice(1);
	const got = path.split("/").slice(1);
	for (let at = 0; at < want.length; at++) {
		const segment = want[at] as string;
		if (at >= got.length) return want.slice(at).every((past) => past === "*");
		if (segment !== "*" && segment !== got[at]) return false;
	}
	return true;
}

/** The one builder of a `FirstPublishFacts`. */
export function firstPublishFactsOf(input: {
	readonly source: HqAppSource;
	readonly lookup: ReaderLookupCatalog;
	readonly columnFieldWords: readonly ColumnFieldWordRow[];
	/** The document under the declaration choice being judged. */
	readonly doc: BlueprintDoc;
	readonly facts: ReadFacts;
	/** The forms of `facts.forms`, in its order, as `emittedGeneratedNodes` takes them. */
	readonly forms: readonly { readonly uuid: Uuid }[];
	/** The project space the reading's emission is written for (`ReaderInput.target`). */
	readonly attachmentTarget: AttachmentUrlTarget;
	/** The files the media path assignment is made over. */
	readonly mediaFiles: readonly AdoptedMediaFile[];
	readonly mediaClaims: readonly HqMediaClaim[];
	readonly choice: {
		readonly runsOnlyOn: Platform | null;
		readonly split: boolean;
	};
}): FirstPublishFacts {
	const before = input.facts.forms.map((form) => form.generated);
	const after = emittedGeneratedNodes(
		input.doc,
		input.forms,
		input.attachmentTarget,
	);
	const positions = formPositionsOf(input.source);
	const formPositions = new Map<Uuid, FormPosition>();
	input.forms.forEach(({ uuid }, index) => {
		const xmlns = input.facts.forms[index]?.xmlns;
		const position =
			xmlns === undefined ? undefined : positions.byXmlns.get(xmlns);
		if (position !== undefined) formPositions.set(uuid, position);
	});
	return {
		source: input.source,
		lookup: input.lookup,
		columnFieldWords: input.columnFieldWords,
		doc: input.doc,
		facts: input.facts,
		generated: generatedDifference(before, after),
		generatedByForm: input.facts.forms.map((form, index) => ({
			position: positions.byXmlns.get(form.xmlns) ?? null,
			form,
			difference: generatedDifference(
				[before[index] ?? []],
				[after[index] ?? []],
			),
		})),
		positions,
		formPositions,
		// Keyed by content: a reading names each of HQ's media documents by a
		// provisional id and a create by its published one, so two documents of
		// one content are one asset only under an id their bytes give.
		media: readingMediaPaths(input.mediaFiles),
		mediaClaims: input.mediaClaims,
		choice: input.choice,
	};
}

/** Whether a stored list keeps `id`: every id but the two Web Apps lines, which it works out again from
 *  the stored Web App setting alone. */
export function storedInAList(id: CurrentFirstPublishChangeId): boolean {
	const entry = FIRST_PUBLISH_CHANGES[id];
	return entry.scope === "reading" || entry.recorded !== undefined;
}

/**
 * The list a baseline stores of a reading's list under the chosen
 * declaration: its ids a list keeps (`storedInAList`), with each id a worker
 * meets on one platform alone taken from the reading itself (`recorded`), whatever
 * the chosen declaration, so `firstPublishViewFromStored` can show it again
 * once the app runs on that platform. In registry order.
 */
export function firstPublishListToStore(
	chosen: FirstPublishView,
	facts: ReadFacts,
): FirstPublishView {
	const given = new Set(chosen.ids);
	const ids = CURRENT_FIRST_PUBLISH_CHANGE_IDS.filter((id) => {
		const recorded = FIRST_PUBLISH_CHANGES[id].recorded;
		if (recorded !== undefined) return recorded(facts);
		return given.has(id) && storedInAList(id);
	});
	return {
		ids,
		touchesWorkers: ids.some((id) => FIRST_PUBLISH_TOUCHES_WORKERS[id]),
		of: chosen.of,
	};
}

/**
 * `view`, the list of a reading worked out from `facts`, with each change in
 * `answered` that `committed`, the document the birth or the bring-in
 * commits, makes of the reading's own (`facts.doc`). In registry order.
 *
 * `answered` names the changes the person's answers stand behind: those the
 * answers of this request make, and those the list a take replaces already
 * holds. A change no answer stands behind is never inferred from the two
 * documents alone, since an author's own edit in Nova can make the same
 * difference (an owner rule set to the worker in the builder) with no
 * question asked.
 */
export function withAnsweredChanges(
	view: FirstPublishView,
	facts: FirstPublishFacts,
	committed: BlueprintDoc,
	answered: readonly FirstPublishChangeId[],
): FirstPublishView {
	if (committed === facts.doc) return view;
	const asked: FirstPublishFacts = {
		...facts,
		read: facts.doc,
		doc: committed,
	};
	const added = ANSWERED_FIRST_PUBLISH_CHANGES.filter(
		(id) =>
			answered.includes(id) &&
			!view.ids.includes(id) &&
			FIRST_PUBLISH_CHANGES[id].applies(asked),
	);
	if (added.length === 0) return view;
	const ids = new Set<FirstPublishChangeId>([...view.ids, ...added]);
	return {
		...view,
		ids: FIRST_PUBLISH_CHANGE_IDS.filter((id) => ids.has(id)),
		touchesWorkers:
			view.touchesWorkers ||
			added.some((id) => FIRST_PUBLISH_CHANGES[id].touchesWorkers),
	};
}

/** The ids whose `applies` is true, in registry order. */
export function firstPublishChangesFor(
	facts: FirstPublishFacts,
): FirstPublishView {
	const ids = CURRENT_FIRST_PUBLISH_CHANGE_IDS.filter((id) =>
		FIRST_PUBLISH_CHANGES[id].applies(facts),
	);
	return {
		ids,
		touchesWorkers: ids.some((id) => FIRST_PUBLISH_CHANGES[id].touchesWorkers),
		of: "first-publish",
	};
}

// ── The places of a reading's changes ───────────────────────────────────

/** One applying change and where it stands on one reading. */
export interface FirstPublishChangePlaces {
	readonly id: FirstPublishChangeId;
	/** Code-unit order; `[""]`, the whole app, for the change declared app-wide. */
	readonly places: readonly string[];
}

/**
 * Where each of `ids`, the changes that apply on `facts`, stands: the places
 * its entry gives (`FirstPublishChange.at`), in registry order. Throws where
 * an entry that is not app-wide gives no place, or a place of a kind it does
 * not declare: a change the proof lane's judge could meet nowhere, or could
 * not tell apart from the change that stands everywhere.
 */
export function firstPublishChangePlaces(
	facts: FirstPublishFacts,
	ids: readonly FirstPublishChangeId[],
): readonly FirstPublishChangePlaces[] {
	const listed = new Set(ids);
	return CURRENT_FIRST_PUBLISH_CHANGE_IDS.filter((id) => listed.has(id)).map(
		(id) => {
			const entry = FIRST_PUBLISH_CHANGES[id].at;
			if ("appWide" in entry) return { id, places: [""] };
			const places = sortedPlaces(entry.places(facts));
			if (places.length === 0)
				throw new Error(
					`The first-publish change ${id} applies on this reading and its entry names no place it stands at. An entry says where its change stands wherever it applies, from what the reading records of it; look at its at.places in lib/deployment/reading/firstPublishChanges.ts and at what the reading records under the id.`,
				);
			for (const place of places) {
				const kind = firstPublishPlaceKind(place);
				if (kind === null || kind === "app-wide" || !entry.kinds.includes(kind))
					throw new Error(
						`The first-publish change ${id} names the place ${JSON.stringify(place)}, which is ${kind === null ? "no place lib/deployment/reading/firstPublishPlaces.ts holds" : `of the kind ${kind}, one its entry does not declare (${entry.kinds.join(", ")})`}. Declare the kind in its at.kinds where the change stands there, or name the place it does stand at.`,
					);
			}
			return { id, places };
		},
	);
}

/** The proof register also names results in the emitted XML, stored cases and
 * generated HQ rows. Only a concrete source operand can authorize replacing
 * its value. A menu, form, attachment or the whole app is never such a slot. */
function storedSubjectValue(facts: FirstPublishFacts, place: string): unknown {
	const [root, at, ...rest] = placeSteps(place);
	if (root === "app" && at && at !== "modules" && at !== "_attachments")
		return storedAt(facts.source.raw, placeOf(at, ...rest));
	if (root === "menu" && rest.length && rest[0] !== "forms")
		return storedAt(facts.source.raw, placeOf("modules", at, ...rest));
	if (root === "form" && rest.length && rest[0] !== "xform") {
		const [menu, form] = at.split(".");
		return storedAt(
			facts.source.raw,
			placeOf("modules", menu, "forms", form, ...rest),
		);
	}
	return undefined;
}

/** Proof locations follow HQ's document order. Review compares the owner the two readings
 * rematched, so changing a menu or form's position changes only its displayed location. */
/** A column as what it shows, without the identities a reading mints for it
 *  and its display rules, which follow the column's position. */
function columnMeaning(column: Column): unknown {
	const { uuid: _uuid, ...rest } = column;
	if ("mapping" in rest)
		return {
			...rest,
			mapping: rest.mapping.map(({ uuid: _row, ...row }) => row),
		};
	return rest;
}

function reviewPlaceOf(facts: FirstPublishFacts) {
	const forms = new Map(
		[...facts.formPositions].map(([uuid, position]) => [position, uuid]),
	);
	const menus = projectedModulePreorder(facts.doc);
	const links = new Map(
		facts.facts.formLinkOwners.map(({ pointer, uuid }) => [pointer, uuid]),
	);
	const columnAt = new Map(
		facts.facts.detailColumnOwners.flatMap((owner) =>
			[owner.short, owner.long].flatMap((path) =>
				path ? [[path, owner] as const] : [],
			),
		),
	);
	const columns = new Map(
		Object.values(facts.doc.modules).flatMap((menu) =>
			(menu.caseListConfig?.columns ?? []).map(
				(column) => [column.uuid, column] as const,
			),
		),
	);
	const formLinks = new Map(
		Object.values(facts.doc.forms).flatMap((form) =>
			formLinkEntries(form).map((entry) => [entry.link.uuid, entry] as const),
		),
	);
	const searchInputs = new Map(
		Object.values(facts.doc.modules).flatMap((menu) =>
			(menu.caseListConfig?.searchInputs ?? []).map(
				(input) => [placeOf(menu.uuid, input.name), input] as const,
			),
		),
	);
	const slots = new Map<string, readonly string[]>();
	function rowKeys(
		menu: string,
		path: string[],
		index: string,
		source: readonly unknown[],
		key: (value: unknown, index: number) => unknown,
		distinguish?: (
			value: unknown,
			index: number,
		) => { meaning: unknown; source: unknown },
		alwaysBind = false,
	): string {
		const list = placeOf(menu, ...path);
		let keys = slots.get(list);
		if (!keys) {
			const groups = source.map((item, i) => JSON.stringify(key(item, i)));
			const repeated = new Set<string>();
			const seenGroups = new Set<string>();
			for (const group of groups) {
				if (seenGroups.has(group)) repeated.add(group);
				seenGroups.add(group);
			}
			const seen = new Map<string, number>();
			keys = source.map((item, i) => {
				const group = groups[i];
				// Identical normalized recipients have no independent identity on
				// HQ. Keep their occurrence AND exact physical source. Only peers
				// with distinguishable behavior can carry a receipt across a reorder.
				const peer =
					alwaysBind || repeated.has(group)
						? (distinguish?.(item, i) ?? { meaning: null, source: item })
						: null;
				const semantic = peer
					? canonicalJsonDigest([group, peer.meaning])
					: group;
				const ord = seen.get(semantic) ?? 0;
				seen.set(semantic, ord + 1);
				return canonicalJsonDigest([semantic, ord, peer?.source ?? null]);
			});
			slots.set(list, keys);
		}
		return keys[Number(index)] ?? index;
	}
	return (place: string): string => {
		const [root, position, ...rest] = placeSteps(place);
		if (root === "form") {
			if (rest[0] === "form_links" && /^\d+$/.test(rest[1] ?? "")) {
				const [menu, form] = position.split(".");
				const pointer = placeOf(
					"modules",
					menu,
					"forms",
					form,
					rest[0],
					rest[1],
				);
				const owner = links.get(pointer);
				if (owner) {
					if (rest[2] === "datums" && /^\d+$/.test(rest[3] ?? "")) {
						const rows = asList(
							storedAt(facts.source.raw, `${pointer}/datums`),
						);
						rest[3] = rowKeys(
							pointer,
							["datums"],
							rest[3],
							rows,
							(row) => at(row, "name") ?? null,
						);
					}
					const list = placeOf("modules", menu, "forms", form, "form_links");
					const rows = asList(storedAt(facts.source.raw, list));
					const linkAt = (index: number) => {
						const id = links.get(`${list}/${index}`);
						return id ? formLinks.get(id) : undefined;
					};
					rest[1] = rowKeys(
						list,
						[],
						rest[1],
						rows,
						(_, i) => linkAt(i)?.link.target ?? null,
						(row, i) => {
							const entry = linkAt(i);
							if (!entry) return { meaning: null, source: row };
							const { uuid: _uuid, ...meaning } = entry.link;
							// HQ rekeys form references in every export. The reader has
							// already resolved them against this reading's target ledger.
							const {
								form_id: _form,
								form_module_id: _menu,
								module_unique_id: _target,
								...physical
							} = asRecord(row);
							return { meaning: [entry.role, meaning], source: physical };
						},
						true,
					);
				}
			}
			return placeOf(root, forms.get(position) ?? position, ...rest);
		}
		if (root !== "menu") return place;
		const menu =
			menus[Number(position)] ??
			facts.source.modules[Number(position)]?.uniqueId ??
			position;
		if (
			rest[0] === "case_details" &&
			(rest[2] === "columns" || rest[2] === "sort_elements") &&
			/^\d+$/.test(rest[3] ?? "")
		) {
			const path = rest.slice(0, 3);
			let rows = asList(
				storedAt(facts.source.raw, placeOf("modules", position, ...path)),
			);
			if (
				!rows[Number(rest[3])] &&
				rest[1] === "short" &&
				rest[2] === "columns"
			) {
				const mod = facts.doc.modules[menus[Number(position)]];
				if (mod)
					rows = [
						...projectCaseListForHq(mod, facts.doc).caseDetails.short.columns,
					];
			}
			const columnIndex = rest[3];
			if (rest[4] === "enum" && /^\d+$/.test(rest[5] ?? "")) {
				const entries = asList(at(rows[Number(columnIndex)], "enum"));
				rest[5] = rowKeys(
					menu,
					[...path, columnIndex, "enum"],
					rest[5],
					entries,
					(entry) => at(entry, "key") ?? null,
				);
			}
			rest[3] = rowKeys(
				menu,
				path,
				columnIndex,
				rows,
				(row) => [at(row, "field") ?? null, at(row, "format") ?? null],
				(row, i) => {
					const pointer = placeOf("modules", position, ...path, i);
					const owner = columnAt.get(pointer);
					const column = owner && columns.get(owner.uuid);
					if (!owner || !column) return { meaning: null, source: row };
					const meaning = columnMeaning(column);
					const other = owner.short === pointer ? owner.long : owner.short;
					return {
						meaning,
						source: [row, other ? storedAt(facts.source.raw, other) : null],
					};
				},
			);
		} else if (
			rest[0] === "search_config" &&
			rest[1] === "properties" &&
			/^\d+$/.test(rest[2] ?? "")
		) {
			const path = rest.slice(0, 2);
			const rows = asList(
				storedAt(facts.source.raw, placeOf("modules", position, ...path)),
			);
			const name = at(rows[Number(rest[2])], "name");
			if (
				rest[3] === "validations" &&
				rest[4] === "0" &&
				typeof name === "string"
			) {
				// HQ's reader admits one validation per prompt. Its message belongs
				// to the normalized rule, even if another rule uses the same text.
				const input = searchInputs.get(placeOf(menu, name));
				if (input && input.kind !== "hidden")
					rest[4] = canonicalJsonDigest([
						"validation",
						input.validation?.rule ?? null,
					]);
			}
			rest[2] = rowKeys(
				menu,
				path,
				rest[2],
				rows,
				(row) => at(row, "name") ?? null,
			);
		}
		return placeOf(root, menu, ...rest);
	};
}

/** Resolve the actual source question to every affected case-write slot.
 * Both the guard and case-value emitter use this view. Other actions of the
 * form, other cases, and current datetime writers retain their own meaning. */
function caseWriterSubjects(
	facts: FirstPublishFacts,
	result: Map<FirstPublishChangeId, Map<string, string>>,
	reviewPlace: (place: string) => string,
) {
	const names = result.get("case-names-checked");
	const dates = result.get("date-and-time-saved-as-hq-stores-it");
	if (!names && !dates) return;
	const earlierDates = new Map<string, Set<string>>();
	if (dates)
		for (const row of facts.facts.sameStateRewrites) {
			if (row.register !== "date-and-time-saved-as-hq-stores-it") continue;
			const place = placeOfStoredPointer(facts.positions, row.path);
			if (!place) continue;
			const position = placeSteps(place)[1];
			const fields = earlierDates.get(position) ?? new Set<string>();
			for (const [kind, field] of row.removedInputs ?? [])
				if (kind === "datetime-question") fields.add(field);
			if (fields.size) earlierDates.set(position, fields);
		}
	const byPosition = new Map(
		[...facts.formPositions].map(([id, position]) => [position, id]),
	);
	for (const { position, difference } of facts.generatedByForm) {
		if (position === null) continue;
		const trimmed = new Set(
			names
				? difference.added
						.filter((node) => node.purpose === "trimmed")
						.map((node) => node.owner)
				: [],
		);
		const datetime = earlierDates.get(position);
		const form = byPosition.get(position);
		if ((!trimmed.size && !datetime) || !form) continue;
		const locations = collectFieldLocations(facts.doc, form);
		const operations = new Map(
			(facts.doc.forms[form]?.caseOperations ?? []).map((op) => [op.uuid, op]),
		);
		const reads = readsTrimmedSibling(facts.doc, form);
		for (const [uuid, views] of formCaseWriteViews(facts.doc, form)) {
			const field = locations.get(uuid)?.path.toXPath();
			if (!field || (!trimmed.has(field) && !datetime?.has(field))) continue;
			const place = nodePlace(position, field);
			for (const view of views) {
				const op = operations.get(view.operationUuid);
				if (!op) continue;
				const key = canonicalJsonDigest([
					reviewPlace(place),
					op.id,
					op.action,
					view.slot,
					view.caseType,
					view.property,
					view.via ?? null,
					view.destination,
					view.onlyIfChanged,
				]);
				if (datetime?.has(field)) dates?.set(key, place);
				if (
					trimmed.has(field) &&
					!view.link &&
					view.destination !== "worker-record" &&
					isCaseScalarTextProperty(view.property) &&
					reads(op.uuid)
				)
					names?.set(key, place);
			}
		}
	}
}

/** The physical recipient of a media loss, independent of proof locations
 * such as the app's media directory. Keep every shared XForm recipient,
 * and the concrete native value of a JSON-backed media slot. */
function mediaSubjects(
	facts: FirstPublishFacts,
	result: Map<FirstPublishChangeId, Map<string, string>>,
	reviewPlace: (place: string) => string,
) {
	const mediaChanges = [
		"media-paths-joined",
		"media-files-renamed",
		"unshown-form-media-removed",
		"broken-pictures-removed",
		"media-references-with-no-file-removed",
	] as const;
	if (!mediaChanges.some((id) => result.has(id))) return;
	const files = new Map(
		facts.source.multimediaMap?.map((file) => [file.path, file]),
	);
	const storedSlots = new Map<string, string>();
	const add = (
		id: FirstPublishChangeId,
		ref: MediaReferenceAt & MediaRecipients & { readonly slot: string },
		kind: string,
		move?: unknown,
	) => {
		const subjects = result.get(id);
		if (!subjects) return;
		const source =
			ref.pointer === undefined
				? null
				: placeOfStoredPointer(facts.positions, ref.pointer);
		const place =
			source ??
			(ref.place.kind === "question"
				? nodePlace(
						`${ref.place.menu}.${ref.place.form}`,
						`/data/${ref.place.path}`,
					)
				: null);
		if (!place || (!source && !ref.itextRecipients?.length))
			throw new Error(
				"A media change has no physical recipient in this reading.",
			);
		const file = files.get(ref.path);
		let storedSlot: string | undefined;
		if (ref.pointer !== undefined) {
			storedSlot = storedSlots.get(ref.pointer);
			if (storedSlot === undefined) {
				storedSlot = canonicalJsonDigest(
					storedAt(facts.source.raw, ref.pointer) ?? null,
				);
				storedSlots.set(ref.pointer, storedSlot);
			}
		}
		const base = canonicalJsonDigest([
			reviewPlace(place),
			ref.slot,
			kind,
			ref.path,
			file?.multimediaId ?? null,
			file?.mediaType ?? null,
			move ?? null,
			ref.shownLanguages ?? null,
			file?.unreadable
				? unreadableMediaIdentity(facts.source.raw, ref.path)
				: null,
			storedSlot ?? null,
		]);
		if (ref.itextRecipients?.length) {
			for (const recipient of ref.itextRecipients) {
				subjects.set(canonicalJsonDigest([base, "stored", recipient]), place);
				subjects.set(
					canonicalJsonDigest([base, "effective", recipient]),
					place,
				);
			}
			for (const recipient of ref.inheritedItextRecipients ?? [])
				subjects.set(
					canonicalJsonDigest([base, "effective", recipient]),
					place,
				);
		} else subjects.set(base, place);
	};
	for (const ref of facts.facts.unheldMedia)
		add("unshown-form-media-removed", ref, ref.form);
	for (const claim of facts.mediaClaims)
		add(
			claim.brokenPicture
				? "broken-pictures-removed"
				: "media-references-with-no-file-removed",
			claim.reference,
			claim.reference.kind,
		);
	const renamed = new Map(
		facts.media.rederived.map((move) => [mapPath(move.from), move]),
	);
	const joined = new Map(
		facts.media.collapsed.flatMap((move) =>
			move.dropped.map(
				(path) =>
					[mapPath(path), { kept: move.kept, assetId: move.assetId }] as const,
			),
		),
	);
	for (const ref of [
		...facts.facts.mediaReferences,
		...facts.facts.pendingMedia,
	]) {
		const path = mapPath(ref.path);
		const replacement = renamed.get(path);
		if (replacement)
			add("media-files-renamed", ref, ref.mediaKind, replacement);
		const kept = joined.get(path);
		if (kept) add("media-paths-joined", ref, ref.mediaKind, kept);
	}
}

export function publishChangeSubjects(
	facts: FirstPublishFacts,
	ids: readonly FirstPublishChangeId[],
): ReadonlyMap<FirstPublishChangeId, ReadonlyMap<string, string>> {
	const result = new Map(ids.map((id) => [id, new Map<string, string>()]));
	const reviewPlace = reviewPlaceOf(facts);
	caseWriterSubjects(facts, result, reviewPlace);
	// These changes have owning reader facts, not proof locations. In
	// particular /case/... has no corresponding node in the JSON source.
	const ordinary = ids.filter(
		(id) =>
			id !== "case-names-checked" &&
			id !== "date-and-time-saved-as-hq-stores-it" &&
			id !== "case-settings-respelled",
	);
	for (const { id, places } of firstPublishChangePlaces(facts, ordinary)) {
		const subjects = new Map<string, string>();
		result.set(id, subjects);
		for (const place of places) {
			const value = storedSubjectValue(facts, place);
			// Maps and lists at output locations may hold unrelated settings.
			// The reader records its actual object/list operand below.
			subjects.set(
				canonicalJsonDigest([
					reviewPlace(place),
					typeof value === "object" ? null : (value ?? null),
				]),
				place,
			);
		}
	}
	const storedOperands = new Map<string, string>();
	for (const record of facts.facts.sameStateRewrites) {
		const subjects = result.get(record.register);
		if (!subjects) continue;
		const place = placeOfStoredPointer(facts.positions, record.path);
		if (!place) continue;
		if (record.removedInputs?.length) {
			for (const item of record.removedInputs)
				subjects.set(canonicalJsonDigest([reviewPlace(place), ...item]), place);
		} else if (!record.path.startsWith("/_attachments/")) {
			let key = storedOperands.get(place);
			if (key === undefined) {
				key = canonicalJsonDigest([
					reviewPlace(place),
					storedSubjectValue(facts, place) ?? null,
				]);
				storedOperands.set(place, key);
			}
			subjects.set(key, place);
		}
	}
	for (const { position, form } of facts.generatedByForm) {
		const blanks = result.get("blank-translations-filled");
		if (!blanks || position === null) continue;
		const place = partPlace(position, ":itext");
		for (const slot of form.blankTranslationSlots ?? [])
			blanks.set(canonicalJsonDigest([reviewPlace(place), slot]), place);
	}
	for (const rewrite of facts.facts.rewrites) {
		const id = CURRENT_FIRST_PUBLISH_CHANGE_IDS.find(
			(item) => item === rewrite.id,
		);
		const set = id && result.get(id);
		if (!set || !rewrite.formExpression) continue;
		for (const place of placesOfSlot(facts.positions, rewrite))
			set.set(
				canonicalJsonDigest([
					reviewPlace(place),
					rewrite.key,
					rewrite.formExpression,
				]),
				place,
			);
	}
	mediaSubjects(facts, result, reviewPlace);
	return result;
}

/** The input to each registered consequence in one birth review. Generated
 * spelling alone and the file list a first content import must inspect at its
 * actual target have no approval at the birth. */
export function birthPublishSubjects(
	facts: FirstPublishFacts,
	view: FirstPublishView,
) {
	const ids = firstPublishListToStore(view, facts.facts).ids.filter(
		(id) =>
			id !== "forms-and-settings-rewritten" &&
			id !== "unused-media-entries-removed",
	);
	return [...publishChangeSubjects(facts, ids)].map(([id, subjects]) => [
		id,
		[...subjects.keys()].sort(),
	]);
}

/**
 * What makes `register` one the proof lane's judge cannot hold each change
 * of apart, each a sentence: an entry that is app-wide beside another, an
 * entry that declares no kind of place or the whole app's, and a kind the
 * vocabulary does not hold. None for the register itself, which the module
 * holds at load.
 */
export function firstPublishRegisterRefusals(
	register: Readonly<Record<string, Pick<FirstPublishChange, "at">>>,
): readonly string[] {
	const refusals: string[] = [];
	const appWide = Object.entries(register).filter(
		([, entry]) => "appWide" in entry.at,
	);
	if (appWide.length > 1)
		refusals.push(
			`The first-publish register declares ${appWide.map(([id]) => id).join(", ")} app-wide. One change alone may stand everywhere, keeping what no other change's place holds; two such changes stand at every place alike, so no difference could show one apart from the other.`,
		);
	for (const [id, entry] of Object.entries(register)) {
		if ("appWide" in entry.at) {
			if (entry.at.appWide.trim() === "")
				refusals.push(
					`The first-publish change ${id} is declared app-wide with no reason. Say why the change stands everywhere.`,
				);
			continue;
		}
		if (entry.at.kinds.length === 0)
			refusals.push(
				`The first-publish change ${id} declares no kind of place, so it stands only where the change declared app-wide stands and no difference could show it apart. Name the kinds of place its change makes a difference at.`,
			);
		// A register built elsewhere than this module (a test's) can hold any text here.
		for (const kind of entry.at.kinds as readonly string[])
			if (
				!(FIRST_PUBLISH_PLACE_KINDS as readonly string[]).includes(kind) ||
				kind === "app-wide"
			)
				refusals.push(
					`The first-publish change ${id} declares the kind of place ${JSON.stringify(kind)}, which ${kind === "app-wide" ? "is the whole app's, the one app-wide change's alone" : "lib/deployment/reading/firstPublishPlaces.ts does not hold"}.`,
				);
	}
	return refusals;
}

const REGISTER_REFUSALS = firstPublishRegisterRefusals(FIRST_PUBLISH_CHANGES);
if (REGISTER_REFUSALS.length > 0) throw new Error(REGISTER_REFUSALS.join("\n"));

/** The kinds of place each entry declares, as the proof lane's copy of the register states them
 *  (`proof/first-publish-changes.json`'s `placeKinds`): `["app-wide"]` for the app-wide entry. */
export function firstPublishPlaceKindsOf(
	id: CurrentFirstPublishChangeId,
): readonly FirstPublishPlaceKind[] {
	const entry = FIRST_PUBLISH_CHANGES[id].at;
	return "appWide" in entry ? ["app-wide"] : entry.kinds;
}
