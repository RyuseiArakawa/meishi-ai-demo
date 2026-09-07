/* 版の番号。index.html と照らし合わせて、古いファイルが残っていないか確かめます。 */
(window.APP_BUILD = window.APP_BUILD || {})["people"] = 12;

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

     大事な点：
       検索欄そのものは、画面に入ったときに一度だけ作ります。
       文字を打つたびに作り直すと、日本語入力の変換が途中で中断されてしまい、
       ローマ字のまま確定できなくなるためです。
       打っている間に描き直すのは、下の一覧だけにします。
     ========================================================================= */

  /** 画面に入ったとき。検索欄を組み立ててから一覧を描く */
  function enter() {
    renderControls();
    renderList();
  }

  function renderControls() {
    const orgs = Storage.getOrganizations();

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
      +   '<option value="name"' + (filter.sort === "name" ? " selected" : "") + ">氏名順（ふりがな優先）</option>"
      +   '<option value="new"'  + (filter.sort === "new"  ? " selected" : "") + ">登録の新しい順</option>"
      +   '<option value="org"'  + (filter.sort === "org"  ? " selected" : "") + ">組織ごと</option>"
      + "</select>";

    const q = $("pq");

    // 日本語入力の変換中は検索しない。
    // compositionstart で変換開始、compositionend で確定が伝わる。
    let composing = false;
    q.addEventListener("compositionstart", function () { composing = true; });
    q.addEventListener("compositionend", function () {
      composing = false;
      filter.query = q.value;
      renderList();
    });
    q.addEventListener("input", function () {
      if (composing) return;          // 変換の途中なので、まだ検索しない
      filter.query = q.value;
      renderList();
    });

    $("porg").addEventListener("change", function () {
      filter.orgId = this.value; renderList();
    });
    $("psort").addEventListener("change", function () {
      filter.sort = this.value; renderList();
    });
  }

  /** 一覧だけを描き直す（検索欄には触らない） */
  function renderList() {
    const all = Storage.getPersons();
    const list = Storage.searchPersons(filter.query, filter.orgId, filter.sort);

    $("people-count").textContent = all.length
      ? list.length + " 件を表示（登録 " + all.length + " 件）"
      : "";

    // ふりがな順を選んでいるのに、ふりがなが入っていない人がいる場合の説明
    const noKana = Storage.countWithoutKana(list);
    const hint = $("people-hint");
    if (filter.sort === "name" && noKana > 0) {
      hint.hidden = false;
      hint.textContent =
        "ふりがなが未登録の人物が " + noKana + " 件あります。"
        + "その人たちは漢字の並びで表示しています。"
        + "人物の画面で「編集する」からふりがなを入れると、読みの順に並びます。";
    } else {
      hint.hidden = true;
    }

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
      const clear = $("btn-clear-filter");
      if (clear) clear.addEventListener("click", function () {
        filter = { query: "", orgId: "", sort: filter.sort };
        enter();
      });
    } else {
      $("people-list").innerHTML = list.map(rowHtml).join("");
    }
  }

  function rowHtml(p) {
    const card = Storage.getCardOf(p.id);
    const topics = Storage.getTopicsOf(p.id);
    const meta = [
      Storage.getOrganizationName(p.organization_id),
      p.department, p.job_title,
    ].filter(Boolean).join("　／　");

    const thumb = card
      ? (card.image_path || (window.Remote && Remote.cachedImage(card.image_file_id)))
      : null;

    return '<button class="prow" data-screen="person" data-id="' + p.id + '">'
      + (thumb
          ? '<img class="prow-thumb" src="' + thumb + '" alt="">'
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


  /* =========================================================================
     人物詳細
     ========================================================================= */

  /* --- 人物同士の関係（Phase 3） ----------------------------------------- */

  // 強さの目安。数字だけでは意味が伝わらないため、言葉を添える。
  const STRENGTH_LABEL = {
    1: "1　一度会っただけ",
    2: "2　同じ場に居合わせた程度",
    3: "3　仕事のやりとりがある",
    4: "4　継続的に協力している",
    5: "5　日常的にやりとりがある",
  };

  function strengthDots(n) {
    const s = Math.max(0, Math.min(5, Number(n) || 0));
    return '<span class="dots" title="強さ ' + s + ' / 5">'
      + "●".repeat(s) + '<span class="dots-off">' + "●".repeat(5 - s) + "</span></span>";
  }

  function relationsHtml(p, rels) {
    if (!rels.length) return '<p class="empty" style="margin-bottom:14px">まだ登録されていません。</p>';

    return '<ul class="rel-list">' + rels.map(function (r) {
      const other = Storage.getPerson(r.other_id);
      const otherName = other ? other.name : "（削除された人物）";
      const otherOrg = other ? Storage.getOrganizationName(other.organization_id) : "";
      const directed = Storage.isDirected(r.relationship_type);

      // 向きに意味がある種類だけ、どちらが起点かを示す
      const arrow = directed
        ? '<span class="rel-arrow">' +
            (r.direction === "out"
              ? esc(p.name) + " → " + esc(otherName)
              : esc(otherName) + " → " + esc(p.name)) +
          "</span>"
        : "";

      return "<li>"
        + '<div class="rel-main">'
        +   '<span class="rel-type">' + esc(Storage.relationshipLabel(r.relationship_type)) + "</span>"
        +   '<button class="rel-name" data-screen="person" data-id="' + r.other_id + '">'
        +     esc(otherName) + "</button>"
        +   (otherOrg ? '<span class="rel-org">' + esc(otherOrg) + "</span>" : "")
        +   strengthDots(r.strength)
        + "</div>"
        + arrow
        + '<div class="rel-src">根拠：' + esc(r.source || "（未記入）")
        +   (r.notes ? "　／　" + esc(r.notes) : "") + "</div>"
        + '<div class="rel-actions">'
        +   (directed
              ? '<button class="linkbtn" data-flip-rel="' + r.id + '">向きを入れ替える</button>'
              : "")
        +   '<button class="linkbtn" data-del-rel="' + r.id + '">削除</button>'
        + "</div>"
        + "</li>";
    }).join("") + "</ul>";
  }

  function relationFormHtml(p) {
    // すでに関係を登録した相手は、選択肢から外す
    const linked = new Set(Storage.getRelationshipsOf(p.id).map((r) => r.other_id));
    const others = Storage.searchPersons("", "", "name").filter((x) => x.id !== p.id);

    if (!others.length) {
      return '<p class="note">関係を登録するには、相手も登録されている必要があります。</p>';
    }

    return '<div class="rel-form">'
      + '<div class="rel-form-row">'
      +   '<label for="rel-other">相手</label>'
      +   '<select id="rel-other">'
      +     '<option value="">選んでください</option>'
      +     others.map(function (x) {
            const org = Storage.getOrganizationName(x.organization_id);
            return '<option value="' + x.id + '">' + esc(x.name)
              + (org ? "（" + esc(org) + "）" : "")
              + (linked.has(x.id) ? "　※登録済みの関係あり" : "") + "</option>";
          }).join("")
      +   "</select>"
      + "</div>"
      + '<div class="rel-form-row">'
      +   '<label for="rel-type">種類</label>'
      +   '<select id="rel-type">'
      +     '<option value="">選んでください</option>'
      +     Storage.RELATIONSHIP_TYPES.map((t) =>
            '<option value="' + t.value + '">' + esc(t.label)
            + (t.directed ? "（向きあり）" : "") + "</option>").join("")
      +   "</select>"
      + "</div>"
      + '<div class="rel-form-row">'
      +   '<label for="rel-strength">強さ</label>'
      +   '<select id="rel-strength">'
      +     '<option value="">選んでください</option>'
      +     [1, 2, 3, 4, 5].map((n) =>
            '<option value="' + n + '">' + esc(STRENGTH_LABEL[n]) + "</option>").join("")
      +   "</select>"
      + "</div>"
      + '<div class="rel-form-row">'
      +   '<label for="rel-source">根拠</label>'
      +   '<input type="text" id="rel-source" list="rel-source-list"'
      +     ' placeholder="例：共著論文（2026）／本人から聞いた">'
      +   '<datalist id="rel-source-list">'
      +     ["本人から聞いた", "共著論文", "同じ組織の名刺", "名刺交換した",
             "展示会で聞いた", "紹介を受けた", "学会で同席した"]
            .map((v) => '<option value="' + v + '">').join("")
      +   "</datalist>"
      + "</div>"
      + '<div class="rel-form-row">'
      +   '<label for="rel-notes">備考</label>'
      +   '<input type="text" id="rel-notes" placeholder="任意">'
      + "</div>"
      + '<div class="btn-row" style="margin-top:6px">'
      +   '<button class="btn btn-sm" id="btn-add-rel">関係を登録する</button>'
      + "</div>"
      + '<p class="note lines" style="margin-top:8px">'
      +   "<span>強さと根拠は、必ず入力してください。</span>"
      +   "<span>この2つが無いと、AIチャットで「なぜこの人を挙げたか」を示せなくなります。</span>"
      + "</p>"
      + "</div>";
  }

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
    const owner = Storage.getCardOwner(p.id);
    const knows = Storage.getUsersWhoKnow(p.id);
    const org = Storage.getOrganizationName(p.organization_id);
    const topics = Storage.getTopicsOf(p.id);
    const logs = Storage.getInteractionsOf(p.id);
    const rels = Storage.getRelationshipsOf(p.id);
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

      + (knows.length
        ? '<div class="knows-bar">'
          + "<span>社内でこの人と接点がある人</span>"
          + knows.map((u) => '<span class="knows-chip">' + esc(u.name) + "</span>").join("")
          + "</div>"
        : "")

      + '<div class="pdetail-grid">'

      /* ---- 左：基本情報 ---- */
      +   '<section class="block">'
      +     "<h3>名刺に記載されていた情報</h3>"
      +     (detail.editing ? editFormHtml(p, org) : readOnlyHtml(p))
      +   "</section>"

      /* ---- 右：名刺画像 ---- */
      +   "<div>"
      +     cardImageHtml(card, p)
      +     '<p class="note" style="margin-top:8px">登録日：'
            + esc(String(p.created_at || "").slice(0, 10))
            + (owner ? "　／　登録した人：" + esc(owner.name) : "") + "</p>"
      +   "</div>"
      + "</div>"

      /* ---- 専門分野 ---- */
      + '<section class="block">'
      +   "<h3>専門・技術</h3>"
      +   '<p class="note lines" style="margin:-6px 0 12px">'
      +     "<span>名刺には書かれていない情報です。</span>"
      +     "<span>会って話した内容や、論文などで確認したことを入力してください。</span>"
      +     "<span>AIには推測させません。</span>"
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

      /* ---- 人物同士の関係（Phase 3） ---- */
      + '<section class="block">'
      +   "<h3>人物同士の関係</h3>"
      +   '<p class="note lines" style="margin:-6px 0 12px">'
      +     "<span>実際にあったつながりだけを登録します。</span>"
      +     "<span>同じ組織にいることや同じ学会に出たことから、システムが関係を作ることはありません。</span>"
      +     "<span>強さと根拠も、人が入力します。</span>"
      +   "</p>"
      +   relationsHtml(p, rels)
      +   relationFormHtml(p)
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
          + '<p class="note lines" style="margin:-6px 0 12px">'
          +   "<span>同じ組織に所属している、という事実だけを示しています。</span>"
          +   "<span>実際につながりがあるかどうかは、上の「人物同士の関係」で登録してください。</span>"
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
      +   '<p class="note lines" style="margin:-6px 0 10px">'
      +     "<span>名刺画像・専門分野・交流の記録も、あわせて消えます。</span>"
      +     "<span>取り消せません。</span>"
      +   "</p>"
      +   '<button class="btn btn-danger btn-sm" id="btn-del-person">削除する</button>'
      + "</section>";

    wireDetail(p);
  }

  /**
   * 名刺画像の表示。
   * 共有データベースを使っているときは画像がドライブにあるため、
   * この画面を開いたときに取り出します（一覧では取りに行きません）。
   */
  function cardImageHtml(card, p) {
    if (!card) return '<div class="noimg-box">名刺画像はありません</div>';

    const ready = card.image_path
      || (window.Remote && Remote.cachedImage(card.image_file_id));

    if (ready) {
      return '<img class="cardshot" id="card-img" src="' + ready + '" alt="'
        + esc(p.name) + 'さんの名刺">';
    }
    if (card.image_file_id && window.Remote) {
      // 先に枠だけ出して、あとから差し替える
      setTimeout(function () {
        Remote.getImage(card.image_file_id).then(function (dataUrl) {
          const el = $("card-img-box");
          if (el && dataUrl) {
            el.outerHTML = '<img class="cardshot" src="' + dataUrl + '" alt="">';
          } else if (el) {
            el.textContent = "名刺画像を取り出せませんでした";
          }
        });
      }, 0);
      return '<div class="noimg-box" id="card-img-box">名刺画像を読み込んでいます…</div>';
    }
    return '<div class="noimg-box">名刺画像はありません</div>';
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

    // 関係の登録
    const addRel = $("btn-add-rel");
    if (addRel) addRel.addEventListener("click", function () {
      const r = Storage.addRelationship(
        p.id,
        $("rel-other").value,
        $("rel-type").value,
        $("rel-strength").value,
        $("rel-source").value,
        $("rel-notes").value
      );
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

      const rd = e.target.closest("[data-del-rel]");
      if (rd) { Storage.removeRelationship(rd.dataset.delRel); renderDetail(); return; }

      const rf = e.target.closest("[data-flip-rel]");
      if (rf) { Storage.flipRelationship(rf.dataset.flipRel); renderDetail(); return; }
    });
  }


  return { enter: enter, renderList: renderList, renderDetail: renderDetail };
})();