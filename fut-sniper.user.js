// ==UserScript==
// @name         FUT Sniper
// @namespace    fut-sniper
// @version      0.8.0
// @description  EA FC Web App tek hedef sniper
// @match        https://www.ea.com/*ultimate-team/web-app*
// @grant        none
// @run-at       document-idle
// ==/UserScript==
(() => {
  // src/config.js
  var DEFAULTS = Object.freeze({
    delayMinMs: 3500,
    delayMaxMs: 6e3,
    breakEveryMin: 25,
    breakEveryMax: 35,
    breakMinMs: 15e3,
    breakMaxMs: 3e4,
    // aramaların bu kadarında kısa "dalgınlık" duraklaması (insan gibi düzensizlik)
    hiccupChance: 0.08,
    hiccupMinMs: 1e4,
    hiccupMaxMs: 25e3,
    // çalış–dinlen döngüsü: dinlenmeden sonra kendiliğinden devam eder
    workMinMs: 24e5,
    workMaxMs: 36e5,
    restMinMs: 12e5,
    restMaxMs: 24e5,
    dailyMaxSearches: 3500,
    maxBuys: 5,
    dryRun: true,
    maxBuy: 0,
    player: null
  });
  var MIN_SAFE_DELAY_MS = 3e3;
  var SETTINGS_KEY = "futSniper.settings";
  var DAILY_KEY = "futSniper.daily";
  var SETTINGS_VERSION = 2;
  var REMOVED_KEYS = ["sessionMaxSearches", "sessionMaxMs"];
  var V1_DAILY_DEFAULT = 2500;
  function migrate(saved) {
    if (saved._v === SETTINGS_VERSION) return saved;
    const out = { ...saved };
    for (const key of REMOVED_KEYS) delete out[key];
    if (out.dailyMaxSearches === V1_DAILY_DEFAULT) delete out.dailyMaxSearches;
    return out;
  }
  function loadSettings(storage) {
    try {
      const { _v, ...saved } = migrate(JSON.parse(storage.getItem(SETTINGS_KEY)) ?? {});
      return { ...DEFAULTS, ...saved };
    } catch {
      return { ...DEFAULTS };
    }
  }
  function saveSettings(storage, settings) {
    const changed = { _v: SETTINGS_VERSION };
    for (const [key, value] of Object.entries(settings)) {
      if (JSON.stringify(value) !== JSON.stringify(DEFAULTS[key])) changed[key] = value;
    }
    storage.setItem(SETTINGS_KEY, JSON.stringify(changed));
  }
  function todayKey(date = /* @__PURE__ */ new Date()) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  function loadDaily(storage, today) {
    try {
      const daily = JSON.parse(storage.getItem(DAILY_KEY));
      if (daily && daily.date === today && Number.isInteger(daily.count)) return daily;
    } catch {
    }
    return { date: today, count: 0 };
  }
  function saveDaily(storage, daily) {
    storage.setItem(DAILY_KEY, JSON.stringify(daily));
  }
  function delayWarning(settings) {
    return settings.delayMinMs < MIN_SAFE_DELAY_MS ? "Uwaga: odstęp poniżej 3 sekund. Ustawienia nie gwarantują ochrony przed blokadą." : null;
  }

  // src/pricing.js
  var MIN_PRICE = 150;
  var MIN_BUY_RATIO = 0.4;
  var STEPS = [
    [1e3, 50],
    [1e4, 100],
    [5e4, 250],
    [1e5, 500],
    [Infinity, 1e3]
  ];
  function stepFor(price) {
    for (const [limit, step] of STEPS) {
      if (price < limit) return step;
    }
  }
  function roundDown(price) {
    const step = stepFor(price);
    return Math.floor(price / step) * step;
  }
  function randomMinBuy(maxBuy, rand) {
    const cap = Math.floor(maxBuy * MIN_BUY_RATIO);
    const options = [0];
    for (let p = MIN_PRICE; p <= cap; p += stepFor(p)) options.push(p);
    return options[Math.floor(rand() * options.length)];
  }

  // src/pacer.js
  function randInt(rand, min, max) {
    return min + Math.floor(rand() * (max - min + 1));
  }
  function randBetween(rand, min, max) {
    return Math.round(min + rand() * (max - min));
  }
  function createPacer(settings, { now, rand, today, daily }) {
    let sessionSearches = 0;
    let buys = 0;
    let sinceBreak = 0;
    let breakAt = randInt(rand, settings.breakEveryMin, settings.breakEveryMax);
    let workEndsAt = now() + randBetween(rand, settings.workMinMs, settings.workMaxMs);
    let dailyDate = daily.date;
    let dailyCount = daily.count;
    function syncDay() {
      const d = today();
      if (d !== dailyDate) {
        dailyDate = d;
        dailyCount = 0;
      }
    }
    function next() {
      syncDay();
      if (buys >= settings.maxBuys) return { action: "stop", reason: "maxBuys" };
      if (dailyCount >= settings.dailyMaxSearches) return { action: "stop", reason: "daily" };
      if (now() >= workEndsAt) {
        const restMs = randBetween(rand, settings.restMinMs, settings.restMaxMs);
        workEndsAt = now() + restMs + randBetween(rand, settings.workMinMs, settings.workMaxMs);
        sinceBreak = 0;
        return { action: "rest", waitMs: restMs };
      }
      if (sinceBreak >= breakAt) {
        sinceBreak = 0;
        breakAt = randInt(rand, settings.breakEveryMin, settings.breakEveryMax);
        return { action: "break", waitMs: randBetween(rand, settings.breakMinMs, settings.breakMaxMs) };
      }
      const hiccup = rand() >= 1 - settings.hiccupChance;
      const waitMs = hiccup ? randBetween(rand, settings.hiccupMinMs, settings.hiccupMaxMs) : randBetween(rand, settings.delayMinMs, settings.delayMaxMs);
      return { action: "search", waitMs };
    }
    function recordSearch() {
      syncDay();
      sessionSearches++;
      dailyCount++;
      sinceBreak++;
    }
    function recordBuy() {
      buys++;
    }
    function stats() {
      return { sessionSearches, buys, daily: { date: dailyDate, count: dailyCount } };
    }
    return { next, recordSearch, recordBuy, stats };
  }

  // src/market.js
  var STATUS_KINDS = {
    458: "captcha",
    429: "rateLimited",
    512: "rateLimited",
    521: "rateLimited",
    494: "rateLimited",
    401: "sessionExpired",
    461: "lost",
    426: "lost",
    478: "lost",
    470: "insufficientCoins",
    473: "pileFull"
  };
  var MarketError = class extends Error {
    constructor(kind, status, message = `${kind}${status ? ` (${status})` : ""}`) {
      super(message);
      this.kind = kind;
      this.status = status;
    }
  };
  function classifyStatus(status) {
    if (STATUS_KINDS[status]) return STATUS_KINDS[status];
    if (status >= 500 && status < 600) return "server";
    return "unknown";
  }
  function normalizeItem(raw) {
    return {
      tradeId: raw._auction.tradeId,
      buyNowPrice: raw._auction.buyNowPrice,
      definitionId: raw.definitionId,
      rating: raw.rating,
      rareflag: raw.rareflag,
      raw
    };
  }
  function observe(observable) {
    return new Promise((resolve) => observable.observe(void 0, (_sender, res) => resolve(res)));
  }
  function fail(res) {
    const status = res.error?.code ?? res.status;
    return new MarketError(classifyStatus(status), status);
  }
  function createMarket(g = globalThis) {
    return {
      // cardId: belirli bir kart versiyonu (definitionId); yoksa oyuncunun tüm versiyonları aranır.
      async search({ playerId, cardId, maxBuy, minBuy, page = 1, pageSize = 20, rarityId = null }) {
        if (page === 1) g.services.Item.clearTransferMarketCache();
        const criteria = new g.UTSearchCriteriaDTO();
        criteria.type = g.SearchType.PLAYER;
        if (cardId) criteria.defId = [cardId];
        else criteria.maskedDefId = playerId;
        if (Number.isInteger(rarityId) && rarityId >= 0) criteria.rarities = [rarityId];
        criteria.maxBuy = maxBuy;
        criteria.minBuy = minBuy;
        criteria.count = pageSize;
        criteria.offset = (page - 1) * pageSize;
        const res = await observe(g.services.Item.searchTransferMarket(criteria, page));
        if (!res.success) throw fail(res);
        return (res.data?.items ?? []).map(normalizeItem);
      },
      async buy(item) {
        const res = await observe(g.services.Item.bid(item.raw, item.buyNowPrice));
        if (!res.success) throw fail(res);
      },
      rarityName(rareflag) {
        const name = g.services.Localization.localize(`item.raretype${rareflag}`);
        return name.startsWith("*") ? `Specjalna (${rareflag})` : name;
      }
    };
  }

  // src/sniper.js
  var SERVER_RETRY_MS = 3e4;
  function pickEligible(items, maxBuy, cardId = null, rarityId = null, versionRating = null) {
    const eligible = items.filter((i) => i.buyNowPrice > 0 && i.buyNowPrice <= maxBuy && (!cardId || Number(i.definitionId) === Number(cardId))
      && (rarityId === null || rarityId === undefined || Number(i.rareflag) === rarityId)
      && (versionRating === null || versionRating === undefined || Number(i.rating) === versionRating));
    return eligible.sort((a, b) => a.buyNowPrice - b.buyNowPrice);
  }
  function createInterruptibleSleep() {
    let timer = null;
    let wake = null;
    return {
      sleep(ms) {
        return new Promise((resolve) => {
          wake = resolve;
          timer = setTimeout(resolve, ms);
        });
      },
      interrupt() {
        clearTimeout(timer);
        if (wake) wake();
      }
    };
  }
  function createSniper({
    market,
    pacer,
    settings,
    sleep,
    rand,
    onLog = () => {
    },
    onBuy = () => {
    },
    onSearch = () => {
    },
    onPhase = () => {
    },
    onResults = () => {}
  }) {
    let stopped = false;
    async function search(criteria) {
      onPhase("search");
      pacer.recordSearch();
      onSearch();
      return market.search(criteria);
    }
    async function searchWithRetry(criteria) {
      try {
        return await search(criteria);
      } catch (err) {
        if (err.kind !== "server") throw err;
        onPhase("retry");
        onLog(`Błąd serwera (${err.status}), ${SERVER_RETRY_MS / 1e3} s do ponownej próby`);
        await sleep(SERVER_RETRY_MS);
        if (stopped) return [];
        return search(criteria);
      }
    }
    function describeCard(item) {
      const name = settings.player.name || "Wybrana karta";
      const rating = item.rating ?? settings.player.rating;
      const price = Number(item.buyNowPrice).toLocaleString("pl-PL");
      return `${rating ? rating + " · " : ""}${name} · ${price} monet · ID karty ${item.definitionId} · oferta ${item.tradeId ?? "—"}`;
    }
    function failure(err) {
      const reason = err.kind ?? "unknown";
      onLog(`Zatrzymano: ${err.message}`, "error");
      return { reason, error: err };
    }
    async function run() {
      while (!stopped) {
        const step = pacer.next();
        if (step.action === "stop") return { reason: step.reason };
        if (step.action === "rest") {
          onLog(`Odpoczynek: ${Math.round(step.waitMs / 6e4)} min, później automatyczne wznowienie`);
          onPhase("rest", step.waitMs);
          await sleep(step.waitMs);
          if (stopped) break;
          onPhase("work");
          continue;
        }
        onPhase(step.action === "break" ? "break" : "wait");
        if (step.action === "break") onLog(`Przerwa: ${Math.round(step.waitMs / 1e3)} s`);
        await sleep(step.waitMs);
        if (stopped) break;
        if (step.action === "break") continue;
        const criteria = {
          playerId: settings.player.id,
          cardId: settings.player.cardId,
          rarityId: settings.player.rarityId ?? null,
          maxBuy: settings.maxBuy,
          minBuy: randomMinBuy(settings.maxBuy, rand)
        };
        let items;
        try {
          items = await searchWithRetry(criteria);
        } catch (err) {
          return failure(err);
        }
        onResults(items);
        const eligible = pickEligible(items, settings.maxBuy, settings.player.cardId, settings.player.rarityId, settings.player.versionRating);
        onLog(`Znaleziono ${eligible.length} pasujących ofert. Wyniki rynku: ${items.length}.`, "search");
        for (const item of eligible) onLog(`ZNALEZIONO KARTĘ: ${describeCard(item)}`, "found");
        for (const target of eligible) {
          if (stopped || pacer.stats().buys >= settings.maxBuys) break;
          if (settings.dryRun) {
            onLog(`TRYB TESTOWY: ${describeCard(target)} · zakup pominięty.`, "dryrun");
            continue;
          }
          try {
            onPhase("buy");
            await market.buy(target);
          } catch (err) {
            const reasons = { lost:"oferta już niedostępna", insufficientCoins:"za mało monet", pileFull:"lista kart jest pełna", rateLimited:"ograniczenie lub blokada rynku", captcha:"wymagana CAPTCHA", sessionExpired:"sesja wygasła", server:"błąd serwera", unknown:"nieznany wynik żądania" };
            const reason = reasons[err.kind] || err.message || "nieznany błąd";
            const uncertain = !err.kind || ["unknown", "server", "sessionExpired"].includes(err.kind);
            onLog(`${uncertain ? "ZAKUP NIEPOTWIERDZONY" : "NIEUDANY ZAKUP"}: ${describeCard(target)} · ${reason}${err.status ? " (kod " + err.status + ")" : ""}`, "failure");
            if (err.kind === "lost") continue;
            return failure(err);
          }
          pacer.recordBuy();
          onLog(`KUPIONO: ${describeCard(target)}`, "success");
          onBuy(target);
        }
      }
      return { reason: "manual" };
    }
    return {
      run,
      stop() {
        stopped = true;
      }
    };
  }

  // src/players.js
  function findPlayersUrl(resourceUrls) {
    return resourceUrls.find((u) => /\/players\.json(\?|$)/.test(u)) ?? null;
  }
  function parsePlayersJson(json) {
    const all = [...json.LegendsPlayers ?? [], ...json.Players ?? []];
    return all.map((p) => ({ id: p.id, name: p.c ?? `${p.f} ${p.l}`, rating: p.r }));
  }
  function normalize(s) {
    return s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ı/g, "i").toLowerCase();
  }
  function searchPlayers(players, query, limit = 10) {
    const q = normalize(query.trim());
    if (q.length < 2) return [];
    return players.filter((p) => normalize(p.name).includes(q)).sort((a, b) => b.rating - a.rating).slice(0, limit);
  }

  // src/versions.js
  function groupVersions(items) {
    const byCard = /* @__PURE__ */ new Map();
    for (const i of items) {
      const v = byCard.get(i.definitionId) ?? { cardId: i.definitionId, rating: i.rating, rareflag: i.rareflag, listings: 0, minPrice: Infinity };
      v.listings++;
      if (i.buyNowPrice > 0) v.minPrice = Math.min(v.minPrice, i.buyNowPrice);
      byCard.set(i.definitionId, v);
    }
    return [...byCard.values()].sort((a, b) => a.minPrice - b.minPrice);
  }


  // src/ui.js
  var SEC = 1e3;
  var MIN = 6e4;
  var PCT = 0.01;
  var SETTING_RANGES = [
    ["delayMinMs", "delayMaxMs", "Odstęp między wyszukiwaniami (s)", SEC, false],
    ["hiccupMinMs", "hiccupMaxMs", "Dłuższa przerwa (s)", SEC, false],
    ["breakEveryMin", "breakEveryMax", "Przerwa co tyle wyszukiwań", 1, true],
    ["breakMinMs", "breakMaxMs", "Czas krótkiej przerwy (s)", SEC, false],
    ["workMinMs", "workMaxMs", "Czas pracy (min)", MIN, false],
    ["restMinMs", "restMaxMs", "Czas odpoczynku (min)", MIN, false]
  ];
  var SETTING_FIELDS = [
    ["hiccupChance", "Szansa dłuższej przerwy (%)", PCT, 0, 100, false],
    ["dailyMaxSearches", "Dzienny limit wyszukiwań", 1, 1, Number.MAX_SAFE_INTEGER, true]
  ];
  function parseSettingRange(text, integer = false) {
    const value = String(text).trim().replace(/,/g, ".");
    const match = value.match(/^(\d+(?:\.\d+)?)\s*[-–—]\s*(\d+(?:\.\d+)?)$/);
    if (!match) return null;
    const min = Number(match[1]), max = Number(match[2]);
    if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || min > max) return null;
    if (integer && (min < 1 || !Number.isSafeInteger(min) || !Number.isSafeInteger(max))) return null;
    return { min, max };
  }
  var CSS = `#fut-sniper { --fs-bg:#101720; --fs-card:#1b2531; --fs-line:#344252; --fs-accent:#b1ffff; position:fixed; inset:112px 0 0 98px; z-index:10000; background:var(--fs-bg); color:#f4f7fc; font:14px/1.45 Arial,sans-serif; overflow:auto; }
#fut-sniper[hidden] { display:none!important; }
#fut-sniper * { box-sizing:border-box; }
#fut-sniper .fs-head { padding:18px 28px; display:flex; align-items:center; gap:16px; border-bottom:1px solid var(--fs-line); }
#fut-sniper .fs-title { font-size:22px; font-weight:700; flex:1; }
#fut-sniper .fs-kicker { font-size:11px; letter-spacing:1.5px; color:#94a8bd; margin-bottom:5px; }
#fut-sniper .fs-mini { color:#b1ffff; }
#fut-sniper .fs-layout { display:grid; grid-template-columns:minmax(340px,1fr) minmax(380px,1fr); gap:20px; padding:22px 28px; }
#fut-sniper .fs-card { background:#141d28; border:1px solid var(--fs-line); border-radius:12px; padding:22px; min-width:0; }
#fut-sniper .fs-body { display:flex; flex-direction:column; gap:16px; }
#fut-sniper .fs-section { font-weight:700; font-size:13px; letter-spacing:.7px; }
#fut-sniper .fs-category { border:1px solid var(--fs-accent); color:var(--fs-accent); padding:12px 20px; border-radius:9px; text-align:center; background:#223042; }
#fut-sniper .fs-description { color:#98a9bc; font-size:12px; margin:0; }
#fut-sniper hr { border:0; border-top:1px solid var(--fs-line); width:100%; margin:0; }
#fut-sniper label { display:grid; gap:7px; color:#e4eaf2; font-size:13px; }
#fut-sniper label.inline { display:flex; gap:9px; align-items:center; }
#fut-sniper .fs-row { display:grid; grid-template-columns:1fr 1fr; gap:14px; }
#fut-sniper input, #fut-sniper select { background:#223042; border:1px solid #3c4d60; color:#fff; border-radius:8px; padding:12px; min-width:0; width:100%; font:inherit; }
#fut-sniper input[type=checkbox] { width:18px; height:18px; accent-color:#7af4db; }
#fut-sniper input:focus, #fut-sniper select:focus { outline:2px solid var(--fs-accent); outline-offset:1px; }
#fut-sniper input[data-q] { background:#101720; border-color:#b1ffff; font-size:17px; }
#fut-sniper button { border:1px solid #3c4d60; border-radius:8px; background:#223042; color:#fff; padding:12px 16px; cursor:pointer; font:inherit; }
#fut-sniper button:hover { filter:brightness(1.2); }
#fut-sniper button:focus-visible, #fs-navigation-tab:focus-visible { outline:2px solid #b1ffff; outline-offset:2px; }
#fut-sniper button:disabled { opacity:.5; cursor:wait; }
#fut-sniper .fs-versions { display:grid; grid-template-columns:auto 1fr; gap:12px; }
#fut-sniper .fs-results:empty { display:none; }
#fut-sniper .fs-results button { display:block; width:100%; text-align:left; margin:5px 0; }
#fut-sniper .fs-target { border:1px solid #776235; border-radius:8px; padding:12px; color:#ffcf70; }
#fut-sniper .fs-target.ok { color:#b1ffff; border-color:#4c9f89; }
#fut-sniper .fs-fields { display:grid; grid-template-columns:1fr 1fr; gap:14px; margin-top:18px; }
#fut-sniper .fs-field-error { color:#ff8593; font-size:11px; }
#fut-sniper .fs-field-error:empty { display:none; }
#fut-sniper input[aria-invalid="true"] { border-color:#ff8593; }
#fut-sniper summary { cursor:pointer; padding:8px 0; }
#fut-sniper .fs-actions { display:flex; gap:12px; position:sticky; bottom:0; background:#141d28; padding:14px 0 0; margin-top:auto; }
#fut-sniper .fs-actions button { flex:1; font-weight:700; }
#fut-sniper button[data-start] { color:#101720; background:linear-gradient(120deg,#b1ffff,#e2d6ff); border:0; }
#fut-sniper button[data-stop] { border-color:#9c424f; color:#ff8593; }
#fut-sniper .fs-warn { color:#ffcf70; }
#fut-sniper .fs-warn:empty { display:none; }
#fut-sniper .fs-dot { display:inline-block; width:8px; height:8px; border-radius:50%; background:#8c9cac; margin-right:7px; }
#fut-sniper [data-state=running] .fs-dot { background:#b1ffff; box-shadow:0 0 8px #b1ffff; }
#fut-sniper [data-state=error] .fs-dot { background:#ff6b6b; }
#fut-sniper .fs-right { display:flex; flex-direction:column; gap:18px; min-width:0; }
#fut-sniper .fs-metrics { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
#fut-sniper .fs-metric { background:#223042; padding:20px; border:1px solid #3c4d60; border-radius:12px; }
#fut-sniper .fs-metric strong { display:block; font-size:32px; margin-bottom:4px; }
#fut-sniper .fs-metric span { font-size:12px; }
#fut-sniper .fs-metric.blue { background:#06a6d9; color:white; border:0; }
#fut-sniper .fs-metric.red { background:#f64a67; color:white; border:0; }
#fut-sniper .fs-stats { color:#98a9bc; font-size:12px; }
#fut-sniper .fs-log { font:12px/1.7 monospace; margin:14px 0 0; min-height:170px; max-height:260px; overflow:auto; white-space:pre-wrap; overflow-wrap:anywhere; color:#bccadc; }
#fut-sniper .fs-table-wrap { overflow:auto; max-height:260px; }
#fut-sniper table { width:100%; border-collapse:collapse; text-align:left; font-size:12px; }
#fut-sniper th { color:#8ba4bd; font-weight:500; }
#fut-sniper td, #fut-sniper th { border-bottom:1px solid #2b3949; padding:10px 5px; }
#fs-navigation-tab { cursor:pointer; color:#eef5ff; }
#fs-navigation-tab.fs-fallback { position:fixed; left:6px; top:440px; width:86px; z-index:10001; background:#172332; border:1px solid #4a637b; border-radius:8px; padding:12px 3px; }
#fs-navigation-tab .fs-nav-icon { display:block; font:28px/1.2 Arial,sans-serif; }
#fs-navigation-tab .fs-nav-label { display:block; font:12px/1.3 Arial,sans-serif; padding:6px 0; }
#fs-navigation-tab[aria-pressed=true] { color:#b1ffff; background:#223548; }

#fut-sniper .fs-timer-card { position:relative; display:flex; flex-direction:column; align-items:center; gap:12px; padding:22px; border:2px solid #697c8d; border-radius:12px; background:#18222e; }
#fut-sniper .fs-timer-ring { display:grid; place-items:center; width:140px; height:140px; border-radius:50%; background:#334151; padding:5px; }
#fut-sniper .fs-timer-inner { display:grid; place-items:center; width:100%; height:100%; border-radius:50%; background:#131c26; }
#fut-sniper [data-countdown] { font-size:36px; font-weight:700; font-style:italic; font-variant-numeric:tabular-nums; }
#fut-sniper [data-timer-label] { color:#b1ffff; font-size:13px; text-align:center; }
#fut-sniper .fs-elapsed { align-self:flex-start; color:#9eafbf; font-size:11px; }
#fut-sniper [data-elapsed] { display:block; color:white; font-size:18px; font-weight:700; font-variant-numeric:tabular-nums; }


#fut-sniper .fs-log-entry { display:flex; align-items:baseline; gap:9px; padding:4px 0; border-bottom:1px solid #263444; }
#fut-sniper .fs-log-time { color:#7f98b2; flex:0 0 auto; font-variant-numeric:tabular-nums; }
#fut-sniper .fs-log-message { min-width:0; white-space:pre-wrap; overflow-wrap:anywhere; }
#fut-sniper .fs-log-search { color:#91a9c1; }
#fut-sniper .fs-log-found { color:#ffcf70; }
#fut-sniper .fs-log-success { color:#7fe7a1; }
#fut-sniper .fs-log-failure { color:#ff8593; }
#fut-sniper .fs-log-dryrun { color:#b1ffff; }


#fut-sniper .fs-log-grid { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:14px; }
#fut-sniper .fs-log-grid .fs-card { padding:16px; }
#fut-sniper .fs-log-grid .fs-log { min-height:250px; max-height:350px; }
#fut-sniper .fs-log-grid .fs-log-entry { flex-wrap:wrap; gap:2px 8px; }
#fut-sniper .fs-log-grid .fs-log-message { width:100%; }
#fut-sniper .fs-log-error { color:#ff8593; }
@media(max-width:650px) { #fut-sniper .fs-log-grid { grid-template-columns:1fr; } }

@media(max-width:1000px) { #fut-sniper .fs-layout { grid-template-columns:1fr; padding:16px; } #fut-sniper .fs-head { padding:16px; } }
@media(max-width:600px) { #fut-sniper .fs-row,#fut-sniper .fs-fields { grid-template-columns:1fr; } #fut-sniper .fs-card { padding:16px; } #fut-sniper .fs-title { font-size:17px; } #fut-sniper .fs-mini { display:none; } }
`;
  var MAX_LOG_LINES = 150;
  function formatCoins(n) {
    return n > 0 ? n.toLocaleString("pl-PL") : "";
  }
  function parseCoins(text) {
    return Number(String(text).replace(/\D/g, "")) || 0;
  }
  // Overlay view: keeps the EA router and the running bot alive when changing tabs.
  function mountSniperTab(root) {
    root.hidden = true;
    root.setAttribute("role", "region");
    root.setAttribute("aria-label", "Sniping Bot");
    let lastFocus = null;
    let tab = null;
    let state = "idle";
    let frame = 0;
    function locateNavigation() {
      const candidates = document.querySelectorAll(".ut-tab-bar, .ut-navigation-bar, nav, [role=navigation]");
      for (const nav of candidates) {
        if (root.contains(nav)) continue;
        const r = nav.getBoundingClientRect();
        if (r.width > 40 && r.width < 180 && r.height > 200 && r.left < 140) return nav;
      }
      for (const item of document.querySelectorAll("button, a, [role=button]")) {
        if (root.contains(item) || item.id === "fs-navigation-tab") continue;
        const text = item.textContent.trim();
        if (!/^(Transfery|Transfers|Transferler|Transferts|Transferencias|Trasferimenti)$/i.test(text)) continue;
        const parent = item.parentElement;
        const r = parent.getBoundingClientRect();
        if (r.left < 140 && r.width < 180 && r.height > 200) return parent;
      }
      return null;
    }
    function placeView(nav) {
      if (!nav) { root.style.left = "98px"; root.style.top = "112px"; return; }
      const r = nav.getBoundingClientRect();
      root.style.left = Math.max(0, Math.round(r.right)) + "px";
      root.style.top = Math.max(0, Math.round(r.top)) + "px";
    }
    function close() {
      root.hidden = true;
      if (tab) tab.setAttribute("aria-pressed", "false");
      if (lastFocus?.isConnected) lastFocus.focus();
    }
    function open() {
      lastFocus = document.activeElement;
      placeView(locateNavigation());
      root.hidden = false;
      tab.setAttribute("aria-pressed", "true");
      root.querySelector("[data-q]").focus();
    }
    function install() {
      frame = 0;
      const nav = locateNavigation();
      if (tab?.isConnected && (nav ? tab.parentElement === nav : tab.classList.contains("fs-fallback"))) {
        if (!root.hidden) placeView(nav);
        return;
      }
      tab?.remove();
      document.querySelectorAll("#fs-navigation-tab").forEach((old) => old.remove());
      tab = document.createElement("button");
      tab.type = "button";
      tab.id = "fs-navigation-tab";
      const sibling = nav?.querySelector("button, a, [role=button]");
      tab.className = sibling?.className && typeof sibling.className === "string" ? sibling.className : "";
      tab.classList.remove("selected", "active", "toggled");
      if (!nav) tab.classList.add("fs-fallback");
      tab.innerHTML = '<span class="fs-nav-icon" aria-hidden="true">⌖</span><span class="fs-nav-label">Sniping Bot</span>';
      tab.setAttribute("aria-controls", root.id);
      tab.setAttribute("aria-pressed", String(!root.hidden));
      tab.title = "Sniping Bot";
      tab.addEventListener("click", (event) => {
        event.preventDefault(); event.stopPropagation();
        root.hidden ? open() : close();
      });
      (nav || document.body).appendChild(tab);
      tab.dataset.state = state;
      if (!root.hidden) placeView(nav);
    }
    function schedule() { if (!frame) frame = requestAnimationFrame(install); }
    // Only track DOM replacement, avoiding loops on our own dashboard updates.
    const observer = new MutationObserver((records) => {
      if (records.some((r) => !root.contains(r.target) && r.target !== tab && !tab?.contains(r.target))) schedule();
    });
    observer.observe(document.body, { childList:true, subtree:true });
    document.addEventListener("click", (event) => {
      const nav = locateNavigation();
      if (!root.hidden && nav?.contains(event.target) && !tab?.contains(event.target)) close();
    }, true);
    document.addEventListener("keydown", (event) => { if (event.key === "Escape" && !root.hidden) close(); });
    window.addEventListener("resize", schedule);
    root.querySelector("[data-close]").addEventListener("click", close);
    install();
    return { setState(next) { state = next; if (tab) tab.dataset.state = next; } };
  }


  function createCountdownController(root, clock = Date.now, schedule = setInterval, cancel = clearInterval) {
    const remainingEl = root.querySelector("[data-countdown]");
    const labelEl = root.querySelector("[data-timer-label]");
    const elapsedEl = root.querySelector("[data-elapsed]");
    const ring = root.querySelector(".fs-timer-ring");
    let startedAt = null;
    let deadline = null;
    let duration = 0;
    let phase = "wait";
    let timer = null;
    const labels = { wait:"Do kolejnego wyszukiwania", break:"Przerwa — do wznowienia cyklu", rest:"Odpoczynek — do wznowienia cyklu", retry:"Do ponownej próby wyszukania", search:"Wyszukiwanie…", buy:"Oczekiwanie na zakup…" };
    function time(ms) {
      const sec = Math.max(0, Math.floor(ms / 1000));
      return Math.floor(sec / 60) + ":" + String(sec % 60).padStart(2, "0");
    }
    function render() {
      const now = clock();
      if (startedAt !== null) elapsedEl.textContent = time(now - startedAt);
      if (deadline !== null) {
        const left = Math.max(0, deadline - now);
        remainingEl.textContent = left > 60000 ? time(Math.ceil(left / 1000) * 1000) : Math.ceil(left / 1000) + "s";
        const degrees = duration > 0 ? Math.min(360, Math.max(0, left / duration * 360)) : 0;
        ring.style.background = "conic-gradient(#b1ffff " + degrees + "deg, #334151 0deg)";
        labelEl.textContent = left === 0 ? "Oczekiwanie na kontynuację…" : labels[phase] || labels.wait;
      } else {
        remainingEl.textContent = "—";
        ring.style.background = "#334151";
        labelEl.textContent = labels[phase] || "Bot zatrzymany";
      }
    }
    return {
      start() {
        if (timer !== null) cancel(timer);
        startedAt = clock(); deadline = null; phase = "wait";
        render(); timer = schedule(render, 200);
      },
      phase(next) { phase = next; deadline = null; render(); },
      wait(ms) {
        duration = Number.isFinite(ms) ? Math.max(0, ms) : 0;
        deadline = clock() + duration; render();
      },
      stop() {
        render();
        if (timer !== null) cancel(timer);
        timer = null; startedAt = null; deadline = null; phase = "stopped";
        render();
      }
    };
  }


  function getCardTypes(g = globalThis) {
    const types = new Map();
    const localize = id => {
      try { return g.services.Localization.localize(`item.raretype${id}`); } catch { return null; }
    };
    try {
      const values = g.factories?.DataProvider?.getItemRarityDP({ itemSubTypes:[2], itemTypes:["player"], quality:"any", tradableOnly:true });
      if (Array.isArray(values)) for (const item of values) {
        const id = Number(item.id);
        const label = item.label || localize(id);
        if (Number.isInteger(id) && id >= 0 && typeof label === "string" && label && !label.startsWith("*")) types.set(id, { id, label });
      }
    } catch {}
    // Localized labels are a fallback when the EA data provider is unavailable.
    if (!types.size) for (let id = 0; id <= 1024; id++) {
      const label = localize(id);
      if (typeof label === "string" && label && !label.startsWith("*") && label !== `item.raretype${id}`) types.set(id, { id, label });
    }
    for (const [id, label] of [[0,"Zwykła — nierzadka"],[1,"Zwykła — rzadka"],[3,"TOTW — Drużyna tygodnia"]]) {
      if (!types.has(id)) types.set(id, { id, label });
    }
    return [...types.values()].sort((a,b) => a.id - b.id);
  }

  function createPanel({ settings, onChange, onPlayerQuery, onFetchVersions, onStart, onStop }) {
    let current = { ...settings };
    const root = document.createElement("div");
    root.id = "fut-sniper";
    root.innerHTML = `
<style>${CSS}</style>
<header class="fs-head" data-state="idle">
  <div class="fs-title"><div class="fs-kicker">EA FC WEB APP</div>Sniping Bot</div>
  <span class="fs-mini"><span class="fs-dot"></span><span data-mini>Gotowy</span></span>
  <button type="button" data-close aria-label="Zamknij zakładkę">Wróć do Web App</button>
</header>
<div class="fs-layout">
  <section class="fs-card fs-body" aria-label="Konfiguracja bota">
    <div class="fs-category">Piłkarze i piłkarki</div>
    <div class="fs-section">FILTR WYSZUKIWANIA</div>
    <div class="fs-row"><label>Zawodnik <input data-q placeholder="Wpisz co najmniej 2 litery" autocomplete="off"></label><label>Wersja karty<select data-rarity><option value="">— wybierz wersję —</option></select></label></div>
    <div class="fs-results"></div>
    <label>Ocena wybranej wersji (opcjonalnie)<input data-version-rating type="number" min="1" max="99" placeholder="Np. 84 — pozostaw puste, aby wybrać dowolną ocenę"></label>
    <p class="fs-description">Wybierz typ, np. TOTW, bez pobierania ofert. Lista typów jest wspólna dla zawodników; wybrana karta może nie być dostępna. Ocena rozróżnia kilka wersji tego samego typu.</p>
    <details><summary>Dokładna karta — opcjonalny wybór z ofert</summary><div class="fs-versions"><button data-versions>Sprawdź oferty</button><select data-card aria-label="Dokładna karta z ofert"><option value="">— wybierz dokładną kartę —</option></select></div></details>
    <div class="fs-target"></div>
    <details><summary>Wprowadź ID ręcznie</summary><div class="fs-row"><label>ID zawodnika<input data-id type="number" min="1"></label><label>ID wersji karty<input data-card-id type="number" min="1" placeholder="definitionId"></label></div></details>
    <hr>
    <div class="fs-section">CENA „KUP TERAZ”</div>
    <div class="fs-row"><label>Maksymalna cena (monety)<input data-max inputmode="numeric" placeholder="0"></label><label>Limit zakupionych kart<input data-max-buys type="number" min="1"></label></div>
    <label class="inline"><input data-dry type="checkbox">Tryb testowy — bez kupowania kart</label>
    <details><summary>Tempo i limity wyszukiwania</summary><p class="fs-description">Zakres wpisuj jako minimum-maksimum, np. 3-5 lub 3,5-6.</p><div class="fs-fields"></div></details>
    <div class="fs-warn"></div>
    <div class="fs-status" data-state="idle"><span class="fs-dot"></span><span data-status>Gotowy</span></div>
    <p class="fs-description">Ukrycie zakładki nie zatrzymuje bota. Aby go zatrzymać, kliknij Stop.</p>
    <div class="fs-actions"><button data-stop>Stop</button><button data-start>Start</button></div>
  </section>
  <aside class="fs-right" aria-label="Statystyki i wyniki">
    <div class="fs-metrics">
      <div class="fs-metric blue"><strong data-spent>0</strong><span>Wydane monety</span></div>
      <div class="fs-metric red"><strong data-searches>0</strong><span>Wyszukiwania w sesji</span></div>
      <div class="fs-metric"><strong data-buys>0</strong><span>Udane zakupy w sesji</span></div>
      <div class="fs-metric"><strong data-daily>0</strong><span>Wyszukiwania dzisiaj</span></div>
    </div>

    <section class="fs-timer-card" aria-label="Czas do kolejnego wyszukiwania">
      <div class="fs-timer-ring"><div class="fs-timer-inner"><span data-countdown>—</span></div></div>
      <div data-timer-label>Bot zatrzymany</div>
      <div class="fs-elapsed">Czas sesji<span data-elapsed>0:00</span></div>
    </section>
    <div class="fs-stats"></div>
    <div class="fs-log-grid">
      <section class="fs-card"><div class="fs-section">LOGI ZAKUPÓW</div><p class="fs-description">Udane, nieudane i niepotwierdzone zakupy.</p><div class="fs-log" data-purchase-log role="log" aria-label="Logi zakupów" aria-live="polite" aria-relevant="additions"></div></section>
      <section class="fs-card"><div class="fs-section">LOGI WYSZUKIWAŃ</div><p class="fs-description">Wyniki wyszukiwania i znalezione karty na rynku.</p><div class="fs-log" data-search-log role="log" aria-label="Logi wyszukiwań" aria-live="polite" aria-relevant="additions"></div></section>
    </div>
    <details class="fs-card"><summary>Komunikaty bota</summary><div class="fs-log" data-system-log role="log" aria-label="Komunikaty bota" aria-live="polite" aria-relevant="additions"></div></details>
    <section class="fs-card"><div class="fs-section">WYNIKI OSTATNIEGO WYSZUKIWANIA</div><p class="fs-description">Ostatnia aktualizacja: <span data-result-time>—</span></p><div class="fs-table-wrap"><table><thead><tr><th>Ocena</th><th>ID karty</th><th>Cena</th><th>Filtr</th></tr></thead><tbody data-market-results></tbody></table></div><p class="fs-description" data-empty-results>Brak wyników. Wyniki pojawią się po wyszukiwaniu.</p></section>
  </aside>
</div>
`;
    document.body.appendChild(root);
    const view = mountSniperTab(root);
    const $ = (sel) => root.querySelector(sel);
    const logTargets = { purchase:$("[data-purchase-log]"), search:$("[data-search-log]"), system:$("[data-system-log]") };
    const cardSelect = $("[data-card]");
    const countdown = createCountdownController(root);
    const raritySelect = $("[data-rarity]");
    const ratingInput = $("[data-version-rating]");
    function renderCardTypes() {
      const selected = current.player?.rarityId;
      raritySelect.replaceChildren();
      const placeholder = document.createElement("option"); placeholder.value = ""; placeholder.textContent = "— wybierz wersję —"; raritySelect.appendChild(placeholder);
      const types = getCardTypes();
      for (const type of types) {
        const option = document.createElement("option"); option.value = String(type.id); option.textContent = type.label; raritySelect.appendChild(option);
      }
      if (Number.isInteger(selected) && !types.some(t => t.id === selected)) {
        const option = document.createElement("option"); option.value = String(selected); option.textContent = current.player.cardLabel || `Typ karty ${selected}`; raritySelect.appendChild(option);
      }
      raritySelect.value = Number.isInteger(selected) ? String(selected) : "";
    }
    renderCardTypes();
    raritySelect.addEventListener("focus", renderCardTypes);
    raritySelect.addEventListener("change", () => {
      if (!current.player) { log("Najpierw wybierz zawodnika."); raritySelect.value = ""; return; }
      const type = getCardTypes().find(t => String(t.id) === raritySelect.value);
      versions = []; renderVersions();
      update({ player:{ ...current.player, cardId:null, rarityId:type?.id ?? null, cardLabel:type?.label ?? null, versionRating:null } });
      ratingInput.value = "";
    });
    ratingInput.addEventListener("change", () => {
      const rating = Number(ratingInput.value);
      const valid = ratingInput.value !== "" && Number.isInteger(rating) && rating >= 1 && rating <= 99;
      if (current.player) update({player:{...current.player, versionRating:valid ? rating : null}});
      if (!valid) ratingInput.value = "";
    });
    const lines = { purchase:[], search:[], system:[] };
    let versions = [];
    function log(text, type = "info") {
      const colors = new Set(["info", "search", "found", "success", "failure", "dryrun", "error"]);
      const channel = ["success", "failure", "dryrun"].includes(type) ? "purchase" : ["search", "found"].includes(type) ? "search" : "system";
      const logEl = logTargets[channel];
      const entries = lines[channel];
      const row = document.createElement("div");
      row.className = "fs-log-entry fs-log-" + (colors.has(type) ? type : "info");
      const stamp = document.createElement("span");
      stamp.className = "fs-log-time";
      stamp.textContent = new Date().toLocaleTimeString("pl-PL", { hour12:false });
      const message = document.createElement("span");
      message.className = "fs-log-message";
      message.textContent = String(text);
      row.appendChild(stamp);
      row.appendChild(message);
      entries.push(row);
      logEl.appendChild(row);
      if (entries.length > MAX_LOG_LINES) entries.shift().remove();
      logEl.scrollTop = logEl.scrollHeight;
    }
    function update(patch) {
      current = { ...current, ...patch };
      onChange(current);
      renderTarget();
    }
    function renderTarget() {
      const p = current.player;
      raritySelect.value = Number.isInteger(p?.rarityId) ? String(p.rarityId) : "";
      ratingInput.value = p?.versionRating ?? "";
      const box = $(".fs-target");
      $("[data-q]").value = p ? `${p.name}${p.rating ? ` (${p.rating})` : ""}` : "";
      $("[data-id]").value = p?.id ?? "";
      $("[data-card-id]").value = p?.cardId ?? "";
      if (!p) {
        box.className = "fs-target warn";
        box.textContent = "Nie wybrano zawodnika";
      } else if (!p.cardId && !Number.isInteger(p.rarityId)) {
        box.className = "fs-target warn";
        box.textContent = `${p.name}${p.rating ? ` (${p.rating})` : ""} · wybierz wersję karty`;
      } else {
        box.className = "fs-target ok";
        box.textContent = `✔ ${p.name} · ${p.cardLabel ?? `Kart #${p.cardId}`}${p.versionRating ? " · ocena " + p.versionRating : ""}`;
      }
    }
    function renderVersions() {
      cardSelect.innerHTML = '<option value="">— wybierz wersję karty —</option>';
      for (const v of versions) {
        const opt = document.createElement("option");
        opt.value = v.cardId;
        opt.textContent = v.label;
        cardSelect.appendChild(opt);
      }
      cardSelect.value = current.player?.cardId ?? "";
    }
    function choosePlayer(player) {
      versions = [];
      renderVersions();
      update({ player: { ...player, cardId: null, cardLabel: null, rarityId:null, versionRating:null } });
    }
    function chooseCard(cardId, cardLabel) {
      update({ player: { ...current.player, cardId, cardLabel, rarityId:null, versionRating:null } });
      cardSelect.value = cardId ?? "";
    }
    const settingErrors = new Map();
    function settingField(label, key) {
      const wrap = document.createElement("label");
      const title = document.createElement("span"); title.textContent = label;
      const input = document.createElement("input"); input.setAttribute("data-setting", key);
      const error = document.createElement("span"); error.className = "fs-field-error";
      error.id = "fs-error-" + key; error.setAttribute("role", "alert");
      input.setAttribute("aria-describedby", error.id);
      wrap.appendChild(title); wrap.appendChild(input); wrap.appendChild(error);
      $(".fs-fields").appendChild(wrap);
      function validate(message) {
        error.textContent = message;
        input.setAttribute("aria-invalid", message ? "true" : "false");
        if (message) settingErrors.set(key, input); else settingErrors.delete(key);
      }
      return { input, validate };
    }
    const display = value => Number(value.toFixed(2));
    for (const [minKey, maxKey, label, scale, integer] of SETTING_RANGES) {
      const { input, validate } = settingField(label, minKey);
      input.type = "text"; input.placeholder = "np. 3-5";
      input.value = `${display(current[minKey] / scale)}-${display(current[maxKey] / scale)}`;
      input.addEventListener("change", () => {
        const range = parseSettingRange(input.value, integer);
        if (!range || range.max * scale > (integer ? Number.MAX_SAFE_INTEGER : 2147483647)) {
          validate(integer ? "Wpisz zakres całkowity, np. 25-35; minimum 1, min. ≤ maks." : "Wpisz zakres, np. 3-5; wartości nieujemne, min. ≤ maks.");
          return;
        }
        validate("");
        update({ [minKey]:Math.round(range.min * scale * 1e6) / 1e6, [maxKey]:Math.round(range.max * scale * 1e6) / 1e6 });
        input.value = `${range.min}-${range.max}`;
      });
    }
    for (const [key, label, scale, min, max, integer] of SETTING_FIELDS) {
      const { input, validate } = settingField(label, key);
      input.type = "number"; input.step = integer ? "1" : "any"; input.min = String(min); input.max = String(max);
      input.value = display(current[key] / scale);
      input.addEventListener("change", () => {
        const value = Number(input.value);
        if (input.value === "" || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isSafeInteger(value))) {
          validate(integer ? "Wpisz dodatnią liczbę całkowitą." : "Wpisz liczbę od 0 do 100."); return;
        }
        validate(""); update({ [key]:Math.round(value * scale * 1e6) / 1e6 });
      });
    }
    $("[data-q]").addEventListener("input", (e) => {
      const results = $(".fs-results");
      results.innerHTML = "";
      for (const p of onPlayerQuery(e.target.value)) {
        const btn = document.createElement("button");
        btn.textContent = `${p.name} (${p.rating}) #${p.id}`;
        btn.addEventListener("click", () => {
          results.innerHTML = "";
          choosePlayer(p);
        });
        results.appendChild(btn);
      }
    });
    $("[data-id]").addEventListener("change", (e) => {
      const id = Number(e.target.value);
      if (id > 0 && id !== current.player?.id) choosePlayer({ id, name: `#${id}`, rating: null });
    });
    $("[data-card-id]").addEventListener("change", (e) => {
      if (!current.player) {
        log("Najpierw wybierz zawodnika");
        e.target.value = "";
        return;
      }
      const cardId = Number(e.target.value);
      if (cardId > 0) chooseCard(cardId, `Kart #${cardId}`);
    });
    const versionsBtn = $("[data-versions]");
    versionsBtn.addEventListener("click", async () => {
      if (!current.player) {
        log("Najpierw wybierz zawodnika");
        return;
      }
      versionsBtn.disabled = true;
      try {
        const requestedPlayer = current.player;
        const fetched = await onFetchVersions(requestedPlayer);
        if (current.player?.id !== requestedPlayer.id) { log("Zmieniono zawodnika — pominięto poprzednie wyniki wersji."); return; }
        versions = fetched;
        renderVersions();
        if (versions.length === 1 && !Number.isInteger(current.player?.rarityId)) chooseCard(versions[0].cardId, versions[0].label);
        log(versions.length ? `${versions.length} wersji karty znaleziono` : "Brak ofert; możesz wpisać ID wersji karty");
      } catch (err) {
        log(`Nie udało się pobrać wersji: ${err.message}`);
      } finally {
        versionsBtn.disabled = false;
      }
    });
    cardSelect.addEventListener("change", () => {
      const v = versions.find((x) => String(x.cardId) === cardSelect.value);
      chooseCard(v?.cardId ?? null, v?.label ?? null);
    });
    const maxInput = $("[data-max]");
    maxInput.value = formatCoins(current.maxBuy);
    maxInput.addEventListener("change", () => {
      update({ maxBuy: parseCoins(maxInput.value) });
      maxInput.value = formatCoins(current.maxBuy);
    });
    const maxBuysInput = $("[data-max-buys]");
    maxBuysInput.value = current.maxBuys;
    maxBuysInput.addEventListener("change", () => {
      update({ maxBuys: Math.max(1, Math.floor(Number(maxBuysInput.value)) || 1) });
      maxBuysInput.value = current.maxBuys;
    });
    const dry = $("[data-dry]");
    dry.checked = current.dryRun;
    dry.addEventListener("change", () => update({ dryRun: dry.checked }));
    $("[data-start]").addEventListener("click", () => {
      if (settingErrors.size) {
        log("Popraw zaznaczone ustawienia tempa i limitów przed uruchomieniem.", "error");
        const first = settingErrors.values().next().value;
        first.parentElement.parentElement.parentElement.open = true;
        first.focus(); return;
      }
      onStart();
    });
    $("[data-stop]").addEventListener("click", onStop);
    renderTarget();
    view.setState("idle");
    return {
      // state: 'idle' | 'running' | 'error' — nokta rengi ve küçültülmüş başlık için
      setStatus(text, state = "idle") {
        $("[data-status]").textContent = text;
        $("[data-mini]").textContent = text.length > 22 ? `${text.slice(0, 21)}…` : text;
        $(".fs-status").dataset.state = state;
        $(".fs-head").dataset.state = state;
        view.setState(state);
      },
      startTimer() { countdown.start(); },
      setTimerPhase(phase) { countdown.phase(phase); },
      setTimerWait(ms) { countdown.wait(ms); },
      stopTimer() { countdown.stop(); },
      setDaily(count) { $("[data-daily]").textContent = count.toLocaleString("pl-PL"); },
      setMetrics(stats, spent) {
        $("[data-searches]").textContent = stats.sessionSearches.toLocaleString("pl-PL");
        $("[data-buys]").textContent = stats.buys;
        $("[data-spent]").textContent = spent.toLocaleString("pl-PL");
        $("[data-daily]").textContent = stats.daily.count.toLocaleString("pl-PL");
      },
      setResults(items, maxBuy, cardId, rarityId = null, versionRating = null) {
        const body = $("[data-market-results]");
        body.replaceChildren();
        for (const item of items.slice(0, 30)) {
          const row = document.createElement("tr");
          const eligible = pickEligible([item], maxBuy, cardId, rarityId, versionRating).length > 0;
          for (const value of [item.rating ?? "—", item.definitionId, item.buyNowPrice > 0 ? formatCoins(item.buyNowPrice) : "—", eligible ? "Pasuje" : "Poza filtrem"]) {
            const cell = document.createElement("td"); cell.textContent = value; row.appendChild(cell);
          }
          body.appendChild(row);
        }
        $("[data-empty-results]").hidden = items.length > 0;
        $("[data-result-time]").textContent = new Date().toLocaleTimeString("pl-PL");
      },
      setStats(text) {
        $(".fs-stats").textContent = text;
      },
      setWarning(text) {
        $(".fs-warn").textContent = text ?? "";
      },
      // main maxBuy'ı geçerli fiyat adımına yuvarlayınca kutuyu da güncelle
      setMaxBuy(value) {
        current.maxBuy = value;
        maxInput.value = formatCoins(value);
      },
      log
    };
  }

  // src/alerts.js
  function beep(times = 3) {
    const ctx = new AudioContext();
    for (let i = 0; i < times; i++) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = 880;
      gain.gain.value = 0.2;
      osc.connect(gain).connect(ctx.destination);
      const start = ctx.currentTime + i * 0.3;
      osc.start(start);
      osc.stop(start + 0.18);
    }
  }
  function requestNotificationPermission() {
    if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission();
    }
  }
  function alertUser(title, body) {
    beep();
    if ("Notification" in window && Notification.permission === "granted") {
      new Notification(title, { body });
    }
  }

  // src/main.js
  var REASONS = {
    manual: "zatrzymano ręcznie",
    maxBuys: "osiągnięto limit zakupów",
    daily: "osiągnięto dzienny limit wyszukiwań",
    captcha: "CAPTCHA — rozwiąż ręcznie w Web App",
    rateLimited: "zbyt wiele żądań lub blokada rynku — zrób przerwę",
    sessionExpired: "sesja wygasła — zaloguj się ponownie",
    insufficientCoins: "niewystarczająca liczba monet",
    pileFull: "lista pełna — zwolnij miejsce na liście transferowej lub nieprzypisanych",
    server: "ponowny błąd serwera",
    unknown: "nieznany błąd"
  };
  var QUIET_REASONS = /* @__PURE__ */ new Set(["manual", "maxBuys", "daily"]);
  function waitForWebApp() {
    return new Promise((resolve) => {
      const timer = setInterval(() => {
        if (globalThis.services?.Item && globalThis.UTSearchCriteriaDTO) {
          clearInterval(timer);
          resolve();
        }
      }, 1e3);
    });
  }
  var PLAYERS_POLL_MS = 2e3;
  async function loadPlayers() {
    for (; ; ) {
      const url = findPlayersUrl(performance.getEntriesByType("resource").map((e) => e.name));
      if (url) {
        const res = await fetch(url);
        return parsePlayersJson(await res.json());
      }
      await new Promise((resolve) => setTimeout(resolve, PLAYERS_POLL_MS));
    }
  }
  async function main() {
    await waitForWebApp();
    const storage = localStorage;
    let settings = loadSettings(storage);
    let players = [];
    let active = null;
    let discoveringVersions = false;
    const panel = createPanel({
      settings,
      onChange(next) {
        settings = { ...next, maxBuy: next.maxBuy > 0 ? roundDown(next.maxBuy) : 0 };
        saveSettings(storage, settings);
        if (settings.maxBuy !== next.maxBuy) panel.setMaxBuy(settings.maxBuy);
        panel.setWarning(delayWarning(settings));
      },
      onPlayerQuery: (q) => searchPlayers(players, q),
      onFetchVersions: fetchVersions,
      onStart: start,
      onStop() {
        active?.stop();
      }
    });
    panel.setWarning(delayWarning(settings));
    panel.setMetrics({sessionSearches:0,buys:0,daily:loadDaily(storage,todayKey())},0);
    panel.log("Oczekiwanie na listę zawodników… Możesz też wpisać ID zawodnika.");
    loadPlayers().then((list) => {
      players = list;
      panel.log(`${list.length} zawodników załadowano`);
    }).catch((err) => panel.log(`Nie udało się załadować listy zawodników: ${err.message}`));
    async function fetchVersions(player) {
      if (active) throw new Error("Zatrzymaj bota przed sprawdzeniem ofert");
      if (discoveringVersions) throw new Error("Trwa już sprawdzanie ofert");
      discoveringVersions = true;
      try {
        const daily = loadDaily(storage, todayKey());
        if (daily.count >= settings.dailyMaxSearches) throw new Error("Osiągnięto dzienny limit wyszukiwań");
        saveDaily(storage, { ...daily, count:daily.count + 1 });
        panel.setDaily(daily.count + 1);
        const market = createMarket();
        const items = await market.search({ playerId:player.id, cardId:null, rarityId:player.rarityId, maxBuy:0, minBuy:0 });
        return groupVersions(items).map(v => ({ ...v, label:`${v.rating} ${market.rarityName(v.rareflag)} · ID ${v.cardId}` }));
      } finally { discoveringVersions = false; }
    }
    async function start() {
      if (active) return;
      if (discoveringVersions) { panel.log("Poczekaj na zakończenie pobierania wersji kart."); return; }
      if (!settings.player || !(settings.maxBuy > 0)) {
        panel.log("Wybierz zawodnika i ustaw maksymalną cenę");
        return;
      }
      if (!settings.player.cardId && !Number.isInteger(settings.player.rarityId)) {
        panel.log('Wybierz wersję karty obok nazwiska lub podaj dokładne ID karty.');
        return;
      }
      requestNotificationPermission();
      const run = { ...settings };
      const pacer = createPacer(run, {
        now: Date.now,
        rand: Math.random,
        today: () => todayKey(),
        daily: loadDaily(storage, todayKey())
      });
      const { sleep, interrupt } = createInterruptibleSleep();
      let spent = 0;
      const renderStats = () => {
        const s = pacer.stats();
        panel.setMetrics(s, spent);
        panel.setStats(`Sesja: ${s.sessionSearches} wyszukiwań · Dzisiaj: ${s.daily.count} · Zakupy: ${s.buys} · Wydano: ${spent}`);
      };
      const sniper = createSniper({
        market: createMarket(),
        pacer,
        settings: run,
        sleep(ms) { panel.setTimerWait(ms); return sleep(ms); },
        rand: Math.random,
        onLog: panel.log,
        onResults(items) { panel.setResults(items, run.maxBuy, run.player.cardId, run.player.rarityId, run.player.versionRating); },
        onSearch() {
          saveDaily(storage, pacer.stats().daily);
          renderStats();
        },
        onBuy(item) {
          spent += item.buyNowPrice;
          beep(1);
          renderStats();
        },
        onPhase(phase, waitMs) {
          panel.setTimerPhase(phase);
          if (phase === "rest") {
            const resumeAt = new Date(Date.now() + waitMs).toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit" });
            panel.setStatus(`Odpoczynek — ${resumeAt} — wznowienie`, "idle");
          } else {
            panel.setStatus(runningText, "running");
      renderStats();
          }
        }
      });
      active = {
        stop() {
          sniper.stop();
          panel.stopTimer();
          interrupt();
        }
      };
      const runningText = run.dryRun ? "Działa (tryb testowy)" : "Działa";
      panel.setStatus(runningText, "running");
      renderStats();
      panel.log(`Uruchomiono: ${run.player.name} [${run.player.cardLabel}] ≤ ${run.maxBuy}`);
      panel.startTimer();
      let result;
      try { result = await sniper.run(); }
      finally { panel.stopTimer(); active = null; }
      const text = REASONS[result.reason] ?? result.reason;
      const quiet = QUIET_REASONS.has(result.reason);
      panel.setStatus(`Zatrzymano: ${text}`, quiet ? "idle" : "error");
      if (quiet) panel.log(`Zatrzymano: ${text}`);
      if (!quiet) alertUser("FUT Sniper durdu", text);
    }
  }
  main();
})();
