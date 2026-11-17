/**
 * Agent assembly: builds every module for one connected bot and exposes the
 * few entry points bot.js needs (chat in, manual command notice, shutdown).
 */

const path = require('path');
const { TaskExecutor, PRIORITY } = require('../core/task-executor');
const { Permissions, TRUST, sanitizeChat } = require('../core/permissions');
const { WorldModel } = require('../core/world-model');
const { CODES } = require('../core/result');
const { AcquirePlanner } = require('../planner/acquire');
const { SkillRegistry } = require('../skills/registry');
const { AgentMemory } = require('../memory/store');
const { LLM } = require('../llm/client');
const { Tracer } = require('../trace/tracer');
const { Router } = require('./router');
const { Controller } = require('./controller');
const { GoalManager } = require('./goals');
const { ReflexEngine } = require('../reflexes/engine');
const L = require('../skills/lib');

// Legacy commands that only read state: they must not interrupt what the agent is doing.
const PASSIVE_COMMANDS = new Set([
    'help', 'status', 'stats', 'info', 'inventory', 'inv', 'count', 'pos', 'position', 'time', 'weather', 'players',
    'uptime', 'version', 'memory', 'chests', 'finditem', 'recipe', 'cancraft', 'mobs', 'death', 'say', 'tools', 'armor',
    'find', 'ask', 'plan', 'mode', 'trust', 'untrust', 'agent', 'skills', 'labelchest', 'basechest', 'waypoint', 'sethome'
]);

