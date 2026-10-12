import { test } from "node:test";
import assert from "node:assert/strict";
import { createLedger, journalText } from "./ledger.mjs";

function purchase(ref, amount = "4.99") {
  return {
    date: "2026-08-19",
    narration: `purchase ${ref}`,
    ref,
    postings: [
      { account: "assets:cash:mock", amount, commodity: "USD" },
      { account: "income:premium", amount: `-${amount}`, commodity: "USD" },
    ],
  };
}

test("record(): accepts a balanced entry and it appears in all()", () => {
  const ledger = createLedger();
  ledger.record(purchase("ord-1"));
  assert.equal(ledger.all().length, 1);
  assert.equal(ledger.all()[0]?.ref, "ord-1");
});

test("record(): throws on an unbalanced entry and never appends it", () => {
  const ledger = createLedger();
  assert.throws(() => ledger.record({
    date: "2026-08-19",
    narration: "bad",
    ref: "ord-bad",
    postings: [{ account: "assets:cash:mock", amount: "5.00", commodity: "USD" }],
  }), RangeError);
  assert.equal(ledger.all().length, 0);
});

test("record(): throws on a non-numeric amount", () => {
  const ledger = createLedger();
  assert.throws(() => ledger.record({
    date: "2026-08-19",
    narration: "bad",
    ref: "ord-nan",
    postings: [
      { account: "assets:cash:mock", amount: "not-a-number", commodity: "USD" },
      { account: "income:premium", amount: "0", commodity: "USD" },
    ],
  }), RangeError);
});

test("record(): throws on an entry with no postings", () => {
  const ledger = createLedger();
  assert.throws(() => ledger.record({ date: "2026-08-19", narration: "empty", ref: "ord-empty", postings: [] }), RangeError);
});

test("record(): a mixed-commodity entry balances independently per commodity", () => {
  const ledger = createLedger();
  ledger.record({
    date: "2026-08-19",
    narration: "swap",
    ref: "ord-mixed",
    postings: [
      { account: "assets:cash:mock", amount: "10.00", commodity: "USD" },
      { account: "income:premium", amount: "-10.00", commodity: "USD" },
      { account: "liabilities:energy:onestone:a", amount: "5", commodity: "ENERGY" },
      { account: "equity:earned:onestone", amount: "-5", commodity: "ENERGY" },
    ],
  });
  const { balanced } = ledger.audit();
  assert.equal(balanced, true);
});

test("has(): true iff a ref has been recorded", () => {
  const ledger = createLedger();
  assert.equal(ledger.has("ord-1"), false);
  ledger.record(purchase("ord-1"));
  assert.equal(ledger.has("ord-1"), true);
  assert.equal(ledger.has("ord-2"), false);
});

test("audit(): balances are independently recomputed from postings, not a running counter", () => {
  const ledger = createLedger();
  ledger.record(purchase("ord-1", "4.99"));
  ledger.record(purchase("ord-2", "2.99"));
  const { balances, entries, malformed, balanced } = ledger.audit();
  assert.equal(entries, 2);
  assert.equal(malformed, 0);
  assert.equal(balanced, true);
  assert.equal(balances["assets:cash:mock"]?.["USD"], "7.98");
  assert.equal(balances["income:premium"]?.["USD"], "-7.98");
});

test("audit(): a ledger constructed with a malformed initial entry reports it as malformed and unbalanced, and skips it in balances", () => {
  const bad = {
    date: "2026-08-19",
    narration: "corrupt",
    ref: "ord-corrupt",
    postings: [{ account: "assets:cash:mock", amount: "5.00", commodity: "USD" }],
  };
  const ledger = createLedger([bad, purchase("ord-good")]);
  const report = ledger.audit();
  assert.equal(report.entries, 2);
  assert.equal(report.malformed, 1);
  assert.equal(report.balanced, false);
  // the malformed entry's own posting must not leak into balances
  assert.equal(report.balances["assets:cash:mock"]?.["USD"], "4.99");
});

test("journalText(): renders each entry as hledger-shaped text with its ref in the header", () => {
  const text = journalText([purchase("ord-1", "1.50")]);
  assert.match(text, /2026-08-19 \* purchase ord-1 {2}; ref:ord-1/);
  assert.match(text, /assets:cash:mock {2}1\.50 USD/);
  assert.match(text, /income:premium {2}-1\.50 USD/);
});

test("createLedger(): with no argument starts empty", () => {
  assert.deepEqual(createLedger().all(), []);
});

// ── high-precision commodities ────────────────────────────────────────────────────────
// Regression coverage for a defect that made the double-entry check unsound for any
// commodity finer than six decimal places. The balance check formerly weighed postings as
// `Number(amount) * 1e6` rounded to an integer, so a wei (eighteen places out) rounded to
// zero: a one-sided entry moving a wei netted to zero and was accepted as *balanced*, and the
// value disappeared from the audited balances. USD and HIVE were unaffected, which is why the
// rest of this suite never caught it.

test("record(): refuses a one-sided wei entry — a wei is not zero", () => {
  const ledger = createLedger();
  assert.throws(
    () =>
      ledger.record({
        date: "2026-08-27",
        narration: "one wei, unbalanced",
        ref: "wei-1",
        postings: [{ account: "assets:cash:evm", amount: "0.000000000000000001", commodity: "ETH" }],
      }),
    RangeError,
  );
  assert.equal(ledger.all().length, 0);
});

test("record(): refuses an entry off by one wei at ten-ETH magnitude", () => {
  const ledger = createLedger();
  assert.throws(
    () =>
      ledger.record({
        date: "2026-08-27",
        narration: "off by one wei",
        ref: "wei-2",
        postings: [
          { account: "assets:cash:evm", amount: "10.000000000000000000", commodity: "ETH" },
          { account: "income:settlement:evm", amount: "-10.000000000000000001", commodity: "ETH" },
        ],
      }),
    RangeError,
  );
});

test("record()/audit(): a balanced wei-precision entry is accepted and its balance survives", () => {
  const ledger = createLedger();
  ledger.record({
    date: "2026-08-27",
    narration: "one wei, balanced",
    ref: "wei-3",
    postings: [
      { account: "assets:cash:evm", amount: "0.000000000000000001", commodity: "ETH" },
      { account: "income:settlement:evm", amount: "-0.000000000000000001", commodity: "ETH" },
    ],
  });
  const { balances, balanced } = ledger.audit();
  assert.equal(balanced, true);
  assert.equal(balances["assets:cash:evm"]?.["ETH"], "0.000000000000000001");
  assert.equal(balances["income:settlement:evm"]?.["ETH"], "-0.000000000000000001");
});

test("audit(): accumulates high-precision balances without drift", () => {
  const ledger = createLedger();
  for (let i = 0; i < 100; i++) {
    ledger.record({
      date: "2026-08-27",
      narration: `wei ${i}`,
      ref: `wei-drift-${i}`,
      postings: [
        { account: "assets:cash:evm", amount: "0.000000000000000001", commodity: "ETH" },
        { account: "income:settlement:evm", amount: "-0.000000000000000001", commodity: "ETH" },
      ],
    });
  }
  const { balances } = ledger.audit();
  assert.equal(balances["assets:cash:evm"]?.["ETH"], "0.0000000000000001");
});
