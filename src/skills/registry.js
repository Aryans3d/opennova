/**
 * Skill registry: the single source of truth for what the bot can do.
 * The model's tool list, the planner's actions and the !commands all come
 * from here. Validates arguments, resolves fuzzy names, checks permissions,
 * applies timeouts, and guarantees a result object comes back.
 */

const Ajv = require('ajv');
const { fail, fromError, CODES } = require('../core/result');
const { resolveName } = require('../core/names');

class SkillRegistry {
    constructor(logger) {
        this.logger = logger;
        this.skills = new Map();
        this.ajv = new Ajv({ coerceTypes: true, useDefaults: true, allErrors: true, strict: false });
    }

    register(def) {
        if (!def.name || typeof def.run !== 'function') throw new Error('skill needs name and run()');
        const params = def.params || { type: 'object', properties: {} };
        this.skills.set(def.name, {
            danger: 'none', timeoutMs: 120000, expose: true, ...def, params,
            validate: this.ajv.compile(params)
        });
    }

    registerAll(defs) {
        for (const d of defs) this.register(d);
    }

    get(name) { return this.skills.get(name); }
    list() { return [...this.skills.values()]; }

    /** Provider-neutral tool definitions: [{name, description, parameters}] */
    toolDefs() {
        return this.list()
            .filter(s => s.expose)
            .sort((a, b) => a.name.localeCompare(b.name)) // deterministic order keeps the prompt cacheable
            .map(s => ({ name: s.name, description: s.description, parameters: stripCustom(s.params) }));
    }

    /**
     * Validate and normalise arguments without running. Returns {ok, args} or a fail result.
     */
    prepare(name, rawArgs, ctx) {
        const skill = this.skills.get(name);
        if (!skill) {
            const { suggestions } = resolveName(name, Object.fromEntries(this.skills));
            return fail(CODES.INVALID_ARGS, `unknown skill "${name}"`, { suggestions });
        }
        const args = JSON.parse(JSON.stringify(rawArgs || {}));
        if (!skill.validate(args)) {
            const msg = skill.validate.errors.map(e => `${e.instancePath || 'args'} ${e.message}`).join('; ');
            return fail(CODES.INVALID_ARGS, `bad arguments for ${name}: ${msg}`);
        }
        // Resolve item / block / entity names.
        for (const [key, schema] of Object.entries(skill.params.properties || {})) {
            const kind = schema['x-kind'];
            if (!kind || args[key] === undefined || args[key] === null) continue;
            const table = kind === 'item' ? ctx.mcData.itemsByName : kind === 'block' ? ctx.mcData.blocksByName : ctx.mcData.entitiesByName;
            const fix = value => {
                const r = resolveName(value, table);
                if (!r.name) throw Object.assign(new Error(`unknown ${kind} "${value}"`), { suggestions: r.suggestions });
                return r.name;
            };
            try {
                args[key] = Array.isArray(args[key]) ? args[key].map(fix) : fix(args[key]);
            } catch (error) {
                return fail(CODES.INVALID_ARGS, `${error.message}${error.suggestions?.length ? ` — did you mean: ${error.suggestions.join(', ')}?` : ''}`, { suggestions: error.suggestions });
            }
        }
        return { ok: true, skill, args };
    }

    /**
     * Run a skill directly (the caller already owns the body).
     * @param {object} opts {source, selfInitiated}
     */
    async run(name, rawArgs, ctx, signal, opts = {}) {
        const prep = this.prepare(name, rawArgs, ctx);
        if (!prep.ok) return prep;
        const { skill, args } = prep;
        const source = opts.source || 'self';
        if (ctx.permissions && !ctx.permissions.allows(source, skill.danger, { selfInitiated: !!opts.selfInitiated })) {
            return fail(CODES.FORBIDDEN, `${source} is not allowed to use ${name} (${skill.danger})`);
        }
        const started = Date.now();
        let timer = null;
        let timedOut = false;
        const inner = new AbortController();
        const onOuter = () => inner.abort(signal.reason);
        if (signal) {
            if (signal.aborted) return fail(CODES.ABORTED, String(signal.reason || 'aborted'));
            signal.addEventListener('abort', onOuter, { once: true });
        }
        if (skill.timeoutMs > 0) {
            timer = setTimeout(() => { timedOut = true; inner.abort('timeout'); }, skill.timeoutMs);
        }
        let result;
        try {
            result = await skill.run({ ...ctx, source }, args, inner.signal);
            if (!result || typeof result.ok !== 'boolean') result = fail(CODES.FAILED, `${name} returned no result`);
        } catch (error) {
            result = fromError(error);
            if (result.code === CODES.FAILED) this.logger?.debug?.(`${name} threw: ${error.stack || error}`);
        } finally {
            if (timer) clearTimeout(timer);
            if (signal) signal.removeEventListener('abort', onOuter);
        }
        if (timedOut && !result.ok) result = fail(CODES.TIMEOUT, `${name} timed out after ${Math.round(skill.timeoutMs / 1000)}s`, result.data);
        result.ms = Date.now() - started;
        result.skill = name;
        return result;
    }
}

function stripCustom(schema) {
    if (Array.isArray(schema)) return schema.map(stripCustom);
    if (!schema || typeof schema !== 'object') return schema;
    const out = {};
    for (const [k, v] of Object.entries(schema)) {
        if (k.startsWith('x-') || k === 'default') continue;
        out[k] = stripCustom(v);
    }
    return out;
}

module.exports = { SkillRegistry };
