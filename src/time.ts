import { Temporal } from "@js-temporal/polyfill";
import { AxiError } from "./errors.js";

export interface TimeRange {
  from: Date;
  to: Date;
  timezone: string;
  year: number;
}

function parseDuration(value: string): number | undefined {
  const match = value.match(/^([1-9]\d*)(m|h|d|w)$/);
  if (!match) return undefined;
  const amount = Number(match[1]);
  const unit = match[2];
  const duration = amount * ({ m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[unit!] ?? 0);
  return Number.isSafeInteger(amount) && Number.isSafeInteger(duration) && duration <= 8_000_000_000_000_000 ? duration : undefined;
}

function toDate(value: Temporal.ZonedDateTime | Temporal.Instant): Date {
  return new Date(Number(value.epochMilliseconds));
}

function localDateTime(value: string, timezone: string): Temporal.ZonedDateTime {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2})(?::(\d{2}))?(?::(\d{2}))?)?$/);
  if (!match) throw new RangeError("not a local date-time");
  return Temporal.ZonedDateTime.from({
    timeZone: timezone,
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4] ?? 0),
    minute: Number(match[5] ?? 0),
    second: Number(match[6] ?? 0),
  }, { disambiguation: "reject", overflow: "reject" });
}

function parseDate(value: string, name: string, timezone: string): Date {
  try {
    if (/^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}(?::\d{2})?(?::\d{2})?)?$/.test(value)) return toDate(localDateTime(value, timezone));
    const withZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value) && !value.includes("[") ? `${value}[${timezone}]` : value;
    return toDate(Temporal.ZonedDateTime.from(withZone, { disambiguation: "reject", offset: "reject", overflow: "reject" }));
  } catch (cause) {
    throw new AxiError({ code: "TIME_INVALID", message: `${name} must be a valid, unambiguous ISO-8601 date or timestamp compatible with ${timezone}.`, exitCode: 2, cause });
  }
}

export function resolveTimeRange(options: { since?: string; from?: string; to?: string; on?: string; timezone: string; now?: Date }): TimeRange {
  try { Temporal.Now.zonedDateTimeISO(options.timezone); } catch (cause) { throw new AxiError({ code: "TIMEZONE_INVALID", message: `Timezone '${options.timezone}' is invalid.`, exitCode: 2, cause }); }
  const now = options.now ?? new Date();
  const selected = [options.since, options.from, options.on].filter(Boolean).length;
  if (selected > 1) throw new AxiError({ code: "TIME_CONFLICT", message: "Use only one of --since, --from, or --on.", exitCode: 2 });
  if (options.on && options.to) throw new AxiError({ code: "TIME_CONFLICT", message: "--on cannot be combined with --to.", exitCode: 2 });
  let to = options.to ? parseDate(options.to, "--to", options.timezone) : now;
  let from: Date;
  if (options.since) {
    const duration = parseDuration(options.since);
    if (!duration) throw new AxiError({ code: "TIME_INVALID", message: "--since must use a positive duration such as 30m, 24h, 7d, or 2w.", exitCode: 2 });
    from = new Date(to.getTime() - duration);
  } else if (options.on) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(options.on)) throw new AxiError({ code: "TIME_INVALID", message: "--on must be YYYY-MM-DD.", exitCode: 2 });
    let start: Temporal.ZonedDateTime;
    try { start = localDateTime(`${options.on}T00:00:00`, options.timezone); } catch (cause) { throw new AxiError({ code: "TIME_INVALID", message: "--on must be a valid calendar date.", exitCode: 2, cause }); }
    from = toDate(start);
    to = toDate(start.add({ days: 1 }));
  } else if (options.from) {
    from = parseDate(options.from, "--from", options.timezone);
  } else {
    from = new Date(to.getTime() - 86_400_000);
  }
  if (from >= to) throw new AxiError({ code: "TIME_RANGE_INVALID", message: "The resolved --from time must be earlier than --to.", exitCode: 2 });
  const year = Temporal.Instant.fromEpochMilliseconds(from.getTime()).toZonedDateTimeISO(options.timezone).year;
  return { from, to, timezone: options.timezone, year };
}
