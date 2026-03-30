# Chat Components

## ChatSidebar

Message list + input. Single instance that morphs between centered and sidebar layouts.

- **`centered` prop**: Hero mode below Logo, no header/border. Logo passed via `heroLogo` slot, animates to header via `layoutId="nova-logo"`.
- **`!centered`**: 320px (`w-80`) left sidebar with header + close button.
- **Layout morph**: Inner panel uses Motion `layout="position"` for GPU-accelerated position animation, enabled only during the 500ms centered↔sidebar transition (via `morphing` state). Disabled otherwise to prevent unwanted animations when toolbar/headers resize the content area. Size/border/shadow transition via CSS `transition` on the panel div. One instance stays mounted across the transition.
- **Enter/exit**: Sidebar slides in/out (`x: -320`). Centered fades. Handled by outer `motion.div` with `AnimatePresence` in BuilderLayout.

**Layout**: scrollable messages → SignalGrid (permanent, `shrink-0`) → ChatInput (`shrink-0`). The SignalGrid panel sits between messages and input, never scrolls.

**Scroll management** — Smart auto-scroll via `scrollRef` callback:
- **Near-bottom tracking**: Only auto-scrolls on new content (MutationObserver + ResizeObserver) when user was within 50px of bottom. Scrolling up "detaches" from auto-follow.
- **User hold detection**: `mousedown` on scroll container suppresses all auto-scroll; `mouseup` re-enables.
- **Cross-instance persistence**: Module-level `chatScrollPinned` + `chatScrollTop` survive center→sidebar transitions and panel close/reopen.
- **Animation-aware pinning**: 600ms rAF loop on mount keeps pinning to bottom during initial layout animation. Separate morph-aware rAF loop (tied to `morphing` state) anchors scroll during center↔sidebar transitions — captures pin-to-bottom intent and absolute scrollTop at morph start, overrides every frame to defeat the ResizeObserver/onScroll race condition where the browser's scrollTop clamping falsely clears `isNearBottomRef`.
- **Question card auto-scroll**: Detects new `input-available` askQuestions parts and `scrollIntoView({ block: 'nearest' })` unless user is holding scrollbar.

## ChatMessage

Iterates `message.parts`:
- `text` parts → text bubbles (assistant: `renderMarkdown()`, user: plain `whitespace-pre-wrap`)
- `tool-askQuestions` parts → `QuestionCard`
- All other tool/data parts → ignored (handled by `onData` in BuilderLayout)

## QuestionCard

Animated stepper with local state. Shows questions one at a time with option buttons. Answered questions display as checkmark + answer. Calls `addToolOutput` when all answered. Outer div carries `data-question-card` attribute (`'waiting'` | `'done'` | `'loading'`) for scroll targeting by ChatSidebar.

**`pendingAnswerRef`** — when user types while a question is waiting, ChatSidebar routes through this ref instead of sending a chat message. Typed answers prefixed with `"User Responded: "` so the SA knows it's free-form text.

## SignalPanel

Reusable sci-fi panel chrome — bezels, notches, indicator LED, display well, etched label. Used by both SignalGrid (chat) and the signal test page. Props: `active`, `label`, `suffix?`, `error?`, `recovering?`, `done?`, `children`. `defaultLabel(mode)` in `signalGridController.ts` provides default mode→label mapping. LED/label color by state: `recovering` = amber (`data-recovering`), `error` = rose (`data-error`), `done` = emerald (`data-done`). CSS in `globals.css` under `.nova-panel*`.

**Label animation** — `AnimatePresence mode="wait"` crossfades the base label on mode change (0.75s fade). Optional `suffix` prop (e.g. elapsed timer) fades in once on appearance but updates in place without retriggering the crossfade.

**Panel chrome** — top bezel (corner notches, groove lines, status LED), recessed display well, bottom bezel with etched label. Grooves/notches are static (never change with state). Label shows "SYS:IDLE" when inactive, phase-specific text when active. Indicator LED pulses slowly (3s cycle) when active, decays over 1.5s on deactivation. Entire panel is `user-select: none`. CSS in `globals.css` under `.nova-panel*`.

## SignalGrid

Permanent neural activity panel. Always mounted between the scroll container and the chat input (`shrink-0`), never scrolls, never hides. Cells are physical LEDs that exist even when unlit.

**Modes** — derived in ChatSidebar from builder + useChat state:
- `idle` — slow wide twinkle clusters (5x5 spread, ~0.75/sec). Grid is alive but resting. Also used after post-build edits where the SA only asked questions (no blueprint mutations) — the grid rests while awaiting user input.
- `sending` — upward wave (bottom→top, left→right). Duration-normalized via `SEND_WAVE_DURATION` so one cycle takes the same time regardless of grid width. Queued via `controller.setMode('sending')` in ChatSidebar. Three triggers: (1) user's initial message, (2) completed question block, (3) post-build edit messages.
- `reasoning` — pure backplate: random neural firing with hue drift toward cyan. The canonical "thinking" visual.
- `scaffolding` — backplate (reduced intensity) + tetris progress bar foreground. Pre-computed `TilingPlan` fills the 3×N grid left→right with L/J-tetromino, step, square, and column pieces. Two animation tiers based on catch-up gap:
  - **Full animation** (speed < 3.0): rejected pieces preview (pink) → winning piece rotates through quarter turns (muted violet-cyan) → double-flash select → slide left to landing → lock. Slower cruise pace (speed 0.4–1.5) for a leisurely feel when keeping pace.
  - **Rush mode** (speed >= 3.0): skips rejected previews, rotation, and select flash. Piece appears pre-selected at its final rotation 5 cols out and slides directly in. ~4x faster per-piece than full animation. Triggers on large gaps (>30% of board) and completion catch-up.
  External progress (`scaffoldTarget`) acts as a **speed signal**: large gap = rush catch-up, small gap = slow cruise with full theatrics, zero gap = breathing front (oscillating pink energy bar on the fill-front columns). `SCAFFOLD_TEMPO` (1.5) scales all phase durations; per-piece `speed` (0.4–4.0) is dynamically updated each frame from the gap. Lock phase scales by `max(speed, 1.0)` so rush pieces lock faster while slow pieces keep a crisp flash. `canReachFromRight` + `nextCellFillable` lookahead prevent unreachable pockets.
