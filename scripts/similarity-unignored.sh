#!/usr/bin/env bash
# Reads similarity-ts output on stdin and prints one `file:line name` per
# finding that carries no `similarity-ignore` comment. The Stop gate counts the
# lines; anything printed is what blocks it.
#
# Split out of `.claude/hooks/stop-gate.sh` so the two rules below can be tested
# against fixtures instead of only against whatever the repo happens to contain.
# Both were wrong while inline, and neither was visible from the hook's output.
set -uo pipefail

SIM=$(cat)

# similarity-ts 0.4.1 prints two line shapes, and the number means something
# different in each:
#
#   ./src/a.ts:134-213 createRoadLines
#   ./src/a.ts:35 | L35-37 similar-type: RoadLegendProps (interface)
#
# For a function it is the declaration's own line, so the comment above the
# declaration is the line before it. For a type it is the line the type sits on
# — and an inline return type inside a multi-line arrow signature sits several
# lines *below* the declaration, so the comment above the declaration is not the
# preceding line and a location-only check cannot see it. Both shapes name the
# symbol, so the declaration is findable by name, and that is where this looks
# second. Without it, `similarity-ignore` is unwritable for that whole class:
# the only line that would work is inside the parameter list.
# `#` delimits the substitutions and the literal pipe is written `[|]`: with `|`
# as the delimiter, escaping it inside the pattern misparses and sed falls
# through to printing the untouched line, which the caller then reads as a
# filename and silently skips. That is how this was first written.
#
# `sed -n` prints nothing for a line neither pattern claims, so a wording change
# in a future similarity-ts would drop findings with no trace — the same silence
# this script exists to remove. The counts are therefore compared: every line
# that looks like a location is expected to be claimed by one of the two, and a
# shortfall is said out loud. It cannot be turned into a finding, because a shape
# nobody parsed has no file or line to report. Only the report's own location
# lines start with `./` when similarity-ts is pointed at a directory, which is
# how the hook calls it, so the headers and totals do not enter this count.
locations() {
  local matched raw_count matched_count
  matched=$(printf '%s\n' "$SIM" | sed -nE \
    -e 's#^[[:space:]]*(\./[^ :]+):([0-9]+)(-[0-9]+)?[[:space:]]+([A-Za-z_$][A-Za-z0-9_$]*)[[:space:]]*$#\1 \2 \4#p' \
    -e 's#^[[:space:]]*(\./[^ :]+):([0-9]+)[[:space:]]+[|][^:]*:[[:space:]]*([A-Za-z_$][A-Za-z0-9_$]*).*$#\1 \2 \3#p')
  raw_count=$(printf '%s\n' "$SIM" |
    grep -cE '^[[:space:]]*\./[^[:space:]:]+:[0-9]+' || true)
  matched_count=$(printf '%s\n' "$matched" | grep -c . || true)
  if [ "$raw_count" -ne "$matched_count" ]; then
    printf 'similarity-unignored: %s location line(s) matched neither known shape, output format may have changed\n' \
      "$((raw_count - matched_count))" >&2
  fi
  # Nothing, rather than one empty line: `printf '%s\n' ""` emits a blank line,
  # which the reader below takes for a location with no file and reports as an
  # unresolved path — a finding invented out of a clean report, and enough on its
  # own to block the gate. The pipeline this replaced could not do that because
  # `sed` writing nothing left `sort` nothing to read.
  [ -n "$matched" ] || return 0
  printf '%s\n' "$matched" | sort -u
}

ignore_above() { # $1 = file, $2 = line — true when the line before it ignores
  local prev=$(($2 - 1))
  [ "$prev" -ge 1 ] || return 1
  case "$(sed -n "${prev}p" "$1")" in *similarity-ignore*) return 0 ;; esac
  return 1
}

# The nearest declaration at or before the reported line, not the first in the
# file. Taking the first silently forgave a real finding: a name declared twice —
# once in an inner scope carrying a `similarity-ignore`, once at module scope
# without one — resolved to the inner declaration, whose comment then covered a
# location it has nothing to do with, and the module-scope finding vanished.
# `default` is optional after `export` because `export default interface Foo` is
# valid TypeScript and puts a word between the two the rest of this pattern
# expects to be adjacent. Nothing in `src/` writes that form today; it is here
# because the cost of missing it is a finding forgiven in silence.
declaration_line() { # $1 = file, $2 = symbol name, $3 = reported line
  grep -nE "^[[:space:]]*(export[[:space:]]+(default[[:space:]]+)?)?(const|let|var|function|interface|type|class)[[:space:]]+$2\b" "$1" |
    cut -d: -f1 |
    awk -v line="$3" '$1 <= line { last = $1 } END { if (last) print last }'
}

locations | while read -r rel line name; do
  file=${rel#./}
  # A path that does not resolve fails closed. similarity-ts reports paths
  # relative to where it ran, and the hook runs both from `$ROOT`, so this is
  # unreachable from there; any other caller would otherwise lose findings with
  # nothing said, which is the failure this whole script exists to remove.
  if [ ! -f "$file" ]; then
    printf 'similarity-unignored: %s not found, treating as unresolved\n' \
      "$file" >&2
    printf '%s:%s %s\n' "$file" "$line" "$name"
    continue
  fi
  ignore_above "$file" "$line" && continue
  decl=$(declaration_line "$file" "$name" "$line")
  if [ -n "$decl" ] && [ "$decl" != "$line" ]; then
    ignore_above "$file" "$decl" && continue
  fi
  printf '%s:%s %s\n' "$file" "$line" "$name"
done
