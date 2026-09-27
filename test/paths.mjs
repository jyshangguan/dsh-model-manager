/**
 * Shared path resolution for the test suite.
 *
 * Nothing here hardcodes a machine-specific location. The plugin is resolved
 * relative to this file, and the DSH installation is discovered from the `dsh`
 * executable on PATH (override with `DSH_INSTALL_DIR`). Tests that want to pin
 * their expectations against real harness internals use {@link dshFile} and fall
 * back to a local re-implementation when it returns `undefined`, so the suite
 * still runs — with a warning — on a machine without DSH installed.
 *
 * @module test/paths
 */
import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** This directory (`<repo>/test`). */
export const here = dirname(fileURLToPath(import.meta.url));

/** The package root. */
export const repoRoot = dirname(here);

/** Absolute path to the host half. */
export const PLUGIN = join(repoRoot, 'lib', 'index.js');

/** Absolute path to the client half. */
export const CLIENT = join(repoRoot, 'client.js');

let cached;

/**
 * The `@deepseek-ai/dsh` installation directory, or `null`.
 *
 * `DSH_INSTALL_DIR` overrides discovery and must point at the `@deepseek-ai/dsh`
 * package directory itself. Otherwise the `dsh` executable on PATH is resolved:
 * its symlink is followed first, because a global install puts the package under
 * `<prefix>/lib/node_modules` while the bin symlink sits in `<prefix>/bin`, so
 * resolving from the symlink path would never reach it.
 *
 * @returns {string | null}
 */
export function dshInstallDir() {
  if (cached !== undefined) return cached;
  cached = null;

  const override = process.env.DSH_INSTALL_DIR;
  if (override && existsSync(join(override, 'package.json'))) {
    cached = override;
    return cached;
  }

  const executables = [];
  try {
    const finder = process.platform === 'win32' ? 'where' : 'which';
    for (const line of execFileSync(finder, ['dsh'], { encoding: 'utf8' }).split('\n')) {
      const trimmed = line.trim();
      if (trimmed !== '') executables.push(trimmed);
    }
  } catch {
    /* `dsh` is not on PATH; the DSH-backed assertions will skip */
  }

  for (const executable of executables) {
    // Anchors to try, in order: the resolved real path, then the symlink itself.
    const anchors = [];
    try {
      anchors.push(realpathSync(executable));
    } catch {
      /* unresolvable symlink; fall through to the raw path */
    }
    anchors.push(executable);
    for (const anchor of anchors) {
      try {
        const from = anchor.endsWith('.js') ? anchor : join(anchor, 'anchor.js');
        const dir = dirname(createRequire(from).resolve('@deepseek-ai/dsh/package.json'));
        if (existsSync(join(dir, 'node_modules', '@deepseek-ai'))) {
          cached = dir;
          return cached;
        }
      } catch {
        /* try the next anchor */
      }
    }
  }
  return null;
}

/**
 * Absolute path to a file inside a DSH-shipped package, or `undefined`.
 * @param {string} packageName - bare name under the `@deepseek-ai` scope.
 * @param {string} relPath - path within that package, e.g. `lib/index.js`.
 * @returns {string | undefined}
 */
export function dshFile(packageName, relPath) {
  const dir = dshInstallDir();
  if (dir === null) return undefined;
  const full = join(dir, 'node_modules', '@deepseek-ai', packageName, relPath);
  return existsSync(full) ? full : undefined;
}
