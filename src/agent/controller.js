/**
 * Controller: the one place that makes decisions.
 *
 * Plan-then-execute. One model call turns an order into a chat reply plus a
 * short list of skill calls. Those run with no further model calls. Only a
 * failure (or a question that needs the result of a lookup) goes back to the
 * model. The reply and the actions come from the same decision, so what the
 * bot says and what it does cannot drift apart.
 */

const { PRIORITY } = require('../core/task-executor');
const { TRUST } = require('../core/permissions');
const { fail, CODES } = require('../core/result');
const { systemPrompt, userMessage, CONTROL_TOOLS, truncate } = require('./prompt');
const { renderSnapshot } = require('./snapshot');

const INFORMATIONAL = new Set(['status', 'find_item', 'recall', 'plan_for', 'scan_chests', 'explore']);

class Controller {
    constructor(deps) {
        Object.assign(this, deps); // bot, llm, registry, executor, ctx, memory, permissions, world, tracer, logger, say, config
        this.maxRounds = this.config.agent?.maxRounds ?? 6;
        this.system = systemPrompt(this.bot.username || 'Nova');
        this.dialogue = [];       // recent exchanges with players
        this.otherChat = [];      // lines not addressed to us
        this.active = null;       // { id, abort }
        this.seq = 0;
        this._tools = null;
    }

    tools() {
        if (!this._tools) this._tools = [...this.registry.toolDefs(), ...CONTROL_TOOLS];
        return this._tools;
    }

    noteChat(who, text) {
        this.otherChat.push({ who, text });
        if (this.otherChat.length > 6) this.otherChat.shift();
    }

    remember(who, text) {
        this.dialogue.push({ who, text });
        if (this.dialogue.length > 10) this.dialogue.shift();
    }

    /** Stop whatever order is being handled. */
    cancel(reason = 'cancelled') {
        if (this.active) {
            this.active.abort.abort(reason);
            this.active = null;
        }
    }

    isBusy() {
        return !!this.active;
    }

