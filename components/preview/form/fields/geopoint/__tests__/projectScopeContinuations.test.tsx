// @vitest-environment happy-dom

import { act, fireEvent, render, screen } from "@testing-library/react";
import type { HTMLAttributes, InputHTMLAttributes, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PortaledContentDirectionProvider } from "@/components/shadcn/portaled-content-direction";
import { ReconcilerContext } from "@/lib/collab/context";
import { createProjectScopeResetRegistry } from "@/lib/collab/projectScopeReset";
import { BuilderSessionContext } from "@/lib/session/provider";
import { createBuilderSessionStore } from "@/lib/session/store";
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
			Positioner: ({
				children,
				...props
			}: HTMLAttributes<HTMLDivElement> & { children?: ReactNode }) => (
				<div data-address-search-positioner {...props}>
					{children}
				</div>
			),
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
	const session = createBuilderSessionStore({
		appId: "geopoint-app",
		projectId: "project-source",
		role: "editor",
		canEdit: true,
	});
	const value = {
		projectScopeId: "geopoint-test",
		subscribeProjectScopeReset: registry.subscribe,
		isProjectScopeCurrent: registry.isCurrent,
	} as never;
	const Wrapper = ({ children }: { children: ReactNode }) => (
		<BuilderSessionContext value={session}>
			<ReconcilerContext.Provider value={value}>
				{children}
			</ReconcilerContext.Provider>
		</BuilderSessionContext>
	);
	return { registry, session, Wrapper };
}

afterEach(() => {
	vi.useRealTimers();
	vi.clearAllMocks();
});

describe("geopoint Project-scope continuations", () => {
	it("carries the worker direction into the address-search portal", () => {
		const { Wrapper } = scopeHarness();
		render(
			<PortaledContentDirectionProvider direction="rtl">
				<AddressSearch value="" onSelect={vi.fn()} />
			</PortaledContentDirectionProvider>,
			{ wrapper: Wrapper },
		);

		expect(
			document
				.querySelector("[data-address-search-positioner]")
				?.getAttribute("dir"),
		).toBe("rtl");
	});

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

	it("re-arms geolocation after a same-Project snapshot without reviving the old request", async () => {
		const sourceLocation = deferred<{
			lat: number;
			lon: number;
			alt: number;
			accuracy: number;
		}>();
		mocks.requestGeolocation
			.mockReturnValueOnce(sourceLocation.promise)
			.mockResolvedValueOnce({
				lat: 41,
				lon: -75,
				alt: 0,
				accuracy: 3,
			});
		const onChange = vi.fn();
		const { registry, session, Wrapper } = scopeHarness();
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
		act(() => {
			session.getState().beginAccessRefresh();
			registry.reset(1);
		});
		expect(
			(
				screen.getByRole("button", {
					name: "My location",
				}) as HTMLButtonElement
			).disabled,
		).toBe(false);
		act(() => {
			session.getState().applyAccessSnapshot({
				projectId: "project-source",
				role: "editor",
				canEdit: true,
			});
		});
		await act(async () => {
			sourceLocation.resolve({ lat: 40, lon: -74, alt: 0, accuracy: 4 });
			await sourceLocation.promise;
		});
		expect(onChange).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole("button", { name: "My location" }));
		await act(async () => {
			await Promise.resolve();
		});
		expect(onChange).toHaveBeenCalledWith("41 -75 0 3");
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

	it("clears stale Places results and accepts a fresh query after same-Project authorization", async () => {
		vi.useFakeTimers();
		const suggestionFetch = vi
			.fn()
			.mockResolvedValueOnce({
				suggestions: [
					{
						placePrediction: {
							placeId: "source-place",
							text: { text: "Source result" },
						},
					},
				],
			})
			.mockResolvedValueOnce({
				suggestions: [
					{
						placePrediction: {
							placeId: "fresh-place",
							text: { text: "Fresh result" },
						},
					},
				],
			});
		mocks.loadPlaces.mockResolvedValue({
			AutocompleteSessionToken: class {},
			AutocompleteSuggestion: {
				fetchAutocompleteSuggestions: suggestionFetch,
			},
		});
		const { registry, session, Wrapper } = scopeHarness();
		render(<AddressSearch value="" onSelect={vi.fn()} />, {
			wrapper: Wrapper,
		});
		const input = screen.getByLabelText("Search for an address");
		fireEvent.change(input, { target: { value: "Source" } });
		await act(async () => {
			vi.advanceTimersByTime(250);
			await Promise.resolve();
			await Promise.resolve();
		});
		expect(screen.getByRole("button", { name: "Source result" })).toBeDefined();

		act(() => {
			session.getState().beginAccessRefresh();
			registry.reset(1);
		});
		expect(screen.queryByRole("button", { name: "Source result" })).toBeNull();
		act(() => {
			session.getState().applyAccessSnapshot({
				projectId: "project-source",
				role: "editor",
				canEdit: true,
			});
		});
		fireEvent.change(input, { target: { value: "Fresh" } });
		await act(async () => {
			vi.advanceTimersByTime(250);
			await Promise.resolve();
			await Promise.resolve();
		});

		expect(screen.getByRole("button", { name: "Fresh result" })).toBeDefined();
		expect(suggestionFetch).toHaveBeenCalledTimes(2);
	});
});
