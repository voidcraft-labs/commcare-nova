import { describe, expect, it } from "vitest";
import { searchInputDisplayLabel } from "../searchInputPresentation";

describe("searchInputDisplayLabel", () => {
	it("keeps a unique authored label free of storage identifiers", () => {
		expect(
			searchInputDisplayLabel("client_name_query", [
				{ name: "client_name_query", label: "Client name", data_type: "text" },
			]),
		).toBe("Client name");
	});

	it("uses the humanized identity only when duplicate labels need it", () => {
		const inputs = [
			{ name: "client_name_query", label: "Client", data_type: "text" },
			{ name: "client_id_query", label: "Client", data_type: "text" },
		] as const;
		expect(searchInputDisplayLabel("client_name_query", inputs)).toBe(
			"Client (Client name query)",
		);
	});
});
