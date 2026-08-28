// @vitest-environment happy-dom

import { act, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { useBlueprintDocApi } from "@/lib/doc/hooks/useBlueprintDoc";
import {
	BlueprintDocProvider,
	type BlueprintDocStore,
} from "@/lib/doc/provider";
import { proseText } from "@/lib/domain/prose";
import { BuilderReferenceProvider } from "../BuilderReferenceProvider";

type SubscribeMutation = (listener: () => void) => () => void;

const wrapperCapture = vi.hoisted(
	() =>
		({
			subscribeMutation: undefined,
		}) as {
			subscribeMutation: SubscribeMutation | undefined;
		},
);
let storeApi: BlueprintDocStore | undefined;

vi.mock("@/lib/references/ReferenceContext", () => ({
	ReferenceProviderWrapper: ({
		subscribeMutation,
		children,
	}: {
		subscribeMutation: SubscribeMutation;
		children: ReactNode;
	}) => {
		wrapperCapture.subscribeMutation = subscribeMutation;
		return children;
	},
}));

vi.mock("@/lib/routing/hooks", () => ({
	useSelectedFormUuid: () => undefined,
}));

function CaptureStore() {
	storeApi = useBlueprintDocApi();
	return null;
}

describe("BuilderReferenceProvider cache invalidation", () => {
	it("subscribes to field paths and custom worker-information names", () => {
		render(
			<BlueprintDocProvider>
				<BuilderReferenceProvider>
					<CaptureStore />
					<span>child</span>
				</BuilderReferenceProvider>
			</BlueprintDocProvider>,
		);

		const subscribeMutation = wrapperCapture.subscribeMutation;
		expect(subscribeMutation).toBeDefined();
		expect(storeApi).toBeDefined();
		const listener = vi.fn();
		const unsubscribe = subscribeMutation?.(listener);

		act(() => {
			storeApi?.setState((state) => ({
				fieldOrder: { ...state.fieldOrder },
			}));
		});
		expect(listener).toHaveBeenCalledTimes(1);

		listener.mockClear();
		act(() => {
			storeApi?.setState((state) => ({
				userProperties: {
					...(state.userProperties ?? {}),
				},
			}));
		});
		expect(listener).toHaveBeenCalledTimes(1);

		unsubscribe?.();
	});

	it("ignores field metadata that cannot change a reference projection", () => {
		render(
			<BlueprintDocProvider>
				<BuilderReferenceProvider>
					<CaptureStore />
				</BuilderReferenceProvider>
			</BlueprintDocProvider>,
		);
		const subscribeMutation = wrapperCapture.subscribeMutation;
		const listener = vi.fn();
		const unsubscribe = subscribeMutation?.(listener);
		const uuid = testUuid("reference-invalidation-field");

		act(() => {
			storeApi?.setState((state) => ({
				fields: {
					...state.fields,
					[uuid]: {
						uuid,
						id: "name",
						kind: "text",
						label: proseText("Name"),
					},
				},
			}));
		});
		expect(listener).toHaveBeenCalledTimes(1);
		listener.mockClear();

		act(() => {
			storeApi?.setState((state) => ({
				fields: {
					...state.fields,
					[uuid]: {
						...state.fields[uuid],
						caseWrite: { caseType: "patient", property: "case_name" },
					},
				},
			}));
		});
		expect(listener).not.toHaveBeenCalled();

		act(() => {
			storeApi?.setState((state) => ({
				fields: {
					...state.fields,
					[uuid]: { ...state.fields[uuid], id: "full_name" },
				},
			}));
		});
		expect(listener).toHaveBeenCalledTimes(1);
		unsubscribe?.();
	});
});
