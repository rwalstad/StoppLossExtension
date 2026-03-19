(function () {
  const DASHBOARD_URL = 'https://trading.just4us.no/dashboard';
  const CONTAINER_ID = 'stoploss-import-container';
  const TOGGLE_ID = 'stoploss-import-toggle';
  const PANEL_ID = 'stoploss-import-panel';
  const BUTTON_ID = 'stoploss-import-button';
  const STATUS_ID = 'stoploss-import-status';
  const TRADER_STORAGE_KEY = 'stoploss-selected-trader-id';
  const TRADER_NAME_STORAGE_KEY = 'stoploss-selected-trader-name';
  const UI_POSITION_STORAGE_KEY = 'stoploss-import-ui-position';
  const ACTION_MODE_IMPORT = 'import';
  const ACTION_MODE_STOP_LOSS = 'stop-loss';
  const ACTION_MODE_DEFINE_STOP_LOSS = 'define-stop-loss';
  const ACTION_MODE_SELL_ORDER = 'sell-order';
  const ACTION_MODE_BUY_ORDER = 'buy-order';
  const ACTION_MODE_MONITORING = 'monitoring';
  const EXTENSION_VERSION = chrome.runtime.getManifest().version;
  let lastReportedPriceSnapshotKey = '';
  let lastReportedPriceSnapshotSavedAt = '';
  function debugLog(step, details) {
    console.info(`[StopLossExtension ${EXTENSION_VERSION}] ${step}`, details);
  }

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
      return 'The extension was updated or reloaded on this tab. Reload the Nordnet page, then try again.';
    }

    return message || fallbackMessage;
  }

  async function sendRuntimeMessage(message, fallbackMessage) {
    try {
      return await chrome.runtime.sendMessage(message);
    } catch (error) {
      throw new Error(toDisplayError(error, fallbackMessage));
    }
  }
  const STOCK_PATH_PATTERN = /^\/aksjer\/kurser\/.+/i;
  const TRACKER_PATH_PATTERN = /^\/etp\/sertifikat\/trackers\/liste\/.+/i;
  const CERTIFICATE_PATH_PATTERN = /^\/etp\/sertifikat\/[^/]+\/liste\/.+/i;
  const MARKET_CURRENCY_MAP = {
    XOSL: 'NOK',
    XSTO: 'SEK',
    XCSE: 'DKK',
    XHEL: 'EUR',
    XICE: 'ISK',
    XETA: 'EUR',
  };

  function isSupportedInstrumentPage() {
    return STOCK_PATH_PATTERN.test(window.location.pathname) || CERTIFICATE_PATH_PATTERN.test(window.location.pathname);
  }

  function getInstrumentType() {
    if (TRACKER_PATH_PATTERN.test(window.location.pathname)) {
      return 'TRACKER';
    }

    if (CERTIFICATE_PATH_PATTERN.test(window.location.pathname)) {
      return 'TRACKER';
    }

    return 'STOCK';
  }

  function isCertificatePage() {
    return CERTIFICATE_PATH_PATTERN.test(window.location.pathname);
  }

  function isOrderTicketPage() {
    return /\/order\/(?:buy|sell)(?:\/|$)/i.test(window.location.pathname);
  }

  function isSellOrderPage() {
    return /\/order\/sell(?:\/|$)/i.test(window.location.pathname);
  }

  function isBuyOrderPage() {
    return /\/order\/buy(?:\/|$)/i.test(window.location.pathname);
  }

  function getInstrumentPathname() {
    const pathParts = window.location.pathname.split('/').filter(Boolean);
    const orderIndex = pathParts.indexOf('order');
    if (orderIndex > 0) {
      return `/${pathParts.slice(0, orderIndex).join('/')}`;
    }

    return window.location.pathname;
  }

  function slugToWords(value) {
    return value
      .split('-')
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ');
  }

  function parseFromUrl() {
    const slug = getInstrumentPathname().split('/').filter(Boolean).pop() ?? '';
    const parts = slug.split('-').filter(Boolean);

    if (parts.length < 3) {
      return null;
    }

    const marketCode = parts.at(-1)?.toUpperCase() ?? '';
    const ticker = parts.at(-2)?.toUpperCase() ?? '';
    const name = slugToWords(parts.slice(0, -2).join('-'));

    return {
      slug,
      ticker,
      name,
      marketCode,
    };
  }

  function findText(selectors) {
    for (const selector of selectors) {
      const node = document.querySelector(selector);
      const text = node?.textContent?.trim();
      if (text) {
        return text;
      }
    }

    return '';
  }

  function normalizeFactLabel(value) {
    return value.replace(/\s+/g, ' ').replace(/:$/, '').trim().toLowerCase();
  }

  function compactText(value) {
    return value.replace(/\s+/g, ' ').trim();
  }

  function uniqueTexts(values) {
    const seen = new Set();

    return values.filter((value) => {
      const normalized = compactText(value);
      if (!normalized || seen.has(normalized)) {
        return false;
      }

      seen.add(normalized);
      return true;
    });
  }

  function extractIsin(value) {
    const match = compactText(value).toUpperCase().match(/\b[A-Z]{2}[A-Z0-9]{9}\d\b/);
    return match ? match[0] : '';
  }

  function parseLocaleNumber(value) {
    const text = compactText(value);
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
      // Use the last separator as the decimal marker and strip the other as grouping.
      if (lastCommaIndex > lastDotIndex) {
        normalized = cleaned.replace(/\./g, '').replace(',', '.');
      } else {
        normalized = cleaned.replace(/,/g, '');
      }
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

  function buildDetailsUrl() {
    const url = new URL(window.location.href);
    url.pathname = getInstrumentPathname();
    url.search = '?details';
    return url.toString();
  }

  function parseFactItems(listNode) {
    return [...listNode.querySelectorAll('li')]
      .map((item) => {
        const segments = uniqueTexts(
          [...item.querySelectorAll('span, div, p, strong')]
            .map((node) => node.textContent ?? ''),
        );

        if (segments.length >= 2) {
          return {
            label: normalizeFactLabel(segments[0]),
            value: compactText(segments.slice(1).join(' ')),
          };
        }

        const text = compactText(item.textContent ?? '');
        const match = text.match(/^([^:]+):\s*(.+)$/);
        if (!match) {
          return null;
        }

        return {
          label: normalizeFactLabel(match[1]),
          value: match[2].trim(),
        };
      })
      .filter(Boolean);
  }

  function parseDefinitionFacts(root) {
    return [...root.querySelectorAll('dl')]
      .flatMap((listNode) => {
        const terms = [...listNode.querySelectorAll('dt')];
        const definitions = [...listNode.querySelectorAll('dd')];

        return terms
          .map((termNode, index) => {
            const label = normalizeFactLabel(termNode.textContent ?? '');
            const value = compactText(definitions[index]?.textContent ?? '');

            if (!label || !value) {
              return null;
            }

            return { label, value };
          })
          .filter(Boolean);
      });
  }

  function parseInlineFacts(root) {
    const texts = uniqueTexts(
      [...root.querySelectorAll('#main-content div, #main-content span, main div, main span')]
        .map((node) => node.textContent ?? ''),
    );

    return texts
      .map((text) => {
        const match = compactText(text).match(/^([^:]+):\s*(.+)$/);
        if (!match) {
          return null;
        }

        return {
          label: normalizeFactLabel(match[1]),
          value: compactText(match[2]),
        };
      })
      .filter(Boolean);
  }

  function extractFactsFromDocument(root) {
    const factLists = [
      ...root.querySelectorAll('#main-content ul'),
      ...root.querySelectorAll('main ul'),
    ];
    const factCollections = [];

    for (const list of factLists) {
      const facts = parseFactItems(list);
      if (facts.some((fact) => /isin/.test(fact.label))) {
        return facts;
      }

      if (facts.length) {
        factCollections.push(...facts);
      }
    }

    const definitionFacts = parseDefinitionFacts(root);
    if (definitionFacts.some((fact) => /isin/.test(fact.label))) {
      return definitionFacts;
    }

    const inlineFacts = parseInlineFacts(root);
    if (inlineFacts.some((fact) => /isin/.test(fact.label))) {
      return inlineFacts;
    }

    const pageText = compactText(root.body?.textContent ?? root.textContent ?? '');
    const pageIsin = extractIsin(pageText);
    if (pageIsin) {
      return [
        ...factCollections,
        ...definitionFacts,
        ...inlineFacts,
        {
          label: 'isin',
          value: pageIsin,
        },
      ];
    }

    return [...factCollections, ...definitionFacts, ...inlineFacts];
  }

  function getFactValue(facts, labels) {
    for (const fact of facts) {
      if (labels.some((label) => fact.label === label || fact.label.includes(label))) {
        if (labels.includes('isin')) {
          return extractIsin(fact.value);
        }

        return fact.value;
      }
    }

    return '';
  }

  async function fetchDetailsFacts() {
    const detailsUrl = buildDetailsUrl();
    debugLog('Fetching details facts', { detailsUrl });
    const response = await fetch(detailsUrl, {
      method: 'GET',
      credentials: 'include',
      cache: 'no-store',
    });

    if (!response.ok) {
      throw new Error(`Failed to load Nordnet details page (${response.status}).`);
    }

    const html = await response.text();
    const parser = new DOMParser();
    const detailsDocument = parser.parseFromString(html, 'text/html');
    const facts = extractFactsFromDocument(detailsDocument);
    debugLog('Fetched details facts', { count: facts.length, facts });
    return facts;
  }

  function getHeaderTarget() {
    return (
      document.querySelector('#main-content header') ||
      document.querySelector('main header') ||
      document.querySelector('#main-content')
    );
  }

  function getMarketLabel() {
    const root = [...document.querySelectorAll('h3, span, div')].find(
      (node) => node.textContent?.trim() === 'Ordredybde',
    );

    if (!root) {
      return '';
    }

    const card = root.closest('div');
    if (!card) {
      return '';
    }

    const marketTexts = uniqueTexts(
      [...card.querySelectorAll('span, div, p')]
        .map((node) => node.textContent ?? '')
        .map((value) => compactText(value))
        .filter((value) => value && value !== 'Ordredybde'),
    );

    const combinedMarket = marketTexts.find((value) => /\b[A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)*\b/.test(value));
    if (!combinedMarket) {
      return '';
    }

    const parts = combinedMarket.split(/\s+/).filter(Boolean);
    return parts.at(-1) ?? combinedMarket;
  }

  function findMetricValueByLabel(labelPattern) {
    const candidates = [...document.querySelectorAll('div, section, article, li')];

    for (const node of candidates) {
      const texts = uniqueTexts(
        [...node.querySelectorAll('span, div, p, dt, dd')]
          .map((child) => child.textContent ?? '')
          .map((value) => compactText(value))
          .filter(Boolean),
      );

      if (texts.length < 2 || !labelPattern.test(texts[0])) {
        continue;
      }

      const value = texts
        .slice(1)
        .find((text) => parseLocaleNumber(text) !== null || /\b[A-Z]{3}\b/.test(text.toUpperCase()));

      if (value) {
        return value;
      }
    }

    return '';
  }

  function extractCurrencyFromPrice() {
    const priceText = findText([
      '#main-content h1 + div',
      '#main-content [data-testid="instrument-price"]',
      '#main-content [class*="InstrumentPrice-styles__CurrencyTypography"]',
      'main [class*="InstrumentPrice-styles__CurrencyTypography"]',
      'main h1 + div',
    ]);
    const fallbackPriceText = priceText || findMetricValueByLabel(/^siste$/i);
    const match = compactText(fallbackPriceText).toUpperCase().match(/\b([A-Z]{3})\b/);
    return match ? match[1] : '';
  }

  function extractCurrentMarketPrice() {
    const selectorPriceText = findText([
      '#main-content [data-testid="instrument-price"]',
      '#main-content [class*="InstrumentPrice-styles__CurrentPriceTypography"]',
      '#main-content h1 + div',
      'main [data-testid="instrument-price"]',
      'main [class*="InstrumentPrice-styles__CurrentPriceTypography"]',
      'main h1 + div',
    ]);
    const metricPriceText = findMetricValueByLabel(/^siste$/i);
    const priceText = selectorPriceText || metricPriceText;

    return {
      value: parseLocaleNumber(priceText),
      text: priceText,
    };
  }

  function resolveCurrentMarketPrice(orderForm = null) {
    const currentMarketPrice = extractCurrentMarketPrice();
    if (currentMarketPrice.value !== null || currentMarketPrice.text) {
      return currentMarketPrice;
    }

    if (orderForm?.price && orderForm.price > 0) {
      return {
        value: orderForm.price,
        text: orderForm.priceText || String(orderForm.price),
      };
    }

    return currentMarketPrice;
  }

  function normalizeCurrencyCode(value) {
    const match = compactText(value).toUpperCase().match(/\b([A-Z]{3})\b/);
    return match ? match[1] : '';
  }

  function collectAlarmFactsFromText(root) {
    return [...root.querySelectorAll('div, span, p, li, dt, dd')]
      .map((node) => compactText(node.textContent ?? ''))
      .filter(Boolean);
  }

  function findAlarmValue(labelPattern) {
    const texts = collectAlarmFactsFromText(document);

    for (let index = 0; index < texts.length; index += 1) {
      const value = texts[index];
      if (!labelPattern.test(value)) {
        continue;
      }

      const nextValue = texts[index + 1] ?? '';
      if (nextValue) {
        return nextValue;
      }
    }

    return '';
  }

  function extractAlarmPayload() {
    const statusTexts = collectAlarmFactsFromText(document);
    const hasAlarmContext = statusTexts.some((text) => /kursalarm/i.test(text));
    if (!hasAlarmContext) {
      return null;
    }

    const stopLossValue =
      findAlarmValue(/^varslingskurs$/i) ||
      findAlarmValue(/^kurs under$/i);
    const instrumentName =
      findAlarmValue(/^instrument$/i) ||
      findText(['[role="dialog"] h1', '[role="dialog"] h2']);
    const conditionText = findAlarmValue(/^vilkår$/i) || findAlarmValue(/^kurs under$/i);
    const price = parseLocaleNumber(stopLossValue);

    if (price === null) {
      return null;
    }

    return {
      instrumentName,
      stopLossPrice: price,
      stopLossPriceText: stopLossValue,
      conditionText,
    };
  }

  function readInputValue(selector) {
    const input = document.querySelector(selector);
    if (!(input instanceof HTMLInputElement || input instanceof HTMLSelectElement)) {
      return '';
    }

    return compactText(input.value ?? '');
  }

  function readButtonLabel(selector, prefixPattern) {
    const button = document.querySelector(selector);
    if (!(button instanceof HTMLElement)) {
      return '';
    }

    const ariaLabel = compactText(button.getAttribute('aria-label') ?? '');
    if (ariaLabel) {
      return prefixPattern ? ariaLabel.replace(prefixPattern, '').trim() : ariaLabel;
    }

    const text = compactText(button.textContent ?? '');
    return prefixPattern ? text.replace(prefixPattern, '').trim() : text;
  }

  function readFormattedNumberField(inputId) {
    const input = document.getElementById(inputId);
    if (!(input instanceof HTMLInputElement)) {
      return {
        text: '',
        numericText: '',
        value: null,
      };
    }

    const wrapper = input.closest('div');
    const hiddenInput = wrapper?.querySelector('input[type="hidden"]');
    const text = compactText(input.value ?? '');
    const numericText =
      hiddenInput instanceof HTMLInputElement ? compactText(hiddenInput.value ?? '') : text;

    return {
      text,
      numericText,
      value: parseLocaleNumber(numericText || text),
    };
  }

  function extractOrderForm() {
    if (!isOrderTicketPage()) {
      return null;
    }

    const quantityField = readFormattedNumberField('quantity');
    const priceField = readFormattedNumberField('price');

    return {
      side: isSellOrderPage() ? 'SELL' : isBuyOrderPage() ? 'BUY' : '',
      accountLabel: readButtonLabel('#instrument-trading-account-selector', /^konto:\s*/i),
      orderTypeLabel: readButtonLabel('#orderType', /^ordretype:\s*/i),
      validUntilLabel: readButtonLabel('#validUntil', /^gyldig til og med:\s*/i),
      quantityText: quantityField.text,
      priceText: priceField.text,
      quantity: quantityField.value,
      price: priceField.value,
    };
  }

  async function collectStockPayload() {
    debugLog('Collecting stock payload', {
      href: window.location.href,
      pathname: window.location.pathname,
    });
    const parsed = parseFromUrl();
    if (!parsed) {
      debugLog('Could not parse instrument slug', { href: window.location.href });
      return {
        ok: false,
        error: 'Could not parse the instrument slug from the current URL.',
      };
    }

    const headerName = findText([
      '#main-content > div > div.CssGrid__RawCssGridItem-sc-bu5cxy-1.CssGrid___StyledRawCssGridItem-sc-bu5cxy-2.YxFRW.bMFOJZ > div > div > header > div > div > div.flex.flex-row.items-end.justify-between > div.flex.flex-col.gap-1 > div.hidden.md\\:block > div',
      '#main-content header .hidden.md\\:block div',
      'h1',
    ]);
    const marketLabel = getMarketLabel();
    let facts = extractFactsFromDocument(document);
    const currentIsin = getFactValue(facts, ['isin']).toUpperCase();
    const currentProductName = getFactValue(facts, ['navn']);
    debugLog('Initial page extraction', {
      parsed,
      headerName,
      marketLabel,
      factsCount: facts.length,
      currentIsin,
      currentProductName,
    });

    if (!facts.length || !currentIsin || !currentProductName) {
      try {
        facts = await fetchDetailsFacts();
      } catch (_error) {
        // Keep the already extracted facts from the current document if details lookup fails.
        debugLog('Details fact fetch failed', { href: window.location.href });
      }
    }

    const isin = getFactValue(facts, ['isin']).toUpperCase();
    const productName = getFactValue(facts, ['navn']);
    const factCurrency = normalizeCurrencyCode(getFactValue(facts, ['handles i']));
    const orderForm = extractOrderForm();
    const currentMarketPrice = resolveCurrentMarketPrice(orderForm);
    const priceCurrency = extractCurrencyFromPrice() || normalizeCurrencyCode(orderForm?.priceText ?? '');
    const fallbackCurrency = MARKET_CURRENCY_MAP[parsed.marketCode] || 'NOK';
    const tradedCurrency = factCurrency || priceCurrency || fallbackCurrency;

    const payload = {
      ticker: parsed.ticker,
      name: productName || headerName || parsed.name,
      market: marketLabel || parsed.marketCode,
      marketCode: parsed.marketCode,
      currency: tradedCurrency,
      currentPrice: currentMarketPrice.value ?? undefined,
      currentPriceText: currentMarketPrice.text || undefined,
      isin: isin || undefined,
      type: getInstrumentType(),
      sourceUrl: isCertificatePage() ? window.location.href : buildDetailsUrl(),
    };

    debugLog('Built stock payload', {
      parsed,
      factCurrency,
      priceCurrency,
      currentMarketPrice,
      fallbackCurrency,
      payload,
      facts,
    });

    return {
      ok: true,
      payload,
    };
  }

  async function isDashboardAvailable() {
    try {
      const response = await sendRuntimeMessage({
        type: 'CHECK_DASHBOARD',
      }, 'Could not reach the StopLoss extension background worker.');
      return Boolean(response?.ok);
    } catch (_error) {
      return false;
    }
  }

  function readSelectedTraderId() {
    try {
      return window.localStorage.getItem(TRADER_STORAGE_KEY) ?? '';
    } catch (_error) {
      return '';
    }
  }

  function writeSelectedTraderId(traderId) {
    try {
      if (traderId) {
        window.localStorage.setItem(TRADER_STORAGE_KEY, traderId);
        chrome.storage.local.set({
          [TRADER_STORAGE_KEY]: traderId,
        });
      } else {
        window.localStorage.removeItem(TRADER_STORAGE_KEY);
        chrome.storage.local.remove(TRADER_STORAGE_KEY);
      }
    } catch (_error) {
      // Ignore storage failures and continue with the current page state.
    }
  }

  function writeSelectedTraderSelection(traderId, traderName = '') {
    writeSelectedTraderId(traderId);

    try {
      if (traderName) {
        window.localStorage.setItem(TRADER_NAME_STORAGE_KEY, traderName);
        chrome.storage.local.set({
          [TRADER_NAME_STORAGE_KEY]: traderName,
        });
      } else {
        window.localStorage.removeItem(TRADER_NAME_STORAGE_KEY);
        chrome.storage.local.remove(TRADER_NAME_STORAGE_KEY);
      }
    } catch (_error) {
      // Ignore storage failures and continue with the current page state.
    }
  }

  function readUiPosition() {
    try {
      const rawValue = window.localStorage.getItem(UI_POSITION_STORAGE_KEY);
      if (!rawValue) {
        return null;
      }

      const parsedValue = JSON.parse(rawValue);
      if (!Number.isFinite(parsedValue?.top) || !Number.isFinite(parsedValue?.left)) {
        return null;
      }

      return {
        top: parsedValue.top,
        left: parsedValue.left,
      };
    } catch (_error) {
      return null;
    }
  }

  function writeUiPosition(position) {
    try {
      if (!position || !Number.isFinite(position.top) || !Number.isFinite(position.left)) {
        window.localStorage.removeItem(UI_POSITION_STORAGE_KEY);
        return;
      }

      window.localStorage.setItem(UI_POSITION_STORAGE_KEY, JSON.stringify(position));
    } catch (_error) {
      // Ignore storage failures and continue with the current page state.
    }
  }

  function clampUiPosition(top, left, width, height) {
    const margin = 8;
    const maxTop = Math.max(margin, window.innerHeight - height - margin);
    const maxLeft = Math.max(margin, window.innerWidth - width - margin);

    return {
      top: Math.min(Math.max(margin, top), maxTop),
      left: Math.min(Math.max(margin, left), maxLeft),
    };
  }

  function applyUiPosition(container, position) {
    container.style.top = `${position.top}px`;
    container.style.left = `${position.left}px`;
    container.style.right = 'auto';
    container.style.bottom = 'auto';
  }

  function clampAndApplyCurrentUiPosition(container, preferredPosition = null) {
    const fallbackPosition = preferredPosition || readUiPosition() || getDefaultUiPosition();
    const rect = container.getBoundingClientRect();
    const clampedPosition = clampUiPosition(
      fallbackPosition.top,
      fallbackPosition.left,
      rect.width || 200,
      rect.height || 44,
    );
    applyUiPosition(container, clampedPosition);
    writeUiPosition(clampedPosition);
    return clampedPosition;
  }

  function getDefaultUiPosition() {
    return clampUiPosition(12, Math.max(8, window.innerWidth - 220), 200, 44);
  }

  function attachDragBehavior(container, handles) {
    let dragState = null;
    let suppressNextClick = false;

    function stopDrag() {
      if (!dragState) {
        return;
      }

      const finalPosition = clampUiPosition(
        dragState.top,
        dragState.left,
        dragState.width,
        dragState.height,
      );
      applyUiPosition(container, finalPosition);
      writeUiPosition(finalPosition);
      suppressNextClick = dragState.moved;
      dragState = null;
      document.body.style.userSelect = '';
    }

    function onPointerMove(event) {
      if (!dragState) {
        return;
      }

      dragState.moved =
        dragState.moved ||
        Math.abs(event.clientX - dragState.pointerStartX) > 4 ||
        Math.abs(event.clientY - dragState.pointerStartY) > 4;

      const nextPosition = clampUiPosition(
        dragState.startTop + (event.clientY - dragState.pointerStartY),
        dragState.startLeft + (event.clientX - dragState.pointerStartX),
        dragState.width,
        dragState.height,
      );

      dragState.top = nextPosition.top;
      dragState.left = nextPosition.left;
      applyUiPosition(container, nextPosition);
    }

    function onPointerUp(event) {
      const pointerId = dragState?.pointerId;
      stopDrag();
      if (pointerId != null) {
        event.currentTarget?.releasePointerCapture?.(pointerId);
      }
    }

    for (const handle of handles) {
      handle.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) {
          return;
        }

        const rect = container.getBoundingClientRect();
        dragState = {
          pointerId: event.pointerId,
          pointerStartX: event.clientX,
          pointerStartY: event.clientY,
          startTop: rect.top,
          startLeft: rect.left,
          top: rect.top,
          left: rect.left,
          width: rect.width,
          height: rect.height,
          moved: false,
        };
        handle.setPointerCapture?.(event.pointerId);
        document.body.style.userSelect = 'none';
      });

      handle.addEventListener('pointermove', onPointerMove);
      handle.addEventListener('pointerup', onPointerUp);
      handle.addEventListener('pointercancel', stopDrag);
    }

    return {
      consumeSuppressedClick() {
        if (!suppressNextClick) {
          return false;
        }

        suppressNextClick = false;
        return true;
      },
    };
  }

  function getTraderLabel(trader) {
    if (!trader) {
      return '';
    }

    return trader.name || trader.email || trader.externalUserId || `Trader ${trader.id}`;
  }

  function getOwnerLabel(instrument) {
    if (!instrument?.owner) {
      return '';
    }

    return getTraderLabel({
      id: instrument.owner.id != null ? String(instrument.owner.id) : '',
      name: instrument.owner.name ?? null,
      email: instrument.owner.email ?? null,
      externalUserId: instrument.owner.externalUserId ?? '',
    });
  }

  function setBadgeState(toggle, text, background) {
    toggle.textContent = text;
    toggle.style.background = background;
  }

  function setStatusMessage(status, message, tone = 'info') {
    const toneColors = {
      info: '#486581',
      success: '#1f7a1f',
      warning: '#b45309',
      error: '#d64545',
    };

    status.style.color = toneColors[tone] || toneColors.info;
    status.textContent = message;
  }

  function formatHoldingSummary(holdingSummary) {
    if (!holdingSummary || holdingSummary.openPositionCount <= 0) {
      return 'No open holdings recorded.';
    }

    const ownerQuantity =
      holdingSummary.ownerQuantity > 0 ? ` Owner holding: ${holdingSummary.ownerQuantity}.` : '';
    return `Open holdings: ${holdingSummary.totalQuantity} shares across ${holdingSummary.openPositionCount} position(s).${ownerQuantity}`;
  }

  function formatStopLossValue(holdingSummary) {
    const stopLossRules = Array.isArray(holdingSummary?.stopLossRules) ? holdingSummary.stopLossRules : [];
    if (stopLossRules.length === 0) {
      return 'None';
    }

    return stopLossRules
      .map((rule) => {
        const statusText = rule?.isEnabled === false ? 'disabled' : 'enabled';
        const quantityText =
          Number.isFinite(Number(rule?.quantity)) && Number(rule.quantity) > 0
            ? ` for ${rule.quantity} share${Number(rule.quantity) === 1 ? '' : 's'}`
            : '';
        return `${rule.stopLossPrice}${quantityText} (${statusText})`;
      })
      .join('; ');
  }

  function appendHoldingDetails(message, holdingSummary) {
    return `${message}\n${formatExistingInstrumentDetails(holdingSummary)}`;
  }

  function formatLastTradeValue(holdingSummary) {
    const tradedAt = holdingSummary?.lastTrade?.tradedAt;
    if (!tradedAt) {
      return 'No trades';
    }

    const parsedDate = new Date(tradedAt);
    return Number.isNaN(parsedDate.getTime()) ? 'No trades' : parsedDate.toLocaleString();
  }

  function formatQuantityLabel(quantity) {
    const numericQuantity = Number(quantity);
    if (!Number.isFinite(numericQuantity) || numericQuantity <= 0) {
      return '';
    }

    return ` for ${numericQuantity} share${numericQuantity === 1 ? '' : 's'}`;
  }

  function formatActiveMonitoringValue(holdingSummary) {
    const activeMonitoringPlan = holdingSummary?.activeMonitoringPlan;
    if (!activeMonitoringPlan?.triggerPrice) {
      return 'None';
    }

    return `${activeMonitoringPlan.triggerPrice}${formatQuantityLabel(activeMonitoringPlan.quantity)}`;
  }

  function formatStoredTargetPriceValue(holdingSummary) {
    const pendingOrderPrice = holdingSummary?.activeMonitoringPlan?.pendingOrderPrice;
    if (pendingOrderPrice === null || pendingOrderPrice === undefined || pendingOrderPrice === '') {
      return null;
    }

    return String(pendingOrderPrice);
  }

  function getRelevantOpenQuantity(holdingSummary) {
    if (Number.isFinite(Number(holdingSummary?.selectedTraderQuantity))) {
      return Number(holdingSummary.selectedTraderQuantity);
    }

    if (Number.isFinite(Number(holdingSummary?.totalQuantity))) {
      return Number(holdingSummary.totalQuantity);
    }

    return 0;
  }

  function getRelevantOpenPositionCount(holdingSummary) {
    if (Number.isFinite(Number(holdingSummary?.selectedTraderOpenPositionCount))) {
      return Number(holdingSummary.selectedTraderOpenPositionCount);
    }

    if (Number.isFinite(Number(holdingSummary?.openPositionCount))) {
      return Number(holdingSummary.openPositionCount);
    }

    return 0;
  }

  function formatExistingInstrumentDetails(holdingSummary) {
    const openQuantity = getRelevantOpenQuantity(holdingSummary);
    const detailLines = [
      `Open quantity: ${openQuantity}`,
      `Current stop loss: ${formatStopLossValue(holdingSummary)}`,
      `Last trade: ${formatLastTradeValue(holdingSummary)}`,
    ];
    const activeMonitoringValue = formatActiveMonitoringValue(holdingSummary);
    if (activeMonitoringValue !== 'None') {
      detailLines.splice(1, 0, `Current monitoring: ${activeMonitoringValue}`);
      const storedTargetPriceValue = formatStoredTargetPriceValue(holdingSummary);
      if (storedTargetPriceValue) {
        detailLines.splice(2, 0, `Price last order: ${storedTargetPriceValue}`);
      }
    }

    return detailLines.join('\n');
  }

  function buildActiveMonitoringLabel(holdingSummary) {
    const activeMonitoringValue = formatActiveMonitoringValue(holdingSummary);
    if (activeMonitoringValue === 'None') {
      return null;
    }

    return `Current monitoring:\n${activeMonitoringValue}`;
  }

  function buildBuyReadyLabel(holdingSummary) {
    const triggerPrice = holdingSummary?.activeMonitoringPlan?.triggerPrice;
    if (!triggerPrice) {
      return 'Buy Ready';
    }

    return `Trigger defined: ${triggerPrice}`;
  }

  function applyExistingInstrumentState(toggle, button, status, traderLabel, instrument, holdingSummary) {
    const ownerLabel = getOwnerLabel(instrument);
    setBadgeState(toggle, 'In StockTrade', '#486581');
    button.dataset.actionMode = ACTION_MODE_IMPORT;
    button.dataset.importIntent = 'update';
    button.textContent = 'Update stock';
    button.disabled = false;
    button.style.cursor = 'pointer';
    button.style.background = '#486581';
    setStatusMessage(status, formatExistingInstrumentDetails(holdingSummary));

    if (ownerLabel) {
      traderLabel.textContent = `Trader: ${ownerLabel}`;
    }
  }

  async function fetchTraders() {
    const response = await sendRuntimeMessage({
      type: 'FETCH_TRADERS',
    }, 'Failed to load traders.');

    if (!response?.ok) {
      throw new Error(response?.error ?? 'Failed to load traders.');
    }

    return Array.isArray(response.data) ? response.data : [];
  }

  function applyImportableState(toggle, button, status) {
    setBadgeState(toggle, 'Not In StockTrade', '#0f8b8d');
    button.dataset.actionMode = ACTION_MODE_IMPORT;
    button.dataset.importIntent = 'import';
    button.disabled = false;
    button.style.cursor = 'pointer';
    button.style.background = '#0f8b8d';
    button.textContent = 'Import stock';
    setStatusMessage(status, 'Ready to import.');

  }

    function applyLookupErrorState(toggle, button, status, message) {
      setBadgeState(toggle, 'Check Failed', '#d64545');
      button.disabled = false;
      button.style.cursor = 'pointer';
      button.style.background = '#d64545';
      button.textContent = 'Retry StockTrade Check';
      setStatusMessage(status, message || 'Could not verify instrument status in StockTrade.', 'error');
    }

    function applyStopLossSavedState(toggle, button) {
      setBadgeState(toggle, 'Monitoring Active', '#1f7a1f');
      button.disabled = true;
      button.style.cursor = 'default';
      button.style.background = '#1f7a1f';
      button.textContent = 'Stop Loss Saved';
    }

    function applyBuyMonitoringSavedState(toggle, button) {
      setBadgeState(toggle, 'Buy Monitor Saved', '#1f7a1f');
      button.disabled = true;
      button.style.cursor = 'default';
      button.style.background = '#1f7a1f';
      button.textContent = 'Buy Monitor Saved';
    }

  async function lookupExistingInstrument(payload, traderId = '') {
    return sendRuntimeMessage({
      type: 'CHECK_INSTRUMENT_EXISTS',
      payload: {
        ...payload,
        traderId: traderId || undefined,
      },
    }, 'Could not verify instrument status in StockTrade.');
  }

  async function fetchTraderHoldings(traderId) {
    return sendRuntimeMessage({
      type: 'FETCH_TRADER_INSTRUMENTS',
      traderId,
    }, 'Could not load trader holdings.');
  }

  async function saveStopLossRule(positionId, payload) {
    return sendRuntimeMessage({
      type: 'SAVE_STOP_LOSS_RULE',
      positionId,
      payload,
    }, 'Failed to save stop loss rule.');
  }

  async function createVirtualStopLoss(payload) {
    return sendRuntimeMessage({
      type: 'CREATE_VIRTUAL_STOP_LOSS',
      payload,
    }, 'Failed to create virtual stop loss.');
  }

  async function savePendingSellOrder(positionId, payload) {
    debugLog('Saving pending sell order', {
      positionId,
      payload,
    });
    return sendRuntimeMessage({
      type: 'SAVE_PENDING_SELL_ORDER',
      positionId,
      payload,
    }, 'Failed to save pending sell order.');
  }

  async function savePendingBuyOrder(payload) {
    debugLog('Saving pending buy order', {
      payload,
    });
    return sendRuntimeMessage({
      type: 'SAVE_PENDING_BUY_ORDER',
      payload,
    }, 'Failed to save pending buy order.');
  }

  async function saveMonitoringPlan(payload) {
    debugLog('Saving monitoring plan', {
      payload,
    });
    return sendRuntimeMessage({
      type: 'SAVE_MONITORING_PLAN',
      payload,
    }, 'Failed to save monitoring plan.');
  }

  async function saveInstrumentPriceSnapshot(payload) {
    debugLog('Saving instrument price snapshot', {
      payload,
    });
    return sendRuntimeMessage({
      type: 'SAVE_INSTRUMENT_PRICE_SNAPSHOT',
      payload,
    }, 'Failed to save price snapshot.');
  }

  function buildPriceSnapshotKey(payload) {
    const ticker = String(payload?.ticker ?? '').trim().toUpperCase();
    const isin = String(payload?.isin ?? '').trim().toUpperCase();
    const market = String(payload?.marketCode ?? payload?.market ?? '').trim().toUpperCase();
    const currentPrice = Number(payload?.currentPrice);
    const currentPriceText = String(payload?.currentPriceText ?? '').trim();

    if (!ticker || !Number.isFinite(currentPrice) || currentPrice <= 0) {
      return '';
    }

    return [ticker, isin, market, currentPrice.toFixed(4), currentPriceText].join('|');
  }

  async function maybeReportCurrentPriceSnapshot(payload, traderId = '') {
    const snapshotKey = buildPriceSnapshotKey(payload);
    if (!snapshotKey || snapshotKey === lastReportedPriceSnapshotKey) {
      return;
    }

    const response = await saveInstrumentPriceSnapshot({
      ...payload,
      traderId: traderId || undefined,
    });

    if (!response?.ok || !response?.data?.saved) {
      debugLog('Instrument price snapshot not saved', {
        snapshotKey,
        response,
      });
      return;
    }

    lastReportedPriceSnapshotKey = snapshotKey;
    lastReportedPriceSnapshotSavedAt = response.data?.snapshot?.capturedAt ?? new Date().toISOString();
    debugLog('Instrument price snapshot saved', {
      snapshotKey,
      savedAt: lastReportedPriceSnapshotSavedAt,
      snapshotId: response.data?.snapshot?.id ?? null,
    });
  }

  function matchesHoldingInstrument(holding, payload) {
    const instrument = holding?.instrument;
    if (!instrument) {
      return false;
    }

    const sameIsin =
      payload.isin &&
      instrument.isin &&
      String(instrument.isin).toUpperCase() === String(payload.isin).toUpperCase();
    const sameTicker = String(instrument.ticker ?? '').toUpperCase() === String(payload.ticker ?? '').toUpperCase();
    const sameMarket =
      !payload.marketCode ||
      String(instrument.market ?? '').toUpperCase() === String(payload.marketCode).toUpperCase() ||
      String(instrument.market ?? '').toUpperCase() === String(payload.market ?? '').toUpperCase();

    return Boolean(sameIsin || (sameTicker && sameMarket));
  }

  async function resolveStopLossTarget(traderId, payload) {
    const response = await fetchTraderHoldings(traderId);
    if (!response?.ok) {
      return {
        ok: false,
        error: response?.error ?? 'Could not load trader holdings.',
      };
    }

    const holdings = Array.isArray(response.data?.holdings) ? response.data.holdings : [];
    const matches = holdings.filter((holding) => matchesHoldingInstrument(holding, payload));

    if (matches.length === 0) {
      return {
        ok: false,
        error: 'No open holding matched this Nordnet instrument for the selected trader.',
      };
    }

    if (matches.length > 1) {
      return {
        ok: false,
        error: 'Multiple open holdings matched this instrument. Open StockTrade and set the stop loss manually.',
      };
    }

    return {
      ok: true,
      holding: matches[0],
    };
  }

  function buildDefineStopLossLabel(holdingSummary) {
    if (holdingSummary?.openPositionCount > 0) {
      return 'Add StopLoss Rule';
    }

    return 'Define StopLoss';
  }

  function requestStopLossPrice(defaultValue) {
    const defaultText =
      Number.isFinite(defaultValue) && defaultValue !== null ? String(defaultValue) : '';
    const response = window.prompt('Enter the stop-loss price to use in StockTrade.', defaultText);
    if (response === null) {
      return null;
    }

    const parsed = parseLocaleNumber(response);
    if (parsed === null || parsed <= 0) {
      return {
        ok: false,
        error: 'Enter a valid stop-loss price greater than zero.',
      };
    }

    return {
      ok: true,
      value: parsed,
      text: response,
    };
  }

  function requestBuyMonitoringPrice(defaultValue) {
    const defaultText =
      Number.isFinite(defaultValue) && defaultValue !== null ? String(defaultValue) : '';
    const response = window.prompt(
      'Enter the monitoring price for this planned buy in StockTrade. Leave blank to save the buy order without monitoring.',
      defaultText,
    );
    if (response === null) {
      return null;
    }

    if (!response.trim()) {
      return {
        ok: true,
        value: null,
        text: '',
      };
    }

    const parsed = parseLocaleNumber(response);
    if (parsed === null || parsed <= 0) {
      return {
        ok: false,
        error: 'Enter a valid monitoring price greater than zero, or leave the field blank.',
      };
    }

    return {
      ok: true,
      value: parsed,
      text: response,
    };
  }

  function requestQuickMonitoringPlan(defaultValue, currentValue) {
    const priceInput = requestBuyMonitoringPrice(defaultValue);
    if (!priceInput || !priceInput.ok || priceInput.value === null) {
      return priceInput;
    }

    const triggerCondition =
      Number.isFinite(currentValue) && currentValue !== null && priceInput.value > currentValue
        ? 'AT_OR_ABOVE'
        : 'AT_OR_BELOW';

    return {
      ...priceInput,
      triggerCondition,
    };
  }

  async function resolveInstrumentLookup(traderId = '') {
    const attempts = 3;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const payload = await collectStockPayload();
      if (!payload.ok) {
        return {
          payload,
          response: null,
        };
      }

      let response = await lookupExistingInstrument(payload.payload, traderId);

      if (!response?.ok) {
        await new Promise((resolve) => window.setTimeout(resolve, 600));
        response = await lookupExistingInstrument(payload.payload, traderId);
      }

      if (response?.ok && response.data?.exists) {
        return {
          payload,
          response,
        };
      }

      if (attempt < attempts - 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 900));
      } else {
        return {
          payload,
          response,
        };
      }
    }

    return {
      payload: {
        ok: false,
        error: 'Could not determine instrument status.',
      },
      response: null,
    };
  }

  async function refreshButtonState(toggle, button, status, traderLabel, traderId = '') {
    setBadgeState(toggle, 'Checking...', '#1d4f91');
    setStatusMessage(status, 'Checking StockTrade for this instrument...');

    const { payload, response } = await resolveInstrumentLookup(traderId);
    if (!payload.ok) {
      setBadgeState(toggle, 'Visit a ticket', '#d64545');
      button.dataset.actionMode = ACTION_MODE_IMPORT;
      button.dataset.importIntent = 'import';
      button.textContent = 'Import stock';
      setStatusMessage(status, payload.error ?? 'Could not read instrument details from Nordnet.', 'error');
      return;
    }

    const alarmPayload = extractAlarmPayload();
    const orderForm = extractOrderForm();

    if (response?.ok && response.data?.exists) {
      if (orderForm?.side === 'SELL' && traderId) {
        const target = await resolveStopLossTarget(traderId, payload.payload);
        if (target.ok) {
          setBadgeState(toggle, 'Sell Ready', '#b45309');
          button.dataset.actionMode = ACTION_MODE_SELL_ORDER;
          button.disabled = false;
          button.style.cursor = 'pointer';
          button.style.background = '#b45309';
          button.textContent = 'Save Sell Order';
          setStatusMessage(status, `Sell ticket detected${orderForm.accountLabel ? ` for ${orderForm.accountLabel}` : ''}. Quantity ${orderForm.quantityText || '-'}, price ${orderForm.priceText || '-'}${orderForm.validUntilLabel ? `, valid ${orderForm.validUntilLabel}` : ''}.`, 'warning');
          return;
        }

        setBadgeState(toggle, 'Sell Ready', '#b45309');
        button.dataset.actionMode = ACTION_MODE_IMPORT;
        button.disabled = true;
        button.style.cursor = 'default';
        button.style.background = '#b45309';
        button.textContent = 'Sell Order Unavailable';
        setStatusMessage(status, target.error, 'error');
        return;
      }

      if (orderForm?.side === 'SELL' && !traderId) {
        setBadgeState(toggle, 'Sell Ready', '#b45309');
        button.dataset.actionMode = ACTION_MODE_IMPORT;
        button.disabled = true;
        button.style.cursor = 'default';
        button.style.background = '#b45309';
        button.textContent = 'Select Trader';
        setStatusMessage(status, 'Select a trader before saving a sell order.', 'warning');
        return;
      }

      const openPositionCount = getRelevantOpenPositionCount(response.data?.holdingSummary);
      const existingInstrumentDetails = formatExistingInstrumentDetails(response.data?.holdingSummary);

      if (orderForm?.side === 'BUY' && traderId) {
        setBadgeState(toggle, buildBuyReadyLabel(response.data?.holdingSummary), '#1d4f91');
        button.dataset.actionMode = ACTION_MODE_BUY_ORDER;
        button.disabled = false;
        button.style.cursor = 'pointer';
        button.style.background = '#1d4f91';
        button.textContent = 'Save Buy + Monitor';
        setStatusMessage(
          status,
          appendHoldingDetails(
            `Buy ticket detected${orderForm.accountLabel ? ` for ${orderForm.accountLabel}` : ''}. Quantity ${orderForm.quantityText || '-'}, price ${orderForm.priceText || '-'}${orderForm.validUntilLabel ? `, valid ${orderForm.validUntilLabel}` : ''}. StockTrade will save a pending BUY order and can attach a monitoring trigger.`,
            response.data?.holdingSummary,
          ),
          'info',
        );
        return;
      }

      if (orderForm?.side === 'BUY' && !traderId) {
        setBadgeState(toggle, buildBuyReadyLabel(response.data?.holdingSummary), '#1d4f91');
        button.dataset.actionMode = ACTION_MODE_IMPORT;
        button.disabled = true;
        button.style.cursor = 'default';
        button.style.background = '#1d4f91';
        button.textContent = 'Select Trader';
        setStatusMessage(status, 'Select a trader before saving a buy order.', 'warning');
        return;
      }

      if (!isOrderTicketPage() && traderId) {
        const activeMonitoringLabel = buildActiveMonitoringLabel(response.data?.holdingSummary);
        setBadgeState(toggle, activeMonitoringLabel ?? 'Monitor Ready', '#1f7a1f');
        button.dataset.actionMode = ACTION_MODE_MONITORING;
        button.disabled = false;
        button.style.cursor = 'pointer';
        button.style.background = '#1f7a1f';
        button.textContent = activeMonitoringLabel ?? 'Quick Monitor';
        setStatusMessage(
          status,
          appendHoldingDetails(
            activeMonitoringLabel
              ? 'Instrument page detected. StockTrade can update the current monitoring rule for this trader.'
              : 'Instrument page detected. StockTrade will save a monitoring-only alarm for this trader.',
            response.data?.holdingSummary,
          ),
          'info',
        );
        return;
      }

      if (!isOrderTicketPage() && !traderId) {
        setBadgeState(toggle, 'Monitor Ready', '#1f7a1f');
        button.dataset.actionMode = ACTION_MODE_IMPORT;
        button.disabled = true;
        button.style.cursor = 'default';
        button.style.background = '#1f7a1f';
        button.textContent = 'Select Trader';
        setStatusMessage(status, 'Select a trader before saving a monitoring alarm.', 'warning');
        return;
      }

      if (openPositionCount > 0 || alarmPayload) {
        setBadgeState(toggle, 'Stop Loss Ready', '#1f7a1f');
        button.dataset.actionMode =
          openPositionCount > 0
            ? ACTION_MODE_STOP_LOSS
            : ACTION_MODE_DEFINE_STOP_LOSS;
        button.disabled = false;
        button.style.cursor = 'pointer';
        button.style.background = '#1f7a1f';
        button.textContent = buildDefineStopLossLabel(response.data?.holdingSummary);
        status.textContent = alarmPayload
          ? appendHoldingDetails(
              `Alarm found on Nordnet at ${alarmPayload.stopLossPriceText}. Use this to create or update the stop loss rule in StockTrade.`,
              response.data?.holdingSummary,
            )
          : appendHoldingDetails(
              'Instrument exists in StockTrade with open holdings. Add a stop loss rule and enter the price manually if Nordnet has no alarm.',
              response.data?.holdingSummary,
            );
      } else if (openPositionCount === 0) {
        setBadgeState(toggle, 'Stop Loss Ready', '#1f7a1f');
        button.dataset.actionMode = ACTION_MODE_DEFINE_STOP_LOSS;
        button.disabled = false;
        button.style.cursor = 'pointer';
        button.style.background = '#1f7a1f';
        button.textContent = buildDefineStopLossLabel(response.data?.holdingSummary);
        status.textContent = appendHoldingDetails(
          'Instrument exists in StockTrade, but no open holdings were found. Define a test stop loss to create a virtual 1-share position.',
          response.data?.holdingSummary,
        );
      } else {
        applyExistingInstrumentState(
          toggle,
          button,
          status,
          traderLabel,
          response.data.instrument,
          response.data.holdingSummary,
        );
      }
      return;
    }

    if (response?.ok) {
      button.dataset.actionMode = ACTION_MODE_IMPORT;
      applyImportableState(toggle, button, status);
      return;
    }

    button.dataset.actionMode = ACTION_MODE_IMPORT;
    applyLookupErrorState(toggle, button, status, response?.error);
  }

  function upsertUi() {
    const existingContainer = document.getElementById(CONTAINER_ID);
    if (existingContainer) {
      return;
    }

    const container = document.createElement('div');
    container.id = CONTAINER_ID;
    container.style.position = 'fixed';
    const initialPosition = readUiPosition() || getDefaultUiPosition();
    applyUiPosition(container, initialPosition);
    container.style.zIndex = '2147483647';
    container.style.display = 'grid';
    container.style.justifyItems = 'end';
    container.style.gap = '6px';

    const toggle = document.createElement('button');
    toggle.id = TOGGLE_ID;
    toggle.type = 'button';
    toggle.textContent = 'Checking...';
    toggle.setAttribute('aria-expanded', 'false');
    toggle.style.border = '0';
    toggle.style.borderRadius = '999px';
    toggle.style.padding = '7px 10px';
    toggle.style.background = '#1d4f91';
    toggle.style.color = '#ffffff';
    toggle.style.fontWeight = '700';
    toggle.style.cursor = 'pointer';
    toggle.style.fontSize = '11px';
    toggle.style.lineHeight = '1.2';
    toggle.style.whiteSpace = 'pre-line';
    toggle.style.textAlign = 'center';
    toggle.style.boxShadow = '0 12px 30px rgba(16, 42, 67, 0.22)';

    const toggleRow = document.createElement('div');
    toggleRow.style.display = 'flex';
    toggleRow.style.alignItems = 'center';
    toggleRow.style.justifyContent = 'flex-end';
    toggleRow.style.gap = '6px';

    const openMonitorButton = document.createElement('button');
    openMonitorButton.type = 'button';
    openMonitorButton.title = 'Open floating monitor';
    openMonitorButton.setAttribute('aria-label', 'Open floating monitor');
    openMonitorButton.textContent = '[+]';
    openMonitorButton.style.border = '0';
    openMonitorButton.style.borderRadius = '999px';
    openMonitorButton.style.padding = '7px 8px';
    openMonitorButton.style.background = '#ffffff';
    openMonitorButton.style.color = '#486581';
    openMonitorButton.style.fontWeight = '700';
    openMonitorButton.style.cursor = 'pointer';
    openMonitorButton.style.fontSize = '11px';
    openMonitorButton.style.lineHeight = '1';
    openMonitorButton.style.boxShadow = '0 10px 24px rgba(16, 42, 67, 0.16)';
    openMonitorButton.style.border = '1px solid #d9e2ec';

    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.hidden = true;
    panel.style.width = '236px';
    panel.style.maxWidth = 'calc(100vw - 16px)';
    panel.style.padding = '10px';
    panel.style.borderRadius = '14px';
    panel.style.background = '#ffffff';
    panel.style.border = '1px solid #d9e2ec';
    panel.style.boxShadow = '0 18px 40px rgba(16, 42, 67, 0.18)';
    panel.style.display = 'grid';
    panel.style.gap = '8px';

    const panelHeader = document.createElement('div');
    panelHeader.style.display = 'flex';
    panelHeader.style.alignItems = 'center';
    panelHeader.style.justifyContent = 'space-between';
    panelHeader.style.gap = '8px';
    panelHeader.style.cursor = 'move';

    const title = document.createElement('div');
    title.textContent = `StockTrade v${EXTENSION_VERSION}`;
    title.style.fontSize = '11px';
    title.style.fontWeight = '700';
    title.style.letterSpacing = '0.04em';
    title.style.textTransform = 'uppercase';
    title.style.color = '#486581';

    const dragHint = document.createElement('span');
    dragHint.textContent = 'Drag';
    dragHint.style.fontSize = '10px';
    dragHint.style.fontWeight = '700';
    dragHint.style.color = '#829ab1';
    dragHint.style.textTransform = 'uppercase';

    panelHeader.appendChild(title);
    panelHeader.appendChild(dragHint);

    const traderLabel = document.createElement('span');
    traderLabel.style.fontSize = '11px';
    traderLabel.style.color = '#334e68';
    traderLabel.textContent = 'Trader: loading...';

    const traderSelect = document.createElement('select');
    traderSelect.style.display = 'none';
    traderSelect.style.border = '1px solid #bcccdc';
    traderSelect.style.borderRadius = '999px';
    traderSelect.style.padding = '6px 10px';
    traderSelect.style.background = '#ffffff';
    traderSelect.style.color = '#102a43';
    traderSelect.style.fontSize = '11px';

    const button = document.createElement('button');
    button.id = BUTTON_ID;
    button.type = 'button';
    button.dataset.importIntent = 'import';
    button.textContent = 'Import stock';
    button.dataset.actionMode = ACTION_MODE_IMPORT;
    button.style.border = '0';
    button.style.borderRadius = '999px';
    button.style.padding = '8px 10px';
    button.style.background = '#0f8b8d';
    button.style.color = '#ffffff';
    button.style.fontWeight = '700';
    button.style.cursor = 'pointer';
    button.style.fontSize = '11px';
    button.style.lineHeight = '1.2';
    button.style.whiteSpace = 'pre-line';
    button.style.textAlign = 'center';

    const status = document.createElement('span');
    status.id = STATUS_ID;
    status.style.fontSize = '11px';
    status.style.color = '#486581';
    status.style.whiteSpace = 'pre-line';
    status.textContent = 'Checking local dashboard...';

    const statusRow = document.createElement('div');
    statusRow.style.display = 'flex';
    statusRow.style.alignItems = 'flex-start';
    statusRow.style.justifyContent = 'space-between';
    statusRow.style.gap = '8px';

    const retryButton = document.createElement('button');
    retryButton.type = 'button';
    retryButton.textContent = '↻';
    retryButton.title = 'Retry StockTrade dashboard check';
    retryButton.setAttribute('aria-label', 'Retry StockTrade dashboard check');
    retryButton.style.display = 'none';
    retryButton.style.flexShrink = '0';
    retryButton.style.width = '24px';
    retryButton.style.height = '24px';
    retryButton.style.border = '1px solid #f0b4b4';
    retryButton.style.borderRadius = '999px';
    retryButton.style.background = '#fff5f5';
    retryButton.style.color = '#d64545';
    retryButton.style.fontSize = '14px';
    retryButton.style.fontWeight = '700';
    retryButton.style.lineHeight = '1';
    retryButton.style.cursor = 'pointer';
    retryButton.style.transition = 'transform 0.2s ease';

    const livePrice = document.createElement('span');
    livePrice.style.fontSize = '11px';
    livePrice.style.color = '#334e68';

    toggleRow.appendChild(openMonitorButton);
    toggleRow.appendChild(toggle);
    container.appendChild(toggleRow);
    container.appendChild(panel);
    document.body.appendChild(container);
    clampAndApplyCurrentUiPosition(container, initialPosition);

    const dragBehavior = attachDragBehavior(container, [toggle, panelHeader]);

    window.addEventListener('resize', () => {
      clampAndApplyCurrentUiPosition(container);
    });

    function refreshLivePrice() {
      const currentPrice = extractCurrentMarketPrice();
      livePrice.textContent = currentPrice.text
        ? `Current Nordnet price: ${currentPrice.text}`
        : 'Current Nordnet price unavailable.';
      return currentPrice;
    }

    function setRetryButtonState({ visible, loading = false }) {
      retryButton.style.display = visible ? 'inline-flex' : 'none';
      retryButton.style.alignItems = visible ? 'center' : '';
      retryButton.style.justifyContent = visible ? 'center' : '';
      retryButton.disabled = loading;
      retryButton.style.opacity = loading ? '0.7' : '1';
      retryButton.style.cursor = loading ? 'progress' : 'pointer';
      retryButton.style.transform = loading ? 'rotate(360deg)' : 'rotate(0deg)';
      retryButton.style.transition = loading ? 'transform 0.6s linear' : 'transform 0.2s ease';
    }

    toggle.addEventListener('click', () => {
      if (dragBehavior.consumeSuppressedClick()) {
        return;
      }

      const nextHidden = !panel.hidden;
      panel.hidden = nextHidden;
      toggle.setAttribute('aria-expanded', String(!nextHidden));
      if (!nextHidden) {
        refreshLivePrice();
      }
    });

    openMonitorButton.addEventListener('click', async () => {
      try {
        const response = await sendRuntimeMessage(
          { type: 'OPEN_FLOATING_MONITOR' },
          'Failed to open floating monitor.',
        );

        if (!response?.ok) {
          throw new Error(response?.error ?? 'Failed to open floating monitor.');
        }
      } catch (error) {
        setStatusMessage(
          status,
          toDisplayError(error, 'Failed to open floating monitor.'),
          'error',
        );
      }
    });

    let selectedTraderId = '';
    let selectedTraderName = '';

    traderSelect.addEventListener('change', () => {
      const option = traderSelect.options[traderSelect.selectedIndex];
      selectedTraderId = traderSelect.value;
      selectedTraderName = option?.textContent ?? '';
      writeSelectedTraderSelection(selectedTraderId, selectedTraderName);
      traderLabel.textContent = selectedTraderName
        ? `Current trader: ${selectedTraderName}`
        : 'Trader: none selected';
    });

    document.addEventListener('input', (event) => {
      const target = event.target;
      if (!(target instanceof HTMLInputElement)) {
        return;
      }

      if (
        (target.id !== 'quantity' && target.id !== 'price') ||
        (button.dataset.actionMode !== ACTION_MODE_SELL_ORDER && button.dataset.actionMode !== ACTION_MODE_BUY_ORDER)
      ) {
        return;
      }

      const orderForm = extractOrderForm();
      if (!orderForm) {
        return;
      }

      setStatusMessage(
        status,
        `${orderForm.side === 'BUY' ? 'Buy' : 'Sell'} ticket detected${orderForm.accountLabel ? ` for ${orderForm.accountLabel}` : ''}. Quantity ${orderForm.quantityText || '-'}, price ${orderForm.priceText || '-'}${orderForm.validUntilLabel ? `, valid ${orderForm.validUntilLabel}` : ''}.`,
        orderForm.side === 'SELL' ? 'warning' : 'info',
      );
    });
//TODO: if the stop loss action is triggered the internal message should get the current price and use that as the default value in the prompt, instead of leaving it blank.
    button.addEventListener('click', async () => {
      button.disabled = true;
      const actionMode = button.dataset.actionMode || ACTION_MODE_IMPORT;
      const isStopLossAction =
        actionMode === ACTION_MODE_STOP_LOSS || actionMode === ACTION_MODE_DEFINE_STOP_LOSS;
      const isSellOrderAction = actionMode === ACTION_MODE_SELL_ORDER;
      const isBuyOrderAction = actionMode === ACTION_MODE_BUY_ORDER;
      const isMonitoringAction = actionMode === ACTION_MODE_MONITORING;
      const isVirtualStopLossAction = actionMode === ACTION_MODE_DEFINE_STOP_LOSS;
      let shouldRefreshState = true;
      const isUpdateAction =
        !isStopLossAction &&
        !isSellOrderAction &&
        !isBuyOrderAction &&
        !isMonitoringAction &&
        button.dataset.importIntent === 'update';
      setBadgeState(
        toggle,
        isStopLossAction || isSellOrderAction || isBuyOrderAction || isMonitoringAction
          ? 'Saving Rule...'
          : isUpdateAction
            ? 'Updating...'
            : 'Importing...',
        '#1d4f91',
      );
      button.textContent = isStopLossAction
        ? 'Saving StopLoss...'
        : isSellOrderAction
          ? 'Saving Sell Order...'
          : isBuyOrderAction
            ? 'Saving Buy Order...'
            : isMonitoringAction
              ? 'Saving Monitor...'
            : isUpdateAction
              ? 'Updating...'
              : 'Importing...';
      setStatusMessage(
        status,
        isStopLossAction
          ? 'Reading Nordnet stop-loss details...'
          : isSellOrderAction
            ? 'Reading Nordnet sell ticket...'
            : isBuyOrderAction
              ? 'Reading Nordnet buy ticket...'
              : isMonitoringAction
                ? 'Reading Nordnet quote page...'
              : isUpdateAction
                ? 'Updating stock...'
                : 'Importing stock...',
      );

      try {
        const payload = await collectStockPayload();
        if (!payload.ok) {
          shouldRefreshState = false;
          setStatusMessage(status, payload.error, 'error');
          return;
        }

        if (isStopLossAction) {
          if (!selectedTraderId) {
            shouldRefreshState = false;
            setStatusMessage(status, 'Select a trader before adding a stop loss rule.', 'warning');
            return;
          }

          const alarmPayload = extractAlarmPayload();
          const currentPrice = refreshLivePrice();
          const stopLossInput = alarmPayload
            ? {
                ok: true,
                value: alarmPayload.stopLossPrice,
                text: alarmPayload.stopLossPriceText,
              }
            : requestStopLossPrice(currentPrice.value);

          if (!stopLossInput) {
            return;
          }

          if (!stopLossInput.ok) {
            shouldRefreshState = false;
            setStatusMessage(status, stopLossInput.error, 'error');
            return;
          }

          setStatusMessage(
            status,
            isVirtualStopLossAction
              ? 'Creating a virtual position with a stop loss in StockTrade...'
              : 'Matching the Nordnet alarm to an open holding in StockTrade...',
          );

          if (isVirtualStopLossAction && isBuyOrderPage()) {
            const buyOrderForm = extractOrderForm();
            if (!buyOrderForm || buyOrderForm.side !== 'BUY') {
              shouldRefreshState = false;
              setStatusMessage(status, 'Open a Nordnet buy ticket before saving a monitoring plan.', 'warning');
              return;
            }

            if (!Number.isFinite(buyOrderForm.quantity) || buyOrderForm.quantity <= 0) {
              shouldRefreshState = false;
              setStatusMessage(status, 'Enter a valid buy quantity on the Nordnet ticket.', 'warning');
              return;
            }

            if (!Number.isFinite(buyOrderForm.price) || buyOrderForm.price <= 0) {
              shouldRefreshState = false;
              setStatusMessage(status, 'Enter a valid buy price on the Nordnet ticket.', 'warning');
              return;
            }

            const response = await savePendingBuyOrder({
              traderId: selectedTraderId,
              instrument: payload.payload,
              quantity: buyOrderForm.quantity,
              price: buyOrderForm.price,
              stopLossPrice: stopLossInput.value,
            });

            if (response?.ok) {
              applyBuyMonitoringSavedState(toggle, button);
              shouldRefreshState = false;
              setStatusMessage(
                status,
                `Saved pending buy order for ${payload.payload.ticker} and attached a monitoring plan at ${stopLossInput.text}.`,
                'success',
              );
            } else {
              shouldRefreshState = false;
              setStatusMessage(status, response?.error ?? 'Failed to save buy monitoring plan.', 'error');
            }
            return;
          }

          if (isVirtualStopLossAction) {
            const response = await createVirtualStopLoss({
              traderId: selectedTraderId,
              instrument: payload.payload,
              stopLossPrice: stopLossInput.value,
              entryPrice: currentPrice.value ?? stopLossInput.value,
              quantity: 1,
            });

            if (response?.ok) {
              applyStopLossSavedState(toggle, button);
              shouldRefreshState = false;
              setStatusMessage(
                status,
                `Created virtual 1-share position for ${payload.payload.ticker} with stop loss ${stopLossInput.text}. Monitoring started and an internal message was queued in StockTrade.`,
                'success',
              );
            } else {
              shouldRefreshState = false;
              setStatusMessage(status, response?.error ?? 'Failed to create virtual stop loss.', 'error');
            }
            return;
          }

          const target = await resolveStopLossTarget(selectedTraderId, payload.payload);
          if (!target.ok) {
            shouldRefreshState = false;
            setStatusMessage(status, target.error, 'error');
            return;
          }

          const quantity = Number(target.holding?.quantity ?? 0);
          if (!Number.isFinite(quantity) || quantity <= 0) {
            shouldRefreshState = false;
            setStatusMessage(status, 'Matched holding has no open quantity to protect.', 'error');
            return;
          }

          const response = await saveStopLossRule(target.holding.id, {
            stopLossPrice: stopLossInput.value,
            saleQuantity: quantity,
            trailingPercent: null,
            trailingAmount: null,
            currentPrice: currentPrice.value ?? null,
            currentPriceText: currentPrice.text || null,
          });

          if (response?.ok) {
            const ticker = target.holding?.instrument?.ticker ?? payload.payload.ticker;
            applyStopLossSavedState(toggle, button);
            shouldRefreshState = false;
            setStatusMessage(
              status,
              `Saved stop loss rule for ${ticker} at ${stopLossInput.text}. Monitoring started and an internal message was queued in StockTrade.`,
              'success',
            );
          } else {
            shouldRefreshState = false;
            setStatusMessage(status, response?.error ?? 'Failed to save stop loss rule.', 'error');
          }
          return;
        }

        if (isSellOrderAction) {
          if (!selectedTraderId) {
            shouldRefreshState = false;
            setStatusMessage(status, 'Select a trader before saving a sell order.', 'warning');
            return;
          }

          const sellOrderForm = extractOrderForm();
          if (!sellOrderForm || sellOrderForm.side !== 'SELL') {
            shouldRefreshState = false;
            setStatusMessage(status, 'Open a Nordnet sell ticket before saving a sell order.', 'warning');
            return;
          }

          if (!Number.isFinite(sellOrderForm.quantity) || sellOrderForm.quantity <= 0) {
            shouldRefreshState = false;
            setStatusMessage(status, 'Enter a valid sell quantity on the Nordnet ticket.', 'warning');
            return;
          }

          if (!Number.isFinite(sellOrderForm.price) || sellOrderForm.price <= 0) {
            shouldRefreshState = false;
            setStatusMessage(status, 'Enter a valid sell price on the Nordnet ticket.', 'warning');
            return;
          }

          const target = await resolveStopLossTarget(selectedTraderId, payload.payload);
          if (!target.ok) {
            shouldRefreshState = false;
            setStatusMessage(status, target.error, 'error');
            return;
          }

          const response = await savePendingSellOrder(target.holding.id, {
            saleQuantity: sellOrderForm.quantity,
            price: sellOrderForm.price,
          });
          debugLog('Pending sell order save response', {
            ticker: target.holding?.instrument?.ticker ?? payload.payload.ticker,
            response,
          });

          if (response?.ok) {
            const ticker = target.holding?.instrument?.ticker ?? payload.payload.ticker;
            shouldRefreshState = false;
            setBadgeState(toggle, 'Sell Saved', '#b45309');
            button.dataset.actionMode = ACTION_MODE_SELL_ORDER;
            button.textContent = 'Sell Order Saved';
            button.style.background = '#b45309';
            button.style.cursor = 'default';
            setStatusMessage(
              status,
              `Saved pending sell order for ${ticker} at ${sellOrderForm.priceText} x ${sellOrderForm.quantityText}.`,
              'success',
            );
          } else {
            shouldRefreshState = false;
            setStatusMessage(status, response?.error ?? 'Failed to save pending sell order.', 'error');
          }
          return;
        }

        if (isMonitoringAction) {
          if (!selectedTraderId) {
            shouldRefreshState = false;
            setStatusMessage(status, 'Select a trader before saving a monitoring alarm.', 'warning');
            return;
          }

          const currentPrice = refreshLivePrice();
          const monitoringInput = requestQuickMonitoringPlan(currentPrice.value, currentPrice.value);

          if (!monitoringInput) {
            return;
          }

          if (!monitoringInput.ok || monitoringInput.value === null) {
            shouldRefreshState = false;
            setStatusMessage(status, monitoringInput.error, 'error');
            return;
          }

          const response = await saveMonitoringPlan({
            traderId: selectedTraderId,
            instrument: payload.payload,
            triggerPrice: monitoringInput.value,
            triggerCondition: monitoringInput.triggerCondition,
          });

          if (response?.ok) {
            shouldRefreshState = false;
            setBadgeState(toggle, 'Monitor Saved', '#1f7a1f');
            button.dataset.actionMode = ACTION_MODE_MONITORING;
            button.textContent = 'Monitor Saved';
            button.style.background = '#1f7a1f';
            button.style.cursor = 'default';
            setStatusMessage(
              status,
              `Saved monitoring alarm for ${payload.payload.ticker} at ${monitoringInput.text}.`,
              'success',
            );
          } else {
            shouldRefreshState = false;
            setStatusMessage(status, response?.error ?? 'Failed to save monitoring plan.', 'error');
          }
          return;
        }

        if (isBuyOrderAction) {
          if (!selectedTraderId) {
            shouldRefreshState = false;
            setStatusMessage(status, 'Select a trader before saving a buy order.', 'warning');
            return;
          }

          const buyOrderForm = extractOrderForm();
          if (!buyOrderForm || buyOrderForm.side !== 'BUY') {
            shouldRefreshState = false;
            setStatusMessage(status, 'Open a Nordnet buy ticket before saving a buy order.', 'warning');
            return;
          }

          if (!Number.isFinite(buyOrderForm.quantity) || buyOrderForm.quantity <= 0) {
            shouldRefreshState = false;
            setStatusMessage(status, 'Enter a valid buy quantity on the Nordnet ticket.', 'warning');
            return;
          }

          if (!Number.isFinite(buyOrderForm.price) || buyOrderForm.price <= 0) {
            shouldRefreshState = false;
            setStatusMessage(status, 'Enter a valid buy price on the Nordnet ticket.', 'warning');
            return;
          }

          const currentPrice = refreshLivePrice();
          const monitoringInput = requestBuyMonitoringPrice(currentPrice.value);
          if (!monitoringInput) {
            return;
          }

          if (!monitoringInput.ok) {
            shouldRefreshState = false;
            setStatusMessage(status, monitoringInput.error, 'error');
            return;
          }

          const response = await savePendingBuyOrder({
            traderId: selectedTraderId,
            instrument: payload.payload,
            quantity: buyOrderForm.quantity,
            price: buyOrderForm.price,
            stopLossPrice: monitoringInput.value ?? undefined,
          });
          debugLog('Pending buy order save response', {
            ticker: payload.payload.ticker,
            response,
          });

          if (response?.ok) {
            shouldRefreshState = false;
            setBadgeState(toggle, 'Buy Saved', '#1d4f91');
            button.dataset.actionMode = ACTION_MODE_BUY_ORDER;
            button.textContent = 'Buy Order Saved';
            button.style.background = '#1d4f91';
            button.style.cursor = 'default';
            setStatusMessage(
              status,
              monitoringInput.value !== null
                ? `Saved pending buy order for ${payload.payload.ticker} at ${buyOrderForm.priceText} x ${buyOrderForm.quantityText} and attached a monitoring plan at ${monitoringInput.text}.`
                : `Saved pending buy order for ${payload.payload.ticker} at ${buyOrderForm.priceText} x ${buyOrderForm.quantityText}.`,
              'success',
            );
          } else {
            shouldRefreshState = false;
            setStatusMessage(status, response?.error ?? 'Failed to save pending buy order.', 'error');
          }
          return;
        }

        setStatusMessage(status, isUpdateAction ? 'Updating stock...' : 'Importing stock...');

        const response = await sendRuntimeMessage({
          type: 'IMPORT_INSTRUMENT',
          payload: {
            ...payload.payload,
            traderId: selectedTraderId || undefined,
            confirmUpdate: isUpdateAction,
          },
        }, 'Import failed because the extension background worker was unavailable.');
        debugLog('Import response received', {
          requestPayload: {
            ...payload.payload,
            traderId: selectedTraderId || undefined,
          },
          response,
        });

        if (response?.ok) {
          const instrument = response.data?.instrument;
          const traderSuffix = selectedTraderName ? ` for ${selectedTraderName}` : '';
          setStatusMessage(
            status,
            `${response.data?.created ? 'Imported' : 'Updated'} ${instrument?.ticker ?? 'instrument'}${traderSuffix}.`,
            'success',
          );
          button.dataset.actionMode = ACTION_MODE_IMPORT;
          applyExistingInstrumentState(toggle, button, status, traderLabel, instrument, null);
          shouldRefreshState = false;
        } else {
          const errorText = response?.details
            ? `${response?.error ?? 'Import failed.'} ${response.details}`
            : response?.error ?? 'Import failed.';
          setStatusMessage(status, errorText, 'error');
          shouldRefreshState = false;
        }
      } catch (error) {
        shouldRefreshState = false;
        setStatusMessage(status, toDisplayError(error, 'Import failed.'), 'error');
      } finally {
        button.disabled = false;
        if (shouldRefreshState) {
          void refreshButtonState(toggle, button, status, traderLabel, selectedTraderId);
        }
      }
    });

    async function refreshDashboardState() {
      setBadgeState(toggle, 'Checking...', '#1d4f91');
      setStatusMessage(status, 'Checking the StockTrade dashboard...', 'info');
      setRetryButtonState({ visible: true, loading: true });
      traderLabel.textContent = 'Trader: loading...';
      traderSelect.style.display = 'none';
      button.dataset.importIntent = 'import';
      button.dataset.actionMode = ACTION_MODE_IMPORT;
      button.textContent = 'Import stock';

      const available = await isDashboardAvailable();
      if (!available) {
        setBadgeState(toggle, 'Dashboard Offline', '#d64545');
        setStatusMessage(status, 'StockTrade dashboard is not reachable.', 'error');
        traderLabel.textContent = 'Trader: unavailable';
        setRetryButtonState({ visible: true, loading: false });
        return;
      }

      setStatusMessage(status, 'Local dashboard detected.', 'success');
      setRetryButtonState({ visible: false, loading: false });
      refreshLivePrice();

      try {
        await refreshButtonState(toggle, button, status, traderLabel, selectedTraderId);
      } catch (_error) {
        button.dataset.importIntent = 'import';
        button.textContent = 'Import stock';
      }

      try {
        const traders = await fetchTraders();
        const storedTraderId = readSelectedTraderId();
        const activeTraders = traders.filter((trader) => trader?.isActive !== false);
        const options = activeTraders.length ? activeTraders : traders;
        const selectedTrader =
          options.find((trader) => trader.id === storedTraderId) ??
          options.find((trader) => trader?.isSelected) ??
          options[0] ??
          null;

        traderSelect.replaceChildren();

        if (!selectedTrader) {
          selectedTraderId = '';
          selectedTraderName = '';
          traderLabel.textContent = 'Trader: none configured';
          traderSelect.style.display = 'none';
          writeSelectedTraderSelection('', '');
          return;
        }

        for (const trader of options) {
          const option = document.createElement('option');
          option.value = trader.id;
          option.textContent = getTraderLabel(trader);
          traderSelect.appendChild(option);
        }

        selectedTraderId = selectedTrader.id;
        selectedTraderName = getTraderLabel(selectedTrader);
        traderSelect.value = selectedTrader.id;
        traderSelect.style.display = options.length > 1 ? 'inline-block' : 'none';
        traderLabel.textContent = `Trader: ${selectedTraderName}`;
        writeSelectedTraderSelection(selectedTraderId, selectedTraderName);

        try {
          await refreshButtonState(toggle, button, status, traderLabel, selectedTraderId);
        } catch (_error) {
          button.dataset.importIntent = 'import';
          button.textContent = 'Import stock';
        }
      } catch (_error) {
        selectedTraderId = '';
        selectedTraderName = '';
        traderLabel.textContent = 'Trader: unavailable';
        traderSelect.style.display = 'none';

        try {
          await refreshButtonState(toggle, button, status, traderLabel, selectedTraderId);
        } catch (_nestedError) {
          button.dataset.importIntent = 'import';
          button.textContent = 'Import stock';
        }
      }
    }

    retryButton.addEventListener('click', () => {
      void refreshDashboardState();
    });

    panel.appendChild(panelHeader);
    panel.appendChild(traderLabel);
    panel.appendChild(traderSelect);
    panel.appendChild(button);
    panel.appendChild(livePrice);
    statusRow.appendChild(status);
    statusRow.appendChild(retryButton);
    panel.appendChild(statusRow);

    void refreshDashboardState();
  }


  function dispatchFieldEvents(input) {
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new Event('blur', { bubbles: true }));
  }

  function setInputElementValue(input, value) {
    const prototype = Object.getPrototypeOf(input);
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
    if (descriptor?.set) {
      descriptor.set.call(input, value);
    } else {
      input.value = value;
    }
    dispatchFieldEvents(input);
  }

  function setFormattedNumberField(inputId, value) {
    const input = document.getElementById(inputId);
    if (!(input instanceof HTMLInputElement)) {
      return false;
    }

    const wrapper = input.closest('div');
    const hiddenInput = wrapper?.querySelector('input[type="hidden"]');
    const textValue = String(value);

    setInputElementValue(input, textValue);
    if (hiddenInput instanceof HTMLInputElement) {
      setInputElementValue(hiddenInput, textValue);
    }

    return true;
  }

  function matchesButtonText(button, labels) {
    if (!(button instanceof HTMLButtonElement) || button.disabled) {
      return false;
    }

    const text = compactText(button.textContent ?? '').toLowerCase();
    const ariaLabel = compactText(button.getAttribute('aria-label') ?? '').toLowerCase();
    return labels.some((label) => text === label || ariaLabel === label || text.includes(label) || ariaLabel.includes(label));
  }

  function findActionButton(labels, options = {}) {
    const scope = options.dialogOnly
      ? [...document.querySelectorAll('[role="dialog"] button, dialog button')]
      : [...document.querySelectorAll('button')].filter((button) => !button.closest('[role="dialog"], dialog'));

    const matches = scope.filter((button) => matchesButtonText(button, labels));
    return matches.at(-1) ?? null;
  }

  async function waitForActionButton(labels, options = {}) {
    const timeoutMs = options.timeoutMs ?? 6000;
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      const button = findActionButton(labels, options);
      if (button) {
        return button;
      }

      await new Promise((resolve) => window.setTimeout(resolve, 150));
    }

    return null;
  }

  async function executeSavedOrder(plan) {
    const savedOrder = plan?.pendingOrder;
    if (!savedOrder?.side) {
      return {
        ok: false,
        error: 'No saved order was attached to this monitoring plan.',
      };
    }

    const expectedSide = String(savedOrder.side).toUpperCase();
    const orderForm = extractOrderForm();
    if (!orderForm || orderForm.side !== expectedSide) {
      return {
        ok: false,
        error: `Open the Nordnet ${expectedSide.toLowerCase()} ticket before placing this saved order.`,
      };
    }

    const quantity = Number(savedOrder.quantity);
    const price = Number(savedOrder.price);
    if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(price) || price <= 0) {
      return {
        ok: false,
        error: 'Saved order quantity or price is invalid.',
      };
    }

    if (!setFormattedNumberField('quantity', quantity) || !setFormattedNumberField('price', price)) {
      return {
        ok: false,
        error: 'Could not populate the Nordnet order form.',
      };
    }

    await new Promise((resolve) => window.setTimeout(resolve, 200));

    const sideLabels = expectedSide === 'BUY' ? ['kj�p', 'kjop'] : ['selg'];
    const primaryButton = findActionButton(sideLabels, { dialogOnly: false });
    if (!primaryButton) {
      return {
        ok: false,
        error: `Could not find the Nordnet ${expectedSide.toLowerCase()} button.`,
      };
    }

    primaryButton.click();

    const confirmButton = await waitForActionButton(sideLabels, { dialogOnly: true, timeoutMs: 8000 });
    if (confirmButton) {
      confirmButton.click();
      return {
        ok: true,
        message: `${savedOrder.status === 'CANCELLED' ? 'Replaced' : 'Submitted'} the saved ${expectedSide.toLowerCase()} order on Nordnet.`,
      };
    }

    return {
      ok: true,
      message: `Filled the Nordnet ${expectedSide.toLowerCase()} ticket and clicked the primary order button. Confirm the final dialog manually if Nordnet still requires it.`,
    };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'GET_STOCK_PAYLOAD') {
      collectStockPayload().then((response) => {
        if (!response?.ok || !response?.payload) {
          sendResponse(response);
          return;
        }

        sendResponse({
          ...response,
          payload: {
            ...response.payload,
            traderId: readSelectedTraderId() || undefined,
          },
        });
      });
      return true;
    }

    if (message?.type === 'EXECUTE_SAVED_ORDER') {
      executeSavedOrder(message.plan).then(sendResponse);
      return true;
    }

    return false;
  });

  if (!isSupportedInstrumentPage()) {
    return;
  }

  let lastPageKey = `${window.location.pathname}${window.location.search}`;

  upsertUi();
  const observer = new MutationObserver(() => {
    const nextPageKey = `${window.location.pathname}${window.location.search}`;
    if (nextPageKey !== lastPageKey) {
      lastPageKey = nextPageKey;
      const existingContainer = document.getElementById(CONTAINER_ID);
      existingContainer?.remove();
      upsertUi();
      return;
    }

    upsertUi();
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
})();
