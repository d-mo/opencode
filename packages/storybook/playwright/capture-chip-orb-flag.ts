import { chromium } from "@playwright/test"
import { mkdir, rm } from "node:fs/promises"
import path from "node:path"
import { build } from "vite"
import solid from "vite-plugin-solid"
import tailwind from "@tailwindcss/vite"
import type {} from "../../app/src/session/composer/activity-chips.fixture"

// Production components and Storybook's service mocks, bundled without the live Storybook module loader.
const out = path.resolve("captures/chip-orb-flag")
const root = path.resolve("packages/storybook/node_modules/.cache/chip-orb-proof")
const mocks = path.resolve("packages/storybook/.storybook/mocks")
await mkdir(out, { recursive: true })
await mkdir(root, { recursive: true })
await Bun.write(
  path.join(root, "index.html"),
  `<div id="root"></div><script type="module" src="${path.resolve("packages/app/src/session/composer/activity-chips.fixture.tsx")}"></script>`,
)
await build({
  configFile: false,
  root,
  publicDir: path.resolve("packages/app/public"),
  plugins: [solid(), tailwind()],
  resolve: {
    dedupe: ["solid-js", "solid-js/web", "@solidjs/meta", "@tanstack/solid-query"],
    alias: [
      { find: "@solidjs/router", replacement: path.join(mocks, "solid-router.tsx") },
      ...Object.entries({
        "providers/models/selection": "context/local.ts",
        "workspaces/files/model": "context/file.ts",
        "shell/state/layout": "context/layout.ts",
        "workspaces/location": "context/location.ts",
        "composer/comments": "context/comments.ts",
        "shell/commands/command": "context/command.ts",
        "runtime/platform/platform": "context/platform.ts",
        "runtime/server/global-sync": "context/global-sync.ts",
        "runtime/server/sync": "context/server-sync.ts",
        "runtime/server/client": "context/server-sdk.ts",
        "runtime/server/current": "context/server-current.ts",
        "providers/catalog/providers": "hooks/use-providers.ts",
        "providers/models/unpaid": "components/dialog-select-model-unpaid.tsx",
      }).map(([find, file]) => ({ find: `@/${find}`, replacement: path.join(mocks, "app", file) })),
      { find: "@", replacement: path.resolve("packages/app/src") },
    ],
  },
  build: { outDir: "dist", minify: true },
  worker: { format: "es" },
})
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: (request) => {
    const pathname = new URL(request.url).pathname
    return new Response(Bun.file(path.join(root, "dist", pathname === "/" ? "index.html" : pathname)))
  },
})
const browser = await chromium.launch()
const context = await browser.newContext({
  viewport: { width: 1200, height: 800 },
  deviceScaleFactor: 2,
  recordVideo: { dir: path.join(out, "video"), size: { width: 1200, height: 800 } },
})
const page = await context.newPage()
const errors: string[] = []
page.on("pageerror", (error) => {
  errors.push(error.message)
  console.error(error.message)
})
try {
  await page.goto(String(server.url))
  const chip = page.locator('[data-slot="session-activity-chip"]')
  await chip.waitFor({ timeout: 30_000 }).catch(async (error) => {
    console.error(await page.locator("body").innerHTML())
    throw error
  })
  await page.evaluate(() => document.fonts.ready.then(() => undefined))
  await page.getByText("Chip corners", { exact: true }).waitFor()
  const choose = (mode: string, corners: string) =>
    page.evaluate(({ mode, corners }) => window.chipExperiment(mode, corners), { mode, corners })
  const geometry = []
  for (const mode of ["today", "orb"]) {
    for (const corners of ["capsule", "composer"]) {
      await choose(mode, corners)
      await page.waitForTimeout(300)
      geometry.push({
        mode,
        corners,
        ...(await page.evaluate(() => {
          const chip = document.querySelector<HTMLElement>('[data-slot="session-activity-chip"]')!
          const composer = document.querySelector<HTMLElement>('[data-component="composer"]')!
          const rect = chip.getBoundingClientRect()
          return {
            height: rect.height,
            radius: getComputedStyle(chip).borderTopLeftRadius,
            composerRadius: getComputedStyle(composer).borderTopLeftRadius,
            composerY: composer.getBoundingClientRect().y,
            glyphOffset:
              chip.querySelector('[data-slot="activity-glyph"]')!.getBoundingClientRect().x +
              8 -
              rect.x -
              rect.height / 2,
            orb: chip.dataset.orb,
          }
        })),
      })
      await page.screenshot({ path: path.join(out, `${mode}-${corners}.png`) })
    }
  }
  await page.reload()
  await chip.waitFor()
  if ((await chip.getAttribute("data-orb")) !== "true") throw new Error("Choice did not persist")
  await choose("today", "capsule")
  await page.waitForTimeout(250)
  const fade = await page.evaluate(async () => {
    const chip = document.querySelector('[data-slot="session-activity-chip"]')!
    const orb = chip.querySelector('[data-slot="activity-glyph-orb"]')!
    const today = chip.querySelector('[data-slot="activity-glyph-today"]')!
    window.chipExperiment("orb", "capsule")
    const frames: number[][] = []
    await new Promise<void>((resolve) => {
      const frame = () => {
        frames.push([Number(getComputedStyle(today).opacity), Number(getComputedStyle(orb).opacity)])
        if (frames.length === 20) return resolve()
        requestAnimationFrame(frame)
      }
      requestAnimationFrame(frame)
    })
    return frames
  })
  if (!fade.some(([a, b]) => a > 0 && b > 0) || fade.some(([a, b]) => a + b < 0.99))
    throw new Error("Glyph swap popped or blanked")
  await page.waitForTimeout(5000)
  await page.emulateMedia({ reducedMotion: "reduce" })
  const reduced = await chip
    .locator('[data-component="css-agent-orb"]')
    .evaluate((orb) => orb.getAnimations({ subtree: true }).length)
  if (reduced !== 0) throw new Error("Reduced motion orb still animates")
  await page.screenshot({ path: path.join(out, "reduced.png") })
  await Bun.write(path.join(out, "proof.json"), JSON.stringify({ geometry, fade, reduced, errors }, null, 2))
  console.log(JSON.stringify({ geometry, reduced, errors }, null, 2))
  if (errors.length) throw new Error(errors.join("\n"))
} finally {
  const video = page.video()!
  await context.close()
  await video.saveAs(path.join(out, "real-time.webm"))
  await browser.close()
  server.stop()
  await rm(root, { recursive: true, force: true })
}
const video = Bun.spawn(
  [
    "ffmpeg",
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    path.join(out, "real-time.webm"),
    "-an",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    path.join(out, "real-time.mp4"),
  ],
  { stdout: "ignore", stderr: "inherit" },
)
if (await video.exited) throw new Error("Video encode failed")
