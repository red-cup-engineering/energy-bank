/**
 * `invariants` — executable checks over a `Ledger`, each returning a list of violations
 * rather than throwing or asserting. A ledger is "sound" exactly when every check here
 * returns an empty list; `checkAll` runs them together for that one yes/no answer plus the
 * detail behind it.
 *
 * Every check is computed purely from `Ledger.audit()`'s own independently-recomputed
 * balances — never from a running counter kept alongside the ledger — matching `audit()`'s
 * own discipline of replaying postings from scratch every time.
 *
 * The `Violation` type shape is declared in the co-located invariants.d.ts, not here — this
 * file is plain JavaScript, no TypeScript syntax, so it loads correctly whether run directly
 * or imported from inside a consumer's node_modules (Node's type-stripping is unavailable for
 * files under node_modules, which is why this package ships .mjs rather than .mts as its
 * runtime source).
 */
import * as decimal from "./decimal.mjs";

const ZERO = decimal.parse("0");

/** Rule 1: every recorded entry's postings balance to zero, per commodity. `MemoryLedger`
 *  refuses to `record()` an unbalanced entry, so in ordinary use this can only fire on a
 *  ledger seeded directly from a malformed initial entry list (exactly the path
 *  `createLedger(initial)` leaves open, for tests that need to construct a broken ledger to
 *  confirm this check actually catches it). */
export function checkBooksBalance(ledger) {
  const report = ledger.audit();
  if (report.balanced) return [];
  return [{
    rule: "books-balance",
    detail: `${report.malformed} of ${report.entries} entries do not balance per commodity`,
  }];
}

/** Rule 2: no `liabilities:energy:*` balance (a player's or pool's spendable ENERGY) is
 *  negative, unless its exact account path is named in `creditLines` — an explicit,
 *  caller-declared overdraft facility. Default is the empty set, so by default nothing may
 *  run negative. Scoped to `liabilities:energy:*` by default because this ledger's own sign
 *  convention (see ledger.mjs's header) makes `income:*`/credit-normal accounts *expected* to
 *  be negative — flagging those would be noise, not a real invariant violation. Pass a wider
 *  `scope` to check a different prefix instead. */
export function checkNoNegativeBalances(ledger, options = {}) {
  const scope = options.scope ?? "liabilities:energy:";
  const creditLines = options.creditLines ?? new Set();
  const { balances } = ledger.audit();
  const violations = [];
  for (const [acct, byCommodity] of Object.entries(balances)) {
    if (!acct.startsWith(scope) || creditLines.has(acct)) continue;
    for (const [commodity, amount] of Object.entries(byCommodity)) {
      if (decimal.isNegative(decimal.parse(amount))) {
        violations.push({
          rule: "no-negative-balance",
          account: acct,
          commodity,
          detail: `${acct} is ${amount} ${commodity}, and has no explicit credit line`,
        });
      }
    }
  }
  return violations;
}

/**
 * Rule 3, as a checkable property: the sum of every `expenses:payout:*` balance never
 * exceeds the sum of every `income:*` balance. Deliberately **not** "payouts <= current
 * liabilities:energy balance" — a player can accrue and spend ENERGY internally all day
 * (liabilities:energy moving to an in-game-use sink, say) without touching real revenue at
 * all; this invariant only binds the moment ENERGY is redeemed *out* through a settlement
 * backend into real money/crypto. `income:*` posts negative by this ledger's sign convention
 * (credit-normal), so it is negated back to a positive "verified revenue" total here.
 */
export function verifyPayoutInvariant(ledger) {
  const { balances } = ledger.audit();
  const income = new Map();
  const payout = new Map();
  for (const [acct, byCommodity] of Object.entries(balances)) {
    const into = acct.startsWith("income:") ? income : acct.startsWith("expenses:payout:") ? payout : null;
    if (into === null) continue;
    for (const [commodity, amount] of Object.entries(byCommodity)) {
      const parsed = decimal.parse(amount);
      // `income:*` posts credit-negative by this ledger's sign convention, so it is negated
      // back into a positive "verified revenue" total here; `expenses:payout:*` is already
      // debit-positive.
      const signed = into === income ? decimal.negate(parsed) : parsed;
      into.set(commodity, decimal.add(into.get(commodity) ?? ZERO, signed));
    }
  }
  // Weighed per commodity, never pooled. Summing every commodity into one running total —
  // as this check did while the ledger served a single-currency game — treats USD, HIVE, and
  // ETH as freely fungible at 1:1, so revenue earned on one rail would silently authorize a
  // payout on another. Nothing here knows an exchange rate, and nothing here should: a payout
  // is covered only by revenue verified in the *same* commodity it is denominated in.
  const breaches = [];
  for (const [commodity, paid] of payout) {
    const earned = income.get(commodity) ?? ZERO;
    if (decimal.cmp(paid, earned) > 0) {
      breaches.push(`${commodity}: payout ${decimal.format(paid)} exceeds verified revenue ${decimal.format(earned)}`);
    }
  }
  const summary = [...payout]
    .map(([c, paid]) => `${c} payout ${decimal.format(paid)} vs verified revenue ${decimal.format(income.get(c) ?? ZERO)}`)
    .join("; ");
  return {
    holds: breaches.length === 0,
    detail: breaches.length > 0 ? breaches.join("; ") : summary === "" ? "no payouts recorded" : summary,
  };
}

/** `verifyPayoutInvariant`, reshaped into the same violations-list form as the other checks. */
export function checkPayoutInvariant(ledger) {
  const result = verifyPayoutInvariant(ledger);
  return result.holds ? [] : [{ rule: "payout-le-revenue", detail: result.detail }];
}

/** Run every executable invariant and return the combined violation list — empty means the
 *  books are, right now, entirely sound. */
export function checkAll(ledger, options) {
  return [
    ...checkBooksBalance(ledger),
    ...checkNoNegativeBalances(ledger, {
      scope: options?.negativeBalanceScope,
      creditLines: options?.creditLines,
    }),
    ...checkPayoutInvariant(ledger),
  ];
}
