/**
 * The CommCare HQ plan privileges an app needs, derived from the document.
 *
 * No API key reads a project space's plan or its privileges, and HQ decides
 * each privilege on its own (`accounting/utils/__init__.py::domain_has_privilege`,
 * by the subscribed plan version's role or a legacy toggle keyed by that
 * privilege), so a publish asks the person to confirm each one this names,
 * once per project space. Each rule reads the emitter's own decision: the
 * function that decides whether the wire holds the content HQ gates is the
 * one this calls, so the confirmation and the wire cannot disagree.
 *
 * HQ's privilege slugs stay inside `lib/commcare`. `requiredPlanFeatures`
 * is the crossing into the public vocabulary of `lib/publish/planFeatures.ts`,
 * which every surface reads.
 */

import { descendantFieldUuids, orderedFormUuids } from "@/lib/doc/fieldWalk";
import { extractLookupReferenceTargets } from "@/lib/doc/lookupReferences";
import type { BlueprintDoc, Uuid } from "@/lib/domain";
import {
	type WorkerRecordRequirement,
	workerRecordRequirements,
} from "@/lib/domain/workerRecordRequirements";
import {
	type PlanFeatureId,
	type PlanFeatureUse,
	planFeatureUse,
} from "@/lib/publish/planFeatures";
import { fieldTakesCaseChoices } from "./caseOptions";
import { deliverUnitTakesDefaultEntity } from "./connectDefaults";
import {
	buildConnectSlugMap,
	connectConfigWritesBlocks,
	type ResolvedConnectConfig,
} from "./connectSlugs";
import { formLinkProjectionContext } from "./formLinkProjection";
import { formsReadingLocationsFixture } from "./locations/readsLocationsFixture";
import type { AttachmentUrlTarget } from "./xform/captureUrlNode";
import { formEmitsSaveToCase } from "./xform/caseOps";

/** The privileges a rule below derives, by HQ's slug. */
export const HQ_PLAN_PRIVILEGE_IDS = [
	"user_case",
	"lookup_tables",
	"child_cases",
	"form_link_workflow",
	"save_to_case",
	"locations",
	"data_forwarding",
] as const;
export type HqPlanPrivilegeId = (typeof HQ_PLAN_PRIVILEGE_IDS)[number];

/** One privilege this app needs, its gate entry, and why. */
export interface HqPlanPrivilegeUse {
	readonly id: HqPlanPrivilegeId;
	/** The gate entry id in `lib/commcare/surface/entries/gates.json`. */
	readonly gate: `privilege/${HqPlanPrivilegeId}`;
	/** One sentence per form that needs it, in form order, then the publish's own. */
	readonly reasons: readonly string[];
}

/**
 * Each form's Connect blocks, as `buildConnectSlugMap` resolves them. Several
 * rules read it, so one derivation builds it once and hands it to each.
 */
export type ConnectBlocks = ReadonlyMap<Uuid, ResolvedConnectConfig>;

/** What this publish sends besides the app, from Nova's own data. */
export interface PlanPrivilegePushes {
	/** The publish sends a lookup table workbook. */
	readonly lookupTables: boolean;
	/** The publish sends at least one place. */
	readonly places: boolean;
}

/**
 * The current plans, as HQ's `accounting/bootstrap/features.py` names its
 * lists and the subscription page names the plans, cheapest first. Every
 * other list in that file is a grandfathered plan.
 */
export const CURRENT_PLANS = [
	["community_v2", "Free"],
	["standard_v2", "Standard"],
	["pro_v1", "Pro"],
	["advanced_v0", "Advanced"],
	["enterprise_v0", "Enterprise"],
] as const;

/** Each privilege's plan feature in Nova's vocabulary. */
export const PLAN_FEATURE_FOR_PRIVILEGE = {
	user_case: "worker-records",
	lookup_tables: "lookup-tables",
	child_cases: "child-cases",
	form_link_workflow: "form-links",
	save_to_case: "advanced-case-actions",
	locations: "organization",
	data_forwarding: "data-forwarding",
} as const satisfies Record<HqPlanPrivilegeId, PlanFeatureId>;

/** A form named as every reason names it: its name, trimmed, or its id. */
function formName(doc: BlueprintDoc, formUuid: Uuid): string {
	const form = doc.forms[formUuid];
	if (form === undefined) return formUuid;
	return form.name.trim() || form.id;
}

/** Every form of the document, in its form order. */
function formsInOrder(
	doc: BlueprintDoc,
): { moduleUuid: Uuid; formUuid: Uuid }[] {
	return doc.moduleOrder.flatMap((moduleUuid) =>
		doc.modules[moduleUuid] === undefined
			? []
			: orderedFormUuids(doc, moduleUuid).flatMap((formUuid) =>
					doc.forms[formUuid] === undefined ? [] : [{ moduleUuid, formUuid }],
				),
	);
}