    /**
     * Handle one order from a player.
     * @returns {Promise<{ok: boolean, summary: string}>}
     */
    async handle(username, text) {
        const level = this.permissions.level(username);
        if (level === TRUST.STRANGER) return { ok: false, summary: 'ignored stranger' };
        if (!this.llm.enabled) {
            this.say(`I can't think right now (${this.llm.disabled || 'no model configured'}). Commands with ${this.config.settings.commandPrefix} still work.`, username);
            return { ok: false, summary: 'llm unavailable' };
        }

        // A new order from someone with at least the same standing replaces the current one.
        this.cancel('superseded by a new order');
        const priority = level === TRUST.OWNER ? PRIORITY.OWNER : PRIORITY.TRUSTED;
        this.executor.cancelBelow(priority + 1, 'superseded by a new order');

        const id = ++this.seq;
        const abort = new AbortController();
        this.active = { id, abort };
        const started = Date.now();
        this.remember(username, text);

        const rounds = [];
        let role = 'fast';
        let failedRounds = 0;
        let invalidOutputs = 0;
        let outcome = { ok: false, summary: 'gave up' };
        const trace = { id, t: started, from: username, order: text, calls: [] };

        try {
            const terms = text.toLowerCase().match(/[a-z_]{3,}/g) || [];
            const memories = this.memory.search(text, 5).map(m => m.text);
            const facts = this.memory.facts(8).map(f => f.text);

            for (let round = 0; round < this.maxRounds; round++) {
                if (abort.signal.aborted) return { ok: false, summary: 'cancelled' };
                const lessonKeys = [...terms, ...rounds.flatMap(r => r.calls.map(c => `${c.name}:${c.result.code}`))];
                const prompt = userMessage({
                    order: text, from: username, trust: level === TRUST.OWNER ? 'owner' : 'trusted',
                    snapshot: renderSnapshot(this.ctx, { relevant: terms }),
                    mode: this.goals ? this.goals.mode : 'obey',
                    memories: memories.filter(m => !facts.includes(m)),
                    facts,
                    lessons: this.memory.lessonsFor(lessonKeys).map(l => l.text),
                    chat: this.otherChat,
                    dialogue: this.dialogue.slice(0, -1).slice(-6),
                    rounds
                });

                let res;
                try {
                    res = await this.llm.complete(role, { system: this.system, messages: [{ role: 'user', content: prompt }], tools: this.tools() });
                } catch (error) {
                    this.logger.error(`LLM error: ${error.message}`);
                    trace.error = error.message;
                    this.say(error.kind === 'budget'
                        ? 'I have used up my thinking budget for this hour. Commands still work.'
                        : `I couldn't think that through (${truncate(error.message, 80)}).`, username);
                    outcome = { ok: false, summary: `llm error: ${error.message}` };
                    return outcome;
                }
                if (abort.signal.aborted) return { ok: false, summary: 'cancelled' };
                trace.calls.push({ round, role: res.role, model: res.model, ms: res.ms, usage: res.usage, text: res.text, toolCalls: res.toolCalls, promptChars: prompt.length });
                this.logger.debug(`LLM ${res.role} ${res.ms}ms in=${res.usage?.input} out=${res.usage?.output} cached=${res.usage?.cached} calls=${res.toolCalls.map(c => c.name).join(',') || '-'}`);

                if (res.refused) {
                    this.say("I can't help with that one.", username);
                    outcome = { ok: false, summary: 'model declined' };
                    return outcome;
                }

                const escalate = res.toolCalls.find(c => c.name === 'escalate');
                if (escalate && role === 'fast' && this.llm.has('smart')) {
                    this.logger.info(`Escalating to the smart model: ${escalate.args?.reason || 'no reason given'}`);
                    role = 'smart';
                    continue;
                }
                const calls = res.toolCalls.filter(c => c.name !== 'escalate').slice(0, 6);

                if (res.text) {
                    this.say(res.text, username);
                    this.remember(this.bot.username, res.text);
                }
                if (!calls.length) {
                    if (!res.text && escalate) this.say("That one is beyond me right now.", username);
                    else if (!res.text && res.truncated && ++invalidOutputs < 2) continue;
                    outcome = { ok: failedRounds === 0 || rounds.length === 0 || rounds[rounds.length - 1].calls.every(c => c.result.ok), summary: res.text || 'no action' };
                    return outcome;
                }

                // Validate everything before touching the world.
                const prepared = calls.map(c => ({ call: c, prep: this.registry.prepare(c.name, c.args, this.ctx) }));
                const invalid = prepared.find(p => !p.prep.ok);
                if (invalid) {
                    rounds.push({ said: res.text, calls: [{ name: invalid.call.name, args: invalid.call.args, result: invalid.prep }], skipped: [] });
                    if (++invalidOutputs >= 2 && role === 'fast' && this.llm.has('smart')) role = 'smart';
                    continue;
                }

                // Never repeat a call that already failed with the same arguments.
                const failedBefore = new Set(rounds.flatMap(r => r.calls.filter(c => !c.result.ok).map(c => `${c.name}:${JSON.stringify(c.args)}`)));
                const repeat = prepared.find(p => failedBefore.has(`${p.call.name}:${JSON.stringify(p.prep.args)}`));
                if (repeat) {
                    if (role === 'fast' && this.llm.has('smart')) {
                        role = 'smart';
                        rounds.push({ said: res.text, calls: [{ name: repeat.call.name, args: repeat.prep.args, result: fail(CODES.INVALID_ARGS, 'this exact call already failed; choose a different approach') }], skipped: [] });
                        continue;
                    }
                    this.say(`I'm stuck: ${truncate(rounds[rounds.length - 1].calls.find(c => !c.result.ok)?.result.message || 'the same step keeps failing', 120)}`, username);
                    outcome = { ok: false, summary: 'loop detected' };
                    return outcome;
                }

                const record = await this.execute(prepared, username, priority, abort.signal, text);
                rounds.push({ said: res.text, ...record });
                trace.calls[trace.calls.length - 1].results = record.calls.map(c => ({ name: c.name, ok: c.result.ok, code: c.result.code, message: c.result.message, ms: c.result.ms }));

                const failed = record.calls.find(c => !c.result.ok);
                if (failed && failed.result.code === CODES.ABORTED) {
                    outcome = { ok: false, summary: 'interrupted' };
                    return outcome;
                }
                if (!failed) {
                    const needsAnswer = record.calls.some(c => INFORMATIONAL.has(c.name));
                    if (needsAnswer) continue; // the model has to read the lookup and answer
                    const last = record.calls[record.calls.length - 1];
                    // Templated confirmation: no model call needed for "it worked".
                    if (rounds.length > 1 || !res.text) this.say(`Done: ${truncate(last.result.message, 140)}.`, username);
                    outcome = { ok: true, summary: last.result.message };
                    return outcome;
                }

                failedRounds++;
                this.memory.addEpisode('failure', `${failed.name} failed (${failed.result.code}): ${failed.result.message}`, 4, username);
                if (failedRounds >= 2 && role === 'fast' && this.llm.has('smart')) {
                    this.logger.info('Two failed attempts; escalating to the smart model');
                    role = 'smart';
                }
            }
            this.say("I couldn't get that done after several tries.", username);
            outcome = { ok: false, summary: 'out of rounds' };
            return outcome;
        } finally {
            if (this.active && this.active.id === id) this.active = null;
            trace.ms = Date.now() - started;
            trace.outcome = outcome;
            trace.rounds = rounds.length;
            if (this.tracer) this.tracer.write(trace);
            if (!abort.signal.aborted) {
                this.memory.addEpisode('order', `${username} asked: "${truncate(text, 160)}" -> ${outcome.ok ? 'done' : 'not done'}: ${truncate(outcome.summary, 160)}`, outcome.ok ? 4 : 5, username);
                this.learn(rounds, outcome);
            }
        }
    }

