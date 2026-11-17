/**
 * Result type shared by every skill.
 * Skills never throw for expected failures and never return bare booleans:
 * the planner and the model branch on `code`.
 */

const CODES = Object.freeze({
    OK: 'OK',
    MISSING_ITEM: 'MISSING_ITEM',
    NO_BLOCK_IN_RANGE: 'NO_BLOCK_IN_RANGE',
    NO_PATH: 'NO_PATH',
    NEED_TOOL_TIER: 'NEED_TOOL_TIER',
    NEED_STATION: 'NEED_STATION',
    INVENTORY_FULL: 'INVENTORY_FULL',
    TIMEOUT: 'TIMEOUT',
    ABORTED: 'ABORTED',
    UNSAFE: 'UNSAFE',
    NOT_FOUND: 'NOT_FOUND',
    BLOCKED: 'BLOCKED',
    INVALID_ARGS: 'INVALID_ARGS',
    FORBIDDEN: 'FORBIDDEN',
    FAILED: 'FAILED'
});

function ok(data = {}, message = 'ok') {
    return { ok: true, code: CODES.OK, message, data };
}

function fail(code, message, data = {}) {
    return { ok: false, code: CODES[code] ? code : CODES.FAILED, message, data };
}

class AbortError extends Error {
    constructor(reason = 'aborted') {
        super(reason);
        this.name = 'AbortError';
    }
}

/** Throw if the signal is aborted. Call between awaits inside skills. */
function check(signal) {
    if (signal && signal.aborted) throw new AbortError(String(signal.reason || 'aborted'));
}

/** Abortable sleep. */
function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal && signal.aborted) return reject(new AbortError(String(signal.reason || 'aborted')));
        const timer = setTimeout(() => {
            if (signal) signal.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        function onAbort() {
            clearTimeout(timer);
            reject(new AbortError(String(signal.reason || 'aborted')));
        }
        if (signal) signal.addEventListener('abort', onAbort, { once: true });
    });
}

/**
 * Race a promise against an abort signal. `onAbort` should stop the
 * underlying work (e.g. bot.pathfinder.stop()), since promises can't be killed.
 */
function abortable(promise, signal, onAbort) {
    if (!signal) return promise;
    if (signal.aborted) {
        try { if (onAbort) onAbort(); } catch (_) { /* ignore */ }
        promise.catch(() => {});
        return Promise.reject(new AbortError(String(signal.reason || 'aborted')));
    }
    return new Promise((resolve, reject) => {
        const handler = () => {
            try { if (onAbort) onAbort(); } catch (_) { /* ignore */ }
            reject(new AbortError(String(signal.reason || 'aborted')));
        };
        signal.addEventListener('abort', handler, { once: true });
        promise.then(
            v => { signal.removeEventListener('abort', handler); resolve(v); },
            e => { signal.removeEventListener('abort', handler); reject(e); }
        );
    });
}

/** Convert anything thrown inside a skill into a result. */
function fromError(error) {
    if (error && error.name === 'AbortError') return fail(CODES.ABORTED, error.message || 'aborted');
    const msg = (error && error.message) || String(error);
    if (/no path|path was stopped|took to long|goal.*changed|cannot find/i.test(msg)) return fail(CODES.NO_PATH, msg);
    return fail(CODES.FAILED, msg);
}

module.exports = { CODES, ok, fail, check, sleep, abortable, fromError, AbortError };
