import GLib from 'gi://GLib';

export const GEM = '◆';

// Resolve the user's locale once. Extensions run inside the gnome-shell
// process, whose environment carries the session's locale categories
// (GNOME's "Formats" setting exports LC_TIME/LC_NUMERIC/etc. separately
// from LANG). SpiderMonkey's Intl only honors LC_ALL/LANG, so an explicit
// LC_TIME would otherwise be ignored; read it ourselves and pass a BCP-47
// tag to Intl. Values like "en_IE.UTF-8" are normalized to "en-IE", and
// anything unusable falls back to undefined (Intl's own default).
function toBcp47(value) {
  if (!value || value === 'C' || value === 'POSIX')
    return null;
  return value.split('.')[0].split('@')[0].replaceAll('_', '-');
}

function resolveLocale(categories) {
  for (const category of categories) {
    const tag = toBcp47(GLib.getenv(category));
    if (tag === null)
      continue;
    try {
      if (Intl.DateTimeFormat.supportedLocalesOf([tag]).length > 0)
        return tag;
    } catch {
      // Not a structurally valid tag; try the next variable.
    }
  }
  return undefined;
}

const LOCALE_NUMBER = resolveLocale(['LC_ALL', 'LC_NUMERIC', 'LANG']);
const LOCALE_TIME = resolveLocale(['LC_ALL', 'LC_TIME', 'LANG']);

export function formatBalance(balance, compact) {
  const options = compact
    ? { notation: 'compact', maximumFractionDigits: 1 }
    : Number.isInteger(balance)
      ? {}
      : { maximumFractionDigits: 2 };
  return new Intl.NumberFormat(LOCALE_NUMBER, options).format(balance);
}

export function formatClock(date) {
  // Respect the user's locale (12/24-hour, separators) rather than forcing
  // zero-padded 24-hour HH:MM.
  return new Intl.DateTimeFormat(LOCALE_TIME, {
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}