/**
 * The forms that use the worker's own record, in the document's form order:
 * the forms `workerRecordRequirements` names, and each form whose Connect
 * deliver unit leaves its entity id or name to the emitter, whose defaults
 * read the worker's username (`connectDefaults.ts::effectiveDeliverEntities`)
 * and count as a read. The `worker-record-access` preflight edge, the setup
 * artifact's `worker-record` section and the `user_case` confirmation's
 * reasons all read this one list.
 */
export function formsUsingWorkerRecord(
	doc: BlueprintDoc,
	connect: ConnectBlocks = buildConnectSlugMap(doc),
): WorkerRecordRequirement[] {
	const byForm = new Map(
		workerRecordRequirements(doc).map((form) => [form.formUuid, form]),
	);
	const forms: WorkerRecordRequirement[] = [];
	for (const { formUuid } of formsInOrder(doc)) {
		const own = byForm.get(formUuid);
		const deliverUnit = connect.get(formUuid)?.deliver_unit;
		const readsDefault =
			deliverUnit !== undefined && deliverUnitTakesDefaultEntity(deliverUnit);
		if (own === undefined && !readsDefault) continue;
		forms.push({
			formUuid,
			name: own?.name ?? formName(doc, formUuid),
			reads: (own?.reads ?? false) || readsDefault,
			writes: own?.writes ?? false,
		});
	}
	return forms;
}

/** "Lesson sends a learn module and an assessment to CommCare Connect." */
function connectFormReasons(
	doc: BlueprintDoc,
	connect: ConnectBlocks,
): string[] {
	return formsInOrder(doc).flatMap(({ formUuid }) => {
		const blocks = connect.get(formUuid);
		if (!connectConfigWritesBlocks(blocks)) return [];
		const named = [
			...(blocks.learn_module ? ["a learn module"] : []),
			...(blocks.assessment ? ["an assessment"] : []),
			...(blocks.deliver_unit ? ["a deliver unit"] : []),
			...(blocks.task ? ["a task"] : []),
		];
		if (named.length === 0) return [];
		return [
			`${formName(doc, formUuid)} sends ${named.join(" and ")} to CommCare Connect.`,
		];
	});
}

/**
 * The plan privileges this app needs on a project space, each with why, in
 * `HQ_PLAN_PRIVILEGE_IDS`' order. `pushes` says what this publish sends
 * beside the app (a lookup table workbook, places); both come from Nova's
 * own data, before CommCare HQ is asked anything. `attachmentTarget` is the
 * one the emitter is handed for the app this describes (a publish's is its
 * own project space; an import file's may be none), since whether a capture
 * written as a link is a case write depends on it. `connect` is the app's
 * Connect blocks, for a caller that already holds them.
 */
