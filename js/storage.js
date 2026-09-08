/* 版の番号。index.html と照らし合わせて、古いファイルが残っていないか確かめます。 */
(window.APP_BUILD = window.APP_BUILD || {})["storage"] = 18;

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
      users:          [],   // このシステムの利用者（社内の人）
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

  /* --- 共有データベース（スプレッドシート）との対応 -------------------------

     シートの名前と、このファイルの中での呼び方の対応表です。
     Remote に渡すときはシートの名前に、受け取るときは元に戻します。
     -------------------------------------------------------------------------- */

  const SHEET_OF = {
    users: "Users", organizations: "Organizations", persons: "Persons",
    business_cards: "BusinessCards", relationships: "Relationships",
    interactions: "Interactions", topics: "Topics", person_topics: "PersonTopics",
  };
  const LOCAL_OF = {};
  Object.keys(SHEET_OF).forEach((k) => { LOCAL_OF[SHEET_OF[k]] = k; });

  let sharedMode = false;      // スプレッドシートを使っているか

  /** 変更した行を、共有データベースへ送る */
  function push(table, rows) {
    if (!sharedMode || !rows || !rows.length) return;
    try { Remote.upsert(SHEET_OF[table], rows); } catch (e) {}
  }
  function drop(table, keys) {
    if (!sharedMode || !keys || !keys.length) return;
    try { Remote.remove(SHEET_OF[table], keys); } catch (e) {}
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

  /* 日本語の並び替え。ひらがなとカタカナの違いは無視して同じものとして扱う。 */
  const collator = new Intl.Collator("ja", { sensitivity: "base", numeric: true });

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
    push("organizations", [org]);
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

    const card = {
      id: uuid(),
      person_id: person.id,
      owner_user_id: currentUserId,       // ★誰が交換した名刺か
      image_path: imageDataUrl || null,   // 画面表示用（共有時はドライブへ送る）
      image_file_id: null,                // ドライブでの置き場所
      ocr_text: JSON.stringify(fields),   // AIが読み取った元の内容を残しておく
      ocr_status: "confirmed",            // 人が確認済み
      created_at: nowISO(),
    };
    db.business_cards.push(card);

    const ok = persist();
    push("persons", [person]);
    push("business_cards", [card]);
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

    const ok = persist();
    push("persons", [p]);
    return { ok: ok, error: lastError };
  }

  /** 人物と、その人に紐づく名刺・専門・交流・関係をまとめて消す */
  function deletePerson(id) {
    // 共有データベースからも消すため、消す前に対象を控えておく
    const cards = db.business_cards.filter((x) => x.person_id === id);
    const topics = db.person_topics.filter((x) => x.person_id === id);
    const logs = db.interactions.filter((x) => x.person_id === id);
    const rels = db.relationships.filter(
      (x) => x.from_person_id === id || x.to_person_id === id);

    db.persons = db.persons.filter((x) => x.id !== id);
    db.business_cards = db.business_cards.filter((x) => x.person_id !== id);
    db.person_topics = db.person_topics.filter((x) => x.person_id !== id);
    db.interactions = db.interactions.filter((x) => x.person_id !== id);
    db.relationships = db.relationships.filter(
      (x) => x.from_person_id !== id && x.to_person_id !== id
    );
    pruneOrganizations();
    pruneTopics();

    const ok = persist();
    drop("persons", [{ id: id }]);
    drop("business_cards", cards.map((x) => ({ id: x.id })));
    drop("person_topics", topics.map((x) => ({ person_id: x.person_id, topic_id: x.topic_id })));
    drop("interactions", logs.map((x) => ({ id: x.id })));
    drop("relationships", rels.map((x) => ({ id: x.id })));
    return ok;
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
    let isNew = false;
    if (!t) {
      t = { id: uuid(), name: n, description: null };
      db.topics.push(t);
      isNew = true;
    }
    const exists = db.person_topics.some(
      (pt) => pt.person_id === personId && pt.topic_id === t.id
    );
    if (exists) return { ok: true, error: "" };

    const link = {
      person_id: personId,
      topic_id: t.id,
      confidence: 1,                       // 人が入力した情報なので 1
      source: clean(source) || "手入力",
      created_by_user_id: currentUserId,   // 誰が登録した情報か
    };
    db.person_topics.push(link);

    const ok = persist();
    if (isNew) push("topics", [t]);
    push("person_topics", [link]);
    return { ok: ok, error: lastError };
  }

  function removeTopicFrom(personId, topicId) {
    db.person_topics = db.person_topics.filter(
      (pt) => !(pt.person_id === personId && pt.topic_id === topicId)
    );
    pruneTopics();
    const ok = persist();
    drop("person_topics", [{ person_id: personId, topic_id: topicId }]);
    return ok;
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

    const log = {
      id: uuid(),
      person_id: personId,
      owner_user_id: currentUserId,        // 誰が記録したか
      occurred_at: clean(data.occurred_at) ? data.occurred_at + "T00:00:00Z" : null,
      location: clean(data.location),
      event_name: clean(data.event_name),
      summary: clean(data.summary),
      created_at: nowISO(),
    };
    db.interactions.push(log);

    const ok = persist();
    push("interactions", [log]);
    return { ok: ok, error: lastError };
  }

  function removeInteraction(id) {
    db.interactions = db.interactions.filter((i) => i.id !== id);
    const ok = persist();
    drop("interactions", [{ id: id }]);
    return ok;
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

    const rel = {
      id: uuid(),
      from_person_id: fromId,
      to_person_id: toId,
      relationship_type: type,
      strength: s,
      source: clean(source),
      notes: clean(notes),
      created_by_user_id: currentUserId,   // 誰が登録したか
      created_at: nowISO(),
    };
    db.relationships.push(rel);

    const ok = persist();
    push("relationships", [rel]);
    return { ok: ok, error: lastError };
  }

  function removeRelationship(id) {
    db.relationships = db.relationships.filter((r) => r.id !== id);
    const ok = persist();
    drop("relationships", [{ id: id }]);
    return ok;
  }

  /** 向きを入れ替える（「指導した／指導を受けた」を直すときに使う） */
  function flipRelationship(id) {
    const r = db.relationships.find((x) => x.id === id);
    if (!r) return false;
    const tmp = r.from_person_id;
    r.from_person_id = r.to_person_id;
    r.to_person_id = tmp;
    const ok = persist();
    push("relationships", [r]);
    return ok;
  }

  /* --- AI検索のための検索関数（Phase 5）― 設計書 §14 -------------------------

     AIにデータベースを直接触らせないため、決まった形の検索だけを用意します。
     AIから受け取るのは「検索語」だけで、実際に探すのはこの関数です。
     -------------------------------------------------------------------------- */

  /** 専門分野から人物を探す（search_people_by_topic） */
  function searchPeopleByTopic(keyword) {
    const k = fold(keyword);
    if (!k) return [];
    const hits = [];
    db.person_topics.forEach(function (pt) {
      const t = db.topics.find((x) => x.id === pt.topic_id);
      if (!t || !fold(t.name).includes(k)) return;
      const p = getPerson(pt.person_id);
      if (p) hits.push({ person: p, topic: t.name, source: pt.source, via: "専門分野" });
    });
    return hits;
  }

  /** 所属・部署・役職・氏名から人物を探す（search_people_by_attribute） */
  function searchPeopleByAttribute(keyword) {
    const k = fold(keyword);
    if (!k) return [];
    return db.persons.filter(function (p) {
      const bag = [p.name, p.name_kana, getOrganizationName(p.organization_id),
                   p.department, p.job_title].join(" ");
      return fold(bag).includes(k);
    }).map((p) => ({ person: p, via: "所属・氏名" }));
  }

  /** 交流の記録から人物を探す（search_interactions） */
  function searchPeopleByInteraction(keyword) {
    const k = fold(keyword);
    if (!k) return [];
    const hits = [];
    db.interactions.forEach(function (i) {
      const bag = [i.event_name, i.location, i.summary].join(" ");
      if (!fold(bag).includes(k)) return;
      const p = getPerson(i.person_id);
      if (p) hits.push({ person: p, via: "交流の記録" });
    });
    return hits;
  }

  /**
   * AIが取り出した検索語で、上の関数をまとめて呼ぶ。
   * @param keywords     専門分野・組織などの語
   * @param personNames  質問に出てきた人物名
   * @param expand       見つかった人物と関係のある人も含めるか
   * @returns {{ids:string[], trace:object[]}}  ids = 見つかった人物、trace = 検索の記録
   */
  function runSearch(keywords, personNames, expand) {
    const found = {};        // person_id → 見つかった理由
    const trace = [];

    (personNames || []).forEach(function (name) {
      const hits = searchPeopleByAttribute(name);
      trace.push({ fn: "search_people_by_attribute", arg: name, count: hits.length });
      hits.forEach((h) => { found[h.person.id] = found[h.person.id] || "氏名の一致"; });
    });

    (keywords || []).forEach(function (kw) {
      const t = searchPeopleByTopic(kw);
      trace.push({ fn: "search_people_by_topic", arg: kw, count: t.length });
      t.forEach((h) => { found[h.person.id] = "専門分野「" + h.topic + "」"; });

      const a = searchPeopleByAttribute(kw);
      trace.push({ fn: "search_people_by_attribute", arg: kw, count: a.length });
      a.forEach((h) => { found[h.person.id] = found[h.person.id] || "所属・氏名の一致"; });

      const i = searchPeopleByInteraction(kw);
      trace.push({ fn: "search_interactions", arg: kw, count: i.length });
      i.forEach((h) => { found[h.person.id] = found[h.person.id] || "交流の記録"; });
    });

    // 人物名で引いた場合は、その人とつながっている人も材料に加える
    if (expand) {
      Object.keys(found).slice(0, 4).forEach(function (id) {
        const rels = getRelationshipsOf(id);
        trace.push({ fn: "search_relationships", arg: (getPerson(id) || {}).name, count: rels.length });
        rels.forEach(function (r) {
          if (!found[r.other_id]) {
            found[r.other_id] = "「" + (getPerson(id) || {}).name + "」との関係";
          }
        });
      });
    }

    return { ids: Object.keys(found), reasons: found, trace: trace };
  }

  /**
   * AIに渡す材料を組み立てる。
   *
   * 設計書 §21「LLMには不要な個人情報を渡さない」にしたがい、
   * メールアドレス・電話番号・住所は含めません。
   * 人物を探すのに必要なのは、所属と専門と関係だけです。
   */
  function buildAIContext(ids, limit) {
    return (ids || []).slice(0, limit || 12).map(function (id) {
      const p = getPerson(id);
      if (!p) return null;
      return {
        person_id: p.id,
        name: p.name,
        organization: getOrganizationName(p.organization_id) || null,
        department: p.department,
        job_title: p.job_title,
        topics: getTopicsOf(p.id).map((t) => ({ name: t.name, source: t.source })),
        relations: getRelationshipsOf(p.id).map(function (r) {
          const o = getPerson(r.other_id);
          return {
            other_person_id: r.other_id,
            other_name: o ? o.name : null,
            type: relationshipLabel(r.relationship_type),
            strength: r.strength,
            source: r.source,
            notes: r.notes,
          };
        }),
        interactions: getInteractionsOf(p.id).map((i) => ({
          date: String(i.occurred_at || "").slice(0, 10) || null,
          event: i.event_name, place: i.location, summary: i.summary,
        })),
      };
    }).filter(Boolean);
  }

  /* --- 利用者（社内でこのシステムを使う人）--------------------------------

     設計書の relationships が「外部の人どうし」を記録するのに対し、
     こちらは「社内の誰が、その名刺を交換したか」を記録するためのものです。
     人脈グラフで「この人と接点があるのは社内の誰か」を出すのに使います。

     これは本格的な認証ではありません。誰として使うかを自分で選ぶ仕組みです。
     実運用では、設計書 §21 のとおり認証が必要です。
     -------------------------------------------------------------------------- */

  const USER_KEY = "meishi_current_user_v1";
  let currentUserId = null;

  function loadCurrentUser() {
    try { currentUserId = localStorage.getItem(USER_KEY) || null; } catch { currentUserId = null; }
  }

  const getUsers = () =>
    db.users.slice().sort((a, b) => collator.compare(a.name || "", b.name || ""));

  const getUser = (id) => db.users.find((u) => u.id === id) || null;
  const getCurrentUserId = () => currentUserId;
  const getCurrentUser = () => getUser(currentUserId);

  function setCurrentUser(id) {
    currentUserId = id || null;
    try {
      if (currentUserId) localStorage.setItem(USER_KEY, currentUserId);
      else localStorage.removeItem(USER_KEY);
    } catch (e) {}
    return currentUserId;
  }

  function addUser(name, email, note) {
    const n = clean(name);
    if (!n) return { ok: false, error: "名前を入力してください。" };

    const already = db.users.find((u) => fold(u.name) === fold(n));
    if (already) return { ok: true, id: already.id, error: "" };

    const user = {
      id: uuid(), name: n, email: clean(email), note: clean(note),
      created_at: nowISO(),
    };
    db.users.push(user);
    const ok = persist();
    push("users", [user]);
    return { ok: ok, id: user.id, error: lastError };
  }

  /** その名刺を交換した社内の人 */
  function getCardOwner(personId) {
    const c = getCardOf(personId);
    return c && c.owner_user_id ? getUser(c.owner_user_id) : null;
  }

  /** ある利用者が名刺を交換した相手（＝接点のある人物） */
  function getContactsOfUser(userId) {
    return db.business_cards
      .filter((c) => c.owner_user_id === userId)
      .map((c) => getPerson(c.person_id))
      .filter(Boolean);
  }

  /** ある人物と接点がある社内の人（「誰に聞けばよいか」の答え） */
  function getUsersWhoKnow(personId) {
    const ids = {};
    db.business_cards.forEach(function (c) {
      if (c.person_id === personId && c.owner_user_id) ids[c.owner_user_id] = true;
    });
    return Object.keys(ids).map(getUser).filter(Boolean);
  }


  /* --- 共有データベースからの読み込み ------------------------------------- */

  /** スプレッドシートを使う状態にする */
  function enableShared(on) { sharedMode = on !== false; }
  const isShared = () => sharedMode;

  /**
   * スプレッドシートから読み込んで、手元のデータを入れ替える。
   * 画像そのものはシートに入っていないため、image_path は空のままです
   * （表示するときに、必要な分だけ取り出します）。
   */
  function applyRemote(data) {
    const next = emptyDB();
    Object.keys(data || {}).forEach(function (sheetName) {
      const local = LOCAL_OF[sheetName];
      if (!local) return;
      next[local] = Array.isArray(data[sheetName]) ? data[sheetName] : [];
    });

    // すでに取り出してある画像は、端末には戻さず、その場の控えとして持ち直す。
    // （保存領域を使わずに、表示だけは速いまま）
    db.business_cards.forEach(function (c) {
      if (c.image_path && c.image_file_id && typeof Remote !== "undefined") {
        Remote.cacheImage(c.image_file_id, c.image_path);
      }
    });

    db = next;
    persist();
    return getStats();
  }

  /**
   * 手元にあるデータを、まとめてスプレッドシートへ送る。
   * JSONを読み込んだあとに使います（読み込みだけでは手元にしか入らないため）。
   */
  function pushAll() {
    if (!sharedMode) {
      return { ok: false, error: "スプレッドシートとつながっていません。" };
    }
    let count = 0;
    Object.keys(SHEET_OF).forEach(function (local) {
      const rows = db[local];
      if (rows && rows.length) { push(local, rows); count += rows.length; }
    });
    return { ok: true, count: count };
  }

  /**
   * 画像をドライブへ送ったあと、その置き場所を控える。
   *
   * 共有しているときは、送り終えた画像をこの端末から消します。
   * 名刺画像は容量のほとんどを占めるため、端末に置き続けると
   * ブラウザの保存領域（約5MB）をすぐ使い切ってしまうためです。
   * 表示するときは、そのつどドライブから取り出します。
   */
  function noteCardImageId(cardId, fileId) {
    const c = db.business_cards.find((x) => x.id === cardId);
    if (!c) return;
    c.image_file_id = c.image_file_id || fileId;
    const keep = typeof Settings !== "undefined" && Settings.get("keepImages");
    if (sharedMode && c.image_file_id && !keep) c.image_path = null;
    persist();
  }

  /** この端末に残っている名刺画像を、まとめて手放す */
  function releaseLocalImages() {
    let n = 0;
    db.business_cards.forEach(function (c) {
      if (c.image_path && c.image_file_id) {
        if (typeof Remote !== "undefined") Remote.cacheImage(c.image_file_id, c.image_path);
        c.image_path = null;
        n++;
      }
    });
    if (n) persist();
    return n;
  }

  /* --- つながりの経路をさがす（AIチャットとグラフで共用）--------------------

     人物どうしの関係に加えて、「社内の誰がその名刺を持っているか」も
     つながりとして扱います。社内の人のIDは "U:" で始めます。
     -------------------------------------------------------------------------- */

  function buildAdjacency(includeUsers) {
    const adj = {};
    const add = (a, b) => { (adj[a] = adj[a] || []).push(b); };

    db.relationships.forEach(function (r) {
      add(r.from_person_id, r.to_person_id);
      add(r.to_person_id, r.from_person_id);
    });

    if (includeUsers !== false) {
      db.business_cards.forEach(function (c) {
        if (!c.owner_user_id || !c.person_id) return;
        add("U:" + c.owner_user_id, c.person_id);
        add(c.person_id, "U:" + c.owner_user_id);
      });
    }
    return adj;
  }

  /**
   * 2者の間の、いちばん短い道筋を返す。
   * 見つからなければ null。
   */
  function findConnectionPath(fromId, toId, includeUsers) {
    if (!fromId || !toId || fromId === toId) return null;

    const adj = buildAdjacency(includeUsers);
    const prev = {}, seen = {}, queue = [fromId];
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

  /** ID（"U:..." を含む）から表示名を引く */
  function displayName(id) {
    if (String(id).indexOf("U:") === 0) {
      const u = getUser(String(id).slice(2));
      return u ? u.name : "?";
    }
    const p = getPerson(id);
    return p ? p.name : "?";
  }

  /** 2者の間に直接登録されている関係（種類と強さ） */
  function relationBetween(a, b) {
    const r = findRelationshipBetween(a, b);
    if (r) {
      return { label: relationshipLabel(r.relationship_type), strength: r.strength,
               source: r.source };
    }
    // 名刺の登録記録によるつながりか
    const ua = String(a).indexOf("U:") === 0 ? String(a).slice(2) : null;
    const ub = String(b).indexOf("U:") === 0 ? String(b).slice(2) : null;
    const owner = ua || ub;
    const person = ua ? b : a;
    if (owner && db.business_cards.some(
        (c) => c.owner_user_id === owner && c.person_id === person)) {
      return { label: "名刺交換", strength: null, source: "名刺の登録記録" };
    }
    return null;
  }

  /* --- 同じ人物をひとつにまとめる（名寄せ）--------------------------------

     いまの作りでは、名刺を登録するたびに別の人物として記録されます。
     複数人で使うと、同じ相手が何件も並ぶことになります。
     ここでは、同じ人物らしい組を見つけ、人が確認したうえでまとめます。
     -------------------------------------------------------------------------- */

  /** 同じ人物らしい組をさがす。判断はせず、候補を返すだけ。 */
  function findPersonDuplicates() {
    const byKey = {};
    const link = {};                     // 人物ID → まとめ先のID

    function join(a, b) {
      const ra = root(a), rb = root(b);
      if (ra !== rb) link[rb] = ra;
    }
    function root(x) {
      while (link[x] && link[x] !== x) x = link[x];
      return x;
    }

    db.persons.forEach(function (p) {
      link[p.id] = link[p.id] || p.id;

      // 氏名が同じ
      const nk = "n:" + fold(p.name);
      if (byKey[nk]) join(byKey[nk], p.id); else byKey[nk] = p.id;

      // メールアドレスが同じ（氏名が違っても同一人物とみなせる手がかり）
      if (p.email) {
        const ek = "e:" + fold(p.email);
        if (byKey[ek]) join(byKey[ek], p.id); else byKey[ek] = p.id;
      }
    });

    const groups = {};
    db.persons.forEach(function (p) {
      const r = root(p.id);
      (groups[r] = groups[r] || []).push(p);
    });

    return Object.keys(groups)
      .map((k) => groups[k])
      .filter((g) => g.length > 1)
      .sort((a, b) => b.length - a.length);
  }

  /**
   * 複数の人物を1件にまとめる。
   * 名刺・専門・交流・関係は、すべて残す方へ付け替えます。
   * 残す側で空になっている項目は、消す側の値で埋めます。
   */
  function mergePersons(keepId, dropIds) {
    const keep = getPerson(keepId);
    if (!keep) return { ok: false, error: "まとめ先の人物が見つかりません。" };

    const drops = (dropIds || []).filter((id) => id !== keepId && getPerson(id));
    if (!drops.length) return { ok: false, error: "まとめる相手がいません。" };

    const removedTopicKeys = [];
    const changedCards = [], changedLogs = [];

    drops.forEach(function (id) {
      const p = getPerson(id);

      // 空欄を埋める（すでに入っている値は上書きしない）
      PERSON_FIELDS.forEach(function (k) {
        if (!keep[k] && p[k]) keep[k] = p[k];
      });
      if (!keep.organization_id && p.organization_id) keep.organization_id = p.organization_id;

      db.business_cards.forEach(function (c) {
        if (c.person_id === id) { c.person_id = keepId; changedCards.push(c); }
      });
      db.interactions.forEach(function (i) {
        if (i.person_id === id) { i.person_id = keepId; changedLogs.push(i); }
      });
      db.person_topics.forEach(function (pt) {
        if (pt.person_id === id) {
          removedTopicKeys.push({ person_id: id, topic_id: pt.topic_id });
          pt.person_id = keepId;
        }
      });
      db.relationships.forEach(function (r) {
        if (r.from_person_id === id) r.from_person_id = keepId;
        if (r.to_person_id === id) r.to_person_id = keepId;
      });
    });

    // 同じ専門が二重にならないようにする
    const seenT = {};
    const keptTopics = [];
    db.person_topics = db.person_topics.filter(function (pt) {
      const k = pt.person_id + "|" + pt.topic_id;
      if (seenT[k]) return false;
      seenT[k] = true;
      if (pt.person_id === keepId) keptTopics.push(pt);
      return true;
    });

    // 自分自身との関係と、同じ相手・同じ種類の重複を取り除く
    const removedRels = [];
    const seenR = {};
    db.relationships = db.relationships.filter(function (r) {
      if (r.from_person_id === r.to_person_id) { removedRels.push(r); return false; }
      const k = [r.from_person_id, r.to_person_id].sort().join("|") + "|" + r.relationship_type;
      if (seenR[k]) { removedRels.push(r); return false; }
      seenR[k] = true;
      return true;
    });
    const keptRels = db.relationships.filter(
      (r) => r.from_person_id === keepId || r.to_person_id === keepId);

    db.persons = db.persons.filter((x) => drops.indexOf(x.id) < 0);
    keep.updated_at = nowISO();
    pruneOrganizations();

    const ok = persist();

    // 共有データベースにも反映する
    push("persons", [keep]);
    drop("persons", drops.map((id) => ({ id: id })));
    push("business_cards", changedCards);
    push("interactions", changedLogs);
    drop("person_topics", removedTopicKeys);
    push("person_topics", keptTopics);
    drop("relationships", removedRels.map((r) => ({ id: r.id })));
    push("relationships", keptRels);

    return { ok: ok, merged: drops.length, error: lastError };
  }


  /* --- 専門分野の表記ゆれをまとめる ---------------------------------------- */

  /** 「旋盤」と「旋盤加工」のように、同じものを指していそうな組をさがす */
  function findTopicDuplicates() {
    const list = db.topics.slice();
    const used = {};
    const groups = [];

    for (let i = 0; i < list.length; i++) {
      if (used[list[i].id]) continue;
      const g = [list[i]];
      const a = fold(list[i].name);

      for (let j = i + 1; j < list.length; j++) {
        if (used[list[j].id]) continue;
        const b = fold(list[j].name);
        const same = (a === b)
          || (a.length >= 2 && b.length >= 2 && (a.indexOf(b) >= 0 || b.indexOf(a) >= 0));
        if (same) { g.push(list[j]); used[list[j].id] = true; }
      }
      if (g.length > 1) { used[list[i].id] = true; groups.push(g); }
    }
    return groups;
  }

  /** 専門分野をひとつにまとめる */
  function mergeTopics(keepId, dropIds) {
    const keep = db.topics.find((t) => t.id === keepId);
    if (!keep) return { ok: false, error: "まとめ先が見つかりません。" };

    const drops = (dropIds || []).filter((id) => id !== keepId);
    if (!drops.length) return { ok: false, error: "まとめる相手がいません。" };

    const removed = [];
    db.person_topics.forEach(function (pt) {
      if (drops.indexOf(pt.topic_id) >= 0) {
        removed.push({ person_id: pt.person_id, topic_id: pt.topic_id });
        pt.topic_id = keepId;
      }
    });

    const seen = {}, kept = [];
    db.person_topics = db.person_topics.filter(function (pt) {
      const k = pt.person_id + "|" + pt.topic_id;
      if (seen[k]) return false;
      seen[k] = true;
      if (pt.topic_id === keepId) kept.push(pt);
      return true;
    });

    db.topics = db.topics.filter((t) => drops.indexOf(t.id) < 0);
    const ok = persist();

    drop("topics", drops.map((id) => ({ id: id })));
    drop("person_topics", removed);
    push("person_topics", kept);
    return { ok: ok, merged: drops.length, error: lastError };
  }


  /* --- 接点の偏り（属人化の度合い）----------------------------------------- */

  /**
   * 外部の人との接点が、社内の誰にどれだけ偏っているかを数える。
   * 「その人が抜けたら、何名との接点が失われるか」まで出します。
   */
  function getDependencyStats() {
    const persons = db.persons;
    const withContact = persons.filter((p) => getUsersWhoKnow(p.id).length > 0);
    const sole = persons.filter((p) => getUsersWhoKnow(p.id).length === 1);
    const none = persons.filter((p) => getUsersWhoKnow(p.id).length === 0);

    const perUser = getUsers().map(function (u) {
      const contacts = getContactsOfUser(u.id);
      // この人だけが接点を持っている相手
      const only = contacts.filter(function (p) {
        const who = getUsersWhoKnow(p.id);
        return who.length === 1 && who[0].id === u.id;
      });
      return { user: u, contacts: contacts.length, only: only.length };
    }).sort((a, b) => b.contacts - a.contacts);

    return {
      persons: persons.length,
      withContact: withContact.length,
      sole: sole.length,
      none: none.length,
      solePct: withContact.length
        ? Math.round((sole.length / withContact.length) * 100) : 0,
      perUser: perUser,
    };
  }

  /* --- 組織 ---------------------------------------------------------------- */

  /** 組織の詳しい情報。所属者・専門分野・社内の接点をまとめる。 */
  function getOrganizationDetail(orgId) {
    const org = db.organizations.find((o) => o.id === orgId);
    if (!org) return null;

    const members = db.persons.filter((p) => p.organization_id === orgId);

    // 所属者の専門分野を数える
    const count = {};
    members.forEach(function (p) {
      getTopicsOf(p.id).forEach(function (t) {
        count[t.name] = (count[t.name] || 0) + 1;
      });
    });
    const topics = Object.keys(count)
      .map((name) => ({ name: name, count: count[name] }))
      .sort((a, b) => b.count - a.count);

    // 社内でこの組織と接点がある人
    const whoIds = {};
    members.forEach(function (p) {
      getUsersWhoKnow(p.id).forEach((u) => { whoIds[u.id] = true; });
    });

    // 所属者を通じてつながっている他の組織
    const linked = {};
    members.forEach(function (p) {
      getRelationshipsOf(p.id).forEach(function (r) {
        const other = getPerson(r.other_id);
        if (!other || !other.organization_id || other.organization_id === orgId) return;
        const k = other.organization_id;
        linked[k] = linked[k] || { id: k, name: getOrganizationName(k), count: 0 };
        linked[k].count++;
      });
    });

    return {
      org: org,
      members: members,
      topics: topics,
      users: Object.keys(whoIds).map(getUser).filter(Boolean),
      linked: Object.keys(linked).map((k) => linked[k]).sort((a, b) => b.count - a.count),
    };
  }

  /* --- 集計 --------------------------------------------------------------- */

  function getStats() {
    // 何が容量を使っているかを分けて数える（ほとんどは名刺画像）
    const imageBytes = db.business_cards.reduce(function (sum, c) {
      return sum + (c.image_path ? c.image_path.length : 0);
    }, 0);

    return {
      imageBytes: imageBytes,
      persons: db.persons.length,
      organizations: db.organizations.length,
      cards: db.business_cards.length,
      users: db.users.length,
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
      const ok = persist();

      // 共有データベースを使っているときは、読み込んだ内容をすべて送る
      if (sharedMode) {
        Object.keys(SHEET_OF).forEach(function (local) {
          if (db[local] && db[local].length) push(local, db[local]);
        });
      }
      return { ok: ok, error: lastError, shared: sharedMode };
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
  loadCurrentUser();

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

    // 利用者と共有データベース
    getUsers, getUser, addUser,
    getCurrentUserId, getCurrentUser, setCurrentUser,
    getCardOwner, getContactsOfUser, getUsersWhoKnow,
    enableShared, isShared, applyRemote, noteCardImageId, pushAll,
    releaseLocalImages,
    findConnectionPath, displayName, relationBetween,

    // 整理（名寄せ・表記ゆれ）と集計
    findPersonDuplicates, mergePersons,
    findTopicDuplicates, mergeTopics,
    getDependencyStats, getOrganizationDetail,

    // AI検索のための検索関数（Phase 5）
    searchPeopleByTopic, searchPeopleByAttribute, searchPeopleByInteraction,
    runSearch, buildAIContext,

    // その他
    getStats, exportJSON, importJSON, clearAll,
  };
})();

/* 他のファイルから window.Storage でも参照できるようにしておく。
   const で定義したものは、そのままでは window に付かないため。 */
window.Storage = Storage;