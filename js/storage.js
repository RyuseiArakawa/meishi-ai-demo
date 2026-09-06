/* =============================================================================
   データ保存

   いまはブラウザの中（localStorage）に保存しています。
   将来 PostgreSQL に移すときは、このファイルだけを書き換えれば済むように、
   保存の処理をここに集めてあります。

   テーブルの構成は設計書 §8 と同じです。
   Phase 2 では topics / person_topics / interactions も使い始めます。
   relationships（人物同士の関係）は Phase 3 で使います。
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
      interactions:   [],   // 交流の記録
      topics:         [],   // 専門分野
      person_topics:  [],   // 人物と専門の結びつき
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

  // 全角を半角にそろえ、記号と空白を落とす（検索・照合用）
  function fold(s) {
    return String(s || "")
      .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
      .replace(/[\s\u3000]/g, "")
      .toLowerCase();
  }

  // 組織名のゆれを吸収する。
  // 「株式会社ABC」「(株)ABC」「ＡＢＣ」を同じ組織として扱うための下ごしらえ。
  function normalizeOrgName(s) {
    return fold(s)
      .replace(/(株式会社|有限会社|合同会社|一般社団法人|公益財団法人|国立大学法人|独立行政法人)/g, "")
      .replace(/[（(]株[）)]|㈱|[（(]有[）)]|㈲/g, "")
      .replace(/[・,.，．]/g, "");
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
      id: uuid(), name: n, industry: null, address: null, website: null,
      created_at: nowISO(), updated_at: nowISO(),
    };
    db.organizations.push(org);
    return org.id;
  }

  function getOrganizationName(id) {
    const o = db.organizations.find((x) => x.id === id);
    return o ? o.name : "";
  }

  // 所属人数つきの組織一覧（人数の多い順）
  function getOrganizations() {
    return db.organizations
      .map((o) => ({
        ...o,
        count: db.persons.filter((p) => p.organization_id === o.id).length,
      }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "ja"));
  }

  // どの人物からも参照されなくなった組織を片づける
  function pruneOrganizations() {
    db.organizations = db.organizations.filter((o) =>
      db.persons.some((p) => p.organization_id === o.id)
    );
  }

  /* --- 人物の登録・更新・削除 --------------------------------------------- */

  const PERSON_FIELDS = [
    "name", "name_kana", "department", "job_title",
    "email", "phone", "fax", "address", "website", "notes",
  ];

  /**
   * 確認画面の内容を、persons / organizations / business_cards に分けて保存する。
   */
  function savePerson(fields, imageDataUrl) {
    const name = clean(fields.name);
    if (!name) return { ok: false, personId: "", error: "氏名が空です。" };

    const person = {
      id: uuid(),
      organization_id: findOrCreateOrganization(fields.organization),
      created_at: nowISO(),
      updated_at: nowISO(),
    };
    PERSON_FIELDS.forEach((k) => { person[k] = clean(fields[k]); });
    person.name = name;
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

  /** 人物詳細画面での編集を反映する */
  function updatePerson(id, fields) {
    const p = db.persons.find((x) => x.id === id);
    if (!p) return { ok: false, error: "この人物は見つかりません。" };

    const name = clean(fields.name);
    if (!name) return { ok: false, error: "氏名を空にはできません。" };

    PERSON_FIELDS.forEach((k) => {
      if (k in fields) p[k] = clean(fields[k]);
    });
    p.name = name;

    if ("organization" in fields) {
      p.organization_id = findOrCreateOrganization(fields.organization);
      pruneOrganizations();
    }
    p.updated_at = nowISO();

    return { ok: persist(), error: lastError };
  }

  /** 人物と、その人に紐づく名刺・専門・交流・関係をまとめて消す */
  function deletePerson(id) {
    db.persons = db.persons.filter((x) => x.id !== id);
    db.business_cards = db.business_cards.filter((x) => x.person_id !== id);
    db.person_topics = db.person_topics.filter((x) => x.person_id !== id);
    db.interactions = db.interactions.filter((x) => x.person_id !== id);
    db.relationships = db.relationships.filter(
      (x) => x.from_person_id !== id && x.to_person_id !== id
    );
    pruneOrganizations();
    pruneTopics();
    return persist();
  }

  /* --- 人物の取り出しと検索 ----------------------------------------------- */

  const getPersons = () => db.persons;
  const getPerson = (id) => db.persons.find((p) => p.id === id) || null;
  const getCardOf = (personId) =>
    db.business_cards.find((c) => c.person_id === personId) || null;

  // 同じ氏名の人がすでにいないか（登録前の注意表示に使う）
  function findByName(name) {
    const key = fold(name);
    if (!key) return [];
    return db.persons.filter((p) => fold(p.name) === key);
  }

  // 同じ組織に登録されている、ほかの人物
  function getColleagues(personId) {
    const p = getPerson(personId);
    if (!p || !p.organization_id) return [];
    return db.persons.filter(
      (x) => x.id !== personId && x.organization_id === p.organization_id
    );
  }

  /**
   * 人物を検索する。
   * 氏名・ふりがな・組織・部署・役職・メール・専門分野を横断して探す。
   * @param query    検索語（空なら全件）
   * @param orgId    組織で絞り込む場合はそのID
   * @param sort     "name" | "new" | "org"
   */
  function searchPersons(query, orgId, sort) {
    const q = fold(query);
    let list = db.persons.slice();

    if (orgId) list = list.filter((p) => p.organization_id === orgId);

    if (q) {
      list = list.filter(function (p) {
        const bag = [
          p.name, p.name_kana, getOrganizationName(p.organization_id),
          p.department, p.job_title, p.email, p.phone, p.address, p.notes,
        ].concat(getTopicsOf(p.id).map((t) => t.name)).join(" ");
        return fold(bag).includes(q);
      });
    }

    if (sort === "new") {
      list.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    } else if (sort === "org") {
      list.sort((a, b) =>
        collator.compare(getOrganizationName(a.organization_id),
                         getOrganizationName(b.organization_id))
        || collator.compare(readingOf(a), readingOf(b)));
    } else {
      list.sort((a, b) => collator.compare(readingOf(a), readingOf(b)));
    }
    return list;
  }

  /* 日本語の並び替え。
     ひらがなとカタカナの違いは無視して同じものとして扱う。 */
  const collator = new Intl.Collator("ja", { sensitivity: "base", numeric: true });

  /* 並び替えに使う読み。
     ふりがなが登録されていればそれを、無ければ漢字をそのまま使う。
     漢字には読み方の情報がないため、この場合は文字コードの順になる。 */
  function readingOf(p) {
    const kana = String(p.name_kana || "").trim();
    return kana || String(p.name || "");
  }

  /** ふりがなが未登録の人数（画面で理由を説明するために使う） */
  function countWithoutKana(list) {
    return (list || db.persons).filter(
      (p) => !String(p.name_kana || "").trim()
    ).length;
  }

  /* --- 専門分野（topics / person_topics） --------------------------------- */

  function getTopicsOf(personId) {
    return db.person_topics
      .filter((pt) => pt.person_id === personId)
      .map(function (pt) {
        const t = db.topics.find((x) => x.id === pt.topic_id);
        return { topic_id: pt.topic_id, name: t ? t.name : "?", source: pt.source };
      });
  }

  /** 専門分野を1つ足す。source は「どこで知ったか」の記録（設計書§20 SOURCE） */
  function addTopicTo(personId, name, source) {
    const n = clean(name);
    if (!n) return { ok: false, error: "専門分野が空です。" };

    let t = db.topics.find((x) => fold(x.name) === fold(n));
    if (!t) {
      t = { id: uuid(), name: n, description: null };
      db.topics.push(t);
    }
    const exists = db.person_topics.some(
      (pt) => pt.person_id === personId && pt.topic_id === t.id
    );
    if (exists) return { ok: true, error: "" };

    db.person_topics.push({
      person_id: personId,
      topic_id: t.id,
      confidence: 1,                       // 人が入力した情報なので 1
      source: clean(source) || "手入力",
    });
    return { ok: persist(), error: lastError };
  }

  function removeTopicFrom(personId, topicId) {
    db.person_topics = db.person_topics.filter(
      (pt) => !(pt.person_id === personId && pt.topic_id === topicId)
    );
    pruneTopics();
    return persist();
  }

  // どの人物にも結びついていない専門分野を片づける
  function pruneTopics() {
    db.topics = db.topics.filter((t) =>
      db.person_topics.some((pt) => pt.topic_id === t.id)
    );
  }

  // 入力候補に使う、登録済みの専門分野一覧
  const getAllTopics = () =>
    db.topics.slice().sort((a, b) => a.name.localeCompare(b.name, "ja"));

  /* --- 交流の記録（interactions） ----------------------------------------- */

  function getInteractionsOf(personId) {
    return db.interactions
      .filter((i) => i.person_id === personId)
      .sort((a, b) => String(b.occurred_at || "").localeCompare(String(a.occurred_at || "")));
  }

  function addInteraction(personId, data) {
    const hasSomething = clean(data.event_name) || clean(data.summary) ||
                         clean(data.location) || clean(data.occurred_at);
    if (!hasSomething) return { ok: false, error: "記録する内容がありません。" };

    db.interactions.push({
      id: uuid(),
      person_id: personId,
      occurred_at: clean(data.occurred_at) ? data.occurred_at + "T00:00:00Z" : null,
      location: clean(data.location),
      event_name: clean(data.event_name),
      summary: clean(data.summary),
      created_at: nowISO(),
    });
    return { ok: persist(), error: lastError };
  }

  function removeInteraction(id) {
    db.interactions = db.interactions.filter((i) => i.id !== id);
    return persist();
  }

  /* --- 人物同士の関係（relationships）― Phase 3 ------------------------------

     設計書 §9 の指示にしたがい、関係は「人が登録した事実」だけを持ちます。
     ・同じ組織にいる、同じ学会に出た、といった事実から関係を自動生成しない
     ・関係の強さをシステムが推測しない（人が選ぶ）
     ・どこで知った情報かを必ず残す（source）
     -------------------------------------------------------------------------- */

  // 関係の種類。directed が true のものは「向き」に意味がある。
  const RELATIONSHIP_TYPES = [
    { value: "card_exchange",   label: "名刺交換",   directed: false },
    { value: "colleague",       label: "同僚",       directed: false },
    { value: "joint_research",  label: "共同研究",   directed: false },
    { value: "same_conference", label: "同じ学会",   directed: false },
    { value: "business",        label: "取引関係",   directed: false },
    { value: "introduction",    label: "紹介",       directed: true  },
    { value: "mentorship",      label: "指導関係",   directed: true  },
    { value: "other",           label: "その他",     directed: false },
  ];

  function relationshipLabel(type) {
    const t = RELATIONSHIP_TYPES.find((x) => x.value === type);
    return t ? t.label : type;
  }
  function isDirected(type) {
    const t = RELATIONSHIP_TYPES.find((x) => x.value === type);
    return t ? t.directed : false;
  }

  /**
   * ある人物にひもづく関係をすべて返す。
   * 相手がどちらの側にいても拾い、この人物から見た向きを添える。
   *   direction "out" … この人物が起点（from）
   *   direction "in"  … 相手が起点（to がこの人物）
   */
  function getRelationshipsOf(personId) {
    return db.relationships
      .filter((r) => r.from_person_id === personId || r.to_person_id === personId)
      .map(function (r) {
        const out = r.from_person_id === personId;
        return Object.assign({}, r, {
          direction: out ? "out" : "in",
          other_id: out ? r.to_person_id : r.from_person_id,
        });
      })
      .sort((a, b) => (b.strength || 0) - (a.strength || 0));
  }

  /** 2人の間にすでに登録されている関係（種類は問わない） */
  function findRelationshipBetween(a, b, type) {
    return db.relationships.find((r) =>
      ((r.from_person_id === a && r.to_person_id === b) ||
       (r.from_person_id === b && r.to_person_id === a)) &&
      (type ? r.relationship_type === type : true)
    ) || null;
  }

  function addRelationship(fromId, toId, type, strength, source, notes) {
    if (!fromId || !toId) return { ok: false, error: "相手を選んでください。" };
    if (fromId === toId) return { ok: false, error: "同じ人物どうしの関係は登録できません。" };
    if (!type) return { ok: false, error: "関係の種類を選んでください。" };

    const s = Number(strength);
    if (!(s >= 1 && s <= 5)) {
      return { ok: false, error: "関係の強さを選んでください。システムは推測しません。" };
    }
    if (!clean(source)) {
      return { ok: false, error: "根拠を入力してください。どこで知った情報かを残します。" };
    }
    if (findRelationshipBetween(fromId, toId, type)) {
      return { ok: false, error: "この2人には、同じ種類の関係がすでに登録されています。" };
    }

    db.relationships.push({
      id: uuid(),
      from_person_id: fromId,
      to_person_id: toId,
      relationship_type: type,
      strength: s,
      source: clean(source),
      notes: clean(notes),
      created_at: nowISO(),
    });
    return { ok: persist(), error: lastError };
  }

  function removeRelationship(id) {
    db.relationships = db.relationships.filter((r) => r.id !== id);
    return persist();
  }

  /** 向きを入れ替える（「指導した／指導を受けた」を直すときに使う） */
  function flipRelationship(id) {
    const r = db.relationships.find((x) => x.id === id);
    if (!r) return false;
    const tmp = r.from_person_id;
    r.from_person_id = r.to_person_id;
    r.to_person_id = tmp;
    return persist();
  }

  /* --- 集計 --------------------------------------------------------------- */

  function getStats() {
    return {
      persons: db.persons.length,
      organizations: db.organizations.length,
      cards: db.business_cards.length,
      topics: db.topics.length,
      interactions: db.interactions.length,
      relationships: db.relationships.length,
      bytes: new Blob([JSON.stringify(db)]).size,
    };
  }

  /* --- 書き出し・読み込み・削除 ------------------------------------------- */

  const exportJSON = () => JSON.stringify(db, null, 2);

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
    getAll: () => db,

    // 人物
    getPersons, getPerson, getCardOf, searchPersons,
    savePerson, updatePerson, deletePerson,
    findByName, getColleagues, countWithoutKana,

    // 組織
    getOrganizationName, getOrganizations,

    // 専門分野
    getTopicsOf, addTopicTo, removeTopicFrom, getAllTopics,

    // 交流
    getInteractionsOf, addInteraction, removeInteraction,

    // 人物同士の関係（Phase 3）
    RELATIONSHIP_TYPES, relationshipLabel, isDirected,
    getRelationshipsOf, findRelationshipBetween,
    addRelationship, removeRelationship, flipRelationship,

    // その他
    getStats, exportJSON, importJSON, clearAll,
  };
})();