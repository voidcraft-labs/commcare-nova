import {
	applyPlacement,
	type Board,
	createEmptyBoard,
	fillCount,
	fillFront,
	generateTilingPlan,
	isBoardFull,
	type Placement,
	type Shape,
	type TilingPlan,
} from "./tetrisProgressSolver";

// ── Color constants (pre-computed RGB for interpolation) ──────────────

const VIOLET = [139, 92, 246] as const; // #8b5cf6
const CYAN = [6, 182, 212] as const; // #06b6d4
const PINK = [255, 105, 140] as const; // bubblegum pink (building sweep)
const WHITE = [232, 232, 255] as const; // #e8e8ff (nova-text)
const AMBER = [245, 158, 11] as const; // #f59e0b (--nova-amber)
const ROSE = [244, 63, 94] as const; // #f43f5e (--nova-rose)
const EMERALD = [16, 185, 129] as const; // #10b981 (--nova-emerald)

function lerp(a: number, b: number, t: number): number {
	return a + (b - a) * t;
}

function cellColor(brightness: number, hue: number): string {
	// hue: 0 = violet, 1 = cyan, <0 = violet→pink (building sweep).
	//       >1 = warm error tones: 1–1.5 = violet→amber, 1.5–2.0 = amber→rose.
	//       3.0–4.0 = cyan→emerald (scaffolding fill / done celebration).
	// Negative hues decay back through violet on the way to cyan — all cool tones.
	let r: number, g: number, b: number;
	if (hue >= 3.0) {
		const t = Math.min(hue - 3.0, 1);
		r = lerp(CYAN[0], EMERALD[0], t);
		g = lerp(CYAN[1], EMERALD[1], t);
		b = lerp(CYAN[2], EMERALD[2], t);
	} else if (hue > 1) {
		// Warm error tones
		if (hue <= 1.5) {
			const t = (hue - 1) * 2;
			r = lerp(VIOLET[0], AMBER[0], t);
			g = lerp(VIOLET[1], AMBER[1], t);
			b = lerp(VIOLET[2], AMBER[2], t);
		} else {
			const t = Math.min((hue - 1.5) * 2, 1);
			r = lerp(AMBER[0], ROSE[0], t);
			g = lerp(AMBER[1], ROSE[1], t);
			b = lerp(AMBER[2], ROSE[2], t);
		}
	} else if (hue < 0) {
		const t = Math.min(-hue, 1);
		r = lerp(VIOLET[0], PINK[0], t);
		g = lerp(VIOLET[1], PINK[1], t);
		b = lerp(VIOLET[2], PINK[2], t);
	} else {
		r = lerp(VIOLET[0], CYAN[0], Math.min(hue, 1));
		g = lerp(VIOLET[1], CYAN[1], Math.min(hue, 1));
		b = lerp(VIOLET[2], CYAN[2], Math.min(hue, 1));
	}

	if (brightness > 0.55) {
		const whiteT = (brightness - 0.55) / 0.45;
		return `rgb(${lerp(r, WHITE[0], whiteT)},${lerp(g, WHITE[1], whiteT)},${lerp(b, WHITE[2], whiteT)})`;
	}
	return `rgb(${r},${g},${b})`;
}

// ── Controller ───────────────────────────────────────────────────────

export type SignalMode =
	| "sending"
	| "reasoning"
	| "scaffolding"
	| "building"
	| "editing"
	| "error-recovering"
	| "error-fatal"
	| "done"
	| "idle";

/** Default label for each mode. Callers can override with a more specific label. */
export function defaultLabel(mode: SignalMode): string {
	switch (mode) {
		case "sending":
			return "Transmitting";
		case "reasoning":
			return "Thinking";
		case "scaffolding":
			return "Designing";
		case "building":
			return "Building";
		case "editing":
			return "Editing";
		case "error-recovering":
			return "Recovering";
		case "error-fatal":
			return "Error";
		case "done":
			return "Complete";
		case "idle":
			return "";
	}
}

/** Normalized zone (0-1) within the grid for editing focus. */
export interface EditFocus {
	/** Start of active zone, 0-1 inclusive. */
	start: number;
	/** End of active zone, 0-1 inclusive. */
	end: number;
}

/** Configuration for the shared think + ambient neural firing layer.
 *  Each mode passes different values to tune the visual character of its
 *  background neural activity (e.g. scaffolding uses reduced intensity
 *  so the tetris pieces remain visually dominant). */
interface ThinkLayerOpts {
	/** Max fraction of cells that can fire per frame (default 0.45). */
	maxFires?: number;
	/** DR multiplier for visual response speed (default 1.0). */
	drScale?: number;
	/** Ambient base count multiplier — higher = denser ambient hum (default 3). */
	ambientIntensity?: number;
	/** Probability of warm amber/rose error hues instead of cool tones (0 = none, default 0). */
	warmProb?: number;
}

/** Configuration for the shared backplate — the background neural activity layer
 *  that multiple modes render underneath their foreground animations.
 *
 *  The backplate encapsulates: sending fade → think layer → hue drift → decay.
 *  Reasoning and error-recovering use it as their entire visual. Scaffolding,
 *  building, and editing layer their foreground (pieces, sweep, defrag) on top. */
interface BackplateOpts {
	/** ThinkLayer tuning (fire density, response speed, warm hue probability). */
	think?: ThinkLayerOpts;
	/** Target hue for active cells (B > 0.05) to drift toward. Default 1.0 (cyan).
	 *  Values >1 drift toward warm tones (e.g. 1.3 for amber). */
	hueDriftTarget?: number;
	/** Hue drift speed per second. Default 0.4. Set to 0 to disable drift. */
	hueDriftRate?: number;
	/** Brightness decay rate per second. Default 0.7. */
	decayRate?: number;
	/** Skip decay for cells where the predicate returns false.
	 *  Used by scaffolding to preserve filled board cells at locked brightness. */
	decayFilter?: (row: number, col: number) => boolean;
}

/** Mutable accumulators owned by each mode and passed to tickBackplate.
 *  Each mode that uses the backplate has its own instance so state doesn't
 *  bleed across mode transitions. Includes the sending fade timer which
 *  drains the violet glow uniformly regardless of which mode follows. */
interface BackplateState {
	accum: number;
	ambientTimer: number;
	sendingFade: number;
}

/** Shared backplate opts for modes with fast-decaying foreground animations (building, editing).
 *  Faster decay (1.2 vs 0.7) keeps the sweep/defrag visually dominant. No hue drift so
 *  the foreground's bubblegum pink doesn't get pulled toward cyan. */
const FOREGROUND_BACKPLATE_OPTS: BackplateOpts = {
	decayRate: 1.2,
	hueDriftRate: 0,
};

/** Minimum zone width as a fraction of total columns (prevents tiny slivers). */
const _MIN_EDIT_ZONE = 0.15;
/** How fast the current zone lerps toward the target zone (per second). */
const EDIT_ZONE_LERP_SPEED = 3.0;
/** One defrag op at a time — a single 2-column bar, just like building's sweep. */
const MAX_DEFRAG_OPS = 1;

enum DefragPhase {
	Seek,
	Select,
	Crawl,
	Place,
}

/** A tracked defrag operation — a vertical bar that selects, crawls, and places. */
interface DefragOp {
	srcCol: number;
	dstCol: number;
	/** Current fractional column position (animates during crawl and seek). */
	pos: number;
	phase: DefragPhase;
	/** Time spent in the current phase. */
	timer: number;
	/** Crawl speed in columns per second (randomized per op for organic feel). */
	speed: number;
	/** Seek: columns to jitter through before landing on srcCol. */
	seekStops: number[];
	seekIdx: number;
}

// ── Scaffolding (solver-driven tetris progress bar) ────────────────────

enum ScaffoldAnimPhase {
	Preview,
	Select,
	Slide,
	Lock,
}

/** A preview candidate: shape + row, ready to render. */
interface ScaffoldPreview {
	shape: Shape;
	originRow: number;
}

interface ScaffoldAnim {
	/** Solver's optimal placement for this turn. */
	optimal: Placement;
	/** Pre-resolved shapes (random piece × random rotation) for the slot-machine preview.
	 *  Last entry is always the winner in its solver-chosen rotation. */
	previews: ScaffoldPreview[];
	previewIdx: number;
	/** Column where preview/select renders (right of fill front). */
	previewCol: number;
	/** Current column position during slide (float for smooth animation). */
	slidePos: number;
	phase: ScaffoldAnimPhase;
	timer: number;
	/** Animation speed multiplier (scales with gap size, fast during completion). */
	speed: number;
}

/** Global scaffold animation tempo — scales all phase durations, DR, and decay.
 *  1.0 = original design pace. Per-piece `speed` multiplies on top.
 *  At 1.5, each piece takes ~1-1.5s at normal speed — fast enough to feel
 *  like progress but slow enough to see the preview→select→slide→lock sequence. */
const SCAFFOLD_TEMPO = 1.5;

// Phase base durations (seconds at TEMPO=1, before per-piece speed scaling).
// Actual duration = base / (SCAFFOLD_TEMPO * speed).
const S_PREVIEW = 0.4; // per candidate dwell
const S_SELECT = 0.13; // double-flash (snappier than other phases)
const S_SLIDE_K = 2.5; // slide cols/sec = max(distance * S_SLIDE_K, 6) * tempo * speed
const S_LOCK = 0.25; // flash + fade
const S_DECAY = 1.2; // TB drain per second (scaled by tempo)

interface ControllerOpts {
	/** Read and reset accumulated burst energy (data parts). Called once per animation frame. */
	consumeEnergy: () => number;
	/** Read and reset accumulated think energy (token generation). Called once per animation frame. */
	consumeThinkEnergy: () => number;
	/** Read current scaffold progress (0-1) from builder. Called each frame during scaffolding. */
	consumeScaffoldProgress?: () => number;
}

/** Reference frame delta for fps-independent scaling. All per-frame caps and
 *  probability thresholds are tuned for 60fps — when running at lower fps
 *  (e.g. 10fps headless), these are scaled by `dt / REFERENCE_DT` so the
 *  same amount of work happens per second regardless of frame rate. */
