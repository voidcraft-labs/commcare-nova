/**
 * The SA connect-block input → domain `ConnectConfig` bridge — the
 * text → AST parse boundary for the Connect XPath slots.
 *
 * The SA authors the connect block's XPath-valued slots
 * (`assessment.user_score`, `deliver_unit.entity_id` / `entity_name`)
 * as TEXT; the domain stores each as the expression AST
 * (`lib/domain/xpath`). `buildConnectConfig` is where every connect
 * writer crosses that boundary: `updateForm` calls it with the form's
 * existing config (a structural partial-update merge), and the
 * creation tools (`createForm` / `createModule`) call it with no
 * existing config against the batch-aware resolver from
 * `fieldAssembly`, so a `user_score` referencing a field landing in
 * the same call resolves to an identity leaf. A connect block that
 * skips this bridge would persist raw strings the next load's Zod
 * gate rejects — which is exactly why no tool builds a
 * `ConnectConfig` from its input by cast.
 */

import type { ConnectConfig, XPathExpression } from "@/lib/domain";

/**
 * The connect-block shape as the SA authors it — XPath slots as text.
 * A structural superset of both authoring schemas
 * (`planningSchemas.ts::connectFormConfigSchema` on the creation
 * tools, the inline connect patch on `updateForm`), so each tool's
 * Zod-inferred input assigns into it without a cast.
 */
export interface ConnectConfigInput {
	learn_module?: {
		id?: string;
		name: string;
		description: string;
		time_estimate: number;
	};
	assessment?: {
		id?: string;
		user_score: string;
	};
	deliver_unit?: {
		id?: string;
		name: string;
		entity_id?: string;
		entity_name?: string;
	};
	task?: {
		id?: string;
		name: string;
		description: string;
	};
}

/**
 * Merge a connect-config input into a full `ConnectConfig`, parsing
 * each XPath-valued slot to its stored expression AST via `parseExpr`.
 *
 * Pure structural merge: keys absent from `input` are copied verbatim
 * from `existing`; keys present on `input` overlay the matching
 * existing sub-config (`existing.learn_module` ← `input.learn_module`,
 * etc.). The creation tools pass `existing: undefined` — there the
 * input IS the whole config, and only the parse boundary does work.
 *
 * No defaults are invented here. `deliver_unit` may land without
 * `entity_id` / `entity_name` — that's a normal state of the domain
 * type, and the XForm builder substitutes the canonical XPath defaults
 * when emitting the binds.
 */
export function buildConnectConfig(
	input: ConnectConfigInput,
	existing: ConnectConfig | undefined,
	parseExpr: (text: string) => XPathExpression,
): ConnectConfig {
	const out: ConnectConfig = { ...existing };
	if (input.learn_module !== undefined) {
		out.learn_module = { ...existing?.learn_module, ...input.learn_module };
	}
	if (input.assessment !== undefined) {
		const { user_score, ...assessmentRest } = input.assessment;
		out.assessment = {
			...existing?.assessment,
			...assessmentRest,
			user_score: parseExpr(user_score),
		};
	}
	if (input.deliver_unit !== undefined) {
		const { entity_id, entity_name, ...deliverRest } = input.deliver_unit;
		out.deliver_unit = {
			...existing?.deliver_unit,
			...deliverRest,
			...(entity_id !== undefined && { entity_id: parseExpr(entity_id) }),
			...(entity_name !== undefined && {
				entity_name: parseExpr(entity_name),
			}),
		};
	}
	if (input.task !== undefined) {
		out.task = { ...existing?.task, ...input.task };
	}
	return out;
}
