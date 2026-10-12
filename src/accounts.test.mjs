import { test } from "node:test";
import assert from "node:assert/strict";
import {
  guestAccountId,
  durableAccountId,
  isGuest,
  namespaceOf,
  account,
  hashSecret,
  energyAccountPath,
  createIdentityFederation,
} from "./accounts.mjs";

test("guestAccountId: namespaced, slugged, deterministic", () => {
  const id = guestAccountId("onestone", "Client Key 123!");
  assert.equal(id, "onestone:guest-client-key-123");
  assert.equal(id, guestAccountId("onestone", "Client Key 123!"));
});

test("guestAccountId: empty/garbage key falls back to 'anon'", () => {
  assert.equal(guestAccountId("onestone", "!!!"), "onestone:guest-anon");
  assert.equal(guestAccountId("onestone", ""), "onestone:guest-anon");
});

test("durableAccountId: namespaced, slugged, distinct prefix from guest", () => {
  const id = durableAccountId("onestone", "Morgan Sennhauser");
  assert.equal(id, "onestone:account-morgan-sennhauser");
});

test("isGuest: true only for guest ids, namespace-agnostic", () => {
  assert.equal(isGuest(guestAccountId("onestone", "a")), true);
  assert.equal(isGuest(durableAccountId("onestone", "a")), false);
  assert.equal(isGuest(guestAccountId("lantern", "a")), true);
});

test("namespaceOf: extracts the leading segment, '' if absent", () => {
  assert.equal(namespaceOf("onestone:guest-a"), "onestone");
  assert.equal(namespaceOf("no-colon-here"), "");
});

test("account(): builds a record whose namespace is derived from the id", () => {
  const id = durableAccountId("solitaire", "alex");
  assert.deepEqual(account(id, "durable"), { id, namespace: "solitaire", kind: "durable" });
});

test("hashSecret: deterministic, and distinguishes namespace/id/secret", () => {
  const h1 = hashSecret("onestone", "onestone:account-a", "hunter2");
  const h2 = hashSecret("onestone", "onestone:account-a", "hunter2");
  assert.equal(h1, h2);
  assert.notEqual(h1, hashSecret("solitaire", "onestone:account-a", "hunter2"));
  assert.notEqual(h1, hashSecret("onestone", "onestone:account-b", "hunter2"));
  assert.notEqual(h1, hashSecret("onestone", "onestone:account-a", "hunter3"));
});

test("energyAccountPath: defaults to the liabilities:energy:<id> chart path", () => {
  assert.equal(energyAccountPath("onestone:delver-abc123"), "liabilities:energy:onestone:delver-abc123");
});

test("energyAccountPath: derives the chart-of-accounts prefix from the given commodity", () => {
  assert.equal(energyAccountPath("pool:account-alice", "HBD"), "liabilities:hbd:pool:account-alice");
  assert.equal(energyAccountPath("pool:account-alice", "ENERGY"), "liabilities:energy:pool:account-alice");
  assert.equal(energyAccountPath("pool:account-alice", "hive"), "liabilities:hive:pool:account-alice");
});

function makeSecretStore() {
  const hashes = new Map();
  return {
    hashes,
    getSecretHash: (id) => hashes.get(id) ?? null,
    setSecretHash: (id, hash) => {
      hashes.set(id, hash);
    },
  };
}

test("authenticate: first login sets the secret, later logins must match", async () => {
  const store = makeSecretStore();
  const fed = createIdentityFederation("onestone", store);
  const id = fed.durableAccountId("alex");

  assert.equal(await fed.authenticate(id, "correct-horse"), true);
  assert.equal(store.hashes.size, 1);
  assert.equal(await fed.authenticate(id, "correct-horse"), true);
  assert.equal(await fed.authenticate(id, "wrong-password"), false);
});

test("authenticate: an empty secret is always rejected, never sets the hash", async () => {
  const store = makeSecretStore();
  const fed = createIdentityFederation("onestone", store);
  const id = fed.durableAccountId("alex");
  assert.equal(await fed.authenticate(id, ""), false);
  assert.equal(store.hashes.size, 0);
});

test("migrateGuest: happy path exports from guest and imports into durable, in order", async () => {
  const store = makeSecretStore();
  const fed = createIdentityFederation("onestone", store);
  const guest = fed.guestAccountId("client-key");
  const durable = fed.durableAccountId("alex");

  const calls = [];
  const hasProgress = async (id) => {
    calls.push(`hasProgress(${id})`);
    return id === guest;
  };
  const exportFacts = async (id) => {
    calls.push(`exportFacts(${id})`);
    return { gold: 42 };
  };
  const importFacts = async (id, facts) => {
    calls.push(`importFacts(${id}, ${facts.gold})`);
  };

  await fed.migrateGuest(guest, durable, hasProgress, exportFacts, importFacts);
  assert.deepEqual(calls, [
    `hasProgress(${guest})`,
    `hasProgress(${durable})`,
    `exportFacts(${guest})`,
    `importFacts(${durable}, 42)`,
  ]);
});

test("migrateGuest: refuses a non-guest source", async () => {
  const store = makeSecretStore();
  const fed = createIdentityFederation("onestone", store);
  const a = fed.durableAccountId("a");
  const b = fed.durableAccountId("b");
  let touched = false;
  await fed.migrateGuest(a, b, async () => true, async () => { touched = true; return {}; }, async () => {});
  assert.equal(touched, false);
});

test("migrateGuest: refuses guest === durable", async () => {
  const store = makeSecretStore();
  const fed = createIdentityFederation("onestone", store);
  const guest = fed.guestAccountId("client-key");
  let touched = false;
  await fed.migrateGuest(guest, guest, async () => true, async () => { touched = true; return {}; }, async () => {});
  assert.equal(touched, false);
});

test("migrateGuest: refuses when the guest has no progress", async () => {
  const store = makeSecretStore();
  const fed = createIdentityFederation("onestone", store);
  const guest = fed.guestAccountId("client-key");
  const durable = fed.durableAccountId("alex");
  let touched = false;
  await fed.migrateGuest(guest, durable, async () => false, async () => { touched = true; return {}; }, async () => {});
  assert.equal(touched, false);
});

test("migrateGuest: refuses when the durable account already has progress (never clobbers it)", async () => {
  const store = makeSecretStore();
  const fed = createIdentityFederation("onestone", store);
  const guest = fed.guestAccountId("client-key");
  const durable = fed.durableAccountId("alex");
  let imported = false;
  await fed.migrateGuest(
    guest,
    durable,
    async () => true, // both guest and durable report progress
    async () => ({}),
    async () => { imported = true; },
  );
  assert.equal(imported, false);
});