const REFERENCE_DT = 1 / 60;

const ROWS = 3;
/** Target duration (seconds) for one full sending wave cycle, regardless of grid width. */
export const SEND_WAVE_DURATION = 3.5;
const CELL_SIZE = 6; // px
const CELL_GAP = 3; // px
const CELL_SLOT = CELL_SIZE + CELL_GAP;

// ── Per-cell state layout ──────────────────────────────────────────
// Cells are stored in a flat Float64Array with STRIDE fields per cell.
// Mode tick methods write to TB/TH (targets); interpolateCells() blends
// B/H toward those targets each frame at the rate specified by DR.
// This target→interpolate architecture gives smooth visual transitions
// even when modes write discontinuous target values.
const STRIDE = 6;
const B = 0; // brightness (current interpolated value)
const H = 1; // hue (current interpolated value, 0=violet 1=cyan)
const TB = 2; // target brightness (set by mode tick methods)
const TH = 3; // target hue (set by mode tick methods)
const DR = 4; // decay/interpolation rate (higher = faster tracking, per second)
const YO = 5; // vertical offset in px (for lifted/dropped effects)

/**
 * Imperative animation controller for the signal grid LED panel.
 *
 * Manages a flat Float64Array of per-cell state (brightness, hue, targets,
 * decay rates, vertical offsets) and drives all animations through a single
 * requestAnimationFrame loop. Each animation mode has its own tick method
 * that writes target values; a shared interpolation pass smoothly blends
 * current values toward targets each frame.
 *
 * Long-lived singleton created at module scope — survives sidebar close/reopen
 * cycles. Attached to a DOM container via `attach()`, and mode-switched via
 * `setMode()`. Two energy channels (burst + think) are consumed each frame
 * from the builder to drive animation intensity.
 *
 * The animation loop runs continuously once started, even while detached from
 * the DOM. This keeps phase timers, energy consumption, and mode transitions
 * advancing in real time. Only the DOM render pass is skipped when detached,
 * so reattaching shows the true current state — no replay of entry animations.
 *
 * Imperative for performance: 60fps across hundreds of cells with no React
 * re-renders in the animation loop — all DOM updates are direct style writes.
 */
export class SignalGridController {
	private cells = new Float64Array(0);
	private cellCount = 0;
	private cols = 0;
	private elements: HTMLDivElement[] = [];
	private container: HTMLDivElement | null = null;

	private rafId = 0;
	/** True when the tick loop is running via setTimeout (headless) instead of rAF. */
	private headless = false;
	/** Seconds of headless ticking with no energy input. After a threshold the
	 *  loop self-terminates to avoid permanent CPU drain on page navigation. */
	private headlessIdleTime = 0;
	private lastTime = 0;
	private mode: SignalMode = "idle";
	private prevMode: SignalMode = "idle";

	// Mode transition queue — modes with minimum animation times defer the next mode
	private pendingMode: SignalMode | null = null;
	private pendingLabel = "";
	private currentLabel = "";
	private settledCallbacks: (() => void)[] = [];
	private modeAppliedCallback:
		| ((mode: SignalMode, label: string) => void)
		| null = null;

	private consumeEnergy: () => number;
	private consumeThinkEnergy: () => number;
	private consumeScaffoldProgress: (() => number) | null;

	// Sending
	private wavePhase = 0;

	// Backplate state — per-mode accumulators for the shared neural activity layer.
	// Each mode gets its own instance so state resets cleanly on mode transitions.
	// Error-recovering shares reasoningBP since they use the same fields.
	private reasoningBP: BackplateState = {
		accum: 0,
		ambientTimer: 0,
		sendingFade: 0,
	};
	private scaffoldBP: BackplateState = {
		accum: 0,
		ambientTimer: 0,
		sendingFade: 0,
	};
	private buildBP: BackplateState = {
		accum: 0,
		ambientTimer: 0,
		sendingFade: 0,
	};
	private editBP: BackplateState = {
		accum: 0,
		ambientTimer: 0,
		sendingFade: 0,
	};

	// Building
	private sweepPhase = 0;

	// Scaffolding (pre-computed tiling plan)
	/** Stable backplate opts for scaffolding — allocated once, never mutated.
	 *  The decayFilter is a bound method that reads this.scaffoldBoard directly. */
	private readonly scaffoldBackplateOpts: BackplateOpts = {
		think: {
			maxFires: 0.25,
			drScale: SCAFFOLD_TEMPO * 0.5,
			ambientIntensity: 1.5,
		},
		decayRate: S_DECAY * SCAFFOLD_TEMPO,
		hueDriftRate: 0,
		decayFilter: (r: number, c: number) => !this.scaffoldBoard?.[r][c],
	};
	private scaffoldBoard: Board | null = null;
	private scaffoldPlan: TilingPlan = [];
	private scaffoldPlanIdx = 0;
	private scaffoldTarget = 0;
	private scaffoldAnim: ScaffoldAnim | null = null;
	private scaffoldBreathPhase = 0;

	// Editing (defrag)
	private editTarget: EditFocus = { start: 0, end: 1 };
	private editCurrent: EditFocus = { start: 0, end: 1 };
	private editOps: DefragOp[] = [];

	// Error fatal
	private fatalTimer = 0;
	private fatalFlickerTimer = 0;

	// Idle — accumulator-based twinkle timing (fps-independent)
	private idleTimer = 0;
	private nextIdleTwinkle = 0.5 + Math.random() * 1.5;

	// Done (celebration + resting pulse)
	private doneTimer = 0;
	private doneCellPhases = new Float64Array(0);

	// Power state
	private powerState: "off" | "powering-on" | "on" | "powering-off" = "off";
	private powerProgress = 0; // 0..1
	private powerTimers: number[] = []; // per-cell delay for cascade

	constructor(opts: ControllerOpts) {
		this.consumeEnergy = opts.consumeEnergy;
		this.consumeThinkEnergy = opts.consumeThinkEnergy;
		this.consumeScaffoldProgress = opts.consumeScaffoldProgress ?? null;
	}

	/** The currently active mode — read by React on remount to sync panel state. */
	get currentMode(): SignalMode {
		return this.mode;
	}

	/** The currently active label — read by React on remount to sync panel state. */
	get currentModeLabel(): string {
		return this.currentLabel;
	}

	// ── Lifecycle ────────────────────────────────────────────────────────

	/** Cancel whichever timer type (rAF or setTimeout) is currently active. */
	private cancelTick(): void {
		if (!this.rafId) return;
		if (this.headless) window.clearTimeout(this.rafId);
		else cancelAnimationFrame(this.rafId);
		this.rafId = 0;
		this.headless = false;
	}

	/** Bind (or rebind) the controller to a DOM container. Rebuilds DOM cells
	 *  from the current cell state and starts the rAF loop if not already running.
	 *  If running headless (setTimeout at ~10fps), upgrades to rAF for smooth rendering.
	 *  Safe to call repeatedly — reattaching after detach resumes rendering
	 *  without replaying any entry animation. */
	attach(container: HTMLDivElement): void {
		this.container = container;
		this.rebuildGrid();
		if (!this.rafId) {
			// First attach or after destroy — start the loop
			this.lastTime = performance.now();
			this.rafId = requestAnimationFrame(this.tick);
		} else if (this.headless) {
			// Upgrade from headless setTimeout to full-speed rAF
			this.cancelTick();
			this.lastTime = performance.now();
			this.rafId = requestAnimationFrame(this.tick);
		}
	}

	/** Disconnect from the DOM. The animation loop continues headless at ~10fps
	 *  via setTimeout — phase timers, energy drain, and mode transitions keep
	 *  advancing so the next `attach()` shows the true current state. */
	detach(): void {
		this.elements = [];
		this.container = null;
		// The next tick will detect no elements and switch to setTimeout automatically
	}

	/** Full teardown — stops the animation loop entirely. Use only when the
	 *  controller is being permanently discarded (e.g. page navigation). */
	destroy(): void {
		this.cancelTick();
		this.elements = [];
		this.container = null;
	}

	resize(): void {
		if (!this.container) return;
		const newCols = Math.max(
			1,
			Math.floor((this.contentWidth() + CELL_GAP) / CELL_SLOT),
		);
		if (newCols === this.cols) return;
		this.rebuildGrid();
	}

	private contentWidth(): number {
		if (!this.container) return 0;
		const style = getComputedStyle(this.container);
		return (
			this.container.clientWidth -
			parseFloat(style.paddingLeft) -
			parseFloat(style.paddingRight)
		);
	}

	private rebuildGrid(): void {
		if (!this.container) return;
		const width = this.contentWidth();
		// Match CSS grid auto-fill: last column doesn't need a trailing gap
		this.cols = Math.max(1, Math.floor((width + CELL_GAP) / CELL_SLOT));
		const newCount = this.cols * ROWS;

		// Preserve existing cell state where possible
		const oldCells = this.cells;
		const oldCount = this.cellCount;
		this.cells = new Float64Array(newCount * STRIDE);
		for (let i = 0; i < Math.min(oldCount, newCount); i++) {
			for (let s = 0; s < STRIDE; s++) {
				this.cells[i * STRIDE + s] = oldCells[i * STRIDE + s];
			}
		}
		// Default decay rate for new cells
		for (let i = oldCount; i < newCount; i++) {
			this.cells[i * STRIDE + DR] = 4.0;
		}
		this.cellCount = newCount;

		// Recompute mode-specific state for new grid dimensions
		if (this.mode === "scaffolding" && this.scaffoldBoard) {
			const oldCols = this.scaffoldBoard[0].length;
			const fraction =
				oldCols > 0 ? fillCount(this.scaffoldBoard) / (ROWS * oldCols) : 0;
			// Regenerate plan for new width and fast-forward to current progress
			this.scaffoldPlan = generateTilingPlan(this.cols);
			this.scaffoldBoard = createEmptyBoard(this.cols);
			const targetFill = Math.floor(fraction * ROWS * this.cols);
			this.scaffoldPlanIdx = 0;
			while (
				this.scaffoldPlanIdx < this.scaffoldPlan.length &&
				fillCount(this.scaffoldBoard) < targetFill
			) {
				this.scaffoldBoard = applyPlacement(
					this.scaffoldBoard,
					this.scaffoldPlan[this.scaffoldPlanIdx],
				);
				this.scaffoldPlanIdx++;
			}
			this.scaffoldAnim = null;
		}
		if (this.mode === "done") {
			this.doneCellPhases = new Float64Array(newCount);
			for (let i = 0; i < newCount; i++) {
				this.doneCellPhases[i] = Math.random() * Math.PI * 2;
			}
		}

		// Sync DOM elements
		while (this.container.firstChild)
			this.container.removeChild(this.container.firstChild);
		this.elements = [];
		for (let i = 0; i < newCount; i++) {
			const el = document.createElement("div");
			el.style.cssText = `width:${CELL_SIZE}px;height:${CELL_SIZE}px;border-radius:1.5px;will-change:transform;`;
			this.container.appendChild(el);
			this.elements.push(el);
		}
	}

