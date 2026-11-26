// @vitest-environment happy-dom
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
} from "@testing-library/react";
import { useRef, useState } from "react";
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

function mountAddress(
	onChange: (value: string) => Promise<boolean>,
	{ publishBeforeAcknowledgement = false } = {},
) {
	const onDisplayMessage = vi.fn((_message: QuestionMessage) =>
		Promise.resolve(),
	);
	function Address() {
		const [value, setValue] = useState("");
		const latest = useRef(0);
		return (
			<AddressEntryField
				field={{
					uuid: testUuid("address-lookup"),
					id: "address",
					kind: "text",
					label: proseText("Address"),
				}}
				state={{
					path: "/data/address",
					value,
					visible: true,
					required: false,
					valid: true,
					touched: false,
				}}
				onBlur={() => {}}
				onCommit={async (next, message) => {
					const revision = ++latest.current;
					if (publishBeforeAcknowledgement) setValue(next);
					const applied = await onChange(next);
					if (
						!publishBeforeAcknowledgement &&
						applied &&
						revision === latest.current
					)
						setValue(next);
					if (applied && revision === latest.current && message !== undefined)
						await onDisplayMessage(message);
					return applied;
				}}
			/>
		);
	}
	render(<Address />);
	return {
		input: screen.getByRole<HTMLInputElement>("combobox"),
		onDisplayMessage,
	};
}

async function chooseFromSearch(input: HTMLInputElement, search: string) {
	await act(async () => {
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

		await act(async () => {
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
	const { input, onDisplayMessage } = mountAddress(onChange, {
		publishBeforeAcknowledgement: true,
	});
	try {
		await chooseFromSearch(input, "River");
		expect(input.value).toBe("River");
		expect(onChange).toHaveBeenCalledOnce();
		expect(onDisplayMessage).not.toHaveBeenCalled();

		await act(async () => {
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

it("keeps a rejected choice as a search and shows the chosen answer once accepted", async () => {
	const onChange = vi.fn(async (_value: string) => true);
	onChange.mockResolvedValueOnce(false);
	offerPlace(() => Promise.resolve());
	const { input, onDisplayMessage } = mountAddress(onChange);

	await chooseFromSearch(input, "River");
	expect(onChange).toHaveBeenCalledOnce();
	expect(input.value).toBe("River");
	expect(input.getAttribute("aria-invalid")).toBe("true");
	expect(onDisplayMessage).not.toHaveBeenCalled();

	await chooseFromSearch(input, "River Road");
	expect(input.value).toBe(ADDRESS);
	expect(input.hasAttribute("aria-invalid")).toBe(false);
	expect(onDisplayMessage).toHaveBeenCalledOnce();
});

it("keeps the recorded address when a clear is refused and sends null after a successful retry", async () => {
	const onChange = vi.fn(async (_value: string) => true);
	offerPlace(() => Promise.resolve());
	const { input, onDisplayMessage } = mountAddress(onChange);
	await chooseFromSearch(input, "River");
	onDisplayMessage.mockClear();
	onChange.mockResolvedValueOnce(false);
	const clear = screen.getByRole("button", { name: "Clear the address" });

	await act(async () => {
		fireEvent.click(clear);
	});
	expect(input.value).toBe(ADDRESS);
	expect(onDisplayMessage).not.toHaveBeenCalled();

	await act(async () => {
		fireEvent.click(clear);
	});
	expect(input.value).toBe("");
	expect(onDisplayMessage).toHaveBeenCalledExactlyOnceWith(null);
});

it("drops a delayed clear broadcast after a newer address has been chosen", async () => {
	const clearing = Promise.withResolvers<boolean>();
	const onChange = vi.fn(async (_value: string) => true);
	offerPlace(() => Promise.resolve());
	const { input, onDisplayMessage } = mountAddress(onChange);
	await chooseFromSearch(input, "River");
	onDisplayMessage.mockClear();
	onChange.mockImplementationOnce(() => clearing.promise);
	try {
		await act(async () => {
			fireEvent.click(
				screen.getByRole("button", { name: "Clear the address" }),
			);
		});
		expect(input.value).toBe(ADDRESS);

		await chooseFromSearch(input, "River Road");
		expect(input.value).toBe(ADDRESS);
		expect(onDisplayMessage).toHaveBeenCalledOnce();
		expect(onDisplayMessage).not.toHaveBeenCalledWith(null);
	} finally {
		await act(async () => {
			clearing.resolve(true);
			await clearing.promise;
		});
	}
	expect(input.value).toBe(ADDRESS);
	expect(onDisplayMessage).toHaveBeenCalledOnce();
});

it("shows the recorded address if typing cannot clear it", async () => {
	const onChange = vi.fn(async (_value: string) => true);
	offerPlace(() => Promise.resolve());
	const { input, onDisplayMessage } = mountAddress(onChange);
	await chooseFromSearch(input, "River");
	onChange.mockResolvedValueOnce(false);
	onDisplayMessage.mockClear();

	await act(async () => {
		fireEvent.input(input, {
			inputType: "insertText",
			target: { value: "Orchard" },
		});
	});
	expect(onChange).toHaveBeenLastCalledWith("");
	expect(input.value).toBe(ADDRESS);
	expect(onDisplayMessage).not.toHaveBeenCalled();
});
