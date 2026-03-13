const monitorSummary = document.getElementById('monitorSummary');
const monitorTableBody = document.getElementById('monitorTableBody');
const messageList = document.getElementById('messageList');
const messageEmpty = document.getElementById('messageEmpty');
const lastUpdatedValue = document.getElementById('lastUpdatedValue');
const refreshButton = document.getElementById('refreshMonitorPrices');
const monitorVersion = document.getElementById('monitorVersion');

const rowMap = new Map();
const hitState = new Map();
const messageKeys = new Set();
const manifestVersion = chrome.runtime.getManifest().version ?? 'unknown';

let monitorPlans = [];
let monitorCurrentTicker = '';
let refreshInFlight = false;
let refreshIntervalId = null;

if (monitorVersion) {
  monitorVersion.textContent = manifestVersion;
}

function normalizeTicker(value) {
  return String(value ?? '').trim().toUpperCase();
}

function compactTicker(value) {
  return normalizeTicker(value).replace(/[^A-Z0-9]/g, '');
}

function tickersMatch(left, right) {
  const normalizedLeft = normalizeTicker(left);
  const normalizedRight = normalizeTicker(right);

  if (!normalizedLeft || !normalizedRight) {
    return false;
  }

  if (normalizedLeft === normalizedRight) {
    return true;
  }

  const compactLeft = compactTicker(normalizedLeft);
  const compactRight = compactTicker(normalizedRight);
  return compactLeft === compactRight || compactLeft.includes(compactRight) || compactRight.includes(compactLeft);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatPrice(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return '-';
  }

  return value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  });
}

