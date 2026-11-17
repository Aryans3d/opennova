/**
 * Agent memory.
 *
 * Spatial facts (home, waypoints, chests) stay in the existing JSON
 * MemorySystem so the legacy commands and the agent share one source.
 * Episodes, lessons and key/value facts live in SQLite with full-text
 * search (node:sqlite, built into Node 22+). If SQLite is unavailable the
 * store degrades to an in-process list so the bot still runs.
 */

const path = require('path');

function openDatabase(file, logger) {
    try {
        const { DatabaseSync } = require('node:sqlite');
        const db = new DatabaseSync(file);
        db.exec(`
            PRAGMA journal_mode = WAL;
            CREATE TABLE IF NOT EXISTS episodes (
                id INTEGER PRIMARY KEY, t INTEGER NOT NULL, kind TEXT NOT NULL,
                text TEXT NOT NULL, importance INTEGER NOT NULL DEFAULT 3, who TEXT
            );
            CREATE VIRTUAL TABLE IF NOT EXISTS episodes_fts USING fts5(text, content='episodes', content_rowid='id');
            CREATE TRIGGER IF NOT EXISTS episodes_ai AFTER INSERT ON episodes BEGIN
                INSERT INTO episodes_fts(rowid, text) VALUES (new.id, new.text);
            END;
            CREATE TRIGGER IF NOT EXISTS episodes_ad AFTER DELETE ON episodes BEGIN
                INSERT INTO episodes_fts(episodes_fts, rowid, text) VALUES ('delete', old.id, old.text);
            END;
            CREATE TABLE IF NOT EXISTS lessons (
                id INTEGER PRIMARY KEY, t INTEGER NOT NULL, trigger TEXT NOT NULL, text TEXT NOT NULL,
                UNIQUE(trigger, text)
            );
            CREATE TABLE IF NOT EXISTS facts (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        `);
        return db;
    } catch (error) {
        logger?.warn?.(`SQLite memory unavailable (${error.message}); using in-process memory only`);
        return null;
    }
}

const STOP = new Set(['the', 'and', 'for', 'you', 'can', 'get', 'with', 'that', 'this', 'from', 'have', 'some', 'please', 'make', 'are', 'was', 'what', 'where', 'need', 'want', 'bring', 'give']);

