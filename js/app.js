/* =============================================================================
   画面の動き（Phase 1.5：複数枚・PDF対応）

     ダッシュボード
       ↓
     名刺登録（画像を何枚でも／PDFも可）
       ↓
     1ページずつ順番にAIが読み取る
       ↓
     確認（複数あれば一覧から選んで1件ずつ直す）
       ↓
     まとめて登録

   Phase 2以降で「人物」「人脈」「AI検索」の画面を足していきます。
   ============================================================================= */

(function () {
  "use strict";

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  const $ = (id) => document.getElementById(id);

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
  let batch = {
    items: [],        // { thumb, label, ai, fields, edited, include }
    selected: 0,
    skipped: 0,       // 名刺が写っていなかったページ数
    failed: [],       // 読み取りに失敗したページ
    stop: false,      // 「中止する」が押されたか
  };

  function resetBatch() {
    batch = { items: [], selected: 0, skipped: 0, failed: [], stop: false };
  }


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

    const persons = Storage.getPersons().slice(-8).reverse();
    $("recent-list").innerHTML = persons.length
      ? persons.map(function (p) {
          const meta = [
            Storage.getOrganizationName(p.organization_id),
            p.department, p.job_title,
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

  /** 選ばれたファイルを読み取る（ここが一括処理の入口） */
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

    // --- 1. ファイルをページの一覧に変換する（PDFはここで画像になる） ---
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
              thumb: page.thumb,
              label: page.label,
              ai: c,                                  // AIが読んだ値。書き換えない
              fields: Object.assign({}, c),           // 編集用
              edited: {},
              include: true,
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
      + '<span>' + (count < 0 ? "失敗" : (count === 0 ? "なし" : count + "枚")) + "</span>";
    $("thumb-strip").appendChild(div);
    $("thumb-strip").scrollLeft = $("thumb-strip").scrollWidth;
  }

  // ファイル選択・カメラ・ドラッグ＆ドロップ
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

    // 読み飛ばした・失敗したページの案内
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
      note.innerHTML = "<b>AIの注記：</b>" + esc(item.ai.notes) +
        '<div class="ai-note-sub">名刺に書かれていた内容のうち、項目に収まらなかったものです。</div>';
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

  // 一覧のクリック（選択の切り替えと、チェックの入り切り）
  $("batch-items").addEventListener("click", function (e) {
    const check = e.target.closest("[data-check]");
    if (check) {
      const i = Number(check.dataset.check);
      batch.items[i].include = check.checked;
      renderBatchList();
      renderLedger();
      return;
    }
    const row = e.target.closest("[data-index]");
    if (row) {
      batch.selected = Number(row.dataset.index);
      renderBatchList();
      renderLedger();
    }
  });

  $("btn-toggle-all").addEventListener("click", function () {
    const allOn = batch.items.every((it) => it.include);
    batch.items.forEach((it) => { it.include = !allOn; });
    renderBatchList();
    renderLedger();
  });

  $("btn-retry").addEventListener("click", () => show("capture"));

  $("btn-register").addEventListener("click", function () {
    const targets = batch.items.filter((it) => it.include);
    if (!targets.length) return;

    // 氏名が空のものがあれば、そこへ案内する
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

    let saved = 0;
    let firstPerson = null;
    let failMessage = "";

    for (const it of targets) {
      const r = Storage.savePerson(it.fields, it.thumb);
      if (r.ok) {
        saved++;
        if (!firstPerson) firstPerson = Storage.getPerson(r.personId);
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

    if (saved === 1 && firstPerson) {
      $("done-name").textContent = firstPerson.name + " さんを登録しました";
      $("done-meta").textContent =
        [Storage.getOrganizationName(firstPerson.organization_id),
         firstPerson.department, firstPerson.job_title]
          .filter(Boolean).join("　／　") || "所属情報なし";
    } else {
      $("done-name").textContent = saved + " 件を登録しました";
      $("done-meta").textContent = failMessage
        ? "途中で保存できなくなりました：" + failMessage
        : "ダッシュボードで一覧を確認できます。";
    }
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
     起動時
     ========================================================================= */

  AI.ping().then(function (r) {
    const el = $("conn");
    el.className = "conn " + (r.ok ? "conn-ok" : "conn-ng");
    el.textContent = (r.ok ? "● " : "▲ ") + r.message;
    if (r.ok && r.multi === false) {
      el.className = "conn conn-warn";
      el.textContent = "▲ Worker が古い版です。worker.js を貼り直してください。";
    }
  });

  show("dashboard");
})();