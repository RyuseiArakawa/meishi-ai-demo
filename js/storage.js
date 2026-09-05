/* =============================================================================
   データ保存

   いまはブラウザの中（localStorage）に保存しています。
   将来 PostgreSQL に移すときは、このファイルだけを書き換えれば済むように、
   保存の処理をここに集めてあります。

   テーブルの構成は設計書 §8 と同じです。
   Phase 1 では organizations / persons / business_cards の3つだけ使いますが、
   残りも空の状態で作っておきます（Phase 3以降で使います）。
   ============================================================================= */

const Storage = (function () {

  const KEY = "meishi_kg_v1";

  /* --- 空のデータベース ------------------------------------------------- */
  function emptyDB() {
    return {
      version: 1,
      organizations:  [],   // 組織
      persons:        [],   // 人物
      business_cards: [],   // 名刺
      relationships:  [],   // 人物同士の関係       … Phase 3
      interactions:   [],   // 交流の記録           … Phase 3
      topics:         [],   // 専門分野             … Phase 2
      person_topics:  [],   // 人物と専門の結びつき … Phase 2
    };
  }

  /* --- localStorage が使えるか確認 --------------------------------------- */
  let canUseStorage = true;
  try {
    localStorage.setItem("__test__", "1");
    localStorage.removeItem("__test__");
  } catch {
    canUseStorage = false;
  }

  let db = emptyDB();
  let lastError = "";

  function load() {
    if (!canUseStorage) return;
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) db = Object.assign(emptyDB(), JSON.parse(raw));
    } catch {
      db = emptyDB();
    }
  }

  function persist() {
    if (!canUseStorage) { lastError = ""; return true; }
    try {
      localStorage.setItem(KEY, JSON.stringify(db));
      lastError = "";
      return true;
    } catch {
      lastError = "保存できませんでした。ブラウザの保存容量（約5MB）がいっぱいです。"
                + "ダッシュボードでデータを書き出してから、古い名刺を削除してください。";
      return false;
    }
  }

  /* --- 部品 --------------------------------------------------------------- */

  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
      const r = (Math.random() * 16) | 0;
      return (c === "x" ? r : ((r & 0x3) | 0x8)).toString(16);
    });
  }

  const nowISO = () => new Date().toISOString();

  // 空文字やスペースだけの文字列は null にする
  function clean(v) {
    const s = String(v == null ? "" : v).trim();
    return s === "" ? null : s;
  }

  // 組織名のゆれを吸収する。
  // 「株式会社ABC」「(株)ABC」「ＡＢＣ」を同じ組織として扱うための下ごしらえ。
  function normalizeOrgName(s) {
    return String(s || "")
      .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
      .replace(/(株式会社|有限会社|合同会社|一般社団法人|公益財団法人|国立大学法人|独立行政法人)/g, "")
      .replace(/[（(]株[）)]|㈱|[（(]有[）)]|㈲/g, "")
      .replace(/[\s\u3000・,.，．]/g, "")
      .toLowerCase();
  }

  /* --- 組織 --------------------------------------------------------------- */

  // 同じ組織がすでにあればそのIDを返し、なければ新しく作る
  function findOrCreateOrganization(name) {
    const n = clean(name);
    if (!n) return null;

    const key = normalizeOrgName(n);
    const found = db.organizations.find((o) => normalizeOrgName(o.name) === key);
    if (found) return found.id;

    const org = {
      id: uuid(),
      name: n,
      industry: null,
      address: null,
      website: null,
      created_at: nowISO(),
      updated_at: nowISO(),
    };
    db.organizations.push(org);
    return org.id;
  }

  function getOrganizationName(id) {
    const o = db.organizations.find((x) => x.id === id);
    return o ? o.name : "";
  }

  /* --- 人物と名刺の登録 --------------------------------------------------- */

  /**
   * 確認画面の内容を、persons / organizations / business_cards の3つに分けて保存する。
   * @param {object} fields  確認画面で確定した項目
   * @param {string} imageDataUrl  名刺画像
   * @returns {{ok:boolean, personId:string, error:string}}
   */
  function savePerson(fields, imageDataUrl) {
    const name = clean(fields.name);
    if (!name) return { ok: false, personId: "", error: "氏名が空です。" };

    const person = {
      id: uuid(),
      name: name,
      name_kana: clean(fields.name_kana),
      organization_id: findOrCreateOrganization(fields.organization),
      department: clean(fields.department),
      job_title: clean(fields.job_title),
      email: clean(fields.email),
      phone: clean(fields.phone),
      fax: clean(fields.fax),
      address: clean(fields.address),
      website: clean(fields.website),
      notes: clean(fields.notes),
      created_at: nowISO(),
      updated_at: nowISO(),
    };
    db.persons.push(person);

    db.business_cards.push({
      id: uuid(),
      person_id: person.id,
      image_path: imageDataUrl || null,   // 本番ではファイルの置き場所を入れる
      ocr_text: JSON.stringify(fields),   // AIが読み取った元の内容を残しておく
      ocr_status: "confirmed",            // 人が確認済み
      created_at: nowISO(),
    });

    const ok = persist();
    return { ok: ok, personId: person.id, error: lastError };
  }

  // 同じ氏名の人がすでに登録されていないか調べる（登録前の注意表示に使う）
  function findByName(name) {
    const key = String(name || "").replace(/[\s\u3000]/g, "");
    if (!key) return [];
    return db.persons.filter(
      (p) => String(p.name).replace(/[\s\u3000]/g, "") === key
    );
  }

  /* --- 取り出し ----------------------------------------------------------- */

  const getAll = () => db;
  const getPersons = () => db.persons;
  const getPerson = (id) => db.persons.find((p) => p.id === id) || null;
  const getCardOf = (personId) =>
    db.business_cards.find((c) => c.person_id === personId) || null;

  function getStats() {
    return {
      persons: db.persons.length,
      organizations: db.organizations.length,
      cards: db.business_cards.length,
      bytes: new Blob([JSON.stringify(db)]).size,
    };
  }

  /* --- 書き出し・読み込み・削除 ------------------------------------------- */

  function exportJSON() {
    return JSON.stringify(db, null, 2);
  }

  function importJSON(text) {
    try {
      const incoming = JSON.parse(text);
      if (!incoming || !Array.isArray(incoming.persons)) {
        return { ok: false, error: "このファイルはこのシステムのデータではありません。" };
      }
      db = Object.assign(emptyDB(), incoming);
      return { ok: persist(), error: lastError };
    } catch {
      return { ok: false, error: "ファイルを読み取れませんでした。" };
    }
  }

  function clearAll() {
    db = emptyDB();
    return persist();
  }

  /* --- 外部に公開するもの ------------------------------------------------- */
  load();

  return {
    isPersistent: canUseStorage,
    getAll, getPersons, getPerson, getCardOf, getStats,
    getOrganizationName, findByName,
    savePerson,
    exportJSON, importJSON, clearAll,
  };
})();
