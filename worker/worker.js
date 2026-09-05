/* =============================================================================
   組織内人脈・知識グラフ型 名刺OCR AIシステム
   Cloudflare Workers ― 名刺読み取りAPI（Phase 1）

   このファイルの中身を、Cloudflare の画面にコピー＆ペーストします。
   GitHub には上げなくて構いません（上げても、APIキーは含まれていないので安全です）。

   役割：
     ブラウザから名刺画像を受け取る
       ↓
     Gemini API に渡す（APIキーはここで付ける）
       ↓
     読み取った項目をブラウザに返す

   APIキーはこのファイルには書きません。
   Cloudflare の「変数とシークレット」に GEMINI_API_KEY という名前で登録します。
   ============================================================================= */


/* --- ここだけ、あなたの環境に合わせて書き換えます ------------------------- */

// 呼び出しを許可するURL。あなたのGitHub PagesのURLに変えてください。
// 末尾のスラッシュは付けません。
const ALLOWED_ORIGINS = [
  "https://YOUR-NAME.github.io",   // ← 例: https://taro-yamada.github.io
  "http://localhost:8000",         // パソコンで試すとき用
  "http://127.0.0.1:8000",         // 同上
];

// 使うモデル。2026年9月時点の安定版から選んでいます。
//   gemini-3.5-flash-lite … 速くて安い（デモ向き・おすすめ）
//   gemini-3.6-flash      … 読み取り精度を上げたいとき
//   gemini-3.8-flash      … 最上位。手書きの名刺など難しいもの向け
const MODEL = "gemini-3.5-flash-lite";

/* --- 書き換えるのはここまで ------------------------------------------------ */


/* 名刺抽出のルール（仕様書 §6・§7）。
   ブラウザ側ではなくサーバー側に置くことで、利用者が書き換えられないようにします。 */
const SYSTEM_PROMPT = `あなたは名刺情報を構造化する情報抽出AIです。
与えられた名刺画像から、名刺に記載されている情報だけを抽出してください。

以下の原則を必ず守ってください。
1. 画像に存在しない情報を推測しない。補完しない。
2. 情報が存在しない場合は空文字列 "" を返す。
3. 氏名と会社名を混同しない。
4. 部署と役職を区別する。部署は組織の区分、役職は肩書きである。
5. 電話番号とFAX番号を区別する。「FAX」「F」と併記された番号はfaxに入れる。
6. メールアドレスは一字一句そのまま抽出する。
7. 文字が読み取りにくく判断に迷った箇所は、その旨を notes に日本語で記録する。
8. 名刺に書かれていない専門分野・人間関係・経歴を推測して補わない。
9. JSONのみを出力する。説明文は出力しない。`;

/* 出力の型を固定する。これにより余計な文章が混ざらない。 */
const CARD_SCHEMA = {
  type: "object",
  properties: {
    name:         { type: "string" },
    name_kana:    { type: "string" },
    organization: { type: "string" },
    department:   { type: "string" },
    job_title:    { type: "string" },
    email:        { type: "string" },
    phone:        { type: "string" },
    fax:          { type: "string" },
    address:      { type: "string" },
    website:      { type: "string" },
    notes:        { type: "string" },
  },
  required: [
    "name", "name_kana", "organization", "department", "job_title",
    "email", "phone", "fax", "address", "website", "notes",
  ],
  propertyOrdering: [
    "name", "name_kana", "organization", "department", "job_title",
    "email", "phone", "fax", "address", "website", "notes",
  ],
};

const FIELDS = CARD_SCHEMA.propertyOrdering;


