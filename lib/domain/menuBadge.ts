import { z } from "zod";
import { valueSchema } from "./expression/types";

/** A short label beside a menu or form. Text has an owner-keyed translation unit.
 * A calculation is evaluated each time the worker's menu is shown. */
export const menuBadgeSchema = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("text"), text: z.string().min(1) }),
	z.strictObject({ kind: z.literal("calculation"), expression: valueSchema }),
]);
export type MenuBadge = z.infer<typeof menuBadgeSchema>;
