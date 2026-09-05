import { expect, test } from "vitest";
import { down } from "../20260728010000_case_schema_index_convergence";

test("index convergence refuses automatic rollback", async () => {
	await expect(down()).rejects.toThrow(/forward-only/);
});
