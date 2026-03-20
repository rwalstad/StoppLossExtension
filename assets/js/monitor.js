const monitorSummary = document.getElementById('monitorSummary');
const monitorTableBody = document.getElementById('monitorTableBody');
const messageList = document.getElementById('messageList');
const messageEmpty = document.getElementById('messageEmpty');
const lastUpdatedValue = document.getElementById('lastUpdatedValue');
const refreshButton = document.getElementById('refreshMonitorPrices');
const syncMonitorPlansButton = document.getElementById('syncMonitorPlans');
const monitorVersion = document.getElementById('monitorVersion');
const selectedTraderLabel = document.getElementById('selectedTraderLabel');
const headerMarketFlagBadge = document.getElementById('headerMarketFlagBadge');
const headerMarketFlagEmoji = document.getElementById('headerMarketFlagEmoji');
const headerMarketFlagText = document.getElementById('headerMarketFlagText');
const headerMarketFlagStatus = document.getElementById('headerMarketFlagStatus');
const toggleViewButton = document.getElementById('toggleMonitorView');
const toggleCompactViewButton = document.getElementById('toggleMonitorViewCompact');
const minimalList = document.getElementById('minimalList');
const minimalTraderLabel = document.getElementById('minimalTraderLabel');
const minimalLastUpdatedBadge = document.getElementById('minimalLastUpdatedBadge');
const SELECTED_TRADER_ID_STORAGE_KEY = 'stoploss-selected-trader-id';
const SELECTED_TRADER_NAME_STORAGE_KEY = 'stoploss-selected-trader-name';
const MONITOR_VIEW_MODE_KEY = 'viewMode';
const MONITOR_VIEW_MODE_MINIMAL = 'minimal';
const MONITOR_VIEW_MODE_FULL = 'full';
const FULL_WINDOW_SIZE = { width: 720, height: 640 };
const MINIMAL_WINDOW_SIZE = { width: 280, height: 120 };

const rowMap = new Map();
const hitState = new Map();
const messageKeys = new Set();
const manifestVersion = chrome.runtime.getManifest().version ?? 'unknown';

let monitorPlans = [];
let monitorCurrentTicker = '';
let monitorTraderId = '';
let monitorTraderName = '';
let refreshInFlight = false;
let refreshIntervalId = null;
let monitorViewMode = MONITOR_VIEW_MODE_FULL;
let latestPriceMap = {};
let placingPlanKey = '';

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

function renderSourceUrlLink(url, ticker) {
  const normalizedUrl = typeof url === 'string' ? url.trim() : '';
  if (!normalizedUrl) {
    return '';
  }

  const label = `Open quote page for ${normalizeTicker(ticker) || 'instrument'}`;
  return `
    <a
      class="ticker-link-action"
      href="${escapeHtml(normalizedUrl)}"
      target="_blank"
      rel="noreferrer"
      aria-label="${escapeHtml(label)}"
      title="${escapeHtml(label)}"
    >
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M10 13a5 5 0 0 1 0-7l1.5-1.5a5 5 0 0 1 7 7L17 13"></path>
        <path d="M14 11a5 5 0 0 1 0 7l-1.5 1.5a5 5 0 1 1-7-7L7 11"></path>
        <path d="M8.5 15.5 15.5 8.5"></path>
      </svg>
    </a>
  `;
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
/*XOSL – Oslo Børs All-share Index
Inneholder alle aksjer notert på Oslo Børs
Bredere enn OSEBX (Nordnet), som kun inneholder de med likviditet over en viss terskel*/
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
  'xetra':               { timezone: 'Europe/Berlin',    open: '09:00', close: '17:30' },
  'oslo børs':           { timezone: 'Europe/Oslo',      open: '09:00', close: '16:25' },
  'oslo stock exchange': { timezone: 'Europe/Oslo',      open: '09:00', close: '16:25' },
  'nasdaq':              { timezone: 'America/New_York', open: '09:30', close: '16:00' },
  'nyse':                { timezone: 'America/New_York', open: '09:30', close: '16:00' },
  'lse':                 { timezone: 'Europe/London',    open: '08:00', close: '16:30' },
  'london stock exchange': { timezone: 'Europe/London', open: '08:00', close: '16:30' },
};

