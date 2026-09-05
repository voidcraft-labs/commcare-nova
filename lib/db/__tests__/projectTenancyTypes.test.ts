import { expectTypeOf, it } from "vitest";
import type { ApplyBlueprintChangeArgs } from "../applyBlueprintChange";
import type { loadAppProjectId } from "../apps";
import type { AppsTable } from "../pg";
import type { AppDoc } from "../types";

// These assertions are checked by npm run typecheck, independently of source formatting.
it("requires Project identity and represents a missing app as a separate arm", () => {
	expectTypeOf<AppsTable["project_id"]>().toEqualTypeOf<string>();
	expectTypeOf<AppDoc["project_id"]>().toEqualTypeOf<string>();
	expectTypeOf<
		ApplyBlueprintChangeArgs["expectedProjectId"]
	>().toEqualTypeOf<string>();
	expectTypeOf<Awaited<ReturnType<typeof loadAppProjectId>>>().toEqualTypeOf<
		| { readonly kind: "found"; readonly projectId: string }
		| { readonly kind: "not-found" }
	>();
});
