/* =============================================================================
   画面の動き（Phase 2）

     ダッシュボード
     名刺登録  … 画像を何枚でも／PDFも可 → 順番にAIが読み取る → 確認 → 登録
     人物一覧  … 検索・絞り込み            （js/people.js が担当）
     人物詳細  … 編集・専門分野・交流の記録（js/people.js が担当）

   このファイルは、画面の切り替えと「名刺登録」を担当します。
   人物まわりの表示は js/people.js に分けてあります。
   ============================================================================= */

(function () {
  "use strict";

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  const $ = (id) => document.getElementById(id);

  // people.js からも使えるように、共通の道具を外に出しておく
  window.UI = { esc: esc, $: $, show: show };

  const FIELDS = [
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

  /* --- 読み取り中・確認中の状態 ------------------------------------------ */
  let batch = { items: [], selected: 0, skipped: 0, failed: [], stop: false };
  function resetBatch() {
    batch = { items: [], selected: 0, skipped: 0, failed: [], stop: false };
  }


  /* =========================================================================
     画面の切り替え
     ========================================================================= */

  const SCREENS = ["dashboard", "capture", "confirm", "done", "people", "person", "graph"];

  function show(name, id) {
    SCREENS.forEach(function (s) {
      const el = $("screen-" + s);
      if (el) el.hidden = (s !== name);
    });

    // サイドバーの現在地。人物詳細のときも「人物」を光らせる
    const navKey = (name === "person") ? "people" : name;
    document.querySelectorAll(".nav-item").forEach(function (b) {
      b.classList.toggle("is-active", b.dataset.screen === navKey);
    });

    if (name === "dashboard") renderDashboard();
    if (name === "capture") resetCapture();
    if (name === "people") People.enter();
    if (name === "person") People.renderDetail(id);
    if (name === "graph") Graph.enter();

    window.scrollTo(0, 0);
  }

  document.addEventListener("click", function (e) {
    const el = e.target.closest("[data-screen]");
    if (el && !el.disabled) show(el.dataset.screen, el.dataset.id);
  });


  /* =========================================================================
     ダッシュボード
     ========================================================================= */

  function renderDashboard() {
    const s = Storage.getStats();
    $("stat-persons").textContent = s.persons;
    $("stat-orgs").textContent = s.organizations;
    $("stat-topics").textContent = s.topics;
    $("stat-relations").textContent = s.relationships;
    $("stat-cards").textContent = s.cards;
    $("stat-size").innerHTML = (s.bytes / 1024 / 1024).toFixed(2) + "<i>MB</i>";

    const warn = $("storage-warning");
    if (!Storage.isPersistent) {
      warn.hidden = false;
      warn.textContent =
        "このブラウザでは保存機能が使えないため、タブを閉じるとデータが消えます。" +
        "プライベートモードを解除するか、別のブラウザで開いてください。";
    } else if (s.bytes > 4 * 1024 * 1024) {
      warn.hidden = false;
      warn.textContent =
        "保存容量の上限（約5MB）に近づいています。JSONで書き出してバックアップを取り、" +
        "不要なデータを削除してください。";
    } else {
      warn.hidden = true;
    }

    const persons = Storage.searchPersons("", "", "new").slice(0, 6);
    $("recent-list").innerHTML = persons.length
      ? persons.map(function (p) {
          const meta = [
            Storage.getOrganizationName(p.organization_id),
            p.department, p.job_title,
          ].filter(Boolean).join("　／　");
          return '<button class="person-row" data-screen="person" data-id="' + p.id + '">'
            + '<span class="person-name">' + esc(p.name) + "</span>"
            + (p.name_kana ? '<span class="person-kana">' + esc(p.name_kana) + "</span>" : "")
            + '<span class="person-meta">' + esc(meta || "所属情報なし") + "</span>"
            + "</button>";
        }).join("")
        + '<div class="btn-row"><button class="btn btn-sm" data-screen="people">'
        + "人物一覧をひらく</button></div>"
      : '<p class="empty">まだ登録がありません。「名刺登録」から始めてください。</p>';
  }


  /* =========================================================================
     名刺登録
     ========================================================================= */

  function resetCapture() {
    resetBatch();
    $("capture-error").hidden = true;
    $("dropzone").hidden = false;
    $("capture-buttons").hidden = false;
    $("capture-note").hidden = false;
    $("reading").hidden = true;
    $("thumb-strip").innerHTML = "";
    $("file-input").value = "";
    $("camera-input").value = "";
  }

  function captureError(message) {
    const box = $("capture-error");
    box.textContent = message;
    box.hidden = false;
    $("dropzone").hidden = false;
    $("capture-buttons").hidden = false;
    $("capture-note").hidden = false;
    $("reading").hidden = true;
  }

  function setProgress(text, done, total) {
    $("progress-text").textContent = text;
    if (typeof done === "number" && total > 0) {
      $("progress-bar").style.width = Math.round((done / total) * 100) + "%";
    }
  }

  async function handleFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;

    resetBatch();
    $("capture-error").hidden = true;
    $("dropzone").hidden = true;
    $("capture-buttons").hidden = true;
    $("capture-note").hidden = true;
    $("reading").hidden = false;
    $("thumb-strip").innerHTML = "";
    $("progress-bar").style.width = "0%";
    $("progress-detail").textContent = "";
    setProgress("画像を準備しています…");

    // --- 1. ファイルをページの一覧に変換（PDFはここで画像になる） ---
    let pages;
    try {
      pages = await AI.filesToPages(files, function (msg) { setProgress(msg); });
    } catch (err) {
      captureError(err.message);
      return;
    }
    if (!pages.length) {
      captureError("読み取れる画像がありませんでした。画像またはPDFを選んでください。");
      return;
    }

    // --- 2. 1ページずつ読み取る ---
    let done = 0;
    setProgress("読み取っています（0 / " + pages.length + "）", 0, pages.length);

    await AI.readPages(
      pages,
      function (i, cards, page) {                    // 成功
        done++;
        if (batch.stop) return;
        if (!cards.length) {
          batch.skipped++;
        } else {
          cards.forEach(function (c) {
            batch.items.push({
              thumb: page.thumb, label: page.label,
              ai: c,                                  // AIが読んだ値。書き換えない
              fields: Object.assign({}, c),           // 編集用
              edited: {}, include: true,
            });
          });
        }
        addThumb(page.thumb, cards.length);
        setProgress("読み取っています（" + done + " / " + pages.length + "）", done, pages.length);
      },
      function (i, message, page) {                   // 失敗
        done++;
        batch.failed.push({ label: page.label, message: message });
        addThumb(page.thumb, -1);
        setProgress("読み取っています（" + done + " / " + pages.length + "）", done, pages.length);
        $("progress-detail").textContent = "一部のページで失敗しました：" + message;
      }
    );

    // --- 3. 結果へ ---
    if (!batch.items.length) {
      let msg = "名刺を読み取れませんでした。";
      if (batch.failed.length) msg += "　" + batch.failed[0].message;
      else if (batch.skipped) msg += "　" + batch.skipped + "ページを調べましたが、名刺が見つかりませんでした。";
      captureError(msg);
      return;
    }

    batch.selected = 0;
    renderConfirm();
    show("confirm");
  }

  function addThumb(src, count) {
    const div = document.createElement("div");
    div.className = "thumb" + (count === 0 ? " is-blank" : (count < 0 ? " is-failed" : ""));
    div.innerHTML = '<img src="' + src + '" alt="">'
      + "<span>" + (count < 0 ? "失敗" : (count === 0 ? "なし" : count + "枚")) + "</span>";
    $("thumb-strip").appendChild(div);
    $("thumb-strip").scrollLeft = $("thumb-strip").scrollWidth;
  }

  $("file-input").addEventListener("change", (e) => handleFiles(e.target.files));
  $("camera-input").addEventListener("change", (e) => handleFiles(e.target.files));
  $("btn-pick").addEventListener("click", () => $("file-input").click());
  $("btn-camera").addEventListener("click", () => $("camera-input").click());
  $("btn-stop").addEventListener("click", function () {
    batch.stop = true;
    setProgress("中止しています…");
  });

  const dz = $("dropzone");
  dz.addEventListener("click", () => $("file-input").click());
  dz.addEventListener("keydown", function (e) {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("file-input").click(); }
  });
  dz.addEventListener("dragover", function (e) { e.preventDefault(); dz.classList.add("is-drag"); });
  dz.addEventListener("dragleave", () => dz.classList.remove("is-drag"));
  dz.addEventListener("drop", function (e) {
    e.preventDefault();
    dz.classList.remove("is-drag");
    handleFiles(e.dataTransfer.files);
  });


  /* =========================================================================
     確認画面

     「AIが読んだ値」と「人が直した値」を見分けられるようにしています。
     設計書§6-8「事実とAIによる推論を分離する」を、画面の上でも守るためです。
     ========================================================================= */

  function renderConfirm() {
    const multi = batch.items.length > 1;
    $("confirm-layout").classList.toggle("is-batch", multi);
    $("batch-list").hidden = !multi;

    $("confirm-lede").textContent = multi
      ? "左の一覧から1件ずつ選んで、内容を確認してください。チェックを外した名刺は登録されません。"
      : "AIが読み取った内容です。誤りを直してから登録してください。";

    const notes = [];
    if (batch.skipped) notes.push("名刺が写っていなかったページ " + batch.skipped + "件は飛ばしました。");
    if (batch.failed.length) notes.push("読み取りに失敗したページが " + batch.failed.length + "件あります。");
    const skip = $("skip-notice");
    skip.hidden = notes.length === 0;
    skip.textContent = notes.join("　");

    if (multi) renderBatchList();
    renderLedger();
  }

  function renderBatchList() {
    const chosen = batch.items.filter((it) => it.include).length;
    $("batch-count").textContent = batch.items.length + "件中 " + chosen + "件を登録";
    $("btn-toggle-all").textContent = chosen === batch.items.length ? "すべて外す" : "すべて選ぶ";

    $("batch-items").innerHTML = batch.items.map(function (it, i) {
      const org = it.fields.organization || "";
      return '<div class="bitem' + (i === batch.selected ? " is-current" : "") + '" data-index="' + i + '">'
        + '<input type="checkbox" class="bcheck" data-check="' + i + '"'
        + (it.include ? " checked" : "") + ' aria-label="登録する">'
        + '<img src="' + it.thumb + '" alt="">'
        + '<div class="binfo">'
        +   '<div class="bname">' + esc(it.fields.name || "（氏名なし）") + "</div>"
        +   '<div class="borg">' + esc(org || it.label) + "</div>"
        + "</div></div>";
    }).join("");
  }

  function renderLedger() {
    const item = batch.items[batch.selected];
    if (!item) return;

    $("confirm-preview").src = item.thumb;
    $("confirm-error").hidden = true;

    $("ledger").innerHTML = FIELDS.map(function (f) {
      const value = item.fields[f.key] || "";
      const state = item.edited[f.key] ? "human" : (value ? "ai" : "none");
      const mark = state === "human" ? "修正" : (state === "ai" ? "AI" : "―");
      return '<div class="lrow">'
        + '<label for="fld-' + f.key + '">' + f.label + "</label>"
        + '<input type="text" id="fld-' + f.key + '" data-key="' + f.key + '"'
        + (f.key === "name" ? ' class="is-name"' : "")
        + ' value="' + esc(value) + '">'
        + '<span class="src" id="src-' + f.key + '" data-src="' + state + '">' + mark + "</span>"
        + "</div>";
    }).join("");

    $("ledger").querySelectorAll("input[data-key]").forEach(function (input) {
      input.addEventListener("input", function () {
        const key = input.dataset.key;
        item.fields[key] = input.value;
        const original = item.ai[key] || "";
        const changed = input.value.trim() !== original;
        item.edited[key] = changed;

        const badge = $("src-" + key);
        const state = changed ? "human" : (input.value.trim() ? "ai" : "none");
        badge.dataset.src = state;
        badge.textContent = state === "human" ? "修正" : (state === "ai" ? "AI" : "―");

        if (key === "name" || key === "organization") {
          if (batch.items.length > 1) renderBatchList();
          checkDuplicate();
        }
      });
    });

    const note = $("ai-note");
    if (item.ai.notes) {
      note.hidden = false;
      note.innerHTML = "<b>AIの注記：</b>" + esc(item.ai.notes)
        + '<div class="ai-note-sub">名刺に書かれていた内容のうち、項目に収まらなかったものです。</div>';
    } else {
      note.hidden = true;
    }

    const chosen = batch.items.filter((it) => it.include).length;
    $("btn-register").textContent = batch.items.length > 1
      ? "選んだ " + chosen + " 件を登録する"
      : "この内容で登録する";
    $("btn-register").disabled = chosen === 0;

    checkDuplicate();
  }

  function checkDuplicate() {
    const item = batch.items[batch.selected];
    const warn = $("dup-warning");
    if (!item) { warn.hidden = true; return; }

    const dup = Storage.findByName(item.fields.name);
    if (dup.length) {
      const where = dup
        .map((p) => Storage.getOrganizationName(p.organization_id) || "所属なし")
        .join("／");
      warn.hidden = false;
      warn.textContent =
        "同じ氏名の人物が " + dup.length + " 件すでに登録されています（" + where + "）。"
        + "別の方であれば、そのまま登録して構いません。";
    } else {
      warn.hidden = true;
    }
  }

  $("batch-items").addEventListener("click", function (e) {
    const check = e.target.closest("[data-check]");
    if (check) {
      batch.items[Number(check.dataset.check)].include = check.checked;
      renderBatchList(); renderLedger();
      return;
    }
    const row = e.target.closest("[data-index]");
    if (row) {
      batch.selected = Number(row.dataset.index);
      renderBatchList(); renderLedger();
    }
  });

  $("btn-toggle-all").addEventListener("click", function () {
    const allOn = batch.items.every((it) => it.include);
    batch.items.forEach((it) => { it.include = !allOn; });
    renderBatchList(); renderLedger();
  });

  $("btn-retry").addEventListener("click", () => show("capture"));

  $("btn-register").addEventListener("click", function () {
    const targets = batch.items.filter((it) => it.include);
    if (!targets.length) return;

    const emptyIndex = batch.items.findIndex(
      (it) => it.include && !String(it.fields.name || "").trim()
    );
    if (emptyIndex >= 0) {
      batch.selected = emptyIndex;
      if (batch.items.length > 1) renderBatchList();
      renderLedger();
      const box = $("confirm-error");
      box.textContent = "氏名が空の名刺があります。入力するか、チェックを外してください。";
      box.hidden = false;
      $("fld-name").focus();
      return;
    }

    let saved = 0, firstId = "", firstPerson = null, failMessage = "";
    for (const it of targets) {
      const r = Storage.savePerson(it.fields, it.thumb);
      if (r.ok) {
        saved++;
        if (!firstId) { firstId = r.personId; firstPerson = Storage.getPerson(r.personId); }
      } else {
        failMessage = r.error || "保存できませんでした。";
        break;
      }
    }

    if (!saved) {
      const box = $("confirm-error");
      box.textContent = failMessage || "保存できませんでした。";
      box.hidden = false;
      return;
    }

    // 1件だけなら、その人物の画面へ直接進める
    if (saved === 1 && firstId) {
      resetBatch();
      show("person", firstId);
      return;
    }

    $("done-name").textContent = saved + " 件を登録しました";
    $("done-meta").textContent = failMessage
      ? "途中で保存できなくなりました：" + failMessage
      : "人物一覧から、専門分野や交流の記録を追加できます。";
    resetBatch();
    show("done");
  });


  /* =========================================================================
     データの書き出し・読み込み・削除
     ========================================================================= */

  $("btn-export").addEventListener("click", function () {
    const blob = new Blob([Storage.exportJSON()], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "organization-knowledge-" + new Date().toISOString().slice(0, 10) + ".json";
    a.click();
    URL.revokeObjectURL(a.href);
  });

  $("btn-import").addEventListener("click", () => $("import-file").click());

  $("import-file").addEventListener("change", function (e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function () {
      const r = Storage.importJSON(reader.result);
      if (!r.ok) { alert(r.error || "読み込めませんでした。"); }
      else if (r.shared) {
        alert("読み込みました。スプレッドシートへ順に送っています。"
            + "左下の表示が「同期済み」になるまでお待ちください。");
      } else {
        alert("読み込みました。");
      }
      renderDashboard();
      renderUserBar();
    };
    reader.readAsText(file);
    e.target.value = "";
  });

  $("btn-clear").addEventListener("click", function () {
    if (!confirm("登録したデータをすべて削除します。元に戻せません。")) return;
    Storage.clearAll();
    renderDashboard();
  });


  /* =========================================================================
     利用者（誰として使うか）
     ========================================================================= */

  function renderUserBar() {
    const me = Storage.getCurrentUser();
    $("userbar").innerHTML = me
      ? '<div class="ub-name">' + esc(me.name) + "</div>"
        + '<button class="linkbtn" id="ub-switch">切り替える</button>'
      : '<button class="btn btn-sm" id="ub-pick">利用者を選ぶ</button>';

    const sw = $("ub-switch"); if (sw) sw.addEventListener("click", openUserPicker);
    const pk = $("ub-pick");   if (pk) pk.addEventListener("click", openUserPicker);
  }

  function openUserPicker() {
    const users = Storage.getUsers();
    const me = Storage.getCurrentUserId();

    $("user-dialog-body").innerHTML =
        "<h2>あなたは誰ですか</h2>"
      + '<p class="note">名刺を登録した人を記録します。'
      + "人脈グラフで「この人と接点があるのは社内の誰か」を出すために使います。</p>"
      + (users.length
        ? '<div class="user-list">' + users.map((u) =>
            '<button class="user-pick' + (u.id === me ? " is-me" : "") + '" data-user="'
            + u.id + '">' + esc(u.name)
            + (u.note ? '<span>' + esc(u.note) + "</span>" : "") + "</button>").join("")
          + "</div>"
        : '<p class="empty">まだ誰も登録されていません。</p>')
      + '<div class="user-add">'
      +   '<label for="new-user">一覧にない場合</label>'
      +   '<div class="addrow">'
      +     '<input type="text" id="new-user" placeholder="氏名">'
      +     '<input type="text" id="new-user-note" placeholder="所属（任意）">'
      +     '<button class="btn btn-sm" id="btn-add-user">登録して選ぶ</button>'
      +   "</div>"
      + "</div>"
      + '<p class="note" style="margin-top:14px">'
      +   "これは認証ではありません。誰として使うかを自分で選ぶ仕組みです。"
      +   "実際の運用では、ログインの仕組みが必要です。</p>"
      + '<div class="btn-row"><button class="btn btn-sm" id="btn-close-user">閉じる</button></div>';

    $("user-dialog").hidden = false;

    $("user-dialog-body").querySelectorAll("[data-user]").forEach(function (b) {
      b.addEventListener("click", function () {
        Storage.setCurrentUser(b.dataset.user);
        $("user-dialog").hidden = true;
        renderUserBar();
        renderDashboard();
      });
    });

    $("btn-add-user").addEventListener("click", function () {
      const r = Storage.addUser($("new-user").value, "", $("new-user-note").value);
      if (!r.ok && r.error) { alert(r.error); return; }
      Storage.setCurrentUser(r.id);
      $("user-dialog").hidden = true;
      renderUserBar();
      renderDashboard();
    });

    $("btn-close-user").addEventListener("click", function () {
      $("user-dialog").hidden = true;
    });
  }


  // 小窓の外側を押しても閉じられるようにする（操作できなくならないように）
  $("user-dialog").addEventListener("click", function (e) {
    if (e.target && e.target.id === "user-dialog") $("user-dialog").hidden = true;
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") $("user-dialog").hidden = true;
  });


  /* =========================================================================
     共有データベースとの同期
     ========================================================================= */

  function renderSyncState(st) {
    const el = $("syncstate");
    if (!Storage.isShared()) {
      el.className = "conn conn-unknown";
      el.textContent = "この端末の中だけに保存中";
      return;
    }
    if (st.sending) {
      el.className = "conn conn-warn";
      el.textContent = "スプレッドシートへ送信中…";
    } else if (st.pending) {
      el.className = "conn conn-warn";
      el.textContent = "未送信 " + st.pending + " 件（自動で送ります）";
    } else if (st.available === false) {
      el.className = "conn conn-ng";
      el.textContent = "▲ 共有できていません：" + (st.error || "");
    } else {
      el.className = "conn conn-ok";
      el.textContent = "● スプレッドシートと同期済み";
    }
  }

  /** スプレッドシートから読み直す */
  async function reload() {
    if (!Storage.isShared()) return;
    const btn = $("btn-reload");
    if (btn) { btn.disabled = true; btn.textContent = "読み込み中…"; }
    try {
      const data = await Remote.fetchAll();
      Storage.applyRemote(data);
      renderDashboard();
      renderUserBar();
    } catch (err) {
      alert("読み込めませんでした：" + err.message);
    }
    if (btn) { btn.disabled = false; btn.textContent = "最新の状態に更新"; }
  }

  const reloadBtn = $("btn-reload");
  if (reloadBtn) reloadBtn.addEventListener("click", reload);

  // 手元のデータを、まとめてスプレッドシートへ送る
  const pushBtn = $("btn-pushall");
  if (pushBtn) pushBtn.addEventListener("click", function () {
    const s = Storage.getStats();
    if (!confirm(
        "手元にあるデータをすべてスプレッドシートへ送ります。\n\n"
      + "人物 " + s.persons + " 名／名刺 " + s.cards + " 枚\n\n"
      + "同じIDの行はスプレッドシート側が書き換わります。\n"
      + "名刺画像はドライブへ送るため、数分かかることがあります。")) return;

    const r = Storage.pushAll();
    if (!r.ok) { alert(r.error); return; }
    alert(r.count + " 行を送信箱に入れました。左下に進み具合が出ます。");
  });


  /* =========================================================================
     起動時
     ========================================================================= */

  // AIチャットは画面ではなく、どの画面からでも開ける小窓にしています
  AIChat.init();
  $("nav-chat").addEventListener("click", AIChat.toggle);
  $("card-chat").addEventListener("click", AIChat.show);

  Remote.onChange(renderSyncState);

  (async function start() {
    show("dashboard");
    renderUserBar();
    renderSyncState(Remote.status());

    // 1. Worker につながるか、共有データベースが使えるかを確かめる
    const r = await AI.ping();
    const el = $("conn");
    el.className = "conn " + (r.ok ? "conn-ok" : "conn-ng");
    el.textContent = (r.ok ? "● " : "▲ ") + r.message;
    if (r.ok && r.multi === false) {
      el.className = "conn conn-warn";
      el.textContent = "▲ Worker が古い版です。worker.js を貼り直してください。";
    }

    if (!r.ok || !r.sharedDb) {
      Storage.enableShared(false);
      renderSyncState(Remote.status());
      renderDashboard();
      return;
    }

    // 2. 共有データベースを使う
    Storage.enableShared(true);
    $("shared-tools").hidden = false;

    // 3. たまっていた未送信分を先に送ってから、最新を読み込む
    await Remote.flush();
    try {
      const data = await Remote.fetchAll();
      Storage.applyRemote(data);
    } catch (err) {
      renderSyncState(Remote.status());
    }

    renderDashboard();
    renderUserBar();

    // 4. まだ誰として使うかが決まっていなければ、選んでもらう
    if (!Storage.getCurrentUser()) openUserPicker();
  })();
})();