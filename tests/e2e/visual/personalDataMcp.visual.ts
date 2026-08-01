/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The user's OWN data must be reachable by the model.
 *
 * The defect this pins, verbatim from the functional audit that found it: an
 * event titled `CALMARKER7719 dentist appointment` was created through the real
 * bridge, the DB row was confirmed, the user asked "What is on my calendar
 * today" - and the marker appeared NOWHERE in the 18,475-character prompt the
 * agent received. `NOTEMARKER4412`, `DOCMARKER5150` and `MEMMARKER8833` were
 * absent the same way. The audit's own summary was "there is no injection point
 * to find": calendar, notes, documents and memory simply never reached a model
 * by any route.
 *
 * The fix is a tool, not a bigger prompt, so this spec inverts the audit's
 * experiment at the same boundary the audit used:
 *
 *   1. write a marker through the real bridge;
 *   2. let the app drive a real agent connect and capture what it actually put
 *      in `session/new` - the personal-data server must be in that list;
 *   3. spawn that EXACT advertised entry (its command, args and env, taken from
 *      the captured payload - not from source), speak real MCP to it, call the
 *      tool, and read the marker back out.
 *
 * Step 3 is what makes this more than a config assertion: `tools/list` passing
 * while the server dies on spawn is precisely the failure mode that shipped for
 * `darhai-search-skills`.
 *
 * Mongolian Cyrillic is asserted with its own markers and its own Cyrillic
 * queries. A Latin-only proof would be worthless for a Mongolian-first product.
 */
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchVisualApp, closeVisualApp, quitVisualApp, waitForSettle, type VisualApp } from './fixture';
import { invokeBridge } from '../helpers/bridge';
import { createMockAgentBinary } from '../helpers/mockAgentBinary';
import { connectMcpStdio, type McpSession, type McpSpawnSpec } from '../helpers/mcpStdioClient';

const PERSONAL_DATA_SERVER = 'darhai-personal-data';

/** Distinct per run so a leftover profile or memory store cannot make a pass. */
const RUN = Date.now().toString(36).toUpperCase();
const CAL_MARKER = `CALMARKER${RUN}`;
const NOTE_MARKER = `NOTEMARKER${RUN}`;
const DOC_MARKER = `DOCMARKER${RUN}`;
const MEM_MARKER = `MEMMARKER${RUN}`;

/** Cyrillic payloads + the Cyrillic words used to search for them. */
const CAL_CYRILLIC_TITLE = `Шүдний эмчид очих ${CAL_MARKER}МН`;
const CAL_CYRILLIC_QUERY = 'шүдний';
const NOTE_CYRILLIC_TITLE = `Хурлын тэмдэглэл ${NOTE_MARKER}МН`;
const NOTE_CYRILLIC_BODY = 'Төсвийн хуваарилалтыг дараагийн улиралд хойшлуулав.';
const NOTE_CYRILLIC_QUERY = 'төсвийн';
const MEM_CYRILLIC = `${MEM_MARKER}МН Дархай нь монгол хэрэглэгчдэд зориулагдсан гэж шийдсэн`;
const MEM_CYRILLIC_QUERY = 'монгол хэрэглэгчдэд';

type StdioServer = { name: string; command: string; args?: string[]; env?: Array<{ name: string; value: string }> };
type JsonRpcRequest = { method?: string; params?: { mcpServers?: StdioServer[] } };
type ConfiguredServer = {
  id?: string;
  name: string;
  enabled?: boolean;
  transport: { type: string; command: string; args?: string[]; env?: Record<string, string> };
};

let visual: VisualApp;
let tmpRoot: string;
let ijfwHome: string;
let dumpFile: string;
let userId: string;
/** The personal-data entry as persisted in mcp.config - the source session/new is built from. */
let configured: ConfiguredServer;
let mcp: McpSession;

/** Local-midnight helpers so the "today" window matches the app's own. */
function todayAtHour(hour: number): number {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, 0, 0, 0).getTime();
}

function toSpawnSpec(server: ConfiguredServer): McpSpawnSpec {
  return { command: server.transport.command, args: server.transport.args ?? [], env: server.transport.env ?? {} };
}

