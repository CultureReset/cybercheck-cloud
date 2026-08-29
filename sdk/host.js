// The host side of the bridge. The platform UI and the public page both use it.
//
// One app surface, in one iframe, on the app's own origin. If it fails to load,
// throws, or never answers, the frame is replaced by a small "unavailable" card
// and everything else on the page keeps working. That boundary is the reason a
// third-party app cannot take the platform down.

const LOAD_TIMEOUT_MS = 12_000;

export function mountSurface(container, options) {
  const {
    platform = location.origin,
    workspaceId, installationId, surfaceId,
    title = 'App', height = 420, sandbox = true,
    onError = null,
  } = options;

  container.replaceChildren();
  const frame = document.createElement('iframe');
  let expectedOrigin = null;
  let settled = false;

  const fail = reason => {
    if (settled) return;
    settled = true;
    container.replaceChildren(unavailable(title, reason));
    onError?.(reason);
  };

  const timer = setTimeout(() => fail('did not load in time'), LOAD_TIMEOUT_MS);

  requestHandoff(platform, workspaceId, installationId, surfaceId)
    .then(handoff => {
      expectedOrigin = handoff.origin;

      frame.src = handoff.url;
      frame.title = handoff.surface.title ?? title;
      frame.loading = 'lazy';
      frame.referrerPolicy = 'no-referrer';
      frame.style.cssText = `width:100%;height:${height}px;border:0;display:block;background:transparent`;
      // allow-same-origin is safe here and necessary: the app is on its own
      // origin, so "same origin" means the app's own, not the platform's.
      if (sandbox) frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-popups allow-same-origin');

      frame.addEventListener('load', () => { clearTimeout(timer); settled = true; });
      frame.addEventListener('error', () => fail('failed to load'));
      container.replaceChildren(frame);
    })
    .catch(e => { clearTimeout(timer); fail(e.message); });

  const onMessage = async event => {
    // The single most important line in this file: a message is only trusted if
    // it came from the frame we mounted, on the origin the manifest pinned.
    if (event.source !== frame.contentWindow || event.origin !== expectedOrigin) return;

    const message = event.data ?? {};
    if (message.type === 'cc:resize' && Number.isFinite(message.height)) {
      frame.style.height = `${Math.min(Math.max(message.height, 80), 4000)}px`;
    }
    if (message.type === 'cc:refresh') {
      const handoff = await requestHandoff(platform, workspaceId, installationId, surfaceId).catch(() => null);
      const code = handoff && new URL(handoff.url).searchParams.get('cc_code');
      if (code) frame.contentWindow.postMessage({ type: 'cc:code', code }, expectedOrigin);
    }
    if (message.type === 'cc:close') options.onClose?.();
    if (message.type === 'cc:navigate') options.onNavigate?.(message.to);
  };
  window.addEventListener('message', onMessage);

  return {
    destroy() {
      clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      container.replaceChildren();
    },
  };
}

async function requestHandoff(platform, workspaceId, installationId, surfaceId) {
  const response = await fetch(
    `${platform}/v1/workspaces/${workspaceId}/installations/${installationId}/surfaces/${surfaceId}/handoff`,
    { method: 'POST', credentials: 'include' }
  );
  const body = await response.json();
  if (!response.ok) throw new Error(body?.error?.message ?? 'could not open this app');
  return body;
}

// Mounts a surface by absolute URL, with no handoff and no token. Used by the
// public page, where there is no logged-in human to authorise anything.
export function mountPublicSurface(container, { url, title = 'App', height = 320 }) {
  container.replaceChildren();
  if (!url) return container.replaceChildren(unavailable(title, 'has no public address'));

  const frame = document.createElement('iframe');
  const timer = setTimeout(() => container.replaceChildren(unavailable(title, 'did not load in time')), LOAD_TIMEOUT_MS);
  frame.src = url;
  frame.title = title;
  frame.loading = 'lazy';
  frame.referrerPolicy = 'no-referrer';
  frame.style.cssText = `width:100%;height:${height}px;border:0;display:block`;
  frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-popups allow-same-origin');
  frame.addEventListener('load', () => clearTimeout(timer));
  frame.addEventListener('error', () => {
    clearTimeout(timer);
    container.replaceChildren(unavailable(title, 'failed to load'));
  });
  container.replaceChildren(frame);
}

function unavailable(title, reason) {
  const card = document.createElement('div');
  card.className = 'cc-unavailable';
  card.setAttribute('role', 'status');
  card.style.cssText =
    'padding:16px;border:1px dashed currentColor;border-radius:10px;opacity:.65;font:14px system-ui';
  card.textContent = `${title} is unavailable — it ${reason}.`;
  return card;
}
