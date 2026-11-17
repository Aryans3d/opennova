const { ok, fail, check, sleep, CODES } = require('../../core/result');
const { AcquirePlanner, describeStep } = require('../../planner/acquire');
const L = require('../lib');

/** Plan and execute until the goals hold, re-planning from real state after failures. */
async function obtainGoals(ctx, goals, signal) {
    const bot = ctx.bot;
    const satisfied = () => goals.every(g => L.count(bot, g.item) >= g.count);
    const failures = new Map();
    const done = [];
    let lastPlan = null;
    try {
        for (let round = 0; round < 8; round++) {
            check(signal);
            if (satisfied()) break;
            const plan = ctx.planner.plan(goals, { inventory: L.inventoryCounts(bot), world: ctx.world.plannerView() });
            lastPlan = plan;
            if (!plan.ok) {
                const m = plan.missing[0];
                return fail(CODES.NOT_FOUND, `cannot plan for ${m.item}: ${m.reason}`, { missing: plan.missing, done });
            }
            if (!plan.steps.length) break;
            ctx.logger.info(`Plan (${plan.steps.length} steps, ~${plan.cost}s):\n${AcquirePlanner.describe(plan)}`);
            let failed = null;
            for (const step of plan.steps) {
                check(signal);
                if (ctx.onProgress) ctx.onProgress(describeStep(step));
                const r = await ctx.registry.run(step.skill, step.args, ctx, signal, { source: ctx.source });
                if (r.ok) {
                    done.push(describeStep(step));
                    continue;
                }
                if (r.code === CODES.ABORTED) return r;
                failed = { step, result: r };
                break;
            }
            if (failed) {
                const key = `${failed.step.skill}:${failed.step.args.item || failed.step.args.output}:${failed.result.code}`;
                const n = (failures.get(key) || 0) + 1;
                failures.set(key, n);
                ctx.logger.warn(`Step failed (${n}): ${describeStep(failed.step)} -> ${failed.result.code} ${failed.result.message}`);
                if (n >= 2) {
                    return fail(failed.result.code, `stuck on "${describeStep(failed.step)}": ${failed.result.message}`, {
                        failedStep: describeStep(failed.step), detail: failed.result.data, done,
                        remaining: plan.steps.slice(plan.steps.indexOf(failed.step)).map(describeStep).slice(0, 8)
                    });
                }
            }
        }
    } finally {
        if (!signal.aborted) await L.reclaimStations(ctx, signal).catch(() => {});
    }
    if (!satisfied()) {
        return fail(CODES.FAILED, 'ran out of attempts before reaching the goal', { done, have: Object.fromEntries(goals.map(g => [g.item, L.count(bot, g.item)])) });
    }
    return ok({ have: Object.fromEntries(goals.map(g => [g.item, L.count(bot, g.item)])), steps: done.length }, `now have ${goals.map(g => `${L.count(bot, g.item)} ${g.item}`).join(', ')}`);
}

module.exports = [
    {
        name: 'obtain',
        description: 'Get items by any means: works out the whole chain itself (gather wood, make tools, mine, smelt, craft, use known chests) and carries it out. `count` is the total wanted in the inventory. Prefer this over calling mine/craft/smelt step by step.',
        params: {
            type: 'object',
            properties: {
                item: { type: 'string', 'x-kind': 'item' },
                count: { type: 'integer', default: 1, minimum: 1, maximum: 2304 },
                also: {
                    type: 'array', maxItems: 8, description: 'further items to obtain in the same run',
                    items: { type: 'object', properties: { item: { type: 'string' }, count: { type: 'integer', minimum: 1, maximum: 2304 } }, required: ['item'] }
                }
            },
            required: ['item']
        },
        timeoutMs: 3600000,
        danger: 'world_edit',
        async run(ctx, a, signal) {
            const { resolveName } = require('../../core/names');
            const goals = [{ item: a.item, count: a.count }];
            for (const extra of a.also || []) {
                const r = resolveName(extra.item, ctx.mcData.itemsByName);
                if (!r.name) return fail(CODES.INVALID_ARGS, `unknown item "${extra.item}"`, { suggestions: r.suggestions });
                goals.push({ item: r.name, count: extra.count || 1 });
            }
            return obtainGoals(ctx, goals, signal);
        }
    },
    {
        name: 'plan_for',
        description: 'Show the steps `obtain` would take for an item, without doing anything.',
        params: { type: 'object', properties: { item: { type: 'string', 'x-kind': 'item' }, count: { type: 'integer', default: 1, minimum: 1, maximum: 2304 } }, required: ['item'] },
        timeoutMs: 5000,
        async run(ctx, a) {
            const plan = ctx.planner.plan([{ item: a.item, count: a.count }], { inventory: L.inventoryCounts(ctx.bot), world: ctx.world.plannerView() });
            if (!plan.ok) return fail(CODES.NOT_FOUND, plan.missing[0].reason, { missing: plan.missing });
            return ok({ steps: plan.steps.map(describeStep), estimatedSeconds: plan.cost });
        }
    },
    {
        name: 'status',
        description: 'Report health, hunger, position, inventory and surroundings.',
        params: { type: 'object', properties: {} },
        timeoutMs: 5000,
        async run(ctx) {
            const { renderSnapshot } = require('../../agent/snapshot');
            return ok({ snapshot: renderSnapshot(ctx) });
        }
    },
    {
        name: 'set_home',
        description: 'Remember the current position as home. The area around home is protected from digging.',
        params: { type: 'object', properties: {} },
        timeoutMs: 5000,
        async run(ctx) {
            const p = ctx.bot.entity.position;
            ctx.memory.setHome(p);
            ctx.permissions.addProtectedRegion(p.floored(), ctx.config.agent?.homeProtectRadius ?? 12, 'home');
            return ok({ home: L.fmt(p) });
        }
    },
    {
        name: 'save_waypoint',
        description: 'Save the current position under a name.',
        params: { type: 'object', properties: { name: { type: 'string', minLength: 1, maxLength: 32 } }, required: ['name'] },
        timeoutMs: 5000,
        async run(ctx, a) {
            ctx.memory.saveWaypoint(a.name, ctx.bot.entity.position);
            return ok({ name: a.name.toLowerCase(), position: L.fmt(ctx.bot.entity.position) });
        }
    },
    {
        name: 'remember',
        description: 'Store a fact for later (a preference, a standing instruction, where something is).',
        params: { type: 'object', properties: { text: { type: 'string', minLength: 3, maxLength: 300 } }, required: ['text'] },
        timeoutMs: 5000,
        async run(ctx, a) {
            ctx.memory.addEpisode('fact', a.text, 8, ctx.source);
            return ok({}, 'remembered');
        }
    },
    {
        name: 'recall',
        description: 'Search memory for past events and stored facts.',
        params: { type: 'object', properties: { query: { type: 'string', minLength: 2, maxLength: 100 } }, required: ['query'] },
        timeoutMs: 5000,
        async run(ctx, a) {
            return ok({ memories: ctx.memory.search(a.query, 6).map(m => m.text) });
        }
    },
    {
        name: 'wait',
        description: 'Do nothing for a number of seconds.',
        params: { type: 'object', properties: { seconds: { type: 'number', minimum: 1, maximum: 120 } }, required: ['seconds'] },
        timeoutMs: 130000,
        async run(ctx, a, signal) {
            await sleep(a.seconds * 1000, signal);
            return ok();
        }
    }
];

module.exports.obtainGoals = obtainGoals;
