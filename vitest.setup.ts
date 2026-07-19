/**
 * Global test setup — runs once per test file, before the tests themselves.
 *
 * Responsibility: intercept the structured logger at the module boundary so
 * passing tests never print to stderr. Production code emits diagnostic
 * warnings and errors through `@/lib/logger` — replaying those emissions
 * during a green run adds noise that drowns real failure output. Mocking
 * the module here replaces every log method with a `vi.fn()` stub, so:
 *
 *   - Tests that don't care about logging see nothing.
 *   - Tests that DO care import `log` from `@/lib/logger` and assert on
 *     `expect(log.warn).toHaveBeenCalledWith(...)` directly — the stubs
 *     preserve full call-tracking semantics.
 *
 * `clearMocks: true` in `vitest.config.ts` wipes each stub's call history
 * between tests so one test's assertions can't leak into another's.
 */
import {
	type ComponentType,
	createElement,
	Fragment,
	forwardRef,
	type HTMLAttributes,
	type ReactElement,
	type ReactNode,
	useRef,
} from "react";
import { vi } from "vitest";

vi.mock("@/lib/logger", () => ({
	log: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		critical: vi.fn(),
	},
}));

/**
 * Global stub for `@sentry/nextjs`, mirroring the logger mock above:
 * replace one module at the boundary for the whole suite rather than
 * per-test.
 *
 * WHY this is mocked globally and not per-test:
 *
 *   Importing the real `@sentry/nextjs` server entry runs
 *   `prepareSafeIdGeneratorContext()` at module init, which calls
 *   `AsyncLocalStorage.snapshot()` and caches the returned context-bound
 *   function on a global symbol for the process lifetime. Under
 *   `vitest --detect-async-leaks` that snapshot is flagged as an
 *   async-resource leak, attributed to whichever test file first pulled
 *   Sentry into its import graph (via `@/lib/auth-utils`, `@/lib/logger`,
 *   the MCP dispatch path, …). It is a benign one-time SDK init, not a
 *   per-test leak, but the gate fails on any leak — same class of problem
 *   the `motion/react` mock below solves.
 *
 * FAITHFULNESS: error reporting is a fire-and-forget side effect that no
 * test asserts on; production Sentry (the `sentry.*.config.ts` /
 * `instrumentation*.ts` hooks) is untouched, since those load via Next.js,
 * not the test import graph. The stub provides exactly the namespace
 * methods the app calls (`captureException`, `captureMessage`, `setTag`,
 * `setUser`) as `vi.fn()`s; any other export resolves to `undefined` at the
 * import site — a loud failure rather than silent wrong behavior — so this
 * list tracks real usage rather than being defensively exhaustive.
 */
vi.mock("@sentry/nextjs", () => ({
	captureException: vi.fn(),
	captureMessage: vi.fn(),
	setTag: vi.fn(),
	setUser: vi.fn(),
}));

/**
 * Global stub for `motion/react` (framer-motion), mirroring the logger
 * mock above: replace one module at the boundary for the whole suite
 * rather than per-test.
 *
 * WHY this is mocked globally and not per-test:
 *
 *   A live `motion.*` component mounts framer-motion's `ProjectionNode`,
 *   whose frame loop perpetually reschedules `requestAnimationFrame`.
 *   Under happy-dom (which backs rAF with `setImmediate`) that loop never
 *   settles, so a render test that mounts any `motion.*` element never
 *   reaches a quiescent state. Under `vitest --detectAsyncLeaks` the
 *   un-drained frame loop is flagged as an async-resource leak; worse, a
 *   single such file run under the flag HANGS the worker forever because
 *   the reporter waits for the loop to drain. Animation is never the
 *   contract under test — the render tests assert DOM shape, dispatched
 *   mutations, and navigation intents. Killing the animation engine at
 *   the module boundary lets every test render the real component logic
 *   and DOM while emitting zero frames.
 *
 * FAITHFULNESS: this is a passthrough, not a behavioral change. A
 * `motion.div` renders a `<div>` carrying exactly the DOM-relevant props
 * (children, className, style, id, role, event handlers, `data-*` /
 * `aria-*`, etc.) with the `ref` forwarded. Only the framer-motion-only
 * animation directives are dropped — keeping them would make React warn
 * about unknown DOM attributes. `AnimatePresence` renders its children
 * directly (no enter/exit choreography). The visible DOM is identical to
 * production minus the in-flight animated style interpolation, so no
 * assertion that inspects rendered structure changes outcome.
 *
 * The only RUNTIME imports the app pulls from `motion/react` are the
 * `motion` proxy, `AnimatePresence`, `useMotionValue`, `useReducedMotion`, and `animate`, so
 * those are the exports the mock provides; `HTMLMotionProps` is type-only
 * (erased at compile time). If a new runtime export is imported without a
 * matching stub added here, it resolves to `undefined` at the import
 * site — a loud, immediate failure rather than a silent wrong-behavior,
 * so this list need not be defensively exhaustive.
 */

