// The store front end.
//
// It never imports an app's code. It renders the catalog from the normalised
// index, and every app surface it shows is an iframe on that app's own origin,
// mounted through the host bridge with its own error boundary.

import { mountSurface } from '/sdk/host.js';

const main = document.getElementById('main');
const tabs = document.getElementById('tabs');
const who = document.getElementById('who');

const state = { user: null, workspaces: [], workspace: null, view: 'store', detail: null, opened: null };

// -- talking to the platform ------------------------------------------------

async function api(path, { method = 'GET', body } = {}) {
  const response = await fetch(path, {
    method,
    credentials: 'include',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const parsed = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(parsed?.error?.message ?? `Request failed (${response.status})`);
    error.status = response.status;
    error.detail = parsed?.error?.detail;
    throw error;
  }
  return parsed;
}

// -- rendering helpers ------------------------------------------------------

const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
};

const show = (...nodes) => main.replaceChildren(...nodes.flat().filter(Boolean));

function fail(error) {
  const detail = Array.isArray(error.detail) ? ` (${error.detail.join(', ')})` : '';
  return el('p', { className: 'error' }, error.message + detail);
}

function workspacePicker() {
  if (state.workspaces.length < 2) {
    return el('span', {}, state.workspace?.name ?? '');
  }
  const select = el('select', {
    'aria-label': 'Workspace',
    onchange: event => {
      state.workspace = state.workspaces.find(w => w.id === event.target.value);
      try { localStorage.setItem(REMEMBERED_WORKSPACE, state.workspace.id); } catch { /* ignore */ }
      render();
    },
  }, state.workspaces.map(w => el('option', { value: w.id, selected: w.id === state.workspace.id }, w.name)));
  return select;
}

// -- sign in ----------------------------------------------------------------

function signInView() {
  tabs.hidden = true;
  who.textContent = '';

  const error = el('p', { className: 'error' });
  const form = el('form', { className: 'auth' },
    el('input', { name: 'name', placeholder: 'Your name', autocomplete: 'name' }),
    el('input', { name: 'email', type: 'email', placeholder: 'Email', required: true, autocomplete: 'email' }),
    el('input', { name: 'password', type: 'password', placeholder: 'Password', required: true, autocomplete: 'current-password' }),
    el('input', { name: 'organizationName', placeholder: 'Business name (new accounts)' }),
    el('div', { className: 'actions' },
      el('button', { className: 'primary', type: 'submit' }, 'Sign in'),
      el('button', { className: 'ghost', type: 'button', onclick: () => submit(true) }, 'Create account')),
    error);

  async function submit(register) {
    error.textContent = '';
    const values = Object.fromEntries(new FormData(form));
    try {
      await api(register ? '/v1/auth/register' : '/v1/auth/sign-in', { method: 'POST', body: values });
      await boot();
    } catch (e) {
      error.textContent = e.message;
    }
  }
  form.onsubmit = event => { event.preventDefault(); submit(false); };

  show(
    el('h1', {}, 'One login, every app'),
    el('p', { className: 'lede' }, 'Sign in once. Everything you install afterwards is authorised from this session — no app ever sees it.'),
    form
  );
}

// -- store ------------------------------------------------------------------

async function storeView() {
  const { apps } = await api(`/v1/catalog/apps?workspace=${state.workspace.id}`);
  show(
    el('h1', {}, 'Store'),
    el('p', { className: 'lede' }, `Apps available to ${state.workspace.name}. Installing one adds it to this workspace only.`),
    apps.length
      ? el('div', { className: 'grid' }, apps.map(appCard))
      : el('p', { className: 'empty' }, 'No apps published yet. Publish one with npm run platform:demo.')
  );
}

const appCard = app => el('button', { className: 'card', onclick: () => go('detail', app.id) },
  el('span', { className: 'icon' }, app.icon ?? '▣'),
  el('span', { className: 'name' }, app.name),
  el('span', { className: 'sub' }, app.summary ?? ''),
  el('span', { className: 'meta' },
    el('span', { className: 'tag' }, app.publisher),
    el('span', { className: 'tag' }, app.pricing.model === 'free' ? 'Free' : `${app.pricing.amount} ${app.pricing.currency}`),
    app.surfaceKinds.map(kind => el('span', { className: 'tag' }, kind)),
    app.installed && el('span', { className: 'tag on' }, 'Installed'))
);

// -- app detail and install -------------------------------------------------

