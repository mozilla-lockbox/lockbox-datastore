/*!
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

const Items = require("./items"),
      ItemKeyStore = require("./itemkeystore"),
      DataStoreError = require("./util/errors"),
      instance = require("./util/instance"),
      localdatabase = require("./localdatabase"),
      jose = require("node-jose");

// BASE64URL(SHA-256("project lockbox"))
const PASSWORD_PREFIX = "-GV3ItzyNxfBGp3ZjtqVGswWWlT7tIMZjeXanHqhxm0";

function checkState(ds) {
  if (!ds.initialized) {
    throw new DataStoreError("data is not initialized", DataStoreError.NOT_INITIALIZED);
  }
  if (ds.locked) {
    throw new DataStoreError("datastore is locked", DataStoreError.LOCKED);
  }
}

function determineItemChanges(prev, next) {
  // TODO: calculate JSON-merge diff

  prev = prev || {};
  next = next || {};
  next = Object.assign({}, prev, next);

  let fields = [];
  // check title
  if (prev.title !== next.title) {
    fields.push("title");
  }
  // check previns
  let prevOrigins = [...(prev.origins || [])];
  let nextOrigins = [...(next.origins || [])];
  if (prevOrigins.length !== nextOrigins.length || !prevOrigins.every((d) => nextOrigins.indexOf(d) !== -1)) {
    fields.push("origins");
  }

  // check entries.(username,password,notes)
  let prevEntry = prev.entry || {};
  let nextEntry = next.entry || {};
  ["username", "password", "notes"].forEach((f) => {
    if (prevEntry[f] !== nextEntry[f]) {
      fields.push(`entry.${f}`);
    }
  });
  fields = fields.join(",");

  return {
    fields
  };
}


async function passwordToKey(pwd) {
  pwd = PASSWORD_PREFIX + (pwd || "");

  let key = {
    kty: "oct",
    k: jose.util.base64url.encode(pwd, "utf8"),
    use: "enc"
  };
  key = await jose.JWK.asKey(key);

  return key;
}

/**
 * Represents item storage.
 */
class DataStore {
  /**
   * Creates a new DataStore.
   *
   * **NOTE:** This constructor is not called directly.  Instead call
   * {@link open} to obtain a [prepared]{@link DataStore#prepare} instance.
   *
   * See {@link datastore.create} for the details of what `{cfg}`
   * parameters are supported.
   *
   * @param {Object} cfg - The configuration parameters.
   * @constructor
   */
  constructor(cfg) {
    cfg = cfg || {};

    let self = instance.stage(this);
    self.items = new Map();

    self.bucket = cfg.bucket;
    self.recordMetric = cfg.recordMetric || (async () => {});

    // TESTING ONLY: accept an (encrypted) item keys map
    self.keystore = new ItemKeyStore({
      encrypted: cfg.keys
    });
  }

  /**
   * Prepares this DataStore. This method:
   *
   * 1. initializes and opens the local database; and
   * 2. loads any stored keys from the local database.
   *
   * If the database is already prepared, this method does nothing.
   *
   * @returns {DataStore} This DataStore.
   */
  async prepare() {
    let self = instance.get(this);

    let ldb = self.ldb;
    if (!ldb) {
      ldb = await localdatabase.open(self.bucket);
      let keystore = await ldb.keystores.get("");
      if (!keystore) {
        keystore = self.keystore.toJSON();
      }

      keystore = new ItemKeyStore(keystore);
      Object.assign(self, {
        ldb,
        keystore
      });
    }

    return this;
  }

  /**
   * Indicates whether this DataStore is initialized.
   *
   * @type {boolean}
   * @readonly
   */
  get initialized() {
    return !!(instance.get(this).keystore.encrypted);
  }

  /**
   * Initializes this DataStore with the given options. This method
   * creates an empty item keystore, and encrypts it using the password
   * specified in `{opts}`.
   *
   * If no `{salt}` is provided, a randomly generated 16-byte value is used.
   *
   * @param {Object} opts The initialization options
   * @param {string} [opts.password=""] The master password to lock with
   * @param {string} [opts.salt] The salt to use in deriving the master
   *        key.
   * @param {number} [opts.iterations=8192] The iteration count to use in
   *        deriving the master key
   * @returns {DataStore} This datastore instance
   */
  async initialize(opts) {
    // TODO: remove this when everything is prepared
    await this.prepare();

    opts = opts || {};
    let self = instance.get(this);

    // TODO: deal with (soft / hard) reset
    if (self.keystore.encrypted) {
      // TODO: specific error reason?
      throw new DataStoreError("already initialized", DataStoreError.INITIALIZED);
    }

    opts = opts || {};
    let { password, salt, iterations } = opts || {};
    let masterKey = await passwordToKey(password || "");
    let keystore = new ItemKeyStore({
      salt,
      iterations,
      masterKey
    });
    self.keystore = await keystore.save();
    await self.ldb.keystores.put(self.keystore.toJSON());

    return this;
  }
  /**
   * Resets this Datastore. This method deletes all items and keys stored.
   * This is not a recoverable action.
   *
   * @returns {DataStore} This datastore instance
   */
  async reset() {
    if (this.initialized) {
      let self = instance.get(this);
      await self.ldb.delete();
      self.keystore.clear(true);
      delete self.ldb;
    }

    return this;
  }

