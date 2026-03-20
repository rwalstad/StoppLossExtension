const APP_BASE_URL = 'https://trading.just4us.no';
const DASHBOARD_URL = `${APP_BASE_URL}/dashboard`;
const DASHBOARD_FALLBACK_URL = `${APP_BASE_URL}/`;
const IMPORT_URL = `${APP_BASE_URL}/api/extension/instruments`;
const TRADERS_URL = `${APP_BASE_URL}/api/extension/traders`;
const VIRTUAL_STOP_LOSS_URL = `${APP_BASE_URL}/api/extension/virtual-stop-loss`;
const EXTENSION_STOP_LOSS_URL = `${APP_BASE_URL}/api/extension/positions`;
const MONITORING_PLAN_URL = `${APP_BASE_URL}/api/extension/monitoring-plan`;
const PRICE_SNAPSHOT_URL = `${APP_BASE_URL}/api/extension/price-snapshot`;
const EXTENSION_SELL_ORDER_URL = `${APP_BASE_URL}/api/extension/positions`;
const SELECTED_TRADER_STORAGE_KEY = 'stoploss-selected-trader-id';
const SELECTED_TRADER_NAME_STORAGE_KEY = 'stoploss-selected-trader-name';
const BACKGROUND_PRICE_REFRESH_ALARM = 'background-price-refresh';
const BACKGROUND_PRICE_REFRESH_PERIOD_MINUTES = 1;
const NORDNET_TAB_PATTERNS = [
  'https://www.nordnet.no/aksjer/kurser/*',
  'https://www.nordnet.no/etp/sertifikat/*/liste/*',
];

// Exchange trading hours — keyed by MIC code and common display name aliases (lowercase)
const EXCHANGE_TRADING_HOURS = {
  XOSL: { timezone: 'Europe/Oslo',        open: '09:00', close: '16:25' },
  XSTO: { timezone: 'Europe/Stockholm',   open: '09:00', close: '17:30' },
  XCSE: { timezone: 'Europe/Copenhagen',  open: '09:00', close: '17:00' },
  XHEL: { timezone: 'Europe/Helsinki',    open: '09:00', close: '18:30' },
  XICE: { timezone: 'Atlantic/Reykjavik', open: '09:30', close: '15:30' },
  XETR: { timezone: 'Europe/Berlin',      open: '09:00', close: '17:30' },
  XETA: { timezone: 'Europe/Berlin',      open: '09:00', close: '17:30' },
  XNYS: { timezone: 'America/New_York',   open: '09:30', close: '16:00' },
  XNAS: { timezone: 'America/New_York',   open: '09:30', close: '16:00' },
  XLON: { timezone: 'Europe/London',      open: '08:00', close: '16:30' },
  XPAR: { timezone: 'Europe/Paris',       open: '09:00', close: '17:30' },
  XAMS: { timezone: 'Europe/Amsterdam',   open: '09:00', close: '17:30' },
  // Display name aliases
  'xetra':               { timezone: 'Europe/Berlin',      open: '09:00', close: '17:30' },
  'oslo børs':           { timezone: 'Europe/Oslo',        open: '09:00', close: '16:25' },
  'oslo stock exchange': { timezone: 'Europe/Oslo',        open: '09:00', close: '16:25' },
  'nasdaq':              { timezone: 'America/New_York',   open: '09:30', close: '16:00' },
  'nyse':                { timezone: 'America/New_York',   open: '09:30', close: '16:00' },
  'lse':                 { timezone: 'Europe/London',      open: '08:00', close: '16:30' },
  'london stock exchange': { timezone: 'Europe/London',   open: '08:00', close: '16:30' },
};

function isInstrumentTradingNow(instrument) {
  const hours =
    EXCHANGE_TRADING_HOURS[instrument?.marketCode] ??
    EXCHANGE_TRADING_HOURS[instrument?.exchangeName?.toLowerCase()] ??
    EXCHANGE_TRADING_HOURS[instrument?.market?.toLowerCase()] ??
    null;

  if (!hours) return true; // Unknown exchange — always allow monitoring

  const now = new Date();
  const local = new Date(now.toLocaleString('en-US', { timeZone: hours.timezone }));
  const day = local.getDay(); // 0 = Sun, 6 = Sat
  if (day === 0 || day === 6) return false;

  const currentMinutes = local.getHours() * 60 + local.getMinutes();
  const [openH, openM] = hours.open.split(':').map(Number);
  const [closeH, closeM] = hours.close.split(':').map(Number);
  return currentMinutes >= openH * 60 + openM && currentMinutes <= closeH * 60 + closeM;
}

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

