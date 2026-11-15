/**
 * The first-publish register: the closed list of what Nova's first publish
 * over an app it brought in from CommCare HQ may change there, and the
 * predicate that says, of one reading under one declaration choice, which
 * entries apply.
 *
 * Nova writes every form and every setting in its own spelling. Spelling is
 * free and behavior is not, so each entry says whether a worker meets the
 * change (`touchesWorkers`), and the JSON Pointers under which CommCare HQ's
 * stored app may differ because of it (`paths`). The ids, their sentences and
 * the stored list's shape are client-safe data in `lib/publish`; this module
 * holds what reads a reading.
 *
 * Pure: it reads only its arguments, so a read and the create that follows
 * it give one list for one choice.
 */

import type { HqAppSource } from "@/lib/commcare/hq/appSource";
import type { ReadFacts, ReadGeneratedNode } from "@/lib/commcare/reader/types";
import type { AttachmentUrlTarget } from "@/lib/commcare/xform/captureUrlNode";
import { collectFieldLocations } from "@/lib/commcare/xform/caseOps";
import {
	type GeneratedNodePurpose,
	generatedNodePaths,
} from "@/lib/commcare/xform/generatedNodes";
import type { BlueprintDoc, Uuid } from "@/lib/domain";
import type { Platform } from "@/lib/domain/platforms";
import {
	FIRST_PUBLISH_CHANGE_IDS,
	type FirstPublishChangeId,
	type FirstPublishView,
} from "@/lib/publish/firstPublishChangeIds";
import {
	type AdoptedMediaFile,
	assignMediaPaths,
	type MediaPathAssignment,
} from "../adoption";
import { reviewMediaId } from "./mediaIds";

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
	/** The document under the declaration choice being judged. */
	readonly doc: BlueprintDoc;
	readonly facts: ReadFacts;
	/** The reading's folded nodes against what Nova writes for `doc`. */
	readonly generated: GeneratedDifference;
	/** `assignMediaPaths` over the held files, keyed by content. */
	readonly media: MediaPathAssignment;
	/** Media references that point at no file and are left out. */
	readonly mediaLeftOut: number;
	readonly choice: {
		readonly runsOnlyOn: Platform | null;
		readonly split: boolean;
	};
}

export interface FirstPublishChange {
	/** Whether a worker meets the change. A `proof3` row of the lane stands only under such an entry. */
	readonly touchesWorkers: boolean;
	/**
	 * `declaration`: the predicate reads `choice.runsOnlyOn`, which a person can
	 * change in the builder afterwards, so the id is never stored and is worked
	 * out again from the stored Web App setting. `reading`: every other entry.
	 * Its id is stored at the birth.
	 */
	readonly scope: "reading" | "declaration";
	applies(facts: FirstPublishFacts): boolean;
	/**
	 * JSON Pointers over CommCare HQ's stored app, `*` for a position or an
	 * app's own key, under which the stored source may differ because of this
	 * entry. A pointer covers everything under it.
	 */
	readonly paths: readonly string[];
}

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

