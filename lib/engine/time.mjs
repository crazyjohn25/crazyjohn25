const NY = "America/New_York";
const SH = "Asia/Shanghai";

function partsInZone(utcMs, timeZone) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const bag = {};
  for (const part of fmt.formatToParts(new Date(utcMs))) bag[part.type] = part.value;
  let hour = Number(bag.hour);
  if (hour === 24) hour = 0;
  return {
    year: Number(bag.year),
    month: Number(bag.month),
    day: Number(bag.day),
    hour,
    minute: Number(bag.minute),
    second: Number(bag.second),
  };
}

function wallAsUtc(parts) {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
}

export function zonedStamp(year, month, day, hour, minute, timeZone) {
  const desired = Date.UTC(year, month - 1, day, hour, minute, 0);
  const first = wallAsUtc(partsInZone(desired, timeZone));
  let utc = desired - (first - desired);
  const shown = wallAsUtc(partsInZone(utc, timeZone));
  utc -= shown - desired;
  return Math.floor(utc / 1000);
}

export function isRealDay(year, month, day) {
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
}

export function nyStamp(year, month, day, hour, minute = 0) {
  if (!isRealDay(year, month, day)) return null;
  return zonedStamp(year, month, day, hour, minute, NY);
}

export function parts(tsSec, timeZone) {
  return partsInZone(tsSec * 1000, timeZone);
}

export function pad(n) {
  return String(n).padStart(2, "0");
}

export function formatMDHM(tsSec, timeZone) {
  const p = parts(tsSec, timeZone);
  return `${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`;
}

export function formatYMDHM(tsSec, timeZone) {
  const p = parts(tsSec, timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`;
}

export function formatYMD(tsSec, timeZone) {
  const p = parts(tsSec, timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

export function isoOffset(tsSec, timeZone) {
  const p = parts(tsSec, timeZone);
  const asIf = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const minutes = Math.round((asIf - tsSec * 1000) / 60000);
  const sign = minutes >= 0 ? "+" : "-";
  const abs = Math.abs(minutes);
  const offset = `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}${offset}`;
}

export function weekdayNY(tsSec) {
  const name = new Intl.DateTimeFormat("en-US", {
    timeZone: NY,
    weekday: "short",
  }).format(new Date(tsSec * 1000));
  return { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 }[name];
}

export function nySessionBounds(tsSec) {
  const p = parts(tsSec, NY);
  return {
    start: zonedStamp(p.year, p.month, p.day, 9, 30, NY),
    end: zonedStamp(p.year, p.month, p.day, 16, 0, NY),
  };
}

export function nyClock(tsSec, hour, minute = 0) {
  const p = parts(tsSec, NY);
  return zonedStamp(p.year, p.month, p.day, hour, minute, NY);
}

export { NY, SH };
