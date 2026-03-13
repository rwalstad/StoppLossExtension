const dashboardStatus = document.getElementById('dashboardStatus');
const activeTab = document.getElementById('activeTab');
const actionStatus = document.getElementById('actionStatus');
const extensionVersion = document.getElementById('extensionVersion');
const importButton = document.getElementById('importButton');
const resetButton = document.getElementById('resetButton');
const existingInstrumentPanel = document.getElementById('existingInstrumentPanel');
const existingInstrumentTitle = document.getElementById('existingInstrumentTitle');
const existingInstrumentDetails = document.getElementById('existingInstrumentDetails');
const activeMonitorList = document.getElementById('activeMonitorList');
const activeMonitorEmpty = document.getElementById('activeMonitorEmpty');
const floatingMonitorButton = document.createElement('button');

let dashboardReady = false;
let stockTabReady = false;
let currentStockPayload = null;
let currentInstrumentExists = false;
let latestMonitoringPlans = [];
let latestMonitorTicker = '';
let activeTabRefreshToken = 0;

if (extensionVersion) {
  extensionVersion.textContent = chrome.runtime.getManifest().version;
}

floatingMonitorButton.type = 'button';
floatingMonitorButton.className = 'secondary';
floatingMonitorButton.textContent = 'Open floating monitor window';
floatingMonitorButton.hidden = true;
activeMonitorEmpty.insertAdjacentElement('afterend', floatingMonitorButton);

function isExtensionContextInvalidatedMessage(message) {
  return /Extension context invalidated/i.test(message ?? '');
}

function toDisplayError(error, fallbackMessage) {
  const message =
    typeof error === 'string'
      ? error
      : error instanceof Error
        ? error.message
        : fallbackMessage;

  if (isExtensionContextInvalidatedMessage(message)) {
    return 'The extension was reloaded while this popup was open. Close and reopen the popup, then reload the Nordnet tab if the page helper does not recover.';
  }

  return message || fallbackMessage;
}

function setStatus(element, type, text) {
  element.className = `status ${type}`;
  element.textContent = text;
}

function updateImportButton() {
  importButton.disabled = !(dashboardReady && stockTabReady);
  importButton.textContent = currentInstrumentExists ? 'Update current stock' : 'Import current stock';
}

function normalizeTickerValue(value) {
  return String(value ?? '').trim().toUpperCase();
}

function compactTickerValue(value) {
  return normalizeTickerValue(value).replace(/[^A-Z0-9]/g, '');
}

function tickersMatch(left, right) {
  const normalizedLeft = normalizeTickerValue(left);
  const normalizedRight = normalizeTickerValue(right);

  if (!normalizedLeft || !normalizedRight) {
    return false;
  }

  if (normalizedLeft === normalizedRight) {
    return true;
  }

  const compactLeft = compactTickerValue(normalizedLeft);
  const compactRight = compactTickerValue(normalizedRight);

  return compactLeft === compactRight || compactLeft.includes(compactRight) || compactRight.includes(compactLeft);
}

function updateFloatingMonitorButton() {
  floatingMonitorButton.hidden = latestMonitoringPlans.length === 0;
}

