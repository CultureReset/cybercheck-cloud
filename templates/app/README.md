# __NAME__

An app for the CyberCheck platform. It is a manifest and a folder of static
files — there is no build step and no server.

```bash
cc dev          # serve this folder and publish it to your platform
cc publish --url https://where-you-host-it
```

## Adding to it

**A table** — add it under `data.tables` in `manifest.json`, then
`cc publish`. The platform provisions it. Read and write it with
`cc.table('name')`; no permission is involved, because it is your table.

**Something the platform owns** — add it to `permissions` with an honest
`reason`; the reason is what the owner reads on the consent screen. Then check
`cc.can('contacts.read')` before using it: an optional permission may not have
been granted, and an app that assumes otherwise breaks for half its installs.

**A public surface** — add `{ "id": "form", "kind": "public", "path": "/public.html" }`
and the `surface.public` permission. A table a public form writes to needs
`"public": "append"`, because a stranger gets nothing by default.

`cc permissions` lists what this platform offers.
