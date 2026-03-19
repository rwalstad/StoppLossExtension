const APP_BASE_URL = 'https://trading.just4us.no';
const DASHBOARD_URL = `${APP_BASE_URL}/dashboard`;
const DASHBOARD_FALLBACK_URL = `${APP_BASE_URL}/`;
const IMPORT_URL = `${APP_BASE_URL}/api/extension/instruments`;
const TRADERS_URL = `${APP_BASE_URL}/api/traders`;
const VIRTUAL_STOP_LOSS_URL = `${APP_BASE_URL}/api/extension/virtual-stop-loss`;
const MONITORING_PLAN_URL = `${APP_BASE_URL}/api/extension/monitoring-plan`;
const PRICE_SNAPSHOT_URL = `${APP_BASE_URL}/api/extension/price-snapshot`;
const SELECTED_TRADER_STORAGE_KEY = 'stoploss-selected-trader-id';
const BACKGROUND_PRICE_REFRESH_ALARM = 'background-price-refresh';
const BACKGROUND_PRICE_REFRESH_PERIOD_MINUTES = 1;
const NORDNET_TAB_PATTERNS = [
  'https://www.nordnet.no/aksjer/kurser/*',
  'https://www.nordnet.no/etp/sertifikat/*/liste/*',
];

function debugLog(step, details) {
  console.info(`[StopLossExtension background] ${step}`, details);
}

async function getStoredSelectedTraderId() {
  const storage = await new Promise((resolve) => {
    chrome.storage.local.get([SELECTED_TRADER_STORAGE_KEY], resolve);
  });
  const traderId = String(storage?.[SELECTED_TRADER_STORAGE_KEY] ?? '').trim();
  return traderId || null;
}

async function checkDashboard() {
  const urlsToProbe = [DASHBOARD_URL, DASHBOARD_FALLBACK_URL];

  for (const url of urlsToProbe) {
    try {
      const response = await fetch(url, {
        method: 'GET',
        cache: 'no-store',
        redirect: 'manual',
      });

      const reachable = response.ok || response.status > 0 || response.type === 'opaqueredirect';
      debugLog('Dashboard probe response', {
        url,
        reachable,
        status: response.status,
        type: response.type,
      });

      if (reachable) {
        return {
          ok: true,
          status: response.status,
          url,
        };
      }
    } catch (error) {
      debugLog('Dashboard probe failed', {
        url,
        error: error instanceof Error ? error.message : error,
      });
    }
  }

  return {
    ok: false,
    status: 0,
    error: 'Dashboard unavailable',
  };
}

async function checkInstrumentExists(instrument) {
  const url = new URL(IMPORT_URL);

  if (instrument?.ticker) {
    url.searchParams.set('ticker', instrument.ticker);
  }

  if (instrument?.isin) {
    url.searchParams.set('isin', instrument.isin);
  }

  if (instrument?.market) {
    url.searchParams.set('market', instrument.market);
  }

  if (instrument?.marketCode) {
    url.searchParams.set('marketCode', instrument.marketCode);
  }

  if (instrument?.traderId) {
    url.searchParams.set('traderId', String(instrument.traderId));
  }

  const response = await fetch(url.toString(), {
    method: 'GET',
    credentials: 'include',
  });
  debugLog('Check instrument response', {
    url: url.toString(),
    status: response.status,
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      error: payload?.message ?? 'Lookup failed',
    };
  }

  return {
    ok: true,
    status: response.status,
    data: payload,
  };
}

async function importInstrument(instrument) {
  debugLog('Import instrument request', instrument);
  const response = await fetch(IMPORT_URL, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(instrument),
  });

  const payload = await response.json().catch(() => ({}));
  debugLog('Import instrument response', {
    status: response.status,
    payload,
  });

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      error: payload?.message ?? 'Import failed',
      details: payload?.details,
    };
  }

  return {
    ok: true,
    status: response.status,
    data: payload,
  };
}

async function fetchTraderInstruments(traderId) {
  const response = await fetch(`${TRADERS_URL}/${encodeURIComponent(String(traderId))}/instruments`, {
    method: 'GET',
    credentials: 'include',
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      error: payload?.error ?? 'Could not load trader holdings',
    };
  }

  return {
    ok: true,
    status: response.status,
    data: payload,
  };
}

