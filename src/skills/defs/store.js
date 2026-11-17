const { ok, fail, check, sleep, CODES } = require('../../core/result');
const L = require('../lib');

const CONTAINERS = ['chest', 'barrel', 'trapped_chest'];

async function openContainerAt(ctx, pos, signal) {
    const bot = ctx.bot;
    let block = null;
    if (pos) {
        const far = await L.travelTo(ctx, pos, 3, signal);
        if (!far.ok) return far;
        block = bot.blockAt(new L.Vec3(pos.x, pos.y, pos.z));
        if (!block || !CONTAINERS.includes(block.name)) {
            if (ctx.memory) ctx.memory.forgetChest(pos);
            return fail(CODES.NOT_FOUND, `no chest at ${L.fmt(pos)} any more`);
        }
    } else {
        block = L.findBlocks(ctx, CONTAINERS, 32, 4)[0];
        if (!block) return fail(CODES.NOT_FOUND, 'no chest or barrel within 32 blocks');
    }
    const reach = await L.gotoBlock(ctx, block, signal);
    if (!reach.ok) return reach;
    try {
        const window = await bot.openContainer(block);
        return ok({ window, block });
    } catch (error) {
        return fail(CODES.BLOCKED, `cannot open chest: ${error.message}`);
    }
}

function remember(ctx, block, window) {
    if (!ctx.memory) return [];
    const contents = window.containerItems().map(i => ({ name: i.name, count: i.count }));
    ctx.memory.updateChest(block.position, contents);
    return contents;
}

function summarize(items) {
    const out = {};
    for (const i of items) out[i.name] = (out[i.name] || 0) + i.count;
    return out;
}

const KEEP = /(_pickaxe|_axe|_sword|_shovel|_hoe|_helmet|_chestplate|_leggings|_boots|^shield$|^torch$|^crafting_table$|^furnace$|bread|cooked_|^water_bucket$|^bucket$)/;

