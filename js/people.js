/* =============================================================================
   人物の画面（Phase 2）

     人物一覧  … 検索・絞り込み・並び替え
     人物詳細  … 基本情報の編集、専門分野、交流の記録

   画面の切り替えは app.js の UI.show() が行います。
   このファイルは「人物」まわりの表示だけを担当します。

   設計上の約束（設計書 §6・§9・§20）：
     名刺に書かれていたこと（事実）と、
     人が後から足したこと（専門分野・交流の記録）を、画面の上でも分けて示す。
   ============================================================================= */

const People = (function () {

  const esc = UI.esc;
  const $ = UI.$;

  /* --- 一覧の絞り込み条件。画面を離れても覚えておく --------------------- */
  let filter = { query: "", orgId: "", sort: "name" };

  /* --- 詳細画面の状態 ----------------------------------------------------- */
  let detail = { id: "", editing: false, message: "" };


  /* =========================================================================
     人物一覧
     ========================================================================= */

  function renderList() {
    const all = Storage.getPersons();
    const orgs = Storage.getOrganizations();
    const list = Storage.searchPersons(filter.query, filter.orgId, filter.sort);

    // 絞り込みの操作部分
    $("people-controls").innerHTML =
        '<input type="search" id="pq" class="search" placeholder="氏名・組織・専門分野で探す"'
      + ' value="' + esc(filter.query) + '" autocomplete="off">'
      + '<select id="porg" class="select">'
      +   '<option value="">すべての組織</option>'
      +   orgs.map((o) =>
            '<option value="' + o.id + '"' + (filter.orgId === o.id ? " selected" : "") + '>'
            + esc(o.name) + "（" + o.count + "）</option>").join("")
      + "</select>"
      + '<select id="psort" class="select">'
      +   '<option value="name"' + (filter.sort === "name" ? " selected" : "") + ">ふりがな順</option>"
      +   '<option value="new"'  + (filter.sort === "new"  ? " selected" : "") + ">登録の新しい順</option>"
      +   '<option value="org"'  + (filter.sort === "org"  ? " selected" : "") + ">組織ごと</option>"
      + "</select>";

    $("people-count").textContent = all.length
      ? list.length + " 件を表示（登録 " + all.length + " 件）"
      : "";

    // 一覧本体
    if (!all.length) {
      $("people-list").innerHTML =
          '<div class="empty-box">'
        + "<p>まだ人物が登録されていません。</p>"
        + '<button class="btn" data-screen="capture">名刺を登録する</button>'
        + "</div>";
    } else if (!list.length) {
      $("people-list").innerHTML =
          '<div class="empty-box"><p>条件に合う人物がいません。</p>'
        + '<button class="btn btn-sm" id="btn-clear-filter">条件を消す</button></div>';
    } else {
      $("people-list").innerHTML = list.map(rowHtml).join("");
    }

    wireList();
  }

  function rowHtml(p) {
    const card = Storage.getCardOf(p.id);
    const topics = Storage.getTopicsOf(p.id);
    const meta = [
      Storage.getOrganizationName(p.organization_id),
      p.department, p.job_title,
    ].filter(Boolean).join("　／　");

    return '<button class="prow" data-screen="person" data-id="' + p.id + '">'
      + (card && card.image_path
          ? '<img class="prow-thumb" src="' + card.image_path + '" alt="">'
          : '<span class="prow-thumb prow-noimg" aria-hidden="true">名刺</span>')
      + '<span class="prow-body">'
      +   '<span class="prow-name">' + esc(p.name) + "</span>"
      +   (p.name_kana ? '<span class="prow-kana">' + esc(p.name_kana) + "</span>" : "")
      +   '<span class="prow-meta">' + esc(meta || "所属情報なし") + "</span>"
      +   (topics.length
            ? '<span class="chips">' + topics.map((t) =>
                '<span class="chip">' + esc(t.name) + "</span>").join("") + "</span>"
            : "")
      + "</span></button>";
  }

  function wireList() {
    const q = $("pq");
    if (q) {
      q.addEventListener("input", function () {
        filter.query = q.value;
        const pos = q.selectionStart;
        renderList();
        const nq = $("pq");
        if (nq) { nq.focus(); nq.setSelectionRange(pos, pos); }
      });
    }
    const org = $("porg");
    if (org) org.addEventListener("change", function () {
      filter.orgId = org.value; renderList();
    });
    const sort = $("psort");
    if (sort) sort.addEventListener("change", function () {
      filter.sort = sort.value; renderList();
    });
    const clear = $("btn-clear-filter");
    if (clear) clear.addEventListener("click", function () {
      filter = { query: "", orgId: "", sort: filter.sort }; renderList();
    });
  }


  /* =========================================================================
     人物詳細
     ========================================================================= */

  const EDIT_FIELDS = [
    { key: "name",         label: "氏名" },
    { key: "name_kana",    label: "ふりがな" },
    { key: "organization", label: "会社・組織名" },
    { key: "department",   label: "部署" },
    { key: "job_title",    label: "役職" },
    { key: "phone",        label: "電話番号" },
    { key: "fax",          label: "FAX" },
    { key: "email",        label: "メールアドレス" },
    { key: "address",      label: "住所" },
    { key: "website",      label: "Webサイト" },
  ];

  function renderDetail(id) {
    if (id) { detail = { id: id, editing: false, message: "" }; }

    const p = Storage.getPerson(detail.id);
    if (!p) {
      $("person-body").innerHTML =
        '<div class="empty-box"><p>この人物は見つかりません。</p>'
        + '<button class="btn" data-screen="people">人物一覧へ</button></div>';
      return;
    }

    const card = Storage.getCardOf(p.id);
    const org = Storage.getOrganizationName(p.organization_id);
    const topics = Storage.getTopicsOf(p.id);
    const logs = Storage.getInteractionsOf(p.id);
    const mates = Storage.getColleagues(p.id);

    $("person-body").innerHTML =
        (detail.message ? '<div class="alert alert-warn">' + esc(detail.message) + "</div>" : "")

      /* ---- 見出し ---- */
      + '<div class="pdetail-head">'
      +   "<div>"
      +     '<h1 class="pdetail-name">' + esc(p.name) + "</h1>"
      +     (p.name_kana ? '<div class="pdetail-kana">' + esc(p.name_kana) + "</div>" : "")
      +     '<div class="pdetail-meta">'
      +       esc([org, p.department, p.job_title].filter(Boolean).join("　／　") || "所属情報なし")
      +     "</div>"
      +   "</div>"
      +   '<button class="btn btn-sm" id="btn-edit">'
      +     (detail.editing ? "編集をやめる" : "編集する") + "</button>"
      + "</div>"

      + '<div class="pdetail-grid">'

      /* ---- 左：基本情報 ---- */
      +   '<section class="block">'
      +     "<h3>名刺に記載されていた情報</h3>"
      +     (detail.editing ? editFormHtml(p, org) : readOnlyHtml(p))
      +   "</section>"

      /* ---- 右：名刺画像 ---- */
      +   "<div>"
      +     (card && card.image_path
            ? '<img class="cardshot" src="' + card.image_path + '" alt="'
              + esc(p.name) + 'さんの名刺">'
            : '<div class="noimg-box">名刺画像はありません</div>')
      +     '<p class="note" style="margin-top:8px">登録日：'
            + esc(String(p.created_at || "").slice(0, 10)) + "</p>"
      +   "</div>"
      + "</div>"

      /* ---- 専門分野 ---- */
      + '<section class="block">'
      +   "<h3>専門・技術</h3>"
      +   '<p class="note" style="margin:-6px 0 12px">'
      +     "名刺には書かれていない情報です。会って話した内容や、論文などで確認したことを入力してください。"
      +     "AIには推測させません。"
      +   "</p>"
      +   (topics.length
          ? '<div class="chips chips-lg">' + topics.map((t) =>
              '<span class="chip chip-del">' + esc(t.name)
              + (t.source ? '<span class="chip-src">' + esc(t.source) + "</span>" : "")
              + '<button data-del-topic="' + t.topic_id + '" aria-label="'
              + esc(t.name) + 'を外す">×</button></span>').join("") + "</div>"
          : '<p class="empty">まだ登録されていません。</p>')
      +   '<div class="addrow">'
      +     '<input type="text" id="new-topic" list="topic-list" placeholder="旋盤加工">'
      +     '<input type="text" id="new-topic-src" placeholder="根拠（例：本人から聞いた）">'
      +     '<button class="btn btn-sm" id="btn-add-topic">追加</button>'
      +   "</div>"
      +   '<datalist id="topic-list">'
      +     Storage.getAllTopics().map((t) => '<option value="' + esc(t.name) + '">').join("")
      +   "</datalist>"
      + "</section>"

      /* ---- 交流の記録 ---- */
      + '<section class="block">'
      +   "<h3>交流の記録</h3>"
      +   (logs.length
          ? '<ul class="timeline">' + logs.map((i) =>
              "<li>"
              + "<time>" + esc(String(i.occurred_at || "").slice(0, 10) || "日付なし") + "</time>"
              + '<div class="tl-title">'
              +   esc([i.event_name, i.location].filter(Boolean).join("　／　") || "（表題なし）")
              + "</div>"
              + (i.summary ? '<div class="tl-body">' + esc(i.summary) + "</div>" : "")
              + '<button class="tl-del" data-del-log="' + i.id + '">削除</button>'
              + "</li>").join("") + "</ul>"
          : '<p class="empty">記録がありません。</p>')
      +   '<div class="addrow addrow-log">'
      +     '<input type="date" id="log-date">'
      +     '<input type="text" id="log-event" placeholder="行事名（例：精密工学会 秋季大会）">'
      +     '<input type="text" id="log-place" placeholder="場所">'
      +     '<input type="text" id="log-note" placeholder="話した内容">'
      +     '<button class="btn btn-sm" id="btn-add-log">記録する</button>'
      +   "</div>"
      + "</section>"

      /* ---- 同じ組織の人物 ---- */
      + (mates.length
        ? '<section class="block">'
          + "<h3>同じ組織に登録されている人物</h3>"
          + '<p class="note" style="margin:-6px 0 12px">'
          +   "同じ組織に所属しているという事実だけを示しています。関係の有無は Phase 3 で記録します。"
          + "</p>"
          + '<div class="mates">' + mates.map((m) =>
              '<button class="mate" data-screen="person" data-id="' + m.id + '">'
              + '<span class="mate-name">' + esc(m.name) + "</span>"
              + '<span class="mate-meta">'
              + esc([m.department, m.job_title].filter(Boolean).join("　") || "　") + "</span>"
              + "</button>").join("") + "</div>"
          + "</section>"
        : "")

      /* ---- 削除 ---- */
      + '<section class="block">'
      +   "<h3>この人物の削除</h3>"
      +   '<p class="note" style="margin:-6px 0 10px">'
      +     "名刺画像・専門分野・交流の記録もあわせて消えます。取り消せません。</p>"
      +   '<button class="btn btn-danger btn-sm" id="btn-del-person">削除する</button>'
      + "</section>";

    wireDetail(p);
  }

  function readOnlyHtml(p) {
    const rows = [
      ["ふりがな", p.name_kana], ["会社・組織名", Storage.getOrganizationName(p.organization_id)],
      ["部署", p.department], ["役職", p.job_title],
      ["電話番号", p.phone], ["FAX", p.fax], ["メールアドレス", p.email],
      ["住所", p.address], ["Webサイト", p.website],
    ].filter((r) => r[1]);

    if (!rows.length) return '<p class="empty">記載情報がありません。</p>';

    return '<dl class="kv">' + rows.map((r) =>
      "<div><dt>" + r[0] + "</dt><dd>" + esc(r[1]) + "</dd></div>").join("") + "</dl>"
      + (p.notes ? '<div class="ai-note"><b>AIの注記：</b>' + esc(p.notes) + "</div>" : "");
  }

  function editFormHtml(p, org) {
    return '<div class="ledger">'
      + EDIT_FIELDS.map(function (f) {
          const v = f.key === "organization" ? org : (p[f.key] || "");
          return '<div class="lrow lrow-edit">'
            + '<label for="ed-' + f.key + '">' + f.label + "</label>"
            + '<input type="text" id="ed-' + f.key + '" data-edit="' + f.key + '"'
            + (f.key === "name" ? ' class="is-name"' : "")
            + ' value="' + esc(v) + '">'
            + "</div>";
        }).join("")
      + "</div>"
      + '<div class="btn-row">'
      +   '<button class="btn btn-primary btn-sm" id="btn-save-person">保存する</button>'
      +   '<button class="btn btn-sm" id="btn-cancel-edit">やめる</button>'
      + "</div>";
  }

  function wireDetail(p) {
    const edit = $("btn-edit");
    if (edit) edit.addEventListener("click", function () {
      detail.editing = !detail.editing;
      detail.message = "";
      renderDetail();
    });

    const cancel = $("btn-cancel-edit");
    if (cancel) cancel.addEventListener("click", function () {
      detail.editing = false; renderDetail();
    });

    const save = $("btn-save-person");
    if (save) save.addEventListener("click", function () {
      const fields = {};
      EDIT_FIELDS.forEach(function (f) {
        const el = $("ed-" + f.key);
        if (el) fields[f.key] = el.value;
      });
      const r = Storage.updatePerson(p.id, fields);
      if (!r.ok) { detail.message = r.error; renderDetail(); return; }
      detail.editing = false;
      detail.message = "";
      renderDetail();
    });

    // 専門分野の追加
    const addTopic = $("btn-add-topic");
    if (addTopic) addTopic.addEventListener("click", function () {
      const name = $("new-topic").value;
      const src = $("new-topic-src").value;
      const r = Storage.addTopicTo(p.id, name, src);
      detail.message = r.ok ? "" : (r.error || "");
      renderDetail();
    });
    const topicInput = $("new-topic");
    if (topicInput) topicInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); $("btn-add-topic").click(); }
    });

    // 交流の記録
    const addLog = $("btn-add-log");
    if (addLog) addLog.addEventListener("click", function () {
      const r = Storage.addInteraction(p.id, {
        occurred_at: $("log-date").value,
        event_name: $("log-event").value,
        location: $("log-place").value,
        summary: $("log-note").value,
      });
      detail.message = r.ok ? "" : (r.error || "");
      renderDetail();
    });

    const del = $("btn-del-person");
    if (del) del.addEventListener("click", function () {
      if (!confirm(p.name + " を削除します。元に戻せません。")) return;
      Storage.deletePerson(p.id);
      UI.show("people");
    });
  }

  /* 専門分野と交流記録の「削除」は、押される場所が描き直しのたびに変わる。
     そのため、外側の入れ物に1回だけ見張りを付けておく。
     （描き直すたびに付けると、見張りが積み重なってしまう） */
  document.addEventListener("DOMContentLoaded", bindDelegated);
  if (document.readyState !== "loading") bindDelegated();

  let bound = false;
  function bindDelegated() {
    if (bound) return;
    const box = $("person-body");
    if (!box) return;
    bound = true;
    box.addEventListener("click", function (e) {
      const t = e.target.closest("[data-del-topic]");
      if (t) { Storage.removeTopicFrom(detail.id, t.dataset.delTopic); renderDetail(); return; }

      const l = e.target.closest("[data-del-log]");
      if (l) { Storage.removeInteraction(l.dataset.delLog); renderDetail(); return; }
    });
  }


  return { renderList: renderList, renderDetail: renderDetail };
})();