async function fetchTraders() {
  const response = await fetch(TRADERS_URL, {
    method: 'GET',
    credentials: 'include',
    cache: 'no-store',
  });

  const payload = await response.json().catch(() => ([]));

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      error: payload?.message ?? payload?.error ?? 'Could not load traders',
    };
  }

  return {
    ok: true,
    status: response.status,
    data: Array.isArray(payload) ? payload : [],
  };
}

async function saveStopLossRule(positionId, stopLossRule) {
  const response = await fetch(`${APP_BASE_URL}/api/positions/${encodeURIComponent(String(positionId))}/stop-loss`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(stopLossRule),
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      error: payload?.error ?? 'Failed to save stop loss rule',
    };
  }

  return {
    ok: true,
    status: response.status,
    data: payload,
  };
}

async function createVirtualStopLoss(payload) {
  const response = await fetch(VIRTUAL_STOP_LOSS_URL, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const responsePayload = await response.json().catch(() => ({}));

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      error: responsePayload?.error ?? 'Failed to create virtual stop loss.',
    };
  }

  return {
    ok: true,
    status: response.status,
    data: responsePayload,
  };
}

async function savePendingSellOrder(positionId, payload) {
  debugLog('Save pending sell order request', {
    positionId,
    payload,
  });
  const response = await fetch(`${APP_BASE_URL}/api/positions/${encodeURIComponent(String(positionId))}/sell-order`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const responsePayload = await response.json().catch(() => ({}));
  debugLog('Save pending sell order response', {
    positionId,
    status: response.status,
    payload: responsePayload,
  });

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      error: responsePayload?.error ?? 'Failed to save pending sell order.',
    };
  }

  return {
    ok: true,
    status: response.status,
    data: responsePayload,
  };
}

async function savePendingBuyOrder(payload) {
  debugLog('Save pending buy order request', {
    payload,
  });
  const response = await fetch(`${APP_BASE_URL}/api/extension/buy-order`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const responsePayload = await response.json().catch(() => ({}));
  debugLog('Save pending buy order response', {
    status: response.status,
    payload: responsePayload,
  });

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      error: responsePayload?.error ?? responsePayload?.message ?? 'Failed to save pending buy order.',
    };
  }

  if (responsePayload?.monitoringPlan && responsePayload?.instrument) {
    await upsertStoredMonitoringPlan(
      buildStoredMonitoringPlanEntry({
        instrument: responsePayload.instrument,
        monitoringPlan: responsePayload.monitoringPlan,
        sourceUrl: payload?.instrument?.sourceUrl,
      }),
      {
        currentTicker: responsePayload.instrument?.ticker ?? payload?.instrument?.ticker ?? '',
      },
    );
  }

  return {
    ok: true,
    status: response.status,
    data: responsePayload,
  };
}

async function saveMonitoringPlan(payload) {
  debugLog('Save monitoring plan request', {
    payload,
  });
  const response = await fetch(MONITORING_PLAN_URL, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const responsePayload = await response.json().catch(() => ({}));
  debugLog('Save monitoring plan response', {
    status: response.status,
    payload: responsePayload,
  });

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      error: responsePayload?.error ?? responsePayload?.message ?? 'Failed to save monitoring plan.',
    };
  }

  if (responsePayload?.monitoringPlan && responsePayload?.instrument) {
    await upsertStoredMonitoringPlan(
      buildStoredMonitoringPlanEntry({
        instrument: responsePayload.instrument,
        monitoringPlan: responsePayload.monitoringPlan,
        sourceUrl: payload?.instrument?.sourceUrl,
      }),
      {
        currentTicker: responsePayload.instrument?.ticker ?? payload?.instrument?.ticker ?? '',
      },
    );
  }

  return {
    ok: true,
    status: response.status,
    data: responsePayload,
  };
}

async function saveInstrumentPriceSnapshot(payload) {
  const traderId = payload?.traderId ?? await getStoredSelectedTraderId();
  const requestPayload = traderId
    ? {
        ...payload,
        traderId,
      }
    : payload;

  debugLog('Save instrument price snapshot request', {
    payload: requestPayload,
  });
  const response = await fetch(PRICE_SNAPSHOT_URL, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(requestPayload),
  });

  const responsePayload = await response.json().catch(() => ({}));
  debugLog('Save instrument price snapshot response', {
    status: response.status,
    payload: responsePayload,
  });

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      error: responsePayload?.error ?? responsePayload?.message ?? 'Failed to save price snapshot.',
    };
  }

  return {
    ok: true,
    status: response.status,
    data: responsePayload,
  };
}

