/**
 * HQ `FormActions` + `case_references_data.load` assembly.
 *
 * `buildFormActions` is the basic projection of the form's one wire plan
 * (`casePlacementPlan.ts::planFormCaseWire`): the own case's open or
 * update and its close, the worker's record, and each basic subcase, every
 * `question_path` a `/data/...` path through the form's groups and repeats.
 * Which case change takes a basic slot is the placement's decision
 * (`placement.ts::planPlacements`), never this file's.
 *
 * `buildCaseReferencesLoad` is the complement: it walks every field's
 * typed expressions for case and worker-record reads and maps the field's full
 * `/data/...` path to the list of references used at that path — translated
 * into the `#case/`-generation vocabulary HQ's case-metadata layer parses
 * (`hqLoadReference`), which feeds HQ's app summary / case property usage.
 */

import { orderedFieldUuids } from "@/lib/doc/fieldWalk";
import {
	type BlueprintDoc,
	expressionSlotValue,
	type Uuid,
	userPropertySlugsByUuid,
} from "@/lib/domain";
import type { Expression } from "@/lib/domain/expression/types";
import { walkExpressionTerms } from "@/lib/domain/expression/walk";
import { planFormCaseWire } from "./casePlacementPlan";
import { caseTypeDepthMap } from "./caseTypeDepths";
import {
	effectiveAssessmentUserScore,
	effectiveDeliverEntities,
} from "./connectDefaults";
import type { ResolvedConnectConfig } from "./connectSlugs";
import { hqLoadReference } from "./hashtags";
import type { FormActions } from "./types";
import type { AttachmentUrlTarget } from "./xform/captureUrlNode";
import { descendFormPathIntoField, FormPath } from "./xform/formPath";

/**
 * HQ's basic `FormActions` for `formUuid`: `planFormCaseWire`'s actions.
 * A form of a menu emitted advanced has `AdvancedFormActions` instead, which
 * its plan holds, so asking this of one throws.
 *
 * A capture's link write names its `nova_url_<question>` sibling, never the
 * capture: HQ's build turns an update whose question path is an upload
 * question into an `<attachment>` block (`xform.py::XFormCaseBlock.
 * add_case_updates`, `::is_attachment`). With no `attachmentTarget` there is
 * no origin and no project space to build the link from, so the plan
 * withholds that write. Nova never writes `case_preload`: a preload is the
 * question's default value, written at its place in the source.
 */
export function buildFormActions(
	doc: BlueprintDoc,
	formUuid: Uuid,
	attachmentTarget: AttachmentUrlTarget | null = null,
): FormActions {
	const plan = planFormCaseWire(doc, formUuid, { attachmentTarget });
	if (plan.kind === "advanced")
		throw new Error(
			"This form is emitted as an advanced form; read its advanced actions.",
		);
	return plan.actions;
}

/**
 * Build `case_references_data.load` for `formUuid`.
 *
 * Walks every field under the form, extracts case and worker-record identities
 * from its expression properties (`relevant`,
 * `validate`, `calculate`, `default_value`, `required`), and emits a
 * map from the field's full `/data/...` path to the list of hashtags
 * it references. Also scans the Connect assessment / deliver-unit
 * XPath fields and emits their own entries keyed by the Connect
 * wrapper paths.
 *
 * `connect` is the resolved config from `buildConnectSlugMap` (a typed
 * pass-through; ids are valid by construction at the source). The XForm
 * builder emits its binds against those same ids, so the load-map keys here
 * line up with the bind nodesets.
 *
 * Every typed case read is projected through `hqLoadReference` into the
 * `#case/`-generation vocabulary HQ's metadata layer parses — `moduleCaseType`
 * feeds the same `caseTypeDepthMap` the XForm builder resolves per-type
 * namespaces with, so the load map and the binds name the same case.
 */