const EXCHANGE_COUNTRY_CODES = {
  XOSL: 'NO',
  XSTO: 'SE',
  XCSE: 'DK',
  XHEL: 'FI',
  XICE: 'IS',
  XETR: 'DE',
  XETA: 'DE',
  XNYS: 'US',
  XNAS: 'US',
  XLON: 'GB',
  XPAR: 'FR',
  XAMS: 'NL',
};

const COUNTRY_NAME_TO_CODE = {
  norway: 'NO',
  norge: 'NO',
  sweden: 'SE',
  sverige: 'SE',
  denmark: 'DK',
  danmark: 'DK',
  finland: 'FI',
  iceland: 'IS',
  island: 'IS',
  germany: 'DE',
  deutschland: 'DE',
  usa: 'US',
  us: 'US',
  'united states': 'US',
  'united states of america': 'US',
  uk: 'GB',
  britain: 'GB',
  'united kingdom': 'GB',
  england: 'GB',
  france: 'FR',
  netherlands: 'NL',
  holland: 'NL',
};

function isInstrumentTradingNow(instrument) {
  const hours =
    EXCHANGE_TRADING_HOURS[instrument?.marketCode] ??
    EXCHANGE_TRADING_HOURS[instrument?.exchangeName?.toLowerCase()] ??
    EXCHANGE_TRADING_HOURS[instrument?.market?.toLowerCase()] ??
    null;

  if (!hours) return true;

  const now = new Date();
  const local = new Date(now.toLocaleString('en-US', { timeZone: hours.timezone }));
  const day = local.getDay();
  if (day === 0 || day === 6) return false;

  const currentMinutes = local.getHours() * 60 + local.getMinutes();
  const [openH, openM] = hours.open.split(':').map(Number);
  const [closeH, closeM] = hours.close.split(':').map(Number);
  return currentMinutes >= openH * 60 + openM && currentMinutes <= closeH * 60 + closeM;
}

function getCountryCodeFromInstrument(instrument) {
  const marketCode = String(instrument?.marketCode ?? '').trim().toUpperCase();
  if (marketCode && EXCHANGE_COUNTRY_CODES[marketCode]) {
    return EXCHANGE_COUNTRY_CODES[marketCode];
  }

  const normalizedCountry = String(instrument?.country ?? '').trim().toLowerCase();
  if (normalizedCountry && COUNTRY_NAME_TO_CODE[normalizedCountry]) {
    return COUNTRY_NAME_TO_CODE[normalizedCountry];
  }

  return '';
}

function getFlagEmoji(countryCode) {
  const normalizedCode = String(countryCode ?? '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(normalizedCode)) {
    return '';
  }

  return String.fromCodePoint(
    ...normalizedCode.split('').map((char) => 127397 + char.charCodeAt(0)),
  );
}

function getExchangeHours(instrument) {
  return (
    EXCHANGE_TRADING_HOURS[instrument?.marketCode] ??
    EXCHANGE_TRADING_HOURS[instrument?.exchangeName?.toLowerCase()] ??
    EXCHANGE_TRADING_HOURS[instrument?.market?.toLowerCase()] ??
    null
  );
}

function getInstrumentMarketLabel(instrument) {
  const exchangeName = String(instrument?.exchangeName ?? '').trim();
  if (exchangeName) {
    return exchangeName;
  }

  const market = String(instrument?.market ?? '').trim();
  if (market) {
    return market;
  }

  const marketCode = String(instrument?.marketCode ?? '').trim().toUpperCase();
  return marketCode || 'Market';
}

