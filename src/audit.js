// Who did what. Every state change an owner could later be surprised by writes
// a row here — installs, grants, revocations, uninstalls with a row count.

import { q } from './db.js';

export async function record({ workspaceId = null, installationId = null, userId = null, action, detail = {} }) {
  await q(
    `insert into platform.audit_log (workspace_id, installation_id, actor_user_id, action, detail)
     values ($1, $2, $3, $4, $5)`,
    [workspaceId, installationId, userId, action, JSON.stringify(detail)]
  );
}

export async function forWorkspace(workspaceId, { limit = 100 } = {}) {
  return q(
    `select l.action, l.detail, l.at, u.name as actor
       from platform.audit_log l
       left join platform.users u on u.id = l.actor_user_id
      where l.workspace_id = $1 order by l.at desc limit $2`,
    [workspaceId, Math.min(Number(limit) || 100, 500)]
  );
}