async function fetchLatestInstrumentPriceSnapshots({ traderId, tickers } = {}) {
  try {
    const url = new URL(PRICE_SNAPSHOT_URL);
    const effectiveTraderId = traderId ?? await getStoredSelectedTraderId();
    const normalizedTickers = [...new Set(
      (Array.isArray(tickers) ? tickers : [])
        .map((value) => normalizeMonitorTicker(value))
        .filter(Boolean),
    )];

    debugLog('Fetch latest instrument price snapshots request', {
      traderId: effectiveTraderId ?? null,
      tickers: normalizedTickers,
    });

    if (effectiveTraderId !== undefined && effectiveTraderId !== null && effectiveTraderId !== '') {
      url.searchParams.set('traderId', String(effectiveTraderId));
    }

    if (normalizedTickers.length > 0) {
      url.searchParams.set('tickers', normalizedTickers.join(','));
    }

    const response = await fetch(url.toString(), {
      method: 'GET',
      credentials: 'include',
      cache: 'no-store',
    });

    const responsePayload = await response.json().catch(() => ({}));
    debugLog('Fetch latest instrument price snapshots response', {
      url: url.toString(),
      status: response.status,
      payload: responsePayload,
    });

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        error: responsePayload?.error ?? responsePayload?.message ?? 'Failed to load saved prices.',
      };
    }

    return {
      ok: true,
      status: response.status,
      data: responsePayload,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      error: error instanceof Error ? error.message : 'Failed to load saved prices.',
    };
  }
}

async function fetchMonitoringPlans(traderId) {
  try {
    const url = new URL(MONITORING_PLAN_URL);
    const effectiveTraderId = traderId ?? await getStoredSelectedTraderId();

    if (effectiveTraderId !== undefined && effectiveTraderId !== null && effectiveTraderId !== '') {
      url.searchParams.set('traderId', String(effectiveTraderId));
    }

    const response = await fetch(url.toString(), {
      method: 'GET',
      credentials: 'include',
      cache: 'no-store',
    });

    const responsePayload = await response.json().catch(() => ({}));
    debugLog('Fetch monitoring plans response', {
      url: url.toString(),
      status: response.status,
      payload: responsePayload,
    });

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        error: responsePayload?.error ?? responsePayload?.message ?? 'Failed to load monitoring plans.',
      };
    }

    await syncMonitorTickersFromPlans(responsePayload?.plans);
    await syncFloatingMonitorStateFromPlans(responsePayload?.plans);

    return {
      ok: true,
      status: response.status,
      data: responsePayload,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      error: error instanceof Error ? error.message : 'Failed to load monitoring plans.',
    };
  }
}

async function openFloatingMonitorWindow() {
  const url = chrome.runtime.getURL('monitor.html');

  return new Promise((resolve) => {
    const handleTabFallback = () => {
      chrome.tabs.create({ url, active: true }, (createdTab) => {
        if (chrome.runtime.lastError) {
          resolve({
            ok: false,
            error: chrome.runtime.lastError.message ?? 'Failed to open floating monitor.',
          });
          return;
        }

        resolve({
          ok: true,
          tabId: createdTab?.id ?? null,
          fallback: 'tab',
        });
      });
    };

    if (!chrome.windows?.create) {
      handleTabFallback();
      return;
    }

    chrome.windows.create(
      {
        url,
        type: 'popup',
        width: 420,
        height: 760,
        focused: true,
      },
      (createdWindow) => {
        if (chrome.runtime.lastError) {
          handleTabFallback();
          return;
        }

        resolve({
          ok: true,
          windowId: createdWindow?.id ?? null,
        });
      },
    );
  });
}

function formatInstrumentDetail(label, value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  return `${label}: ${String(value)}`;
}

function buildExistingInstrumentSummary(instrument) {
  if (!instrument) {
    return [];
  }

  return [
    formatInstrumentDetail('Ticker', instrument.ticker),
    formatInstrumentDetail('Name', instrument.name),
    formatInstrumentDetail('Market', instrument.market),
    formatInstrumentDetail('ISIN', instrument.isin),
    formatInstrumentDetail('Currency', instrument.currency),
    formatInstrumentDetail('Type', instrument.type),
    formatInstrumentDetail('Status', instrument.isActive ? 'Active' : 'Inactive'),
    formatInstrumentDetail('Owner', instrument.owner?.name || instrument.owner?.email),
    formatInstrumentDetail(
      'Created',
      instrument.createdAt ? new Date(instrument.createdAt).toLocaleString() : null,
    ),
    formatInstrumentDetail(
      'Updated',
      instrument.updatedAt ? new Date(instrument.updatedAt).toLocaleString() : null,
    ),
  ].filter(Boolean);
}