function syncHeaderMarketFlag() {
  if (!headerMarketFlagBadge || !headerMarketFlagEmoji || !headerMarketFlagText || !headerMarketFlagStatus) {
    return;
  }

  const preferredPlan = getPreferredCurrentPlan();
  const instrument = preferredPlan?.instrument;

  if (!instrument) {
    headerMarketFlagBadge.classList.remove('is-visible');
    headerMarketFlagStatus.classList.remove('is-open');
    headerMarketFlagBadge.removeAttribute('title');
    headerMarketFlagText.textContent = '';
    headerMarketFlagEmoji.textContent = '';
    return;
  }

  const marketLabel = getInstrumentMarketLabel(instrument);
  const flagEmoji = getFlagEmoji(getCountryCodeFromInstrument(instrument));
  const isOpen = isInstrumentTradingNow(instrument);
  const hours = getExchangeHours(instrument);
  const statusLabel = isOpen ? 'Open' : 'Closed';
  const hoursLabel = hours ? `${hours.open}-${hours.close} ${hours.timezone}` : 'Trading hours unavailable';

  headerMarketFlagBadge.classList.add('is-visible');
  headerMarketFlagEmoji.textContent = flagEmoji;
  headerMarketFlagText.textContent = `${marketLabel} ${statusLabel}`;
  headerMarketFlagStatus.classList.toggle('is-open', isOpen);
  headerMarketFlagBadge.title = `${marketLabel}: ${statusLabel}. ${hoursLabel}`;
}

function getPlanKey(plan) {
  return [
    normalizeTicker(plan?.instrument?.ticker),
    plan?.triggerCondition ?? '',
    String(plan?.triggerPrice ?? ''),
  ].join('|');
}

function getSelectedTraderLabel() {
  const traderLabel = String(monitorTraderName ?? '').trim();
  if (traderLabel) {
    return traderLabel;
  }

  const traderId = String(monitorTraderId ?? '').trim();
  return traderId || 'none selected';
}

function syncSelectedTraderLabel() {
  if (selectedTraderLabel) {
    selectedTraderLabel.textContent = getSelectedTraderLabel();
  }

  if (minimalTraderLabel) {
    minimalTraderLabel.textContent = getSelectedTraderLabel();
    minimalTraderLabel.title = getSelectedTraderLabel();
  }
}

function syncLastUpdatedLabel(value) {
  const formatted =
    typeof value === 'string' && value && Number.isNaN(new Date(value).getTime())
      ? value
      : formatTimestamp(value);

  if (lastUpdatedValue) {
    lastUpdatedValue.textContent = formatted;
    lastUpdatedValue.title = `Monitor version ${manifestVersion}`;
  }

  if (minimalLastUpdatedBadge) {
    minimalLastUpdatedBadge.textContent = formatted;
    minimalLastUpdatedBadge.title = `Monitor version ${manifestVersion}`;
  }
}

function getPreferredCurrentPlan() {
  if (monitorPlans.length === 0) {
    return null;
  }

  if (monitorCurrentTicker) {
    const currentPlan = monitorPlans.find((plan) => tickersMatch(plan?.instrument?.ticker, monitorCurrentTicker));
    if (currentPlan) {
      return currentPlan;
    }
  }

  return monitorPlans[0] ?? null;
}

function getStoredPriceEntryForTicker(ticker, priceMap) {
  if (!ticker) {
    return null;
  }

  const matchedKey = Object.keys(priceMap ?? {}).find((key) => tickersMatch(key, ticker));
  return matchedKey ? priceMap[matchedKey] : null;
}

function getSavedOrder(plan) {
  const savedOrder = plan?.pendingOrder;
  if (!savedOrder) {
    return null;
  }

  const quantity = Number(savedOrder.quantity);
  const price = Number(savedOrder.price);
  if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(price) || price <= 0) {
    return null;
  }

  return savedOrder;
}

function getSavedOrderStatus(plan) {
  const status = String(plan?.pendingOrder?.status ?? '').trim().toUpperCase();
  return status || '';
}

function isPendingSavedOrder(plan) {
  return getSavedOrderStatus(plan) === 'PENDING';
}

function isCancelledSavedOrder(plan) {
  return getSavedOrderStatus(plan) === 'CANCELLED';
}

function hasPlaceableSavedOrder(plan) {
  return Boolean(
    getSavedOrder(plan) &&
    String(plan?.instrument?.sourceUrl ?? '').trim() &&
    (isPendingSavedOrder(plan) || isCancelledSavedOrder(plan))
  );
}

function canMarkSavedOrderDone(plan) {
  return Boolean(getSavedOrder(plan) && isPendingSavedOrder(plan));
}