	// ── Mode & power control ─────────────────────────────────────────────

	/** Set mode and label together. Label defaults to a built-in name if omitted.
	 *  If the current animation hasn't settled, the transition is queued. */
	setMode(mode: SignalMode, label?: string): void {
		const newLabel = label ?? defaultLabel(mode);

		// Same mode — just update the label and cancel any stale pending transition.
		// The pending clear handles a race: triggerSendWave() fires, then a transient
		// desiredMode ('idle') queues before the real desired mode ('sending') arrives
		// on the next render. Without clearing, the stale pending fires on settle.
		if (mode === this.mode) {
			this.pendingMode = null;
			if (newLabel !== this.currentLabel) {
				this.currentLabel = newLabel;
				this.modeAppliedCallback?.(mode, newLabel);
			}
			return;
		}

		// Error modes always bypass the queue
		if (mode === "error-fatal" || mode === "error-recovering") {
			this.pendingMode = null;
			this.applyMode(mode, newLabel);
			return;
		}

		// Force scaffolding completion when transitioning away
		if (this.mode === "scaffolding") this.scaffoldTarget = 1.0;

		// If the current mode's animation hasn't settled, queue the transition
		if (!this.isSettled()) {
			this.pendingMode = mode;
			this.pendingLabel = newLabel;
			return;
		}

		this.applyMode(mode, newLabel);
	}

	/** Register a one-shot callback for when the current animation settles.
	 *  Fires at most once per registration. Multiple can be registered. */
	onSettled(callback: () => void): void {
		this.settledCallbacks.push(callback);
	}

	/** Register a persistent callback that fires every time a mode (and/or label) is applied. */
	setOnModeApplied(
		callback: ((mode: SignalMode, label: string) => void) | null,
	): void {
		this.modeAppliedCallback = callback;
	}

	/** True when the current mode's minimum animation has completed and a transition can proceed. */
	private isSettled(): boolean {
		switch (this.mode) {
			case "sending": {
				// One full wave cycle
				const maxDelay = this.cols * 0.15 + (ROWS - 1) * 0.5;
				return this.wavePhase >= Math.PI + maxDelay;
			}
			case "scaffolding":
				// Settled if not targeting completion, or board is full with no active piece
				return (
					this.scaffoldTarget < 1.0 ||
					(this.scaffoldBoard != null &&
						isBoardFull(this.scaffoldBoard) &&
						!this.scaffoldAnim)
				);
			default:
				return true;
		}
	}

	/** Check settled state each frame — resolves pending mode and fires callbacks. */
	private checkSettled(): void {
		if (!this.isSettled()) return;
		if (!this.pendingMode && this.settledCallbacks.length === 0) return;

		// Resolve pending mode queue
		if (this.pendingMode) {
			const next = this.pendingMode;
			const label = this.pendingLabel;
			this.pendingMode = null;
			this.applyMode(next, label);
		}

		// Fire one-shot callbacks
		if (this.settledCallbacks.length > 0) {
			const cbs = this.settledCallbacks.splice(0);
			for (const cb of cbs) cb();
		}
	}

	/** Actually apply a mode transition — resets mode-specific state. */
	private applyMode(mode: SignalMode, label: string): void {
		this.pendingMode = null;
		this.prevMode = this.mode;
		this.mode = mode;
		this.currentLabel = label;
		this.modeAppliedCallback?.(mode, label);

		// Sending fade: when arriving from the sending wave, seed the backplate's
		// sendingFade timer so the violet glow decays gradually (~0.7s) into the
		// next mode's ambient baseline instead of snapping dark.
		const fade = this.prevMode === "sending" ? 1.0 : 0;

		// Reset mode-specific state so animations start fresh
		if (mode === "sending") this.wavePhase = 0;
		if (mode === "reasoning" || mode === "error-recovering") {
			this.reasoningBP = { accum: 0, ambientTimer: 0, sendingFade: fade };
		}
		if (mode === "building") {
			this.sweepPhase = 0;
			this.buildBP = { accum: 0, ambientTimer: 0, sendingFade: fade };
		}
		if (mode === "scaffolding") {
			this.scaffoldBoard = null;
			this.scaffoldPlan = [];
			this.scaffoldPlanIdx = 0;
			this.scaffoldTarget = 0;
			this.scaffoldAnim = null;
			this.scaffoldBreathPhase = 0;
			this.scaffoldBP = { accum: 0, ambientTimer: 0, sendingFade: fade };
		}
		if (mode === "editing") {
			this.editOps = [];
			this.editBP = { accum: 0, ambientTimer: 0, sendingFade: fade };
		}
		// When leaving done/emerald (hue 4.0), snap hue to a cool base so interpolation
		// never passes through the warm error tone range (hue 1.0–3.0 = amber/rose).
		// Scaffolding lives in the emerald range (3.0–4.0), so snap to the cyan–emerald
		// boundary. All other modes live at hue ≤ 1.0, so snap to cyan.
		if (this.prevMode === "done" && mode !== "done") {
			const snapHue = mode === "scaffolding" ? 3.0 : 1.0;
			for (let i = 0; i < this.cellCount; i++) {
				this.cells[i * STRIDE + H] = snapHue;
				this.cells[i * STRIDE + TH] = snapHue;
			}
		}
		if (mode === "idle") {
			this.idleTimer = 0;
			this.nextIdleTwinkle = 0.5 + Math.random() * 1.5;
		}
		if (mode === "error-fatal") {
			this.fatalTimer = 0;
			this.fatalFlickerTimer = 0;
		}
		if (mode === "done") {
			this.doneTimer = 0;
			this.doneCellPhases = new Float64Array(this.cellCount);
			for (let i = 0; i < this.cellCount; i++) {
				this.doneCellPhases[i] = Math.random() * Math.PI * 2;
				// Snap both current and target hue to emerald so interpolation never
				// passes through the warm error tone range (hue 1.0–3.0 = amber/rose)
				this.cells[i * STRIDE + H] = 4.0;
				this.cells[i * STRIDE + TH] = 4.0;
			}
		}
	}

	/** Set the normalized focus zone for editing mode. Null = full width. */
	setEditFocus(focus: EditFocus | null): void {
		this.editTarget = focus ?? { start: 0, end: 1 };
	}

	/** Set scaffold progress target (0-1). Monotonic — only advances. */
	setScaffoldProgress(target: number): void {
		this.scaffoldTarget = Math.max(this.scaffoldTarget, Math.min(1, target));
	}

	powerOn(): void {
		if (this.powerState === "on" || this.powerState === "powering-on") return;
		this.powerState = "powering-on";
		this.powerProgress = 0;
		// Compute per-cell cascade delays (center-out radial)
		const cx = (this.cols - 1) / 2;
		const cy = (ROWS - 1) / 2;
		let maxDist = 0;
		this.powerTimers = [];
		for (let i = 0; i < this.cellCount; i++) {
			const col = i % this.cols;
			const row = Math.floor(i / this.cols);
			const d = Math.sqrt((col - cx) ** 2 + (row - cy) ** 2);
			this.powerTimers.push(d);
			if (d > maxDist) maxDist = d;
		}
		// Normalize to 0..1
		if (maxDist > 0) {
			for (let i = 0; i < this.powerTimers.length; i++) {
				this.powerTimers[i] /= maxDist;
			}
		}
	}

	powerOff(): void {
		if (this.powerState === "off" || this.powerState === "powering-off") return;
		this.powerState = "powering-off";
		this.powerProgress = 1;
		// Top-down row cascade delays
		this.powerTimers = [];
		for (let i = 0; i < this.cellCount; i++) {
			const row = Math.floor(i / this.cols);
			this.powerTimers.push(row / Math.max(1, ROWS - 1));
		}
	}

	// ── Animation loop ───────────────────────────────────────────────────

	/** Headless throttle interval — ~10fps when detached to save CPU while
	 *  keeping phase timers and energy drain advancing. */
	private static readonly HEADLESS_INTERVAL = 100;

