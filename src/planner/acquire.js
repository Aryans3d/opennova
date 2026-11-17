/**
 * Acquire planner.
 *
 * Given goals like have(iron_pickaxe, 1) it returns an ordered list of skill
 * calls that reach them from the current inventory. It is a pure function of
 * (goals, inventory, world view): no bot, no I/O, no model.
 *
 * Algorithm: backward chaining over item sources (chest, craft, smelt, mine,
 * hunt). Candidate sources are ranked by a memoised cost estimate (seconds),
 * then committed against a simulated inventory with reservations so one
 * recipe's ingredients are never consumed by a sibling. Gather steps for the
 * same item are hoisted into a single earlier step to avoid repeat trips.
 */

const SMELTING = require('./data/smelting.json');
const FUEL = require('./data/fuel.json');
const WORLD_COSTS = require('./data/world-costs.json');

const TIERS = ['wooden', 'golden', 'stone', 'copper', 'iron', 'diamond', 'netherite'];
const NATURAL_OVERRIDES = new Set(['stone', 'clay', 'snow_block', 'melon', 'pumpkin', 'sandstone', 'red_sandstone', 'moss_block', 'bone_block', 'packed_ice', 'glowstone', 'mud']);
const UNNATURAL = /(_bed|_door|_slab|_stairs|_wall|_fence|_gate|_button|_pressure_plate|_sign|_carpet|_banner|_glass|_pane|_concrete|_terracotta|_wool|_candle|_shulker_box|rail|^tripwire$|^chest$|^furnace$|^barrel$|^anvil$|torch$|lantern$|^farmland$|^smooth_|^polished_|^chiseled_|^cut_|bricks?$|_planks$|^stripped_|^infested_|spawner$|^bedrock$|portal|command_block|^barrier$|^structure_|^jigsaw$|^light$|^budding_amethyst$|^reinforced_deepslate$|^trial_|^vault$)/;
const NEVER_HUNT = new Set(WORLD_COSTS.mobs.never);
const HOSTILE = new Set(WORLD_COSTS.mobs.hostile);
const MAX_DEPTH = 12;
const MAX_COUNT = 2304;

/** World view used when nothing is known. */
const NULL_WORLD = {
    nearest: () => null,
    hasStation: () => false,
    chests: () => [],
    nearestMob: () => null
};

class AcquirePlanner {
    constructor(mcData) {
        this.mcData = mcData;
        this._buildIndexes();
    }

