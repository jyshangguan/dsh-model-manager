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
    const ROLES = ['main', 'planning', 'execution', 'vision'];
    const MODES = ['hybrid', 'managed', 'advisory'];

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
      unset: '(unset — inherit)',
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
      unset: '（未设置 — 继承）',
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
      selectEffort: {
        flex: '0 1 11rem',
        minWidth: 0,
        padding: '0.35rem 0.5rem',
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: '0.85rem',
      },
      entryRow: { display: 'flex', gap: '0.4rem', alignItems: 'center', flexWrap: 'wrap' },
      index: {
        flex: '0 0 auto',
        minWidth: '1.4rem',
        fontSize: '0.76rem',
        color: 'var(--dsw-alias-label-secondary)',
        fontVariantNumeric: 'tabular-nums',
      },
      button: {
        flex: '0 0 auto',
        padding: '0.3rem 0.6rem',
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: '0.78rem',
        cursor: 'pointer',
      },
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

      const loadCatalog = async () => {
        const mine = ++generation;
        publish({ status: 'loading', groups: [], failures: [], error: undefined });

        // Preferred source: it also carries each model's reasoning efforts.
        let groups = [];
        let failures = [];
        let error;
        try {
          const response = await ctx.remote.session.modelCatalog();
          if (mine !== generation) return;
          if (response && response.ok) {
            const value = response.value ?? {};
            groups = Array.isArray(value.groups) ? value.groups : [];
            failures = Array.isArray(value.failures) ? value.failures : [];
          } else if (response) {
            error = response.error;
          }
        } catch (caught) {
          if (mine !== generation) return;
          error = caught?.message ?? String(caught);
        }
        if (mine !== generation) return;

        // Nothing usable from the session namespace → try the global directory.
        if (groups.length === 0) {
          try {
            const fallback = await loadCatalogFromLlm();
            if (mine !== generation) return;
            if (fallback.groups.length > 0) {
              groups = fallback.groups;
              failures = fallback.failures;
              error = undefined;
            } else if (fallback.failures.length > 0) {
              failures = fallback.failures;
            }
          } catch (caught) {
            if (mine !== generation) return;
            if (error === undefined) error = caught?.message ?? String(caught);
          }
        }
        if (mine !== generation) return;
        publish(groups.length === 0 && error !== undefined
          ? { status: 'error', groups: [], failures, error }
          : { status: 'ready', groups, failures, error: undefined });
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

          const entries = models.map((route, index) => {
            const key = routeKey(route.provider, route.model);
            const known = catalogue().some((group) => group.id === route.provider
              && (group.models ?? []).some((entry) => entry?.id === route.model));
            const options = modelOptions(new Set());
            // A configured route the catalog no longer advertises must stay
            // selectable, or the control would silently show a different value.
            if (!known) options.push(h('option', { key: 'current', value: key },
              `${route.provider}/${route.model} (${t('notInCatalog')})`));

            const controls = [
              h('span', { key: 'i', style: S.index }, String(index + 1)),
              h('select', {
                key: 'model',
                style: S.select,
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
              }, ...options),
            ];

            const efforts = effortsFor(route);
            if (efforts.length > 0) {
              controls.push(h('select', {
                key: 'effort',
                style: S.selectEffort,
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
            }

            if (index > 0) {
              controls.push(h('button', {
                key: 'up',
                type: 'button',
                style: S.button,
                disabled: !ready,
                'aria-label': `${t('moveUp')} ${index + 1}`,
                onClick: () => {
                  const copy = models.slice();
                  const [moved] = copy.splice(index, 1);
                  copy.splice(index - 1, 0, moved);
                  return saveModels(role, copy);
                },
              }, t('moveUp')));
            }
            controls.push(h('button', {
              key: 'rm',
              type: 'button',
              style: S.button,
              disabled: !ready,
              'aria-label': `${t('remove')} ${index + 1}`,
              onClick: () => saveModels(role, models.filter((_, i) => i !== index)),
            }, t('remove')));

            return h('div', { key: `${role}-${index}`, style: S.entryRow }, ...controls);
          });

          const addRow = h('div', { style: S.entryRow },
            h('select', {
              key: 'add',
              style: S.select,
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

          const tail = [];
          if (models.length > 1) {
            tail.push(h('span', { key: 'oh', style: S.hint }, t('orderHint')));
            const holder = roles[role];
            const pick = holder !== null && typeof holder === 'object' && holder.pick === 'round-robin'
              ? 'round-robin' : 'first';
            tail.push(h('div', { key: 'pick', style: S.entryRow },
              h('span', { style: S.index }, t('pick')),
              h('select', {
                style: S.selectEffort,
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
            ...entries,
            addRow,
            ...tail);
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
      safely('settings page', () => use(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'model-manager',
        order: 50,
        label: () => t('title'),
      }, Card)), 'model-manager: settings page'));

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
        console.log('[model-manager] client half applied; locale + 3 surfaces attempted');
      } catch {
        /* logging is best-effort */
      }
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
      inject: ['slots', 'locale', 'remote'],
      apply,
    };
  },
});