function appendHoldingSummary(summary, holdingSummary) {
  if (!holdingSummary) {
    return summary;
  }

  const nextSummary = [...summary];
  const hasSelectedTraderHoldings = Number(holdingSummary.selectedTraderOpenPositionCount ?? 0) > 0;
  const openPositionCount = hasSelectedTraderHoldings
    ? holdingSummary.selectedTraderOpenPositionCount
    : holdingSummary.openPositionCount;
  const openQuantity = hasSelectedTraderHoldings
    ? holdingSummary.selectedTraderQuantity
    : holdingSummary.totalQuantity;

  if (openPositionCount > 0) {
    nextSummary.push(`Open positions: ${openPositionCount}`);
    nextSummary.push(`Total shares held: ${openQuantity}`);

    if (hasSelectedTraderHoldings && holdingSummary.totalQuantity !== holdingSummary.selectedTraderQuantity) {
      nextSummary.push(`All traders shares held: ${holdingSummary.totalQuantity}`);
    }

    if (holdingSummary.ownerQuantity > 0) {
      nextSummary.push(`Owner shares held: ${holdingSummary.ownerQuantity}`);
    }
  } else {
    nextSummary.push('Open positions: 0');
  }

  nextSummary.push(`Last trade: ${holdingSummary.lastTrade?.tradedAt ? new Date(holdingSummary.lastTrade.tradedAt).toLocaleString() : 'No trades'}`);

  return nextSummary;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'CHECK_DASHBOARD') {
    checkDashboard().then(sendResponse);
    return true;
  }
  if (message?.type === 'IMPORT_INSTRUMENT') {
    (async () => {
      const existingResponse = await checkInstrumentExists(message.payload);

      if (!existingResponse.ok) {
        sendResponse(existingResponse);
        return;
      }

      if (existingResponse.data?.exists && !message.payload?.confirmUpdate) {
        sendResponse({
          ok: false,
          status: 409,
          requiresConfirmation: true,
          existingInstrument: existingResponse.data.instrument,
          existingInstrumentSummary: appendHoldingSummary(
            buildExistingInstrumentSummary(existingResponse.data.instrument),
            existingResponse.data.holdingSummary,
          ),
          holdingSummary: existingResponse.data.holdingSummary,
          error: 'Instrument already exists. Confirm update to replace the existing entry.',
        });
        return;
      }

      const importResponse = await importInstrument(message.payload);
      sendResponse(importResponse);
    })();
    return true;
  }

  if (message?.type === 'CHECK_INSTRUMENT_EXISTS') {
    checkInstrumentExists(message.payload).then(sendResponse);
    return true;
  }

  if (message?.type === 'FETCH_TRADER_INSTRUMENTS') {
    fetchTraderInstruments(message.traderId).then(sendResponse);
    return true;
  }

  if (message?.type === 'FETCH_TRADERS') {
    fetchTraders().then(sendResponse);
    return true;
  }

  if (message?.type === 'SAVE_STOP_LOSS_RULE') {
    saveStopLossRule(message.positionId, message.payload).then(sendResponse);
    return true;
  }

  if (message?.type === 'CREATE_VIRTUAL_STOP_LOSS') {
    createVirtualStopLoss(message.payload).then(sendResponse);
    return true;
  }

  if (message?.type === 'SAVE_PENDING_SELL_ORDER') {
    savePendingSellOrder(message.positionId, message.payload).then(sendResponse);
    return true;
  }

  if (message?.type === 'SAVE_PENDING_BUY_ORDER') {
    savePendingBuyOrder(message.payload).then(sendResponse);
    return true;
  }

  if (message?.type === 'SAVE_MONITORING_PLAN') {
    saveMonitoringPlan(message.payload).then(sendResponse);
    return true;
  }

  if (message?.type === 'FETCH_MONITORING_PLANS') {
    fetchMonitoringPlans(message.traderId).then(sendResponse);
    return true;
  }

  if (message?.type === 'SAVE_INSTRUMENT_PRICE_SNAPSHOT') {
    saveInstrumentPriceSnapshot(message.payload).then(sendResponse);
    return true;
  }

  if (message?.type === 'FETCH_LATEST_PRICE_SNAPSHOTS') {
    debugLog('FETCH_LATEST_PRICE_SNAPSHOTS message received', {
      traderId: message.traderId ?? null,
      tickers: Array.isArray(message.tickers) ? message.tickers : [],
    });
    fetchLatestInstrumentPriceSnapshots({
      traderId: message.traderId,
      tickers: message.tickers,
    }).then((response) => {
      debugLog('FETCH_LATEST_PRICE_SNAPSHOTS message resolved', response);
      sendResponse(response);
    });
    return true;
  }

  if (message?.type === 'GET_ACTIVE_TAB') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      sendResponse({
        ok: Boolean(tab),
        tab: tab
          ? {
              id: tab.id,
              url: tab.url,
              title: tab.title,
            }
          : null,
      });
    });
    return true;
  }

  if (message?.type === 'OPEN_FLOATING_MONITOR') {
    openFloatingMonitorWindow().then(sendResponse);
    return true;
  }

  return false;
  
});

