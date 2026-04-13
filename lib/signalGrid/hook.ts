/**
 * useSignalGridFrame -- rAF loop hook bound to a component's lifetime.
 *
 * The callback is invoked once per frame with the delta since the previous
 * frame (clamped to 100ms to avoid long-tab-switch surprises). The loop
 * stops when the component unmounts.
 *
 * Consumers call `signalGrid.drainEnergy()` / `drainThinkEnergy()` inside
 * the callback to consume accumulated energy each frame.
 */
import { useEffect } from "react";

/** Maximum frame delta (ms) -- prevents a single massive step after a
 *  background tab returns to focus. */
const MAX_DELTA_MS = 100;

export function useSignalGridFrame(callback: (deltaMs: number) => void): void {
	useEffect(() => {
		let rafId = 0;
		let lastTs = performance.now();
		let cancelled = false;

		const tick = (ts: number) => {
			if (cancelled) return;
			const delta = Math.min(ts - lastTs, MAX_DELTA_MS);
			lastTs = ts;
			callback(delta);
			rafId = requestAnimationFrame(tick);
		};

		rafId = requestAnimationFrame(tick);
		return () => {
			cancelled = true;
			cancelAnimationFrame(rafId);
		};
	}, [callback]);
}
