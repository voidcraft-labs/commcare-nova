import { z } from "zod";
import { selectOptionValueSchema } from "@/lib/domain/selectOptionValue";

export const INLINE_CHOICES_MARKER = "x-nova-design-inline-choices";
const labelSchema = z.string().regex(/\S/, "A choice needs a nonblank label.");

/** The accepted wording and saved value travel together through review and
 * execution. Authoring may omit a value; stored designs never do. */
export const designChoiceSchema = z
	.object({
		value: selectOptionValueSchema,
		label: labelSchema,
	})
	.strict();
export type DesignChoice = z.infer<typeof designChoiceSchema>;

export const designChoicesSchema = z
	.array(designChoiceSchema)
	.superRefine((choices, ctx) => {
		const values = new Set<string>();
		for (const [index, choice] of choices.entries()) {
			if (values.has(choice.value))
				ctx.addIssue({
					code: "custom",
					path: [index, "value"],
					message: "Choice values must be unique.",
				});
			values.add(choice.value);
		}
	})
	.meta({ [INLINE_CHOICES_MARKER]: true });
