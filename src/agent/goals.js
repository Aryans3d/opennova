/**
 * Autonomy: what to do when nobody is giving orders.
 *
 *   obey    only orders (reflexes still protect the bot)
 *   assist  orders + upkeep: food, storage, sleep
 *   auto    all of that + working through the progression milestones
 *
 * Goal selection is deterministic scoring over needs and a data-driven
 * tech tree. It costs no tokens; the planner already knows how to reach
 * every milestone because milestones are just have(item, n) goals.
 */

const { PRIORITY } = require('../core/task-executor');
const { tierRank } = require('../planner/acquire');
const { obtainGoals } = require('../skills/defs/meta');
const L = require('../skills/lib');
const PROGRESSION = require('../planner/data/progression.json');

const MODES = ['obey', 'assist', 'auto'];
const TOOL_RE = /^(wooden|stone|copper|iron|golden|diamond|netherite)_(pickaxe|axe|sword|shovel|hoe|helmet|chestplate|leggings|boots)$/;

class GoalManager {
    constructor({ bot, ctx, executor, memory, world, logger, controller, say, config }) {
        Object.assign(this, { bot, ctx, executor, memory, world, logger, controller, say });
        const saved = memory.getFact('mode', null);
        this.mode = MODES.includes(saved) ? saved : (config.agent?.mode || 'assist');
        this.idlePeriodMs = config.agent?.idleSeconds ? config.agent.idleSeconds * 1000 : 12000;
        this.cooldown = new Map();
        this.lastActivity = Date.now();
        this.timer = null;
        this.busy = false;
    }

    setMode(mode) {
        if (!MODES.includes(mode)) return false;
        this.mode = mode;
        this.memory.setFact('mode', mode);
        if (mode === 'obey') this.executor.cancelBelow(PRIORITY.TRUSTED, 'mode changed to obey');
        return true;
    }

    start() {
        if (this.timer) return;
        this.timer = setInterval(() => this.tick().catch(e => this.logger.debug(`goal tick: ${e.message}`)), 3000);
    }

    stop() {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }

    touch() {
        this.lastActivity = Date.now();
    }

    /** Does the inventory satisfy a goal, counting better tiers of the same tool? */
    satisfied(goal, inv) {
        if ((inv[goal.item] || 0) >= goal.count) return true;
        const m = TOOL_RE.exec(goal.item);
        if (!m) return false;
        const rank = tierRank(goal.item);
        return Object.keys(inv).some(name => {
            const o = TOOL_RE.exec(name);
            return o && o[2] === m[2] && tierRank(name) >= rank && o[1] !== 'golden';
        });
    }

    /** Ranked candidate goals. Pure given the world; exposed for tests. */
    candidates() {
        const bot = this.bot;
        const inv = this.world.inventory();
        const out = [];
        const now = Date.now();
        const ready = key => (this.cooldown.get(key) || 0) <= now;

        if (this.mode === 'obey') return out;

        // --- needs ---
        if (this.world.isNight() && bot.game?.dimension !== 'the_nether' && this.world.hostiles(12).length === 0) {
            const bedNames = this.ctx.mcData.blocksArray.filter(b => /_bed$/.test(b.name)).map(b => b.name);
            if (this.world.nearest(bedNames, 32) !== null && ready('sleep')) {
                out.push({ key: 'sleep', score: 80, label: 'sleep through the night', kind: 'skill', skill: 'sleep', args: {} });
            }
        }
        if (bot.inventory.emptySlotCount() <= 3 && ready('deposit')) {
            const hasChest = this.world.nearest(['chest', 'barrel'], 32) !== null || this.memory.getBaseChests().length > 0;
            if (hasChest) out.push({ key: 'deposit', score: 70, label: 'store a full inventory', kind: 'skill', skill: 'deposit', args: {} });
        }
        const foods = this.ctx.mcData.foodsByName || {};
        const foodCount = Object.entries(inv).filter(([n]) => foods[n]).reduce((s, [, c]) => s + c, 0);
        if (foodCount < 4 && ready('food')) {
            const animal = this.world.nearestMob(['cow', 'pig', 'sheep', 'chicken'], 48);
            if (animal !== null) {
                const meat = this.world.nearestMob(['cow'], 48) !== null ? 'cooked_beef' : this.world.nearestMob(['pig'], 48) !== null ? 'cooked_porkchop' : this.world.nearestMob(['sheep'], 48) !== null ? 'cooked_mutton' : 'cooked_chicken';
                out.push({ key: 'food', score: 60, label: 'stock up on food', kind: 'obtain', goals: [{ item: meat, count: (inv[meat] || 0) + 6 }] });
            }
        }

        // --- progression ---
        if (this.mode === 'auto') {
            for (let i = 0; i < PROGRESSION.length; i++) {
                const stage = PROGRESSION[i];
                const unmet = stage.goals.filter(g => !this.satisfied(g, inv));
                if (!unmet.length) continue;
                const key = `stage:${stage.name}`;
                if (ready(key)) out.push({ key, score: 40 - i, label: stage.name, kind: 'obtain', goals: unmet });
                break; // one stage at a time, in order
            }
        }
        return out.sort((a, b) => b.score - a.score);
    }

    async tick() {
        if (this.busy || this.mode === 'obey') return;
        if (!this.bot.entity || this.bot.health <= 0) return;
        if (this.executor.isBusy() || this.controller.isBusy()) { this.touch(); return; }
        if (Date.now() - this.lastActivity < this.idlePeriodMs) return;
        const goal = this.candidates()[0];
        if (!goal) return;

        this.busy = true;
        this.logger.info(`Self-chosen goal: ${goal.label}`);
        this.world.note(`chose goal: ${goal.label}`);
        try {
            const result = await this.executor.submit({
                name: `self:${goal.key}`,
                priority: goal.kind === 'skill' ? PRIORITY.MAINTENANCE : PRIORITY.SELF,
                source: 'self',
                resumable: true,
                run: signal => (goal.kind === 'obtain'
                    ? obtainGoals({ ...this.ctx, source: 'self' }, goal.goals, signal)
                    : this.ctx.registry.run(goal.skill, goal.args, this.ctx, signal, { source: 'self', selfInitiated: true }))
            });
            if (result.ok) {
                this.cooldown.set(goal.key, Date.now() + 60000);
                this.memory.addEpisode('goal', `Finished self-chosen goal: ${goal.label}`, 3);
            } else if (result.code !== 'ABORTED') {
                // Do not grind on the same wall: shelve it for a while.
                const fails = (this.fails?.get(goal.key) || 0) + 1;
                (this.fails ||= new Map()).set(goal.key, fails);
                this.cooldown.set(goal.key, Date.now() + Math.min(60, 5 * fails * fails) * 60000);
                this.memory.addEpisode('goal', `Gave up on self-chosen goal "${goal.label}": ${result.message}`, 4);
                this.logger.warn(`Goal "${goal.label}" failed: ${result.message}`);
            }
        } finally {
            this.busy = false;
            this.touch();
        }
    }
}

module.exports = { GoalManager, MODES };
