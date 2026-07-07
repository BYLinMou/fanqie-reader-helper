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
    fontSize: 18,
    lineHeight: 1.85,
    pageWidth: "normal",
    theme: "paper",
  };

  const PAGE_WIDTHS = {
    narrow: 720,
    normal: 860,
    wide: 1040,
  };
  const A4_RATIO = 297 / 210;

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
      paragraphs: [],
      wordCount: 0,
      contentFontFamily: "",
    },
    fingerprint: "",
    observer: null,
    refreshTimer: 0,
    progressFrame: 0,
    pageCount: 1,
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
    refresh("init");

    [250, 900, 1800, 3500].forEach((delay) => {
      window.setTimeout(() => refresh("delayed"), delay);
    });
  }

  function normalizeSettings(input) {
    const next = { ...DEFAULT_SETTINGS, ...(input || {}) };
    next.enabled = Boolean(next.enabled);
    next.fontSize = clampNumber(next.fontSize, 14, 28, DEFAULT_SETTINGS.fontSize);
    next.lineHeight = clampNumber(
      next.lineHeight,
      1.35,
      2.4,
      DEFAULT_SETTINGS.lineHeight,
    );
    if (!Object.prototype.hasOwnProperty.call(PAGE_WIDTHS, next.pageWidth)) {
      next.pageWidth = DEFAULT_SETTINGS.pageWidth;
    }
    if (!["paper", "green", "dark"].includes(next.theme)) {
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

    if (fingerprint !== state.fingerprint || reason === "init") {
      state.chapter = extracted;
      state.fingerprint = fingerprint;
    }

    state.navigation = navigation;
    render();
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
    const paragraphs = source ? collectParagraphs(source, title) : [];
    const wordCount = countReadableCharacters(paragraphs.join(""));
    const contentFontFamily = getContentFontFamily(source);
    setSourceContainer(source);

    return {
      title: title || "正在等待正文",
      bookName,
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
      chapter.wordCount,
      chapter.paragraphs.length,
      chapter.contentFontFamily,
      chapter.paragraphs.slice(0, 2).join("|"),
      chapter.paragraphs.slice(-2).join("|"),
    ].join("::");
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

  function render() {
    ensureRoot();
    applySourceVisibility();

    state.root.className = "";
    state.root.dataset.theme = state.settings.theme;
    state.root.style.setProperty("--fq-doc-font-size", `${state.settings.fontSize}px`);
    state.root.style.setProperty("--fq-doc-line-height", String(state.settings.lineHeight));
    state.root.style.setProperty(
      "--fq-doc-content-font-family",
      state.chapter.contentFontFamily || "serif",
    );
    state.root.style.setProperty(
      "--fq-doc-page-width",
      `${PAGE_WIDTHS[state.settings.pageWidth]}px`,
    );
    state.root.style.setProperty(
      "--fq-doc-page-height",
      `${Math.round(PAGE_WIDTHS[state.settings.pageWidth] * A4_RATIO)}px`,
    );

    if (!state.settings.enabled) {
      renderCollapsed();
      document.body?.classList.remove(BODY_ACTIVE_CLASS);
      return;
    }

    document.body?.classList.add(BODY_ACTIVE_CLASS);
    renderReader();
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

  function renderReader() {
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
    updateProgress(scroller);

    if (document.fonts?.ready) {
      document.fonts.ready.then(() => {
        if (state.root?.contains(scroller)) {
          renderPaginatedPages(scroller);
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
    scroller.append(page);

    contentNodes.forEach((node) => {
      body.append(node);

      if (isPageBodyOverflowing(body) && body.childElementCount > 1) {
        body.removeChild(node);
        page = createPageShell(pages.length + 1);
        body = page.querySelector(".fq-doc-page-body");
        pages.push(page);
        scroller.append(page);
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
    chapter.textContent = pageNumber === 1 ? state.chapter.title : "";

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
        text: "原网页",
        onClick: () => updateSettings({ enabled: false }),
      }),
      createButton({
        className: "fq-doc-icon-button",
        title: "上一章",
        text: "←",
        disabled: !state.navigation?.prev || state.navigation.prev.disabled,
        onClick: () => activateNavigation("prev"),
      }),
      createButton({
        className: "fq-doc-icon-button",
        title: "下一章",
        text: "→",
        disabled: !state.navigation?.next || state.navigation.next.disabled,
        onClick: () => activateNavigation("next"),
      }),
      createFileTitle(),
    );

    const center = document.createElement("div");
    center.className = "fq-doc-toolbar-group fq-doc-toolbar-controls";

    center.append(
      createStepper({
        label: "字号",
        minusTitle: "减小字号",
        plusTitle: "增大字号",
        valueText: `${state.settings.fontSize}px`,
        onMinus: () =>
          updateSettings({
            fontSize: clampNumber(state.settings.fontSize - 1, 14, 28, 18),
          }),
        onPlus: () =>
          updateSettings({
            fontSize: clampNumber(state.settings.fontSize + 1, 14, 28, 18),
          }),
      }),
      createStepper({
        label: "行距",
        minusTitle: "减小行距",
        plusTitle: "增大行距",
        valueText: state.settings.lineHeight.toFixed(2),
        onMinus: () =>
          updateSettings({
            lineHeight: roundTo(
              clampNumber(state.settings.lineHeight - 0.05, 1.35, 2.4, 1.85),
              2,
            ),
          }),
        onPlus: () =>
          updateSettings({
            lineHeight: roundTo(
              clampNumber(state.settings.lineHeight + 0.05, 1.35, 2.4, 1.85),
              2,
            ),
          }),
      }),
      createSegmentedControl({
        label: "页面",
        value: state.settings.pageWidth,
        options: [
          { value: "narrow", text: "窄" },
          { value: "normal", text: "标准" },
          { value: "wide", text: "宽" },
        ],
        onChange: (pageWidth) => updateSettings({ pageWidth }),
      }),
      createSegmentedControl({
        label: "主题",
        value: state.settings.theme,
        options: [
          { value: "paper", text: "浅色" },
          { value: "green", text: "护眼" },
          { value: "dark", text: "深色" },
        ],
        onChange: (theme) => updateSettings({ theme }),
      }),
    );

    const right = document.createElement("div");
    right.className = "fq-doc-toolbar-group fq-doc-toolbar-status";
    right.append(createStatus());

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

  function createStatus() {
    const status = document.createElement("span");
    status.className = "fq-doc-status";
    status.setAttribute("aria-live", "polite");
    status.textContent = buildStatusText(0, 1, state.pageCount);
    return status;
  }

  function createFileTitle() {
    const title = document.createElement("div");
    title.className = "fq-doc-file-title";
    title.textContent = `${formatDocumentName(state.chapter.bookName)}.pdf`;
    title.title = title.textContent;
    title.setAttribute("aria-label", `文档标题：${title.textContent}`);
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
    return `${count} · ${currentPage}/${Math.max(1, totalPages)} 页 · ${Math.round(progress)}%`;
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

  async function updateSettings(partial) {
    state.settings = normalizeSettings({ ...state.settings, ...partial });
    await storage.set(partial);
    render();
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

  function updateProgress(scroller) {
    const status = state.root?.querySelector(".fq-doc-status");
    if (!status || !scroller) {
      return;
    }

    const pages = Array.from(scroller.querySelectorAll(".fq-doc-page"));
    const marker = scroller.scrollTop + 12;
    const currentPage =
      pages.findIndex((page) => page.offsetTop + page.offsetHeight > marker) + 1 || 1;
    const maxScroll = Math.max(1, scroller.scrollHeight - scroller.clientHeight);
    const progress = Math.min(100, Math.max(0, (scroller.scrollTop / maxScroll) * 100));
    status.textContent = buildStatusText(progress, currentPage, pages.length || state.pageCount);
  }
})();
