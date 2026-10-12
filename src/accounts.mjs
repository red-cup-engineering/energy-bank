/**
 * `accounts` — the shared identity shape every 561 game plays against: a guest account from
 * the first tick, a durable account once a player chooses to log in, and the guest→durable
 * migration between them.
 *
 * Lifted as *pattern*, not code, from flickering-delve's `accounts.mts` (whose concrete
 * methods are bound to `DelveScene` and so cannot be imported verbatim): every visitor is a
 * real actor immediately — a **guest** keyed by an opaque client-minted token, so guest
 * progress persists and survives reloads with no account at all — and **logging in** with a
 * handle mints a durable account id and offers to migrate the guest's whole history into it.
 * Energy-bank owns the id derivation and the migration guard sequencing; it does not own
 * where a game's own state lives, so `authenticate`/`migrateGuest` take that storage as
 * injected callbacks (a `SecretStore`, and export/import facts functions) rather than reaching
 * into any particular game's state module.
 *
 * Type shapes (`AccountKind`, `AccountId`, `Account`, `SecretStore`, `IdentityFederation`) are
 * declared in the co-located accounts.d.ts, not here — this file is plain JavaScript, no
 * TypeScript syntax, so it loads correctly whether run directly or imported from inside a
 * consumer's node_modules (Node's type-stripping is unavailable for files under
 * node_modules, which is why this package ships .mjs rather than .mts as its runtime
 * source).
 */
import { slugify } from "@red-cup-engineering/computer-text-content-engineering-services-section/slugify-text";
import { sha256Hex } from "@red-cup-engineering/cryptographic-computer-data-engineering-services-section/integrity";

const slug = (text) => slugify(text);

const localPart = (raw) => {
  const s = slug(raw).slice(0, 48);
  return s === "" ? "anon" : s;
};

/** A guest account id, keyed by an opaque client-minted key, scoped to a namespace. */
export function guestAccountId(namespace, clientKey) {
  return `${namespace}:guest-${localPart(clientKey)}`;
}

/** A durable account id, keyed by a chosen handle, scoped to a namespace. */
export function durableAccountId(namespace, handle) {
  return `${namespace}:account-${localPart(handle)}`;
}

/** True iff `id`'s local part marks it as a guest account (namespace-agnostic). */
export function isGuest(id) {
  const local = id.slice(id.indexOf(":") + 1);
  return local.startsWith("guest-");
}

/** The namespace segment of an account id, or "" if the id has no ":" at all. */
export function namespaceOf(id) {
  const i = id.indexOf(":");
  return i === -1 ? "" : id.slice(0, i);
}

/** Build an `Account` record from an id whose kind is already known (from context — a login
 *  vs. a guest-session start — not by re-deriving it from the id's shape). */
export function account(id, kind) {
  return { id, namespace: namespaceOf(id), kind };
}

/** Salted secret hash (sha256 over namespace:id:secret). Defense-in-depth for a game login,
 *  not a substitute for a real auth provider. */
export function hashSecret(namespace, id, secret) {
  return sha256Hex(`${namespace}:${id}:${secret}`);
}

/** The chart-of-accounts path for an account's spendable balance in `commodity`, derived from
 *  the commodity rather than fixed to ENERGY — an account posting HBD (or any other commodity)
 *  gets its own `liabilities:<commodity>:*` prefix, never the literal `liabilities:energy:*`
 *  path regardless of what is actually held there. Defaults to `"ENERGY"` so every existing
 *  single-commodity caller keeps its prior path unchanged. See ledger.mjs's header comment for
 *  the sign convention this ledger uses for `liabilities:<commodity>:*` balances (positive
 *  means "currently held by this account").
 * @param {string} id The account id.
 * @param {string} [commodity] The commodity this path holds a balance in; defaults to `"ENERGY"`.
 * @returns {string} The chart-of-accounts path, `liabilities:<commodity lowercased>:<id>`.
 */
export function energyAccountPath(id, commodity = "ENERGY") {
  return `liabilities:${commodity.toLowerCase()}:${id}`;
}

/** Build an `IdentityFederation` for one namespace, backed by a caller-supplied secret store. */
export function createIdentityFederation(namespace, secrets) {
  return {
    guestAccountId: (clientKey) => guestAccountId(namespace, clientKey),
    durableAccountId: (handle) => durableAccountId(namespace, handle),

    async authenticate(id, secret) {
      if (secret === "") return false;
      const hash = hashSecret(namespace, id, secret);
      const stored = await secrets.getSecretHash(id);
      if (stored === null) {
        await secrets.setSecretHash(id, hash);
        return true;
      }
      return stored === hash;
    },

    async migrateGuest(guest, durable, hasProgress, exportFacts, importFacts) {
      if (!isGuest(guest) || guest === durable) return;
      if (!(await hasProgress(guest))) return;
      if (await hasProgress(durable)) return;
      const facts = await exportFacts(guest);
      await importFacts(durable, facts);
    },
  };
}