function getSavedOrderSummary(plan) {
  const savedOrder = getSavedOrder(plan);
  if (!savedOrder) {
    return 'Monitoring only';
  }

  const status = String(savedOrder.status ?? '').trim().toLowerCase() || 'saved';
  const quantity = Number(savedOrder.quantity);
  const price = Number(savedOrder.price);
  return `${savedOrder.side} ${formatPrice(price)} x ${formatPrice(quantity)} (${status})`;
}

function getPlanActionLabel(plan) {
  const savedOrder = getSavedOrder(plan);
  if (!savedOrder) {
    return 'No order';
  }

  return savedOrder.status === 'CANCELLED' ? 'Replace order' : 'Place order';
}

async function placeSavedOrder(plan, price) {
  if (!hasPlaceableSavedOrder(plan)) {
    window.alert('This monitor does not have a saved order to place.');
    return;
  }

  const savedOrder = getSavedOrder(plan);
  const ticker = normalizeTicker(plan?.instrument?.ticker) || 'instrument';
  const confirmMessage = [
    `${ticker} has hit the trigger at ${formatPrice(price)} ${plan?.instrument?.currency ?? ''}.`.trim(),
    '',
    `${savedOrder.side} ${formatPrice(Number(savedOrder.price))} x ${formatPrice(Number(savedOrder.quantity))}`,
    savedOrder.status === 'CANCELLED'
      ? 'The last saved Nordnet day order was cancelled. Replace it now?'
      : 'Place the saved Nordnet order now?',
  ].join('\n');

  if (!window.confirm(confirmMessage)) {
    return;
  }

  const planKey = getPlanKey(plan);
  placingPlanKey = planKey;
  renderPlans();
  applyPrices(latestPriceMap);

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'PLACE_MONITORED_ORDER',
      plan,
    });

    if (!response?.ok) {
      throw new Error(response?.error ?? 'Failed to place the saved Nordnet order.');
    }

    await syncMonitorPlansFromServer({ silent: true });
    window.alert(response?.message ?? 'Saved Nordnet order submitted.');
  } catch (error) {
    window.alert(error instanceof Error ? error.message : 'Failed to place the saved Nordnet order.');
  } finally {
    placingPlanKey = '';
    renderPlans();
    applyPrices(latestPriceMap);
  }
}

function askForFilledOrderDetails(plan, price) {
  const savedOrder = getSavedOrder(plan);
  if (!savedOrder) {
    return null;
  }

  const ticker = normalizeTicker(plan?.instrument?.ticker) || 'instrument';
  const suggestedPrice = String(savedOrder.price ?? '').trim() || (typeof price === 'number' ? String(price) : '');
  const suggestedQuantity = String(savedOrder.quantity ?? '').trim();

  const executedPriceInput = window.prompt(`Executed price for ${ticker}:`, suggestedPrice);
  if (executedPriceInput === null) {
    return null;
  }

  const executedQuantityInput = window.prompt(`Executed quantity for ${ticker}:`, suggestedQuantity);
  if (executedQuantityInput === null) {
    return null;
  }

  const feeInput = window.prompt('Fee (optional):', '');
  if (feeInput === null) {
    return null;
  }

  const executedPrice = Number(executedPriceInput);
  const executedQuantity = Number(executedQuantityInput);
  const fee = feeInput.trim() === '' ? null : Number(feeInput);

  if (!Number.isFinite(executedPrice) || executedPrice <= 0) {
    window.alert('Executed price must be greater than zero.');
    return null;
  }

  if (!Number.isFinite(executedQuantity) || executedQuantity <= 0) {
    window.alert('Executed quantity must be greater than zero.');
    return null;
  }

  if (fee !== null && (!Number.isFinite(fee) || fee < 0)) {
    window.alert('Fee must be zero or greater.');
    return null;
  }

  return {
    executedPrice,
    executedQuantity,
    fee,
    executedAt: new Date().toISOString(),
  };
}