class AgentMemory {
    /**
     * @param {object} legacy existing MemorySystem (JSON)
     * @param {string} dataDir directory for nova.db, or ':memory:'
     */
    constructor(legacy, dataDir, logger) {
        this.legacy = legacy;
        this.logger = logger;
        this.db = openDatabase(dataDir === ':memory:' ? ':memory:' : path.join(dataDir, 'nova.db'), logger);
        this.fallback = { episodes: [], lessons: [], facts: {} };
        this.writes = 0;
        if (this.db) {
            this.q = {
                addEpisode: this.db.prepare('INSERT INTO episodes (t, kind, text, importance, who) VALUES (?, ?, ?, ?, ?)'),
                search: this.db.prepare(`SELECT e.id, e.t, e.kind, e.text, e.importance, bm25(episodes_fts) AS rank
                    FROM episodes_fts JOIN episodes e ON e.id = episodes_fts.rowid
                    WHERE episodes_fts MATCH ? ORDER BY rank LIMIT 40`),
                recent: this.db.prepare('SELECT t, kind, text, importance FROM episodes ORDER BY id DESC LIMIT ?'),
                byKind: this.db.prepare('SELECT t, kind, text, importance FROM episodes WHERE kind = ? ORDER BY id DESC LIMIT ?'),
                prune: this.db.prepare('DELETE FROM episodes WHERE id IN (SELECT id FROM episodes WHERE importance < 8 ORDER BY id DESC LIMIT -1 OFFSET 4000)'),
                addLesson: this.db.prepare('INSERT OR IGNORE INTO lessons (t, trigger, text) VALUES (?, ?, ?)'),
                lessons: this.db.prepare('SELECT trigger, text FROM lessons WHERE trigger = ? ORDER BY id DESC LIMIT 3'),
                countLessons: this.db.prepare('SELECT COUNT(*) AS n FROM lessons'),
                pruneLessons: this.db.prepare('DELETE FROM lessons WHERE id IN (SELECT id FROM lessons ORDER BY id DESC LIMIT -1 OFFSET 300)'),
                setFact: this.db.prepare('INSERT INTO facts (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
                getFact: this.db.prepare('SELECT value FROM facts WHERE key = ?')
            };
        }
    }

    close() {
        try { if (this.db) this.db.close(); } catch (_) { /* ignore */ }
        this.db = null;
    }

    // ---------- spatial (delegated to the JSON store) ----------
    allChests() { return Object.values(this.legacy?.chests || {}); }
    updateChest(position, contents, label) { return this.legacy?.updateChest(position, contents, label); }
    forgetChest(position) { return this.legacy?.forgetChest(position); }
    getBaseChests() { return this.legacy?.getBaseChests() || []; }
    getHome() { return this.legacy?.getHome() || null; }
    setHome(position) { return this.legacy?.setHome(position); }
    getDeathLocation() { return this.legacy?.getDeathLocation() || null; }
    saveWaypoint(name, position) { return this.legacy?.saveWaypoint(name, position); }
    getWaypoint(name) { return this.legacy?.getWaypoint(name) || null; }
    listWaypoints() { return this.legacy?.listWaypoints() || []; }
    addStat(stat, n) { return this.legacy?.addStat(stat, n); }

    // ---------- episodic ----------
    addEpisode(kind, text, importance = 3, who = null) {
        const t = Date.now();
        const clean = String(text).slice(0, 500);
        if (this.db) {
            this.q.addEpisode.run(t, kind, clean, importance, who);
            if (++this.writes % 200 === 0) this.q.prune.run();
        } else {
            this.fallback.episodes.push({ t, kind, text: clean, importance, who });
            if (this.fallback.episodes.length > 500) this.fallback.episodes.shift();
        }
    }

    recent(n = 5) {
        if (this.db) return this.q.recent.all(n).reverse();
        return this.fallback.episodes.slice(-n);
    }

    facts(n = 8) {
        if (this.db) return this.q.byKind.all('fact', n).reverse();
        return this.fallback.episodes.filter(e => e.kind === 'fact').slice(-n);
    }

    /** Keyword search ranked by relevance x recency x importance. */
    search(query, k = 5) {
        const terms = [...new Set(String(query).toLowerCase().match(/[a-z0-9_]{3,}/g) || [])].filter(t => !STOP.has(t)).slice(0, 12);
        if (!terms.length) return [];
        const now = Date.now();
        let rows;
        if (this.db) {
            const match = terms.map(t => `"${t}"`).join(' OR ');
            try { rows = this.q.search.all(match); } catch (_) { rows = []; }
            rows = rows.map(r => ({ ...r, rel: -r.rank }));
        } else {
            rows = this.fallback.episodes
                .map(e => ({ ...e, rel: terms.filter(t => e.text.toLowerCase().includes(t)).length }))
                .filter(e => e.rel > 0);
        }
        return rows
            .map(r => {
                const ageDays = (now - r.t) / 86400000;
                return { ...r, score: (0.2 + r.rel) * Math.pow(0.97, ageDays) * (1 + r.importance / 5) };
            })
            .sort((a, b) => b.score - a.score)
            .slice(0, k);
    }

    // ---------- lessons ----------
    addLesson(trigger, text) {
        const t = String(trigger).toLowerCase().slice(0, 60);
        const body = String(text).slice(0, 300);
        if (this.db) {
            this.q.addLesson.run(Date.now(), t, body);
            if (this.q.countLessons.get().n > 400) this.q.pruneLessons.run();
        } else if (!this.fallback.lessons.some(l => l.trigger === t && l.text === body)) {
            this.fallback.lessons.push({ trigger: t, text: body });
        }
    }

    lessonsFor(triggers) {
        const out = [];
        const seen = new Set();
        for (const raw of triggers) {
            const t = String(raw).toLowerCase();
            const rows = this.db ? this.q.lessons.all(t) : this.fallback.lessons.filter(l => l.trigger === t).slice(-3);
            for (const r of rows) if (!seen.has(r.text)) { seen.add(r.text); out.push(r); }
        }
        return out.slice(0, 6);
    }

    // ---------- key/value facts ----------
    setFact(key, value) {
        const v = JSON.stringify(value);
        if (this.db) this.q.setFact.run(key, v);
        else this.fallback.facts[key] = v;
    }

    getFact(key, fallback = null) {
        const raw = this.db ? this.q.getFact.get(key)?.value : this.fallback.facts[key];
        if (raw === undefined || raw === null) return fallback;
        try { return JSON.parse(raw); } catch (_) { return fallback; }
    }
}

module.exports = { AgentMemory };
