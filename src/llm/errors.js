class LLMError extends Error {
    /**
     * @param {'auth'|'config'|'request'|'rate_limit'|'network'|'server'|'budget'|'unknown'} kind
     * @param {string} message
     * @param {boolean} retryable
     */
    constructor(kind, message, retryable = false) {
        super(message);
        this.name = 'LLMError';
        this.kind = kind;
        this.retryable = retryable;
    }
}

/** Shared HTTP helper for the fetch-based adapters. */
async function postJson(url, headers, body, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
        res = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...headers },
            body: JSON.stringify(body),
            signal: controller.signal
        });
    } catch (error) {
        const timedOut = error.name === 'AbortError';
        throw new LLMError('network', timedOut ? `request timed out after ${timeoutMs}ms` : `cannot reach ${new URL(url).host}: ${error.cause?.code || error.message}`, true);
    } finally {
        clearTimeout(timer);
    }
    const raw = await res.text();
    if (!res.ok) {
        let detail = raw.slice(0, 300);
        try {
            const j = JSON.parse(raw);
            detail = j.error?.message || j.error || j.message || detail;
            if (typeof detail !== 'string') detail = JSON.stringify(detail).slice(0, 300);
        } catch (_) { /* keep raw */ }
        if (res.status === 401 || res.status === 403) throw new LLMError('auth', `credentials rejected (${res.status}): ${detail}`, false);
        if (res.status === 404) throw new LLMError('config', `not found (check model name and baseURL): ${detail}`, false);
        if (res.status === 429) throw new LLMError('rate_limit', `rate limited: ${detail}`, true);
        if (res.status >= 500) throw new LLMError('server', `server error ${res.status}: ${detail}`, true);
        throw new LLMError('request', `request rejected (${res.status}): ${detail}`, false);
    }
    try {
        return JSON.parse(raw);
    } catch (_) {
        throw new LLMError('server', 'response was not JSON', true);
    }
}

module.exports = { LLMError, postJson };
