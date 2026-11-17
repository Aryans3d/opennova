/**
 * Anthropic adapter (official SDK).
 *
 * Each call is a fresh request: stable system prompt and tool list first
 * (cached), volatile context in the user message. No thinking blocks are
 * replayed, so there is no history-editing concern.
 */

const Anthropic = require('@anthropic-ai/sdk');
const { LLMError } = require('./errors');

// Models whose safety classifiers can decline a request and that support a server-side fallback.
const SERVER_FALLBACK_MODELS = new Set(['claude-fable-5-2', 'claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);

class AnthropicAdapter {
    constructor(role) {
        this.role = role;
        const options = { timeout: role.timeoutMs || 60000, maxRetries: role.maxRetries ?? 2 };
        if (role.apiKey) options.apiKey = role.apiKey;
        if (role.baseURL) options.baseURL = role.baseURL;
        // With no explicit key the SDK resolves credentials from the environment or an `ant auth login` profile.
        this.client = new Anthropic(options);
    }

    async complete({ system, messages, tools, maxTokens }) {
        const role = this.role;
        const params = {
            model: role.model,
            max_tokens: maxTokens || role.maxTokens || 16000,
            system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
            messages: messages.map(m => ({ role: m.role, content: m.content }))
        };
        if (tools && tools.length) {
            params.tools = tools.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters }));
        }
        if (role.effort) params.output_config = { effort: role.effort };

        const useFallback = role.refusalFallback !== false && SERVER_FALLBACK_MODELS.has(role.model);
        let response;
        try {
            if (useFallback) {
                response = await this.client.beta.messages.create({
                    ...params,
                    betas: ['server-side-fallback-2026-07-01'],
                    fallbacks: 'default'
                });
            } else {
                response = await this.client.messages.create(params);
            }
        } catch (error) {
            throw mapError(error);
        }

        if (response.stop_reason === 'refusal') {
            return { text: '', toolCalls: [], refused: true, stop: 'refusal', model: response.model, usage: usage(response) };
        }
        let text = '';
        const toolCalls = [];
        for (const block of response.content || []) {
            if (block.type === 'text') text += block.text;
            else if (block.type === 'tool_use') toolCalls.push({ name: block.name, args: block.input || {} });
        }
        return {
            text: text.trim(),
            toolCalls,
            truncated: response.stop_reason === 'max_tokens',
            stop: response.stop_reason,
            model: response.model,
            usage: usage(response)
        };
    }
}

function usage(response) {
    const u = response.usage || {};
    const cached = u.cache_read_input_tokens || 0;
    return {
        input: (u.input_tokens || 0) + cached + (u.cache_creation_input_tokens || 0),
        output: u.output_tokens || 0,
        cached
    };
}

function mapError(error) {
    if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
        return new LLMError('auth', `Anthropic rejected the credentials: ${error.message}`, false);
    }
    if (error instanceof Anthropic.NotFoundError) return new LLMError('config', `Anthropic: ${error.message}`, false);
    if (error instanceof Anthropic.BadRequestError) return new LLMError('request', `Anthropic: ${error.message}`, false);
    if (error instanceof Anthropic.RateLimitError) return new LLMError('rate_limit', 'Anthropic rate limit', true);
    if (error instanceof Anthropic.APIConnectionError) return new LLMError('network', `cannot reach Anthropic: ${error.message}`, true);
    if (error instanceof Anthropic.APIError) return new LLMError('server', `Anthropic error ${error.status}: ${error.message}`, (error.status || 500) >= 500);
    if (error instanceof Anthropic.AnthropicError) return new LLMError('auth', error.message, false);
    return new LLMError('unknown', error.message || String(error), false);
}

module.exports = { AnthropicAdapter };
