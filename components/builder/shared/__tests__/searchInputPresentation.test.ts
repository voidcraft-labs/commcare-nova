import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { searchInputDisplayLabel } from "../searchInputPresentation";

describe("searchInputDisplayLabel", () => {
	it("keeps a unique authored label free of storage identifiers", () => {
		const inputUuid = testUuid("client-name-query");
		expect(
			searchInputDisplayLabel(inputUuid, [
				{
					uuid: inputUuid,
					name: "client_name_query",
					label: "Client name",
					data_type: "text",
				},
			]),
		).toBe("Client name");
	});

	it("uses the humanized identity only when duplicate labels need it", () => {
		const nameUuid = testUuid("client-name-query");
		const inputs = [
			{
				uuid: nameUuid,
				name: "client_name_query",
				label: "Client",
				data_type: "text",
			},
			{
				uuid: testUuid("client-id-query"),
				name: "client_id_query",
				label: "Client",
				data_type: "text",
			},
		] as const;
		expect(searchInputDisplayLabel(nameUuid, inputs)).toBe(
			"Client (Client name query)",
		);
	});
});

it("resolves missing or blank labels and detects case-insensitive authored duplicates", () => {
	const uuid = testUuid("name");
	expect(searchInputDisplayLabel(uuid, [])).toBe("Search field");
	expect(
		searchInputDisplayLabel(uuid, [{ uuid, name: "first_name", label: "   " }]),
	).toBe("First name");
	expect(
		searchInputDisplayLabel(uuid, [
			{ uuid, name: "first_name", label: " Person " },
			{ uuid: testUuid("other"), name: "last_name", label: "person" },
		]),
	).toBe("Person (First name)");
});
