/* =============================================================================
   画面の動き（Phase 1）

     ダッシュボード → 名刺登録 → 読み取り → 確認 → 登録完了

   Phase 2以降で「人物」「人脈」「AI検索」の画面を足していきます。
   ============================================================================= */

(function () {
  "use strict";

  /* --- 画面に出す文字をそのまま使うと危ないので、記号を無害化する --------- */
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  const $ = (id) => document.getElementById(id);

  /* --- 確認画面に並べる項目（順番もこのとおり） -------------------------- */
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

  /* --- いま扱っている名刺の状態 ------------------------------------------ */
  let current = {
    imageDataUrl: "",   // 縮小した名刺画像
    aiFields: null,     // AIが読み取った値（元のまま。変更しない）
    fields: null,       // 画面で編集中の値
    edited: {},         // 人が直した項目を覚えておく
  };


  /* =========================================================================
     画面の切り替え
     ========================================================================= */

  function show(name) {
    ["dashboard", "capture", "confirm", "done"].forEach(function (s) {
      const el = $("screen-" + s);
      if (el) el.hidden = (s !== name);
    });

    document.querySelectorAll(".nav-item").forEach(function (b) {
      b.classList.toggle("is-active", b.dataset.screen === name);
    });

    if (name === "dashboard") renderDashboard();
    if (name === "capture") resetCapture();
    window.scrollTo(0, 0);
  }

  document.addEventListener("click", function (e) {
    const el = e.target.closest("[data-screen]");
    if (el && !el.disabled) show(el.dataset.screen);
  });


  /* =========================================================================
     ダッシュボード
     ========================================================================= */

  function renderDashboard() {
    const s = Storage.getStats();
    $("stat-persons").textContent = s.persons;
    $("stat-orgs").textContent = s.organizations;
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

    // 登録済みの人物（新しい順に5件）
    const persons = Storage.getPersons().slice(-5).reverse();
    $("recent-list").innerHTML = persons.length
      ? persons.map(function (p) {
          const meta = [
            Storage.getOrganizationName(p.organization_id),
            p.department,
            p.job_title,
          ].filter(Boolean).join("　／　");
          return '<div class="person-row">'
            + '<div><span class="person-name">' + esc(p.name) + "</span>"
            + (p.name_kana ? '<span class="person-kana">' + esc(p.name_kana) + "</span>" : "")
            + "</div>"
            + '<div class="person-meta">' + esc(meta || "所属情報なし") + "</div>"
            + "</div>";
        }).join("")
      : '<p class="empty">まだ登録がありません。「名刺登録」から始めてください。</p>';
  }


  /* =========================================================================
     名刺登録
     ========================================================================= */

  function resetCapture() {
    current = { imageDataUrl: "", aiFields: null, fields: null, edited: {} };
    $("capture-error").hidden = true;
    $("dropzone").hidden = false;
    $("reading").hidden = true;
    $("file-input").value = "";
  }

  function captureError(message) {
    const box = $("capture-error");
    box.textContent = message;
    box.hidden = false;
    $("dropzone").hidden = false;
    $("reading").hidden = true;
  }

  async function handleFile(file) {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      captureError("画像ファイルを選んでください。");
      return;
    }

    $("capture-error").hidden = true;

    // 1. 画像を縮小する
    try {
      current.imageDataUrl = await AI.shrinkImage(file);
    } catch (err) {
      captureError(err.message);
      return;
    }

    // 2. 読み取り中の表示に切り替える
    $("dropzone").hidden = true;
    $("reading").hidden = false;
    $("reading-preview").src = current.imageDataUrl;

    // 3. Workers経由でAIに読ませる
    try {
      const data = await AI.readBusinessCard(current.imageDataUrl);
      current.aiFields = data;
      current.fields = Object.assign({}, data);
      current.edited = {};
      renderConfirm();
      show("confirm");
    } catch (err) {
      captureError(err.message);
    }
  }

  // ファイル選択
  $("file-input").addEventListener("change", function (e) {
    handleFile(e.target.files[0]);
  });

  // クリック／キーボード／ドラッグ＆ドロップ
  const dz = $("dropzone");
  dz.addEventListener("click", () => $("file-input").click());
  dz.addEventListener("keydown", function (e) {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("file-input").click(); }
  });
  dz.addEventListener("dragover", function (e) { e.preventDefault(); dz.classList.add("is-drag"); });
  dz.addEventListener("dragleave", function () { dz.classList.remove("is-drag"); });
  dz.addEventListener("drop", function (e) {
    e.preventDefault();
    dz.classList.remove("is-drag");
    handleFile(e.dataTransfer.files[0]);
  });


  /* =========================================================================
     読み取り結果の確認

     ここで「AIが読んだ値」と「人が直した値」を見分けられるようにしています。
     設計書§6-8「事実とAIによる推論を分離する」を、画面の上でも守るためです。
     ========================================================================= */

  function renderConfirm() {
    $("confirm-preview").src = current.imageDataUrl;
    $("confirm-error").hidden = true;

    $("ledger").innerHTML = FIELDS.map(function (f) {
      const value = current.fields[f.key] || "";
      const state = current.edited[f.key] ? "human" : (value ? "ai" : "none");
      const mark = state === "human" ? "修正" : (state === "ai" ? "AI" : "―");
      return '<div class="lrow">'
        + '<label for="fld-' + f.key + '">' + f.label + "</label>"
        + '<input type="text" id="fld-' + f.key + '" data-key="' + f.key + '"'
        + (f.key === "name" ? ' class="is-name"' : "")
        + ' value="' + esc(value) + '">'
        + '<span class="src" id="src-' + f.key + '" data-src="' + state + '">' + mark + "</span>"
        + "</div>";
    }).join("");

    // 入力されたら、その項目を「修正」に変える
    $("ledger").querySelectorAll("input[data-key]").forEach(function (input) {
      input.addEventListener("input", function () {
        const key = input.dataset.key;
        current.fields[key] = input.value;

        const original = current.aiFields[key] || "";
        const changed = input.value.trim() !== original;
        current.edited[key] = changed;

        const badge = $("src-" + key);
        const state = changed ? "human" : (input.value.trim() ? "ai" : "none");
        badge.dataset.src = state;
        badge.textContent = state === "human" ? "修正" : (state === "ai" ? "AI" : "―");
      });
    });

    // AIが読み取りに迷った箇所（notes）は、本文とは別枠で表示する
    const note = $("ai-note");
    if (current.aiFields.notes) {
      note.hidden = false;
      note.innerHTML = "<b>AIの注記：</b>" + esc(current.aiFields.notes);
    } else {
      note.hidden = true;
    }

    // 同じ氏名の人がいれば知らせる（勝手に統合はしない）
    const dup = Storage.findByName(current.fields.name);
    const warn = $("dup-warning");
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

  $("btn-retry").addEventListener("click", function () { show("capture"); });

  $("btn-register").addEventListener("click", function () {
    if (!String(current.fields.name || "").trim()) {
      const box = $("confirm-error");
      box.textContent = "氏名が空です。名刺を見て入力してください。";
      box.hidden = false;
      $("fld-name").focus();
      return;
    }

    const result = Storage.savePerson(current.fields, current.imageDataUrl);

    if (!result.ok) {
      const box = $("confirm-error");
      box.textContent = result.error || "保存できませんでした。";
      box.hidden = false;
      return;
    }

    const p = Storage.getPerson(result.personId);
    $("done-name").textContent = p.name + " さんを登録しました";
    $("done-meta").textContent =
      [Storage.getOrganizationName(p.organization_id), p.department, p.job_title]
        .filter(Boolean).join("　／　") || "所属情報なし";
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

  $("btn-import").addEventListener("click", function () { $("import-file").click(); });

  $("import-file").addEventListener("change", function (e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function () {
      const r = Storage.importJSON(reader.result);
      alert(r.ok ? "読み込みました。" : (r.error || "読み込めませんでした。"));
      renderDashboard();
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
     起動時の処理
     ========================================================================= */

  // サイドバーに接続状態を出す（設定が正しいかすぐ分かるように）
  AI.ping().then(function (r) {
    const el = $("conn");
    el.className = "conn " + (r.ok ? "conn-ok" : "conn-ng");
    el.textContent = (r.ok ? "● " : "▲ ") + r.message;
  });

  show("dashboard");
})();
