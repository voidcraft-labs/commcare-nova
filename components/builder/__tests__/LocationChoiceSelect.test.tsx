// @vitest-environment happy-dom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { settleBaseUiTransitions } from "@/__tests__/helpers/baseUiInteractions";
import { testUuid } from "@/__tests__/helpers/uuid";
import type { StoredLocation } from "@/lib/organization/types";
import { LocationChoiceSelect } from "../LocationChoiceSelect";

function location(index: number): StoredLocation {
	return {
		id: testUuid(`location-${index}`),
		levelUuid: testUuid("level"),
		parentId: null,
		siteCode: `place-${index}`,
		name: `Place ${index}`,
		externalId: null,
		latitude: null,
		longitude: null,
		values: {},
		archivedAt: null,
		orderKey: String(index),
	};
}

describe("LocationChoiceSelect", () => {
	it("preflights and mounts one bounded page while search reaches later rows", async () => {
		const locations = Array.from({ length: 120 }, (_, index) =>
			location(index + 1),
		);
		const issueFor = vi.fn(() => undefined);
		render(
			<LocationChoiceSelect
				locations={locations}
				value=""
				onValueChange={() => undefined}
				ariaLabel="Choose a place"
				placeholder="Choose a place"
				issueFor={issueFor}
			/>,
		);

		expect(issueFor).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("combobox", { name: "Choose a place" }));
		await settleBaseUiTransitions();
		expect(issueFor).toHaveBeenCalledTimes(50);
		expect(screen.getAllByRole("option")).toHaveLength(50);
		expect(screen.queryByRole("option", { name: /Place 51/ })).toBeNull();

		fireEvent.change(screen.getByLabelText("Search choose a place"), {
			target: { value: "place-120" },
		});
		await settleBaseUiTransitions();
		expect(screen.getAllByRole("option")).toHaveLength(1);
		expect(
			screen.getByRole("option", { name: "Place 120 · place-120" }),
		).toBeDefined();
	});

	it("keeps a rejected exact match visible with its refusal reason", async () => {
		const blocked = location(1);
		render(
			<LocationChoiceSelect
				locations={[blocked]}
				value=""
				onValueChange={() => undefined}
				ariaLabel="Choose a place"
				placeholder="Choose a place"
				issueFor={() => "Outside Asha's address book."}
			/>,
		);

		fireEvent.click(screen.getByRole("combobox", { name: "Choose a place" }));
		await settleBaseUiTransitions();
		expect(screen.getByText("Outside Asha's address book.")).toBeDefined();
		const [option] = screen.getAllByRole("option");
		expect(option).toBeDefined();
		expect(option?.getAttribute("aria-disabled")).toBe("true");
	});
});
