# @red-cup-engineering/energy-bank

Shared identity and a double-entry `ENERGY`/credits ledger for every game in the 561 fleet:
guest/durable accounts, an append-only balanced-postings ledger, executable invariant checks,
player-to-player transfer and pooling, and a pluggable settlement-backend interface. Implements
the Cartridge and Energy Bank interface specification.

Zero runtime dependencies. Runtime source ships as plain `.mjs` with hand-written `.d.ts`
files, not `.mts` — Node cannot type-strip `.mts`/`.ts` files once they are resolved from
inside a `node_modules` directory, and this package's whole purpose is to be installed as a
dependency by other games. Domain logic never calls `Date.now()` or `Math.random()`; the
`.test.mts` files run directly via `node --test` from this package's own directory.

## Modules

Import by subpath (`@red-cup-engineering/energy-bank/ledger`, `/transfer`, `/settlement`, …)
for a smaller module graph, or `@red-cup-engineering/energy-bank` for the whole public surface
at once.

- **`accounts`** — `guestAccountId`/`durableAccountId` derivation, `energyAccountPath` (the
  fixed `liabilities:energy:<id>` chart-of-accounts path), and `createIdentityFederation`, the
  guest→durable migration guard sequencing (refuses to migrate a non-guest, a self-migration, a
  guest with no progress, or into a durable account that already has progress). Secret storage
  and player-fact export/import are injected by the caller (`SecretStore`,
  `exportFacts`/`importFacts`) — this module doesn't own where either lives.
- **`decimal`** — exact decimal arithmetic over the amount strings every other module passes
  around: an amount is carried as a `BigInt` numerator over a power-of-ten denominator, so any
  finite decimal is represented exactly at any precision, with no representable maximum and no
  rounding anywhere in the module. This replaces an earlier scaled-double representation that
  was exact for 2-dp and 3-dp commodities and silently wrong past six places — a wei scaled by
  1e6 rounded to zero, so a one-sided entry moving a wei netted to zero and was accepted as
  *balanced*. Cents, millis, satoshis, wei, 18-decimal ERC-20s, and fractional share
  quantities now all weigh correctly.
- **`ledger`** — an in-memory, append-only, double-entry `Ledger` (`MemoryLedger` /
  `createLedger`). `record()` refuses an unbalanced entry, checked per commodity in exact
  decimal arithmetic at whatever precision that commodity carries, never floats. `audit()` always recomputes balances from postings, never from a
  cached total, and renders the portable hledger journal text via `journalText`. There is no
  persistence layer — a caller wiring this in for real still needs to decide where the entry
  list lives between process restarts.
- **`invariants`** — three checks, each returning a violation list rather than throwing:
  `checkBooksBalance` (every entry balances per commodity), `checkNoNegativeBalances` (no
  `liabilities:energy:*` balance is negative unless its account path is named in an explicit
  `creditLines` set), and `checkPayoutInvariant`/`verifyPayoutInvariant` (total
  `expenses:payout:*` never exceeds total `income:*`, **weighed per commodity and never
  pooled** — nothing here knows an exchange rate, so a payout is covered only by revenue
  verified in the same commodity it is denominated in). `checkAll` runs all three together.
- **`transfer`** — `transferEnergy`, the one primitive everything else composes (refuses a
  self-transfer, a non-positive amount, a reused ref, and — unless `allowCreditLine` is passed
  — a transfer that would leave the source negative); `fundAccount`/`spendFromAccount`, its
  origination/sink counterparts; pooling (`createPool`/`withMember`/`poolDistribution`/
  `contributeToPool`/`distributePool`, using the largest-remainder method so a pro-rata split's
  total is always exactly the input amount); and `sellEnergy`, a transfer whose narration
  carries an agreed price as a memo.
- **`settlement`** — the `SettlementBackend` interface (`id`, `configured`, `createIntent`,
  `settle`), an in-memory `mockBackend` that clears instantly, a `zbdBackend` stub (shaped
  exactly like a real ZBD/Lightning adapter but makes no live network call in either
  direction), a `resolveBackend`/`availableBackends` registry, and `authorizeSettlement`, which
  records real-money bookkeeping (never `liabilities:energy:*`) once a backend actually clears,
  refusing — and never mutating the ledger — if a `"payout"` would break the payout invariant.
  An on-chain backend can join later as a third `SettlementBackend` implementation with no
  schema change to `Ledger` or anything that calls `authorizeSettlement`.

Not implemented in this package: the `EnergyHooks`/`priceOf` action-pricing surface from §2.5
of the spec, and the aggregate `EnergyBank` manager class from §2.6.

## Earn-only, no wagering

Every operation this package exposes is a transfer, an accrual, a spend, or a redemption of
`ENERGY` already held — there is no random-outcome, stake-at-risk, or house-edge mechanic
anywhere in it.

## Layout

```
src/
  decimal.mjs      decimal.d.ts      decimal.test.mts
  accounts.mjs     accounts.d.ts     accounts.test.mts
  ledger.mjs       ledger.d.ts       ledger.test.mts
  invariants.mjs   invariants.d.ts   invariants.test.mts   (includes seeded-random property tests)
  transfer.mjs     transfer.d.ts     transfer.test.mts
  settlement.mjs   settlement.d.ts   settlement.test.mts
  index.mjs        index.d.ts        index.test.mts        (barrel re-export + a smoke test)
  prng.mts                           prng.test.mts          (test-only seeded RNG; not in the export map)
```

## Development

```sh
npm test         # node --test src/*.test.mts
npm run check    # node --check every src/*.mjs
npm run check && npm test   # check && test
```
