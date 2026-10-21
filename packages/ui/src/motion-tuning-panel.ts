import type { DurationOptions } from "./motion"
import { motionPresets, motionTuning, type MotionKnob, type MotionPreset } from "./motion-tuning"

const global = "Global"

const experiments = "Experiments"

/**
 * Mounts the Knobs workspace into `container`: a Global card (speed, slow motion and other settings every surface reads)
 * on top, then the surfaces below it, one tab each (none when there is only one), under the shipped values and the
 * Snappy, Smooth and Calm presets for every spring at once. Each surface is one card: its springs and knobs, with its
 * replay buttons under a Replay sub-heading. knobs loads on first mount, so importing this module costs nothing until
 * then. Works anywhere a surface registered its knobs, including Storybook stories. Returns its removal.
 */
export function mountMotionPanel(
  container: HTMLElement,
  options: { title?: string; section?: string; onClose?: () => void } = {},
) {
  let unmount: (() => void) | undefined
  let disposed = false
  let section = options.section

  void start()

  return () => {
    disposed = true
    unmount?.()
  }

  async function start() {
    const { action, choice, defineControls, knob, spring, toggle } = await import("knobs")

    const field = (item: MotionKnob, tabbed = false) => {
      const meta = {
        label: item.label,
        group: item.group,
        tab: tabbed && item.group !== global ? item.group : undefined,
      }

      if (item.kind === "spring") return spring(item.initial, meta)

      if (item.kind === "toggle") return toggle(item.initial, meta)

      if (item.kind === "choice") return choice(item.initial, item.options, { ...meta, labels: item.labels })

      return knob(item.initial, { ...meta, min: item.min, max: item.max, step: item.step, unit: item.unit ?? "×" })
    }

    const apply = (item: MotionKnob, value: MotionKnob["value"]) => {
      if (item.kind === "spring") {
        // SAFETY: a spring knob's field is a spring field.
        return motionTuning.set(item, value as DurationOptions)
      }

      if (item.kind === "toggle") {
        // SAFETY: a toggle knob's field is a toggle field.
        return motionTuning.set(item, value as boolean)
      }

      if (item.kind === "choice") {
        // SAFETY: a choice knob's field is a choice field.
        return motionTuning.set(item, value as string)
      }

      // SAFETY: a number knob's field is a number field.
      motionTuning.set(item, value as number)
    }

    const identity = () =>
      [...motionTuning.list(), ...motionTuning.actions()].map((item) => `${item.group}/${item.id}`).join()

    // Rebuilt when a surface registers or removes a knob or action.
    const mount = () => {
      unmount?.()
      const list = motionTuning.list()
      const actions = motionTuning.actions()
      const mounted = identity()
      const springs = list.flatMap((item) => (item.kind === "spring" ? [item] : []))
      const preset = (id: MotionPreset) => Object.fromEntries(springs.map((item) => [item.id, item.presets[id]]))

      const sections = [...new Set([...list, ...actions].map((item) => item.group))]
        .filter((group) => group !== global)
        // Experiments come and go, so they sit last.
        .toSorted((a, b) => Number(a === experiments) - Number(b === experiments))

      // A lone section needs no tab strip.
      const tabbed = sections.length > 1
      const globals = list.filter((item) => item.group === global)

      // Global sits in its own panel above the sections, so it reads as applying to all of them.
      const top = defineControls(
        "opencode-motion-global",
        Object.fromEntries(globals.map((item) => [item.id, field(item)])),
        {
          enabled: true,
          ship: () => import("knobs/panel"),
          persist: "none",
          onChange: (patch) =>
            globals.forEach((item) => {
              // SAFETY: each field was made from its knob above, so its value is that knob's kind.
              const value = patch[item.id] as MotionKnob["value"] | undefined

              if (value !== undefined) apply(item, value)
            }),
        },
      )

      const controls = defineControls(
        "opencode-motion",
        {
          // Each section's knobs and its replay buttons together, so each shows as one card.
          ...Object.fromEntries(
            [...list, ...actions]
              .filter((item) => item.group !== global)
              .toSorted((a, b) => sections.indexOf(a.group) - sections.indexOf(b.group))
              .map((item) =>
                "run" in item
                  ? [
                      `action.${item.id}`,
                      action(item.label, {
                        group: item.group,
                        tab: tabbed ? item.group : undefined,
                        subsection: "Replay",
                        run: item.run,
                      }),
                    ]
                  : [item.id, field(item, tabbed)],
              ),
          ),
        },
        {
          // knobs enables itself only on localhost; this module is only loaded in developer channels.
          enabled: true,
          ship: () => import("knobs/panel"),
          persist: "variants",
          // Springs ship different presets, so the defaults get their own chip.
          defaultLabel: "Shipped",
          presetLabels: motionPresets,
          presets: { snappy: preset("snappy"), smooth: preset("smooth"), calm: preset("calm") },
          onChange: (patch) =>
            list.forEach((item) => {
              // SAFETY: each field was made from its knob above, so its value is that knob's kind.
              const value = patch[item.id] as MotionKnob["value"] | undefined

              if (value !== undefined && item.group !== global) apply(item, value)
            }),
        },
      )

      const sync = () => {
        top.sync(Object.fromEntries(globals.map((item) => [item.id, item.value])))
        controls.sync(
          Object.fromEntries(list.filter((item) => item.group !== global).map((item) => [item.id, item.value])),
        )
      }

      sync()
      const upper = container.appendChild(document.createElement("div"))
      const lower = container.appendChild(document.createElement("div"))

      // The debug bar shows and hides this panel, and `s` jumps only with focus inside it, so the app keeps its keys.
      const keys = { toggleKey: false, hints: "panel" } as const

      const stopTop = top.mount(upper, {
        theme: "auto",
        title: options.title ?? "Knobs",
        onClose: options.onClose,
        variants: false,
        ...keys,
      })

      const stopPanel = controls.mount(lower, {
        theme: "auto",
        title: false,
        ...keys,
        tabs: tabbed ? sections : undefined,
        tab: section,
        onTab: (id) => (section = id),
      })

      const stopWatch = motionTuning.subscribe(() => {
        // Edits from elsewhere, such as the debug bar's SLOW, show here too.
        if (identity() === mounted) return sync()
        mount()
      })

      unmount = () => {
        stopWatch()
        stopTop()
        stopPanel()
        upper.remove()
        lower.remove()
      }
    }

    if (!disposed) mount()
  }
}