async function syncSelectedTraderSelection(selection = {}) {
  const storage = await new Promise((resolve) => {
    chrome.storage.local.get([
      SELECTED_TRADER_STORAGE_KEY,
      SELECTED_TRADER_NAME_STORAGE_KEY,
      'floatingMonitorState',
    ], resolve);
  });
  const currentState = storage?.floatingMonitorState ?? {};
  const nextTraderId = String(selection?.traderId ?? storage?.[SELECTED_TRADER_STORAGE_KEY] ?? '').trim();
  const requestedTraderName = String(selection?.traderName ?? '').trim();
  const nextTraderName = requestedTraderName || String(storage?.[SELECTED_TRADER_NAME_STORAGE_KEY] ?? currentState?.currentTraderName ?? '').trim();

  await new Promise((resolve) => chrome.storage.local.set({
    [SELECTED_TRADER_STORAGE_KEY]: nextTraderId,
    [SELECTED_TRADER_NAME_STORAGE_KEY]: nextTraderName,
    floatingMonitorState: {
      ...currentState,
      currentTraderId: nextTraderId,
      currentTraderName: nextTraderName,
    },
  }, resolve));
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
  const response = await fetch(`${EXTENSION_STOP_LOSS_URL}/${encodeURIComponent(String(positionId))}/stop-loss`, {
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
  const response = await fetch(`${EXTENSION_SELL_ORDER_URL}/${encodeURIComponent(String(positionId))}/sell-order`, {
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

  if (responsePayload?.monitoringPlan && responsePayload?.instrument) {
    await upsertStoredMonitoringPlan(
      buildStoredMonitoringPlanEntry({
        instrument: responsePayload.instrument,
        monitoringPlan: responsePayload.monitoringPlan,
        pendingOrder: responsePayload.order,
      }),
      {
        currentTicker: responsePayload.instrument?.ticker ?? '',
      },
    );
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
        pendingOrder: responsePayload.order,
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
        pendingOrder: responsePayload.order,
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

async function rearmSavedOrder(orderId) {
  const traderId = await getStoredSelectedTraderId();
  if (!orderId || !traderId) {
    return {
      ok: false,
      error: 'Trader selection is required to refresh the saved order state.',
    };
  }

  const response = await fetch(`${APP_BASE_URL}/api/orders/${encodeURIComponent(String(orderId))}`, {
    method: 'PATCH',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      traderId,
      status: 'PENDING',
    }),
  });

  const responsePayload = await response.json().catch(() => ({}));
  if (!response.ok) {
    return {
      ok: false,
      error: responsePayload?.error ?? 'Failed to refresh the saved order state.',
    };
  }

  return {
    ok: true,
    data: responsePayload,
  };
}

async function markSavedOrderFilled(orderId, payload = {}) {
  const traderId = await getStoredSelectedTraderId();
  if (!orderId || !traderId) {
    return {
      ok: false,
      error: 'Trader selection is required to mark the saved order as filled.',
    };
  }

  const response = await fetch(`${APP_BASE_URL}/api/orders/${encodeURIComponent(String(orderId))}`, {
    method: 'PATCH',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      traderId,
      status: 'FILLED',
      executedPrice: payload.executedPrice,
      executedQuantity: payload.executedQuantity,
      executedAt: payload.executedAt,
      fee: payload.fee,
    }),
  });

  const responsePayload = await response.json().catch(() => ({}));
  if (!response.ok) {
    return {
      ok: false,
      error: responsePayload?.error ?? 'Failed to mark the saved order as filled.',
    };
  }

  return {
    ok: true,
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
    const requestedTraderId = traderId ?? await getStoredSelectedTraderId();

    async function requestPlans(candidateTraderId) {
      const url = new URL(MONITORING_PLAN_URL);

      if (candidateTraderId !== undefined && candidateTraderId !== null && candidateTraderId !== '') {
        url.searchParams.set('traderId', String(candidateTraderId));
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

      return {
        response,
        payload: responsePayload,
        requestedTraderId: candidateTraderId ?? null,
      };
    }

    let result = await requestPlans(requestedTraderId);
    const requestedPlans = Array.isArray(result?.payload?.plans) ? result.payload.plans : [];
    const shouldRetryWithoutTrader =
      result.response.ok &&
      requestedPlans.length === 0 &&
      requestedTraderId !== undefined &&
      requestedTraderId !== null &&
      requestedTraderId !== '';

    if (shouldRetryWithoutTrader) {
      const fallbackResult = await requestPlans(null);
      const fallbackPlans = Array.isArray(fallbackResult?.payload?.plans) ? fallbackResult.payload.plans : [];

      if (fallbackResult.response.ok && fallbackPlans.length > 0) {
        debugLog('Fetch monitoring plans fallback used', {
          staleTraderId: requestedTraderId,
          recoveredPlanCount: fallbackPlans.length,
          trader: fallbackResult.payload?.trader ?? null,
        });
        result = fallbackResult;
      }
    }

    if (!result.response.ok) {
      return {
        ok: false,
        status: result.response.status,
        error: result.payload?.error ?? result.payload?.message ?? 'Failed to load monitoring plans.',
      };
    }

    const resolvedTraderId = String(
      result.payload?.trader?.id ??
      result.requestedTraderId ??
      requestedTraderId ??
      '',
    ).trim();
    const resolvedTraderName = String(result.payload?.trader?.name ?? '').trim();

    await syncSelectedTraderSelection({
      traderId: resolvedTraderId,
      traderName: resolvedTraderName,
    });
    await syncMonitorTickersFromPlans(result.payload?.plans);
    await syncFloatingMonitorStateFromPlans(result.payload?.plans, {
      traderId: resolvedTraderId,
      traderName: resolvedTraderName,
    });

    return {
      ok: true,
      status: result.response.status,
      data: result.payload,
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

async function waitForTabComplete(tabId, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(handleUpdated);
      reject(new Error('Timed out waiting for the Nordnet order page to load.'));
    }, timeoutMs);

    const handleUpdated = (updatedTabId, changeInfo) => {
      if (updatedTabId !== tabId || changeInfo.status !== 'complete') {
        return;
      }

      clearTimeout(timeoutId);
      chrome.tabs.onUpdated.removeListener(handleUpdated);
      resolve();
    };

    chrome.tabs.onUpdated.addListener(handleUpdated);
  });
}

function buildOrderTicketUrl(plan) {
  const sourceUrl = compactWhitespace(plan?.instrument?.sourceUrl);
  const side = String(plan?.pendingOrder?.side ?? '').trim().toLowerCase();

  if (!sourceUrl || (side !== 'buy' && side !== 'sell')) {
    return null;
  }

  try {
    const url = new URL(sourceUrl);
    url.search = '';
    url.hash = '';
    url.pathname = url.pathname
      .replace(/\/order\/(?:buy|sell)(?:\/.*)?$/i, '')
      .replace(/\/$/, '') + `/order/${side}`;
    return url.toString();
  } catch (_error) {
    return null;
  }
}

async function openOrderTicketTab(orderUrl) {
  const activeTabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const activeTab = activeTabs[0];

  const openedTab = await new Promise((resolve) => {
    if (activeTab?.id && isSupportedNordnetUrl(activeTab.url)) {
      chrome.tabs.update(activeTab.id, { url: orderUrl, active: true }, resolve);
      return;
    }

    chrome.tabs.create({ url: orderUrl, active: true }, resolve);
  });

  if (!openedTab?.id) {
    throw new Error('Could not open the Nordnet order ticket.');
  }

  await waitForTabComplete(openedTab.id);
  return openedTab.id;
}

async function sendMessageToTab(tabId, message) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        resolve({
          ok: false,
          error: chrome.runtime.lastError.message ?? 'Could not reach the Nordnet tab.',
          needsInjection: /Receiving end does not exist/i.test(chrome.runtime.lastError.message ?? ''),
        });
        return;
      }

      resolve(response ?? { ok: false, error: 'Could not reach the Nordnet tab.' });
    });
  });
}