test.beforeAll(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'darhai-personal-mcp-'));
  ijfwHome = fs.mkdtempSync(path.join(os.tmpdir(), 'darhai-personal-ijfw-'));
  dumpFile = path.join(tmpRoot, 'acp-requests.jsonl');

  visual = await launchVisualApp({ DARHAI_IJFW_HOME: ijfwHome });
  await waitForSettle(visual.page);

  // The identity every per-user store keys on. Inventing one here would read
  // back empty and make the whole spec pass vacuously.
  const local = await invokeBridge<{ id: string }>(visual.page, 'local-user.get', undefined, 30_000);
  userId = local.id;
  expect(userId, 'local-user.get returned no id').toBeTruthy();

  // ── Markers in, through the real bridge ────────────────────────────────────
  await invokeBridge(
    visual.page,
    'calendar.create',
    { userId, title: `${CAL_MARKER} dentist appointment`, startMs: todayAtHour(10), endMs: todayAtHour(11) },
    30_000
  );
  await invokeBridge(
    visual.page,
    'calendar.create',
    { userId, title: CAL_CYRILLIC_TITLE, startMs: todayAtHour(14), endMs: todayAtHour(15) },
    30_000
  );
  await invokeBridge(
    visual.page,
    'note.create',
    { userId, title: `${NOTE_MARKER} groceries`, content: 'milk, bread, coffee' },
    30_000
  );
  await invokeBridge(
    visual.page,
    'note.create',
    { userId, title: NOTE_CYRILLIC_TITLE, content: NOTE_CYRILLIC_BODY },
    30_000
  );
  await invokeBridge(
    visual.page,
    'documents.create',
    { userId, title: 'Quarterly plan', content: `Section one.\n${DOC_MARKER} is the acceptance token.\nSection two.` },
    30_000
  );
  await invokeBridge(visual.page, 'memory.set-quick-add', { content: `${MEM_MARKER} latin memory probe`, scope: 'global' }, 30_000);
  await invokeBridge(visual.page, 'memory.set-quick-add', { content: MEM_CYRILLIC, scope: 'global' }, 30_000);

  // Connect here, not inside a test: Playwright starts a FRESH worker after any
  // failure, which resets module state. Deriving the session in beforeAll keeps
  // every test self-sufficient, so one red assertion reports its own cause
  // instead of a cascade of "cannot read property of undefined".
  const servers = await invokeBridge<ConfiguredServer[]>(visual.page, 'agent.config.storage.get', 'mcp.config', 30_000);
  const entry = (servers ?? []).find((s) => s.name === PERSONAL_DATA_SERVER);
  expect(entry, `mcp.config has no '${PERSONAL_DATA_SERVER}' entry`).toBeTruthy();
  configured = entry as ConfiguredServer;
  expect(configured.enabled, `'${PERSONAL_DATA_SERVER}' is registered but not enabled`).toBe(true);
  mcp = await connectMcpStdio(toSpawnSpec(configured));
});

test.afterAll(async () => {
  mcp?.close();
  if (visual) await closeVisualApp(visual);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.rmSync(ijfwHome, { recursive: true, force: true });
});