/** A Search field's keys a reading takes as spelled another way (`search/prompts.ts`). */
const SEARCH_FIELD_RESPELLED_KEYS: readonly string[] = [
	"label",
	"hint",
	"receiver_expression",
	"default_value",
	"required",
	"validations/*/text",
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

const sameStateRecorded =
	(id: FirstPublishChangeId) =>
	(facts: FirstPublishFacts): boolean =>
		facts.facts.sameStateRewrites.some((record) => record.register === id);

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

/**
 * The register, in the order of `FIRST_PUBLISH_CHANGE_IDS`. Each entry's doc
 * comment names where the change comes from.
 */
export const FIRST_PUBLISH_CHANGES: Readonly<
	Record<FirstPublishChangeId, FirstPublishChange>
> = {
	/**
	 * Nova writes every form and setting again in its own spelling
	 * (`lib/commcare/expander.ts::expandDoc`), and CommCare HQ's import marks
	 * every app it updates (`views/app_import_api.py::import_app_api` sets
	 * `created_from_template`, which no page and no runtime reads). Applies on
	 * every reading.
	 */
	"forms-and-settings-rewritten": {
		touchesWorkers: false,
		scope: "reading",
		applies: () => true,
		paths: [
			"/_attachments/*",
			"/modules/*/forms/*/case_references_data/load",
			"/modules/*/case_details/short/filter",
			"/created_from_template",
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
		paths: ["/_attachments/*", "/modules/*/forms/*/actions"],
	},
	/** A count lifted out of a validation (`xform/constraintCollections.ts::planConstraintCollections`). */
	"validation-counts-moved": {
		touchesWorkers: true,
		scope: "reading",
		applies: generatedAdds("validation-counts-moved"),
		paths: ["/_attachments/*"],
	},
	/** A validation message composed over its answer (`xform/constraintMessage.ts::protectConstraintMessage`). */
	"validation-messages-composed": {
		touchesWorkers: true,
		scope: "reading",
		applies: generatedAdds("validation-messages-composed"),
		paths: ["/_attachments/*"],
	},
	/** The rewrite `instant-comparison` (`xpath/wire/fromExpression.ts::compareSides`). */
	"instant-comparison": {
		touchesWorkers: true,
		scope: "reading",
		applies: rewriteReported("instant-comparison"),
		paths: EXPRESSION_PATHS,
	},
	/** The rewrite `empty-rows-guard` (`xpath/wire/emptyRows.ts`). */
	"empty-rows-guard": {
		touchesWorkers: true,
		scope: "reading",
		applies: rewriteReported("empty-rows-guard"),
		paths: EXPRESSION_PATHS,
	},
	/** The rewrite `absent-session-value-guard` (`xpath/wire/fromExpression.ts::term`). */
	"absent-session-value-guard": {
		touchesWorkers: true,
		scope: "reading",
		applies: rewriteReported("absent-session-value-guard"),
		paths: EXPRESSION_PATHS,
	},
	/** The rewrite `row-predicate-current` (`xpath/wire/formReads.ts::formReadToWire`). */
	"row-predicate-current": {
		touchesWorkers: true,
		scope: "reading",
		applies: rewriteReported("row-predicate-current"),
		paths: ["/_attachments/*"],
	},
	/** The rewrite `search-value-guards` (`csql/print.ts`). */
	"search-value-guards": {
		touchesWorkers: true,
		scope: "reading",
		applies: rewriteReported("search-value-guards"),
		paths: ["/modules/*/search_config/*"],
	},
	/** The rewrite `search-today-device-day` (`csql/emitter.ts::runtimeHole`). */
	"search-today-device-day": {
		touchesWorkers: true,
		scope: "reading",
		applies: rewriteReported("search-today-device-day"),
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
		paths: ["/modules/*/forms/*/actions", "/_attachments/*"],
	},
	/** A search's filter rows cut another way (`hqJson/caseList.ts::projectCaseListForHq`), recorded by `search/rows.ts`. */
	"search-filter-rows-recut": {
		touchesWorkers: false,
		scope: "reading",
		applies: sameStateRecorded("search-filter-rows-recut"),
		paths: ["/modules/*/search_config/default_properties"],
	},
	/** A sort rule over a property the list doesn't show, written as a hidden column, recorded by `caseList/order.ts`. */
	"sort-rule-kept-as-hidden-column": {
		touchesWorkers: false,
		scope: "reading",
		applies: sameStateRecorded("sort-rule-kept-as-hidden-column"),
		paths: [
			"/modules/*/case_details/short/columns",
			"/modules/*/case_details/short/sort_elements/*/field",
			"/modules/*/case_details/short/sort_elements/*/type",
			"/modules/*/case_details/short/sort_elements/*/display",
		],
	},
	/**
	 * A case list's, a search's or a menu's stored setting or text map Nova
	 * writes another way with nothing a device shows changed, recorded by the
	 * list, search and menu readers and by `heldText.ts::recordTextRewrite`.
	 */
	"list-settings-respelled": {
		touchesWorkers: false,
		scope: "reading",
		applies: sameStateRecorded("list-settings-respelled"),
		paths: [
			"/modules/*/case_details/short/max_select_value",
			"/modules/*/case_details/short/sort_elements",
			"/modules/*/search_config/title_label",
			"/modules/*/search_config/description",
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
		applies: sameStateRecorded("search-filter-joined-to-list"),
		paths: ["/modules/*/case_details/short/filter"],
	},
	/** A case list's filter sent with its search (`hqJson/caseList.ts::projectCaseListForHq`), recorded by `search/rows.ts`. */
	"search-restates-list-filter": {
		touchesWorkers: true,
		scope: "reading",
		applies: sameStateRecorded("search-restates-list-filter"),
		paths: ["/modules/*/search_config/default_properties"],
	},
	/** A held-case guard on a link that carries a case (`formLinkProjection.ts::formLinkCarriedCaseGuards`), recorded by `menus/afterSubmit.ts`. */
	"link-held-case-guards-added": {
		touchesWorkers: true,
		scope: "reading",
		applies: sameStateRecorded("link-held-case-guards-added"),
		paths: ["/modules/*/forms/*/form_links/*/xpath"],
	},
	/** A Register button's label with no text read as the words HQ's build writes, recorded by `menus/registration.ts::readLabel`. */
	"registration-label-fixed": {
		touchesWorkers: true,
		scope: "reading",
		applies: sameStateRecorded("registration-label-fixed"),
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
			facts.doc.connectType !== null &&
			facts.source.raw.auto_gps_capture !== true,
		paths: ["/auto_gps_capture"],
	},
	/** A generated translation key folded into the name it sets (`reader/assemble.ts::decideGeneratedKeys`). */
	"translation-overrides-folded": {
		touchesWorkers: false,
		scope: "reading",
		applies: (facts) => facts.facts.foldedTranslationKeys > 0,
		paths: [
			"/translations/*/*",
			"/name",
			"/modules/*/name/*",
			"/modules/*/forms/*/name/*",
			"/modules/*/case_list/label/*",
			"/modules/*/case_list_form/label/*",
		],
	},
	/** Every app writes `location_fixture_restore: project_default` (`hqShells.ts::applicationShell`). */
	"location-list-setting-reset": {
		touchesWorkers: false,
		scope: "reading",
		applies: (facts) =>
			facts.source.raw.location_fixture_restore === "both_fixtures" ||
			facts.source.raw.location_fixture_restore === "only_flat_fixture",
		paths: ["/location_fixture_restore"],
	},
	/** `cloudcare_enabled` written from where the app runs (`hqShells.ts::applicationShell`). */
	"web-apps-turned-off": {
		touchesWorkers: true,
		scope: "declaration",
		applies: (facts) =>
			facts.source.cloudcareEnabled && facts.choice.runsOnlyOn === "android",
		paths: ["/cloudcare_enabled"],
	},
	/** `cloudcare_enabled` written from where the app runs (`hqShells.ts::applicationShell`). */
	"web-apps-turned-on": {
		touchesWorkers: true,
		scope: "declaration",
		applies: (facts) =>
			!facts.source.cloudcareEnabled && facts.choice.runsOnlyOn !== "android",
		paths: ["/cloudcare_enabled"],
	},
	/** The split a person chose at the review (`lib/doc/datetimeSplit.ts`). */
	"date-and-time-questions-split": {
		touchesWorkers: true,
		scope: "reading",
		applies: (facts) => facts.choice.split,
		paths: ["/_attachments/*", "/modules/*/forms/*/actions"],
	},
	/** A translation left blank, filled from the first language (`lib/domain/translationFill.ts::filledProse`). */
	"blank-translations-filled": {
		touchesWorkers: true,
		scope: "reading",
		applies: (facts) =>
			facts.facts.forms.some((form) => form.blankTranslations > 0),
		paths: ["/_attachments/*"],
	},
	/** One file HQ holds under several paths, kept at one (`adoption.ts::assignMediaPaths`). */
	"media-paths-joined": {
		touchesWorkers: false,
		scope: "reading",
		applies: (facts) => facts.media.collapsed.length > 0,
		paths: ["/multimedia_map/*", ...MEDIA_REFERENCE_PATHS],
	},
	/** A path Nova cannot hold, the file taking its derivation (`adoption.ts::assignMediaPaths`). */
	"media-files-renamed": {
		touchesWorkers: true,
		scope: "reading",
		applies: (facts) => facts.media.rederived.length > 0,
		paths: ["/multimedia_map/*", ...MEDIA_REFERENCE_PATHS],
	},
	/** A reference to no file that no runtime draws, left out of the document. */
	"media-references-with-no-file-removed": {
		touchesWorkers: false,
		scope: "reading",
		applies: (facts) => facts.mediaLeftOut > 0,
		paths: [...MEDIA_REFERENCE_PATHS, "/multimedia_map/*"],
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
		applies: (facts) => {
			const named = new Set(
				facts.facts.mediaReferences.map((reference) => reference.path),
			);
			for (const path of logoPaths(facts.source)) named.add(path);
			return (facts.source.multimediaMap ?? []).some(
				(item) => !named.has(item.path),
			);
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
		paths: [
			"/modules/*/name",
			"/modules/*/forms/*/name",
			"/name",
			"/translations/*/app.display.name",
		],
	},
	/**
	 * A navigation media map read as the file HQ's build shows in each language
	 * and written under every language with the switches off
	 * (`multimedia/navMenuMedia.ts::buildNavMediaDicts`), recorded by
	 * `menus/navMedia.ts::recordRespelling`.
	 */
	"media-maps-respelled": {
		touchesWorkers: false,
		scope: "reading",
		applies: sameStateRecorded("media-maps-respelled"),
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
		],
	},
};

/**
 * Whether the register pointer `pattern` covers the concrete pointer `path`:
 * each segment matches, `*` matching any one, over the shorter of the two,
 * and where the pattern is the longer, every segment past `path`'s end is
 * `*`. A pointer covers everything under it, and a record at a map covers
 * a pattern that names each of its keys.
 */
export function pointerCovers(pattern: string, path: string): boolean {
	const want = pattern.split("/").slice(1);
	const got = path.split("/").slice(1);
	for (let at = 0; at < want.length; at++) {
		const segment = want[at] as string;
		if (at >= got.length) return segment === "*";
		if (segment !== "*" && segment !== got[at]) return false;
	}
	return true;
}

/** The one builder of a `FirstPublishFacts`. */
export function firstPublishFactsOf(input: {
	readonly source: HqAppSource;
	/** The document under the declaration choice being judged. */
	readonly doc: BlueprintDoc;
	readonly facts: ReadFacts;
	/** The forms of `facts.forms`, in its order, as `emittedGeneratedNodes` takes them. */
	readonly forms: readonly { readonly uuid: Uuid }[];
	/** The project space the reading's emission is written for (`ReaderInput.target`). */
	readonly attachmentTarget: AttachmentUrlTarget;
	/** The files the media path assignment is made over. */
	readonly mediaFiles: readonly AdoptedMediaFile[];
	readonly mediaLeftOut: number;
	readonly choice: {
		readonly runsOnlyOn: Platform | null;
		readonly split: boolean;
	};
}): FirstPublishFacts {
	return {
		source: input.source,
		doc: input.doc,
		facts: input.facts,
		generated: generatedDifference(
			input.facts.forms.map((form) => form.generated),
			emittedGeneratedNodes(input.doc, input.forms, input.attachmentTarget),
		),
		// Keyed by content: a reading names each of HQ's media documents by a
		// provisional id and a create by its published one, so two documents of
		// one content are one asset only under an id their bytes give.
		media: assignMediaPaths(
			input.mediaFiles.map((file) => ({
				...file,
				assetId: reviewMediaId(file.contentHash),
			})),
		),
		mediaLeftOut: input.mediaLeftOut,
		choice: input.choice,
	};
}

/** The ids whose `applies` is true, in registry order. */
export function firstPublishChangesFor(
	facts: FirstPublishFacts,
): FirstPublishView {
	const ids = FIRST_PUBLISH_CHANGE_IDS.filter((id) =>
		FIRST_PUBLISH_CHANGES[id].applies(facts),
	);
	return {
		ids,
		touchesWorkers: ids.some((id) => FIRST_PUBLISH_CHANGES[id].touchesWorkers),
		of: "first-publish",
	};
}
