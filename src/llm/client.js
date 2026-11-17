/**
 * LLM client: role selection (fast / smart), retries, and hourly budgets.
 * Nothing above this file knows which provider is in use.
 */

const { resolveRole } = require('./providers');
const { LLMError } = require('./errors');

function createAdapter(role) {
    switch (role.kind) {
        case 'anthropic': return new (require('./anthropic').AnthropicAdapter)(role);
        case 'gemini': return new (require('./gemini').GeminiAdapter)(role);
        case 'openai': return new (require('./openai-compatible').OpenAICompatibleAdapter)(role);
        default: throw new Error(`no adapter for kind "${role.kind}"`);
    }
}

class LLM {
    /**
     * @param {object} config config.llm: { fast, smart, budget: { callsPerHour, tokensPerHour } }
     */
    constructor(config = {}, logger = null) {
        this.logger = logger;
        this.roles = {};
        this.problems = [];
        for (const name of ['fast', 'smart']) {
            try {
                const role = resolveRole(config[name]);
                if (!role) continue;
                if (role.needsKey && !role.apiKey) {
                    this.problems.push(`${name}: set ${role.apiKeyEnv} to use ${role.provider}`);
                    continue;
                }
                this.roles[name] = { config: role, adapter: createAdapter(role) };
            } catch (error) {
                this.problems.push(`${name}: ${error.message}`);
            }
        }
        this.budget = { callsPerHour: 240, tokensPerHour: 600000, ...(config.budget || {}) };
        this.window = [];   // { t, tokens }
        this.totals = { calls: 0, input: 0, output: 0, cached: 0 };
        this.disabled = null;
    }

    get enabled() {
        return !this.disabled && !!(this.roles.fast || this.roles.smart);
    }

    has(role) {
        return !!this.roles[role];
    }

    describe() {
        const part = n => (this.roles[n] ? `${n}=${this.roles[n].config.provider}/${this.roles[n].config.model}` : `${n}=none`);
        return `${part('fast')} ${part('smart')}`;
    }

    spent() {
        const cutoff = Date.now() - 3600000;
        while (this.window.length && this.window[0].t < cutoff) this.window.shift();
        return { calls: this.window.length, tokens: this.window.reduce((s, w) => s + w.tokens, 0) };
    }

    overBudget() {
        const s = this.spent();
        return s.calls >= this.budget.callsPerHour || s.tokens >= this.budget.tokensPerHour;
    }

    /**
     * @param {'fast'|'smart'} roleName falls back to the other role if this one is not configured
     */
    async complete(roleName, request) {
        if (this.disabled) throw new LLMError('auth', this.disabled, false);
        const role = this.roles[roleName] || this.roles.fast || this.roles.smart;
        if (!role) throw new LLMError('config', 'no LLM configured', false);
        if (this.overBudget()) throw new LLMError('budget', 'hourly LLM budget reached', false);

        const started = Date.now();
        let lastError;
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                const res = await role.adapter.complete(request);
                res.ms = Date.now() - started;
                res.role = this.roles[roleName] ? roleName : (this.roles.fast ? 'fast' : 'smart');
                const tokens = (res.usage?.input || 0) + (res.usage?.output || 0);
                this.window.push({ t: Date.now(), tokens });
                this.totals.calls++;
                this.totals.input += res.usage?.input || 0;
                this.totals.output += res.usage?.output || 0;
                this.totals.cached += res.usage?.cached || 0;
                return res;
            } catch (error) {
                lastError = error instanceof LLMError ? error : new LLMError('unknown', error.message || String(error), false);
                if (lastError.kind === 'auth') {
                    // Do not hammer a provider that has rejected the key.
                    this.disabled = lastError.message;
                    throw lastError;
                }
                // The Anthropic SDK already retried; only the fetch adapters retry here.
                if (!lastError.retryable || role.config.kind === 'anthropic') throw lastError;
                await new Promise(r => setTimeout(r, 400 * Math.pow(3, attempt)));
            }
        }
        throw lastError;
    }
}

module.exports = { LLM, createAdapter };
