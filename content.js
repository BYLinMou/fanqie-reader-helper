(() => {
  "use strict";

  if (window.__fanqieDocumentReaderMounted) {
    return;
  }
  window.__fanqieDocumentReaderMounted = true;

  const ROOT_ID = "fq-doc-reader-root";
  const SOURCE_HIDDEN_CLASS = "fq-doc-source-hidden";
  const BODY_ACTIVE_CLASS = "fq-doc-reader-active";
  const STORAGE_KEY = "fanqieDocumentReaderSettings";

  const DEFAULT_SETTINGS = {
    enabled: true,
    fontSize: 16,
    lineHeight: 1.85,
    pageWidth: "normal",
    pageScale: 100,
    theme: "system",
  };

  const PAGE_WIDTHS = {
    narrow: 720,
    normal: 860,
    wide: 1040,
  };
  const A4_PAGE_WIDTH = 860;
  const A4_RATIO = 297 / 210;
  const PAGE_SCALE_MIN = 70;
  const PAGE_SCALE_MAX = 140;
  const PAGE_SCALE_STEP = 5;
  const WHEEL_ZOOM_INTERVAL = 80;
  const SYSTEM_DARK_QUERY = "(prefers-color-scheme: dark)";

  const SOURCE_SELECTORS = [
    ".muye-reader-content",
    ".reader-content",
    ".chapter-content",
    ".article-content",
    ".book-reader-content",
    "[class*='muye-reader-content']",
    "[class*='reader-content']",
    "[class*='ReaderContent']",
    "[class*='chapter-content']",
    "[class*='ChapterContent']",
    "[class*='article-content']",
    "[class*='content']",
    "article",
    "main",
  ];

  const TITLE_SELECTORS = [
    ".muye-reader-title",
    ".reader-title",
    ".chapter-title",
    "[class*='muye-reader-title']",
    "[class*='reader-title']",
    "[class*='ReaderTitle']",
    "[class*='chapter-title']",
    "[class*='ChapterTitle']",
    "h1",
    "h2",
  ];

  const UPDATED_AT_SELECTORS = [
    ".muye-reader-subtitle",
    ".reader-subtitle",
    ".chapter-subtitle",
    ".desc-item",
    "[class*='muye-reader-subtitle']",
    "[class*='reader-subtitle']",
    "[class*='ChapterSubtitle']",
    "[class*='desc-item']",
  ];

  const BOOK_TITLE_SELECTORS = [
    ".muye-reader-nav-title",
    ".reader-nav-title",
    ".book-title",
    "[class*='muye-reader-nav-title']",
    "[class*='reader-nav-title']",
    "[class*='ReaderNavTitle']",
    "[class*='book-title']",
    "[class*='BookTitle']",
  ];

  const BLOCK_SELECTOR =
    "p, div, section, article, main, li, h1, h2, h3, h4, blockquote";

  const FORBIDDEN_CONTAINER_TOKENS = new Set([
    "ad",
    "ads",
    "advert",
    "advertisement",
    "banner",
    "catalog",
    "comment",
    "comments",
    "download",
    "footer",
    "header",
    "login",
    "menu",
    "nav",
    "navigation",
    "pay",
    "popup",
    "recommend",
    "search",
    "share",
    "shelf",
    "sidebar",
    "toolbar",
    "vip",
  ]);
  const NAV_TEXT_RE = /(上一章|下一章|上一页|下一页|上章|下章|目录|书架|加入书架|下载|客户端|打开App|打开APP|登录|注册|评论|推荐|广告|举报|听书|分享|设置|自动阅读)/i;
  const PREV_RE = /(上一章|上一页|上章|prev|previous)/i;
  const NEXT_RE = /(下一章|下一页|下章|next)/i;

  const state = {
    root: null,
    source: null,
    settings: { ...DEFAULT_SETTINGS },
    chapter: {
      title: "正在等待正文",
      bookName: "",
      editedDateLabel: "未知",
      loadedTimeLabel: "",
      paragraphs: [],
      wordCount: 0,
      contentFontFamily: "",
    },
    fingerprint: "",
    observer: null,
    refreshTimer: 0,
    progressFrame: 0,
    lastWheelZoomAt: 0,
    currentPage: 1,
    pageCount: 1,
    lastRenderKey: "",
    suppressStorageEvent: false,
  };

  const storage = {
    async get() {
      const fallback = () => {
        try {
          const raw = window.localStorage.getItem(STORAGE_KEY);
          return raw ? JSON.parse(raw) : {};
        } catch {
          return {};
        }
      };

      if (!globalThis.chrome?.storage?.local) {
        return fallback();
      }

      return new Promise((resolve) => {
        globalThis.chrome.storage.local.get(DEFAULT_SETTINGS, (items) => {
          if (globalThis.chrome.runtime?.lastError) {
            resolve(fallback());
            return;
          }
          resolve(items || {});
        });
      });
    },

    async set(partial) {
      if (!globalThis.chrome?.storage?.local) {
        try {
          window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state.settings));
        } catch {
          // Ignore storage failures; controls should still work for the page session.
        }
        return;
      }

      state.suppressStorageEvent = true;
      await new Promise((resolve) => {
        globalThis.chrome.storage.local.set(partial, resolve);
      });
      window.setTimeout(() => {
        state.suppressStorageEvent = false;
      }, 0);
    },
  };

  init();

  async function init() {
    if (!isReaderPage()) {
      return;
    }

    const saved = await storage.get();
    state.settings = normalizeSettings(saved);

    ensureRoot();
    patchHistoryEvents();
    installObservers();
    installStorageListener();
    installSystemThemeListener();
    installZoomShortcuts();
    refresh("init");

    [250, 900, 1800, 3500].forEach((delay) => {
      window.setTimeout(() => refresh("delayed"), delay);
    });
  }

  function normalizeSettings(input) {
    const next = { ...DEFAULT_SETTINGS, ...(input || {}) };
    next.enabled = Boolean(next.enabled);
    next.fontSize = clampNumber(next.fontSize, 14, 28, DEFAULT_SETTINGS.fontSize);
    next.pageScale = clampNumber(
      next.pageScale,
      PAGE_SCALE_MIN,
      PAGE_SCALE_MAX,
      DEFAULT_SETTINGS.pageScale,
    );
    next.lineHeight = clampNumber(
      next.lineHeight,
      1.35,
      2.4,
      DEFAULT_SETTINGS.lineHeight,
    );
    if (!Object.prototype.hasOwnProperty.call(PAGE_WIDTHS, next.pageWidth)) {
      next.pageWidth = DEFAULT_SETTINGS.pageWidth;
    }
    if (!["system", "paper", "green", "dark"].includes(next.theme)) {
      next.theme = DEFAULT_SETTINGS.theme;
    }
    return next;
  }

  function clampNumber(value, min, max, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
      return fallback;
    }
    return Math.min(max, Math.max(min, number));
  }

  function ensureRoot() {
    let root = document.getElementById(ROOT_ID);
    if (!root) {
      root = document.createElement("div");
      root.id = ROOT_ID;
      root.setAttribute("data-fq-doc-reader", "true");
      document.documentElement.appendChild(root);
    }
    state.root = root;
  }

  function installObservers() {
    if (state.observer) {
      return;
    }

    state.observer = new MutationObserver((mutations) => {
      if (!state.root) {
        return;
      }

      const onlyOwnChanges = mutations.every((mutation) => {
        const target = mutation.target;
        return target === state.root || state.root.contains(target);
      });

      if (onlyOwnChanges) {
        return;
      }

      const hasRelevantChange = mutations.some((mutation) => {
        const target = mutation.target;
        if (!(target instanceof Node)) {
          return false;
        }
        if (state.root && (target === state.root || state.root.contains(target))) {
          return false;
        }
        if (state.source && (target === state.source || state.source.contains(target))) {
          return true;
        }
        return Array.from(mutation.addedNodes || []).some(
          (node) =>
            node instanceof HTMLElement &&
            (SOURCE_SELECTORS.some((selector) => node.matches?.(selector)) ||
              TITLE_SELECTORS.some((selector) => node.matches?.(selector)) ||
              node.querySelector?.(SOURCE_SELECTORS.join(",")) ||
              node.querySelector?.(TITLE_SELECTORS.join(","))),
        );
      });

      if (!hasRelevantChange) {
        return;
      }

      scheduleRefresh();
    });

    state.observer.observe(document.documentElement, {
      childList: true,
      characterData: true,
      subtree: true,
    });

    window.addEventListener("popstate", () => scheduleRefresh(100));
    window.addEventListener("hashchange", () => scheduleRefresh(100));
    window.addEventListener("fq-doc-reader-locationchange", () => scheduleRefresh(250));
  }

  function installStorageListener() {
    if (!globalThis.chrome?.storage?.onChanged) {
      return;
    }

    globalThis.chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "local" || state.suppressStorageEvent) {
        return;
      }

      const changedKeys = Object.keys(DEFAULT_SETTINGS).filter((key) => changes[key]);
      if (!changedKeys.length) {
        return;
      }

      changedKeys.forEach((key) => {
        state.settings[key] = changes[key].newValue;
      });
      state.settings = normalizeSettings(state.settings);
      render();
    });
  }

  function installSystemThemeListener() {
    const media = window.matchMedia?.(SYSTEM_DARK_QUERY);
    if (!media?.addEventListener) {
      return;
    }

    media.addEventListener("change", () => {
      if (state.settings.theme === "system") {
        render();
      }
    });
  }

  function installZoomShortcuts() {
    if (window.__fanqieDocumentReaderZoomShortcuts) {
      return;
    }
    window.__fanqieDocumentReaderZoomShortcuts = true;

    window.addEventListener("keydown", handleZoomKeydown, true);
    window.addEventListener("wheel", handleZoomWheel, {
      capture: true,
      passive: false,
    });
  }

  function handleZoomKeydown(event) {
    if (!shouldHandleDocumentZoom() || !isZoomModifierPressed(event)) {
      return;
    }

    const key = event.key;
    const code = event.code;
    const zoomIn = key === "+" || key === "=" || code === "NumpadAdd";
    const zoomOut = key === "-" || key === "_" || code === "NumpadSubtract";
    const reset = key === "0" || code === "Digit0" || code === "Numpad0";

    if (!zoomIn && !zoomOut && !reset) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    if (reset) {
      setPageScale(DEFAULT_SETTINGS.pageScale);
      return;
    }

    adjustPageScale(zoomIn ? PAGE_SCALE_STEP : -PAGE_SCALE_STEP);
  }

  function handleZoomWheel(event) {
    if (!shouldHandleDocumentZoom() || !event.ctrlKey || !Number.isFinite(event.deltaY)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const now = Date.now();
    if (now - state.lastWheelZoomAt < WHEEL_ZOOM_INTERVAL) {
      return;
    }
    state.lastWheelZoomAt = now;

    adjustPageScale(event.deltaY < 0 ? PAGE_SCALE_STEP : -PAGE_SCALE_STEP);
  }

  function shouldHandleDocumentZoom() {
    return (
      isReaderPage() &&
      state.settings.enabled &&
      state.root?.classList.contains("fq-doc-shell")
    );
  }

  function isZoomModifierPressed(event) {
    return (event.ctrlKey || event.metaKey) && !event.altKey;
  }

  function patchHistoryEvents() {
    if (window.__fanqieDocumentReaderHistoryPatched) {
      return;
    }
    window.__fanqieDocumentReaderHistoryPatched = true;

    const fire = () => {
      window.dispatchEvent(new Event("fq-doc-reader-locationchange"));
    };

    ["pushState", "replaceState"].forEach((methodName) => {
      const original = history[methodName];
      history[methodName] = function patchedHistoryMethod(...args) {
        const result = original.apply(this, args);
        fire();
        return result;
      };
    });
  }

  function scheduleRefresh(delay = 350) {
    window.clearTimeout(state.refreshTimer);
    state.refreshTimer = window.setTimeout(() => refresh("mutation"), delay);
  }

  function refresh(reason) {
    if (!isReaderPage()) {
      teardownForNonReaderPage();
      return;
    }

    ensureRoot();
    const extracted = extractChapter();
    const fingerprint = createFingerprint(extracted);
    const navigation = findNavigation();
    const navigationFingerprint = createNavigationFingerprint(navigation);
    const renderKey = `${fingerprint}::${navigationFingerprint}::${state.settings.enabled}`;
    const shouldRender = renderKey !== state.lastRenderKey || reason === "init";

    if (fingerprint !== state.fingerprint || reason === "init") {
      state.chapter = extracted;
      state.fingerprint = fingerprint;
    }

    state.navigation = navigation;
    if (shouldRender) {
      state.lastRenderKey = renderKey;
      render();
    }
  }

  function isReaderPage() {
    return location.hostname === "fanqienovel.com" && location.pathname.startsWith("/reader/");
  }

  function teardownForNonReaderPage() {
    unhideSource();
    document.body?.classList.remove(BODY_ACTIVE_CLASS);
    state.root?.remove();
    state.root = null;
  }

  function extractChapter() {
    const source = findBestSourceContainer();
    if (source) {
      source.classList.remove(SOURCE_HIDDEN_CLASS);
    }

    const title = findTitle(source);
    const bookName = findBookName(title);
    const editedDateLabel = findEditedDateLabel();
    const loadedTimeLabel = formatCurrentTime();
    const paragraphs = source ? collectParagraphs(source, title) : [];
    const wordCount = countReadableCharacters(paragraphs.join(""));
    const contentFontFamily = getContentFontFamily(source);
    setSourceContainer(source);

    return {
      title: title || "正在等待正文",
      bookName,
      editedDateLabel,
      loadedTimeLabel,
      paragraphs,
      wordCount,
      contentFontFamily,
    };
  }

  function findBestSourceContainer() {
    const candidates = new Set();

    SOURCE_SELECTORS.forEach((selector) => {
      document.querySelectorAll(selector).forEach((element) => {
        if (isUsableSourceCandidate(element)) {
          candidates.add(element);
        }
      });
    });

    if (!candidates.size) {
      document.querySelectorAll("article, main, section, div").forEach((element) => {
        if (isUsableSourceCandidate(element)) {
          candidates.add(element);
        }
      });
    }

    let best = null;
    let bestScore = 0;

    candidates.forEach((element) => {
      const score = scoreSourceCandidate(element);
      if (score > bestScore) {
        best = element;
        bestScore = score;
      }
    });

    if (best && bestScore > 180) {
      return best;
    }

    return null;
  }

  function isUsableSourceCandidate(element) {
    if (!(element instanceof HTMLElement)) {
      return false;
    }
    if (state.root && (element === state.root || state.root.contains(element))) {
      return false;
    }
    if (element === document.documentElement || element === document.body) {
      return false;
    }
    if (hasForbiddenRole(element)) {
      return false;
    }

    const text = cleanText(element.textContent || "");
    return text.length >= 80;
  }

  function scoreSourceCandidate(element) {
    const text = cleanText(element.textContent || "");
    if (!text) {
      return 0;
    }

    const paragraphs = collectBlockTexts(element, "").length;
    const links = Array.from(element.querySelectorAll("a"));
    const controls = element.querySelectorAll("button, input, textarea, select").length;
    const linkTextLength = links.reduce(
      (total, link) => total + cleanText(link.textContent || "").length,
      0,
    );
    const classSignal = getElementSignal(element);
    const likelyReader = /(reader|chapter|article|content|muye)/i.test(classSignal) ? 350 : 0;
    const forbiddenPenalty = hasForbiddenRole(element) ? 600 : 0;

    return (
      Math.min(text.length, 12000) +
      paragraphs * 180 +
      likelyReader -
      linkTextLength * 1.1 -
      controls * 250 -
      forbiddenPenalty
    );
  }

  function findTitle(source) {
    const scopedCandidates = [];
    const searchRoots = source ? [source, document] : [document];

    searchRoots.forEach((root) => {
      TITLE_SELECTORS.forEach((selector) => {
        root.querySelectorAll(selector).forEach((element) => {
          if (state.root && state.root.contains(element)) {
            return;
          }
          const text = normalizeTitle(readElementText(element));
          if (isLikelyTitle(text)) {
            scopedCandidates.push(text);
          }
        });
      });
    });

    if (scopedCandidates.length) {
      return scopedCandidates.sort((a, b) => a.length - b.length)[0];
    }

    const documentTitle = normalizeTitle(document.title || "");
    return isLikelyTitle(documentTitle) ? documentTitle : "";
  }

  function isLikelyTitle(text) {
    return Boolean(text && text.length >= 2 && text.length <= 80 && !NAV_TEXT_RE.test(text));
  }

  function findEditedDateLabel() {
    for (const selector of UPDATED_AT_SELECTORS) {
      for (const element of document.querySelectorAll(selector)) {
        if (state.root && state.root.contains(element)) {
          continue;
        }

        const formatted = formatEditedDateFromText(readElementText(element));
        if (formatted) {
          return formatted;
        }
      }
    }

    const dateModified = Array.from(
      document.querySelectorAll("script[type='application/ld+json']"),
    )
      .map((script) => formatEditedDateFromText(script.textContent || ""))
      .find(Boolean);

    return dateModified || "未知";
  }

  function formatEditedDateFromText(text) {
    const cleaned = cleanText(text);
    const labeledMatch = cleaned.match(
      /更新时间[:：]?\s*((?:\d{4}[-/.年])?\d{1,2}[-/.月]\d{1,2}(?:日)?)/,
    );
    const dateMatch =
      labeledMatch ||
      cleaned.match(/dateModified["']?\s*[:：]\s*["']?(\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2})/i) ||
      cleaned.match(/(\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}(?:日)?)/) ||
      cleaned.match(/(\d{1,2}[-/.月]\d{1,2}(?:日)?)/);

    if (!dateMatch) {
      return "";
    }

    return formatDateParts(dateMatch[1]);
  }

  function formatDateParts(rawDate) {
    const parts = String(rawDate)
      .replace(/[年月.]/g, "-")
      .replace(/日/g, "")
      .replace(/\//g, "-")
      .split("-")
      .filter(Boolean)
      .map((part) => Number(part));

    let year;
    let month;
    let day;

    if (parts.length >= 3 && parts[0] > 31) {
      [year, month, day] = parts;
    } else if (parts.length >= 2) {
      year = new Date().getFullYear();
      [month, day] = parts;
    } else {
      return "";
    }

    if (!isValidDateParts(year, month, day)) {
      return "";
    }

    return `${pad2(day)}/${pad2(month)}/${year}`;
  }

  function isValidDateParts(year, month, day) {
    return (
      Number.isInteger(year) &&
      Number.isInteger(month) &&
      Number.isInteger(day) &&
      year >= 2000 &&
      year <= 2100 &&
      month >= 1 &&
      month <= 12 &&
      day >= 1 &&
      day <= 31
    );
  }

  function pad2(value) {
    return String(value).padStart(2, "0");
  }

  function formatCurrentTime() {
    const now = new Date();
    return `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
  }

  function normalizeTitle(text) {
    return cleanText(text)
      .replace(/[_\-|｜].*?番茄小说.*$/i, "")
      .replace(/番茄小说.*$/i, "")
      .replace(/免费阅读.*$/i, "")
      .replace(/^(第[一二三四五六七八九十百千万两\d]+章)\s*(?=\S)/, "$1 ")
      .trim();
  }

  function findBookName(chapterTitle) {
    const candidates = [];

    BOOK_TITLE_SELECTORS.forEach((selector) => {
      document.querySelectorAll(selector).forEach((element) => {
        if (state.root && state.root.contains(element)) {
          return;
        }

        const text = normalizeBookName(readElementText(element), chapterTitle);
        if (isLikelyBookName(text)) {
          candidates.push(text);
        }
      });
    });

    const titleCandidate = normalizeBookName(document.title || "", chapterTitle);
    if (isLikelyBookName(titleCandidate)) {
      candidates.push(titleCandidate);
    }

    return candidates.sort((a, b) => b.length - a.length)[0] || "番茄小说";
  }

  function normalizeBookName(text, chapterTitle) {
    let cleaned = cleanText(text)
      .replace(/在线免费阅读.*$/i, "")
      .replace(/番茄小说官网.*$/i, "")
      .replace(/番茄小说.*$/i, "")
      .replace(/免费阅读.*$/i, "")
      .replace(/^返回\s*/, "")
      .trim();

    if (chapterTitle) {
      cleaned = cleaned.replace(chapterTitle, "").trim();
      cleaned = cleaned.replace(chapterTitle.replace(/\s+/g, ""), "").trim();
    }

    cleaned = cleaned
      .replace(/第[一二三四五六七八九十百千万两\d]+章.*$/i, "")
      .replace(/[_\-|｜]+$/g, "")
      .trim();

    return cleaned;
  }

  function isLikelyBookName(text) {
    return Boolean(text && text.length >= 2 && text.length <= 80 && !NAV_TEXT_RE.test(text));
  }

  function collectParagraphs(source, title) {
    if (!source) {
      return [];
    }

    let blocks = Array.from(source.querySelectorAll("p"))
      .filter((element) => !hasForbiddenRole(element))
      .map((element) => cleanParagraphText(readElementText(element), title))
      .filter(Boolean);

    if (blocks.length < 2) {
      blocks = collectBlockTexts(source, title);
    }

    if (blocks.length <= 1 && blocks[0]?.includes("\n")) {
      blocks = splitLooseParagraphs(blocks[0], title);
    }

    if (!blocks.length) {
      blocks = splitLooseParagraphs(readElementText(source), title);
    }

    return dedupeParagraphs(blocks);
  }

  function collectBlockTexts(source, title) {
    const blocks = [];

    source.querySelectorAll(BLOCK_SELECTOR).forEach((element) => {
      if (!(element instanceof HTMLElement)) {
        return;
      }
      if (element === source || hasForbiddenRole(element)) {
        return;
      }
      if (state.root && state.root.contains(element)) {
        return;
      }
      if (!isLeafReadableBlock(element)) {
        return;
      }

      const text = cleanParagraphText(readElementText(element), title);
      if (text) {
        blocks.push(text);
      }
    });

    return blocks;
  }

  function isLeafReadableBlock(element) {
    const text = cleanText(readElementText(element));
    if (text.length < 8) {
      return false;
    }

    const meaningfulChildren = Array.from(element.children).filter((child) => {
      if (!(child instanceof HTMLElement) || hasForbiddenRole(child)) {
        return false;
      }
      const childText = cleanText(readElementText(child));
      return childText.length >= 8 && isBlockElement(child);
    });

    return meaningfulChildren.length === 0;
  }

  function isBlockElement(element) {
    return /^(ARTICLE|BLOCKQUOTE|DIV|H1|H2|H3|H4|LI|MAIN|P|SECTION)$/i.test(
      element.tagName,
    );
  }

  function splitLooseParagraphs(text, title) {
    return (text || "")
      .split(/\n+/)
      .map((part) => cleanParagraphText(part, title))
      .filter(Boolean);
  }

  function cleanParagraphText(text, title) {
    const cleaned = cleanText(text);
    if (!cleaned || cleaned === title) {
      return "";
    }
    if (cleaned.length < 8 && !/[。！？!?]/.test(cleaned)) {
      return "";
    }
    if (cleaned.length <= 28 && NAV_TEXT_RE.test(cleaned)) {
      return "";
    }
    if (/^第[一二三四五六七八九十百千万\d]+章/.test(cleaned) && cleaned.length <= 45) {
      return "";
    }
    return cleaned;
  }

  function cleanText(text) {
    return String(text || "")
      .replace(/[\u200b-\u200f\ufeff]/g, "")
      .replace(/[\u00a0\u1680\u180e\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/g, " ")
      .replace(/\r/g, "\n")
      .replace(/[^\S\n]+/g, " ")
      .replace(/\n[ \t]+/g, "\n")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/([\u4e00-\u9fff]) +(?=[\u4e00-\u9fff])/g, "$1")
      .replace(/([\u4e00-\u9fffA-Za-z0-9]) +(?=[，。！？、；：”’」』）】》])/g, "$1")
      .replace(/([“‘「『（【《]) +(?=[\u4e00-\u9fffA-Za-z0-9])/g, "$1")
      .replace(/([，。！？、；：]) +(?=[\u4e00-\u9fff“‘「『（【《])/g, "$1")
      .trim();
  }

  function readElementText(element) {
    if (!(element instanceof HTMLElement)) {
      return element?.textContent || "";
    }

    const visibleText = element.innerText || "";
    if (cleanText(visibleText)) {
      return visibleText;
    }

    return element.textContent || "";
  }

  function dedupeParagraphs(blocks) {
    const seen = new Set();
    const result = [];

    blocks.forEach((block) => {
      const key = block.replace(/\s+/g, "");
      if (!key || seen.has(key)) {
        return;
      }
      seen.add(key);
      result.push(block);
    });

    return result;
  }

  function countReadableCharacters(text) {
    return Array.from(String(text || "").replace(/\s/g, "")).length;
  }

  function createFingerprint(chapter) {
    return [
      chapter.title,
      chapter.bookName,
      chapter.editedDateLabel,
      chapter.loadedTimeLabel,
      chapter.wordCount,
      chapter.paragraphs.length,
      chapter.contentFontFamily,
      chapter.paragraphs.slice(0, 2).join("|"),
      chapter.paragraphs.slice(-2).join("|"),
    ].join("::");
  }

  function createNavigationFingerprint(navigation) {
    return [
      navigation?.prev?.href || "",
      navigation?.prev?.disabled ? "prev-disabled" : "prev-enabled",
      navigation?.next?.href || "",
      navigation?.next?.disabled ? "next-disabled" : "next-enabled",
    ].join("|");
  }

  function getContentFontFamily(source) {
    if (!(source instanceof HTMLElement)) {
      return "";
    }

    const targets = [
      source,
      source.querySelector("p"),
      source.closest(".muye-reader-box"),
      source.closest("[class*='reader-box']"),
      source.closest("[class*='reader']"),
    ].filter((element) => element instanceof HTMLElement);

    for (const element of targets) {
      const fontFamily = getComputedStyle(element).fontFamily;
      if (fontFamily && fontFamily !== "inherit") {
        return fontFamily;
      }
    }

    return "";
  }

  function setSourceContainer(source) {
    if (state.source && state.source !== source) {
      state.source.classList.remove(SOURCE_HIDDEN_CLASS);
    }
    state.source = source;
    applySourceVisibility();
  }

  function applySourceVisibility() {
    if (!state.source) {
      return;
    }

    if (state.settings.enabled) {
      state.source.classList.add(SOURCE_HIDDEN_CLASS);
    } else {
      state.source.classList.remove(SOURCE_HIDDEN_CLASS);
    }
  }

  function unhideSource() {
    if (state.source) {
      state.source.classList.remove(SOURCE_HIDDEN_CLASS);
    }
  }

  function hasForbiddenRole(element) {
    const signal = getElementSignal(element);
    return signal
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean)
      .some(
        (token) =>
          FORBIDDEN_CONTAINER_TOKENS.has(token) ||
          /^(ad|ads|advert|advertisement|banner|catalog|comment|comments|download|footer|header|login|menu|nav|navigation|pay|popup|recommend|search|share|shelf|sidebar|toolbar|vip)/i.test(
            token,
          ),
      );
  }

  function getElementSignal(element) {
    return [
      element.id,
      element.className,
      element.getAttribute("role"),
      element.getAttribute("aria-label"),
      element.getAttribute("data-testid"),
    ]
      .filter(Boolean)
      .map(String)
      .join(" ")
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/[^A-Za-z0-9\u4e00-\u9fff]+/g, " ")
      .trim();
  }

  function findNavigation() {
    const linksAndButtons = Array.from(
      document.querySelectorAll("a, button, [role='button']"),
    ).filter((element) => !(state.root && state.root.contains(element)));

    return {
      prev: findNavCandidate(linksAndButtons, PREV_RE),
      next: findNavCandidate(linksAndButtons, NEXT_RE),
    };
  }

  function findNavCandidate(elements, pattern) {
    for (const element of elements) {
      const text = cleanText(
        [
          element.textContent,
          element.getAttribute("aria-label"),
          element.getAttribute("title"),
          element.getAttribute("data-title"),
        ]
          .filter(Boolean)
          .join(" "),
      );

      if (!pattern.test(text)) {
        continue;
      }

      const disabled =
        element.disabled ||
        element.getAttribute("aria-disabled") === "true" ||
        /disabled/i.test(element.className || "");
      const href = element instanceof HTMLAnchorElement ? element.href : "";

      return {
        element,
        href,
        disabled: Boolean(disabled),
      };
    }

    return null;
  }

  function render(positionToRestore = null) {
    ensureRoot();
    const previousPosition =
      positionToRestore || capturePagePosition(state.root.querySelector(".fq-doc-scroller"));
    applySourceVisibility();

    state.root.className = "";
    state.root.dataset.theme = resolveTheme(state.settings.theme);
    state.root.dataset.themeChoice = state.settings.theme;
    state.root.style.setProperty("--fq-doc-font-size", `${state.settings.fontSize}px`);
    state.root.style.setProperty("--fq-doc-line-height", String(state.settings.lineHeight));
    state.root.style.setProperty(
      "--fq-doc-content-font-family",
      state.chapter.contentFontFamily || "serif",
    );
    state.root.style.setProperty(
      "--fq-doc-page-width",
      `${A4_PAGE_WIDTH}px`,
    );
    const pageHeight = Math.round(A4_PAGE_WIDTH * A4_RATIO);
    const pageScale = state.settings.pageScale / 100;
    state.root.style.setProperty(
      "--fq-doc-page-height",
      `${pageHeight}px`,
    );
    state.root.style.setProperty(
      "--fq-doc-page-frame-width",
      `${Math.round(A4_PAGE_WIDTH * pageScale)}px`,
    );
    state.root.style.setProperty(
      "--fq-doc-page-frame-height",
      `${Math.round(pageHeight * pageScale)}px`,
    );
    state.root.style.setProperty(
      "--fq-doc-page-scale",
      String(roundTo(pageScale, 2)),
    );

    if (!state.settings.enabled) {
      renderCollapsed();
      document.body?.classList.remove(BODY_ACTIVE_CLASS);
      return;
    }

    document.body?.classList.add(BODY_ACTIVE_CLASS);
    renderReader(previousPosition);
  }

  function renderCollapsed() {
    state.root.replaceChildren();
    state.root.classList.add("fq-doc-collapsed");

    const button = createButton({
      className: "fq-doc-restore",
      title: "开启文档模式",
      text: "文档模式",
      onClick: () => updateSettings({ enabled: true }),
    });
    state.root.append(button);
  }

  function resolveTheme(theme) {
    if (theme !== "system") {
      return theme;
    }
    return window.matchMedia?.(SYSTEM_DARK_QUERY).matches ? "dark" : "paper";
  }

  function renderReader(previousPosition) {
    state.root.replaceChildren();
    state.root.classList.add("fq-doc-shell");

    const toolbar = createToolbar();
    const workspace = document.createElement("main");
    workspace.className = "fq-doc-workspace";

    const scroller = document.createElement("div");
    scroller.className = "fq-doc-scroller";
    scroller.addEventListener("scroll", scheduleProgressUpdate, { passive: true });

    workspace.append(scroller);
    state.root.append(toolbar, workspace);
    renderPaginatedPages(scroller);
    restorePagePosition(scroller, previousPosition);
    updateProgress(scroller);

    if (document.fonts?.ready) {
      document.fonts.ready.then(() => {
        if (state.root?.contains(scroller)) {
          const fontReadyPosition = capturePagePosition(scroller);
          renderPaginatedPages(scroller);
          restorePagePosition(scroller, fontReadyPosition);
          updateProgress(scroller);
        }
      });
    }
  }

  function renderPaginatedPages(scroller) {
    scroller.replaceChildren();

    const contentNodes = createChapterContentNodes();
    const pages = [];
    let page = createPageShell(1);
    let body = page.querySelector(".fq-doc-page-body");
    pages.push(page);
    appendPageToScroller(scroller, page);

    contentNodes.forEach((node) => {
      body.append(node);

      if (isPageBodyOverflowing(body) && body.childElementCount > 1) {
        body.removeChild(node);
        page = createPageShell(pages.length + 1);
        body = page.querySelector(".fq-doc-page-body");
        pages.push(page);
        appendPageToScroller(scroller, page);
        body.append(node);
      }
    });

    state.pageCount = pages.length || 1;
    pages.forEach((pageNode, index) => {
      pageNode.dataset.page = String(index + 1);
      const footer = pageNode.querySelector(".fq-doc-page-foot");
      if (footer) {
        footer.textContent = `${index + 1} / ${state.pageCount}`;
      }
    });
    updatePageCounter(state.currentPage, state.pageCount);
  }

  function appendPageToScroller(scroller, page) {
    const frame = document.createElement("div");
    frame.className = "fq-doc-page-frame";
    frame.append(page);
    scroller.append(frame);
  }

  function createPageShell(pageNumber) {
    const page = document.createElement("article");
    page.className = "fq-doc-page";

    const header = document.createElement("header");
    header.className = "fq-doc-page-head";

    const file = document.createElement("span");
    file.className = "fq-doc-page-file";
    file.textContent = `${formatDocumentName(state.chapter.bookName)}.pdf`;

    const chapter = document.createElement("span");
    chapter.className = "fq-doc-page-chapter";
    chapter.textContent = state.chapter.title;

    header.append(file, chapter);

    const body = document.createElement("section");
    body.className = "fq-doc-page-body";

    const footer = document.createElement("footer");
    footer.className = "fq-doc-page-foot";
    footer.textContent = String(pageNumber);

    page.append(header, body, footer);
    return page;
  }

  function createChapterContentNodes() {
    const nodes = [];

    const heading = document.createElement("h1");
    heading.className = "fq-doc-title";
    heading.textContent = state.chapter.title;
    nodes.push(heading);

    const rule = document.createElement("div");
    rule.className = "fq-doc-title-rule";
    nodes.push(rule);

    if (state.chapter.paragraphs.length) {
      state.chapter.paragraphs.forEach((paragraph) => {
        const node = document.createElement("p");
        node.className = "fq-doc-paragraph";
        node.textContent = paragraph;
        nodes.push(node);
      });
    } else {
      const empty = document.createElement("p");
      empty.className = "fq-doc-empty";
      empty.textContent = "正文加载中，稍后会自动重排。";
      nodes.push(empty);
    }

    return nodes;
  }

  function isPageBodyOverflowing(body) {
    return body.scrollHeight > body.clientHeight + 1;
  }

  function createToolbar() {
    const toolbar = document.createElement("header");
    toolbar.className = "fq-doc-toolbar";

    const left = document.createElement("div");
    left.className = "fq-doc-toolbar-group fq-doc-toolbar-primary";

    left.append(
      createButton({
        className: "fq-doc-icon-button",
        title: "关闭文档模式",
        text: "返回",
        onClick: () => updateSettings({ enabled: false }),
      }),
      createEditedTimeTitle(),
    );

    const center = document.createElement("div");
    center.className = "fq-doc-toolbar-group fq-doc-toolbar-controls";

    center.append(
      createPageCounter(),
      createToolbarDivider(),
      createScaleControl(),
      createToolbarDivider(),
      createNumberInputControl({
        label: "字号",
        prefix: "字号",
        value: state.settings.fontSize,
        min: 14,
        max: 28,
        step: 1,
        suffix: "px",
        onCommit: (fontSize) => updateSettings({ fontSize }),
      }),
      createToolbarDivider(),
      createChapterNavControls(),
    );

    const right = document.createElement("div");
    right.className = "fq-doc-toolbar-group fq-doc-toolbar-status";
    right.append(createStatus(), createToolbarActions());

    toolbar.append(left, center, right);
    return toolbar;
  }

  function createStepper({ label, minusTitle, plusTitle, valueText, onMinus, onPlus }) {
    const group = document.createElement("div");
    group.className = "fq-doc-stepper";

    const labelNode = document.createElement("span");
    labelNode.className = "fq-doc-control-label";
    labelNode.textContent = label;

    const controls = document.createElement("span");
    controls.className = "fq-doc-stepper-controls";
    controls.append(
      createButton({
        className: "fq-doc-icon-button fq-doc-mini-button",
        title: minusTitle,
        text: "−",
        onClick: onMinus,
      }),
      createValue(valueText),
      createButton({
        className: "fq-doc-icon-button fq-doc-mini-button",
        title: plusTitle,
        text: "+",
        onClick: onPlus,
      }),
    );

    group.append(labelNode, controls);
    return group;
  }

  function createSegmentedControl({ label, value, options, onChange }) {
    const group = document.createElement("div");
    group.className = "fq-doc-segmented-wrap";

    const labelNode = document.createElement("span");
    labelNode.className = "fq-doc-control-label";
    labelNode.textContent = label;

    const segmented = document.createElement("div");
    segmented.className = "fq-doc-segmented";
    segmented.setAttribute("role", "group");
    segmented.setAttribute("aria-label", label);

    options.forEach((option) => {
      segmented.append(
        createButton({
          className: "fq-doc-segment",
          title: option.text,
          text: option.text,
          pressed: option.value === value,
          onClick: () => onChange(option.value),
        }),
      );
    });

    group.append(labelNode, segmented);
    return group;
  }

  function createValue(text) {
    const value = document.createElement("span");
    value.className = "fq-doc-value";
    value.textContent = text;
    return value;
  }

  function createPageCounter() {
    const counter = document.createElement("span");
    counter.className = "fq-doc-page-counter";

    const input = document.createElement("input");
    input.className = "fq-doc-page-input";
    input.type = "number";
    input.inputMode = "numeric";
    input.min = "1";
    input.max = String(Math.max(1, state.pageCount));
    input.step = "1";
    input.value = String(state.currentPage);
    input.setAttribute("aria-label", "页码");

    const total = document.createElement("span");
    total.className = "fq-doc-page-total";
    total.textContent = `/ ${Math.max(1, state.pageCount)}`;

    const commit = () => {
      const page = Math.round(clampNumber(input.value, 1, Math.max(1, state.pageCount), state.currentPage));
      input.value = String(page);
      scrollToPage(page);
    };

    input.addEventListener("change", commit);
    input.addEventListener("blur", commit);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        input.blur();
      }
    });

    counter.append(input, total);
    return counter;
  }

  function createToolbarDivider() {
    const divider = document.createElement("span");
    divider.className = "fq-doc-toolbar-divider";
    divider.setAttribute("aria-hidden", "true");
    return divider;
  }

  function createNumberInputControl({ label, prefix, value, min, max, step, suffix, onCommit }) {
    const group = document.createElement("label");
    group.className = "fq-doc-number-control";
    group.title = label;
    group.setAttribute("aria-label", label);

    if (prefix) {
      const prefixNode = document.createElement("span");
      prefixNode.className = "fq-doc-number-prefix";
      prefixNode.textContent = prefix;
      group.append(prefixNode);
    }

    const input = document.createElement("input");
    input.className = "fq-doc-number-input";
    input.type = "number";
    input.inputMode = "numeric";
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(value);
    input.setAttribute("aria-label", label);

    const commit = () => {
      const nextValue = clampNumber(input.value, min, max, value);
      input.value = String(nextValue);
      if (nextValue !== value) {
        onCommit(nextValue);
      }
    };

    input.addEventListener("change", commit);
    input.addEventListener("blur", commit);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        input.blur();
      }
    });

    group.append(input);
    if (suffix) {
      const suffixNode = document.createElement("span");
      suffixNode.className = "fq-doc-number-suffix";
      suffixNode.textContent = suffix;
      group.append(suffixNode);
    }

    return group;
  }

  function createScaleControl() {
    const group = document.createElement("span");
    group.className = "fq-doc-scale-control";
    group.append(
      createButton({
        className: "fq-doc-icon-button fq-doc-scale-button",
        title: "缩小页面",
        text: "−",
        onClick: () => adjustPageScale(-PAGE_SCALE_STEP),
      }),
      createNumberInputControl({
        label: "页面缩放",
        value: state.settings.pageScale,
        min: PAGE_SCALE_MIN,
        max: PAGE_SCALE_MAX,
        step: PAGE_SCALE_STEP,
        suffix: "%",
        onCommit: (pageScale) => setPageScale(pageScale),
      }),
      createButton({
        className: "fq-doc-icon-button fq-doc-scale-button",
        title: "放大页面",
        text: "+",
        onClick: () => adjustPageScale(PAGE_SCALE_STEP),
      }),
    );
    return group;
  }

  function createChapterNavControls() {
    const group = document.createElement("span");
    group.className = "fq-doc-chapter-nav";
    group.append(
      createButton({
        className: "fq-doc-icon-button fq-doc-nav-button",
        title: "上一章",
        text: "←",
        disabled: !state.navigation?.prev || state.navigation.prev.disabled,
        onClick: () => activateNavigation("prev"),
      }),
      createButton({
        className: "fq-doc-icon-button fq-doc-nav-button",
        title: "下一章",
        text: "→",
        disabled: !state.navigation?.next || state.navigation.next.disabled,
        onClick: () => activateNavigation("next"),
      }),
    );
    return group;
  }

  function createStatus() {
    const status = document.createElement("span");
    status.className = "fq-doc-status";
    status.setAttribute("aria-live", "polite");
    status.textContent = buildStatusText(0, 1, state.pageCount);
    return status;
  }

  function createToolbarActions() {
    const actions = document.createElement("div");
    actions.className = "fq-doc-toolbar-actions";
    actions.append(
      createStaticToolbarIcon({ title: "下载", icon: "download" }),
      createToolbarActionButton({ title: "打印", icon: "print", onClick: () => window.print() }),
      createStaticToolbarIcon({ title: "更多", icon: "more" }),
    );
    return actions;
  }

  function createStaticToolbarIcon({ title, icon }) {
    const item = document.createElement("span");
    item.className = "fq-doc-action-button fq-doc-action-static";
    item.title = title;
    item.setAttribute("role", "img");
    item.setAttribute("aria-label", title);
    item.innerHTML = getToolbarIconSvg(icon);
    return item;
  }

  function createToolbarActionButton({ title, icon, onClick }) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "fq-doc-action-button";
    button.title = title;
    button.setAttribute("aria-label", title);
    button.innerHTML = getToolbarIconSvg(icon);
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      onClick?.();
    });
    return button;
  }

  function getToolbarIconSvg(icon) {
    const icons = {
      download: '<path d="M12 3v12"></path><path d="m7 10 5 5 5-5"></path><path d="M5 21h14"></path>',
      print:
        '<path d="M6 9V3h12v6"></path><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"></path><path d="M6 14h12v7H6z"></path>',
      more:
        '<circle cx="12" cy="5" r="1.4"></circle><circle cx="12" cy="12" r="1.4"></circle><circle cx="12" cy="19" r="1.4"></circle>',
    };
    return `<svg class="fq-doc-action-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${icons[icon] || icons.more}</svg>`;
  }

  function createEditedTimeTitle() {
    const title = document.createElement("div");
    title.className = "fq-doc-file-title";
    title.textContent = `最后编辑：${state.chapter.editedDateLabel || "未知"} ${state.chapter.loadedTimeLabel || ""}`.trim();
    title.title = title.textContent;
    title.setAttribute("aria-label", title.textContent);
    return title;
  }

  function formatDocumentName(bookName) {
    return cleanText(bookName || "番茄小说")
      .replace(/[\\/:*?"<>|]+/g, "")
      .replace(/\.+$/g, "")
      .trim() || "番茄小说";
  }

  function buildStatusText(progress, currentPage = 1, totalPages = state.pageCount) {
    const count = state.chapter.wordCount
      ? `${state.chapter.wordCount.toLocaleString("zh-CN")} 字`
      : "等待正文";
    return `${count} · ${Math.round(progress)}%`;
  }

  function createButton({ className, title, text, disabled, pressed, onClick }) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className;
    button.title = title;
    button.setAttribute("aria-label", title);
    button.textContent = text;
    if (typeof pressed === "boolean") {
      button.setAttribute("aria-pressed", String(pressed));
    }
    if (disabled) {
      button.disabled = true;
    }
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!button.disabled) {
        onClick?.();
      }
    });
    return button;
  }

  function adjustPageScale(delta) {
    setPageScale(state.settings.pageScale + delta);
  }

  function setPageScale(pageScale) {
    const nextScale = clampNumber(
      pageScale,
      PAGE_SCALE_MIN,
      PAGE_SCALE_MAX,
      DEFAULT_SETTINGS.pageScale,
    );
    if (nextScale === state.settings.pageScale) {
      return;
    }
    updateSettings({ pageScale: nextScale });
  }

  async function updateSettings(partial) {
    const positionToRestore = capturePagePosition(state.root?.querySelector(".fq-doc-scroller"));
    state.settings = normalizeSettings({ ...state.settings, ...partial });
    await storage.set(partial);
    state.lastRenderKey = "";
    render(positionToRestore);
  }

  function roundTo(value, digits) {
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
  }

  function activateNavigation(direction) {
    const candidate = state.navigation?.[direction];
    if (!candidate || candidate.disabled) {
      return;
    }

    if (candidate.href) {
      location.href = candidate.href;
      return;
    }

    candidate.element.click();
    scheduleRefresh(500);
  }

  function scheduleProgressUpdate(event) {
    const scroller = event.currentTarget;
    cancelAnimationFrame(state.progressFrame);
    state.progressFrame = requestAnimationFrame(() => updateProgress(scroller));
  }

  function capturePagePosition(scroller) {
    if (!scroller) {
      return null;
    }

    const pages = Array.from(scroller.querySelectorAll(".fq-doc-page"));
    if (!pages.length) {
      return { page: state.currentPage, offsetRatio: 0 };
    }

    const marker = scroller.scrollTop + 8;
    let pageIndex = 0;
    pages.forEach((page, index) => {
      if (getPageStartScrollTop(scroller, page) <= marker) {
        pageIndex = index;
      }
    });

    const pageStart = getPageStartScrollTop(scroller, pages[pageIndex]);
    const nextPageStart = pages[pageIndex + 1]
      ? getPageStartScrollTop(scroller, pages[pageIndex + 1])
      : scroller.scrollHeight;
    const pageSpan = Math.max(1, nextPageStart - pageStart);

    return {
      page: pageIndex + 1,
      offsetRatio: Math.min(1, Math.max(0, (scroller.scrollTop - pageStart) / pageSpan)),
    };
  }

  function restorePagePosition(scroller, position) {
    if (!position || !scroller) {
      scroller.scrollTop = 0;
      return;
    }

    const pages = Array.from(scroller.querySelectorAll(".fq-doc-page"));
    const pageIndex = Math.min(Math.max(1, position.page), pages.length || 1) - 1;
    const page = pages[pageIndex];
    if (!page) {
      scroller.scrollTop = 0;
      return;
    }

    const pageStart = getPageStartScrollTop(scroller, page);
    const nextPageStart = pages[pageIndex + 1]
      ? getPageStartScrollTop(scroller, pages[pageIndex + 1])
      : scroller.scrollHeight;
    const pageSpan = Math.max(1, nextPageStart - pageStart);
    scroller.scrollTop = Math.max(0, pageStart + pageSpan * position.offsetRatio);
  }

  function getPageStartScrollTop(scroller, page) {
    const header = page.querySelector(".fq-doc-page-head") || page;
    const scrollerRect = scroller.getBoundingClientRect();
    const headerRect = header.getBoundingClientRect();
    return scroller.scrollTop + headerRect.top - scrollerRect.top;
  }

  function updateProgress(scroller) {
    const status = state.root?.querySelector(".fq-doc-status");
    if (!status || !scroller) {
      return;
    }

    const pages = Array.from(scroller.querySelectorAll(".fq-doc-page"));
    const marker = scroller.scrollTop + 8;
    let currentPage = 1;
    pages.forEach((page, index) => {
      if (getPageStartScrollTop(scroller, page) <= marker) {
        currentPage = index + 1;
      }
    });
    state.currentPage = currentPage;
    state.pageCount = pages.length || state.pageCount;
    updatePageCounter(currentPage, pages.length || state.pageCount);
    const maxScroll = Math.max(1, scroller.scrollHeight - scroller.clientHeight);
    const progress = Math.min(100, Math.max(0, (scroller.scrollTop / maxScroll) * 100));
    status.textContent = buildStatusText(progress, currentPage, pages.length || state.pageCount);
  }

  function updatePageCounter(currentPage, totalPages) {
    const counter = state.root?.querySelector(".fq-doc-page-counter");
    if (!counter) {
      return;
    }
    const input = counter.querySelector(".fq-doc-page-input");
    const total = counter.querySelector(".fq-doc-page-total");
    if (input instanceof HTMLInputElement) {
      input.max = String(Math.max(1, totalPages));
      if (document.activeElement !== input) {
        input.value = String(currentPage);
      }
    }
    if (total) {
      total.textContent = `/ ${Math.max(1, totalPages)}`;
    }
  }

  function scrollToPage(pageNumber) {
    const scroller = state.root?.querySelector(".fq-doc-scroller");
    const pages = Array.from(state.root?.querySelectorAll(".fq-doc-page") || []);
    const page = pages[pageNumber - 1];
    if (!scroller || !page) {
      return;
    }
    scroller.scrollTo({
      top: Math.max(0, getPageStartScrollTop(scroller, page)),
      behavior: "smooth",
    });
  }
})();
