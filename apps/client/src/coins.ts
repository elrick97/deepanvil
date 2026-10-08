// The forge counts in gold: 1 coin = 1 US cent of API-equivalent spend (the engine's own
// list-price estimate). Subscription billing isn't per token, so coins show *relative*
// cost — what each tier and quest burns — which is what token min-maxing is about.

export const USD_PER_COIN = 0.01;

export function coinsOf(usd: number): number {
  return usd / USD_PER_COIN;
}

/** 0.3, 7.5, 42, 1.2k */
export function formatCoins(coins: number): string {
  if (coins >= 1000) return `${(coins / 1000).toFixed(1)}k`;
  if (coins >= 10) return String(Math.round(coins));
  if (coins >= 0.1) return coins.toFixed(1);
  return coins > 0 ? '<0.1' : '0';
}

/** An inline coin icon (the rendered coin.png from assets/src/build_coin.py). */
export function coinIcon(): HTMLImageElement {
  const img = document.createElement('img');
  img.src = '/assets/coin.png';
  img.alt = 'gold';
  img.className = 'coin-ico';
  img.decoding = 'async';
  return img;
}

/** "<coin> 42" as a span, with the dollar equivalent on hover. */
export function coinAmount(usd: number, prefix = ''): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = 'coin-amt';
  span.title = `$${usd.toFixed(usd < 1 ? 3 : 2)} API-equivalent`;
  if (prefix) span.append(prefix);
  span.append(coinIcon(), formatCoins(coinsOf(usd)));
  return span;
}