	private tick = (now?: number): void => {
		// setTimeout doesn't pass a DOMHighResTimeStamp — read it ourselves
		const t = now ?? performance.now();
		// Cap dt at 50ms when rendering to prevent visual jumps on frame drops.
		// When headless, allow real elapsed time so the animation catches up to
		// wall-clock — we're not rendering so large steps are fine.
		const rawDt = (t - this.lastTime) / 1000;
		const dt = this.headless ? rawDt : Math.min(rawDt, 0.05);
		this.lastTime = t;

		// Read and drain energy from both channels
		const burstEnergy = this.consumeEnergy();
		const thinkEnergy = this.consumeThinkEnergy();

		// Poll scaffold progress from builder each frame (like energy — no React re-render)
		if (
			(this.mode === "scaffolding" || this.pendingMode) &&
			this.consumeScaffoldProgress
		) {
			const progress = this.consumeScaffoldProgress();
			if (progress > this.scaffoldTarget) this.scaffoldTarget = progress;
		}

		// Advance power state
		this.tickPower(dt);

		// Always tick state — the controller runs headless while detached.
		// Only render when attached to the DOM.
		this.tickMode(dt, burstEnergy, thinkEnergy);
		this.checkSettled();

		const attached = this.elements.length > 0;
		if (attached) {
			this.interpolateCells(dt);
			this.render();
		} else {
			// Headless: snap B/H to targets instead of smooth interpolation.
			// Nobody sees the intermediate values, and they'll converge on reattach.
			this.snapCells();
		}

		// When detached, throttle to ~10fps via setTimeout to save CPU while
		// keeping state current. Switch back to rAF when attached for smooth rendering.
		// Self-terminate after 5s of headless idle with no energy to avoid permanent
		// CPU drain when the user navigates away from the build page.
		if (attached) {
			this.headless = false;
			this.headlessIdleTime = 0;
			this.rafId = requestAnimationFrame(this.tick);
		} else {
			this.headless = true;
			const hasEnergy = burstEnergy > 0 || thinkEnergy > 0;
			this.headlessIdleTime = hasEnergy ? 0 : this.headlessIdleTime + dt;
			if (this.headlessIdleTime > 5) {
				// No one is listening and nothing is happening — stop the loop.
				// attach() will restart it if the sidebar reopens.
				this.rafId = 0;
			} else {
				this.rafId = window.setTimeout(
					this.tick,
					SignalGridController.HEADLESS_INTERVAL,
				);
			}
		}
	};

	private tickPower(dt: number): void {
		if (this.powerState === "powering-on") {
			this.powerProgress = Math.min(1, this.powerProgress + dt * 2.5); // 400ms
			if (this.powerProgress >= 1) this.powerState = "on";
		} else if (this.powerState === "powering-off") {
			this.powerProgress = Math.max(0, this.powerProgress - dt * 3.3); // 300ms
			if (this.powerProgress <= 0) this.powerState = "off";
		}
	}

	private tickMode(dt: number, burstEnergy: number, thinkEnergy: number): void {
		switch (this.mode) {
			case "sending":
				this.tickSending(dt);
				break;
			case "reasoning":
				this.tickReasoning(dt, burstEnergy + thinkEnergy);
				break;
			case "scaffolding":
				this.tickScaffolding(dt, burstEnergy, thinkEnergy);
				break;
			case "building":
				this.tickBuilding(dt, burstEnergy, thinkEnergy);
				break;
			case "editing":
				this.tickEditing(dt, burstEnergy, thinkEnergy);
				break;
			case "error-recovering":
				this.tickErrorRecovering(dt, burstEnergy + thinkEnergy);
				break;
			case "error-fatal":
				this.tickErrorFatal(dt);
				break;
			case "done":
				this.tickDone(dt);
				break;
			case "idle":
				this.tickIdle(dt);
				break;
		}
	}

	// ── Think + ambient layer (called by tickBackplate) ─────────────────
	//
	// Fires neural hotspots, scatter cells, and ambient hum based on accumulated
	// energy. Mutates state.accum and state.ambientTimer in place.

	private tickThinkLayer(
		dt: number,
		energy: number,
		state: BackplateState,
		opts?: ThinkLayerOpts,
	): void {
		const maxFires = opts?.maxFires ?? 0.45;
		const drScale = opts?.drScale ?? 1.0;
		const intensity = opts?.ambientIntensity ?? 3;
		const warmProb = opts?.warmProb ?? 0;

		const density = this.cellCount / 93;

		state.accum += energy;
		const threshold = 7 / density;
		let fires = Math.floor(state.accum / threshold);
		// Scale the per-frame fire cap by dt so the same energy budget is available
		// per second regardless of frame rate. At 10fps headless, each tick gets a
		// 6x larger cap, matching the total fires/sec of 60fps rendering. Capped at
		// 10x to prevent pathological values after long background tab delays.
		const dtScale = Math.min(Math.max(dt, 0.001) / REFERENCE_DT, 10);
		fires = Math.min(fires, Math.ceil(this.cellCount * maxFires * dtScale));
		state.accum = Math.min(state.accum - fires * threshold, threshold * 8);

		// Hotspots: 1-3 bright center cells + 1-2 dimmer neighbors
		if (fires >= 5) {
			const hotspots = Math.min(
				1 + Math.floor(Math.random() * 3),
				Math.floor(fires / 2),
			);
			for (let h = 0; h < hotspots; h++) {
				const center = Math.floor(Math.random() * this.cellCount);
				const centerCol = center % this.cols;
				const centerRow = Math.floor(center / this.cols);
				const warm = warmProb > 0 && Math.random() < warmProb;
				const cOff = center * STRIDE;
				this.cells[cOff + TB] = 0.7 + Math.random() * 0.3;
				this.cells[cOff + TH] = warm
					? 1.3 + Math.random() * 0.4
					: 0.5 + Math.random() * 0.5;
				this.cells[cOff + DR] = 2.0 * drScale;
				fires--;
				const neighborCount = 1 + Math.floor(Math.random() * 2);
				for (let n = 0; n < neighborCount && fires > 0; n++) {
					const dc = Math.floor(Math.random() * 3) - 1;
					const dr = Math.floor(Math.random() * 3) - 1;
					if (dc === 0 && dr === 0) continue;
					const nc = centerCol + dc;
					const nr = centerRow + dr;
					if (nr < 0 || nr >= ROWS || nc < 0 || nc >= this.cols) continue;
					const nOff = (nr * this.cols + nc) * STRIDE;
					this.cells[nOff + TB] = 0.3 + Math.random() * 0.4;
					this.cells[nOff + TH] = warm
						? 1.2 + Math.random() * 0.3
						: 0.4 + Math.random() * 0.4;
					this.cells[nOff + DR] = 2.5 * drScale;
					fires--;
				}
			}
		}

		// Scatter remaining fires
		for (let f = 0; f < fires; f++) {
			const idx = Math.floor(Math.random() * this.cellCount);
			const off = idx * STRIDE;
			const warm = warmProb > 0 && Math.random() < warmProb;
			this.cells[off + TB] = 0.45 + Math.random() * 0.45;
			this.cells[off + TH] = warm
				? 1.3 + Math.random() * 0.4
				: Math.random() * 0.7;
			this.cells[off + DR] = (2.0 + Math.random()) * drScale;
		}

		// Ambient hum — baseline activity even with zero energy.
		// Loop handles multi-interval steps at low fps so each interval's batch
		// fires independently instead of clumping into one oversized burst.
		// Timer capped at 5 intervals to prevent a CPU spike after long background
		// delays (e.g. tab throttled to 1fps → dt of 60s → 1500 iterations).
		const recent = Math.min(1, state.accum / 50);
		const ambientInterval = 0.12 - recent * 0.08;
		state.ambientTimer = Math.min(state.ambientTimer + dt, ambientInterval * 5);
		while (state.ambientTimer > ambientInterval) {
			state.ambientTimer -= ambientInterval;
			const count = Math.max(
				1,
				Math.round((2 + recent * intensity + Math.random() * 2) * density),
			);
			for (let a = 0; a < count; a++) {
				const idx = Math.floor(Math.random() * this.cellCount);
				const off = idx * STRIDE;
				const warm = warmProb > 0 && Math.random() < warmProb * 0.7;
				const roll = Math.random();
				const brightness =
					roll < 0.7 ? 0.15 + Math.random() * 0.2 : 0.3 + Math.random() * 0.25;
				this.cells[off + TB] = Math.max(this.cells[off + TB], brightness);
				this.cells[off + TH] = warm ? 1.2 + Math.random() * 0.5 : Math.random();
				this.cells[off + DR] = (1.5 + Math.random() * 0.5) * drScale;
			}
		}
	}

	// ── Backplate — shared background neural activity layer ──────────────
	//
	// The canonical "thinking" visual: random neural firing, hue drift, gentle
	// decay. Used directly by reasoning and error-recovering as their entire
	// animation, and as a background layer by scaffolding, building, and editing
	// (which paint their foreground elements on top).
	//
	// Call order in each mode ticker:
	//   Foreground-first modes (building, editing):
	//     1. Render foreground (sweep, defrag bars, bursts)
	//     2. tickBackplate() — fires underneath, decay applied to all
	//   Background-first modes (scaffolding):
	//     1. tickBackplate() — fires on unfilled cells
	//     2. Render foreground (board cells, piece animation) on top
	//   Pure backplate modes (reasoning, error-recovering):
	//     1. tickBackplate() — that's the entire visual

	private tickBackplate(
		dt: number,
		energy: number,
		state: BackplateState,
		opts?: BackplateOpts,
	): void {
		// ── Sending fade — violet glow that lingers after the wave ──
		// Applies a decaying brightness floor (Math.max so it never overwrites
		// brighter foreground) and caps DR for smooth interpolation. Drains at
		// 1.5/s so the fade is fully gone in ~0.7s.
		if (state.sendingFade > 0.01) {
			const fadeBrightness = 0.08 * state.sendingFade;
			for (let i = 0; i < this.cellCount; i++) {
				const off = i * STRIDE;
				this.cells[off + TB] = Math.max(this.cells[off + TB], fadeBrightness);
				this.cells[off + DR] = Math.min(this.cells[off + DR], 2.0);
			}
			state.sendingFade = Math.max(0, state.sendingFade - dt * 1.5);
		}

		// ── Think layer — neural firing correlated with streaming energy ──
		this.tickThinkLayer(dt, energy, state, opts?.think);

		// ── Hue drift — active cells drift toward a target hue ──
		const driftRate = opts?.hueDriftRate ?? 0.4;
		const driftTarget = opts?.hueDriftTarget ?? 1.0;
		if (driftRate > 0) {
			for (let i = 0; i < this.cellCount; i++) {
				const off = i * STRIDE;
				if (this.cells[off + B] > 0.05) {
					const current = this.cells[off + TH];
					if (current < driftTarget) {
						this.cells[off + TH] = Math.min(
							driftTarget,
							current + dt * driftRate,
						);
					} else if (current > driftTarget) {
						this.cells[off + TH] = Math.max(
							driftTarget,
							current - dt * driftRate,
						);
					}
				}
			}
		}

		// ── Decay + YO reset — brightness fades, vertical offsets cleared ──
		const decay = opts?.decayRate ?? 0.7;
		const filter = opts?.decayFilter;
		for (let i = 0; i < this.cellCount; i++) {
			if (filter && !filter(Math.floor(i / this.cols), i % this.cols)) continue;
			const off = i * STRIDE;
			this.cells[off + TB] = Math.max(0, this.cells[off + TB] - dt * decay);
			this.cells[off + YO] = 0;
		}
	}

