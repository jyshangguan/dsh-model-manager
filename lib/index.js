/**
 * @darkbear9494/dsh-model-manager — role-based model manager for DeepSeek Harness.
 *
 * Assign models to four roles (main / planning / execution / vision), route
 * subagent work to the right role, and report which model every subagent used.
 *
 * Design rules for this plugin (learned the hard way on DSH 0.1.7-rc.2):
 *   - No `settings.installSection` / `installSettingsSection` / `settingsNamespace`.
 *     That API was removed in 0.1.7; calling it fails *apply* and takes the whole
 *     plugin tree (and therefore startup) down. This host half instead exports a
 *     volatile `Config`, which the harness auto-generates a Settings form from
 *     (`autoGenerate` defaults to true) and which the Web client half in
 *     `client.js` renders as a model picker per role. Neither touches the removed
 *     settings API.
 *   - A volatile-only Settings save is committed in place and the loader returns
 *     before re-running `apply`, so `attach()` listens on
 *     `loader/volatile-update` to re-read this config.
 *   - No import of `@deepseek-ai/dsh-tools` / `dsh-llm` / `cordis`: those are not
 *     resolvable from a profile-installed plugin. Tools are registered in the
 *     normalized shape the registry expects, using plain JSON Schema.
 *   - Nothing optional may throw. Every integration is probed and wrapped, and
 *     `apply` has a final backstop: a misconfiguration must degrade routing,
 *     never prevent the harness from booting.
 *
 * @module @darkbear9494/dsh-model-manager
 */

import { readFileSync } from 'node:fs';

/**
 * Optional schema dependency.
 *
 * Loaded dynamically so that a resolution failure degrades — no schema
 * validation and no auto-generated Settings page — instead of aborting module
 * load, which would fail the loader entry and therefore *startup*. cordis's
 * `resolveConfig` treats a plugin with no `Config` export as valid and passes
 * the raw config straight through (`if (!runtime.Config) return config`), and
 * `readConfig` below already normalizes raw values defensively.
 */
let z;
try {
  z = (await import('@deepseek-ai/schemastery')).default;
} catch {
  z = undefined;
}

/** Stable Cordis identity. */
export const name = 'model-manager';

const ROLE_NAMES = ['main', 'planning', 'execution', 'vision'];

const KNOWN_TOP_KEYS = ['enabled', 'pick', 'roles', 'strategy', 'update'];
const KNOWN_ROLE_KEYS = ['models', 'note'];
const KNOWN_ROUTE_KEYS = ['provider', 'model', 'reasoningEffort'];
const KNOWN_STRATEGY_KEYS = ['mode', 'visionKeywords', 'planningKeywords', 'historyLimit', 'autoDelegate'];
const KNOWN_UPDATE_KEYS = ['enabled', 'registry', 'intervalHours'];

/**
 * Delegation-policy levels for `strategy.autoDelegate`.
 *
 *   off      — no policy section is rendered at all.
 *   balanced — the default: prefer subagents for multi-step and independent work.
 *   eager    — the top-level agent is instructed to orchestrate: nearly all
 *              substantive work goes to delegations.
 */
const DELEGATION_LEVELS = ['off', 'balanced', 'eager'];

/**
 * Delegation tools the policy may name. The text function checks each against
 * the assembly's scope (`tools.get(name, scope)`, the same probe
 * dsh-tool-subagent itself uses) so the policy never tells an agent to call a
 * tool it does not have.
 */
const DELEGATION_TOOL_NAMES = ['subagent', 'subagent_fork'];

/**
 * Order of the delegation-policy prompt section. Sits between the harness's
 * PLAN_POLICY (500) and TEAM_POLICY (600) placements, i.e. with the other
 * behavioural policy rows rather than with this plugin's routing cheat sheet.
 */
const DELEGATION_SECTION_ORDER = 550;

/** Registry path of this package on any npm-compatible registry. */
const UPDATE_PACKAGE_PATH = '@darkbear9494%2fdsh-model-manager';

/** Default registry consulted for the latest published version. */
const UPDATE_REGISTRY_DEFAULT = 'https://registry.npmjs.org';

/** Delay before the first update check, so boot is never blocked by it. */
const UPDATE_FIRST_CHECK_DELAY_MS = 10_000;

/** Per-request timeout for the registry fetch. */
const UPDATE_FETCH_TIMEOUT_MS = 10_000;

/** Floor for the re-check interval, so a mis-typed hour cannot hammer a registry. */
const UPDATE_MIN_INTERVAL_MS = 60_000;

/**
 * Bound on remembered manager-applied routes. Held independently of
 * `strategy.historyLimit` on purpose, so lowering that diagnostic limit can
 * never cause the manager to forget a route it assigned.
 */
const MANAGER_APPLIED_LIMIT = 4096;

/**
 * Provider/model failures eligible for failover.
 *
 * Deliberately excludes:
 *   - `ABORTED` — a user or parent cancellation, never a model problem; failing
 *     over would silently change the route the next request uses.
 *   - `INVALID_REQUEST` — a 400 is a request-content problem that another model
 *     will almost certainly reject identically, so switching just burns budget.
 *   - `IMAGE_OFFLOAD_REQUIRED` — owned by `dsh-compaction-image-offload`, which
 *     offloads images and retries in place.
 */
const FAILOVER_CODES = new Set([
  'SERVER', 'RATE_LIMIT', 'TIMEOUT', 'TRANSPORT', 'EMPTY_RESPONSE', 'STREAM_CLOSED',
  'MALFORMED_RESPONSE', 'PI_AI_ERROR', 'UNKNOWN', 'NO_ADAPTER',
  'INVALID_MODEL_INFO', 'INVALID_MODEL_CONTEXT', 'INVALID_MODEL_MAX_TOKENS',
  'AUTH', 'QUOTA', 'ACCOUNT_QUOTA', 'INVALID_CREDENTIAL',
  'CONTEXT_WINDOW_EXCEEDED', 'UNSUPPORTED_CONTENT', 'UNSUPPORTED_REASONING_EFFORT',
]);

/** `HTTP_5xx` fallback codes are provider failures too. */
const isFailoverCode = (code) => typeof code === 'string'
  && (FAILOVER_CODES.has(code) || code.startsWith('HTTP_5'));

/**
 * Bound on model switches within one step.
 *
 * The harness's attempt loop has no global cap — it exits only on success,
 * terminal failure, or abort — so without this a route that always fails could
 * ping-pong indefinitely.
 */
const MAX_SWITCHES_PER_STEP = 3;

/** Package name the browser module table keys this plugin's client half by. */
const PACKAGE_NAME = '@darkbear9494/dsh-model-manager';

/**
 * Loader row id this plugin is mounted as.
 *
 * Also the settings namespace the client half binds (`configForms`/`settings`
 * are keyed by row id — the shipped Subagent settings card binds its own row id
 * `subagent-model-selection-settings` the same way).
 */
const ROW_ID = 'model-manager';

// No 'figure' here on purpose: in coding labels "figure out the bug" is far more
// common than "read figure 3", and a genuine figure-reading unit can always say
// so with a leading `vision:` prefix (which outranks every keyword). Anyone who
// wants it back can re-add it via `strategy.visionKeywords`.
const DEFAULT_VISION_KEYWORDS = [
  'vision', 'visual', 'image', 'images', 'screenshot', 'screen shot', 'ocr',
  'diagram', 'chart', 'plot', 'photo', 'picture', 'png', 'jpg',
  'jpeg', 'webp', 'gif', 'ui mock', 'render',
];

const DEFAULT_PLANNING_KEYWORDS = [
  'plan', 'planning', 'design', 'architect', 'architecture', 'analyse',
  'analyze', 'analysis', 'research', 'investigate', 'review', 'critique',
  'strategy', 'reasoning', 'reason', 'compare', 'evaluate', 'assess',
  'spec', 'specification', 'decompose', 'breakdown', 'proposal', 'root cause',
];

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * Build the row schema.
 *
 * Kept inside a function so that nothing touches `z` unless the optional
 * dependency actually loaded.
 */
function buildConfigSchema(z) {
  const RouteSchema = z.object({
    provider: z.string().required(),
    model: z.string().required(),
    reasoningEffort: z.string(),
  });

  const RoleSchema = z.object({
    models: z.array(RouteSchema).default([]),
    note: z.string(),
  });

  const StrategySchema = z.object({
    mode: z.union([z.const('hybrid'), z.const('managed'), z.const('advisory')]).default('hybrid'),
    visionKeywords: z.array(z.string()).default(DEFAULT_VISION_KEYWORDS),
    planningKeywords: z.array(z.string()).default(DEFAULT_PLANNING_KEYWORDS),
    historyLimit: z.number().default(300),
    autoDelegate: z.union([z.const('off'), z.const('balanced'), z.const('eager')]).default('balanced'),
  });

  const UpdateSchema = z.object({
    enabled: z.boolean().default(true),
    registry: z.string().default(UPDATE_REGISTRY_DEFAULT),
    intervalHours: z.number().default(24),
  });

  /**
   * Row config.
   *
   * Every field is volatile so the client card can edit it through the shared
   * settings form and have the change apply without a remount. A volatile-only
   * save is committed in place *without* re-running `apply`, which is why
   * `attach()` listens on `loader/volatile-update` to re-read this config.
   */
  return z.object({
    /** Master switch: when false the manager observes and reports but never rewrites a route. */
    enabled: z.boolean().default(true).volatile(),
    /**
     * One selection strategy for every role (0.2.0). `first` treats each role's
     * ordered list as a failover chain: index 0 first, failures move down.
     * `round-robin` rotates across each role's list instead.
     */
    pick: z.union([z.const('first'), z.const('round-robin')]).default('first').volatile(),
    roles: z.object({
      main: RoleSchema.default({}),
      planning: RoleSchema.default({}),
      execution: RoleSchema.default({}),
      vision: RoleSchema.default({}),
    }).default({}).volatile(),
    strategy: StrategySchema.default({}).volatile(),
    /**
     * Automatic update check against the package registry. Checked once shortly
     * after boot, then on the interval; a newer release is logged, surfaced by
     * the `model_manager` tool (action "update") and reported by `routes`.
     */
    update: UpdateSchema.default({}).volatile(),
  });
}

/**
 * Row schema, or `undefined` when the optional schema dependency is missing or
 * incompatible.
 *
 * Built inside a guard on purpose: a module-evaluation failure here would fail
 * the loader entry and therefore startup, which is the one failure this plugin
 * must never cause. Without a schema cordis's `resolveConfig` passes the raw
 * config through and `readConfig` normalizes it — routing still works, only
 * schema validation and the auto-generated Settings page are skipped.
 */
let Config;
try {
  Config = z === undefined ? undefined : buildConfigSchema(z);
} catch {
  Config = undefined;
}
export { Config };

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Unwrap a volatile ref if the loader gave us one, else return the value. */
function readVal(value) {
  if (value !== null && typeof value === 'object' && typeof value.get === 'function') {
    try {
      return value.get();
    } catch {
      return undefined;
    }
  }
  return value;
}

/**
 * Normalize a keyword list.
 *
 * An absent list takes the built-in default; an explicit `[]` is honoured and
 * disables that classifier, which is the only way to switch one off.
 */