/* --- Price monitor state used by the floating monitor UI --- */

const DEFAULT_MONITOR_TICKERS = [];

function normalizeMonitorTicker(value) {
  return String(value ?? '').trim().toUpperCase();
}

function compactWhitespace(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function parseLocaleNumber(value) {
  const text = compactWhitespace(value);
  if (!text) {
    return null;
  }

  const cleaned = text.replace(/[^\d,.-]/g, '');
  if (!cleaned) {
    return null;
  }

  const lastCommaIndex = cleaned.lastIndexOf(',');
  const lastDotIndex = cleaned.lastIndexOf('.');
  const hasComma = lastCommaIndex !== -1;
  const hasDot = lastDotIndex !== -1;

  let normalized = cleaned;

  if (hasComma && hasDot) {
    normalized =
      lastCommaIndex > lastDotIndex
        ? cleaned.replace(/\./g, '').replace(',', '.')
        : cleaned.replace(/,/g, '');
  } else if (hasComma) {
    const decimalDigits = cleaned.length - lastCommaIndex - 1;
    normalized =
      decimalDigits > 0 && decimalDigits <= 4
        ? cleaned.replace(/\./g, '').replace(',', '.')
        : cleaned.replace(/,/g, '');
  } else if (hasDot) {
    const decimalDigits = cleaned.length - lastDotIndex - 1;
    normalized = decimalDigits > 0 && decimalDigits <= 4 ? cleaned : cleaned.replace(/\./g, '');
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function decodeHtmlEntities(value) {
  return String(value ?? '')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function stripHtmlToText(html) {
  return compactWhitespace(
    decodeHtmlEntities(
      String(html ?? '')
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<[^>]+>/g, ' '),
    ),
  );
}

function extractLatestTradePrice(text) {
  const normalizedText = compactWhitespace(text);
  if (!normalizedText) {
    return null;
  }

  const latestTradesSection = normalizedText.split(/Siste handler/i)[1] ?? '';
  const candidateText = latestTradesSection || normalizedText;
  const tradeMatch = candidateText.match(
    /\d{1,2}:\d{2}:\d{2}\s+([0-9][0-9\s.,]*)\s+\d/i,
  );

  if (!tradeMatch) {
    return null;
  }

  const priceText = compactWhitespace(tradeMatch[1]);
  const price = parseLocaleNumber(priceText);

  if (!Number.isFinite(price) || price <= 0) {
    return null;
  }

  return {
    price,
    priceText,
  };
}

function buildFetchedMonitorPayload(plan, sourceUrl, priceEntry) {
  const ticker = normalizeMonitorTicker(plan?.instrument?.ticker);
  if (!ticker || !priceEntry) {
    return null;
  }

  return {
    ticker,
    name: compactWhitespace(plan?.instrument?.name) || ticker,
    market: compactWhitespace(plan?.instrument?.market) || undefined,
    currency: compactWhitespace(plan?.instrument?.currency).toUpperCase() || 'NOK',
    currentPrice: priceEntry.price,
    currentPriceText: priceEntry.priceText,
    sourceUrl,
  };
}

function buildSourceUrlCandidates(sourceUrl) {
  const normalizedSourceUrl = compactWhitespace(sourceUrl);
  if (!normalizedSourceUrl) {
    return [];
  }

  const candidates = [normalizedSourceUrl];

  try {
    const parsed = new URL(normalizedSourceUrl);
    if (parsed.searchParams.has('details')) {
      parsed.searchParams.delete('details');
      const withoutDetails = parsed.toString();
      if (!candidates.includes(withoutDetails)) {
        candidates.push(withoutDetails);
      }
    }
  } catch (_error) {
    // Ignore malformed URLs here; validation happens earlier.
  }

  return candidates;
}

async function fetchPayloadFromSourceUrl(plan) {
  const sourceUrl = typeof plan?.instrument?.sourceUrl === 'string' ? plan.instrument.sourceUrl.trim() : '';
  const ticker = normalizeMonitorTicker(plan?.instrument?.ticker);

  if (!ticker || !isSupportedNordnetUrl(sourceUrl)) {
    return {
      ok: false,
      error: 'A supported Nordnet source URL is required.',
    };
  }

  const candidateUrls = buildSourceUrlCandidates(sourceUrl);
  let lastError = 'Could not fetch the monitored Nordnet quote page.';

  for (const candidateUrl of candidateUrls) {
    try {
      const response = await fetch(candidateUrl, {
        method: 'GET',
        credentials: 'include',
        cache: 'no-store',
        redirect: 'follow',
      });

      if (!response.ok) {
        lastError = `Nordnet quote request failed (${response.status}).`;
        continue;
      }

      const html = await response.text();
      const latestTrade = extractLatestTradePrice(stripHtmlToText(html));

      if (!latestTrade) {
        lastError = 'No latest trade price was found in the Nordnet quote response.';
        continue;
      }

      const payload = buildFetchedMonitorPayload(plan, candidateUrl, latestTrade);
      if (!payload) {
        lastError = 'Fetched Nordnet quote data could not be converted into a monitor payload.';
        continue;
      }

      return {
        ok: true,
        payload,
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : 'Could not fetch the monitored Nordnet quote page.';
    }
  }

  return {
    ok: false,
    error: lastError,
  };
}

async function syncMonitorTickersFromPlans(plans) {
  const nextTickers = [...new Set(
    (Array.isArray(plans) ? plans : [])
      .map((plan) => normalizeMonitorTicker(plan?.instrument?.ticker))
      .filter(Boolean),
  )];

  await new Promise((resolve) => chrome.storage.local.set({
    monitorTickers: nextTickers.length > 0 ? nextTickers : DEFAULT_MONITOR_TICKERS,
  }, resolve));
}

async function syncFloatingMonitorStateFromPlans(plans) {
  const storage = await new Promise((resolve) => chrome.storage.local.get(['floatingMonitorState'], resolve));
  const currentState = storage?.floatingMonitorState ?? {};

  await new Promise((resolve) => chrome.storage.local.set({
    floatingMonitorState: {
      ...currentState,
      plans: Array.isArray(plans) ? plans : [],
      updatedAt: new Date().toISOString(),
    },
  }, resolve));
}

function buildStoredMonitoringPlanEntry({ instrument, monitoringPlan, sourceUrl }) {
  if (!instrument || !monitoringPlan) {
    return null;
  }

  return {
    id: String(monitoringPlan.id ?? '').trim(),
    kind: monitoringPlan.kind,
    triggerPrice: String(monitoringPlan.triggerPrice ?? '').trim(),
    triggerCondition: monitoringPlan.triggerCondition,
    isEnabled: Boolean(monitoringPlan.isEnabled ?? true),
    notes: monitoringPlan.notes ?? null,
    triggeredAt: monitoringPlan.triggeredAt ?? null,
    updatedAt: monitoringPlan.updatedAt ?? new Date().toISOString(),
    instrument: {
      id: instrument.id ?? null,
      ticker: instrument.ticker ?? '',
      name: instrument.name ?? '',
      market: instrument.market ?? null,
      currency: instrument.currency ?? '',
      sourceUrl: typeof sourceUrl === 'string' && sourceUrl.trim() ? sourceUrl.trim() : null,
    },
  };
}

async function upsertStoredMonitoringPlan(plan, options = {}) {
  if (!plan?.id) {
    return;
  }

  const storage = await new Promise((resolve) => chrome.storage.local.get(['floatingMonitorState'], resolve));
  const currentState = storage?.floatingMonitorState ?? {};
  const currentPlans = Array.isArray(currentState?.plans) ? currentState.plans : [];
  const nextPlans = [
    plan,
    ...currentPlans.filter((entry) => String(entry?.id ?? '').trim() !== plan.id),
  ];

  await syncMonitorTickersFromPlans(nextPlans);
  await new Promise((resolve) => chrome.storage.local.set({
    floatingMonitorState: {
      ...currentState,
      plans: nextPlans,
      currentTicker: normalizeMonitorTicker(options?.currentTicker ?? currentState?.currentTicker),
      updatedAt: new Date().toISOString(),
    },
  }, resolve));
}

async function readStoredMonitorPlans() {
  const storage = await new Promise((resolve) => chrome.storage.local.get(['floatingMonitorState'], resolve));
  const currentState = storage?.floatingMonitorState ?? {};
  return Array.isArray(currentState?.plans) ? currentState.plans : [];
}

function isSupportedNordnetUrl(url) {
  return (
    typeof url === 'string' &&
    (
      /^https:\/\/www\.nordnet\.no\/aksjer\/kurser\/.+/i.test(url) ||
      /^https:\/\/www\.nordnet\.no\/etp\/sertifikat\/[^/]+\/liste\/.+/i.test(url)
    )
  );
}

async function ensureContentScriptForTab(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['assets/js/nordnet-stock.js'],
  });
}

async function requestTabStockPayload(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: 'GET_STOCK_PAYLOAD' }, (payloadResponse) => {
      if (chrome.runtime.lastError) {
        const rawMessage = chrome.runtime.lastError.message ?? '';
        resolve({
          ok: false,
          error: rawMessage || 'Could not read instrument data from the page.',
          needsInjection: /Receiving end does not exist/i.test(rawMessage),
        });
        return;
      }

      resolve(payloadResponse ?? { ok: false, error: 'Could not read instrument data from the page.' });
    });
  });
}

