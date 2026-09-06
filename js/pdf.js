/* =============================================================================
   PDFをページごとの画像に変換する

   名刺スキャナーで取り込んだPDFを、1ページずつ画像にしてからAIに渡します。
   PDFのまま送る方法もありますが、ページごとに画像にしておくと、
   登録した人物それぞれに名刺の画像を紐づけられます。

   PDFを読む部分は、Mozilla の pdf.js という部品を使っています。
   インターネットから読み込むので、インストール作業は不要です。
   PDFを選んだときに初めて読み込まれるため、普段の動作は重くなりません。
   ============================================================================= */

const PdfPages = (function () {

  // 部品の置き場所。バージョンを固定してあります。
  // 新しくしたいときは、この2行の数字（6.3.289）をそろえて変えてください。
  const PDFJS_URL  = "https://cdn.jsdelivr.net/npm/pdfjs-dist@6.3.289/build/pdf.min.mjs";
  const WORKER_URL = "https://cdn.jsdelivr.net/npm/pdfjs-dist@6.3.289/build/pdf.worker.min.mjs";

  // 一度に扱うページ数の上限。これを超えると時間も費用もかかりすぎるため。
  const MAX_PAGES = 60;

  // 変換するときの横幅の目安。
  // A4に複数枚並べてスキャンした場合でも、文字が読める大きさになるようにしています。
  const TARGET_WIDTH = 2000;

  let pdfjs = null;

  /** pdf.js を読み込む（初回だけ） */
  async function load() {
    if (pdfjs) return pdfjs;
    try {
      pdfjs = await import(PDFJS_URL);
      pdfjs.GlobalWorkerOptions.workerSrc = WORKER_URL;
      return pdfjs;
    } catch {
      throw new Error(
        "PDFを読み込む部品を取得できませんでした。" +
        "インターネットに接続しているか確認してください。"
      );
    }
  }

  /**
   * PDFファイルを、ページごとの画像に変換する。
   * @param file       PDFファイル
   * @param onProgress 進み具合を伝える関数（文字列を受け取る）
   * @returns {Promise<Array>} [{ send, thumb, label }, ...]
   */
  async function toPages(file, onProgress) {
    const lib = await load();

    const buffer = await file.arrayBuffer();

    let doc;
    try {
      doc = await lib.getDocument({ data: buffer }).promise;
    } catch (err) {
      if (err && /password/i.test(String(err.message))) {
        throw new Error("このPDFにはパスワードがかかっています：" + file.name);
      }
      throw new Error("PDFを開けませんでした：" + file.name);
    }

    const total = Math.min(doc.numPages, MAX_PAGES);
    const pages = [];

    for (let n = 1; n <= total; n++) {
      if (onProgress) {
        onProgress("PDFを画像に変換しています（" + n + " / " + total + "ページ）");
      }

      const page = await doc.getPage(n);

      // 文字が読める大きさになるよう、拡大率を決める
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(4, Math.max(1, TARGET_WIDTH / base.width));
      const viewport = page.getViewport({ scale: scale });

      const canvas = document.createElement("canvas");
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);

      // 背景は pdf.js が白で塗ってくれる
      await page.render({
        canvas: canvas,
        viewport: viewport,
        background: "#ffffff",
      }).promise;

      const pair = AI.pairFromCanvas(canvas);
      pages.push({
        send: pair.send,
        thumb: pair.thumb,
        label: file.name + " p." + n,
      });

      page.cleanup();
    }

    doc.destroy();

    if (doc.numPages > MAX_PAGES && onProgress) {
      onProgress(
        "このPDFは" + doc.numPages + "ページありますが、" +
        "一度に処理できる上限のため最初の" + MAX_PAGES + "ページだけを読み取ります。"
      );
    }

    return pages;
  }

  return { toPages: toPages, MAX_PAGES: MAX_PAGES };
})();
