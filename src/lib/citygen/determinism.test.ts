import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The source scan ADR-0027 names as the guard for its determinism policy.
 *
 * That ADR's Decision reads "`Math.sin/cos/tan/exp/log/pow/atan2/hypot/cbrt/
 * random`, `**`, and the clock are banned inside the engine ... Golden per-stage
 * content hashes are the proof, a source scan is the guard." The proof existed and
 * the guard did not: as of 2026-08-04 no lint rule, test or CI step checked any of
 * it, and the ban held by convention alone.
 *
 * The goldens cannot stand in for it, which is the whole reason it is worth having.
 * A `Math.sin` added to the engine would produce one stable value under the engine
 * the goldens were taken with, pass every hash assertion, and quietly make the
 * output engine-dependent — precisely the failure that a non-transitive comparator
 * in `graph/faces.ts` did cause, undetected by three committed golden seeds, until
 * the same seed was run under a second runtime and diffed per stage.
 *
 * `Math.sqrt`, `abs`, `floor`, `ceil`, `round`, `trunc`, `sign`, `min` and `max`
 * are deliberately absent from the ban: each is exactly specified by IEEE-754 or
 * by the language, so each is bit-identical across engines.
 */

const ENGINE_DIR = join(process.cwd(), "src", "lib", "citygen");

/**
 * Source with comments removed, so the ban does not fire on prose about itself.
 *
 * Several engine files name the forbidden calls in their own doc comments —
 * `field/noise.ts` lists them and `geometry/vec.ts` states that none appear — and
 * an unstripped scan reports those as violations.
 *
 * String literals are matched *before* the comment forms and passed through
 * untouched, which is the whole reason this is one alternation rather than two
 * sequential `replace` calls. Two calls cannot tell `//` inside a quote from a
 * comment starter, so `const u = "https://x"; return Math.pow(a, b);` had its
 * `Math.pow` deleted along with the rest of the line and the scan reported the
 * file clean. No engine source triggers that today — scanned, zero `//` inside a
 * literal and zero comments trailing real code — but the guard exists to survive
 * the source changing under it, and a guard that silently stops matching reads
 * exactly like a compliant engine.
 *
 * Anchoring the strip to comment-only lines was the other candidate fix and is
 * rejected: it would stop removing trailing comments entirely, so the first
 * `const x = 1; // avoids Math.pow` would be a false positive. That trades a
 * dormant false negative for a dormant false positive instead of closing either.
 * Matching literals closes the gap without the trade.
 */
const COMMENT_OR_LITERAL =
  /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g;

const withoutComments = (source: string): string =>
  source.replace(COMMENT_OR_LITERAL, (match) =>
    match.startsWith("//") || match.startsWith("/*") ? "" : match
  );

interface Ban {
  readonly label: string;
  readonly pattern: RegExp;
}

const BANS: readonly Ban[] = [
  {
    label: "transcendental or Math.random",
    // Longer alternatives first, so `log10` is not matched as `log`.
    pattern:
      /\bMath\s*\.\s*(atan2|atan|asin|acos|sinh|cosh|tanh|sin|cos|tan|expm1|exp|log1p|log10|log2|log|pow|hypot|cbrt|random)\b/,
  },
  { label: "exponent operator", pattern: /\*\*/ },
  {
    label: "clock",
    pattern: /\b(?:Date\s*\.\s*now|performance\s*\.\s*now)\b|\bnew\s+Date\b/,
  },
];

const violationsIn = (source: string): readonly string[] => {
  const code = withoutComments(source);
  return BANS.filter((ban) => ban.pattern.test(code)).map((ban) => ban.label);
};

/** Every non-test TypeScript source under the engine directory. */
const engineSources = (dir: string): readonly string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return engineSources(full);
    return entry.isFile() &&
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts")
      ? [full]
      : [];
  });

describe("engine determinism scan", () => {
  /**
   * The scanner's own regression test. A guard that has stopped matching reports a
   * clean engine, which reads exactly like a compliant one — so each ban is proved
   * against a positive fixture before the real sources are trusted to its verdict.
   */
  it("should flag each banned form when handed one", () => {
    expect([
      violationsIn("const a = Math.sin(x);"),
      violationsIn("const a = Math.random();"),
      violationsIn("const a = Math.log10(x);"),
      violationsIn("const a = x ** 2;"),
      violationsIn("const a = Date.now();"),
      violationsIn("const a = new Date();"),
      violationsIn("const a = performance.now();"),
    ]).toEqual([
      ["transcendental or Math.random"],
      ["transcendental or Math.random"],
      ["transcendental or Math.random"],
      ["exponent operator"],
      ["clock"],
      ["clock"],
      ["clock"],
    ]);
  });

  it("should allow the exactly-specified Math functions when they appear", () => {
    expect(
      violationsIn(
        "const a = Math.sqrt(Math.abs(Math.min(Math.floor(x), Math.max(y, 0))));"
      )
    ).toEqual([]);
  });

  it("should report no violation when a doc comment names a banned call", () => {
    expect(
      violationsIn("/** No Math.random, no `**`, no Date.now. */")
    ).toEqual([]);
  });

  /**
   * The comment strip must not eat code hiding behind a string literal.
   *
   * With two sequential `replace` calls the `//` in the URL read as a comment
   * starter and took the rest of the line — `Math.pow` included — so the scan
   * called this line clean. Each quote style is covered because the alternation
   * lists them separately and a typo in any one of the three would reopen the gap
   * for that style alone.
   */
  it.each([
    ['const u = "https://x";', "double"],
    ["const u = 'https://x';", "single"],
    ["const u = `https://x`;", "template"],
  ])(
    "should still flag a banned call when a %s-quoted literal on the same line contains a slash pair",
    (literal) => {
      expect(violationsIn(`${literal} return Math.pow(a, b);`)).toEqual([
        "transcendental or Math.random",
      ]);
    }
  );

  /** Trailing comments must still be stripped, which the rejected fix would have broken. */
  it("should report no violation when a trailing comment after code names a banned call", () => {
    expect(violationsIn("const x = 1; // avoids Math.pow entirely")).toEqual(
      []
    );
  });

  /** A quote inside a comment is comment text, not the start of a literal. */
  it("should report no violation when a comment contains an unbalanced quote", () => {
    expect(violationsIn("const x = 1; // don't use Math.random")).toEqual([]);
  });

  it("should find engine sources to scan when reading the engine directory", () => {
    expect(engineSources(ENGINE_DIR).length).toBeGreaterThan(30);
  });

  it("should report no banned construct when scanning every engine source", () => {
    const offenders = engineSources(ENGINE_DIR).flatMap((file) =>
      violationsIn(readFileSync(file, "utf8")).map(
        (label) => `${file.slice(process.cwd().length + 1)}: ${label}`
      )
    );
    expect(offenders).toEqual([]);
  });
});
