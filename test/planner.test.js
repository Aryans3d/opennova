const test = require('node:test');
const assert = require('node:assert');
const { AcquirePlanner } = require('../src/planner/acquire');

const VERSION = '1.21.11';
const mcData = require('minecraft-data')(VERSION);
const planner = new AcquirePlanner(mcData);

/** Execute a plan against a fake inventory, checking every step is feasible when reached. */
function simulate(plan, inventory) {
    const inv = new Map(Object.entries(inventory));
    const get = k => inv.get(k) || 0;
    for (const step of plan.steps) {
        const a = step.args;
        if (step.skill === 'mine_block') {
            const tool = planner.toolFor(a.blocks[0]);
            if (tool.rank > 0) assert.ok(tool.tools.some(t => get(t) > 0), `need tool for ${a.blocks[0]}, have ${[...inv.keys()]}`);
            inv.set(a.item, Math.max(get(a.item), a.until));
        } else if (step.skill === 'kill_for_loot') {
            inv.set(a.item, Math.max(get(a.item), a.until));
        } else if (step.skill === 'withdraw') {
            inv.set(a.item, get(a.item) + a.count);
        } else if (step.skill === 'craft') {
            const recipe = planner.recipes.get(a.item).find(r => {
                const times = Math.ceil(a.count / r.resultCount);
                return [...r.ingredients].every(([ing, n]) => get(ing) >= n * times);
            });
            assert.ok(recipe, `cannot craft ${a.count} ${a.item} with ${JSON.stringify([...inv])}`);
            if (recipe.needsTable) assert.ok(get('crafting_table') > 0, `need crafting table for ${a.item}`);
            const times = Math.ceil(a.count / recipe.resultCount);
            for (const [ing, n] of recipe.ingredients) inv.set(ing, get(ing) - n * times);
            inv.set(a.item, get(a.item) + times * recipe.resultCount);
        } else if (step.skill === 'smelt') {
            assert.ok(get('furnace') > 0, 'need furnace');
            assert.ok(get(a.input) >= a.count, `need ${a.count} ${a.input}`);
            assert.ok(get(a.fuel) >= a.fuelCount, `need ${a.fuelCount} ${a.fuel}`);
            inv.set(a.input, get(a.input) - a.count);
            inv.set(a.fuel, get(a.fuel) - a.fuelCount);
            inv.set(a.output, get(a.output) + a.count);
        } else {
            assert.fail(`unknown step ${step.skill}`);
        }
        for (const [k, v] of inv) assert.ok(v >= 0, `${k} went negative`);
    }
    return inv;
}

test('nothing to do when already held', () => {
    const plan = planner.plan([{ item: 'stick', count: 2 }], { inventory: { stick: 5 } });
    assert.ok(plan.ok);
    assert.strictEqual(plan.steps.length, 0);
});

test('sticks from planks in inventory need no gathering', () => {
    const plan = planner.plan([{ item: 'stick', count: 4 }], { inventory: { oak_planks: 2 } });
    assert.ok(plan.ok);
    assert.deepStrictEqual(plan.steps.map(s => s.skill), ['craft']);
});

test('wooden pickaxe from nothing', () => {
    const plan = planner.plan([{ item: 'wooden_pickaxe', count: 1 }], { inventory: {} });
    assert.ok(plan.ok, JSON.stringify(plan.missing));
    const inv = simulate(plan, {});
    assert.ok(inv.get('wooden_pickaxe') >= 1);
    // all log gathering hoisted into one trip
    assert.strictEqual(plan.steps.filter(s => s.skill === 'mine_block').length, 1);
});

test('iron pickaxe from nothing is complete and feasible in order', () => {
    const plan = planner.plan([{ item: 'iron_pickaxe', count: 1 }], { inventory: {} });
    assert.ok(plan.ok, JSON.stringify(plan.missing));
    const inv = simulate(plan, {});
    assert.ok(inv.get('iron_pickaxe') >= 1);
    const skills = plan.steps.map(s => `${s.skill}:${s.args.item || s.args.output}`);
    assert.ok(skills.includes('smelt:iron_ingot'));
    assert.ok(skills.includes('craft:stone_pickaxe'), 'stone pickaxe needed for iron ore');
    assert.ok(plan.steps.length <= 20, `plan too long: ${plan.steps.length}`);
});

test('diamond pickaxe from nothing', () => {
    const plan = planner.plan([{ item: 'diamond_pickaxe', count: 1 }], { inventory: {} });
    assert.ok(plan.ok, JSON.stringify(plan.missing));
    const inv = simulate(plan, {});
    assert.ok(inv.get('diamond_pickaxe') >= 1);
    assert.ok(plan.steps.some(s => s.skill === 'craft' && s.args.item === 'iron_pickaxe'), 'iron pickaxe needed for diamond ore');
});

