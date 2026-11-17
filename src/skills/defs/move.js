const { ok, fail, check, sleep, CODES } = require('../../core/result');
const L = require('../lib');

const coords = {
    x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' }
};

module.exports = [
    {
        name: 'goto',
        description: 'Walk to coordinates. Omit y to accept any height.',
        params: { type: 'object', properties: { ...coords, range: { type: 'number', default: 2, minimum: 0, maximum: 32 } }, required: ['x', 'z'] },
        timeoutMs: 600000,
        async run(ctx, a, signal) {
            return L.travelTo(ctx, { x: a.x, y: a.y, z: a.z }, a.range, signal);
        }
    },
    {
        name: 'goto_player',
        description: 'Walk to a player. Defaults to whoever gave the order.',
        params: { type: 'object', properties: { player: { type: 'string' } } },
        timeoutMs: 300000,
        async run(ctx, a, signal) {
            const name = a.player || ctx.source;
            const entity = ctx.bot.players[name]?.entity;
            if (!entity) return fail(CODES.NOT_FOUND, `cannot see player ${name} (too far away or offline)`);
            return L.travelTo(ctx, entity.position, 2, signal);
        }
    },
    {
        name: 'follow',
        description: 'Keep following a player until another order arrives. Defaults to whoever gave the order.',
        params: { type: 'object', properties: { player: { type: 'string' }, distance: { type: 'number', default: 3, minimum: 1, maximum: 16 } } },
        timeoutMs: 0,
        background: true,
        async run(ctx, a, signal) {
            const name = a.player || ctx.source;
            const bot = ctx.bot;
            if (!bot.players[name]) return fail(CODES.NOT_FOUND, `no player named ${name}`);
            let lost = 0;
            try {
                while (true) {
                    check(signal);
                    const entity = bot.players[name]?.entity;
                    if (!entity) {
                        if (++lost > 60) return fail(CODES.NOT_FOUND, `lost sight of ${name}`);
                    } else {
                        lost = 0;
                        if (!bot.pathfinder.goal || bot.pathfinder.goal.entity !== entity) {
                            bot.pathfinder.setGoal(new L.goals.GoalFollow(entity, a.distance), true);
                        }
                    }
                    await sleep(500, signal);
                }
            } finally {
                L.stopMoving(bot);
            }
        }
    },
    {
        name: 'goto_waypoint',
        description: 'Walk to a saved waypoint, or "home", or "death" (last death location).',
        params: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
        timeoutMs: 900000,
        async run(ctx, a, signal) {
            const key = a.name.toLowerCase();
            const pos = key === 'home' ? ctx.memory.getHome() : key === 'death' ? ctx.memory.getDeathLocation() : ctx.memory.getWaypoint(key);
            if (!pos) return fail(CODES.NOT_FOUND, `no waypoint "${a.name}"`, { known: ctx.memory.listWaypoints().map(w => w.name) });
            return L.travelTo(ctx, pos, 2, signal);
        }
    },
    {
        name: 'explore',
        description: 'Walk in a direction to discover new terrain. Reports notable things seen on arrival.',
        params: {
            type: 'object',
            properties: {
                direction: { type: 'string', enum: ['north', 'south', 'east', 'west', 'any'], default: 'any' },
                distance: { type: 'number', default: 64, minimum: 8, maximum: 400 }
            }
        },
        timeoutMs: 600000,
        async run(ctx, a, signal) {
            const dirs = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] };
            const d = dirs[a.direction] || Object.values(dirs)[Math.floor(Math.random() * 4)];
            const p = ctx.bot.entity.position;
            const r = await L.travelTo(ctx, { x: p.x + d[0] * a.distance, z: p.z + d[1] * a.distance }, 6, signal);
            const seen = ctx.world.visibleResources().slice(0, 8);
            const here = ctx.bot.entity.position;
            return ok({ position: L.fmt(here), reached: r.ok, seen }, r.ok ? 'explored' : `stopped early: ${r.message}`);
        }
    },
    {
        name: 'look_at_player',
        description: 'Turn to face a player.',
        params: { type: 'object', properties: { player: { type: 'string' } } },
        timeoutMs: 5000,
        async run(ctx, a) {
            const entity = ctx.bot.players[a.player || ctx.source]?.entity;
            if (!entity) return fail(CODES.NOT_FOUND, 'cannot see that player');
            await ctx.bot.lookAt(entity.position.offset(0, entity.height || 1.6, 0));
            return ok();
        }
    }
];
