/*!
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

const assert = require("./setup/assert");

const UUID = require("uuid"),
      jose = require("node-jose"),
      jsonmergepatch = require("json-merge-patch");

const DataStore = require("../lib/datastore"),
      localdatabase = require("../lib/localdatabase"),
      DataStoreError = require("../lib/util/errors");

function failOnSuccess() {
  assert.ok(false, "unexpected success");
}

function loadAppKey(bundle) {
  // master key contains secret
  if (!bundle) {
    bundle = require("./setup/key-bundle.json");
  }
  let appKey = bundle.appKey;
  return appKey;
}

async function setupAppKey(appKey = "r_w9dG02dPnF-c7N3et7Rg1Fa5yiNB06hwvhMOpgSRo") {
  if (appKey) {
    return jose.JWK.asKey({
      kty: "oct",
      k: appKey
    });
  }
  return null;
}

function loadEncryptedKeys() {
  // keys is encrypted (using master password) as a Compact JWE
  let keys = require("./setup/encrypted-empty.json");
  keys = keys.encrypted;
  return keys;
}

function checkList(stored, cached) {
  assert.equal(stored.size, cached.size);
  for (let i of cached.keys()) {
    let actual = stored.get(i),
        expected = cached.get(i);
    assert.deepEqual(actual, expected);
  }
}

describe("datastore", () => {
  describe("ctor", () => {
    it("constructs an instance without any options", () => {
      let ds = new DataStore();
      assert.ok(!ds.initialized);
      assert.ok(ds.locked);
    });
    it("constructs with the specified configuration", () => {
      let cfg = {
        keys: loadEncryptedKeys()
      };
      let ds = new DataStore(cfg);
      assert.ok(ds.initialized);
      assert.ok(ds.locked);
    });
  });

  describe("initialization & reset", () => {
    beforeEach(localdatabase.startup);
    afterEach(localdatabase.teardown);
    function setupTest(appKey) {
      return async () => {
        appKey = await setupAppKey(appKey);
        let ds = new DataStore();

        let result = await ds.initialize({ appKey });
        assert.strictEqual(result, ds);
        assert(!ds.locked);
        assert(ds.initialized);

        await ds.lock();
        await ds.unlock(appKey);
        assert(!ds.locked);

        return ds;
      };
    }
    async function populateDataStore(ds) {
      let cache = new Map();

      for (let idx = 0; idx < 4; idx++) {
        let item = await ds.add({
          title: `entry #${idx + 1}`,
          entry: {
            kind: "login",
            username: "the user",
            password: "the password"
          }
        });
        cache.set(item.id, item);
      }

      return cache;
    }

    it("initializes with given app key", setupTest());
    it("fails to initialize without app key", async () => {
      const init = setupTest("");
      return init().then(failOnSuccess, (err) => {
        assert.strictEqual(err.reason, DataStoreError.MISSING_APP_KEY);
      });
    });
    it("fails on the second initialization", async () => {
      let first = setupTest();
      let ds = await first();
      try {
        let appKey = await jose.JWK.createKeyStore().generate("oct", 256);
        await ds.initialize({ appKey  });
      } catch (err) {
        assert.strictEqual(err.reason, DataStoreError.INITIALIZED);
      }
    });
    it("resets an initialized datastore", async () => {
      let ds = await setupTest()();

      assert(ds.initialized);

      let result;
      result = await ds.reset();
      assert(!ds.initialized);
      assert.strictEqual(result, ds);
    });
    it("resets an uninitialized datastore", async () => {
      let ds = new DataStore();

      assert(!ds.initialized);

      let result;
      result = await ds.reset();
      assert(!ds.initialized);
      assert.strictEqual(result, ds);
    });
    it("resets and reinitializes a datastore", async () => {
      let ds = await setupTest()();

      assert(ds.initialized);

      let result;
      result = await ds.reset();
      assert(!ds.initialized);
      assert.strictEqual(result, ds);

      let appKey = await setupAppKey();
      result = await ds.initialize({
        appKey
      });
      assert(ds.initialized);
      assert.strictEqual(result, ds);
    });
    it("rebases a datastore to a new password", async () => {
      let ds = await setupTest()();
      let cache = await populateDataStore(ds);

      assert(ds.initialized);
      assert(!ds.locked);

      let result, appKey, salt;
      appKey = await setupAppKey();
      salt = UUID();
      result = await ds.initialize({
        appKey,
        salt,
        rebase: true
      });
      assert(ds.initialized);
      assert(!ds.locked);
      assert.strictEqual(result, ds);

      await ds.lock();
      assert(ds.locked);
      result = await ds.unlock(appKey);
      assert(!ds.locked);
      assert.strictEqual(result, ds);

      let all = await ds.list();
      assert.deepEqual(all, cache);
    });
    it("fails to rebase a datastore when locked", async () => {
      let ds = await setupTest()();

      assert(ds.initialized);
      assert(!ds.locked);

      await ds.lock();

      let appKey;
      appKey = await setupAppKey();
      try {
        await ds.initialize({
          appKey,
          rebase: true
        });
        failOnSuccess();
      } catch (err) {
        assert.strictEqual(err.reason, DataStoreError.LOCKED);
      }
    });
  });

  describe("CRUD", () => {
    let main, appKey, salt, metrics;

    function checkMetrics(expected) {
      let actual = metrics;
      metrics = [];

      assert.equal(actual.length, expected.length);
      for (let idx = 0; idx < expected.length; idx++) {
        assert.deepEqual(actual[idx], expected[idx]);
      }
    }

    before(async () => {
      await localdatabase.startup();

      let bundle = require("./setup/key-bundle.json");
      appKey = loadAppKey(bundle);
      salt = bundle.salt;
      metrics = [];
      main = new DataStore({
        salt,
        keys: loadEncryptedKeys(),
        recordMetric: async (method, id, fields) => {
          metrics.push({method, id, fields});
        }
      });
      main = await main.prepare();
    });
    after(async () => {
      // cleanup databases
      await localdatabase.teardown();
    });

    it("locks and unlocks", async () => {
      let result;

      assert.ok(main.locked);
      result = await main.unlock(appKey);
      assert.strictEqual(result, main);
      assert.ok(!main.locked);
      result = await main.unlock(appKey);
      assert.strictEqual(result, main);
      assert.ok(!main.locked);
      result = await main.lock();
      assert.strictEqual(result, main);
      assert.ok(main.locked);
      result = await main.lock();
      assert.strictEqual(result, main);
      assert.ok(main.locked);
    });

    it("does basic CRUD ops", async () => {
      // start by unlocking
      await main.unlock(appKey);
      let cached = new Map(),
          stored;
      stored = await main.list();
      checkList(stored, cached);

      let something = {
        title: "My Item",
        entry: {
          kind: "login",
          username: "foo",
          password: "bar"
        }
      };
      let result, expected, history = [];
      result = await main.add(something);
      assert.itemMatches(result, Object.assign({}, something, {
        modified: new Date().toISOString(),
        history
      }));
      cached.set(result.id, result);
      stored = await main.list();
      checkList(stored, cached);
      checkMetrics([
        {
          method: "added",
          id: result.id,
          fields: undefined
        }
      ]);

      // result is the full item
      expected = result;
      result = await main.get(expected.id);
      assert(expected !== result);
      assert.deepEqual(result, expected);

      something = JSON.parse(JSON.stringify(result));
      something.entry = Object.assign(something.entry, {
        password: "baz"
      });
      history.unshift({
        created: new Date().toISOString(),
        patch: jsonmergepatch.generate(something.entry, expected.entry)
      });
      result = await main.update(something);

      assert.itemMatches(result, Object.assign({}, something, {
        modified: new Date().toISOString(),
        history
      }));
      cached.set(result.id, result);
      stored = await main.list();
      checkList(stored, cached);
      checkMetrics([
        {
          method: "updated",
          id: result.id,
          fields: "entry.password"
        }
      ]);

      expected = result;
      result = await main.get(expected.id);
      assert(expected !== result);
      assert.deepEqual(result, expected);

      something = JSON.parse(JSON.stringify(result));
      something = Object.assign(something, {
        title: "MY Item"
      });
      something.entry = Object.assign(something.entry, {
        username: "another-user",
        password: "zab"
      });
      history.unshift({
        created: new Date().toISOString(),
        patch: jsonmergepatch.generate(something.entry, expected.entry)
      });
      result = await main.update(something);

      assert.itemMatches(result, Object.assign({}, something, {
        modified: new Date().toISOString(),
        history
      }));
      cached.set(result.id, result);
      stored = await main.list();
      checkList(stored, cached);
      checkMetrics([
        {
          method: "updated",
          id: result.id,
          fields: "title,entry.username,entry.password"
        }
      ]);

      expected = result;
      result = await main.get(expected.id);
      assert(expected !== result);
      assert.deepEqual(result, expected);

      something = JSON.parse(JSON.stringify(result));
      something = Object.assign(something, {
        title: "My Someplace Item",
        origins: ["someplace.example"]
      });
      result = await main.update(something);

      assert.itemMatches(result, Object.assign({}, something, {
        modified: new Date().toISOString(),
        history
      }));
      cached.set(result.id, result);
      stored = await main.list();
      checkList(stored, cached);
      checkMetrics([
        {
          method: "updated",
          id: result.id,
          fields: "title,origins"
        }
      ]);

      expected = result;
      result = await main.get(expected.id);
      assert(expected !== result);
      assert.deepEqual(result, expected);

      something = result;
      result = await main.remove(something.id);
      assert.deepEqual(result, something);
      cached.delete(result.id);
      stored = await main.list();
      checkList(stored, cached);
      checkMetrics([
        {
          method: "deleted",
          id: result.id,
          fields: undefined
        }
      ]);

      result = await main.get(result.id);
      assert(!result);
    });
    it("touches", async () => {
      await main.unlock(appKey);
      let cached = new Map(),
          stored;
      stored = await main.list();
      checkList(stored, cached);

      let something = {
        title: "My Item",
        entry: {
          kind: "login",
          username: "foo",
          password: "bar"
        }
      };

      let result, expected = [];
      result = await main.add(something);
      checkMetrics([
        {
          method: "added",
          id: result.id,
          fields: undefined
        }
      ]);

      expected = result;
      result = await main.touch(expected);
      let time = new Date().toISOString();
      assert.dateInRange(result.last_used, time);
      cached.set(result.id, result);
      stored = await main.list();
      checkList(stored, cached);
      checkMetrics([
        {
          method: "touched",
          id: result.id,
          fields: undefined
        }
      ]);
    });
    it("fails to add nothing", async () => {
      await main.unlock(appKey);

      try {
        await main.add();
        failOnSuccess();
      } catch (err) {
        assert.strictEqual(err.reason, DataStoreError.INVALID_ITEM);
      }
    });
    it("fails to update nothing", async () => {
      await main.unlock();

      try {
        await main.update();
        failOnSuccess();
      } catch (err) {
        assert.strictEqual(err.reason, DataStoreError.INVALID_ITEM);
      }
    });
    it("fails to update missing item", async () => {
      await main.unlock();
      let something = {
        id: "d50fd808-8c0f-47f8-99bc-896750a2cc0e",
        title: "Some other item",
        entry: {
          kind: "login",
          username: "bilbo.baggins",
          password: "hidden treasure"
        }
      };

      try {
        await main.update(something);
        failOnSuccess();
      } catch (err) {
        assert.strictEqual(err.reason, DataStoreError.MISSING_ITEM);
      }
    });
    it("fails to touch missing item", async () => {
      await main.unlock();
      let something = {
        id: "d50fd808-8c0f-47f8-99bc-896750a2cc0e",
        title: "Some other item",
        entry: {
          kind: "login",
          username: "bilbo.baggins",
          password: "hidden treasure"
        }
      };

      try {
        await main.touch(something);
        failOnSuccess();
      } catch (err) {
        assert.strictEqual(err.reason, DataStoreError.MISSING_ITEM);
      }
    });

    describe("locked failures", () => {
      const item = {
        id: UUID(),
        title: "foobar",
        entry: {
          kind: "login",
          username: "blah",
          password: "dublah"
        }
      };

      beforeEach(async () => {
        await main.lock();
      });

      it("fails list if locked", async () => {
        try {
          await main.list();
        } catch (err) {
          assert.strictEqual(err.reason, DataStoreError.LOCKED);
        }
      });
      it("fails get if locked", async () => {
        try {
          await main.get(item.id);
        } catch (err) {
          assert.strictEqual(err.reason, DataStoreError.LOCKED);
        }
      });
      it("fails add if locked", async () => {
        try {
          await main.add(item);
        } catch (err) {
          assert.strictEqual(err.reason, DataStoreError.LOCKED);
        }
      });
      it("fails update if locked", async () => {
        try {
          await main.update(item);
        } catch (err) {
          assert.strictEqual(err.reason, DataStoreError.LOCKED);
        }
      });
      it("fails touch if locked", async () => {
        try {
          await main.touch(item);
        } catch (err) {
          assert.strictEqual(err.reason, DataStoreError.LOCKED);
        }
      });
      it("fails remove if locked", async () => {
        try {
          await main.remove(item);
        } catch (err) {
          assert.strictEqual(err.reason, DataStoreError.LOCKED);
        }
      });
    });

    describe("uninitialized failures", () => {
      function checkNotInitialized(err) {
        assert.strictEqual(err.reason, DataStoreError.NOT_INITIALIZED);
      }

      before(async () => {
        return main.reset();
      });

      it("fails to list when uninitialized", async () => {
        return main.list().then(failOnSuccess, checkNotInitialized);
      });
      it("fails to get when uninitialized", async () => {
        const id = "f96eb083-6103-41f8-9cbc-231efa2957af";
        return main.get(id).then(failOnSuccess, checkNotInitialized);
      });
      it("fails to add when uninitialized", async () => {
        const item = {
          entry: {
            kind: "login",
            username: "frodo.baggins",
            password: "keepitsecretkeepitsafe"
          }
        };
        return main.add(item).then(failOnSuccess, checkNotInitialized);
      });
      it("fails to update when uninitialized", async () => {
        const item = {
          id: "f96eb083-6103-41f8-9cbc-231efa2957af",
          entry: {
            kind: "login",
            username: "frodo.baggins",
            password: "keepitsecretkeepitsafe"
          }
        };
        return main.update(item).then(failOnSuccess, checkNotInitialized);
      });
      it("fails to touch when uninitialized", async () => {
        const item = {
          id: "f96eb083-6103-41f8-9cbc-231efa2957af",
          entry: {
            kind: "login",
            username: "frodo.baggins",
            password: "keepitsecretkeepitsafe"
          }
        };
        return main.touch(item).then(failOnSuccess, checkNotInitialized);
      });
      it("fails to remove when uninitialized", async () => {
        const id = "f96eb083-6103-41f8-9cbc-231efa2957af";
        return main.remove(id).then(failOnSuccess, checkNotInitialized);
      });
    });
  });

  describe("defaults", () => {
    before(async () => {
      await localdatabase.startup();
    });
    after(async () => {
      await localdatabase.teardown();
    });
  });

  describe("persistence", () => {
    let cached = new Map();
    let expectedID;
    let something = {
      title: "Sa Tuna2",
      entry: {
        kind: "login",
        username: "foo",
        password: "bar"
      }
    };

    before(async () => {
      localdatabase.startup();
    });
    after(async () => {
      // cleanup databases
      await localdatabase.teardown();
    });

    it("add a value to first datastore", async () => {
      const appKey = await setupAppKey();
      let main = new DataStore();
      main = await main.prepare();
      await main.initialize({
        appKey
      });

      let result = await main.add(something);
      assert.itemMatches(result, something);
      cached.set(result.id, result);
      let stored = await main.list();
      checkList(stored, cached);

      // result is the full item
      let expected = result;
      result = await main.get(expected.id);
      assert(expected !== result);
      assert.deepEqual(result, expected);

      expectedID = expected.id;
    });

    it("data persists into second datastore", async () => {
      const appKey = await setupAppKey();
      let secondDatastore = new DataStore();
      secondDatastore = await secondDatastore.prepare();
      await secondDatastore.unlock(appKey);

      let stored = await secondDatastore.list();
      checkList(stored, cached);

      // result is the full item
      let result = await secondDatastore.get(expectedID);
      assert.itemMatches(result, something);
    });
  });
});