test('uses a known chest instead of gathering', () => {
    const world = { chests: () => [{ id: 'c1', position: { x: 1, y: 64, z: 1 }, distance: 5, contents: { iron_ingot: 10 } }] };
    const plan = planner.plan([{ item: 'iron_ingot', count: 3 }], { inventory: {}, world });
    assert.ok(plan.ok);
    assert.deepStrictEqual(plan.steps.map(s => s.skill), ['withdraw']);
    assert.strictEqual(plan.steps[0].args.count, 3);
});

test('partial chest is topped up from another source', () => {
    const world = { chests: () => [{ id: 'c1', position: { x: 1, y: 64, z: 1 }, distance: 5, contents: { diamond: 3 } }] };
    const plan = planner.plan([{ item: 'diamond', count: 5 }], { inventory: { iron_pickaxe: 1 }, world });
    assert.ok(plan.ok, JSON.stringify(plan.missing));
    const inv = simulate(plan, { iron_pickaxe: 1 });
    assert.ok(inv.get('diamond') >= 5);
    assert.strictEqual(plan.steps.find(s => s.skill === 'withdraw').args.count, 3);
    assert.ok(plan.steps.some(s => s.skill === 'mine_block'));
});

test('explains the raw item that blocks a recipe', () => {
    const plan = planner.plan([{ item: 'bread', count: 1 }], { inventory: {} });
    assert.strictEqual(plan.ok, false);
    assert.match(plan.missing[0].reason, /wheat/);
    const withFarm = planner.plan([{ item: 'bread', count: 1 }], { inventory: {}, world: { nearest: b => (b.includes('wheat') ? 10 : null) } });
    assert.ok(withFarm.ok, JSON.stringify(withFarm.missing));
});

test('reuses a nearby crafting table and furnace', () => {
    const world = { hasStation: () => true };
    const plan = planner.plan([{ item: 'iron_ingot', count: 2 }], { inventory: { raw_iron: 2, coal: 1 }, world });
    assert.ok(plan.ok);
    assert.deepStrictEqual(plan.steps.map(s => s.skill), ['smelt']);
});

test('prefers the wood type that is known nearby', () => {
    const world = { nearest: blocks => (blocks.includes('birch_log') ? 6 : null) };
    const plan = planner.plan([{ item: 'crafting_table', count: 1 }], { inventory: {}, world });
    assert.ok(plan.ok);
    assert.ok(plan.steps[0].args.blocks.includes('birch_log'), JSON.stringify(plan.steps[0]));
    simulate(plan, {});
});

test('sibling ingredients do not steal from each other', () => {
    // pickaxe needs 3 planks + 2 sticks (sticks need 2 planks): 4 planks is not enough.
    const plan = planner.plan([{ item: 'wooden_pickaxe', count: 1 }], { inventory: { oak_planks: 4, crafting_table: 1 } });
    assert.ok(plan.ok);
    const inv = simulate(plan, { oak_planks: 4, crafting_table: 1 });
    assert.ok(inv.get('wooden_pickaxe') >= 1);
});

test('several goals at once', () => {
    const plan = planner.plan([{ item: 'stone_pickaxe', count: 1 }, { item: 'stone_axe', count: 1 }, { item: 'torch', count: 8 }], { inventory: {} });
    assert.ok(plan.ok, JSON.stringify(plan.missing));
    const inv = simulate(plan, {});
    assert.ok(inv.get('stone_pickaxe') >= 1 && inv.get('stone_axe') >= 1 && inv.get('torch') >= 8);
});

test('unknown and unobtainable items are reported, not thrown', () => {
    const a = planner.plan([{ item: 'not_a_thing', count: 1 }], { inventory: {} });
    assert.strictEqual(a.ok, false);
    assert.strictEqual(a.missing[0].reason, 'unknown item');
    const b = planner.plan([{ item: 'bedrock', count: 1 }], { inventory: {} });
    assert.strictEqual(b.ok, false);
});

test('planning is fast', () => {
    const t = process.hrtime.bigint();
    for (const item of ['iron_pickaxe', 'diamond_pickaxe', 'bread', 'shield', 'bucket', 'white_bed', 'iron_chestplate', 'furnace', 'chest', 'torch']) {
        planner.plan([{ item, count: 1 }], { inventory: {} });
    }
    const ms = Number(process.hrtime.bigint() - t) / 1e6;
    assert.ok(ms < 1500, `10 plans took ${ms.toFixed(0)}ms`);
});
