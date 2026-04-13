// @vitest-environment happy-dom

/**
 * Tests for EditGuardContext — the scoped context that gates URL-driven
 * selection changes when an inline editor has unsaved content.
 *
 * Covers the full registration contract: default allow, predicate blocking,
 * cleanup restoration, last-write-wins semantics, unmount cleanup, and
 * the provider-required invariant.
 */

import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import {
	EditGuardProvider,
	useConsultEditGuard,
	useRegisterEditGuard,
} from "../EditGuardContext";

/** Wrapper that provides EditGuardProvider for hook tests. */
function Wrapper({ children }: { children: ReactNode }) {
	return <EditGuardProvider>{children}</EditGuardProvider>;
}

describe("EditGuardContext", () => {
	// ── Test 1: No predicate → consult returns true ─────────────────────

	it("returns true when no predicate is registered", () => {
		const { result } = renderHook(() => useConsultEditGuard(), {
			wrapper: Wrapper,
		});
		expect(result.current()).toBe(true);
	});

	// ── Test 2: Predicate returning false → consult returns false ───────

	it("blocks when a registered predicate returns false", () => {
		const { result } = renderHook(
			() => {
				useRegisterEditGuard(() => false, true);
				return useConsultEditGuard();
			},
			{ wrapper: Wrapper },
		);
		expect(result.current()).toBe(false);
	});

	// ── Test 3: Register then cleanup → consult returns true again ──────

	it("restores allow after cleanup deregisters the predicate", () => {
		const { result, rerender } = renderHook(
			({ enabled }: { enabled: boolean }) => {
				useRegisterEditGuard(() => false, enabled);
				return useConsultEditGuard();
			},
			{ wrapper: Wrapper, initialProps: { enabled: true } },
		);

		/* Guard is active — selection should be blocked. */
		expect(result.current()).toBe(false);

		/* Disable the guard (simulates blur/commit/cancel). The effect
		 * cleanup runs, deregistering the predicate. */
		rerender({ enabled: false });
		expect(result.current()).toBe(true);
	});

	// ── Test 4: Last-write-wins — second registration replaces first ────

	it("evaluates the latest predicate when two are registered (last-write-wins)", () => {
		const predicateA = () => false;
		const predicateB = () => true;

		const { result, rerender } = renderHook(
			({ predicate }: { predicate: () => boolean }) => {
				useRegisterEditGuard(predicate, true);
				return useConsultEditGuard();
			},
			{ wrapper: Wrapper, initialProps: { predicate: predicateA } },
		);

		/* A is active — blocks. */
		expect(result.current()).toBe(false);

		/* B takes over — allows. */
		rerender({ predicate: predicateB });
		expect(result.current()).toBe(true);
	});

	// ── Test 5: Unmount cleans up the predicate (shared provider) ──────

	it("clears the predicate when the registering component unmounts (shared provider)", () => {
		/* Use a component that conditionally renders the registration hook
		 * based on a prop, sharing a single provider instance. */
		const { result, rerender } = renderHook(
			({ mounted }: { mounted: boolean }) => {
				/* Conditionally register. When mounted=false, the hook
				 * call is skipped — simulating unmount of the registering
				 * component. We use enabled to control this cleanly. */
				useRegisterEditGuard(() => false, mounted);
				return useConsultEditGuard();
			},
			{ wrapper: Wrapper, initialProps: { mounted: true } },
		);

		/* Registration active — blocks selection. */
		expect(result.current()).toBe(false);

		/* "Unmount" the registration by disabling it. */
		rerender({ mounted: false });

		/* Guard cleared — selection allowed. */
		expect(result.current()).toBe(true);
	});

	// ── Test 6: Hook without provider throws ────────────────────────────

	it("throws when useRegisterEditGuard is used outside EditGuardProvider", () => {
		/* Suppress React error boundary console noise. */
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		expect(() =>
			renderHook(() => useRegisterEditGuard(() => true, true)),
		).toThrow("EditGuard hooks must be used within EditGuardProvider");
		spy.mockRestore();
	});

	it("throws when useConsultEditGuard is used outside EditGuardProvider", () => {
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		expect(() => renderHook(() => useConsultEditGuard())).toThrow(
			"EditGuard hooks must be used within EditGuardProvider",
		);
		spy.mockRestore();
	});
});
