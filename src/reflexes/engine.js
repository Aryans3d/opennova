/**
 * Reflex engine: survival rules evaluated on a short timer against the
 * world model. No model is ever consulted here. A reflex takes the body
 * through the task executor at top priority, so whatever it interrupted is
 * re-queued and resumes afterwards.
 */

const { PRIORITY } = require('../core/task-executor');
const { ok, sleep } = require('../core/result');
const L = require('../skills/lib');
const { eatNow, fleeNow, bestFood } = require('../skills/defs/survive');
const { equipWeapon, killEntity } = require('../skills/defs/gather');

const PERIOD_MS = 250;

class ReflexEngine {
    constructor({ bot, ctx, executor, world, logger, config }) {
        this.bot = bot;
        this.ctx = ctx;
        this.executor = executor;
        this.world = world;
        this.logger = logger;
        this.fleeAt = config.combat?.fleeHealthThreshold ?? 6;
        this.enabled = true;
        this.running = false;       // a reflex task is queued or active
        this.cooldown = new Map();
        this.timer = null;
        this.rules = this.buildRules();
    }

    start() {
        if (this.timer) return;
        this.timer = setInterval(() => this.tick(), PERIOD_MS);
    }

    stop() {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }

    ready(name, ms) {
        const now = Date.now();
        if ((this.cooldown.get(name) || 0) > now) return false;
        this.cooldown.set(name, now + ms);
        return true;
    }

    tick() {
        if (!this.enabled || this.running) return;
        const bot = this.bot;
        if (!bot.entity || bot.health <= 0 || bot.isSleeping) return;
        for (const rule of this.rules) {
            let hit;
            try { hit = rule.when(); } catch (_) { hit = false; }
            if (!hit) continue;
            if (!this.ready(rule.name, rule.cooldownMs)) continue;
            this.fire(rule, hit);
            return;
        }
    }

    fire(rule, hit) {
        this.running = true;
        this.logger.debug(`reflex: ${rule.name}`);
        this.world.note(`reflex ${rule.name}`);
        this.executor.submit({
            name: `reflex:${rule.name}`,
            priority: PRIORITY.REFLEX,
            source: 'reflex',
            timeoutMs: rule.timeoutMs || 15000,
            run: signal => rule.act(signal, hit)
        }).finally(() => { this.running = false; });
    }

    buildRules() {
        const bot = this.bot;
        const ctx = this.ctx;
        return [
            {
                name: 'air',
                cooldownMs: 3000,
                when: () => bot.oxygenLevel !== undefined && bot.oxygenLevel <= 6,
                act: async signal => {
                    L.stopMoving(bot);
                    bot.setControlState('jump', true);
                    try {
                        for (let i = 0; i < 32 && bot.oxygenLevel < 15; i++) await sleep(250, signal);
                    } finally {
                        bot.setControlState('jump', false);
                    }
                    return ok();
                }
            },
            {
                name: 'creeper',
                cooldownMs: 2500,
                when: () => L.nearbyEntities(bot, e => e.name === 'creeper', 4.5)[0],
                act: signal => fleeNow(ctx, signal, 14, 5000)
            },
            {
                name: 'flee',
                cooldownMs: 4000,
                when: () => bot.health <= this.fleeAt && this.world.hostiles(10).length > 0,
                act: async signal => {
                    await fleeNow(ctx, signal, 24, 9000);
                    if (bestFood(ctx)) await eatNow(ctx, signal);
                    return ok();
                }
            },
            {
                name: 'fight_back',
                cooldownMs: 1500,
                when: () => {
                    if (bot.health <= this.fleeAt) return false;
                    const current = this.executor.current;
                    if (current && /attack|guard|kill_for_loot|reflex/.test(current.name)) return false;
                    const close = this.world.hostiles(4.5).filter(h => h.entity.name !== 'creeper' && h.entity.name !== 'enderman')[0];
                    // Only engage what is actually on top of us or has just hurt us.
                    if (close && (close.distance < 3.2 || Date.now() - this.world.lastDamageAt < 2500)) return close;
                    return false;
                },
                timeoutMs: 25000,
                act: async (signal, hit) => {
                    await equipWeapon(bot);
                    await killEntity(ctx, hit.entity, signal, 20000);
                    return ok();
                }
            },
            {
                name: 'eat',
                cooldownMs: 6000,
                when: () => (bot.food <= 14 || (bot.health < 12 && bot.food < 20)) && this.world.hostiles(8).length === 0 && !!bestFood(ctx),
                act: signal => eatNow(ctx, signal)
            }
        ];
    }
}

module.exports = { ReflexEngine };
