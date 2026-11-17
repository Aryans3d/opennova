/**
 * Google Gemini adapter (native generateContent API).
 */

const { postJson } = require('./errors');

const KEEP = new Set(['type', 'properties', 'required', 'items', 'enum', 'description', 'minimum', 'maximum', 'minItems', 'maxItems']);

/** Gemini accepts a subset of JSON Schema; drop everything else. */
function cleanSchema(schema) {
    if (!schema || typeof schema !== 'object') return schema;
    if (Array.isArray(schema)) return schema.map(cleanSchema);
    const out = {};
    for (const [k, v] of Object.entries(schema)) {
        if (!KEEP.has(k)) continue;
        if (k === 'properties') {
            out.properties = {};
            for (const [name, sub] of Object.entries(v)) out.properties[name] = cleanSchema(sub);
        } else if (k === 'items') {
            out.items = cleanSchema(v);
        } else {
            out[k] = v;
        }
    }
    return out;
}

class GeminiAdapter {
    constructor(role) {
        this.role = role;
    }

    async complete({ system, messages, tools, maxTokens }) {
        const role = this.role;
        const body = {
            systemInstruction: { parts: [{ text: system }] },
            contents: messages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
            generationConfig: { maxOutputTokens: maxTokens || role.maxTokens || 4096, ...(role.generationConfig || {}) }
        };
        if (tools && tools.length) {
            body.tools = [{
                functionDeclarations: tools.map(t => {
                    const decl = { name: t.name, description: t.description };
                    const params = cleanSchema(t.parameters);
                    if (params && params.properties && Object.keys(params.properties).length) decl.parameters = params;
                    return decl;
                })
            }];
        }
        const url = `${role.baseURL}/models/${encodeURIComponent(role.model)}:generateContent`;
        const json = await postJson(url, { 'x-goog-api-key': role.apiKey || '' }, body, role.timeoutMs || 60000);

        const candidate = (json.candidates || [])[0] || {};
        let text = '';
        const toolCalls = [];
        for (const part of candidate.content?.parts || []) {
            if (part.thought) continue;
            if (typeof part.text === 'string') text += part.text;
            if (part.functionCall && part.functionCall.name) toolCalls.push({ name: part.functionCall.name, args: part.functionCall.args || {} });
        }
        const u = json.usageMetadata || {};
        const blocked = !!json.promptFeedback?.blockReason || ['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST'].includes(candidate.finishReason);
        return {
            text: text.trim(),
            toolCalls,
            truncated: candidate.finishReason === 'MAX_TOKENS',
            refused: blocked,
            stop: candidate.finishReason,
            model: json.modelVersion || role.model,
            usage: { input: u.promptTokenCount || 0, output: (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0), cached: u.cachedContentTokenCount || 0 }
        };
    }
}

module.exports = { GeminiAdapter, cleanSchema };
