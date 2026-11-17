const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Vec3 } = require('vec3');
const { createAgent } = require('../src/agent');
const MemorySystem = require('../src/systems/memory');
const CommandLoader = require('../src/commands');
const { GoalManager } = require('../src/agent/goals');

const quiet = { debug() {}, info() {}, warn() {}, error() {}, success() {} };

/** A bot with no world: nothing to see, nowhere to walk. Enough to exercise real wiring and failure paths. */
function stubBot(inventory = []) {
    const bot = new EventEmitter();
    Object.assign(bot, {
        version: '1.21.11', username: 'Nova', health: 20, food: 20, oxygenLevel: 20, isSleeping: false,
        entity: { position: new Vec3(0, 64, 0), height: 1.8 }, entities: {}, players: { Aryan: {}, Nova: {} },
        game: { dimension: 'overworld' }, time: { timeOfDay: 6000 }, chatLog: [],
        inventory: { items: () => inventory, emptySlotCount: () => 36 - inventory.length, slots: [], count: () => 0 },
        chat: text => bot.chatLog.push(text),
        findBlocks: () => [], findBlock: () => null, blockAt: () => null,
        pathfinder: { movements: { exclusionAreasBreak: [], exclusionAreasPlace: [], blocksCantBreak: new Set(), scafoldingBlocks: [] }, setGoal() {}, goto: async () => { throw new Error('No path to the goal!'); } },
        clearControlStates() {}, stopDigging() {}, setControlState() {}
    });
    return bot;
}

function build(config = {}, inventory) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-test-'));
    const bot = stubBot(inventory);
    bot.systems = { memory: new MemorySystem(quiet, dir) };
    const full = { settings: { commandPrefix: '!', owner: '' }, combat: { fleeHealthThreshold: 6 }, agent: { reflexes: false, trace: false }, llm: {}, ...config };
    bot.config = full;
    const agent = createAgent(bot, full, quiet, dir);
    return { bot, agent, dir, close: () => { agent.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('agent assembles on a bare bot and runs with no model configured', async t => {
    const env = build();
    t.after(env.close);
    env.agent.start();
    assert.strictEqual(env.agent.llm.enabled, false);
    assert.ok(env.agent.registry.list().length >= 30);
    assert.strictEqual(env.agent.goals.mode, 'assist');

    // First speaker claims an unowned bot.
    assert.ok(env.agent.authorize('Aryan'));
    assert.ok(env.agent.permissions.isOwner('Aryan'));
    assert.strictEqual(env.agent.authorize('Stranger'), false);

    // Natural language without a model: told plainly, nothing crashes.
    await env.agent.onChat('Aryan', 'please build me a castle', {});
    assert.match(env.bot.chatLog.join('\n'), /can't think right now/);
});

test('plan_for goes through the real registry and planner', async t => {
    const env = build({ settings: { commandPrefix: '!', owner: 'Aryan' } });
    t.after(env.close);
    const r = await env.agent.registry.run('plan_for', { item: 'Iron Pickaxe' }, env.agent.ctx, null, { source: 'Aryan' });
    assert.ok(r.ok, r.message);
    assert.ok(r.data.steps.length >= 10 && r.data.steps.length <= 20);
    assert.match(r.data.steps[0], /mine oak_log/);
    assert.match(r.data.steps[r.data.steps.length - 1], /craft 1 iron_pickaxe/);
});

test('obtain in an empty world fails cleanly with a useful reason', async t => {
    const env = build({ settings: { commandPrefix: '!', owner: 'Aryan' } });
    t.after(env.close);
    const r = await env.agent.runSkill('obtain', { item: 'crafting_table' }, 'Aryan');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'NO_BLOCK_IN_RANGE');
    assert.match(r.message, /stuck on "mine oak_log/);
    assert.ok(Array.isArray(r.data.remaining));
    assert.strictEqual(env.agent.executor.isBusy(), false);
});

test('"stop" in chat halts a running task without a model', async t => {
    const env = build({ settings: { commandPrefix: '!', owner: 'Aryan' } });
    t.after(env.close);
    const running = env.agent.runSkill('wait', { seconds: 60 }, 'Aryan');
    await new Promise(r => setTimeout(r, 20));
    const started = Date.now();
    await env.agent.onChat('Aryan', 'stop', {});
    const r = await running;
    assert.strictEqual(r.code, 'ABORTED');
    assert.ok(Date.now() - started < 250, 'stop must take effect within 250 ms');
    assert.match(env.bot.chatLog.join('\n'), /Stopped/);
});

test('strangers cannot trigger anything through chat', async t => {
    const env = build({ settings: { commandPrefix: '!', owner: 'Aryan' } });
    t.after(env.close);
    await env.agent.onChat('Griefer', 'follow me', { whisper: true });
    assert.strictEqual(env.agent.executor.isBusy(), false);
    assert.strictEqual(env.bot.chatLog.length, 0);
});

test('a manual action command takes the body back; a passive one does not', async t => {
    const env = build({ settings: { commandPrefix: '!', owner: 'Aryan' } });
    t.after(env.close);
    const running = env.agent.runSkill('wait', { seconds: 60 }, 'Aryan');
    await new Promise(r => setTimeout(r, 10));
    env.agent.onManualCommand('status');
    assert.ok(env.agent.executor.isBusy());
    env.agent.onManualCommand('mine');
    assert.strictEqual((await running).code, 'ABORTED');
});

test('command modules load with no alias collisions', () => {
    const loader = new CommandLoader(quiet);
    loader.loadCommands(path.join(__dirname, '..', 'src', 'commands'));
    for (const name of ['ask', 'obtain', 'plan', 'do', 'skills', 'mode', 'trust', 'untrust', 'agent', 'mine', 'craft', 'stop']) {
        assert.ok(loader.has(name), name);
    }
    // The agent module must not shadow or share a name with any existing command or alias.
    const all = loader.getAll();
    for (const [name, cmd] of all.filter(([, c]) => c.module === 'agent')) {
        for (const alias of cmd.aliases || []) {
            assert.ok(!loader.commands.has(alias), `alias "${alias}" of ${name} shadows a command`);
            const clash = all.find(([other, c]) => other !== name && (c.aliases || []).includes(alias));
            assert.ok(!clash, `alias "${alias}" of ${name} is also used by ${clash && clash[0]}`);
        }
    }
});

test('autonomy: obey does nothing, auto works through the tech tree in order', t => {
    const env = build({ settings: { commandPrefix: '!', owner: 'Aryan' } });
    t.after(env.close);
    const goals = env.agent.goals;
    assert.ok(goals instanceof GoalManager);
    goals.setMode('obey');
    assert.deepStrictEqual(goals.candidates(), []);
    goals.setMode('auto');
    assert.strictEqual(goals.candidates()[0].label, 'wooden tools');
    env.agent.world.inventory = () => ({ iron_pickaxe: 1, stone_axe: 1, stone_sword: 1 });
    assert.strictEqual(goals.candidates()[0].label, 'light and heat', 'a better pickaxe satisfies the lower tiers');
    assert.strictEqual(env.agent.memory.getFact('mode'), 'auto', 'mode is remembered');
    assert.strictEqual(goals.setMode('chaos'), false);
});