async function publishCurrentStockPriceUpdate(stockPayload) {
  const ticker = normalizeTickerValue(stockPayload?.ticker);
  const price = Number(stockPayload?.currentPrice);

  if (!ticker || !Number.isFinite(price) || price <= 0) {
    return;
  }

  const fetchedAt = new Date().toISOString();
  const updatePayload = {
    [ticker]: {
      ok: true,
      price,
      error: null,
      fetchedAt,
      source: 'nordnet-active-tab',
    },
  };
  const storage = await chrome.storage.local.get(['extensionPrices']);

  await chrome.storage.local.set({
    extensionPrices: {
      ...(storage?.extensionPrices ?? {}),
      ...updatePayload,
    },
    extensionPricesUpdatedAt: fetchedAt,
  });

  try {
    chrome.runtime.sendMessage({
      type: 'PRICE_UPDATE',
      payload: updatePayload,
    });
  } catch (_error) {
    // Non-fatal if no listener is active.
  }

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'SAVE_INSTRUMENT_PRICE_SNAPSHOT',
      payload: stockPayload,
    });

    if (response?.ok && response?.data?.saved) {
      console.info('[StopLossExtension popup] price-snapshot/route succeeded', {
        ticker: response.data.instrument?.ticker ?? ticker,
        snapshotId: response.data.snapshot?.id ?? null,
        capturedAt: response.data.snapshot?.capturedAt ?? fetchedAt,
        marketPrice: response.data.snapshot?.priceText ?? stockPayload?.currentPriceText ?? price,
      });
    } else {
      console.warn('[StopLossExtension popup] price-snapshot/route did not save a snapshot', {
        ticker,
        response,
      });
    }
  } catch (_error) {
    console.warn('[StopLossExtension popup] price-snapshot/route failed', {
      ticker,
      price,
    });
  }
}

async function openFloatingMonitorWindow() {
  if (latestMonitoringPlans.length === 0) {
    setStatus(actionStatus, 'error', 'No active monitors available to show.');
    return;
  }

  await chrome.storage.local.set({
    floatingMonitorState: {
      plans: latestMonitoringPlans,
      currentTicker: latestMonitorTicker,
      updatedAt: new Date().toISOString(),
    },
  });

  const monitorUrl = chrome.runtime.getURL('monitor.html');
  const monitorWindow = window.open(
    monitorUrl,
    'stoploss-monitor-window',
    'popup=yes,width=720,height=640,resizable=yes,scrollbars=yes',
  );

  if (!monitorWindow) {
    setStatus(actionStatus, 'error', 'Could not open the floating monitor window.');
    return;
  }

  void chrome.runtime.sendMessage({ type: 'REFRESH_PRICES' }).catch(() => undefined);
  monitorWindow.focus();
}

function hideExistingInstrumentPanel() {
  existingInstrumentTitle.textContent = 'No current stock selected.';
  existingInstrumentDetails.replaceChildren();
  activeMonitorList.replaceChildren();
  activeMonitorEmpty.hidden = false;
  latestMonitoringPlans = [];
  latestMonitorTicker = '';
  updateFloatingMonitorButton();
  existingInstrumentPanel.classList.remove('visible');
}

function ensureExistingInstrumentPanelVisible() {
  existingInstrumentPanel.classList.add('visible');
}

function formatMonitorListItem(plan) {
  const ticker = plan?.instrument?.ticker ?? '-';
  const triggerPrice = plan?.triggerPrice ?? '-';
  const currency = plan?.instrument?.currency ? ` ${plan.instrument.currency}` : '';
  const condition = plan?.triggerCondition === 'AT_OR_ABOVE' ? '>=' : '<=';
  return `${ticker} / ${condition} ${triggerPrice}${currency}`;
}

function showMonitoringPlans(plans, options = {}) {
  const items = Array.isArray(plans) ? plans : [];
  const currentTicker = normalizeTickerValue(options.currentTicker);

  const sortedItems = currentTicker
    ? [
        ...items.filter((plan) => tickersMatch(plan?.instrument?.ticker ?? '', currentTicker)),
        ...items.filter((plan) => !tickersMatch(plan?.instrument?.ticker ?? '', currentTicker)),
      ]
    : items;

  activeMonitorList.replaceChildren(
    ...sortedItems.map((plan) => {
      const li = document.createElement('li');
      li.textContent = formatMonitorListItem(plan);
      return li;
    }),
  );
  activeMonitorEmpty.hidden = sortedItems.length > 0;
}

function showExistingInstrumentPanel(instrument, summary) {
  const titleParts = [instrument?.ticker, instrument?.name].filter(Boolean);
  existingInstrumentTitle.textContent =
    titleParts.length > 0
      ? titleParts.join(' - ')
      : 'Current stock found in the local database.';

  const items = Array.isArray(summary) ? summary : [];
  existingInstrumentDetails.replaceChildren(
    ...items.map((item) => {
      const li = document.createElement('li');
      li.textContent = item;
      return li;
    }),
  );

  ensureExistingInstrumentPanelVisible();
}

