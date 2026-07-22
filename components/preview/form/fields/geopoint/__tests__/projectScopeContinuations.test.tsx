// @vitest-environment happy-dom

import { act, fireEvent, render, screen } from "@testing-library/react";
import type { InputHTMLAttributes, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReconcilerContext } from "@/lib/collab/context";
import { createProjectScopeResetRegistry } from "@/lib/collab/projectScopeReset";
import { AddressSearch } from "../AddressSearch";
import { GeopointPicker } from "../GeopointPicker";

const mocks = vi.hoisted(() => ({
	requestGeolocation: vi.fn(),
	loadPlaces: vi.fn(),
	loadGeocoding: vi.fn(),
	projectToast: vi.fn(),
}));

vi.mock("../geolocation", () => ({
	GeolocationError: class GeolocationError extends Error {},
	requestGeolocation: mocks.requestGeolocation,
}));
vi.mock("../googleMaps", () => ({
	googleMapsConfigured: () => true,
	loadPlaces: mocks.loadPlaces,
	loadGeocoding: mocks.loadGeocoding,
}));
vi.mock("../useInView", () => ({ useInView: () => false }));
vi.mock("@/lib/collab/useProjectToast", () => ({
	useProjectToast: () => mocks.projectToast,
}));

/* Keep this regression about continuation ownership rather than Base UI's
 * popup mechanics. The tiny stand-in preserves Root's value-change contract
 * and makes each server-provided item clickable. */
vi.mock("@base-ui/react/autocomplete", async () => {
	const React = await import("react");
	type RootState = {
		items: Array<{ label: string }>;
		value: string;
		onValueChange: (
			value: string,
			details: { reason: "input-change" | "item-press" },
		) => void;
	};
	const Context = React.createContext<RootState | null>(null);
	const passthrough = ({ children }: { children?: ReactNode }) => children;
	return {
		Autocomplete: {
			Root: ({
				items,
				value,
				onValueChange,
				children,
			}: RootState & { children: ReactNode }) => (
				<Context.Provider value={{ items, value, onValueChange }}>
					{children}
				</Context.Provider>
			),
			InputGroup: passthrough,
			Input: (props: InputHTMLAttributes<HTMLInputElement>) => {
				const state = React.useContext(Context);
				if (!state) throw new Error("mock autocomplete input outside root");
				return (
					<input
						{...props}
						value={state.value}
						onChange={(event) =>
							state.onValueChange(event.currentTarget.value, {
								reason: "input-change",
							})
						}
					/>
				);
			},
			Portal: passthrough,
			Positioner: passthrough,
			Popup: passthrough,
			Empty: passthrough,
			List: passthrough,
			Collection: ({
				children,
			}: {
				children: (item: { label: string }) => ReactNode;
			}) => {
				const state = React.useContext(Context);
				return state?.items.map(children) ?? null;
			},
			Item: ({
				value,
				children,
			}: {
				value: { label: string };
				children: ReactNode;
			}) => {
				const state = React.useContext(Context);
				return (
					<button
						type="button"
						onClick={() =>
							state?.onValueChange(value.label, { reason: "item-press" })
						}
					>
						{children}
					</button>
				);
			},
		},
	};
});

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function scopeHarness() {
	const registry = createProjectScopeResetRegistry();
	const value = {
		projectScopeId: "geopoint-test",
		subscribeProjectScopeReset: registry.subscribe,
		isProjectScopeCurrent: registry.isCurrent,
	} as never;
	const Wrapper = ({ children }: { children: ReactNode }) => (
		<ReconcilerContext.Provider value={value}>
			{children}
		</ReconcilerContext.Provider>
	);
	return { registry, Wrapper };
}

afterEach(() => {
	vi.useRealTimers();
	vi.clearAllMocks();
});

describe("geopoint Project-scope continuations", () => {
	it("drops a held geolocation result inside the synchronous reset boundary", async () => {
		const location = deferred<{
			lat: number;
			lon: number;
			alt: number;
			accuracy: number;
		}>();
		mocks.requestGeolocation.mockReturnValue(location.promise);
		const onChange = vi.fn();
		const { registry, Wrapper } = scopeHarness();
		render(
			<GeopointPicker
				value=""
				onChange={onChange}
				onBlur={vi.fn()}
				showError={false}
			/>,
			{ wrapper: Wrapper },
		);

		fireEvent.click(screen.getByRole("button", { name: "My location" }));
		act(() => registry.reset(1));
		await act(async () => {
			location.resolve({ lat: 40, lon: -74, alt: 0, accuracy: 4 });
			await location.promise;
		});

		expect(onChange).not.toHaveBeenCalled();
		expect(mocks.projectToast).not.toHaveBeenCalled();
	});

	it("drops held Places details and remounts without source address text", async () => {
		vi.useFakeTimers();
		const fields = deferred<void>();
		const place = {
			fetchFields: vi.fn(() => fields.promise),
			location: { lat: () => 40, lng: () => -74 },
			formattedAddress: "Source project address",
		};
		const prediction = {
			placeId: "source-place",
			text: { text: "Source project address" },
			toPlace: () => place,
		};
		mocks.loadPlaces.mockResolvedValue({
			AutocompleteSessionToken: class {},
			AutocompleteSuggestion: {
				fetchAutocompleteSuggestions: vi.fn().mockResolvedValue({
					suggestions: [{ placePrediction: prediction }],
				}),
			},
		});
		const onSelect = vi.fn();
		const { registry, Wrapper } = scopeHarness();
		const view = render(
			<AddressSearch key={0} value="" onSelect={onSelect} />,
			{ wrapper: Wrapper },
		);

		fireEvent.change(screen.getByLabelText("Search for an address"), {
			target: { value: "Source" },
		});
		await act(async () => {
			vi.advanceTimersByTime(250);
			await Promise.resolve();
			await Promise.resolve();
		});
		fireEvent.click(
			screen.getByRole("button", { name: /Source project address/ }),
		);
		expect(place.fetchFields).toHaveBeenCalledTimes(1);

		act(() => {
			registry.reset(1);
			view.rerender(<AddressSearch key={1} value="" onSelect={onSelect} />);
		});
		expect(
			(screen.getByLabelText("Search for an address") as HTMLInputElement)
				.value,
		).toBe("");
		await act(async () => {
			fields.resolve();
			await fields.promise;
		});

		expect(onSelect).not.toHaveBeenCalled();
		expect(screen.queryByText("Source project address")).toBeNull();
	});
});
