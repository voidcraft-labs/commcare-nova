import { expect, it } from "vitest";
import { postgresTestUrl } from "./perTestDatabase";

it("refuses a database fixture in the ordinary test project before connecting", () => {
	expect(() => postgresTestUrl()).toThrow("*.postgres.test.ts");
});
