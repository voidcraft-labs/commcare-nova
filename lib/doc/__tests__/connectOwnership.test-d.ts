import { expectTypeOf } from "vitest";
import type {
	NewFormInput,
	updateFormMutations,
} from "@/lib/agent/blueprintHelpers";
import type { BlueprintMutations } from "../hooks/useBlueprintMutations";

// Compile-time API ownership, checked by npm run typecheck.
expectTypeOf<keyof NewFormInput>()
	.exclude<"connect">()
	.toEqualTypeOf<keyof NewFormInput>();
expectTypeOf<keyof Parameters<typeof updateFormMutations>[2]>()
	.exclude<"connect">()
	.toEqualTypeOf<keyof Parameters<typeof updateFormMutations>[2]>();
expectTypeOf<keyof Parameters<BlueprintMutations["addForm"]>[1]>()
	.exclude<"connect">()
	.toEqualTypeOf<keyof Parameters<BlueprintMutations["addForm"]>[1]>();
expectTypeOf<keyof Parameters<BlueprintMutations["updateForm"]>[1]>()
	.exclude<"connect">()
	.toEqualTypeOf<keyof Parameters<BlueprintMutations["updateForm"]>[1]>();
