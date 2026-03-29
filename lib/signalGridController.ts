// ── Color constants (pre-computed RGB for interpolation) ──────────────

const VIOLET = [139, 92, 246] as const   // #8b5cf6
const CYAN = [6, 182, 212] as const      // #06b6d4
const PINK = [255, 105, 140] as const    // bubblegum pink (building sweep)
const WHITE = [232, 232, 255] as const   // #e8e8ff (nova-text)
const AMBER = [245, 158, 11] as const    // #f59e0b (--nova-amber)
const ROSE = [244, 63, 94] as const      // #f43f5e (--nova-rose)

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

function cellColor(brightness: number, hue: number): string {
  // hue: 0 = violet, 1 = cyan, <0 = violet→pink (building sweep).
  //       >1 = warm error tones: 1–1.5 = violet→amber, 1.5–2.0 = amber→rose.
  // Negative hues decay back through violet on the way to cyan — all cool tones.
  let r, g, b
  if (hue > 1) {
    // Warm error tones
    if (hue <= 1.5) {
      const t = (hue - 1) * 2
      r = lerp(VIOLET[0], AMBER[0], t)
      g = lerp(VIOLET[1], AMBER[1], t)
      b = lerp(VIOLET[2], AMBER[2], t)
    } else {
      const t = Math.min((hue - 1.5) * 2, 1)
      r = lerp(AMBER[0], ROSE[0], t)
      g = lerp(AMBER[1], ROSE[1], t)
      b = lerp(AMBER[2], ROSE[2], t)
    }
  } else if (hue < 0) {
    const t = Math.min(-hue, 1)
    r = lerp(VIOLET[0], PINK[0], t)
    g = lerp(VIOLET[1], PINK[1], t)
    b = lerp(VIOLET[2], PINK[2], t)
  } else {
    r = lerp(VIOLET[0], CYAN[0], Math.min(hue, 1))
    g = lerp(VIOLET[1], CYAN[1], Math.min(hue, 1))
    b = lerp(VIOLET[2], CYAN[2], Math.min(hue, 1))
  }

  if (brightness > 0.55) {
    const whiteT = (brightness - 0.55) / 0.45
    return `rgb(${lerp(r, WHITE[0], whiteT)},${lerp(g, WHITE[1], whiteT)},${lerp(b, WHITE[2], whiteT)})`
  }
  return `rgb(${r},${g},${b})`
}

// ── Controller ───────────────────────────────────────────────────────

export type SignalMode = 'sending' | 'reasoning' | 'building' | 'editing' | 'error-recovering' | 'error-fatal' | 'idle'

/** Normalized zone (0-1) within the grid for editing focus. */
export interface EditFocus {
  /** Start of active zone, 0-1 inclusive. */
  start: number
  /** End of active zone, 0-1 inclusive. */
  end: number
}

/** Minimum zone width as a fraction of total columns (prevents tiny slivers). */
const MIN_EDIT_ZONE = 0.15
/** How fast the current zone lerps toward the target zone (per second). */
const EDIT_ZONE_LERP_SPEED = 3.0
/** One defrag op at a time — a single 2-column bar, just like building's sweep. */
const MAX_DEFRAG_OPS = 1

const enum DefragPhase { Seek, Select, Crawl, Place }

/** A tracked defrag operation — a vertical bar that selects, crawls, and places. */
interface DefragOp {
  srcCol: number
  dstCol: number
  /** Current fractional column position (animates during crawl and seek). */
  pos: number
  phase: DefragPhase
  /** Time spent in the current phase. */
  timer: number
  /** Crawl speed in columns per second (randomized per op for organic feel). */
  speed: number
  /** Seek: columns to jitter through before landing on srcCol. */
  seekStops: number[]
  seekIdx: number
}

interface ControllerOpts {
  /** Read and reset accumulated burst energy (data parts). Called once per animation frame. */
  consumeEnergy: () => number
  /** Read and reset accumulated think energy (token generation). Called once per animation frame. */
  consumeThinkEnergy: () => number
}

const ROWS = 3
/** Target duration (seconds) for one full sending wave cycle, regardless of grid width. */
export const SEND_WAVE_DURATION = 3.5
const CELL_SIZE = 6   // px
const CELL_GAP = 3    // px
const CELL_SLOT = CELL_SIZE + CELL_GAP

// Per-cell state indices in the flat Float64Array
const STRIDE = 6
const B = 0    // brightness (current)
const H = 1    // hue (current, 0=violet 1=cyan)
const TB = 2   // target brightness
const TH = 3   // target hue
const DR = 4   // decay rate (interpolation speed per second)
const YO = 5   // vertical offset in px

export class SignalGridController {
  private cells = new Float64Array(0)
  private cellCount = 0
  private cols = 0
  private elements: HTMLDivElement[] = []
  private container: HTMLDivElement | null = null

  private rafId = 0
  private lastTime = 0
  private mode: SignalMode = 'idle'
  private prevMode: SignalMode = 'idle'
  private modeT = 1 // blend factor 0..1 (1 = fully in current mode)

  private consumeEnergy: () => number
  private consumeThinkEnergy: () => number

  // Sending
  private wavePhase = 0

  // Reasoning
  private accumEnergy = 0
  private ambientTimer = 0

  // Building
  private sweepPhase = 0
  private buildThinkAccum = 0
  private buildAmbientTimer = 0

  // Editing (defrag)
  private editTarget: EditFocus = { start: 0, end: 1 }
  private editCurrent: EditFocus = { start: 0, end: 1 }
  private editOps: DefragOp[] = []
  private editSpawnTimer = 0
  private editThinkAccum = 0
  private editAmbientTimer = 0

  // Error fatal
  private fatalTimer = 0

  // Power state
  private powerState: 'off' | 'powering-on' | 'on' | 'powering-off' = 'off'
  private powerProgress = 0 // 0..1
  private powerTimers: number[] = [] // per-cell delay for cascade