async function markSavedOrderDone(plan, price) {
  if (!canMarkSavedOrderDone(plan)) {
    window.alert('This monitor does not have a pending order that can be marked as done.');
    return;
  }

  const savedOrder = getSavedOrder(plan);
  const details = askForFilledOrderDetails(plan, price);
  if (!details) {
    return;
  }

  const ticker = normalizeTicker(plan?.instrument?.ticker) || 'instrument';
  const confirmMessage = [
    `Mark ${ticker} as trade done?`,
    '',
    `${savedOrder.side} ${formatPrice(details.executedPrice)} x ${formatPrice(details.executedQuantity)}`,
    details.fee !== null ? `Fee ${formatPrice(details.fee)}` : 'No fee recorded',
  ].join('\n');

  if (!window.confirm(confirmMessage)) {
    return;
  }

  const planKey = getPlanKey(plan);
  placingPlanKey = planKey;
  renderPlans();
  applyPrices(latestPriceMap);

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'MARK_MONITORED_ORDER_FILLED',
      orderId: savedOrder.id,
      payload: details,
    });

    if (!response?.ok) {
      throw new Error(response?.error ?? 'Failed to mark the saved order as filled.');
    }

    await syncMonitorPlansFromServer({ silent: true });
    window.alert('Saved order marked as filled and the monitoring state was updated.');
  } catch (error) {
    window.alert(error instanceof Error ? error.message : 'Failed to mark the saved order as filled.');
  } finally {
    placingPlanKey = '';
    renderPlans();
    applyPrices(latestPriceMap);
  }
}

function updateMinimalPanel(priceMap = {}) {
  if (!minimalList) {
    return;
  }

  minimalList.replaceChildren();

  if (monitorPlans.length === 0) {
    const emptyState = document.createElement('div');
    emptyState.className = 'minimal-meta';
    emptyState.textContent = 'No active monitors found';
    minimalList.append(emptyState);
    return;
  }

  const sortedPlans = getPreferredCurrentPlan()
    ? [
        ...monitorPlans.filter((plan) => tickersMatch(plan?.instrument?.ticker, monitorCurrentTicker)),
        ...monitorPlans.filter((plan) => !tickersMatch(plan?.instrument?.ticker, monitorCurrentTicker)),
      ]
    : [...monitorPlans];

  minimalList.append(
    ...sortedPlans.map((plan) => {
      const ticker = normalizeTicker(plan?.instrument?.ticker) || '-';
      const entry = getStoredPriceEntryForTicker(ticker, priceMap);
      const price = entry?.ok ? Number(entry.price) : null;
      const currency = String(plan?.instrument?.currency ?? '').trim();
      const isCurrent = monitorCurrentTicker && tickersMatch(ticker, monitorCurrentTicker);
      const hit = isTriggerHit(plan, price);
      const row = document.createElement('div');
      row.className = 'minimal-row';
      row.classList.toggle('is-current', Boolean(isCurrent));
      row.classList.toggle('is-hit', hit);
      row.innerHTML = `
        <div>
          <div class="minimal-symbol ticker-link">${escapeHtml(ticker)} ${renderSourceUrlLink(plan?.instrument?.sourceUrl, ticker)}</div>
          <div class="minimal-meta">${isCurrent ? 'Current' : 'Watching'}</div>
        </div>
        <div class="minimal-price">${escapeHtml(entry?.ok ? `${formatPrice(price)}${currency ? ` ${currency}` : ''}` : '-')}</div>
      `;
      return row;
    }),
  );
}

async function persistViewMode() {
  const storage = await chrome.storage.local.get(['floatingMonitorState']);
  const currentState = storage?.floatingMonitorState ?? {};
  await chrome.storage.local.set({
    floatingMonitorState: {
      ...currentState,
      [MONITOR_VIEW_MODE_KEY]: monitorViewMode,
    },
  });
}

