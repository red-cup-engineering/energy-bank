import { test } from "node:test";
import assert from "node:assert/strict";
import { createLedger } from "./ledger.mjs";
import {
  transferEnergy,
  fundAccount,
  spendFromAccount,
  createPool,
  withMember,
  totalShares,
  poolDistribution,
  contributeToPool,
  distributePool,
  poolAccountId,
  sellEnergy,
} from "./transfer.mjs";

const DATE = "2026-08-19";
const alice = "onestone:account-alice";
const bob = "onestone:account-bob";
const carol = "onestone:account-carol";

test("fundAccount(): credits the target's liabilities:energy balance from a source path", () => {
  const ledger = createLedger();
  fundAccount(ledger, "equity:earned:onestone", alice, "10", "ENERGY", "fund-1", DATE);
  const { balances, balanced } = ledger.audit();
  assert.equal(balanced, true);
  assert.equal(balances["liabilities:energy:" + alice]?.["ENERGY"], "10");
  assert.equal(balances["equity:earned:onestone"]?.["ENERGY"], "-10");
});

test("fundAccount()/transferEnergy(): a non-ENERGY commodity posts under its own liabilities:<commodity> prefix, never liabilities:energy", () => {
  const ledger = createLedger();
  fundAccount(ledger, "equity:seed:pool", "pool:account-hbd-pool", "100", "HBD", "fund-hbd-1", DATE);
  transferEnergy(ledger, "pool:account-hbd-pool", alice, "10", "HBD", "xfer-hbd-1", DATE);
  const { balances, balanced } = ledger.audit();
  assert.equal(balanced, true);
  assert.equal(balances["liabilities:hbd:pool:account-hbd-pool"]?.["HBD"], "90");
  assert.equal(balances["liabilities:hbd:" + alice]?.["HBD"], "10");
  assert.equal(balances["liabilities:energy:pool:account-hbd-pool"], undefined);
  assert.equal(balances["liabilities:energy:" + alice], undefined);
});

test("fundAccount(): rejects a non-positive amount", () => {
  const ledger = createLedger();
  assert.throws(() => fundAccount(ledger, "equity:earned:onestone", alice, "0", "ENERGY", "fund-0", DATE), RangeError);
  assert.throws(() => fundAccount(ledger, "equity:earned:onestone", alice, "-5", "ENERGY", "fund-neg", DATE), RangeError);
});

test("fundAccount(): rejects a reused ref", () => {
  const ledger = createLedger();
  fundAccount(ledger, "equity:earned:onestone", alice, "10", "ENERGY", "fund-1", DATE);
  assert.throws(() => fundAccount(ledger, "equity:earned:onestone", alice, "5", "ENERGY", "fund-1", DATE), RangeError);
});

test("transferEnergy(): moves balance from one account to another in one balanced entry", () => {
  const ledger = createLedger();
  fundAccount(ledger, "equity:earned:onestone", alice, "10", "ENERGY", "fund-1", DATE);
  transferEnergy(ledger, alice, bob, "4", "ENERGY", "xfer-1", DATE);
  const { balances, balanced } = ledger.audit();
  assert.equal(balanced, true);
  assert.equal(balances["liabilities:energy:" + alice]?.["ENERGY"], "6");
  assert.equal(balances["liabilities:energy:" + bob]?.["ENERGY"], "4");
});

test("transferEnergy(): refuses to leave the source negative by default", () => {
  const ledger = createLedger();
  fundAccount(ledger, "equity:earned:onestone", alice, "3", "ENERGY", "fund-1", DATE);
  assert.throws(() => transferEnergy(ledger, alice, bob, "10", "ENERGY", "xfer-1", DATE), RangeError);
  // the failed attempt must not have been recorded
  assert.equal(ledger.has("xfer-1"), false);
});

test("transferEnergy(): allowCreditLine permits an explicit negative balance", () => {
  const ledger = createLedger();
  transferEnergy(ledger, alice, bob, "5", "ENERGY", "xfer-credit", DATE, { allowCreditLine: true });
  const { balances } = ledger.audit();
  assert.equal(balances["liabilities:energy:" + alice]?.["ENERGY"], "-5");
  assert.equal(balances["liabilities:energy:" + bob]?.["ENERGY"], "5");
});

test("transferEnergy(): refuses a self-transfer", () => {
  const ledger = createLedger();
  assert.throws(() => transferEnergy(ledger, alice, alice, "1", "ENERGY", "xfer-self", DATE), RangeError);
});

test("transferEnergy(): refuses a non-positive amount and a reused ref", () => {
  const ledger = createLedger();
  fundAccount(ledger, "equity:earned:onestone", alice, "10", "ENERGY", "fund-1", DATE);
  assert.throws(() => transferEnergy(ledger, alice, bob, "0", "ENERGY", "xfer-0", DATE), RangeError);
  transferEnergy(ledger, alice, bob, "1", "ENERGY", "xfer-reused", DATE);
  assert.throws(() => transferEnergy(ledger, alice, bob, "1", "ENERGY", "xfer-reused", DATE), RangeError);
});