/**
 * framer-motion-only props that must be stripped before forwarding to the
 * intrinsic element. React warns ("React does not recognize the `X` prop
 * on a DOM element") for any non-standard attribute that reaches a host
 * node, so every animation directive the app actually passes to a
 * `motion.*` element is filtered here. Kept as an explicit Set (rather
 * than a prefix heuristic) so the strip list is auditable against real
 * usage — extend it if a new directive shows up in `<motion.* ...>`.
 */
const FRAMER_ONLY_PROPS: ReadonlySet<string> = new Set([
	// Animation targets + timing.
	"initial",
	"animate",
	"exit",
	"transition",
	"variants",
	"custom",
	// Gesture-driven animation targets.
	"whileHover",
	"whileTap",
	"whileFocus",
	"whileInView",
	"whileDrag",
	// Drag configuration.
	"drag",
	"dragConstraints",
	"dragElastic",
	"dragMomentum",
	// Layout animation directives.
	"layout",
	"layoutId",
	"layoutScroll",
	"layoutDependency",
	// Animation lifecycle callbacks (framer signatures, not DOM events).
	"onAnimationStart",
	"onAnimationComplete",
	"onUpdate",
	// Transform + viewport configuration.
	"transformTemplate",
	"viewport",
]);

/**
 * Build a `forwardRef` stand-in for `motion.<tag>` that renders the bare
 * intrinsic `<tag>`, forwards the ref, and spreads every prop EXCEPT the
 * framer-only directives. `forwardRef` matches the codebase's own
 * components (e.g. `components/shadcn/button.tsx`), so the stub composes
 * through Base UI's render-prop ref-merging exactly as the real `motion`
 * component does. The ref type is the generic `Element` because a single
 * factory backs every tag (`div`, `span`, `button`, `tr`, …) and the
 * precise element type is irrelevant to the tests.
 */
function createMotionComponent(
	tag: string,
): ComponentType<HTMLAttributes<Element>> {
	const Component = forwardRef<Element, HTMLAttributes<Element>>(
		(props, ref): ReactElement => {
			const domProps: Record<string, unknown> = {};
			for (const key in props) {
				if (FRAMER_ONLY_PROPS.has(key)) continue;
				domProps[key] = (props as Record<string, unknown>)[key];
			}
			return createElement(tag, { ...domProps, ref });
		},
	);
	Component.displayName = `motion.${tag}`;
	return Component as ComponentType<HTMLAttributes<Element>>;
}

vi.mock("motion/react", () => {
	// Cache one component per tag so repeated `motion.div` accesses return
	// a stable component identity (React treats a fresh component type as a
	// different element and would remount on every render otherwise).
	const tagCache = new Map<string, ComponentType<HTMLAttributes<Element>>>();

	const motion = new Proxy(
		{},
		{
			get(_target, prop): unknown {
				// React + bundlers probe modules with symbol/internal keys
				// (`$$typeof`, `Symbol.toPrimitive`, the thenable `then` check).
				// Only string tag names map to components; everything else is
				// undefined so those probes resolve as "not a component".
				if (typeof prop !== "string") return undefined;
				const cached = tagCache.get(prop);
				if (cached) return cached;
				const component = createMotionComponent(prop);
				tagCache.set(prop, component);
				return component;
			},
		},
	);

	/**
	 * `AnimatePresence` exists only to choreograph enter/exit animations;
	 * with the engine stubbed it is a transparent wrapper that renders its
	 * children directly. The animation-config props (`mode`, `initial`,
	 * `onExitComplete`, …) are accepted and ignored.
	 */
	function AnimatePresence({
		children,
	}: {
		children?: ReactNode;
	}): ReactElement {
		return createElement(Fragment, null, children);
	}

	/**
	 * Value-holding stand-in for `useMotionValue` (used by ContentFrame's
	 * mode-flip glide): `get`/`set` round-trip a real value so component
	 * logic that accumulates onto it behaves; nothing ever animates.
	 * Identity is stable per component instance, matching the real hook.
	 */
	interface MotionValueStub {
		get: () => unknown;
		set: (v: unknown) => void;
		stop: () => void;
		on: () => () => void;
	}
	function useMotionValue(initial: unknown): MotionValueStub {
		const ref = useRef<MotionValueStub | null>(null);
		if (!ref.current) {
			let current = initial;
			ref.current = {
				get: () => current,
				set: (v: unknown) => {
					current = v;
				},
				stop: () => {},
				on: () => () => {},
			};
		}
		return ref.current;
	}

	/** Animation driver stub — resolves nothing, animates nothing. */
	const animate = vi.fn(() => ({ stop: vi.fn() }));
	/** Tests opt into reduced motion explicitly when that behavior is relevant. */
	const useReducedMotion = vi.fn(() => false);

	return {
		motion,
		AnimatePresence,
		useMotionValue,
		useReducedMotion,
		animate,
	};
});