function applyViewMode() {
  document.body.classList.toggle('minimal-mode', monitorViewMode === MONITOR_VIEW_MODE_MINIMAL);

  if (toggleViewButton) {
    toggleViewButton.title = monitorViewMode === MONITOR_VIEW_MODE_MINIMAL ? 'Expand to normal view' : 'Switch to minimal view';
    toggleViewButton.setAttribute(
      'aria-label',
      monitorViewMode === MONITOR_VIEW_MODE_MINIMAL ? 'Expand to normal view' : 'Switch to minimal view',
    );
  }

  const nextSize =
    monitorViewMode === MONITOR_VIEW_MODE_MINIMAL
      ? { width: 300, height: Math.max(160, 92 + (monitorPlans.length * 54)) }
      : FULL_WINDOW_SIZE;

  if (typeof window.resizeTo === 'function') {
    window.resizeTo(nextSize.width, nextSize.height);
  }
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
  syncSelectedTraderLabel();
  syncHeaderMarketFlag();
  rowMap.clear();
  monitorTableBody.replaceChildren();

  if (monitorPlans.length === 0) {
    const emptyRow = document.createElement('tr');
    emptyRow.innerHTML = '<td colspan="7" class="muted">No active monitors found.</td>';
    monitorTableBody.append(emptyRow);
    if (monitorSummary) {
      monitorSummary.textContent = `No active monitors found for trader: ${getSelectedTraderLabel()}.`;
    }
    updateMinimalPanel();
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
      <td><span class="ticker-link"><strong>${escapeHtml(ticker)}</strong>${renderSourceUrlLink(plan?.instrument?.sourceUrl, ticker)}</span> ${badge}</td>
      <td>${escapeHtml(plan?.instrument?.name ?? '-')}</td>
      <td>${escapeHtml(condition)} ${escapeHtml(plan?.triggerPrice ?? '-')}</td>
      <td data-role="price">-</td>
      <td>${escapeHtml(plan?.instrument?.currency ?? '-')}</td>
      <td data-role="status">Watching<span class="status-subline">${escapeHtml(getSavedOrderSummary(plan))}</span></td>
      <td data-role="action"></td>
    `;

    monitorTableBody.append(row);
    rowMap.set(index, row);
  });

  if (monitorSummary) {
    monitorSummary.textContent =
      `(Loaded ` +
      `${monitorPlans.length} monitor(s)${monitorCurrentTicker ? `, current stock: ${monitorCurrentTicker}` : ''})`;
  }

  updateMinimalPanel();
}

function applyPrices(priceMap) {
  latestPriceMap = mergePriceMaps(priceMap, latestPriceMap);
  let newestFetchedAt = null;

  monitorPlans.forEach((plan, index) => {
    const row = rowMap.get(index);
    if (!row) {
      return;
    }

    const ticker = normalizeTicker(plan?.instrument?.ticker);
    const entryKey = Object.keys(latestPriceMap ?? {}).find((key) => tickersMatch(key, ticker));
    const entry = entryKey ? latestPriceMap[entryKey] : null;
    const price = entry?.ok ? Number(entry.price) : null;
    const hit = isTriggerHit(plan, price);
    const previousHit = hitState.get(index) === true;
    const priceCell = row.querySelector('[data-role="price"]');
    const statusCell = row.querySelector('[data-role="status"]');
    const actionCell = row.querySelector('[data-role="action"]');

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
      statusCell.innerHTML = `${hit ? 'Trigger hit' : 'Watching'}<span class="status-subline">${escapeHtml(getSavedOrderSummary(plan))}</span>`;
      statusCell.className = hit ? 'status-hit' : '';
      statusCell.setAttribute('data-role', 'status');
    }

    if (actionCell) {
      const canPlace = hit && hasPlaceableSavedOrder(plan);
      const canMarkDone = hit && canMarkSavedOrderDone(plan);
      const isPlacing = placingPlanKey === getPlanKey(plan);
      actionCell.innerHTML = canPlace || canMarkDone
        ? `
          <div class="table-actions">
            ${canPlace ? `<button type="button" class="table-action" data-action="place-saved-order" data-plan-index="${index}" ${isPlacing ? 'disabled' : ''}>${escapeHtml(isPlacing ? 'Working...' : getPlanActionLabel(plan))}</button>` : ''}
            ${canMarkDone ? `<button type="button" class="table-action secondary" data-action="mark-saved-order-done" data-plan-index="${index}" ${isPlacing ? 'disabled' : ''}>${escapeHtml(isPlacing ? 'Working...' : 'Trade done')}</button>` : ''}
          </div>
        `
        : '<span class="muted">Waiting</span>';
    }

    if (hit && !previousHit) {
      appendMessage(plan, price, entry?.fetchedAt);
    }

    hitState.set(index, hit);
  });

  syncLastUpdatedLabel(newestFetchedAt);

  updateMinimalPanel(latestPriceMap);
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

async function fetchServerPriceMap(options = {}) {
  const tickers = [...new Set(
    monitorPlans
      .map((plan) => normalizeTicker(plan?.instrument?.ticker))
      .filter(Boolean),
  )];

  if (tickers.length === 0) {
    return {};
  }

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'FETCH_LATEST_PRICE_SNAPSHOTS',
      traderId: monitorTraderId || undefined,
      tickers,
    });

    if (!response?.ok) {
      if (!options?.silent) {
        console.info('[StopLossExtension monitor] server price snapshot fetch failed', response?.error ?? 'Unknown error');
      }
      return {};
    }

    return toPriceMapFromServer(response);
  } catch (error) {
    if (!options?.silent) {
      console.info('[StopLossExtension monitor] server price snapshot fetch exception', error);
    }
    return {};
  }
}

async function loadMonitorState() {
  const storage = await chrome.storage.local.get([
    'floatingMonitorState',
    SELECTED_TRADER_ID_STORAGE_KEY,
    SELECTED_TRADER_NAME_STORAGE_KEY,
  ]);
  const state = storage?.floatingMonitorState ?? {};

  monitorPlans = Array.isArray(state?.plans) ? state.plans : [];
  monitorCurrentTicker = normalizeTicker(state?.currentTicker);
  monitorViewMode = state?.[MONITOR_VIEW_MODE_KEY] === MONITOR_VIEW_MODE_MINIMAL
    ? MONITOR_VIEW_MODE_MINIMAL
    : MONITOR_VIEW_MODE_FULL;
  monitorTraderId = String(
    state?.currentTraderId ??
    storage?.[SELECTED_TRADER_ID_STORAGE_KEY] ??
    '',
  ).trim();
  const stateTraderName = String(state?.currentTraderName ?? '').trim();
  const storedTraderName = String(storage?.[SELECTED_TRADER_NAME_STORAGE_KEY] ?? '').trim();
  monitorTraderName = stateTraderName || storedTraderName;

  syncSelectedTraderLabel();
  applyViewMode();
  renderPlans();
  void hydrateTraderNameFromServer();
}

function getTraderDisplayName(trader) {
  return String(trader?.name ?? trader?.email ?? trader?.externalUserId ?? '').trim();
}

function looksLikeFallbackTraderLabel(value) {
  return /^\d+$/.test(String(value ?? '').trim());
}

async function hydrateTraderNameFromServer() {
  if (!monitorTraderId) {
    return false;
  }

  if (monitorTraderName && !looksLikeFallbackTraderLabel(monitorTraderName)) {
    return true;
  }

  try {
    const response = await chrome.runtime.sendMessage({ type: 'FETCH_TRADERS' });
    if (!response?.ok) {
      return false;
    }

    const traders = Array.isArray(response?.data) ? response.data : [];
    const trader = traders.find((entry) => String(entry?.id ?? '').trim() === monitorTraderId);
    const traderName = getTraderDisplayName(trader);

    if (!traderName) {
      return false;
    }

    monitorTraderName = traderName;
    syncSelectedTraderLabel();
    renderPlans();

    const storage = await chrome.storage.local.get(['floatingMonitorState']);
    const currentState = storage?.floatingMonitorState ?? {};

    await chrome.storage.local.set({
      [SELECTED_TRADER_NAME_STORAGE_KEY]: traderName,
      floatingMonitorState: {
        ...currentState,
        currentTraderId: monitorTraderId,
        currentTraderName: traderName,
      },
    });

    return true;
  } catch (error) {
    console.info('[StopLossExtension monitor] hydrateTraderNameFromServer failed', error);
    return false;
  }
}

async function loadMonitorPlansFromStorage(options = {}) {
  try {
    await loadMonitorState();
    return true;
  } catch (error) {
    console.error('[StopLossExtension monitor] loadMonitorPlansFromStorage exception', error);
    if (!options?.silent) {
      syncLastUpdatedLabel('Failed to load local monitors');
    }
    return false;
  }
}

async function syncMonitorPlansFromServer(options = {}) {
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'FETCH_MONITORING_PLANS',
    });

    if (!response?.ok) {
      if (!options?.silent) {
        syncLastUpdatedLabel(response?.error ?? 'Failed to load active monitors');
      }
      return false;
    }

    return loadMonitorPlansFromStorage(options);
  } catch (error) {
    console.error('[StopLossExtension monitor] syncMonitorPlansFromServer exception', error);
    if (!options?.silent) {
      syncLastUpdatedLabel('Failed to sync active monitors');
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

    const refreshResponse = await chrome.runtime.sendMessage({ type: 'REFRESH_PRICES' });

    backgroundPriceMap = refreshResponse?.data?.prices ?? {};
    if (Object.keys(backgroundPriceMap).length > 0) {
      console.info('[StopLossExtension monitor] refreshPrices background result', {
        tickers: Object.keys(backgroundPriceMap),
        updatedAt: refreshResponse?.data?.updatedAt ?? null,
      });
      applyPrices(backgroundPriceMap);
    }

    const serverPriceMap = await fetchServerPriceMap({ silent: options?.silent });
    const storedPrices = await readStoredPrices();
    const mergedPrices = mergePriceMaps(
      backgroundPriceMap,
      mergePriceMaps(serverPriceMap, storedPrices),
    );

    console.info('[StopLossExtension monitor] refreshPrices apply', {
      appliedTickers: Object.keys(mergedPrices),
      refreshOk: Boolean(refreshResponse?.ok),
      serverTickers: Object.keys(serverPriceMap),
    });

    applyPrices(mergedPrices);
  } catch (error) {
    console.error('[StopLossExtension monitor] refreshPrices exception', error);
    if (!options?.silent) {
      syncLastUpdatedLabel('Failed to refresh prices');
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
    return;
  }

  if (changes?.[SELECTED_TRADER_ID_STORAGE_KEY] || changes?.[SELECTED_TRADER_NAME_STORAGE_KEY]) {
    void loadMonitorState();
  }
});

refreshButton?.addEventListener('click', () => {
  console.info('[StopLossExtension monitor] Refresh prices button clicked');
  void refreshPrices();
});

monitorTableBody?.addEventListener('click', (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }

  const button = target.closest('[data-action="place-saved-order"]');
  const doneButton = target.closest('[data-action="mark-saved-order-done"]');
  const actionButton =
    button instanceof HTMLButtonElement
      ? button
      : doneButton instanceof HTMLButtonElement
        ? doneButton
        : null;
  if (!actionButton) {
    return;
  }

  const index = Number(actionButton.dataset.planIndex);
  const plan = monitorPlans[index];
  const ticker = normalizeTicker(plan?.instrument?.ticker);
  const entry = getStoredPriceEntryForTicker(ticker, latestPriceMap);
  const price = entry?.ok ? Number(entry.price) : null;

  if (!plan || typeof price !== 'number' || !Number.isFinite(price)) {
    return;
  }

  if (actionButton.dataset.action === 'mark-saved-order-done') {
    void markSavedOrderDone(plan, price);
    return;
  }

  void placeSavedOrder(plan, price);
});

syncMonitorPlansButton?.addEventListener('click', async () => {
  syncMonitorPlansButton.disabled = true;
  syncMonitorPlansButton.textContent = 'Syncing...';
  await syncMonitorPlansFromServer();
  syncMonitorPlansButton.disabled = false;
  syncMonitorPlansButton.textContent = 'Sync monitors';
});

toggleViewButton?.addEventListener('click', () => {
  monitorViewMode =
    monitorViewMode === MONITOR_VIEW_MODE_MINIMAL
      ? MONITOR_VIEW_MODE_FULL
      : MONITOR_VIEW_MODE_MINIMAL;
  applyViewMode();
  void persistViewMode();
});

toggleCompactViewButton?.addEventListener('click', () => {
  monitorViewMode = MONITOR_VIEW_MODE_FULL;
  applyViewMode();
  void persistViewMode();
});

window.addEventListener('beforeunload', () => {
  if (refreshIntervalId) {
    window.clearInterval(refreshIntervalId);
  }
});

void loadMonitorState().then(async () => {
  applyPrices(await readStoredPrices());
  await loadMonitorPlansFromStorage({ silent: true });
  applyPrices(await fetchServerPriceMap({ silent: true }));
  void refreshPrices({ silent: true });
  refreshIntervalId = window.setInterval(() => {
    void refreshPrices({ silent: true });
  }, 60000);
});


