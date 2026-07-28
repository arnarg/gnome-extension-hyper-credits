import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Secret from 'gi://Secret';

const SERVICE = 'hyper-credits';
const ACCOUNT = 'oauth';
const LABEL = 'Charm Hyper OAuth credentials';

const SCHEMA = new Secret.Schema('land.charm.Hyper.Credentials', Secret.SchemaFlags.NONE, {
    service: Secret.SchemaAttributeType.STRING,
    account: Secret.SchemaAttributeType.STRING,
});

const ATTRIBUTES = { service: SERVICE, account: ACCOUNT };

function fallbackPath() {
    return GLib.build_filenamev([
        GLib.get_user_config_dir(), 'hyper-credits', 'credentials.json',
    ]);
}

async function secretStore(payload) {
    return new Promise((resolve, reject) => {
        Secret.password_store(SCHEMA, ATTRIBUTES, Secret.COLLECTION_DEFAULT,
            LABEL, payload, null, (_source, result) => {
                try {
                    Secret.password_store_finish(result);
                    resolve(true);
                } catch (e) {
                    reject(e);
                }
            });
    });
}

async function secretLookup() {
    return new Promise((resolve, reject) => {
        Secret.password_lookup(SCHEMA, ATTRIBUTES, null, (_source, result) => {
            try {
                resolve(Secret.password_lookup_finish(result));
            } catch (e) {
                reject(e);
            }
        });
    });
}

async function secretClear() {
    return new Promise((resolve, reject) => {
        Secret.password_clear(SCHEMA, ATTRIBUTES, null, (_source, result) => {
            try {
                resolve(Secret.password_clear_finish(result));
            } catch (e) {
                reject(e);
            }
        });
    });
}

function fileStore(payload) {
    const path = fallbackPath();
    const dir = GLib.path_get_dirname(path);
    GLib.mkdir_with_parents(dir, 0o700);

    const file = Gio.File.new_for_path(path);
    file.replace_contents(payload, null, false,
        Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION, null);
}

function fileLookup() {
    const path = fallbackPath();
    if (!GLib.file_test(path, GLib.FileTest.EXISTS))
        return null;

    const file = Gio.File.new_for_path(path);
    const [, bytes] = file.load_contents(null);
    return new TextDecoder('utf-8').decode(bytes);
}

function fileClear() {
    const path = fallbackPath();
    if (!GLib.file_test(path, GLib.FileTest.EXISTS))
        return;
    Gio.File.new_for_path(path).delete(null);
}

function serialize(credentials) {
    return JSON.stringify({
        type: 'oauth',
        access: credentials.access,
        refresh: credentials.refresh,
        expires: credentials.expires,
        teamName: credentials.teamName ?? null,
        teamId: credentials.teamId ?? null,
        userId: credentials.userId ?? null,
    });
}

function deserialize(payload) {
    if (!payload)
        return null;
    try {
        const data = JSON.parse(payload);
        if (data?.type !== 'oauth')
            return null;
        if (typeof data.access !== 'string' || typeof data.refresh !== 'string')
            return null;
        if (typeof data.expires !== 'number')
            return null;
        return {
            access: data.access,
            refresh: data.refresh,
            expires: data.expires,
            teamName: typeof data.teamName === 'string' ? data.teamName : null,
            teamId: typeof data.teamId === 'string' ? data.teamId : null,
            userId: typeof data.userId === 'string' ? data.userId : null,
        };
    } catch {
        return null;
    }
}

export class CredentialsStore {
    constructor() {
        this._useSecret = true;
    }

    async save(credentials) {
        const payload = serialize(credentials);
        if (this._useSecret) {
            try {
                await secretStore(payload);
                return;
            } catch (e) {
                log(`hyper-credits: libsecret unavailable, using file fallback: ${e.message}`);
                this._useSecret = false;
            }
        }
        fileStore(payload);
    }

    async load() {
        if (this._useSecret) {
            try {
                const payload = await secretLookup();
                if (payload)
                    return deserialize(payload);
            } catch (e) {
                log(`hyper-credits: libsecret lookup failed, trying file: ${e.message}`);
                this._useSecret = false;
            }
        }
        try {
            return deserialize(fileLookup());
        } catch (e) {
            log(`hyper-credits: credential file read failed: ${e.message}`);
            return null;
        }
    }

    async clear() {
        if (this._useSecret) {
            try {
                await secretClear();
            } catch (e) {
                log(`hyper-credits: libsecret clear failed: ${e.message}`);
            }
        }
        try {
            fileClear();
        } catch {
            // best effort
        }
    }

    isAccessValid(credentials) {
        return credentials !== null && Date.now() < credentials.expires;
    }
}