	// ── Sending wave ─────────────────────────────────────────────────────

	private tickSending(dt: number): void {
		// Normalize phase offsets so the wave spans exactly one cycle across the grid,
		// preventing wrap-around where the tail bleeds into the bottom-left corner.
		const maxDelay = this.cols * 0.15 + (ROWS - 1) * 0.5;
		const cycleLen = Math.PI + maxDelay; // one sine half-period + full grid traversal
		this.wavePhase += dt * (cycleLen / SEND_WAVE_DURATION);
		const t = this.wavePhase % cycleLen;

		for (let i = 0; i < this.cellCount; i++) {
			const col = i % this.cols;
			const row = Math.floor(i / this.cols);
			const invertedRow = ROWS - 1 - row;
			const delay = col * 0.15 + invertedRow * 0.5;
			const localPhase = t - delay;
			// Only show the positive half of sine, and only when the wave has reached this cell
			const wave =
				localPhase > 0 && localPhase < Math.PI ? Math.sin(localPhase) : 0;
			const brightness = wave > 0 ? wave * 0.85 + 0.08 : 0.08;
			const yShift = wave > 0 ? -wave * 1.5 : 0;

			const off = i * STRIDE;
			this.cells[off + TB] = brightness;
			this.cells[off + TH] = 0; // pure violet
			this.cells[off + DR] = 8.0;
			this.cells[off + YO] = yShift;
		}
	}

	// ── Scaffolding (solver-driven tetris progress bar) ────────────────────
	//
	// Grid fills left→right as solver-optimal pieces are placed.
	// External progress (scaffoldTarget) acts as a SPEED SIGNAL, not a gate:
	//   - Large gap between target and fill → fast animation (catch up, rush mode)
	//   - Small gap → slow animation (ease off, full theatrics)
	//   - Zero gap → stall: breathing energy bar on the fill front columns
	// Rush mode (speed >= 3.0) skips preview/select phases — piece appears
	// pre-selected at its final rotation and slides in from a short distance.
	// This makes catch-up ~4x faster than the full animation sequence.
	// The animation never freezes — it either places pieces or breathes.

	private tickScaffolding(
		dt: number,
		_burstEnergy: number,
		thinkEnergy: number,
	): void {
		// ── Initialize board + pre-compute tiling plan on first frame ───
		if (!this.scaffoldBoard) {
			this.scaffoldBoard = createEmptyBoard(this.cols);
			this.scaffoldPlan = generateTilingPlan(this.cols);
			this.scaffoldPlanIdx = 0;
		}

		// ── Background: neural activity on unfilled cells ──
		// The backplate handles think layer firing, sending fade, and decay.
		// decayFilter (on scaffoldBackplateOpts) reads this.scaffoldBoard directly.
		const board = this.scaffoldBoard;
		const cols = this.cols;
		this.tickBackplate(
			dt,
			thinkEnergy,
			this.scaffoldBP,
			this.scaffoldBackplateOpts,
		);

		// ── Foreground: filled board cells at locked brightness ──
		for (let r = 0; r < ROWS; r++) {
			for (let c = 0; c < cols; c++) {
				if (!board[r][c]) continue;
				const off = (r * cols + c) * STRIDE;
				this.cells[off + TB] = 0.25;
				this.cells[off + TH] = 1.0;
				this.cells[off + DR] = 20;
			}
		}

		// ── Speed from gap — progress is a speed signal, not a gate ───
		const totalCells = ROWS * cols;
		const targetFill = Math.floor(this.scaffoldTarget * totalCells);
		const currentFill = fillCount(board);
		const gap = targetFill - currentFill;
		const gapFraction = gap / totalCells;
		const stalled =
			gap <= 0 || this.scaffoldPlanIdx >= this.scaffoldPlan.length;

		if (stalled) {
			// ── Breathing front — oscillating energy bar on the fill edge columns ───
			// A bright peak travels up and down the 3 rows, leaving a fading trail
			// on the two columns at the fill front. Shows the system is alive and working.
			const front = fillFront(board);
			if (front < cols) {
				this.scaffoldBreathPhase += dt * 1.5;
				for (let row = 0; row < ROWS; row++) {
					const phase =
						this.scaffoldBreathPhase * Math.PI * 2 +
						row * ((Math.PI * 2) / ROWS);
					const wave = (Math.sin(phase) + 1) * 0.5;
					const brightness = 0.15 + wave * 0.6;

					const off1 = (row * cols + front) * STRIDE;
					this.cells[off1 + TB] = Math.max(this.cells[off1 + TB], brightness);
					this.cells[off1 + TH] = -0.6;
					this.cells[off1 + DR] = 2.5;

					if (front + 1 < cols) {
						const off2 = (row * cols + front + 1) * STRIDE;
						this.cells[off2 + TB] = Math.max(
							this.cells[off2 + TB],
							brightness * 0.5,
						);
						this.cells[off2 + TH] = -0.3;
						this.cells[off2 + DR] = 2.0;
					}
				}
			}
		} else {
			// ── Piece placement — speed scales with how far behind we are ───
			// Slow cruise when keeping pace, rush mode (>= 3.0) when catching up.
			// Rush skips preview/select theatrics for ~4x faster piece placement.
			const speed =
				this.scaffoldTarget >= 1.0
					? 4.0
					: gapFraction > 0.3
						? 3.0
						: gapFraction > 0.15
							? 1.5
							: gapFraction > 0.05
								? 0.7
								: 0.4;
			const rush = speed >= 3.0;

			// Start a new turn when idle
			if (
				!this.scaffoldAnim &&
				this.scaffoldPlanIdx < this.scaffoldPlan.length
			) {
				this.scaffoldAnim = this.startScaffoldTurn(
					this.scaffoldPlan[this.scaffoldPlanIdx],
					rush,
				);
			}

			// Update speed dynamically — the gap can change mid-turn as new milestones arrive
			if (this.scaffoldAnim) {
				this.scaffoldAnim.speed = speed;
				this.advanceScaffoldAnim(dt);
			}

			// Reset breath phase so it starts fresh if we stall again
			this.scaffoldBreathPhase = 0;
		}
	}

	/** Start a new turn: replay the solver's search — rejected pieces then the winner.
	 *  Speed is not set here — tickScaffolding updates it dynamically each frame
	 *  based on the gap between target and current fill.
	 *  Rush mode skips preview/select theatrics — piece appears pre-selected at its
	 *  final rotation a few columns out and slides directly into landing position. */
	private startScaffoldTurn(optimal: Placement, rush: boolean): ScaffoldAnim {
		const board = this.scaffoldBoard;
		if (!board) return this.scaffoldAnim as ScaffoldAnim;
		const front = fillFront(board);
		const pieceWidth = Math.max(...optimal.shape.map(([, c]) => c)) + 1;
		const previewCol = front + pieceWidth + 3;

		// Rush: no rejected previews, no rotation, no select flash.
		// Piece starts at its final rotation a short distance out and slides in.
		if (rush) {
			const rushStart = Math.min(optimal.originCol + 5, this.cols - 1);
			return {
				optimal,
				previews: [],
				previewIdx: 0,
				previewCol,
				slidePos: rushStart,
				phase: ScaffoldAnimPhase.Slide,
				timer: 0,
				speed: 1.0,
			};
		}

		// Full animation: rejected pieces → rotation → double-flash select → slide → lock.
		// Previews: last 1-3 rejections (rot0), then winner rotating to its final orientation.
		// Rotation families: rotations 0-3 are one family, 4-7 another (quarter turns within each).
		const previews: ScaffoldPreview[] = [];

		// Rejected pieces in rot0
		if (optimal.rejected.length > 0) {
			const rej = optimal.rejected;
			const n = Math.min(rej.length, 1 + Math.floor(Math.random() * 3));
			for (const r of rej.slice(-n)) {
				const shape = r.rotations[0];
				const height = Math.max(...shape.map(([row]) => row)) + 1;
				previews.push({ shape, originRow: Math.floor((ROWS - height) / 2) });
			}
		}

		// Winner rotating: step from family base to final rotation, one quarter turn at a time.
		// Last frame uses the actual landing originRow so it visually "drops" into position.
		const ri = optimal.rotationIndex;
		const base =
			optimal.piece.rotations.length > 4 ? Math.floor(ri / 4) * 4 : 0;
		for (let r = base; r <= ri; r++) {
			const shape = optimal.piece.rotations[r];
			const height = Math.max(...shape.map(([row]) => row)) + 1;
			previews.push({ shape, originRow: Math.floor((ROWS - height) / 2) });
		}
		// If the centered row differs from the landing row, add a final "drop" frame
		if (previews.length > 0) {
			const lastPv = previews[previews.length - 1];
			if (lastPv.originRow !== optimal.originRow) {
				previews.push({ shape: optimal.shape, originRow: optimal.originRow });
			}
		}

		return {
			optimal,
			previews,
			previewIdx: 0,
			previewCol,
			slidePos: previewCol,
			phase:
				previews.length > 0
					? ScaffoldAnimPhase.Preview
					: ScaffoldAnimPhase.Select,
			timer: 0,
			speed: 1.0,
		};
	}

