#!/usr/bin/env node
// The app developer's command line.
//
//   cc init <dir>     scaffold a new app, anywhere on disk
//   cc login          sign in to a platform, once
//   cc dev            serve this folder and publish it, so it appears in the store
//   cc publish        publish it at a real address
//   cc apps           what is published
//   cc permissions    what this platform offers
//   cc validate       check the manifest without publishing
//
// Nothing here writes to the platform's own source tree. An app is a folder
// somewhere else entirely, and this is the only thing that connects the two.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES = path.join(HERE, '..', 'templates');
const CREDENTIALS = path.join(
  process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'),
  'cybercheck', 'credentials.json'
);

const [command, ...argv] = process.argv.slice(2);
const flags = parseFlags(argv);

// -- commands ---------------------------------------------------------------

async function init() {
  const target = path.resolve(flags._[0] ?? '.');
  const name = flags.name ?? path.basename(target).replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  const publisher = flags.publisher ?? (await ask('Publisher id (lowercase, e.g. acme)', slugify(os.userInfo().username)));
  const slug = flags.slug ?? slugify(path.basename(target));

  if (fs.existsSync(path.join(target, 'manifest.json')) && !flags.force) {
    throw new Error(`${target} already has a manifest.json. Pass --force to overwrite.`);
  }
  fs.mkdirSync(target, { recursive: true });

  const substitutions = {
    __PUBLISHER__: publisher,
    __SLUG__: slug,
    __NAME__: name,
    __NAMESPACE__: `${publisher}_${slug}`.replace(/-/g, '_'),
    // Pinned to this platform's major, so an app scaffolded today keeps
    // installing after the platform ships a minor.
    __PLATFORM_RANGE__: `^${(await platformVersion()) ?? '1'}`.replace(/^(\^\d+).*/, '$1'),
  };

  for (const file of fs.readdirSync(path.join(TEMPLATES, 'app'))) {
    const body = fs.readFileSync(path.join(TEMPLATES, 'app', file), 'utf8');
    const rendered = Object.entries(substitutions)
      .reduce((text, [from, to]) => text.replaceAll(from, to), body);
    fs.writeFileSync(path.join(target, file.replace(/\.template$/, '')), rendered);
  }

  const where = path.relative(process.cwd(), target);
  console.log(`
  Created ${substitutions.__PUBLISHER__}.${slug} in ${target}

    cd ${!where || where.startsWith('..') ? target : where}
    cc dev

  That serves this folder and publishes it. Open the store and install it.
`);
}

async function login() {
  const platform = platformUrl();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const email = flags.email ?? await rl.question('  Email: ');
  const password = flags.password ?? await rl.question('  Password: ');
  rl.close();

  const result = await call(platform, '/v1/auth/sign-in', { method: 'POST', body: { email, password } });
  save({ ...load(), [platform]: { token: result.session.token, email: result.user.email } });
  console.log(`\n  Signed in to ${platform} as ${result.user.email}\n`);
}

// Serves the app folder and publishes it pointing at that address, so the app
// you are editing is the app in the store. Republishes on every change.
async function dev() {
  const dir = path.resolve(flags.dir ?? '.');
  const manifest = readManifest(dir);
  const port = Number(flags.port ?? 0);
  const platform = platformUrl();

  const server = http.createServer((req, res) => serveFile(dir, req, res));
  await new Promise(resolve => server.listen(port, resolve));
  const url = flags.url ?? `http://localhost:${server.address().port}`;

  console.log(`\n  ${manifest.id}  serving ${dir}\n  at ${url}\n`);

  let lastVersion = null;
  const push = async () => {
    const current = readManifest(dir);
    // Every publish is a new immutable version, so a dev loop needs a version
    // that moves. The published one is prerelease-tagged and never collides
    // with a release the developer meant to cut.
    const version = `${current.version}-dev.${Date.now()}`;
    try {
      await publishManifest(platform, { ...current, version, runtime: { ...current.runtime, url } });
      lastVersion = version;
      console.log(`  published ${version}`);
    } catch (error) {
      console.error(`  publish failed: ${error.message}`);
      for (const line of [].concat(error.detail ?? [])) console.error(`    ${line}`);
    }
  };

  await push();
  fs.watch(dir, { recursive: true }, debounce(push, 400));

  console.log(`\n  Watching for changes. Open ${platform} and install it.\n  Ctrl-C to stop.\n`);
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => { server.close(); process.exit(0); });
  }
}

async function publish() {
  const dir = path.resolve(flags.dir ?? '.');
  const manifest = readManifest(dir);
  const platform = platformUrl();
  const url = flags.url ?? manifest.runtime?.url ?? manifest.runtime?.base_url;

  if (manifest.runtime?.type !== 'service' && !url) {
    throw new Error('This app needs an address to be served from. Pass --url https://…');
  }
  if (url?.includes('localhost') && !platform.includes('localhost') && !flags.force) {
    // A localhost URL published to a real platform is an app that loads for
    // nobody but the person who published it.
    throw new Error(`Refusing to publish a localhost address to ${platform}. Pass --url, or --force if you mean it.`);
  }

  const runtime = manifest.runtime.type === 'service'
    ? { ...manifest.runtime, base_url: url }
    : { ...manifest.runtime, url };

  const result = await publishManifest(platform, { ...manifest, runtime }, { channel: flags.channel });
  console.log(`\n  Published ${result.appId}@${result.version}\n  ${result.contentHash}\n`);
}

