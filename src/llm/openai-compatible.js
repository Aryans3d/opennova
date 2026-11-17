/**
 * OpenAI chat-completions adapter. Covers OpenAI, OpenRouter, Groq,
 * DeepSeek, Mistral, xAI, Together, Ollama, LM Studio, vLLM and any other
 * server that speaks the same format.
 */

const { postJson } = require('./errors');

class OpenAICompatibleAdapter {
    constructor(role) {
        this.role = role;
    }

    async complete({ system, messages, tools, maxTokens }) {
        const role = this.role;
        const body = {
            model: role.model,
            messages: [{ role: 'system', content: system }, ...messages.map(m => ({ role: m.role, content: m.content }))],
            [role.tokenParam || 'max_tokens']: maxTokens || role.maxTokens || 4096,
            ...(role.extraBody || {})
        };
        if (tools && tools.length) {
            body.tools = tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
            body.tool_choice = 'auto';
        }
        if (role.effort) body.reasoning_effort = role.effort;

        const headers = { ...(role.headers || {}) };
        if (role.apiKey) headers.authorization = `Bearer ${role.apiKey}`;
        const json = await postJson(`${role.baseURL}/chat/completions`, headers, body, role.timeoutMs || 60000);

        const choice = (json.choices || [])[0] || {};
        const message = choice.message || {};
        let text = typeof message.content === 'string'
            ? message.content
            : Array.isArray(message.content) ? message.content.map(p => p.text || '').join('') : '';
        const toolCalls = [];
        for (const call of message.tool_calls || []) {
            const fn = call.function || {};
            if (!fn.name) continue;
            toolCalls.push({ name: fn.name, args: parseArgs(fn.arguments) });
        }
        // Small local models often print the call as text instead of using the tool channel.
        if (!toolCalls.length && tools && tools.length && text) {
            const names = new Set(tools.map(t => t.name));
            const extracted = extractToolCalls(text, names);
            if (extracted.calls.length) {
                toolCalls.push(...extracted.calls);
                text = extracted.rest;
            }
        }
        text = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
        const u = json.usage || {};
        return {
            text,
            toolCalls,
            truncated: choice.finish_reason === 'length',
            refused: choice.finish_reason === 'content_filter' || !!message.refusal,
            stop: choice.finish_reason,
            model: json.model || role.model,
            usage: { input: u.prompt_tokens || 0, output: u.completion_tokens || 0, cached: u.prompt_tokens_details?.cached_tokens || 0 }
        };
    }
}

function parseArgs(raw) {
    if (raw && typeof raw === 'object') return raw;
    if (!raw) return {};
    try {
        const v = JSON.parse(raw);
        return v && typeof v === 'object' ? v : {};
    } catch (_) {
        return { _invalid: String(raw).slice(0, 200) };
    }
}

/** Pull `{"name": "...", "arguments": {...}}` objects out of free text. */
function extractToolCalls(text, names) {
    const calls = [];
    let rest = text;
    const candidates = [];
    const tagged = /<tool_call>([\s\S]*?)<\/tool_call>|```(?:json)?\s*([\s\S]*?)```/g;
    let m;
    while ((m = tagged.exec(text))) candidates.push({ raw: m[0], body: (m[1] || m[2] || '').trim() });
    if (!candidates.length) {
        const trimmed = text.trim();
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) candidates.push({ raw: text, body: trimmed });
    }
    for (const c of candidates) {
        let parsed;
        try { parsed = JSON.parse(c.body); } catch (_) { continue; }
        const list = Array.isArray(parsed) ? parsed : [parsed];
        let used = false;
        for (const obj of list) {
            if (!obj || typeof obj !== 'object') continue;
            const name = obj.name || obj.tool || obj.function?.name;
            const args = obj.arguments ?? obj.parameters ?? obj.args ?? obj.function?.arguments ?? {};
            if (name && names.has(name)) {
                calls.push({ name, args: parseArgs(args) });
                used = true;
            }
        }
        if (used) rest = rest.replace(c.raw, '');
    }
    return { calls, rest: rest.trim() };
}

module.exports = { OpenAICompatibleAdapter, extractToolCalls };
