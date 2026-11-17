/**
 * OpenNova - Agent Commands
 * Direct access to the agent: planner, skills, autonomy mode and trust.
 */

const { TRUST } = require('../core/permissions');
const { MODES } = require('../agent/goals');

function needAgent(bot) {
    if (!bot.agent) {
        bot.chat('The agent is not running.');
        return null;
    }
    return bot.agent;
}

/** Parse "key=value key2=a,b" into an object, using the skill schema for types. */
function parseArgs(skill, tokens) {
    const props = skill.params.properties || {};
    const args = {};
    const positional = (skill.params.required || []).filter(k => props[k]);
    let pos = 0;
    for (const token of tokens) {
        const eq = token.indexOf('=');
        let key, value;
        if (eq > 0 && props[token.slice(0, eq)]) {
            key = token.slice(0, eq);
            value = token.slice(eq + 1);
        } else {
            // positional: required params first, then remaining params in declared order
            const order = [...positional, ...Object.keys(props).filter(k => !positional.includes(k))];
            key = order[pos++];
            value = token;
            if (!key) continue;
        }
        const type = props[key].type;
        if (type === 'array') args[key] = value.split(',').filter(Boolean);
        else if (type === 'object') { try { args[key] = JSON.parse(value); } catch (_) { args[key] = value; } }
        else args[key] = value;
    }
    return args;
}

module.exports = {
    name: 'agent',
    commands: {
        ask: {
            description: 'Give the agent an order in plain language',
            usage: '!ask <anything>',
            aliases: ['nova', 'a'],
            execute: async (bot, args, sender) => {
                const agent = needAgent(bot);
                if (!agent) return;
                if (!args.length) return bot.chat('Usage: !ask <what you want me to do>');
                await agent.controller.handle(sender, args.join(' '));
            }
        },

        obtain: {
            description: 'Get an item by any means (gather, craft, smelt, chests)',
            usage: '!obtain <item> [count]',
            aliases: ['get'],
            execute: async (bot, args, sender) => {
                const agent = needAgent(bot);
                if (!agent) return;
                if (!args.length) return bot.chat('Usage: !obtain <item> [count]');
                const count = parseInt(args[args.length - 1]);
                const item = (isNaN(count) ? args : args.slice(0, -1)).join('_');
                bot.chat(`Working on ${isNaN(count) ? 1 : count} ${item}...`);
                const result = await agent.runSkill('obtain', { item, count: isNaN(count) ? 1 : count }, sender);
                bot.chat(result.ok ? `Done: ${result.message}` : `Could not: ${result.message}`.slice(0, 240));
            }
        },

        plan: {
            description: 'Show the steps the agent would take to get an item',
            usage: '!plan <item> [count]',
            execute: async (bot, args, sender) => {
                const agent = needAgent(bot);
                if (!agent) return;
                if (!args.length) return bot.chat('Usage: !plan <item> [count]');
                const count = parseInt(args[args.length - 1]);
                const item = (isNaN(count) ? args : args.slice(0, -1)).join('_');
                const result = await agent.registry.run('plan_for', { item, count: isNaN(count) ? 1 : count }, agent.ctx, null, { source: sender });
                if (!result.ok) return bot.chat(`No plan: ${result.message}`.slice(0, 240));
                const steps = result.data.steps;
                bot.chat(`${steps.length} steps, about ${result.data.estimatedSeconds}s:`);
                steps.slice(0, 12).forEach((s, i) => bot.chat(`${i + 1}. ${s}`.slice(0, 240)));
                if (steps.length > 12) bot.chat(`...and ${steps.length - 12} more`);
            }
        },

        do: {
            description: 'Run one agent skill directly',
            usage: '!do <skill> [args or key=value ...]',
            execute: async (bot, args, sender) => {
                const agent = needAgent(bot);
                if (!agent) return;
                const skill = agent.registry.get(args[0]);
                if (!skill) return bot.chat(`Unknown skill. Use ${bot.config.settings.commandPrefix}skills to list them.`);
                const result = await agent.runSkill(skill.name, parseArgs(skill, args.slice(1)), sender);
                const extra = result.ok && result.data && Object.keys(result.data).length ? ` ${JSON.stringify(result.data)}` : '';
                bot.chat(`${result.ok ? 'OK' : result.code}: ${result.message}${extra}`.slice(0, 240));
            }
        },

        skills: {
            description: 'List agent skills',
            usage: '!skills',
            execute: async (bot) => {
                const agent = needAgent(bot);
                if (!agent) return;
                const names = agent.registry.list().map(s => s.name).sort();
                for (let i = 0; i < names.length; i += 12) bot.chat(names.slice(i, i + 12).join(', '));
            }
        },

        mode: {
            description: 'Set how independent the agent is: obey, assist or auto',
            usage: '!mode [obey|assist|auto]',
            execute: async (bot, args, sender) => {
                const agent = needAgent(bot);
                if (!agent) return;
                if (!args.length) return bot.chat(`Mode: ${agent.goals.mode} (options: ${MODES.join(', ')})`);
                if (!agent.permissions.isOwner(sender)) return bot.chat('Only my owner can change that.');
                if (!agent.goals.setMode(args[0].toLowerCase())) return bot.chat(`Options: ${MODES.join(', ')}`);
                bot.chat(`Mode set to ${agent.goals.mode}.`);
            }
        },

        trust: {
            description: 'Let another player give the agent harmless orders',
            usage: '!trust <player>',
            execute: async (bot, args, sender) => {
                const agent = needAgent(bot);
                if (!agent) return;
                if (!agent.permissions.isOwner(sender)) return bot.chat('Only my owner can change that.');
                if (!args.length) return bot.chat(`Trusted: ${[...agent.permissions.trusted].join(', ') || 'nobody'}`);
                agent.permissions.trust(args[0]);
                agent.memory.setFact('trusted', [...agent.permissions.trusted]);
                bot.chat(`${args[0]} can now give me orders.`);
            }
        },

        untrust: {
            description: 'Remove a player from the trusted list',
            usage: '!untrust <player>',
            execute: async (bot, args, sender) => {
                const agent = needAgent(bot);
                if (!agent) return;
                if (!agent.permissions.isOwner(sender)) return bot.chat('Only my owner can change that.');
                if (!args.length) return bot.chat('Usage: !untrust <player>');
                agent.permissions.untrust(args[0]);
                agent.memory.setFact('trusted', [...agent.permissions.trusted]);
                bot.chat(`${args[0]} is no longer trusted.`);
            }
        },

        agent: {
            description: 'Show agent state: models, mode, current task, usage',
            usage: '!agent',
            execute: async (bot, args, sender) => {
                const agent = needAgent(bot);
                if (!agent) return;
                const st = agent.executor.status();
                const spent = agent.llm.spent();
                bot.chat(`Models: ${agent.llm.describe()}${agent.llm.enabled ? '' : ' (off)'}`);
                bot.chat(`Mode: ${agent.goals.mode} | Owner: ${agent.permissions.owner || 'none'} | You: ${['stranger', 'trusted', 'owner'][agent.permissions.level(sender)] || 'stranger'}`);
                bot.chat(`Task: ${st.current ? st.current.name : 'idle'}${st.queued.length ? ` (+${st.queued.length} queued)` : ''}`);
                bot.chat(`Model use this hour: ${spent.calls} calls, ${spent.tokens} tokens (limit ${agent.llm.budget.callsPerHour} / ${agent.llm.budget.tokensPerHour})`);
            }
        }
    }
};

module.exports.parseArgs = parseArgs;
module.exports.TRUST = TRUST;
