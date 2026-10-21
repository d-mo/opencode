import { afterEach, beforeEach, expect, it } from "bun:test"
import { batch, createRoot, createSignal } from "solid-js"
import { motionTuning } from "@opencode/ui/motion-tuning"
import { createPanelMotion, guardClosingFocus, panelsMoving } from "../src/shell/panel-motion"

let frames: Map<number, FrameRequestCallback>

let id: number

let time: number

const cleanups: (() => void)[] = []

const originals = { raf: globalThis.requestAnimationFrame, caf: globalThis.cancelAnimationFrame }

beforeEach(() => {
  frames = new Map()
  id = 0
  time = 0
  globalThis.requestAnimationFrame = (fn: FrameRequestCallback) => {
    frames.set(++id, fn)

    return id
  }

  globalThis.cancelAnimationFrame = (key: number) => {
    frames.delete(key)
  }
})

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  globalThis.requestAnimationFrame = originals.raf
  globalThis.cancelAnimationFrame = originals.caf
  setStyle("spring")
  setLow(false)
})

function setStyle(value: string) {
  const knob = motionTuning.list().find((item) => item.id === "sidebars.style")

  if (knob?.kind === "choice") motionTuning.set(knob, value)
}

// Low movement is a mode, chosen in the preset strip rather than the Motion choice.
function setLow(on: boolean) {
  const knob = motionTuning.list().find((item) => item.id === "sidebars.low")

  if (knob?.kind === "mode") motionTuning.set(knob, on)
}

function frame() {
  time += 1000 / 60
  const next = [...frames.values()]
  frames.clear()

  for (const callback of next) callback(time)
}

function settle() {
  for (let i = 0; i < 120 && frames.size; i++) frame()
}

function setup(initial: boolean) {
  const [open, setOpen] = createSignal(initial)
  const [identity, setIdentity] = createSignal("a")
  const [size, setSize] = createSignal(200)
  const closed: number[] = []
  const painted = { width: 0 }

  const motion = createRoot((dispose) => {
    cleanups.push(dispose)

    return createPanelMotion({
      open,
      paint: (shut) => {
        painted.width = size() * (1 - shut)
      },
      identity,
      onClosed: () => closed.push(time),
    })
  })

  return { painted, setOpen, setIdentity, setSize, closed, present: motion.present, motion }
}

it("sizes the panel a little every frame on the way open and closed, present until the close settles", () => {
  const panel = setup(false)
  panel.setOpen(true)
  expect(panel.present()).toBe(true)
  expect(panel.painted.width).toBe(0)
  const widths: number[] = []

  for (let i = 0; i < 120 && frames.size; i++) {
    frame()
    widths.push(panel.painted.width)
  }

  const steps = widths.map((width, index) => width - (widths[index - 1] ?? 0))
  expect(widths.length).toBeGreaterThan(5)
  expect(steps.every((step) => step >= 0)).toBe(true)
  expect(Math.max(...steps)).toBeLessThan(60)
  // The last moving frame lands within a pixel of rest.
  expect(200 - widths.findLast((width) => width < 200)!).toBeLessThan(1)

  panel.setOpen(false)
  frame()
  expect(panel.present()).toBe(true)
  expect(panel.closed).toEqual([])
  settle()
  expect(panel.painted.width).toBe(0)
  expect(panel.present()).toBe(false)
  expect(panel.closed).toHaveLength(1)
})

it("turns around mid-flight from where it is", () => {
  const panel = setup(false)
  panel.setOpen(true)
  frame()
  frame()
  frame()
  const before = panel.painted.width

  panel.setOpen(false)
  expect(panel.painted.width).toBe(before)
  frame()
  // Still carrying its opening velocity, it does not jump back closed.
  expect(Math.abs(panel.painted.width - before)).toBeLessThan(30)
  settle()
  expect(panel.present()).toBe(false)
  expect(panel.painted.width).toBe(0)
})

it("repaints at rest when the open size changes, like a resize drag", () => {
  const panel = setup(true)
  expect(panel.painted.width).toBe(200)

  panel.setSize(260)
  expect(panel.painted.width).toBe(260)
  expect(frames.size).toBe(0)
})