function showCurrentStockPanel(stockPayload) {
  const titleParts = [stockPayload?.ticker, stockPayload?.name].filter(Boolean);
  existingInstrumentTitle.textContent =
    titleParts.length > 0
      ? titleParts.join(' - ')
      : 'Current stock from active tab';

  const summary = [
    `Ticker: ${stockPayload?.ticker ?? '-'}`,
    `Name: ${stockPayload?.name ?? '-'}`,
    `Market: ${stockPayload?.market ?? stockPayload?.marketCode ?? '-'}`,
    `Current price: ${stockPayload?.currentPriceText ?? stockPayload?.currentPrice ?? '-'}`,
    `Currency: ${stockPayload?.currency ?? '-'}`,
    `Type: ${stockPayload?.type ?? '-'}`,
  ];

  existingInstrumentDetails.replaceChildren(
    ...summary.map((item) => {
      const li = document.createElement('li');
      li.textContent = item;
      return li;
    }),
  );

  ensureExistingInstrumentPanelVisible();
}

async function refreshMonitoringPlans(currentTicker) {
  let response;
  try {
    response = await chrome.runtime.sendMessage({
      type: 'FETCH_MONITORING_PLANS',
    });
  } catch (error) {
    activeMonitorList.replaceChildren();
    activeMonitorEmpty.hidden = false;
    activeMonitorEmpty.textContent = toDisplayError(error, 'Could not load active monitors.');
    latestMonitoringPlans = [];
    latestMonitorTicker = normalizeTickerValue(currentTicker);
    updateFloatingMonitorButton();
    ensureExistingInstrumentPanelVisible();
    return;
  }

  if (!response?.ok) {
    activeMonitorList.replaceChildren();
    activeMonitorEmpty.hidden = false;
    activeMonitorEmpty.textContent = response?.error ?? 'Could not load active monitors.';
    latestMonitoringPlans = [];
    latestMonitorTicker = normalizeTickerValue(currentTicker);
    updateFloatingMonitorButton();
    ensureExistingInstrumentPanelVisible();
    return;
  }

  latestMonitoringPlans = Array.isArray(response.data?.plans) ? response.data.plans : [];
  latestMonitorTicker = normalizeTickerValue(currentTicker);
  activeMonitorEmpty.textContent = 'No active monitors found.';
  showMonitoringPlans(latestMonitoringPlans, { currentTicker });
  updateFloatingMonitorButton();
  ensureExistingInstrumentPanelVisible();
}

function isNordnetStockUrl(url) {
  return (
    typeof url === 'string' &&
    (
      /^https:\/\/www\.nordnet\.no\/aksjer\/kurser\/.+/i.test(url) ||
      /^https:\/\/www\.nordnet\.no\/etp\/sertifikat\/[^/]+\/liste\/.+/i.test(url)
    )
  );
}

async function ensureContentScript(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['assets/js/nordnet-stock.js'],
  });
}

async function requestStockPayload(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: 'GET_STOCK_PAYLOAD' }, (payloadResponse) => {
      if (chrome.runtime.lastError) {
        const rawMessage = chrome.runtime.lastError.message ?? '';
        resolve({
          ok: false,
          error: toDisplayError(rawMessage, 'Could not read instrument data from the page.'),
          needsInjection:
            /Receiving end does not exist/i.test(rawMessage) &&
            !isExtensionContextInvalidatedMessage(rawMessage),
        });
        return;
      }

      resolve(payloadResponse ?? { ok: false, error: 'Could not read instrument data from the page.' });
    });
  });
}

async function loadCurrentStockPayload(tabId) {
  let payloadResponse = await requestStockPayload(tabId);

  if (!payloadResponse?.ok && payloadResponse?.needsInjection) {
    await ensureContentScript(tabId);
    payloadResponse = await requestStockPayload(tabId);
  }

  return payloadResponse;
}