	/** Advance the scaffold piece animation state machine.
	 *  All phase durations use base constants (S_*) scaled by SCAFFOLD_TEMPO and per-piece speed. */
	private advanceScaffoldAnim(dt: number): void {
		const a = this.scaffoldAnim;
		if (!a) return;
		const tempo = SCAFFOLD_TEMPO * a.speed;
		a.timer += dt;

		switch (a.phase) {
			case ScaffoldAnimPhase.Preview: {
				if (a.timer >= S_PREVIEW / tempo) {
					a.previewIdx++;
					a.timer = 0;
					if (a.previewIdx >= a.previews.length) {
						a.phase = ScaffoldAnimPhase.Select;
						a.timer = 0;
					}
				}
				const pv = a.previews[Math.min(a.previewIdx, a.previews.length - 1)];
				this.renderScaffoldShape(
					pv.shape,
					pv.originRow,
					a.previewCol,
					0.5,
					-0.6,
					4.0,
					0,
				);
				break;
			}

			case ScaffoldAnimPhase.Select: {
				const { shape, originRow } = a.optimal;
				const p = a.timer / (S_SELECT / tempo); // 0..1 normalized progress
				if (p < 0.25) {
					this.renderScaffoldShape(
						shape,
						originRow,
						a.previewCol,
						0.95,
						-0.8,
						8.0,
						-1.5,
					);
				} else if (p < 0.5) {
					this.renderScaffoldShape(
						shape,
						originRow,
						a.previewCol,
						0.05,
						-0.4,
						10.0,
						0,
					);
				} else if (p < 0.67) {
					this.renderScaffoldShape(
						shape,
						originRow,
						a.previewCol,
						0.95,
						-0.8,
						8.0,
						-1.5,
					);
				} else {
					this.renderScaffoldShape(
						shape,
						originRow,
						a.previewCol,
						0.85,
						-0.8,
						5.0,
						-0.8,
					);
				}
				if (p >= 1.0) {
					a.phase = ScaffoldAnimPhase.Slide;
					a.timer = 0;
					a.slidePos = a.previewCol;
				}
				break;
			}

			case ScaffoldAnimPhase.Slide: {
				const { shape, originRow, originCol } = a.optimal;
				const distance = a.previewCol - originCol;
				const slideSpeed = Math.max(distance * S_SLIDE_K, 6) * tempo;
				a.slidePos -= slideSpeed * dt;
				const col = Math.max(originCol, Math.round(a.slidePos));
				this.renderScaffoldShape(shape, originRow, col, 0.9, -0.8, 5.0, -0.5);
				// Trailing glow
				const maxDc = Math.max(...shape.map(([, c]) => c));
				const trail = col + maxDc + 1;
				if (trail < this.cols) {
					for (let row = 0; row < ROWS; row++) {
						const off = (row * this.cols + trail) * STRIDE;
						this.cells[off + TB] = Math.max(this.cells[off + TB], 0.2);
						this.cells[off + TH] = -0.3;
						this.cells[off + DR] = 3.5 * SCAFFOLD_TEMPO;
					}
				}
				if (a.slidePos <= originCol) {
					a.phase = ScaffoldAnimPhase.Lock;
					a.timer = 0;
				}
				break;
			}

			case ScaffoldAnimPhase.Lock: {
				// Scale by speed (clamped >= 1.0 so slow pieces keep a crisp lock flash)
				const dur = S_LOCK / (SCAFFOLD_TEMPO * Math.max(a.speed, 1.0));
				const p = a.timer / dur;
				const { cells } = a.optimal;
				if (p < 0.3) {
					for (const [r, c] of cells) {
						if (r < 0 || r >= ROWS || c < 0 || c >= this.cols) continue;
						const off = (r * this.cols + c) * STRIDE;
						this.cells[off + TB] = 0.95;
						this.cells[off + TH] = 1.0;
						this.cells[off + DR] = 6.0 * SCAFFOLD_TEMPO;
						this.cells[off + YO] = -1.0;
					}
				} else {
					const fade = Math.max(0, 1 - (p - 0.3) / 0.7);
					for (const [r, c] of cells) {
						if (r < 0 || r >= ROWS || c < 0 || c >= this.cols) continue;
						const off = (r * this.cols + c) * STRIDE;
						this.cells[off + TB] = 0.35 + fade * 0.5;
						this.cells[off + TH] = 1.0;
						this.cells[off + DR] = 3.0 * SCAFFOLD_TEMPO;
						this.cells[off + YO] = -fade * 0.5;
					}
				}
				if (p >= 1.0) {
					this.scaffoldBoard = applyPlacement(
						this.scaffoldBoard ?? [],
						a.optimal,
					);
					this.scaffoldPlanIdx++;
					this.scaffoldAnim = null;
				}
				break;
			}
		}
	}

	/** Render a piece shape at the given board position.
	 *  DR is scaled by SCAFFOLD_TEMPO for crisp response at animation speed.
	 *  Skips cells already filled on the board so pieces never clip through placed tiles. */
	private renderScaffoldShape(
		shape: Shape,
		originRow: number,
		anchorCol: number,
		brightness: number,
		hue: number,
		decay: number,
		yOffset: number,
	): void {
		for (const [dr, dc] of shape) {
			const row = originRow + dr;
			const col = anchorCol + dc;
			if (row < 0 || row >= ROWS || col < 0 || col >= this.cols) continue;
			if (this.scaffoldBoard?.[row][col]) continue;
			const off = (row * this.cols + col) * STRIDE;
			this.cells[off + TB] = Math.max(this.cells[off + TB], brightness);
			this.cells[off + TH] = hue;
			this.cells[off + DR] = decay * SCAFFOLD_TEMPO;
			this.cells[off + YO] = yOffset;
		}
	}

	// ── Reasoning (token-correlated neural firing) ───────────────────────

	private tickReasoning(dt: number, energy: number): void {
		this.tickBackplate(dt, energy, this.reasoningBP);
	}

	// ── Building (sweep + delivery bursts + thinking activity) ────────────

	private tickBuilding(
		dt: number,
		burstEnergy: number,
		thinkEnergy: number,
	): void {
		this.sweepPhase += dt * 1.8;

		// Pink scanner beam — bubblegum pink bars contrasting the cyan thinking cells.
		// Negative hue = pink; decays through violet back to cyan (all cool tones).
		const activeCol = Math.floor(this.sweepPhase % this.cols);
		const nextCol = (activeCol + 1) % this.cols;
		const trailCol = (activeCol - 1 + this.cols) % this.cols;
		for (let row = 0; row < ROWS; row++) {
			// Leading edge — bright bubblegum pink
			for (const col of [activeCol, nextCol]) {
				const off = (row * this.cols + col) * STRIDE;
				this.cells[off + TB] = Math.max(this.cells[off + TB], 0.78);
				this.cells[off + TH] = -0.8;
				this.cells[off + DR] = 5.0;
				this.cells[off + YO] = -0.5;
			}
			// Trailing glow — pinkish violet fade
			const tOff = (row * this.cols + trailCol) * STRIDE;
			this.cells[tOff + TB] = Math.max(this.cells[tOff + TB], 0.35);
			this.cells[tOff + TH] = -0.35;
			this.cells[tOff + DR] = 3.0;
		}

		// Delivery bursts — only from data parts (UI-visible changes like module/form done)
		if (burstEnergy >= 150) {
			// Large burst: flash all cells bright cyan
			for (let i = 0; i < this.cellCount; i++) {
				const off = i * STRIDE;
				this.cells[off + TB] = 0.85 + Math.random() * 0.15;
				this.cells[off + TH] = 0.8 + Math.random() * 0.2;
				this.cells[off + DR] = 1.5; // linger
			}
		} else if (burstEnergy >= 30) {
			// Small burst: activate random subset
			const count = Math.min(Math.floor(burstEnergy / 8), this.cellCount);
			for (let f = 0; f < count; f++) {
				const idx = Math.floor(Math.random() * this.cellCount);
				const off = idx * STRIDE;
				this.cells[off + TB] = 0.5 + Math.random() * 0.3;
				this.cells[off + TH] = 0.5;
				this.cells[off + DR] = 3.0;
			}
		}

		// Backplate: think layer fires on top of sweep, then decay pulls everything down
		this.tickBackplate(
			dt,
			thinkEnergy,
			this.buildBP,
			FOREGROUND_BACKPLATE_OPTS,
		);
	}

	// ── Editing (defrag — vertical bars that select, crawl, and place) ────
	//
	// Like the building sweep's vertical bubblegum pink bars, but instead of
	// sweeping left→right, bars perform tracked pick-move-drop operations:
	//   1. Select — double-brighten a column (two quick flashes, like double-click)
	//   2. Crawl  — bar moves column-by-column from source to destination
	//   3. Place  — single bright pulse at destination (single-click to drop)
	//
	// Operations are tracked in editOps with per-op lifecycle state.
	// Zone smoothly lerps toward the target focus so transitions feel organic.