- `building` — pink scanner beam sweep + delivery bursts + backplate. The sweep uses bubblegum pink (negative hue) to contrast the cyan thinking cells. Burst energy drives flashes; think energy drives neural firing layered on top.
- `editing` — defrag-style animation + backplate. A 2-column bubblegum pink bar performs tracked pick-move-drop operations within a focus zone: **Seek** → **Select** (double-flash) → **Crawl** → **Place**. Think layer fires underneath.
- `error-recovering` — backplate with `warmProb: 0.35` for ~35% warm amber hues, no hue drift. Panel LED/label amber.
- `error-fatal` — erratic warm flicker settling into dim rose-pink pulse. Panel LED/label rose.
- `done` — "du-du-DONEE" 3-beat radial celebration → resting emerald breathing pulse. Panel LED/label emerald. Triggers after initial build completion and after post-build edits where the SA actually mutated the blueprint (even without `validateApp`). Does NOT trigger when the SA only asked questions — that goes to `idle` instead. Exiting done snaps hue to cyan (or 3.0 for scaffolding) so interpolation never passes through the warm error tone range (1.0–3.0).

**Elapsed timer** — after 30s in the current step, ChatSidebar appends a suffix like "(30s)", "(1m 12s)" via the `suffix` prop on SignalPanel. Resets when the controller's active label changes. Only runs during active work stages (`reasoning`, `scaffolding`, `building`, `editing`); skipped for non-progressing states (`idle`, `sending`, `done`, `error-recovering`, `error-fatal`).

**Architecture** — `SignalGridController` (imperative class in `lib/signalGridController.ts`) is created in ChatSidebar and passed to SignalGrid as a prop. ChatSidebar owns mode/label state and calls `controller.setMode(mode, label)`. The controller queues transitions when the current animation hasn't settled (e.g., sending wave must complete). `setOnModeApplied` callback notifies React of the actually-applied mode/label — both ChatSidebar and the signal test page use this to defer label updates until the animation actually transitions. `SignalGrid` attaches the controller to the DOM via ref callback.

**Backplate** — `tickBackplate()` is the shared background neural activity layer used by reasoning, scaffolding, building, editing, and error-recovering. It encapsulates four steps: (1) sending fade — decaying violet brightness floor after the sending wave, (2) think layer — `tickThinkLayer()` for neural firing (mutates `BackplateState` in place), (3) hue drift — active cells drift toward a target hue (cyan by default, disabled for error/scaffolding), (4) decay + YO reset. Configured via `BackplateOpts`: `think` (ThinkLayerOpts pass-through), `hueDriftTarget`/`hueDriftRate` (hue drift), `decayRate` (brightness decay speed), `decayFilter` (`(row, col) => boolean`, e.g. scaffolding's filled board). Building and editing share `FOREGROUND_BACKPLATE_OPTS` (faster decay, no hue drift). Scaffolding uses a `readonly` pre-allocated opts object whose `decayFilter` reads `this.scaffoldBoard` directly — zero per-frame allocations. Each mode has its own `BackplateState` (accum, ambientTimer, sendingFade) so state resets cleanly on transitions. Reasoning and error-recovering are pure backplate (1-line tickers). Scaffolding, building, and editing layer foreground animations on top.

**Energy pipeline** — two channels, both non-versioned (no React re-renders):
- **Burst energy** (`builder.injectEnergy` / `drainEnergy`) — from `applyDataPart()` (200 for module/form completions, 100 for updates, 50 for phase transitions) and the intro sequence. Drives building-mode flashes; combined into neural firing in reasoning mode.
- **Think energy** (`builder.injectThinkEnergy` / `drainThinkEnergy`) — from message content deltas: `text` + `reasoning` + `tool-*` input parts (2x multiplier). Drives reasoning-style neural firing in all modes. Tool input tracking (`JSON.stringify(part.input)`) captures energy during tool arg streaming, which is the bulk of build time.
Controller reads both via `consumeEnergy()` + `consumeThinkEnergy()` each animation frame.

**Color space** — `cellColor(brightness, hue)` maps hue to color: 0 = violet, 1 = cyan, <0 = pink (violet→bubblegum), >1 = warm error tones (1–1.5 = violet→amber, 1.5–2.0 = amber→rose), 3.0–4.0 = cyan→emerald (scaffolding fill / done celebration). Brightness >0.55 blends toward white.

**Intro sequence** — on page load, ChatSidebar's `WelcomeIntro` component temporarily sets mode to `reasoning` and injects energy bursts timed with the staggered welcome text fade-in.

**Density scaling** — all per-frame activation counts scale with `cellCount / 93` (reference: sidebar at 280px) so narrow and wide grids have the same visual density.