async function apps() {
  const platform = platformUrl();
  const { apps: list } = await call(platform, '/v1/catalog/apps', { token: tokenFor(platform) });
  if (!list.length) return console.log('\n  Nothing published yet.\n');
  console.log('');
  for (const app of list) {
    console.log(`  ${app.id.padEnd(34)} ${app.version.padEnd(22)} ${app.runtime.padEnd(8)} ${app.store}`);
  }
  console.log('');
}

async function permissions() {
  const platform = platformUrl();
  const { permissions: list } = await call(platform, '/v1/catalog/permissions');
  console.log('');
  for (const permission of list) {
    const marks = [permission.sensitive && 'sensitive', permission.public_safe && 'public-safe']
      .filter(Boolean).join(', ');
    console.log(`  ${permission.id.padEnd(26)} ${permission.title}${marks ? `  (${marks})` : ''}`);
    console.log(`  ${''.padEnd(26)} ${permission.description}`);
  }
  console.log('');
}

async function validate() {
  const dir = path.resolve(flags.dir ?? '.');
  const manifest = readManifest(dir);
  const platform = platformUrl();
  const runtime = manifest.runtime?.type === 'service'
    ? { ...manifest.runtime, base_url: manifest.runtime.base_url ?? 'https://example.invalid' }
    : { ...manifest.runtime, url: manifest.runtime?.url ?? 'https://example.invalid' };

  await call(platform, '/v1/catalog/validate', { method: 'POST', body: { manifest: { ...manifest, runtime } } });
  console.log(`\n  ${manifest.id}@${manifest.version} is valid.\n`);
}

function help() {
  console.log(`
  cc — build apps for a CyberCheck platform

    cc init <dir>              scaffold a new app
    cc login                   sign in (once per platform)
    cc dev [--port N]          serve this folder and publish it live
    cc publish --url <url>     publish at a real address
    cc validate                check the manifest without publishing
    cc apps                    what is published
    cc permissions             what this platform offers

  --platform <url>   which platform (or CC_PLATFORM; default http://localhost:4000)
`);
}

// -- plumbing ---------------------------------------------------------------

function platformUrl() {
  return (flags.platform ?? process.env.CC_PLATFORM ?? 'http://localhost:4000').replace(/\/$/, '');
}

async function platformVersion() {
  return call(platformUrl(), '/health').then(r => r.version).catch(() => null);
}

function readManifest(dir) {
  const file = path.join(dir, 'manifest.json');
  if (!fs.existsSync(file)) throw new Error(`No manifest.json in ${dir}. Run: cc init ${dir}`);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`${file} is not valid JSON: ${e.message}`);
  }
}

const publishManifest = (platform, manifest, { channel } = {}) =>
  call(platform, '/v1/catalog/publish', {
    method: 'POST', token: tokenFor(platform), body: { manifest, channel },
  });

async function call(platform, route, { method = 'GET', body, token } = {}) {
  let response;
  try {
    response = await fetch(platform + route, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error(`Cannot reach ${platform}. Is it running?`);
  }
  const parsed = await response.json().catch(() => null);
  if (response.status === 401 && token) throw new Error(`Session expired for ${platform}. Run: cc login`);
  if (!response.ok) {
    const error = new Error(parsed?.error?.message ?? `HTTP ${response.status}`);
    error.detail = parsed?.error?.detail;
    throw error;
  }
  return parsed;
}

const load = () => {
  try { return JSON.parse(fs.readFileSync(CREDENTIALS, 'utf8')); } catch { return {}; }
};

function save(all) {
  fs.mkdirSync(path.dirname(CREDENTIALS), { recursive: true });
  fs.writeFileSync(CREDENTIALS, JSON.stringify(all, null, 2), { mode: 0o600 });
}

function tokenFor(platform) {
  const token = load()[platform]?.token;
  if (!token) throw new Error(`Not signed in to ${platform}. Run: cc login`);
  return token;
}

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp',
  '.woff2': 'font/woff2', '.ico': 'image/x-icon',
};

function serveFile(dir, req, res) {
  const requested = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = path.join(dir, requested.endsWith('/') ? requested + 'index.html' : requested);
  // Refuse anything that resolves outside the app folder.
  if (!file.startsWith(dir + path.sep) && file !== dir) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.readFile(file, (error, body) => {
    if (error) return res.writeHead(404).end('not found');
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    }).end(body);
  });
}

function parseFlags(args) {
  const flags = { _: [] };
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith('--')) { flags._.push(args[i]); continue; }
    const key = args[i].slice(2);
    const next = args[i + 1];
    if (next === undefined || next.startsWith('--')) flags[key] = true;
    else { flags[key] = next; i++; }
  }
  return flags;
}

async function ask(question, fallback) {
  if (!process.stdin.isTTY) return fallback;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`  ${question} [${fallback}]: `)).trim();
  rl.close();
  return answer || fallback;
}

const slugify = value =>
  String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'app';

function debounce(fn, ms) {
  let timer = null;
  return () => { clearTimeout(timer); timer = setTimeout(fn, ms); };
}

// -- dispatch ---------------------------------------------------------------
// Last on purpose: a top-level await placed above these declarations runs
// before they are initialised, and every helper here is a const.

const COMMANDS = { init, login, dev, publish, apps, permissions, validate, help };

try {
  await (COMMANDS[command] ?? help)();
} catch (error) {
  console.error(`\n  ${error.message}\n`);
  if (error.detail) console.error(`  ${[].concat(error.detail).join('\n  ')}\n`);
  process.exitCode = 1;
}
