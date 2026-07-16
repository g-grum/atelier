// Packages Atelier into a macOS .app bundle and installs it to ~/Applications.
// Re-runnable: bun run package:mac
//
// The bundle carries only the thin Electron shell (package.json + dist/) plus
// a runtime.json recording the absolute repo root and bun path captured now —
// a Dock launch gets a minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin), so the
// shell must spawn the server with an absolute bun and cwd inside the repo.

import { existsSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const desktopDir = join(repoRoot, 'apps', 'desktop')
const icnsPath = join(desktopDir, 'build', 'icon.icns')

async function run(cmd: string[], cwd: string): Promise<void> {
  console.log(`$ ${cmd.join(' ')}`)
  const proc = Bun.spawn(cmd, { cwd, stdout: 'inherit', stderr: 'inherit' })
  if ((await proc.exited) !== 0) throw new Error(`command failed: ${cmd.join(' ')}`)
}

// ── 1. Build the web UI and the desktop shell ─────────────────────────────
await run(['bun', 'run', 'build:web'], repoRoot)
await run(['bun', 'run', '--cwd', 'apps/desktop', 'build'], repoRoot)

if (!existsSync(icnsPath)) {
  throw new Error(`missing ${icnsPath} — run \`bun scripts/make-icons.ts\` first`)
}

// ── 2. Package into Atelier.app ───────────────────────────────────────────
// @electron/packager is a devDep of apps/desktop (isolated install layout),
// so resolve it from there rather than from this root-level script.
const packagerModule = (await import(
  Bun.resolveSync('@electron/packager', desktopDir)
)) as typeof import('@electron/packager')

const electronPkg = (await Bun.file(
  join(desktopDir, 'node_modules', 'electron', 'package.json')
).json()) as { version: string }

const bunPath = Bun.which('bun')
if (bunPath === null) throw new Error('bun not found on PATH')

const runtimeConfig = JSON.stringify({ repoRoot, bunPath }, null, 2)

const [appDir] = await packagerModule.packager({
  dir: desktopDir,
  name: 'Atelier',
  appBundleId: 'dev.germain.atelier',
  platform: 'darwin',
  arch: 'arm64',
  electronVersion: electronPkg.version,
  icon: icnsPath,
  out: join(repoRoot, 'dist-app'),
  overwrite: true,
  // Plain Contents/Resources/app directory — runtime.json must be editable
  // and inspectable next to the shell (no asar archive).
  asar: false,
  // Ship only the shell: package.json + dist/main.js (+ runtime.json below).
  ignore: [/^\/(src|node_modules|tsconfig\.json|build)(\/|$)/],
  prune: false,
  afterCopy: [
    // buildPath becomes Contents/Resources/app — written before signing.
    ({ buildPath }) => writeFile(join(buildPath, 'runtime.json'), runtimeConfig),
  ],
})

const builtApp = join(String(appDir), 'Atelier.app')
if (!existsSync(builtApp)) throw new Error(`packager did not produce ${builtApp}`)

// Re-seal the bundle ad-hoc: the packager edits Info.plist/icon/app after the
// prebuilt Electron was signed, which breaks the seal. A coherent ad-hoc
// signature keeps Gatekeeper and the arm64 loader happy for local installs.
await run(['codesign', '--force', '--deep', '--sign', '-', builtApp], repoRoot)
console.log(`packaged ${builtApp}`)

// ── 3. Install to ~/Applications (replace any previous install) ───────────
const installDir = join(homedir(), 'Applications')
const installedApp = join(installDir, 'Atelier.app')
await mkdir(installDir, { recursive: true })
await rm(installedApp, { recursive: true, force: true })
// ditto preserves symlinks, permissions and the code signature.
await run(['ditto', builtApp, installedApp], repoRoot)
console.log(`installed ${installedApp}`)
