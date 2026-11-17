const { ok, fail, check, sleep, CODES } = require('../../core/result');
const L = require('../lib');
const { equipWeapon, killEntity } = require('./gather');

const BAD_FOOD = new Set(['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish', 'chicken', 'suspicious_stew', 'chorus_fruit']);

function bestFood(ctx) {
    const foods = ctx.mcData.foodsByName || {};
    return ctx.bot.inventory.items()
        .filter(i => foods[i.name] && !BAD_FOOD.has(i.name))
        .sort((a, b) => (foods[b.name].foodPoints || 0) - (foods[a.name].foodPoints || 0))[0] || null;
}

async function eatNow(ctx, signal) {
    const bot = ctx.bot;
    if (bot.food >= 20) return ok({ food: bot.food }, 'not hungry');
    const food = bestFood(ctx);
    if (!food) return fail(CODES.MISSING_ITEM, 'no food in inventory', { missing: [{ item: 'bread', count: 1 }] });
    try {
        await bot.equip(food, 'hand');
        check(signal);
        await bot.consume();
    } catch (error) {
        return fail(CODES.FAILED, `could not eat: ${error.message}`);
    }
    return ok({ ate: food.name, food: bot.food });
}

async function fleeNow(ctx, signal, distance = 20, maxMs = 8000) {
    const bot = ctx.bot;
    const threats = L.nearbyEntities(bot, L.isHostile, 24);
    if (!threats.length) return ok({}, 'nothing to flee from');
    const t = threats[0].entity.position;
    const me = bot.entity.position;
    let dx = me.x - t.x, dz = me.z - t.z;
    const len = Math.hypot(dx, dz) || 1;
    dx /= len; dz /= len;
    try {
        await L.pathTo(bot, new L.goals.GoalNearXZ(me.x + dx * distance, me.z + dz * distance, 3), signal, maxMs);
    } catch (error) {
        if (error.name === 'AbortError') throw error;
    }
    return ok({ from: threats[0].entity.name });
}

module.exports = [
    {
        name: 'eat',
        description: 'Eat the best food in the inventory.',
        params: { type: 'object', properties: {} },
        timeoutMs: 15000,
        run: (ctx, a, signal) => eatNow(ctx, signal)
    },
    {
        name: 'sleep',
        description: 'Sleep in a nearby bed (or the bed at home) to skip the night.',
        params: { type: 'object', properties: {} },
        timeoutMs: 300000,
        async run(ctx, a, signal) {
            const bot = ctx.bot;
            const bedNames = ctx.mcData.blocksArray.filter(b => /_bed$/.test(b.name)).map(b => b.name);
            let bed = L.findBlocks(ctx, bedNames, 32, 2)[0];
            if (!bed) {
                const home = ctx.memory && ctx.memory.getHome();
                if (home) {
                    const r = await L.travelTo(ctx, home, 4, signal);
                    if (r.ok) bed = L.findBlocks(ctx, bedNames, 32, 2)[0];
                }
            }
            if (!bed) return fail(CODES.NOT_FOUND, 'no bed nearby or at home', { missing: [{ item: 'white_bed', count: 1 }] });
            const reach = await L.gotoBlock(ctx, bed, signal, 2.5);
            if (!reach.ok) return reach;
            try {
                await bot.sleep(bed);
            } catch (error) {
                return fail(/monster/i.test(error.message) ? CODES.UNSAFE : CODES.BLOCKED, `cannot sleep: ${error.message}`);
            }
            while (bot.isSleeping) { await sleep(1000, signal).catch(async e => { try { await bot.wake(); } catch (_) { /* ignore */ } throw e; }); }
            return ok({}, 'slept');
        }
    },
    {
        name: 'flee',
        description: 'Run away from the nearest hostile mob.',
        params: { type: 'object', properties: {} },
        timeoutMs: 20000,
        run: (ctx, a, signal) => fleeNow(ctx, signal)
    },
    {
        name: 'attack_mob',
        description: 'Fight a mob: a named type, or the nearest hostile one.',
        params: { type: 'object', properties: { mob: { type: 'string', 'x-kind': 'entity' } } },
        timeoutMs: 120000,
        async run(ctx, a, signal) {
            const found = L.nearbyEntities(ctx.bot, e => (a.mob ? e.name === a.mob : L.isHostile(e)), 24)[0];
            if (!found) return fail(CODES.NOT_FOUND, a.mob ? `no ${a.mob} nearby` : 'no hostile mobs nearby');
            await equipWeapon(ctx.bot);
            const r = await killEntity(ctx, found.entity, signal);
            return r.ok ? ok({ killed: found.entity.name }) : r;
        }
    },
    {
        name: 'attack_player',
        description: 'Attack a player. Only on a direct order from the owner.',
        params: { type: 'object', properties: { player: { type: 'string' } }, required: ['player'] },
        timeoutMs: 120000,
        danger: 'hostile',
        async run(ctx, a, signal) {
            const entity = ctx.bot.players[a.player]?.entity;
            if (!entity) return fail(CODES.NOT_FOUND, `cannot see ${a.player}`);
            if (ctx.permissions.isOwner(a.player)) return fail(CODES.FORBIDDEN, 'will not attack my owner');
            await equipWeapon(ctx.bot);
            return killEntity(ctx, entity, signal, 60000);
        }
    },
    {
        name: 'guard',
        description: 'Stay near a player and fight hostile mobs that come close, until another order arrives.',
        params: { type: 'object', properties: { player: { type: 'string' } } },
        timeoutMs: 0,
        background: true,
        async run(ctx, a, signal) {
            const bot = ctx.bot;
            const name = a.player || ctx.source;
            try {
                while (true) {
                    check(signal);
                    const entity = bot.players[name]?.entity;
                    const threat = L.nearbyEntities(bot, L.isHostile, 10)[0];
                    if (threat) {
                        await equipWeapon(bot);
                        await killEntity(ctx, threat.entity, signal, 20000);
                    } else if (entity && bot.entity.position.distanceTo(entity.position) > 5) {
                        bot.pathfinder.setGoal(new L.goals.GoalFollow(entity, 3), true);
                    }
                    await sleep(400, signal);
                }
            } finally {
                L.stopAll(bot);
            }
        }
    }
];

module.exports.eatNow = eatNow;
module.exports.fleeNow = fleeNow;
module.exports.bestFood = bestFood;