	private tickEditing(
		dt: number,
		burstEnergy: number,
		thinkEnergy: number,
	): void {
		// Smooth-lerp the current zone toward the target
		this.editCurrent.start +=
			(this.editTarget.start - this.editCurrent.start) *
			Math.min(dt * EDIT_ZONE_LERP_SPEED, 1);
		this.editCurrent.end +=
			(this.editTarget.end - this.editCurrent.end) *
			Math.min(dt * EDIT_ZONE_LERP_SPEED, 1);

		const startCol = Math.floor(this.editCurrent.start * this.cols);
		const endCol = Math.min(
			Math.ceil(this.editCurrent.end * this.cols),
			this.cols,
		);
		const zoneCols = Math.max(1, endCol - startCol);
		const _density = this.cellCount / 93;

		// ── Defrag bar — one 2-column bar at a time, like building's sweep ──
		// Immediately spawn a new op when the previous one finishes.
		if (this.editOps.length < MAX_DEFRAG_OPS) {
			const src = startCol + Math.floor(Math.random() * zoneCols);
			let dst = startCol + Math.floor(Math.random() * zoneCols);
			if (Math.abs(dst - src) < 2) dst = src + (Math.random() < 0.5 ? -2 : 2);
			dst = Math.max(startCol, Math.min(endCol - 1, dst));
			if (dst === src) dst = src < endCol - 1 ? src + 1 : src - 1;
			dst = Math.max(startCol, Math.min(endCol - 1, dst));

			// Generate seek stops — mix of jumps and adjacent moves.
			// ~40% chance each stop is adjacent to the previous (±1-2 cols),
			// creating clusters where the bar "inspects a region" before jumping.
			const seekCount = 4 + Math.floor(Math.random() * 5);
			const seekStops: number[] = [];
			let prev = startCol + Math.floor(Math.random() * zoneCols);
			seekStops.push(prev);
			for (let s = 1; s < seekCount; s++) {
				if (Math.random() < 0.8) {
					// Adjacent move — nudge ±1-2 columns from previous
					const nudge =
						(Math.random() < 0.5 ? -1 : 1) *
						(1 + Math.floor(Math.random() * 2));
					prev = Math.max(startCol, Math.min(endCol - 1, prev + nudge));
				} else {
					// Jump to a random column
					prev = startCol + Math.floor(Math.random() * zoneCols);
				}
				seekStops.push(prev);
			}
			seekStops.push(src); // final stop is the actual source

			this.editOps.push({
				srcCol: src,
				dstCol: dst,
				pos: seekStops[0],
				phase: DefragPhase.Seek,
				timer: 0,
				speed: zoneCols * 0.16 + Math.random() * (zoneCols * 0.12),
				seekStops,
				seekIdx: 0,
			});
		}

		// ── Advance the active operation ────────────────────────────────
		const op = this.editOps[0];
		if (op) {
			op.timer += dt;
			const dir = op.dstCol > op.srcCol ? 1 : -1;

			// Pick the adjacent column for a 2-wide bar, always staying inside the zone.
			// Prefer the dir side, fall back to the other side.
			const pairCol = (col: number): number => {
				const preferred = col + dir;
				if (preferred >= startCol && preferred < endCol) return preferred;
				const fallback = col - dir;
				if (fallback >= startCol && fallback < endCol) return fallback;
				return col; // zone is 1 col wide, no pair possible
			};

			switch (op.phase) {
				case DefragPhase.Seek: {
					// Hunt: dim bar jitters through a few random columns before
					// landing on the source. Each stop gets a brief dim flash.
					const t = op.timer;
					const dwell = 0.54; // time per stop
					const col = op.seekStops[op.seekIdx];
					// Seek has no direction — pick whichever adjacent column fits
					const pair = col + 1 < endCol ? col + 1 : Math.max(startCol, col - 1);

					// Dim flash at current stop — subtle, not full brightness
					const flash = Math.max(0, 1 - t / dwell);
					for (const c of [col, pair])
						this.lightColumnY(c, 0.25 + flash * 0.2, -0.4, 6.0, 0);

					if (t >= dwell) {
						op.seekIdx++;
						op.timer = 0;
						if (op.seekIdx >= op.seekStops.length) {
							op.phase = DefragPhase.Select;
							op.timer = 0;
						}
					}
					break;
				}
				case DefragPhase.Select: {
					// Double-click: two sharp flashes with a short forced-dark gap.
					const t = op.timer;
					const src = op.srcCol;
					const srcPair = pairCol(src);

					if (t < 0.1) {
						for (const c of [src, srcPair])
							this.lightColumnY(c, 0.95, -0.8, 8.0, -1.5);
					} else if (t < 0.25) {
						for (const c of [src, srcPair]) this.dimColumn(c, 10.0);
					} else if (t < 0.35) {
						for (const c of [src, srcPair])
							this.lightColumnY(c, 0.95, -0.8, 8.0, -1.5);
					} else {
						for (const c of [src, srcPair])
							this.lightColumnY(c, 0.95, -0.8, 5.0, -0.8);
					}

					if (t >= 0.45) {
						op.phase = DefragPhase.Crawl;
						op.timer = 0;
						op.pos = op.srcCol;
					}
					break;
				}
				case DefragPhase.Crawl: {
					// Drag: full flash brightness, lifted — actively moving.
					op.pos += dir * op.speed * dt;

					const col = Math.round(op.pos);
					const lead = Math.max(startCol, Math.min(endCol - 1, col));
					const pair = pairCol(lead);
					this.lightColumnY(lead, 0.95, -0.8, 5.0, -0.8);
					this.lightColumnY(pair, 0.95, -0.8, 5.0, -0.8);

					// Trailing glow
					const trail = lead - dir;
					if (trail >= startCol && trail < endCol) {
						this.lightColumn(trail, 0.15, -0.3, 3.5);
					}

					if (
						(dir > 0 && op.pos >= op.dstCol) ||
						(dir < 0 && op.pos <= op.dstCol)
					) {
						op.phase = DefragPhase.Place;
						op.timer = 0;
					}
					break;
				}
				case DefragPhase.Place: {
					// Drop: forced dark gap, then single flash, then fade.
					const t = op.timer;
					const dst = op.dstCol;
					const dstPair = pairCol(dst);

					if (t < 0.2) {
						for (const c of [dst, dstPair]) this.dimColumn(c, 10.0);
					} else if (t < 0.32) {
						for (const c of [dst, dstPair])
							this.lightColumnY(c, 0.95, -0.8, 6.0, 0.8);
					} else {
						const fade = Math.max(0, 1 - (t - 0.32) / 0.33);
						for (const c of [dst, dstPair])
							this.lightColumnY(c, fade * 0.5, -0.5, 3.0, 0.8 * fade);
					}

					if (t >= 0.65) {
						this.editOps.length = 0;
					}
					break;
				}
			}
		}

		// ── Delivery bursts — from data parts (form updated, blueprint updated) ──
		if (burstEnergy >= 100) {
			for (let row = 0; row < ROWS; row++) {
				for (let col = startCol; col < endCol; col++) {
					const off = (row * this.cols + col) * STRIDE;
					this.cells[off + TB] = 0.8 + Math.random() * 0.2;
					this.cells[off + TH] = 0.8 + Math.random() * 0.2;
					this.cells[off + DR] = 1.5;
				}
			}
		} else if (burstEnergy >= 30) {
			const count = Math.min(Math.floor(burstEnergy / 6), zoneCols * ROWS);
			for (let f = 0; f < count; f++) {
				const col = startCol + Math.floor(Math.random() * zoneCols);
				const row = Math.floor(Math.random() * ROWS);
				const off = (row * this.cols + col) * STRIDE;
				this.cells[off + TB] = 0.5 + Math.random() * 0.35;
				this.cells[off + TH] = 0.6 + Math.random() * 0.3;
				this.cells[off + DR] = 2.5;
			}
		}

		// Backplate: think layer fires underneath defrag bars, then decay
		this.tickBackplate(
			dt,
			thinkEnergy + burstEnergy,
			this.editBP,
			FOREGROUND_BACKPLATE_OPTS,
		);
	}

	/** Light an entire column (all rows) — used by defrag ops for vertical bar effect. */
	private lightColumn(
		col: number,
		brightness: number,
		hue: number,
		decay: number,
	): void {
		for (let row = 0; row < ROWS; row++) {
			const off = (row * this.cols + col) * STRIDE;
			this.cells[off + TB] = Math.max(this.cells[off + TB], brightness);
			this.cells[off + TH] = hue;
			this.cells[off + DR] = decay;
		}
	}

	/** Force a column dark — actively pulls brightness toward 0 at the given rate.
	 *  Unlike lightColumn (which uses max), this overrides to drive cells down. */
	private dimColumn(col: number, decayRate: number): void {
		for (let row = 0; row < ROWS; row++) {
			const off = (row * this.cols + col) * STRIDE;
			this.cells[off + TB] = 0;
			this.cells[off + DR] = decayRate;
		}
	}

	/** Light an entire column with a vertical offset — for lifted/dropped bar states. */
	private lightColumnY(
		col: number,
		brightness: number,
		hue: number,
		decay: number,
		yOffset: number,
	): void {
		for (let row = 0; row < ROWS; row++) {
			const off = (row * this.cols + col) * STRIDE;
			this.cells[off + TB] = Math.max(this.cells[off + TB], brightness);
			this.cells[off + TH] = hue;
			this.cells[off + DR] = decay;
			this.cells[off + YO] = yOffset;
		}
	}

	// ── Error recovering ("sprinkle some red" — reasoning with distress) ─

	private tickErrorRecovering(dt: number, energy: number): void {
		this.tickBackplate(dt, energy, this.reasoningBP, {
			think: { warmProb: 0.35 },
			hueDriftRate: 0,
		});
	}

	// ── Error fatal ("giving up" — flicker fades into settled dim pulse) ─
	//
	// No discrete phases — flicker intensity decays continuously while the
	// pull toward the resting breath target grows. Everything flows through
	// the target/interpolation system so transitions are inherently smooth.

	private tickErrorFatal(dt: number): void {
		this.fatalTimer += dt;
		const density = this.cellCount / 93;

		// Resting state: slow breathing rose-pink pulse (~5s cycle)
		const breath = 0.235 + Math.sin(this.fatalTimer * 1.25) * 0.055;

		// Flicker fades out continuously over ~3s
		const flicker = Math.max(0, 1 - this.fatalTimer / 3);

		// Pull toward resting state — weak at first (flicker dominates), strong when settled
		const pull = 0.5 + (1 - flicker) * 6;

		// All cells drift toward the resting breath target
		for (let i = 0; i < this.cellCount; i++) {
			const off = i * STRIDE;
			this.cells[off + TB] += (breath - this.cells[off + TB]) * dt * pull;
			this.cells[off + TH] += (2.0 - this.cells[off + TH]) * dt * pull;
			this.cells[off + DR] = 1.0 + (1 - flicker) * 2.0;
			this.cells[off + YO] = 0;
		}

		// Erratic flicker layered on top — fades out naturally.
		// Accumulator-based timing so flicker rate is fps-independent (the old
		// `Math.random() < dt / fireRate` saturated to 1.0 at low fps).
		if (flicker > 0.01) {
			const fireRate = 0.03 + flicker * 0.05;
			this.fatalFlickerTimer += dt;
			if (this.fatalFlickerTimer >= fireRate) {
				this.fatalFlickerTimer -= fireRate;
				const count = Math.max(1, Math.round((2 + flicker * 6) * density));
				for (let f = 0; f < count; f++) {
					const idx = Math.floor(Math.random() * this.cellCount);
					const off = idx * STRIDE;
					this.cells[off + TB] = breath + Math.random() * 0.5 * flicker;
					this.cells[off + TH] = 1.5 + Math.random() * 0.5;
					this.cells[off + DR] = 2.0 + flicker * 3;
				}
			}
		}
	}

