import { expectTypeOf, it } from "vitest";
import type { CreateAppOptions } from "../appGenesis";

// The compiler, not the runtime runner, proves the authored genesis surface.
it("excludes failed/deleted birth states and caller-supplied alternate genesis", () => {
	expectTypeOf<
		Extract<CreateAppOptions["status"], "error" | "deleted">
	>().toEqualTypeOf<never>();
	expectTypeOf<
		Extract<keyof CreateAppOptions, "appName" | "seedMutations">
	>().toEqualTypeOf<never>();
});