export function buildCaseReferencesLoad(
	doc: BlueprintDoc,
	formUuid: Uuid,
	connect?: ResolvedConnectConfig,
	moduleCaseType?: string,
): Record<string, string[]> {
	const load: Record<string, string[]> = {};
	const caseTypeDepths = caseTypeDepthMap(moduleCaseType, doc.caseTypes ?? []);
	// The one legal authored case ref on a registration form is
	// `#<own_type>/case_id`. Its private HQ metadata projection is
	// `#case/case_id`, while the XForm side reads the session datum the entry
	// mints the new case's id into, the datum HQ's build also sets
	// `/data/case/@case_id` from. Recording that private projection here would
	// tell HQ's App Summary the form reads `case_id` from a case database it
	// never touches.
	// Vanilla parity: HQ's editor can't author case refs on a non-case-loading
	// form at all, so its load map for a registration form is empty.
	const isRegistration = doc.forms[formUuid].type === "registration";
	const userProperties = userPropertySlugsByUuid(doc);
	// Metadata follows typed reads. Literal text and session-user values have
	// no case-load meaning, even when their text looks like a worker hashtag.
	const toLoadRefs = (expressions: readonly Expression[]): string[] => {
		const refs = new Set<string>();
		for (const expression of expressions)
			walkExpressionTerms(expression, (term) => {
				if (term.kind === "form-case") {
					const reference = hqLoadReference(
						term.caseType,
						term.property,
						caseTypeDepths,
					);
					if (
						reference !== undefined &&
						!(isRegistration && reference === "#case/case_id")
					)
						refs.add(reference);
				} else if (
					term.kind === "session-user" &&
					term.source === "worker-record"
				) {
					refs.add(`#user/${term.field}`);
				} else if (
					term.kind === "session-user-property" &&
					term.source === "worker-record"
				) {
					const slug = userProperties.get(term.userPropertyUuid);
					if (slug === undefined)
						throw new Error(
							`Worker property ${term.userPropertyUuid} has no current name for HQ case-load metadata.`,
						);
					refs.add(`#user/${slug}`);
				}
			});
		return [...refs];
	};

	const walk = (parentUuid: Uuid, parentPath: FormPath): void => {
		for (const fieldUuid of orderedFieldUuids(doc, parentUuid)) {
			const field = doc.fields[fieldUuid];
			if (!field) continue;
			const nodePath = parentPath.child(field.id);

			const expressions = (
				[
					"relevant",
					"validate",
					"calculate",
					"default_value",
					"required",
				] as const
			).flatMap((slot) => {
				const expression = expressionSlotValue(doc, {
					entity: "field",
					uuid: field.uuid,
					slot,
				});
				return expression === undefined ? [] : [expression];
			});
			const references = toLoadRefs(expressions);
			if (references.length > 0) load[nodePath.toXPath()] = references;

			// Containers: recurse into their children. `doc.fieldOrder`
			// having an entry for this uuid is the container marker.
			// `descendFormPathIntoField` adds the model-iteration `<item>` step for
			// `query_bound` so descendant paths match the XForm emitter +
			// identity-backed case binding path derivation.
			if (doc.fieldOrder[fieldUuid] !== undefined) {
				walk(fieldUuid, descendFormPathIntoField(field, nodePath));
			}
		}
	};

	walk(formUuid, FormPath.root());

	// Connect assessment + deliver unit carry their own XPath fields
	// keyed by the Connect wrapper ids.
	if (connect?.assessment) {
		const assessId = connect.assessment.id;
		// `effectiveAssessmentUserScore` is the single source of truth for
		// the wire-fallback policy — the bind emitter calls the same helper,
		// so the load map's hashtag set always matches what the runtime will
		// evaluate from that bind. (The default is a hashtag-free literal,
		// so an unset user_score contributes no load entry.)
		const h = toLoadRefs([effectiveAssessmentUserScore(connect.assessment)]);
		if (h.length > 0) {
			load[
				FormPath.root()
					.child(assessId)
					.child("assessment")
					.child("user_score")
					.toXPath()
			] = h;
		}
	}
	if (connect?.deliver_unit) {
		const duId = connect.deliver_unit.id;
		// `effectiveDeliverEntities` is the single source of truth for
		// the wire-fallback policy. The bind emitter calls the same
		// helper, so the load map's hashtag set always matches what the
		// runtime will evaluate from those binds.
		const { entityId, entityName } = effectiveDeliverEntities(
			connect.deliver_unit,
		);
		const deliverPath = FormPath.root().child(duId).child("deliver");
		const idH = toLoadRefs([entityId]);
		if (idH.length > 0) {
			load[deliverPath.child("entity_id").toXPath()] = idH;
		}
		const nameH = toLoadRefs([entityName]);
		if (nameH.length > 0) {
			load[deliverPath.child("entity_name").toXPath()] = nameH;
		}
	}

	return load;
}
