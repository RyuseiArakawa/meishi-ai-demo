/* 版の番号。index.html と照らし合わせて、古いファイルが残っていないか確かめます。 */
(window.APP_BUILD = window.APP_BUILD || {})["settings"] = 3;

/* =============================================================================
   設定

   これまで、設定はあちこちに散らばっていました。
     ・データの書き出し … ダッシュボード
     ・送信の間隔      … js/config.js（利用者からは触れない）
     ・グラフの見え方   … 画面を開くたびに初期値へ戻る
   ここに集めます。

   保存先はこの端末です。人によって見やすさが違うため、
   組織で共有するものではありません。
   ============================================================================= */

const Settings = (function () {

  const esc = UI.esc;
  const $ = UI.$;

  const KEY = "meishi_settings_v1";

  const DEFAULTS = {
    fontScale: 1,          // 文字の大きさ（0.9 / 1 / 1.15 / 1.3）
    wide: false,           // 画面いっぱいに広げるか
    dark: false,           // 濃い背景
    rememberGraph: true,   // 人脈グラフの設定を覚えるか
    graph: null,           // 覚えた内容
    presenting: false,     // 発表モード（連絡先と名刺画像を伏せる）
    captureLocked: false,  // 名刺の読み取りを止める
    keepImages: false,     // 共有時、名刺画像を端末にも残すか
    restoreScreen: true,   // 最後に見ていた画面で開くか
  };

  let data = load();

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      return Object.assign({}, DEFAULTS, raw ? JSON.parse(raw) : {});
    } catch { return Object.assign({}, DEFAULTS); }
  }

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(data)); } catch (e) {}
  }

  const get = (k) => data[k];

  function set(k, v) {
    data[k] = v;
    save();
    apply();
  }


  /* =========================================================================
     画面に反映する
     ========================================================================= */

  function apply() {
    document.documentElement.style.setProperty("--fs", String(data.fontScale));
    document.body.classList.toggle("width-full", data.wide === true);
    document.body.classList.toggle("theme-dark", data.dark === true);

    // 発表中であることが分かるよう、上に小さく出す
    const tag = $("presenting-tag");
    if (tag) tag.hidden = !data.presenting;
  }

  /* --- 人脈グラフの設定を覚える -------------------------------------------- */

  function saveGraph(state) {
    if (!data.rememberGraph) return;
    data.graph = {
      scope: state.scope, minStrength: state.minStrength,
      showIsolated: state.showIsolated, showUsers: state.showUsers,
      markSole: state.markSole,
      spacing: state.spacing, spacingTouched: state.spacingTouched,
    };
    save();
  }
  const loadGraph = () => (data.rememberGraph ? data.graph : null);


  /* =========================================================================
     設定の画面
     ========================================================================= */

  function enter() { render(); }

  function render() {
    const s = Storage.getStats();

    $("settings-body").innerHTML =

      /* ---- 見え方 ---- */
        block("見え方", [
          choice("文字の大きさ", "fontScale", [
            [0.9, "小"], [1, "標準"], [1.15, "大"], [1.3, "特大"],
          ], "発表で後ろの席から見えないときに大きくします。"),
          choice("内容の幅", "wide", [
            [false, "読みやすい幅で中央に"], [true, "画面に合わせる"],
          ], "広い画面で、余白が気になるときに切り替えます。"),
          toggle("dark", "ダークモード",
            "画面全体を暗い配色にします。暗い部屋での投影や、夜間の作業に向きます。"),
        ])

      /* ---- 人脈グラフ ---- */
      + block("人脈グラフ", [
          toggle("rememberGraph", "表示の設定を覚える",
            "間隔・表示範囲・強調などを、次に開いたときも同じにします。"),
          data.graph
            ? '<div class="set-sub">いま覚えている内容：'
              + esc(describeGraph(data.graph)) + "</div>"
              + '<button class="btn btn-sm" data-act="forget-graph">覚えた内容を消す</button>'
            : '<div class="set-sub">まだ覚えていません。'
              + "人脈の画面で設定を変えると覚えます。</div>",
        ])

      /* ---- 発表・デモ ---- */
      + block("発表・デモ", [
          toggle("presenting", "発表モード",
            "メールアドレス・電話番号・住所と、名刺画像を伏せます。"
            + "実在の名刺が入っていても、画面を見せられるようになります。"),
          toggle("captureLocked", "名刺の読み取りを止める",
            "デモ中に、誤って本物の名刺を登録してしまうのを防ぎます。"),
          '<div class="set-row">'
          +   '<div class="set-label">AIチャットの会話</div>'
          +   '<div class="set-sub">'
          +     "いままでのやりとりを消します。発表の前に整えるときに使います。"
          +   "</div>"
          +   '<div class="btn-row" style="margin-top:6px">'
          +     '<button class="btn btn-sm" data-act="clear-chat">会話を消す</button>'
          +   "</div>"
          + "</div>",
        ])

      /* ---- 動作 ---- */
      + block("動作", [
          toggle("restoreScreen", "最後に見ていた画面で開く",
            "切ると、いつもダッシュボードから始まります。"),
          toggle("keepImages", "名刺画像をこの端末にも残す",
            "共有しているときの設定です。通信が不安定な場所では、"
            + "残しておくと表示が速くなります。"
            + "そのぶん、この端末の保存領域を使います。"),
        ])

      /* ---- データ ---- */
      + block("データ", [
          '<div class="set-sub">'
          +   "人物 " + s.persons + " 名／名刺 " + s.cards + " 枚／"
          +   "この端末の使用量 " + (s.bytes / 1024 / 1024).toFixed(2) + " MB"
          + "</div>",
          '<div class="btn-row" style="margin-top:4px">'
          +   '<button class="btn btn-sm" data-act="export">JSONで書き出す</button>'
          +   '<button class="btn btn-sm" data-act="import">JSONを読み込む</button>'
          +   (Storage.isShared()
              ? '<button class="btn btn-sm" data-act="pushall">手元のデータをすべて送る</button>'
                + '<button class="btn btn-sm" data-act="release">端末の名刺画像を手放す</button>'
              : "")
          + "</div>",
          '<div class="btn-row">'
          +   '<button class="btn btn-sm btn-danger" data-act="wipe">すべて削除</button>'
          + "</div>",
          '<div class="set-sub">'
          +   (Storage.isShared()
              ? "本体はスプレッドシートにあります。「すべて削除」はこの端末の控えとスプレッドシートの両方に及びます。"
              : "保存先はこの端末だけです。削除すると元に戻せません。")
          + "</div>",
        ])

      + block("この端末の設定を戻す", [
          '<button class="btn btn-sm" data-act="reset">設定を初期値に戻す</button>',
          '<div class="set-sub">データは消えません。見え方などの設定だけ戻します。</div>',
        ]);

    wire();
  }

  /* --- 部品 --------------------------------------------------------------- */

  function block(title, rows) {
    return '<section class="block set-block">'
      + "<h3>" + esc(title) + "</h3>"
      + rows.join("")
      + "</section>";
  }

  function choice(label, key, options, note) {
    return '<div class="set-row">'
      + '<div class="set-label">' + esc(label) + "</div>"
      + '<div class="set-choice">'
      +   options.map(function (o) {
            const on = String(data[key]) === String(o[0]);
            return '<button class="set-opt' + (on ? " is-on" : "") + '"'
              + ' data-set="' + key + '" data-val="' + esc(String(o[0])) + '">'
              + esc(o[1]) + "</button>";
          }).join("")
      + "</div>"
      + (note ? '<div class="set-sub">' + esc(note) + "</div>" : "")
      + "</div>";
  }

  function toggle(key, label, note) {
    return '<label class="set-row set-toggle">'
      + '<input type="checkbox" data-toggle="' + key + '"'
      +   (data[key] ? " checked" : "") + ">"
      + "<span>"
      +   '<span class="set-label">' + esc(label) + "</span>"
      +   (note ? '<span class="set-sub">' + esc(note) + "</span>" : "")
      + "</span></label>";
  }

  function describeGraph(g) {
    return [
      g.scope === "mine" ? "自分の名刺だけ" : "組織全体",
      "強さ " + (g.minStrength === 1 ? "すべて" : g.minStrength + " 以上"),
      "間隔 " + Math.round((g.spacing || 1) * 100) + "%",
      g.showUsers ? "社内の利用者あり" : "社内の利用者なし",
      g.markSole ? "接点1人を強調" : "強調なし",
    ].join("／");
  }

  /* --- 操作 --------------------------------------------------------------- */

  function wire() {
    const body = $("settings-body");

    body.querySelectorAll("[data-set]").forEach(function (b) {
      b.addEventListener("click", function () {
        const v = b.dataset.val;
        set(b.dataset.set, v === "true" ? true : v === "false" ? false : Number(v));
        render();
      });
    });

    body.querySelectorAll("[data-toggle]").forEach(function (c) {
      c.addEventListener("change", function () {
        const key = c.dataset.toggle;
        set(key, c.checked);

        // 端末に残さない設定にしたら、いま残っている画像を手放す
        if (key === "keepImages" && !c.checked) Storage.releaseLocalImages();

        render();
        if (typeof onChange === "function") onChange(key);
      });
    });

    body.querySelectorAll("[data-act]").forEach(function (b) {
      b.addEventListener("click", function () { act(b.dataset.act); });
    });
  }

  let onChange = null;
  const setOnChange = (fn) => { onChange = fn; };

  function act(name) {
    if (name === "forget-graph") {
      data.graph = null; save(); render();

    } else if (name === "reset") {
      if (!confirm("見え方などの設定を初期値に戻します。データは消えません。")) return;
      data = Object.assign({}, DEFAULTS);
      save(); apply(); render();

    } else if (name === "release") {
      const n = Storage.releaseLocalImages();
      alert(n + " 枚の名刺画像を、この端末から手放しました。表示するときにドライブから取り出します。");
      render();

    } else if (typeof onChange === "function") {
      onChange(name);          // 書き出し・読み込み・送信・全削除は app.js が持っています
    }
  }

  apply();

  return {
    enter: enter, render: render,
    get: get, set: set,
    saveGraph: saveGraph, loadGraph: loadGraph,
    setOnChange: setOnChange,
  };
})();

window.Settings = Settings;