/**
 * The SA connect-block input → domain `ConnectConfig` bridge — the
 * exact-shape bridge for the Connect XPath slots.
 *
 * The SA authors the connect block's XPath-valued slots
 * (`assessment.user_score`, `deliver_unit.entity_id` / `entity_name`)
 * as the canonical stored expression AST (`lib/domain/xpath`).
 * `buildConnectConfig` is where both machine writers carry that exact shape:
 * `updateForm` calls it with the form's existing config (a structural
 * partial-update merge), while `configureConnect` calls it with no existing
 * content because each participant is a complete replacement, plus the current
 * config as an identity source so an omitted same-form/same-kind id remains
 * final. Reference leaves already contain their final UUIDs. This bridge never
 * parses or resolves text; the strict input schema admits only the stored AST
 * shape.
 */

import type {
	ConnectAssessment,
	ConnectConfig,
	ConnectDeliverUnit,
	ConnectLearnModule,
	ConnectTask,
	XPathExpression,
} from "@/lib/domain";

export interface ConnectConfigDraft {
	learn_module?: Omit<ConnectLearnModule, "id"> & { id?: string };
	assessment?: Omit<ConnectAssessment, "id"> & { id?: string };
	deliver_unit?: Omit<ConnectDeliverUnit, "id"> & { id?: string };
	task?: Omit<ConnectTask, "id"> & { id?: string };
}

/**
 * The connect-block shape as the SA authors it — XPath slots as canonical AST.
 * A structural superset of both authoring schemas (one shared shape,
 * two refinements: `planningSchemas.ts::connectFormConfigSchema` on
 * `configureConnect`, `connectFormPatchSchema` on `updateForm`), so each
 * tool's Zod-inferred input assigns into it without a cast.
 */
export interface ConnectConfigInput {
	learn_module?: {
		id?: string | null;
		name: string;
		description: string;
		time_estimate: number;
	} | null;
	assessment?: {
		id?: string | null;
		user_score: XPathExpression;
	} | null;
	deliver_unit?: {
		id?: string | null;
		name: string;
		entity_id?: XPathExpression | null;
		entity_name?: XPathExpression | null;
	} | null;
	task?: {
		id?: string | null;
		name: string;
		description: string;
	} | null;
}

/**
 * Merge a connect-config input into a full `ConnectConfig`.
 *
 * The merge speaks the shared input contract (lib/agent/CLAUDE.md) at
 * sub-config scope: an OMITTED sub-config is copied verbatim from
 * `existing`; an explicit `null` REMOVES it; a non-null sub-config
 * overlays the matching existing one (`existing.learn_module` ←
 * `input.learn_module`, etc.). `configureConnect` passes
 * `existing: undefined` because every participant is an exact complete
 * replacement and passes the form's current config only as `identitySource`;
 * there removal has nothing to remove, so null degrades to "not supplied",
 * while an omitted id preserves the established same-kind identity. A patch
 * that removes the LAST sub-config yields an empty config; `updateForm` refuses
 * that participant-set change and points the caller to `configureConnect`.
 *
 * Inner slots follow the same law where clearing is meaningful:
 * `deliver_unit.entity_id` / `entity_name` are optional on the domain
 * type — the XForm builder substitutes the canonical XPath defaults
 * when emitting the binds — so `null` clears them back to those
 * defaults. The one exception is each sub-config's `id`: it is the
 * sub-config's cross-version IDENTITY (`enforceConnectIds` would
 * silently re-mint a cleared one — an identity change, not a clear),
 * so a null id reads as "not supplied" and keeps an existing id when
 * refining a participant.
 *
 * No defaults are invented here.
 */
export function buildConnectConfig(
	input: ConnectConfigInput,
	existing: ConnectConfig | undefined,
	identitySource: ConnectConfig | undefined = existing,
): ConnectConfigDraft {
	const out: ConnectConfigDraft = { ...existing };
	if (input.learn_module === null) delete out.learn_module;
	if (input.learn_module != null) {
		const { id, ...learnRest } = input.learn_module;
		const establishedId =
			identitySource && "learn_module" in identitySource
				? identitySource.learn_module?.id
				: undefined;
		const resolvedId = id != null ? id : establishedId;
		out.learn_module = {
			...(existing && "learn_module" in existing
				? existing.learn_module
				: undefined),
			...learnRest,
			...(resolvedId === undefined ? {} : { id: resolvedId }),
		};
	}
	if (input.assessment === null) delete out.assessment;
	if (input.assessment != null) {
		const { id, user_score } = input.assessment;
		const establishedId =
			identitySource && "assessment" in identitySource
				? identitySource.assessment?.id
				: undefined;
		const resolvedId = id != null ? id : establishedId;
		out.assessment = {
			...(existing && "assessment" in existing
				? existing.assessment
				: undefined),
			...(resolvedId === undefined ? {} : { id: resolvedId }),
			user_score,
		};
	}
	if (input.deliver_unit === null) delete out.deliver_unit;
	if (input.deliver_unit != null) {
		const { id, entity_id, entity_name, name } = input.deliver_unit;
		const establishedId =
			identitySource && "deliver_unit" in identitySource
				? identitySource.deliver_unit?.id
				: undefined;
		const resolvedId = id != null ? id : establishedId;
		const merged: NonNullable<ConnectConfigDraft["deliver_unit"]> = {
			...(existing && "deliver_unit" in existing
				? existing.deliver_unit
				: undefined),
			name,
			...(resolvedId === undefined ? {} : { id: resolvedId }),
		};
		if (entity_id === null) delete merged.entity_id;
		if (entity_id != null) merged.entity_id = entity_id;
		if (entity_name === null) delete merged.entity_name;
		if (entity_name != null) merged.entity_name = entity_name;
		out.deliver_unit = merged;
	}
	if (input.task === null) delete out.task;
	if (input.task != null) {
		const { id, ...taskRest } = input.task;
		const establishedId =
			identitySource && "task" in identitySource
				? identitySource.task?.id
				: undefined;
		const resolvedId = id != null ? id : establishedId;
		out.task = {
			...(existing && "task" in existing ? existing.task : undefined),
			...taskRest,
			...(resolvedId === undefined ? {} : { id: resolvedId }),
		};
	}
	return out;
}