async function loadTabStockPayload(tabId) {
  let payloadResponse = await requestTabStockPayload(tabId);

  if (!payloadResponse?.ok && payloadResponse?.needsInjection) {
    await ensureContentScriptForTab(tabId);
    payloadResponse = await requestTabStockPayload(tabId);
  }

  return payloadResponse;
}

async function publishCurrentStockPriceUpdate(stockPayload, source = 'nordnet-background') {
  const ticker = normalizeMonitorTicker(stockPayload?.ticker);
  const price = Number(stockPayload?.currentPrice);

  if (!ticker || !Number.isFinite(price) || price <= 0) {
    return false;
  }

  const fetchedAt = new Date().toISOString();
  const updatePayload = {
    [ticker]: {
      ok: true,
      price,
      error: null,
      fetchedAt,
      source,
    },
  };

  const storage = await new Promise((resolve) => chrome.storage.local.get(['extensionPrices'], resolve));

  await new Promise((resolve) => chrome.storage.local.set({
    extensionPrices: {
      ...(storage?.extensionPrices ?? {}),
      ...updatePayload,
    },
    extensionPricesUpdatedAt: fetchedAt,
  }, resolve));

  try {
    chrome.runtime.sendMessage({
      type: 'PRICE_UPDATE',
      payload: updatePayload,
    });
  } catch (_error) {
    // Non-fatal if no listener is active.
  }

  return true;
}

