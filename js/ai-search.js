/* =============================================================================
   AI検索（Phase 5）

   設計書 §14 の構成をそのまま実装しています。

     1. 質問の解釈    AI       … 質問文から検索語を取り出す（DBは見ない）
     2. データベース検索  システム … 決まった検索関数だけを呼ぶ
     3. 回答の作成    AI       … 2の結果だけを根拠に文章にする

   途中の3段階を画面に表示します。
   AIがデータベースを直接触っていないことが、操作している人に見えるようにするためです。

   最後に、AIが挙げた人物IDが本当に登録されているかを、画面側でもう一度確かめます。
   （Worker側でも確認していますが、二重に守ります）
   ============================================================================= */

const AISearch = (function () {

  const esc = UI.esc;
  const $ = UI.$;

  const EXAMPLES = [
    "旋盤加工について相談できる人を探して",
    "材料の分析に詳しい人は誰ですか",
    "技能教育について話せる人はいますか",
    "荒川さんとはどのようなつながりがありますか",
    "松本さんを紹介してもらうには誰に頼めばよいですか",
  ];

  let state = {
    question: "",
    running: false,
    step: 0,          // 0=未実行 1=解釈中 2=検索中 3=回答作成中 4=完了
    intent: null,     // AIが取り出した検索語
    trace: [],        // システムが呼んだ検索関数の記録
    contextIds: [],   // AIに渡した人物
    result: null,     // AIの回答
    error: "",
  };


  /* =========================================================================
     画面
     ========================================================================= */

  function enter() {
    render();
  }

  function render() {
    $("ai-form").innerHTML =
        '<div class="ai-inputrow">'
      +   '<input type="text" id="ai-q" class="ai-input" placeholder="登録されている人物について質問してください"'
      +     ' value="' + esc(state.question) + '"'
      +     (state.running ? " disabled" : "") + ">"
      +   '<button class="btn btn-primary" id="ai-go"'
      +     (state.running ? " disabled" : "") + ">検索する</button>"
      + "</div>"
      + '<div class="ai-examples">'
      +   EXAMPLES.map((q, i) =>
          '<button class="ai-ex" data-ex="' + i + '"'
          + (state.running ? " disabled" : "") + ">" + esc(q) + "</button>").join("")
      + "</div>";

    const input = $("ai-q");
    let composing = false;
    input.addEventListener("compositionstart", function () { composing = true; });
    input.addEventListener("compositionend", function () { composing = false; });
    input.addEventListener("input", function () { state.question = this.value; });
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !composing && !state.running) run();
    });
    $("ai-go").addEventListener("click", function () { run(); });
    $("ai-form").querySelectorAll("[data-ex]").forEach(function (b) {
      b.addEventListener("click", function () {
        state.question = EXAMPLES[Number(b.dataset.ex)];
        run();
      });
    });

    renderSteps();
    renderResult();
  }

  /* --- 処理の流れの表示 ---------------------------------------------------- */

  function renderSteps() {
    const box = $("ai-steps");
    if (!state.step && !state.error) { box.hidden = true; return; }
    box.hidden = false;

    const stepState = (n) =>
      state.step > n ? "done" : (state.step === n ? "now" : "wait");

    box.innerHTML =
        '<h3>処理の流れ</h3>'
      + '<ol class="ai-flow">'

      + '<li class="is-' + stepState(1) + '">'
      +   '<div class="fl-head"><span class="fl-who fl-ai">AI</span>質問の解釈</div>'
      +   (state.intent
          ? '<div class="fl-body">'
            + "検索語：" + (state.intent.keywords.length
                ? state.intent.keywords.map((k) => '<span class="kw">' + esc(k) + "</span>").join("")
                : "（なし）")
            + (state.intent.person_names.length
                ? "　人物名：" + state.intent.person_names.map((k) =>
                    '<span class="kw">' + esc(k) + "</span>").join("")
                : "")
            + (state.intent.note ? '<div class="fl-note">' + esc(state.intent.note) + "</div>" : "")
            + '<div class="fl-note">この段階でAIはデータベースを見ていません。</div>'
            + "</div>"
          : "")
      + "</li>"

      + '<li class="is-' + stepState(2) + '">'
      +   '<div class="fl-head"><span class="fl-who fl-sys">システム</span>データベース検索</div>'
      +   (state.trace.length
          ? '<div class="fl-body">'
            + '<ul class="fl-trace">' + state.trace.map((t) =>
                "<li><code>" + esc(t.fn) + "(&quot;" + esc(t.arg) + "&quot;)</code> → "
                + t.count + " 件</li>").join("") + "</ul>"
            + '<div class="fl-note">決められた検索関数だけを呼びます。AIがSQLを書くことはありません。</div>'
            + "</div>"
          : "")
      + "</li>"

      + '<li class="is-' + stepState(3) + '">'
      +   '<div class="fl-head"><span class="fl-who fl-ai">AI</span>回答の作成</div>'
      +   (state.step >= 3
          ? '<div class="fl-body">'
            + "AIに渡した人物：" + state.contextIds.length + " 名"
            + '<div class="fl-note">'
            +   "渡したのは氏名・所属・専門分野・関係・交流の記録だけです。"
            +   "メールアドレス・電話番号・住所は渡していません（設計書 §21）。"
            + "</div></div>"
          : "")
      + "</li>"
      + "</ol>";
  }

  /* --- 回答の表示 ---------------------------------------------------------- */

  function renderResult() {
    const box = $("ai-result");

    if (state.error) {
      box.hidden = false;
      box.innerHTML = '<div class="alert alert-error">' + esc(state.error) + "</div>";
      return;
    }
    if (!state.result) { box.hidden = true; return; }

    const r = state.result;
    box.hidden = false;

    box.innerHTML =
        '<div class="ai-answer' + (r.insufficient ? " is-insufficient" : "") + '">'
      +   '<div class="ai-answer-label">回答</div>'
      +   '<p class="ai-answer-text">' + esc(r.answer) + "</p>"
      + "</div>"

      + (r.persons.length
        ? "<h3>根拠となった登録情報</h3>"
          + '<div class="ai-persons">' + r.persons.map(function (item) {
              const p = Storage.getPerson(item.person_id);
              if (!p) return "";
              const topics = Storage.getTopicsOf(p.id);
              return '<div class="ai-person">'
                + '<div class="ai-person-head">'
                +   '<button class="ai-person-name" data-screen="person" data-id="' + p.id + '">'
                +     esc(p.name) + "</button>"
                +   '<span class="ai-person-org">'
                +     esc([Storage.getOrganizationName(p.organization_id), p.department, p.job_title]
                        .filter(Boolean).join("　／　")) + "</span>"
                + "</div>"
                + (item.reason ? '<div class="ai-reason">' + esc(item.reason) + "</div>" : "")
                + (item.evidence
                    ? '<div class="ai-evidence"><span>根拠</span>' + esc(item.evidence) + "</div>"
                    : "")
                + (topics.length
                    ? '<div class="chips">' + topics.map((t) =>
                        '<span class="chip">' + esc(t.name)
                        + (t.source ? '<span class="chip-src">' + esc(t.source) + "</span>" : "")
                        + "</span>").join("") + "</div>"
                    : "")
                + "</div>";
            }).join("") + "</div>"
        : "")

      + (r.dropped
        ? '<div class="alert alert-warn" style="margin-top:14px">'
          + "AIが挙げた人物のうち " + r.dropped + " 件は、登録されていないため取り除きました。"
          + "</div>"
        : "")

      + '<p class="note" style="margin-top:14px">'
      +   "この回答は、上の検索で見つかった登録情報だけをもとに作られています。"
      +   "登録されていないことは答えられません。"
      + "</p>";
  }


  /* =========================================================================
     実行
     ========================================================================= */

  async function run() {
    const q = String(state.question || "").trim();
    if (!q || state.running) return;

    state.running = true;
    state.error = "";
    state.intent = null;
    state.trace = [];
    state.contextIds = [];
    state.result = null;
    state.step = 1;
    render();

    try {
      /* --- 1. 質問の解釈（AI） --- */
      const intent = await AI.readIntent(q);
      state.intent = {
        keywords: intent.keywords || [],
        person_names: intent.person_names || [],
        intent: intent.intent,
        note: intent.note,
      };
      state.step = 2;
      renderSteps();

      /* --- 2. データベース検索（システム） --- */
      // 人物名が出ている質問（つながり・経路）では、関係先も材料に加える
      const expand = state.intent.person_names.length > 0
        || intent.intent === "relation" || intent.intent === "path";

      const found = Storage.runSearch(
        state.intent.keywords, state.intent.person_names, expand);

      state.trace = found.trace;
      const context = Storage.buildAIContext(found.ids, 12);
      state.contextIds = context.map((c) => c.person_id);
      state.step = 3;
      renderSteps();

      /* --- 3. 回答の作成（AI） --- */
      const ans = await AI.askAnswer(q, context);

      // AIが挙げた人物が、本当に登録されているかを画面側でも確かめる
      const persons = (ans.persons || []).filter((x) => Storage.getPerson(x.person_id));
      const dropped = (ans.persons || []).length - persons.length + (ans.dropped || 0);

      state.result = {
        answer: ans.answer || "",
        insufficient: ans.insufficient === true,
        persons: persons,
        dropped: dropped,
      };
      state.step = 4;

    } catch (err) {
      state.error = err.message;
      state.step = 0;
    }

    state.running = false;
    render();
  }


  return { enter: enter };
})();
