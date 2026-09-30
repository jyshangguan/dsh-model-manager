# @jyshangguan/dsh-model-manager

A host-half plugin for DeepSeek Harness that assigns models to four roles — `main`,
`planning`, `execution`, `vision` — applies them on the `agent/request` waterfall, and
reports which model every subagent actually used, with its role, the reason, and its live
status.

## What it is

DSH already ships the primitives: the `subagent` tool accepts an explicit
`provider`/`model` per delegation, and the `subagent-model-selection-settings` row
constrains which routes an agent may name. What it does not ship is a layer above that:
nothing assigns models to *kinds of work* (planning, implementation, image reading), and
nothing tells you afterwards which model a given subagent ended up on.

This plugin is that layer. It keeps one ordered route list per role, classifies each
delegated child from the label the delegating agent gives it, rewrites the child's resolved
route to the role's route when inheritance is provable, and exposes a read-only
`model_manager` tool that reports what happened. It is deliberately small: one ESM host
file, one config schema, and one hand-written client file that contributes a
configuration card to the Plugins page. There is no build step for either half.

## Install

One command — straight from GitHub, or from a working copy:

```bash
# from GitHub, no publishing step; needs git access to the repo
dsh plugin --profile desktop add github:jyshangguan/dsh-model-manager

# from a working copy (path must be absolute)
git clone https://github.com/jyshangguan/dsh-model-manager.git
dsh plugin --profile desktop add /absolute/path/to/dsh-model-manager

# from npm — only after `npm publish`; see "Not on npm yet" below
dsh plugin --profile desktop add @jyshangguan/dsh-model-manager@latest
```

Use the profile your app actually boots. `dsh web` and the Web GUI run the `web` profile; the
desktop app (DeepSeek Harness.app) runs **`desktop`**, so a plugin installed into `web` is
invisible there. When in doubt, check the running process's working directory: it is
`$DSH_HOME/profiles/<name>`.

`dsh plugin` forwards everything after `--profile <name>` to **pnpm, run inside the profile
directory** under a file lock (`lib/bin.js` → `runPlugin` → `runPluginCommand` in
`@deepseek-ai/dsh-plugin-manager`). It is the same code path the GUI's `install_bundle` action
uses, so both leave an identical result.

What makes it one command instead of three: after the install, `reconcile()` walks every *new*
profile dependency, reads its manifest, and when it declares `dsh.bundle.patch` it validates that
patch and appends the package name to `dsh.profile.bundles`, writing `package.json` atomically. A
dependency that declares no `dsh.bundle` prints `installed as a plain dependency, not a profile
layer` and is never mounted. The profile-layer registration you would otherwise hand-edit is the
installer's job.

Then **restart the harness once** and confirm the row mounted: `plugin_manager` `list_plugins`
should show row id `model-manager`, `enabled: true`, `fiberPhase: active`.

### Add plugin, from the Plugins page

The Plugins page's **Add plugin** field reads *"Enter the plugin's package name, GitHub repository
address, or local directory path."* It is the GUI's `install_bundle`, and it parses the string
through the same `parseInstallSpec` (`@deepseek-ai/dsh-plugin-manager/lib/types/install-spec.js`)
before handing it to pnpm. Paste any one of:

| Field input | Spec kind |
| --- | --- |
| `github:jyshangguan/dsh-model-manager` | git — the `https://github.com/…` URL works too |
| `/Users/you/src/dsh-model-manager` | absolute local directory (relative paths are refused) |
| `/Users/you/dsh-model-manager-0.1.0.tgz` | local tarball — `npm pack` makes one, no registry needed |
| `@jyshangguan/dsh-model-manager` | registry — needs the package published first |

The **Add plugin** field prompts for a package name, and that is the one form that does not work
yet; the other three do. Verified end-to-end on this runtime: the git and local-path forms both
install, `reconcile()` appends the bundle, and the composed tree mounts row `model-manager`.

### Not on npm yet

`@jyshangguan/dsh-model-manager` is **not published**. Asking for it by name fails at pnpm with
`ERR_PNPM_FETCH_404: GET https://registry.npmjs.org/@jyshangguan%2Fdsh-model-manager: Not Found`.
Publishing is the only thing standing between this plugin and the package-name form — the manifest
is already public-access, unprivate, and `files` lists exactly what a mounted bundle needs, so
`npm publish` from the repository root is the whole step. Until then use the **git** or **local
path** form: both install the same tree a published tarball would contain, because every shipped
file is committed and `files` limits the pack to them (verified — the git install delivers
`lib/index.js`, `client.js`, `cordis.patch.yml`, `locale/*.json` and no `node_modules`).

### Why the package is scoped

The unscoped name `dsh-model-manager` is **already taken on npm by a different plugin**: another
DeepSeek Harness package whose Chinese display name is also 模型管理器, and which also declares
`dsh.bundle.patch`. Installing by that bare name fetches theirs and auto-registers it into your
boot graph; were both ever mounted together their loader rows could collide on one id, which
aborts startup with `duplicate loader entry id`. `test/packaging.test.mjs` pins the scoped name
so this cannot silently regress.

### The runtime version gate

`peerDependencies["@deepseek-ai/dsh"]` is `>=0.1.7-rc.2 <0.3.0`. The harness checks exactly that
peer — only names equal to `@deepseek-ai/dsh` or beginning `@deepseek-ai/dsh-` — with semver,
**prereleases included** (`semver.satisfies(runtime, range, { includePrerelease: true })` in
`@deepseek-ai/dsh-app-boot`), and refuses an incompatible install while printing the exemption
command:

```bash
dsh plugin --profile desktop allow-version @jyshangguan/dsh-model-manager@0.1.0 \
  --dsh-version <exact runtime version> --accept-risk
```

Without that peer this plugin would install silently onto a harness too old to have
`sessionProjections.stateOf` or the `model/selection` event, and then degrade with no
explanation. Profiles ship `autoInstallPeers: false`, so declaring the peer does not pull a
second copy of dsh into the profile.

The range was `>=0.1.7-rc.2 <0.2.0` through 0.1.0, and that upper bound did not mean what it
looked like. In semver a prerelease sorts *below* its release, so `0.2.0-rc.2 < 0.2.0` is true:
the old range admitted **every 0.2.0 prerelease** while excluding `0.2.0` itself. It therefore
permitted exactly the builds nobody had tested and blocked the release it appeared to target.
`<0.3.0` is what it was meant to say, and it now covers the whole 0.2.0 line deliberately.

The 0.2.0 line is admitted because the host half is verified against it. Against **dsh
0.2.0-rc.2** — the core bundled in DeepSeek Harness.app 0.2.0-rc.2 and the `latest` tag on npm —
every API this plugin touches is unchanged from 0.1.7-rc.2: `dsh-session-projection`
(`stateOf`), `dsh-plan-mode`, `dsh-agent`, `dsh-subagent`, `dsh-tool-subagent` +
`model-selection-settings`, `dsh-tools`, `dsh-llm`, `dsh-session` and `dsh-client-modules` are
byte-identical, all five subscribed events and every probed service still exist, and all 22
failover `failure.code` values are still emitted. A real boot on that runtime applied the host
half, bound every event, resolved every injection and registered the `model_manager` tool. The
client half is unchanged too: `window.__ModuleLoader__.load({ id, factory })`, the `dsh.client`
manifest keys and every injected namespace still match what 0.2.0 provides.

What did change between the two runtimes touches nothing here: `dsh-agent-loop` adds
`ToolCallRecovery` on step failure, `dsh-session` refactors tail repair, `dsh-config-editor`
changes how inherited config composes, and `dsh-api-remotes` gains transport code plus two
namespaces (`productAnalytics`, `userQuestions`) with **no removals**.

### Renaming or moving a linked install

Both of these were hit for real while scoping this package, on DSH 0.1.7-rc.2:

`remove_bundle` drops the dependency from the profile's `package.json` and removes it from
`dsh.profile.bundles`, but **leaves the symlink behind** in the profile's `node_modules`. Delete
that orphan yourself: a directory whose name no longer matches the `name` in its own manifest is
precisely what a resolution scanner should not have to reason about. (Clearing it did *not* fix
the symptom below, so it is hygiene rather than a remedy.)

