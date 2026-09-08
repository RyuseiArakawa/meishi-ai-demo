/* 版の番号。index.html と照らし合わせて、古いファイルが残っていないか確かめます。 */
(window.APP_BUILD = window.APP_BUILD || {})["orgs"] = 18;

/* =============================================================================
   組織（Phase 6）

   人物単位ではなく、組織単位で見るための画面です。
     ・どの組織に何人の接点があるか
     ・その組織にどんな専門が集まっているか
     ・社内の誰がその組織と接点を持っているか
     ・その組織が、他のどの組織とつながっているか

   組織どうしのつながりは、所属者の関係から数えたものです。
   組織そのものの提携関係を登録しているわけではないので、その旨を画面に書いています。
   ============================================================================= */

const Orgs = (function () {

  const esc = UI.esc;
  const $ = UI.$;

  let selected = "";

  /* 画面が狭いかどうか。
     狭いときは一覧と詳細を並べられないので、
     組織を選んだら詳細だけの画面に切り替える。
     並べて出していると、下に出た詳細に気づけないため。 */
  const isNarrow = () => window.matchMedia("(max-width: 900px)").matches;

  function enter(orgId) {
    if (orgId !== undefined) selected = orgId;
    render();
  }

  function render() {
    const list = Storage.getOrganizations();
    const detailOnly = isNarrow() && Boolean(selected);

    // 狭い画面で組織を選んでいる間は、一覧を隠す
    $("orgs-layout").className = "orgs-layout" + (detailOnly ? " is-detail" : "");

    $("orgs-count").textContent = list.length
      ? list.length + " 組織・" + Storage.getPersons().length + " 名"
      : "";

    $("orgs-list").innerHTML = list.length
      ? list.map(rowHtml).join("")
      : '<div class="empty-box"><p>まだ組織がありません。</p>'
        + '<button class="btn" data-screen="capture">名刺を登録する</button></div>';

    $("orgs-detail").innerHTML = selected ? detailHtml(selected) : placeholderHtml();
    wire();
  }

  function rowHtml(o) {
    const d = Storage.getOrganizationDetail(o.id);
    return '<button class="orow' + (selected === o.id ? " is-current" : "") + '"'
      + ' data-org="' + o.id + '">'
      + '<span class="orow-name">' + esc(o.name) + "</span>"
      + '<span class="orow-meta">'
      +   o.count + " 名"
      +   (d && d.users.length ? "　／　社内の接点 " + d.users.length + " 人" : "　／　社内の接点なし")
      + "</span>"
      + "</button>";
  }

  function placeholderHtml() {
    return '<div class="empty-box"><p>左から組織を選んでください。</p></div>';
  }

  function detailHtml(orgId) {
    const d = Storage.getOrganizationDetail(orgId);
    if (!d) return placeholderHtml();

    return '<div class="odetail">'
      // 狭い画面のときだけ見える戻り口
      + '<button class="backlink orgs-back" id="orgs-back">← 組織一覧へもどる</button>'
      + '<h2 class="odetail-name">' + esc(d.org.name) + "</h2>"
      + '<div class="odetail-meta">'
      +   esc([d.org.industry, d.org.address].filter(Boolean).join("　／　") || "")
      + "</div>"

      /* 社内の接点 */
      + "<h3>社内でこの組織と接点がある人</h3>"
      + (d.users.length
        ? '<div class="chips" style="margin-bottom:14px">'
          + d.users.map((u) => '<span class="knows-chip">' + esc(u.name) + "</span>").join("")
          + "</div>"
        : '<p class="empty" style="margin-bottom:14px">ありません。</p>')

      /* 所属者 */
      + "<h3>登録されている人（" + d.members.length + "）</h3>"
      + '<div class="omembers">'
      +   d.members.map(function (p) {
            const sole = Storage.getUsersWhoKnow(p.id).length === 1;
            return '<button class="omember" data-screen="person" data-id="' + p.id + '">'
              + '<span class="omember-name">' + esc(p.name)
              +   (sole ? '<span class="sole-tag" title="社内で接点があるのは1人だけです">接点1人</span>' : "")
              + "</span>"
              + '<span class="omember-meta">'
              +   esc([p.department, p.job_title].filter(Boolean).join("　") || "　") + "</span>"
              + "</button>";
          }).join("")
      + "</div>"

      /* 専門分野 */
      + "<h3>この組織に集まっている専門</h3>"
      + (d.topics.length
        ? '<div class="chips" style="margin-bottom:14px">'
          + d.topics.map((t) => '<span class="chip">' + esc(t.name)
            + (t.count > 1 ? '<span class="chip-src">' + t.count + " 名</span>" : "")
            + "</span>").join("") + "</div>"
        : '<p class="empty" style="margin-bottom:14px">まだ登録されていません。</p>')

      /* つながっている組織 */
      + "<h3>つながっている組織</h3>"
      + '<p class="note lines" style="margin:-6px 0 10px">'
      +   "<span>所属している人どうしの関係から数えたものです。</span>"
      +   "<span>組織どうしの提携を登録しているわけではありません。</span>"
      + "</p>"
      + (d.linked.length
        ? '<div class="olinks">' + d.linked.map((l) =>
            '<button class="olink" data-org="' + l.id + '">' + esc(l.name)
            + '<span>' + l.count + " 件</span></button>").join("") + "</div>"
        : '<p class="empty">ありません。</p>')
      + "</div>";
  }

  function wire() {
    const back = $("orgs-back");
    if (back) back.addEventListener("click", function () {
      selected = "";
      render();
      window.scrollTo(0, 0);
    });

    ["orgs-list", "orgs-detail"].forEach(function (id) {
      $(id).querySelectorAll("[data-org]").forEach(function (b) {
        b.addEventListener("click", function (e) {
          e.stopPropagation();
          selected = b.dataset.org;
          render();
          if (isNarrow()) window.scrollTo(0, 0);
        });
      });
    });
  }

  // 画面の向きを変えたときに、並べ方が合わなくなるので描き直す
  window.addEventListener("resize", function () {
    if (!$("screen-orgs").hidden) render();
  });

  return { enter: enter };
})();