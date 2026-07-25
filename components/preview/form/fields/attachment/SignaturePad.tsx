"use client";
import { Icon } from "@iconify/react/offline";
import tablerX from "@iconify-icons/tabler/x";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * A signature pad — the one capture a worker produces in-app rather than
 * attaching.
 *
 * Hand-rolled rather than pulling a dependency: the whole job is pointer
 * events onto a canvas plus `toBlob`, and the real runtime's own
 * implementation (`entries.js::SignatureEntry`) does no more than that.
 * Its output is a PNG, which is what `answerCanvasData` produces there
 * too.
 *
 * ## Keyboard and pointer parity
 *
 * A drawing surface cannot be operated by keyboard, so the pad is not the
 * only way to answer: `Clear` is a real button, and the surface itself is
 * reachable and describable. This is the honest limit of the interaction
 * — a signature is a physical gesture — and it matches the device, where
 * the canvas is equally pointer-only. What must NOT happen is the pad
 * silently swallowing focus with no way out, which is why it is not
 * focusable itself.
 *
 * ## What happens on a resize
 *
 * The canvas backing store is sized once per mount from its rendered box
 * and the device pixel ratio. Resizing the window mid-signature would
 * otherwise clear the bitmap; the strokes are therefore replayed from a
 * retained point list, the same approach `SignatureEntry::resizeCanvas`
 * takes.
 */
interface SignaturePadProps {
	readonly disabled: boolean;
	readonly hasAnswer: boolean;
	/** Fired once a stroke ends, with the pad's current content as a PNG. */
	readonly onDrawn: (file: File) => void;
	readonly onClear: () => void;
}

type Point = { x: number; y: number };

export function SignaturePad({
	disabled,
	hasAnswer,
	onDrawn,
	onClear,
}: SignaturePadProps) {
	const canvasRef = useRef<HTMLCanvasElement>(null);
	/** Completed strokes plus the one in progress, in CSS pixels. Retained
	 *  so a resize can replay rather than lose the signature. */
	const strokesRef = useRef<Point[][]>([]);
	const drawingRef = useRef(false);
	const [empty, setEmpty] = useState(true);

	const redraw = useCallback(() => {
		const canvas = canvasRef.current;
		const ctx = canvas?.getContext("2d");
		if (!canvas || !ctx) return;
		const ratio = window.devicePixelRatio || 1;
		const { width, height } = canvas.getBoundingClientRect();
		if (canvas.width !== Math.round(width * ratio)) {
			canvas.width = Math.round(width * ratio);
			canvas.height = Math.round(height * ratio);
		}
		ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
		ctx.clearRect(0, 0, width, height);
		ctx.lineWidth = 2;
		ctx.lineCap = "round";
		ctx.lineJoin = "round";
		// Ink, not a theme token: the PNG is data that leaves the app, so it
		// must read the same wherever it is later opened — a light-on-dark
		// signature would be invisible on a white page.
		ctx.strokeStyle = "#111111";
		for (const stroke of strokesRef.current) {
			if (stroke.length === 0) continue;
			ctx.beginPath();
			ctx.moveTo(stroke[0].x, stroke[0].y);
			for (const point of stroke.slice(1)) ctx.lineTo(point.x, point.y);
			// A single tap is a dot, not a no-op.
			if (stroke.length === 1) ctx.lineTo(stroke[0].x + 0.1, stroke[0].y);
			ctx.stroke();
		}
	}, []);

	useEffect(() => {
		redraw();
		const onResize = () => redraw();
		window.addEventListener("resize", onResize);
		return () => window.removeEventListener("resize", onResize);
	}, [redraw]);

	const pointFrom = (e: React.PointerEvent<HTMLCanvasElement>): Point => {
		const rect = e.currentTarget.getBoundingClientRect();
		return { x: e.clientX - rect.left, y: e.clientY - rect.top };
	};

	const emit = useCallback(() => {
		const canvas = canvasRef.current;
		if (!canvas) return;
		canvas.toBlob((blob) => {
			if (!blob) return;
			// The name matters only as a transport label — the server mints the
			// stored name — but it must carry a `.png` extension, which is what
			// the accepted-format check reads.
			onDrawn(new File([blob], "signature.png", { type: "image/png" }));
		}, "image/png");
	}, [onDrawn]);

	const clear = useCallback(() => {
		strokesRef.current = [];
		setEmpty(true);
		redraw();
		onClear();
	}, [redraw, onClear]);

	return (
		<div className="space-y-2">
			<canvas
				ref={canvasRef}
				aria-label="Signature pad. Sign with a finger, stylus, or mouse."
				className="h-40 w-full touch-none rounded-lg border border-pv-input-border bg-white disabled:opacity-40"
				style={disabled ? { pointerEvents: "none", opacity: 0.4 } : undefined}
				onPointerDown={(e) => {
					if (disabled) return;
					e.currentTarget.setPointerCapture(e.pointerId);
					drawingRef.current = true;
					strokesRef.current = [...strokesRef.current, [pointFrom(e)]];
					setEmpty(false);
					redraw();
				}}
				onPointerMove={(e) => {
					if (!drawingRef.current) return;
					const strokes = strokesRef.current;
					const current = strokes[strokes.length - 1];
					if (!current) return;
					current.push(pointFrom(e));
					redraw();
				}}
				onPointerUp={(e) => {
					if (!drawingRef.current) return;
					drawingRef.current = false;
					e.currentTarget.releasePointerCapture(e.pointerId);
					// One upload per stroke end, mirroring the runtime's
					// answer-on-`endStroke` behavior. Each replaces the last.
					emit();
				}}
				onPointerCancel={() => {
					drawingRef.current = false;
				}}
			/>
			<button
				type="button"
				onClick={clear}
				disabled={disabled || (empty && !hasAnswer)}
				className="inline-flex min-h-12 items-center gap-2 rounded-md border border-pv-input-border bg-pv-surface px-4 text-sm font-medium text-nova-text transition-colors hover:border-pv-input-focus disabled:opacity-40"
			>
				<Icon icon={tablerX} width="16" height="16" aria-hidden="true" />
				Clear signature
			</button>
		</div>
	);
}