	// ── Done ("du-du-DONEE" celebration → resting emerald pulse) ──────────

	private tickDone(dt: number): void {
		this.doneTimer += dt;
		if (this.doneTimer < 2.0) {
			this.tickDoneCelebration();
		} else {
			this.tickDoneResting(dt);
		}
	}

	private tickDoneCelebration(): void {
		const t = this.doneTimer;
		const cx = (this.cols - 1) / 2;
		const cy = (ROWS - 1) / 2;
		let maxDist = 0;
		for (let i = 0; i < this.cellCount; i++) {
			const col = i % this.cols;
			const row = Math.floor(i / this.cols);
			const d = Math.sqrt((col - cx) ** 2 + (row - cy) ** 2);
			if (d > maxDist) maxDist = d;
		}
		if (maxDist === 0) maxDist = 1;

		// Three beats: accelerating into climax
		// [startTime, peakBrightness, radiusFraction, decayRate]
		const beats: [number, number, number, number][] = [
			[0.0, 0.6, 0.35, 3.5], // Beat 1: modest, center 35%
			[0.3, 0.78, 0.65, 3.0], // Beat 2: medium, 65%
			[0.55, 1.0, 1.0, 1.8], // Beat 3: FULL explosion
		];

		// Decay toward dark between beats + force emerald hue on ALL cells
		for (let i = 0; i < this.cellCount; i++) {
			const off = i * STRIDE;
			this.cells[off + TB] = Math.max(0, this.cells[off + TB] - 0.016 * 3.0);
			this.cells[off + TH] = 4.0;
			this.cells[off + H] = 4.0;
		}

		for (let i = 0; i < this.cellCount; i++) {
			const col = i % this.cols;
			const row = Math.floor(i / this.cols);
			const dist = Math.sqrt((col - cx) ** 2 + (row - cy) ** 2) / maxDist;
			const off = i * STRIDE;

			let bright = 0;
			for (const [beatStart, peak, radius, decay] of beats) {
				const beatAge = t - beatStart;
				if (beatAge < 0) continue;
				if (dist > radius) continue;
				const waveDelay = dist * 0.12;
				const localAge = beatAge - waveDelay;
				if (localAge < 0) continue;
				const attack = Math.min(localAge / 0.05, 1);
				const decayFactor = Math.exp(-localAge * decay);
				bright = Math.max(bright, peak * attack * decayFactor);
			}

			// Settle toward resting level (t=1.0-2.0)
			if (t > 1.0) {
				const settleT = Math.min((t - 1.0) / 1.0, 1);
				const rest = 0.25 + Math.sin(this.doneCellPhases[i] ?? 0) * 0.03;
				bright = lerp(bright, rest, settleT * settleT);
			}

			if (bright > 0.01) {
				// Write directly to both current (B) and target (TB) for instant response
				this.cells[off + B] = Math.max(this.cells[off + B], bright);
				this.cells[off + TB] = Math.max(this.cells[off + TB], bright);
				this.cells[off + TH] = 4.0;
				this.cells[off + H] = 4.0; // snap hue too — no interpolation lag
				this.cells[off + DR] = 12.0; // fast tracking
				this.cells[off + YO] = bright > 0.7 ? -bright * 1.2 : 0;
			}
		}
	}

	private tickDoneResting(dt: number): void {
		// Gentle emerald breathing — per-cell phase offset for organic feel
		const breathFreq = Math.PI / 2; // ~4s full cycle
		for (let i = 0; i < this.cellCount; i++) {
			const off = i * STRIDE;
			const phase = this.doneCellPhases[i] ?? 0;
			const breath =
				0.25 + Math.sin(this.doneTimer * breathFreq + phase) * 0.05;
			this.cells[off + TB] += (breath - this.cells[off + TB]) * dt * 2;
			this.cells[off + TH] += (4.0 - this.cells[off + TH]) * dt * 3;
			this.cells[off + DR] = 1.5;
			this.cells[off + YO] = 0;
		}
	}

	// ── Idle ─────────────────────────────────────────────────────────────

	private tickIdle(dt: number): void {
		this.idleTimer += dt;

		// Decay all cells toward dark — but gently, so twinkles linger
		for (let i = 0; i < this.cellCount; i++) {
			const off = i * STRIDE;
			this.cells[off + TB] = Math.max(0, this.cells[off + TB] - dt * 0.3);
			this.cells[off + TH] = 0; // keep violet
			this.cells[off + DR] = 0.8;
			this.cells[off + YO] = 0;
		}

		// Occasional soft twinkle — wider cluster around a center cell.
		// Mean interval ~1.33s (was `Math.random() < dt * 0.75` which broke
		// with large dt, firing every frame at low fps).
		if (this.idleTimer >= this.nextIdleTwinkle) {
			this.idleTimer -= this.nextIdleTwinkle;
			this.nextIdleTwinkle = 0.5 + Math.random() * 1.5;
			const center = Math.floor(Math.random() * this.cellCount);
			const centerCol = center % this.cols;
			const centerRow = Math.floor(center / this.cols);
			// Center cell brightest
			this.cells[center * STRIDE + TB] = 0.3 + Math.random() * 0.26;
			this.cells[center * STRIDE + DR] = 0.5;
			// 5×5 spread — inner ring bright, outer ring dimmer
			for (let dr = -2; dr <= 2; dr++) {
				for (let dc = -2; dc <= 2; dc++) {
					if (dr === 0 && dc === 0) continue;
					const nr = centerRow + dr;
					const nc = centerCol + dc;
					if (nr < 0 || nr >= ROWS || nc < 0 || nc >= this.cols) continue;
					const dist = Math.max(Math.abs(dr), Math.abs(dc));
					const nOff = (nr * this.cols + nc) * STRIDE;
					if (dist === 1) {
						this.cells[nOff + TB] = Math.max(
							this.cells[nOff + TB],
							0.15 + Math.random() * 0.2,
						);
						this.cells[nOff + DR] = 0.4;
					} else {
						this.cells[nOff + TB] = Math.max(
							this.cells[nOff + TB],
							0.08 + Math.random() * 0.12,
						);
						this.cells[nOff + DR] = 0.3;
					}
				}
			}
		}
	}

	// ── Interpolation & render ───────────────────────────────────────────

	private interpolateCells(dt: number): void {
		for (let i = 0; i < this.cellCount; i++) {
			const off = i * STRIDE;
			const rate = this.cells[off + DR];
			const t = Math.min(dt * rate, 1);
			this.cells[off + B] += (this.cells[off + TB] - this.cells[off + B]) * t;
			this.cells[off + H] += (this.cells[off + TH] - this.cells[off + H]) * t;
		}
	}

	/** Headless fast-path: snap current values to targets without smooth
	 *  interpolation. Saves per-cell multiply/add when nobody sees the result. */
	private snapCells(): void {
		for (let i = 0; i < this.cellCount; i++) {
			const off = i * STRIDE;
			this.cells[off + B] = this.cells[off + TB];
			this.cells[off + H] = this.cells[off + TH];
		}
	}

	private render(): void {
		let totalBrightness = 0;

		for (let i = 0; i < this.cellCount; i++) {
			const el = this.elements[i];
			if (!el) continue;

			const off = i * STRIDE;
			let brightness = this.cells[off + B];
			const hue = this.cells[off + H];
			const yOffset = this.cells[off + YO];

			// Apply power envelope with per-cell cascade
			if (
				this.powerState === "powering-on" ||
				this.powerState === "powering-off"
			) {
				const delay = this.powerTimers[i] ?? 0;
				const cellPower = Math.max(
					0,
					Math.min(1, (this.powerProgress - delay * 0.6) / 0.4),
				);
				brightness *= cellPower;
			}

			totalBrightness += brightness;

			// Unlit LED base — cells are always physically present, just dark when off
			const base = `width:${CELL_SIZE}px;height:${CELL_SIZE}px;border-radius:1.5px;will-change:transform;`;

			if (brightness < 0.02) {
				el.style.cssText = `${base}background:rgba(139,92,246,0.06);`;
				continue;
			}

			// Boost opacity so peaks punch to full white — dims stay dim.
			const opacity = Math.min(1, brightness * 1.7);

			const color = cellColor(brightness, hue);
			const shadow =
				brightness > 0.25
					? `0 0 ${(brightness * 6).toFixed(1)}px ${cellColor(brightness * 0.6, hue)}`
					: "none";
			const transform =
				yOffset !== 0 ? `translateY(${yOffset.toFixed(1)}px)` : "none";

			el.style.cssText = `${base}background:${color};box-shadow:${shadow};transform:${transform};opacity:${opacity.toFixed(2)};`;
		}

		// Pulse container border glow with average brightness
		if (this.container) {
			const avg = this.cellCount > 0 ? totalBrightness / this.cellCount : 0;
			if (avg > 0.02) {
				const isDone = this.mode === "done";
				const isError =
					this.mode === "error-recovering" || this.mode === "error-fatal";
				const glowColor = isDone
					? "16,185,129"
					: isError
						? "244,63,94"
						: "139,92,246";
				this.container.style.boxShadow = `0 0 ${(avg * 12).toFixed(1)}px rgba(${glowColor},${(avg * 0.3).toFixed(2)})`;
			} else {
				this.container.style.boxShadow = "none";
			}
		}
	}
}
