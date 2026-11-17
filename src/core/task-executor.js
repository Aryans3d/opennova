/**
 * Task executor: exactly one task owns the bot's body at a time.
 *
 * - Tasks have a priority. A higher-priority submission preempts the running
 *   task by aborting its AbortSignal.
 * - A preempted task that declared `resumable` is put back on the queue and
 *   run again from the start. Skills are written to be idempotent / goal
 *   based ("have 3 iron_ingot"), so re-running continues from current state.
 */

const { EventEmitter } = require('events');
const { fail, fromError, CODES } = require('./result');

const PRIORITY = Object.freeze({
    REFLEX: 100,
    STOP: 80,
    OWNER: 60,
    TRUSTED: 40,
    MAINTENANCE: 20,
    SELF: 10
});

let nextId = 1;

class TaskExecutor extends EventEmitter {
    constructor(logger) {
        super();
        this.logger = logger;
        this.queue = [];
        this.current = null;
        this.draining = false;
    }

    /**
     * @param {object} spec
     * @param {string} spec.name
     * @param {number} spec.priority
     * @param {(signal: AbortSignal) => Promise<object>} spec.run
     * @param {boolean} [spec.resumable] re-queue when preempted
     * @param {boolean} [spec.yields] background task (follow, guard): any new task replaces it
     * @param {number} [spec.timeoutMs]
     * @param {string} [spec.source] who asked (player name, 'reflex', 'self')
     * @returns {Promise<object>} result object
     */
    submit(spec) {
        const task = {
            id: nextId++,
            name: spec.name,
            priority: spec.priority ?? PRIORITY.SELF,
            run: spec.run,
            resumable: !!spec.resumable,
            yields: !!spec.yields,       // background task: gives way to any new task
            timeoutMs: spec.timeoutMs || 0,
            source: spec.source || 'unknown',
            controller: null,
            preempted: false,
            attempts: 0,
            submittedAt: Date.now()
        };
        const promise = new Promise(resolve => { task.resolve = resolve; });

        if (this.current && (task.priority > this.current.priority || this.current.yields)) {
            this.current.preempted = true;
            this.current.controller.abort(`preempted by ${task.name}`);
        }
        this.queue.push(task);
        this.queue.sort((a, b) => b.priority - a.priority || a.id - b.id);
        this._drain();
        return promise;
    }

    /** Abort the running task and drop everything queued. */
    cancelAll(reason = 'cancelled') {
        const dropped = this.queue.splice(0);
        for (const t of dropped) t.resolve(fail(CODES.ABORTED, reason));
        if (this.current) {
            this.current.preempted = false;
            this.current.resumable = false;
            this.current.controller.abort(reason);
        }
    }

    /** Abort tasks below a priority (used when the owner gives a manual command). */
    cancelBelow(priority, reason = 'cancelled') {
        const keep = [];
        for (const t of this.queue) {
            if (t.priority < priority) t.resolve(fail(CODES.ABORTED, reason));
            else keep.push(t);
        }
        this.queue = keep;
        if (this.current && this.current.priority < priority) {
            this.current.resumable = false;
            this.current.controller.abort(reason);
        }
    }

    isBusy() {
        return !!this.current || this.queue.length > 0;
    }

    status() {
        return {
            current: this.current ? { name: this.current.name, priority: this.current.priority, source: this.current.source } : null,
            queued: this.queue.map(t => ({ name: t.name, priority: t.priority }))
        };
    }

    async _drain() {
        if (this.draining) return;
        this.draining = true;
        try {
            while (this.queue.length > 0) {
                const task = this.queue.shift();
                this.current = task;
                task.controller = new AbortController();
                task.preempted = false;
                task.attempts++;
                this.emit('start', task);

                let timer = null;
                if (task.timeoutMs > 0) {
                    timer = setTimeout(() => {
                        task.timedOut = true;
                        task.controller.abort('timeout');
                    }, task.timeoutMs);
                }

                let result;
                try {
                    result = await task.run(task.controller.signal);
                    if (!result || typeof result.ok !== 'boolean') {
                        result = fail(CODES.FAILED, `task ${task.name} returned no result`);
                    }
                } catch (error) {
                    result = fromError(error);
                }
                if (timer) clearTimeout(timer);
                if (task.timedOut && !result.ok) result = fail(CODES.TIMEOUT, `${task.name} timed out`, result.data);

                this.current = null;

                if (task.preempted && task.resumable && !result.ok && task.attempts < 6) {
                    this.logger?.debug?.(`Task ${task.name} preempted; re-queued`);
                    this.queue.push(task);
                    this.queue.sort((a, b) => b.priority - a.priority || a.id - b.id);
                    this.emit('requeue', task);
                    continue;
                }
                this.emit('end', task, result);
                task.resolve(result);
            }
        } finally {
            this.draining = false;
            this.emit('idle');
        }
    }
}

module.exports = { TaskExecutor, PRIORITY };
