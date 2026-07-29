/**
 * The SA connect-block input → domain `ConnectConfig` bridge — the
 * exact-shape bridge for the Connect XPath slots.
 *
 * The SA authors the connect block's XPath-valued slots
 * (`assessment.user_score`, `deliver_unit.entity_id` / `entity_name`)
 * as the canonical stored expression AST (`lib/domain/xpath`).
 * `buildConnectConfig` is where every connect writer merges that exact
 * shape: `updateForm` calls it with the form's
 * existing config (a structural partial-update merge), and the
 * creation tools (`createForm` / `createModule`) call it with no
 * existing config. Same-call field references already contain their
 * predeclared final UUIDs. This bridge never parses or resolves text;
 * the strict input schema admits only the stored AST shape.
 */

import type { ConnectConfig, XPathExpression } from "@/lib/domain";

/**
 * The connect-block shape as the SA authors it — XPath slots as canonical AST.
 * A structural superset of both authoring schemas (one shared shape,
 * two refinements: `planningSchemas.ts::connectFormConfigSchema` on the
 * creation tools, `connectFormPatchSchema` on `updateForm`), so each
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
 * `input.learn_module`, etc.). The creation tools pass
 * `existing: undefined` — there removal has nothing to remove, so null
 * degrades to "not supplied" and both surfaces share this one code
 * path. A patch that removes the LAST sub-config yields an empty
 * config; the caller collapses that to whole-block removal
 * (`updateForm` maps it to `connect: null`).
 *
 * Inner slots follow the same law where clearing is meaningful:
 * `deliver_unit.entity_id` / `entity_name` are optional on the domain
 * type — the XForm builder substitutes the canonical XPath defaults
 * when emitting the binds — so `null` clears them back to those
 * defaults. The one exception is each sub-config's `id`: it is the
 * sub-config's cross-version IDENTITY (`enforceConnectIds` would
 * silently re-mint a cleared one — an identity change, not a clear),
 * so a null id reads as "not supplied" and keeps the existing id on
 * both surfaces.
 *
 * No defaults are invented here.
 */
export function buildConnectConfig(
	input: ConnectConfigInput,
	existing: ConnectConfig | undefined,
): ConnectConfig {
	const out: ConnectConfig = { ...existing };
	if (input.learn_module === null) delete out.learn_module;
	if (input.learn_module != null) {
		const { id, ...learnRest } = input.learn_module;
		out.learn_module = {
			...existing?.learn_module,
			...learnRest,
			...(id != null && { id }),
		};
	}
	if (input.assessment === null) delete out.assessment;
	if (input.assessment != null) {
		const { id, user_score } = input.assessment;
		out.assessment = {
			...existing?.assessment,
			...(id != null && { id }),
			user_score,
		};
	}
	if (input.deliver_unit === null) delete out.deliver_unit;
	if (input.deliver_unit != null) {
		const { id, entity_id, entity_name, name } = input.deliver_unit;
		const merged: NonNullable<ConnectConfig["deliver_unit"]> = {
			...existing?.deliver_unit,
			name,
			...(id != null && { id }),
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
		out.task = { ...existing?.task, ...taskRest, ...(id != null && { id }) };
	}
	return out;
}
