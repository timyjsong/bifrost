/**
 * Nothing but regexes.
 *
 * This is the ONE file the leak guard cannot scan, because a pattern that
 * matches an identifier necessarily looks like one. Everything else — including
 * the vocabulary lists and the guard itself — is scanned normally.
 *
 * Keeping the unscannable surface to regex declarations and nothing else is what
 * makes the exclusion safe: `placeholders.test.ts` asserts that every
 * substantive line here is `export const NAME = /…/flags;`, so a value cannot be
 * hidden in this file without failing that grammar check. Earlier versions
 * exempted a whole test file and twice hid a real leak in the exemption.
 */

/** Absolute home paths. 3+ chars: a 2-char tail is regex flags, not a user. */
export const HOME_PATH = /\/home\/[A-Za-z0-9._-]{3,}/gi;
/** The slugified form: separators replaced, so no slashes survive. */
export const HOME_SLUG = /[-_]home[-_][A-Za-z0-9._-]+?[-_]/gi;
/** Home-rooted paths in either spelling, for the project-name check. */
export const HOME_ROOTED = /(?:\/home\/you|-home-you)[A-Za-z0-9._/-]*/g;
/** Tailnet hosts. */
export const TAILNET = /[A-Za-z0-9._-]+\.ts\.net/gi;
/** Tailscale CGNAT addresses. */
export const CGNAT = /\b100\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g;
/** Anything shaped like an e-mail address. */
export const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
/** Session ids. Boundaries are explicit, not \b — \b never fires after "_". */
export const UUID = /(?<![0-9a-z])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9a-z])/gi;
/** A path rooted anywhere, for the name checks. */
export const ROOTED_PATH = /(?:~|\/[A-Za-z0-9._-]+|[-_]home[-_]you)[A-Za-z0-9._/-]*/gi;
/** Word-ish tokens, for the bare-name check. Any text, not just literals. */
export const WORD_TOKEN = /[A-Za-z0-9][A-Za-z0-9._-]{2,}/g;
/** Opaque account-scoped ids: session/message/account handles from other tools. */
export const OPAQUE_ID = /\b(?:cse|session|msg|acct|org|user)_[A-Za-z0-9]{16,}\b/g;
/** A home path assembled from fragments, which defeats every literal scan. */
export const CONCAT_HOME = /["'`]\/?home\/?["'`]\s*\+|\+\s*["'`]\/?home|\$\{[^}]*\}\/home|\/home\/\$\{/gi;