async function refreshOpenNordnetTabs() {
  const tabs = await chrome.tabs.query({ url: NORDNET_TAB_PATTERNS });
  const supportedTabs = tabs.filter((tab) => tab?.id && isSupportedNordnetUrl(tab.url));
  const refreshedTickers = new Set();

  debugLog('Background Nordnet tab refresh start', {
    tabCount: supportedTabs.length,
  });

  for (const tab of supportedTabs) {
    try {
      const payloadResponse = await loadTabStockPayload(tab.id);

      if (!payloadResponse?.ok || !payloadResponse?.payload) {
        debugLog('Background tab payload unavailable', {
          tabId: tab.id,
          url: tab.url,
          error: payloadResponse?.error ?? 'Unknown payload error',
        });
        continue;
      }

      const payload = payloadResponse.payload;
      await publishCurrentStockPriceUpdate(payload);
      const ticker = normalizeMonitorTicker(payload?.ticker);
      if (ticker) {
        refreshedTickers.add(ticker);
      }
    } catch (error) {
      debugLog('Background tab refresh failed', {
        tabId: tab?.id ?? null,
        url: tab?.url ?? null,
        error: error instanceof Error ? error.message : error,
      });
    }
  }

  return refreshedTickers;
}

async function refreshInstrumentFromSourceUrl(plan, refreshedTickers) {
  const ticker = normalizeMonitorTicker(plan?.instrument?.ticker);
  const sourceUrl = typeof plan?.instrument?.sourceUrl === 'string' ? plan.instrument.sourceUrl.trim() : '';

  if (!ticker || refreshedTickers.has(ticker) || !isSupportedNordnetUrl(sourceUrl)) {
    return false;
  }

  try {
    const payloadResponse = await fetchPayloadFromSourceUrl(plan);
    if (!payloadResponse?.ok || !payloadResponse?.payload) {
      throw new Error(payloadResponse?.error ?? 'Could not read instrument data from the Nordnet quote response.');
    }

    const payload = payloadResponse.payload;
    await publishCurrentStockPriceUpdate(payload, 'nordnet-background-source-fetch');

    refreshedTickers.add(ticker);
    return true;
  } catch (error) {
    debugLog('Background source-url refresh failed', {
      ticker,
      sourceUrl,
      error: error instanceof Error ? error.message : error,
    });
    return false;
  }
}

