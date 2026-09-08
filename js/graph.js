/* 版の番号。index.html と照らし合わせて、古いファイルが残っていないか確かめます。 */
(window.APP_BUILD = window.APP_BUILD || {})["graph"] = 22;

/* =============================================================================
   人脈グラフ（Phase 4）

     人物をノード（丸）、関係をエッジ（線）として図に描きます。

   外部の描画ライブラリは使っていません。
   ・配置は「ばねと反発」による簡単な計算で決めています
   ・図はSVGという、文字で書ける図形の形式で作っています
   GitHub Pages にファイルを置くだけで動かすためです。

   設計上の約束（設計書 §9）：
     線が引かれるのは、人が登録した関係だけです。
     同じ組織にいる、同じ学会に出た、というだけで線は引きません。
     線の太さは「関係の強さ」であって、システムが測った親しさではありません。
   ============================================================================= */

const Graph = (function () {

  const esc = UI.esc;
  const $ = UI.$;

  const VIEW_W = 900;
  const VIEW_H = 620;

  // 組織ごとの色。順番に割り当てる。
  const ORG_COLORS = [
    "#2f5d8c", "#2b6b53", "#a9622a", "#7a4a86", "#a93a2a",
    "#3d6f74", "#8a6420", "#5a5f8c", "#6b7a3a", "#8c4a5e",
  ];

  let state = {
    nodes: [],        // { id, name, org, orgId, x, y, degree }
    links: [],        // { a, b, type, strength, source, notes }
    selected: null,   // 選ばれている人物のID
    minStrength: 1,   // これ未満の関係は線を引かない
    showIsolated: true,
    showUsers: true,  // 社内の利用者を図に載せるか
    pathFrom: "",
    pathTo: "",
    pathIds: [],      // 経路上の人物ID
    pathLinks: [],    // 経路上の関係のキー
    message: "",

    // いま見えている範囲（拡大縮小と移動に使う）
    view: { x: 0, y: 0, w: VIEW_W, h: VIEW_H },
    scope: "all",     // "all"=全員 / "mine"=選択中の利用者が交換した名刺だけ
    markSole: true,   // 組織内で1人しか接点がない人を強調するか
    spacing: 1,       // ノードの間隔（0.7=せまい / 1=ふつう / 1.4=ひろい）
    spacingTouched: false,   // 利用者が自分でつまみを動かしたか
  };

  // 図を描く場所の広さ。間隔を広げると、この範囲も広がる。
  const areaW = () => VIEW_W * state.spacing;
  const areaH = () => VIEW_H * state.spacing;

  const nodeById = (id) => state.nodes.find((n) => n.id === id);
  const linkKey = (a, b) => [a, b].sort().join("|");


  /* =========================================================================
     画面に入ったとき
     ========================================================================= */

  function enter() {
    // 設定で覚えている内容があれば、それを引き継ぐ
    if (typeof Settings !== "undefined") {
      const saved = Settings.loadGraph();
      if (saved) Object.assign(state, saved);
    }
    build();
    resetView();
    render();
  }

  /** 設定が変わったら覚えておく（設定画面で切っていれば何もしません） */
  function remember() {
    if (typeof Settings !== "undefined") Settings.saveGraph(state);
  }

  /** 保存されているデータから、図に描く材料を組み立てる */
  function build() {
    let persons = Storage.searchPersons("", "", "name");

    /* 「自分の名刺だけ」を選んだときは、
       いま選ばれている利用者が名刺交換した相手だけに絞ります。
       誰と接点があるかを、自分を中心に見たいときに使います。 */
    const me = Storage.getCurrentUserId();
    if (state.scope === "mine" && me) {
      const mine = {};
      Storage.getContactsOfUser(me).forEach((p) => { mine[p.id] = true; });
      persons = persons.filter((p) => mine[p.id]);
    }
    const orgIds = [];
    persons.forEach(function (p) {
      if (p.organization_id && orgIds.indexOf(p.organization_id) < 0) {
        orgIds.push(p.organization_id);
      }
    });

    // 前の配置を覚えておき、同じ人物は同じ場所から始める
    const prev = {};
    state.nodes.forEach((n) => { prev[n.id] = { x: n.x, y: n.y }; });

    state.nodes = persons.map(function (p, i) {
      const angle = (i / Math.max(1, persons.length)) * Math.PI * 2;
      const start = prev[p.id] || {
        x: VIEW_W / 2 + Math.cos(angle) * 180,
        y: VIEW_H / 2 + Math.sin(angle) * 180,
      };
      return {
        id: p.id,
        name: p.name,
        kana: p.name_kana || "",
        // 組織内で、この人と名刺を交換しているのが1人だけかどうか
        soleContact: Storage.getUsersWhoKnow(p.id).length === 1,
        orgId: p.organization_id,
        org: Storage.getOrganizationName(p.organization_id),
        colorIndex: p.organization_id ? orgIds.indexOf(p.organization_id) : -1,
        x: start.x, y: start.y, vx: 0, vy: 0, degree: 0,
      };
    });

    // 社内の利用者もノードにする（四角で表示する）
    if (state.showUsers) {
      const userList = (state.scope === "mine" && me)
        ? Storage.getUsers().filter((u) => u.id === me)
        : Storage.getUsers();
      userList.forEach(function (u, i) {
        const prevPos = prev["U:" + u.id] || {
          x: areaW() / 2 + Math.cos(i * 1.7) * 90 * state.spacing,
          y: areaH() / 2 + Math.sin(i * 1.7) * 90 * state.spacing,
        };
        state.nodes.push({
          id: "U:" + u.id, userId: u.id, name: u.name, isUser: true,
          org: u.note || "社内", orgId: null, colorIndex: -2,
          x: prevPos.x, y: prevPos.y, vx: 0, vy: 0, degree: 0,
        });
      });
    }

    // 関係を、重複しない形で取り出す
    const seen = {};
    state.links = [];
    persons.forEach(function (p) {
      Storage.getRelationshipsOf(p.id).forEach(function (r) {
        const key = linkKey(p.id, r.other_id) + "|" + r.relationship_type;
        if (seen[key]) return;
        if (!nodeById(r.other_id)) return;          // 相手が消えている場合は描かない
        seen[key] = true;
        state.links.push({
          a: r.from_person_id, b: r.to_person_id,
          type: r.relationship_type,
          label: Storage.relationshipLabel(r.relationship_type),
          strength: r.strength || 1,
          source: r.source, notes: r.notes,
          directed: Storage.isDirected(r.relationship_type),
        });
      });
    });

    // 「誰がその名刺を交換したか」を線にする。
    // これは推測ではなく、名刺を登録したときの記録そのものです。
    if (state.showUsers) {
      state.nodes.filter((n) => n.isUser).forEach(function (un) {
        Storage.getContactsOfUser(un.userId).forEach(function (p) {
          if (!nodeById(p.id)) return;
          state.links.push({
            a: un.id, b: p.id,
            type: "card_owner",
            label: "名刺交換（登録記録）",
            strength: 2,
            source: "名刺の登録記録",
            notes: null, directed: false, isOwner: true,
          });
        });
      });
    }

    // つながっている本数を数える（丸の大きさに使う）
    state.links.forEach(function (l) {
      const na = nodeById(l.a), nb = nodeById(l.b);
      if (na) na.degree++;
      if (nb) nb.degree++;
    });

    // 人数が多いほど、名前が重なりやすくなる。
    // 自分でつまみを動かしていない間は、人数に合わせた間隔を選ぶ。
    if (!state.spacingTouched) {
      const n = state.nodes.length;
      const auto = Math.max(1, Math.min(2.4, Math.sqrt(n / 34)));
      if (Math.abs(auto - state.spacing) > 0.01) {
        const ratio = auto / state.spacing;
        state.nodes.forEach(function (nd) { nd.x *= ratio; nd.y *= ratio; });
        state.spacing = auto;
      }
    }

    simulate();
  }

  /* -------------------------------------------------------------------------
     配置の計算

     ・つながっている人どうしは、ばねで引き寄せる（強い関係ほど近く）
     ・すべての人どうしは、反発させて重ならないようにする
     ・全体が中央に集まるよう、弱く引き寄せる
     この3つを何度も繰り返すと、自然に見える配置に落ち着きます。
     ------------------------------------------------------------------------- */
  function simulate(steps, pinned) {
    const nodes = state.nodes;
    const links = visibleLinks();
    const n = nodes.length;
    if (!n) return;

    const total = steps || 320;
    for (let step = 0; step < total; step++) {
      // 指で動かしている間は、勢いを一定にして自然に追従させる
      const cooling = pinned ? 0.6 : (1 - step / total);

      // 反発
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          const a = nodes[i], b = nodes[j];
          let dx = b.x - a.x, dy = b.y - a.y;
          let d2 = dx * dx + dy * dy;
          if (d2 < 1) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 1; }
          const d = Math.sqrt(d2);
          const force = (9000 * state.spacing * state.spacing) / d2;
          const fx = (dx / d) * force, fy = (dy / d) * force;
          a.vx -= fx; a.vy -= fy;
          b.vx += fx; b.vy += fy;
        }
      }

      // ばね（関係が強いほど、短く保とうとする）
      links.forEach(function (l) {
        const a = nodeById(l.a), b = nodeById(l.b);
        if (!a || !b) return;
        const rest = (190 - l.strength * 16) * state.spacing;
        let dx = b.x - a.x, dy = b.y - a.y;
        const d = Math.max(1, Math.sqrt(dx * dx + dy * dy));
        const force = (d - rest) * 0.05;
        const fx = (dx / d) * force, fy = (dy / d) * force;
        a.vx += fx; a.vy += fy;
        b.vx -= fx; b.vy -= fy;
      });

      // 中央へ寄せる
      const cx = areaW() / 2, cy = areaH() / 2;
      nodes.forEach(function (nd) {
        nd.vx += (cx - nd.x) * 0.012;
        nd.vy += (cy - nd.y) * 0.012;
      });

      // 動かす（つかんでいる丸は指の位置のまま）
      nodes.forEach(function (nd) {
        if (nd === pinned) { nd.vx = 0; nd.vy = 0; return; }
        nd.x += nd.vx * 0.4 * cooling;
        nd.y += nd.vy * 0.4 * cooling;
        nd.vx *= 0.82; nd.vy *= 0.82;
        const m = 46;
        nd.x = Math.max(m, Math.min(areaW() - m, nd.x));
        nd.y = Math.max(m, Math.min(areaH() - m, nd.y));
      });
    }

    // 最後に、名前が重ならないように整える
    separateLabels(pinned ? 2 : (state.nodes.length > 60 ? 70 : 30));
  }

  /* -------------------------------------------------------------------------
     名前の重なりをほどく

     丸どうしが離れていても、名前は横に広がるため重なります。
     そこで、名前を囲む四角どうしが重なっていたら、
     重なりの小さい方向へ押し離します。
     横に重なっているときは横へ、縦に重なっているときは縦へ動かすので、
     配置が大きく崩れません。
     ------------------------------------------------------------------------- */

  const FONT_W = 12;     // 文字1つのおおよその幅（CSSの13pxに合わせる）
  const LABEL_H = 17;    // 名前1行の高さ

  function labelBox(n) {
    const r = 13 + Math.min(9, n.degree * 1.6);
    return {
      w: Math.max(r * 2, String(n.name || "").length * FONT_W + 8),
      // 丸と、その下に置く名前を合わせた高さ
      h: r * 2 + LABEL_H + 6,
      // 名前は丸の下に出るので、囲みの中心は少し下になる
      cy: (LABEL_H + 6) / 2,
    };
  }

  function separateLabels(passes) {
    const nodes = state.nodes;
    const gap = 6;

    for (let k = 0; k < (passes || 30); k++) {
      let moved = 0;
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i], b = nodes[j];
          const ba = labelBox(a), bb = labelBox(b);

          const dx = b.x - a.x;
          const dy = (b.y + bb.cy) - (a.y + ba.cy);
          const needX = (ba.w + bb.w) / 2 + gap;
          const needY = (ba.h + bb.h) / 2 + gap;

          const overX = needX - Math.abs(dx);
          const overY = needY - Math.abs(dy);
          if (overX <= 0 || overY <= 0) continue;   // 重なっていない

          // 重なりが小さい方向へ、半分ずつ押し離す
          if (overX < overY) {
            const push = (dx >= 0 ? 1 : -1) * overX / 2;
            a.x -= push; b.x += push;
          } else {
            const push = (dy >= 0 ? 1 : -1) * overY / 2;
            a.y -= push; b.y += push;
          }
          moved++;
        }
      }
      if (!moved) break;         // どこも重なっていなければ終わり
    }

    // 図の外へ出ないようにする
    const m = 34;
    nodes.forEach(function (nd) {
      nd.x = Math.max(m, Math.min(areaW() - m, nd.x));
      nd.y = Math.max(m, Math.min(areaH() - m, nd.y));
    });
  }

  function visibleLinks() {
    return state.links.filter(function (l) {
      if (l.isOwner) return true;          // 名刺の登録記録は常に表示する
      return (l.strength || 1) >= state.minStrength;
    });
  }

  function visibleNodes() {
    if (state.showIsolated) return state.nodes;
    const used = {};
    visibleLinks().forEach((l) => { used[l.a] = true; used[l.b] = true; });
    return state.nodes.filter((n) => used[n.id]);
  }


  /* =========================================================================
     経路をさがす（最短で何人はさむか）
     ========================================================================= */

  function findPath(fromId, toId) {
    if (!fromId || !toId || fromId === toId) return null;

    const adj = {};
    visibleLinks().forEach(function (l) {
      (adj[l.a] = adj[l.a] || []).push(l.b);
      (adj[l.b] = adj[l.b] || []).push(l.a);
    });

    // 幅優先探索。近いところから順に調べるので、最初に着いた道が最短になる。
    const prev = {}; const seen = {}; const queue = [fromId];
    seen[fromId] = true;

    while (queue.length) {
      const cur = queue.shift();
      if (cur === toId) {
        const path = [cur];
        while (prev[path[0]]) path.unshift(prev[path[0]]);
        return path;
      }
      (adj[cur] || []).forEach(function (next) {
        if (seen[next]) return;
        seen[next] = true;
        prev[next] = cur;
        queue.push(next);
      });
    }
    return null;
  }

  function applyPath() {
    state.pathIds = [];
    state.pathLinks = [];
    state.message = "";

    if (!state.pathFrom || !state.pathTo) return;

    const path = findPath(state.pathFrom, state.pathTo);
    if (!path) {
      state.message = "登録されている関係では、この2人はつながっていません。";
      return;
    }
    state.pathIds = path;
    for (let i = 0; i < path.length - 1; i++) {
      state.pathLinks.push(linkKey(path[i], path[i + 1]));
    }

    const via = path.slice(1, -1).map((id) => (nodeById(id) || {}).name);
    state.message = via.length
      ? "間に " + via.length + " 人：" + path.map((id) => (nodeById(id) || {}).name).join(" → ")
      : "直接つながっています：" + path.map((id) => (nodeById(id) || {}).name).join(" → ");
  }


  /* =========================================================================
     描く
     ========================================================================= */

  function render() {
    renderControls();
    renderCanvas();
    renderPanel();
  }

  /* -------------------------------------------------------------------------
     操作欄

     設定が多いので、4つの行に分けています。
     行の頭に「何の設定か」を書き、右にその設定だけを並べます。
     以前は横一列に並べていたため、画面幅によって折り返す位置が変わり、
     どれとどれが同じ設定なのか分からなくなっていました。
     ------------------------------------------------------------------------- */

  /* -------------------------------------------------------------------------
     人を選ぶ入力欄

     打ち込みながら候補を出します。何も打たずに押せば全員が出るので、
     一覧から選ぶ使い方もできます。
     人数が増えると、選択式だけでは目当ての人を探しにくいためです。
     ------------------------------------------------------------------------- */

  // 探すときの文字ゆれを吸収する（全角と半角、大文字と小文字）
  function fold(v) {
    return String(v || "")
      .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
      .replace(/[\s\u3000]/g, "")
      .toLowerCase();
  }

  const labelOf = (id) => {
    const n = nodeById(id);
    return n ? n.name : "";
  };

  function comboHtml(id, value, placeholder) {
    return '<span class="combo" id="' + id + '-box">'
      + '<input type="text" class="combo-input" id="' + id + '"'
      +   ' value="' + esc(labelOf(value)) + '"'
      +   ' placeholder="' + esc(placeholder) + '" autocomplete="off"'
      +   ' role="combobox" aria-expanded="false" aria-autocomplete="list">'
      + '<button class="combo-open" id="' + id + '-open" tabindex="-1"'
      +   ' aria-label="一覧から選ぶ">▾</button>'
      + '<span class="combo-list" id="' + id + '-list" hidden></span>'
      + "</span>";
  }

  /** 打ち込みに合う人を、上から順に返す */
  function candidates(query) {
    const q = fold(query);
    const list = state.nodes.filter(function (n) {
      if (!q) return true;
      return fold(n.name + " " + (n.kana || "") + " " + (n.org || "")).indexOf(q) >= 0;
    });
    // 社内の利用者を先に出す（自分から探すことが多いため）
    list.sort(function (a, b) {
      if (a.isUser !== b.isUser) return a.isUser ? -1 : 1;
      return String(a.name).localeCompare(String(b.name), "ja");
    });
    return list;
  }

  /**
   * 入力欄に、候補を出す仕組みを付ける。
   * @param id      入力欄のID
   * @param onPick  選ばれたときに呼ぶ（人物IDを渡す。消したときは空文字）
   */
  function setupCombo(id, onPick) {
    const input = $(id);
    const list = $(id + "-list");
    const openBtn = $(id + "-open");
    if (!input || !list) return;

    let composing = false;   // 日本語を変換している最中か
    let active = -1;         // キーボードで選んでいる位置
    let shown = [];

    function close() {
      list.hidden = true;
      input.setAttribute("aria-expanded", "false");
      active = -1;
    }

    // 一度に出す上限。多すぎると探しにくいので区切るが、
    // 区切ったことは必ず画面に出す（黙って減らすと、いないと勘違いするため）
    const MAX_SHOWN = 60;

    function open(query) {
      const all = candidates(query);
      shown = all.slice(0, MAX_SHOWN);
      const rest = all.length - shown.length;

      if (!shown.length) {
        list.innerHTML = '<span class="combo-empty">'
          + (state.scope === "mine"
            ? "見つかりません。「表示」が『自分の名刺だけ』になっています。"
            : "見つかりません。")
          + "</span>";
      } else {
        list.innerHTML = shown.map(function (n, i) {
          return '<span class="combo-item' + (i === active ? " is-active" : "") + '"'
            + ' data-pick="' + n.id + '" data-i="' + i + '">'
            + '<span class="ci-name">' + esc(n.name) + "</span>"
            + (n.kana ? '<span class="ci-kana">' + esc(n.kana) + "</span>" : "")
            + '<span class="ci-org">' + esc(n.isUser ? "社内" : (n.org || "")) + "</span>"
            + "</span>";
        }).join("")
        + (rest > 0
          ? '<span class="combo-more">ほか ' + rest + " 件。"
            + "氏名・ふりがな・組織を打ち込むと絞り込めます。</span>"
          : "")
        + (state.scope === "mine"
          ? '<span class="combo-more">「表示」が『自分の名刺だけ』のため、'
            + "その相手だけが出ています。</span>"
          : "");
      }
      list.hidden = false;
      input.setAttribute("aria-expanded", "true");
    }

    function pick(id2) {
      const n = nodeById(id2);
      input.value = n ? n.name : "";
      close();
      onPick(id2);
    }

    input.addEventListener("compositionstart", function () { composing = true; });
    input.addEventListener("compositionend", function () {
      composing = false;
      open(input.value);
    });
    input.addEventListener("input", function () {
      if (composing) return;          // 変換の途中では絞り込まない
      active = -1;
      open(input.value);
      if (!input.value.trim()) onPick("");   // 空にしたら選択も外す
    });
    input.addEventListener("focus", function () { open(input.value); });
    input.addEventListener("blur", function () {
      // 候補を押す前に閉じてしまわないよう、少し待つ
      setTimeout(close, 150);
    });

    input.addEventListener("keydown", function (e) {
      if (composing) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (list.hidden) { open(input.value); return; }
        active += (e.key === "ArrowDown" ? 1 : -1);
        if (active < 0) active = shown.length - 1;
        if (active >= shown.length) active = 0;
        open(input.value);
        const el = list.querySelector(".is-active");
        if (el && el.scrollIntoView) el.scrollIntoView({ block: "nearest" });
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (!list.hidden && shown.length) pick(shown[active >= 0 ? active : 0].id);
      } else if (e.key === "Escape") {
        close();
      }
    });

    openBtn.addEventListener("mousedown", function (e) {
      e.preventDefault();
      if (list.hidden) { input.focus(); open(""); } else { close(); }
    });

    list.addEventListener("mousedown", function (e) {
      const item = e.target.closest("[data-pick]");
      if (!item) return;
      e.preventDefault();
      pick(item.dataset.pick);
    });
  }

  function renderControls() {
    const persons = state.nodes.filter((n) => !n.isUser);
    const me = Storage.getCurrentUser();

    const personOptions = (selected) =>
      '<option value="">選んでください</option>'
      + state.nodes.map((n) =>
          '<option value="' + n.id + '"' + (selected === n.id ? " selected" : "") + ">"
          + esc(n.name) + (n.isUser ? "（社内）" : (n.org ? "（" + esc(n.org) + "）" : ""))
          + "</option>").join("");

    $("graph-controls").innerHTML =
        '<div class="gpanel">'

      /* --- 1行目：どの範囲を出すか --- */
      + '<div class="grow">'
      +   '<div class="glabel">絞り込み</div>'
      +   '<div class="gitems">'
      +     '<span class="gfield"><label for="g-scope">範囲</label>'
      +       '<select id="g-scope" class="select">'
      +         '<option value="all"' + (state.scope === "all" ? " selected" : "") + ">組織全体</option>"
      +         '<option value="mine"' + (state.scope === "mine" ? " selected" : "") + ">"
      +           (me ? esc(me.name) + "さんの名刺だけ" : "自分の名刺だけ（利用者未選択）")
      +         "</option>"
      +       "</select></span>"
      +     '<span class="gfield"><label for="g-strength">関係の強さ</label>'
      +       '<select id="g-strength" class="select">'
      +         [1, 2, 3, 4, 5].map((v) =>
                  '<option value="' + v + '"' + (state.minStrength === v ? " selected" : "") + ">"
                  + (v === 1 ? "すべて" : v + " 以上") + "</option>").join("")
      +       "</select></span>"
      +   "</div>"
      + "</div>"

      /* --- 2行目：何を出すか --- */
      + '<div class="grow">'
      +   '<div class="glabel">表示する</div>'
      +   '<div class="gitems">'
      +     '<label class="gcheck"><input type="checkbox" id="g-users"'
      +       (state.showUsers ? " checked" : "") + "> 社内の利用者</label>"
      +     '<label class="gcheck"><input type="checkbox" id="g-isolated"'
      +       (state.showIsolated ? " checked" : "") + "> 関係のない人物</label>"
      +     '<label class="gcheck"><input type="checkbox" id="g-sole"'
      +       (state.markSole ? " checked" : "") + "> 接点が1人だけの人を強調</label>"
      +   "</div>"
      + "</div>"

      /* --- 3行目：見え方 --- */
      + '<div class="grow">'
      +   '<div class="glabel">見え方</div>'
      +   '<div class="gitems">'
      +     '<span class="gfield"><label for="g-spacing">間隔</label>'
      +       '<input type="range" id="g-spacing" min="0.6" max="3" step="0.05"'
      +         ' value="' + state.spacing + '">'
      +       '<span class="gvalue" id="g-spacing-level">'
              + Math.round(state.spacing * 100) + "%</span></span>"
      +     '<span class="gfield"><span class="glabel-sub">拡大</span>'
      +       '<button class="zbtn" id="g-zoom-out" aria-label="縮小">−</button>'
      +       '<span class="gvalue" id="g-zoom-level">100%</span>'
      +       '<button class="zbtn" id="g-zoom-in" aria-label="拡大">＋</button>'
      +       '<button class="btn btn-sm" id="g-zoom-reset">全体を表示</button></span>'
      +     '<button class="btn btn-sm" id="g-untangle">名前の重なりをほどく</button>'
      +   "</div>"
      + "</div>"

      /* --- 4行目：経路 --- */
      + '<div class="grow">'
      +   '<div class="glabel">経路をさがす</div>'
      +   '<div class="gitems">'
      +     (me
            ? '<button class="btn btn-sm" id="g-me" title="'
              + esc(me.name) + 'さんを出発点にします">自分から</button>'
            : "")
      +     comboHtml("g-from", state.pathFrom, "出発する人")
      +     '<span class="garrow">→</span>'
      +     comboHtml("g-to", state.pathTo, "たどり着きたい人")
      +     '<button class="btn btn-sm" id="g-clear">解除</button>'
      +   "</div>"
      + "</div>"

      + "</div>";

    $("g-strength").addEventListener("change", function () {
      state.minStrength = Number(this.value);
      remember();
      applyPath();
      simulate(180);
      render();
    });
    $("g-isolated").addEventListener("change", function () {
      state.showIsolated = this.checked;
      remember();
      render();
    });
    $("g-users").addEventListener("change", function () {
      state.showUsers = this.checked;
      remember();
      build();
      render();
    });

    /* 間隔つまみ。
       動かしている間は軽い計算だけを行い、手を離したときに整えます。
       つまみを動かすたびに重い計算をすると、動きが引っかかるためです。 */
    const spacingInput = $("g-spacing");

    function applySpacing(next, light) {
      const ratio = next / state.spacing;
      state.nodes.forEach(function (n) { n.x *= ratio; n.y *= ratio; });
      state.spacing = next;
      if (!light) remember();
      simulate(light ? 12 : 200);
      resetView();
      renderCanvas();
      $("g-spacing-level").textContent = Math.round(next * 100) + "%";
    }

    spacingInput.addEventListener("input", function () {
      state.spacingTouched = true;
      applySpacing(Number(this.value), true);
    });
    spacingInput.addEventListener("change", function () {
      applySpacing(Number(this.value), false);
    });

    // 名前が重なったときに、そこだけ整え直す
    $("g-untangle").addEventListener("click", function () {
      separateLabels(60);
      renderCanvas();
    });

    $("g-scope").addEventListener("change", function () {
      state.scope = this.value;
      state.selected = null;
      remember();
      build();
      resetView();
      render();
    });
    $("g-sole").addEventListener("change", function () {
      state.markSole = this.checked;
      remember();
      renderCanvas();
      renderPanel();
    });

    $("g-zoom-in").addEventListener("click", function () { zoomBy(1.25); });
    $("g-zoom-out").addEventListener("click", function () { zoomBy(1 / 1.25); });
    $("g-zoom-reset").addEventListener("click", resetView);
    // 「自分から」で、いま使っている人をすぐ出発点にする
    const meBtn = $("g-me");
    if (meBtn) meBtn.addEventListener("click", function () {
      const u = Storage.getCurrentUser();
      if (!u) return;
      state.pathFrom = "U:" + u.id;
      $("g-from").value = u.name;
      applyPath();
      redrawAfterPath();
      // 続けて行き先を打てるように、そちらへ移す
      const to = $("g-to");
      if (to && to.focus) to.focus();
    });

    setupCombo("g-from", function (id) {
      state.pathFrom = id; applyPath(); redrawAfterPath();
    });
    setupCombo("g-to", function (id) {
      state.pathTo = id; applyPath(); redrawAfterPath();
    });
    $("g-clear").addEventListener("click", function () {
      state.pathFrom = ""; state.pathTo = "";
      state.pathIds = []; state.pathLinks = []; state.message = "";
      $("g-from").value = ""; $("g-to").value = "";
      redrawAfterPath();
    });
  }

  /* 経路を選んだあとの描き直し。
     入力欄そのものは作り直さない（打ち込んだ内容や、開いている候補が消えるため） */
  function redrawAfterPath() {
    renderCanvas();
    renderPanel();
  }

  function renderCanvas() {
    const nodes = visibleNodes();
    const visibleIds = {};
    nodes.forEach((n) => { visibleIds[n.id] = true; });
    const links = visibleLinks().filter((l) => visibleIds[l.a] && visibleIds[l.b]);

    if (!state.nodes.length) {
      $("graph-canvas").innerHTML =
        '<div class="empty-box"><p>まだ人物が登録されていません。</p>'
        + '<button class="btn" data-screen="capture">名刺を登録する</button></div>';
      return;
    }
    if (!state.links.length) {
      $("graph-canvas").innerHTML =
        '<div class="empty-box"><p>まだ関係が登録されていません。</p>'
        + "<p class=\"note\">人物の画面をひらき、「人物同士の関係」から登録してください。</p>"
        + '<button class="btn" data-screen="people">人物一覧へ</button></div>';
      return;
    }

    const onPath = {};
    state.pathIds.forEach((id) => { onPath[id] = true; });
    const dim = state.pathIds.length > 0;   // 経路を表示中は、それ以外を薄くする

    // --- 線 ---
    const edges = links.map(function (l) {
      const a = nodeById(l.a), b = nodeById(l.b);
      const key = linkKey(l.a, l.b);
      const isPath = state.pathLinks.indexOf(key) >= 0;
      const cls = "edge" + (l.isOwner ? " is-owner" : "")
        + (isPath ? " is-path" : (dim ? " is-dim" : ""));
      const title = esc(a.name) + " ― " + esc(b.name) + "　"
        + esc(l.label) + "　強さ" + l.strength
        + (l.source ? "　根拠：" + esc(l.source) : "");
      return '<g class="' + cls + '" data-a="' + l.a + '" data-b="' + l.b + '">'
        + "<title>" + title + "</title>"
        + '<line x1="' + a.x.toFixed(1) + '" y1="' + a.y.toFixed(1) + '"'
        + ' x2="' + b.x.toFixed(1) + '" y2="' + b.y.toFixed(1) + '"'
        + ' stroke-width="' + (0.8 + l.strength * 0.9).toFixed(1) + '"'
        + (l.strength <= 2 ? ' stroke-dasharray="5 4"' : "")
        + "></line></g>";
    }).join("");

    // --- 丸と名前 ---
    const circles = nodes.map(function (n) {
      const r = 13 + Math.min(9, n.degree * 1.6);
      const color = n.isUser
        ? "#16202a"                                  // 社内の利用者は濃い色の四角
        : (n.colorIndex >= 0 ? ORG_COLORS[n.colorIndex % ORG_COLORS.length] : "#8a949c");
      const sole = state.markSole && n.soleContact && !n.isUser;
      const cls = "node" + (n.isUser ? " is-user" : "") + (sole ? " is-sole" : "")
        + (state.selected === n.id ? " is-selected" : "")
        + (onPath[n.id] ? " is-path" : (dim ? " is-dim" : ""));

      // 利用者は四角、外部の人物は丸
      const shape = n.isUser
        ? '<rect x="' + (-r) + '" y="' + (-r) + '" width="' + (r * 2) + '" height="'
          + (r * 2) + '" rx="3" fill="' + color + '"></rect>'
        : '<circle r="' + r + '" fill="' + color + '"></circle>';

      return '<g class="' + cls + '" data-node="' + n.id + '"'
        + ' transform="translate(' + n.x.toFixed(1) + "," + n.y.toFixed(1) + ')">'
        + "<title>" + esc(n.name) + (n.isUser ? "（社内）" : (n.org ? "（" + esc(n.org) + "）" : ""))
        + "　つながり " + n.degree + " 件"
        + (sole ? "　※社内でこの人と接点があるのは1人だけです" : "") + "</title>"
        // 1人しか接点がない人には、外側に印の輪を描く
        + (sole ? '<circle class="sole-ring" r="' + (r + 5) + '" fill="none"></circle>' : "")
        + shape
        + '<text y="' + (r + 15) + '" text-anchor="middle">' + esc(n.name) + "</text>"
        + "</g>";
    }).join("");

    $("graph-canvas").innerHTML =
        '<svg viewBox="' + viewBoxStr() + '" class="graph-svg"'
      + ' role="img" aria-label="人物の関係図">'
      + '<g class="edges">' + edges + "</g>"
      + '<g class="nodes">' + circles + "</g>"
      + "</svg>";

    wireCanvas();
  }

  /* -------------------------------------------------------------------------
     丸を押して選ぶ、引きずって動かす

     指を動かすたびに図全体を作り直すと、動きがぎこちなくなります。
     ここでは、位置が変わった丸と線の座標だけを書き換えます。
     あわせて、画面の更新に合わせて計算を少しずつ回すことで、
     つかんだ丸のまわりがばねのように追従します。
     ------------------------------------------------------------------------- */

  /* --- 拡大縮小と移動 -------------------------------------------------------

     図そのものは作り直さず、「どこを見ているか」だけを書き換えます。
     SVG の viewBox という指定で、表示する範囲を決められます。
     範囲を狭めれば拡大、広げれば縮小になります。
     ------------------------------------------------------------------------- */

  const MIN_ZOOM = 0.35;   // これ以上は縮小しない
  const MAX_ZOOM = 4;      // これ以上は拡大しない

  const viewBoxStr = () =>
    state.view.x.toFixed(1) + " " + state.view.y.toFixed(1) + " "
    + state.view.w.toFixed(1) + " " + state.view.h.toFixed(1);

  /** いまの倍率（1 = 全体が見えている状態） */
  const zoomLevel = () => areaW() / state.view.w;

  /** 全体が見える状態に戻す */
  function resetView() {
    state.view = { x: 0, y: 0, w: areaW(), h: areaH() };
    applyView();
  }

  /** 見ている範囲だけを書き換える（作り直さない） */
  function applyView() {
    if (svgEl) svgEl.setAttribute("viewBox", viewBoxStr());
    const label = $("g-zoom-level");
    if (label) label.textContent = Math.round(zoomLevel() * 100) + "%";
  }

  /**
   * 拡大・縮小する。
   * @param factor  1より大きいと拡大
   * @param cx,cy   この点を動かさないようにする（マウスの位置）
   */
  function zoomBy(factor, cx, cy) {
    const v = state.view;
    const now = zoomLevel();
    let next = now * factor;
    next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, next));
    if (Math.abs(next - now) < 0.0001) return;

    const w = areaW() / next, h = areaH() / next;
    const px = (cx === undefined) ? v.x + v.w / 2 : cx;
    const py = (cy === undefined) ? v.y + v.h / 2 : cy;

    // マウスの下にある点が動かないように、左上の位置を決め直す
    v.x = px - (px - v.x) * (w / v.w);
    v.y = py - (py - v.y) * (h / v.h);
    v.w = w; v.h = h;
    applyView();
  }

  let svgEl = null;
  let nodeEls = {};     // 人物ID → 丸のまとまり
  let edgeEls = [];     // { a, b, line }
  let dragging = null;
  let panning = null;
  let moved = false;
  let raf = 0;

  function collectElements() {
    svgEl = $("graph-canvas").querySelector("svg");
    applyView();
    nodeEls = {};
    edgeEls = [];
    if (!svgEl) return;

    svgEl.querySelectorAll("[data-node]").forEach(function (g) {
      nodeEls[g.dataset.node] = g;
    });
    svgEl.querySelectorAll("[data-a]").forEach(function (g) {
      const line = g.querySelector("line");
      if (line) edgeEls.push({ a: g.dataset.a, b: g.dataset.b, line: line });
    });
  }

  /** 座標だけを書き換える（作り直さない） */
  function updatePositions() {
    Object.keys(nodeEls).forEach(function (id) {
      const n = nodeById(id);
      if (n) nodeEls[id].setAttribute("transform",
        "translate(" + n.x.toFixed(1) + "," + n.y.toFixed(1) + ")");
    });
    edgeEls.forEach(function (e) {
      const a = nodeById(e.a), b = nodeById(e.b);
      if (!a || !b) return;
      e.line.setAttribute("x1", a.x.toFixed(1));
      e.line.setAttribute("y1", a.y.toFixed(1));
      e.line.setAttribute("x2", b.x.toFixed(1));
      e.line.setAttribute("y2", b.y.toFixed(1));
    });
  }

  /** 画面の更新に合わせて、少しずつ計算して動かす */
  function tick() {
    if (!dragging) { raf = 0; return; }
    simulate(2, dragging);
    updatePositions();
    raf = requestAnimationFrame(tick);
  }

  function wireCanvas() {
    collectElements();
    if (!svgEl) return;

    // 画面上の位置を、図の中の座標に直す
    function toSvgPoint(evt) {
      const rect = svgEl.getBoundingClientRect();
      return {
        x: state.view.x + ((evt.clientX - rect.left) / rect.width) * state.view.w,
        y: state.view.y + ((evt.clientY - rect.top) / rect.height) * state.view.h,
      };
    }

    /* マウスホイールと、タッチパッドの二本指で拡大・縮小。

       以前は「1回動かすたびに一定量」拡大していたため、
       小刻みに何度も知らせてくるタッチパッドでは効きすぎていた。
       動かした量に応じて変えることで、どちらでも同じ感覚になる。 */
    svgEl.addEventListener("wheel", function (e) {
      e.preventDefault();

      // 知らせ方が「行」「ページ」単位のこともあるので、点の単位にそろえる
      let dy = e.deltaY;
      if (e.deltaMode === 1) dy *= 16;
      else if (e.deltaMode === 2) dy *= 400;

      // つまむ操作（二本指でのピンチ）は、拡大の意図がはっきりしているので少し強めに
      const sensitivity = e.ctrlKey ? 0.008 : 0.0015;

      // 一度に飛びすぎないよう、上下を抑える
      let factor = Math.exp(-dy * sensitivity);
      factor = Math.max(0.84, Math.min(1.2, factor));

      const p = toSvgPoint(e);
      zoomBy(factor, p.x, p.y);
    }, { passive: false });

    svgEl.addEventListener("pointerdown", function (e) {
      const g = e.target.closest("[data-node]");

      // 何もないところをつかんだら、図全体を動かす
      if (!g) {
        panning = { x: e.clientX, y: e.clientY,
                    vx: state.view.x, vy: state.view.y };
        if (svgEl.setPointerCapture) svgEl.setPointerCapture(e.pointerId);
        svgEl.classList.add("is-panning");
        return;
      }

      dragging = nodeById(g.dataset.node);
      moved = false;
      if (svgEl.setPointerCapture) svgEl.setPointerCapture(e.pointerId);
      e.preventDefault();
      if (!raf) raf = requestAnimationFrame(tick);
    });

    svgEl.addEventListener("pointermove", function (e) {
      if (panning) {
        const rect = svgEl.getBoundingClientRect();
        state.view.x = panning.vx - (e.clientX - panning.x) / rect.width * state.view.w;
        state.view.y = panning.vy - (e.clientY - panning.y) / rect.height * state.view.h;
        applyView();
        return;
      }
      if (!dragging) return;
      const p = toSvgPoint(e);
      dragging.x = p.x;
      dragging.y = p.y;
      moved = true;
      e.preventDefault();
    });

    function end() {
      if (panning) { panning = null; svgEl.classList.remove("is-panning"); }
      if (!dragging) return;
      const wasClick = !moved;
      const id = dragging.id;
      dragging = null;
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      if (wasClick) {
        state.selected = id;
        renderCanvas();       // 選ばれた印を付けるので、ここは作り直す
        renderPanel();
      }
    }
    svgEl.addEventListener("pointerup", end);
    svgEl.addEventListener("pointercancel", end);
    svgEl.addEventListener("pointerleave", end);
  }

  /* --- 右側の詳細パネル ---------------------------------------------------- */

  function renderPanel() {
    const box = $("graph-panel");

    // 経路の説明があれば、まず出す
    let head = "";
    if (state.message) {
      head = '<div class="alert ' + (state.pathIds.length ? "alert-ok" : "alert-warn") + '">'
        + esc(state.message) + "</div>";
    }

    // 接点が1人だけの人が何名いるかを知らせる
    if (state.markSole) {
      const sole = visibleNodes().filter((n) => n.soleContact && !n.isUser);
      if (sole.length) {
        head += '<div class="sole-note">'
          + "<b>社内で接点が1人だけの人：" + sole.length + " 名</b>"
          + "<div>その人が抜けると、つながりが途切れます。</div>"
          + "</div>";
      }
    }

    if (!state.selected) {
      box.innerHTML = head + legendHtml()
        + '<p class="note lines">'
        +   "<span>丸を押すと、その人物の関係を表示します。</span>"
        +   "<span>引きずると位置を動かせます。</span>"
        + "</p>";
      return;
    }

    // 社内の利用者を選んだとき
    if (String(state.selected).indexOf("U:") === 0) {
      const u = Storage.getUser(state.selected.slice(2));
      if (u) {
        const contacts = Storage.getContactsOfUser(u.id);
        box.innerHTML = head
          + '<div class="gp-head">'
          +   '<div class="gp-name">' + esc(u.name) + "</div>"
          +   '<div class="gp-meta">社内の利用者' + (u.note ? "　／　" + esc(u.note) : "") + "</div>"
          + "</div>"
          + "<h3>名刺を交換した相手（" + contacts.length + "）</h3>"
          + (contacts.length
            ? '<ul class="gp-rels">' + contacts.map((c) =>
                "<li>"
                + '<button class="linkbtn gp-rel-name" data-pick="' + c.id + '">'
                + esc(c.name) + "</button>"
                + '<div class="rel-src">' + esc(Storage.getOrganizationName(c.organization_id) || "") + "</div>"
                + "</li>").join("") + "</ul>"
            : '<p class="empty">ありません。</p>')
          + legendHtml();

        box.querySelectorAll("[data-pick]").forEach(function (b) {
          b.addEventListener("click", function () {
            state.selected = b.dataset.pick;
            renderCanvas(); renderPanel();
          });
        });
        return;
      }
    }

    const p = Storage.getPerson(state.selected);
    if (!p) { state.selected = null; box.innerHTML = head + legendHtml(); return; }

    const rels = Storage.getRelationshipsOf(p.id);
    const topics = Storage.getTopicsOf(p.id);

    box.innerHTML = head
      + '<div class="gp-head">'
      +   '<div class="gp-name">' + esc(p.name) + "</div>"
      +   '<div class="gp-meta">'
      +     esc([Storage.getOrganizationName(p.organization_id), p.department, p.job_title]
            .filter(Boolean).join("　／　") || "所属情報なし") + "</div>"
      + "</div>"
      + (topics.length
        ? '<div class="chips" style="margin-bottom:12px">'
          + topics.map((t) => '<span class="chip">' + esc(t.name) + "</span>").join("")
          + "</div>"
        : "")
      + (function () {
          const knows = Storage.getUsersWhoKnow(p.id);
          if (!knows.length) return "";
          return "<h3>社内でこの人と接点がある人</h3>"
            + '<div class="gp-knows">' + knows.map((u) =>
                '<span class="knows-chip">' + esc(u.name) + "</span>").join("") + "</div>"
            + '<p class="note" style="margin:0 0 14px">名刺を登録した記録に基づきます。</p>';
        })()
      + "<h3>登録されている関係（" + rels.length + "）</h3>"
      + (rels.length
        ? '<ul class="gp-rels">' + rels.map(function (r) {
            const other = Storage.getPerson(r.other_id);
            return "<li>"
              + '<span class="rel-type">' + esc(Storage.relationshipLabel(r.relationship_type)) + "</span>"
              + '<button class="linkbtn gp-rel-name" data-pick="' + r.other_id + '">'
              +   esc(other ? other.name : "?") + "</button>"
              + '<span class="dots">' + "●".repeat(r.strength || 0)
              +   '<span class="dots-off">' + "●".repeat(5 - (r.strength || 0)) + "</span></span>"
              + '<div class="rel-src">根拠：' + esc(r.source || "（未記入）") + "</div>"
              + "</li>";
          }).join("") + "</ul>"
        : '<p class="empty">ありません。</p>')
      + '<div class="btn-row">'
      +   '<button class="btn btn-sm" data-screen="person" data-id="' + p.id + '">この人の詳細を見る</button>'
      +   '<button class="btn btn-sm" id="gp-from">ここを経路の起点にする</button>'
      + "</div>"
      + legendHtml();

    box.querySelectorAll("[data-pick]").forEach(function (b) {
      b.addEventListener("click", function () {
        state.selected = b.dataset.pick;
        renderCanvas(); renderPanel();
      });
    });
    const from = $("gp-from");
    if (from) from.addEventListener("click", function () {
      state.pathFrom = p.id;
      const box = $("g-from");
      if (box) box.value = p.name;
      applyPath();
      redrawAfterPath();
    });
  }

  function legendHtml() {
    const orgs = [];
    state.nodes.forEach(function (n) {
      if (n.colorIndex >= 0 && !orgs.some((o) => o.i === n.colorIndex)) {
        orgs.push({ i: n.colorIndex, name: n.org });
      }
    });
    orgs.sort((a, b) => a.i - b.i);

    return '<div class="gp-legend">'
      + "<h3>凡例</h3>"
      + '<div class="lg-row"><span class="lg-sq"></span>社内の利用者（四角）</div>'
      + '<div class="lg-row"><span class="lg-line lg-owner"></span>名刺交換（登録記録）</div>'
      + '<div class="lg-row"><span class="lg-line lg-thin"></span>強さ1〜2（点線）</div>'
      + '<div class="lg-row"><span class="lg-line lg-thick"></span>強さ3〜5（実線・太いほど強い）</div>'
      + '<p class="note lines" style="margin:6px 0 10px">'
      +   "<span>線の太さは、人が登録した「関係の強さ」です。</span>"
      +   "<span>システムが親しさを判定したものではありません。</span>"
      + "</p>"
      + '<div class="lg-orgs">' + orgs.map((o) =>
          '<div class="lg-row"><span class="lg-dot" style="background:'
          + ORG_COLORS[o.i % ORG_COLORS.length] + '"></span>' + esc(o.name) + "</div>").join("")
      + "</div></div>";
  }


  /**
   * 外から呼ぶ入口。
   * AIチャットが「このつながりを図で見せたい」ときに使います。
   * 指定された人だけを強調し、それ以外を薄くします。
   */
  function focusOn(ids) {
    build();
    const valid = (ids || []).filter((id) => nodeById(id));
    state.pathIds = valid;
    state.pathLinks = [];
    for (let i = 0; i < valid.length - 1; i++) {
      state.pathLinks.push(linkKey(valid[i], valid[i + 1]));
    }
    state.selected = valid.length ? valid[0] : null;
    state.message = valid.length > 1
      ? valid.map((id) => (nodeById(id) || {}).name).join(" → ")
      : "";
    state.pathFrom = valid[0] || "";
    state.pathTo = valid.length > 1 ? valid[valid.length - 1] : "";
    render();
  }

  return { enter: enter, focusOn: focusOn };
})();