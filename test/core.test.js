const test = require('node:test');
const assert = require('node:assert');
const { TaskExecutor, PRIORITY } = require('../src/core/task-executor');
const { ok, fail, sleep, check, CODES } = require('../src/core/result');
const { resolveName } = require('../src/core/names');
const { Permissions, TRUST, sanitizeChat } = require('../src/core/permissions');
const { Router } = require('../src/agent/router');
const { SkillRegistry } = require('../src/skills/registry');
const { AgentMemory } = require('../src/memory/store');

const mcData = require('minecraft-data')('1.21.11');
const quiet = { debug() {}, info() {}, warn() {}, error() {} };

test('executor runs tasks one at a time in priority order', async () => {
    const ex = new TaskExecutor(quiet);
    const order = [];
    const mk = (name, priority) => ex.submit({ name, priority, run: async s => { order.push(`${name}:start`); await sleep(20, s); order.push(`${name}:end`); return ok(); } });
    await Promise.all([mk('a', 10), mk('b', 10), mk('c', 5)]);
    assert.deepStrictEqual(order, ['a:start', 'a:end', 'b:start', 'b:end', 'c:start', 'c:end']);
});

test('higher priority preempts and the interrupted task resumes', async () => {
    const ex = new TaskExecutor(quiet);
    const log = [];
    let runs = 0;
    const low = ex.submit({
        name: 'low', priority: PRIORITY.SELF, resumable: true,
        run: async s => { runs++; log.push('low:start'); await sleep(runs === 1 ? 200 : 10, s); log.push('low:end'); return ok({ runs }); }
    });
    await sleep(20);
    const high = ex.submit({ name: 'reflex', priority: PRIORITY.REFLEX, run: async () => { log.push('reflex'); return ok(); } });
    assert.ok((await high).ok);
    const r = await low;
    assert.ok(r.ok);
    assert.strictEqual(r.data.runs, 2);
    assert.deepStrictEqual(log, ['low:start', 'reflex', 'low:start', 'low:end']);
});

test('stop is fast: cancelAll aborts the running task and empties the queue', async () => {
    const ex = new TaskExecutor(quiet);
    const a = ex.submit({ name: 'long', priority: 60, resumable: true, run: async s => { await sleep(5000, s); return ok(); } });
    const b = ex.submit({ name: 'queued', priority: 10, run: async () => ok() });
    await sleep(10);
    const t = Date.now();
    ex.cancelAll('stop');
    const [ra, rb] = await Promise.all([a, b]);
    assert.ok(Date.now() - t < 100, 'stopped quickly');
    assert.strictEqual(ra.code, CODES.ABORTED);
    assert.strictEqual(rb.code, CODES.ABORTED);
    assert.strictEqual(ex.isBusy(), false);
});

test('background tasks yield to any new task', async () => {
    const ex = new TaskExecutor(quiet);
    const follow = ex.submit({ name: 'follow', priority: 60, yields: true, run: async s => { while (true) { check(s); await sleep(10, s); } } });
    await sleep(15);
    const next = ex.submit({ name: 'mine', priority: 40, run: async () => ok({ did: 'mine' }) });
    assert.strictEqual((await follow).code, CODES.ABORTED);
    assert.ok((await next).ok);
});

test('task timeout is reported as TIMEOUT', async () => {
    const ex = new TaskExecutor(quiet);
    const r = await ex.submit({ name: 'slow', priority: 1, timeoutMs: 30, run: async s => { await sleep(1000, s); return ok(); } });
    assert.strictEqual(r.code, CODES.TIMEOUT);
});

test('a throwing task becomes a failed result, not a crash', async () => {
    const ex = new TaskExecutor(quiet);
    const r = await ex.submit({ name: 'boom', priority: 1, run: async () => { throw new Error('kaput'); } });
    assert.strictEqual(r.ok, false);
    assert.match(r.message, /kaput/);
});

