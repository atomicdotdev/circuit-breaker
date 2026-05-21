/**
 * Terminal symbols.
 *
 * ASCII by default — reliable everywhere.  Set CB_UNICODE=1 to opt in to
 * Unicode symbols (they work on most modern terminals but not all).
 */

export const unicode = process.env.CB_UNICODE === "1";

export const s = {
  check: unicode ? "✓" : "ok",
  cross: unicode ? "✗" : "!!",
  warn:  unicode ? "⚠" : " !",
  play:  unicode ? "▶" : " >",
  skip:  unicode ? "⊘" : " -",
  dot:   unicode ? "·" : " .",
};