async function inspectCurrentInstrument(tabId) {
  setStatus(actionStatus, 'info', 'Loading instrument data from the active Nordnet page...');
  hideExistingInstrumentPanel();
  currentStockPayload = null;
  currentInstrumentExists = false;

  let payloadResponse;
  try {
    payloadResponse = await loadCurrentStockPayload(tabId);
  } catch (error) {
    await refreshMonitoringPlans();
    setStatus(
      actionStatus,
      'error',
      toDisplayError(error, 'Could not load the Nordnet page helper.'),
    );
    stockTabReady = false;
    updateImportButton();
    return;
  }

  if (!payloadResponse?.ok) {
    await refreshMonitoringPlans();
    setStatus(
      actionStatus,
      'error',
      payloadResponse?.error ?? 'Could not read instrument data from the page.',
    );
    stockTabReady = false;
    updateImportButton();
    return;
  }

  currentStockPayload = payloadResponse.payload;
  await publishCurrentStockPriceUpdate(currentStockPayload);
  showCurrentStockPanel(currentStockPayload);
  await refreshMonitoringPlans(currentStockPayload?.ticker);

  const existingResponse = await chrome.runtime.sendMessage({
    type: 'CHECK_INSTRUMENT_EXISTS',
    payload: payloadResponse.payload,
  });

  if (!existingResponse?.ok) {
    await refreshMonitoringPlans(currentStockPayload?.ticker);
    setStatus(actionStatus, 'error', existingResponse?.error ?? 'Could not check existing instruments.');
    stockTabReady = false;
    updateImportButton();
    return;
  }

  stockTabReady = true;

  if (existingResponse.data?.exists) {
    currentInstrumentExists = true;
    const instrument = existingResponse.data.instrument;
    const summary = [
      `Ticker: ${instrument?.ticker ?? '-'}`,
      `Name: ${instrument?.name ?? '-'}`,
      `Market: ${instrument?.market ?? '-'}`,
      `ISIN: ${instrument?.isin ?? '-'}`,
      `Currency: ${instrument?.currency ?? '-'}`,
      `Type: ${instrument?.type ?? '-'}`,
    ];

    showExistingInstrumentPanel(instrument, summary);
    await refreshMonitoringPlans(instrument?.ticker ?? currentStockPayload?.ticker);
    setStatus(actionStatus, 'info', 'Show Current monitors.');
  } else {
    currentInstrumentExists = false;
    showCurrentStockPanel(currentStockPayload);
    await refreshMonitoringPlans(currentStockPayload?.ticker);
    setStatus(actionStatus, 'info', 'Show current');
  }

  updateImportButton();
}

async function checkDashboard() {
  const response = await chrome.runtime.sendMessage({ type: 'CHECK_DASHBOARD' });

  dashboardReady = Boolean(response?.ok);
  if (dashboardReady) {
    setStatus(dashboardStatus, 'ok', 'StockTrade dashboard is reachable.');
  } else {
    setStatus(
      dashboardStatus,
      'error',
      'StockTrade dashboard is not reachable. Verify the deployed app URL and that the site is online.',
    );
  }

  updateImportButton();
}

async function checkActiveTab() {
  const refreshToken = ++activeTabRefreshToken;
  const response = await chrome.runtime.sendMessage({ type: 'GET_ACTIVE_TAB' });
  const url = response?.tab?.url ?? '';
  const tabId = response?.tab?.id;

  if (refreshToken !== activeTabRefreshToken) {
    return;
  }

  stockTabReady = false;
  currentStockPayload = null;
  currentInstrumentExists = false;

  if (isNordnetStockUrl(url) && tabId) {
    activeTab.textContent = url;
    await inspectCurrentInstrument(tabId);
  } else {
    activeTab.textContent = url || 'No active tab detected';
    hideExistingInstrumentPanel();
    await refreshMonitoringPlans();
    setStatus(
      actionStatus,
      'info',
      'Open a Nordnet instrument page like /aksjer/kurser/orkla-ork-xosl or /etp/sertifikat/trackers/liste/... or /etp/sertifikat/bull-bear/liste/....',
    );
    updateImportButton();
  }
}