it("snaps when the Motion workspace sets Instant", () => {
  setStyle("instant")
  const panel = setup(true)

  panel.setOpen(false)
  expect(panel.painted.width).toBe(0)
  expect(panel.present()).toBe(false)
  expect(panel.closed).toHaveLength(1)
  expect(frames.size).toBe(0)
})

it("shows another layout's state without motion or a close", () => {
  const panel = setup(true)

  panel.setOpen(false)
  panel.setIdentity("b")
  expect(panel.present()).toBe(false)
  expect(panel.painted.width).toBe(0)
  expect(panel.closed).toEqual([])
  expect(frames.size).toBe(0)
})

it("shows a state at once when synced, also from inside a batch", () => {
  const panel = setup(true)

  batch(() => {
    panel.setOpen(false)
    panel.motion.sync(false)
  })
  expect(panel.painted.width).toBe(0)
  expect(panel.present()).toBe(false)
  expect(frames.size).toBe(0)

  panel.setOpen(true)
  frame()
  panel.motion.sync(true)
  expect(panel.painted.width).toBe(200)
  expect(frames.size).toBe(0)
})

it("runs settled work once the flight lands, dropping work queued before a turnaround", () => {
  const panel = setup(false)
  const ran: string[] = []
  panel.setOpen(true)
  panel.motion.whenSettled(() => ran.push("opened"))
  frame()
  panel.setOpen(false)
  panel.motion.whenSettled(() => ran.push("closed"))
  frame()
  expect(ran).toEqual([])
  settle()
  expect(ran).toEqual(["closed"])
  panel.motion.whenSettled(() => ran.push("at rest"))
  expect(ran).toEqual(["closed", "at rest"])
})

it("reports a flight from its first frame until it lands, for native views to hide", () => {
  const panel = setup(true)
  expect(panelsMoving()).toBe(false)

  panel.setOpen(false)
  expect(panelsMoving()).toBe(true)
  frame()
  panel.setOpen(true)
  expect(panelsMoving()).toBe(true)
  settle()
  expect(panelsMoving()).toBe(false)

  setStyle("instant")
  panel.setOpen(false)
  expect(panelsMoving()).toBe(false)
})

it("moves focus out of a closing panel when the close starts and when it re-enters mid-flight", () => {
  const root = document.createElement("div")
  const inner = document.createElement("button")
  const toggle = document.createElement("button")
  root.append(inner)
  document.body.append(root, toggle)
  const [closing, setClosing] = createSignal(false)
  cleanups.push(
    createRoot((dispose) => {
      guardClosingFocus({ root: () => root, closing, target: () => toggle })

      return dispose
    }),
    () => {
      root.remove()
      toggle.remove()
    },
  )

  inner.focus()
  setClosing(true)
  expect(document.activeElement).toBe(toggle)

  inner.focus()
  expect(document.activeElement).toBe(toggle)

  setClosing(false)
  inner.focus()
  expect(document.activeElement).toBe(inner)
})

type Played = {
  keyframes: PropertyIndexedKeyframes
  options: KeyframeAnimationOptions
  cancelled: boolean
  finish: () => void
}

// happy-dom has no Web Animations, so the panel layer records what Low movement asks it to play.
function setupLow(initial: boolean) {
  setLow(true)
  const [open, setOpen] = createSignal(initial)
  const played: Played[] = []
  const closed: number[] = []
  const painted = { width: initial ? 200 : 0 }
  const element = document.createElement("div")
  Object.defineProperty(element, "animate", {
    value: (keyframes: PropertyIndexedKeyframes, options: KeyframeAnimationOptions) => {
      const finished = Promise.withResolvers<void>()
      const animation = { keyframes, options, cancelled: false, finish: () => finished.resolve() }
      played.push(animation)

      return {
        finished: finished.promise,
        cancel: () => {
          animation.cancelled = true
          finished.reject(new Error("cancelled"))
        },
      }
    },
  })

  const motion = createRoot((dispose) => {
    cleanups.push(dispose)

    return createPanelMotion({
      open,
      paint: (shut) => {
        painted.width = 200 * (1 - shut)
      },
      onClosed: () => closed.push(time),
      element: () => element,
      offset: -10,
    })
  })

  return { played, setOpen, closed, painted, motion }
}

