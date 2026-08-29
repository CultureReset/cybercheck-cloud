// The host side of the bridge, loaded by whatever dashboard is embedding the
// store. It is served by the platform so that the origin check below — the one
// line the whole security model rests on — has a single implementation rather
// than one per front end.
//
//   const { mountSurface } = await import(`${PLATFORM}/sdk/host.js`);
//   mountSurface(node, { handoff: () => api.post(handoffPath), title: 'Notes' });
//
// It knows nothing about how the host authenticates. `handoff` is a function
// the host supplies that returns { url, origin }; sessions, tokens and cookies
// stay on the host's side of the line.

const LOAD_TIMEOUT_MS = 12_000;

export function mountSurface(container, options) {
  const { handoff, title = 'App', height = 420, onError = null, onClose = null, onNavigate = null } = options;
  if (typeof handoff !== 'function') throw new Error('mountSurface needs a handoff function');

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

  Promise.resolve(handoff())
    .then(result => {
      expectedOrigin = result.origin;
      frame.src = result.url;
      frame.title = result.surface?.title ?? title;
      frame.loading = 'lazy';
      frame.referrerPolicy = 'no-referrer';
      frame.style.cssText = `width:100%;height:${height}px;border:0;display:block;background:transparent`;
      // allow-same-origin is both safe and necessary here: the app is on its
      // own origin, so "same origin" means the app's, never the host's.
      frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-popups allow-same-origin');
      frame.addEventListener('load', () => { clearTimeout(timer); settled = true; });
      frame.addEventListener('error', () => fail('failed to load'));
      container.replaceChildren(frame);
    })
    .catch(error => { clearTimeout(timer); fail(error.message); });

  const onMessage = async event => {
    // Only the frame we mounted, only on the origin its manifest pinned.
    if (event.source !== frame.contentWindow || event.origin !== expectedOrigin) return;

    const message = event.data ?? {};
    if (message.type === 'cc:resize' && Number.isFinite(message.height)) {
      frame.style.height = `${Math.min(Math.max(message.height, 80), 4000)}px`;
    }
    if (message.type === 'cc:refresh') {
      // A handoff code is single-use, so an app cannot mint itself a new token.
      // It asks the host, which holds the session.
      const result = await Promise.resolve(handoff()).catch(() => null);
      const code = result && new URL(result.url).searchParams.get('cc_code');
      if (code) frame.contentWindow.postMessage({ type: 'cc:code', code }, expectedOrigin);
    }
    if (message.type === 'cc:close') onClose?.();
    if (message.type === 'cc:navigate') onNavigate?.(message.to);
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

// A published surface on a customer-facing page. No handoff and no host
// session: the platform already put an anonymous code in the URL, because
// there is no logged-in human out here to authorise anything.
export function mountPublicSurface(container, { url, title = 'App', height = 320 }) {
  container.replaceChildren();
  if (!url) return container.replaceChildren(unavailable(title, 'has no public address'));

  const frame = document.createElement('iframe');
  const timer = setTimeout(
    () => container.replaceChildren(unavailable(title, 'did not load in time')), LOAD_TIMEOUT_MS
  );
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

  // Public surfaces resize too, and there is no host session involved in it.
  const origin = safeOrigin(url);
  const onMessage = event => {
    if (event.source !== frame.contentWindow || event.origin !== origin) return;
    if (event.data?.type === 'cc:resize' && Number.isFinite(event.data.height)) {
      frame.style.height = `${Math.min(Math.max(event.data.height, 80), 4000)}px`;
    }
  };
  window.addEventListener('message', onMessage);
  return { destroy() { window.removeEventListener('message', onMessage); container.replaceChildren(); } };
}

const safeOrigin = url => { try { return new URL(url).origin; } catch { return null; } };

function unavailable(title, reason) {
  const card = document.createElement('div');
  card.className = 'cc-unavailable';
  card.setAttribute('role', 'status');
  card.style.cssText =
    'padding:16px;border:1px dashed currentColor;border-radius:10px;opacity:.65;font:14px system-ui';
  card.textContent = `${title} is unavailable — it ${reason}.`;
  return card;
}