async function executeSavedOrderInTab(tabId, plan) {
  let response = await sendMessageToTab(tabId, {
    type: 'EXECUTE_SAVED_ORDER',
    plan,
  });

  if (!response?.ok && response?.needsInjection) {
    await ensureContentScriptForTab(tabId);
    response = await sendMessageToTab(tabId, {
      type: 'EXECUTE_SAVED_ORDER',
      plan,
    });
  }

  return response;
}

async function placeMonitoredOrder(plan) {
  const orderUrl = buildOrderTicketUrl(plan);
  const savedOrder = plan?.pendingOrder;

  if (!orderUrl || !savedOrder?.side) {
    return {
      ok: false,
      error: 'The monitored plan does not include a saved Nordnet order.',
    };
  }

  const tabId = await openOrderTicketTab(orderUrl);
  const response = await executeSavedOrderInTab(tabId, plan);

  if (!response?.ok) {
    return {
      ok: false,
      error: response?.error ?? 'Failed to submit the saved Nordnet order.',
    };
  }

  const rearmResponse = savedOrder?.id ? await rearmSavedOrder(savedOrder.id) : null;
  if (rearmResponse && !rearmResponse.ok) {
    return {
      ok: false,
      error: rearmResponse.error,
    };
  }

  return {
    ok: true,
    tabId,
    message:
      response?.message ??
      `${savedOrder.status === 'CANCELLED' ? 'Replaced' : 'Submitted'} the saved ${String(savedOrder.side).toLowerCase()} order on Nordnet.`,
  };
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

  if (message?.type === 'PLACE_MONITORED_ORDER') {
    placeMonitoredOrder(message.plan).then(sendResponse);
    return true;
  }

  if (message?.type === 'MARK_MONITORED_ORDER_FILLED') {
    markSavedOrderFilled(message.orderId, message.payload).then(sendResponse);
    return true;
  }

  return false;
  
});