test("spendFromAccount(): debits the account into a sink, never touches income/expenses:payout", () => {
  const ledger = createLedger();
  fundAccount(ledger, "equity:earned:onestone", alice, "10", "ENERGY", "fund-1", DATE);
  spendFromAccount(ledger, alice, "expenses:in-game-use:onestone", "6", "ENERGY", "spend-1", DATE);
  const { balances } = ledger.audit();
  assert.equal(balances["liabilities:energy:" + alice]?.["ENERGY"], "4");
  assert.equal(balances["expenses:in-game-use:onestone"]?.["ENERGY"], "6");
  assert.equal(balances["income:premium"], undefined);
  assert.equal(balances["expenses:payout:mock"], undefined);
});

test("spendFromAccount(): refuses to overspend without a credit line", () => {
  const ledger = createLedger();
  fundAccount(ledger, "equity:earned:onestone", alice, "2", "ENERGY", "fund-1", DATE);
  assert.throws(() => spendFromAccount(ledger, alice, "expenses:in-game-use:onestone", "5", "ENERGY", "spend-1", DATE), RangeError);
});

test("sellEnergy(): a transfer whose narration records the price memo", () => {
  const ledger = createLedger();
  fundAccount(ledger, "equity:earned:onestone", alice, "10", "ENERGY", "fund-1", DATE);
  sellEnergy(ledger, alice, bob, "3", "ENERGY", "3000 SATS", "sale-1", DATE);
  const entry = ledger.all().find((e) => e.ref === "sale-1");
  assert.ok(entry !== undefined);
  assert.match(entry.narration, /3000 SATS/);
  const { balances } = ledger.audit();
  assert.equal(balances["liabilities:energy:" + alice]?.["ENERGY"], "7");
  assert.equal(balances["liabilities:energy:" + bob]?.["ENERGY"], "3");
});

// ── pooling ──────────────────────────────────────────────────────────────────────────

test("poolAccountId(): namespaced, distinct from a player account", () => {
  const id = poolAccountId("onestone", "guild-1");
  assert.equal(id, "onestone:pool-guild-1");
});

test("createPool()/withMember(): rejects non-positive shares", () => {
  assert.throws(() => createPool("onestone:pool-1", [{ account: alice, shares: 0 }]), RangeError);
  const pool = createPool("onestone:pool-1");
  assert.throws(() => withMember(pool, { account: alice, shares: -1 }), RangeError);
});

test("withMember(): pure — replaces an existing member's shares rather than duplicating", () => {
  const pool0 = createPool("onestone:pool-1", [{ account: alice, shares: 1 }]);
  const pool1 = withMember(pool0, { account: alice, shares: 3 });
  assert.equal(totalShares(pool0), 1); // pool0 is untouched
  assert.equal(totalShares(pool1), 3);
  assert.equal(pool1.members.length, 1);
});

test("poolDistribution(): pro-rata split whose total is exactly the input amount", () => {
  const pool = createPool("onestone:pool-1", [
    { account: alice, shares: 1 },
    { account: bob, shares: 1 },
    { account: carol, shares: 1 },
  ]);
  const split = poolDistribution(pool, "10");
  const total = [...split.values()].reduce((sum, v) => sum + Number(v), 0);
  assert.equal(total, 10);
  // 10 / 3 members can't split evenly; every share must still be accounted for exactly once
  assert.equal(split.size, 3);
});

test("poolDistribution(): an empty pool distributes nothing", () => {
  assert.equal(poolDistribution(createPool("onestone:pool-1"), "10").size, 0);
});

test("contributeToPool()/distributePool(): round-trips a contribution back out pro rata", () => {
  const ledger = createLedger();
  fundAccount(ledger, "equity:earned:onestone", alice, "10", "ENERGY", "fund-1", DATE);
  const pool = createPool(poolAccountId("onestone", "guild-1"), [
    { account: bob, shares: 1 },
    { account: carol, shares: 3 },
  ]);
  contributeToPool(ledger, pool, alice, "8", "ENERGY", "contrib-1", DATE);
  assert.equal(ledger.audit().balances["liabilities:energy:" + pool.account]?.["ENERGY"], "8");

  distributePool(ledger, pool, "8", "ENERGY", "dist-1", DATE);
  const { balances, balanced } = ledger.audit();
  assert.equal(balanced, true);
  // bob: 1/4 share of 8 = 2; carol: 3/4 share of 8 = 6
  assert.equal(balances["liabilities:energy:" + bob]?.["ENERGY"], "2");
  assert.equal(balances["liabilities:energy:" + carol]?.["ENERGY"], "6");
  assert.equal(balances["liabilities:energy:" + pool.account]?.["ENERGY"], "0");
});