test('name resolution handles spacing, plurals, aliases and typos', () => {
    const items = mcData.itemsByName;
    assert.strictEqual(resolveName('Oak Log', items).name, 'oak_log');
    assert.strictEqual(resolveName('iron pickaxes', items).name, 'iron_pickaxe');
    assert.strictEqual(resolveName('planks', items).name, 'oak_planks');
    assert.strictEqual(resolveName('minecraft:diamond', items).name, 'diamond');
    assert.strictEqual(resolveName('iron_pikaxe', items).name, 'iron_pickaxe');
    const bad = resolveName('unobtainium', items);
    assert.strictEqual(bad.name, null);
    assert.strictEqual(bad.suggestions.length, 3);
});

test('permissions: trust levels and danger classes', () => {
    const p = new Permissions({ owner: 'Aryan' });
    p.trust('Friend');
    assert.strictEqual(p.level('aryan'), TRUST.OWNER);
    assert.strictEqual(p.level('friend'), TRUST.TRUSTED);
    assert.strictEqual(p.level('Griefer'), TRUST.STRANGER);
    assert.ok(p.allows('Friend', 'world_edit'));
    assert.ok(!p.allows('Friend', 'hostile'));
    assert.ok(!p.allows('Griefer', 'none'));
    assert.ok(p.allows('Aryan', 'destructive'));
    assert.ok(!p.allows('self', 'destructive', { selfInitiated: true }), 'autonomy can never be destructive');
    p.addProtectedRegion({ x: 0, y: 64, z: 0 }, 10, 'home');
    assert.strictEqual(p.isProtected({ x: 3, y: 65, z: -4 }), 'home');
    assert.strictEqual(p.isProtected({ x: 30, y: 65, z: 0 }), null);
});

test('unowned bot is claimed by the first speaker only', () => {
    const p = new Permissions({});
    assert.ok(p.claimIfUnowned('Aryan'));
    assert.ok(!p.claimIfUnowned('Other'));
    assert.ok(p.isOwner('Aryan'));
    assert.ok(!p.isOwner('Other'));
});

test('outgoing chat can never be a server command', () => {
    assert.strictEqual(sanitizeChat('/op Griefer'), 'op Griefer');
    assert.strictEqual(sanitizeChat('//stop'), 'stop');
    assert.strictEqual(sanitizeChat('/msg Aryan hi'), '/msg Aryan hi');
    assert.strictEqual(sanitizeChat('line1\n/kill'), 'line1 /kill');
    assert.ok(sanitizeChat('x'.repeat(500)).length <= 240);
});

test('router: fixed phrases skip the model, the rest goes to the agent', () => {
    const r = new Router('OpenNova', { aliases: ['nova'] });
    assert.strictEqual(r.route('A', 'stop', { otherPlayers: 1 }).type, 'stop');
    assert.strictEqual(r.route('A', 'Nova, stop!', { otherPlayers: 5 }).type, 'stop');
    assert.deepStrictEqual(r.route('A', 'follow me', { otherPlayers: 1 }).skill, 'follow');
    assert.strictEqual(r.route('A', 'nova come here', { otherPlayers: 3 }).skill, 'goto_player');
    assert.strictEqual(r.route('A', 'ruko', { otherPlayers: 1 }).type, 'stop');
    const order = r.route('A', 'nova bring me 10 oak logs', { otherPlayers: 3 });
    assert.strictEqual(order.type, 'agent');
    assert.strictEqual(order.text, 'bring me 10 oak logs');
});

test('router: on a busy server only addressed lines are handled', () => {
    const r = new Router('OpenNova', { aliases: ['nova'] });
    assert.strictEqual(r.route('A', 'anyone want to trade?', { otherPlayers: 4 }).type, 'ignore');
    assert.strictEqual(r.route('A', 'stop', { otherPlayers: 4 }).type, 'ignore');
    assert.strictEqual(r.route('A', 'hello there', { otherPlayers: 4, whisper: true }).type, 'agent');
    r.noteSpokeTo('A');
    assert.strictEqual(r.route('A', 'yes please', { otherPlayers: 4 }).type, 'agent');
});