/* --- Price monitor state used by the floating monitor UI --- */

const DEFAULT_MONITOR_TICKERS = [];
const BACKGROUND_TAB_PAYLOAD_RETRY_COUNT = 10;
const BACKGROUND_TAB_PAYLOAD_RETRY_DELAY_MS = 750;
const lastReportedBackgroundSnapshotByTicker = new Map();

function normalizeMonitorTicker(value) {
  return String(value ?? '').trim().toUpperCase();
}

function compactWhitespace(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

  const candidates = [];

  try {
    const parsed = new URL(normalizedSourceUrl);

    const withDetails = new URL(parsed.toString());
    withDetails.search = '?details';
    const withDetailsUrl = withDetails.toString();
    if (!candidates.includes(withDetailsUrl)) {
      candidates.push(withDetailsUrl);
    }

    parsed.search = '';
    parsed.hash = '';
    const withoutDetails = parsed.toString();
    if (!candidates.includes(withoutDetails)) {
      candidates.push(withoutDetails);
    }

    if (!candidates.includes(normalizedSourceUrl)) {
      candidates.push(normalizedSourceUrl);
    }
  } catch (_error) {
    candidates.push(normalizedSourceUrl);
  }

  return candidates;
}

async function openBackgroundQuoteTab(sourceUrl) {
  const openedTab = await new Promise((resolve) => {
    chrome.tabs.create(
      {
        url: sourceUrl,
        active: false,
      },
      resolve,
    );
  });

  if (!openedTab?.id) {
    throw new Error('Could not open the Nordnet quote page in a background tab.');
  }

  await waitForTabComplete(openedTab.id);
  return openedTab.id;
}

async function removeTabQuietly(tabId) {
  if (!tabId) {
    return;
  }

  try {
    await chrome.tabs.remove(tabId);
  } catch (_error) {
    // Ignore cleanup errors if the temporary tab was already closed.
  }
}

