// Strict ISO-8601 / RFC3339 UTC-instant validator for `hitch summary`
// time-window flags (#84 Stage B). `Date.parse` is NOT fail-closed — it accepts
// prose ("June 1, 2026"), offset-less LOCAL time ("2026-06-01T00:00:00"),
// impossible dates rolled over ("2026-02-31T…Z" → Mar 3), and bare numbers
// ("1"). #84 requires fail-closed validation, so we (1) require a strict shape
// with an explicit UTC designator `Z` or a numeric `±HH:MM` offset, (2) validate
// every calendar/clock component arithmetically (so an impossible date is
// rejected, never silently rolled over), then (3) use Date.parse — now safe,
// because the shape and components are already proven valid — to obtain the
// epoch-ms. Uppercase `T`/`Z` only, matching the canonical `toISOString()` form
// the harness writes.
const ISO_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/;

/** Last calendar day of `month` (1-12) in `year` — proleptic Gregorian,
 * leap-year aware, with no `Date` century-remap pitfall. `month` is validated
 * to 1-12 before this is called. */
function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  return [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
}

/**
 * Parse a strict ISO-8601 UTC instant to epoch-ms, or `null` if the input is
 * not a valid, unambiguous instant. Fail-closed: any rejection returns `null`
 * (the caller decides whether that is a CLI error or a silent exclusion).
 */
export function parseIsoInstantMs(value: string): number | null {
  const m = ISO_INSTANT.exec(value);
  if (m === null) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6]);
  const offset = m[8]!;
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  if (offset !== "Z") {
    const offHours = Number(offset.slice(1, 3));
    const offMinutes = Number(offset.slice(4, 6));
    if (offHours > 23 || offMinutes > 59) return null;
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}