export function requiredPlanPrivileges(
	doc: BlueprintDoc,
	pushes: PlanPrivilegePushes,
	attachmentTarget: AttachmentUrlTarget | null,
	connect: ConnectBlocks = buildConnectSlugMap(doc),
): HqPlanPrivilegeUse[] {
	const uses: HqPlanPrivilegeUse[] = [];
	const add = (id: HqPlanPrivilegeId, reasons: readonly string[]): void => {
		if (reasons.length === 0) return;
		uses.push({ id, gate: `privilege/${id}`, reasons });
	};
	const forms = formsInOrder(doc);
	/* The form link context the emitter builds (`expander.ts::expandDoc`),
	 * so each form's actions and case writes are the ones it writes. */
	const linkContext = formLinkProjectionContext(doc, {
		entryMetadataOnly: true,
		attachmentTarget,
	});

	/* `user_case`: HQ's build fails for a form that saves to the worker's
	 * record (`helpers/validators.py::ApplicationValidator._check_subscription`),
	 * and a worker's record is made only under the privilege
	 * (`callcenter/sync_usercase.py::_iter_sync_usercase_helpers`), so every
	 * value a form reads from it is blank. */
	add(
		"user_case",
		formsUsingWorkerRecord(doc, connect).map(
			(form) =>
				`${form.name} ${
					form.reads && form.writes
						? "reads and saves"
						: form.writes
							? "saves"
							: "reads"
				} worker information.`,
		),
	);

	/* `lookup_tables`: the build fails for a form that reads a table
	 * (`helpers/validators.py::ApplicationBaseValidator._validate_fixtures`),
	 * the workbook push is answered with HQ's Upgrade Required page
	 * (`fixtures/dispatcher.py::require_can_edit_fixtures`), and Vellum
	 * reports an error on every question that holds an itemset, one over the
	 * worker's cases among them (`src/itemset.js`). */
	const readsTable =
		pushes.lookupTables ||
		extractLookupReferenceTargets(doc).tableIds.length > 0;
	add("lookup_tables", [
		...(readsTable ? ["The app reads data from a lookup table."] : []),
		...forms.flatMap(({ formUuid }) =>
			[...descendantFieldUuids(doc, formUuid)].some((fieldUuid) => {
				const field = doc.fields[fieldUuid];
				return field !== undefined && fieldTakesCaseChoices(field);
			})
				? [`${formName(doc, formUuid)} offers cases as a question's choices.`]
				: [],
		),
	]);

	/* `child_cases`: HQ's Case Management page keeps a form's child cases
	 * un-editable without it (`add_ons.py::_ADD_ONS["subcases"]`, whose
	 * `used_in_form` reads the `subcases` list's length). */
	add(
		"child_cases",
		forms.flatMap(({ formUuid }) =>
			linkContext.formActions(formUuid).subcases.length > 0
				? [`${formName(doc, formUuid)} creates or updates a child case.`]
				: [],
		),
	);

	/* `form_link_workflow`: HQ's form settings page posts no link without it
	 * and its view ignores one that is posted (`views/forms.py::_edit_form_attr`),
	 * so nobody can change the links Nova wrote. The emitter writes
	 * `post_form_workflow: "form"` exactly for a form with links. */
	add(
		"form_link_workflow",
		forms.flatMap(({ formUuid }) =>
			(doc.forms[formUuid]?.formLinks ?? []).length > 0
				? [
						`${formName(doc, formUuid)} opens another form after it is submitted.`,
					]
				: [],
		),
	);

	/* `save_to_case`: HQ loads Vellum's `saveToCase` plugin only under it
	 * (`views/formdesigner.py::_get_vellum_plugins`), so a save in the form
	 * builder discards the case binds of every Save to Case block. */
	add(
		"save_to_case",
		forms.flatMap(({ formUuid }) =>
			formEmitsSaveToCase(doc, formUuid, linkContext)
				? [
						`${formName(doc, formUuid)} writes its case changes as Save to Case blocks.`,
					]
				: [],
		),
	);

	/* `locations`: without it no location list reaches a worker
	 * (`domain/models.py::Domain.uses_locations`, read by
	 * `locations/fixtures.py::should_sync_flat_fixture`), and HQ answers the
	 * place push 403 (`locations/resources/v0_5.py::BaseLocationsResource.dispatch`).
	 * The form list reads the shared wire serializer's instance dependencies. */
	add("locations", [
		...flatLocationFixtureReasons(doc),
		...(pushes.places
			? ["This publish sends the places in your organization."]
			: []),
	]);

	/* `data_forwarding`: HQ registers no repeat record without it
	 * (`corehq/motech/repeaters/models.py::domain_can_forward`), so its
	 * receiver takes each form and nothing reaches CommCare Connect. */
	add("data_forwarding", connectFormReasons(doc, connect));

	return uses;
}

/** The plan features this app needs, in Nova's vocabulary, each keeping its reasons. */
export function requiredPlanFeatures(
	doc: BlueprintDoc,
	pushes: PlanPrivilegePushes,
	attachmentTarget: AttachmentUrlTarget | null,
	connect: ConnectBlocks = buildConnectSlugMap(doc),
): PlanFeatureUse[] {
	return requiredPlanPrivileges(doc, pushes, attachmentTarget, connect).map(
		(use) => planFeatureUse(PLAN_FEATURE_FOR_PRIVILEGE[use.id], use.reasons),
	);
}

/**
 * The reasons a Connect forwarder is asked about: one sentence per form that
 * sends a block to CommCare Connect, the same sentences Data Forwarding's
 * reasons hold. Empty for an app with no Connect block.
 */
export function connectForwarderReasons(
	doc: BlueprintDoc,
	connect: ConnectBlocks = buildConnectSlugMap(doc),
): string[] {
	return connectFormReasons(doc, connect);
}

/**
 * The reasons the flat location list is asked about: one sentence per form
 * whose source or links read places, in form order. A form whose only read is
 * a case owner taken from a place says so; any other read says the form
 * reads places. Empty for an app that reads none. The `locations`
 * privilege's form reasons are these same sentences.
 */
export function flatLocationFixtureReasons(doc: BlueprintDoc): string[] {
	return formsReadingLocationsFixture(doc).map(({ formUuid, why }) =>
		why === "owner"
			? `${formName(doc, formUuid)} sets a case's owner from a place in your organization.`
			: `${formName(doc, formUuid)} reads places in your organization.`,
	);
}