async function importCurrentStock() {
  setStatus(actionStatus, 'info', 'Preparing import...');
  importButton.disabled = true;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    setStatus(actionStatus, 'error', 'Could not access the active browser tab.');
    updateImportButton();
    return;
  }

  let payload = currentStockPayload;
  if (!payload) {
    const payloadResponse = await loadCurrentStockPayload(tab.id).catch((error) => ({
      ok: false,
      error: toDisplayError(error, 'Could not load the Nordnet page helper.'),
    }));

    if (!payloadResponse?.ok) {
      setStatus(
        actionStatus,
        'error',
        payloadResponse?.error ?? 'Could not read instrument data from the page.',
      );
      updateImportButton();
      return;
    }

    payload = payloadResponse.payload;
    currentStockPayload = payload;
  }

  hideExistingInstrumentPanel();
  showCurrentStockPanel(payload);
  await refreshMonitoringPlans(payload?.ticker);

  const importResponse = await chrome.runtime.sendMessage({
    type: 'IMPORT_INSTRUMENT',
    payload,
  });

  if (importResponse?.requiresConfirmation) {
    currentInstrumentExists = true;
    showExistingInstrumentPanel(importResponse.existingInstrument, importResponse.existingInstrumentSummary);
    await refreshMonitoringPlans(importResponse.existingInstrument?.ticker ?? payload?.ticker);

    const shouldUpdate = window.confirm(
      'This instrument already exists in the local database. Select OK to update the existing entry or Cancel to keep it unchanged.',
    );

    if (!shouldUpdate) {
      setStatus(actionStatus, 'info', 'Existing instrument left unchanged.');
      updateImportButton();
      return;
    }

    const confirmedImportResponse = await chrome.runtime.sendMessage({
      type: 'IMPORT_INSTRUMENT',
      payload: {
        ...payload,
        confirmUpdate: true,
      },
    });

    if (confirmedImportResponse?.ok) {
      const result = confirmedImportResponse.data;
      const instrument = result?.instrument;
      await refreshMonitoringPlans(instrument?.ticker ?? payload?.ticker);
      setStatus(
        actionStatus,
        'ok',
        `${result?.created ? 'Created' : 'Updated'} ${instrument?.ticker ?? 'instrument'} in the local database.`,
      );
    } else {
      setStatus(actionStatus, 'error', confirmedImportResponse?.error ?? 'Import failed.');
    }

    updateImportButton();
    return;
  }

  if (importResponse?.ok) {
    const result = importResponse.data;
    const instrument = result?.instrument;
    currentInstrumentExists = !result?.created;
    await refreshMonitoringPlans(instrument?.ticker ?? payload?.ticker);
    setStatus(
      actionStatus,
      'ok',
      `${result?.created ? 'Created' : 'Updated'} ${instrument?.ticker ?? 'instrument'} in the local database.`,
    );
  } else {
    setStatus(actionStatus, 'error', importResponse?.error ?? 'Import failed.');
  }

  updateImportButton();
}

function resetExtensionState() {
  chrome.storage.local.clear(() => {
    hideExistingInstrumentPanel();
    setStatus(actionStatus, 'ok', 'Extension state cleared. Nordnet instrument import remains available.');
  });
}

function queueActiveTabRefresh() {
  void checkActiveTab();
}

hideExistingInstrumentPanel();

importButton.addEventListener('click', () => {
  void importCurrentStock();
});

resetButton.addEventListener('click', () => {
  resetExtensionState();
});

floatingMonitorButton.addEventListener('click', () => {
  openFloatingMonitorWindow();
});

chrome.tabs.onActivated.addListener(() => {
  queueActiveTabRefresh();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo.url && changeInfo.status !== 'complete') {
    return;
  }

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (chrome.runtime.lastError) {
      return;
    }

    if (tabs[0]?.id === tabId && tab?.active) {
      queueActiveTabRefresh();
    }
  });
});

void Promise.all([checkDashboard(), checkActiveTab()]);
