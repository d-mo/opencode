import { createEffect, createSignal, on, onCleanup, type Accessor } from "solid-js"
import { frameLoop, prefersReducedMotion, Spring, type DurationOptions } from "@opencode/ui/motion"
import { motionTuning } from "@opencode/ui/motion-tuning"

const group = "Sidebars"

// Panels in flight, across the app. Native views, which no DOM box clips, stay hidden while any panel moves.
const [flights, setFlights] = createSignal(0)

export const panelsMoving = () => flights() > 0

// Low movement, chosen in the preset strip beside Snappy, Smooth and Calm, swaps the section's knobs for its own: layout
// changes in one frame and only the panel moves, a few pixels toward its edge, while it fades. The neighbours beside it
// glide from their old box to the new one. All run as Web Animations, so the compositor plays them through main-thread
// work.
const low = motionTuning.mode("sidebars.low", { label: "Low movement", group })

const kit = () => !low()

// The left sidebar and the side panel share one spring, so they move as one system.
const spring = motionTuning.spring("sidebars", {
  label: "Spring",
  group,
  when: kit,
  shipped: "smooth",
  presets: {
    snappy: { duration: 0.2, bounce: 0 },
    smooth: { duration: 0.3, bounce: 0 },
    calm: { duration: 0.45, bounce: 0 },
  },
})

const style = motionTuning.choice("sidebars.style", {
  label: "Motion",
  group,
  when: kit,
  value: "spring",
  labels: { spring: "Spring", instant: "Instant" },
})

const lowShift = motionTuning.spring("sidebars.low.shift", {
  label: "Movement",
  group,
  when: low,
  shipped: "smooth",
  presets: {
    snappy: { duration: 0.18, bounce: 0 },
    smooth: { duration: 0.24, bounce: 0 },
    calm: { duration: 0.32, bounce: 0 },
  },
})

const lowFade = motionTuning.easing("sidebars.low.fade", {
  label: "Fade",
  group,
  when: low,
  value: [0.44, 0.75, 0.63, 1.03],
})

const lowFadeDuration = motionTuning.number("sidebars.low.fadeDuration", {
  label: "Fade duration",
  group,
  when: low,
  value: 0.18,
  min: 0.05,
  max: 0.6,
  step: 0.01,
  unit: "s",
  time: "duration",
})

// "flip" translates the neighbours from their old box on the compositor; "width" animates the resized box's real width,
// re-wrapping its content each frame.
const lowLayout = motionTuning.choice("sidebars.low.layout", {
  label: "Layout",
  group,
  when: low,
  value: "flip",
  labels: { flip: "Glide (FLIP)", width: "Width", off: "Off" },
})

const layoutSpring = (direction: string, label: string) =>
  motionTuning.spring(`sidebars.low.layout.${direction}`, {
    label,
    group,
    when: () => low() && lowLayout() !== "off",
    shipped: "smooth",
    presets: {
      snappy: { duration: 0.12, bounce: 0 },
      smooth: { duration: 0.16, bounce: 0 },
      calm: { duration: 0.24, bounce: 0 },
    },
  })

const lowLayoutOpen = layoutSpring("open", "Layout open")

const lowLayoutClose = layoutSpring("close", "Layout close")

// The opacity a low-movement panel fades up from and down to.
const faded = 0.15

/** Where a neighbour's content sits: centred content follows its box's centre, start-pinned content its start edge. */
export type Anchor = "center" | "start"

/** Adds a button that toggles a panel to the Motion workspace's Sidebars section while the panel is mounted. */
export function replayPanelToggle(input: { id: string; label: string; toggle: () => void }) {
  onCleanup(motionTuning.action({ id: `sidebars.${input.id}`, label: input.label, group, run: input.toggle }))
}

/**
 * Opens and closes an edge panel on the shared sidebar spring. `paint` receives how far closed the panel is, from 0
 * (open) to 1 (closed), every frame of a flight and whenever a signal it reads changes at rest. It sizes the panel's
 * real layout box, so the neighbouring content's edge follows the panel's edge on every frame. `present` stays true
 * until a close settles. `whenSettled` defers work that would force a layout, like moving focus, until the flight
 * lands; `sync` shows a state at once, for changes the user makes by hand.
 */
