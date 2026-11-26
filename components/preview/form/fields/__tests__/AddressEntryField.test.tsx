// @vitest-environment happy-dom
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { proseText } from "@/lib/domain";
import type { QuestionMessage } from "@/lib/preview/displayMessages";
import { AddressEntryField } from "../AddressEntryField";

const { fetchAutocompleteSuggestions } = vi.hoisted(() => ({
	fetchAutocompleteSuggestions: vi.fn(),
}));

vi.mock("../geopoint/googleMaps", () => ({
	googleMapsConfigured: () => true,
	loadPlaces: async () => ({
		AutocompleteSuggestion: { fetchAutocompleteSuggestions },
		AutocompleteSessionToken: class {},
	}),
}));
vi.mock(
	"@/components/builder/localization/BuilderLocalizationProvider",
	() => ({
		useBuilderLanguage: () => ({ language: "en" }),
	}),
);

const SUGGESTION = "12 River Road";
const ADDRESS = "12 River Road, Riverside";

function offerPlace(fetchFields: () => Promise<void>) {
	fetchAutocompleteSuggestions.mockResolvedValue({
		suggestions: [
			{
				placePrediction: {
					placeId: "river-road",
					text: { text: SUGGESTION },
					toPlace: () => ({
						fetchFields,
						formattedAddress: ADDRESS,
						location: { lat: () => 51, lng: () => 0 },
					}),
				},
			},
		],
	});
}

function mountAddress(onChange: (value: string) => Promise<boolean>) {
	const onDisplayMessage = vi.fn((_message: QuestionMessage) =>
		Promise.resolve(),
	);
	render(
		<AddressEntryField
			field={{
				uuid: testUuid("address-lookup"),
				id: "address",
				kind: "text",
				label: proseText("Address"),
			}}
			state={{
				path: "/data/address",
				value: "",
				visible: true,
				required: false,
				valid: true,
				touched: false,
			}}
			onBlur={() => {}}
			onChange={onChange}
			onDisplayMessage={onDisplayMessage}
		/>,
	);
	return {
		input: screen.getByRole<HTMLInputElement>("combobox"),
		onDisplayMessage,
	};
}

async function chooseFromSearch(input: HTMLInputElement, search: string) {
	await act(() => {
		input.focus();
		fireEvent.input(input, {
			inputType: "insertText",
			target: { value: search },
		});
	});
	await act(() => vi.advanceTimersByTimeAsync(250));
	await act(async () => {
		fireEvent.click(screen.getByRole("option", { name: SUGGESTION }));
	});
}

beforeEach(() => {
	vi.useFakeTimers();
	fetchAutocompleteSuggestions.mockReset();
});

afterEach(async () => {
	try {
		await act(() => {
			cleanup();
		});
	} finally {
		vi.useRealTimers();
	}
});

it("keeps a new query while details from a previous choice are pending", async () => {
	const details = Promise.withResolvers<void>();
	const fetchFields = vi.fn(() => details.promise);
	const onChange = vi.fn(async () => true);
	offerPlace(fetchFields);
	const { input, onDisplayMessage } = mountAddress(onChange);
	try {
		await chooseFromSearch(input, "River");
		expect(fetchFields).toHaveBeenCalledOnce();

		await act(() => {
			fireEvent.input(input, {
				inputType: "insertText",
				target: { value: "Orchard Avenue" },
			});
		});
	} finally {
		await act(async () => {
			details.resolve();
			await details.promise;
		});
	}

	expect(input.value).toBe("Orchard Avenue");
	expect(onChange).not.toHaveBeenCalled();
	expect(onDisplayMessage).not.toHaveBeenCalled();
});

it("drops the broadcast when editing resumes before the sender acknowledges the address", async () => {
	const sender = Promise.withResolvers<boolean>();
	const onChange = vi.fn(async (_value: string) => true);
	onChange.mockImplementationOnce(() => sender.promise);
	offerPlace(() => Promise.resolve());
	const { input, onDisplayMessage } = mountAddress(onChange);
	try {
		await chooseFromSearch(input, "River");
		expect(input.value).toBe(ADDRESS);
		expect(onChange).toHaveBeenCalledOnce();
		expect(onDisplayMessage).not.toHaveBeenCalled();

		await act(() => {
			fireEvent.input(input, {
				inputType: "insertText",
				target: { value: "Orchard Avenue" },
			});
		});
		expect(onChange).toHaveBeenLastCalledWith("");
	} finally {
		await act(async () => {
			sender.resolve(true);
			await sender.promise;
		});
	}

	expect(input.value).toBe("Orchard Avenue");
	expect(onDisplayMessage).not.toHaveBeenCalled();

	await chooseFromSearch(input, "River");
	expect(input.value).toBe(ADDRESS);
	expect(onDisplayMessage).toHaveBeenCalledOnce();
	expect(onChange).toHaveBeenLastCalledWith(
		JSON.stringify(onDisplayMessage.mock.calls[0]?.[0]),
	);
});
