/* =============================================================================
   スプレッドシートとのやりとり

     ブラウザ → Cloudflare Workers → Apps Script → スプレッドシート

   合言葉は Workers が持っています。このファイルには出てきません。

   書き込みは「送信箱（outbox）」にためてから、順に送ります。
   ・通信が切れても操作を続けられる
   ・つながったときに、たまっていた分をまとめて送れる
   ようにするためです。
   ============================================================================= */

const Remote = (function () {

  const OUTBOX_KEY = "meishi_outbox_v1";

  let outbox = [];
  let flushing = false;
  let lastError = "";
  let available = null;          // null=未確認, true=使える, false=使えない
  const listeners = [];

  // 名刺画像は、必要になったときに取り出して覚えておく（毎回取りに行かないため）
  const imageCache = {};


  /* --- 状態の通知 ---------------------------------------------------------- */

  function onChange(fn) { listeners.push(fn); }
  function notify() { listeners.forEach((fn) => { try { fn(status()); } catch (e) {} }); }

  function status() {
    return {
      available: available,
      pending: outbox.length,
      sending: flushing,
      error: lastError,
    };
  }


  /* --- 送信箱の保存（再読み込みしても消えないように） ---------------------- */

  function loadOutbox() {
    try {
      const raw = localStorage.getItem(OUTBOX_KEY);
      outbox = raw ? JSON.parse(raw) : [];
    } catch { outbox = []; }
  }
  function saveOutbox() {
    try { localStorage.setItem(OUTBOX_KEY, JSON.stringify(outbox)); } catch (e) {}
  }
  loadOutbox();


  /* --- Workers を呼ぶ ------------------------------------------------------ */

  async function call(action, params) {
    const url = (window.APP_CONFIG && window.APP_CONFIG.API_ENDPOINT) || "";
    if (!url) throw new Error("js/config.js の API_ENDPOINT が空です。");

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(Object.assign({ mode: "db", action: action }, params || {})),
    });

    let json;
    try { json = await res.json(); }
    catch { throw new Error("スプレッドシートからの応答を読み取れませんでした。"); }

    if (!json.ok) throw new Error(json.error || "スプレッドシートがエラーを返しました。");
    return json;
  }

  /** 使える状態かどうかを確かめる */
  async function check() {
    try {
      await call("ping");
      available = true; lastError = "";
    } catch (err) {
      available = false; lastError = err.message;
    }
    notify();
    return available;
  }


  /* --- 読み込み ------------------------------------------------------------ */

  /** すべての表を読む */
  async function fetchAll() {
    const r = await call("fetchAll");
    available = true; lastError = "";
    notify();
    return r.data;
  }


  /* --- 書き込み（送信箱にためる） ------------------------------------------ */

  function queue(op, table, payload) {
    outbox.push({ op: op, table: table, payload: payload, at: Date.now() });
    saveOutbox();
    notify();
    // すぐに送ってみる。失敗しても送信箱には残る。
    setTimeout(flush, 50);
  }

  const upsert = (table, rows) => queue("upsert", table, rows);
  const remove = (table, keys) => queue("remove", table, keys);

  /**
   * 送信箱を順に送る。
   * 名刺画像がまだドライブに無い場合は、先に画像を送ってから行を送ります。
   */
  async function flush() {
    if (flushing || !outbox.length) return;
    flushing = true; notify();

    try {
      while (outbox.length) {
        const item = outbox[0];

        if (item.op === "upsert") {
          const rows = await prepareRows(item.table, item.payload);
          await call("upsert", { table: item.table, rows: rows });
        } else {
          await call("remove", { table: item.table, keys: item.payload });
        }

        outbox.shift();
        saveOutbox();
        notify();
      }
      available = true; lastError = "";
    } catch (err) {
      lastError = err.message;
      available = false;
    }

    flushing = false;
    notify();
  }

  /** 名刺の行を送る前に、画像をドライブへ送る */
  async function prepareRows(table, rows) {
    if (table !== "BusinessCards") return rows;

    const out = [];
    for (const row of rows) {
      const copy = Object.assign({}, row);
      if (!copy.image_file_id && copy.image_path) {
        try {
          const r = await call("saveImage", {
            name: "card-" + (copy.id || Date.now()),
            dataUrl: copy.image_path,
          });
          copy.image_file_id = r.fileId;
          if (r.fileId) imageCache[r.fileId] = copy.image_path;
          // 画面側にも、どこに保存されたかを伝える
          if (typeof Storage !== "undefined" && Storage.noteCardImageId) {
            Storage.noteCardImageId(copy.id, r.fileId);
          }
        } catch (err) {
          // 画像だけ失敗しても、行そのものは登録する
          console.warn("名刺画像を保存できませんでした", err);
        }
      }
      delete copy.image_path;      // 画像そのものはシートに入れない
      out.push(copy);
    }
    return out;
  }


  /* --- 名刺画像の取り出し -------------------------------------------------- */

  async function getImage(fileId) {
    if (!fileId) return null;
    if (imageCache[fileId]) return imageCache[fileId];
    try {
      const r = await call("getImage", { fileId: fileId });
      imageCache[fileId] = r.dataUrl;
      return r.dataUrl;
    } catch {
      return null;
    }
  }

  const hasImage = (fileId) => Boolean(fileId && imageCache[fileId]);
  const cachedImage = (fileId) => imageCache[fileId] || null;
  function cacheImage(fileId, dataUrl) {
    if (fileId && dataUrl) imageCache[fileId] = dataUrl;
  }


  return {
    check, fetchAll, upsert, remove, flush,
    getImage, hasImage, cachedImage, cacheImage,
    status, onChange,
    isAvailable: () => available === true,
  };
})();
