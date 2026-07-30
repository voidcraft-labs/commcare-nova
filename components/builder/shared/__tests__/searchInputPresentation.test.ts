import { describe, expect, it } from "vitest";
import { asUuid } from "@/lib/domain";
import { searchInputDisplayLabel } from "../searchInputPresentation";

describe("searchInputDisplayLabel", () => {
	it("keeps a unique authored label free of storage identifiers", () => {
		const clientNameUuid = asUuid("8faf100f-a6b0-4420-83c2-1a38b5de6858");
		expect(
			searchInputDisplayLabel(clientNameUuid, [
				{
					uuid: clientNameUuid,
					name: "client_name_query",
					label: "Client name",
					data_type: "text",
				},
			]),
		).toBe("Client name");
	});

	it("uses the humanized identity only when duplicate labels need it", () => {
		const inputs = [
			{
				uuid: asUuid("8faf100f-a6b0-4420-83c2-1a38b5de6858"),
				name: "client_name_query",
				label: "Client",
				data_type: "text",
			},
			{
				uuid: asUuid("2d8d5414-afda-4bb4-8190-f945293b26c9"),
				name: "client_id_query",
				label: "Client",
				data_type: "text",
			},
		] as const;
		expect(
			searchInputDisplayLabel(
				asUuid("8faf100f-a6b0-4420-83c2-1a38b5de6858"),
				inputs,
			),
		).toBe("Client (Client name query)");
	});
});