  constructor(opts: ControllerOpts) {
    this.consumeEnergy = opts.consumeEnergy
    this.consumeThinkEnergy = opts.consumeThinkEnergy
  }

  // ── Lifecycle ────────────────────────────────────────────────────────

  attach(container: HTMLDivElement): void {
    this.container = container
    this.rebuildGrid()
    this.lastTime = performance.now()
    this.rafId = requestAnimationFrame(this.tick)
  }

  detach(): void {
    if (this.rafId) cancelAnimationFrame(this.rafId)
    this.rafId = 0
    this.elements = []
    this.container = null
  }

  resize(): void {
    if (!this.container) return
    const newCols = Math.max(1, Math.floor((this.contentWidth() + CELL_GAP) / CELL_SLOT))
    if (newCols === this.cols) return
    this.rebuildGrid()
  }

  private contentWidth(): number {
    if (!this.container) return 0
    const style = getComputedStyle(this.container)
    return this.container.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
  }

  private rebuildGrid(): void {
    if (!this.container) return
    const width = this.contentWidth()
    // Match CSS grid auto-fill: last column doesn't need a trailing gap
    this.cols = Math.max(1, Math.floor((width + CELL_GAP) / CELL_SLOT))
    const newCount = this.cols * ROWS

    // Preserve existing cell state where possible
    const oldCells = this.cells
    const oldCount = this.cellCount
    this.cells = new Float64Array(newCount * STRIDE)
    for (let i = 0; i < Math.min(oldCount, newCount); i++) {
      for (let s = 0; s < STRIDE; s++) {
        this.cells[i * STRIDE + s] = oldCells[i * STRIDE + s]
      }
    }
    // Default decay rate for new cells
    for (let i = oldCount; i < newCount; i++) {
      this.cells[i * STRIDE + DR] = 4.0
    }
    this.cellCount = newCount

    // Sync DOM elements
    while (this.container.firstChild) this.container.removeChild(this.container.firstChild)
    this.elements = []
    for (let i = 0; i < newCount; i++) {
      const el = document.createElement('div')
      el.style.cssText = `width:${CELL_SIZE}px;height:${CELL_SIZE}px;border-radius:1.5px;will-change:transform;`
      this.container.appendChild(el)
      this.elements.push(el)
    }
  }

  // ── Mode & power control ─────────────────────────────────────────────

  setMode(mode: SignalMode): void {
    if (mode === this.mode) return
    this.prevMode = this.mode
    this.mode = mode
    this.modeT = 0
    // Reset mode-specific state so animations start fresh
    if (mode === 'sending') this.wavePhase = 0
    if (mode === 'building') { this.sweepPhase = 0; this.buildThinkAccum = 0; this.buildAmbientTimer = 0 }
    if (mode === 'reasoning' || mode === 'error-recovering') { this.accumEnergy = 0; this.ambientTimer = 0 }
    if (mode === 'editing') { this.editOps = []; this.editSpawnTimer = 0; this.editThinkAccum = 0; this.editAmbientTimer = 0 }
    if (mode === 'error-fatal') this.fatalTimer = 0
  }

  /** Set the normalized focus zone for editing mode. Null = full width. */
  setEditFocus(focus: EditFocus | null): void {
    this.editTarget = focus ?? { start: 0, end: 1 }
  }

  powerOn(): void {
    if (this.powerState === 'on' || this.powerState === 'powering-on') return
    this.powerState = 'powering-on'
    this.powerProgress = 0
    // Compute per-cell cascade delays (center-out radial)
    const cx = (this.cols - 1) / 2
    const cy = (ROWS - 1) / 2
    let maxDist = 0
    this.powerTimers = []
    for (let i = 0; i < this.cellCount; i++) {
      const col = i % this.cols
      const row = Math.floor(i / this.cols)
      const d = Math.sqrt((col - cx) ** 2 + (row - cy) ** 2)
      this.powerTimers.push(d)
      if (d > maxDist) maxDist = d
    }
    // Normalize to 0..1
    if (maxDist > 0) {
      for (let i = 0; i < this.powerTimers.length; i++) {
        this.powerTimers[i] /= maxDist
      }
    }
  }

  powerOff(): void {
    if (this.powerState === 'off' || this.powerState === 'powering-off') return
    this.powerState = 'powering-off'
    this.powerProgress = 1
    // Top-down row cascade delays
    this.powerTimers = []
    for (let i = 0; i < this.cellCount; i++) {
      const row = Math.floor(i / this.cols)
      this.powerTimers.push(row / Math.max(1, ROWS - 1))
    }
  }

  // ── Animation loop ───────────────────────────────────────────────────

  private tick = (now: number): void => {
    const dt = Math.min((now - this.lastTime) / 1000, 0.05)
    this.lastTime = now

    // Advance mode blend
    if (this.modeT < 1) {
      this.modeT = Math.min(1, this.modeT + dt * 3.0) // 333ms blend
    }

    // Read and drain energy from both channels
    const burstEnergy = this.consumeEnergy()
    const thinkEnergy = this.consumeThinkEnergy()

    // Advance power state
    this.tickPower(dt)

    // Always tick and render — cells are physical LEDs, always present
    this.tickMode(dt, burstEnergy, thinkEnergy)
    this.interpolateCells(dt)
    this.render()

    this.rafId = requestAnimationFrame(this.tick)
  }

  private tickPower(dt: number): void {
    if (this.powerState === 'powering-on') {
      this.powerProgress = Math.min(1, this.powerProgress + dt * 2.5) // 400ms
      if (this.powerProgress >= 1) this.powerState = 'on'
    } else if (this.powerState === 'powering-off') {
      this.powerProgress = Math.max(0, this.powerProgress - dt * 3.3) // 300ms
      if (this.powerProgress <= 0) this.powerState = 'off'
    }
  }

