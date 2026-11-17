const { ok, fail, check, sleep, abortable, CODES } = require('../../core/result');
const L = require('../lib');

module.exports = [
    {
        name: 'mine_block',
        description: 'Mine blocks of the given type(s) and pick up the drops. Searches the area (and digs down for ores) if none are in view. Use `count` for a number of blocks, or `item`+`until` to stop once the inventory holds that many of an item.',
        params: {
            type: 'object',
            properties: {
                blocks: { type: 'array', items: { type: 'string' }, minItems: 1, 'x-kind': 'block', description: 'block names, e.g. ["iron_ore","deepslate_iron_ore"]' },
                count: { type: 'integer', minimum: 1, maximum: 512 },
                item: { type: 'string', 'x-kind': 'item', description: 'item the blocks drop' },
                until: { type: 'integer', minimum: 1, maximum: 2304, description: 'stop when inventory has this many of `item`' }
            },
            required: ['blocks']
        },
        timeoutMs: 1200000,
        danger: 'world_edit',
        async run(ctx, a, signal) {
            const bot = ctx.bot;
            const byItem = a.item && a.until;
            const target = byItem ? a.until : (a.count || 1);
            const progress = () => (byItem ? L.count(bot, a.item) : mined);
            let mined = 0;
            let failures = 0;
            let lastFail = null;
            const skip = new Set();
            const search = {};

            while (progress() < target) {
                check(signal);
                if (bot.inventory.emptySlotCount() === 0) {
                    return fail(CODES.INVENTORY_FULL, 'inventory is full', { mined, have: progress(), target });
                }
                let block = L.findBlocks(ctx, a.blocks, 64, 32).find(b => !skip.has(b.position.toString()));
                if (!block) {
                    block = await L.searchForBlocks(ctx, a.blocks, signal, search);
                    if (!block) {
                        return fail(CODES.NO_BLOCK_IN_RANGE, `found no ${a.blocks[0]} after searching ${search.leg - 1} areas`, { mined, have: progress(), target, position: L.fmt(bot.entity.position) });
                    }
                }
                const pos = block.position.clone();
                const r = await L.digBlock(ctx, block, signal);
                if (!r.ok) {
                    if (r.code === CODES.NEED_TOOL_TIER) return fail(r.code, r.message, { ...r.data, mined, have: progress(), target });
                    skip.add(pos.toString());
                    lastFail = r;
                    if (++failures >= 8) return fail(lastFail.code, `kept failing to mine ${a.blocks[0]}: ${lastFail.message}`, { mined, have: progress(), target });
                    continue;
                }
                failures = 0;
                if (!r.data.already) mined++;
                await sleep(250, signal);
                await L.collectDrops(ctx, pos, 5, signal);
            }
            if (ctx.memory) ctx.memory.addStat('blocksMined', mined);
            return ok({ mined, have: progress(), target }, `mined ${mined} ${a.blocks[0]}`);
        }
    },
    {
        name: 'collect_drops',
        description: 'Pick up dropped items lying nearby.',
        params: { type: 'object', properties: { radius: { type: 'number', default: 12, minimum: 1, maximum: 32 }, item: { type: 'string', 'x-kind': 'item' } } },
        timeoutMs: 60000,
        async run(ctx, a, signal) {
            const n = await L.collectDrops(ctx, ctx.bot.entity.position.clone(), a.radius, signal, a.item || null);
            return ok({ collected: n });
        }
    },
    {
        name: 'kill_for_loot',
        description: 'Hunt mobs of the given type(s) until the inventory holds `until` of `item` (or `count` kills).',
        params: {
            type: 'object',
            properties: {
                mobs: { type: 'array', items: { type: 'string' }, minItems: 1, 'x-kind': 'entity' },
                item: { type: 'string', 'x-kind': 'item' },
                until: { type: 'integer', minimum: 1, maximum: 512 },
                count: { type: 'integer', minimum: 1, maximum: 64 }
            },
            required: ['mobs']
        },
        timeoutMs: 900000,
        async run(ctx, a, signal) {
            const bot = ctx.bot;
            const byItem = a.item && a.until;
            const target = byItem ? a.until : (a.count || 1);
            const names = new Set(a.mobs);
            let kills = 0;
            const progress = () => (byItem ? L.count(bot, a.item) : kills);
            const search = { dir: Math.floor(Math.random() * 4) };
            let legs = 0;
            await equipWeapon(bot);
            while (progress() < target) {
                check(signal);
                const found = L.nearbyEntities(bot, e => names.has(e.name), 48)[0];
                if (!found) {
                    if (++legs > 8) return fail(CODES.NOT_FOUND, `found no ${a.mobs[0]} after searching`, { kills, have: progress(), target });
                    const p = bot.entity.position;
                    const dirs = [[1, 0], [0, 1], [-1, 0], [0, -1]];
                    const [dx, dz] = dirs[(search.dir + Math.floor(legs / 2)) % 4];
                    await L.travelTo(ctx, { x: p.x + dx * 40, z: p.z + dz * 40 }, 6, signal);
                    continue;
                }
                const r = await killEntity(ctx, found.entity, signal);
                if (r.ok) {
                    kills++;
                    await sleep(400, signal);
                    await L.collectDrops(ctx, r.data.position, 6, signal);
                }
            }
            if (ctx.memory) ctx.memory.addStat('mobsKilled', kills);
            return ok({ kills, have: progress(), target });
        }
    }
];

const WEAPONS = ['netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword', 'netherite_axe', 'diamond_axe', 'iron_axe', 'golden_sword', 'wooden_sword', 'stone_axe', 'wooden_axe'];

async function equipWeapon(bot) {
    for (const name of WEAPONS) {
        const item = L.findItem(bot, name);
        if (item) {
            try { await bot.equip(item, 'hand'); } catch (_) { /* ignore */ }
            return name;
        }
    }
    return null;
}

/** Attack until the entity is gone. Resolves with its last position. */
async function killEntity(ctx, entity, signal, timeoutMs = 45000) {
    const bot = ctx.bot;
    const started = Date.now();
    let position = entity.position.clone();
    try {
        if (bot.pvp) bot.pvp.attack(entity);
        while (bot.entities[entity.id] && entity.isValid !== false) {
            check(signal);
            position = entity.position.clone();
            if (Date.now() - started > timeoutMs) return fail(CODES.TIMEOUT, `could not kill ${entity.name}`);
            if (!bot.pvp) {
                if (bot.entity.position.distanceTo(entity.position) > 3) {
                    await L.pathTo(bot, new L.goals.GoalFollow(entity, 2), signal, 5000).catch(e => { if (e.name === 'AbortError') throw e; });
                }
                await bot.lookAt(entity.position.offset(0, (entity.height || 1) * 0.6, 0), true);
                bot.attack(entity);
            }
            await sleep(bot.pvp ? 250 : 600, signal);
        }
        return ok({ position });
    } finally {
        try { if (bot.pvp) bot.pvp.stop(); } catch (_) { /* ignore */ }
        L.stopMoving(bot);
    }
}

module.exports.equipWeapon = equipWeapon;
module.exports.killEntity = killEntity;
module.exports.abortable = abortable;