    _buildIndexes() {
        const d = this.mcData;
        // item name -> [{ block, yield }]
        this.minedFrom = new Map();
        const add = (item, block, y) => {
            if (!d.itemsByName[item] || !d.blocksByName[block]) return;
            if (!this.minedFrom.has(item)) this.minedFrom.set(item, []);
            const list = this.minedFrom.get(item);
            if (!list.some(e => e.block === block)) list.push({ block, yield: y });
        };
        if (d.blockLoot) {
            for (const [blockName, loot] of Object.entries(d.blockLoot)) {
                const block = d.blocksByName[blockName];
                if (!block || !block.diggable) continue;
                const isLeaves = /leaves$/.test(blockName);
                for (const drop of loot.drops || []) {
                    if (drop.silkTouch) continue; // needs silk touch
                    const range = drop.stackSizeRange || [1, 1];
                    const avg = ((range[0] ?? 1) + (range[1] ?? range[0] ?? 1)) / 2 || 1;
                    let chance = drop.dropChance ?? 1;
                    // The data splits silk / no-silk variants 50:50; without silk touch the drop is certain.
                    if (drop.noSilkTouch) chance = 1;
                    // Loot data for leaves is unreliable; they are a poor source of anything but themselves.
                    if (isLeaves && drop.item !== blockName) chance = Math.min(chance, 0.04);
                    if (chance < 0.03) continue;
                    add(drop.item, blockName, chance * avg);
                }
            }
        } else {
            for (const block of d.blocksArray) {
                for (const id of block.drops || []) {
                    const item = d.items[typeof id === 'object' ? id.drop : id];
                    if (item) add(item.name, block.name, 1);
                }
            }
        }

        // item name -> [{ mob, yield }]
        this.huntedFrom = new Map();
        for (const [mob, loot] of Object.entries(d.entityLoot || {})) {
            for (const drop of loot.drops || []) {
                if (!d.itemsByName[drop.item]) continue;
                const range = drop.stackSizeRange || [1, 1];
                const avg = ((range[0] ?? 1) + (range[1] ?? 1)) / 2 || 1;
                const y = (drop.dropChance ?? 1) * avg;
                if (y < 0.2 || NEVER_HUNT.has(mob)) continue;
                if (!this.huntedFrom.has(drop.item)) this.huntedFrom.set(drop.item, []);
                this.huntedFrom.get(drop.item).push({ mob, yield: y });
            }
        }

        // item name -> [{ ingredients: Map<name, n>, resultCount, needsTable }]
        this.recipes = new Map();
        for (const [idStr, list] of Object.entries(d.recipes || {})) {
            const item = d.items[idStr];
            if (!item) continue;
            const out = [];
            const seen = new Set();
            for (const r of list) {
                const ing = new Map();
                let needsTable = false;
                const cell = c => {
                    const id = c && typeof c === 'object' ? c.id : c;
                    if (id === null || id === undefined || id < 0) return;
                    const it = d.items[id];
                    if (it) ing.set(it.name, (ing.get(it.name) || 0) + 1);
                };
                if (r.inShape) {
                    if (r.inShape.length > 2 || r.inShape.some(row => row.length > 2)) needsTable = true;
                    for (const row of r.inShape) for (const c of row) cell(c);
                } else if (r.ingredients) {
                    if (r.ingredients.length > 4) needsTable = true;
                    for (const c of r.ingredients) cell(c);
                }
                if (ing.size === 0 || ing.has(item.name)) continue;
                const key = [...ing.entries()].sort().map(e => e.join(':')).join(',');
                if (seen.has(key)) continue;
                seen.add(key);
                out.push({ ingredients: ing, resultCount: (r.result && r.result.count) || 1, needsTable });
            }
            if (out.length) this.recipes.set(item.name, out);
        }

        for (const [mob, drops] of Object.entries(WORLD_COSTS.extraLoot || {})) {
            for (const [item, y] of Object.entries(drops)) {
                if (!d.itemsByName[item]) continue;
                if (!this.huntedFrom.has(item)) this.huntedFrom.set(item, []);
                if (!this.huntedFrom.get(item).some(e => e.mob === mob)) this.huntedFrom.get(item).push({ mob, yield: y });
            }
        }

        this.fuelItems = [];
        for (const [name, per] of Object.entries(FUEL)) {
            if (name.startsWith('_comment')) continue;
            if (name === '_planks') {
                for (const it of d.itemsArray) if (/_planks$/.test(it.name)) this.fuelItems.push({ name: it.name, per });
            } else if (name === '_log') {
                for (const it of d.itemsArray) if (/(_log|_stem)$/.test(it.name) && !/stripped/.test(it.name)) this.fuelItems.push({ name: it.name, per });
            } else if (d.itemsByName[name]) {
                this.fuelItems.push({ name, per });
            }
        }
    }

    /**
     * Whether a block can be expected to exist in the world without a player
     * placing it. Player-made blocks (crafting tables, iron blocks, planks)
     * are only a mining source when one is actually known nearby.
     */
    isNatural(blockName) {
        if (NATURAL_OVERRIDES.has(blockName)) return true;
        if (this.recipes.has(blockName)) return false;
        return !UNNATURAL.test(blockName);
    }

    /** Lowest tool tier (and acceptable tools) needed to get drops from a block. */
    toolFor(blockName) {
        const block = this.mcData.blocksByName[blockName];
        if (!block || !block.harvestTools) return { rank: 0, tools: [] };
        const tools = Object.keys(block.harvestTools)
            .map(id => this.mcData.items[id])
            .filter(Boolean)
            .map(it => ({ name: it.name, rank: tierRank(it.name) }))
            .sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
        // Prefer wooden over golden at the same usefulness: golden is expensive.
        const preferred = tools.filter(t => !t.name.startsWith('golden_'));
        const list = preferred.length ? preferred.concat(tools.filter(t => t.name.startsWith('golden_'))) : tools;
        return { rank: list.length ? list[0].rank : 0, tools: list.map(t => t.name) };
    }

