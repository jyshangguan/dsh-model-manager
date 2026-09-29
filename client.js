/**
 * dsh-model-manager — Web client half.
 *
 * Contributes a configuration page for this plugin's own row on the Plugins
 * page. The row gains a configure control that opens a card with one model
 * picker per role (main / planning / execution / vision) fed by the host's live
 * model catalog, plus the distribution mode and a per-role reasoning effort.
 *
 * Design constraints (from the harness's own plugin practices):
 *   - No Harness Client package is `require`d as a module. React comes from the
 *     browser module table; every other collaborator is a cordis *service*
 *     reached through `inject`. Controls are written here and styled only with
 *     `--dsw-alias-*` theme tokens, so light/dark and future renames degrade
 *     gracefully instead of breaking the entry.
 *   - The host owns the values and the write path: the slot passes a `form`
 *     with `state` (accepted values, revision, writability) and `mutate`
 *     (ordered, revision-fenced path operations). This half never talks to
 *     settings storage directly.
 *   - A component that throws blanks the slot entry, so every render path is
 *     guarded and defaults to a readable notice.
 *
 * Writes are applied immediately on selection — the same pattern the host's own
 * volatile settings cards use. The host half re-reads its config on
 * `loader/volatile-update`, so a change takes effect without a restart.
 *
 * @module dsh-model-manager/client
 */
