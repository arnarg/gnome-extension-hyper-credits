export const GEM = '◆';

export function formatBalance(balance, compact) {
  const options = compact
    ? { notation: 'compact', maximumFractionDigits: 1 }
    : Number.isInteger(balance)
      ? {}
      : { maximumFractionDigits: 2 };
  return new Intl.NumberFormat(undefined, options).format(balance);
}

export function formatClock(date) {
  // Respect the user's locale (12/24-hour, separators) rather than forcing
  // zero-padded 24-hour HH:MM.
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}