    /**
     * @param {Array<{item: string, count: number}>} goals
     * @param {{inventory: Record<string, number>, world?: object}} state
     * @returns {{ok: boolean, steps: object[], cost: number, missing: object[]}}
     */
    plan(goals, state) {
        const world = Object.assign({}, NULL_WORLD, state.world || {});
        const run = new PlanRun(this, world, state.inventory || {});
        const missing = [];
        for (const goal of goals) {
            const count = Math.max(1, Math.min(MAX_COUNT, Math.floor(goal.count || 1)));
            if (!this.mcData.itemsByName[goal.item]) {
                missing.push({ item: goal.item, count, reason: 'unknown item' });
                continue;
            }
            if (run.ensure(goal.item, count, 0, [])) {
                run.reserve(goal.item, count);
            } else {
                missing.push({ item: goal.item, count, reason: run.failReason || 'no way to obtain' , blockedOn: run.blockedOn });
            }
        }
        return {
            ok: missing.length === 0,
            steps: run.steps,
            cost: Math.round(run.steps.reduce((s, st) => s + (st.cost || 0), 0)),
            missing
        };
    }

    /** Short human/model-readable rendering of a plan. */
    static describe(plan) {
        if (!plan.steps.length) return plan.ok ? 'nothing to do' : 'no plan';
        return plan.steps.map((s, i) => `${i + 1}. ${describeStep(s)}`).join('\n');
    }
}

function describeStep(s) {
    const a = s.args;
    switch (s.skill) {
        case 'mine_block': return `mine ${a.blocks.slice(0, 3).join('/')} until ${a.until} ${a.item}`;
        case 'craft': return `craft ${a.count} ${a.item}`;
        case 'smelt': return `smelt ${a.count} ${a.input} -> ${a.output} (fuel ${a.fuel})`;
        case 'withdraw': return `withdraw ${a.count} ${a.item} from chest at ${a.chest.x},${a.chest.y},${a.chest.z}`;
        case 'kill_for_loot': return `hunt ${a.mobs.slice(0, 3).join('/')} until ${a.until} ${a.item}`;
        default: return `${s.skill} ${JSON.stringify(a)}`;
    }
}

function tierRank(toolName) {
    const prefix = toolName.split('_')[0];
    const i = TIERS.indexOf(prefix);
    return i === -1 ? 1 : i + 1;
}

class PlanRun {
    constructor(planner, world, inventory) {
        this.p = planner;
        this.world = world;
        this.inv = new Map(Object.entries(inventory).filter(([, n]) => n > 0));
        this.reserved = new Map();
        this.steps = [];
        this.stations = new Set();
        this.usedChests = new Map(); // chest id -> Map(item -> taken)
        this.memo = new Map();
        this.failReason = null;
        this.blockedOn = null;
    }

    avail(item) {
        return (this.inv.get(item) || 0) - (this.reserved.get(item) || 0);
    }
    reserve(item, n) { this.reserved.set(item, (this.reserved.get(item) || 0) + n); }
    unreserve(item, n) { this.reserved.set(item, Math.max(0, (this.reserved.get(item) || 0) - n)); }
    add(item, n) { this.inv.set(item, (this.inv.get(item) || 0) + n); this.memo.clear(); }
    take(item, n) { this.inv.set(item, (this.inv.get(item) || 0) - n); this.memo.clear(); }

    snapshot() {
        return {
            inv: new Map(this.inv), reserved: new Map(this.reserved), steps: this.steps.map(s => ({ ...s, args: { ...s.args } })),
            stations: new Set(this.stations),
            usedChests: new Map([...this.usedChests].map(([k, v]) => [k, new Map(v)]))
        };
    }
    restore(s) {
        this.inv = s.inv; this.reserved = s.reserved; this.steps = s.steps;
        this.stations = s.stations; this.usedChests = s.usedChests; this.memo.clear();
    }

