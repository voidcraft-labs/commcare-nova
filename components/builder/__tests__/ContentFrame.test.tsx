// @vitest-environment happy-dom

import { render } from "@testing-library/react";
import { animate, useReducedMotion } from "motion/react";
import { useCallback, useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	ContentFrame,
	ModeFlipGlideProvider,
} from "@/components/builder/ContentFrame";

const animateMock = vi.mocked(animate);
const reducedMotionMock = vi.mocked(useReducedMotion);

function Harness({
	previewing,
	leftWidth,
	rightWidth,
}: {
	readonly previewing: boolean;
	readonly leftWidth: number;
	readonly rightWidth: number;
}) {
	const rowRef = useRef<HTMLDivElement>(null);
	const setRow = useCallback((node: HTMLDivElement | null) => {
		rowRef.current = node;
		if (node !== null) {
			Object.defineProperty(node, "clientWidth", {
				configurable: true,
				value: 1_200,
			});
		}
	}, []);

	return (
		<div ref={setRow}>
			<ModeFlipGlideProvider
				previewing={previewing}
				leftWidth={leftWidth}
				rightWidth={rightWidth}
				rowRef={rowRef}
			>
				<ContentFrame width="3xl">Frame</ContentFrame>
			</ModeFlipGlideProvider>
		</div>
	);
}

describe("ContentFrame reduced motion", () => {
	beforeEach(() => {
		animateMock.mockClear();
		reducedMotionMock.mockReturnValue(false);
	});

	afterEach(() => reducedMotionMock.mockReturnValue(false));

	it("glides to the new layout when motion is allowed", () => {
		const view = render(
			<Harness previewing={false} leftWidth={300} rightWidth={360} />,
		);

		view.rerender(<Harness previewing leftWidth={0} rightWidth={0} />);

		expect(animateMock).toHaveBeenCalledOnce();
	});

	it("settles immediately without a glide when reduced motion is requested", () => {
		reducedMotionMock.mockReturnValue(true);
		const view = render(
			<Harness previewing={false} leftWidth={300} rightWidth={360} />,
		);

		view.rerender(<Harness previewing leftWidth={0} rightWidth={0} />);

		expect(animateMock).not.toHaveBeenCalled();
	});

	it("stops an active glide when reduced motion is enabled", () => {
		const view = render(
			<Harness previewing={false} leftWidth={300} rightWidth={360} />,
		);

		view.rerender(<Harness previewing leftWidth={0} rightWidth={0} />);
		const controls = animateMock.mock.results[0]?.value as
			| { stop: ReturnType<typeof vi.fn> }
			| undefined;
		expect(controls).toBeDefined();

		reducedMotionMock.mockReturnValue(true);
		view.rerender(<Harness previewing leftWidth={0} rightWidth={0} />);

		expect(controls?.stop).toHaveBeenCalledOnce();
	});
});
