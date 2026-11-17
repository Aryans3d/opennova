/**
 * World snapshot for the prompt: compact, fixed field order, nearest first.
 */

const L = require('../skills/lib');

const MAX_INV = 28;

function renderSnapshot(ctx, opts = {}) {
    const bot = ctx.bot;
    const world = ctx.world;
    if (!bot.entity) return 'self: not spawned';
    const p = bot.entity.position;
    const lines = [];

    const t = bot.time ? bot.time.timeOfDay : 0;
    const phase = t < 12000 ? 'day' : t < 13000 ? 'dusk' : t < 23000 ? 'night' : 'dawn';
    const dim = String(bot.game?.dimension || 'overworld').replace('minecraft:', '');
    lines.push(`self: hp ${Math.round(bot.health)}/20 food ${Math.round(bot.food)}/20 pos (${L.fmt(p)}) ${dim} ${phase}${bot.isRaining ? ' rain' : ''}`);

    const held = bot.heldItem ? bot.heldItem.name : 'nothing';
    const armour = [5, 6, 7, 8].map(s => bot.inventory.slots[s]).filter(Boolean).map(i => i.name);
    lines.push(`held: ${held}  armour: ${armour.length ? armour.join(', ') : 'none'}`);

    const inv = Object.entries(world.inventory());
    const relevant = new Set(opts.relevant || []);
    inv.sort((a, b) => (relevant.has(b[0]) - relevant.has(a[0])) || b[1] - a[1]);
    const used = 36 - bot.inventory.emptySlotCount();
    const shown = inv.slice(0, MAX_INV).map(([n, c]) => `${n} ${c}`).join(', ');
    lines.push(`inv(${used}/36): ${shown || 'empty'}${inv.length > MAX_INV ? `, +${inv.length - MAX_INV} more kinds` : ''}`);

    const near = [];
    for (const [name, player] of Object.entries(bot.players)) {
        if (name === bot.username || !player.entity) continue;
        near.push([player.entity.position.distanceTo(p), `${name}(player) ${Math.round(player.entity.position.distanceTo(p))}m`]);
    }
    const mobs = new Map();
    for (const { entity, distance } of L.nearbyEntities(bot, e => e.type !== 'player' && e.name && e.name !== 'item' && ['hostile', 'animal', 'mob', 'passive', 'water_creature', 'ambient'].includes(e.type), 24)) {
        const m = mobs.get(entity.name) || { n: 0, d: distance };
        m.n++;
        mobs.set(entity.name, m);
    }
    for (const [name, m] of mobs) near.push([m.d, `${name}${m.n > 1 ? `x${m.n}` : ''} ${Math.round(m.d)}m`]);
    near.sort((a, b) => a[0] - b[0]);
    lines.push(`near: ${near.slice(0, 10).map(n => n[1]).join(' · ') || 'nobody'}`);

    const res = world.visibleResources().slice(0, 12).map(r => `${r.name} ${r.distance}m`);
    lines.push(`blocks seen: ${res.join(' · ') || 'nothing notable'}`);

    const threats = world.hostiles(12).slice(0, 4).map(h => `${h.entity.name} ${Math.round(h.distance)}m`);
    lines.push(`threats: ${threats.join(', ') || 'none'}`);

    const home = ctx.memory?.getHome();
    const places = [];
    if (home) places.push(`home (${home.x},${home.y},${home.z})`);
    for (const w of (ctx.memory?.listWaypoints() || []).slice(0, 6)) places.push(`${w.name} (${w.x},${w.y},${w.z})`);
    if (places.length) lines.push(`places: ${places.join(' · ')}`);

    const chests = world.chests().slice(0, 4).map(c => {
        const top = Object.entries(c.contents).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([n, k]) => `${n} ${k}`).join(', ');
        return `(${c.position.x},${c.position.y},${c.position.z}) ${Math.round(c.distance)}m: ${top || 'empty'}`;
    });
    if (chests.length) lines.push(`known chests: ${chests.join(' | ')}`);

    return lines.join('\n');
}

module.exports = { renderSnapshot };
