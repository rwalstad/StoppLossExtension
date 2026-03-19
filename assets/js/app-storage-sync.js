const APP_MONITOR_CACHE_STORAGE_KEY = 'stocktrade:extension-monitor-cache';
const SELECTED_TRADER_ID_STORAGE_KEY = 'stoploss-selected-trader-id';
const SELECTED_TRADER_NAME_STORAGE_KEY = 'stoploss-selected-trader-name';
const APP_MONITOR_CACHE_EVENT = 'stocktrade-monitor-cache-updated';

function normalizeTicker(value) {
  return String(value ?? '').trim().toUpperCase();
}

function sanitizePlans(plans) {
  return (Array.isArray(plans) ? plans : [])
    .map((plan) => {
      const ticker = normalizeTicker(plan?.instrument?.ticker);

      if (!ticker) {
        return null;
      }

      return {
        id: String(plan?.id ?? '').trim(),
        kind: plan?.kind ?? null,
        triggerPrice: String(plan?.triggerPrice ?? '').trim(),
        triggerCondition: plan?.triggerCondition ?? null,
        isEnabled: Boolean(plan?.isEnabled),
        notes: plan?.notes ?? null,
        triggeredAt: plan?.triggeredAt ?? null,
        updatedAt: plan?.updatedAt ?? null,
        instrument: {
          id: plan?.instrument?.id ?? null,
          ticker,
          name: plan?.instrument?.name ?? '',
          market: plan?.instrument?.market ?? null,
          currency: plan?.instrument?.currency ?? '',
          sourceUrl: plan?.instrument?.sourceUrl ?? null,
        },
      };
    })
    .filter(Boolean);
}

function sanitizePrices(prices) {
  const nextPrices = {};

  for (const [ticker, entry] of Object.entries(prices ?? {})) {
    const normalizedTicker = normalizeTicker(ticker);

    if (!normalizedTicker) {
      continue;
    }

    nextPrices[normalizedTicker] = {
      ok: Boolean(entry?.ok),
      price: Number(entry?.price),
      error: entry?.error ?? null,
      fetchedAt: entry?.fetchedAt ?? null,
      source: entry?.source ?? null,
    };
  }

  return nextPrices;
}

function dispatchCacheUpdated(cache) {
  window.dispatchEvent(new CustomEvent(APP_MONITOR_CACHE_EVENT, {
    detail: cache,
  }));
}

async function syncMonitorCacheToPage() {
  const storage = await chrome.storage.local.get([
    'extensionPrices',
    'extensionPricesUpdatedAt',
    'floatingMonitorState',
    SELECTED_TRADER_ID_STORAGE_KEY,
    SELECTED_TRADER_NAME_STORAGE_KEY,
  ]);
  const floatingMonitorState = storage?.floatingMonitorState ?? {};
  const nextCache = {
    prices: sanitizePrices(storage?.extensionPrices ?? {}),
    updatedAt: storage?.extensionPricesUpdatedAt ?? floatingMonitorState?.updatedAt ?? null,
    traderId: String(
      floatingMonitorState?.currentTraderId ??
      storage?.[SELECTED_TRADER_ID_STORAGE_KEY] ??
      '',
    ).trim() || null,
    traderName: String(
      floatingMonitorState?.currentTraderName ??
      storage?.[SELECTED_TRADER_NAME_STORAGE_KEY] ??
      '',
    ).trim() || null,
    currentTicker: normalizeTicker(floatingMonitorState?.currentTicker),
    plans: sanitizePlans(floatingMonitorState?.plans),
  };
  const serializedCache = JSON.stringify(nextCache);
  const currentCache = window.localStorage.getItem(APP_MONITOR_CACHE_STORAGE_KEY);

  if (currentCache !== serializedCache) {
    window.localStorage.setItem(APP_MONITOR_CACHE_STORAGE_KEY, serializedCache);
  }

  dispatchCacheUpdated(nextCache);
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') {
    return;
  }

  if (
    changes?.extensionPrices ||
    changes?.extensionPricesUpdatedAt ||
    changes?.floatingMonitorState ||
    changes?.[SELECTED_TRADER_ID_STORAGE_KEY] ||
    changes?.[SELECTED_TRADER_NAME_STORAGE_KEY]
  ) {
    void syncMonitorCacheToPage();
  }
});

void syncMonitorCacheToPage();