    // ---------- cost estimation (no mutation) ----------

    estimate(item, count, depth = 0, stack = []) {
        const have = this.avail(item);
        if (have >= count) return 0;
        const short = count - have;
        const key = `${item}:${short}`;
        if (this.memo.has(key)) return this.memo.get(key);
        if (depth > MAX_DEPTH || stack.includes(item)) return Infinity;
        const next = stack.concat(item);
        let best = Infinity;
        for (const cand of this.candidates(item, short, depth, next)) best = Math.min(best, cand.cost);
        // Only cache results that were not cut off by the cycle guard higher up.
        if (best !== Infinity || stack.length === 0) this.memo.set(key, best);
        return best;
    }

    stationCost(name, depth, stack) {
        if (this.stations.has(name) || this.world.hasStation(name) || this.avail(name) > 0) return 0;
        return this.estimate(name, 1, depth + 1, stack);
    }

    fuelChoice(units, depth, stack, exclude) {
        // Prefer fuel already held.
        for (const f of this.p.fuelItems) {
            if (f.name === exclude) continue;
            const need = Math.ceil(units / f.per);
            if (this.avail(f.name) >= need) return { name: f.name, count: need, cost: 0 };
        }
        let best = null;
        for (const f of this.p.fuelItems) {
            if (f.name === exclude || f.per < 1) continue;
            const need = Math.ceil(units / f.per);
            const cost = this.estimate(f.name, this.avail(f.name) + need, depth + 1, stack);
            if (cost !== Infinity && (!best || cost < best.cost)) best = { name: f.name, count: need, cost };
        }
        return best;
    }

    mineGroup(item) {
        const sources = this.p.minedFrom.get(item);
        if (!sources || !sources.length) return null;
        const infos = sources.map(s => {
            const tool = this.p.toolFor(s.block);
            const dist = this.world.nearest([s.block]);
            return { ...s, tool, dist };
        }).filter(i => (i.dist !== null && i.dist !== undefined) || this.p.isNatural(i.block));
        if (!infos.length) return null;
        const known = infos.filter(i => i.dist !== null && i.dist !== undefined).sort((a, b) => a.dist - b.dist);
        const anchor = known[0] || infos.slice().sort((a, b) =>
            a.tool.rank - b.tool.rank || searchCost(a.block) - searchCost(b.block) || b.yield - a.yield)[0];
        const group = infos.filter(i => i.tool.rank <= anchor.tool.rank);
        const hardest = group.slice().sort((a, b) => b.tool.rank - a.tool.rank)[0];
        const y = anchor.yield || 1;
        const hardness = this.p.mcData.blocksByName[anchor.block].hardness ?? 1;
        const perBlock = 1.5 + Math.min(10, Math.max(0, hardness)) * 0.8;
        const search = known.length ? known[0].dist * 0.3 : searchCost(anchor.block);
        return { blocks: uniqueOrdered([anchor.block, ...group.map(g => g.block)]), tool: hardest.tool, yield: y, perBlock, search, known: known.length > 0 };
    }