async function refreshMonitoredSourceUrls(plans, refreshedTickers) {
  const uniquePlansByTicker = new Map();

  for (const plan of Array.isArray(plans) ? plans : []) {
    const ticker = normalizeMonitorTicker(plan?.instrument?.ticker);
    if (!ticker || uniquePlansByTicker.has(ticker)) {
      continue;
    }

    uniquePlansByTicker.set(ticker, plan);
  }

  for (const plan of uniquePlansByTicker.values()) {
    await refreshInstrumentFromSourceUrl(plan, refreshedTickers);
  }
}

async function runBackgroundPriceRefresh() {
  try {
    const plans = await readStoredMonitorPlans();
    const refreshedTickers = await refreshOpenNordnetTabs();
    await refreshMonitoredSourceUrls(plans, refreshedTickers);
    await fetchPricesAndPublish();
  } catch (error) {
    debugLog('Background price refresh failed', {
      error: error instanceof Error ? error.message : error,
    });
  }
}

function scheduleBackgroundPriceRefreshAlarm() {
  chrome.alarms.create(BACKGROUND_PRICE_REFRESH_ALARM, {
    periodInMinutes: BACKGROUND_PRICE_REFRESH_PERIOD_MINUTES,
  });
}

async function fetchPricesAndPublish() {
  try {
    const storage = await new Promise((resolve) => chrome.storage.local.get(['extensionPrices'], resolve));
    const prices = storage?.extensionPrices ?? {};

    try {
      chrome.runtime.sendMessage({ type: 'PRICE_UPDATE', payload: prices });
    } catch (e) {
      debugLog('PRICE_UPDATE sendMessage failed', e);
    }
  } catch (err) {
    debugLog('fetchPricesAndPublish error', err instanceof Error ? err.message : err);
  }
}

async function readExtensionPrices() {
  const storage = await new Promise((resolve) => chrome.storage.local.get(['extensionPrices', 'extensionPricesUpdatedAt'], resolve));

  return {
    prices: storage?.extensionPrices ?? {},
    updatedAt: storage?.extensionPricesUpdatedAt ?? null,
  };
}

chrome.runtime.onInstalled.addListener((details) => {
  debugLog('onInstalled', details);
  scheduleBackgroundPriceRefreshAlarm();
  fetchPricesAndPublish();
  void runBackgroundPriceRefresh();
});

chrome.runtime.onStartup.addListener(() => {
  scheduleBackgroundPriceRefreshAlarm();
  void runBackgroundPriceRefresh();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm?.name !== BACKGROUND_PRICE_REFRESH_ALARM) {
    return;
  }

  void runBackgroundPriceRefresh();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'REFRESH_PRICES') {
    runBackgroundPriceRefresh()
      .then(async () => {
        const latestPrices = await readExtensionPrices();
        sendResponse({
          ok: true,
          data: latestPrices,
        });
      })
      .catch(async (error) => {
        const latestPrices = await readExtensionPrices();
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : 'Failed to refresh prices.',
          data: latestPrices,
        });
      });
    return true;
  }
});