function createAgent(bot, config, logger, dataDir) {
    const mcData = require('minecraft-data')(bot.version);
    const agentConfig = config.agent || {};

    const memory = new AgentMemory(bot.systems?.memory || null, dataDir, logger);
    const permissions = new Permissions(config.settings || {});
    for (const name of memory.getFact('trusted', [])) permissions.trust(name);
    if (!permissions.owner) {
        const savedOwner = memory.getFact('owner', null);
        if (savedOwner) permissions.owner = savedOwner;
    }
    const home = memory.getHome();
    if (home) permissions.addProtectedRegion(home, agentConfig.homeProtectRadius ?? 12, 'home');

    const executor = new TaskExecutor(logger);
    const world = new WorldModel(bot, mcData, memory, logger);
    const planner = new AcquirePlanner(mcData);
    const registry = new SkillRegistry(logger);
    registry.registerAll(require('../skills/defs'));
    const llm = new LLM(config.llm || {}, logger);
    const tracer = new Tracer(path.join(dataDir, '..', 'logs'), agentConfig.trace !== false);
    const router = new Router(bot.username, { aliases: agentConfig.aliases, listen: agentConfig.listen });

    let lastSaid = { text: '', t: 0 };
    const say = (text, to) => {
        const clean = sanitizeChat(text);
        if (!clean) return;
        // Never spam the same line twice in a row.
        if (clean === lastSaid.text && Date.now() - lastSaid.t < 4000) return;
        lastSaid = { text: clean, t: Date.now() };
        try { bot.chat(clean); } catch (_) { /* disconnected */ }
        if (to) router.noteSpokeTo(to);
    };

    const ctx = { bot, mcData, logger, memory, permissions, planner, world, config, registry, session: { placedStations: [] }, say, source: 'self' };
    const controller = new Controller({ bot, llm, registry, executor, ctx, memory, permissions, world, tracer, logger, say, config });
    const goals = new GoalManager({ bot, ctx, executor, memory, world, logger, controller, say, config });
    controller.goals = goals;
    const reflexes = new ReflexEngine({ bot, ctx, executor, world, logger, config });

    tunePathfinder(bot, permissions, mcData);

    // When a task is cut short, make sure the body actually stops.
    executor.on('end', (task, result) => {
        if (result.code === CODES.ABORTED || result.code === CODES.TIMEOUT) L.stopAll(bot);
    });
    executor.on('requeue', () => L.stopAll(bot));

    const agent = {
        bot, config, memory, permissions, executor, world, planner, registry, llm, router, controller, goals, reflexes, ctx, say,

        start() {
            if (agentConfig.reflexes !== false) reflexes.start();
            goals.start();
            if (llm.problems.length) for (const p of llm.problems) logger.warn(`LLM: ${p}`);
            logger.info(`Agent ready. Models: ${llm.describe()}. Mode: ${goals.mode}. Skills: ${registry.list().length}.`);
            if (!llm.enabled) logger.warn('No language model is configured: natural-language orders are off, commands and reflexes still work.');
        },

        /** Stop everything now (kill switch). */
        stop(reason = 'stopped') {
            controller.cancel(reason);
            executor.cancelAll(reason);
            L.stopAll(bot);
            goals.touch();
        },

        /** A legacy !command is about to run. */
        onManualCommand(name) {
            goals.touch();
            if (PASSIVE_COMMANDS.has(name)) return;
            controller.cancel('manual command');
            executor.cancelAll('manual command');
        },

        /** May this player use commands at all? Claims ownership for the first speaker when unowned. */
        authorize(username) {
            if (permissions.claimIfUnowned(username)) {
                memory.setFact('owner', username);
                logger.info(`${username} is now my owner (set settings.owner in the config to fix this permanently)`);
                say(`${username}, you are now my owner.`, username);
            }
            return permissions.level(username) >= TRUST.TRUSTED;
        },

        /** Run one skill for a player through the executor. */
        async runSkill(name, args, username, opts = {}) {
            const prep = registry.prepare(name, args, ctx);
            if (!prep.ok) return prep;
            const level = permissions.level(username);
            const priority = level === TRUST.OWNER ? PRIORITY.OWNER : PRIORITY.TRUSTED;
            controller.cancel('direct skill');
            executor.cancelBelow(priority + 1, 'replaced by a direct command');
            const task = executor.submit({
                name: `cmd:${name}`, priority, source: username,
                yields: !!prep.skill.background, resumable: !prep.skill.background,
                run: signal => registry.run(name, prep.args, { ...ctx, onProgress: opts.onProgress }, signal, { source: username })
            });
            if (prep.skill.background) return { ok: true, code: 'OK', message: `${name} started`, data: {} };
            return task;
        },

        /** Chat line that is not a !command. */
        async onChat(username, message, env = {}) {
            const otherPlayers = Object.keys(bot.players).filter(n => n !== bot.username).length;
            const route = router.route(username, message, { whisper: !!env.whisper, otherPlayers });
            if (route.type === 'ignore') {
                controller.noteChat(username, message);
                return;
            }
            if (!agent.authorize(username)) {
                controller.noteChat(username, message);
                return;
            }
            goals.touch();
            if (route.type === 'stop') {
                agent.stop(`stop from ${username}`);
                say('Stopped.', username);
                return;
            }
            if (route.type === 'skill') {
                const result = await agent.runSkill(route.skill, route.args || {}, username);
                if (!result.ok && result.code !== CODES.ABORTED) say(result.message, username);
                else if (result.ok && !registry.get(route.skill).background) say('Done.', username);
                else if (result.ok) say('OK.', username);
                return;
            }
            try {
                await controller.handle(username, route.text);
            } catch (error) {
                logger.error(`Agent error: ${error.stack || error.message}`);
            }
        },

        shutdown() {
            reflexes.stop();
            goals.stop();
            controller.cancel('shutdown');
            executor.cancelAll('shutdown');
            world.dispose();
            memory.close();
        }
    };
    return agent;
}

function tunePathfinder(bot, permissions, mcData) {
    if (!bot.pathfinder) return;
    bot.pathfinder.thinkTimeout = 8000;
    const movements = bot.pathfinder.movements;
    if (!movements) return;
    // Do not tunnel through or build on protected ground (home).
    const guard = block => (block && block.position && permissions.isProtected(block.position) ? 100 : 0);
    movements.exclusionAreasBreak.push(guard);
    movements.exclusionAreasPlace.push(guard);
    for (const name of ['chest', 'trapped_chest', 'barrel', 'furnace', 'crafting_table', 'bed', 'spawner']) {
        const b = mcData.blocksByName[name];
        if (b) movements.blocksCantBreak.add(b.id);
    }
    for (const b of mcData.blocksArray) if (/_bed$/.test(b.name)) movements.blocksCantBreak.add(b.id);
    const extra = ['cobbled_deepslate', 'stone', 'andesite', 'diorite', 'granite']
        .map(n => mcData.itemsByName[n]?.id).filter(Boolean);
    movements.scafoldingBlocks = [...new Set([...(movements.scafoldingBlocks || []), ...extra])];
}

module.exports = { createAgent, PASSIVE_COMMANDS };
