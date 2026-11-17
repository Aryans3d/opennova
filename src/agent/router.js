/**
 * Router: decide what a chat line is before any model is involved.
 *
 *   stop / come / follow me / stay / go home  -> skill, zero model calls
 *   addressed to the bot                       -> controller (model)
 *   anything else                              -> recorded only
 */

const PHRASES = [
    // [regex, action]. Checked against the lower-cased line with the bot's name removed.
    [/^(stop|halt|cancel|abort|stop it|stop that|enough|freeze|ruko|ruk ja|ruk jao|bas|band karo|para|alto|arr[eê]te)[.! ]*$/, { type: 'stop' }],
    [/^(come|come here|come to me|come back|get over here|here|idhar aa+o?|yahan aa+o?|aa jao|ven|ven aqu[ií]|viens)[.! ]*$/, { type: 'skill', skill: 'goto_player', args: {} }],
    [/^(follow|follow me|with me|come with me|mere (peeche|saath) aa+o?|peeche aa+o?|s[ií]gueme|suis[- ]moi)[.! ]*$/, { type: 'skill', skill: 'follow', args: {} }],
    [/^(stay|stay here|wait|wait here|stand still|don'?t move|yahin ruko|ruko yahin|qu[eé]date)[.! ]*$/, { type: 'stop' }],
    [/^(go home|home|go back home|return home|ghar jao|ghar chalo)[.! ]*$/, { type: 'skill', skill: 'goto_waypoint', args: { name: 'home' } }],
    [/^(guard me|protect me|defend me|meri raksha karo)[.! ]*$/, { type: 'skill', skill: 'guard', args: {} }],
    [/^(eat|eat something|khana khao)[.! ]*$/, { type: 'skill', skill: 'eat', args: {} }],
    [/^(sleep|go to sleep|go to bed|so jao)[.! ]*$/, { type: 'skill', skill: 'sleep', args: {} }]
];

class Router {
    constructor(botName, options = {}) {
        this.botName = botName.toLowerCase();
        this.aliases = [this.botName, ...(options.aliases || []).map(a => a.toLowerCase())];
        this.listen = options.listen || 'auto';   // auto | name | all
        this.lastSpokeTo = new Map();              // player -> timestamp
    }

    noteSpokeTo(player) {
        this.lastSpokeTo.set(player, Date.now());
    }

    stripName(text) {
        let t = text.trim();
        for (const alias of this.aliases) {
            const re = new RegExp(`^(hey |hi |ok |yo )?@?${escapeRe(alias)}[,:!]?\\s+|[,]?\\s+@?${escapeRe(alias)}[.!?]*$`, 'i');
            const stripped = t.replace(re, '').trim();
            if (stripped !== t) return { text: stripped, named: true };
        }
        const mentioned = this.aliases.some(a => new RegExp(`\\b${escapeRe(a)}\\b`, 'i').test(t));
        return { text: t, named: mentioned };
    }

    /**
     * @param {string} username
     * @param {string} message
     * @param {object} env { whisper: boolean, otherPlayers: number }
     * @returns {{type: 'ignore'|'stop'|'skill'|'agent', ...}}
     */
    route(username, message, env = {}) {
        const { text, named } = this.stripName(message);
        if (!text) return { type: 'ignore' };

        const recentlySpoke = Date.now() - (this.lastSpokeTo.get(username) || 0) < 30000;
        const alone = (env.otherPlayers ?? 2) <= 1;
        const addressed = env.whisper || named || this.listen === 'all' || (this.listen === 'auto' && (alone || recentlySpoke));
        if (!addressed) return { type: 'ignore' };

        const lower = text.toLowerCase();
        for (const [re, action] of PHRASES) {
            if (re.test(lower)) return { ...action, args: action.args ? { ...action.args } : undefined, text };
        }
        return { type: 'agent', text };
    }
}

function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = { Router };