function formatTimestamp(value) {
  if (!value) {
    return 'Waiting for price updates';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return 'Waiting for price updates';
  }

  return date.toLocaleString([], {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function getPlanKey(plan) {
  return [
    normalizeTicker(plan?.instrument?.ticker),
    plan?.triggerCondition ?? '',
    String(plan?.triggerPrice ?? ''),
  ].join('|');
}

function isTriggerHit(plan, price) {
  if (typeof price !== 'number' || !Number.isFinite(price)) {
    return false;
  }

  const triggerPrice = Number(plan?.triggerPrice);
  if (!Number.isFinite(triggerPrice)) {
    return false;
  }

  return plan?.triggerCondition === 'AT_OR_ABOVE'
    ? price >= triggerPrice
    : price <= triggerPrice;
}

function appendMessage(plan, price, fetchedAt) {
  const timestamp = fetchedAt ? new Date(fetchedAt) : new Date();
  const key = `${getPlanKey(plan)}|${timestamp.toISOString()}`;

  if (messageKeys.has(key)) {
    return;
  }

  messageKeys.add(key);
  messageEmpty?.remove();

  const item = document.createElement('li');
  item.className = 'message-item';
  item.innerHTML = '<span class="message-meta"></span><span class="message-meta"></span><span></span>';
  item.children[0].textContent = timestamp.toLocaleDateString();
  item.children[1].textContent = timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  item.children[2].textContent = `${normalizeTicker(plan?.instrument?.ticker) || 'Unknown'} trigger hit (${formatPrice(price)})`;
  messageList.prepend(item);
}

function renderPlans() {
  rowMap.clear();
  monitorTableBody.replaceChildren();

  if (monitorPlans.length === 0) {
    const emptyRow = document.createElement('tr');
    emptyRow.innerHTML = '<td colspan="6" class="muted">No active monitors found.</td>';
    monitorTableBody.append(emptyRow);
    if (monitorSummary) {
      monitorSummary.textContent = 'No active monitors found.';
    }
    return;
  }

  monitorPlans.forEach((plan, index) => {
    const row = document.createElement('tr');
    const ticker = plan?.instrument?.ticker ?? '-';
    const isCurrent = monitorCurrentTicker && tickersMatch(ticker, monitorCurrentTicker);
    const condition = plan?.triggerCondition === 'AT_OR_ABOVE' ? '>=' : '<=';
    const badge = isCurrent ? '<span class="badge">Current</span>' : '';

    row.className = isCurrent ? 'is-current' : '';
    row.dataset.planIndex = String(index);
    row.innerHTML = `
      <td><strong>${escapeHtml(ticker)}</strong> ${badge}</td>
      <td>${escapeHtml(plan?.instrument?.name ?? '-')}</td>
      <td>${escapeHtml(condition)} ${escapeHtml(plan?.triggerPrice ?? '-')}</td>
      <td data-role="price">-</td>
      <td>${escapeHtml(plan?.instrument?.currency ?? '-')}</td>
      <td data-role="status">Watching</td>
    `;

    monitorTableBody.append(row);
    rowMap.set(index, row);
  });

  if (monitorSummary) {
    monitorSummary.textContent = `${monitorPlans.length} monitor(s)${monitorCurrentTicker ? `, current stock: ${monitorCurrentTicker}` : ''}`;
  }
}

function applyPrices(priceMap) {
  let newestFetchedAt = null;

  monitorPlans.forEach((plan, index) => {
    const row = rowMap.get(index);
    if (!row) {
      return;
    }

    const ticker = normalizeTicker(plan?.instrument?.ticker);
    const entryKey = Object.keys(priceMap ?? {}).find((key) => tickersMatch(key, ticker));
    const entry = entryKey ? priceMap[entryKey] : null;
    const price = entry?.ok ? Number(entry.price) : null;
    const hit = isTriggerHit(plan, price);
    const previousHit = hitState.get(index) === true;
    const priceCell = row.querySelector('[data-role="price"]');
    const statusCell = row.querySelector('[data-role="status"]');

    if (priceCell) {
      priceCell.textContent = entry?.ok ? formatPrice(price) : '-';
    }

    if (entry?.fetchedAt) {
      if (!newestFetchedAt || new Date(entry.fetchedAt).getTime() > new Date(newestFetchedAt).getTime()) {
        newestFetchedAt = entry.fetchedAt;
      }
    }

    row.classList.toggle('is-hit', hit);

    if (statusCell) {
      statusCell.textContent = hit ? 'Trigger hit' : 'Watching';
      statusCell.className = hit ? 'status-hit' : '';
      statusCell.setAttribute('data-role', 'status');
    }

    if (hit && !previousHit) {
      appendMessage(plan, price, entry?.fetchedAt);
    }

    hitState.set(index, hit);
  });

  if (lastUpdatedValue) {
    lastUpdatedValue.textContent = formatTimestamp(newestFetchedAt);
    lastUpdatedValue.title = `Monitor version ${manifestVersion}`;
  }
}

function toPriceMapFromServer(response) {
  const serverPrices = {};

  for (const entry of Array.isArray(response?.data?.prices) ? response.data.prices : []) {
    const ticker = normalizeTicker(entry?.ticker);
    const marketPrice = Number(entry?.snapshot?.marketPrice);

    if (!ticker || !Number.isFinite(marketPrice)) {
      continue;
    }

    serverPrices[ticker] = {
      ok: true,
      price: marketPrice,
      error: null,
      fetchedAt: entry?.snapshot?.capturedAt ?? null,
      source: 'stocktrade-server',
    };
  }

  return serverPrices;
}

function toTimestamp(value) {
  const timestamp = value ? new Date(value).getTime() : Number.NaN;
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function mergePriceMaps(primaryPriceMap, secondaryPriceMap) {
  const merged = { ...(secondaryPriceMap ?? {}) };

  for (const [ticker, nextEntry] of Object.entries(primaryPriceMap ?? {})) {
    const currentEntry = merged[ticker];

    if (!currentEntry) {
      merged[ticker] = nextEntry;
      continue;
    }

    const nextIsUsable = nextEntry?.ok && Number.isFinite(Number(nextEntry?.price));
    const currentIsUsable = currentEntry?.ok && Number.isFinite(Number(currentEntry?.price));

    if (nextIsUsable && !currentIsUsable) {
      merged[ticker] = nextEntry;
      continue;
    }

    if (!nextIsUsable && currentIsUsable) {
      continue;
    }

    if (toTimestamp(nextEntry?.fetchedAt) >= toTimestamp(currentEntry?.fetchedAt)) {
      merged[ticker] = nextEntry;
    }
  }

  return merged;
}

async function readStoredPrices() {
  const storage = await chrome.storage.local.get(['extensionPrices']);
  return storage?.extensionPrices ?? {};
}

async function loadMonitorState() {
  const storage = await chrome.storage.local.get(['floatingMonitorState']);
  const state = storage?.floatingMonitorState ?? {};

  monitorPlans = Array.isArray(state?.plans) ? state.plans : [];
  monitorCurrentTicker = normalizeTicker(state?.currentTicker);

  renderPlans();
}

async function refreshMonitorPlans(options = {}) {
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'FETCH_MONITORING_PLANS',
    });

    if (!response?.ok) {
      if (!options?.silent && lastUpdatedValue) {
        lastUpdatedValue.textContent = response?.error ?? 'Failed to load active monitors';
      }
      return false;
    }

    monitorPlans = Array.isArray(response.data?.plans) ? response.data.plans : [];
    renderPlans();
    return true;
  } catch (error) {
    console.error('[StopLossExtension monitor] refreshMonitorPlans exception', error);
    if (!options?.silent && lastUpdatedValue) {
      lastUpdatedValue.textContent = 'Failed to load active monitors';
    }
    return false;
  }
}

async function refreshPrices(options = {}) {
  if (refreshInFlight) {
    return;
  }

  refreshInFlight = true;
  if (refreshButton) {
    refreshButton.disabled = true;
    refreshButton.textContent = 'Refreshing...';
  }

  try {
    let backgroundPriceMap = {};

    console.info('[StopLossExtension monitor] refreshPrices start', {
      silent: Boolean(options?.silent),
      tickers: monitorPlans.map((plan) => normalizeTicker(plan?.instrument?.ticker)).filter(Boolean),
    });

    await refreshMonitorPlans({ silent: options?.silent });
    const refreshResponse = await chrome.runtime.sendMessage({ type: 'REFRESH_PRICES' });

    backgroundPriceMap = refreshResponse?.data?.prices ?? {};
    if (Object.keys(backgroundPriceMap).length > 0) {
      console.info('[StopLossExtension monitor] refreshPrices background result', {
        tickers: Object.keys(backgroundPriceMap),
        updatedAt: refreshResponse?.data?.updatedAt ?? null,
      });
      applyPrices(backgroundPriceMap);
    }

    const [storedPrices, serverResponse] = await Promise.all([
      readStoredPrices(),
      chrome.runtime.sendMessage({
        type: 'FETCH_LATEST_PRICE_SNAPSHOTS',
      }),
    ]);

    const mergedPrices = mergePriceMaps(
      toPriceMapFromServer(serverResponse),
      mergePriceMaps(backgroundPriceMap, storedPrices),
    );

    console.info('[StopLossExtension monitor] refreshPrices apply', {
      appliedTickers: Object.keys(mergedPrices),
      refreshOk: Boolean(refreshResponse?.ok),
      serverOk: Boolean(serverResponse?.ok),
    });

    applyPrices(mergedPrices);

    if (!serverResponse?.ok && !options?.silent && lastUpdatedValue) {
      lastUpdatedValue.textContent = serverResponse?.error ?? 'Failed to load saved prices';
    }
  } catch (error) {
    console.error('[StopLossExtension monitor] refreshPrices exception', error);
    if (!options?.silent && lastUpdatedValue) {
      lastUpdatedValue.textContent = 'Failed to refresh prices';
    }
  } finally {
    refreshInFlight = false;
    if (refreshButton) {
      refreshButton.disabled = false;
      refreshButton.textContent = 'Refresh prices';
    }
  }
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== 'PRICE_UPDATE') {
    return;
  }

  console.info('[StopLossExtension monitor] PRICE_UPDATE received', {
    tickers: Object.keys(message.payload ?? {}),
  });
  applyPrices(message.payload ?? {});
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') {
    return;
  }

  if (changes?.floatingMonitorState) {
    void loadMonitorState().then(() => refreshPrices({ silent: true }));
  }
});

refreshButton?.addEventListener('click', () => {
  console.info('[StopLossExtension monitor] Refresh prices button clicked');
  void refreshPrices();
});

window.addEventListener('beforeunload', () => {
  if (refreshIntervalId) {
    window.clearInterval(refreshIntervalId);
  }
});

void loadMonitorState().then(async () => {
  applyPrices(await readStoredPrices());
  await refreshMonitorPlans({ silent: true });
  void refreshPrices({ silent: true });
  refreshIntervalId = window.setInterval(() => {
    void refreshPrices({ silent: true });
  }, 60000);
});
