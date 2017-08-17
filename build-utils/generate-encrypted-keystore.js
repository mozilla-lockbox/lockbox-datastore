#! /usr/bin/env node
/*!
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

const jose = require("node-jose"),
      fs = require("promisified-fs"),
      yargs = require("yargs"),
      UUID = require("uuid");

var argv = yargs.
          option("master", {
            desc: "the master key to use for encryption",
            required: true,
            requiresArg: true
          }).option("output", {
            desc: "the file to write the results to",
            required: true,
            requiresArg: true
          }).
          option("count", {
            desc: "the number of test item keys to generate",
            number: true,
            default: 4
          }).
          help().
          argv;

var keystore = jose.JWK.createKeyStore();

async function createItemKey() {
  let params = {
    alg: "A256GCM",
    kid: UUID()
  };
  return await keystore.generate("oct", 256, params);
}

async function main() {
  let { count, master, output } = argv;

  master = await fs.readFile(master, "utf8");
  master = JSON.parse(master);
  master = await jose.JWK.asKey(master);

  let itemKeys = {};
  for (let idx = 0; count > idx; idx++) {
    let k = await createItemKey();
    itemKeys[k.kid] = k.toJSON(true);
  }

  let params = {
    format: "compact",
    contentAlg: "A256GCM",
    fields: {
      p2c: 8192,
      p2s: jose.util.base64url.encode(jose.util.randomBytes(32))
    }
  };

  let encrypted;
  encrypted = JSON.stringify(itemKeys);
  encrypted = await jose.JWE.createEncrypt(params, master).final(encrypted, "utf8");
  encrypted = JSON.stringify({ encrypted }, null, "  ") + "\n";

  await fs.writeFile(output, encrypted);
  console.log(`generated encrypted keysstore of ${count} keys: [${Object.keys(itemKeys).join(", ")}]`);
}
main();
