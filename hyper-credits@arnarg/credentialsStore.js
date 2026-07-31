import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Secret from 'gi://Secret';

const SERVICE = 'hyper-credits';
const ACCOUNT = 'oauth';
const LABEL = 'Charm Hyper OAuth credentials';
const SCHEMA_NAME = 'land.charm.Hyper.Credentials';

const ATTRIBUTES = { service: SERVICE, account: ACCOUNT };

function fallbackPath() {
  return GLib.build_filenamev([
    GLib.get_user_config_dir(), 'hyper-credits', 'credentials.json',
  ]);
}

async function secretStore(schema, payload) {
  return new Promise((resolve, reject) => {
    Secret.password_store(schema, ATTRIBUTES, Secret.COLLECTION_DEFAULT,
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

async function secretLookup(schema) {
  return new Promise((resolve, reject) => {
    Secret.password_lookup(schema, ATTRIBUTES, null, (_source, result) => {
      try {
        resolve(Secret.password_lookup_finish(result));
      } catch (e) {
        reject(e);
      }
    });
  });
}

async function secretClear(schema) {
  return new Promise((resolve, reject) => {
    Secret.password_clear(schema, ATTRIBUTES, null, (_source, result) => {
      try {
        resolve(Secret.password_clear_finish(result));
      } catch (e) {
        reject(e);
      }
    });
  });
}

async function fileStore(payload) {
  const path = fallbackPath();
  const dir = GLib.path_get_dirname(path);
  GLib.mkdir_with_parents(dir, 0o700);

  const file = Gio.File.new_for_path(path);
  return new Promise((resolve, reject) => {
    file.replace_contents_async(payload, null, false,
      Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION, null, (_source, result) => {
        try {
          file.replace_contents_finish(result);
          resolve();
        } catch (e) {
          reject(e);
        }
      });
  });
}

async function fileLookup() {
  const path = fallbackPath();
  if (!GLib.file_test(path, GLib.FileTest.EXISTS))
    return null;

  const file = Gio.File.new_for_path(path);
  return new Promise((resolve, reject) => {
    file.load_contents_async(null, (_source, result) => {
      try {
        const [, bytes] = file.load_contents_finish(result);
        resolve(new TextDecoder('utf-8').decode(bytes));
      } catch (e) {
        reject(e);
      }
    });
  });
}

async function fileClear() {
  const path = fallbackPath();
  if (!GLib.file_test(path, GLib.FileTest.EXISTS))
    return;

  const file = Gio.File.new_for_path(path);
  return new Promise((resolve, reject) => {
    file.delete_async(GLib.PRIORITY_DEFAULT, null, (_source, result) => {
      try {
        file.delete_finish(result);
        resolve();
      } catch (e) {
        reject(e);
      }
    });
  });
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
  // Constructed only from Indicator, which lives for the duration of
  // enable(); the Secret.Schema GObject is therefore never created at module
  // scope and is released in destroy().
  constructor() {
    this._schema = new Secret.Schema(SCHEMA_NAME, Secret.SchemaFlags.NONE, {
      service: Secret.SchemaAttributeType.STRING,
      account: Secret.SchemaAttributeType.STRING,
    });
    this._useSecret = true;
  }

  destroy() {
    this._schema = null;
  }

  async save(credentials) {
    const payload = serialize(credentials);
    if (this._useSecret) {
      try {
        await secretStore(this._schema, payload);
        return;
      } catch (e) {
        log(`hyper-credits: libsecret unavailable, using file fallback: ${e.message}`);
        this._useSecret = false;
      }
    }
    await fileStore(payload);
  }

  async load() {
    if (this._useSecret) {
      try {
        const payload = await secretLookup(this._schema);
        if (payload)
          return deserialize(payload);
      } catch (e) {
        log(`hyper-credits: libsecret lookup failed, trying file: ${e.message}`);
        this._useSecret = false;
      }
    }
    try {
      return deserialize(await fileLookup());
    } catch (e) {
      log(`hyper-credits: credential file read failed: ${e.message}`);
      return null;
    }
  }

  async clear() {
    if (this._useSecret) {
      try {
        await secretClear(this._schema);
      } catch (e) {
        log(`hyper-credits: libsecret clear failed: ${e.message}`);
      }
    }
    try {
      await fileClear();
    } catch {
      // best effort
    }
  }

  isAccessValid(credentials) {
    return credentials !== null && Date.now() < credentials.expires;
  }
}
