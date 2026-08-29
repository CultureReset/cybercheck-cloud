// Apps calling apps.
//
// An app never gets another app's URL or another app's token. It names a
// capability; the platform finds which installation in this workspace provides
// it and makes the call itself. That indirection is what lets an owner swap the
// app behind a capability without the caller noticing.

import { q, one } from './db.js';
import { badRequest, forbidden, notFound } from './errors.js';
import { sign } from './tokens.js';
import { liveScope } from './oauth.js';
import { config } from './config.js';

export async function providersFor({ workspaceId, capabilityId }) {
  return q(
    `select i.id as installation_id, a.app_id, a.name, a.data_namespace,
            c.path, coalesce(i.pinned_manifest -> 'runtime' ->> 'url',
                             i.pinned_manifest -> 'runtime' ->> 'base_url') as origin
       from platform.installations i
       join platform.apps a on a.id = i.app_row_id
       join platform.app_declared_capabilities c
         on c.app_version_id = i.app_version_id and c.direction = 'provides'
      where i.workspace_id = $1 and i.status = 'installed' and i.enabled
        and c.capability_id = $2`,
    [workspaceId, capabilityId]
  );
}

export async function invoke({ workspaceId, capabilityId, payload, caller }) {
  const providers = await providersFor({ workspaceId, capabilityId });
  if (!providers.length) throw notFound(`No installed app provides "${capabilityId}"`);
  if (providers.length > 1) {
    // Two apps answering the same call is a decision for the owner, not a
    // coin toss made inside a request.
    throw badRequest(`More than one app provides "${capabilityId}"`,
      providers.map(p => p.app_id));
  }

  const provider = providers[0];
  if (provider.app_id === caller.appId) throw badRequest('An app cannot invoke its own capability through the platform');
  if (!provider.origin) throw badRequest(`${provider.app_id} has no hosted runtime to call`);

  const scope = await liveScope(provider.installation_id);
  const { token } = await sign({
    sub: `installation:${provider.installation_id}`,
    aud: provider.app_id,
    inst: provider.installation_id,
    ws: workspaceId,
    ns: provider.data_namespace,
    scope,
  }, { ttlSeconds: 60 });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.appCallTimeoutMs);
  try {
    const response = await fetch(new URL(provider.path, provider.origin), {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        'x-cybercheck-caller': caller.appId,
        'x-cybercheck-capability': capabilityId,
      },
      body: JSON.stringify(payload ?? {}),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      throw new (await import('./errors.js')).PlatformError(
        502, 'capability_failed', `${provider.app_id} rejected the call`, body
      );
    }
    return { provider: provider.app_id, result: body };
  } catch (e) {
    if (e.name === 'AbortError') {
      throw new (await import('./errors.js')).PlatformError(
        504, 'capability_timeout', `${provider.app_id} did not answer within ${config.appCallTimeoutMs}ms`
      );
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