  /**
   * Indicates if this datastore is locked or unlocked.
   *
   * @type {boolean}
   * @readonly
   */
  get locked() {
    return !(instance.get(this).keystore.masterKey);
  }
  /**
   * Locks this datastore.
   *
   * @returns {DataStore} This DataStore once locked
   */
  async lock() {
    let self = instance.get(this);

    await self.keystore.clear();

    return this;
  }
  /**
   * Attempts to unlock this datastore.
   *
   * @param {string} pwd The password to unlock the datastore.
   * @returns {DataStore} This DataStore once unlocked
   */
  async unlock(pwd) {
    let self = instance.get(this);
    let { keystore } = self;
    let masterKey;

    if (!this.locked) {
      // fast win
      return this;
    }

    try {
      masterKey = await passwordToKey(pwd);
      await keystore.load(masterKey);
    } catch (err) {
      // TODO: differentiate errors?
      throw err;
    }

    return this;
  }

  /**
   * Retrieves all of the items stored in this DataStore.
   *
   * @returns {Map<string, Object>} The map of stored item, by id
   */
  async list() {
    checkState(this);

    let self = instance.get(this);
    let all;
    all = await self.ldb.items.toArray();
    all = all.map(async i => {
      let { id, encrypted } = i;
      let item = await self.keystore.decrypt(id, encrypted);
      return [ id, item ];
    });
    all = await Promise.all(all);

    let result = new Map(all);

    return result;
  }

  /**
   * Retrieves a single item from this DataStore
   *
   * @param {string} id The item id to retrieve
   * @returns {Object} The JSON representing the item, or `null` if there is
   *          no item for `{id}`
   */
  async get(id) {
    checkState(this);

    let self = instance.get(this);
    let one = await self.ldb.items.get(id);
    if (one) {
      one = one.encrypted;
      one = await self.keystore.decrypt(id, one);
    }
    return one || null;
  }
  /**
   * Adds a new item to this DataStore.
   *
   * The `{id}` of the item is replaced with a new UUID.
   *
   * @param {Object} item - The item to add
   * @returns {Object} The added item, with all fields completed
   * @throws {TypeError} if `item` is invalid
   */
  async add(item) {
    checkState(this);

    let self = instance.get(this);
    if (!item) {
      // TODO: custom errors
      throw new TypeError("expected item");
    }

    // validate, and fill defaults into, {item}
    item = Items.prepare(item);

    let id = item.id,
        active = !item.disabled ? "active" : "",
        encrypted = await self.keystore.encrypt(item);

    let record = {
      id,
      active,
      encrypted
    };
    let ldb = self.ldb;
    await self.keystore.save();
    await ldb.transaction("rw", ldb.items, ldb.keystores, () => {
      ldb.items.add(record);
      ldb.keystores.put(self.keystore.toJSON());
    });
    self.recordMetric("added", item.id);

    return item;
  }
  /**
   * Updates an existing item in this DataStore.
   *
   * `{item}` is expected to be a complete object; any (mutable) fields missing
   * are removed from the stored value.  API users should call {@link #get},
   * then make the desired changes to the returned value.
   *
   * @param {Object} item - The item to update
   * @returns {Object} The updated item
   * @throws {Error} if this item does not exist
   * @throws {TypeError} if `item` is not an object with a `id` member
   * @throws {DataStoreError} if the `item` violates the schema
   */
  async update(item) {
    checkState(this);

    let self = instance.get(this);
    if (!item || !item.id) {
      // TODO: custom errors
      throw new TypeError("invalid item");
    }

    let id = item.id;
    let orig = await self.ldb.items.get(id),
        encrypted;
    if (!orig) {
      throw new Error("item does not exist");
    } else {
      encrypted = orig.encrypted;
    }

    orig = await self.keystore.decrypt(id, encrypted);
    item = Items.prepare(item, orig);

    let changes = determineItemChanges(orig, item);

    let active = !item.disabled ? "active" : "";
    encrypted = await self.keystore.encrypt(item);

    let record = {
      id,
      active,
      encrypted
    };
    await self.ldb.items.put(record);
    self.recordMetric("updated", item.id, changes.fields);

    return item;
  }
  /**
   * Removes an item from this DataStore.
   *
   * @param {string} id - The item id to remove
   * @returns {Object} The removed item, or `null` if no item was removed
   */
  async remove(id) {
    checkState(this);

    let self = instance.get(this);
    let item = await self.ldb.items.get(id);
    if (item) {
      item = await self.keystore.decrypt(id, item.encrypted);
      self.keystore.delete(id);

      let ldb = self.ldb;
      await self.keystore.save();
      await ldb.transaction("rw", ldb.items, ldb.keystores, () => {
        ldb.items.delete(id);
        ldb.keystores.put(self.keystore.toJSON());
      });
      self.recordMetric("deleted", item.id);
    }

    return item || null;
  }
}

module.exports = DataStore;