  private tickMode(dt: number, burstEnergy: number, thinkEnergy: number): void {
    switch (this.mode) {
      case 'sending': this.tickSending(dt); break
      case 'reasoning': this.tickReasoning(dt, burstEnergy + thinkEnergy); break
      case 'building': this.tickBuilding(dt, burstEnergy, thinkEnergy); break
      case 'editing': this.tickEditing(dt, burstEnergy, thinkEnergy); break
      case 'error-recovering': this.tickErrorRecovering(dt, burstEnergy + thinkEnergy); break
      case 'error-fatal': this.tickErrorFatal(dt); break
      case 'idle': this.tickIdle(dt); break
    }
  }

  // ── Sending wave ─────────────────────────────────────────────────────

  private tickSending(dt: number): void {
    // Normalize phase offsets so the wave spans exactly one cycle across the grid,
    // preventing wrap-around where the tail bleeds into the bottom-left corner.
    const maxDelay = this.cols * 0.15 + (ROWS - 1) * 0.5
    const cycleLen = Math.PI + maxDelay // one sine half-period + full grid traversal
    this.wavePhase += dt * (cycleLen / SEND_WAVE_DURATION)
    const t = this.wavePhase % cycleLen

    for (let i = 0; i < this.cellCount; i++) {
      const col = i % this.cols
      const row = Math.floor(i / this.cols)
      const invertedRow = ROWS - 1 - row
      const delay = col * 0.15 + invertedRow * 0.5
      const localPhase = t - delay
      // Only show the positive half of sine, and only when the wave has reached this cell
      const wave = (localPhase > 0 && localPhase < Math.PI)
        ? Math.sin(localPhase)
        : 0
      const brightness = wave > 0 ? wave * 0.85 + 0.08 : 0.08
      const yShift = wave > 0 ? -wave * 1.5 : 0

      const off = i * STRIDE
      this.cells[off + TB] = brightness
      this.cells[off + TH] = 0 // pure violet
      this.cells[off + DR] = 8.0
      this.cells[off + YO] = yShift
    }
  }

  // ── Reasoning (token-correlated neural firing) ───────────────────────

  private tickReasoning(dt: number, energy: number): void {
    this.accumEnergy += energy

    // Scale activation counts so the same energy produces the same visual density
    // regardless of grid width. Reference: 93 cells (sidebar at 280px).
    const density = this.cellCount / 93

    // Convert energy to fires. Threshold scales inversely with density so wider
    // grids fire proportionally more cells from the same energy.
    const threshold = 7 / density
    let fires = Math.floor(this.accumEnergy / threshold)
    fires = Math.min(fires, Math.ceil(this.cellCount * 0.45))
    this.accumEnergy = Math.min(this.accumEnergy - fires * threshold, threshold * 8) // cap overflow

    // Large bursts: 1-3 small hotspots (center + 1-2 neighbors)
    if (fires >= 5) {
      const hotspots = Math.min(1 + Math.floor(Math.random() * 3), Math.floor(fires / 2))
      for (let h = 0; h < hotspots; h++) {
        const center = Math.floor(Math.random() * this.cellCount)
        const centerCol = center % this.cols
        const centerRow = Math.floor(center / this.cols)
        // Center cell — brightest
        const cOff = center * STRIDE
        this.cells[cOff + TB] = 0.7 + Math.random() * 0.3
        this.cells[cOff + TH] = 0.5 + Math.random() * 0.5 // pushed toward cyan
        this.cells[cOff + DR] = 2.0
        fires--
        // 1-2 random adjacent neighbors at lower intensity
        const neighborCount = 1 + Math.floor(Math.random() * 2)
        for (let n = 0; n < neighborCount && fires > 0; n++) {
          const dc = Math.floor(Math.random() * 3) - 1
          const dr = Math.floor(Math.random() * 3) - 1
          if (dc === 0 && dr === 0) continue
          const nc = centerCol + dc
          const nr = centerRow + dr
          if (nr < 0 || nr >= ROWS || nc < 0 || nc >= this.cols) continue
          const nOff = (nr * this.cols + nc) * STRIDE
          this.cells[nOff + TB] = 0.3 + Math.random() * 0.4
          this.cells[nOff + TH] = 0.4 + Math.random() * 0.4
          this.cells[nOff + DR] = 2.5
          fires--
        }
      }
    }

    // Scatter remaining fires — energy-driven cells punch above the ambient baseline
    for (let f = 0; f < fires; f++) {
      const idx = Math.floor(Math.random() * this.cellCount)
      const off = idx * STRIDE
      this.cells[off + TB] = 0.45 + Math.random() * 0.45 // 0.45-0.90: clearly above ambient
      this.cells[off + TH] = Math.random() * 0.7
      this.cells[off + DR] = 2.0 + Math.random()
    }

    // Ambient background hum — baseline neural activity even with zero energy.
    // Interval and count both scale with recent energy: more energy = faster firing.
    // At rest: ~every 120ms, 2-4 cells. With energy: up to every 40ms, 4-8 cells.
    const recentEnergy = Math.min(1, this.accumEnergy / 50) // 0..1 energy level
    const ambientInterval = 0.12 - recentEnergy * 0.08 // 120ms at rest → 40ms at peak
    const ambientBase = 2 + recentEnergy * 3             // 2-5 cells per tick

    this.ambientTimer += dt
    if (this.ambientTimer > ambientInterval) {
      this.ambientTimer -= ambientInterval
      const count = Math.max(1, Math.round((ambientBase + Math.random() * 2) * density))
      for (let a = 0; a < count; a++) {
        const idx = Math.floor(Math.random() * this.cellCount)
        const off = idx * STRIDE
        // Varied intensity — most cells get a gentle glow, some pop brighter
        const roll = Math.random()
        const ambientBrightness = roll < 0.7
          ? 0.15 + Math.random() * 0.2   // gentle glow
          : 0.3 + Math.random() * 0.25   // occasional brighter pop
        this.cells[off + TB] = Math.max(this.cells[off + TB], ambientBrightness)
        this.cells[off + TH] = Math.random()
        this.cells[off + DR] = 1.5 + Math.random() * 0.5
      }
    }

    // Drift active cell hues toward cyan over time
    for (let i = 0; i < this.cellCount; i++) {
      const off = i * STRIDE
      if (this.cells[off + B] > 0.05) {
        this.cells[off + TH] = Math.min(1, this.cells[off + TH] + dt * 0.4)
      }
    }

    // Decay targets toward dark
    for (let i = 0; i < this.cellCount; i++) {
      const off = i * STRIDE
      this.cells[off + TB] = Math.max(0, this.cells[off + TB] - dt * 0.7)
      this.cells[off + YO] = 0
    }
  }

