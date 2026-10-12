import { test } from "node:test";
import assert from "node:assert/strict";
import { createLedger } from "./ledger.mjs";

import { checkBooksBalance, checkNoNegativeBalances, verifyPayoutInvariant, checkPayoutInvariant, checkAll } from "./invariants.mjs";
import { fundAccount, transferEnergy, spendFromAccount, createPool, withMember, contributeToPool, distributePool } from "./transfer.mjs";
import { seededStream } from "@red-cup-engineering/computer-data-engineering-services-section/randomization/stream";

const DATE = "2026-08-19";

test("checkBooksBalance(): empty on a ledger built only through record()", () => {
  const ledger = createLedger();
  fundAccount(ledger, "equity:earned:onestone", "onestone:account-a", "5", "ENERGY", "f-1", DATE);
  assert.deepEqual(checkBooksBalance(ledger), []);
});

test("checkBooksBalance(): flags a ledger seeded with a malformed entry", () => {
  const bad = {
    date: DATE,
    narration: "corrupt",
    ref: "bad-1",
    postings: [{ account: "assets:cash:mock", amount: "5.00", commodity: "USD" }],
  };
  const ledger = createLedger([bad]);
  const violations = checkBooksBalance(ledger);
  assert.equal(violations.length, 1);
  assert.equal(violations[0]?.rule, "books-balance");
});

test("checkNoNegativeBalances(): empty when every account guarded by transfer.mts's own checks stays non-negative", () => {
  const ledger = createLedger();
  fundAccount(ledger, "equity:earned:onestone", "onestone:account-a", "5", "ENERGY", "f-1", DATE);
  assert.deepEqual(checkNoNegativeBalances(ledger), []);
});

test("checkNoNegativeBalances(): does NOT flag income:*/equity:* going negative — that's this ledger's expected sign for credit-normal accounts", () => {
  const ledger = createLedger();
  fundAccount(ledger, "income:premium", "onestone:account-a", "5", "ENERGY", "f-1", DATE);
  // income:premium is now -5 ENERGY by this ledger's convention — not in the default scope.
  assert.deepEqual(checkNoNegativeBalances(ledger), []);
});

test("checkNoNegativeBalances(): flags a liabilities:energy:* account driven negative by a raw (non-guarded) entry", () => {
  const ledger = createLedger([{
    date: DATE,
    narration: "raw overdraw",
    ref: "raw-1",
    postings: [
      { account: "liabilities:energy:onestone:account-a", amount: "-3", commodity: "ENERGY" },
      { account: "equity:earned:onestone", amount: "3", commodity: "ENERGY" },
    ],
  }]);
  const violations = checkNoNegativeBalances(ledger);
  assert.equal(violations.length, 1);
  assert.equal(violations[0]?.rule, "no-negative-balance");
  assert.equal(violations[0]?.account, "liabilities:energy:onestone:account-a");
});

test("checkNoNegativeBalances(): an explicit credit line silences the same violation", () => {
  const ledger = createLedger([{
    date: DATE,
    narration: "raw overdraw",
    ref: "raw-1",
    postings: [
      { account: "liabilities:energy:onestone:account-a", amount: "-3", commodity: "ENERGY" },
      { account: "equity:earned:onestone", amount: "3", commodity: "ENERGY" },
    ],
  }]);
  const violations = checkNoNegativeBalances(ledger, {
    creditLines: new Set(["liabilities:energy:onestone:account-a"]),
  });
  assert.deepEqual(violations, []);
});

test("verifyPayoutInvariant(): holds on a ledger with no payout accounts at all", () => {
  const ledger = createLedger();
  assert.equal(verifyPayoutInvariant(ledger).holds, true);
});

test("verifyPayoutInvariant(): holds when payout is less than or equal to recognized income", () => {
  const ledger = createLedger([
    { date: DATE, narration: "revenue", ref: "rev-1", postings: [
      { account: "assets:cash:mock", amount: "10", commodity: "USD" },
      { account: "income:premium", amount: "-10", commodity: "USD" },
    ] },
    { date: DATE, narration: "payout", ref: "payout-1", postings: [
      { account: "expenses:payout:mock", amount: "10", commodity: "USD" },
      { account: "assets:cash:mock", amount: "-10", commodity: "USD" },
    ] },
  ]);
  const result = verifyPayoutInvariant(ledger);
  assert.equal(result.holds, true);
  assert.equal(checkPayoutInvariant(ledger).length, 0);
});

