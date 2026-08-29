# CyberCheck Platform

A standalone, modular app store. One login, many apps.

Nothing about any app is compiled into this repo. There is no `apps/` folder, no
plugin registry to edit, no import to add. An app is **a manifest and a URL**,
it lives in its own directory or its own repository, and adding one to a running
platform is one command.

```bash
cc init ~/my-app          # scaffold an app, anywhere on disk
cd ~/my-app && cc dev     # serve it and publish it — it is now in the store
```

That is the whole path. Install it from the store like any other app.

---

## Running the platform

```bash
createdb cybercheck_platform
cp .env.example .env                     # every knob is in here, none in the source
DATABASE_URL=postgres://localhost/cybercheck_platform npm run migrate
npm start
```

```bash
DATABASE_URL=postgres://localhost/cc_test npm test     # 53 cases
```

## Adding an app

`cc init` writes four files and hard-codes nothing — no platform address, no
port, no publisher but yours:

    manifest.json     what the app declares
    index.html        what it shows
    README.md         how to extend it
    .gitignore

`cc dev` serves that folder, publishes the manifest pointing at wherever it is
serving, and republishes on every save. `cc publish --url https://…` does the
same at a real address. The **same manifest** publishes to local, staging and
production — the address is an argument, never a line in the file. There is a
test that publishes one app at two different origins to prove it.

| | |
|---|---|
| `cc init <dir>` | scaffold, anywhere |
| `cc dev [--port N]` | serve and publish live |
| `cc publish --url <url>` | publish at a real address |
| `cc validate` | check a manifest, no account needed |
| `cc permissions` | what this platform offers, no account needed |
| `cc apps` | what is published |

`cc validate` and `cc permissions` need no login on purpose. Requiring an
account to read a contract is a reason not to build on a platform.

## Three questions, answered before anything runs

| | |
|---|---|
| **Who is this?** | a platform session (a human) or a scoped token (an installation) |
| **Which workspace?** | membership, checked against the URL — never taken from it |
| **May they do this?** | a permission the owner granted by name, read live |

Three separate middlewares in `src/http/auth.js`. A credential for one is never
accepted by another: a platform session cannot call an app route and an app
token cannot call a user route, and there is a test for both.

## The four states people confuse

    installed    the app exists in this workspace
    enabled      it is allowed to run
    published    a public surface of it is on the customer-facing page
    data         the owner's records, which outlive all three

Four columns, four operations. Uninstalling keeps the records unless the
manifest said otherwise or the owner asked, the uninstalled row survives, and
reinstalling lands back on that data.

## Why apps run in iframes

The alternative is importing a third party's JavaScript into the platform's own
page, where one bad app blanks the dashboard and any app can read every other
app's token. So a surface is an iframe on the app's **own origin**, and
`sdk/host.js` does three things that matter:

- it trusts a `postMessage` only when `event.origin` is the origin that app's
  manifest pinned — one line, and the whole model rests on it;
- a surface that throws, hangs or 404s becomes a small "unavailable" card while
  the rest of the page keeps working;
- the handoff code in the frame URL is single-use, short-lived, and redeemable
  only from that pinned origin, so a leaked one buys nothing.

## What an app may do

| | Needs |
|---|---|
| Read and write its **own** tables | nothing — they are its tables |
| Read the workspace profile, its members | `workspace.profile.read`, `workspace.members.read` |
| Read and write **shared contacts** | `contacts.read`, `contacts.write` |
| Announce an event | `events.emit`, and the event must be in its manifest |
| Call another app's capability | `capability.invoke` |
| Appear on the customer-facing page | `surface.public` |

Grants are read from the table on **every** request, not from the token: a
permission revoked thirty seconds ago stops working now, not in fifteen minutes.

Shared contacts are the reason to install a second app — one writes a contact,
another reads it, and neither knows the other exists. Capabilities are the same
idea for behaviour: an app calls `notify.send` and the platform decides which
installed app answers.

## Public surfaces

A public surface runs for whoever loads the page, so its token is anonymous and
narrowed to the permissions marked `public_safe` — a column on
`platform.permissions`, so adding one is a row, not a row plus an edit to a set
in the token code. A table a public form writes to must say so:

```json
"items": { "public": "append", "columns": { … } }
```

Default `none`. `append` does not imply read: a stranger can submit a request and
cannot read everyone else's back.

## Configuration

`src/config.js` is the only file that reads `process.env`, and nothing it
provides is restated as a literal anywhere else — port, database, the platform's
own address, store name, three token lifetimes, two timeouts. The platform's own
version comes from `package.json`, which is what an app's `requires.platform`
range is checked against and what `/health` reports so tooling can pin without
being told what to pin to.

## Layout

    db/          four migrations; every boundary above is a constraint here
    contract/    the app manifest schema (vendored from cybercheck-marketplace)
    src/         catalog, installs, tokens, identity, appdata, events, capabilities
    sdk/         app.js (loaded by apps) and host.js (loaded by the store)
    ui/          the store, and the customer-facing page
    bin/         cc — the developer CLI — plus migrate and contract sync
    templates/   what `cc init` writes
    test/        53 end-to-end cases, with fixtures — not apps

There is deliberately no `apps/` directory. The test fixtures live under
`test/fixtures/` and carry no address, for the same reason a scaffolded app
carries none.

## Postgres, and no substitute

`src/db.js` requires a real database. Every rule above is a constraint in
`db/*.sql` — the partial unique index that lets an app reinstall onto its old
data, the check that only a public surface can be published, the one that says
an installed row must record when. An in-memory stand-in ignores most of them,
and a suite that passed against it would be agreeing with itself.

## The contract

`contract/app-manifest.v1.json` is a copy. The canonical schema lives in
`cybercheck-marketplace`, because the catalog decides what an app may declare.
`npm run sync:contract` copies it and the suite fails if the two have drifted.

Validation is two layers on purpose. The JSON Schema decides shape. `validate`
in `src/manifest.js` decides what the schema cannot know: that a permission
exists on *this* platform, that a public surface asked for `surface.public`,
that an id carries its publisher's prefix. After that, nothing downstream reads
a manifest again — the store renders `app_declared_*` rows, which came out of
columns.

## Not built yet

- **Remote stores.** `stores` is a table with a `public_key` column and a
  `remote` kind; fetching and signature verification are not written. This is
  what lets a workspace enable somebody else's catalog, and it is the difference
  between an app store and an ecosystem someone else controls.
- **Billing.** `pricing` is declared, validated and stored. Nothing charges.
- **Rate limiting.** A public surface accepts writes from strangers. It needs a
  limiter before it faces the internet.
- **App review.** Any signed-in developer can publish to the local store.
- **Update UI.** `POST /installations/:id/update` works and refuses to widen
  permissions silently; the store has no button for it.