And a **running host cannot import a package name that did not exist when it booted**. The runtime
resolution is computed from the installation and the bundles selected at startup, then handed to
Node's ESM and CommonJS resolvers, so after a rename the entry reports `failed to import` —
`inactiveEntries` finding `entry.fiber === undefined` — however many times you toggle the bundle.
The package itself is fine: `node -e "import('<new name>')"` from the profile directory succeeds,
and `dsh --profile <name> --dump-config` composes the row correctly, override config included.
Only a restart picks it up. Remove the old name, install the new one, then restart once.

| File | Purpose |
| --- | --- |
| `lib/index.js` | Host half: Cordis identity `model-manager`, exported `Config`, `apply`, the `agent/request` routing, the `agent/request-error` failover, and the `model_manager` tool. |
| `client.js` | Client half: the configuration card, contributed as a page in the Settings panel. |
| `locale/en.json`, `locale/zh.json` | Display metadata only — the bundle's `title` and `description` in the plugin list. |
| `cordis.patch.yml` | Bundle layer: inserts exactly one row, id `model-manager`. |
| `package.json` | Package `@jyshangguan/dsh-model-manager`, declaring `dsh.bundle.patch`, `dsh.client`, and the `@deepseek-ai/dsh` version gate. |
| `test/` | The test suite; `npm test` runs all of it. See [Testing](#testing). |

### Making the schema dependency resolvable

`@deepseek-ai/schemastery` is declared as an **optional peer**: the harness ships it, and this
package deliberately does not install its own copy, so the `Config` schema is built by the same
schemastery instance the loader validates with.

But a path-based install is *linked*, not copied, so Node resolves this package's imports from
its own directory upward — which never reaches the profile's `node_modules`. Point it at the
harness's copy once per machine:

```bash
mkdir -p node_modules/@deepseek-ai
ln -s "$(npm root -g)/@deepseek-ai/dsh/node_modules/@deepseek-ai/schemastery" \
      node_modules/@deepseek-ai/schemastery
```

`npm root -g` is the global install root; adjust if your `dsh` lives somewhere else.
`node_modules/` is git-ignored, so this step is not carried by the repository.

Skipping it does not break the plugin: `Config` degrades to `undefined`, cordis's
`resolveConfig` passes the raw config straight through, and routing keeps working. What you
lose is the Settings card — the harness only serves a settings namespace for a row that has a
Config schema, so the card would report the namespace as unavailable.

**The test suite needs it too**, and fails less gracefully than the plugin does: without a
resolvable schemastery, `edge` dies on `TypeError: plugin.Config is not a constructor` and
`client-diagnostic` loses one assertion. This is a known rough edge — the suites should skip
those cases with a warning instead of crashing. Create the symlink before running `npm test` on
a fresh clone.

**Restart the harness once after installing.** The client half reaches the browser through
a boot manifest: the node half of `client-modules` scans the loader's entries for packages
declaring `dsh.client`, and package metadata — including the negative "not a client
package" verdict — is cached per loader specifier *until restart*. It is the same restart
the host half needs, so do both at once. Before it, the Plugins page simply shows no
configure control for this bundle.

```json
{
  "exports": {
    ".": "./lib/index.js",
    "./client": "./client.js",
    "./locale/*.json": "./locale/*.json",
    "./package.json": "./package.json"
  },
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    },
    "client": {
      "platform": "web",
      "immediately": true,
      "inject": [
        "@deepseek-ai/dsh-client-locale",
        "@deepseek-ai/dsh-client-ui-settings",
        "@deepseek-ai/dsh-api-remotes"
      ]
    }
  }
}
```

`platform: "web"` is what makes this a browser module for the web shell, and `immediately:
true` marks it for stage-one prefetch, so its factory is registered during module-face boot
instead of on demand. `inject` is a *dependency edge*, not a mount whitelist: each named package
has to arrive first because it declares something this half uses —
`@deepseek-ai/dsh-client-locale` for `ctx.locale.register`, `@deepseek-ai/dsh-client-ui-settings`
for the `settings.section` slot, and `@deepseek-ai/dsh-api-remotes` for the `remote.llm` and
`remote.session` faces the card reads the model catalog and the usage projection through. If one
is missing from the composition that registration has nothing to attach to; the host half still
routes, and the boot log names the surface that never appeared.

To smoke-test it before installing anything, mount the entry by path in a throwaway
patch layer and boot the whole plugin tree headless — a plugin that breaks startup fails
here instead of in your running server:

```yaml
# smoke.patch.yml
- insert:
    - id: model-manager-smoke
      name: '/absolute/path/to/dsh-model-manager/lib/index.js'
      config:
        roles:
          planning:
            models:
              - provider: pku-corpus
                model: qwen3.8-max-0902
          execution:
            models:
              - provider: pku-corpus
                model: qwen3.8-flash
        strategy:
          mode: hybrid
```

```bash
dsh --profile web --patch ./smoke.patch.yml headless "say ok"
```

## The four roles

Each role holds an ordered list of routes and a `pick` strategy. A role with no models
resolves to no route, and requests classified into it pass through unchanged — except
`vision`, which falls back to `execution`. A subagent never uses `main`.

| Role | What it is for | When it applies | Bundled default |
| --- | --- | --- | --- |
| `main` | The top-level agent outside plan mode. | Requests from a non-subagent session while plan mode is **not** active. | `models: []` (no route — the composer choice is left alone) |
| `planning` | Reasoning, design, analysis, research. | Top-level requests while plan mode is active; subagents whose label matches a planning keyword (and no vision keyword). | `pku-corpus/qwen3.8-max-0902` |
| `execution` | Default tier for delegated implementation. | Every subagent that matches neither keyword list, including a child with an empty label; also the fallback for vision when `vision` has no models. | `pku-corpus/qwen3.8-flash` |
| `vision` | Image, screenshot, chart and OCR work. | Subagents whose label matches a vision keyword. | `models: []` (falls back to `execution`) |

A route is `{ provider, model, reasoningEffort? }`; `pick` is `first` (default) or
`round-robin`. With one model in the list, `pick` has no effect. A role may also carry a
`note` — free text for humans, printed under the role in the `routes` table and never
used for routing.

## Configure in the UI

The client half contributes a configuration card to the Plugins page. It writes exactly the
values documented under [Configuration](#configuration) — `roles.<role>.models` and
`strategy.mode` — so the two paths are interchangeable: use the card to try a routing
choice, the YAML to pin it. This package's own `cordis.patch.yml` is the declarative source
that ships with the bundle and is re-read on every boot, and a profile patch overrides it by
row id; the card never edits patch files, so if a patch layer pins a value, edit the patch.

### Where the card appears

`client.js` registers **two** surfaces and deliberately nothing on the Plugins page:

| Slot | Registration id | What it renders |
| --- | --- | --- |
| `settings.section` | `model-manager` | The configuration card: the four roles and their model lists, the pick strategy, the distribution mode. |
| `conversation.session.header.utilities` | `model-manager-usage` | The per-session model-usage summary the host half folds from the durable log. |

So the path is **设置 → 模型管理器** — not Plugins → the row → configure. `plugins.item` and
`plugins.row.config` are *not* registered: one card in one place was the requirement, and a
second copy on the Plugins page would only be a second place for the same values to disagree.

Both entries are registered **unconditionally** rather than behind the shipped
`configForms.whileServed([ns], …)` gate. The Host serves a settings namespace only for a row
whose Config schema has volatile fields, so that gate would hide the card entirely whenever the
optional schemastery dependency failed to resolve — making a packaging problem look exactly like
a missing feature. The entry is therefore always reachable, and the card itself reports why it
cannot show values.

The usage surface only subscribes to a finished value: the host half folds `modelManagerUsage`
out of the durable session log and ships it as a wired projection, so there is no folding and no
polling on the client, and the numbers survive a restart.

### What the card offers

| Control | Writes | Notes |
| --- | --- | --- |
| Model rows, one per role (`Main model`, `Planning and reasoning`, `Execution`, `Image recognition`) | `set roles.<role>.models` | Each configured route is its own row with a `<select>` grouped by provider in `<optgroup>`s, fed by `ctx.remote.session.modelCatalog()` and labelled `name — id`. A route the catalog stopped advertising stays selectable and is marked `(not in catalog)` rather than being silently swapped. An empty list is the YAML default: no route for that role, and `vision` falls back to `execution`. |
| Add a model | `set roles.<role>.models` | One dashed control under the rows, listing every catalog model the role has not already used, so a model cannot be added twice. |
| `up` / `remove` | `set roles.<role>.models` | Reorder and delete. The whole list is rewritten in one atomic operation, so a reorder cannot interleave into a partial state. The up control is **disabled on the first row** rather than absent, so the column never changes width. |
 `reasoning.efforts`** in the catalog. `(model default)` writes a route with no `reasoningEffort`, letting the adapter choose; naming a tier explicitly is how you satisfy a model that rejects a request without one. |
| Reasoning-effort picker | `set roles.<role>.models` (single route with `reasoningEffort`) | Appears **only when the selected model advertises `reasoning.efforts`** in the catalog. `(model default)` writes a route with no `reasoningEffort`, letting the adapter choose; naming a tier explicitly is how you satisfy a model that rejects a request without one. |
| `Pick` (`first` / `round-robin`) | `set roles.<role>.pick` | Shown for a role holding two or more models. `first` always uses index 0 and only advances when a route fails; `round-robin` spreads consecutive requests. |
| Distribution mode | `set strategy.mode` | `hybrid` / `managed` / `advisory`, labelled with the same one-line explanations this README uses. A stored mode the card does not know displays as `hybrid`, mirroring the host half's fallback. |

**Layout.** One CSS grid per role, with fixed column tracks `auto minmax(0, 1fr) auto auto` — index, model, effort, actions. That choice is the whole reason the rows line up: in a flex row a control with `flex: 1 1 16rem` takes width from its siblings, so any row that omits one control (a model with no reasoning tiers, a first row with no reorder button) pulls every other row's right edge out of alignment. Under the grid a row with no effort control still emits an empty cell, so the action column sits at the same x everywhere. The two actions are glyphs rather than words, so the column is also the same width in either locale; each keeps an `aria-label` and a native `title`. The add affordance is deliberately unlike a model row — dashed border, no fill, muted text, spanning the value columns — and the pick line uses its own label style instead of the numeric index style.

Each role also carries a hint line (`Top-level agent outside plan mode. Leave unset to keep
following the composer selection.`, `Used for image, screenshot and OCR work. Pick a model
that accepts images.`, …) so the card explains itself without this README open.

The card cannot tell you whether a model accepts images: the session model catalog carries
ids, names and reasoning efforts, and no modality field. Use
`model_manager(action: "routes")` for the vision capability audit, which asks the host half's
`llm` service instead.

### How a change reaches the router

**Immediately, with no Save button.** Every control writes on `change`, and the host half
re-reads its config on `loader/volatile-update`, so the next request uses the new value
without a restart. A short status line confirms the outcome (`Saved`, or the host's refusal
or error message) in the theme's success/error colour.

**The UI never writes settings storage itself.** The page owner hands the card a `form`
built from the row's settings namespace (`model-manager`): `form.state` with the accepted
`value`, the current `revision`, `writable` and `status`, and `form.mutate(ops, revision)`
for ordered path operations. The card always submits with the revision it just read, and a
mutate that returns falsy or throws is reported rather than assumed to have worked. That is
why this card cannot race the host's own settings writes: a stale write is fenced off by the
revision rather than silently overwriting a newer one.

### When the card cannot show anything

A component that throws blanks its whole slot entry, so each unavailable state renders a
notice instead — and every optional collaborator is probed, with any failure logged as
`[model-manager] <step>: <message>` through a wrapper that keeps applying:

| State | Cause | Rendered copy |
| --- | --- | --- |
| No `form` on a page render | the host rendered this slot without values — a defensive path, not the row page | `This page did not supply configuration values, so the model roles cannot be edited here. Open this plugin's own row on the Plugins page to configure it.` (warning colour) |
| No `form` on the summary render | the row-list render always omits it | renders nothing: the card returns `null` and the row's description stands |
| Catalog loading | `modelCatalog()` in flight | every control renders **disabled**, the add control offers only its own `Add a model…` placeholder, a configured route the catalog has not returned yet still shows as `provider/model (not advertised)` so its value is never silently swapped, and `Loading models…` appears below |
| Not available to this client | `form.state.status === 'unavailable'` — the namespace is not exposed here | `These settings are not available to this client right now.` (warning colour) |
| Read-only deployment | `status === 'ready'` but `writable === false` | role rows render disabled, plus `This deployment stores settings read-only.` |
| Nothing advertised | catalog ready with zero provider groups | `No models are advertised yet. Configure a provider route, then reopen this page.` |
| Partial failure | catalog `failures` non-empty | `Some providers could not be listed: <name, name>` (warning colour) |
| Fetch failed | `modelCatalog()` returned an error or threw | the error message, in the error colour |

The notices are ordered so a read-only deployment says so before anything about the catalog,
and the write-result line (`Saved` / refusal) is last, because it is the most transient.

The catalog is fetched once per page load and refreshed on the `llm/adapters-updated` and
`settings/document-updated` remote events, so adding a provider route makes its models
appear without a reload. A `generation` counter discards a response that is older than the
most recent request, and a throwing subscriber cannot break the other subscribers.

**A configured route the catalog no longer advertises stays selectable**, appended as an
extra option labelled `pku-corpus/some-retired-model (not advertised)` and kept as the
selected value. Without that, a `<select>` whose value matches no `<option>` renders as its
first option instead — so the card would appear to name a model the config does not select,
and saving anything else on that row would overwrite the real route.

Note also that picking a *different* model for a role preserves a `reasoningEffort` already
stored on that route. If the new model advertises no efforts, the effort picker disappears
while the stored effort remains in the config; clear it by writing the role's models from
the patch layer.

### How the card is built

- **It requires exactly one module: `react`.** The harness's plugin practices forbid
  `require`-ing Harness Client packages from a hand-written client half — including
  `@deepseek-ai/dsh-client-ui-primitives` — because a second copy of a UI package in the
  browser graph is a breakage waiting to happen. So the `<select>` controls here are written
  locally in `client.js` rather than imported.
- **Styling uses only `--dsw-alias-*` theme tokens**: `bg-layer-1`, `border-l1`,
  `label-primary`, `label-secondary`, `state-success-primary`, `state-error-primary`,
  `state-warn-primary`. Light and dark follow the host, and a future token rename degrades
  to an inherited colour instead of breaking the entry.
- **Its copy is localized.** `apply` registers a `dsh-model-manager` locale namespace with
  inline English and Chinese dictionaries through `ctx.locale`, and binds it for rendering;
  if the binding fails, labels degrade to their key names. The `locale/en.json` and
  `locale/zh.json` files in the package are separate: they are the bundle's `title` and
  `description` as shown in the plugin list.

**Verification status, stated honestly:** the client half was verified by JavaScript syntax,
manifest validation, a structural load of the `window.__ModuleLoader__.load` factory — which
confirms that only `react` is required, that `apply` registers the `dsh-model-manager` locale
namespace with the same 46 keys in English and Chinese (the test compares the sorted key *sets*,
not just their counts), that exactly two surfaces are injected — `settings.section` under
`model-manager` and `conversation.session.header.utilities` under `model-manager-usage` — and
that `apply` still returns normally when every injected collaborator throws. It was also checked
against the live slot contract in `@deepseek-ai/dsh-client-ui-settings`. **Visual verification of
the rendered card is not available in this environment:** the harness's own verification guidance
forbids emulating React/DOM or building mock previews as a substitute for a browser, so the
rendered appearance is unverified. Remember the restart after installing, since the live slot only
populates once the client-module boot manifest has been rebuilt.

## Distribution strategy

### Modes

`strategy.mode` decides whether the selected role route is written into the request.

| Mode | Behaviour |
| --- | --- |
| `hybrid` (default) | Top-level requests are rewritten whenever the role has a route. A subagent is rewritten **only when inheritance is provable** — its resolved route equals the parent's effective route, or equals a route this manager already applied to that child (see below). Anything else is respected as the child's own choice. |
| `managed` | The role route is always applied, overriding an explicit per-delegation `provider`/`model`. Use this if you want routing regardless of lineage. |
| `advisory` | Never rewrites anything. It classifies the request and records the model actually used. |

`hybrid` is what makes per-delegation choices work: pass nothing and the role decides;
pass an explicit `provider`/`model` to the delegation tool and your choice survives.

### `main` and the composer's model picker

These are two different mechanisms, and they used to collide: the composer writes the
session's own route (`session.selectModel`), while the manager rewrote it at request time
whenever `main` was configured — so the picker kept displaying a model that was never used.

In `hybrid` the manager now backs off when you have actually chosen. The test is
**durable, not a guess**: selecting a model in the composer appends a
`model/selection` event to the session log — that event has exactly one append site in the
whole install (`selectForNextRequest`) — and this plugin folds it into a
`modelManagerSelection` session projection. A session with such an event keeps your pick and
records `explicit session selection (respected)`; a session that never had one is running on
the deployment default, which is the route `main` exists to replace.

Three things follow from that. `managed` is unchanged — it means "the manager owns every
route", including a session you picked by hand. A respected selection **does not consume the
round-robin rotation**, because rotation commits only when a route is applied; the first
request the manager does take over still gets the first model. And the choice survives a
restart, a resume and a fork, because it is read from the log rather than remembered in
process state.

One caveat worth knowing: **the composer's picker also overwrites the deployment default**
(implementation note: `selectModel` calls `selectForNextRequest` *and*
`agentDefaultModel.saveSelection` in the same action). Picking a model for one session
therefore changes what brand-new sessions start on too, which is the harness's behaviour, not
this plugin's.

### What "inherited" means

Three rules decide whether a subagent request is treated as inherited.

**The parent's effective route.** Read the same way DSH itself computes the route it
passes to a child: the parent's latest request header
(`agent.session.requestHeader()?.config`) owns `provider`/`model`, and the parent's
creation options (`agent.options`) are only the pre-first-request fallback. That matters
because after request-time selection the header reflects what the parent actually ran on
— including a route this plugin applied. Comparing against `agent.options` instead would
misread a manager-rewritten parent as an explicit child choice and silently stop routing.

**Manager-owned children.** Once the manager routes a child, that child's own request
header changes, so on its next request it no longer equals the parent's route. Without a
second rule, a long-running child would be reclassified as an explicit choice and quietly
stop being managed. So a child is also treated as inherited when its route equals the
route the manager itself last applied to it. This is tracked by an internal `applied` flag
recorded per request, and it is `true` only when a route was really applied — `advisory`,
respected-explicit and `passthrough` all record `false`, so **an explicit choice is never
re-adopted**. Manager-ownership is checked before lineage, so a child the manager already
routed stays managed even if its parent goes away.

**Unresolvable lineage fails closed.** If no delegating parent can be found and the child
is not manager-owned, the plugin cannot prove inheritance: it **respects the child's own
route** and records `lineage unresolved (child route respected)`. If you want the role
route applied no matter what, use `managed`.

All comparisons are by value. A `round-robin` advance is committed **only when a route is
actually applied**: `advisory` passes, a respected explicit route, and a respected
unresolved-lineage route all leave the rotation where it was.

### Label-driven classification

Only a session whose `session.header.origin` is `'subagent'` is classified by label. The
label is the `description` the delegating agent passed to the `subagent` tool, which the
harness stores as the child's label. Matching is case-insensitive and anchored at a
leading word boundary, in this order:

1. Empty label → `execution`.
2. Any `visionKeywords` match → `vision`.
3. Else any `planningKeywords` match → `planning`.
4. Else `execution`.

Vision is tested before planning, so a label that matches both lands on `vision`.

| Delegation `description` | Matched by | Role | Applied route (bundled defaults) |
| --- | --- | --- | --- |
| `"plan: design the migration"` | `plan`, `design` | `planning` | `pku-corpus/qwen3.8-max-0902` |
| `"vision: read this screenshot"` | `vision`, `screenshot` | `vision` | falls back to `execution` → `pku-corpus/qwen3.8-flash` |
| `"fix the typo"` | nothing | `execution` | `pku-corpus/qwen3.8-flash` |
| `"analyze the parser design"` | `analyze`, `design` | `planning` | `pku-corpus/qwen3.8-max-0902` |
| `"summarize the changelog"` | nothing | `execution` | `pku-corpus/qwen3.8-flash` |

A non-subagent session is never classified by label: it gets `planning` while plan mode
is active and `main` otherwise.

### The vision → execution fallback

If `vision.models` is empty when a vision request is routed, the plugin serves it from the
execution role's models instead. The role recorded for that request is still `vision`;
the model is the execution role's, and `execution`'s `pick` strategy and `round-robin`
counter are the ones used. The `routes` table marks such a role `(via execution)`. If
`execution` is empty as well, there is no route and the request passes through. This is
why the bundled default (`vision: []`) is safe: vision work is served by the execution
tier until you configure a dedicated vision model.

### Vision image capability check

A text-only model cannot serve image work: the harness rejects image blocks on requests to
a model that does not declare image input. Because the vision role has a fallback and can
name any provider, `routes` verifies the models it will actually use, through
`ctx.get('llm')` → `resolveModelInfo(provider, model)` → `inputModalities`. The check
follows the **effective** vision route, so with the bundled default it audits the execution
model the fallback would use.

| Verdict | Condition | Detail text |
| --- | --- | --- |
| `ok` | `inputModalities` includes `image` | `accepts images` |
| `NO IMAGES` | `inputModalities` present without `image` | `declares <modalities> — image work routed here will fail` |
| `unknown` | no `inputModalities` on the resolved info (absent means unknown) | `image support not declared` |
| `unresolved` | `resolveModelInfo` threw | `could not resolve (<error message>)` |

```text
Vision role (image capability):
  ok         pku-corpus/kimi-k3 — accepts images
  NO IMAGES  pku-corpus/qwen3.8-flash — declares text — image work routed here will fail
  unknown    pku-corpus/mystery — image support not declared
  unresolved pku-corpus/broken — could not resolve (no adapter registered for provider "pku-corpus")
```

The check reports three distinct states on purpose, and they are never conflated.

**Checked** — the block above. With the bundled default (no dedicated vision model) it
audits the execution model the fallback would use:

```text
Vision role (image capability):
  NO IMAGES  pku-corpus/qwen3.8-flash — declares text — image work routed here will fail
```

**Nothing to check** — no effective vision route, i.e. `vision` *and* `execution` are both
empty. Image-labelled children then keep their parent's route:

```text
Vision role: no route configured, so image-labelled delegations have no dedicated model
  and will simply inherit the delegating parent's route.
```

**Not checked** — no `llm` service in this composition:

```text
Vision role: not checked (no llm service in this composition).
```

At boot the plugin runs the same check once and warns only for the `NO IMAGES` case, since
that is the one that fails at run time:

```text
warn  [model-manager] vision role route(s) declare no image input and image work routed to them will fail: pku-corpus/qwen3.8-flash. Point roles.vision.models at an image-capable model.
```

`unknown` and `unresolved` are reported by `routes` but not warned about: a model with
undeclared modalities may well accept images, and an unresolvable route is already reported
by the allow-list audit.

## Configuration

Config is the `config` of the row id `model-manager`. This bundle ships a layer that
inserts it; a profile can override it by id, and the harness also presents it on the
Settings page — `roles` and `strategy` are declared `volatile`, so the form is
auto-generated from the schema and a saved edit is committed in place without a remount. The
[card on the Plugins page](#configure-in-the-ui) writes the same paths into the same
namespace, so the YAML below and the card are two views of one config; the patch remains the
declarative copy that ships with the package.

**Saved Settings edits apply live.** The loader commits a volatile-only save and returns
*before* re-running `apply`, so the plugin listens on `loader/volatile-update` and
re-reads the config itself — including rebuilding the keyword matchers. A keyword or role
change saved on the Settings page — or from the [card on the Plugins
page](#configure-in-the-ui), which writes the same volatile namespace — takes effect on the
next request, with no restart. The
event logs `settings reloaded — mode …` on success; a value that cannot be re-read logs
`could not reload settings; routing keeps the previous config: …` and the previously
active config stays in force.

Complete key set, with the schema defaults shown in comments:

```yaml
- id: model-manager
  config:
    roles:
      main:
        models: []            # default: [] — empty means "leave the composer/model selection alone"
        pick: first           # default: first; "first" | "round-robin"
        note: ''              # default: none — optional free text, printed by `routes` under the role
      planning:
        models: []            # schema default: [] (this package's own layer sets pku-corpus/qwen3.8-max-0902)
        pick: first
      execution:
        models: []            # schema default: [] (this package's own layer sets pku-corpus/qwen3.8-flash)
        pick: first
      vision:
        models: []            # schema default: [] — empty falls back to the execution role
        pick: first
    strategy:
      mode: hybrid            # default: hybrid; "hybrid" | "managed" | "advisory"
      # visionKeywords: omitted = the 20 built-ins; any list you write replaces them
      # planningKeywords: omitted = the 24 built-ins; [] DISABLES that classifier
      historyLimit: 300       # default: 300; any positive value floors to at least 1
```

The two keyword lists are shown commented out because their default is the built-in list
rather than a literal value: omitting the key keeps the built-ins, while writing any list —
including `[]` — replaces them, and `[]` switches that classifier off entirely.

Each entry of `models` is:

| Key | Required | Default | Meaning |
| --- | --- | --- | --- |
| `provider` | yes | — | Provider id, e.g. `pku-corpus`. |
| `model` | yes | — | Model id, e.g. `qwen3.8-flash`. |
| `reasoningEffort` | no | none | Applied as the route's reasoning effort when the manager writes the route. |

Behaviours of `readConfig` worth knowing:

- A route missing `provider` or `model` is dropped rather than failing the plugin. A role
  whose every route is invalid behaves exactly like an empty role.
- Unknown keys are reported rather than ignored, at three levels: the row, a role, and an
  individual route. A route written with the snake_case alias is called out by name —
  `unknown key "roles.planning.models[].reasoning_effort" ignored — the key is
  "reasoningEffort"`.
- `historyLimit` accepts any positive number, floored to an integer and raised to a
  minimum of 1, so a fractional value cannot floor to 0 and silently disable usage
  tracking. `0`, a negative number, a non-number or an absent key all mean 300.
- When the manager switches a request to a different route it **drops an inherited
  reasoning effort** unless the role names one, because the destination model may not
  accept the previous effort and `prepareCall` rejects unsupported explicit efforts
  instead of clamping them.

> A profile patch entry with an `id` and no `insert` replaces the target row's fields,
> and `config` is **replaced wholesale, never deep-merged**. An override that sets only
> `strategy.mode` therefore also drops every role route. Restate every key you want to
> keep.

The bundled layer this package ships is:

```yaml
- insert:
    - id: model-manager
      name: '@jyshangguan/dsh-model-manager'
      config:
        roles:
          main:
            models: []
          planning:
            models:
              - provider: pku-corpus
                model: qwen3.8-max-0902
          execution:
            models:
              - provider: pku-corpus
                model: qwen3.8-flash
          vision:
            models: []
        strategy:
          mode: hybrid
```

## Seeing which model each subagent used

### First: the harness already shows this per Turn

Before reaching for the tool, note that the Web UI already attributes each completed Turn to
the exact provider/model that served it. On every completed Turn's footer there is a button
labelled **用量 {total}** ("Usage {total}", with a database icon); clicking it opens the
**本轮用量** ("Turn usage") dialog, whose rows are Uncached input, Output (with its reasoning
subset), Cached input, Cache write, Cache hit, and **Provider / model**.

Two conditions decide whether it appears:

- **Settings → General → Performance & usage** must be `detailed`, not `compact`. `detailed`
  is the default. `compact` hides per-Turn usage entirely.
- Accounting is deliberately all-or-nothing. A Turn discloses usage only when the loaded
  window includes `turn/start` and **every** started model attempt reported safe, exact
  usage. The harness hides a partial total rather than showing a misleading one.

That second rule interacts with this plugin's failover, and it is worth understanding before
filing it as a bug: a failed attempt settles as an `assistant/attempt` event, which carries no
token usage unless its stream reported some. `deriveTurnTokenUsage` then marks the whole Turn
invalid and discloses nothing. So **on a Turn where a model failed and the manager switched to
another, the usage row will be absent** — the accounting genuinely cannot prove an exact total
for that Turn. This is the harness's own rule and it applies equally to the harness's built-in
retries; failover simply produces such Turns more often.

There is no per-model **aggregate for one whole session** in the harness itself: its session-level
projections (`tokenUsage`, `contextPressure`, `contextBreakdown`) accumulate four token buckets with
no route split. This plugin supplies exactly that, as a **Model usage** button in the session header.

It is a session projection folded from the durable log (`modelManagerUsage`), not a live counter, so
the numbers survive a restart and are identical after fork, resume, and replay. Each row shows
provider/model, uncached input, output, cached input and cache write when reported, request count,
and a total. Only attempts carrying an exact usage sample **and** a provider/model on the committed
message are counted — the same refusal the per-Turn dialog makes, so the two never disagree about
which numbers are provable.

Because the host half declares the projection and wires a view, the client half only subscribes to a
finished value: no folding in the browser, no polling, no fetch route. That is the sanctioned path —
*"a domain ships projection support with zero client code."*

### The tool

The plugin registers one read-only tool, `model_manager`, with four actions:

| Action | Returns |
| --- | --- |
| `report` (default) | A `Top-level agents` table — session id, role, model, reason, live status, and whether the session's model was picked by hand or left at the deployment default — then the per-subagent table: child id, role, model, reason, live status, delegation label, and finally the active mode with subagent-only totals by role/model. |
| `routes` | Role table (role, `pick`, effective models, role `note`), active mode, allow-list audit with a YAML snippet for unlisted routes, the vision image-capability check, and the first 8 keywords of each list. |
| `usage` | Request and subagent counts per role/model across the whole process, including top-level turns. |
| `client` | Whether the Host composed this package's Web client half into the browser boot graph, the route serving its bundle, and the current graph revision. Use it when the settings card does not appear. |

Both `report` and `usage` read **process-local in-memory state**: they answer for the current
`dsh` process only, and a restart clears them. A subagent that finished before a restart
therefore reappears as `(not yet routed)` with role `?`, because it was re-registered on resume
but issued no request in this process. For history that survives a restart, use the per-Turn
usage dialog described above — it is derived from the durable session log.

Asking for the report:

```text
model_manager(action: "report")
```

Sample output, generated by running the real renderer against a mock harness instead of typed by
hand — a hand-typed example is exactly how this file shipped a misaligned table. The `session` and
`child` columns hold 10-character id prefixes:

```text
Top-level agents — 1

session      role       model                            reason                                       status    the session model was
-----------  ---------  -------------------------------  -------------------------------------------  --------  --------------------------------
a1b2c3d4-e  main       user-picked/glm-5.2              explicit session selection (respected)       running   picked by hand, so main yields

A reason ending in (respected) is the verdict itself: a human choice won and the
manager stepped back. Under managed it never does, and a session that never had
a manual pick is rewritten by the main role.

Subagent model report — 3 subagent(s)

child       role       model                            reason                                       status    label
----------  ---------  -------------------------------  -------------------------------------------  --------  --------------------
7c1f0a92-a  planning   pku-corpus/qwen3.8-max-0902      applied                                      running   "plan: design the migration"
925d4c6e-a  execution  pku-corpus/deepseek-v4-flash-0731  applied                                      running   "fix the typo"
e0c7b551-a  vision     pku-corpus/kimi-k3               applied                                      running   "vision: read this screenshot"

mode: hybrid

Subagent requests by role/model:
     1 req /  1 subagent(s)  execution  pku-corpus/deepseek-v4-flash-0731
     1 req /  1 subagent(s)  planning  pku-corpus/qwen3.8-max-0902
     1 req /  1 subagent(s)  vision  pku-corpus/kimi-k3
```

Reading it:

- `e0c7b551-e` is a `vision` row served by the first vision model; with `vision: []` it
  would show the execution model instead. Role and model are reported independently.
- `925d4c6e-d` was dispatched with an explicit route, so `hybrid` left it alone.
- `b84e2d10-b` issued two requests. The first was routed by the manager; on the second the
  child's own header already carried the applied route, so it reads
  `applied (manager-owned)` rather than being mistaken for an explicit choice. Hence the
  planning total of `3 req / 2 subagent(s)`.
- `0a1b2c3d-f` has no resolvable delegating parent and no manager-applied route, so
  `hybrid` failed closed: the child kept the route it was given, and with it no label the
  catalog could resolve.
- The totals are **subagent-only**, so the top-level turn this parent made is not counted
  here. `usage` is the action that covers the whole process.

The `status` column is the child's live status as the harness reports it (`running`,
`idle`, …), `live` when the harness exposes the agent without a status, and `inactive`
when `agents.get` cannot resolve the child — for example after it has gone away.

The `reason` column is the outcome for that request:

| Reason | Meaning |
| --- | --- |
| `applied` | The role route was written into the request. |
| `applied (manager-owned)` | The child's route matched what the manager last applied to it, so it stayed under management and the role route was written again. |
| `explicit session selection (respected)` | `hybrid`, top-level: the session log carries a `model/selection` event, so the model running is one a person chose in the composer. `main` is skipped and the rotation is not advanced. |
| `explicit child route (respected)` | `hybrid` found the child's resolved route differed from the parent's effective route, so it was treated as the delegating agent's own choice and left alone. |
| `lineage unresolved (child route respected)` | No delegating parent could be resolved and the child was not manager-owned, so inheritance was not provable and the child kept its route. |
| `advisory (not applied)` | `advisory` mode classified the request but changed nothing; the model shown is the one actually used. |
| `passthrough (role unconfigured)` | The role resolved to no route at all, so the request was returned unchanged. |

Verbatim example rows for the two reasons not shown above:

```text
99aa11bb-0  execution  pku-corpus/qwen3.8-max           advisory (not applied)            running   "fix the typo"
4d5e6f70-0  execution  pku-corpus/qwen3.8-max           passthrough (role unconfigured)   running   "fix the typo in README"
```

A subagent the catalog knows about but which has not issued a request yet shows
`(not yet routed)` in the model column and `-` as its reason. Labels are collapsed to a
single line, truncated at 42 characters, and any `"` in them is displayed as `'` so the
column can never be misread.

`usage` counts every request the process recorded, including top-level turns — its header
says so, and a top-level bucket shows `0 subagent(s)`:

```text
Requests by role/model (whole process, including top-level turns)

     1 req    1 subagent(s)  execution  pku-corpus/deepseek-v4-flash-0731
     1 req    1 subagent(s)  execution  pku-corpus/qwen3.8-flash
     1 req    1 subagent(s)  execution  pku-corpus/qwen3.8-max
     1 req    0 subagent(s)  main  pku-corpus/qwen3.8-max
     3 req    2 subagent(s)  planning  pku-corpus/qwen3.8-max-0902
     1 req    1 subagent(s)  vision  pku-corpus/kimi-k3
```

## The allow-list gotcha

The profile's `subagent-model-selection-settings` row (`.allowedModels`) constrains what
an agent may **name**. `assertAllowedModelSelection` in the subagent tool returns early
when the delegation call names no `provider`, `model` or `reasoning_effort`, so:

- **Role routing is not blocked by the allow-list.** The manager rewrites *inherited*
  delegations at request time, and an inherited delegation names nothing, so a route
  outside the list still serves it.
- What the list does affect: an agent that **explicitly** names a route outside it is
  refused at delegation time with an error of the form
  `child LLM route "pku-corpus/qwen3.8-max-0902" is not allowed for this Session`, and that
  route is absent from what `list_subagent_models` advertises — so the model is invisible
  to agents even while the manager uses it.

Two further properties matter in practice:

- The list is sampled per Session when the session receives its delegation tools, so a
  session started before you edited it keeps the old list until the session is recreated.
- With `enabled: false`, no subagent can select a model at all. `routes` says so
  explicitly when it detects that state.

The plugin cannot fix the list for you. Inserting a second `subagent-model-selection-settings`
row would abort startup with `duplicate loader entry id`, so the plugin only reads it. If
any role's **effective** route is unlisted — including a `vision` → `execution` fallback —
it logs a warning at boot naming the routes, and `routes` renders the audit plus the exact
YAML to add. Unlisted routes are de-duplicated, one snippet entry each:

```text
model_manager(action: "routes")
```

```text
Model manager roles

Role          pick          effective model(s)
------------  ------------  ------------------------------------------
main          first         (unconfigured — passes through)
planning      first         pku-corpus/qwen3.8-max-0902
                            note: use for architecture and migration design
execution     first         pku-corpus/qwen3.8-flash
vision        first         pku-corpus/kimi-k3, pku-corpus/qwen3.8-flash, pku-corpus/mystery, pku-corpus/broken

Strategy mode: hybrid (apply when the child inherited the parent route)

Allow-list: enabled, 4 route(s) currently dispatchable
  allowed   planning   pku-corpus/qwen3.8-max-0902
  allowed   execution  pku-corpus/qwen3.8-flash
  allowed   vision     pku-corpus/kimi-k3
  allowed   vision     pku-corpus/qwen3.8-flash
  BLOCKED   vision     pku-corpus/mystery
  BLOCKED   vision     pku-corpus/broken

2 role route(s) are not in the subagent allow-list.
This does NOT block role routing: the harness gates only *explicit* model-facing
choices, and the manager routes pure-inheritance delegations at request time. What
it does affect: an agent that names one of these routes explicitly will be refused,
and the route will not appear in `list_subagent_models`. Add them to
`subagent-model-selection-settings` (`.allowedModels`) — in the profile patch, or on
the Subagent settings page — to make them selectable:

      - provider: pku-corpus
        model: mystery
      - provider: pku-corpus
        model: broken

Vision role (image capability):
  ok         pku-corpus/kimi-k3 — accepts images
  NO IMAGES  pku-corpus/qwen3.8-flash — declares text — image work routed here will fail
  unknown    pku-corpus/mystery — image support not declared
  unresolved pku-corpus/broken — could not resolve (no adapter registered for provider "pku-corpus")

Delegation labels select the tier. The `description` you pass to a delegation
becomes the child label, which the manager matches against (word-anchored):
  vision   : vision, visual, image, images, screenshot, screen shot, ocr, figure, …
  planning : plan, planning, design, architect, architecture, analyse, analyze, analysis, …
  else     : execution
```

When nothing is missing the audit says so, and the role table marks a fallback
`(via execution)` while the audit row is labelled with the role that uses it:

```text
Allow-list: enabled, 2 route(s) currently dispatchable
  allowed   planning   pku-corpus/qwen3.8-max-0902
  allowed   execution  pku-corpus/qwen3.8-flash
  allowed   vision     pku-corpus/qwen3.8-flash
  All role routes are allow-listed.
```

To add a route, paste the snippet under `allowedModels:` in the profile patch, restating
the whole config because an id override replaces `config` wholesale:

```yaml
- id: subagent-model-selection-settings
  config:
    enabled: true
    allowedModels:
      - provider: pku-corpus
        model: qwen3.8-flash
      - provider: pku-corpus
        model: qwen3.8-max-0902   # a route the audit reported
      - provider: pku-corpus
        model: deepseek-v4-flash-0731
```

### When the audit cannot read the list

`routes` distinguishes three outcomes, because they call for different fixes.

**No such service** in this composition — a missing feature, not a mistake:

```text
Allow-list: unavailable (no subagent model-selection settings service in this composition).
```

**Model selection is disabled** — subagents cannot choose a model at all:

```text
Allow-list: model selection is DISABLED — subagents cannot select a model at all.
```

**The settings owner refused to report** — a configuration error, not a missing feature.
Its `current()` throws when selection is enabled with an empty `allowedModels`, which is a
broken deployment that every delegation would hit:

```text
Allow-list: the subagent model-selection settings refused to report its routes:
  enabled subagent model selection requires at least one allowed model
Fix `subagent-model-selection-settings` in the profile patch (an enabled policy needs a
non-empty `allowedModels`), then reload.
```

The same refusal is logged at boot as
`subagent model-selection settings refused to report its routes: <error>`, so it is not
mistaken for a normal "no routes listed" state.

## Tuning the classification

`strategy.visionKeywords` and `strategy.planningKeywords` are the whole classification
policy.

- **An absent key uses the built-ins. An explicit `[]` disables that classifier.** That
  is the only way to switch one off: `visionKeywords: []` sends every vision word to the
  planning and execution tests instead. Treat a disabled classifier as intentional —
  with `planning: []` the planning role becomes unreachable for subagents, and with
  `vision: []` no subagent is ever classified `vision`.
- **Matching is case-insensitive and anchored at a leading word boundary.** A keyword must
  begin at the start of a word, so `spec` no longer matches `"inspect"` and `design` no
  longer matches `"redesign"`, while `screenshot` still matches `"screenshots"` and the
  multi-word `ui mock` still matches. It is not a full-word match, so `plan` still matches
  `"planet"` and `render` still matches `"rendering"`. Prefer distinctive words.
- Vision is tested before planning, so a label matching both goes to vision.
- Regex metacharacters in a keyword are escaped, so `pkg.io` or `a+b` match literally.
- The matchers are rebuilt on a saved Settings edit, so a keyword change applies live.

The built-in lists, used when a keyword list is absent:

```text
vision   (20): vision, visual, image, images, screenshot, screen shot, ocr, figure,
               diagram, chart, plot, photo, picture, png, jpg, jpeg, webp, gif,
               ui mock, render
planning (24): plan, planning, design, architect, architecture, analyse, analyze,
               analysis, research, investigate, review, critique, strategy, reasoning,
               reason, compare, evaluate, assess, spec, specification, decompose,
               breakdown, proposal, root cause
```

`routes` prints the first 8 entries of each list, appending `…` only when there are more,
and prints `(disabled)` for an explicitly emptied list:

```text
Delegation labels select the tier. The `description` you pass to a delegation
becomes the child label, which the manager matches against (word-anchored):
  vision   : vision, visual, image, images, screenshot, screen shot, ocr, figure, …
  planning : (disabled)
  else     : execution
```

Replace a list with the keywords you want, remembering that a patch override replaces
`config` wholesale:

```yaml
- id: model-manager
  config:
    roles:
      planning:
        models:
          - provider: pku-corpus
            model: qwen3.8-max-0902
      execution:
        models:
          - provider: pku-corpus
            model: qwen3.8-flash
    strategy:
      mode: hybrid
      planningKeywords:       # replaces the 24 built-ins entirely
        - plan
        - design
        - audit
        - benchmark
      visionKeywords: []      # disables the vision classifier
```

The plugin also contributes a system-prompt section (name `model-manager`, order 60) that
tells the delegating agent to start a delegation description with `plan:` for reasoning
work, `vision:` for image work, or leave it plain for execution, and lists each role's
effective models (including a fallback). It is empty text when no role has any models, so
the prompt is not padded with a description of routing that does nothing.

## How it stays safe

Both halves obey the same rule: neither may be able to break the harness it is loaded into.
A host `apply` that throws fails the loader entry and therefore startup, and a client
component that throws blanks its whole slot entry, so every risky path is probed and
degrades to a notice or a log line.

- **Its own schema dependency cannot fail startup.** `@deepseek-ai/schemastery` is loaded
  through a guarded dynamic import and the schema is built inside a guard. If the
  dependency is missing *or incompatible* (a version whose `.default()` / `.volatile()`
  chain differs), the plugin still loads and still routes: `Config` is left undefined, so
  cordis's `resolveConfig` passes the raw config straight through and `readConfig`
  normalizes it defensively. Only schema validation and the auto-generated Settings page
  are skipped.
- **No settings API.** `settings.installSection` / `installSettingsSection` /
  `settingsNamespace` were removed in DSH 0.1.7, and calling them fails `apply`, which
  fails the loader entry and therefore startup. The host half never touches that API: it
  exports a volatile `Config` and lets the harness auto-generate the Settings form
  (`autoGenerate` defaults to true). It claims no settings namespace either — and neither
  does the client half, which writes the row's *existing* namespace through the `form` the
  plugins page hands it, so the card cannot register a second store or race the host.
- **The host half imports nothing but its own schema dependency.** It does not import
  `@deepseek-ai/dsh-tools`, `dsh-llm` or `cordis`, which are not resolvable from a
  profile-installed plugin; the tool is registered in the normalized shape the registry
  expects, using plain JSON Schema, and the `llm` service is reached through
  `ctx.get('llm')` rather than an import.
- **The client half requires one module: `react`.** Harness Client packages — including
  `@deepseek-ai/dsh-client-ui-primitives` — are not `require`d from a hand-written client
  half, so the controls are local and styled with `--dsw-alias-*` tokens only. Its
  collaborators (`slots`, `locale`, `remote`) arrive as injected services, and each use of
  them sits inside a `safely(label, fn)` wrapper that logs
  `[model-manager] <step>: <message>` and continues: a missing locale seat, a failed
  catalog fetch, a rejected subscription or an absent slot registry leaves the card
  unreadable, never fatal. Every value read from the host is re-narrowed before use
  (`isObject` guards on `form.state.value`, `roles`, each catalog group and route), so a
  shape change degrades to "unset" rather than a render error.
- **Every optional integration is probed and wrapped.** Plan mode, the agent list and
  lineage, the parent's request header, subagent listing, the allow-list service, the
  model-capability lookup, `tools` and `systemPrompt` are each reached through a guarded
  accessor and a `try`/`catch`; a missing service means that feature is inert, not that the
  plugin fails. The `agent/request` handler catches its own errors, logs one warning
  (`routing skipped for one request: …`) and returns the request it was given, unchanged.
- **`apply` never throws.** The whole body sits behind a backstop that logs
  `failed to initialise; model routing is disabled: …` and returns, so a misconfiguration
  degrades routing instead of preventing the harness from booting. Malformed configs
  (`roles: "not-an-object"`, `strategy: null`, an unknown mode, a negative `historyLimit`,
  routes with empty ids) all apply cleanly; bad routes are filtered out and the mode falls
  back to `hybrid`.
- **A bad live edit cannot break a running router.** The `loader/volatile-update` handler
  is wrapped: a config it cannot re-read logs
  `could not reload settings; routing keeps the previous config: …` and the previous
  config stays in force. The boot capability check is an async probe with its own catch, so
  a slow or failing `llm` service cannot disturb startup.
- **Typos are reported, not silently ignored.** Schemastery does not reject unknown keys,
  so `readConfig` returns a `warnings` array and `apply` logs each entry at warn level:
  `unknown config key "bogus" ignored`, `unknown role "nope" ignored`,
  `unknown key "roles.planning.mispelled" ignored`, `unknown key "strategy.nope" ignored`,
  and the route-level form with its `reasoningEffort` hint.
- **The pure helpers are exported for testing:** `name`, `Config`, `apply` plus
  `readConfig`, `applyRoute`, `effectiveRouteOf` and the two default keyword lists.
- **It does not touch the subagent allow-list row**, precisely to avoid the duplicate
  loader entry id that would abort startup.
- **The `model_manager` tool is read-only.** Its description says so and the
  implementation only reads state.

## Testing

```bash
npm test
```

Runs eight suites in child processes and aggregates the result — **683 assertions** at the time
of writing. Each suite also runs on its own: `node test/<name>.test.mjs`.

| Suite | Assertions | What it pins |
| --- | --- | --- |
| `packaging.test.mjs` | 31 | The package identity that nothing else cross-checks: the scoped name is the one string the bundle patch's loader row, the client half's module id and the host half's `PACKAGE_NAME` must all agree on, while the cordis row id, the client row namespace and the locale namespace must all *stay* unscoped. Plus publishability (not private, public access, a real `@deepseek-ai/dsh` version gate, schemastery still optional) and tarball completeness — every `exports` target and every `files` pattern resolved against disk, so a published package cannot mount-less. The gate is not string-matched: a self-validating semver comparator (prerelease-aware, and checked against the ordering trap first) proves the declared range admits 0.1.7-rc.2, 0.2.0-rc.2 **and** 0.2.0 while refusing 0.1.6 and 0.3.0 — because `<0.2.0` reads as "every 0.2.0 prerelease" while excluding 0.2.0 itself. Each identity assertion was mutation-checked: breaking any one of the four name sites, or "tidying" the row id or locale namespace to match, fails exactly one assertion; reverting the upper bound to `<0.2.0` fails exactly two. |
| `routing.test.mjs` | 9 | The four roles route as documented; label classification; an explicit child route is respected; the tool and system-prompt section register; `apply` survives malformed configs. |
| `edge.test.mjs` | 503 | Hostile configs, keyword anchoring and trimming, explicit-`[]`-disables versus absent-uses-defaults, round-robin committing only on apply, LRU eviction, the manager-owned rule, volatile settings reload, every `reason` string, the report/usage/routes output, and the generated allow-list YAML round-tripped through the **real** harness validator. |
| `failover.test.mjs` | 24 | The failover chain and every guard: it walks to the end of the list and then stops rather than wrapping; `ABORTED`, `INVALID_REQUEST` and `IMAGE_OFFLOAD_REQUIRED` never fail over; a downstream recovery decision is passed through untouched; the per-step cap holds and resets on a new step; `round-robin` does wrap; single-model and disabled roles do nothing; a route outside the role's list is left alone; hostile payloads never throw; subagent chains fail over too. |
| `client-structure.test.mjs` | 32 | The client half loads through `window.__ModuleLoader__`, requires **only** `react`, exports `{ inject, apply }`, registers its locale dictionaries and exactly two surfaces, and — because the check mirrors the real `SlotCore.register` validation — fails if a registration ever loses its `name`. It also declares each `remote.<namespace>` used must appear in `inject`, drives the settings-form bindings, and renders the usage surface against a stubbed projection face in both its collapsed and expanded states, with an empty-projection case proving those render assertions are not vacuous. |
| `client-diagnostic.test.mjs` | 17 | Every branch of `model_manager` with `action: "client"`, including the two that matter most: a bundle the Host will not serve, and a bundle that serves but registers the wrong id. |
| `usage-projection.test.mjs` | 42 | The per-session model-usage fold: bucket sums against the harness's own field names, refusal of unsafe or fractional counts without aborting the fold, usage recovered from an embedded stream, separate attribution per provider/model, immutable state transitions, reference stability that suppresses republishing, and both schemas rejecting junk through the only method cordis calls (`.parse`). |
| `explicit-selection.test.mjs` | 25 | The rule that `main` yields to a hand-picked session model, and nothing else does: respected under `hybrid`, still applied under `managed`, untouched by a respected call in the round-robin rotation, and falling back to the old rewriting behaviour when the projection service is absent, when `stateOf` throws, or when the key was never registered. A disabled manager is checked too. Plus the `Top-level agents` report table: the hand-picked versus default-driven verdict, no orphaned subagent header when no subagent exists, a row that outlives its agent degrading to `unknown, agent no longer live`, and — read back out of the renderer's own source — proof that the reason column is still padded past the longest reason string it can print. |

The suites are plain Node scripts — no test framework, and no dependency beyond Node itself.

Two of them optionally pin their expectations against the **real** harness internals rather
than a transcription of them: `dsh-subagent`'s `resolveChildAgentOptions` (what a delegated
child actually inherits) and `SubagentModelSelectionConfig.current` (the allow-list gate that
rejects a repeated route). `test/paths.mjs` discovers the DSH installation from the `dsh`
executable on `PATH`, or from `DSH_INSTALL_DIR` if you set it. When neither resolves, those
assertions fall back to a local re-implementation and print a `WARN` — the suite still passes,
but it is then testing my model of the harness rather than the harness, so prefer running it
where `dsh` is installed.

Nothing in the suite touches the network, a profile, or a running harness, and nothing writes
outside the repository.

## Limitations

- **Classification is label-driven, not content-driven.** At `agent/request` time the
  plugin has no supported way to read a child's message blocks, so it matches the child's
  delegation label and nothing else. Image detection is therefore label-based: a
  delegation about an image whose `description` contains no vision keyword is classified
  `execution`.
- **Leading-boundary matching still matches word prefixes** (`plan` in `"planet"`,
  `render` in `"rendering"`), and the first match wins with vision tested before planning.
  Two classifier lists cannot express precedence beyond that.
- **`hybrid` compares routes by value.** A child that deliberately names the same route as
  the parent's effective route is indistinguishable from one that inherited it, and will
  be rewritten to the role route.
- **Under `hybrid`, an unresolved lineage means the child keeps its own route.** The
  manager will not touch a delegation whose inheritance it cannot prove; if you want
  routing regardless of lineage, use `managed`. The report shows
  `lineage unresolved (child route respected)` for those requests, so a broken lineage
  integration is visible rather than silent — but it does also mean a child that should
  have been managed was not.
- **Manager-ownership is sticky.** Once a route has been applied to a child, that child
  keeps being managed as long as its route matches the applied one, even after its parent
  is gone. If a child legitimately changes its own model to one the parent also uses, the
  manager takes it back.
- **`round-robin` is per-process and per-role.** Counters live in an in-memory `Map` and
  reset to index 0 on restart. A role with a single model never advances, and an advance is
  committed only when a route is applied, so `advisory` passes and both kinds of respected
  route do not rotate. Routing happens per LLM request, not per turn, so a `round-robin`
  role can still rotate models between the steps of one turn.
- **Usage history is in-process.** A `Map` capped at `strategy.historyLimit` (300),
  evicted least-recently-used: an active subagent stays, an idle one goes first. Nothing is
  persisted, so after a restart `report` and `usage` start empty.
- **`report` lists top-level rows but its totals stay subagent-only.** The `Top-level agents`
  table covers every session this process saw a request for, top-level or not; the
  `Subagent requests by role/model:` block beneath it counts subagents only. `usage` counts the
  whole process, including top-level `main`/`planning` turns (shown as `0 subagent(s)`). So the
  two tables inside `report` answer for different populations, and neither one matches `usage`.
- **The `status` column needs the live agent list.** It is the status the harness reports,
  `live` when a live agent exposes no status, and `inactive` when `agents.get` cannot
  resolve the child. If the `agents` service is unavailable or has no `get`, every row
  reads `inactive` whether or not the subagent is alive.
- **The image-capability check covers only the vision role's effective models.** A planning
  or execution child handed an image is not checked, `unknown` and `unresolved` verdicts are
  reported but never warned about at boot, and with the bundled default (`vision: []`) the
  check audits the execution fallback rather than a dedicated vision model.
- **The allow-list audit is informational for routing.** Since the harness gates only
  explicit choices, a `BLOCKED` row does not mean role routing failed — it means agents
  cannot name that route and `list_subagent_models` will not show it.
- **The `child` column is a 10-character id prefix**, so two session ids sharing their
  first 10 characters are indistinguishable in the table.
- **Labels are flattened for display.** Newlines collapse to spaces, the text is truncated
  at 42 characters with `…`, and `"` becomes `'`.
- **`roles.<role>.note` affects only the `routes` table.** It is human annotation; no
  routing decision, report or count reads it, and the boot log does not print it.
- **`main` empty is the simplest policy, and now not the only one.** With `main: []` a
  top-level turn outside plan mode is never rewritten. With `main` configured under
  `hybrid`, a session whose model was picked by hand keeps it (see "`main` and the composer's
  model picker") and only untouched sessions are rewritten; under `managed` every top-level
  request is rewritten, chosen by hand or not.
- **The card can only pick what the catalog advertises.** A route the catalog stopped returning keeps its row and stays editable, labelled `(not advertised)`, but you cannot add such a route — or any model absent from the catalog — from the UI. Provider and model are never free text here, so a typo cannot be written into the config; use the patch layer for a route the host does not advertise.
- **The card has no image-capability information.** `session/modelCatalog` exposes ids,
  names and reasoning efforts, not modalities, so nothing in the UI stops you picking a
  text-only model for `vision`; the host half's `routes` audit is the check.
- **A stored effort can be invisible.** Picking a different model keeps the route's previous
  `reasoningEffort`, and the effort picker only renders when the newly selected model
  advertises efforts — so a stale effort can remain in the config with no control to clear
  it. Remove it in the patch layer.
- **The card lives in exactly one place: 设置.** It registers `settings.section` under
  `model-manager`, and nothing on the Plugins page — `plugins.item` and `plugins.row.config` are
  deliberately not registered, so there is one copy of these values and one place to edit them.
  The second surface, `conversation.session.header.utilities` under `model-manager-usage`, is
  read-only: it shows the per-session model usage the host half folds from the durable log, and
  writes nothing.
- **The card needs one restart after installing**, because the client-module boot manifest
  caches package metadata per loader specifier until restart. Before that the Settings entry is
  simply absent.