    /** All ways to get `short` more of an item, each with an estimated cost. */
    candidates(item, short, depth, stack) {
        const out = [];

        for (const chest of this.world.chests() || []) {
            const taken = (this.usedChests.get(chest.id) || new Map()).get(item) || 0;
            const has = ((chest.contents || {})[item] || 0) - taken;
            if (has > 0) {
                const n = Math.min(has, short);
                const rest = n < short ? 40 : 0; // partial: something else must cover the remainder
                out.push({ type: 'chest', chest, n, cost: 4 + (chest.distance || 0) * 0.25 + rest });
            }
        }

        for (const r of this.p.recipes.get(item) || []) {
            const times = Math.ceil(short / r.resultCount);
            let cost = 1 + (r.needsTable ? this.stationCost('crafting_table', depth, stack) : 0);
            for (const [ing, n] of r.ingredients) {
                cost += this.estimate(ing, n * times, depth + 1, stack);
                if (cost === Infinity) break;
            }
            if (cost !== Infinity) out.push({ type: 'craft', recipe: r, times, cost });
        }

        for (const input of SMELTING[item] || []) {
            if (!this.p.mcData.itemsByName[input]) continue;
            let cost = 3 + short * 10 + this.estimate(input, short, depth + 1, stack);
            if (cost === Infinity) continue;
            cost += this.stationCost('furnace', depth, stack);
            const fuel = this.fuelChoice(short, depth, stack, input);
            if (!fuel) continue;
            cost += fuel.cost;
            if (cost !== Infinity) out.push({ type: 'smelt', input, cost });
        }

        const group = this.mineGroup(item);
        if (group) {
            let cost = group.search + Math.ceil(short / group.yield) * group.perBlock;
            if (group.tool.rank > 0 && !group.tool.tools.some(t => this.avail(t) > 0)) {
                cost += this.estimate(group.tool.tools[0], 1, depth + 1, stack);
            }
            if (cost !== Infinity) out.push({ type: 'mine', group, cost });
        }

        const mobs = this.p.huntedFrom.get(item);
        if (mobs && mobs.length) {
            const near = this.world.nearestMob(mobs.map(m => m.mob));
            const y = Math.max(...mobs.map(m => m.yield));
            const danger = mobs.every(m => HOSTILE.has(m.mob)) ? 2.5 : 1;
            out.push({ type: 'hunt', mobs: mobs.map(m => m.mob), yield: y, cost: ((near === null || near === undefined ? 120 : near * 0.3) + Math.ceil(short / y) * 15) * danger });
        }

        return out.sort((a, b) => a.cost - b.cost);
    }

    /** Find the raw items that make `item` unobtainable (for a useful failure message). */
    explain(item, seen = new Set(), depth = 0) {
        if (seen.has(item) || depth > 6) return [];
        seen.add(item);
        if (this.estimate(item, this.avail(item) + 1) !== Infinity) return [];
        // Something that is gathered from the world but not known nearby is the real blocker.
        if (this.p.minedFrom.has(item) || this.p.huntedFrom.has(item)) return [item];
        const out = [];
        const recipes = (this.p.recipes.get(item) || []).slice(0, 3);
        for (const r of recipes) for (const [ing] of r.ingredients) out.push(...this.explain(ing, seen, depth + 1));
        for (const input of (SMELTING[item] || []).slice(0, 2)) out.push(...this.explain(input, seen, depth + 1));
        return out.length ? [...new Set(out)].slice(0, 3) : [item];
    }

    // ---------- committing ----------

    /** Make avail(item) >= count, appending steps. Returns false (state restored) if impossible. */
    ensure(item, count, depth, stack) {
        if (this.avail(item) >= count) return true;
        if (depth > MAX_DEPTH || stack.includes(item)) return false;
        const next = stack.concat(item);
        const short = count - this.avail(item);
        const cands = this.candidates(item, short, depth, next);
        if (!cands.length) {
            const leaves = this.explain(item);
            this.blockedOn = leaves[0] || item;
            this.failReason = leaves.length && leaves[0] !== item
                ? `${item} needs ${leaves.join(', ')}, which has no known source nearby`
                : `no known source for ${item}`;
            return false;
        }
        for (const cand of cands) {
            const snap = this.snapshot();
            if (this.apply(item, short, cand, depth, next) && this.avail(item) >= count) return true;
            // A partial chest withdrawal is fine: top up from another source.
            if (cand.type === 'chest' && this.avail(item) > (snap.inv.get(item) || 0) - (snap.reserved.get(item) || 0)) {
                if (this.ensure(item, count, depth, stack)) return true;
            }
            this.restore(snap);
        }
        return false;
    }

    ensureStation(name, depth, stack) {
        if (this.stations.has(name) || this.world.hasStation(name)) { this.stations.add(name); return true; }
        if (!this.ensure(name, 1, depth + 1, stack)) return false;
        this.reserve(name, 1); // held for the rest of the plan
        this.stations.add(name);
        return true;
    }