test("verifyPayoutInvariant(): fails the moment payout exceeds verified revenue", () => {
  const ledger = createLedger([
    { date: DATE, narration: "revenue", ref: "rev-1", postings: [
      { account: "assets:cash:mock", amount: "10", commodity: "USD" },
      { account: "income:premium", amount: "-10", commodity: "USD" },
    ] },
    { date: DATE, narration: "over-payout", ref: "payout-1", postings: [
      { account: "expenses:payout:mock", amount: "11", commodity: "USD" },
      { account: "assets:cash:mock", amount: "-11", commodity: "USD" },
    ] },
  ]);
  const result = verifyPayoutInvariant(ledger);
  assert.equal(result.holds, false);
  const violations = checkPayoutInvariant(ledger);
  assert.equal(violations.length, 1);
  assert.equal(violations[0]?.rule, "payout-le-revenue");
});

test("checkAll(): aggregates every rule's violations", () => {
  const bad = {
    date: DATE,
    narration: "corrupt",
    ref: "bad-1",
    postings: [{ account: "assets:cash:mock", amount: "5.00", commodity: "USD" }],
  };
  const overPayout = {
    date: DATE, narration: "over-payout", ref: "payout-1",
    postings: [
      { account: "expenses:payout:mock", amount: "5", commodity: "USD" },
      { account: "assets:cash:mock", amount: "-5", commodity: "USD" },
    ],
  };
  const violations = checkAll(createLedger([bad, overPayout]));
  const rules = violations.map((v) => v.rule).sort();
  assert.deepEqual(rules, ["books-balance", "payout-le-revenue"]);
});

// ── property tests: hammer the invariants with seeded-random legal entry sequences ──────

const ACCOUNTS = ["onestone:account-a", "onestone:account-b", "onestone:account-c", "onestone:account-d"];

/** Run one seeded, deterministic sequence of legal ledger operations (fund/transfer/spend/
 *  pool contribute+distribute), asserting every invariant holds after every single step —
 *  never just at the end, so a step that transiently breaks a rule can't hide behind a later
 *  step that happens to fix it back up. */
function runLegalSequence(seed, steps) {
  const rng = seededStream(seed);
  const ledger = createLedger();
  let pool = createPool("onestone:pool-shared", ACCOUNTS.map((account) => ({ account, shares: 1 })));
  let refCounter = 0;
  const nextRef = () => `${seed}-${++refCounter}`;

  for (let i = 0; i < steps; i++) {
    const balances = ledger.audit().balances;
    const balanceOf = (a) => Number(balances[`liabilities:energy:${a}`]?.["ENERGY"] ?? "0");
    const amount = String(rng.int(1, 9));
    const kind = rng.pick(["fund", "transfer", "spend", "contribute", "distribute", "reshare"]);

    if (kind === "fund") {
      fundAccount(ledger, "equity:earned:onestone", rng.pick(ACCOUNTS), amount, "ENERGY", nextRef(), DATE);
    } else if (kind === "transfer") {
      const from = rng.pick(ACCOUNTS);
      const to = rng.pick(ACCOUNTS.filter((a) => a !== from));
      if (balanceOf(from) > 0) {
        transferEnergy(ledger, from, to, String(Math.min(Number(amount), balanceOf(from))), "ENERGY", nextRef(), DATE);
      }
    } else if (kind === "spend") {
      const from = rng.pick(ACCOUNTS);
      if (balanceOf(from) > 0) {
        spendFromAccount(ledger, from, "expenses:in-game-use:onestone", String(Math.min(Number(amount), balanceOf(from))), "ENERGY", nextRef(), DATE);
      }
    } else if (kind === "contribute") {
      const from = rng.pick(ACCOUNTS);
      if (balanceOf(from) > 0) {
        contributeToPool(ledger, pool, from, String(Math.min(Number(amount), balanceOf(from))), "ENERGY", nextRef(), DATE);
      }
    } else if (kind === "distribute") {
      const poolBalance = Number(balances[`liabilities:energy:${pool.account}`]?.["ENERGY"] ?? "0");
      if (poolBalance > 0) distributePool(ledger, pool, String(Math.min(Number(amount), poolBalance)), "ENERGY", nextRef(), DATE);
    } else {
      pool = withMember(pool, { account: rng.pick(ACCOUNTS), shares: rng.int(1, 5) });
    }

    const violations = checkAll(ledger);
    assert.deepEqual(violations, [], `seed "${seed}" step ${i} (${kind}) produced violations: ${JSON.stringify(violations)}`);
  }
  // and once more at the end, for good measure
  assert.deepEqual(checkAll(ledger), []);
}

