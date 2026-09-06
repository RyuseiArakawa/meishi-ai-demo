/* 版の番号。index.html と照らし合わせて、古いファイルが残っていないか確かめます。 */
(window.APP_BUILD = window.APP_BUILD || {})["gemini"] = 14;

/* =============================================================================
   AIへの問い合わせと、画像の準備

   ブラウザから Gemini API を直接呼ぶことはしません。
   Cloudflare Workers（APIキーを預けてある場所）を経由します。

     このファイル  →  Cloudflare Workers  →  Gemini API

   そのため、このファイルにAPIキーは一切出てきません。
   ============================================================================= */

const AI = (function () {

  // 送信用：読み取り精度を優先して、やや大きめ
  const SEND_MAX = 1600;
  const SEND_QUALITY = 0.85;

  // 保存用：ブラウザの容量（約5MB）を節約するため小さめ
  const THUMB_MAX = 640;
  const THUMB_QUALITY = 0.7;


  /* --- 画像を縮小する ---------------------------------------------------- */

  function scaleTo(source, sw, sh, maxEdge, quality) {
    const scale = Math.min(1, maxEdge / Math.max(sw, sh));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(sw * scale));
    canvas.height = Math.max(1, Math.round(sh * scale));
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", quality);
  }

  /**
   * 送信用と保存用の2種類を作る。
   * 送信用は大きく（読み取り精度のため）、保存用は小さく（容量節約のため）。
   */
  function makePair(source, width, height) {
    return {
      send: scaleTo(source, width, height, SEND_MAX, SEND_QUALITY),
      thumb: scaleTo(source, width, height, THUMB_MAX, THUMB_QUALITY),
    };
  }

  /** すでに描画済みのcanvas（PDFのページなど）から2種類を作る */
  function pairFromCanvas(canvas) {
    return makePair(canvas, canvas.width, canvas.height);
  }

  /** 画像ファイルから2種類を作る */
  function pairFromFile(file) {
    return new Promise(function (resolve, reject) {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = function () {
        URL.revokeObjectURL(url);
        try {
          resolve(makePair(img, img.naturalWidth, img.naturalHeight));
        } catch (e) {
          reject(new Error("画像を処理できませんでした。"));
        }
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error("画像を読み込めませんでした：" + file.name));
      };
      img.src = url;
    });
  }


  /* --- 選ばれたファイルを、読み取り待ちの一覧に変換する ------------------- */

  /**
   * 画像ファイルとPDFファイルが混ざっていても受け付ける。
   * PDFは1ページずつ画像に変換する。
   *
   * @returns {Promise<Array>} [{ send, thumb, label }, ...]
   */
  async function filesToPages(fileList, onProgress) {
    const files = Array.from(fileList || []);
    const pages = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const isPdf = file.type === "application/pdf" ||
                    /\.pdf$/i.test(file.name);

      if (isPdf) {
        if (onProgress) onProgress("PDFを読み込んでいます：" + file.name);
        const rendered = await PdfPages.toPages(file, onProgress);
        rendered.forEach(function (p) { pages.push(p); });
      } else if (file.type.startsWith("image/")) {
        if (onProgress) onProgress("画像を準備しています：" + file.name);
        const pair = await pairFromFile(file);
        pages.push({ send: pair.send, thumb: pair.thumb, label: file.name });
      }
      // それ以外の種類のファイルは黙って飛ばす
    }
    return pages;
  }


  /* --- Workers に送って読み取ってもらう ----------------------------------- */

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* --- 送りすぎないようにする ---------------------------------------------

     無料枠には「1分あたりの回数」の上限があります（多くのモデルで10〜15回）。
     一気に送ると上限に当たり、しばらく使えなくなります。
     そこで、前回の送信からの間隔をあけてから送ります。
     ------------------------------------------------------------------------ */

  let lastSentAt = 0;

  const rpm = () => Math.max(1, Number(
    (window.APP_CONFIG && window.APP_CONFIG.REQUESTS_PER_MINUTE) || 10));

  /** 次に送れるようになるまでの待ち時間（ミリ秒） */
  function waitNeeded() {
    const gap = 60000 / rpm();
    return Math.max(0, lastSentAt + gap - Date.now());
  }

  /** 間隔があくまで待つ。待っている間は onWait に残り秒数を伝える。 */
  async function pace(onWait) {
    let left = waitNeeded();
    while (left > 0) {
      if (onWait) onWait(Math.ceil(left / 1000));
      await sleep(Math.min(1000, left));
      left = waitNeeded();
    }
    lastSentAt = Date.now();
  }

  function endpoint() {
    return (window.APP_CONFIG && window.APP_CONFIG.API_ENDPOINT) || "";
  }

  /**
   * 1枚の画像を読み取る。
   * @returns {Promise<Array>} 名刺の配列。名刺が写っていなければ空配列。
   */
  async function readPage(sendDataUrl, attempt) {
    attempt = attempt || 1;
    const url = endpoint();

    if (!url) {
      throw new Error(
        "接続先が設定されていません。js/config.js の API_ENDPOINT に、" +
        "Cloudflare Workers のURLを入れてください。"
      );
    }

    const base64 = sendDataUrl.split(",")[1];

    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageBase64: base64, mimeType: "image/jpeg" }),
      });
    } catch {
      throw new Error(
        "サーバーに接続できませんでした。js/config.js のURLが正しいか確認してください。"
      );
    }

    let json;
    try {
      json = await res.json();
    } catch {
      throw new Error("サーバーからの応答を読み取れませんでした。");
    }

    if (!res.ok || !json.ok) {
      const err = new Error(json.error || "サーバーがエラーを返しました（" + res.status + "）");
      err.limit = json && json.limit;               // "rate" か "daily"
      err.retryAfter = (json && json.retryAfter) || null;
      throw err;
    }

    // 新しい形（複数枚）と、古い形（1枚だけ）のどちらでも受け取れるようにする
    if (Array.isArray(json.cards)) return json.cards;
    if (json.data) return [json.data];
    return [];
  }

  /**
   * 複数ページをまとめて読み取る。
   * APIに一度に投げると上限に当たるため、1件ずつ順番に処理する。
   *
   * @param pages     filesToPages が返した一覧
   * @param onEach    1件終わるたびに呼ばれる (index, 結果, ページ情報)
   * @param onError   失敗したときに呼ばれる (index, メッセージ, ページ情報)
   */
  async function readPages(pages, onEach, onError, onWait) {
    for (let i = 0; i < pages.length; i++) {
      // 1分あたりの上限を超えないよう、間隔をあける
      await pace(function (sec) {
        if (onWait) onWait("次の1枚まで " + sec + " 秒待っています（1分あたりの上限を超えないため）");
      });
      if (onWait) onWait("");

      let done = false;
      for (let tries = 0; tries < 3 && !done; tries++) {
        try {
          const cards = await readPage(pages[i].send);
          if (onEach) onEach(i, cards, pages[i]);
          done = true;
        } catch (err) {
          // 1日の上限は待っても直らないので、ここで打ち切る
          if (err.limit === "daily") {
            if (onError) onError(i, err.message, pages[i]);
            const stop = new Error(err.message);
            stop.limit = "daily";
            throw stop;
          }
          // 1分の上限なら、待ってからやり直す
          if (err.limit === "rate" && tries < 2) {
            const wait = err.retryAfter || (tries === 0 ? 20 : 45);
            for (let s = wait; s > 0; s--) {
              if (onWait) onWait("利用上限に当たりました。" + s + " 秒待ってから続けます");
              await sleep(1000);
            }
            if (onWait) onWait("");
            lastSentAt = 0;
            continue;
          }
          if (onError) onError(i, err.message, pages[i]);
          done = true;
        }
      }
    }
  }

  /** 何枚読むのに、どれくらいかかるかの目安（秒） */
  const estimateSeconds = (count) => Math.round((count - 1) * (60 / rpm()));


  /* --- AI検索（Phase 5） --------------------------------------------------
     設計書 §14 の構成にしたがい、2回に分けてWorkerを呼びます。
       1回目 … 質問から検索語を取り出す（AIはデータベースを見ない）
       2回目 … システムが検索した結果だけを渡して、回答を作らせる
     ------------------------------------------------------------------------ */

  async function post(payload) {
    const url = endpoint();
    if (!url) {
      throw new Error(
        "接続先が設定されていません。js/config.js の API_ENDPOINT に、" +
        "Cloudflare Workers のURLを入れてください。"
      );
    }
    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch {
      throw new Error("サーバーに接続できませんでした。");
    }
    let json;
    try { json = await res.json(); }
    catch { throw new Error("サーバーからの応答を読み取れませんでした。"); }

    if (!res.ok || !json.ok) {
      throw new Error(json.error || "サーバーがエラーを返しました（" + res.status + "）");
    }
    return json;
  }

  /* 同じ質問の「解釈」は毎回同じなので、一度聞いた分は覚えておきます。
     「もう一度聞く」を押したときに、無駄に回数を使わないためです。 */
  const intentCache = {};

  async function readIntent(question) {
    const key = String(question).trim();
    if (intentCache[key]) return intentCache[key];
    const r = await post({ mode: "intent", question: key });
    intentCache[key] = r;
    return r;
  }

  /** 検索結果だけを根拠に回答を作る */
  function askAnswer(question, context) {
    return post({ mode: "answer", question: question, context: context });
  }


  /* --- 接続確認 ----------------------------------------------------------- */

  async function ping() {
    const url = endpoint();
    if (!url) return { ok: false, message: "js/config.js にURLが入っていません。" };
    try {
      const res = await fetch(url, { method: "GET" });
      const json = await res.json();
      if (json.ok) {
        return {
          ok: true,
          message: "接続できました（モデル: " + json.model + "）",
          multi: json.multi === true,
          aiSearch: json.ai_search === true,
          sharedDb: json.shared_db === true,
        };
      }
      return { ok: false, message: json.error || "応答が想定と違います。" };
    } catch {
      return { ok: false, message: "接続できませんでした。URLを確認してください。" };
    }
  }


  return {
    pairFromCanvas: pairFromCanvas,
    pairFromFile: pairFromFile,
    filesToPages: filesToPages,
    readPage: readPage,
    readPages: readPages,
    readIntent: readIntent,
    estimateSeconds: estimateSeconds,
    askAnswer: askAnswer,
    ping: ping,
  };
})();