    apply(item, short, cand, depth, stack) {
        switch (cand.type) {
            case 'chest': {
                const used = this.usedChests.get(cand.chest.id) || new Map();
                used.set(item, (used.get(item) || 0) + cand.n);
                this.usedChests.set(cand.chest.id, used);
                this.steps.push({ skill: 'withdraw', args: { item, count: cand.n, chest: cand.chest.position }, cost: cand.cost });
                this.add(item, cand.n);
                return true;
            }
            case 'craft': {
                const r = cand.recipe;
                const times = cand.times;
                if (r.needsTable && !this.ensureStation('crafting_table', depth, stack)) return false;
                const held = [];
                for (const [ing, n] of r.ingredients) {
                    if (!this.ensure(ing, n * times, depth + 1, stack)) {
                        for (const [i, c] of held) this.unreserve(i, c);
                        return false;
                    }
                    this.reserve(ing, n * times);
                    held.push([ing, n * times]);
                }
                for (const [i, c] of held) { this.unreserve(i, c); this.take(i, c); }
                const last = this.steps[this.steps.length - 1];
                if (last && last.skill === 'craft' && last.args.item === item) last.args.count += times * r.resultCount;
                else this.steps.push({ skill: 'craft', args: { item, count: times * r.resultCount }, cost: 1 });
                this.add(item, times * r.resultCount);
                return true;
            }
            case 'smelt': {
                if (!this.ensure(cand.input, short, depth + 1, stack)) return false;
                this.reserve(cand.input, short);
                const fuel = this.fuelChoice(short, depth, stack, cand.input);
                if (!fuel || !this.ensure(fuel.name, fuel.count, depth + 1, stack)) { this.unreserve(cand.input, short); return false; }
                this.reserve(fuel.name, fuel.count);
                if (!this.ensureStation('furnace', depth, stack)) {
                    this.unreserve(cand.input, short); this.unreserve(fuel.name, fuel.count);
                    return false;
                }
                this.unreserve(cand.input, short); this.take(cand.input, short);
                this.unreserve(fuel.name, fuel.count); this.take(fuel.name, fuel.count);
                this.steps.push({ skill: 'smelt', args: { input: cand.input, output: item, count: short, fuel: fuel.name, fuelCount: fuel.count }, cost: 3 + short * 10 });
                this.add(item, short);
                return true;
            }
            case 'mine': {
                const g = cand.group;
                if (g.tool.rank > 0 && !g.tool.tools.some(t => this.avail(t) > 0)) {
                    if (!this.ensure(g.tool.tools[0], 1, depth + 1, stack)) return false;
                }
                // Hoist into an earlier gather step for the same item when there is one.
                const earlier = this.steps.find(s => s.skill === 'mine_block' && s.args.item === item);
                if (earlier) {
                    earlier.args.until += short;
                    earlier.cost += Math.ceil(short / g.yield) * g.perBlock;
                } else {
                    this.steps.push({
                        skill: 'mine_block',
                        args: { blocks: g.blocks, item, until: (this.inv.get(item) || 0) + short },
                        cost: g.search + Math.ceil(short / g.yield) * g.perBlock
                    });
                }
                this.add(item, short);
                return true;
            }
            case 'hunt': {
                const earlier = this.steps.find(s => s.skill === 'kill_for_loot' && s.args.item === item);
                if (earlier) earlier.args.until += short;
                else this.steps.push({ skill: 'kill_for_loot', args: { mobs: cand.mobs, item, until: (this.inv.get(item) || 0) + short }, cost: cand.cost });
                this.add(item, short);
                return true;
            }
            default:
                return false;
        }
    }
}

function searchCost(block) {
    return WORLD_COSTS.search[block] ?? WORLD_COSTS.search.default;
}

function uniqueOrdered(list) {
    return [...new Set(list)];
}

module.exports = { AcquirePlanner, describeStep, tierRank, WORLD_COSTS };
