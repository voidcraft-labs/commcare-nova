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
