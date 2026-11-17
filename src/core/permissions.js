/**
 * Trust levels and danger classes, enforced in code (never by the prompt).
 */

const TRUST = Object.freeze({ STRANGER: 0, TRUSTED: 1, OWNER: 2 });

// Minimum trust needed to trigger a skill of each danger class.
const REQUIRED = Object.freeze({
    none: TRUST.TRUSTED,
    world_edit: TRUST.TRUSTED,
    destructive: TRUST.OWNER,
    hostile: TRUST.OWNER
});

class Permissions {
    /**
     * @param {object} settings config.settings
     * @param {object} [memory] object with getTrusted()/setTrusted() persistence (optional)
     */
    constructor(settings = {}, memory = null) {
        this.owner = (settings.owner || '').trim();
        this.trusted = new Set((settings.trusted || []).map(s => s.toLowerCase()));
        this.memory = memory;
        this.protectedRegions = [];
        this.claimed = false;
    }

    /** With no owner configured, the first player to speak becomes owner (single-player default). */
    claimIfUnowned(username) {
        if (!this.owner && username) {
            this.owner = username;
            this.claimed = true;
            return true;
        }
        return false;
    }

    level(username) {
        if (!username) return TRUST.STRANGER;
        if (username === 'self' || username === 'reflex') return TRUST.OWNER;
        if (this.owner && username.toLowerCase() === this.owner.toLowerCase()) return TRUST.OWNER;
        if (this.trusted.has(username.toLowerCase())) return TRUST.TRUSTED;
        return TRUST.STRANGER;
    }

    isOwner(username) {
        return this.level(username) === TRUST.OWNER;
    }

    trust(username) {
        this.trusted.add(username.toLowerCase());
    }

    untrust(username) {
        this.trusted.delete(username.toLowerCase());
    }

    /**
     * @param {string} username who is asking
     * @param {string} danger skill danger class
     * @param {object} [opts]
     * @param {boolean} [opts.selfInitiated] true when the agent chose this itself (autonomy)
     */
    allows(username, danger = 'none', opts = {}) {
        if (opts.selfInitiated && (danger === 'destructive' || danger === 'hostile')) return false;
        return this.level(username) >= (REQUIRED[danger] ?? TRUST.OWNER);
    }

    addProtectedRegion(center, radius, name = 'region') {
        this.protectedRegions = this.protectedRegions.filter(r => r.name !== name);
        this.protectedRegions.push({ name, x: center.x, y: center.y, z: center.z, radius });
    }

    isProtected(pos) {
        for (const r of this.protectedRegions) {
            const dx = pos.x - r.x, dz = pos.z - r.z;
            if (dx * dx + dz * dz <= r.radius * r.radius && Math.abs(pos.y - r.y) <= r.radius) return r.name;
        }
        return null;
    }
}

/** Outgoing chat must never be a server command unless allowlisted. */
function sanitizeChat(text, allow = ['/msg', '/tell', '/w', '/me']) {
    let t = String(text ?? '').replace(/[\r\n]+/g, ' ').trim();
    if (t.startsWith('/')) {
        const cmd = t.split(/\s+/)[0].toLowerCase();
        if (!allow.includes(cmd)) t = t.replace(/^\/+/, '');
    }
    return t.slice(0, 240);
}

module.exports = { Permissions, TRUST, sanitizeChat };