  // ── Building (sweep + delivery bursts + thinking activity) ────────────

  private tickBuilding(dt: number, burstEnergy: number, thinkEnergy: number): void {
    this.sweepPhase += dt * 1.8

    // Pink scanner beam — bubblegum pink bars contrasting the cyan thinking cells.
    // Negative hue = pink; decays through violet back to cyan (all cool tones).
    const activeCol = Math.floor(this.sweepPhase % this.cols)
    const nextCol = (activeCol + 1) % this.cols
    const trailCol = (activeCol - 1 + this.cols) % this.cols
    for (let row = 0; row < ROWS; row++) {
      // Leading edge — bright bubblegum pink
      for (const col of [activeCol, nextCol]) {
        const off = (row * this.cols + col) * STRIDE
        this.cells[off + TB] = Math.max(this.cells[off + TB], 0.78)
        this.cells[off + TH] = -0.8
        this.cells[off + DR] = 5.0
        this.cells[off + YO] = -0.5
      }
      // Trailing glow — pinkish violet fade
      const tOff = (row * this.cols + trailCol) * STRIDE
      this.cells[tOff + TB] = Math.max(this.cells[tOff + TB], 0.35)
      this.cells[tOff + TH] = -0.35
      this.cells[tOff + DR] = 3.0
    }

    // Delivery bursts — only from data parts (UI-visible changes like module/form done)
    if (burstEnergy >= 150) {
      // Large burst: flash all cells bright cyan
      for (let i = 0; i < this.cellCount; i++) {
        const off = i * STRIDE
        this.cells[off + TB] = 0.85 + Math.random() * 0.15
        this.cells[off + TH] = 0.8 + Math.random() * 0.2
        this.cells[off + DR] = 1.5 // linger
      }
    } else if (burstEnergy >= 30) {
      // Small burst: activate random subset
      const count = Math.min(Math.floor(burstEnergy / 8), this.cellCount)
      for (let f = 0; f < count; f++) {
        const idx = Math.floor(Math.random() * this.cellCount)
        const off = idx * STRIDE
        this.cells[off + TB] = 0.5 + Math.random() * 0.3
        this.cells[off + TH] = 0.5
        this.cells[off + DR] = 3.0
      }
    }

    // Thinking activity — reasoning-style neural firing from token generation.
    // Token streaming (text, reasoning, tool args) isn't shown to the user,
    // so it manifests as thinking activity layered on top of the sweep.
    this.buildThinkAccum += thinkEnergy
    const density = this.cellCount / 93
    const threshold = 7 / density
    let fires = Math.floor(this.buildThinkAccum / threshold)
    fires = Math.min(fires, Math.ceil(this.cellCount * 0.35))
    this.buildThinkAccum = Math.min(this.buildThinkAccum - fires * threshold, threshold * 8)

    if (fires >= 5) {
      const hotspots = Math.min(1 + Math.floor(Math.random() * 3), Math.floor(fires / 2))
      for (let h = 0; h < hotspots; h++) {
        const center = Math.floor(Math.random() * this.cellCount)
        const centerCol = center % this.cols
        const centerRow = Math.floor(center / this.cols)
        const cOff = center * STRIDE
        this.cells[cOff + TB] = 0.7 + Math.random() * 0.3
        this.cells[cOff + TH] = 0.5 + Math.random() * 0.5
        this.cells[cOff + DR] = 2.0
        fires--
        const neighborCount = 1 + Math.floor(Math.random() * 2)
        for (let n = 0; n < neighborCount && fires > 0; n++) {
          const dc = Math.floor(Math.random() * 3) - 1
          const dr = Math.floor(Math.random() * 3) - 1
          if (dc === 0 && dr === 0) continue
          const nc = centerCol + dc
          const nr = centerRow + dr
          if (nr < 0 || nr >= ROWS || nc < 0 || nc >= this.cols) continue
          const nOff = (nr * this.cols + nc) * STRIDE
          this.cells[nOff + TB] = 0.3 + Math.random() * 0.4
          this.cells[nOff + TH] = 0.4 + Math.random() * 0.4
          this.cells[nOff + DR] = 2.5
          fires--
        }
      }
    }
    for (let f = 0; f < fires; f++) {
      const idx = Math.floor(Math.random() * this.cellCount)
      const off = idx * STRIDE
      this.cells[off + TB] = 0.45 + Math.random() * 0.45
      this.cells[off + TH] = Math.random() * 0.7
      this.cells[off + DR] = 2.0 + Math.random()
    }

    // Ambient hum while thinking — keeps grid alive between token chunks
    const recentThink = Math.min(1, this.buildThinkAccum / 50)
    const ambientInterval = 0.12 - recentThink * 0.08
    this.buildAmbientTimer += dt
    if (this.buildAmbientTimer > ambientInterval) {
      this.buildAmbientTimer -= ambientInterval
      const count = Math.max(1, Math.round((2 + recentThink * 2 + Math.random() * 2) * density))
      for (let a = 0; a < count; a++) {
        const idx = Math.floor(Math.random() * this.cellCount)
        const off = idx * STRIDE
        const roll = Math.random()
        const ambientBrightness = roll < 0.7
          ? 0.15 + Math.random() * 0.2
          : 0.3 + Math.random() * 0.25
        this.cells[off + TB] = Math.max(this.cells[off + TB], ambientBrightness)
        this.cells[off + TH] = Math.random()
        this.cells[off + DR] = 1.5 + Math.random() * 0.5
      }
    }

    // Decay targets
    for (let i = 0; i < this.cellCount; i++) {
      const off = i * STRIDE
      this.cells[off + TB] = Math.max(0, this.cells[off + TB] - dt * 1.2)
      this.cells[off + YO] = 0
    }
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

  private tickEditing(dt: number, burstEnergy: number, thinkEnergy: number): void {
    // Smooth-lerp the current zone toward the target
    this.editCurrent.start += (this.editTarget.start - this.editCurrent.start) * Math.min(dt * EDIT_ZONE_LERP_SPEED, 1)
    this.editCurrent.end += (this.editTarget.end - this.editCurrent.end) * Math.min(dt * EDIT_ZONE_LERP_SPEED, 1)

    const startCol = Math.floor(this.editCurrent.start * this.cols)
    const endCol = Math.min(Math.ceil(this.editCurrent.end * this.cols), this.cols)
    const zoneCols = Math.max(1, endCol - startCol)
    const density = this.cellCount / 93

    // ── Defrag bar — one 2-column bar at a time, like building's sweep ──
    // Immediately spawn a new op when the previous one finishes.
    if (this.editOps.length < MAX_DEFRAG_OPS) {
      const src = startCol + Math.floor(Math.random() * zoneCols)
      let dst = startCol + Math.floor(Math.random() * zoneCols)
      if (Math.abs(dst - src) < 2) dst = src + (Math.random() < 0.5 ? -2 : 2)
      dst = Math.max(startCol, Math.min(endCol - 1, dst))
      if (dst === src) dst = src < endCol - 1 ? src + 1 : src - 1
      dst = Math.max(startCol, Math.min(endCol - 1, dst))

      // Generate seek stops — mix of jumps and adjacent moves.
      // ~40% chance each stop is adjacent to the previous (±1-2 cols),
      // creating clusters where the bar "inspects a region" before jumping.
      const seekCount = 4 + Math.floor(Math.random() * 5)
      const seekStops: number[] = []
      let prev = startCol + Math.floor(Math.random() * zoneCols)
      seekStops.push(prev)
      for (let s = 1; s < seekCount; s++) {
        if (Math.random() < 0.8) {
          // Adjacent move — nudge ±1-2 columns from previous
          const nudge = (Math.random() < 0.5 ? -1 : 1) * (1 + Math.floor(Math.random() * 2))
          prev = Math.max(startCol, Math.min(endCol - 1, prev + nudge))
        } else {
          // Jump to a random column
          prev = startCol + Math.floor(Math.random() * zoneCols)
        }
        seekStops.push(prev)
      }
      seekStops.push(src) // final stop is the actual source

      this.editOps.push({
        srcCol: src,
        dstCol: dst,
        pos: seekStops[0],
        phase: DefragPhase.Seek,
        timer: 0,
        speed: (zoneCols * 0.16) + Math.random() * (zoneCols * 0.12),
        seekStops,
        seekIdx: 0,
      })
    }

    // ── Advance the active operation ────────────────────────────────
    const op = this.editOps[0]
    if (op) {
      op.timer += dt
      const dir = op.dstCol > op.srcCol ? 1 : -1

      // Pick the adjacent column for a 2-wide bar, always staying inside the zone.
      // Prefer the dir side, fall back to the other side.
      const pairCol = (col: number): number => {
        const preferred = col + dir
        if (preferred >= startCol && preferred < endCol) return preferred
        const fallback = col - dir
        if (fallback >= startCol && fallback < endCol) return fallback
        return col // zone is 1 col wide, no pair possible
      }

      switch (op.phase) {
        case DefragPhase.Seek: {
          // Hunt: dim bar jitters through a few random columns before
          // landing on the source. Each stop gets a brief dim flash.
          const t = op.timer
          const dwell = 0.54 // time per stop
          const col = op.seekStops[op.seekIdx]
          // Seek has no direction — pick whichever adjacent column fits
          const pair = (col + 1 < endCol) ? col + 1 : Math.max(startCol, col - 1)

          // Dim flash at current stop — subtle, not full brightness
          const flash = Math.max(0, 1 - (t / dwell))
          for (const c of [col, pair]) this.lightColumnY(c, 0.25 + flash * 0.2, -0.4, 6.0, 0)

          if (t >= dwell) {
            op.seekIdx++
            op.timer = 0
            if (op.seekIdx >= op.seekStops.length) {
              op.phase = DefragPhase.Select
              op.timer = 0
            }
          }
          break
        }
        case DefragPhase.Select: {
          // Double-click: two sharp flashes with a short forced-dark gap.
          const t = op.timer
          const src = op.srcCol
          const srcPair = pairCol(src)

          if (t < 0.10) {
            for (const c of [src, srcPair]) this.lightColumnY(c, 0.95, -0.8, 8.0, -1.5)
          } else if (t < 0.25) {
            for (const c of [src, srcPair]) this.dimColumn(c, 10.0)
          } else if (t < 0.35) {
            for (const c of [src, srcPair]) this.lightColumnY(c, 0.95, -0.8, 8.0, -1.5)
          } else {
            for (const c of [src, srcPair]) this.lightColumnY(c, 0.95, -0.8, 5.0, -0.8)
          }

          if (t >= 0.45) {
            op.phase = DefragPhase.Crawl
            op.timer = 0
            op.pos = op.srcCol
          }
          break
        }
        case DefragPhase.Crawl: {
          // Drag: full flash brightness, lifted — actively moving.
          op.pos += dir * op.speed * dt

          const col = Math.round(op.pos)
          const lead = Math.max(startCol, Math.min(endCol - 1, col))
          const pair = pairCol(lead)
          this.lightColumnY(lead, 0.95, -0.8, 5.0, -0.8)
          this.lightColumnY(pair, 0.95, -0.8, 5.0, -0.8)

          // Trailing glow
          const trail = lead - dir
          if (trail >= startCol && trail < endCol) {
            this.lightColumn(trail, 0.15, -0.3, 3.5)
          }

          if ((dir > 0 && op.pos >= op.dstCol) || (dir < 0 && op.pos <= op.dstCol)) {
            op.phase = DefragPhase.Place
            op.timer = 0
          }
          break
        }
        case DefragPhase.Place: {
          // Drop: forced dark gap, then single flash, then fade.
          const t = op.timer
          const dst = op.dstCol
          const dstPair = pairCol(dst)

          if (t < 0.20) {
            for (const c of [dst, dstPair]) this.dimColumn(c, 10.0)
          } else if (t < 0.32) {
            for (const c of [dst, dstPair]) this.lightColumnY(c, 0.95, -0.8, 6.0, 0.8)
          } else {
            const fade = Math.max(0, 1 - (t - 0.32) / 0.33)
            for (const c of [dst, dstPair]) this.lightColumnY(c, fade * 0.5, -0.5, 3.0, 0.8 * fade)
          }

          if (t >= 0.65) {
            this.editOps.length = 0
          }
          break
        }
      }
    }

    // ── Delivery bursts — from data parts (form updated, blueprint updated) ──
    if (burstEnergy >= 100) {
      for (let row = 0; row < ROWS; row++) {
        for (let col = startCol; col < endCol; col++) {
          const off = (row * this.cols + col) * STRIDE
          this.cells[off + TB] = 0.8 + Math.random() * 0.2
          this.cells[off + TH] = 0.8 + Math.random() * 0.2
          this.cells[off + DR] = 1.5
        }
      }
    } else if (burstEnergy >= 30) {
      const count = Math.min(Math.floor(burstEnergy / 6), zoneCols * ROWS)
      for (let f = 0; f < count; f++) {
        const col = startCol + Math.floor(Math.random() * zoneCols)
        const row = Math.floor(Math.random() * ROWS)
        const off = (row * this.cols + col) * STRIDE
        this.cells[off + TB] = 0.5 + Math.random() * 0.35
        this.cells[off + TH] = 0.6 + Math.random() * 0.3
        this.cells[off + DR] = 2.5
      }
    }

    // ── Thinking activity — full-grid reasoning-style neural firing ─────
    // Identical to building mode's think layer: fires across the entire grid,
    // not constrained to the zone. The defrag bars are the zone-specific part;
    // this is the independent background layer underneath.
    this.editThinkAccum += thinkEnergy + burstEnergy
    const thinkThreshold = 7 / density
    let fires = Math.floor(this.editThinkAccum / thinkThreshold)
    fires = Math.min(fires, Math.ceil(this.cellCount * 0.35))
    this.editThinkAccum = Math.min(this.editThinkAccum - fires * thinkThreshold, thinkThreshold * 8)

    if (fires >= 5) {
      const hotspots = Math.min(1 + Math.floor(Math.random() * 3), Math.floor(fires / 2))
      for (let h = 0; h < hotspots; h++) {
        const center = Math.floor(Math.random() * this.cellCount)
        const centerCol = center % this.cols
        const centerRow = Math.floor(center / this.cols)
        const cOff = center * STRIDE
        this.cells[cOff + TB] = 0.7 + Math.random() * 0.3
        this.cells[cOff + TH] = 0.5 + Math.random() * 0.5
        this.cells[cOff + DR] = 2.0
        fires--
        const neighborCount = 1 + Math.floor(Math.random() * 2)
        for (let n = 0; n < neighborCount && fires > 0; n++) {
          const dc = Math.floor(Math.random() * 3) - 1
          const dr = Math.floor(Math.random() * 3) - 1
          if (dc === 0 && dr === 0) continue
          const nc = centerCol + dc
          const nr = centerRow + dr
          if (nr < 0 || nr >= ROWS || nc < 0 || nc >= this.cols) continue
          const nOff = (nr * this.cols + nc) * STRIDE
          this.cells[nOff + TB] = 0.3 + Math.random() * 0.4
          this.cells[nOff + TH] = 0.4 + Math.random() * 0.4
          this.cells[nOff + DR] = 2.5
          fires--
        }
      }
    }
    for (let f = 0; f < fires; f++) {
      const idx = Math.floor(Math.random() * this.cellCount)
      const off = idx * STRIDE
      this.cells[off + TB] = 0.45 + Math.random() * 0.45
      this.cells[off + TH] = Math.random() * 0.7
      this.cells[off + DR] = 2.0 + Math.random()
    }

    // ── Ambient hum — full-grid baseline activity between token chunks ──
    const recentThink = Math.min(1, this.editThinkAccum / 50)
    const ambientInterval = 0.12 - recentThink * 0.08
    this.editAmbientTimer += dt
    if (this.editAmbientTimer > ambientInterval) {
      this.editAmbientTimer -= ambientInterval
      const count = Math.max(1, Math.round((2 + recentThink * 2 + Math.random() * 2) * density))
      for (let a = 0; a < count; a++) {
        const idx = Math.floor(Math.random() * this.cellCount)
        const off = idx * STRIDE
        const roll = Math.random()
        const ambientBrightness = roll < 0.7
          ? 0.15 + Math.random() * 0.2
          : 0.3 + Math.random() * 0.25
        this.cells[off + TB] = Math.max(this.cells[off + TB], ambientBrightness)
        this.cells[off + TH] = Math.random()
        this.cells[off + DR] = 1.5 + Math.random() * 0.5
      }
    }

    // ── Decay ──
    for (let i = 0; i < this.cellCount; i++) {
      const off = i * STRIDE
      this.cells[off + TB] = Math.max(0, this.cells[off + TB] - dt * 1.2)
      this.cells[off + YO] = 0
    }
  }

  /** Light an entire column (all rows) — used by defrag ops for vertical bar effect. */
  private lightColumn(col: number, brightness: number, hue: number, decay: number): void {
    for (let row = 0; row < ROWS; row++) {
      const off = (row * this.cols + col) * STRIDE
      this.cells[off + TB] = Math.max(this.cells[off + TB], brightness)
      this.cells[off + TH] = hue
      this.cells[off + DR] = decay
    }
  }

  /** Force a column dark — actively pulls brightness toward 0 at the given rate.
   *  Unlike lightColumn (which uses max), this overrides to drive cells down. */
  private dimColumn(col: number, decayRate: number): void {
    for (let row = 0; row < ROWS; row++) {
      const off = (row * this.cols + col) * STRIDE
      this.cells[off + TB] = 0
      this.cells[off + DR] = decayRate
    }
  }

  /** Light an entire column with a vertical offset — for lifted/dropped bar states. */
  private lightColumnY(col: number, brightness: number, hue: number, decay: number, yOffset: number): void {
    for (let row = 0; row < ROWS; row++) {
      const off = (row * this.cols + col) * STRIDE
      this.cells[off + TB] = Math.max(this.cells[off + TB], brightness)
      this.cells[off + TH] = hue
      this.cells[off + DR] = decay
      this.cells[off + YO] = yOffset
    }
  }

  // ── Error recovering ("sprinkle some red" — reasoning with distress) ─

  private tickErrorRecovering(dt: number, energy: number): void {
    this.accumEnergy += energy
    const density = this.cellCount / 93

    const threshold = 7 / density
    let fires = Math.floor(this.accumEnergy / threshold)
    fires = Math.min(fires, Math.ceil(this.cellCount * 0.45))
    this.accumEnergy = Math.min(this.accumEnergy - fires * threshold, threshold * 8)

    // Same hotspot/scatter pattern as reasoning, but ~35% of cells get warm error hues
    if (fires >= 5) {
      const hotspots = Math.min(1 + Math.floor(Math.random() * 3), Math.floor(fires / 2))
      for (let h = 0; h < hotspots; h++) {
        const center = Math.floor(Math.random() * this.cellCount)
        const centerCol = center % this.cols
        const centerRow = Math.floor(center / this.cols)
        const warm = Math.random() < 0.35
        const cOff = center * STRIDE
        this.cells[cOff + TB] = 0.7 + Math.random() * 0.3
        this.cells[cOff + TH] = warm ? 1.3 + Math.random() * 0.4 : 0.5 + Math.random() * 0.5
        this.cells[cOff + DR] = 2.0
        fires--
        const neighborCount = 1 + Math.floor(Math.random() * 2)
        for (let n = 0; n < neighborCount && fires > 0; n++) {
          const dc = Math.floor(Math.random() * 3) - 1
          const dr = Math.floor(Math.random() * 3) - 1
          if (dc === 0 && dr === 0) continue
          const nc = centerCol + dc
          const nr = centerRow + dr
          if (nr < 0 || nr >= ROWS || nc < 0 || nc >= this.cols) continue
          const nOff = (nr * this.cols + nc) * STRIDE
          this.cells[nOff + TB] = 0.3 + Math.random() * 0.4
          this.cells[nOff + TH] = warm ? 1.2 + Math.random() * 0.3 : 0.4 + Math.random() * 0.4
          this.cells[nOff + DR] = 2.5
          fires--
        }
      }
    }
    for (let f = 0; f < fires; f++) {
      const idx = Math.floor(Math.random() * this.cellCount)
      const off = idx * STRIDE
      const warm = Math.random() < 0.35
      this.cells[off + TB] = 0.45 + Math.random() * 0.45
      this.cells[off + TH] = warm ? 1.3 + Math.random() * 0.4 : Math.random() * 0.7
      this.cells[off + DR] = 2.0 + Math.random()
    }

    // Ambient with warm mix
    const recentEnergy = Math.min(1, this.accumEnergy / 50)
    const ambientInterval = 0.12 - recentEnergy * 0.08
    this.ambientTimer += dt
    if (this.ambientTimer > ambientInterval) {
      this.ambientTimer -= ambientInterval
      const count = Math.max(1, Math.round((2 + recentEnergy * 3 + Math.random() * 2) * density))
      for (let a = 0; a < count; a++) {
        const idx = Math.floor(Math.random() * this.cellCount)
        const off = idx * STRIDE
        const warm = Math.random() < 0.25
        const roll = Math.random()
        const ambientBrightness = roll < 0.7
          ? 0.15 + Math.random() * 0.2
          : 0.3 + Math.random() * 0.25
        this.cells[off + TB] = Math.max(this.cells[off + TB], ambientBrightness)
        this.cells[off + TH] = warm ? 1.2 + Math.random() * 0.5 : Math.random()
        this.cells[off + DR] = 1.5 + Math.random() * 0.5
      }
    }

    // Decay + drift
    for (let i = 0; i < this.cellCount; i++) {
      const off = i * STRIDE
      this.cells[off + TB] = Math.max(0, this.cells[off + TB] - dt * 0.7)
      this.cells[off + YO] = 0
    }
  }

  // ── Error fatal ("giving up" — flicker fades into settled dim pulse) ─
  //
  // No discrete phases — flicker intensity decays continuously while the
  // pull toward the resting breath target grows. Everything flows through
  // the target/interpolation system so transitions are inherently smooth.

  private tickErrorFatal(dt: number): void {
    this.fatalTimer += dt
    const density = this.cellCount / 93

    // Resting state: slow breathing rose-pink pulse (~5s cycle)
    const breath = 0.235 + Math.sin(this.fatalTimer * 1.25) * 0.055

    // Flicker fades out continuously over ~3s
    const flicker = Math.max(0, 1 - this.fatalTimer / 3)

    // Pull toward resting state — weak at first (flicker dominates), strong when settled
    const pull = 0.5 + (1 - flicker) * 6

    // All cells drift toward the resting breath target
    for (let i = 0; i < this.cellCount; i++) {
      const off = i * STRIDE
      this.cells[off + TB] += (breath - this.cells[off + TB]) * dt * pull
      this.cells[off + TH] += (2.0 - this.cells[off + TH]) * dt * pull
      this.cells[off + DR] = 1.0 + (1 - flicker) * 2.0
      this.cells[off + YO] = 0
    }

    // Erratic flicker layered on top — fades out naturally
    if (flicker > 0.01) {
      const fireRate = 0.03 + flicker * 0.05
      if (Math.random() < dt / fireRate) {
        const count = Math.max(1, Math.round((2 + flicker * 6) * density))
        for (let f = 0; f < count; f++) {
          const idx = Math.floor(Math.random() * this.cellCount)
          const off = idx * STRIDE
          this.cells[off + TB] = breath + Math.random() * 0.5 * flicker
          this.cells[off + TH] = 1.5 + Math.random() * 0.5
          this.cells[off + DR] = 2.0 + flicker * 3
        }
      }
    }
  }

  // ── Idle ─────────────────────────────────────────────────────────────

  // Idle
  private idleTimer = 0

  private tickIdle(dt: number): void {
    this.idleTimer += dt

    // Decay all cells toward dark — but gently, so twinkles linger
    for (let i = 0; i < this.cellCount; i++) {
      const off = i * STRIDE
      this.cells[off + TB] = Math.max(0, this.cells[off + TB] - dt * 0.3)
      this.cells[off + TH] = 0 // keep violet
      this.cells[off + DR] = 0.8
      this.cells[off + YO] = 0
    }

    // Occasional soft twinkle — wider cluster around a center cell
    if (Math.random() < dt * 0.75) {
      const center = Math.floor(Math.random() * this.cellCount)
      const centerCol = center % this.cols
      const centerRow = Math.floor(center / this.cols)
      // Center cell brightest
      this.cells[center * STRIDE + TB] = 0.3 + Math.random() * 0.26
      this.cells[center * STRIDE + DR] = 0.5
      // 5×5 spread — inner ring bright, outer ring dimmer
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          if (dr === 0 && dc === 0) continue
          const nr = centerRow + dr
          const nc = centerCol + dc
          if (nr < 0 || nr >= ROWS || nc < 0 || nc >= this.cols) continue
          const dist = Math.max(Math.abs(dr), Math.abs(dc))
          const nOff = (nr * this.cols + nc) * STRIDE
          if (dist === 1) {
            this.cells[nOff + TB] = Math.max(this.cells[nOff + TB], 0.15 + Math.random() * 0.20)
            this.cells[nOff + DR] = 0.4
          } else {
            this.cells[nOff + TB] = Math.max(this.cells[nOff + TB], 0.08 + Math.random() * 0.12)
            this.cells[nOff + DR] = 0.3
          }
        }
      }
    }
  }

  // ── Interpolation & render ───────────────────────────────────────────

  private interpolateCells(dt: number): void {
    for (let i = 0; i < this.cellCount; i++) {
      const off = i * STRIDE
      const rate = this.cells[off + DR]
      const t = Math.min(dt * rate, 1)
      this.cells[off + B] += (this.cells[off + TB] - this.cells[off + B]) * t
      this.cells[off + H] += (this.cells[off + TH] - this.cells[off + H]) * t
    }
  }

  private render(): void {
    let totalBrightness = 0

    for (let i = 0; i < this.cellCount; i++) {
      const el = this.elements[i]
      if (!el) continue

      const off = i * STRIDE
      let brightness = this.cells[off + B]
      const hue = this.cells[off + H]
      const yOffset = this.cells[off + YO]

      // Apply power envelope with per-cell cascade
      if (this.powerState === 'powering-on' || this.powerState === 'powering-off') {
        const delay = this.powerTimers[i] ?? 0
        const cellPower = Math.max(0, Math.min(1, (this.powerProgress - delay * 0.6) / 0.4))
        brightness *= cellPower
      }

      totalBrightness += brightness

      // Unlit LED base — cells are always physically present, just dark when off
      const base = `width:${CELL_SIZE}px;height:${CELL_SIZE}px;border-radius:1.5px;will-change:transform;`

      if (brightness < 0.02) {
        el.style.cssText = `${base}background:rgba(139,92,246,0.06);`
        continue
      }

      // Boost opacity so peaks punch to full white — dims stay dim.
      const opacity = Math.min(1, brightness * 1.7)

      const color = cellColor(brightness, hue)
      const shadow = brightness > 0.25
        ? `0 0 ${(brightness * 6).toFixed(1)}px ${cellColor(brightness * 0.6, hue)}`
        : 'none'
      const transform = yOffset !== 0
        ? `translateY(${yOffset.toFixed(1)}px)`
        : 'none'

      el.style.cssText = `${base}background:${color};box-shadow:${shadow};transform:${transform};opacity:${opacity.toFixed(2)};`
    }

    // Pulse container border glow with average brightness
    if (this.container) {
      const avg = this.cellCount > 0 ? totalBrightness / this.cellCount : 0
      if (avg > 0.02) {
        const isError = this.mode === 'error-recovering' || this.mode === 'error-fatal'
        const glowColor = isError ? '244,63,94' : '139,92,246'
        this.container.style.boxShadow = `0 0 ${(avg * 12).toFixed(1)}px rgba(${glowColor},${(avg * 0.3).toFixed(2)})`
      } else {
        this.container.style.boxShadow = 'none'
      }
    }
  }
}