test('the app advertises the personal-data MCP server to a real agent in session/new', async () => {
  const cliPath = createMockAgentBinary({ binary: 'claude', dumpRequestsTo: dumpFile });

  const conversation = await invokeBridge<{ id: string }>(
    visual.page,
    'create-conversation',
    {
      type: 'acp',
      name: 'personal-data-probe',
      model: { id: 'mock', name: 'mock', useModel: 'mock', platform: 'custom' },
      extra: { backend: 'custom', cliPath: `node ${cliPath}`, workspace: process.cwd() },
    },
    30_000
  );
  expect(conversation?.id, 'conversation was not created').toBeTruthy();

  await invokeBridge(
    visual.page,
    'chat.send.message',
    { conversation_id: conversation.id, input: 'What is on my calendar today', msg_id: `probe_${Date.now()}` },
    60_000
  ).catch(() => {
    // The turn itself may fail; only the captured session/new matters here.
  });

  const deadline = Date.now() + 90_000;
  let sessionNew: JsonRpcRequest | undefined;
  while (Date.now() < deadline && !sessionNew) {
    if (fs.existsSync(dumpFile)) {
      sessionNew = fs
        .readFileSync(dumpFile, 'utf-8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as JsonRpcRequest)
        .find((r) => r.method === 'session/new');
    }
    if (!sessionNew) await new Promise((r) => setTimeout(r, 1_000));
  }
  expect(sessionNew, `the app never sent session/new. dump: ${dumpFile}`).toBeTruthy();

  const servers = sessionNew?.params?.mcpServers ?? [];
  // eslint-disable-next-line no-console -- this payload is the evidence the spec exists to produce
  console.log('[personal-data] session/new mcpServers =', JSON.stringify(servers.map((s) => s.name)));

  const found = servers.find((s) => s.name === PERSONAL_DATA_SERVER);
  expect(
    found,
    `session/new did not carry '${PERSONAL_DATA_SERVER}'. Servers: ${servers.map((s) => s.name).join(', ')}`
  ).toBeTruthy();
  const advertised = found as StdioServer;

  expect(fs.existsSync((advertised.args ?? [])[0]), 'the advertised script does not exist on disk').toBe(true);

  // The spawn spec every other test in this file exercises is read from
  // mcp.config; pin that it is byte-for-byte what the agent was handed, so the
  // tool proofs below cannot drift away from what production actually delivers.
  expect(advertised.command).toBe(configured.transport.command);
  expect(advertised.args).toEqual(configured.transport.args);
  const advertisedEnv = Object.fromEntries((advertised.env ?? []).map((e) => [e.name, e.value]));
  expect(advertisedEnv).toEqual(configured.transport.env ?? {});

  // Discoverability. A tool the model is never told about is as useless as no
  // tool: without this line the model answers "I don't have access to your
  // calendar" and never calls anything. Assert it in the SAME captured payload
  // the audit read - the prompt the agent actually received.
  const promptText = fs.readFileSync(dumpFile, 'utf-8');
  expect(promptText, 'session/prompt never told the model the personal-data tools exist').toContain(
    'darhai_calendar_search'
  );
  expect(promptText).toContain('darhai_memory_recall');

  await invokeBridge(visual.page, 'remove-conversation', { id: conversation.id }).catch(() => {});
});

test('the advertised server spawns and registers the four read tools', async () => {
  expect(mcp.serverName).toBe(PERSONAL_DATA_SERVER);
  const names = mcp.tools.map((t) => t.name).sort();
  // eslint-disable-next-line no-console -- evidence
  console.log('[personal-data] tools/list =', JSON.stringify(names));
  expect(names).toEqual([
    'darhai_calendar_search',
    'darhai_documents_search',
    'darhai_memory_recall',
    'darhai_notes_search',
  ]);
});

test('calendar: the marker the audit could not find comes back from the tool', async () => {
  const today = await mcp.call('darhai_calendar_search', {});
  // eslint-disable-next-line no-console -- evidence
  console.log('[personal-data] darhai_calendar_search {} =>', today);
  expect(today, `'${CAL_MARKER}' is missing from today's calendar result`).toContain(CAL_MARKER);
  expect(today).toContain('dentist appointment');

  const byText = await mcp.call('darhai_calendar_search', { query: 'dentist' });
  expect(byText, 'text search did not find the event').toContain(CAL_MARKER);
});

test('notes and documents: markers come back from their tools', async () => {
  const notes = await mcp.call('darhai_notes_search', { query: NOTE_MARKER });
  // eslint-disable-next-line no-console -- evidence
  console.log('[personal-data] darhai_notes_search =>', notes);
  expect(notes).toContain(NOTE_MARKER);
  expect(notes).toContain('groceries');

  const docs = await mcp.call('darhai_documents_search', { query: DOC_MARKER });
  // eslint-disable-next-line no-console -- evidence
  console.log('[personal-data] darhai_documents_search =>', docs);
  expect(docs).toContain(DOC_MARKER);

  // The search result must carry a usable id, and reading by that id must
  // return the full body - otherwise the model can find a document and then
  // never read it.
  const documentId = (JSON.parse(docs) as { documents: Array<{ id: string }> }).documents[0]?.id;
  expect(documentId, 'document search returned no id').toBeTruthy();
  const full = await mcp.call('darhai_documents_search', { documentId });
  expect(full).toContain(DOC_MARKER);
  expect(full).toContain('Section two.');
});

test('memory: a stored entry is recalled through the tool, and gibberish is not', async () => {
  const recalled = await mcp.call('darhai_memory_recall', { query: MEM_MARKER });
  // eslint-disable-next-line no-console -- evidence
  console.log('[personal-data] darhai_memory_recall =>', recalled);
  expect(recalled).toContain(MEM_MARKER);

  // Reuse of the archive's own search lane means gibberish must stay empty -
  // a matcher that returns the whole corpus is as useless as no matcher.
  const noise = await mcp.call('darhai_memory_recall', { query: 'zzzqqxk-not-a-real-memory-9910' });
  expect((JSON.parse(noise) as { entries: unknown[] }).entries).toEqual([]);
});

test('Mongolian Cyrillic content is found by a Mongolian Cyrillic query', async () => {
  const cal = await mcp.call('darhai_calendar_search', { query: CAL_CYRILLIC_QUERY });
  // eslint-disable-next-line no-console -- evidence
  console.log(`[personal-data] calendar query '${CAL_CYRILLIC_QUERY}' =>`, cal);
  expect(cal, 'Cyrillic calendar query found nothing').toContain(CAL_CYRILLIC_TITLE);

  const notes = await mcp.call('darhai_notes_search', { query: NOTE_CYRILLIC_QUERY });
  // eslint-disable-next-line no-console -- evidence
  console.log(`[personal-data] notes query '${NOTE_CYRILLIC_QUERY}' =>`, notes);
  expect(notes, 'Cyrillic note query found nothing').toContain(NOTE_CYRILLIC_TITLE);

  const memory = await mcp.call('darhai_memory_recall', { query: MEM_CYRILLIC_QUERY });
  // eslint-disable-next-line no-console -- evidence
  console.log(`[personal-data] memory query '${MEM_CYRILLIC_QUERY}' =>`, memory);
  expect(memory, 'Cyrillic memory query found nothing').toContain(`${MEM_MARKER}МН`);
});

test('a returning user gets a fresh port, not a dead one from the previous boot', async () => {
  // The loopback port and token change every boot, so the persisted catalog
  // entry from launch N is stale at launch N+1. If the refresh branch were
  // wrong, only first-launch users would ever get working tools - the exact
  // shape of the original defect (an entry that looks present and is dead).
  const before = configured.transport.env ?? {};

  mcp.close();
  await quitVisualApp(visual);
  visual = await launchVisualApp({ DARHAI_IJFW_HOME: ijfwHome }, { reuseRunRoot: visual.runRoot });
  await waitForSettle(visual.page);

  const servers = await invokeBridge<ConfiguredServer[]>(visual.page, 'agent.config.storage.get', 'mcp.config', 30_000);
  const entries = (servers ?? []).filter((s) => s.name === PERSONAL_DATA_SERVER);
  expect(entries.length, 'the restart duplicated the catalog entry instead of updating it').toBe(1);

  configured = entries[0];
  const after = configured.transport.env ?? {};
  // eslint-disable-next-line no-console -- evidence
  console.log('[personal-data] env before/after restart =', JSON.stringify({ before, after }));
  expect(after, 'the spawn env was not refreshed across the restart').not.toEqual(before);

  mcp = await connectMcpStdio(toSpawnSpec(configured));
  const today = await mcp.call('darhai_calendar_search', {});
  expect(today, 'the tool is dead after a restart').toContain(CAL_MARKER);
});

test('the tools are read-only - no mutating verb is exposed', async () => {
  // A model that can silently create or delete the user's events is a surprise
  // -write hazard. The tool surface is the enforcement point, so pin it.
  const mutating = mcp.tools.filter((t) => /create|update|delete|write|add|set|remove/i.test(t.name));
  expect(mutating.map((t) => t.name)).toEqual([]);
});
