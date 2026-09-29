/**
 * @jyshangguan/dsh-model-manager — role-based model manager for DeepSeek Harness.
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
 * @module @jyshangguan/dsh-model-manager
 */

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

const KNOWN_TOP_KEYS = ['enabled', 'roles', 'strategy'];
const KNOWN_ROLE_KEYS = ['models', 'pick', 'note'];
const KNOWN_ROUTE_KEYS = ['provider', 'model', 'reasoningEffort'];
const KNOWN_STRATEGY_KEYS = ['mode', 'visionKeywords', 'planningKeywords', 'historyLimit'];

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
const PACKAGE_NAME = '@jyshangguan/dsh-model-manager';

/**
 * Loader row id this plugin is mounted as.
 *
 * Also the settings namespace the client half binds (`configForms`/`settings`
 * are keyed by row id — the shipped Subagent settings card binds its own row id
 * `subagent-model-selection-settings` the same way).
 */
const ROW_ID = 'model-manager';

const DEFAULT_VISION_KEYWORDS = [
  'vision', 'visual', 'image', 'images', 'screenshot', 'screen shot', 'ocr',
  'figure', 'diagram', 'chart', 'plot', 'photo', 'picture', 'png', 'jpg',
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
    pick: z.union([z.const('first'), z.const('round-robin')]).default('first'),
    note: z.string(),
  });

  const StrategySchema = z.object({
    mode: z.union([z.const('hybrid'), z.const('managed'), z.const('advisory')]).default('hybrid'),
    visionKeywords: z.array(z.string()).default(DEFAULT_VISION_KEYWORDS),
    planningKeywords: z.array(z.string()).default(DEFAULT_PLANNING_KEYWORDS),
    historyLimit: z.number().default(300),
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
    roles: z.object({
      main: RoleSchema.default({}),
      planning: RoleSchema.default({}),
      execution: RoleSchema.default({}),
      vision: RoleSchema.default({}),
    }).default({}).volatile(),
    strategy: StrategySchema.default({}).volatile(),
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

/** Coerce raw row config into a total, always-usable shape. */
function readConfig(raw) {
  const warnings = [];
  const rolesRaw = readVal(raw?.roles) ?? {};
  const strategyRaw = readVal(raw?.strategy) ?? {};

  for (const key of unknownKeys(raw, KNOWN_TOP_KEYS)) warnings.push(`unknown config key "${key}" ignored`);
  for (const key of unknownKeys(rolesRaw, ROLE_NAMES)) warnings.push(`unknown role "${key}" ignored`);
  for (const key of ROLE_NAMES) {
    for (const bad of unknownKeys(readVal(rolesRaw?.[key]), KNOWN_ROLE_KEYS)) {
      warnings.push(`unknown key "roles.${key}.${bad}" ignored`);
    }
  }
  for (const key of unknownKeys(strategyRaw, KNOWN_STRATEGY_KEYS)) warnings.push(`unknown key "strategy.${key}" ignored`);

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
      pick: role.pick === 'round-robin' ? 'round-robin' : 'first',
      note: typeof role.note === 'string' && role.note.trim() !== '' ? role.note.trim() : undefined,
    };
  };

  const mode = strategyRaw.mode;
  const limit = strategyRaw.historyLimit;
  return {
    // Only an explicit `false` switches the manager off. A missing or malformed
    // value keeps it on, so a typo can never silently disable routing.
    enabled: readVal(raw?.enabled) !== false,
    roles: Object.fromEntries(ROLE_NAMES.map((key) => [key, readRole(key)])),
    strategy: {
      mode: mode === 'managed' || mode === 'advisory' ? mode : 'hybrid',
      visionKeywords: asStringArray(strategyRaw.visionKeywords, DEFAULT_VISION_KEYWORDS),
      planningKeywords: asStringArray(strategyRaw.planningKeywords, DEFAULT_PLANNING_KEYWORDS),
      // Guard against a positive fraction flooring to 0, which would evict every
      // record immediately and silently disable usage tracking.
      historyLimit: Number.isFinite(limit) && limit > 0 ? Math.max(1, Math.floor(limit)) : 300,
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
   * rotation.
   *
   * `sessionId` selects the failover position for `pick: 'first'`, where the
   * ordered list is a failover chain rather than a rotation.
   */
  function routeCandidate(key, sessionId) {
    const models = effectiveModels(key);
    if (models.length === 0) return undefined;
    if (models.length === 1) return { route: models[0], commit() {} };
    const owner = roleOf(key)?.models.length > 0 ? key : 'execution';
    if (roleOf(owner)?.pick === 'round-robin') {
      const index = roundRobin.get(owner) ?? 0;
      return {
        route: models[index],
        commit() {
          roundRobin.set(owner, (index + 1) % models.length);
        },
      };
    }
    const at = Math.min(failover.get(sessionId) ?? 0, models.length - 1);
    return { route: models[at], commit() {} };
  }

  /** Which role owns a delegated child, from its delegation label. */
  function classifySubagent(label) {
    const text = String(label ?? '');
    if (text === '') return 'execution';
    if (visionMatch(text)) return 'vision';
    if (planningMatch(text)) return 'planning';
    return 'execution';
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
        ? Math.min(failover.get(agent.id) ?? 0, models.length - 1)
        : models.findIndex((route) => route.provider === header.provider && route.model === header.model);
      if (failedAt < 0) return undefined;

      const owner = roleOf(role)?.models.length > 0 ? role : 'execution';
      const rotating = roleOf(owner)?.pick === 'round-robin';
      const nextIndex = rotating
        ? (failedAt + 1) % models.length
        : Math.min(failedAt + 1, models.length - 1);
      // `first` mode: the end of the chain is a terminal failure, not a wrap.
      if (!rotating && nextIndex === failedAt) return undefined;

      if (rotating) roundRobin.set(owner, nextIndex);
      else failover.set(agent.id, nextIndex);
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
    const lines = ['Role          pick          effective model(s)'];
    lines.push('------------  ------------  ------------------------------------------');
    for (const key of ROLE_NAMES) {
      const role = roleOf(key);
      const models = effectiveModels(key);
      const via = role.models.length === 0 && models.length > 0 ? '  (via execution)' : '';
      const detail = models.length === 0
        ? '(unconfigured — passes through)'
        : models.map((route) => `${route.provider}/${route.model}${route.reasoningEffort ? ` (${route.reasoningEffort})` : ''}`).join(', ');
      lines.push(`${key.padEnd(12)}  ${role.pick.padEnd(12)}  ${detail}${via}`);
      if (role.note !== undefined) lines.push(`${' '.repeat(28)}note: ${role.note}`);
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
        + roleTable();
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
      roleTable(),
      '',
      `Strategy mode: ${config.strategy.mode}`
        + (config.strategy.mode === 'hybrid' ? ' (apply when the child inherited the parent route)' : '')
        + (config.strategy.mode === 'managed' ? ' (always apply the role route)' : '')
        + (config.strategy.mode === 'advisory' ? ' (never rewrite — report only)' : ''),
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
    return [
      '## Model manager',
      'Delegated work is routed by the label you give each delegation:',
      ...summary,
      'Start a delegation `description` with "plan:" for reasoning work, "vision:" for',
      'image/screenshot work, or leave it plain for execution. Call `model_manager` with',
      'action "report" to see which model each subagent actually used.',
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
    ctx.on('agent/disposed', (payload) => {
      const id = payload?.agent?.id ?? (typeof payload === 'string' ? payload : payload?.id);
      if (typeof id !== 'string') return;
      failover.delete(id);
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
        const next = readConfig(rawConfig);
        config = { enabled: next.enabled, roles: next.roles, strategy: next.strategy, warnings: next.warnings };
        visionMatch = keywordMatcher(config.strategy.visionKeywords);
        planningMatch = keywordMatcher(config.strategy.planningKeywords);
        for (const warning of config.warnings) log('warn', warning);
        log('info', `settings reloaded — mode ${config.strategy.mode}; `
          + ROLE_NAMES
            .map((key) => `${key}=${config.roles[key].models.length === 0 ? '-' : config.roles[key].models.map((r) => `${r.provider}/${r.model}`).join('|')}`)
            .join(' '));
      } catch (error) {
        log('warn', `could not reload settings; routing keeps the previous config: ${error?.message ?? error}`);
      }
    });

    if (typeof ctx.inject === 'function') {
      ctx.inject(['tools'], (scoped) => {
        try {
          scoped.tools.register({
            name: 'model_manager',
            description: 'Inspect and explain the role-based model routing configured for this harness. '
              + 'action "report": a Top-level agents section naming which model served each '
              + 'conversation and whether the manager yielded to a model a person picked in the '
              + 'composer, then one row per subagent with its label, role, reason, live status and '
              + 'totals. action "routes": the four role assignments '
              + '(including the vision->execution fallback), the active distribution mode, and whether each '
              + 'route is dispatchable by the delegation tool, with the YAML to add any that are not. '
              + 'action "usage": request and subagent counts by role and model across the whole process. '
              + 'action "client": whether the Host composed this plugin\'s Web client half into the browser '
              + 'boot graph, the route serving its bundle, and the current graph revision — use it when the '
              + 'configuration card does not appear in the Web UI. '
              + 'Read-only; it never changes routing.',
            parameters: {
              type: 'object',
              properties: {
                action: {
                  type: 'string',
                  enum: ['report', 'routes', 'usage', 'client'],
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
          const register = () => scoped.systemPrompt.section({
            name: 'model-manager',
            order: 60,
            text: () => cheatSheet(),
          });
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
  }

  return { attach, classifySubagent, classifyAndRoute: routeCandidate, roleTable, routes, report };
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
    log('info', `active — mode ${config.strategy.mode}; `
      + ROLE_NAMES
        .map((key) => `${key}=${config.roles[key].models.length === 0 ? '-' : config.roles[key].models.map((r) => `${r.provider}/${r.model}`).join('|')}`)
        .join(' '));
  } catch (error) {
    log('error', `failed to initialise; model routing is disabled: ${error?.stack ?? error}`);
  }
}

export { readConfig, applyRoute, effectiveRouteOf, DEFAULT_PLANNING_KEYWORDS, DEFAULT_VISION_KEYWORDS };