export function createPanelMotion(input: {
  open: Accessor<boolean>
  paint: (closed: number) => void
  /** A change shows the new state without motion, e.g. switching to another session's layout. */
  identity?: Accessor<unknown>
  onClosed?: () => void
  /**
   * Low movement: the panel layer that shifts and fades, and how far it shifts, in pixels toward its edge (negative for
   * the inline-start edge; mirrored in RTL).
   */
  element?: Accessor<HTMLElement | undefined>
  offset?: number
  /** Low movement: the boxes beside the panel that glide into place when its layout changes, and how. */
  neighbours?: () => Array<[HTMLElement | null | undefined, Anchor]>
  /** Low movement, width layout: the box whose real width animates. */
  resize?: () => HTMLElement | null | undefined
}) {
  const [present, setPresent] = createSignal(input.open())
  // Percent closed, so the spring's rest threshold stays well under a pixel.
  const motion = new Spring(input.open() ? 0 : 100)
  let stop: (() => void) | undefined
  let landed: (() => void)[] = []
  // A state `sync` asked to show at once, for when the change hasn't reached this motion yet, e.g. inside a batch.
  let snapTo: boolean | undefined
  let flying = false
  // The low-movement flight in progress, if any.
  let fades: Animation[] = []

  const fly = (next: boolean) => {
    if (flying === next) return
    flying = next
    setFlights((count) => count + (next ? 1 : -1))
  }

  const paint = () => input.paint(Math.min(1, Math.max(0, motion.value / 100)))

  const settle = () => {
    stop?.()
    stop = undefined
    fades.forEach((animation) => animation.cancel())
    fades = []
    fly(false)
    const queued = landed
    landed = []

    if (!input.open()) {
      setPresent(false)
      input.onClosed?.()
    }

    queued.forEach((run) => run())
  }

  const snap = (open: boolean) => {
    motion.snap(open ? 0 : 100)
    paint()
    settle()
  }

  createEffect(
    on(
      () => [input.open(), input.identity?.()] as const,
      ([open, identity], previous) => {
        const target = open ? 0 : 100
        // Work queued for the previous direction no longer applies.
        landed = []
        const now = snapTo === open
        snapTo = undefined

        if (open) setPresent(true)

        if (previous === undefined || previous[1] !== identity) {
          stop?.()
          stop = undefined
          fades.forEach((animation) => animation.cancel())
          fades = []
          fly(false)
          motion.snap(target)
          paint()

          if (!open) setPresent(false)

          return
        }

        if (now || prefersReducedMotion() || (!low() && style() === "instant")) return snap(open)

        if (low()) return fade(open)

        const tuning = spring()
        motion.omega = (2 * Math.PI) / tuning.duration
        motion.zeta = 1 - tuning.bounce
        // Retargeting keeps the current position and velocity, so a second toggle mid-flight turns around smoothly.
        motion.set(target)
        fly(true)
        // Writes only; anything reading layout this frame does so in the loop's read phase, before this runs.
        stop ??= frameLoop.add((dt) => {
          motion.step(dt)
          paint()

          if (!motion.resting) return true
          stop = undefined
          settle()

          return false
        })
      },
    ),
  )

  /**
   * Opens with the layout first, then the panel shifts in and fades up; closes in reverse, with the layout last. A
   * reversal mid-flight turns around from where the panel is.
   */
  const fade = (open: boolean) => {
    stop?.()
    stop = undefined
    glide(true, () => {
      motion.snap(0)
      paint()
    })
    fly(true)
    // Deferred so a panel that mounts with this open exists before it animates; microtasks run before the next paint.
    queueMicrotask(() => {
      const element = input.element?.()

      if (input.open() !== open) return

      if (!element?.animate) return open ? settle() : snap(false)

      const x = (input.offset ?? 0) * (element.matches(":dir(rtl)") ? -1 : 1)
      const away = { transform: `translateX(${x}px)`, opacity: `${faded}` }
      const rest = { transform: "none", opacity: "1" }
      const target = open ? rest : away
      const start = fades.length > 0 ? getComputedStyle(element) : open ? away : rest
      const tuning = lowShift()
      fades.forEach((animation) => animation.cancel())
      fades = [
        element.animate({ transform: [start.transform, target.transform] }, { ...springEasing(tuning), fill: "both" }),
        element.animate(
          { opacity: [start.opacity, target.opacity] },
          { duration: lowFadeDuration() * 1000, easing: `cubic-bezier(${lowFade().join(", ")})`, fill: "both" },
        ),
      ]
      const current = fades
      void Promise.all(current.map((animation) => animation.finished)).then(
        () => current === fades && (open ? settle() : glide(false, () => snap(false))),
        () => undefined,
      )
    })
  }

  /**
   * Runs `change`, which moves the layout, then glides the neighbours from their old boxes to the new ones. The new
   * boxes are read in a ResizeObserver pass, after the screen's own observers have settled their sizes for the change.
   */
  const glide = (open: boolean, change: () => void) => {
    const mode = lowLayout()

    const before =
      mode === "flip"
        ? (input.neighbours?.() ?? []).flatMap(([element, anchor]) =>
            element ? [{ element, anchor, x: anchorX(element, anchor) }] : [],
          )
        : []

    const box = mode === "width" ? input.resize?.() : undefined

    const width = box?.getBoundingClientRect().width
    change()

    if (before.length === 0 && !box) return
    const timing = springEasing(open ? lowLayoutOpen() : lowLayoutClose())

    const observer = new ResizeObserver(() => {
      observer.disconnect()
      before.forEach(({ element, anchor, x }) => {
        const dx = x - anchorX(element, anchor)

        if (Math.abs(dx) > 0.5)
          element.animate(
            { transform: [`translateX(${dx}px)`, "none"] },
            { ...timing, composite: "add", fill: "backwards" },
          )
      })

      if (!box || width === undefined) return
      const to = box.getBoundingClientRect().width

      if (Math.abs(to - width) > 0.5)
        box.animate({ width: [`${width}px`, `${to}px`] }, { ...timing, fill: "backwards" })
    })

    before.forEach(({ element }) => observer.observe(element))

    if (box) observer.observe(box)
  }

  // Repaints at rest when the open size changes, e.g. a resize drag or a window resize.
  createEffect(paint)

  onCleanup(() => {
    stop?.()
    fades.forEach((animation) => animation.cancel())
    fly(false)
  })

  return {
    present,
    sync: (open: boolean) => {
      if (flying && input.open() === open) return snap(open)
      snapTo = open
    },
    whenSettled: (run: () => void) => {
      if (flying) return void landed.push(run)
      run()
    },
  }
}

