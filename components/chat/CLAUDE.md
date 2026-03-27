# Chat Components

## ChatSidebar

Message list + input. Single instance that morphs between centered and sidebar layouts.

- **`centered` prop**: Hero mode below Logo, no header/border. Logo passed via `heroLogo` slot, animates to header via `layoutId="nova-logo"`.
- **`!centered`**: 320px (`w-80`) left sidebar with header + close button.
- **Layout morph**: Inner panel uses Motion `layout="position"` for GPU-accelerated position animation. Size/border/shadow transition via CSS `transition` on the panel div. One instance stays mounted across the transition.
- **Enter/exit**: Sidebar slides in/out (`x: -320`). Centered fades. Handled by outer `motion.div` with `AnimatePresence` in BuilderLayout.

**Layout**: scrollable messages → SignalGrid (permanent, `shrink-0`) → ChatInput (`shrink-0`). The SignalGrid panel sits between messages and input, never scrolls.

**Scroll management** — Smart auto-scroll via `scrollRef` callback:
- **Near-bottom tracking**: Only auto-scrolls on new content (MutationObserver + ResizeObserver) when user was within 50px of bottom. Scrolling up "detaches" from auto-follow.
- **User hold detection**: `mousedown` on scroll container suppresses all auto-scroll; `mouseup` re-enables.
- **Cross-instance persistence**: Module-level `chatScrollPinned` + `chatScrollTop` survive center→sidebar transitions and panel close/reopen.
- **Animation-aware pinning**: 600ms rAF loop on mount keeps pinning to bottom during layout animation, catching post-reflow height changes.
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

Reusable sci-fi panel chrome — bezels, notches, indicator LED, display well, etched label. Used by both SignalGrid (chat) and the signal test page. Props: `active`, `label`, `children`. Exports `signalLabel(mode)` for default mode→label mapping.

**Label animation** — `AnimatePresence mode="wait"` crossfades the base label on mode change (0.75s fade). Optional `suffix` prop (e.g. elapsed timer) fades in once on appearance but updates in place without retriggering the crossfade.

**Panel chrome** — top bezel (corner notches, groove lines, status LED), recessed display well, bottom bezel with etched label. Grooves/notches are static (never change with state). Label shows "SYS:IDLE" when inactive, phase-specific text when active. Indicator LED pulses slowly (3s cycle) when active, decays over 1.5s on deactivation. Entire panel is `user-select: none`. CSS in `globals.css` under `.nova-panel*`.

## SignalGrid

Permanent neural activity panel. Always mounted between the scroll container and the chat input (`shrink-0`), never scrolls, never hides. Cells are physical LEDs that exist even when unlit.

**Modes** — derived in ChatSidebar from builder + useChat state:
- `idle` — slow wide twinkle clusters (5x5 spread, ~0.75/sec). Grid is alive but resting.
- `sending` — upward wave (bottom→top, left→right). Duration-normalized via `SEND_WAVE_DURATION` so one cycle takes the same time regardless of grid width. Forced for one wave cycle via `forceSending` in ChatSidebar.
- `reasoning` — random neural firing correlated with reasoning token reception. Tracks `reasoning` + `text` part deltas on the last assistant message → `builder.injectEnergy(delta * 2)`. Ambient firing speed scales with energy level.
- `building` — rhythmic two-column sweep + data-part bursts (module/form completions flash bright cyan).

**Elapsed timer** — after 30s in reasoning or building mode, ChatSidebar appends a suffix like "(30s)", "(1m 12s)" via the `suffix` prop on SignalPanel. Fades in once, then ticks in place.

**Status labels** — `PHASE_LABELS` in `builder.ts` is the single source of truth for build-phase status text shown in the panel. No ellipses — the neurons and timer convey activity.

**Architecture** — two-layer: `SignalGridController` (imperative class in `lib/signalGridController.ts`) owns cell state and the rAF animation loop, writes directly to DOM via `style.cssText`. `SignalGrid` (React component) creates/destroys the controller via a stable ref callback, forwards mode changes via `useEffect`, and tracks message content deltas.

**Energy pipeline** — `builder.injectEnergy(amount)` / `builder.drainEnergy()` are non-versioned (no React re-renders). Energy injected from: message content deltas (reasoning tokens, 2x multiplier), `applyDataPart()` bursts, and the intro sequence. Controller reads via `consumeEnergy()` each animation frame.

**Intro sequence** — on page load, ChatSidebar's `WelcomeIntro` component temporarily sets mode to `reasoning` and injects energy bursts timed with the staggered welcome text fade-in.

**Density scaling** — all per-frame activation counts scale with `cellCount / 93` (reference: sidebar at 280px) so narrow and wide grids have the same visual density.