module.exports = [
    {
        name: 'withdraw',
        description: 'Take items out of a chest. Uses the nearest chest unless coordinates are given.',
        params: {
            type: 'object',
            properties: {
                item: { type: 'string', 'x-kind': 'item' },
                count: { type: 'integer', default: 1, minimum: 1, maximum: 2304 },
                chest: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } }, required: ['x', 'y', 'z'] }
            },
            required: ['item']
        },
        timeoutMs: 300000,
        async run(ctx, a, signal) {
            let target = a.chest;
            if (!target && ctx.world) {
                const known = ctx.world.chests().find(c => (c.contents[a.item] || 0) > 0);
                if (known) target = known.position;
            }
            const opened = await openContainerAt(ctx, target, signal);
            if (!opened.ok) return opened;
            const { window, block } = opened.data;
            let taken = 0;
            try {
                const id = ctx.mcData.itemsByName[a.item].id;
                const available = window.containerItems().filter(i => i.name === a.item).reduce((s, i) => s + i.count, 0);
                const want = Math.min(a.count, available);
                if (want > 0) {
                    await window.withdraw(id, null, want);
                    taken = want;
                }
                remember(ctx, block, window);
            } catch (error) {
                return fail(error.message.includes('full') ? CODES.INVENTORY_FULL : CODES.FAILED, `withdraw failed: ${error.message}`, { taken });
            } finally {
                try { window.close(); } catch (_) { /* ignore */ }
            }
            if (taken < a.count) return fail(CODES.MISSING_ITEM, `chest only had ${taken} ${a.item}`, { taken, missing: [{ item: a.item, count: a.count - taken }] });
            return ok({ taken }, `took ${taken} ${a.item}`);
        }
    },
    {
        name: 'deposit',
        description: 'Put items into a chest. With no item, stores everything except tools, armour, food and stations.',
        params: {
            type: 'object',
            properties: {
                item: { type: 'string', 'x-kind': 'item' },
                count: { type: 'integer', minimum: 1, maximum: 2304 },
                chest: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } }, required: ['x', 'y', 'z'] }
            }
        },
        timeoutMs: 300000,
        async run(ctx, a, signal) {
            let target = a.chest;
            if (!target && ctx.memory) {
                const base = ctx.memory.getBaseChests()[0];
                if (base && !L.findBlocks(ctx, CONTAINERS, 32, 1).length) target = base.position;
            }
            const opened = await openContainerAt(ctx, target, signal);
            if (!opened.ok) return opened;
            const { window, block } = opened.data;
            const stored = {};
            try {
                const items = ctx.bot.inventory.items().filter(i => (a.item ? i.name === a.item : !KEEP.test(i.name)));
                let left = a.count || Infinity;
                for (const it of items) {
                    check(signal);
                    if (left <= 0) break;
                    const n = Math.min(it.count, left);
                    try {
                        await window.deposit(it.type, null, n);
                        stored[it.name] = (stored[it.name] || 0) + n;
                        left -= n;
                    } catch (error) {
                        if (/full|space/i.test(error.message)) break;
                    }
                }
                remember(ctx, block, window);
            } finally {
                try { window.close(); } catch (_) { /* ignore */ }
            }
            const total = Object.values(stored).reduce((s, n) => s + n, 0);
            if (!total) return fail(a.item ? CODES.MISSING_ITEM : CODES.FAILED, a.item ? `no ${a.item} to store` : 'nothing was stored (chest full or nothing to store)');
            return ok({ stored, chest: L.fmt(block.position) }, `stored ${total} items`);
        }
    },
    {
        name: 'scan_chests',
        description: 'Open every chest within range and remember what is inside, so items can be found later.',
        params: { type: 'object', properties: { radius: { type: 'number', default: 16, minimum: 2, maximum: 32 } } },
        timeoutMs: 300000,
        async run(ctx, a, signal) {
            const blocks = L.findBlocks(ctx, CONTAINERS, a.radius, 24);
            const seen = [];
            for (const block of blocks) {
                check(signal);
                const opened = await openContainerAt(ctx, block.position, signal);
                if (!opened.ok) continue;
                const contents = remember(ctx, opened.data.block, opened.data.window);
                try { opened.data.window.close(); } catch (_) { /* ignore */ }
                seen.push({ chest: L.fmt(block.position), contents: summarize(contents) });
                await sleep(200, signal);
            }
            return ok({ chests: seen }, `scanned ${seen.length} chests`);
        }
    },
    {
        name: 'find_item',
        description: 'Look up where an item is: inventory and remembered chests. Does not move.',
        params: { type: 'object', properties: { item: { type: 'string', 'x-kind': 'item' } }, required: ['item'] },
        timeoutMs: 5000,
        async run(ctx, a) {
            const chests = ctx.world.chests().filter(c => c.contents[a.item]).map(c => ({ chest: c.position, count: c.contents[a.item], distance: Math.round(c.distance) }));
            return ok({ inventory: L.count(ctx.bot, a.item), chests });
        }
    },
    {
        name: 'give_to_player',
        description: 'Walk to a player and hand over items by dropping them at their feet. Defaults to whoever gave the order.',
        params: {
            type: 'object',
            properties: { item: { type: 'string', 'x-kind': 'item' }, count: { type: 'integer', default: 1, minimum: 1, maximum: 2304 }, player: { type: 'string' } },
            required: ['item']
        },
        timeoutMs: 300000,
        async run(ctx, a, signal) {
            const bot = ctx.bot;
            const name = a.player || ctx.source;
            const have = L.count(bot, a.item);
            if (have <= 0) return fail(CODES.MISSING_ITEM, `no ${a.item} to give`, { missing: [{ item: a.item, count: a.count }] });
            const entity = bot.players[name]?.entity;
            if (!entity) return fail(CODES.NOT_FOUND, `cannot see player ${name}`);
            const r = await L.travelTo(ctx, entity.position, 2.5, signal);
            if (!r.ok) return r;
            await bot.lookAt(entity.position.offset(0, 1.2, 0), true);
            const n = Math.min(have, a.count);
            await bot.toss(ctx.mcData.itemsByName[a.item].id, null, n);
            return ok({ given: n, to: name }, `gave ${n} ${a.item} to ${name}`);
        }
    },
    {
        name: 'equip',
        description: 'Hold an item, or put on armour / a shield.',
        params: {
            type: 'object',
            properties: { item: { type: 'string', 'x-kind': 'item' }, slot: { type: 'string', enum: ['hand', 'off-hand', 'head', 'torso', 'legs', 'feet'], default: 'hand' } },
            required: ['item']
        },
        timeoutMs: 10000,
        async run(ctx, a) {
            const item = L.findItem(ctx.bot, a.item);
            if (!item) return fail(CODES.MISSING_ITEM, `no ${a.item} in inventory`, { missing: [{ item: a.item, count: 1 }] });
            let slot = a.slot;
            if (slot === 'hand') {
                if (/_helmet$/.test(a.item)) slot = 'head';
                else if (/_chestplate$|^elytra$/.test(a.item)) slot = 'torso';
                else if (/_leggings$/.test(a.item)) slot = 'legs';
                else if (/_boots$/.test(a.item)) slot = 'feet';
                else if (a.item === 'shield') slot = 'off-hand';
            }
            await ctx.bot.equip(item, slot);
            return ok({ slot });
        }
    },
    {
        name: 'drop',
        description: 'Drop some of one item on the ground.',
        params: {
            type: 'object',
            properties: { item: { type: 'string', 'x-kind': 'item' }, count: { type: 'integer', default: 1, minimum: 1, maximum: 2304 } },
            required: ['item']
        },
        timeoutMs: 10000,
        async run(ctx, a) {
            const have = L.count(ctx.bot, a.item);
            if (!have) return fail(CODES.MISSING_ITEM, `no ${a.item}`);
            const n = Math.min(have, a.count);
            await ctx.bot.toss(ctx.mcData.itemsByName[a.item].id, null, n);
            return ok({ dropped: n });
        }
    }
];
