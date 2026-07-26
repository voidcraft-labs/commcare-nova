"use client";
import { Icon } from "@iconify/react/offline";
import tablerArrowBackUp from "@iconify-icons/tabler/arrow-back-up";
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
	/** Whether an upload is in flight. Deliberately NOT used to disable the
	 *  drawing surface — see `SIGNATURE_SETTLE_MS`. */
	readonly uploading: boolean;
	readonly hasAnswer: boolean;
	/** Fired once the worker has stopped drawing, with the pad's whole
	 *  content as a PNG. */
	readonly onDrawn: (file: File) => void;
	readonly onClear: () => void;
}

/**
 * How long after the last stroke the pad waits before uploading.
 *
 * A signature is many strokes, not one. Uploading on every `pointerup`
 * would fire a round trip per stroke, each immediately superseded by the
 * next — and, worse, would make the pad unusable if the surface were
 * disabled while a request was in flight: the worker's pen would die
 * partway through their own name and the strokes drawn in that window
 * would be dropped by the browser. So the surface stays live at all times
 * and the upload waits for the worker to stop.
 *
 * The real runtime answers on every `endStroke`
 * (`entries.js::SignatureEntry`) and gets away with it because its canvas
 * is never disabled either; what it does not do is block drawing. Nova
 * matches the part that matters — an always-drawable pad — and sends one
 * upload instead of ten.
 */
const SIGNATURE_SETTLE_MS = 700;

type Point = { x: number; y: number };

export function SignaturePad({
	uploading,
	hasAnswer,
	onDrawn,
	onClear,
}: SignaturePadProps) {
	const canvasRef = useRef<HTMLCanvasElement>(null);
	/** Completed strokes plus the one in progress, in CSS pixels. Retained
	 *  so a resize can replay rather than lose the signature. */
	const strokesRef = useRef<Point[][]>([]);
	const drawingRef = useRef(false);
	const settleRef = useRef<ReturnType<typeof setTimeout> | undefined>(
		undefined,
	);
	/** Fences `canvas.toBlob` callbacks, which cannot themselves be aborted. */
	const renderGenerationRef = useRef(0);
	/**
	 * The strokes the last Clear removed, kept so it can be undone.
	 *
	 * This is the one destructive act in the whole attachment flow. Every
	 * other capture kind is the OS file picker, so clearing one costs a
	 * re-pick from a file still sitting on the worker's disk — and replacing
	 * one means they already went through the picker and chose something
	 * else, a deliberate act of its own. A signature has no source file:
	 * clearing it destroys the only copy that ever existed.
	 *
	 * So it gets inverse-action undo rather than a confirmation, which is
	 * what the contracts prefer for a recoverable edit. A modal in front of
	 * a gesture a worker repeats is friction; undo costs nothing until it is
	 * needed. The offer stands until they draw again — deliberately not a
	 * timed window, which would punish anyone reading slowly or arriving by
	 * keyboard.
	 */
	const clearedRef = useRef<Point[][] | undefined>(undefined);
	const [cleared, setCleared] = useState(false);
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

	// A pending settle must not outlive the pad; without this the timer
	// fires into an unmounted component after a form change.
	useEffect(
		() => () => {
			clearTimeout(settleRef.current);
			renderGenerationRef.current += 1;
		},
		[],
	);

	const pointFrom = (e: React.PointerEvent<HTMLCanvasElement>): Point => {
		const rect = e.currentTarget.getBoundingClientRect();
		return { x: e.clientX - rect.left, y: e.clientY - rect.top };
	};

	const emit = useCallback(() => {
		const canvas = canvasRef.current;
		if (!canvas) return;
		const generation = ++renderGenerationRef.current;
		canvas.toBlob((blob) => {
			if (!blob || generation !== renderGenerationRef.current) return;
			// The name matters only as a transport label — the server mints the
			// stored name — but it must carry a `.png` extension, which is what
			// the accepted-format check reads.
			onDrawn(new File([blob], "signature.png", { type: "image/png" }));
		}, "image/png");
	}, [onDrawn]);

	const clear = useCallback(() => {
		// Cancel any settle in flight: a timer that survived would re-upload
		// the strokes the worker just cleared.
		clearTimeout(settleRef.current);
		renderGenerationRef.current += 1;
		clearedRef.current =
			strokesRef.current.length > 0 ? strokesRef.current : undefined;
		setCleared(clearedRef.current !== undefined);
		strokesRef.current = [];
		setEmpty(true);
		redraw();
		onClear();
	}, [redraw, onClear]);

	const undo = useCallback(() => {
		const restored = clearedRef.current;
		if (restored === undefined) return;
		clearedRef.current = undefined;
		setCleared(false);
		strokesRef.current = restored;
		setEmpty(false);
		redraw();
		// Restoring the pixels is not enough: `onClear` discarded the staged
		// attachment, so the answer has to be re-minted from the restored
		// canvas. `emit` is the same path an ordinary stroke takes.
		emit();
	}, [redraw, emit]);

	return (
		<div className="space-y-2">
			<canvas
				ref={canvasRef}
				aria-label="Signature pad. Sign with a finger, stylus, or mouse."
				className="h-40 w-full touch-none rounded-lg border border-pv-input-border bg-white"
				onPointerDown={(e) => {
					// No disabled check: the surface stays live even while an
					// upload is in flight, so a worker can keep signing.
					clearTimeout(settleRef.current);
					// Invalidate a `toBlob` from the prior stroke set. The next
					// settled emission captures the complete, newer bitmap.
					renderGenerationRef.current += 1;
					// A new stroke supersedes the undo offer — the worker has
					// said what they want by drawing it.
					if (clearedRef.current !== undefined) {
						clearedRef.current = undefined;
						setCleared(false);
					}
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
					// Upload once the worker has stopped, not once per stroke.
					clearTimeout(settleRef.current);
					settleRef.current = setTimeout(emit, SIGNATURE_SETTLE_MS);
				}}
				onPointerCancel={() => {
					drawingRef.current = false;
				}}
			/>
			{/* The pad stays drawable while this shows — it reports progress,
			    it does not gate the surface. */}
			<div className="flex flex-wrap items-center gap-2">
				<p aria-live="polite" className="text-xs text-nova-text-muted">
					{uploading
						? "Saving signature…"
						: cleared
							? "Signature cleared."
							: hasAnswer
								? "Signature saved."
								: "Sign above."}
				</p>
				{cleared ? (
					<button
						type="button"
						onClick={undo}
						className="inline-flex min-h-12 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-nova-violet-bright transition-colors hover:text-nova-text"
					>
						<Icon
							icon={tablerArrowBackUp}
							width="14"
							height="14"
							aria-hidden="true"
						/>
						Undo
					</button>
				) : null}
			</div>
			<button
				type="button"
				onClick={clear}
				disabled={empty && !hasAnswer}
				className="inline-flex min-h-12 items-center gap-2 rounded-md border border-pv-input-border bg-pv-surface px-4 text-sm font-medium text-nova-text transition-colors hover:border-pv-input-focus disabled:opacity-40"
			>
				<Icon icon={tablerX} width="16" height="16" aria-hidden="true" />
				Clear signature
			</button>
		</div>
	);
}