function asStringArray(value, fallback) {
  const raw = readVal(value);
  if (!Array.isArray(raw)) return fallback;
  return raw
    .filter((item) => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

function normalizeRoute(raw) {
  const value = readVal(raw);
  if (value === null || typeof value !== 'object') return undefined;
  const provider = typeof value.provider === 'string' ? value.provider.trim() : '';
  const model = typeof value.model === 'string' ? value.model.trim() : '';
  if (provider === '' || model === '') return undefined;
  const effort = typeof value.reasoningEffort === 'string' ? value.reasoningEffort.trim() : '';
  return { provider, model, ...(effort === '' ? {} : { reasoningEffort: effort }) };
}

function unknownKeys(source, known) {
  const value = readVal(source);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.keys(value).filter((key) => !known.includes(key));
}

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

/** A strict semver-shaped version: `v?MAJOR.MINOR.PATCH[-prerelease][+build]`. */
const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-((?:[0-9A-Za-z-]+)(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * Parse a semver-shaped version string.
 *
 * Both sides of the update comparison come from `package.json` fields (this
 * package's own and the registry packument's `dist-tags.latest`), so a strict
 * shape check is enough: anything else is reported unparseable rather than
 * guessed at.
 * @returns `{ major, minor, patch, prerelease }` or `undefined`.
 */
function parseVersion(input) {
  if (typeof input !== 'string') return undefined;
  const match = VERSION_RE.exec(input.trim());
  if (match === null) return undefined;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) {
    return undefined;
  }
  const prerelease = match[4] === undefined || match[4] === '' ? [] : match[4].split('.');
  return { major, minor, patch, prerelease };
}

/**
 * Compare two prerelease identifier lists per semver: numeric identifiers
 * compare numerically and sort below alphanumeric ones, alphanumeric compare
 * in ASCII order, and a shorter list sorts below a longer one when it is a
 * prefix of it. An empty list (no prerelease) sorts ABOVE any prerelease.
 */
function comparePrerelease(a, b) {
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  for (let index = 0; index < a.length || index < b.length; index += 1) {
    const x = a[index];
    const y = b[index];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) {
      if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1;
    } else if (xNumeric) return -1;
    else if (yNumeric) return 1;
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * Compare two version strings, semver-style including prereleases.
 * @returns `-1 | 0 | 1`, or `undefined` when either side does not parse.
 */
function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (left === undefined || right === undefined) return undefined;
  if (left.major !== right.major) return left.major < right.major ? -1 : 1;
  if (left.minor !== right.minor) return left.minor < right.minor ? -1 : 1;
  if (left.patch !== right.patch) return left.patch < right.patch ? -1 : 1;
  return comparePrerelease(left.prerelease, right.prerelease);
}

/** Cached own version, read from this package's `package.json`. `null` = unreadable. */
let cachedInstalledVersion;

/**
 * This package's own version, straight from its `package.json`.
 *
 * Read from the manifest next to `lib/index.js` rather than hardcoded, so a
 * git checkout, an npm install and a tarball install all report what actually
 * shipped — the version in `client.js` is a pinned fallback for the browser
 * only, and a packaging test keeps the two equal.
 * @returns {string | null}
 */
function installedVersion() {
  if (cachedInstalledVersion !== undefined) return cachedInstalledVersion;
  let version;
  try {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    if (typeof manifest.version === 'string' && manifest.version.trim() !== '') {
      version = manifest.version.trim();
    }
  } catch {
    version = undefined;
  }
  cachedInstalledVersion = version ?? null;
  return cachedInstalledVersion;
}

/**
 * The profile name this process booted, from the host's working directory
 * (`$DSH_HOME/profiles/<name>` per the harness's own docs), so the upgrade
 * command can be printed ready to paste. `undefined` when the layout does not
 * match; the command then shows a `<profile>` placeholder instead.
 */
function profileHint() {
  try {
    const segments = process.cwd().split(/[\\/]/).filter((segment) => segment !== '');
    const at = segments.lastIndexOf('profiles');
    if (at >= 0 && at + 1 < segments.length) return segments[at + 1];
  } catch {
    /* fall through to the placeholder */
  }
  return undefined;
}

/** An abort signal that fires after `ms`, on whatever abort API exists. */
function timeoutSignal(ms) {
  try {
    if (typeof AbortSignal?.timeout === 'function') return AbortSignal.timeout(ms);
  } catch {
    /* fall through to the manual controller */
  }
  if (typeof AbortController !== 'function') return undefined;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    try {
      controller.abort(new Error(`timed out after ${ms}ms`));
    } catch {
      controller.abort();
    }
  }, ms);
  if (typeof timer?.unref === 'function') timer.unref();
  return controller.signal;
}

/**
 * Sanitize a configured registry URL: trim, drop trailing slashes, and keep
 * only http(s) origins. Anything else falls back to the npm default.
 */
function sanitizeRegistry(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!/^https?:\/\//i.test(text)) return UPDATE_REGISTRY_DEFAULT;
  return text.replace(/\/+$/, '');
}

/**
 * Normalize `update.intervalHours`.
 *
 * Absent, malformed or negative values mean the 24h default; an explicit `0`
 * is honoured as "check at boot only" — `enabled: false` is the off switch.
 */
function normalizeIntervalHours(value) {
  const raw = readVal(value);
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 24;
  if (raw === 0) return 0;
  if (raw < 0) return 24;
  return raw;
}

/** Coerce raw row config into a total, always-usable shape. */
function readConfig(raw) {
  const warnings = [];
  const rolesRaw = readVal(raw?.roles) ?? {};
  const strategyRaw = readVal(raw?.strategy) ?? {};
  const updateRaw = readVal(raw?.update) ?? {};

  for (const key of unknownKeys(raw, KNOWN_TOP_KEYS)) warnings.push(`unknown config key "${key}" ignored`);
  for (const key of unknownKeys(rolesRaw, ROLE_NAMES)) warnings.push(`unknown role "${key}" ignored`);
  for (const key of ROLE_NAMES) {
    for (const bad of unknownKeys(readVal(rolesRaw?.[key]), KNOWN_ROLE_KEYS)) {
      warnings.push(bad === 'pick'
        ? `"roles.${key}.pick" moved to the top-level "pick" in 0.2.0; the per-role value is ignored`
        : `unknown key "roles.${key}.${bad}" ignored`);
    }
  }
  for (const key of unknownKeys(strategyRaw, KNOWN_STRATEGY_KEYS)) warnings.push(`unknown key "strategy.${key}" ignored`);
  for (const key of unknownKeys(updateRaw, KNOWN_UPDATE_KEYS)) warnings.push(`unknown key "update.${key}" ignored`);

  const readRole = (key) => {
    const role = readVal(rolesRaw?.[key]) ?? {};
    const rawModels = Array.isArray(role.models) ? role.models : [];
    const models = rawModels.map(normalizeRoute).filter((route) => route !== undefined);
    for (const rawModel of rawModels) {
      for (const bad of unknownKeys(rawModel, KNOWN_ROUTE_KEYS)) {
        warnings.push(`unknown key "roles.${key}.models[].${bad}" ignored`
          + (bad === 'reasoning_effort' ? ' — the key is "reasoningEffort"' : ''));
      }
    }
    return {
      models,
      note: typeof role.note === 'string' && role.note.trim() !== '' ? role.note.trim() : undefined,
    };
  };

  const mode = strategyRaw.mode;
  const limit = strategyRaw.historyLimit;
  const autoDelegate = strategyRaw.autoDelegate;
  return {
    // Only an explicit `false` switches the manager off. A missing or malformed
    // value keeps it on, so a typo can never silently disable routing.
    enabled: readVal(raw?.enabled) !== false,
    // One strategy for every role; anything that is not 'round-robin' is 'first'.
    pick: readVal(raw?.pick) === 'round-robin' ? 'round-robin' : 'first',
    roles: Object.fromEntries(ROLE_NAMES.map((key) => [key, readRole(key)])),
    strategy: {
      mode: mode === 'managed' || mode === 'advisory' ? mode : 'hybrid',
      visionKeywords: asStringArray(strategyRaw.visionKeywords, DEFAULT_VISION_KEYWORDS),
      planningKeywords: asStringArray(strategyRaw.planningKeywords, DEFAULT_PLANNING_KEYWORDS),
      // Guard against a positive fraction flooring to 0, which would evict every
      // record immediately and silently disable usage tracking.
      historyLimit: Number.isFinite(limit) && limit > 0 ? Math.max(1, Math.floor(limit)) : 300,
      // The delegation-policy level; anything unrecognised falls back to the
      // default level rather than silently switching the policy off.
      autoDelegate: autoDelegate === 'off' || autoDelegate === 'eager' || autoDelegate === 'balanced'
        ? autoDelegate
        : 'balanced',
    },
    update: {
      // Same fail-on philosophy as the master switch: only explicit `false`
      // stops the checks.
      enabled: readVal(updateRaw.enabled) !== false,
      registry: sanitizeRegistry(readVal(updateRaw.registry)),
      // Absent/malformed -> 24h; explicit 0 -> boot-only checks.
      intervalHours: normalizeIntervalHours(updateRaw.intervalHours),
    },
    warnings,
  };
}

/** Best-effort logger; never throws, whatever the host provides. */
function makeLogger(ctx) {
  let logger;
  try {
    logger = typeof ctx?.logger === 'function' ? ctx.logger('model-manager') : undefined;
  } catch {
    logger = undefined;
  }
  return (level, message) => {
    const text = `[model-manager] ${message}`;
    try {
      if (logger && typeof logger[level] === 'function') {
        logger[level](text);
        return;
      }
    } catch {
      /* fall through to console */
    }
    try {
      if (level === 'error') console.error(text);
      else if (level === 'warn') console.warn(text);
      else console.log(text);
    } catch {
      /* nothing else we can do */
    }
  };
}

/** Run a probe against the live context, returning undefined instead of throwing. */
function probe(fn) {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

/** Whether plan mode is currently in force for an agent. Never throws. */
function planActive(ctx, agent) {
  const live = probe(() => {
    const controller = ctx.get('planMode');
    if (controller === undefined || typeof controller.get !== 'function') return undefined;
    const state = controller.get(agent);
    return state === undefined ? undefined : Boolean(state.pending ?? state.active);
  });
  if (live !== undefined) return live;
  const projected = probe(() => {
    const projections = ctx.get('sessionProjections');
    if (projections === undefined || typeof projections.stateOf !== 'function') return undefined;
    const state = projections.stateOf(agent.session, 'plan');
    return state === undefined ? undefined : Boolean(state.active);
  });
  return projected === undefined ? false : projected;
}

/** Find the delegating parent of a child session. */
function findParent(ctx, childId) {
  return probe(() => {
    const agents = ctx.get('agents');
    if (agents === undefined || typeof agents.list !== 'function') return undefined;
    if (typeof agents.isOwnedBy !== 'function') return undefined;
    return agents.list().find((candidate) => {
      if (candidate.id === childId) return false;
      try {
        return agents.isOwnedBy(childId, candidate) === true;
      } catch {
        return false;
      }
    });
  });
}

/**
 * The route a delegating parent actually passes to a child.
 *
 * Mirrors DSH's own `parentAgentOptionsForDelegation`: after request-time
 * selection the parent's **latest request header** owns provider and model, and
 * creation options are only the pre-first-request fallback. Comparing against
 * `parent.options` instead would misread a manager-rewritten parent as an
 * explicit child choice and silently disable routing.
 */
function effectiveRouteOf(agent) {
  const fromHeader = probe(() => {
    const config = agent.session?.requestHeader?.()?.config;
    if (config === undefined) return undefined;
    return config.provider !== undefined && config.model !== undefined
      ? { provider: config.provider, model: config.model }
      : undefined;
  });
  if (fromHeader !== undefined) return fromHeader;
  return probe(() => {
    const options = agent.options;
    if (options === undefined) return undefined;
    return options.provider !== undefined && options.model !== undefined
      ? { provider: options.provider, model: options.model }
      : undefined;
  });
}

/**
 * Read the routes the delegation tool will accept.
 *
 * Returns `{ unavailable: true }` when the composition has no such service, or
 * `{ error }` when the settings owner refuses to report — importantly, its
 * `current()` *throws* when model selection is enabled with an empty allow-list,
 * which is a configuration problem and must not be reported as a missing service.
 */
function readAllowList(ctx) {
  const selection = probe(() => ctx.get('subagentModelSelection'));
  if (selection === undefined || typeof selection.current !== 'function') return { unavailable: true };
  let current;
  try {
    current = selection.current();
  } catch (error) {
    return { error: String(error?.message ?? error) };
  }
  if (current === null || typeof current !== 'object') return { unavailable: true };
  const routes = Array.isArray(current.allowedModels) ? current.allowedModels : [];
  return {
    enabled: current.enabled === true,
    allowed: routes
      .filter((route) => route && typeof route.provider === 'string' && typeof route.model === 'string')
      .map((route) => ({ provider: route.provider, model: route.model })),
  };
}

const routeKey = (route) => `${route.provider}\u0000${route.model}`;

/**
 * Apply a role route to a resolved call config.
 *
 * Switching route drops an inherited adapter-owned reasoning effort, because the
 * destination model may not accept the previous one and `prepareCall` rejects
 * unsupported explicit efforts rather than clamping. An effort named by the role
 * is applied instead.
 */
function applyRoute(resolved, route) {
  const sameRoute = resolved.provider === route.provider && resolved.model === route.model;
  const effort = route.reasoningEffort;
  if (sameRoute && effort === undefined) return resolved;
  const { reasoningEffort: inherited, ...rest } = resolved;
  void inherited;
  return {
    ...(sameRoute ? resolved : rest),
    provider: route.provider,
    model: route.model,
    ...(effort === undefined ? {} : { reasoningEffort: effort }),
  };
}

const shortId = (id) => String(id ?? '').slice(0, 10).padEnd(10);

const quoteLabel = (label) => {
  if (typeof label !== 'string' || label.trim() === '') return '(unlabelled)';
  const text = label.trim().replace(/\s+/g, ' ').replace(/"/g, "'");
  return text.length > 42 ? `"${text.slice(0, 41)}…"` : `"${text}"`;
};

/**
 * Key of a failover cursor: per (session, role), never per session alone.
 *
 * A session can serve different roles over its life — plan mode moves the
 * top-level agent between `main` and `planning` on every request — and the
 * roles' chains are independent lists. Keying by session only let one role's
 * wear push every other role off its first model.
 */
const failoverKey = (sessionId, role) => `${sessionId}::${role}`;

/**
 * Build a keyword matcher.
 *
 * Anchored with a **leading** word boundary only: that stops `spec` matching
 * `inspect`, while still letting `screenshot` match `screenshots`.
 */
function keywordMatcher(keywords) {
  const patterns = [];
  for (const keyword of keywords) {
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`\\b${escaped}`, 'i');
    patterns.push(pattern);
  }
  return (text) => patterns.some((pattern) => pattern.test(text));
}

// ---------------------------------------------------------------------------
// Delegation policy text
// ---------------------------------------------------------------------------

/**
 * Render the model-facing delegation policy for one level.
 *
 * Pure on purpose: the decision *whether* to render (config, agent lineage,
 * tool availability) lives in the engine's `delegationPolicy`, so this text is
 * directly unit-testable and the engine only ever swaps the level, the
 * available tool names, and which tiers actually have models behind the labels
 * it teaches — a tier with no configured route is never advertised.
 *
 * @param {'balanced' | 'eager'} level - the policy level.
 * @param {string[]} toolNames - delegation tools the target agent actually has.
 * @param {{ planning?: boolean, vision?: boolean, routed?: boolean }} [opts]
 *        `planning` / `vision`: whether that tier has models to route to (both
 *        default to true, so a bare caller keeps the full text). `routed`:
 *        whether a label can actually change the model — false under
 *        `advisory`, where warning about `provider`/`model` would be noise
 *        because nothing is routed at all.
 * @returns {string} the policy, or `''` when there is nothing to say.
 */
function delegationPolicyText(level, toolNames, opts) {
  const has = (name) => toolNames.includes(name);
  const subagent = has('subagent') || has('subagent_fork');
  if (!subagent) return '';
  const planning = opts?.planning !== false;
  const vision = opts?.vision !== false;
  const routed = opts?.routed !== false;
  const fork = has('subagent_fork')
    ? ' Prefer `subagent_fork` when a unit needs this conversation\'s own context.'
    : '';
  const subagentTool = has('subagent') ? '`subagent`' : '`subagent_fork`';
  const planTag = planning ? ' as a `plan:` unit' : ' to a delegation';
  const head = level === 'eager'
    ? [
      '## Delegation policy (model-manager, eager)',
      '',
      'You are the orchestrator: decomposition, dispatch, and synthesis are your job, and',
      'nearly all substantive work — research, analysis, implementation, review, verification —',
      'belongs in delegations.',
      '',
      `- Decompose the request into self-contained units before doing anything else, the`,
      `  decomposition itself going out${planTag}, and dispatch them as ${subagentTool}`,
      `  delegations, several in a single message when they are independent.${fork}`,
      '- Do work yourself only when no delegation can carry it: a single trivial step, or an',
      '  action that requires this session\'s interactive tools (approvals, user questions).',
      '- Collect results as delegations finish, verify each one, re-delegate what missed, and',
      '  synthesize the final answer from what came back.',
    ]
    : [
      '## Delegation policy (model-manager, balanced)',
      '',
      'Default to solving substantive work through subagents instead of doing it all yourself.',
      '',
      '- Plan first: when a task needs more than a few steps, delegate the decomposition',
      `  itself${planTag}, then dispatch the units it returned — research, analysis,`,
      '  implementation of separate areas, review, verification — together.',
      `- Dispatch each unit as a ${subagentTool} delegation — independent units go together in`,
      `  a single message — and continue useful work while they run.${fork}`,
      '- Keep for yourself what does not pay to delegate: coordination, single-step reads or',
      '  tiny edits, decisions that need the user, and the final synthesis of every result.',
      '- Verify what delegations return before presenting it as done; re-delegate or fix',
      '  yourself when a result misses.',
    ];
  const tierLines = [
    planning
      ? '- `plan:` — the unit has to be thought through before it is done: design, analysis,'
        + '\n  research, decomposition, review, trade-offs.'
      : '',
    vision
      ? '- `vision:` — the unit reads images, screenshots, diagrams, or OCRs a picture.'
      : '',
    '- plain — mechanical execution: edits, lookups, formatting, straightforward commands.',
  ].filter(Boolean);
  const taught = [planning ? '`plan:`' : '', vision ? '`vision:`' : ''].filter(Boolean).join('/');
  const matchLines = [];
  if (planning && vision) {
    matchLines.push(
      '- A leading prefix decides the tier; a label without one falls back to keyword',
      '  matching, and a keyword label that fits both tiers goes to `vision`.',
    );
  } else if (planning || vision) {
    matchLines.push(
      '- A leading prefix decides the tier; a label without one falls back to keyword matching.',
    );
  }
  if ((planning || vision) && routed) {
    matchLines.push(
      `- Omit \`provider\` and \`model\` on ${taught} units — a route named explicitly`,
      '  on the delegation overrides the tier.',
    );
  }
  return [
    ...head,
    '',
    'Label each delegation by the kind of work it carries — the label picks the model:',
    ...tierLines,
    ...matchLines,
    '- Never invent results for delegations that have not answered; wait for or collect them.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

function createEngine(initialConfig, ctx, log, rawConfig) {
  /**
   * Live config. Reassigned when the harness commits a volatile-only Settings
   * edit: the loader applies those in place and returns *before* re-running
   * `apply`, so without this re-read the Settings page would save successfully
   * while routing kept its boot-time values until the next restart.
   */
  let config = initialConfig;
  /** child session id -> catalog facts */
  const catalog = new Map();
  /** session id -> last observed route decision (insertion-ordered, LRU-refreshed) */
  const usage = new Map();
  /**
   * session id -> route key this manager itself applied.
   *
   * Deliberately separate from `usage`, which is LRU-capped by `historyLimit`.
   * If ownership lived only there, lowering the limit would evict a record and
   * the manager would afterwards misreport its own route as an explicit caller
   * choice and stop managing that child permanently.
   */
  const managerApplied = new Map();
  const roundRobin = new Map();
  /** child session id -> in-flight single-child lookup, to coalesce bursts */
  const childLookups = new Map();
  /**
   * session id -> how far down its role's ordered model list a failure has
   * pushed it.
   *
   * Only `agent/request-error` advances this, so a request can never
   * double-advance. The list order IS the failover order: index 0 is tried
   * first, and each genuine provider failure moves one step down.
   */
  const failover = new Map();
  /** session id -> `{ key: '<turn>:<step>', switches }`, the per-step budget. */
  const stepSwitches = new Map();

  /**
   * The `tools` service, captured when its injection resolves, so the
   * delegation-policy section can ask which delegation tools an assembly's
   * scope actually sees (`tools.get(name, scope)`) — the same probe
   * dsh-tool-subagent's own prompt section uses.
   */
  let toolsService;

  /**
   * Latest update-check outcome. Statuses: `idle` (not yet checked), `checking`,
   * `ok` (up to date), `available` (a newer release exists), `error` (the check
   * failed), `disabled` (checks switched off in config).
   */
  let updateState = { status: 'idle' };

  /** Coalesces concurrent update checks. */
  let updateInFlight;

  /** Fallback timer handles for the update schedule, cleared when re-armed. */
  let updateTimers = [];

  const roleOf = (key) => config.roles[key];

  let visionMatch = keywordMatcher(config.strategy.visionKeywords);
  let planningMatch = keywordMatcher(config.strategy.planningKeywords);

  /** The model list a role actually resolves to, including the vision fallback. */
  function effectiveModels(key) {
    const role = roleOf(key);
    if (role && role.models.length > 0) return role.models;
    if (key === 'vision') return roleOf('execution')?.models ?? [];
    return [];
  }

  /**
   * Choose a route for a role without committing a round-robin advance.
   *
   * The counter is committed only when the route is actually applied, so an
   * advisory pass or a respected explicit choice does not consume a turn of the
   * rotation. One strategy (`config.pick`) governs every role; the rotation
   * counter itself stays per-role so each list rotates independently.
   *
   * `sessionId` selects the failover position for `pick: 'first'`, where the
   * ordered list is a failover chain rather than a rotation. The cursor is
   * keyed per (session, role): a session that failed over while it was serving
   * `planning` (say, in plan mode) must not come back to `main` already pushed
   * off `main`'s first model — each tier's chain wears down independently.
   */
  function routeCandidate(key, sessionId) {
    const models = effectiveModels(key);
    if (models.length === 0) return undefined;
    if (models.length === 1) return { route: models[0], commit() {} };
    const owner = roleOf(key)?.models.length > 0 ? key : 'execution';
    if (config.pick === 'round-robin') {
      const index = roundRobin.get(owner) ?? 0;
      return {
        route: models[index],
        commit() {
          roundRobin.set(owner, (index + 1) % models.length);
        },
      };
    }
    const at = Math.min(failover.get(failoverKey(sessionId, key)) ?? 0, models.length - 1);
    return { route: models[at], commit() {} };
  }

  /**
   * Which role owns a delegated child, from its delegation label.
   *
   * A leading `plan:` / `vision:` prefix is authoritative — it is the one signal
   * the delegating model writes *on purpose*, so it must beat the keyword scan.
   * That is what the policy text teaches, so honouring it makes the documented
   * rule true: "plan: analyse the screenshots" is planning work even though a
   * bare keyword label fitting both tiers goes to vision.
   */
  function classifySubagent(label) {
    const text = String(label ?? '').trim();
    if (text === '') return 'execution';
    const lower = text.toLowerCase();
    if (lower.startsWith('plan:')) return 'planning';
    if (lower.startsWith('vision:')) return 'vision';
    if (visionMatch(text)) return 'vision';
    if (planningMatch(text)) return 'planning';
    return 'execution';
  }

  /**
   * The delegation policy for one prompt assembly, or `''` when none applies.
   *
   * Rendered only for the *orchestrating* top-level agent: a delegated child
   * already carries the harness's fixed `subagent:delegation` runtime context,
   * and encouraging a child to delegate further would push every unit one more
   * depth level down for no benefit. Depth is read from the session header the
   * same way `delegationDepthOf` does (`header.delegationDepth ?? 0`).
   *
   * Tool availability is verified against the assembly's own scope, so an agent
   * whose composition restricted the delegation tools never sees a policy
   * naming a tool it cannot call. Tier availability is passed through too, so
   * the text never advertises a `plan:` or `vision:` tier that has no models
   * behind it, and never warns about `provider`/`model` overrides in `advisory`
   * mode where nothing is routed at all.
   */
  function delegationPolicy(context) {
    try {
      if (!config.enabled) return '';
      const level = config.strategy.autoDelegate;
      if (level === 'off') return '';
      const agent = context?.agent;
      if (agent !== undefined) {
        const header = agent.session?.header;
        if (header?.origin === 'subagent') return '';
        const depth = header?.delegationDepth;
        if (typeof depth === 'number' && depth > 0) return '';
      }
      if (toolsService === undefined || typeof toolsService.get !== 'function') return '';
      const scope = context?.scope;
      const available = DELEGATION_TOOL_NAMES
        .filter((name) => probe(() => toolsService.get(name, scope)) !== undefined);
      return delegationPolicyText(level, available, {
        planning: effectiveModels('planning').length > 0,
        vision: effectiveModels('vision').length > 0,
        routed: config.strategy.mode !== 'advisory',
      });
    } catch {
      // A prompt section must never throw: an empty policy degrades to the
      // harness's own behaviour, which is exactly the pre-0.3.0 state.
      return '';
    }
  }

  function remember(sessionId, entry) {
    const previous = usage.get(sessionId);
    // Re-insert so the map stays in least-recently-used order for eviction.
    if (previous !== undefined) usage.delete(sessionId);
    usage.set(sessionId, {
      ...(previous ?? {}),
      ...entry,
      requests: (previous?.requests ?? 0) + 1,
      at: Date.now(),
    });
    while (usage.size > config.strategy.historyLimit) {
      const oldest = usage.keys().next().value;
      if (oldest === undefined) break;
      usage.delete(oldest);
    }
  }

  /** Cache one parent's direct children. */
  async function cacheChildrenOf(parentId) {
    const subagents = probe(() => ctx.get('subagents'));
    if (!subagents || typeof subagents.listChildren !== 'function') return false;
    let children;
    try {
      children = await subagents.listChildren(parentId);
    } catch {
      return false;
    }
    if (!Array.isArray(children)) return false;
    for (const child of children) {
      if (!child || child.id === undefined) continue;
      catalog.set(child.id, {
        label: typeof child.label === 'string' ? child.label : undefined,
        parentId,
        mode: child.mode,
        createdAt: child.createdAt,
      });
    }
    return true;
  }

  /** Refresh the child catalog for every live agent (used by reporting). */
  async function refreshCatalog() {
    const agents = probe(() => ctx.get('agents'));
    if (!agents || typeof agents.list !== 'function') return false;
    let found = false;
    for (const agent of agents.list()) {
      if (await cacheChildrenOf(agent.id)) found = true;
    }
    return found;
  }

  /**
   * Resolve one child's catalog facts on demand.
   *
   * Deliberately not latched behind a one-shot "catalog loaded" flag: a child
   * created after the first lookup must still be resolvable on its first
   * request, otherwise the very delegations the manager exists to route would
   * fall through to the default role.
   */
  function lookupChild(childId) {
    const known = catalog.get(childId);
    if (known !== undefined) return Promise.resolve(known);
    const inFlight = childLookups.get(childId);
    if (inFlight !== undefined) return inFlight;
    const pending = (async () => {
      const parent = findParent(ctx, childId);
      if (parent !== undefined) await cacheChildrenOf(parent.id);
      // Fall back to a full sweep when lineage could not be resolved.
      if (!catalog.has(childId)) await refreshCatalog();
      return catalog.get(childId);
    })().catch(() => undefined).finally(() => {
      childLookups.delete(childId);
    });
    childLookups.set(childId, pending);
    return pending;
  }

  async function factsFor(childId) {
    return catalog.get(childId) ?? (await lookupChild(childId));
  }

  // -- request routing ------------------------------------------------------

  async function onAgentRequest(payload, next) {
    const resolved = await next();
    try {
      const agent = payload?.agent;
      if (agent === undefined) return resolved;
      const isSubagent = probe(() => agent.session?.header?.origin === 'subagent') === true;

      let role;
      let label;
      if (isSubagent) {
        const facts = await factsFor(agent.id);
        label = facts?.label;
        role = classifySubagent(label);
      } else {
        role = planActive(ctx, agent) ? 'planning' : 'main';
      }

      // Master switch off: observe and record, but never rewrite a route. The
      // record is what makes `model_manager report` useful even with routing
      // disabled — "which model did this subagent use" is a question the user
      // still wants answered.
      if (!config.enabled) {
        remember(agent.id, {
          role,
          label,
          isSubagent,
          provider: resolved.provider,
          model: resolved.model,
          reasoningEffort: resolved.reasoningEffort,
          reason: 'manager disabled (observed only)',
          applied: false,
          parentId: catalog.get(agent.id)?.parentId,
        });
        return resolved;
      }

      // Record the attempt group, so the failover budget is per (turn, step).
      // `agent/request` re-fires for every attempt of the same step, so this
      // resets only when the step actually changes.
      const stepKey = `${payload?.turn}:${payload?.step}`;
      const tracked = stepSwitches.get(agent.id);
      if (tracked === undefined || tracked.key !== stepKey) {
        stepSwitches.set(agent.id, { key: stepKey, switches: 0 });
      }

      const candidate = routeCandidate(role, agent.id);
      if (candidate === undefined) {
        remember(agent.id, {
          role,
          provider: resolved.provider,
          model: resolved.model,
          reason: 'passthrough (role unconfigured)',
          applied: false,
          isSubagent,
          label,
        });
        return resolved;
      }
      const route = candidate.route;

      const mode = config.strategy.mode;
      let reason = 'applied';
      let didApply = false;
      let output;

      if (mode === 'advisory') {
        reason = 'advisory (not applied)';
        output = resolved;
      } else {
        let inherited = true;
        if (mode === 'hybrid' && !isSubagent && selectionWasExplicit(agent)) {
          // `main` replaces a route the user never chose; it does not overrule
          // one they did choose. The proof is a durable log event, so a real
          // composer pick survives restart, resume and fork, while a session
          // still riding the deployment default is rewritten as before.
          // `managed` is the mode for "the manager owns every route", including a
          // session the user already picked, and is left untouched here.
          inherited = false;
          reason = 'explicit session selection (respected)';
        } else if (mode === 'hybrid' && isSubagent) {
          // Respect an explicit delegation choice. A child counts as inheriting
          // when its resolved route is either the delegating parent's *effective*
          // route (mirroring DSH's own parentAgentOptionsForDelegation) or the
          // route this manager itself assigned earlier — the latter keeps a
          // long-running child manager-owned instead of letting the first route
          // it applied masquerade as a choice the caller made.
          const previous = usage.get(agent.id);
          const managerOwned = managerApplied.get(agent.id) === routeKey({ provider: resolved.provider, model: resolved.model })
            || (previous?.applied === true
              && previous.provider === resolved.provider
              && previous.model === resolved.model);
          if (managerOwned) {
            reason = 'applied (manager-owned)';
          } else {
            const parent = findParent(ctx, agent.id);
            const parentRoute = parent === undefined ? undefined : effectiveRouteOf(parent);
            if (parentRoute === undefined) {
              // Lineage unresolvable (parent disposed, resumed descendant). Do
              // not overwrite a route the manager cannot prove it inherited.
              inherited = false;
              reason = 'lineage unresolved (child route respected)';
            } else if (parentRoute.provider !== resolved.provider || parentRoute.model !== resolved.model) {
              inherited = false;
              reason = 'explicit child route (respected)';
            }
          }
        }
        output = inherited ? applyRoute(resolved, route) : resolved;
        didApply = inherited;
      }

      // Commit the rotation only when a route was actually applied, and record
      // ownership in a map the usage LRU cap cannot evict.
      if (didApply) {
        candidate.commit();
        managerApplied.delete(agent.id);
        managerApplied.set(agent.id, routeKey({ provider: output.provider, model: output.model }));
        while (managerApplied.size > MANAGER_APPLIED_LIMIT) {
          const oldest = managerApplied.keys().next().value;
          if (oldest === undefined) break;
          managerApplied.delete(oldest);
        }
      }

      remember(agent.id, {
        role,
        label,
        isSubagent,
        provider: output.provider,
        model: output.model,
        reasoningEffort: output.reasoningEffort,
        reason,
        applied: didApply,
        parentId: catalog.get(agent.id)?.parentId,
      });
      return output;
    } catch (error) {
      log('warn', `routing skipped for one request: ${error?.message ?? error}`);
      return resolved;
    }
  }

  /**
   * In-step model failover.
   *
   * `agent/request-error` is the harness's recovery seam: it fires once per
   * genuinely failed model-request attempt. Downstream is asked first, so
   * `dsh-llm-retry` (same-model backoff), `dsh-compaction-basic` (context
   * overflow) and `dsh-compaction-image-offload` (image offload) stay
   * authoritative. Only when they all decline does this advance the role's
   * failover pointer and ask the loop to re-run the SAME step; re-running
   * re-enters `agent/request`, which then picks the next model. The failed
   * attempt was already settled as a non-surface `assistant/attempt` event, so
   * nothing enters model-visible history and the step's user messages are not
   * re-appended.
   */
  async function onRequestError(payload, next) {
    const decision = await next();
    if (decision !== undefined && decision !== null) return decision;
    try {
      if (!config.enabled) return undefined;
      const agent = payload?.agent;
      const failure = payload?.failure;
      if (agent === undefined || failure === null || typeof failure !== 'object') return undefined;

      // A user or parent cancellation is not a model problem, and advancing the
      // pointer here would silently change the route the next request uses.
      if (payload.signal?.aborted === true || failure.code === 'ABORTED') return undefined;
      if (!isFailoverCode(failure.code)) return undefined;

      // The role is the one this manager routed the failed request as; with no
      // such record there is no chain to fail over within.
      const role = usage.get(agent.id)?.role;
      if (role === undefined) return undefined;
      const models = effectiveModels(role);
      if (models.length < 2) return undefined;

      const stepKey = `${payload?.turn}:${payload?.step}`;
      let budget = stepSwitches.get(agent.id);
      if (budget === undefined || budget.key !== stepKey) {
        budget = { key: stepKey, switches: 0 };
        stepSwitches.set(agent.id, budget);
      }
      if (budget.switches >= MAX_SWITCHES_PER_STEP) return undefined;

      // Anchor on the failed attempt's own logged header rather than on a guess,
      // so the pointer moves from where the failure actually was. A header
      // naming a route outside this role's list means the failure was not ours
      // to recover.
      const header = probe(() => agent.session?.requestHeader?.()?.config);
      const failedAt = header === undefined
        ? Math.min(failover.get(failoverKey(agent.id, role)) ?? 0, models.length - 1)
        : models.findIndex((route) => route.provider === header.provider && route.model === header.model);
      if (failedAt < 0) return undefined;

      const owner = roleOf(role)?.models.length > 0 ? role : 'execution';
      const rotating = config.pick === 'round-robin';
      const nextIndex = rotating
        ? (failedAt + 1) % models.length
        : Math.min(failedAt + 1, models.length - 1);
      // `first` mode: the end of the chain is a terminal failure, not a wrap.
      if (!rotating && nextIndex === failedAt) return undefined;

      if (rotating) roundRobin.set(owner, nextIndex);
      else failover.set(failoverKey(agent.id, role), nextIndex);
      budget.switches += 1;

      const from = models[failedAt];
      const to = models[nextIndex];
      log('warn', `failover: ${role} ${from.provider}/${from.model} failed (${failure.code}); `
        + `re-running the step on ${to.provider}/${to.model} `
        + `(${budget.switches}/${MAX_SWITCHES_PER_STEP} switches this step)`);
      return { kind: 'retry' };
    } catch (error) {
      log('warn', `failover skipped: ${error?.message ?? error}`);
      return undefined;
    }
  }

  // -- update check ---------------------------------------------------------

  /** Drop every fallback timer the schedule armed; never throws. */
  function clearUpdateTimers() {
    const timers = updateTimers;
    updateTimers = [];
    for (const timer of timers) {
      try {
        clearTimeout(timer);
        clearInterval(timer);
      } catch {
        /* a half-cleared timer is already harmless */
      }
    }
  }

  /**
   * Arm the update-check schedule from the live config.
   *
   * The first check runs shortly after boot (never on the boot path itself),
   * then once per `update.intervalHours`; an explicit `0` means "boot only".
   * Prefers the cordis timer service when the composition provides one — those
   * timers are context-effect-managed and dispose with the plugin fiber — and
   * falls back to unref'd globals otherwise, so a test process can still exit.
   */
  function scheduleUpdateChecks() {
    clearUpdateTimers();
    if (!config.update.enabled) {
      if (updateState.status !== 'available') updateState = { status: 'disabled', at: Date.now() };
      return;
    }
    const arm = (repeat, delay) => {
      const run = () => void checkForUpdate().catch(() => {});
      const viaCordis = probe(() => (repeat
        ? (typeof ctx.interval === 'function' ? ctx.interval : undefined)
        : (typeof ctx.timeout === 'function' ? ctx.timeout : undefined)));
      if (viaCordis !== undefined) {
        viaCordis(run, delay);
        return;
      }
      const timer = repeat ? setInterval(run, delay) : setTimeout(run, delay);
      if (typeof timer?.unref === 'function') timer.unref();
      updateTimers.push(timer);
    };
    arm(false, UPDATE_FIRST_CHECK_DELAY_MS);
    const hours = config.update.intervalHours;
    if (hours > 0) {
      arm(true, Math.max(UPDATE_MIN_INTERVAL_MS, hours * 3_600_000));
    }
  }

  /**
   * Run one update check against the configured registry.
   *
   * Fetches the abbreviated packument, reads `dist-tags.latest`, and compares
   * it with this package's own version. Every failure path lands in
   * `updateState.status === 'error'` with a reason; none of them throws, and
   * none of them can touch routing.
   */
  function checkForUpdate() {
    if (updateInFlight !== undefined) return updateInFlight;
    updateInFlight = (async () => {
      if (!config.update.enabled) {
        updateState = { status: 'disabled', at: Date.now() };
        return updateState;
      }
      const registry = config.update.registry;
      const current = installedVersion();
      updateState = { status: 'checking', at: Date.now(), registry, current: current ?? undefined };
      try {
        if (current === null) throw new Error('this installation\'s version could not be read');
        if (typeof fetch !== 'function') throw new Error('no fetch in this runtime');
        const signal = timeoutSignal(UPDATE_FETCH_TIMEOUT_MS);
        const response = await fetch(`${registry}/${UPDATE_PACKAGE_PATH}`, {
          headers: { accept: 'application/vnd.npm.install-v1+json' },
          redirect: 'follow',
          ...(signal === undefined ? {} : { signal }),
        });
        if (response?.ok !== true) throw new Error(`HTTP ${response?.status ?? '(no status)'}`);
        const packument = await response.json();
        const latest = packument?.['dist-tags']?.latest;
        if (typeof latest !== 'string' || latest === '') {
          throw new Error('the packument carries no dist-tags.latest');
        }
        const order = compareVersions(latest, current);
        if (order === undefined) throw new Error(`unparseable version pair "${latest}" / "${current}"`);
        if (order > 0) {
          updateState = { status: 'available', at: Date.now(), current, latest, registry };
          log('warn', `update available: ${PACKAGE_NAME} ${current} -> ${latest} (checked ${registry}). `
            + `Run the model_manager tool with action "update" for the upgrade command, then restart. `
            + 'The settings card and the session-header chip show the same notice.');
        } else {
          updateState = { status: 'ok', at: Date.now(), current, latest, registry };
        }
      } catch (error) {
        updateState = {
          status: 'error',
          at: Date.now(),
          registry,
          current: current ?? undefined,
          reason: String(error?.message ?? error),
        };
        // A failed check is a diagnostic, not an alarm: offline deployments hit
        // this on every interval and a warn-per-hour would be noise.
        log('info', `update check failed (will retry on the interval): ${updateState.reason}`);
      }
      return updateState;
    })().finally(() => {
      updateInFlight = undefined;
    });
    return updateInFlight;
  }

  /** One compact status line for `routes`/`report`. */
  function updateStatusLine() {
    const state = updateState;
    const at = state.at === undefined ? '' : new Date(state.at).toISOString();
    switch (state.status) {
      case 'available':
        return `Update check: ${state.latest} AVAILABLE (installed ${state.current}, checked ${at}, ${state.registry}). `
          + 'Run model_manager with action "update" for the upgrade command.';
      case 'ok':
        return `Update check: up to date — ${state.current} (checked ${at}, ${state.registry}).`;
      case 'checking':
        return `Update check: in progress (since ${at}, ${state.registry}).`;
      case 'error':
        return `Update check: failed — ${state.reason} (checked ${at}). `
          + 'Run model_manager with action "update" to retry now.';
      case 'disabled':
        return 'Update check: disabled in config (update.enabled: false).';
      default:
        return 'Update check: not run yet in this process.';
    }
  }

  /** The full `model_manager` action-"update" report, forcing a fresh check. */
  async function updateAction() {
    await checkForUpdate();
    const state = updateState;
    const current = installedVersion();
    const lines = [
      'Model manager update check',
      '',
      `  installed : ${current ?? '(unreadable)'}`,
      `  latest    : ${state.latest ?? '(unknown)'}`,
      `  registry  : ${config.update.registry}`,
      `  checked   : ${state.at === undefined ? 'not yet' : new Date(state.at).toISOString()}`,
    ];
    if (state.status === 'available') {
      lines.push(`  verdict   : UPDATE AVAILABLE (${current} -> ${state.latest})`, '',
        'To upgrade, run in a terminal:', '',
        `  dsh plugin --profile ${profileHint() ?? '<profile>'} add ${PACKAGE_NAME}@latest`, '',
        'then restart the harness so the new version mounts. The Plugins page can reinstall',
        'the same package instead; both paths run the same installer. Tell the user this',
        'upgrade is available and what command to run.');
    } else if (state.status === 'error') {
      lines.push(`  verdict   : CHECK FAILED — ${state.reason}`, '',
        'The check is retried on its interval; offline deployments keep this verdict.');
    } else if (state.status === 'disabled') {
      lines.push('  verdict   : DISABLED — set update.enabled: true to check.');
    } else if (state.status === 'checking') {
      lines.push('  verdict   : a concurrent check is in flight; re-run this action shortly.');
    } else {
      lines.push(`  verdict   : up to date (${current}).`);
    }
    return lines.join('\n');
  }

  // -- reporting ------------------------------------------------------------

  /**
   * Check whether the vision role's models can actually accept images.
   *
   * `inputModalities` is authoritative when present: absent means unknown, an
   * explicit list without `image` is a negative capability. Routing image work
   * to a model that declares no image input fails at request time, so this is
   * worth surfacing before it is discovered mid-task.
   */
  async function visionReport() {
    const models = effectiveModels('vision');
    if (models.length === 0) return { reason: 'no-routes', rows: [] };
    const llm = probe(() => ctx.get('llm'));
    if (llm === undefined || typeof llm.resolveModelInfo !== 'function') return { reason: 'no-service', rows: [] };
    const rows = [];
    for (const route of models) {
      const label = `${route.provider}/${route.model}`;
      let info;
      try {
        info = await llm.resolveModelInfo(route.provider, route.model);
      } catch (error) {
        rows.push({ label, verdict: 'unresolved', detail: `could not resolve (${error?.message ?? error})` });
        continue;
      }
      const modalities = info?.inputModalities;
      if (!Array.isArray(modalities)) rows.push({ label, verdict: 'unknown', detail: 'image support not declared' });
      else if (modalities.includes('image')) rows.push({ label, verdict: 'ok', detail: 'accepts images' });
      else rows.push({
        label,
        verdict: 'no-images',
        detail: `declares ${modalities.join(', ') || 'nothing'} — image work routed here will fail`,
      });
    }
    return { reason: 'checked', rows };
  }

  /**
   * Whether the Host composed this plugin's Web client half into the browser
   * boot graph.
   *
   * The configuration card is contributed at runtime by the client half, so a
   * missing card is either a composition problem — which this reports exactly —
   * or a browser page that predates the current composition, which this cannot
   * see and which a reload fixes.
   */
  async function clientStatus() {
    const modules = probe(() => ctx.get('clientModules'));
    if (modules === undefined) {
      return 'Web client half\n\n  unavailable — this composition has no clientModules service, so no\n'
        + '  Web client half can be mounted at all.';
    }
    const graph = probe(() => (typeof modules.graph === 'function' ? modules.graph() : undefined));
    const entries = Array.isArray(graph?.entries) ? graph.entries : [];
    const ids = entries.map((entry) => entry?.id).filter((id) => typeof id === 'string');
    const mine = ids.filter((id) => id === PACKAGE_NAME || id.startsWith(`${PACKAGE_NAME}/`));
    const served = probe(() => (typeof modules.clientPath === 'function' ? modules.clientPath(PACKAGE_NAME) : undefined));
    const lines = [
      'Web client half',
      '',
      `  graph revision : ${typeof graph?.rev === 'string' ? graph.rev : '(unknown)'}`,
      `  graph rows     : ${ids.length}`,
      `  this package   : ${mine.length > 0 ? `PRESENT (${mine.join(', ')})` : 'ABSENT'}`,
      `  bundle route   : ${typeof served === 'string' ? served : '(not served)'}`,
      `  row id / ns    : ${ROW_ID}`,
      // The Host's settings.describe() skips any entry without a Config schema,
      // and a namespace it does not serve can never satisfy whileServed — so an
      // undefined Config would silently remove both the auto form and the
      // Settings card while routing kept working. Report it explicitly.
      `  Config schema  : ${Config === undefined
        ? 'UNDEFINED — no settings namespace is served for this row, so neither the auto-generated form nor the Settings card can appear (schemastery did not resolve)'
        : 'exported'}`,
      `  settings svc   : ${probe(() => ctx.get('settings')) === undefined ? 'absent' : 'present'}`,
    ];

    // Serve the graph row's own URL through the Host's bundle handler. This is
    // the same fetch the browser makes (minus auth), so it settles whether the
    // bundle is reachable and intact without needing the browser console.
    const row = entries.find((entry) => entry !== null && typeof entry === 'object'
      && typeof entry.id === 'string'
      && (entry.id === PACKAGE_NAME || entry.id.startsWith(`${PACKAGE_NAME}/`)));
    const url = typeof row?.url === 'string' ? row.url : undefined;
    lines.push(`  graph url      : ${url ?? '(none)'}`);
    if (url !== undefined && typeof modules.fetchBundle === 'function') {
      try {
        const absolute = url.startsWith('http') ? url : `http://localhost/${url.replace(/^\/+/, '')}`;
        const response = await modules.fetchBundle(new Request(absolute));
        const body = typeof response.text === 'function' ? await response.text() : '';
        const registers = body.includes(`'${PACKAGE_NAME}'`) || body.includes(`"${PACKAGE_NAME}"`);
        lines.push(`  self-fetch     : HTTP ${response.status}, ${body.length} bytes`);
        lines.push(`  module loader  : ${body.includes('__ModuleLoader__') ? 'present' : 'MISSING'}`);
        lines.push(`  registers id   : ${registers ? 'yes' : 'NO'}`);
        if (response.status !== 200 || !registers) {
          lines.push('', '  The Host did not serve a usable bundle, so the browser cannot load this');
          lines.push('  client half. That is a packaging problem, not a page-cache problem.');
        } else {
          lines.push('', '  The Host serves a usable bundle. If no card appears, the open page');
          lines.push('  predates this composition, or the client half threw while applying —');
          lines.push('  check the browser console for lines starting with "[model-manager]".');
        }
      } catch (error) {
        lines.push(`  self-fetch     : FAILED (${error?.message ?? error})`);
      }
    }

    // Whether the settings namespace this plugin writes to is actually served,
    // which is the gate the Settings card registers behind.
    const namespaces = probe(() => {
      const settings = ctx.get('settings');
      if (settings === undefined || typeof settings.describe !== 'function') return undefined;
      const described = settings.describe({ redactSecrets: true });
      return Array.isArray(described)
        ? described.map((item) => item?.ns).filter((ns) => typeof ns === 'string')
        : undefined;
    });
    if (namespaces === undefined) {
      lines.push('', '  settings namespaces: unavailable (no settings service).');
    } else {
      lines.push('', `  settings namespaces served (${namespaces.length}): ${namespaces.join(', ') || '(none)'}`);
      lines.push(`  ours (${ROW_ID}) served: ${namespaces.includes(ROW_ID) ? 'YES' : 'NO — the Settings card cannot register'}`);
    }
    return lines.join('\n');
  }

  function roleTable() {
    const lines = ['Role          effective model(s)'];
    lines.push('----------  ------------------------------------------');
    for (const key of ROLE_NAMES) {
      const role = roleOf(key);
      const models = effectiveModels(key);
      const via = role.models.length === 0 && models.length > 0 ? '  (via execution)' : '';
      const detail = models.length === 0
        ? '(unconfigured — passes through)'
        : models.map((route) => `${route.provider}/${route.model}${route.reasoningEffort ? ` (${route.reasoningEffort})` : ''}`).join(', ');
      lines.push(`${key.padEnd(12)}  ${detail}${via}`);
      if (role.note !== undefined) lines.push(`${' '.repeat(14)}note: ${role.note}`);
    }
    return lines.join('\n');
  }

  function allowListBlock() {
    const selection = readAllowList(ctx);
    if (selection.error !== undefined) {
      return 'Allow-list: the subagent model-selection settings refused to report its routes:\n'
        + `  ${selection.error}\n`
        + 'Fix `subagent-model-selection-settings` in the profile patch (an enabled policy needs a\n'
        + 'non-empty `allowedModels`), then reload.';
    }
    if (selection.unavailable === true) {
      return 'Allow-list: unavailable (no subagent model-selection settings service in this composition).';
    }
    if (!selection.enabled) {
      return 'Allow-list: model selection is DISABLED — subagents cannot select a model at all.\n'
        + 'Enable `subagent-model-selection-settings` in the profile patch to use role routing.';
    }
    const allowed = new Set(selection.allowed.map(routeKey));
    const rows = [];
    const missing = [];
    const seenMissing = new Set();
    for (const key of ROLE_NAMES) {
      // Audit the route the role will actually use, including the vision
      // fallback onto execution. Per-role rows stay, but the missing-route list
      // is deduplicated: the fallback would otherwise emit the same route twice,
      // and a repeated `allowedModels` entry is rejected by the harness.
      for (const route of effectiveModels(key)) {
        const ok = allowed.has(routeKey(route));
        rows.push(`  ${ok ? 'allowed  ' : 'BLOCKED  '} ${key.padEnd(10)} ${route.provider}/${route.model}`);
        const id = routeKey(route);
        if (!ok && !seenMissing.has(id)) {
          seenMissing.add(id);
          missing.push({ key, route });
        }
      }
    }
    const head = `Allow-list: enabled, ${selection.allowed.length} route(s) currently dispatchable`;
    if (rows.length === 0) return `${head}\n  (no role routes configured)`;
    if (missing.length === 0) return `${head}\n${rows.join('\n')}\n  All role routes are allow-listed.`;
    const yaml = missing
      .map(({ route }) => `      - provider: ${route.provider}\n        model: ${route.model}`)
      .join('\n');
    return `${head}\n${rows.join('\n')}\n\n`
      + `${missing.length} role route(s) are not in the subagent allow-list.\n`
      + 'This does NOT block role routing: the harness gates only *explicit* model-facing\n'
      + 'choices, and the manager routes pure-inheritance delegations at request time. What\n'
      + 'it does affect: an agent that names one of these routes explicitly will be refused,\n'
      + 'and the route will not appear in `list_subagent_models`. Add them to\n'
      + '`subagent-model-selection-settings` (`.allowedModels`) — in the profile patch, or on\n'
      + 'the Subagent settings page — to make them selectable:\n\n'
      + `${yaml}`;
  }

  async function report() {
    await refreshCatalog();
    const rows = [];
    for (const [childId, facts] of catalog) {
      rows.push({ childId, facts, seen: usage.get(childId) });
    }
    // Include any routed subagent the catalog did not surface.
    for (const [sessionId, seen] of usage) {
      if (!seen?.isSubagent) continue;
      if (rows.some((row) => row.childId === sessionId)) continue;
      rows.push({ childId: sessionId, facts: undefined, seen });
    }
    // The top-level agents: the only place the manager's decision about the main
    // role is visible at all. Without it this report answers which model each
    // child got and never says what served the conversation you are typing in —
    // exactly the question the explicit-selection rule raises.
    const topRows = [];
    for (const [sessionId, seen] of usage) {
      // A missing `seen` would take the whole report down on the first field
      // read below, and the subagent loop above already guards for it.
      if (!seen || seen.isSubagent) continue;
      topRows.push({ sessionId, seen });
    }
    if (rows.length === 0 && topRows.length === 0) {
      return 'No subagents observed yet in this process.\n\n'
        + 'Delegate some work, then run this report again. Model usage is recorded per\n'
        + 'delegation at request time, so it works whether routing applied or passed through.\n\n'
        + roleTable()
        // The empty report still carries an available-update notice: it is the
        // one line a model reading this report should relay unprompted.
        + (updateState.status === 'available' ? `\n${updateStatusLine()}` : '');
    }
    rows.sort((a, b) => String(a.childId).localeCompare(String(b.childId)));
    const lines = [];
    if (topRows.length > 0) {
      topRows.sort((a, b) => String(a.sessionId).localeCompare(String(b.sessionId)));
      lines.push(`Top-level agents — ${topRows.length}`, '');
      lines.push('session      role       model                            reason                                       status    the session model was');
      lines.push('-----------  ---------  -------------------------------  -------------------------------------------  --------  --------------------------------');
      for (const row of topRows) {
        const live = probe(() => ctx.get('agents')?.get?.(row.sessionId));
        const status = live === undefined ? 'inactive' : String(live.status ?? 'live');
        // Read the durable fold rather than this turn's decision, so the answer
        // does not depend on whether the manager happened to be enabled.
        const origin = live === undefined
          ? 'unknown, agent no longer live'
          : selectionWasExplicit(live)
            ? 'picked by hand, so main yields'
            : 'the deployment default, so main applies';
        lines.push([
          shortId(row.sessionId),
          String(row.seen.role ?? '?').padEnd(9),
          `${row.seen.provider}/${row.seen.model}`.padEnd(31),
          String(row.seen.reason ?? '-').padEnd(43),
          status.padEnd(8),
          origin,
        ].join('  '));
      }
      lines.push('');
      lines.push('A reason ending in (respected) is the verdict itself: a human choice won and the');
      lines.push('manager stepped back. Under managed it never does, and a session that never had');
      lines.push('a manual pick is rewritten by the main role.');
      lines.push('');
    }
    if (rows.length > 0) {
      lines.push(`Subagent model report — ${rows.length} subagent(s)`, '');
      lines.push('child       role       model                            reason                                       status    label');
      lines.push('----------  ---------  -------------------------------  -------------------------------------------  --------  --------------------');
    }
    for (const row of rows) {
      const model = row.seen ? `${row.seen.provider}/${row.seen.model}` : '(not yet routed)';
      const live = probe(() => ctx.get('agents')?.get?.(row.childId));
      const status = live === undefined ? 'inactive' : String(live.status ?? 'live');
      lines.push([
        shortId(row.childId),
        String(row.seen?.role ?? '?').padEnd(9),
        model.padEnd(31),
        String(row.seen?.reason ?? '-').padEnd(43),
        status.padEnd(8),
        quoteLabel(row.facts?.label ?? row.seen?.label),
      ].join('  '));
    }
    lines.push('');
    lines.push(`mode: ${config.strategy.mode}`);
    lines.push('');
    lines.push('Subagent requests by role/model:');
    const totals = new Map();
    for (const [, seen] of usage) {
      if (!seen?.isSubagent) continue;
      const key = `${seen.role ?? '?'}  ${seen.provider}/${seen.model}`;
      const entry = totals.get(key) ?? { requests: 0, children: 0 };
      entry.requests += seen.requests ?? 1;
      entry.children += 1;
      totals.set(key, entry);
    }
    if (totals.size === 0) lines.push('  (nothing routed yet)');
    else {
      for (const [key, entry] of [...totals].sort()) {
        lines.push(`  ${String(entry.requests).padStart(4)} req / ${String(entry.children).padStart(2)} subagent(s)  ${key}`);
      }
    }
    // Only an AVAILABLE update is worth a report line: the full status lives in
    // `routes` and action "update", and a per-report "up to date" would be noise.
    if (updateState.status === 'available') {
      lines.push('', updateStatusLine());
    }
    return lines.join('\n');
  }

  async function routes() {
    const vision = await visionReport();
    const visionBlock = vision.reason === 'no-service'
      ? 'Vision role: not checked (no llm service in this composition).'
      : vision.reason === 'no-routes'
        ? 'Vision role: no route configured, so image-labelled delegations have no dedicated model\n'
          + '  and will simply inherit the delegating parent\'s route.'
        : [
          'Vision role (image capability):',
          ...vision.rows.map((row) => {
            const tag = row.verdict === 'ok' ? 'ok        '
              : row.verdict === 'no-images' ? 'NO IMAGES '
                : row.verdict === 'unknown' ? 'unknown   ' : 'unresolved';
            return `  ${tag} ${row.label} — ${row.detail}`;
          }),
        ].join('\n');
    return [
      'Model manager roles',
      '',
      `Enabled: ${config.enabled ? 'yes' : 'NO — observing and reporting only, no route is rewritten'}`,
      '',
      `Selection: ${config.pick === 'round-robin'
        ? 'round-robin — every role rotates across its own list'
        : 'first — every role starts at its top model and fails over down its list'} (one strategy for all roles)`,
      '',
      roleTable(),
      '',
      `Strategy mode: ${config.strategy.mode}`
        + (config.strategy.mode === 'hybrid' ? ' (apply when the child inherited the parent route)' : '')
        + (config.strategy.mode === 'managed' ? ' (always apply the role route)' : '')
        + (config.strategy.mode === 'advisory' ? ' (never rewrite — report only)' : ''),
      '',
      `Auto-delegation: ${config.strategy.autoDelegate === 'off'
        ? 'off — no delegation policy is added to the system prompt'
        : `${config.strategy.autoDelegate} — the top-level agent is prompted to ${config.strategy.autoDelegate === 'eager'
          ? 'orchestrate: nearly all substantive work goes to delegations'
          : 'plan and dispatch subagents for multi-step and independent work'}`}`,
      '',
      allowListBlock(),
      '',
      visionBlock,
      '',
      'Delegation labels select the tier. The `description` you pass to a delegation',
      'becomes the child label, which the manager matches against (word-anchored):',
      `  vision   : ${config.strategy.visionKeywords.slice(0, 8).join(', ') || '(disabled)'}${config.strategy.visionKeywords.length > 8 ? ', …' : ''}`,
      `  planning : ${config.strategy.planningKeywords.slice(0, 8).join(', ') || '(disabled)'}${config.strategy.planningKeywords.length > 8 ? ', …' : ''}`,
      '  else     : execution',
      '',
      updateStatusLine(),
    ].join('\n');
  }

  function cheatSheet() {
    const summary = ROLE_NAMES
      .map((key) => {
        const models = effectiveModels(key);
        if (models.length === 0) return undefined;
        return `  ${key}: ${models.map((route) => `${route.provider}/${route.model}`).join(', ')}`;
      })
      .filter(Boolean);
    if (summary.length === 0) return '';
    const routing = config.strategy.mode === 'advisory'
      ? 'The manager is observing only (advisory), so labels classify but never rewrite a route.'
      : [
        'Label a delegation `description` with "plan:" for thinking work, "vision:" for image',
        'work, or leave it plain for execution; a leading prefix wins over keyword matches.',
        'Leave `provider` and `model` unset on those units so the role route applies.',
      ].join('\n');
    const planningGap = effectiveModels('planning').length === 0
      ? '\nThe planning tier has no models, so "plan:" labels keep the inherited route.'
      : '';
    return [
      '## Model manager',
      'Delegated work is routed by the label you give each delegation:',
      ...summary,
      routing,
      `Call \`model_manager\` with action "report" to see which model each subagent actually used.${planningGap}`,
    ].join('\n');
  }

  // -- wiring ---------------------------------------------------------------

  // ---- session-level usage by model ----------------------------------------
  //
  // The harness already attributes every completed Turn to the exact
  // provider/model that served it and shows that in the Turn's own usage dialog,
  // but nothing aggregates usage *by model* for a whole session: its
  // session-level projections accumulate four token buckets with no route split.
  // This unit fills that gap.
  //
  // It folds the DURABLE LOG rather than keeping a live counter, so the numbers
  // survive a restart and are byte-identical after fork, resume, and replay —
  // unlike the process-local state `model_manager report` reads.
  //
  // Only attempts carrying an exact usage sample are counted, and only those with
  // a provider/model on the committed message. A failed attempt that reported no
  // usage contributes nothing, which is the same refusal the per-Turn dialog
  // makes: never present a total that cannot be proven.
  const USAGE_PROJECTION_KEY = 'modelManagerUsage';
  const USAGE_BUCKETS = [
    'uncachedInputTokens',
    'outputTokens',
    'cacheReadTokens',
    'cacheWriteTokens',
    'totalTokens',
  ];

  const countField = (value, label) => {
    if (value === undefined || value === null) return 0;
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${label}: expected a non-negative safe integer, got ${String(value)}`);
    }
    return value;
  };

  const parseUsageRoute = (value, label) => {
    if (value === null || typeof value !== 'object') throw new Error(`${label}: expected an object`);
    const record = value;
    if (typeof record.provider !== 'string' || typeof record.model !== 'string') {
      throw new Error(`${label}: provider and model must be strings`);
    }
    const route = {
      provider: record.provider,
      model: record.model,
      requests: countField(record.requests, `${label}.requests`),
    };
    for (const bucket of USAGE_BUCKETS) route[bucket] = countField(record[bucket], `${label}.${bucket}`);
    return route;
  };

  /**
   * cordis calls only `.parse()` on `stateSchema` and `viewSchema`, so a
   * hand-written canonicalizer satisfies the contract and this package keeps no
   * `zod` dependency of its own. Rebuilding each route is the point: nothing
   * that is not a proven count can reach the wire.
   */
  const usageProjectionSchema = {
    parse: (value) => {
      if (value === null || typeof value !== 'object' || !Array.isArray(value.routes)) {
        throw new Error(`${USAGE_PROJECTION_KEY}: expected { routes: [] }`);
      }
      return { routes: value.routes.map((route, index) => parseUsageRoute(route, `routes[${index}]`)) };
    },
  };

  const usageSampleOf = (event) => {
    if (event.type === 'assistant/message' && event.data.usage !== undefined) return event.data.usage;
    if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return undefined;
    const stream = event.data.stream;
    if (!Array.isArray(stream)) return undefined;
    for (let index = stream.length - 1; index >= 0; index -= 1) {
      const frame = stream[index];
      if (frame !== null && typeof frame === 'object' && frame.type === 'usage' && frame.usage !== null && typeof frame.usage === 'object') {
        return frame.usage;
      }
    }
    return undefined;
  };

  const routeOfMessage = (message) => {
    const source = message === null || typeof message !== 'object' ? undefined : message.source;
    if (source === null || typeof source !== 'object') return undefined;
    const { provider, model } = source;
    if (typeof provider !== 'string' || provider.length === 0) return undefined;
    if (typeof model !== 'string' || model.length === 0) return undefined;
    return { provider, model };
  };

  const usageProjectionDefinition = {
    key: USAGE_PROJECTION_KEY,
    stateVersion: 1,
    stateSchema: usageProjectionSchema,
    init: () => ({ routes: [] }),
    apply: (state, event) => {
      if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return state;
      const sample = usageSampleOf(event);
      if (sample === undefined) return state;
      // `assistant/attempt` carries no message, so its route is unknown here;
      // counting it under a guessed model would corrupt the split.
      const route = event.type === 'assistant/message' ? routeOfMessage(event.data.message) : undefined;
      if (route === undefined) return state;
      const key = `${route.provider}\u0000${route.model}`;
      const index = state.routes.findIndex((entry) => entry.provider === route.provider && entry.model === route.model);
      const previous = index < 0
        ? { ...route, requests: 0, uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 }
        : state.routes[index];
      let next;
      try {
        next = parseUsageRoute({
          ...previous,
          requests: previous.requests + 1,
          uncachedInputTokens: previous.uncachedInputTokens + countField(sample.inputTokens, 'usage.inputTokens'),
          outputTokens: previous.outputTokens + countField(sample.outputTokens, 'usage.outputTokens'),
          cacheReadTokens: previous.cacheReadTokens + countField(sample.cacheReadTokens, 'usage.cacheReadTokens'),
          cacheWriteTokens: previous.cacheWriteTokens + countField(sample.cacheWriteTokens, 'usage.cacheWriteTokens'),
          totalTokens: previous.totalTokens + countField(sample.totalTokens, 'usage.totalTokens'),
        }, `route ${key}`);
      } catch (error) {
        // An unusable sample must never abort the fold: the log is authoritative
        // and every later event still has to be applied.
        log('warn', `usage sample skipped: ${error?.message ?? error}`);
        return state;
      }
      const routes = index < 0
        ? [...state.routes, next]
        : state.routes.map((entry, position) => (position === index ? next : entry));
      return { routes };
    },
    // Returning the state itself keeps the view reference stable whenever the
    // fold produced no change, which is what suppresses a publication.
    wire: { viewSchema: usageProjectionSchema, view: (state) => state },
  };

  /**
   * Whether this Session ever recorded an *explicit* model selection.
   *
   * `selectForNextRequest()` (dsh-api-session-controller/lib/index.js:319-322)
   * appends a durable `model/selection` event, and that is the only append site
   * in the install, so the event is proof that a person chose this session's
   * model — through the composer seat or `/model`. A session that never got one
   * runs on the deployment default, and *that* is the route `main` exists to
   * replace.
   *
   * The host's own `modelSelection` projection cannot answer this question: its
   * `lastUsed` is filled from `request/header`, so a default-written request
   * populates it too, and `pending` is cleared the moment a request consumes it.
   * One is default-polluted, the other transient; only the event's presence is
   * both durable and unambiguous.
   */
  const SELECTION_PROJECTION_KEY = 'modelManagerSelection';
  const selectionProjectionSchema = {
    parse: (value) => {
      if (value === null || typeof value !== 'object') throw new Error('expected an object');
      if (typeof value.explicit !== 'boolean') throw new Error('explicit: expected a boolean');
      return { explicit: value.explicit };
    },
  };
  const selectionProjectionDefinition = {
    key: SELECTION_PROJECTION_KEY,
    stateVersion: 1,
    stateSchema: selectionProjectionSchema,
    init: () => ({ explicit: false }),
    apply: (state, event) => {
      // Monotone: an explicit selection cannot be taken back, and a fold that
      // changed nothing must return the same reference to suppress publication.
      if (event.type !== 'model/selection' || state.explicit === true) return state;
      return { explicit: true };
    },
    wire: { viewSchema: selectionProjectionSchema, view: (state) => state },
  };

  /** The projection registry, captured when this composition provides one. */
  let projections;

  /**
   * Whether the user explicitly chose this agent's session model.
   *
   * Never throws. Answers `false` when no registry is reachable, which keeps the
   * previous behaviour — `main` rewrites the route — instead of quietly turning
   * the manager off; the missing registration is logged at apply time.
   */
  function selectionWasExplicit(agent) {
    if (projections === undefined || typeof projections.stateOf !== 'function') return false;
    const state = probe(() => projections.stateOf(agent.session, SELECTION_PROJECTION_KEY));
    return state?.explicit === true;
  }

  function attach() {
    ctx.on('agent/request', onAgentRequest);
    ctx.on('agent/request-error', onRequestError);

    // Drop per-session failover state when its agent goes away, so a long-lived
    // process does not accumulate entries for sessions that can no longer run.
    // The cursors are keyed `${id}::${role}`, so every role's cursor goes too.
    ctx.on('agent/disposed', (payload) => {
      const id = payload?.agent?.id ?? (typeof payload === 'string' ? payload : payload?.id);
      if (typeof id !== 'string') return;
      failover.delete(id);
      const prefix = `${id}::`;
      for (const key of [...failover.keys()]) {
        if (key.startsWith(prefix)) failover.delete(key);
      }
      stepSwitches.delete(id);
    });

    // Resolve a newly published child's label immediately, and targeted rather
    // than by sweeping every live agent.
    ctx.on('subagent/start', (info) => {
      const childId = info?.id;
      if (childId !== undefined) void lookupChild(childId).catch(() => {});
    });

    // A volatile-only Settings edit is committed in place: the loader returns
    // before re-running `apply`, so the config must be re-read here. Without
    // this the page would save and display the new value while routing kept the
    // boot-time one until restart. DSH's own volatile plugins do the same.
    ctx.on('loader/volatile-update', () => {
      try {
        const previousUpdate = config.update;
        const next = readConfig(rawConfig);
        config = {
          enabled: next.enabled,
          pick: next.pick,
          roles: next.roles,
          strategy: next.strategy,
          update: next.update,
          warnings: next.warnings,
        };
        visionMatch = keywordMatcher(config.strategy.visionKeywords);
        planningMatch = keywordMatcher(config.strategy.planningKeywords);
        for (const warning of config.warnings) log('warn', warning);
        // The delegation policy and the update schedule both read the live
        // config through this closure, so they follow a save with no restart.
        scheduleUpdateChecks();
        const updateChanged = JSON.stringify(previousUpdate) !== JSON.stringify(config.update);
        if (updateChanged) void checkForUpdate().catch(() => {});
        log('info', `settings reloaded — mode ${config.strategy.mode}, pick ${config.pick}, autoDelegate ${config.strategy.autoDelegate}; `
          + ROLE_NAMES
            .map((key) => `${key}=${config.roles[key].models.length === 0 ? '-' : config.roles[key].models.map((r) => `${r.provider}/${r.model}`).join('|')}`)
            .join(' '));
      } catch (error) {
        log('warn', `could not reload settings; routing keeps the previous config: ${error?.message ?? error}`);
      }
    });

    if (typeof ctx.inject === 'function') {
      ctx.inject(['tools'], (scoped) => {
        // Captured for the delegation-policy section, which asks this service
        // which delegation tools an assembly's scope actually exposes.
        toolsService = scoped.tools;
        try {
          scoped.tools.register({
            name: 'model_manager',
            description: 'Inspect and explain the role-based model routing configured for this harness. '
              + 'action "report": a Top-level agents section naming which model served each '
              + 'conversation and whether the manager yielded to a model a person picked in the '
              + 'composer, then one row per subagent with its label, role, reason, live status and '
              + 'totals. action "routes": the four role assignments '
              + '(including the vision->execution fallback), the shared selection strategy (first or round-robin), '
              + 'the active distribution mode, the auto-delegation level, the update-check status, '
              + 'and whether each '
              + 'route is dispatchable by the delegation tool, with the YAML to add any that are not. '
              + 'action "usage": request and subagent counts by role and model across the whole process. '
              + 'action "client": whether the Host composed this plugin\'s Web client half into the browser '
              + 'boot graph, the route serving its bundle, and the current graph revision — use it when the '
              + 'configuration card does not appear in the Web UI. '
              + 'action "update": force a fresh update check against the package registry and return the '
              + 'installed version, the latest published version, and the exact upgrade command to run '
              + 'when a newer release exists — use it whenever the report or routes output says an update '
              + 'is available, and tell the user. '
              + 'Read-only; it never changes routing.',
            parameters: {
              type: 'object',
              properties: {
                action: {
                  type: 'string',
                  enum: ['report', 'routes', 'usage', 'client', 'update'],
                  description: 'What to return. Defaults to "report".',
                },
              },
              additionalProperties: false,
            },
            output: {
              schema: { type: 'string' },
              render: (_args, result) => [{ type: 'text', text: String(result) }],
            },
            async execute(args) {
              const action = args?.action ?? 'report';
              if (action === 'routes') return routes();
              if (action === 'client') return clientStatus();
              if (action === 'update') return updateAction();
              if (action === 'usage') {
                await refreshCatalog();
                const totals = new Map();
                for (const [, seen] of usage) {
                  const key = `${seen.role ?? '?'}  ${seen.provider}/${seen.model}`;
                  const entry = totals.get(key) ?? { requests: 0, subagents: 0 };
                  entry.requests += seen.requests ?? 1;
                  if (seen.isSubagent) entry.subagents += 1;
                  totals.set(key, entry);
                }
                if (totals.size === 0) return 'No model usage recorded yet.\n\n' + roleTable();
                const lines = [
                  'Requests by role/model (whole process, including top-level turns)',
                  '',
                ];
                for (const [key, entry] of [...totals].sort()) {
                  lines.push(`  ${String(entry.requests).padStart(4)} req  ${String(entry.subagents).padStart(3)} subagent(s)  ${key}`);
                }
                return lines.join('\n');
              }
              return report();
            },
          });
        } catch (error) {
          log('warn', `model_manager tool not registered: ${error?.message ?? error}`);
        }
      });

      // Optional service: a profile without the projection subsystem simply
      // gets no per-session model usage surface, instead of a throwing plugin.
      ctx.inject(['sessionProjections'], (scoped) => {
        try {
          const registry = scoped.sessionProjections;
          if (registry === undefined || typeof registry.register !== 'function') {
            log('warn', 'sessionProjections is present but exposes no register(); per-session model usage is unavailable');
            return;
          }
          registry.register(usageProjectionDefinition);
          registry.register(selectionProjectionDefinition);
          projections = registry;
          log('info', `registered the ${USAGE_PROJECTION_KEY} and ${SELECTION_PROJECTION_KEY} session projections`);
        } catch (error) {
          log('warn', `could not register the usage projection: ${error?.message ?? error}`);
        }
      });

      ctx.inject(['systemPrompt'], (scoped) => {
        try {
          const register = () => {
            const disposers = [];
            try {
              disposers.push(scoped.systemPrompt.section({
                name: 'model-manager',
                order: 60,
                text: () => cheatSheet(),
              }));
              // The delegation policy: rendered per assembly, only for the
              // top-level orchestrator, and only while it actually has the
              // delegation tools — see delegationPolicy().
              disposers.push(scoped.systemPrompt.section({
                name: 'model-manager:delegation',
                order: DELEGATION_SECTION_ORDER,
                text: (context) => delegationPolicy(context),
              }));
            } catch (error) {
              for (const dispose of disposers) {
                try {
                  dispose();
                } catch {
                  /* a failed partial registration must not leak the rest */
                }
              }
              throw error;
            }
            return () => {
              for (const dispose of disposers) {
                try {
                  dispose();
                } catch {
                  /* disposal is best-effort */
                }
              }
            };
          };
          if (typeof scoped.effect === 'function') scoped.effect(register);
          else register();
        } catch (error) {
          log('warn', `system prompt section not registered: ${error?.message ?? error}`);
        }
      });
    }

    // Boot diagnostic: tell the operator about role routes the delegation tool
    // would refuse, before they hit the error mid-task.
    const selection = readAllowList(ctx);
    if (selection.error !== undefined) {
      log('warn', `subagent model-selection settings refused to report its routes: ${selection.error}`);
    } else if (selection.unavailable !== true && selection.enabled) {
      const allowed = new Set(selection.allowed.map(routeKey));
      const missing = [];
      const seen = new Set();
      for (const key of ROLE_NAMES) {
        for (const route of effectiveModels(key)) {
          const id = routeKey(route);
          if (allowed.has(id) || seen.has(id)) continue;
          seen.add(id);
          missing.push(`${route.provider}/${route.model} (needed by ${key})`);
        }
      }
      if (missing.length > 0) {
        log('warn', `${missing.length} role route(s) are not in the subagent allow-list: ${missing.join('; ')}. `
          + 'Role routing still works for inherited delegations (the harness gates only explicit '
          + 'model-facing choices), but an agent naming one of these explicitly will be refused and '
          + 'it will not appear in list_subagent_models. Run the model_manager tool with action '
          + '"routes" for the exact snippet to add.');
      }
    }

    // The vision role only helps if its models actually declare image input.
    void (async () => {
      const vision = await visionReport();
      const broken = vision.rows.filter((row) => row.verdict === 'no-images');
      if (broken.length > 0) {
        log('warn', `vision role route(s) declare no image input and image work routed to them will fail: `
          + `${broken.map((row) => row.label).join(', ')}. Point roles.vision.models at an image-capable model.`);
      }
    })().catch(() => {});

    // Automatic update checks: the first run is delayed past the boot path,
    // and every failure path inside degrades to a logged diagnostic.
    scheduleUpdateChecks();
  }

  return {
    attach,
    classifySubagent,
    classifyAndRoute: routeCandidate,
    roleTable,
    routes,
    report,
    delegationPolicy,
    checkForUpdate,
    updateStatusLine,
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Activate the model manager.
 *
 * A throw here would fail the loader entry and therefore startup, so the whole
 * body is guarded: any failure disables routing and logs, never propagates.
 */
export function apply(ctx, rawConfig) {
  const log = makeLogger(ctx);
  try {
    const config = readConfig(rawConfig);
    for (const warning of config.warnings) log('warn', warning);
    const engine = createEngine(config, ctx, log, rawConfig);
    engine.attach();
    log('info', `active — mode ${config.strategy.mode}, pick ${config.pick}, autoDelegate ${config.strategy.autoDelegate}; `
      + ROLE_NAMES
        .map((key) => `${key}=${config.roles[key].models.length === 0 ? '-' : config.roles[key].models.map((r) => `${r.provider}/${r.model}`).join('|')}`)
        .join(' ')
      + (config.update.enabled
        ? `; update check every ${config.update.intervalHours === 0
          ? 'boot (interval disabled)'
          : `${config.update.intervalHours}h against ${config.update.registry}`}`
        : '; update check disabled'));
  } catch (error) {
    log('error', `failed to initialise; model routing is disabled: ${error?.stack ?? error}`);
  }
}

export {
  readConfig,
  applyRoute,
  effectiveRouteOf,
  parseVersion,
  compareVersions,
  installedVersion,
  profileHint,
  delegationPolicyText,
  DEFAULT_PLANNING_KEYWORDS,
  DEFAULT_VISION_KEYWORDS,
};
