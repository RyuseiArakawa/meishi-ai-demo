/* 版の番号。index.html と照らし合わせて、古いファイルが残っていないか確かめます。 */
(window.APP_BUILD = window.APP_BUILD || {})["ai-chat"] = 14;

/* =============================================================================
   AIチャット（Phase 5）

   右下のアイコンを押すと、チャット画面が開きます。
   質問を入力すると、登録されている情報だけを根拠に回答します。

   中の仕組みは、設計書 §14 のままです。

     1. 質問の解釈    AI       … 質問文から検索語を取り出す（DBは見ない）
     2. データベース検索  システム … 決まった検索関数だけを呼ぶ
     3. 回答の作成    AI       … 2の結果だけを根拠に文章にする

   つながりを尋ねられたときは、その部分だけを小さな図にして返します。
   文章だけだと「誰を経由するのか」が伝わりにくいためです。
   ============================================================================= */

const AIChat = (function () {

  const esc = UI.esc;
  const $ = UI.$;

  const EXAMPLES = [
    "旋盤加工について相談できる人は？",
    "材料分析に詳しい人を教えて",
    "荒川さんとはどんなつながりがある？",
    "松本さんを紹介してもらうには誰に頼めばいい？",
  ];

  /* 「何ができるか」への答え。
     これは登録データと関係のない、このシステム自身の説明なので、
     AIには聞かずにここで返します。毎回同じ内容を確実に返せます。 */
  const HELP_RE = /何ができ|なにができ|出来る事|できること|できる事|使い方|つかいかた|機能|ヘルプ|help|どんな質問/i;

  const HELP_TEXT =
      "登録されている名刺の情報をもとに、次のことをお答えできます。\n\n"
    + "● 人を探す\n"
    + "　「旋盤加工に詳しい人は？」のように、専門分野・組織・役職から探せます。\n\n"
    + "● つながりを調べる\n"
    + "　「荒川さんとはどんなつながり？」「松本さんを紹介してもらうには？」\n"
    + "　経路が見つかると、図でお見せします。\n\n"
    + "● 社内の誰が接点を持つか\n"
    + "　その人の名刺を登録した社内の人をお伝えします。\n\n"
    + "● 交流の記録\n"
    + "　「いつ、どこで会ったか」の記録から探せます。\n\n"
    + "できないこと\n"
    + "　登録されていないことは答えられません。推測もしません。\n"
    + "　メールアドレス・電話番号・住所はAIに渡していません。";

  let open = false;
  let busy = false;
  let messages = [];        // { role, text, data }
  let lastPersons = [];     // 直前の回答に出てきた人物（次の候補づくりに使う）

  /** 入力欄の上に出す質問候補 */
  function suggestions() {
    const out = [];

    // 直前の回答に人が出ていれば、その人についての続きを勧める
    lastPersons.slice(0, 2).forEach(function (id) {
      const p = Storage.getPerson(id);
      if (p) {
        const nm = String(p.name).split(/[ 　]/)[0];
        out.push(nm + "さんとのつながりは？");
        out.push(nm + "さんへの紹介は？");
      }
    });

    // 登録されている専門分野から、実際に答えが出るものを選ぶ
    const topics = Storage.getAllTopics();
    for (let i = 0; i < topics.length && out.length < 3; i++) {
      const t = topics[(i * 7 + messages.length) % topics.length];
      const q = t.name + "に詳しい人";
      if (out.indexOf(q) < 0) out.push(q);
    }

    // この1つは必ず残す（何を聞けるか分からないときの入口になるため）
    return out.slice(0, 3).concat(["何ができますか？"]);
  }


  /* =========================================================================
     開く・閉じる
     ========================================================================= */

  function toggle() { open ? close() : show(); }

  function show() {
    open = true;
    $("chat-panel").hidden = false;
    applyLayout();
    $("chat-fab").classList.add("is-open");
    render();
    setTimeout(function () { const i = $("chat-input"); if (i) i.focus(); }, 60);
  }

  function close() {
    open = false;
    $("chat-panel").hidden = true;
    $("chat-fab").classList.remove("is-open");
  }


  /* =========================================================================
     表示
     ========================================================================= */

  function render() {
    const log = $("chat-log");

    log.innerHTML = messages.length
      ? messages.map(bubbleHtml).join("")
      : '<div class="chat-intro">'
        + '<div class="chat-intro-title">登録されている人について質問できます</div>'
        + '<p class="note">回答は、このシステムに登録されている情報だけをもとに作られます。'
        + "登録されていないことは答えられません。</p>"
        + '<div class="chat-examples">'
        +   EXAMPLES.map((q, i) => '<button class="chat-ex" data-ex="' + i + '">'
              + esc(q) + "</button>").join("")
        + "</div></div>";

    if (busy) {
      log.innerHTML += '<div class="chat-row is-ai"><div class="chat-bubble">'
        + '<span class="spinner" aria-hidden="true"></span> 調べています…</div></div>';
    }

    log.scrollTop = log.scrollHeight;

    // 入力欄の上の質問候補
    $("chat-suggest").innerHTML = busy ? "" : suggestions()
      .map((q, i) => '<button class="sg" data-sg="' + i + '">' + esc(q) + "</button>").join("");

    wire();
  }

  function bubbleHtml(m) {
    if (m.role === "user") {
      return '<div class="chat-row is-me"><div class="chat-bubble">'
        + esc(m.text) + "</div></div>";
    }

    const d = m.data || {};
    return '<div class="chat-row is-ai"><div class="chat-bubble">'
      + '<p class="chat-answer' + (d.insufficient ? " is-insufficient" : "") + '">'
      +   esc(m.text) + "</p>"

      // つながりの質問なら、その部分だけを図にする
      + (d.diagram ? d.diagram : "")
      + (d.focusIds && d.focusIds.length > 1
        ? '<button class="chat-link" data-focus="' + esc(d.focusIds.join(",")) + '">'
          + "人脈グラフで見る</button>"
        : "")

      // 根拠
      + (d.persons && d.persons.length
        ? '<div class="chat-persons">' + d.persons.map(function (item) {
            const p = Storage.getPerson(item.person_id);
            if (!p) return "";
            const knows = Storage.getUsersWhoKnow(p.id);
            return '<div class="chat-person">'
              + '<button class="chat-person-name" data-person="' + p.id + '">'
              +   esc(p.name) + "</button>"
              + '<span class="chat-person-org">'
              +   esc([Storage.getOrganizationName(p.organization_id), p.job_title]
                    .filter(Boolean).join("　")) + "</span>"
              + (item.reason ? '<div class="chat-reason">' + esc(item.reason) + "</div>" : "")
              + (item.evidence
                  ? '<div class="chat-evidence">根拠：' + esc(item.evidence) + "</div>" : "")
              + (knows.length
                  ? '<div class="chat-knows">社内の接点：'
                    + knows.map((u) => esc(u.name)).join("、") + "</div>"
                  : "")
              + "</div>";
          }).join("") + "</div>"
        : "")

      // 処理の内容（開くと見られる）
      + (d.trace
        ? '<details class="chat-trace"><summary>この回答の作られ方</summary>'
          + '<div class="ct-step"><b>1. 質問の解釈（AI）</b>　検索語：'
          +   (d.keywords.length
              ? d.keywords.map((k) => '<span class="kw">' + esc(k) + "</span>").join("")
              : "（なし）")
          + "</div>"
          + '<div class="ct-step"><b>2. データベース検索（システム）</b>'
          +   '<ul>' + d.trace.map((t) => "<li><code>" + esc(t.fn)
              + '("' + esc(t.arg) + '")</code> → ' + t.count + " 件</li>").join("") + "</ul>"
          + "</div>"
          + '<div class="ct-step"><b>3. 回答の作成（AI）</b>　'
          +   "渡した人物 " + d.contextCount + " 名"
          +   '<div class="fl-note">氏名・所属・専門・関係・交流のみ。'
          +   "メール・電話・住所は渡していません（設計書 §21）。</div>"
          + "</div></details>"
        : "")
      + (m.q && !(m.data && m.data.help)
        ? '<div class="chat-again"><button class="chat-link" data-again="'
          + esc(m.q) + '">もう一度聞く</button></div>'
        : "")
      + "</div></div>";
  }

  function wire() {
    const log = $("chat-log");

    log.querySelectorAll("[data-ex]").forEach(function (b) {
      b.addEventListener("click", function () { send(EXAMPLES[Number(b.dataset.ex)]); });
    });

    const sg = suggestions();
    $("chat-suggest").querySelectorAll("[data-sg]").forEach(function (b) {
      b.addEventListener("click", function () { send(sg[Number(b.dataset.sg)]); });
    });

    // 同じ質問をもう一度送る
    log.querySelectorAll("[data-again]").forEach(function (b) {
      b.addEventListener("click", function () { send(b.dataset.again, true); });
    });
    log.querySelectorAll("[data-person]").forEach(function (b) {
      b.addEventListener("click", function () {
        close();
        UI.show("person", b.dataset.person);
      });
    });
    log.querySelectorAll("[data-focus]").forEach(function (b) {
      b.addEventListener("click", function () {
        const ids = b.dataset.focus.split(",");
        close();
        UI.show("graph");
        Graph.focusOn(ids);
      });
    });
  }


  /* =========================================================================
     つながりを小さな図にする

     チャットの中に収まる大きさで、経路だけを描きます。
     ここに出るのは、人が登録した関係と、名刺の登録記録だけです。
     ========================================================================= */

  function pathDiagram(ids) {
    if (!ids || ids.length < 2) return "";

    const W = 300;
    const gapY = 62;
    const H = 26 + (ids.length - 1) * gapY + 26;
    const x = 46;

    let out = '<svg class="chat-graph" viewBox="0 0 ' + W + " " + H + '" '
      + 'role="img" aria-label="つながりの図">';

    // 線と、その間柄
    for (let i = 0; i < ids.length - 1; i++) {
      const y1 = 26 + i * gapY, y2 = 26 + (i + 1) * gapY;
      const rel = Storage.relationBetween(ids[i], ids[i + 1]);
      out += '<line x1="' + x + '" y1="' + (y1 + 14) + '" x2="' + x + '" y2="' + (y2 - 14) + '"'
        + ' stroke="#a93a2a" stroke-width="2.5"></line>'
        + '<text class="cg-rel" x="' + (x + 14) + '" y="' + ((y1 + y2) / 2 + 4) + '">'
        + esc(rel ? rel.label + (rel.strength ? "（強さ" + rel.strength + "）" : "") : "つながり")
        + "</text>";
    }

    // 丸（社内の人は四角）
    ids.forEach(function (id, i) {
      const y = 26 + i * gapY;
      const isUser = String(id).indexOf("U:") === 0;
      const name = Storage.displayName(id);
      out += isUser
        ? '<rect x="' + (x - 11) + '" y="' + (y - 11) + '" width="22" height="22" rx="3"'
          + ' fill="#16202a"></rect>'
        : '<circle cx="' + x + '" cy="' + y + '" r="11" fill="#2f5d8c"></circle>';
      out += '<text class="cg-name" x="' + (x + 22) + '" y="' + (y + 5) + '">'
        + esc(name) + (isUser ? "（社内）" : "") + "</text>";
    });

    return out + "</svg>";
  }


  /* =========================================================================
     質問を処理する
     ========================================================================= */

  const CONNECTION_WORDS = /つながり|繋がり|関係|紹介|経由|たどり|知って|会う|会い|コンタクト|接点/;

  /**
   * 質問を送る。
   * @param question  質問文
   * @param again     true なら「もう一度」。質問は増やさず、答えだけを作り直す。
   */
  async function send(question, again) {
    const q = String(question || "").trim();
    if (!q || busy) return;

    if (again) {
      // 直前の答えを取り除いて、同じ質問で作り直す
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === "assistant" && messages[i].q === q) {
          messages.splice(i, 1);
          break;
        }
      }
    } else {
      messages.push({ role: "user", text: q });
    }
    $("chat-input").value = "";

    // 「何ができるか」は、このシステム自身の説明なのでAIを呼ばない
    if (HELP_RE.test(q)) {
      messages.push({ role: "assistant", text: HELP_TEXT, q: q, data: { help: true } });
      lastPersons = [];
      render();
      return;
    }

    busy = true;
    render();

    try {
      /* --- 1. 質問の解釈（AI） --- */
      const intent = await AI.readIntent(q);
      const keywords = intent.keywords || [];
      const names = intent.person_names || [];

      /* --- 2. データベース検索（システム） --- */
      const wantsConnection = CONNECTION_WORDS.test(q)
        || intent.intent === "relation" || intent.intent === "path";

      const found = Storage.runSearch(keywords, names, wantsConnection || names.length > 0);
      const context = Storage.buildAIContext(found.ids, 12);

      /* --- 3. 回答の作成（AI） --- */
      const ans = await AI.askAnswer(q, context);
      const persons = (ans.persons || []).filter((x) => Storage.getPerson(x.person_id));

      /* --- つながりの質問なら、経路を図にする --- */
      let diagram = "", focusIds = [];
      if (wantsConnection) {
        const path = choosePath(names, persons);
        if (path && path.length > 1) {
          diagram = pathDiagram(path);
          focusIds = path;
        }
      }

      lastPersons = persons.map((x) => x.person_id);

      messages.push({
        role: "assistant",
        text: ans.answer || "登録情報からは判断できません。",
        q: q,
        data: {
          insufficient: ans.insufficient === true,
          persons: persons,
          keywords: keywords,
          trace: found.trace,
          contextCount: context.length,
          diagram: diagram,
          focusIds: focusIds,
        },
      });

    } catch (err) {
      messages.push({ role: "assistant",
        text: "うまくいきませんでした：" + err.message, q: q, data: {} });
    }

    busy = false;
    render();
  }

  /**
   * どの経路を図にするかを決める。
   *   ・質問に2人の名前が出ていれば、その2人の間
   *   ・1人だけなら、いま使っている社内の人からその人まで
   *     （「紹介してもらうには誰に頼めばよいか」への答えになる）
   */
  function choosePath(names, persons) {
    const idOf = function (name) {
      const hit = Storage.searchPersons(name, "", "name");
      return hit.length ? hit[0].id : null;
    };

    if (names.length >= 2) {
      const a = idOf(names[0]), b = idOf(names[1]);
      if (a && b) return Storage.findConnectionPath(a, b, true);
    }

    const target = names.length ? idOf(names[0])
                 : (persons.length ? persons[0].person_id : null);
    if (!target) return null;

    const me = Storage.getCurrentUserId();
    if (me) {
      const path = Storage.findConnectionPath("U:" + me, target, true);
      if (path) return path;
    }
    return null;
  }


  /* =========================================================================
     組み立て
     ========================================================================= */

  /* =========================================================================
     窓の位置と大きさ

     見出しをつかむと移動、右下の角をつかむと大きさを変えられます。
     指定した位置と大きさは覚えておき、次に開いたときも同じにします。
     画面が狭いときは全画面にするので、移動も大きさ変更もしません。
     ========================================================================= */

  const LAYOUT_KEY = "meishi_chat_layout_v1";
  const MIN_W = 320, MIN_H = 360;

  const isNarrow = () => window.innerWidth <= 700;

  function loadLayout() {
    try {
      const raw = localStorage.getItem(LAYOUT_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }
  function saveLayout(l) {
    try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(l)); } catch (e) {}
  }

  let layout = loadLayout();

  /** 画面からはみ出さないように直す */
  function clampLayout(l) {
    l.w = Math.max(MIN_W, Math.min(l.w, window.innerWidth - 16));
    l.h = Math.max(MIN_H, Math.min(l.h, window.innerHeight - 16));
    l.left = Math.max(8, Math.min(l.left, window.innerWidth - l.w - 8));
    l.top = Math.max(8, Math.min(l.top, window.innerHeight - l.h - 8));
    return l;
  }

  function applyLayout() {
    const el = $("chat-panel");
    if (isNarrow()) {
      // 画面が狭いときは全画面。指定は消さずに残しておく。
      el.style.left = ""; el.style.top = "";
      el.style.width = ""; el.style.height = "";
      el.classList.remove("is-placed");
      return;
    }
    if (!layout) {
      layout = {
        w: 400, h: Math.min(620, window.innerHeight - 130),
        left: window.innerWidth - 400 - 22,
        top: Math.max(12, window.innerHeight - 620 - 88),
      };
    }
    clampLayout(layout);
    el.classList.add("is-placed");
    el.style.left = layout.left + "px";
    el.style.top = layout.top + "px";
    el.style.width = layout.w + "px";
    el.style.height = layout.h + "px";
  }

  function initWindow() {
    const panel = $("chat-panel");
    const head = $("chat-head");
    const grip = $("chat-resize");
    let mode = null, start = null;

    function begin(kind, e) {
      if (isNarrow()) return;
      applyLayout();
      mode = kind;
      start = { x: e.clientX, y: e.clientY,
                left: layout.left, top: layout.top, w: layout.w, h: layout.h };
      panel.classList.add("is-moving");
      if (panel.setPointerCapture) panel.setPointerCapture(e.pointerId);
      e.preventDefault();
    }

    head.addEventListener("pointerdown", function (e) {
      // ボタンを押したときは動かさない
      if (e.target.closest("button")) return;
      begin("move", e);
    });
    grip.addEventListener("pointerdown", function (e) { begin("resize", e); });

    panel.addEventListener("pointermove", function (e) {
      if (!mode) return;
      const dx = e.clientX - start.x, dy = e.clientY - start.y;
      if (mode === "move") {
        layout.left = start.left + dx;
        layout.top = start.top + dy;
      } else {
        layout.w = start.w + dx;
        layout.h = start.h + dy;
      }
      applyLayout();
    });

    function stop() {
      if (!mode) return;
      mode = null;
      panel.classList.remove("is-moving");
      saveLayout(layout);
    }
    panel.addEventListener("pointerup", stop);
    panel.addEventListener("pointercancel", stop);

    // 見出しを2回押すと、元の位置と大きさに戻す
    head.addEventListener("dblclick", function () {
      layout = null; applyLayout(); saveLayout(layout || {});
    });

    window.addEventListener("resize", function () { if (open) applyLayout(); });
  }

  function init() {
    initWindow();
    $("chat-fab").addEventListener("click", toggle);
    $("chat-close").addEventListener("click", close);

    const input = $("chat-input");
    let composing = false;
    input.addEventListener("compositionstart", function () { composing = true; });
    input.addEventListener("compositionend", function () { composing = false; });
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !composing && !e.shiftKey) {
        e.preventDefault();
        send(input.value);
      }
    });
    $("chat-send").addEventListener("click", function () { send(input.value); });

    $("chat-clear").addEventListener("click", function () {
      messages = [];
      render();
    });

    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && open) close();
    });

    render();
  }

  return { init: init, show: show, close: close, toggle: toggle, send: send };
})();