async function detailView(appId) {
  const app = await api(`/v1/catalog/apps/${appId}?workspace=${state.workspace.id}`);

  const surfaceBoxes = app.surfaces.map(surface => el('label', { className: 'check' },
    el('input', { type: 'checkbox', value: surface.surface_id, checked: true, name: 'surface' }),
    el('span', {},
      el('strong', {}, surface.title ?? surface.surface_id),
      el('div', { className: 'why' }, describeSurface(surface.kind)))));

  const permissionBoxes = app.permissions.map(permission => el('label',
    { className: permission.optional ? 'check' : 'check required' },
    el('input', {
      type: 'checkbox', value: permission.permission_id, name: 'permission',
      checked: true, disabled: !permission.optional,
    }),
    el('span', {},
      el('strong', {}, permission.title),
      permission.sensitive ? el('span', { className: 'tag warn' }, ' sensitive') : '',
      el('div', { className: 'why' }, permission.reason),
      el('div', { className: 'why' }, el('code', {}, permission.permission_id)))));

  const error = el('div', {});
  const install = el('button', { className: 'primary', onclick: doInstall }, `Install ${app.name}`);

  async function doInstall() {
    install.disabled = true;
    error.replaceChildren();
    try {
      await api(`/v1/workspaces/${state.workspace.id}/installations`, {
        method: 'POST',
        body: {
          appId: app.id,
          grants: checked('permission'),
          surfaces: checked('surface'),
        },
      });
      go('installed');
    } catch (e) {
      error.replaceChildren(fail(e));
      install.disabled = false;
    }
  }
  const checked = name => [...main.querySelectorAll(`input[name="${name}"]:checked`)].map(i => i.value);

  show(
    el('button', { className: 'ghost', onclick: () => go('store') }, '← Store'),
    el('h1', { style: 'margin-top:16px' }, `${app.icon ?? '▣'} ${app.name}`),
    el('p', { className: 'lede' }, app.description ?? app.summary ?? ''),
    el('div', { className: 'meta' },
      el('span', { className: 'tag' }, `v${app.version}`),
      el('span', { className: 'tag' }, `by ${app.publisher}`),
      el('span', { className: 'tag' }, `${app.runtime} runtime`),
      el('span', { className: 'tag' }, app.store)),

    app.installed
      ? el('p', { className: 'notice', style: 'margin-top:20px' }, 'Already installed in this workspace.')
      : [
          surfaceBoxes.length ? el('h2', {}, 'Where it may appear') : null,
          surfaceBoxes.length ? el('div', { className: 'stack' }, surfaceBoxes) : null,
          el('h2', {}, 'What it is asking for'),
          permissionBoxes.length
            ? el('div', { className: 'stack' }, permissionBoxes)
            : el('p', { className: 'empty' }, 'Nothing. This app only touches its own records.'),
          el('p', { className: 'notice', style: 'margin-top:14px' },
            'Required permissions cannot be unticked — the app does not run without them. Optional ones can be turned on later, and any of them revoked at any time.'),
          el('div', { className: 'actions' }, install),
          error,
        ]
  );
}

const describeSurface = kind => ({
  dashboard: 'A page inside your dashboard.',
  settings: 'A settings page for this app.',
  public: 'Can be placed on your customer-facing page.',
  widget: 'Embeddable elsewhere.',
  standalone: 'Its own URL.',
}[kind] ?? kind);

// -- installed apps ---------------------------------------------------------

async function installedView() {
  const { installations } = await api(`/v1/workspaces/${state.workspace.id}/installations`);
  if (!installations.length) {
    return show(el('h1', {}, 'My apps'), el('p', { className: 'empty' }, 'Nothing installed yet.'));
  }

  show(
    el('h1', {}, 'My apps'),
    el('p', { className: 'lede' }, 'Installed, enabled and published are three different things. So is deleting the records.'),
    el('div', { className: 'card' }, installations.map(installedRow))
  );
}

function installedRow(installation) {
  const openable = installation.surfaces.filter(s => s.kind === 'dashboard' && s.enabled);

  return el('div', { className: 'row' },
    el('span', { className: 'icon' }, installation.icon ?? '▣'),
    el('span', { className: 'grow' },
      el('div', {}, el('strong', {}, installation.name), ` v${installation.version}`),
      el('div', { className: 'sub' },
        `${installation.surfaces.length} surface${installation.surfaces.length === 1 ? '' : 's'} · ` +
        `${installation.permissions.length} permission${installation.permissions.length === 1 ? '' : 's'}`),
      el('div', { className: 'meta', style: 'margin-top:6px' },
        el('span', { className: installation.enabled ? 'tag on' : 'tag warn' }, installation.enabled ? 'enabled' : 'disabled'),
        installation.surfaces.some(s => s.published) && el('span', { className: 'tag on' }, 'on public page'),
        installation.updateAvailable && el('span', { className: 'tag warn' }, `update to ${installation.latest_version}`))),

    openable.length
      ? el('button', { className: 'ghost', onclick: () => go('open', `${installation.id}:${openable[0].surface_id}`) }, 'Open')
      : null,
    el('button', {
      className: 'ghost',
      onclick: async () => {
        await api(`/v1/workspaces/${state.workspace.id}/installations/${installation.id}/enabled`,
          { method: 'POST', body: { enabled: !installation.enabled } });
        installedView();
      },
    }, installation.enabled ? 'Disable' : 'Enable'),
    el('button', {
      className: 'ghost danger',
      onclick: async () => {
        const alsoData = confirm(
          `Uninstall ${installation.name}?\n\nOK removes the app and keeps its records.\nCancel to stop.`
        );
        if (!alsoData) return;
        const result = await api(`/v1/workspaces/${state.workspace.id}/installations/${installation.id}`, { method: 'DELETE' });
        alert(`Uninstalled. ${result.retainedRows} record(s) kept — reinstalling picks them back up.`);
        installedView();
      },
    }, 'Uninstall'));
}

