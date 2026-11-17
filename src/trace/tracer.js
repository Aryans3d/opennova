/** Decision trace: one JSON line per handled order, for debugging and benchmarks. */

const fs = require('fs');
const path = require('path');

class Tracer {
    constructor(dir, enabled = true) {
        this.enabled = enabled;
        this.dir = dir;
        this.ready = false;
    }

    write(record) {
        if (!this.enabled) return;
        try {
            if (!this.ready) { fs.mkdirSync(this.dir, { recursive: true }); this.ready = true; }
            const day = new Date().toISOString().slice(0, 10);
            fs.appendFile(path.join(this.dir, `trace-${day}.jsonl`), JSON.stringify(record) + '\n', () => {});
        } catch (_) { /* tracing must never break the bot */ }
    }
}

module.exports = { Tracer };
