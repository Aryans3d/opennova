/**
 * Name resolution: models and players write "oak log", "Iron Pickaxe",
 * "planks". Map those to real registry names, and offer close matches
 * when nothing fits so the model can correct itself.
 */

function normalize(name) {
    return String(name || '')
        .toLowerCase()
        .trim()
        .replace(/^minecraft:/, '')
        .replace(/[\s-]+/g, '_')
        .replace(/[^a-z0-9_]/g, '');
}

function levenshtein(a, b) {
    if (a === b) return 0;
    const m = a.length, n = b.length;
    if (!m) return n;
    if (!n) return m;
    let prev = new Array(n + 1);
    let cur = new Array(n + 1);
    for (let j = 0; j <= n; j++) prev[j] = j;
    for (let i = 1; i <= m; i++) {
        cur[0] = i;
        for (let j = 1; j <= n; j++) {
            const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
            cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
        }
        [prev, cur] = [cur, prev];
    }
    return prev[n];
}

// Generic words → the most common concrete item.
const ALIASES = {
    wood: 'oak_log', log: 'oak_log', logs: 'oak_log', planks: 'oak_planks', plank: 'oak_planks',
    sticks: 'stick', cobble: 'cobblestone', iron: 'iron_ingot', gold: 'gold_ingot',
    copper: 'copper_ingot', diamonds: 'diamond', pickaxe: 'wooden_pickaxe', pick: 'wooden_pickaxe',
    table: 'crafting_table', workbench: 'crafting_table', bed: 'white_bed', torches: 'torch',
    steak: 'cooked_beef', meat: 'cooked_beef', food: 'bread', wool: 'white_wool',
    boat: 'oak_boat', door: 'oak_door', chest: 'chest', furnace: 'furnace'
};

/**
 * @param {string} input
 * @param {Record<string, object>} byName  e.g. mcData.itemsByName
 * @returns {{name: string|null, suggestions: string[]}}
 */
function resolveName(input, byName) {
    const n = normalize(input);
    if (!n) return { name: null, suggestions: [] };
    if (byName[n]) return { name: n, suggestions: [] };

    const singular = n.replace(/s$/, '');
    if (byName[singular]) return { name: singular, suggestions: [] };
    if (ALIASES[n] && byName[ALIASES[n]]) return { name: ALIASES[n], suggestions: [] };

    const names = Object.keys(byName);
    const scored = [];
    for (const cand of names) {
        let score = levenshtein(n, cand);
        if (cand.includes(n) || n.includes(cand)) score = Math.min(score, Math.abs(cand.length - n.length) * 0.5 + 0.5);
        scored.push([score, cand]);
    }
    scored.sort((a, b) => a[0] - b[0] || a[1].length - b[1].length);
    const best = scored[0];
    const suggestions = scored.slice(0, 3).map(s => s[1]);
    // Accept only a confident, unambiguous match (typo-level distance).
    if (best && best[0] <= Math.max(1, Math.floor(n.length / 6)) && (!scored[1] || scored[1][0] > best[0])) {
        return { name: best[1], suggestions };
    }
    return { name: null, suggestions };
}

module.exports = { normalize, levenshtein, resolveName };