export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowed = ALLOWED_ORIGINS.includes(origin);
    const cors = {
      "Access-Control-Allow-Origin": allowed ? origin : ALLOWED_ORIGINS[0],
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
    };

    // ブラウザが本番の通信の前に送ってくる「事前確認」への返事
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    // 動作確認用。ブラウザでWorkerのURLを開くとこれが表示される
    if (request.method === "GET") {
      return reply({ ok: true, service: "meishi-ocr", model: MODEL }, 200, cors);
    }

    if (request.method !== "POST") {
      return reply({ ok: false, error: "POSTで送信してください。" }, 405, cors);
    }

    if (!allowed) {
      return reply({
        ok: false,
        error: "このURLからの呼び出しは許可されていません。worker.js の ALLOWED_ORIGINS を確認してください。",
      }, 403, cors);
    }

    if (!env.GEMINI_API_KEY) {
      return reply({
        ok: false,
        error: "APIキーが設定されていません。Cloudflareの「変数とシークレット」に GEMINI_API_KEY を登録してください。",
      }, 500, cors);
    }

    // --- ブラウザから送られてきた画像を取り出す ---
    let body;
    try {
      body = await request.json();
    } catch {
      return reply({ ok: false, error: "送信データを読み取れませんでした。" }, 400, cors);
    }

    const imageBase64 = body.imageBase64;
    const mimeType = body.mimeType || "image/jpeg";
    if (!imageBase64) {
      return reply({ ok: false, error: "画像が含まれていません。" }, 400, cors);
    }
    // 5MBを超える画像は受け付けない（base64は元データの約1.37倍になる）
    if (imageBase64.length > 7_000_000) {
      return reply({ ok: false, error: "画像が大きすぎます。" }, 413, cors);
    }

    // --- Gemini API を呼ぶ ---
    const url =
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent` +
      `?key=${encodeURIComponent(env.GEMINI_API_KEY)}`;

    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents: [{
            role: "user",
            parts: [
              { text: "以下は名刺の画像です。記載されている情報のみを抽出してください。" },
              { inline_data: { mime_type: mimeType, data: imageBase64 } },
            ],
          }],
          generationConfig: {
            responseMimeType: "application/json",
            responseSchema: CARD_SCHEMA,
          },
        }),
      });
    } catch {
      return reply({ ok: false, error: "Gemini APIに接続できませんでした。" }, 502, cors);
    }

    if (!res.ok) {
      let detail = `${res.status}`;
      try {
        const e = await res.json();
        if (e?.error?.message) detail = e.error.message;
      } catch { /* 本文が読めなくても続行 */ }

      let message = `Gemini APIがエラーを返しました（${detail}）`;
      if (res.status === 400 && /API key|API_KEY/i.test(detail)) {
        message = "APIキーが正しくありません。Cloudflareに登録したキーを確認してください。";
      } else if (res.status === 403) {
        message = "APIキーの権限がありません。Google AI Studioでキーを作り直してください。";
      } else if (res.status === 404) {
        message = `モデル "${MODEL}" が見つかりません。worker.js の MODEL を確認してください。`;
      } else if (res.status === 429) {
        message = "利用回数の上限に達しました。しばらく待ってから試してください。";
      }
      return reply({ ok: false, error: message }, 502, cors);
    }

    // --- 返ってきたJSONを整える ---
    const json = await res.json();
    const text = (json?.candidates?.[0]?.content?.parts || [])
      .map((p) => p.text || "")
      .join("")
      .trim();

    if (!text) {
      return reply({
        ok: false,
        error: "AIが応答を返しませんでした。名刺がはっきり写っているか確認して、もう一度試してください。",
      }, 502, cors);
    }

    let parsed;
    try {
      parsed = JSON.parse(text.replace(/^```json\s*|\s*```$/g, ""));
    } catch {
      return reply({ ok: false, error: "AIの応答を解釈できませんでした。" }, 502, cors);
    }

    // 空文字は null にそろえる（仕様書§7「情報がない場合は null」）
    const data = {};
    for (const key of FIELDS) {
      const v = typeof parsed[key] === "string" ? parsed[key].trim() : "";
      data[key] = v === "" ? null : v;
    }

    return reply({ ok: true, model: MODEL, data }, 200, cors);
  },
};


function reply(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...cors },
  });
}
