/** Provider projection for tools whose inputs are already authored values.
 * Shared app tools use authoring/toolSchema.ts before reaching the provider. */
import { jsonSchema, type Schema } from "ai";
import { z } from "zod";

const projectedSchemas = new WeakMap<z.ZodType, Schema<unknown>>();

export function providerToolSchema<I>(schema: z.ZodType<I>): Schema<I> {
	const prior = projectedSchemas.get(schema);
	if (prior) return prior as Schema<I>;
	const projected = jsonSchema<I>(
		z.toJSONSchema(schema, { target: "draft-7", io: "input" }),
		{
			validate(value) {
				const result = schema.safeParse(value);
				return result.success
					? { success: true, value: result.data }
					: { success: false, error: result.error };
			},
		},
	);
	projectedSchemas.set(schema, projected);
	return projected;
}
