/* 版の番号。index.html と照らし合わせて、古いファイルが残っていないか確かめます。 */
(window.APP_BUILD = window.APP_BUILD || {})["maintain"] = 16;

/* =============================================================================
   整理（Phase 6）

     人物の重複        … 同じ人が別々に登録されているものを、ひとつにまとめる
     専門分野の表記ゆれ … 「旋盤」と「旋盤加工」のようなものを、ひとつにまとめる

   どちらも、システムが勝手にまとめることはしません。
   候補を挙げるところまでを機械が行い、まとめるかどうかは人が決めます。
   別人の同姓同名を勝手に統合すると、取り返しがつかないためです。
   ============================================================================= */

const Maintain = (function () {

  const esc = UI.esc;
  const $ = UI.$;

  let message = "";

  function enter() { render(); }

  function render() {
    const dupes = Storage.findPersonDuplicates();
    const topics = Storage.findTopicDuplicates();

    $("maintain-body").innerHTML =
        (message ? '<div class="alert alert-ok">' + esc(message) + "</div>" : "")

      /* ---- 人物の重複 ---- */
      + '<section class="block">'
      +   "<h3>同じ人物かもしれない組（" + dupes.length + "）</h3>"
      +   '<p class="note lines" style="margin:-6px 0 14px">'
      +     "<span>氏名かメールアドレスが一致するものを挙げています。</span>"
      +     "<span>同姓同名の別人である場合もあるので、内容を確かめてからまとめてください。</span>"
      +   "</p>"
      +   (dupes.length
          ? dupes.map(personGroupHtml).join("")
          : '<p class="empty">重複はありません。</p>')
      + "</section>"

      /* ---- 専門分野の表記ゆれ ---- */
      + '<section class="block">'
      +   "<h3>同じ意味かもしれない専門分野（" + topics.length + "）</h3>"
      +   '<p class="note lines" style="margin:-6px 0 14px">'
      +     "<span>文字が含まれ合うものを挙げています。</span>"
      +     "<span>別の意味であればまとめないでください（例：「加工」と「微細加工」）。</span>"
      +   "</p>"
      +   (topics.length
          ? topics.map(topicGroupHtml).join("")
          : '<p class="empty">表記ゆれはありません。</p>')
      + "</section>";

    wire();
  }

  /* --- 人物の組 ----------------------------------------------------------- */

  function personGroupHtml(group, gi) {
    return '<div class="mgroup" data-group="' + gi + '">'
      + '<div class="mgroup-head">まとめ先にする人を選んでください</div>'
      + group.map(function (p, i) {
          const org = Storage.getOrganizationName(p.organization_id);
          const who = Storage.getUsersWhoKnow(p.id);
          const topics = Storage.getTopicsOf(p.id);
          return '<label class="mrow">'
            + '<input type="radio" name="keep-' + gi + '" value="' + p.id + '"'
            +   (i === 0 ? " checked" : "") + ">"
            + '<span class="mrow-body">'
            +   '<span class="mrow-name">' + esc(p.name) + "</span>"
            +   '<span class="mrow-meta">'
            +     esc([org, p.department, p.job_title].filter(Boolean).join("　／　") || "所属情報なし")
            +   "</span>"
            +   '<span class="mrow-sub">'
            +     (p.email ? esc(p.email) + "　" : "")
            +     "名刺 " + (who.length ? esc(who.map((u) => u.name).join("・")) : "登録者なし")
            +     "　専門 " + topics.length + " 件"
            +     "　交流 " + Storage.getInteractionsOf(p.id).length + " 件"
            +     "　関係 " + Storage.getRelationshipsOf(p.id).length + " 件"
            +   "</span>"
            + "</span></label>";
        }).join("")
      + '<div class="mgroup-foot">'
      +   '<button class="btn btn-sm btn-primary" data-merge="' + gi + '">'
      +     "この " + group.length + " 件をまとめる</button>"
      +   '<span class="note">選ばなかった側の名刺・専門・交流・関係は、'
      +     "まとめ先へ引き継がれます。空欄は相手の値で埋まります。</span>"
      + "</div></div>";
  }

  /* --- 専門分野の組 -------------------------------------------------------- */

  function topicGroupHtml(group, gi) {
    return '<div class="mgroup" data-tgroup="' + gi + '">'
      + '<div class="mgroup-head">残す名前を選んでください</div>'
      + '<div class="tchoice">'
      +   group.map(function (t, i) {
            const n = Storage.getPersons()
              .filter((p) => Storage.getTopicsOf(p.id).some((x) => x.topic_id === t.id)).length;
            return '<label class="trow">'
              + '<input type="radio" name="tkeep-' + gi + '" value="' + t.id + '"'
              +   (i === 0 ? " checked" : "") + ">"
              + esc(t.name) + '<span class="trow-n">' + n + " 名</span></label>";
          }).join("")
      + "</div>"
      + '<div class="mgroup-foot">'
      +   '<button class="btn btn-sm" data-tmerge="' + gi + '">まとめる</button>'
      + "</div></div>";
  }

  /* --- 操作 --------------------------------------------------------------- */

  function wire() {
    const body = $("maintain-body");

    body.querySelectorAll("[data-merge]").forEach(function (b) {
      b.addEventListener("click", function () {
        const gi = Number(b.dataset.merge);
        const group = Storage.findPersonDuplicates()[gi];
        if (!group) return;

        const picked = body.querySelector('input[name="keep-' + gi + '"]:checked');
        const keepId = picked ? picked.value : group[0].id;
        const keep = Storage.getPerson(keepId);

        if (!confirm(
            group.length + " 件を「" + (keep ? keep.name : "") + "」にまとめます。\n\n"
          + "名刺・専門・交流・関係は引き継がれますが、この操作は元に戻せません。")) return;

        const r = Storage.mergePersons(keepId, group.map((p) => p.id));
        message = r.ok
          ? (r.merged + " 件をまとめました。")
          : (r.error || "まとめられませんでした。");
        render();
      });
    });

    body.querySelectorAll("[data-tmerge]").forEach(function (b) {
      b.addEventListener("click", function () {
        const gi = Number(b.dataset.tmerge);
        const group = Storage.findTopicDuplicates()[gi];
        if (!group) return;

        const picked = body.querySelector('input[name="tkeep-' + gi + '"]:checked');
        const keepId = picked ? picked.value : group[0].id;

        const r = Storage.mergeTopics(keepId, group.map((t) => t.id));
        message = r.ok ? (r.merged + " 件をまとめました。") : (r.error || "");
        render();
      });
    });
  }

  return { enter: enter };
})();