/**
 * SA/MCP tool: `setFormOtherwise` / `set_form_otherwise` — where the worker
 * goes after a form when none of its destinations with a condition or a
 * carried case runs.
 *
 * Each arm maps onto the stored `FormOtherwise` of the same kind: a built-in
 * destination, or a link whose `linkUuid` becomes its `uuid` (minted when
 * omitted or null). `null` clears it, and the app home follows. The planner
 * (`lib/doc/formLinkMutations.ts::planSetOtherwise`) decides whether the
 * otherwise may be set, and its refusals read `linkRefusalMessage`.
 */

import { z } from "zod";
import { planSetOtherwise } from "@/lib/doc/formLinkMutations";
import {
	asUuid,
	type FormOtherwise,
	formOtherwiseSchema,
	OTHERWISE_DESTINATIONS,
	type Uuid,
	uniqueFormLinkDatumNames,
	uuidSchema,
} from "@/lib/domain";
import type { ToolInvocationContext } from "../../workspace/types";
import {
	guardedMutate,
	type MutatingToolResult,
	toToolErrorResult,
} from "../common";
import { formAddressSchema } from "../shared/entityAddresses";
import type { MutationSuccess } from "../shared/toolCallSummary";
import {
	formLinkDatumInputSchema,
	formLinkTargetInputSchema,
	formName,
	linkRefusalMessage,
	resolveLinkAddress,
} from "./shared";

export const setFormOtherwiseInputSchema = formAddressSchema
	.extend({
		otherwise: z
			.discriminatedUnion("kind", [
				z.strictObject({
					kind: z.literal("destination"),
					destination: z
						.enum(OTHERWISE_DESTINATIONS)
						.describe(
							'"firstMenu" (the app\'s first menu), "module" (this module\'s first screen), "parentMenu" (the parent module) or "previous" (the preceding selection or task), each only where the module offers it, as post_submit says.',
						),
				}),
				z.strictObject({
					kind: z.literal("link"),
					target: formLinkTargetInputSchema,
					datums: z
						.array(formLinkDatumInputSchema)
						.min(1)
						.nullable()
						.optional(),
					linkUuid: uuidSchema
						.nullable()
						.optional()
						.describe(
							"Stable UUID for the otherwise link; omit to let Nova mint it.",
						),
				}),
			])
			.nullable()
			.describe(
				"Where the worker goes when no destination with a condition or a carried case runs: a built-in destination, or a form or module like a destination's target. null goes to the app home.",
			),
	})
	.superRefine((input, ctx) => {
		if (input.otherwise?.kind === "link")
			uniqueFormLinkDatumNames(input.otherwise.datums, ctx, [
				"otherwise",
				"datums",
			]);
	});

export type SetFormOtherwiseInput = z.infer<typeof setFormOtherwiseInputSchema>;

export interface SetFormOtherwiseSuccess extends MutationSuccess {
	/** The form's otherwise after the commit; absent, the app home follows. */
	readonly otherwise?:
		| { readonly kind: "destination"; readonly destination: string }
		| { readonly kind: "link"; readonly linkUuid: Uuid };
}

export type SetFormOtherwiseResult =
	| SetFormOtherwiseSuccess
	| { readonly error: string };

/** The stored otherwise for an admitted input arm. */
function resolveOtherwiseInput(
	input: NonNullable<SetFormOtherwiseInput["otherwise"]>,
): FormOtherwise {
	if (input.kind === "destination")
		return { kind: "destination", destination: input.destination };
	return formOtherwiseSchema.parse({
		kind: "link",
		uuid: asUuid(input.linkUuid ?? crypto.randomUUID()),
		target: input.target,
		...(input.datums !== undefined &&
			input.datums !== null && { datums: input.datums }),
	});
}

export const setFormOtherwiseTool = {
	description:
		"Set where the worker goes after this form when none of its destinations with a condition or a carried case runs. It opens before any destination that runs every time. Offered only while some destination might not run, because it has a condition or carries values; null goes to the app home.",
	inputSchema: setFormOtherwiseInputSchema,
	async execute(
		input: SetFormOtherwiseInput,
		ctx: ToolInvocationContext,
	): Promise<MutatingToolResult<SetFormOtherwiseResult>> {
		const doc = ctx.snapshot.doc;
		try {
			const address = resolveLinkAddress(doc, input);
			if (!address.ok) {
				return {
					kind: "mutate",
					mutations: [],
					result: { error: address.error },
				};
			}
			const name = formName(doc, address.formUuid);
			const next =
				input.otherwise === null
					? null
					: resolveOtherwiseInput(input.otherwise);
			const plan = planSetOtherwise(doc, address.formUuid, next);
			if (!plan.ok) {
				return {
					kind: "mutate",
					mutations: [],
					result: {
						error: `The otherwise of form "${name}" was not set: ${linkRefusalMessage(plan.reason, doc, address.formUuid)}`,
					},
				};
			}
			const commit = await guardedMutate(
				ctx,
				[...plan.mutations],
				`form:${address.formUuid}`,
			);
			if (!commit.ok) {
				return {
					kind: "mutate",
					mutations: [],
					result: { error: commit.error },
				};
			}
			const stored = commit.newDoc.forms[address.formUuid]?.otherwise;
			return {
				kind: "mutate",
				mutations: commit.mutations,
				result: {
					ok: true,
					...(stored !== undefined && {
						otherwise:
							stored.kind === "destination"
								? { kind: "destination", destination: stored.destination }
								: { kind: "link", linkUuid: stored.uuid },
					}),
					summary: { location: name },
				},
			};
		} catch (error) {
			return toToolErrorResult(error);
		}
	},
};