async function fetchPayloadFromBackgroundTab(plan, candidateUrl) {
  let tabId = null;

  try {
    tabId = await openBackgroundQuoteTab(candidateUrl);
    const payloadResponse = await loadTabStockPayload(tabId, {
      retryCount: BACKGROUND_TAB_PAYLOAD_RETRY_COUNT,
      retryDelayMs: BACKGROUND_TAB_PAYLOAD_RETRY_DELAY_MS,
    });

    if (!payloadResponse?.ok || !payloadResponse?.payload) {
      throw new Error(payloadResponse?.error ?? 'Could not read instrument data from the Nordnet quote tab.');
    }

    return {
      ok: true,
      payload: {
        ...payloadResponse.payload,
        sourceUrl: candidateUrl,
      },
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Could not read instrument data from the Nordnet quote tab.',
    };
  } finally {
    await removeTabQuietly(tabId);
  }
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
        const tabPayloadResponse = await fetchPayloadFromBackgroundTab(plan, candidateUrl);
        if (tabPayloadResponse?.ok && tabPayloadResponse?.payload) {
          debugLog('Background quote tab fallback succeeded', {
            ticker,
            sourceUrl: candidateUrl,
          });
          return tabPayloadResponse;
        }

        lastError =
          tabPayloadResponse?.error ??
          'No latest trade price was found in the Nordnet quote response.';
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

async function syncFloatingMonitorStateFromPlans(plans, options = {}) {
  const storage = await new Promise((resolve) => chrome.storage.local.get(['floatingMonitorState'], resolve));
  const currentState = storage?.floatingMonitorState ?? {};

  await new Promise((resolve) => chrome.storage.local.set({
    floatingMonitorState: {
      ...currentState,
      plans: Array.isArray(plans) ? plans : [],
      currentTraderId: String(options?.traderId ?? currentState?.currentTraderId ?? '').trim(),
      currentTraderName: String(options?.traderName ?? '').trim() || String(currentState?.currentTraderName ?? '').trim(),
      updatedAt: new Date().toISOString(),
    },
  }, resolve));
}

function buildStoredMonitoringPlanEntry({ instrument, monitoringPlan, sourceUrl, pendingOrder }) {
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
    pendingOrder: pendingOrder
      ? {
          id: String(pendingOrder.id ?? '').trim(),
          side: pendingOrder.side ?? '',
          status: pendingOrder.status ?? 'PENDING',
          quantity: String(pendingOrder.quantity ?? '').trim(),
          price: String(pendingOrder.price ?? '').trim(),
          currency: pendingOrder.currency ?? instrument.currency ?? '',
          placedAt: pendingOrder.placedAt ?? new Date().toISOString(),
        }
      : monitoringPlan.pendingOrder ?? null,
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

function hasUsableStockPayload(payloadResponse) {
  const price = Number(payloadResponse?.payload?.currentPrice);
  return Boolean(payloadResponse?.ok && payloadResponse?.payload && Number.isFinite(price) && price > 0);
}

async function loadTabStockPayload(tabId, options = {}) {
  let payloadResponse = await requestTabStockPayload(tabId);

  if (!payloadResponse?.ok && payloadResponse?.needsInjection) {
    await ensureContentScriptForTab(tabId);
    payloadResponse = await requestTabStockPayload(tabId);
  }

  const retryCount = Number.isInteger(options?.retryCount) ? options.retryCount : BACKGROUND_TAB_PAYLOAD_RETRY_COUNT;
  const retryDelayMs =
    Number.isInteger(options?.retryDelayMs) && Number(options.retryDelayMs) >= 0
      ? Number(options.retryDelayMs)
      : BACKGROUND_TAB_PAYLOAD_RETRY_DELAY_MS;

  for (let attempt = 0; attempt < retryCount; attempt += 1) {
    if (hasUsableStockPayload(payloadResponse)) {
      return payloadResponse;
    }

    await delay(retryDelayMs);
    payloadResponse = await requestTabStockPayload(tabId);

    if (!payloadResponse?.ok && payloadResponse?.needsInjection) {
      await ensureContentScriptForTab(tabId);
      payloadResponse = await requestTabStockPayload(tabId);
    }
  }

  return payloadResponse;
}

function buildBackgroundPriceSnapshotKey(payload) {
  const ticker = normalizeMonitorTicker(payload?.ticker);
  const isin = compactWhitespace(payload?.isin).toUpperCase();
  const market = compactWhitespace(payload?.marketCode ?? payload?.market).toUpperCase();
  const currentPrice = Number(payload?.currentPrice);
  const currentPriceText = compactWhitespace(payload?.currentPriceText);

  if (!ticker || !Number.isFinite(currentPrice) || currentPrice <= 0) {
    return '';
  }

  return [ticker, isin, market, currentPrice.toFixed(4), currentPriceText].join('|');
}

async function persistBackgroundPriceSnapshot(stockPayload, source) {
  const ticker = normalizeMonitorTicker(stockPayload?.ticker);
  const snapshotKey = buildBackgroundPriceSnapshotKey(stockPayload);

  if (!ticker || !snapshotKey || lastReportedBackgroundSnapshotByTicker.get(ticker) === snapshotKey) {
    return false;
  }

  const response = await saveInstrumentPriceSnapshot({
    ...stockPayload,
    source,
  });

  if (!response?.ok || !response?.data?.saved) {
    debugLog('Background price snapshot not saved', {
      ticker,
      snapshotKey,
      response,
    });
    return false;
  }

  lastReportedBackgroundSnapshotByTicker.set(ticker, snapshotKey);
  debugLog('Background price snapshot saved', {
    ticker,
    snapshotKey,
    savedAt: response.data?.snapshot?.capturedAt ?? null,
  });
  return true;
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
    await persistBackgroundPriceSnapshot(stockPayload, source);
  } catch (error) {
    debugLog('Background price snapshot persist failed', {
      ticker,
      source,
      error: error instanceof Error ? error.message : error,
    });
  }

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

function toMonitorTimestamp(value) {
  const timestamp = value ? new Date(value).getTime() : Number.NaN;
  return Number.isFinite(timestamp) ? timestamp : 0;
}

async function syncStoredPricesFromServerSnapshots(plans) {
  const tickers = [...new Set(
    (Array.isArray(plans) ? plans : [])
      .map((plan) => normalizeMonitorTicker(plan?.instrument?.ticker))
      .filter(Boolean),
  )];

  if (tickers.length === 0) {
    return {
      ok: true,
      tickers: [],
      updatedAt: null,
    };
  }

  const response = await fetchLatestInstrumentPriceSnapshots({ tickers });
  if (!response?.ok) {
    debugLog('Background server snapshot sync skipped', response?.error ?? 'Unknown error');
    return {
      ok: false,
      tickers: [],
      updatedAt: null,
      error: response?.error ?? null,
    };
  }

  const storage = await new Promise((resolve) => chrome.storage.local.get(['extensionPrices', 'extensionPricesUpdatedAt'], resolve));
  const currentPrices = storage?.extensionPrices ?? {};
  const nextPrices = { ...currentPrices };
  let newestFetchedAt = storage?.extensionPricesUpdatedAt ?? null;
  const syncedTickers = [];

  for (const entry of Array.isArray(response?.data?.prices) ? response.data.prices : []) {
    const ticker = normalizeMonitorTicker(entry?.ticker);
    const marketPrice = Number(entry?.snapshot?.marketPrice);
    const fetchedAt = entry?.snapshot?.capturedAt ?? null;

    if (!ticker || !Number.isFinite(marketPrice)) {
      continue;
    }

    const currentEntry = nextPrices[ticker];
    if (toMonitorTimestamp(fetchedAt) < toMonitorTimestamp(currentEntry?.fetchedAt)) {
      continue;
    }

    nextPrices[ticker] = {
      ok: true,
      price: marketPrice,
      error: null,
      fetchedAt,
      source: 'stocktrade-server',
    };
    syncedTickers.push(ticker);

    if (toMonitorTimestamp(fetchedAt) > toMonitorTimestamp(newestFetchedAt)) {
      newestFetchedAt = fetchedAt;
    }
  }

  await new Promise((resolve) => chrome.storage.local.set({
    extensionPrices: nextPrices,
    extensionPricesUpdatedAt: newestFetchedAt,
  }, resolve));

  return {
    ok: true,
    tickers: syncedTickers,
    updatedAt: newestFetchedAt,
  };
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
    if (!isInstrumentTradingNow(plan?.instrument)) {
      debugLog('Skipping refresh — market closed', { ticker: plan?.instrument?.ticker });
      continue;
    }
    await refreshInstrumentFromSourceUrl(plan, refreshedTickers);
  }
}

async function runBackgroundPriceRefresh() {
  try {
    const plans = await readStoredMonitorPlans();
    const refreshedTickers = await refreshOpenNordnetTabs();
    await refreshMonitoredSourceUrls(plans, refreshedTickers);
    await syncStoredPricesFromServerSnapshots(plans);
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




