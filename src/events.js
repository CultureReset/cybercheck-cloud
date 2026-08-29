// Events.
//
// One app announces something happened; apps that subscribed hear about it.
// Written to an outbox first, so an app that is slow or down delays its own
// delivery and nobody else's.

import { q, one } from './db.js';
import { badRequest } from './errors.js';
import { sign } from './tokens.js';
import { liveScope } from './oauth.js';
import { config } from './config.js';

const MAX_ATTEMPTS = 5;

export async function emit({ workspaceId, installationId, event, payload = {} }) {
  const declared = await one(
    `select 1 from platform.app_declared_events e
       join platform.installations i on i.app_version_id = e.app_version_id
      where i.id = $1 and e.event_id = $2 and e.direction = 'emits'`,
    [installationId, event]
  );
  // An app emitting an event it never declared is an app whose manifest no
  // longer describes it, which is the thing the manifest exists to prevent.
  if (!declared) throw badRequest(`This app did not declare that it emits "${event}"`);

  const row = await one(
    `insert into platform.event_outbox (workspace_id, installation_id, event, payload)
     values ($1, $2, $3, $4) returning id, event, created_at`,
    [workspaceId, installationId, event, JSON.stringify(payload)]
  );
  return { queued: row.id, event: row.event };
}

export async function subscribersFor({ workspaceId, event }) {
  return q(
    `select i.id as installation_id, a.app_id, a.data_namespace, e.path,
            coalesce(i.pinned_manifest -> 'runtime' ->> 'url',
                     i.pinned_manifest -> 'runtime' ->> 'base_url') as origin
       from platform.installations i
       join platform.apps a on a.id = i.app_row_id
       join platform.app_declared_events e
         on e.app_version_id = i.app_version_id and e.direction = 'subscribes'
       join platform.installation_permissions p
         on p.installation_id = i.id and p.permission_id = 'events.subscribe' and p.revoked_at is null
      where i.workspace_id = $1 and i.status = 'installed' and i.enabled and e.event_id = $2`,
    [workspaceId, event]
  );
}

// Drains the outbox once. Called on a timer by the server, and directly by the
// tests so that delivery is observable rather than eventual.
export async function deliverPending({ limit = 50 } = {}) {
  const pending = await q(
    `select * from platform.event_outbox
      where delivered_at is null and attempts < $2
      order by created_at limit $1`,
    [limit, MAX_ATTEMPTS]
  );

  let delivered = 0;
  for (const item of pending) {
    const subscribers = await subscribersFor({ workspaceId: item.workspace_id, event: item.event });
    const failures = [];

    for (const subscriber of subscribers) {
      if (subscriber.installation_id === item.installation_id) continue;   // not your own event
      try {
        await post(subscriber, item);
      } catch (e) {
        failures.push(`${subscriber.app_id}: ${e.message}`);
      }
    }

    if (failures.length) {
      await q(
        `update platform.event_outbox set attempts = attempts + 1, last_error = $2 where id = $1`,
        [item.id, failures.join('; ')]
      );
    } else {
      await q('update platform.event_outbox set delivered_at = now() where id = $1', [item.id]);
      delivered++;
    }
  }
  return { considered: pending.length, delivered };
}

async function post(subscriber, item) {
  if (!subscriber.origin) throw new Error('no hosted runtime');
  const scope = await liveScope(subscriber.installation_id);
  const { token } = await sign({
    sub: `installation:${subscriber.installation_id}`,
    aud: subscriber.app_id,
    inst: subscriber.installation_id,
    ws: item.workspace_id,
    ns: subscriber.data_namespace,
    scope,
  }, { ttlSeconds: 60 });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.appCallTimeoutMs);
  try {
    const response = await fetch(new URL(subscriber.path, subscriber.origin), {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ event: item.event, payload: item.payload, at: item.created_at }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } finally {
    clearTimeout(timer);
  }
}
