// Generates the app icons from assets/logo.svg (single source of truth).
// Re-runnable: bun scripts/make-icons.ts
//
// Outputs (committed as build inputs):
//   apps/desktop/build/icon.icns  — assembled with the native `iconutil` from a
//     full .iconset (16 → 512@2x); macOS convention: the mark occupies ~80% of
//     the canvas, transparent margins around it.
//   apps/web/public/favicon.svg   — the mark itself (no margin), served as-is.

import { mkdir, mkdtemp, rm, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const logoSvg = join(repoRoot, 'assets', 'logo.svg')
const icnsOut = join(repoRoot, 'apps', 'desktop', 'build', 'icon.icns')
const faviconOut = join(repoRoot, 'apps', 'web', 'public', 'favicon.svg')

const LOGO_VIEWBOX = 512 // assets/logo.svg viewBox size, for density math
const MARK_RATIO = 0.8 // macOS margins: the mark fills ~80% of the icon canvas

/** Render the mark at `size` px with transparent macOS margins around it. */
async function renderIconPng(canvas: number, outFile: string): Promise<void> {
  const inner = Math.round(canvas * MARK_RATIO)
  const left = Math.floor((canvas - inner) / 2)
  const top = left
  // Density scales librsvg's rasterization so the vector renders crisp at the
  // target size instead of being resampled from the natural 512px raster.
  const density = (72 * inner) / LOGO_VIEWBOX
  await sharp(logoSvg, { density })
    .resize(inner, inner)
    .extend({
      top,
      bottom: canvas - inner - top,
      left,
      right: canvas - inner - left,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toFile(outFile)
}

// name → canvas px, per Apple's .iconset naming convention.
const ICONSET: Array<[name: string, px: number]> = [
  ['icon_16x16.png', 16],
  ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32],
  ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128],
  ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256],
  ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512],
  ['icon_512x512@2x.png', 1024],
]

const iconset = await mkdtemp(join(tmpdir(), 'atelier-icon-'))
const iconsetDir = join(iconset, 'icon.iconset')
await mkdir(iconsetDir)
try {
  await Promise.all(ICONSET.map(([name, px]) => renderIconPng(px, join(iconsetDir, name))))

  await mkdir(dirname(icnsOut), { recursive: true })
  const proc = Bun.spawn(['iconutil', '-c', 'icns', iconsetDir, '-o', icnsOut], {
    stdout: 'inherit',
    stderr: 'inherit',
  })
  if ((await proc.exited) !== 0) {
    throw new Error('iconutil failed to assemble the .icns')
  }
  console.log(`wrote ${icnsOut}`)

  await mkdir(dirname(faviconOut), { recursive: true })
  await copyFile(logoSvg, faviconOut)
  console.log(`wrote ${faviconOut}`)
} finally {
  await rm(iconset, { recursive: true, force: true })
}
