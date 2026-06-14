"use client";
import { useCallback, useEffect, useState } from "react";

/**
 * Drives the shared reject-shake on an input wrapper (the `xpath-shake`
 * utility + `shake` keyframes in `globals.css`) with the cleanup the
 * animation contract requires: state clears on `animationend` filtered by
 * keyframe name, never a JS timer — animation events bubble, so an
 * unfiltered handler would let a descendant's keyframe clear the shake
 * mid-flight.
 *
 * Spread `shakeProps` onto the element that should shake and call
 * `shake()` on each refusal; re-invoking while already shaking restarts
 * cleanly because the class is removed on the keyframe's own end event.
 */
export function useShake(): {
	shake: () => void;
	shakeProps: {
		className: string;
		onAnimationEnd: (e: React.AnimationEvent) => void;
	};
} {
	const [shaking, setShaking] = useState(false);

	const shake = useCallback(() => setShaking(true), []);
	const onAnimationEnd = useCallback((e: React.AnimationEvent) => {
		if (e.animationName === "shake") setShaking(false);
	}, []);

	return {
		shake,
		shakeProps: {
			className: shaking ? "xpath-shake" : "",
			onAnimationEnd,
		},
	};
}

/**
 * `useShake` keyed to `useCommitField`'s `rejectionNonce`: every refused
 * commit — including a repeat refusal of an unchanged draft — fires one
 * shake. The nonce starts at 0 (no refusal yet), so the mount value never
 * shakes.
 */
export function useRejectionShake(
	rejectionNonce: number,
): ReturnType<typeof useShake>["shakeProps"] {
	const { shake, shakeProps } = useShake();
	useEffect(() => {
		if (rejectionNonce > 0) shake();
	}, [rejectionNonce, shake]);
	return shakeProps;
}
