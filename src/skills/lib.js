/**
 * Shared low-level helpers used by skill definitions.
 * Everything here is abortable and returns result objects or throws AbortError.
 */

const { goals } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');
const { ok, fail, check, sleep, abortable, CODES } = require('../core/result');
const WORLD_COSTS = require('../planner/data/world-costs.json');

const LEG = 56;                 // max blocks per pathfinding leg
const HOSTILE = new Set(WORLD_COSTS.mobs.hostile);
const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, 1], [-1, -1], [1, -1]];

function stopMoving(bot) {
    try { bot.pathfinder.setGoal(null); } catch (_) { /* ignore */ }
    try { bot.clearControlStates(); } catch (_) { /* ignore */ }
}

function stopAll(bot) {
    stopMoving(bot);
    try { bot.stopDigging(); } catch (_) { /* ignore */ }
    try { if (bot.pvp) bot.pvp.stop(); } catch (_) { /* ignore */ }
}

/** One pathfinder run, abortable, with a wall-clock cap. */
async function pathTo(bot, goal, signal, timeoutMs = 45000) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => { stopMoving(bot); reject(new Error('path timeout')); }, timeoutMs);
    });
    try {
        await abortable(Promise.race([bot.pathfinder.goto(goal), timeout]), signal, () => stopMoving(bot));
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Travel to a position, splitting long trips into legs so the A* search
 * never has to plan through unloaded chunks. Detects lack of progress.
 * @param {{x:number,y?:number,z:number}} pos  y omitted = any height
 */
async function travelTo(ctx, pos, range, signal) {
    const bot = ctx.bot;
    const dist3 = () => {
        const p = bot.entity.position;
        const dy = pos.y === undefined || pos.y === null ? 0 : pos.y - p.y;
        return Math.sqrt((pos.x - p.x) ** 2 + dy ** 2 + (pos.z - p.z) ** 2);
    };
    let last = dist3();
    let stalls = 0;
    let lastError = null;
    for (let leg = 0; leg < 400; leg++) {
        check(signal);
        const d = dist3();
        if (d <= range + 0.75) return ok({ distance: d });
        const p = bot.entity.position;
        const dx = pos.x - p.x, dz = pos.z - p.z;
        const horiz = Math.hypot(dx, dz);
        let goal;
        if (horiz > LEG * 1.5) {
            const f = LEG / horiz;
            goal = new goals.GoalNearXZ(p.x + dx * f, p.z + dz * f, 4);
        } else if (pos.y === undefined || pos.y === null) {
            goal = new goals.GoalNearXZ(pos.x, pos.z, Math.max(1, range));
        } else {
            goal = new goals.GoalNear(pos.x, pos.y, pos.z, Math.max(1, range));
        }
        try {
            await pathTo(bot, goal, signal);
            lastError = null;
        } catch (error) {
            if (error.name === 'AbortError') throw error;
            lastError = error;
        }
        const now = dist3();
        if (now > last - 2) {
            if (++stalls >= 3) {
                return fail(CODES.NO_PATH, `could not get closer than ${now.toFixed(0)} blocks${lastError ? ` (${lastError.message})` : ''}`, { distance: now });
            }
            await sleep(250, signal);
        } else {
            stalls = 0;
        }
        last = now;
    }
    return fail(CODES.NO_PATH, 'gave up after too many legs');
}

async function gotoBlock(ctx, block, signal, reach = 3.5) {
    const bot = ctx.bot;
    if (bot.entity.position.distanceTo(block.position.offset(0.5, 0.5, 0.5)) <= reach) return ok();
    const far = await travelTo(ctx, block.position, 12, signal);
    if (!far.ok) return far;
    try {
        await pathTo(bot, new goals.GoalGetToBlock(block.position.x, block.position.y, block.position.z), signal, 30000);
        return ok();
    } catch (error) {
        if (error.name === 'AbortError') throw error;
        return fail(CODES.NO_PATH, `cannot reach block at ${fmt(block.position)}: ${error.message}`);
    }
}

function fmt(p) {
    return `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
}

function inventoryCounts(bot) {
    const out = {};
    for (const item of bot.inventory.items()) out[item.name] = (out[item.name] || 0) + item.count;
    return out;
}

function count(bot, name) {
    let n = 0;
    for (const item of bot.inventory.items()) if (item.name === name) n += item.count;
    return n;
}

function findItem(bot, name) {
    return bot.inventory.items().find(i => i.name === name) || null;
}

function isHostile(entity) {
    if (!entity || !entity.name) return false;
    return entity.type === 'hostile' || HOSTILE.has(entity.name);
}

function nearbyEntities(bot, filter, maxDistance = 32) {
    const me = bot.entity.position;
    const out = [];
    for (const e of Object.values(bot.entities)) {
        if (e === bot.entity || !e.position || !filter(e)) continue;
        const d = e.position.distanceTo(me);
        if (d <= maxDistance) out.push({ entity: e, distance: d });
    }
    return out.sort((a, b) => a.distance - b.distance);
}

/** Find loaded blocks by name, nearest first. */
function findBlocks(ctx, names, maxDistance = 64, max = 24) {
    const ids = names.map(n => ctx.mcData.blocksByName[n]).filter(Boolean).map(b => b.id);
    if (!ids.length) return [];
    const positions = ctx.bot.findBlocks({ matching: ids, maxDistance, count: max });
    return positions.map(p => ctx.bot.blockAt(p)).filter(Boolean);
}

/** Digging here would release a liquid or drop the bot into one. */
function isUnsafeToDig(bot, block) {
    const p = block.position;
    for (const off of [[0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0]]) {
        const b = bot.blockAt(p.offset(off[0], off[1], off[2]));
        if (b && (b.name === 'lava' || b.name === 'flowing_lava')) return 'lava next to it';
    }
    const above = bot.blockAt(p.offset(0, 1, 0));
    if (above && (above.name === 'sand' || above.name === 'gravel' || above.name === 'red_sand')) {
        const me = bot.entity.position;
        if (Math.abs(me.x - p.x) < 1.5 && Math.abs(me.z - p.z) < 1.5 && me.y < p.y) return 'falling block above';
    }
    return null;
}

async function equipToolFor(ctx, block) {
    const bot = ctx.bot;
    const need = ctx.planner.toolFor(block.name);
    if (need.rank > 0 && !need.tools.some(t => count(bot, t) > 0)) {
        return fail(CODES.NEED_TOOL_TIER, `${block.name} needs ${need.tools[0]} or better`, { tool: need.tools[0], block: block.name });
    }
    try {
        if (bot.tool) await bot.tool.equipForBlock(block, { requireHarvest: need.rank > 0 });
    } catch (_) {
        if (need.rank > 0) {
            const tool = need.tools.map(t => findItem(bot, t)).filter(Boolean).pop();
            if (tool) await bot.equip(tool, 'hand');
        }
    }
    return ok();
}

/** Walk onto dropped items near a position. */
async function collectDrops(ctx, center, radius, signal, itemName = null) {
    const bot = ctx.bot;
    let collected = 0;
    for (let i = 0; i < 12; i++) {
        check(signal);
        const drops = nearbyEntities(bot, e => {
            if (e.name !== 'item' || !e.position) return false;
            if (center && e.position.distanceTo(center) > radius) return false;
            if (itemName && typeof e.getDroppedItem === 'function') {
                const it = e.getDroppedItem();
                if (it && it.name !== itemName) return false;
            }
            return true;
        }, center ? 64 : radius);
        if (!drops.length) break;
        const target = drops[0].entity;
        try {
            await pathTo(bot, new goals.GoalNear(target.position.x, target.position.y, target.position.z, 0.5), signal, 8000);
            collected++;
        } catch (error) {
            if (error.name === 'AbortError') throw error;
            break;
        }
        await sleep(150, signal);
    }
    return collected;
}

async function digBlock(ctx, block, signal) {
    const bot = ctx.bot;
    const unsafe = isUnsafeToDig(bot, block);
    if (unsafe) return fail(CODES.UNSAFE, `not digging ${block.name} at ${fmt(block.position)}: ${unsafe}`);
    if (ctx.permissions && ctx.permissions.isProtected(block.position)) {
        return fail(CODES.FORBIDDEN, `block at ${fmt(block.position)} is inside protected region`);
    }
    const reach = await gotoBlock(ctx, block, signal);
    if (!reach.ok) return reach;
    const fresh = bot.blockAt(block.position);
    if (!fresh || fresh.name === 'air' || fresh.type !== block.type) return ok({ already: true });
    const tool = await equipToolFor(ctx, fresh);
    if (!tool.ok) return tool;
    try {
        await bot.lookAt(fresh.position.offset(0.5, 0.5, 0.5), true);
        await abortable(bot.dig(fresh), signal, () => { try { bot.stopDigging(); } catch (_) { /* ignore */ } });
    } catch (error) {
        if (error.name === 'AbortError') throw error;
        return fail(CODES.BLOCKED, `dig failed: ${error.message}`);
    }
    return ok();
}

/** Place an item from the inventory on a free spot next to the bot. Returns the placed block. */
async function placeNearby(ctx, itemName, signal) {
    const bot = ctx.bot;
    const item = findItem(bot, itemName);
    if (!item) return fail(CODES.MISSING_ITEM, `no ${itemName} to place`, { item: itemName });
    const base = bot.entity.position.floored();
    const spots = [];
    for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) for (let dy = -1; dy <= 1; dy++) {
        if (dx === 0 && dz === 0) continue;
        spots.push([Math.abs(dx) + Math.abs(dz) + Math.abs(dy), dx, dy, dz]);
    }
    spots.sort((a, b) => a[0] - b[0]);
    for (const [, dx, dy, dz] of spots) {
        check(signal);
        const ref = bot.blockAt(base.offset(dx, dy - 1, dz));
        const target = bot.blockAt(base.offset(dx, dy, dz));
        const above = bot.blockAt(base.offset(dx, dy + 1, dz));
        if (!ref || !target || ref.boundingBox !== 'block' || target.name !== 'air') continue;
        if (!above || above.boundingBox === 'block') continue; // need headroom to interact
        if (ctx.permissions && ctx.permissions.isProtected(target.position)) continue;
        try {
            await bot.equip(item, 'hand');
            await bot.lookAt(ref.position.offset(0.5, 1, 0.5), true);
            await bot.placeBlock(ref, new Vec3(0, 1, 0));
        } catch (error) {
            continue;
        }
        await sleep(150, signal);
        const placed = bot.blockAt(target.position);
        if (placed && placed.name === itemName) return ok({ block: placed });
    }
    return fail(CODES.BLOCKED, `no free spot to place ${itemName}`);
}

/** Find or place a station block (crafting_table, furnace). Remembers what it placed. */
async function getStation(ctx, name, signal) {
    const found = findBlocks(ctx, [name], 32, 4);
    for (const block of found) {
        const r = await gotoBlock(ctx, block, signal);
        if (r.ok) return ok({ block });
    }
    if (!count(ctx.bot, name)) {
        return fail(CODES.NEED_STATION, `need a ${name}: none nearby and none in inventory`, { station: name });
    }
    const placed = await placeNearby(ctx, name, signal);
    if (!placed.ok) return placed;
    ctx.session.placedStations.push({ name, position: placed.data.block.position.clone() });
    return placed;
}

/** Pick up stations this session placed (so the next craft elsewhere still has them). */
async function reclaimStations(ctx, signal) {
    const list = ctx.session.placedStations.splice(0);
    for (const s of list) {
        const block = ctx.bot.blockAt(s.position);
        if (!block || block.name !== s.name) continue;
        if (ctx.bot.entity.position.distanceTo(s.position) > 40) continue;
        const r = await digBlock(ctx, block, signal);
        if (r.ok) {
            await sleep(300, signal);
            await collectDrops(ctx, s.position, 4, signal);
        }
    }
}

/**
 * Look for blocks that are not in view: walk outward (surface things) or
 * descend to the block's usual level and tunnel (ores), rescanning each leg.
 * @returns block or null
 */
async function searchForBlocks(ctx, names, signal, state) {
    const bot = ctx.bot;
    const level = names.map(n => WORLD_COSTS.level[n]).find(v => v !== undefined);
    state.leg = (state.leg || 0) + 1;
    if (state.leg > (level === undefined ? 8 : 14)) return null;
    const p = bot.entity.position;
    if (state.dir === undefined) state.dir = Math.floor(Math.random() * 4);
    // Change heading every third leg so the search fans out instead of running in a line.
    if (state.leg % 3 === 0) state.dir = (state.dir + 1) % DIRS.length;
    const [dx, dz] = DIRS[state.dir % DIRS.length];

    if (level !== undefined && Math.abs(p.y - level) > 6 && bot.game.dimension === 'overworld') {
        // Descend diagonally (never straight down): the pathfinder digs a staircase.
        const drop = Math.max(-24, Math.min(24, level - p.y));
        const run = Math.max(8, Math.abs(drop));
        ctx.logger.debug(`search: descending toward y=${level} for ${names[0]}`);
        try {
            await pathTo(bot, new goals.GoalNear(p.x + dx * run, p.y + drop, p.z + dz * run, 2), signal, 90000);
        } catch (error) {
            if (error.name === 'AbortError') throw error;
            state.dir = (state.dir + 1) % 4;
        }
    } else {
        const stride = level === undefined ? 40 : 16;
        const target = level === undefined
            ? new goals.GoalNearXZ(p.x + dx * stride, p.z + dz * stride, 3)
            : new goals.GoalNear(p.x + dx * stride, p.y, p.z + dz * stride, 2);
        try {
            await pathTo(bot, target, signal, 60000);
        } catch (error) {
            if (error.name === 'AbortError') throw error;
            state.dir = (state.dir + 1) % 4;
        }
    }
    const found = findBlocks(ctx, names, 48, 8);
    return found[0] || null;
}

module.exports = {
    goals, Vec3, LEG,
    stopMoving, stopAll, pathTo, travelTo, gotoBlock, fmt,
    inventoryCounts, count, findItem, isHostile, nearbyEntities, findBlocks,
    isUnsafeToDig, equipToolFor, collectDrops, digBlock, placeNearby,
    getStation, reclaimStations, searchForBlocks
};
