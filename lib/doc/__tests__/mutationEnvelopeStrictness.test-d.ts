import { expectTypeOf } from "vitest";
import { z } from "zod";
import { mutationSchema } from "@/lib/doc/types";

const directUnion = z.discriminatedUnion("kind", mutationSchema.options);
expectTypeOf<z.input<typeof mutationSchema>>().toEqualTypeOf<
	z.input<typeof directUnion>
>();
expectTypeOf<z.output<typeof mutationSchema>>().toEqualTypeOf<
	z.output<typeof directUnion>
>();
