// Tests import modules outside a dsh profile, so their @deepseek-ai peers resolve from a
// DeepSeek Harness, as a profile would supply them: DSH_HARNESS, else the packages that
// `npm run harness` installs in the repository's dev/harness, else the nearest
// deepseek-harness/ checkout in a folder above the repository, else the same search from the
// repository's place in the main worktree (a git worktree has no checkout of its own).
// The plugin has no dev/harness of its own, so the install and the checkout are
// looked up from the repository.
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire, registerHooks } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// The ocean-crew package; only imports from inside it are redirected to the harness.
const plugin = resolve(import.meta.dirname, '..')
// The repository checkout that holds it (and dev/harness next to it).
const repo = dirname(plugin)
const above = (start) => {
  for (let dir = start; ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'deepseek-harness'))) return join(dir, 'deepseek-harness')
    if (dirname(dir) === dir) return undefined
  }
}
const installed = join(repo, 'dev', 'harness')
const findHarness = () => {
  if (process.env.DSH_HARNESS) return process.env.DSH_HARNESS
  if (existsSync(join(installed, 'node_modules'))) return installed
  const near = above(repo)
  if (near) return near
  const beside = resolve(repo, '../deepseek-harness')
  try {
    const git = (...args) => execFileSync('git', ['-C', repo, 'rev-parse', ...args], { encoding: 'utf8' }).trim()
    const main = join(dirname(git('--path-format=absolute', '--git-common-dir')), git('--show-prefix'))
    // A linked worktree carries no node_modules: the main worktree's harness install is
    // the one already on this machine.
    const mainInstalled = join(main, 'dev', 'harness')
    if (existsSync(join(mainInstalled, 'node_modules'))) return mainInstalled
    return above(main) ?? beside
  } catch {
    return beside
  }
}
const harness = findHarness()
// Tests that load other harness packages (jsdom) read the same checkout.
process.env.DSH_HARNESS = harness
// A checkout links the packages into its base bundle; an npm install has them at its root.
const base = resolve(harness, 'packages/bundle/base/package.json')
const anchor = pathToFileURL(existsSync(base) ? base : resolve(harness, 'package.json')).href
const pluginUrl = `${pathToFileURL(plugin).href}/`
// Third-party packages a host module imports by bare name install with the plugin; a
// test tree has no install of its own, so resolve them from the reference checkout.
const rootRequire = createRequire(join(repo, 'package.json'))
const rootPackage = (specifier) => {
  try {
    return rootRequire.resolve(specifier)
  } catch {
    return undefined
  }
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@deepseek-ai/') && context.parentURL?.startsWith(pluginUrl)) {
      return nextResolve(specifier, { ...context, parentURL: anchor })
    }
    if (
      context.parentURL?.startsWith(pluginUrl) &&
      !specifier.startsWith('.') &&
      !specifier.startsWith('/') &&
      !specifier.startsWith('node:') &&
      !specifier.includes(':')
    ) {
      const resolved = rootPackage(specifier)
      if (resolved !== undefined) return { url: pathToFileURL(resolved).href, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
})