for (const seed of ["prop-run-1", "prop-run-2", "prop-run-3", "prop-run-4", "prop-run-5"]) {
  test(`property: seed "${seed}" — 200 legal operations never violate any invariant`, () => {
    runLegalSequence(seed, 200);
  });
}

test("property: a hostile hand-built ledger (unbalanced entry) is always caught, across many random shapes", () => {
  const rng = seededStream("hostile-books");
  for (let i = 0; i < 50; i++) {
    const amount = String(rng.int(1, 100));
    const ledger = createLedger([{
      date: DATE,
      narration: "hostile",
      ref: `hostile-${i}`,
      postings: [{ account: `liabilities:energy:onestone:account-${rng.pick(["a", "b", "c"])}`, amount, commodity: "ENERGY" }],
    }]);
    const violations = checkAll(ledger);
    assert.ok(violations.some((v) => v.rule === "books-balance"));
  }
});

test("property: a hostile hand-built ledger (payout beyond revenue) is always caught, across many random shapes", () => {
  const rng = seededStream("hostile-payout");
  for (let i = 0; i < 50; i++) {
    const income = rng.int(1, 50);
    const payout = income + rng.int(1, 20); // always strictly more than income
    const ledger = createLedger([
      { date: DATE, narration: "revenue", ref: `hostile-rev-${i}`, postings: [
        { account: "assets:cash:mock", amount: String(income), commodity: "USD" },
        { account: "income:premium", amount: String(-income), commodity: "USD" },
      ] },
      { date: DATE, narration: "payout", ref: `hostile-payout-${i}`, postings: [
        { account: "expenses:payout:mock", amount: String(payout), commodity: "USD" },
        { account: "assets:cash:mock", amount: String(-payout), commodity: "USD" },
      ] },
    ]);
    const violations = checkAll(ledger);
    assert.ok(violations.some((v) => v.rule === "payout-le-revenue"));
  }
});

// ── the payout invariant is weighed per commodity ──────────────────────────────────────
// Regression coverage for a defect that pooled every commodity into one running total, so
// revenue verified on one rail silently authorized a payout on another. Harmless while the
// ledger served a single-currency game; wrong the moment a second settlement rail exists,
// because it treats USD, HIVE, and ETH as freely fungible at 1:1. Nothing here knows an
// exchange rate, and nothing here should.

test("verifyPayoutInvariant(): revenue in one commodity does not cover a payout in another", () => {
  const ledger = createLedger([
    {
      date: "2026-08-27",
      narration: "stripe purchase",
      ref: "inv-usd-income",
      postings: [
        { account: "assets:cash:stripe", amount: "100.00", commodity: "USD" },
        { account: "income:settlement:stripe", amount: "-100.00", commodity: "USD" },
      ],
    },
    {
      date: "2026-08-27",
      narration: "hive payout against no HIVE revenue",
      ref: "inv-hive-payout",
      postings: [
        { account: "expenses:payout:hive", amount: "50.000", commodity: "HIVE" },
        { account: "assets:cash:hive", amount: "-50.000", commodity: "HIVE" },
      ],
    },
  ]);
  const result = verifyPayoutInvariant(ledger);
  assert.equal(result.holds, false);
  assert.match(result.detail, /HIVE/);
});

test("verifyPayoutInvariant(): a payout covered in its own commodity holds", () => {
  const ledger = createLedger([
    {
      date: "2026-08-27",
      narration: "hive revenue",
      ref: "inv-hive-income",
      postings: [
        { account: "assets:cash:hive", amount: "50.000", commodity: "HIVE" },
        { account: "income:settlement:hive", amount: "-50.000", commodity: "HIVE" },
      ],
    },
    {
      date: "2026-08-27",
      narration: "hive payout within revenue",
      ref: "inv-hive-payout-ok",
      postings: [
        { account: "expenses:payout:hive", amount: "50.000", commodity: "HIVE" },
        { account: "assets:cash:hive", amount: "-50.000", commodity: "HIVE" },
      ],
    },
  ]);
  assert.equal(verifyPayoutInvariant(ledger).holds, true);
});

test("verifyPayoutInvariant(): holds vacuously when no payouts are recorded", () => {
  const ledger = createLedger([]);
  const result = verifyPayoutInvariant(ledger);
  assert.equal(result.holds, true);
  assert.equal(result.detail, "no payouts recorded");
});
