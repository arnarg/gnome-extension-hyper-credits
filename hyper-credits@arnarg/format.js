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
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}