const tick = async () => {
  await Promise.resolve()
  await Promise.resolve()
}

const land = async (played: Played[]) => {
  played.filter((animation) => !animation.cancelled).forEach((animation) => animation.finish())
  await tick()
}

it("Low movement opens with the layout first, then shifts the panel in on a spring and fades it up from 0.15", async () => {
  const panel = setupLow(false)
  panel.setOpen(true)
  expect(panel.painted.width).toBe(200)
  expect(panel.motion.present()).toBe(true)
  await tick()

  const [shift, fade] = panel.played
  expect(shift.keyframes.transform).toEqual(["translateX(-10px)", "none"])
  // A 240 ms spring without bounce: x(t) = 1 - (1 + ωt)e^(-ωt), sampled per 60 Hz frame.
  const omega = (2 * Math.PI) / 0.24
  const points = String(shift.options.easing).slice("linear(".length, -1).split(", ").map(Number)
  points.slice(1, -1).forEach((point, index) => {
    const t = (index + 1) / 60
    expect(point).toBeCloseTo(1 - (1 + omega * t) * Math.exp(-omega * t), 2)
  })
  expect(fade.keyframes.opacity).toEqual(["0.15", "1"])
  expect(fade.options).toMatchObject({ duration: 180, easing: "cubic-bezier(0.44, 0.75, 0.63, 1.03)" })
  expect(panelsMoving()).toBe(true)

  const ran: string[] = []
  panel.motion.whenSettled(() => ran.push("opened"))
  await land(panel.played)
  expect(ran).toEqual(["opened"])
  expect(panelsMoving()).toBe(false)
})

it("Low movement closes in reverse, keeping the layout until the panel has faded down", async () => {
  const panel = setupLow(true)
  panel.setOpen(false)
  await tick()

  const [shift, fade] = panel.played
  expect(shift.keyframes.transform).toEqual(["none", "translateX(-10px)"])
  expect(fade.keyframes.opacity).toEqual(["1", "0.15"])
  expect(panel.painted.width).toBe(200)
  expect(panel.motion.present()).toBe(true)

  await land(panel.played)
  expect(panel.painted.width).toBe(0)
  expect(panel.motion.present()).toBe(false)
  expect(panel.closed).toHaveLength(1)
})

it("Low movement turns around mid-flight, cancelling the first direction", async () => {
  const panel = setupLow(true)
  panel.setOpen(false)
  await tick()
  panel.setOpen(true)
  await tick()

  expect(panel.played).toHaveLength(4)
  expect(panel.played.slice(0, 2).every((animation) => animation.cancelled)).toBe(true)
  expect(panel.played[2].keyframes.transform?.at(-1)).toBe("none")
  await land(panel.played)
  expect(panel.motion.present()).toBe(true)
  expect(panel.closed).toEqual([])
})

it("Low movement snaps under reduced motion", () => {
  document.documentElement.dataset.motion = "reduce"
  cleanups.push(() => delete document.documentElement.dataset.motion)
  const panel = setupLow(true)
  panel.setOpen(false)

  expect(panel.played).toEqual([])
  expect(panel.painted.width).toBe(0)
  expect(panel.motion.present()).toBe(false)
})

it("swaps Kit's knobs for Low movement's while its mode is on", () => {
  const shown = () =>
    motionTuning
      .list()
      .filter((knob) => knob.group === "Sidebars" && knob.kind !== "mode" && (knob.when?.() ?? true))
      .map((knob) => knob.label)

  expect(shown()).toEqual(["Spring", "Motion"])
  setLow(true)
  expect(shown()).toEqual(["Movement", "Fade", "Fade duration", "Layout", "Layout open", "Layout close"])
  setLow(false)
  expect(shown()).toEqual(["Spring", "Motion"])
})
