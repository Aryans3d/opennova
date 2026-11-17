const { ok, fail, check, sleep, CODES } = require('../../core/result');
const L = require('../lib');
const FUEL = require('../../planner/data/fuel.json');
const SMELTING = require('../../planner/data/smelting.json');

function fuelValue(name) {
    if (FUEL[name]) return FUEL[name];
    if (/_planks$/.test(name)) return FUEL._planks;
    if (/(_log|_stem|_wood)$/.test(name)) return FUEL._log;
    return 0;
}

module.exports = [
    {
        name: 'craft',
        description: 'Craft an item from ingredients already in the inventory. Uses a nearby crafting table or places one from the inventory when the recipe needs it. `count` is the number of items wanted.',
        params: {
            type: 'object',
            properties: { item: { type: 'string', 'x-kind': 'item' }, count: { type: 'integer', default: 1, minimum: 1, maximum: 576 } },
            required: ['item']
        },
        timeoutMs: 120000,
        async run(ctx, a, signal) {
            const bot = ctx.bot;
            const id = ctx.mcData.itemsByName[a.item].id;
            const known = ctx.planner.recipes.get(a.item);
            if (!known) return fail(CODES.NOT_FOUND, `${a.item} has no crafting recipe`);

            // Is there a recipe we can afford (ignoring the table for now)?
            let recipes = bot.recipesFor(id, null, a.count, true);
            if (!recipes.length) {
                const have = L.inventoryCounts(bot);
                const best = known
                    .map(r => {
                        const times = Math.ceil(a.count / r.resultCount);
                        const missing = [...r.ingredients].map(([item, n]) => ({ item, count: n * times - (have[item] || 0) })).filter(m => m.count > 0);
                        return { missing, total: missing.reduce((s, m) => s + m.count, 0) };
                    })
                    .sort((x, y) => x.total - y.total)[0];
                return fail(CODES.MISSING_ITEM, `cannot craft ${a.count} ${a.item}: missing ${best.missing.map(m => `${m.count} ${m.item}`).join(', ')}`, { missing: best.missing });
            }

            let table = null;
            if (recipes.every(r => r.requiresTable)) {
                const station = await L.getStation(ctx, 'crafting_table', signal);
                if (!station.ok) return station;
                table = station.data.block;
                recipes = bot.recipesFor(id, null, a.count, table);
                if (!recipes.length) return fail(CODES.FAILED, `recipe for ${a.item} not available at the table`);
            }
            const recipe = recipes.find(r => !r.requiresTable) || recipes[0];
            const times = Math.ceil(a.count / (recipe.result?.count || 1));
            const before = L.count(bot, a.item);
            check(signal);
            try {
                await bot.craft(recipe, times, recipe.requiresTable ? table : null);
            } catch (error) {
                return fail(CODES.FAILED, `crafting ${a.item} failed: ${error.message}`);
            }
            await sleep(100, signal);
            const made = L.count(bot, a.item) - before;
            return ok({ item: a.item, made, have: L.count(bot, a.item) }, `crafted ${made} ${a.item}`);
        }
    },
    {
        name: 'smelt',
        description: 'Smelt or cook items in a furnace (a nearby one, or one placed from the inventory). Waits for the result and takes it out.',
        params: {
            type: 'object',
            properties: {
                input: { type: 'string', 'x-kind': 'item', description: 'item to put in, e.g. raw_iron' },
                output: { type: 'string', 'x-kind': 'item' },
                count: { type: 'integer', default: 1, minimum: 1, maximum: 64 },
                fuel: { type: 'string', 'x-kind': 'item' },
                fuelCount: { type: 'integer', minimum: 1, maximum: 64 }
            },
            required: ['input']
        },
        timeoutMs: 900000,
        async run(ctx, a, signal) {
            const bot = ctx.bot;
            const d = ctx.mcData;
            if (L.count(bot, a.input) < a.count) {
                return fail(CODES.MISSING_ITEM, `need ${a.count} ${a.input}, have ${L.count(bot, a.input)}`, { missing: [{ item: a.input, count: a.count - L.count(bot, a.input) }] });
            }
            // Choose fuel.
            let fuel = a.fuel && L.count(bot, a.fuel) > 0 ? a.fuel : null;
            if (!fuel) {
                const held = Object.keys(L.inventoryCounts(bot))
                    .filter(n => n !== a.input && fuelValue(n) > 0)
                    .sort((x, y) => fuelValue(y) - fuelValue(x));
                fuel = held.find(n => L.count(bot, n) * fuelValue(n) >= a.count) || held[0] || null;
            }
            if (!fuel) return fail(CODES.MISSING_ITEM, 'no fuel (coal, charcoal, planks or logs) in inventory', { missing: [{ item: 'coal', count: Math.ceil(a.count / 8) }] });
            const fuelCount = Math.min(L.count(bot, fuel), a.fuelCount || Math.ceil(a.count / fuelValue(fuel)));
            if (fuelCount * fuelValue(fuel) < a.count) {
                return fail(CODES.MISSING_ITEM, `not enough ${fuel} to smelt ${a.count}`, { missing: [{ item: fuel, count: Math.ceil(a.count / fuelValue(fuel)) - fuelCount }] });
            }

            const station = await L.getStation(ctx, 'furnace', signal);
            if (!station.ok) return station;
            let furnace;
            try {
                furnace = await bot.openFurnace(station.data.block);
            } catch (error) {
                return fail(CODES.BLOCKED, `cannot open furnace: ${error.message}`);
            }
            let taken = 0;
            try {
                if (furnace.outputItem()) await furnace.takeOutput().catch(() => {});
                const existingInput = furnace.inputItem();
                if (existingInput && existingInput.name !== a.input) await furnace.takeInput().catch(() => {});
                await furnace.putFuel(d.itemsByName[fuel].id, null, fuelCount);
                await furnace.putInput(d.itemsByName[a.input].id, null, a.count);
                // 10 s per item, plus slack for a cold furnace.
                const deadline = Date.now() + a.count * 11000 + 20000;
                while (taken < a.count && Date.now() < deadline) {
                    check(signal);
                    await sleep(1000, signal);
                    const out = furnace.outputItem();
                    const inputLeft = furnace.inputItem();
                    // Collect when everything is cooked, or in batches so a long job is not lost if interrupted.
                    if (out && (!inputLeft || out.count >= 16)) {
                        const got = await furnace.takeOutput().catch(() => null);
                        if (got) taken += got.count;
                    } else if (!out && !inputLeft) {
                        break; // nothing inside and nothing coming
                    }
                }
                const rest = furnace.outputItem();
                if (rest) {
                    const got = await furnace.takeOutput().catch(() => null);
                    if (got) taken += got.count;
                }
                // Do not leave raw input behind when we give up.
                if (taken < a.count && furnace.inputItem()) await furnace.takeInput().catch(() => {});
            } finally {
                try { furnace.close(); } catch (_) { /* ignore */ }
            }
            const output = a.output || Object.keys(SMELTING).find(o => Array.isArray(SMELTING[o]) && SMELTING[o].includes(a.input)) || 'result';
            if (taken < a.count) return fail(CODES.FAILED, `only ${taken}/${a.count} ${output} came out`, { smelted: taken });
            return ok({ output, smelted: taken }, `smelted ${taken} ${output}`);
        }
    },
    {
        name: 'place_block',
        description: 'Place a block from the inventory next to the bot.',
        params: { type: 'object', properties: { item: { type: 'string', 'x-kind': 'item' } }, required: ['item'] },
        timeoutMs: 30000,
        danger: 'world_edit',
        async run(ctx, a, signal) {
            const r = await L.placeNearby(ctx, a.item, signal);
            if (!r.ok) return r;
            return ok({ position: L.fmt(r.data.block.position) }, `placed ${a.item}`);
        }
    }
];

module.exports.fuelValue = fuelValue;