test('registry validates, coerces, resolves names and enforces permissions', async () => {
    const reg = new SkillRegistry(quiet);
    let got = null;
    reg.register({
        name: 'grab', description: 'd',
        params: { type: 'object', properties: { item: { type: 'string', 'x-kind': 'item' }, count: { type: 'integer', default: 1, minimum: 1 } }, required: ['item'] },
        run: async (ctx, a) => { got = a; return ok(); }
    });
    reg.register({ name: 'smash', description: 'd', danger: 'destructive', run: async () => ok() });
    reg.register({ name: 'hang', description: 'd', timeoutMs: 30, run: async (c, a, s) => { await sleep(5000, s); return ok(); } });
    const permissions = new Permissions({ owner: 'Aryan' });
    permissions.trust('Friend');
    const ctx = { mcData, permissions };

    assert.ok((await reg.run('grab', { item: 'Oak Logs', count: '3' }, ctx, null, { source: 'Aryan' })).ok);
    assert.deepStrictEqual(got, { item: 'oak_log', count: 3 });
    assert.ok((await reg.run('grab', { item: 'stick' }, ctx, null, { source: 'Aryan' })).ok);
    assert.strictEqual(got.count, 1);

    const bad = await reg.run('grab', { item: 'flurbo' }, ctx, null, { source: 'Aryan' });
    assert.strictEqual(bad.code, CODES.INVALID_ARGS);
    assert.match(bad.message, /did you mean/);
    assert.strictEqual((await reg.run('grab', { count: 2 }, ctx, null, { source: 'Aryan' })).code, CODES.INVALID_ARGS);
    assert.strictEqual((await reg.run('nope', {}, ctx, null, { source: 'Aryan' })).code, CODES.INVALID_ARGS);

    assert.strictEqual((await reg.run('smash', {}, ctx, null, { source: 'Friend' })).code, CODES.FORBIDDEN);
    assert.ok((await reg.run('smash', {}, ctx, null, { source: 'Aryan' })).ok);
    assert.strictEqual((await reg.run('grab', { item: 'stick' }, ctx, null, { source: 'Griefer' })).code, CODES.FORBIDDEN);
    assert.strictEqual((await reg.run('hang', {}, ctx, null, { source: 'Aryan' })).code, CODES.TIMEOUT);

    const defs = reg.toolDefs();
    assert.deepStrictEqual(defs.map(d => d.name), ['grab', 'hang', 'smash']);
    assert.ok(!JSON.stringify(defs).includes('x-kind'));
});

test('real skill definitions all load and produce valid tool schemas', () => {
    const reg = new SkillRegistry(quiet);
    reg.registerAll(require('../src/skills/defs'));
    assert.ok(reg.list().length >= 30);
    for (const def of reg.toolDefs()) {
        assert.match(def.name, /^[a-z_]+$/);
        assert.ok(def.description.length > 10, def.name);
        assert.strictEqual(def.parameters.type, 'object');
    }
});

test('memory: episodes are searchable, lessons and facts persist in the store', () => {
    const mem = new AgentMemory(null, ':memory:', quiet);
    mem.addEpisode('order', 'Aryan asked for 10 oak logs -> done', 4, 'Aryan');
    mem.addEpisode('fact', 'Aryan prefers spruce wood for building', 8, 'Aryan');
    mem.addEpisode('failure', 'mine_block failed: no diamond ore found near spawn', 4);
    const hits = mem.search('what wood does aryan like for building?');
    assert.ok(hits.length >= 1);
    assert.match(hits[0].text, /spruce/);
    assert.strictEqual(mem.search('the and for').length, 0);
    assert.strictEqual(mem.facts().length, 1);

    mem.addLesson('mine_block:NO_BLOCK_IN_RANGE', 'explore east then retry');
    mem.addLesson('mine_block:NO_BLOCK_IN_RANGE', 'explore east then retry');
    assert.strictEqual(mem.lessonsFor(['mine_block:NO_BLOCK_IN_RANGE', 'other']).length, 1);

    mem.setFact('mode', 'auto');
    assert.strictEqual(mem.getFact('mode'), 'auto');
    assert.strictEqual(mem.getFact('missing', 'x'), 'x');
    mem.close();
});
