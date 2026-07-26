// @vitest-environment happy-dom

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SignaturePad } from "../SignaturePad";

const context = {
	setTransform: vi.fn(),
	clearRect: vi.fn(),
	beginPath: vi.fn(),
	moveTo: vi.fn(),
	lineTo: vi.fn(),
	stroke: vi.fn(),
	lineWidth: 0,
	lineCap: "round",
	lineJoin: "round",
	strokeStyle: "",
} as unknown as CanvasRenderingContext2D;

let blobCallbacks: BlobCallback[] = [];

beforeEach(() => {
	blobCallbacks = [];
	vi.useFakeTimers();
	vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context);
	vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(
		(callback) => {
			blobCallbacks.push(callback);
		},
	);
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

function drawOneStroke(canvas: HTMLCanvasElement, pointerId: number): void {
	Object.assign(canvas, {
		setPointerCapture: vi.fn(),
		releasePointerCapture: vi.fn(),
	});
	fireEvent.pointerDown(canvas, {
		pointerId,
		clientX: 10,
		clientY: 10,
	});
	fireEvent.pointerUp(canvas, {
		pointerId,
		clientX: 10,
		clientY: 10,
	});
	act(() => {
		vi.advanceTimersByTime(800);
	});
}

describe("SignaturePad", () => {
	it("generation-fences an older toBlob callback after a newer stroke", () => {
		const onDrawn = vi.fn();
		render(
			<SignaturePad
				uploading={false}
				hasAnswer={false}
				onDrawn={onDrawn}
				onClear={vi.fn()}
			/>,
		);
		const canvas = screen.getByLabelText(/Signature pad/) as HTMLCanvasElement;

		drawOneStroke(canvas, 1);
		expect(blobCallbacks).toHaveLength(1);
		drawOneStroke(canvas, 2);
		expect(blobCallbacks).toHaveLength(2);

		blobCallbacks[0]?.(new Blob(["old"], { type: "image/png" }));
		expect(onDrawn).not.toHaveBeenCalled();
		blobCallbacks[1]?.(new Blob(["new"], { type: "image/png" }));
		expect(onDrawn).toHaveBeenCalledTimes(1);
	});

	it("invalidates an in-flight canvas render when the signature is cleared", () => {
		const onDrawn = vi.fn();
		const onClear = vi.fn();
		render(
			<SignaturePad
				uploading={true}
				hasAnswer={false}
				onDrawn={onDrawn}
				onClear={onClear}
			/>,
		);
		const canvas = screen.getByLabelText(/Signature pad/) as HTMLCanvasElement;

		drawOneStroke(canvas, 1);
		fireEvent.click(screen.getByRole("button", { name: "Clear signature" }));
		blobCallbacks[0]?.(new Blob(["stale"], { type: "image/png" }));

		expect(onClear).toHaveBeenCalledTimes(1);
		expect(onDrawn).not.toHaveBeenCalled();
	});
});