/**
 * Keeps focus out of a closing panel without `inert`, which would restyle every element in it: focus inside moves to
 * `target` when the close starts and whenever it enters during the flight. A settled panel is skipped, so nothing in
 * it can take focus.
 */
export function guardClosingFocus(input: {
  root: Accessor<HTMLElement | undefined>
  closing: Accessor<boolean>
  target: () => HTMLElement | undefined
}) {
  const evict = () => {
    const root = input.root()

    if (!input.closing() || !root?.contains(document.activeElement)) return
    const target = input.target()

    if (target) return target.focus({ preventScroll: true })

    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
  }

  createEffect(on(input.closing, evict, { defer: true }))
  createEffect(() => {
    const root = input.root()

    if (!root) return
    root.addEventListener("focusin", evict)
    onCleanup(() => root.removeEventListener("focusin", evict))
  })
}

/** A spring sampled per 60 Hz frame into a CSS `linear()` easing, ending once within 0.5% of rest. */
function springEasing(tuning: DurationOptions) {
  const spring = Spring.fromDuration(0, tuning).set(1)
  const points = [0]

  while (points.length < 240 && (Math.abs(1 - points.at(-1)!) > 0.005 || Math.abs(spring.velocity) > 0.05))
    points.push(Math.round(spring.step(1 / 60) * 1000) / 1000)
  points[points.length - 1] = 1

  return { duration: ((points.length - 1) * 1000) / 60, easing: `linear(${points.join(", ")})` }
}

function anchorX(element: HTMLElement, anchor: Anchor) {
  const box = element.getBoundingClientRect()

  if (anchor === "center") return box.left + box.width / 2

  return element.matches(":dir(rtl)") ? box.right : box.left
}
