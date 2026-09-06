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
      // 利用上限に当たったときは、少し待って1回だけやり直す
      if (json && json.status === 429 && attempt < 2) {
        await sleep(4000);
        return readPage(sendDataUrl, attempt + 1);
      }
      throw new Error(json.error || "サーバーがエラーを返しました（" + res.status + "）");
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
  async function readPages(pages, onEach, onError) {
    for (let i = 0; i < pages.length; i++) {
      try {
        const cards = await readPage(pages[i].send);
        if (onEach) onEach(i, cards, pages[i]);
      } catch (err) {
        if (onError) onError(i, err.message, pages[i]);
      }
      // 続けて投げすぎないよう、少し間を空ける
      if (i < pages.length - 1) await sleep(400);
    }
  }


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

  /** 質問から検索語を取り出す */
  function readIntent(question) {
    return post({ mode: "intent", question: question });
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
    askAnswer: askAnswer,
    ping: ping,
  };
})();