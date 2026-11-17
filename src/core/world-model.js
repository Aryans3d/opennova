/**
 * World view: a cheap, cached read model over the Mineflayer bot.
 * The planner, the reflexes and the prompt snapshot all read from here so
 * nothing in a hot path runs its own block scan.
 */

const { inventoryCounts, isHostile, nearbyEntities } = require('../skills/lib');

const SCAN_TTL = 4000;
const RESOURCE_BLOCKS = [
    'oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'cherry_log', 'mangrove_log',
    'coal_ore', 'iron_ore', 'copper_ore', 'gold_ore', 'redstone_ore', 'lapis_ore', 'diamond_ore', 'emerald_ore',
    'deepslate_coal_ore', 'deepslate_iron_ore', 'deepslate_copper_ore', 'deepslate_gold_ore',
    'deepslate_redstone_ore', 'deepslate_lapis_ore', 'deepslate_diamond_ore',
    'crafting_table', 'furnace', 'chest', 'barrel', 'wheat', 'water', 'lava', 'sand', 'gravel', 'clay', 'sugar_cane', 'pumpkin', 'melon'
];

class WorldModel {
    constructor(bot, mcData, memory, logger) {
        this.bot = bot;
        this.mcData = mcData;
        this.memory = memory;
        this.logger = logger;
        this.cache = new Map();
        this.events = [];           // recent notable events for the prompt
        this.lastDamageAt = 0;
        this.lastHealth = 20;
        this._listeners = [];
        this._listen();
    }

    _on(event, fn) {
        this.bot.on(event, fn);
        this._listeners.push([event, fn]);
    }

    _listen() {
        this._on('health', () => {
            if (this.bot.health < this.lastHealth - 0.5) {
                this.lastDamageAt = Date.now();
            }
            this.lastHealth = this.bot.health;
        });
        this._on('death', () => this.note('I died'));
        this._on('blockUpdate', () => { this.cache.clear(); });
    }

    dispose() {
        for (const [event, fn] of this._listeners) this.bot.removeListener(event, fn);
        this._listeners = [];
    }

    note(text) {
        this.events.push({ t: Date.now(), text });
        if (this.events.length > 12) this.events.shift();
    }

    inventory() {
        return inventoryCounts(this.bot);
    }

    /** Distance to the nearest loaded block with one of these names, or null. */
    nearest(names, maxDistance = 48) {
        const key = names.join('|') + '@' + maxDistance;
        const hit = this.cache.get(key);
        const now = Date.now();
        if (hit && now - hit.t < SCAN_TTL) return hit.v;
        const ids = names.map(n => this.mcData.blocksByName[n]).filter(Boolean).map(b => b.id);
        let v = null;
        if (ids.length && this.bot.entity) {
            const pos = this.bot.findBlock({ matching: ids, maxDistance });
            if (pos) v = pos.position.distanceTo(this.bot.entity.position);
        }
        this.cache.set(key, { t: now, v });
        return v;
    }

    hasStation(name) {
        const d = this.nearest([name], 32);
        return d !== null;
    }

    nearestMob(names, maxDistance = 48) {
        const set = new Set(names);
        const list = nearbyEntities(this.bot, e => set.has(e.name), maxDistance);
        return list.length ? list[0].distance : null;
    }

    chests() {
        if (!this.memory || !this.bot.entity) return [];
        const me = this.bot.entity.position;
        const out = [];
        for (const chest of this.memory.allChests()) {
            const p = chest.position;
            const distance = Math.sqrt((p.x - me.x) ** 2 + (p.y - me.y) ** 2 + (p.z - me.z) ** 2);
            if (distance > 256) continue;
            const contents = {};
            for (const it of chest.contents || []) contents[it.name] = (contents[it.name] || 0) + it.count;
            out.push({ id: `${p.x},${p.y},${p.z}`, position: p, distance, contents, label: chest.label });
        }
        return out.sort((a, b) => a.distance - b.distance);
    }

    hostiles(maxDistance = 16) {
        return nearbyEntities(this.bot, isHostile, maxDistance);
    }

    /** View handed to the planner. */
    plannerView() {
        return {
            nearest: names => this.nearest(names),
            hasStation: name => this.hasStation(name),
            chests: () => this.chests(),
            nearestMob: names => this.nearestMob(names)
        };
    }

    /** Resources currently visible, for the prompt. */
    visibleResources() {
        const out = [];
        for (const name of RESOURCE_BLOCKS) {
            const d = this.nearest([name]);
            if (d !== null) out.push({ name, distance: Math.round(d) });
        }
        return out.sort((a, b) => a.distance - b.distance);
    }

    isNight() {
        const t = this.bot.time ? this.bot.time.timeOfDay : 0;
        return t >= 12542 && t <= 23460;
    }
}

module.exports = { WorldModel };