    /** Run a round's calls as one task that owns the body. */
    async execute(prepared, username, priority, signal, label) {
        const calls = [];
        const skipped = [];
        const background = prepared.length === 1 && prepared[0].prep.skill.background;
        const run = async taskSignal => {
            const merged = AbortSignal.any([taskSignal, signal]);
            for (let i = 0; i < prepared.length; i++) {
                const { call, prep } = prepared[i];
                const result = await this.registry.run(call.name, prep.args, this.ctx, merged, { source: username });
                calls.push({ name: call.name, args: prep.args, result });
                if (!result.ok) {
                    for (const rest of prepared.slice(i + 1)) skipped.push({ name: rest.call.name, args: rest.prep.args });
                    return result;
                }
            }
            return calls[calls.length - 1].result;
        };
        if (background) {
            // follow / guard run until something else needs the body; report success at once.
            const { call, prep } = prepared[0];
            this.executor.submit({ name: `agent:${call.name}`, priority, source: username, yields: true, run: taskSignal => this.registry.run(call.name, prep.args, this.ctx, taskSignal, { source: username }) });
            calls.push({ name: call.name, args: prep.args, result: { ok: true, code: 'OK', message: `${call.name} started`, data: {} } });
            return { calls, skipped };
        }
        await this.executor.submit({ name: `agent:${truncate(label, 40)}`, priority, source: username, resumable: true, run });
        if (!calls.length) calls.push({ name: prepared[0].call.name, args: prepared[0].prep.args, result: fail(CODES.ABORTED, 'interrupted before it started') });
        return { calls, skipped };
    }

    /** Turn "failed, then a different approach worked" into a stored lesson. */
    learn(rounds, outcome) {
        if (!outcome.ok || rounds.length < 2) return;
        const firstFail = rounds.flatMap(r => r.calls).find(c => !c.result.ok && c.result.code !== CODES.INVALID_ARGS);
        const winning = rounds[rounds.length - 1].calls.filter(c => c.result.ok);
        if (!firstFail || !winning.length) return;
        const what = winning.map(c => `${c.name}(${truncate(JSON.stringify(c.args), 80)})`).join(' then ');
        const text = `When ${firstFail.name} fails with ${firstFail.result.code} (${truncate(firstFail.result.message, 80)}), this worked: ${what}`;
        this.memory.addLesson(`${firstFail.name}:${firstFail.result.code}`, text);
        const item = firstFail.args.item || (firstFail.args.blocks || [])[0];
        if (item) this.memory.addLesson(item, text);
    }
}

module.exports = { Controller };
