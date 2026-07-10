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
		id?: string | null;
		name: string;
		description: string;
		time_estimate: number;
	} | null;
	assessment?: {
		id?: string | null;
		user_score: string;
	} | null;
	deliver_unit?: {
		id?: string | null;
		name: string;
		entity_id?: string | null;
		entity_name?: string | null;
	} | null;
	task?: {
		id?: string | null;
		name: string;
		description: string;
	} | null;
}

/**
 * Merge a connect-config input into a full `ConnectConfig`, parsing
 * each XPath-valued slot to its stored expression AST via `parseExpr`.
 *
 * Pure structural merge: keys absent from `input` — and `null` keys,
 * the wire's forced-key way of saying "not supplied" — are copied
 * verbatim from `existing`; non-null keys overlay the matching existing
 * sub-config (`existing.learn_module` ← `input.learn_module`, etc.),
 * with null INNER slots (a null id, a null entity_id) likewise dropped
 * before the spread so a null never lands on the stored config. The
 * creation tools pass `existing: undefined` — there the input IS the
 * whole config, and only the parse boundary does work.
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
	// Null leaf slots (a null id, a null entity_id) are dropped per key so a
	// forced-key null never spreads onto the stored config — the domain
	// schemas don't accept null.
	const out: ConnectConfig = { ...existing };
	if (input.learn_module != null) {
		const { id, ...learnRest } = input.learn_module;
		out.learn_module = {
			...existing?.learn_module,
			...learnRest,
			...(id != null && { id }),
		};
	}
	if (input.assessment != null) {
		const { id, user_score } = input.assessment;
		out.assessment = {
			...existing?.assessment,
			...(id != null && { id }),
			user_score: parseExpr(user_score),
		};
	}
	if (input.deliver_unit != null) {
		const { id, entity_id, entity_name, name } = input.deliver_unit;
		out.deliver_unit = {
			...existing?.deliver_unit,
			name,
			...(id != null && { id }),
			...(entity_id != null && { entity_id: parseExpr(entity_id) }),
			...(entity_name != null && {
				entity_name: parseExpr(entity_name),
			}),
		};
	}
	if (input.task != null) {
		const { id, ...taskRest } = input.task;
		out.task = { ...existing?.task, ...taskRest, ...(id != null && { id }) };
	}
	return out;
}