// -- opening an app ---------------------------------------------------------

async function openView(target) {
  const [installationId, surfaceId] = target.split(':');
  const { installations } = await api(`/v1/workspaces/${state.workspace.id}/installations`);
  const installation = installations.find(i => i.id === installationId);

  const frame = el('div', { className: 'surface-frame' });
  show(
    el('button', { className: 'ghost', onclick: () => go('installed') }, '← My apps'),
    el('h1', { style: 'margin-top:16px' }, installation?.name ?? 'App'),
    el('p', { className: 'lede' },
      'This runs in an iframe on the app\'s own origin. It cannot read this page, and if it fails it fails alone.'),
    frame
  );

  state.opened?.destroy();
  state.opened = mountSurface(frame, {
    workspaceId: state.workspace.id,
    installationId, surfaceId,
    title: installation?.name ?? 'App',
    height: 560,
  });
}

// -- public page ------------------------------------------------------------

async function publicView() {
  const { installations } = await api(`/v1/workspaces/${state.workspace.id}/installations`);
  const publicSurfaces = installations.flatMap(installation =>
    installation.surfaces.filter(s => s.kind === 'public').map(s => ({ installation, surface: s })));

  show(
    el('h1', {}, 'Public page'),
    el('p', { className: 'lede' },
      `What a customer sees at /p/${state.workspace.slug}. Publishing a surface puts it on that page; it does not change the app's data.`),

    publicSurfaces.length
      ? el('div', { className: 'card' }, publicSurfaces.map(({ installation, surface }) =>
          el('div', { className: 'row' },
            el('span', { className: 'grow' },
              el('div', {}, el('strong', {}, surface.title ?? surface.surface_id)),
              el('div', { className: 'sub' }, installation.name)),
            el('button', {
              className: 'ghost',
              onclick: async () => {
                await api(
                  `/v1/workspaces/${state.workspace.id}/installations/${installation.id}/surfaces/${surface.surface_id}`,
                  { method: 'PATCH', body: { published: !surface.published } });
                publicView();
              },
            }, surface.published ? 'Remove from page' : 'Put on page'))))
      : el('p', { className: 'empty' }, 'No installed app declares a public surface.'),

    el('div', { className: 'actions' },
      el('a', { className: 'primary', href: `/p/${state.workspace.slug}`, target: '_blank',
                style: 'text-decoration:none;display:inline-block' }, 'Open the customer page'))
  );
}

// -- routing ----------------------------------------------------------------

const views = { store: storeView, detail: detailView, installed: installedView, open: openView, public: publicView };

function go(view, argument = null) {
  state.view = view;
  state.detail = argument;
  location.hash = argument ? `${view}/${argument}` : view;
  render();
}

async function render() {
  for (const button of tabs.querySelectorAll('button')) {
    button.setAttribute('aria-current', String(button.dataset.view === state.view));
  }
  state.opened?.destroy();
  state.opened = null;
  try {
    await views[state.view](state.detail);
  } catch (e) {
    show(el('h1', {}, 'Something went wrong'), fail(e),
         el('div', { className: 'actions' }, el('button', { className: 'ghost', onclick: () => go('store') }, 'Back to the store')));
  }
}

tabs.onclick = event => {
  const view = event.target.dataset?.view;
  if (view) go(view);
};

window.onhashchange = () => {
  const [view, argument] = location.hash.slice(1).split('/');
  if (views[view] && (view !== state.view || argument !== state.detail)) {
    state.view = view; state.detail = argument ?? null; render();
  }
};

const REMEMBERED_WORKSPACE = 'cc.workspace';

async function boot() {
  let me;
  try {
    me = await api('/v1/auth/me');
  } catch {
    return signInView();
  }
  state.user = me.user;
  state.workspaces = me.workspaces;

  // Which workspace is the person's choice, not the first row the query
  // happened to return.
  let remembered = null;
  try { remembered = localStorage.getItem(REMEMBERED_WORKSPACE); } catch { /* private browsing */ }
  state.workspace = me.workspaces.find(w => w.id === remembered) ?? me.workspaces[0];

  tabs.hidden = false;
  who.replaceChildren(el('span', {}, `${state.user.name} · `), workspacePicker());
  const [view, argument] = location.hash.slice(1).split('/');
  state.view = views[view] ? view : 'store';
  state.detail = argument ?? null;
  render();
}

boot();
