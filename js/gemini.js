/* =============================================================================
   AIへの問い合わせ

   ブラウザから Gemini API を直接呼ぶことはしません。
   Cloudflare Workers（APIキーを預けてある場所）を経由します。

     このファイル  →  Cloudflare Workers  →  Gemini API

   そのため、このファイルにAPIキーは一切出てきません。
   ============================================================================= */

const AI = (function () {

  /**
   * 画像を小さくしてから送るための処理。
   *
   * スマートフォンの写真はそのままだと5MB前後あり、
   *   ・通信に時間がかかる
   *   ・AIの利用料が高くなる
   *   ・ブラウザの保存容量をすぐ使い切る
   * ため、長辺1280ピクセルのJPEGに縮小します。名刺の文字は十分読み取れます。
   *
   * @returns {Promise<string>} "data:image/jpeg;base64,..." という形式の文字列
   */
  function shrinkImage(file, maxEdge = 1280, quality = 0.82) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);

      img.onload = function () {
        URL.revokeObjectURL(url);
        const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };

      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error("画像を読み込めませんでした。JPEGまたはPNGの画像を選んでください。"));
      };

      img.src = url;
    });
  }

  /**
   * 名刺画像をWorkersに送り、読み取り結果を受け取る。
   * @param {string} dataUrl shrinkImage が返した文字列
   * @returns {Promise<object>} { name, name_kana, organization, ... }
   */
  async function readBusinessCard(dataUrl) {
    const endpoint = (window.APP_CONFIG && window.APP_CONFIG.API_ENDPOINT) || "";

    if (!endpoint) {
      throw new Error(
        "接続先が設定されていません。js/config.js の API_ENDPOINT に、" +
        "Cloudflare Workers のURLを入れてください。"
      );
    }

    // "data:image/jpeg;base64,XXXX" の XXXX の部分だけを取り出す
    const base64 = dataUrl.split(",")[1];

    let res;
    try {
      res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageBase64: base64, mimeType: "image/jpeg" }),
      });
    } catch {
      throw new Error(
        "サーバーに接続できませんでした。js/config.js のURLが正しいか、" +
        "Cloudflare Workers が動いているかを確認してください。"
      );
    }

    let json;
    try {
      json = await res.json();
    } catch {
      throw new Error("サーバーからの応答を読み取れませんでした。");
    }

    if (!res.ok || !json.ok) {
      throw new Error(json.error || `サーバーがエラーを返しました（${res.status}）`);
    }

    return json.data;
  }

  /** 接続確認だけを行う（設定が正しいかを確かめるボタン用） */
  async function ping() {
    const endpoint = (window.APP_CONFIG && window.APP_CONFIG.API_ENDPOINT) || "";
    if (!endpoint) return { ok: false, message: "js/config.js にURLが入っていません。" };
    try {
      const res = await fetch(endpoint, { method: "GET" });
      const json = await res.json();
      if (json.ok) return { ok: true, message: `接続できました（モデル: ${json.model}）` };
      return { ok: false, message: json.error || "応答が想定と違います。" };
    } catch {
      return { ok: false, message: "接続できませんでした。URLを確認してください。" };
    }
  }

  return { shrinkImage, readBusinessCard, ping };
})();