window.__ModuleLoader__.load({
  id: 'dsh-model-manager',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Locale namespace for this card's copy. */
    const LOCALE_NS = 'dsh-model-manager';
    /**
     * This plugin's own settings namespace — the Loader row id its host half is
     * mounted as. `configForms`/`settings` are keyed by row id; the shipped
     * Subagent settings card binds `configForms.get("subagent-model-selection-settings")`,
     * i.e. its own row id, which is the convention followed here.
     */
    const ROW_NS = 'model-manager';
    /**
     * Key of the session projection the host half folds from the durable log.
     * Must match USAGE_PROJECTION_KEY in lib/index.js: the client only subscribes,
     * it never folds.
     */
    const USAGE_PROJECTION_KEY = 'modelManagerUsage';
    const ROLES = ['main', 'planning', 'execution', 'vision'];
    const MODES = ['hybrid', 'managed', 'advisory'];
    /**
     * How long to wait for the session-scoped catalog before relying on the
     * global `remote.llm` directory alone. It is a bonus source (it carries
     * reasoning efforts), never a gate.
     */
    const SESSION_CATALOG_TIMEOUT_MS = 4000;

    const en = {
      title: 'Model manager',
      summaryEmpty: 'No roles configured',
      summary: 'Model roles',
      help: 'Each role names the model used for that kind of work. Changes apply immediately.',
      roleMain: 'Main model',
      roleMainHint: 'Top-level agent outside plan mode. Leave unset to keep following the composer selection.',
      rolePlanning: 'Planning and reasoning',
      rolePlanningHint: 'Used in plan mode and for delegations labelled as planning work.',
      roleExecution: 'Execution',
      roleExecutionHint: 'The default tier for delegated implementation work.',
      roleVision: 'Image recognition',
      roleVisionHint: 'Used for image, screenshot and OCR work. Pick a model that accepts images.',
      mode: 'Distribution mode',
      modeHybrid: 'hybrid — take over only when the child inherited the parent route',
      modeManaged: 'managed — always apply the role route',
      modeAdvisory: 'advisory — never rewrite, report only',
      effort: 'Reasoning effort',
      effortDefault: '(model default)',
      loading: 'Loading models…',
      unavailable: 'These settings are not available to this client right now.',
      readOnly: 'This deployment stores settings read-only.',
      saved: 'Saved',
      refused: 'The host refused the change.',
      notInCatalog: 'not advertised',
      providersFailed: 'Some providers could not be listed:',
      noModels: 'No models are advertised yet. Configure a provider route, then reopen this page.',
      noForm: 'This page did not supply configuration values, so the model roles cannot be edited here. Open this plugin\'s own row on the Plugins page to configure it.',
      current: 'Current',
      enable: 'Enable model manager',
      enableHint: 'Off: routes are observed and reported but never rewritten.',
      addModel: 'Add a model…',
      remove: 'Remove',
      moveUp: 'Move up',
      pick: 'Selection',
      pickFirst: 'first — use the top model, fall back down the list',
      pickRoundRobin: 'round-robin — rotate across the list',
      orderHint: 'Order is the fallback order: the top model is tried first.',
      usageTitle: 'Model usage',
      usageModel: 'Provider / model',
      usageUncachedInput: 'Uncached input',
      usageOutput: 'Output',
      usageCacheRead: 'Cached input',
      usageCacheWrite: 'Cache write',
      usageRequests: '{count} requests',
      usageEmpty: 'No usage reported for this session yet.',
      usageHint: 'Folded from the durable session log, so it survives a restart. Only attempts that reported an exact usage sample are counted, which is why a Turn where a model failed shows no line here.',
    };

    const zh = {
      title: '模型管理器',
      summaryEmpty: '未配置角色',
      summary: '模型角色',
      help: '每个角色指定该类工作使用的模型。更改会立即生效。',
      roleMain: '主模型',
      roleMainHint: '非计划模式下顶层 Agent 使用的模型。留空则继续跟随输入框的模型选择。',
      rolePlanning: '规划与推理',
      rolePlanningHint: '计划模式下使用，也用于标记为规划类工作的委派。',
      roleExecution: '执行',
      roleExecutionHint: '委派实现的默认档位。',
      roleVision: '图像识别',
      roleVisionHint: '用于图像、截图与 OCR 工作。请选择支持图像输入的模型。',
      mode: '分发模式',
      modeHybrid: 'hybrid — 仅当子 Agent 继承父路由时才接管',
      modeManaged: 'managed — 始终应用角色路由',
      modeAdvisory: 'advisory — 只记录不改写',
      effort: '推理档位',
      effortDefault: '（模型默认）',
      loading: '正在加载模型…',
      unavailable: '当前客户端无法使用这些设置。',
      readOnly: '该部署以只读方式存储设置。',
      saved: '已保存',
      refused: '主机拒绝了此次更改。',
      notInCatalog: '未在目录中',
      providersFailed: '以下供应商无法列出：',
      noModels: '尚无可用模型。请先配置供应商路由，然后重新打开此页。',
      noForm: '此页面未提供配置值，因此无法在此编辑模型角色。请在「插件」页面打开该插件自身的条目进行配置。',
      current: '当前',
      enable: '启用模型管理器',
      enableHint: '关闭时：只观察和记录各会话实际使用的模型，不改写任何路由。',
      addModel: '添加模型…',
      remove: '移除',
      moveUp: '上移',
      pick: '选择方式',
      pickFirst: 'first — 优先用第一个，失败时按顺序向下回退',
      pickRoundRobin: 'round-robin — 在列表内轮流使用',
      orderHint: '列表顺序即回退顺序：排在最前的模型优先使用。',
      usageTitle: '模型用量',
      usageModel: '提供方 / 模型',
      usageUncachedInput: '未缓存输入',
      usageOutput: '输出',
      usageCacheRead: '缓存读取',
      usageCacheWrite: '缓存写入',
      usageRequests: '{count} 次请求',
      usageEmpty: '这个会话还没有上报用量。',
      usageHint: '从持久会话日志折叠而来，重启后依然准确。只计入上报了精确 usage 样本的请求，因此某个 turn 发生模型失败切换时不会出现在这里。',
    };

    /** Styles reference only theme tokens, so light/dark switch with the host. */
    const S = {
      root: { display: 'flex', flexDirection: 'column', gap: '0.9rem', color: 'var(--dsw-alias-label-primary)' },
      help: { margin: 0, fontSize: '0.82rem', color: 'var(--dsw-alias-label-secondary)' },
      row: { display: 'flex', flexDirection: 'column', gap: '0.3rem' },
      label: { fontSize: '0.85rem', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
      hint: { fontSize: '0.76rem', color: 'var(--dsw-alias-label-secondary)' },
      controls: { display: 'flex', gap: '0.5rem', flexWrap: 'wrap' },
      select: {
        flex: '1 1 16rem',
        minWidth: 0,
        padding: '0.35rem 0.5rem',
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: '0.85rem',
      },
      // One grid per role: fixed column tracks make every model control start and
      // end at the same x, whatever row it is in or which optional controls show.
      entryGrid: {
        display: 'grid',
        gridTemplateColumns: 'auto minmax(0, 1fr) auto auto',
        gap: '0.35rem 0.45rem',
        alignItems: 'center',
      },
      cellIndex: {
        justifySelf: 'end',
        minWidth: '1.1rem',
        fontSize: '0.75rem',
        color: 'var(--dsw-alias-label-secondary)',
        fontVariantNumeric: 'tabular-nums',
      },
      cellGap: {},
      actions: { display: 'inline-flex', gap: '0.25rem' },
      // Fixed square glyph buttons: no text, so the column width cannot drift
      // with the active locale or with a row having one action instead of two.
      action: {
        width: '1.7rem',
        height: '1.7rem',
        padding: 0,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: '0.85rem',
        lineHeight: 1,
        cursor: 'pointer',
      },
      actionOff: { opacity: 0.35, cursor: 'default' },
      selectGrid: {
        minWidth: 0,
        padding: '0.35rem 0.5rem',
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: '0.85rem',
        height: '1.7rem',
      },
      selectEffortGrid: { minWidth: '7rem' },
      // The add affordance must not look like another configured model.
      selectAdd: {
        borderStyle: 'dashed',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
      },
      cellSpan: { gridColumn: '2 / -1' },
      pickLabel: { fontSize: '0.76rem', color: 'var(--dsw-alias-label-secondary)' },
      usage: { position: 'relative', display: 'inline-flex' },
      usageButton: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '0.35rem',
        padding: '0.22rem 0.5rem',
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: '0.74rem',
        cursor: 'pointer',
        fontVariantNumeric: 'tabular-nums',
      },
      usagePanel: {
        position: 'absolute',
        top: 'calc(100% + 0.3rem)',
        right: 0,
        zIndex: 30,
        minWidth: '17rem',
        padding: '0.6rem 0.7rem',
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-2)',
        boxShadow: '0 6px 20px rgb(0 0 0 / 18%)',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.35rem',
      },
      usageHead: {
        display: 'flex',
        justifyContent: 'space-between',
        gap: '0.8rem',
        fontSize: '0.78rem',
        fontWeight: 600,
        color: 'var(--dsw-alias-label-primary)',
      },
      usageTable: { display: 'flex', flexDirection: 'column', gap: '0.3rem' },
      usageRow: {
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 1fr) auto',
        gap: '0.7rem',
        alignItems: 'baseline',
        paddingTop: '0.3rem',
        borderTop: '1px solid var(--dsw-alias-border-l1)',
      },
      usageName: {
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        fontSize: '0.76rem',
        color: 'var(--dsw-alias-label-primary)',
      },
      usageValue: {
        fontSize: '0.76rem',
        color: 'var(--dsw-alias-label-secondary)',
        fontVariantNumeric: 'tabular-nums',
        whiteSpace: 'nowrap',
      },
      usageBuckets: {
        gridColumn: '1 / -1',
        fontSize: '0.7rem',
        color: 'var(--dsw-alias-label-secondary)',
        fontVariantNumeric: 'tabular-nums',
      },
      usageEmpty: { fontSize: '0.76rem', color: 'var(--dsw-alias-label-secondary)' },
      toggleRow: { display: 'flex', gap: '0.5rem', alignItems: 'center' },
      checkbox: { width: '1rem', height: '1rem', accentColor: 'var(--dsw-alias-brand-primary)' },
      notice: { fontSize: '0.76rem', color: 'var(--dsw-alias-label-secondary)' },
      warn: { fontSize: '0.76rem', color: 'var(--dsw-alias-state-warn-primary)' },
      error: { fontSize: '0.76rem', color: 'var(--dsw-alias-state-error-primary)' },
      ok: { fontSize: '0.76rem', color: 'var(--dsw-alias-state-success-primary)' },
      summary: { fontSize: '0.8rem', color: 'var(--dsw-alias-label-secondary)' },
    };

    const routeKey = (provider, model) => `${provider}\u0000${model}`;
    const parseKey = (raw) => {
      const at = String(raw ?? '').indexOf('\u0000');
      if (at < 0) return undefined;
      const provider = raw.slice(0, at);
      const model = raw.slice(at + 1);
      return provider === '' || model === '' ? undefined : { provider, model };
    };
    const firstRoute = (role) => {
      const models = role && Array.isArray(role.models) ? role.models : [];
      return models.length > 0 ? models[0] : undefined;
    };
    const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

    function apply(ctx) {
      const safely = (label, fn) => {
        try {
          return fn();
        } catch (error) {
          try {
            console.warn(`[model-manager] ${label}: ${error?.message ?? error}`);
          } catch {
            /* nothing else we can do */
          }
          return undefined;
        }
      };
      /** Register through `ctx.effect` when present, else directly. */
      const use = (fn, label) => (typeof ctx.effect === 'function' ? ctx.effect(fn, label) : fn());

      safely('locale', () => use(() => ctx.locale.register(LOCALE_NS, { en, zh }), 'model-manager: locale'));
      const t = safely('locale binding', () => ctx.locale.bind(LOCALE_NS)) ?? ((key) => key);

      // -- model catalog ------------------------------------------------------
      // Shared by every card render; invalidated when adapters change.
      let catalog = { status: 'loading', groups: [], failures: [], error: undefined };
      const listeners = new Set();
      const publish = (next) => {
        catalog = next;
        for (const listener of [...listeners]) {
          try {
            listener();
          } catch {
            /* a broken subscriber must not break the others */
          }
        }
      };
      const subscribe = (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      };
      const getSnapshot = () => catalog;

      let generation = 0;

      /**
       * Session-independent catalog, from the global `remote.llm` directory.
       *
       * `remote.session.modelCatalog()` is served through the session namespace,
       * so it yields nothing when the Settings panel is open with no session —
       * which is why the pickers used to offer only "(unset)" plus the currently
       * configured route. This path lists every configurable provider and then
       * discovers its models, so it works from any page. It carries no reasoning
       * metadata, so the effort picker simply stays hidden in this mode.
       */
      const loadCatalogFromLlm = async () => {
        const listed = await ctx.remote.llm.listConfigurableProviders();
        if (!listed || !listed.ok) throw new Error(String(listed?.error ?? 'listConfigurableProviders refused'));
        const providers = Array.isArray(listed.value) ? listed.value : [];
        const groups = [];
        const failures = [];
        for (const entry of providers) {
          if (entry === null || typeof entry !== 'object' || typeof entry.provider !== 'string') continue;
          const label = typeof entry.displayName === 'string' && entry.displayName !== '' ? entry.displayName : entry.provider;
          if (typeof entry.error === 'string' && entry.error !== '') {
            failures.push({ id: entry.provider, name: label, message: entry.error });
            continue;
          }
          try {
            const answer = await ctx.remote.llm.discoverModels(entry.settingsNs, { provider: entry.provider });
            if (answer && answer.ok && Array.isArray(answer.value)) {
              groups.push({
                id: entry.provider,
                name: label,
                models: answer.value
                  .filter((model) => model !== null && typeof model === 'object' && typeof model.id === 'string')
                  .map((model) => ({
                    id: model.id,
                    name: typeof model.name === 'string' && model.name !== '' ? model.name : model.id,
                    ...(Array.isArray(model.inputModalities) ? { inputModalities: model.inputModalities } : {}),
                  })),
              });
            } else {
              failures.push({ id: entry.provider, name: label, message: String(answer?.error ?? 'discoverModels refused') });
            }
          } catch (error) {
            failures.push({ id: entry.provider, name: label, message: error?.message ?? String(error) });
          }
        }
        return { groups, failures };
      };

      /**
       * Load the model catalog.
       *
       * Both sources run *concurrently* on purpose. `remote.session.modelCatalog()`
       * is served through the session namespace: it carries each model's reasoning
       * efforts, but with no session open it can reject or never settle, so
       * awaiting it first would gate the whole card — which is exactly how the
       * pickers ended up empty in the Settings panel. The global `remote.llm`
       * directory always answers and is therefore the floor; the session catalog
       * only upgrades the result when it arrives in time.
       */
      const withTimeout = (promise, ms) => Promise.race([
        promise,
        new Promise((resolve) => { setTimeout(() => resolve(undefined), ms); }),
      ]);

      const fromSessionCatalog = async () => {
        try {
          const response = await withTimeout(ctx.remote.session.modelCatalog(), SESSION_CATALOG_TIMEOUT_MS);
          if (response === undefined) return { timedOut: true };
          if (response.ok) {
            const value = response.value ?? {};
            return {
              groups: Array.isArray(value.groups) ? value.groups : [],
              failures: Array.isArray(value.failures) ? value.failures : [],
            };
          }
          return { error: response.error === undefined ? 'refused without a reason' : String(response.error) };
        } catch (error) {
          return { error: error?.message ?? String(error) };
        }
      };

      const fromLlmDirectory = async () => {
        try {
          return await loadCatalogFromLlm();
        } catch (error) {
          return { groups: [], failures: [], error: error?.message ?? String(error) };
        }
      };

      const loadCatalog = async () => {
        const mine = ++generation;
        publish({ status: 'loading', groups: [], failures: [], error: undefined });

        const sessionPromise = fromSessionCatalog();
        const directoryPromise = fromLlmDirectory();

        // Publish the global directory the moment it lands, so the pickers are
        // usable even when the session catalog never settles.
        const directory = await directoryPromise;
        if (mine !== generation) return;
        const directoryOk = Array.isArray(directory.groups) && directory.groups.length > 0;
        if (directoryOk) {
          publish({ status: 'ready', groups: directory.groups, failures: directory.failures ?? [], error: undefined });
        }

        // Then let the session catalog upgrade the result: it is the only source
        // that carries each model's reasoning efforts.
        const session = await sessionPromise;
        if (mine !== generation) return;
        const sessionOk = Array.isArray(session.groups) && session.groups.length > 0;
        if (sessionOk) {
          publish({ status: 'ready', groups: session.groups, failures: session.failures ?? [], error: undefined });
          return;
        }
        if (directoryOk) return;   // already published; the session catalog added nothing

        // Neither source produced models. Report what each one actually did, so
        // an empty picker says why instead of leaving it to guesswork.
        const sessionNote = session.timedOut === true
          ? `timed out after ${SESSION_CATALOG_TIMEOUT_MS}ms (no session open?)`
          : (session.error ?? 'returned no groups');
        const directoryNote = directory.error
          ?? `returned no groups${(directory.failures ?? []).length > 0
            ? ` (${directory.failures.length} provider failure(s))` : ''}`;
        publish({
          status: 'error',
          groups: [],
          failures: [...(session.failures ?? []), ...(directory.failures ?? [])],
          error: `no models from either source — session catalog: ${sessionNote}; llm directory: ${directoryNote}`,
        });
      };

      // A client half that throws while applying leaves the card unregistered,
      // so every optional collaborator is probed and reported rather than
      // trusted. Mirrors the host half's never-throw discipline.
      void safely('initial catalog load', () => loadCatalog());
      safely('adapter updates', () => use(() => ctx.remote.$on('llm/adapters-updated', () => void loadCatalog()), 'model-manager: adapter updates'));
      safely('settings updates', () => use(() => ctx.remote.$on('settings/document-updated', () => void loadCatalog()), 'model-manager: settings updates'));

      // -- lookups ------------------------------------------------------------
      const modelIn = (provider, model) => {
        for (const group of catalog.groups) {
          if (group?.id !== provider) continue;
          for (const entry of group.models ?? []) if (entry?.id === model) return entry;
        }
        return undefined;
      };
      const effortsFor = (route) => {
        const entry = route === undefined ? undefined : modelIn(route.provider, route.model);
        const efforts = entry?.reasoning?.efforts;
        return Array.isArray(efforts) ? efforts : [];
      };
      const catalogue = () => catalog.groups.filter((g) => isObject(g) && Array.isArray(g.models));

      // -- card ---------------------------------------------------------------
      /**
       * Shared per-namespace form, for surfaces that are handed no `form` prop.
       *
       * The Plugins configuration slots pass a `form`; the Settings page slots
       * do not, so that page reads and writes the same namespace through
       * `ctx.configForms`, whose snapshot has the same `{ value, revision,
       * writable, status }` shape and whose `mutate` takes the same operations.
       * Assigned once, inside the `configForms` injection scope below, so the
       * store subscription identities stay stable across renders.
       */
      let settingsForm;
      let settingsSubscribe = () => () => {};
      let settingsGetSnapshot = () => undefined;

      function Card(props) {
        const state = React.useSyncExternalStore(subscribe, getSnapshot);
        const shared = React.useSyncExternalStore(settingsSubscribe, settingsGetSnapshot);
        const [status, setStatus] = React.useState(null);
        const view = props?.view;
        const form = props?.form ?? settingsForm;
        const snapshot = props?.form?.state ?? shared;
        const value = isObject(snapshot?.value) ? snapshot.value : {};
        const roles = isObject(value.roles) ? value.roles : {};
        const mode = isObject(value.strategy) && typeof value.strategy.mode === 'string' ? value.strategy.mode : 'hybrid';

        const summary = () => {
          const parts = ROLES
            .map((role) => {
              const route = firstRoute(roles[role]);
              return route ? `${t(roleKeyFor(role))}: ${route.model}` : undefined;
            })
            .filter(Boolean);
          return parts.length > 0 ? parts.join(' · ') : t('summaryEmpty');
        };

        if (view === 'summary') {
          // The row-list render passes no `form`, so there is nothing to
          // summarise; render nothing and let the row's own description stand
          // rather than claiming no roles are configured.
          if (snapshot === undefined) return null;
          return h('span', { style: S.summary }, summary());
        }
        if (snapshot === undefined) {
          // A page render without a form cannot read or write. Say so instead of
          // sitting on a misleading "loading" state.
          return h('div', { style: S.warn }, t('noForm'));
        }
        if (snapshot.status === 'unavailable') return h('div', { style: S.warn }, t('unavailable'));

        const ready = snapshot.status === 'ready' && snapshot.writable !== false;
        const write = async (ops) => {
          setStatus(null);
          try {
            const accepted = await form.mutate(ops, snapshot.revision);
            setStatus(accepted ? { kind: 'ok', text: t('saved') } : { kind: 'err', text: t('refused') });
          } catch (error) {
            setStatus({ kind: 'err', text: error?.message ?? String(error) });
          }
        };

        /** The role's configured routes, normalized and order-preserving. */
        const roleModels = (role) => {
          const holder = roles[role];
          const list = holder !== null && typeof holder === 'object' && Array.isArray(holder.models)
            ? holder.models : [];
          return list.filter((route) => route !== null && typeof route === 'object'
            && typeof route.provider === 'string' && typeof route.model === 'string');
        };
        // Every edit rewrites the whole list in one atomic operation, so order,
        // removals and effort changes cannot interleave into a partial state.
        const saveModels = (role, next) => write([{ op: 'set', path: ['roles', role, 'models'], value: next }]);

        /** Catalog models as grouped options, minus every key in `exclude`. */
        const modelOptions = (exclude) => {
          const out = [];
          for (const group of catalogue()) {
            const options = (group.models ?? [])
              .filter((entry) => entry !== null && typeof entry === 'object' && typeof entry.id === 'string')
              .filter((entry) => !exclude.has(routeKey(group.id, entry.id)))
              .map((entry) => h('option', {
                key: routeKey(group.id, entry.id),
                value: routeKey(group.id, entry.id),
              }, entry.name && entry.name !== entry.id ? `${entry.name} — ${entry.id}` : entry.id));
            if (options.length > 0) out.push(h('optgroup', { key: group.id, label: group.name ?? group.id }, ...options));
          }
          return out;
        };

        const row = (role) => {
          const models = roleModels(role);
          const used = new Set(models.map((route) => routeKey(route.provider, route.model)));

          // Every control of one role's editor is a child of a single grid, so the
          // column tracks — index, model, effort, actions — line up across rows by
          // construction instead of by luck.
          const cells = [];
          models.forEach((route, index) => {
            const key = routeKey(route.provider, route.model);
            const known = catalogue().some((group) => group.id === route.provider
              && (group.models ?? []).some((entry) => entry?.id === route.model));
            const options = modelOptions(new Set());
            // A configured route the catalog no longer advertises must stay
            // selectable, or the control would silently show a different value.
            if (!known) options.push(h('option', { key: 'current', value: key },
              `${route.provider}/${route.model} (${t('notInCatalog')})`));

            cells.push(h('span', { key: `${key}#i`, style: S.cellIndex }, String(index + 1)));

            cells.push(h('select', {
              key: `${key}#m`,
              style: S.selectGrid,
              value: key,
              disabled: !ready,
              'aria-label': `${t(roleKeyFor(role))} ${index + 1}`,
              onChange: (event) => {
                const next = parseKey(event.target.value);
                if (next === undefined) return undefined;
                const copy = models.slice();
                copy[index] = {
                  provider: next.provider,
                  model: next.model,
                  ...(typeof route.reasoningEffort === 'string' ? { reasoningEffort: route.reasoningEffort } : {}),
                };
                return saveModels(role, copy);
              },
            }, ...options));

            const efforts = effortsFor(route);
            // A row with no effort control still occupies the column, otherwise the
            // action buttons of every row beneath it would sit at a different x.
            cells.push(efforts.length === 0
              ? h('span', { key: `${key}#gap`, 'aria-hidden': true })
              : h('select', {
                key: `${key}#e`,
                style: { ...S.selectGrid, ...S.selectEffortGrid },
                value: typeof route.reasoningEffort === 'string' ? route.reasoningEffort : '',
                disabled: !ready,
                'aria-label': `${t(roleKeyFor(role))} ${index + 1} — ${t('effort')}`,
                onChange: (event) => {
                  const chosen = event.target.value;
                  const copy = models.slice();
                  copy[index] = { provider: route.provider, model: route.model };
                  if (chosen !== '') copy[index].reasoningEffort = chosen;
                  return saveModels(role, copy);
                },
              },
              h('option', { key: '', value: '' }, t('effortDefault')),
              ...efforts.map((effort) => h('option', { key: effort.id, value: effort.id },
                effort.name && effort.name !== effort.id ? `${effort.name} — ${effort.id}` : effort.id))));

            // Both actions always render; the first row's "move up" is disabled
            // rather than absent, so the column width never shifts while reordering
            // and the glyphs keep the row the same width in every locale.
            cells.push(h('span', { key: `${key}#a`, style: S.actions },
              h('button', {
                type: 'button',
                style: index === 0 ? { ...S.action, ...S.actionOff } : S.action,
                disabled: !ready || index === 0,
                'aria-label': `${t('moveUp')} ${index + 1}`,
                title: t('moveUp'),
                onClick: () => {
                  const copy = models.slice();
                  const [moved] = copy.splice(index, 1);
                  copy.splice(index - 1, 0, moved);
                  return saveModels(role, copy);
                },
              }, '↑'),
              h('button', {
                type: 'button',
                style: S.action,
                disabled: !ready,
                'aria-label': `${t('remove')} ${index + 1}`,
                title: t('remove'),
                onClick: () => saveModels(role, models.filter((_, position) => position !== index)),
              }, '×')));
          });

          // Add reads as an affordance, not as another configured model: dashed
          // border, no fill, muted text, and it spans the value columns.
          cells.push(h('select', {
            key: 'add',
            style: { ...S.selectGrid, ...S.selectAdd, ...S.cellSpan },
            value: '',
            disabled: !ready,
            'aria-label': `${t(roleKeyFor(role))} — ${t('addModel')}`,
            onChange: (event) => {
              const next = parseKey(event.target.value);
              if (next === undefined) return undefined;
              return saveModels(role, [...models, { provider: next.provider, model: next.model }]);
            },
          },
          h('option', { key: '', value: '' }, t('addModel')),
          ...modelOptions(used)));

          if (models.length > 1) {
            const holder = roles[role];
            const pick = holder !== null && typeof holder === 'object' && holder.pick === 'round-robin'
              ? 'round-robin' : 'first';
            cells.push(h('span', {
              key: 'pick',
              style: { ...S.cellSpan, display: 'inline-flex', alignItems: 'center', gap: '0.45rem' },
            },
            h('span', { style: S.pickLabel }, t('pick')),
            h('select', {
              style: { ...S.selectGrid, ...S.selectEffortGrid },
              value: pick,
              disabled: !ready,
              'aria-label': `${t(roleKeyFor(role))} — ${t('pick')}`,
              onChange: (event) => write([{ op: 'set', path: ['roles', role, 'pick'], value: event.target.value }]),
            },
            h('option', { key: 'first', value: 'first' }, t('pickFirst')),
            h('option', { key: 'rr', value: 'round-robin' }, t('pickRoundRobin')))));
          }

          return h('div', { key: role, style: S.row },
            h('label', { style: S.label }, t(roleKeyFor(role))),
            h('span', { style: S.hint }, t(hintKeyFor(role))),
            h('div', { style: S.entryGrid }, ...cells),
            models.length > 1 ? h('span', { key: 'oh', style: S.hint }, t('orderHint')) : null);
        };

        const modeControl = h('div', { style: S.row },
          h('label', { style: S.label }, t('mode')),
          h('div', { style: S.controls },
            h('select', {
              style: S.select,
              value: MODES.includes(mode) ? mode : 'hybrid',
              disabled: !ready,
              'aria-label': t('mode'),
              onChange: (event) => write([{ op: 'set', path: ['strategy', 'mode'], value: event.target.value }]),
            }, ...MODES.map((name) => h('option', { key: name, value: name }, t(modeKeyFor(name)))))));

        const notices = [];
        if (!ready && snapshot.status === 'ready') notices.push(h('div', { key: 'ro', style: S.notice }, t('readOnly')));
        if (state.status === 'loading') notices.push(h('div', { key: 'load', style: S.notice }, t('loading')));
        if (state.status === 'error') {
          notices.push(h('div', { key: 'err', style: S.error }, state.error ?? t('unavailable')));
        }
        if (state.status === 'ready' && catalogue().length === 0) {
          notices.push(h('div', { key: 'none', style: S.notice }, t('noModels')));
        }
        if (state.status === 'ready' && state.failures.length > 0) {
          notices.push(h('div', { key: 'fail', style: S.warn },
            `${t('providersFailed')} ${state.failures.map((f) => f?.name ?? f?.id ?? '?').join(', ')}`));
        }
        if (status !== null) {
          notices.push(h('div', {
            key: 'status',
            style: status.kind === 'ok' ? S.ok : S.error,
          }, status.text));
        }

        // Master switch. Off still records what each session ran on, so the
        // report stays useful; it only stops rewriting routes.
        const enableToggle = h('div', { style: S.row },
          h('label', { style: S.toggleRow },
            h('input', {
              type: 'checkbox',
              style: S.checkbox,
              checked: value.enabled !== false,
              disabled: !ready,
              'aria-label': t('enable'),
              onChange: (event) => write([{ op: 'set', path: ['enabled'], value: event.target.checked === true }]),
            }),
            h('span', { style: S.label }, t('enable'))),
          h('span', { style: S.hint }, t('enableHint')));

        return h('div', { style: S.root },
          h('p', { style: S.help }, t('help')),
          enableToggle,
          ...ROLES.map((role) => row(role)),
          modeControl,
          ...notices);
      }

      // One surface only, as requested: a page in the Settings panel
      // (`sidebar.settings` → `settings.section`). The Plugins page slots
      // (`plugins.item`, `plugins.row.config`) are deliberately not registered.
      //
      // Registered *unconditionally* on purpose. The shipped pattern gates a page
      // behind `configForms.whileServed([ns], …)`, but the Host only serves a
      // namespace when the row has a Config schema with volatile fields — so if
      // this plugin's optional schema dependency ever failed to resolve, that
      // gate would hide the page entirely and a packaging problem would look
      // exactly like a missing feature. The entry is therefore always reachable,
      // and the card itself reports why it cannot show values.
      // -- per-session model usage, rendered in the session header -------------
      // The host half folds `modelManagerUsage` out of the durable session log and
      // ships it as a wired projection, so this half only subscribes to a finished
      // value: no folding here, no polling, and the numbers survive a restart.
      function UsageView(props) {
        const face = props.face ?? null;
        const subscribe = React.useMemo(
          () => (face === null ? () => () => {} : (listener) => face.subscribe(listener)),
          [face],
        );
        const getSnapshot = React.useMemo(
          () => (face === null ? () => undefined : () => face.getSnapshot()),
          [face],
        );
        const value = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
        const [open, setOpen] = React.useState(false);
        const routes = Array.isArray(value?.routes) ? value.routes : [];
        if (routes.length === 0) return null;
        const total = routes.reduce((sum, route) => sum + (Number.isSafeInteger(route.totalTokens) ? route.totalTokens : 0), 0);
        const rows = [...routes].sort((a, b) => (b.totalTokens ?? 0) - (a.totalTokens ?? 0));
        const head = [
          h('div', { key: 'h', style: S.usageHead }, [
            h('span', null, t('usageTitle')),
            h('span', null, formatTokens(total)),
          ]),
        ];
        for (const route of rows) {
          const label = `${route.provider}/${route.model}`;
          head.push(h('div', { key: label, style: S.usageRow }, [
            h('span', { style: S.usageName, title: label }, label),
            h('span', { style: S.usageValue }, formatTokens(route.totalTokens)),
            h('span', { style: S.usageBuckets }, [
              t('usageUncachedInput'), ' ', formatTokens(route.uncachedInputTokens),
              ' · ', t('usageOutput'), ' ', formatTokens(route.outputTokens),
              ...(route.cacheReadTokens > 0 ? [' · ', t('usageCacheRead'), ' ', formatTokens(route.cacheReadTokens)] : []),
              ...(route.cacheWriteTokens > 0 ? [' · ', t('usageCacheWrite'), ' ', formatTokens(route.cacheWriteTokens)] : []),
              ' · ', t('usageRequests', { count: route.requests }),
            ].join('')),
          ]));
        }
        head.push(h('div', { key: 'hint', style: S.usageEmpty }, t('usageHint')));
        return h('span', { style: S.usage }, [
          h('button', {
            type: 'button',
            style: S.usageButton,
            'aria-haspopup': 'dialog',
            'aria-expanded': open,
            onClick: () => setOpen((current) => !current),
          }, [            t('usageTitle'), ' ', formatTokens(total), ' · ', String(rows.length)],
          ),
          ...(open ? [h('div', { style: S.usagePanel, role: 'dialog', 'aria-label': t('usageTitle') }, head)] : []),
        ]);
      }

      safely('session usage surface', () => ctx.inject(['sessions'], (scoped) => {
        const sessions = scoped.sessions;
        if (sessions === undefined || typeof sessions.binding !== 'function') {
          console.warn('[model-manager] no sessions service; per-session model usage is unavailable');
          return undefined;
        }
        return ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
          name: 'conversation.session.header.utilities',
          id: 'model-manager-usage',
          order: 60,
          locale: LOCALE_NS,
          inject: (sessionId) => {
            let face;
            try {
              face = sessions.binding(sessionId)?.session?.projections?.faceOf?.(USAGE_PROJECTION_KEY);
            } catch (error) {
              console.warn(`[model-manager] projection face unavailable: ${error?.message ?? error}`);
              face = undefined;
            }
            return { sessionId, face: face ?? null };
          },
        }, UsageView));
      }));

      safely('settings page', () => use(() => ctx.slots.inject('settings.section', () => {
        const disposer = ctx.slots.register({
          name: 'settings.section',
          id: 'model-manager',
          order: 50,
          label: () => t('title'),
        }, Card);
        // A positive line at the moment the card actually lands. The apply-time
        // summary below cannot know whether this ran: `slots.inject` waits for the
        // owning declaration, so a count taken there would read 0 even on success.
        try {
          console.log('[model-manager] settings card registered');
        } catch {
          /* logging is best-effort */
        }
        return disposer;
      }), 'model-manager: settings page'));

      // Bind the shared per-namespace form when the Host serves it. This runs at
      // apply time, well before the user can navigate to the page, so the card's
      // first render already sees it.
      safely('settings form', () => ctx.inject(['configForms'], (scoped) => {
        settingsForm = safely('settings form get', () => scoped.configForms.get(ROW_NS));
        if (settingsForm !== undefined) {
          if (typeof settingsForm.subscribe === 'function') settingsSubscribe = settingsForm.subscribe.bind(settingsForm);
          if (typeof settingsForm.getSnapshot === 'function') settingsGetSnapshot = settingsForm.getSnapshot.bind(settingsForm);
        }
      }));

      // One success line, so the browser console distinguishes "never applied"
      // from "applied but a step failed" (each failed step logs its own
      // `[model-manager] <step>: <error>` warning immediately above this).
      try {
        console.log('[model-manager] client half applied; locale registered, 2 surfaces awaited (settings section, session header utilities)');
      } catch {
        /* logging is best-effort */
      }
    }

    function formatTokens(value) {
      const n = Number.isSafeInteger(value) && value >= 0 ? value : 0;
      if (n >= 1000000) return `${(n / 1000000).toFixed(n >= 10000000 ? 0 : 1)}M`;
      if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
      return String(n);
    }

    function roleKeyFor(role) {
      return role === 'main' ? 'roleMain'
        : role === 'planning' ? 'rolePlanning'
          : role === 'execution' ? 'roleExecution'
            : 'roleVision';
    }
    function hintKeyFor(role) {
      return role === 'main' ? 'roleMainHint'
        : role === 'planning' ? 'rolePlanningHint'
          : role === 'execution' ? 'roleExecutionHint'
            : 'roleVisionHint';
    }
    function modeKeyFor(mode) {
      return mode === 'managed' ? 'modeManaged' : mode === 'advisory' ? 'modeAdvisory' : 'modeHybrid';
    }

    return {
      // Each `remote.<namespace>` is its own cordis service, installed when the
      // package contributing it applies — `remote` itself existing does not mean
      // `remote.llm` or `remote.session` do. Declaring them here parks this half
      // until they are mounted. Without that, `apply` ran first and both were
      // `undefined`, which is exactly what emptied the model pickers.
      inject: ['slots', 'locale', 'remote', 'remote.llm', 'remote.session'],
      apply,
    };
  },
});
