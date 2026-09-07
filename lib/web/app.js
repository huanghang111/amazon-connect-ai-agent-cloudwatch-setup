/* Connect AI Agent 日志排查前端逻辑
 *
 * 数据来源: window.__CONNECT_AI_LOG_DATA__ = [{timestamp, message}]
 * message 是 AI Agent 写入 CloudWatch 的原始 JSON 字符串。
 *
 * 关键映射:
 *   - Amazon Connect 的 contactId 在日志里体现为 `session_name`
 *     (也出现在 span 的 session_name=...)。
 *   - `session_id` 是底层 Q in Connect 的内部会话 ID。
 *   一个 contactId 可能对应一个或多个 session_id，这里以 contactId 为主键分组。
 */
(function () {
  "use strict";

  const RAW = window.__CONNECT_AI_LOG_DATA__ || [];

  // ---- 界面语言 (UI i18n) ----
  const I18N = window.I18N || {};
  const I18N_LANGS = window.I18N_LANGS || ["中文"];
  const DEFAULT_LANG = "中文";

  // 把 config.env 里可能出现的语言代码/别名归一化为字典里的规范名称
  const LANG_ALIASES = {
    "zh": "中文", "zh-cn": "中文", "zh-hans": "中文", "chinese": "中文", "中文": "中文",
    "en": "English", "en-us": "English", "english": "English", "英语": "English", "英文": "English",
    "es": "Español", "spanish": "Español", "espanol": "Español", "español": "Español", "西班牙语": "Español",
    "it": "Italiano", "italian": "Italiano", "italiano": "Italiano", "意大利语": "Italiano",
    "de": "Deutsch", "german": "Deutsch", "deutsch": "Deutsch", "德语": "Deutsch", "德文": "Deutsch",
  };
  function normalizeLang(v) {
    if (!v) return null;
    const s = String(v).trim();
    if (I18N[s]) return s;                    // 已经是规范名称
    return LANG_ALIASES[s.toLowerCase()] || null;
  }

  let currentLang = DEFAULT_LANG;
  // 1) config.env 注入的默认界面语言(site-config.js -> window.__UI_CONFIG__)
  try {
    const cfgLang = window.__UI_CONFIG__ && window.__UI_CONFIG__.defaultLang;
    const n = normalizeLang(cfgLang);
    if (n) currentLang = n;
  } catch (e) { /* 无注入配置时用默认值 */ }
  // 2) 用户上次在页面上手动选择的语言优先于配置默认值
  try {
    const saved = localStorage.getItem("connectAiUiLang");
    if (saved && I18N[saved]) currentLang = saved;
  } catch (e) { /* localStorage 不可用时忽略 */ }

  // 翻译单个 key，可传入 {占位符: 值} 做替换。缺失时回退到中文、再回退到 key 本身。
  function t(key, params) {
    const dict = I18N[currentLang] || I18N[DEFAULT_LANG] || {};
    let s = dict[key];
    if (s == null && I18N[DEFAULT_LANG]) s = I18N[DEFAULT_LANG][key];
    if (s == null) s = key;
    if (params) {
      for (const k in params) {
        s = s.split("{" + k + "}").join(String(params[k]));
      }
    }
    return s;
  }

  // 把带 data-i18n / data-i18n-ph 属性的静态元素替换为当前语言文本
  function applyStaticI18n() {
    document.querySelectorAll("[data-i18n]").forEach((el) => {
      el.textContent = t(el.getAttribute("data-i18n"));
    });
    document.querySelectorAll("[data-i18n-ph]").forEach((el) => {
      el.setAttribute("placeholder", t(el.getAttribute("data-i18n-ph")));
    });
    document.documentElement.setAttribute("lang", currentLang);
  }

  // ---- 按需翻译状态 ----
  let TRANSLATE_CFG = { available: false, lang: "中文" };
  const translatedContacts = new Set();   // 已翻译过的 Contact
  const translatingContacts = new Set();  // 正在翻译中的 Contact

  // ---- 工具: 安全 JSON 解析 ----
  function tryParse(s) {
    if (typeof s !== "string") return s;
    try { return JSON.parse(s); } catch (e) { return null; }
  }

  // ---- 解析 span 字符串 "{k=v, k=v, nested=[...]}" ----
  // 这是 OpenTelemetry 风格的非 JSON 文本，做一个容错的浅解析。
  function parseSpan(spanStr) {
    const out = {};
    if (typeof spanStr !== "string") return out;
    let s = spanStr.trim();
    if (s.startsWith("{")) s = s.slice(1);
    if (s.endsWith("}")) s = s.slice(0, -1);
    // 顶层按逗号切分，但要跳过中括号 / 大括号内部的逗号
    const parts = [];
    let depth = 0, cur = "";
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === "[" || c === "{") depth++;
      else if (c === "]" || c === "}") depth--;
      if (c === "," && depth === 0) { parts.push(cur); cur = ""; }
      else cur += c;
    }
    if (cur.trim()) parts.push(cur);
    for (const p of parts) {
      const eq = p.indexOf("=");
      if (eq === -1) continue;
      const k = p.slice(0, eq).trim();
      const v = p.slice(eq + 1).trim();
      out[k] = v;
    }
    return out;
  }

  const SHORT_TYPE = (t) => (t || "").replace(/^TRANSCRIPT_/, "");

  // ---- 归一化每条日志 ----
  const events = [];
  for (const row of RAW) {
    const source = row.source || "connect";

    // Gateway 日志: 来自 Bedrock AgentCore Gateway，可能是 JSON 也可能是纯文本。
    // 关联用的 contactId 由后端预先计算并写在 row.contactId 上。
    if (source === "gateway") {
      const gobj = tryParse(row.message); // 可能为 null(纯文本)
      events.push({
        ts: row.timestamp,
        source: "gateway",
        type: "GATEWAY",
        fullType: "GATEWAY",
        contactId: row.contactId || "",
        sessionId: "",
        span: null,
        obj: gobj,
        raw: row.message,
      });
      continue;
    }

    const obj = tryParse(row.message);
    if (!obj || !obj.event_type) {
      events.push({
        ts: row.timestamp, source: "connect", type: "UNKNOWN", contactId: row.contactId || "(unparsed)",
        sessionId: "", raw: row.message, obj: null,
      });
      continue;
    }
    let contactId = row.contactId || "";
    let span = null;
    if (!contactId && obj.session_name) contactId = obj.session_name;
    if (obj.span) {
      span = parseSpan(obj.span);
      if (!contactId && span.session_name) contactId = span.session_name;
    }
    // 没有 session_name 的事件(如 UTTERANCE / ORCHESTRATION)先记下 session_id，
    // 之后用 session_id -> contactId 的映射补全。
    events.push({
      ts: row.timestamp,
      source: "connect",
      type: SHORT_TYPE(obj.event_type),
      fullType: obj.event_type,
      contactId: contactId,
      sessionId: obj.session_id || "",
      span: span,
      obj: obj,
      raw: row.message,
      // 运行时点击「翻译」按钮后，由 /api/translate 填充
      translation: "",
      translationLang: "",
    });
  }

  // ---- 构建 session_id -> contactId 映射 ----
  const sidToCid = {};
  for (const e of events) {
    if (e.contactId && e.sessionId) sidToCid[e.sessionId] = e.contactId;
  }
  // 补全缺失 contactId
  for (const e of events) {
    if (!e.contactId && e.sessionId && sidToCid[e.sessionId]) {
      e.contactId = sidToCid[e.sessionId];
    }
    if (!e.contactId) {
      // gateway 没关联到会话的，单独归入一个分组，避免污染真实 Contact 列表
      e.contactId = e.source === "gateway"
        ? "(未关联的 Gateway 日志)"
        : (e.sessionId || "(unknown)");
    }
  }

  // ---- 按 contactId 分组 ----
  const groups = {};
  for (const e of events) {
    (groups[e.contactId] = groups[e.contactId] || []).push(e);
  }
  // 每个 Contact 的元信息(最早时间 / 事件数)，供侧栏排序使用
  const contactMeta = {};
  for (const cid of Object.keys(groups)) {
    const list = groups[cid];
    let mn = Infinity;
    for (const x of list) { if (x.ts < mn) mn = x.ts; }
    contactMeta[cid] = { minTs: mn, count: list.length };
  }
  const contactIds = Object.keys(groups);

  // 侧栏排序: 时间(最早时间戳) 或 事件数，可切换升/降序
  let currentSort = "time_desc";
  function getOrderedContactIds() {
    return contactIds.slice().sort((a, b) => {
      const ma = contactMeta[a], mb = contactMeta[b];
      switch (currentSort) {
        case "time_asc":   return ma.minTs - mb.minTs;
        case "count_desc": return (mb.count - ma.count) || (mb.minTs - ma.minTs);
        case "count_asc":  return (ma.count - mb.count) || (ma.minTs - mb.minTs);
        case "time_desc":
        default:           return mb.minTs - ma.minTs; // 最近的会话排前面
      }
    });
  }

  // ---- 会话级统计(用于侧栏徽标) ----
  function summarize(list) {
    let errors = 0, escalations = 0, toolCalls = 0, llmCalls = 0;
    let gateway = 0;
    // 护栏拦截次数与 Contact 列表口径一致(结构化评估优先, 避免一次拦截记两次)
    const guardrailBlocks = guardStats(list).blocks;
    for (const e of list) {
      if (e.source === "gateway") {
        gateway++;
        if (isGatewayError(e)) errors++;
        continue;
      }
      if (e.span) {
        if (spanFailed(e.span)) errors++;    // barge-in 造成的 ERROR 不算错误
        if (e.span.span_name === "escalate_agent") escalations++;
        if (e.span.span_name === "execute_tool") toolCalls++;
        if (e.span.span_name === "inference") llmCalls++;
      }
    }
    return { errors, escalations, toolCalls, llmCalls, guardrailBlocks, gateway };
  }

  // gateway 日志的错误判定: level/status 字段或文本含 ERROR/Exception
  function isGatewayError(e) {
    if (e.obj) {
      const lvl = (e.obj.level || e.obj.severity || e.obj.status || "").toString().toUpperCase();
      if (/ERROR|FATAL|CRITICAL/.test(lvl)) return true;
    }
    return /\b(ERROR|Exception|Traceback|FATAL)\b/.test(e.raw || "");
  }

  // Amazon Connect 侧的可选补充数据(通话智能摘要 / 挂断方 / CSAT / AI Agent 次数),
  // 这些字段无法从 CloudWatch AI Agent 日志里获取，需要额外调用 Amazon Connect API
  // (见 fetch-connect-contact-details.py 生成的 connect-enrich.js)。缺失时显示 N/A。
  const ENRICH = window.__CONNECT_CONTACT_ENRICH__ || {};

  // 「CSAT 满意度评分」对应的 Amazon Connect 联系人属性键名(不写死)。
  // 优先取运行时配置(site-config.js / aws-config.js 注入)，缺省回退 botevaluation。
  const CSAT_ATTR =
    (window.__UI_CONFIG__ && window.__UI_CONFIG__.csatAttribute) ||
    (window.__AWS_CONFIG__ && window.__AWS_CONFIG__.csatAttribute) ||
    "botevaluation";

  // 去掉 MCP 工具名的命名空间前缀: connect_repair_mcp_agent___faqSearch -> faqSearch
  function shortToolName(name) {
    if (!name) return "";
    const i = name.lastIndexOf("___");
    return i >= 0 ? name.slice(i + 3) : name;
  }

  // 取 execute_tool span 的输出正文(用于判断该次工具调用是否"成功有响应")
  function toolOutputText(sp) {
    let txt = "";
    const om = tryParse(sp.output_messages);
    if (Array.isArray(om)) {
      om.forEach((m) => (m.values || []).forEach((v) => {
        if (v.toolResult) {
          (v.toolResult.content || []).forEach((c) => { txt += (c.text || JSON.stringify(c)); });
        }
      }));
    }
    if (!txt && typeof sp.output_messages === "string") txt = sp.output_messages;
    return txt;
  }

  // 用户打断(barge-in)导致的 span: 客户抢话时 Connect 会把正在进行的
  // inference / invoke_agent 标成 status=ERROR，
  // 但这属于正常中止而非故障，不应计入错误。
  function spanBargeIn(sp) {
    if (!sp) return false;
    if (sp.span_name === "barge_in" || sp.operation_name === "barge_in") return true;
    if (sp.error_type === "barge_in") return true;
    return /barge[-_ ]?in/i.test(sp.status_description || "");
  }

  // span 是否真的失败: 状态非 OK，且不是 barge-in 造成的中止
  function spanFailed(sp) {
    if (!sp || !sp.status || sp.status === "OK") return false;
    return !spanBargeIn(sp);
  }

  // 判断一次工具调用是否成功返回(span 状态 OK 且输出里没有 error / HTTP 4xx-5xx)
  function toolSucceeded(sp) {
    if (sp.status && sp.status !== "OK") return false;
    const txt = toolOutputText(sp);
    if (/"error"/.test(txt)) return false;
    if (/HTTP\s*[45]\d\d/.test(txt)) return false;
    return true;
  }

  // 判断一次 requestRepair 工具调用是否成功创建了 SR Draft:
  // 以工具输出里 ticketNumber 是否有非空返回值为准。
  function repairTicketReturned(sp) {
    const txt = toolOutputText(sp);
    if (!txt) return false;
    // 兼容多层转义(\"ticketNumber\": \"4685750498\" / "ticketNumber":"xxx")
    const m = txt.match(/ticketNumber\\*["']?\s*:\s*\\*["']?\s*([^"'\\,}\s]+)/i);
    if (!m) return false;
    const val = (m[1] || "").trim();
    return val && val.toLowerCase() !== "null" && val.toLowerCase() !== "none" && val !== "";
  }

  // 从原始日志文本里抽取 SR 工单号(srNumber):
  // 兼容多层转义, 例如 result={content=[{type=text, text={\"status\": \"success\",
  // ..., \"srNumber\": \"MISSR202607205000005\"}}
  function extractSrNumber(raw) {
    if (!raw) return "";
    const m = raw.match(/srNumber\\*["']?\s*:\s*\\*["']?\s*([^"'\\,}\s]+)/i);
    if (!m) return "";
    const val = (m[1] || "").trim();
    if (!val || val.toLowerCase() === "null" || val.toLowerCase() === "none") return "";
    return val;
  }

  // 从原始日志文本里抽取 BU (<customer_info> 中的 "- BU: xxx")
  function extractBU(raw) {
    if (!raw) return "";
    const m = raw.match(/-\s*BU:\s*([^\\"\n<}]+)/);
    return m ? m[1].trim() : "";
  }

  // 从原始日志文本里抽取 locale code (如 en_US / fr-FR)，优先取"配置的 locale"
  function extractLocale(raw) {
    if (!raw) return "";
    let m = raw.match(/language locale[^A-Za-z]{0,12}([a-z]{2}[_-][A-Z]{2})/);
    if (!m) m = raw.match(/configured locale[^A-Za-z]{0,12}([a-z]{2}[_-][A-Z]{2})/);
    if (!m) m = raw.match(/\blocale\b[^A-Za-z]{0,12}([a-z]{2}_[A-Z]{2})/);
    return m ? m[1] : "";
  }

  // 兜底: 当 extractLocale 未命中时，从 <system-variables> 节点里的
  // responseLanguage 取语言值(如 responseLanguage: en_US)。
  function extractResponseLanguage(raw) {
    if (!raw) return "";
    const m = raw.match(/responseLanguage[^A-Za-z]{0,12}([a-z]{2}[_-][A-Z]{2})/);
    return m ? m[1] : "";
  }

  // ---- Guardrail 评估解析 ----
  // 日志里的 span.guardrail_assessments 形如:
  //   [{"guardrailId":"9dp6cp5qt6ob/7","guardrailName":"Midea-Competitor-Filter",
  //     "source":"INPUT","action":"BLOCKED",
  //     "policies":[{"policyType":"TOPIC","action":"BLOCKED","details":"historical-atrocity-debate"}]}]
  // 从起始的 [ 或 { 开始做括号配对，截出完整的一段文本
  function sliceBalanced(s, start) {
    let depth = 0;
    for (let i = start; i < s.length; i++) {
      const c = s[i];
      if (c === "[" || c === "{") depth++;
      else if (c === "]" || c === "}") {
        depth--;
        if (depth === 0) return s.slice(start, i + 1);
      }
    }
    return "";
  }

  // 提取某个事件里全部 guardrail 评估对象(优先用已解析的 span 字段，兜底扫原始文本)
  function eventGuardAssessments(e) {
    if (e._guardAssessments) return e._guardAssessments;
    const out = [];
    const texts = [];
    if (e.span && e.span.guardrail_assessments) texts.push(e.span.guardrail_assessments);
    const raw = e.raw || "";
    if (!texts.length && /guardrail_assessments/.test(raw)) texts.push(raw);

    for (const text of texts) {
      // 原始消息里 guardrail 段是 JSON 转义过的(\" 或 \\")，先还原成普通引号
      const s = String(text).replace(/\\+"/g, '"');
      const arrays = [];
      if (s.indexOf("guardrail_assessments") === -1) {
        const i = s.indexOf("[");
        if (i !== -1) arrays.push(sliceBalanced(s, i));
      } else {
        let idx = 0, k;
        while ((k = s.indexOf("guardrail_assessments", idx)) !== -1) {
          const i = s.indexOf("[", k);
          if (i === -1) break;
          const seg = sliceBalanced(s, i);
          if (!seg) break;
          arrays.push(seg);
          idx = i + seg.length;
        }
      }
      for (const a of arrays) {
        const parsed = tryParse(a);
        if (Array.isArray(parsed)) {
          for (const item of parsed) if (item && typeof item === "object") out.push(item);
        }
      }
    }
    e._guardAssessments = out;
    return out;
  }

  // policy 的 details 可能是字符串，也可能是对象/数组(不同 policyType 结构不同)
  function guardrailDetailText(d) {
    if (d == null) return "";
    if (typeof d === "string") return d.trim();
    if (Array.isArray(d)) return d.map(guardrailDetailText).filter(Boolean).join(" / ");
    if (typeof d === "object") {
      const picked = ["name", "topic", "type", "filterType", "match", "detail"]
        .map((k) => d[k]).filter((v) => typeof v === "string" && v);
      if (picked.length) return picked.join(": ");
      try { return JSON.stringify(d); } catch (err) { return ""; }
    }
    return String(d);
  }

  // 判断某事件是否触发了 guardrail 拦截(action 非 NONE 即视为拦截)
  function eventGuardBlocked(e) {
    const assessments = eventGuardAssessments(e);
    if (assessments.length) {
      return assessments.some((a) => a.action && String(a.action).toUpperCase() !== "NONE");
    }
    if (e.obj && e.obj.guardrail_blocked === true) return true;
    const raw = e.raw || "";
    if (!/guardrail/i.test(raw)) return false;
    const re = /action[\\"'\s]*[:=][\\"'\s]*([A-Z_]+)/g;
    let m;
    while ((m = re.exec(raw)) !== null) {
      if (m[1] && m[1] !== "NONE") return true;
    }
    return false;
  }

  // 收集该事件里出现的 guardrail 拦截原因:
  // 每个被触发的 guardrailId 输出 "guardrailName · policyType · details"
  function eventGuardReasons(e) {
    const out = [];
    const assessments = eventGuardAssessments(e);
    for (const a of assessments) {
      const action = String(a.action || "").toUpperCase();
      if (action === "NONE") continue;                     // 未触发的护栏不计入原因
      const name = (a.guardrailName || a.guardrailId || "guardrail").trim();
      const policies = Array.isArray(a.policies) ? a.policies.filter(Boolean) : [];
      const hit = policies.filter((p) => String(p.action || "").toUpperCase() !== "NONE");
      const use = hit.length ? hit : policies;
      if (!use.length) {
        out.push(name + " · " + (action || "BLOCKED"));      // 没有 policies 明细时只给名称+动作
        continue;
      }
      for (const p of use) {
        const parts = [name];
        if (p.policyType) parts.push(String(p.policyType));
        const detail = guardrailDetailText(p.details);
        if (detail) parts.push(detail);
        out.push(parts.join(" · "));
      }
    }
    // 已能结构化解析时以解析结果为准(全部 action=NONE 则确实没有拦截原因)
    if (assessments.length) return out;

    // 兜底: 结构化解析失败时，仍按老逻辑从文本里抓 guardrailName
    const raw = e.raw || "";
    if (!/guardrail/i.test(raw)) return out;
    const re = /guardrailName[\\"'\s]*[:=][\\"'\s]*([^\\"',}\]]+)/g;
    let m;
    while ((m = re.exec(raw)) !== null) {
      const n = (m[1] || "").trim();
      if (n) out.push(n);
    }
    return out;
  }

  // 统计一批事件里的护栏拦截: 次数 + 每条原因各命中多少次。
  // 口径说明:
  //   1) 同一次拦截会在日志里出现两次 —— 编排层的 ORCHESTRATION_MESSAGE
  //      (guardrail_blocked=true, 即那句兜底话术) 与 inference span 的
  //      guardrail_assessments=BLOCKED。因此只要存在结构化评估就以评估为准，
  //      避免把一次拦截算成两次; 没有结构化评估的日志才回退到 guardrail_blocked 标记。
  //   2) 次数由「原因命中次数」累加而来，因此各原因次数之和恒等于拦截次数;
  //      一个事件里若同时命中多条策略，则按命中条数分别累加。
  //   3) 只有拦截标记、拿不到原因的事件归入「未提供原因」，保证两列仍然对得上。
  function guardStats(list) {
    const assessed = [], fallback = [];
    for (const e of list) {
      if (!eventGuardBlocked(e)) continue;
      (eventGuardAssessments(e).length ? assessed : fallback).push(e);
    }
    const use = assessed.length ? assessed : fallback;

    const counts = new Map();   // 原因文本 -> 命中次数
    let blocks = 0;
    for (const e of use) {
      let rs = eventGuardReasons(e);
      if (!rs.length) rs = [t("guardReasonUnknown")];
      for (const r of rs) {
        counts.set(r, (counts.get(r) || 0) + 1);
        blocks++;
      }
    }
    const reasons = Array.from(counts, ([text, count]) => ({ text, count }))
      .sort((a, b) => b.count - a.count || a.text.localeCompare(b.text));
    return { blocks, reasons };
  }

  // 统计用户打断(barge-in)次数。
  // 日志里一次打断会写出多条记录:
  //   1) 一个 span_name=barge_in / operation_name=barge_in 的 INTERNAL span(最准, 按 span_id 去重);
  //   2) 被放弃的 inference / invoke_agent span:
  //      status=ERROR, error_type=barge_in, status_description="Abandoning due to barge-in"。
  // 所以优先按 barge_in span 计数; 若日志里没有这种 span, 再退回按「被放弃的轮次」
  // (origin_request_id / request_id 去重)统计，避免同一次打断被算成两三次。
  function countBargeIns(list) {
    const bargeSpans = new Set();
    const abandonedTurns = new Set();
    for (const e of list) {
      const sp = e.span;
      if (!sp) continue;
      if (sp.span_name === "barge_in" || sp.operation_name === "barge_in") {
        bargeSpans.add(sp.span_id || String(e.ts));
        continue;
      }
      const desc = sp.status_description || "";
      if (sp.error_type === "barge_in" || /barge[-_ ]?in/i.test(desc)) {
        abandonedTurns.add(sp.origin_request_id || sp.request_id || String(e.ts));
      }
    }
    return bargeSpans.size || abandonedTurns.size;
  }

  // ---- Dashboard 用: 计算单个 Contact 的全部指标(尽量从日志派生) ----
  function computeMetrics(list) {
    let agentic = 0, llm = 0, om = 0, ut = 0, errors = 0;
    let mcpToolCalls = 0;
    let faqAsk = 0, faqSend = 0;
    let srIntent = 0, srSuccess = 0;
    let srNumber = "";
    // 护栏拦截: 次数与各原因次数一起算出，保证「拦截原因」各项之和 == 「拦截次数」
    const guard = guardStats(list);
    const interrupts = countBargeIns(list);       // 用户打断(barge-in)次数
    let latSum = 0, latN = 0;
    let firstRepairTs = null, lastRepairTs = null;
    const toolCounts = {};
    let bu = "", locale = "";
    let minTs = Infinity, maxTs = -Infinity;

    for (const e of list) {
      if (typeof e.ts === "number") {
        if (e.ts < minTs) minTs = e.ts;
        if (e.ts > maxTs) maxTs = e.ts;
      }
      if (!bu) bu = extractBU(e.raw);
      if (!locale) locale = extractLocale(e.raw);
      // 原逻辑未取到语言时，回退到日志 <system-variables> 里的 responseLanguage
      if (!locale) locale = extractResponseLanguage(e.raw);
      if (!srNumber) srNumber = extractSrNumber(e.raw);

      if (e.source === "gateway") {
        if (isGatewayError(e)) errors++;
        continue;
      }
      if (e.span) {
        if (spanFailed(e.span)) errors++;    // barge-in 造成的 ERROR 不算错误
        if (e.span.span_name === "inference" && e.span.start_timestamp && e.span.end_timestamp) {
          latSum += Number(e.span.end_timestamp) - Number(e.span.start_timestamp);
          latN++;
        }
        if (e.span.span_name === "execute_tool") {
          mcpToolCalls++;
          const full = toolNameFromSpan(e.span) || "(unknown)";
          const n = shortToolName(full);
          toolCounts[n] = (toolCounts[n] || 0) + 1;
          const ok = toolSucceeded(e.span);
          if (/faqSearch/i.test(n)) { faqAsk++; if (ok) faqSend++; }
          if (/requestRepair/i.test(n)) {
            // 创建 SR 意图触发次数 = requestRepair 工具的调用次数
            srIntent++;
            // SR Draft 创建成功次数 = requestRepair 调用后 ticketNumber 有返回值的次数
            if (repairTicketReturned(e.span)) srSuccess++;
            if (firstRepairTs == null) firstRepairTs = e.ts;
            lastRepairTs = e.ts;
          }
        }
      }
      if (e.type === "AGENTIC_MESSAGE") agentic++;
      if (e.type === "LARGE_LANGUAGE_MODEL_INVOCATION") llm++;
      if (e.type === "ORCHESTRATION_MESSAGE") om++;
      if (e.type === "UTTERANCE") ut++;
    }

    // SR 信息提取回答轮次: 若触发过 requestRepair，统计为收集 requestRepair 工具
    // 所需信息、机器人与客户之间的对话轮次(客户回答的轮次数量)，即从会话开始到
    // 首次调用 requestRepair 工具之前，客户为填充工单字段所提供信息的轮次。
    let srRounds = null;
    if (srIntent > 0) {
      let rounds = 0;
      for (const e of list) {
        if (e.type === "UTTERANCE" && /^\[CUSTOMER\]/.test((e.obj && e.obj.utterance) || "")) {
          if (firstRepairTs == null || e.ts <= firstRepairTs) rounds++;
        }
      }
      srRounds = rounds;
    }

    const esc = detectEscalation(list);
    const hasTs = minTs !== Infinity;
    if (!hasTs) { minTs = 0; maxTs = 0; }

    return {
      bu: bu,
      locale: locale,
      startTs: hasTs ? minTs : null,
      endTs: hasTs ? maxTs : null,
      duration: Math.max(0, maxTs - minTs),
      aiAgentCalls: Math.max(agentic, llm),
      turns: om || ut,
      toolCounts: toolCounts,
      mcpToolCalls: mcpToolCalls,
      faqAsk: faqAsk,
      faqSend: faqSend,
      srIntent: srIntent,
      srSuccess: srSuccess,
      srNumber: srNumber,
      srRounds: srRounds,
      guardBlocks: guard.blocks,
      guardReasons: guard.reasons,          // [{text, count}], 各 count 之和 == guardBlocks
      interrupts: interrupts,
      responseLatency: latN ? Math.round(latSum / latN) : null,
      escalated: esc.flag,
      escalationReason: esc.reason,
      errors: errors,
      count: list.length,
    };
  }

  // 检测该会话是否触发转人工(Escalate 工具 / escalate_agent span)并取原因
  function detectEscalation(list) {
    let flag = false, reason = "";
    for (const e of list) {
      if (e.span && e.span.span_name === "escalate_agent") flag = true;
      if (e.span && e.span.span_name === "execute_tool") {
        if (/Escalate/i.test(toolNameFromSpan(e.span) || "")) flag = true;
      }
      if (e.obj && e.obj.prompt) {
        const p = tryParse(e.obj.prompt) || {};
        for (const msg of (p.messages || [])) {
          for (const c of (msg.content || [])) {
            if (c.toolUse && /Escalate/i.test(c.toolUse.name || "")) {
              flag = true;
              if (c.toolUse.input && c.toolUse.input.reason) reason = c.toolUse.input.reason;
            }
          }
        }
      }
    }
    return { flag: flag, reason: reason };
  }

  // ---- 把毫秒时长格式化为易读文本 ----
  function formatDuration(ms) {
    if (!ms || ms < 0) return t("durationZero");
    const totalSec = Math.round(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    const parts = [];
    if (h) parts.push(h + t("durationHour"));
    if (m) parts.push(m + t("durationMin"));
    parts.push(s + t("durationSec"));
    // 中文单位紧凑无空格，其他语言用空格分隔更易读
    return parts.join(currentLang === DEFAULT_LANG ? "" : " ");
  }

  // ---- 把 epoch 毫秒格式化为本地日期时间 ----
  function formatDateTime(ts) {
    if (ts == null) return "—";
    return new Date(ts).toLocaleString([], {
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
    });
  }

  // ---- 渲染侧栏 ----
  const contactListEl = document.getElementById("contactList");
  const searchBox = document.getElementById("searchBox");
  let activeCid = null;

  function renderSidebar(filter) {
    const f = (filter || "").trim().toLowerCase();
    contactListEl.innerHTML = "";
    const shown = getOrderedContactIds().filter((c) => !f || c.toLowerCase().includes(f));
    if (shown.length === 0) {
      contactListEl.innerHTML = '<div class="empty" style="margin-top:30px;font-size:13px">' + esc(t("noMatchContact")) + '</div>';
      return;
    }
    for (const cid of shown) {
      const list = groups[cid];
      const s = summarize(list);
      const tmin = new Date(Math.min.apply(null, list.map((x) => x.ts)));
      const item = document.createElement("div");
      item.className = "contact-item" + (cid === activeCid ? " active" : "");
      let badges = `<span class="badge">${esc(t("badgeEvents", { n: list.length }))}</span>`;
      if (s.toolCalls) badges += `<span class="badge">${esc(t("badgeTools", { n: s.toolCalls }))}</span>`;
      if (s.gateway) badges += `<span class="badge gw">${esc(t("badgeGateway", { n: s.gateway }))}</span>`;
      if (s.escalations) badges += `<span class="badge esc">${esc(t("badgeEscalation", { n: s.escalations }))}</span>`;
      if (s.errors) badges += `<span class="badge err">${esc(t("badgeError", { n: s.errors }))}</span>`;
      if (s.guardrailBlocks) badges += `<span class="badge err">${esc(t("badgeGuard", { n: s.guardrailBlocks }))}</span>`;
      if (!s.errors && !s.escalations) badges += `<span class="badge ok">${esc(t("badgeOk"))}</span>`;
      // 翻译按钮(仅当本地服务器提供翻译接口时显示)，并反映"未译/翻译中/已译"三态
      let transBtn = "";
      if (TRANSLATE_CFG.available && cid !== "(未关联的 Gateway 日志)") {
        if (translatingContacts.has(cid)) {
          transBtn = `<button class="icon-btn js-translate busy" title="${esc(t("titleTranslating"))}" disabled>⏳</button>`;
        } else if (translatedContacts.has(cid)) {
          transBtn = `<button class="icon-btn js-translate ok" title="${esc(t("titleRetranslate"))}">${esc(t("btnTranslated"))}</button>`;
        } else {
          transBtn = `<button class="icon-btn js-translate" title="${esc(t("titleTranslate", { lang: TRANSLATE_CFG.lang }))}">${esc(t("btnTranslate"))}</button>`;
        }
      }

      item.innerHTML =
        `<div class="cid-row">` +
          `<span class="cid" title="${cid}">${cid}</span>` +
          `<span class="cid-actions">` +
            transBtn +
            `<button class="icon-btn js-copy" title="${esc(t("titleCopy"))}">⧉</button>` +
            `<button class="icon-btn js-download" title="${esc(t("titleDownload"))}">⬇</button>` +
          `</span>` +
        `</div>` +
        `<div class="sub">${tmin.toLocaleString()}</div>` +
        `<div class="badges">${badges}</div>`;

      // 点击整行选中会话
      item.addEventListener("click", () => selectContact(cid));

      // 拷贝按钮(阻止冒泡，避免触发选中)
      const copyBtn = item.querySelector(".js-copy");
      copyBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        copyToClipboard(cid, copyBtn);
      });

      // 下载按钮
      const dlBtn = item.querySelector(".js-download");
      dlBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        downloadContactCsv(cid);
      });

      // 翻译按钮
      const trBtn = item.querySelector(".js-translate");
      if (trBtn) {
        trBtn.addEventListener("click", (ev) => {
          ev.stopPropagation();
          translateContact(cid);
        });
      }

      contactListEl.appendChild(item);
    }
  }

  // ---- 拷贝 Contact ID 到剪贴板 ----
  function copyToClipboard(text, btn) {
    const done = () => {
      if (!btn) return;
      const old = btn.textContent;
      btn.textContent = "✓";
      btn.classList.add("ok");
      setTimeout(() => { btn.textContent = old; btn.classList.remove("ok"); }, 1200);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
    } else {
      fallbackCopy(text, done);
    }
  }

  function fallbackCopy(text, done) {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      if (done) done();
    } catch (e) {
      window.prompt(t("copyPrompt"), text);
    }
  }

  // ---- 下载该 Contact 的日志为 CSV(含 connect + gateway) ----
  function csvEscape(v) {
    const s = String(v == null ? "" : v);
    if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function downloadContactCsv(cid) {
    const list = groups[cid].slice().sort((a, b) => a.ts - b.ts);
    const header = ["timestamp_ms", "datetime", "source", "event_type", "message", t("csvOriginal"), t("csvTranslation")];
    const lines = [header.join(",")];
    for (const e of list) {
      const dt = new Date(e.ts).toISOString();
      lines.push([
        csvEscape(e.ts),
        csvEscape(dt),
        csvEscape(e.source || ""),
        csvEscape(e.fullType || e.type || ""),
        csvEscape(e.raw != null ? e.raw : ""),
        csvEscape(getTranslatableText(e) || ""),
        csvEscape(e.translation || ""),
      ].join(","));
    }
    // 加 BOM，便于 Excel 正确识别 UTF-8
    const blob = new Blob(["\ufeff" + lines.join("\r\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const safeCid = String(cid).replace(/[^a-zA-Z0-9_-]+/g, "_");
    a.href = url;
    a.download = `contact-${safeCid}-logs.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ---- 渲染消息气泡的辅助 ----
  function extractMessageText(values) {
    // values 可能是数组 [{type:"text", value:"..."}] 或字符串
    if (typeof values === "string") {
      const p = tryParse(values);
      if (p) values = p; else return values;
    }
    if (Array.isArray(values)) {
      return values.map((v) => v.value || v.text || "").join("\n").trim();
    }
    return "";
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  // 从 AI Agent 回复中拆出 <message> 与 <thinking>
  function splitMessageThinking(text) {
    const msgs = [];
    const thinks = [];
    const re = /<(message|thinking)>([\s\S]*?)<\/\1>/g;
    let m, matched = false;
    while ((m = re.exec(text)) !== null) {
      matched = true;
      if (m[1] === "message") msgs.push(m[2].trim());
      else thinks.push(m[2].trim());
    }
    if (!matched) return { messages: [text.trim()], thinking: [] };
    return { messages: msgs, thinking: thinks };
  }

  // ---- 判定事件的角色(客户/机器人/工具)与严重度(错误/护栏)，用于高亮 ----
  function eventRoleInfo(e) {
    let role = "", badge = "", sev = "";
    if (e.type === "UTTERANCE") {
      const u = (e.obj && e.obj.utterance) || "";
      role = /^\[CUSTOMER\]/.test(u) ? "customer" : "bot";
      badge = role === "customer" ? "CUSTOMER" : "BOT";
    } else if (e.type === "ORCHESTRATION_MESSAGE") {
      role = ((e.obj && e.obj.participant) || "BOT").toLowerCase() === "customer" ? "customer" : "bot";
      badge = role === "customer" ? "CUSTOMER" : "BOT";
      if (e.obj && e.obj.guardrail_blocked) sev = "guard";
    } else if (e.type === "AI_AGENT_TRACE" && e.span && e.span.span_name === "execute_tool") {
      role = "tool"; badge = "TOOL";
      if (spanFailed(e.span)) sev = "err";
    } else if (e.type === "GATEWAY") {
      role = "tool"; badge = t("whoGateway");
      if (isGatewayError(e)) sev = "err";
    } else if (e.type === "AI_AGENT_TRACE") {
      if (spanFailed(e.span)) sev = "err";
      else if (spanBargeIn(e.span)) sev = "barge";   // 用户打断: 单独着色, 不算错误
    }
    return { role: role, badge: badge, sev: sev };
  }

  // ---- 渲染单个事件 ----
  function renderEvent(e) {
    const div = document.createElement("div");
    const ri = eventRoleInfo(e);
    div.className = "event t-" + e.type +
      (ri.role ? " role-" + ri.role : "") +
      (ri.sev ? " sev-" + ri.sev : "");

    const time = new Date(e.ts).toLocaleTimeString([], { hour12: false }) +
      "." + String(e.ts % 1000).padStart(3, "0");

    let summary = "";
    let tags = "";
    let bodyHtml = "";

    if (e.type === "UTTERANCE") {
      const u = e.obj.utterance || "";
      summary = u;
      const isCustomer = /^\[CUSTOMER\]/.test(u);
      const who = isCustomer ? "customer" : "bot";
      const txt = u.replace(/^\[(CUSTOMER|AGENT|BOT|SYSTEM)\]\s*/, "");
      bodyHtml = `<div class="bubble ${who}">${esc(txt)}</div>`;
      if (e.translation) bodyHtml += renderTranslationBubble(e.translation, e.translationLang, who);

    } else if (e.type === "ORCHESTRATION_MESSAGE") {
      const txt = extractMessageText(e.obj.values);
      const who = (e.obj.participant || "BOT").toLowerCase() === "customer" ? "customer" : "bot";
      summary = `[${e.obj.participant || "BOT"}] ${txt}`.replace(/\s+/g, " ");
      const parts = splitMessageThinking(txt);
      bodyHtml += `<div class="kv"><b>participant:</b> ${esc(e.obj.participant || "")} · <b>model:</b> ${esc(e.obj.model_id || "")}</div>`;
      for (const mm of parts.messages) if (mm) bodyHtml += `<div class="bubble ${who}">${esc(mm)}</div>`;
      for (const th of parts.thinking) if (th) bodyHtml += `<div class="bubble thinking">💭 ${esc(th)}</div>`;
      if (e.translation) bodyHtml += renderTranslationBubble(e.translation, e.translationLang, who);
      if (e.obj.guardrail_blocked) tags += `<span class="ev-tag err">guardrail</span>`;

    } else if (e.type === "AGENTIC_MESSAGE" || e.type === "LARGE_LANGUAGE_MODEL_INVOCATION") {
      const prompt = tryParse(e.obj.prompt) || {};
      const msgs = prompt.messages || [];
      summary = t("evLlmCall", {
        kind: e.type === "AGENTIC_MESSAGE" ? "Agentic" : "LLM",
        model: prompt.modelId || e.obj.model_id || "?",
        n: msgs.length,
      });
      bodyHtml += `<div class="kv"><b>modelId:</b> ${esc(prompt.modelId || "")}</div>`;
      bodyHtml += renderConversation(msgs);
      // 工具配置
      if (prompt.toolConfig && prompt.toolConfig.tools) {
        const names = prompt.toolConfig.tools.map((tc) => (tc.toolSpec && tc.toolSpec.name) || "").filter(Boolean);
        bodyHtml += `<details><summary>${esc(t("evAvailableTools", { n: names.length }))}</summary><div class="kv">${esc(names.join(", "))}</div></details>`;
      }

    } else if (e.type === "AI_AGENT_TRACE") {
      const sp = e.span || {};
      const dur = (sp.start_timestamp && sp.end_timestamp)
        ? (Number(sp.end_timestamp) - Number(sp.start_timestamp)) + "ms" : "";
      summary = `${sp.span_name || "span"} · ${sp.status || ""} ${dur ? "· " + dur : ""}`;
      if (sp.ai_agent_name) summary += ` · ${sp.ai_agent_name.trim()}`;
      if (spanFailed(sp)) tags += `<span class="ev-tag err">${esc(sp.status)}</span>`;
      else if (spanBargeIn(sp)) tags += `<span class="ev-tag barge">${esc(t("tagBargeIn"))}</span>`;
      else tags += `<span class="ev-tag ok">OK</span>`;
      if (sp.span_name === "execute_tool") {
        const tn = toolNameFromSpan(sp);
        tags += `<span class="ev-tag mcp">🔌 MCP${tn ? ": " + esc(tn) : ""}</span>`;
      }

      const interesting = ["span_name", "span_type", "status", "operation_name",
        "ai_agent_type", "ai_agent_name", "ai_agent_version", "provider_name",
        "request_id", "span_id", "parent_span_id"];
      for (const k of interesting) {
        if (sp[k] !== undefined) bodyHtml += `<div class="kv"><b>${k}:</b> ${esc(String(sp[k]).trim())}</div>`;
      }
      // token 使用
      const tokenKeys = Object.keys(sp).filter((k) => /usage_|tokens|finish_reason/.test(k));
      if (tokenKeys.length) {
        bodyHtml += `<div class="kv" style="margin-top:6px"><b>${esc(t("evUsage"))}</b> ` +
          tokenKeys.map((k) => `${k}=${esc(sp[k])}`).join(" · ") + `</div>`;
      }
      // 工具调用 input/output
      if (sp.span_name === "execute_tool") {
        const im = tryParse(sp.input_messages);
        const om = tryParse(sp.output_messages);
        bodyHtml += renderToolSpan(im, om);
      }

    } else if (e.type === "CREATE_SESSION") {
      summary = t("evCreateSession", { n: e.obj.session_name || "" });
      bodyHtml += `<div class="kv"><b>session_id:</b> ${esc(e.obj.session_id || "")}</div>`;
      bodyHtml += `<div class="kv"><b>session_name:</b> ${esc(e.obj.session_name || "")}</div>`;

    } else if (e.type === "SESSION_POLLED") {
      summary = t("evSessionPolled") + (e.obj.connect_user_arn ? " · " + t("evAssignedAgent") : "");
      if (e.obj.connect_user_arn) bodyHtml += `<div class="kv"><b>connect_user_arn:</b> ${esc(e.obj.connect_user_arn)}</div>`;

    } else if (e.type === "GATEWAY") {
      // Bedrock AgentCore Gateway 应用日志: 结构化或纯文本都兼容
      const o = e.obj;
      if (o && typeof o === "object") {
        const msgText = o.message || o.msg || o.body || "";
        const lvl = o.level || o.severity || o.status || "";
        summary = `${lvl ? "[" + lvl + "] " : ""}${typeof msgText === "string" ? msgText : JSON.stringify(msgText)}`.replace(/\s+/g, " ");
        const interesting = ["level", "severity", "status", "logger", "tool", "tool_name",
          "method", "operation", "requestId", "request_id", "duration", "durationMs", "latency"];
        for (const k of interesting) {
          if (o[k] !== undefined) bodyHtml += `<div class="kv"><b>${k}:</b> ${esc(typeof o[k] === "string" ? o[k] : JSON.stringify(o[k]))}</div>`;
        }
        if (msgText) bodyHtml += `<div class="bubble" style="background:#1a1f2b;border:1px solid var(--border)">${esc(typeof msgText === "string" ? msgText : JSON.stringify(msgText))}</div>`;
      } else {
        summary = (e.raw || "").replace(/\s+/g, " ");
        bodyHtml += `<div class="bubble" style="background:#1a1f2b;border:1px solid var(--border)">${esc(e.raw || "")}</div>`;
      }
      if (isGatewayError(e)) tags += `<span class="ev-tag err">error</span>`;

    } else {
      summary = e.fullType || e.type;
    }

    bodyHtml += `<details><summary>${esc(t("rawJson"))}</summary><pre class="raw">${esc(prettyRaw(e.raw))}</pre></details>`;

    const srcTag = `<span class="src-tag src-${e.source}">${e.source === "gateway" ? "Gateway" : "Connect"}</span>`;
    const whoBadge = ri.badge ? `<span class="who ${ri.role}">${ri.badge}</span>` : "";

    div.innerHTML =
      `<div class="event-head">` +
        `<span class="ev-time">${time}</span>` +
        srcTag +
        whoBadge +
        `<span class="ev-type">${esc(e.type)}</span>` +
        `<span class="ev-summary">${esc(summary)}</span>` +
        tags +
      `</div>` +
      `<div class="event-body">${bodyHtml}</div>`;

    div.querySelector(".event-head").addEventListener("click", () => {
      div.classList.toggle("open");
    });
    return div;
  }

  function prettyRaw(raw) {
    const o = tryParse(raw);
    if (o) { try { return JSON.stringify(o, null, 2); } catch (e) {} }
    return raw;
  }

  // ---- 渲染高亮的译文气泡(原文保留在上方，译文高亮显示在下方) ----
  function renderTranslationBubble(translation, lang, who) {
    const label = lang ? esc(t("transLabelLang", { lang: lang })) : esc(t("transLabel"));
    return (
      `<div class="bubble ${who} translated">` +
        `<span class="trans-badge">${label}</span>` +
        esc(translation) +
      `</div>`
    );
  }

  // ---- 取一条事件里可翻译的对话正文(客户/机器人) ----
  function getTranslatableText(e) {
    if (e.source !== "connect") return "";
    if (e.type === "UTTERANCE") {
      const u = e.obj && e.obj.utterance || "";
      return u.replace(/^\[(CUSTOMER|AGENT|BOT|SYSTEM)\]\s*/, "").trim();
    }
    if (e.type === "ORCHESTRATION_MESSAGE") {
      return (e.obj ? extractMessageText(e.obj.values) : "").trim();
    }
    return "";
  }

  // ---- 从 execute_tool span 里取工具名 ----
  function toolNameFromSpan(sp) {
    const im = tryParse(sp.input_messages);
    if (Array.isArray(im)) {
      for (const m of im) {
        for (const v of (m.values || [])) {
          if (v.toolUse && v.toolUse.name) return v.toolUse.name;
        }
      }
    }
    return sp.tool_name || sp.tool || "";
  }

  // ---- 收集某会话里被调用的 MCP 工具名 ----
  function collectToolNames(list) {
    const set = new Set();
    for (const e of list) {
      if (e.source === "connect" && e.span && e.span.span_name === "execute_tool") {
        const n = toolNameFromSpan(e.span);
        if (n) set.add(n);
      }
      if (e.obj && e.obj.prompt) {
        const prompt = tryParse(e.obj.prompt) || {};
        for (const m of (prompt.messages || [])) {
          for (const c of (m.content || [])) {
            if (c.toolUse && c.toolUse.name) set.add(c.toolUse.name);
          }
        }
      }
    }
    return Array.from(set);
  }

  function renderConversation(msgs) {
    let html = "";
    for (const m of msgs) {
      const role = m.role || "?";
      const content = m.content || [];
      for (const c of content) {
        if (c.text !== undefined) {
          const parts = splitMessageThinking(c.text);
          for (const mm of parts.messages) if (mm) html += `<div class="bubble ${role === "user" ? "customer" : "bot"}">${esc(mm)}</div>`;
          for (const th of parts.thinking) if (th) html += `<div class="bubble thinking">💭 ${esc(th)}</div>`;
        } else if (c.guardContent && c.guardContent.text) {
          const gt = c.guardContent.text.text || c.guardContent.text;
          html += `<div class="bubble ${role === "user" ? "customer" : "bot"}">${esc(typeof gt === "string" ? gt : JSON.stringify(gt))}</div>`;
        } else if (c.toolUse) {
          html += `<div class="toolcall mcp">🔌 <span class="mcp-label">${esc(t("evMcpTool"))}</span> <span class="name">${esc(c.toolUse.name)}</span><div class="kv">input: ${esc(JSON.stringify(c.toolUse.input))}</div></div>`;
        } else if (c.toolResult) {
          const rc = (c.toolResult.content || []).map((x) => x.text || JSON.stringify(x)).join("\n");
          html += `<div class="toolcall">↩️ ${esc(t("evToolResult"))}<pre class="raw">${esc(rc)}</pre></div>`;
        }
      }
    }
    return html;
  }

  function renderToolSpan(im, om) {
    let html = "";
    const collect = (arr) => {
      const r = [];
      (arr || []).forEach((msg) => (msg.values || []).forEach((v) => {
        if (v.toolUse) r.push(`<div class="toolcall mcp">🔌 <span class="mcp-label">${esc(t("evMcpTool"))}</span> <span class="name">${esc(v.toolUse.name)}</span><div class="kv">input: ${esc(typeof v.toolUse.input === "string" ? v.toolUse.input : JSON.stringify(v.toolUse.input))}</div></div>`);
        if (v.toolResult) {
          const rc = (v.toolResult.content || []).map((x) => x.text || JSON.stringify(x)).join("\n");
          r.push(`<div class="toolcall">↩️ ${esc(t("evResult"))}<pre class="raw">${esc(rc)}</pre></div>`);
        }
      }));
      return r.join("");
    };
    html += collect(im);
    html += collect(om);
    return html;
  }

  // ---- 过滤器 ----
  const ALL_TYPES = ["UTTERANCE", "ORCHESTRATION_MESSAGE", "AGENTIC_MESSAGE",
    "LARGE_LANGUAGE_MODEL_INVOCATION", "AI_AGENT_TRACE", "CREATE_SESSION", "SESSION_POLLED", "GATEWAY"];
  const activeFilters = new Set(ALL_TYPES);

  const filtersEl = document.getElementById("filters");
  function renderFilters() {
    filtersEl.innerHTML = "";
    ALL_TYPES.forEach((t) => {
      const chip = document.createElement("span");
      chip.className = "filter-chip" + (activeFilters.has(t) ? " on" : "");
      chip.textContent = t;
      chip.addEventListener("click", () => {
        if (activeFilters.has(t)) activeFilters.delete(t); else activeFilters.add(t);
        renderFilters();
        if (activeCid) renderTimeline(activeCid);
      });
      filtersEl.appendChild(chip);
    });
  }

  // ---- 渲染时间线 ----
  const timelineEl = document.getElementById("timeline");
  const selectedTitle = document.getElementById("selectedTitle");

  function renderTimeline(cid) {
    timelineEl.innerHTML = "";
    const group = groups[cid];
    if (!group || !group.length) {
      const d = document.createElement("div");
      d.className = "empty";
      d.textContent = t("noEventsFilter");
      timelineEl.appendChild(d);
      return;
    }
    const list = group.slice().sort((a, b) => a.ts - b.ts);
    const s = summarize(list);

    const toolNames = collectToolNames(list);
    const toolsHtml = toolNames.length
      ? `<div class="tool-list">🔌 <b>${esc(t("calledTools"))}</b> ` +
          toolNames.map((n) => `<span class="tool-chip">${esc(n)}</span>`).join("") + `</div>`
      : "";

    const stat = document.createElement("div");
    stat.className = "event";
    stat.style.borderColor = "var(--accent)";
    stat.innerHTML = `<div class="event-body" style="display:block;padding:12px">
      <div class="stat-row">
        <span>${esc(t("statEvents"))} <b>${list.length}</b></span>
        <span>${esc(t("statLlm"))} <b>${s.llmCalls}</b></span>
        <span>${esc(t("statTool"))} <b>${s.toolCalls}</b></span>
        <span>${esc(t("statGateway"))} <b>${s.gateway}</b></span>
        <span>${esc(t("statEscalation"))} <b>${s.escalations}</b></span>
        <span>${esc(t("statError"))} <b style="color:${s.errors ? "var(--red)" : "inherit"}">${s.errors}</b></span>
        <span>${esc(t("statGuard"))} <b>${s.guardrailBlocks}</b></span>
      </div>${toolsHtml}</div>`;
    timelineEl.appendChild(stat);

    let shown = 0;
    for (const e of list) {
      if (!activeFilters.has(e.type) && ALL_TYPES.includes(e.type)) continue;
      // 单条事件渲染出错不应让整个时间线空白，兜底显示原始 JSON。
      try {
        timelineEl.appendChild(renderEvent(e));
      } catch (err) {
        const d = document.createElement("div");
        d.className = "event";
        d.innerHTML = `<div class="event-body" style="display:block;padding:10px">` +
          `<div class="kv"><b>${esc(e.type || "EVENT")}</b> · ${esc(new Date(e.ts).toLocaleString())}</div>` +
          `<pre class="raw">${esc(prettyRaw(e.raw))}</pre></div>`;
        timelineEl.appendChild(d);
      }
      shown++;
    }
    if (shown === 0) {
      const d = document.createElement("div");
      d.className = "empty";
      d.textContent = t("noEventsFilter");
      timelineEl.appendChild(d);
    }
  }

  function selectContact(cid) {
    activeCid = cid;
    selectedTitle.textContent = cid;
    renderSidebar(searchBox.value);
    renderTimeline(cid);
  }

  // ---- 按需翻译某个 Contact 的客户/机器人对话 ----
  async function translateContact(cid) {
    if (translatingContacts.has(cid)) return;
    const list = groups[cid] || [];
    // 收集尚未翻译、且有正文的对话事件
    const items = [];
    for (const e of list) {
      const text = getTranslatableText(e);
      if (text && !e.translation) items.push({ e: e, text: text });
    }
    if (!items.length) {
      // 没有新内容需要翻译(可能已全部翻译过)
      translatedContacts.add(cid);
      renderSidebar(searchBox.value);
      if (activeCid === cid) renderTimeline(cid);
      return;
    }
    translatingContacts.add(cid);
    renderSidebar(searchBox.value);
    try {
      const resp = await fetch("./api/translate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ texts: items.map((i) => i.text), lang: TRANSLATE_CFG.lang }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error((data && data.error) || ("HTTP " + resp.status));
      const translations = data.translations || [];
      items.forEach((it, i) => {
        it.e.translation = translations[i] || "";
        it.e.translationLang = data.lang || TRANSLATE_CFG.lang;
      });
      translatedContacts.add(cid);
    } catch (err) {
      window.alert(t("translateFailed") + (err && err.message ? err.message : err));
    } finally {
      translatingContacts.delete(cid);
      renderSidebar(searchBox.value);
      if (activeCid === cid) renderTimeline(cid);
    }
  }

  // ---- 读取本地服务器的翻译配置(可用性 / 默认语种) ----
  function loadTranslateConfig() {
    return fetch("./api/config")
      .then((r) => (r.ok ? r.json() : null))
      .then((cfg) => {
        if (cfg) TRANSLATE_CFG = { available: !!cfg.available, lang: cfg.lang || "中文" };
      })
      .catch(() => { /* 非翻译服务器(如 file:// 或 http.server) -> 隐藏翻译按钮 */ });
  }

  // ---- 渲染 Dashboard ----
  const dashContactRowsEl = document.getElementById("dashContactRows");
  const DASH_COLS = 29; // Contact 列表总列数(含 Action)

  // N/A 占位: 值为空 / null 时显示 N/A
  function na(v) {
    return (v == null || v === "") ? t("na") : v;
  }

  // Dashboard Contact 列表的排序状态: key = cid | start | end, dir = asc | desc
  let dashSort = { key: "start", dir: "desc" };

  function dashComparator(a, b) {
    const dir = dashSort.dir === "asc" ? 1 : -1;
    if (dashSort.key === "cid") {
      return dir * String(a.cid).localeCompare(String(b.cid));
    }
    let av = dashSort.key === "end" ? a.m.endTs : a.m.startTs;
    let bv = dashSort.key === "end" ? b.m.endTs : b.m.startTs;
    av = av == null ? -Infinity : av;
    bv = bv == null ? -Infinity : bv;
    if (av === bv) return String(a.cid).localeCompare(String(b.cid));
    return dir * (av - bv);
  }

  // 点击表头切换排序: 同列切换升/降序，换列则默认降序
  function setDashSort(key) {
    if (dashSort.key === key) {
      dashSort.dir = dashSort.dir === "asc" ? "desc" : "asc";
    } else {
      dashSort = { key: key, dir: "desc" };
    }
    renderDashboard();
  }

  // 更新表头的排序指示箭头与高亮
  function updateSortIndicators() {
    document.querySelectorAll(".contact-table th.sortable").forEach((th) => {
      const key = th.getAttribute("data-sort");
      const ind = th.querySelector(".sort-ind");
      const active = key === dashSort.key;
      th.classList.toggle("active", active);
      if (ind) ind.textContent = active ? (dashSort.dir === "asc" ? "▲" : "▼") : "";
    });
  }

  function renderDashboard() {
    // Contact 列表(支持按 Contact ID / Start Time / End Time 升降序)
    const rows = contactIds
      .filter((c) => c !== "(未关联的 Gateway 日志)")
      .map((cid) => ({ cid: cid, m: computeMetrics(groups[cid]) }));
    rows.sort(dashComparator);
    updateSortIndicators();

    dashContactRowsEl.innerHTML = "";
    if (!rows.length) {
      dashContactRowsEl.innerHTML = `<tr><td colspan="${DASH_COLS}" style="color:var(--muted)">${esc(t("noContactData"))}</td></tr>`;
      return;
    }
    for (const row of rows) {
      const cid = row.cid;
      const mm = row.m;
      const en = ENRICH[cid] || {};

      // 比率格式化(默认 0，不显示 N/A)
      const srRate = mm.srIntent ? Math.round((mm.srSuccess / mm.srIntent) * 100) + "%" : "0%";
      const latency = mm.responseLatency != null ? mm.responseLatency + " ms" : t("na");

      // Connect API 补充字段(缺失显示 N/A)
      const summary = en.summary || "";
      const disconnect = en.disconnectReason || "";
      const csat = (en.surveyResult != null ? en.surveyResult : en.csat);
      // 调用 AI Agent 次数: 优先用 Connect API 值，否则用日志派生值
      const aiCalls = (en.aiAgentCalls != null) ? en.aiAgentCalls : mm.aiAgentCalls;

      const cell = (v, cls) => `<td class="${cls || ""}${(v == null || v === "") ? " na" : ""}">${esc(v == null || v === "" ? t("na") : v)}</td>`;
      const numCell = (v) => `<td>${esc(v)}</td>`;

      const tr = document.createElement("tr");
      tr.className = "contact-row";
      tr.setAttribute("data-cid", cid);
      tr.innerHTML =
        cell(mm.bu) +
        cell(mm.locale) +
        cell(en.did || "", "did-cell") +
        `<td class="cid-cell"><span class="cid-value clickable" title="${esc(t("cdOpenTitle"))}">${esc(cid)}</span>` +
          `<button class="icon-btn js-copy-cid" title="${esc(t("titleCopy"))}">⧉</button></td>` +
        summaryCellHtml(summary) +
        `<td class="time-cell">${esc(formatDateTime(mm.startTs))}</td>` +
        `<td class="time-cell">${esc(formatDateTime(mm.endTs))}</td>` +
        `<td class="time-cell">${esc(formatDuration(mm.duration))}</td>` +
        `<td class="${mm.errors ? "num-bad" : ""}">${esc(mm.errors)}</td>` +
        numCell(mm.faqAsk) +
        numCell(mm.faqSend) +
        cell(disconnect, "disc-cell") +
        numCell(mm.srIntent) +
        numCell(mm.srSuccess) +
        `<td>${esc(srRate)}</td>` +
        cell(mm.srNumber, "sr-num-cell") +
        numCell(mm.srRounds != null ? mm.srRounds : 0) +
        `<td>${esc(latency)}</td>` +
        cell("") /* 意图识别准确率: 需标注数据, N/A */ +
        numCell(mm.interrupts) /* 用户打断次数: 取自 barge_in span */ +
        cell(csat, "csat-cell") +
        numCell(aiCalls) +
        numCell(mm.mcpToolCalls) +
        `<td class="${mm.escalated ? "flag-yes" : ""}">${esc(mm.escalated ? t("flagYes") : t("flagNo"))}</td>` +
        `<td class="reason-cell${mm.escalationReason ? "" : " na"}">${esc(mm.escalationReason || t("na"))}</td>` +
        `<td class="${mm.guardBlocks ? "num-warn" : ""}">${esc(mm.guardBlocks)}</td>` +
        guardReasonCellHtml(mm.guardReasons) +
        cell("") /* 静默超时次数: 日志无此信息, N/A */ +
        `<td class="act-cell"><button class="act-btn logs">${esc(t("btnLogs"))}</button></td>`;

      tr.querySelector(".act-btn.logs").addEventListener("click", () => openContactLogs(cid));
      tr.querySelector(".cid-value.clickable").addEventListener("click", () => openContactDetail(cid));
      // 拷贝 Contact ID(阻止冒泡，避免触发打开详情)
      const copyCidBtn = tr.querySelector(".js-copy-cid");
      copyCidBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        copyToClipboard(cid, copyCidBtn);
      });
      dashContactRowsEl.appendChild(tr);
    }
    // 行插入后再评估各摘要单元格是否溢出(需要真实布局), 决定是否显示「展开」按钮
    requestAnimationFrame(refreshAllSummaryToggles);
  }

  // 拦截原因单元格: 每条护栏命中单独一行，显示 guardrailName / policyType / details
  // 以及该原因的命中次数(×N); 各行次数之和等于「拦截次数」列。
  function guardReasonCellHtml(reasons) {
    if (!reasons || !reasons.length) return `<td class="reason-cell na">${esc(t("na"))}</td>`;
    const items = reasons.map((r) => {
      // 兼容纯字符串形式(视为命中 1 次)
      const text = typeof r === "string" ? r : r.text;
      const count = typeof r === "string" ? 1 : r.count;
      const parts = String(text).split(" · ");
      const name = parts.shift();
      const rest = parts.map((p) => `<span class="guard-part">${esc(p)}</span>`).join("");
      return `<div class="guard-reason"><span class="guard-name">${esc(name)}</span>${rest}` +
        `<span class="guard-count" title="${esc(t("guardReasonCountTitle"))}">×${esc(count)}</span></div>`;
    }).join("");
    return `<td class="reason-cell">${items}</td>`;
  }

  // 通话摘要单元格: 有内容时用可折叠容器 + 「展开/收起」按钮(是否显示按钮由溢出检测决定)
  function summaryCellHtml(summary) {
    if (!summary) return `<td class="summary-cell na">${esc(t("na"))}</td>`;
    return `<td class="summary-cell"><div class="summary-text">${esc(summary)}</div>` +
      `<button type="button" class="summary-toggle" style="display:none">${esc(t("expand"))}</button></td>`;
  }

  // 检测某个摘要单元格在折叠态是否溢出(内容超过列宽/行数), 相应显示或隐藏「展开」按钮
  function refreshSummaryToggle(td) {
    const textEl = td.querySelector(".summary-text");
    const btn = td.querySelector(".summary-toggle");
    if (!textEl || !btn) return;
    const wasExpanded = td.classList.contains("expanded");
    td.classList.remove("expanded"); // 先回到折叠态才能测量溢出
    const overflow = textEl.scrollHeight - textEl.clientHeight > 1;
    if (overflow) {
      btn.style.display = "";
      if (wasExpanded) td.classList.add("expanded"); // 恢复用户之前的展开状态
      btn.textContent = td.classList.contains("expanded") ? t("collapse") : t("expand");
    } else {
      btn.style.display = "none";
      td.classList.remove("expanded");
    }
  }

  function refreshAllSummaryToggles() {
    if (!dashContactRowsEl) return;
    dashContactRowsEl.querySelectorAll(".summary-cell").forEach(refreshSummaryToggle);
  }

  // ---- 视图切换(Dashboard / 日志排查 / Contact 详情) ----
  const viewDashboard = document.getElementById("viewDashboard");
  const viewLog = document.getElementById("viewLog");
  const viewContact = document.getElementById("viewContact");
  const navDashboard = document.getElementById("navDashboard");
  const navLog = document.getElementById("navLog");
  const navContact = document.getElementById("navContact");

  function showView(name) {
    viewDashboard.classList.toggle("show", name === "dashboard");
    viewLog.style.display = name === "log" ? "flex" : "none";
    // viewContact 的 index.html 里带内联 style="display:none"，内联样式优先级高于
    // .contact-detail.show 的样式表规则，因此必须直接用内联 display 控制显隐。
    viewContact.style.display = name === "contact" ? "block" : "none";
    viewContact.classList.toggle("show", name === "contact");
    navDashboard.classList.toggle("active", name === "dashboard");
    navLog.classList.toggle("active", name === "log");
    navContact.classList.toggle("active", name === "contact");
  }

  // 从 Dashboard 点击「日志」: 切到日志排查视图并选中该 Contact
  function openContactLogs(cid) {
    showView("log");
    selectContact(cid);
  }

  // ---- Contact 详情(DescribeContact) ----
  const cdCidEl = document.getElementById("cdCid");
  const cdBodyEl = document.getElementById("cdBody");
  const cdRefreshBtn = document.getElementById("cdRefresh");
  let cdContactId = null;

  // 从日志里抽取某个 Contact 对应的 instanceId(DescribeContact 需要)
  function extractInstanceId(cid) {
    const list = groups[cid] || [];
    for (const e of list) {
      const raw = e.raw || "";
      let m = raw.match(/[-"']?\s*instanceId["']?\s*[:=]\s*["']?([0-9a-fA-F-]{20,})/);
      if (m) return m[1];
      // ai_agent_arn / prompt_arn 里也可能带 instance 段, 但优先用显式 instanceId
    }
    return "";
  }

  // 点击 Contact ID: 显示「Contact 详情」tab 并加载 DescribeContact 结果
  function openContactDetail(cid) {
    cdContactId = cid;
    navContact.style.display = "";
    cdCidEl.textContent = cid;
    showView("contact");
    loadDescribeContact(cid);
  }

  // 拉取并渲染 DescribeContact 结果:
  //   1) 优先请求本地预览服务器的 ./api/describe-contact(实时调用 Amazon Connect)
  //   2) 回退到预抓取的 connect-enrich.js 里的 describeContact 缓存
  //   3) 都没有 -> 提示如何启用
  async function loadDescribeContact(cid, forceRefresh) {
    cdBodyEl.innerHTML = `<div class="cd-status">${esc(t("cdLoading"))}</div>`;
    const instanceId = extractInstanceId(cid) ||
      (window.__AWS_CONFIG__ && window.__AWS_CONFIG__.connectInstanceId) || "";

    // 1) CloudFront 部署: 浏览器用 AWS SDK + Cognito 临时凭证直接调用 DescribeContact
    //    (结果按 Contact 缓存，forceRefresh=true 时绕过缓存重新拉取)
    if (typeof window.__CONNECT_DESCRIBE_CONTACT__ === "function") {
      try {
        const data = await window.__CONNECT_DESCRIBE_CONTACT__(cid, instanceId, forceRefresh);
        const contact = data && (data.Contact || data);
        if (contact && (contact.Id || contact.Arn || contact.Channel)) {
          renderDescribeContact(cid, contact, "api");
          return;
        }
        throw new Error("DescribeContact 返回空结果");
      } catch (err) {
        const cached = (ENRICH[cid] || {}).describeContact;
        if (cached) { renderDescribeContact(cid, cached.Contact || cached, "cache"); return; }
        cdBodyEl.innerHTML =
          `<div class="cd-status err">${esc(t("cdError"))}${esc(err && err.message ? err.message : String(err))}</div>` +
          `<div class="cd-status">${esc(t("cdHint"))}</div>`;
        return;
      }
    }

    // 2) 本地 serve.py: /api/describe-contact 端点
    try {
      const qs = "contactId=" + encodeURIComponent(cid) +
        (instanceId ? "&instanceId=" + encodeURIComponent(instanceId) : "");
      const resp = await fetch("./api/describe-contact?" + qs);
      const data = await resp.json().catch(() => ({}));
      if (resp.ok && data && data.Contact) {
        renderDescribeContact(cid, data.Contact, "api");
        return;
      }
      if (resp.ok && data && !data.Contact && !data.error) {
        // 有的 API 直接返回 Contact 字段在顶层
        renderDescribeContact(cid, data, "api");
        return;
      }
      throw new Error((data && data.error) || ("HTTP " + resp.status));
    } catch (err) {
      // 回退: enrich 缓存
      const cached = (ENRICH[cid] || {}).describeContact;
      if (cached) {
        renderDescribeContact(cid, cached.Contact || cached, "cache");
        return;
      }
      cdBodyEl.innerHTML =
        `<div class="cd-status err">${esc(t("cdError"))}${esc(err && err.message ? err.message : String(err))}</div>` +
        `<div class="cd-status">${esc(t("cdHint"))}</div>`;
    }
  }

  // 渲染 DescribeContact 的 Contact 对象: 关键字段表 + 完整 JSON
  function renderDescribeContact(cid, contact, srcKind) {
    const rows = [
      ["Id", contact.Id],
      ["Arn", contact.Arn],
      ["Channel", contact.Channel],
      ["InitiationMethod", contact.InitiationMethod],
      ["Name", contact.Name],
      ["Description", contact.Description],
      ["InitiationTimestamp", fmtMaybeTime(contact.InitiationTimestamp)],
      ["DisconnectTimestamp", fmtMaybeTime(contact.DisconnectTimestamp)],
      ["LastUpdateTimestamp", fmtMaybeTime(contact.LastUpdateTimestamp)],
      ["ScheduledTimestamp", fmtMaybeTime(contact.ScheduledTimestamp)],
      ["DisconnectReason", contact.DisconnectReason],
      ["QueueInfo", contact.QueueInfo ? JSON.stringify(contact.QueueInfo) : ""],
      ["AgentInfo", contact.AgentInfo ? JSON.stringify(contact.AgentInfo) : ""],
      ["RoutingCriteria", contact.RoutingCriteria ? JSON.stringify(contact.RoutingCriteria) : ""],
      ["Tags", contact.Tags ? JSON.stringify(contact.Tags) : ""],
    ];
    let html = "";
    const srcLabel = srcKind === "cache" ? t("cdSrcCache") : t("cdSrcApi");
    html += `<div class="cd-status">${esc(t("cdSource", { src: srcLabel }))}</div>`;
    html += `<table class="cd-fields"><tbody>`;
    for (const [k, v] of rows) {
      if (v === undefined || v === null || v === "") continue;
      html += `<tr><th>${esc(k)}</th><td>${esc(String(v))}</td></tr>`;
    }
    html += `</tbody></table>`;
    html += `<div class="cd-section-title">${esc(t("cdRawJson"))}</div>`;
    let pretty = "";
    try { pretty = JSON.stringify(contact, null, 2); } catch (e) { pretty = String(contact); }
    html += `<pre class="cd-json">${esc(pretty)}</pre>`;
    // 「完整 JSON」下方再展示一段包含 AutomatedInteractionSummary 的 JSON(异步填充)
    html += `<div id="cdSummaryBox"></div>`;
    cdBodyEl.innerHTML = html;
    fillSummaryJson(cid, contact);
  }

  // 在 Contact 详情里渲染"自动交互摘要"的 JSON 块。摘要不在 DescribeContact 返回体里,
  // 已缓存则直接用, 否则(CloudFront 版)按需从 S3 分析结果拉取后再填充。
  function fillSummaryJson(cid, contact) {
    const box = document.getElementById("cdSummaryBox");
    if (!box) return;
    const render = (summary) => {
      if (!summary || box !== document.getElementById("cdSummaryBox")) return;
      const obj = { ContactSummary: { AutomatedInteractionSummary: { Content: summary } } };
      let j = "";
      try { j = JSON.stringify(obj, null, 2); } catch (e) { j = String(summary); }
      box.innerHTML = `<div class="cd-section-title">${esc(t("cdSummaryJson"))}</div>` +
        `<pre class="cd-json">${esc(j)}</pre>`;
    };
    const existing = (ENRICH[cid] || {}).summary;
    if (existing) { render(existing); return; }
    if (typeof window.__CONNECT_FETCH_SUMMARY__ === "function" && contact) {
      window.__CONNECT_FETCH_SUMMARY__(contact).then((s) => {
        if (s) {
          const e = ENRICH[cid] || (ENRICH[cid] = {});
          e.summary = s;
          render(s);
          patchEnrichCells(cid);
        }
      }).catch(() => { /* 拉取失败: 不显示该块 */ });
    }
  }

  // 时间戳格式化: 支持 epoch(秒/毫秒) 或 ISO 字符串
  function fmtMaybeTime(v) {
    if (v == null || v === "") return "";
    let d;
    if (typeof v === "number") {
      d = new Date(v > 1e12 ? v : v * 1000);
    } else {
      const n = Number(v);
      d = isNaN(n) ? new Date(v) : new Date(n > 1e12 ? n : n * 1000);
    }
    return isNaN(d.getTime()) ? String(v) : d.toLocaleString([], { hour12: false }) + "  (" + String(v) + ")";
  }

  // 从 DescribeContact 的 Contact 对象里取"接电话的 DID"(系统侧号码)
  //   优先 SystemEndpoint.Address, 回退到 Tags["aws:connect:systemEndpoint"]
  function pickDidFromContact(contact) {
    if (!contact) return "";
    const ep = contact.SystemEndpoint || contact.systemEndpoint;
    if (ep && (ep.Address || ep.address)) return ep.Address || ep.address;
    const tags = contact.Tags || {};
    if (tags["aws:connect:systemEndpoint"]) return tags["aws:connect:systemEndpoint"];
    return "";
  }

  // CloudFront 部署下: 用浏览器 SDK 为每个 Contact 调用 DescribeContact，
  // 派生「接电话的 DID」「挂断方(DisconnectReason)」并缓存完整结果，随后刷新列表。
  // 受限并发，逐个 Contact 容错，完成一批后触发一次重绘。
  // 就地更新某个 Contact 行的 DID / 挂断方单元格(不重建整表，
  // 避免后台补数据时打断用户点击、或重置横向滚动位置)。
  function patchEnrichCells(cid) {
    const e = ENRICH[cid] || {};
    const rows = dashContactRowsEl.querySelectorAll("tr.contact-row");
    for (const tr of rows) {
      if (tr.getAttribute("data-cid") !== cid) continue;
      if (e.did) {
        const c = tr.querySelector(".did-cell");
        if (c) { c.textContent = e.did; c.classList.remove("na"); }
      }
      if (e.disconnectReason) {
        const c = tr.querySelector(".disc-cell");
        if (c) { c.textContent = e.disconnectReason; c.classList.remove("na"); }
      }
      if (e.surveyResult != null && e.surveyResult !== "") {
        const c = tr.querySelector(".csat-cell");
        if (c) { c.textContent = e.surveyResult; c.classList.remove("na"); }
      }
      if (e.summary) {
        const c = tr.querySelector(".summary-cell");
        if (c) {
          c.classList.remove("na");
          let textEl = c.querySelector(".summary-text");
          if (!textEl) {
            c.innerHTML = `<div class="summary-text"></div>` +
              `<button type="button" class="summary-toggle" style="display:none">${esc(t("expand"))}</button>`;
            textEl = c.querySelector(".summary-text");
          }
          textEl.textContent = e.summary;
          requestAnimationFrame(() => refreshSummaryToggle(c));
        }
      }
      break;
    }
  }

  function enrichContactsViaConnect() {
    if (typeof window.__CONNECT_DESCRIBE_CONTACT__ !== "function") return;
    const realCids = contactIds.filter(
      (c) => c !== "(未关联的 Gateway 日志)" && /^[A-Za-z0-9._-]+$/.test(c)
    );
    let idx = 0;
    const CONCURRENCY = 4;

    function worker() {
      if (idx >= realCids.length) return Promise.resolve();
      const cid = realCids[idx++];
      const instanceId = extractInstanceId(cid) ||
        (window.__AWS_CONFIG__ && window.__AWS_CONFIG__.connectInstanceId) || "";
      // 已有 DescribeContact 缓存则直接就地更新，跳过 API 调用;
      // 但若摘要仍缺失, 仍尝试从 S3 分析结果补一次(缓存里可能只有基础字段)。
      if ((ENRICH[cid] || {}).describeContact) {
        patchEnrichCells(cid);
        const ec = ENRICH[cid];
        if (typeof window.__CONNECT_FETCH_SUMMARY__ === "function" && !ec.summary) {
          const cached = ec.describeContact.Contact || ec.describeContact;
          window.__CONNECT_FETCH_SUMMARY__(cached).then((s) => {
            if (s) { ec.summary = s; patchEnrichCells(cid); }
          }).catch(() => { /* 忽略 */ });
        }
        return worker();
      }
      return window.__CONNECT_DESCRIBE_CONTACT__(cid, instanceId)
        .then((data) => {
          const contact = data && (data.Contact || data);
          if (contact) {
            const e = ENRICH[cid] || (ENRICH[cid] = {});
            e.describeContact = { Contact: contact };
            const did = pickDidFromContact(contact);
            if (did && !e.did) e.did = did;
            if (contact.DisconnectReason && !e.disconnectReason) e.disconnectReason = contact.DisconnectReason;
            // CSAT: DescribeContact 返回的 Attributes 里按配置键名取值(不写死)
            const cAttrs = (contact.Attributes && typeof contact.Attributes === "object") ? contact.Attributes : {};
            const csatVal = cAttrs[CSAT_ATTR];
            if (csatVal != null && csatVal !== "" && (e.surveyResult == null || e.surveyResult === "")) {
              e.surveyResult = csatVal;
            }
            patchEnrichCells(cid); // 就地更新单元格，不重建整表
            // 通话/自动交互智能摘要: 从与录音同桶的分析结果 JSON 读取(异步, 到手后再就地更新)
            if (typeof window.__CONNECT_FETCH_SUMMARY__ === "function" && !e.summary) {
              window.__CONNECT_FETCH_SUMMARY__(contact).then((s) => {
                if (s) { e.summary = s; patchEnrichCells(cid); }
              }).catch(() => { /* 摘要拉取失败忽略, 保持 N/A */ });
            }
          }
        })
        .catch(() => { /* 单个失败忽略 */ })
        .then(() => worker());
    }

    for (let w = 0; w < Math.min(CONCURRENCY, realCids.length); w++) worker();
  }

  // 「刷新通话摘要」按钮: 遍历 Contact 列表, 对「通话摘要」为空的 Contact 调用
  // Connect API(DescribeContact 取录音位置 + S3 分析结果 JSON)在线获取摘要,
  // 到手后就地更新对应单元格。仅在 CloudFront 部署(注入了在线取数函数)时可用。
  let summaryRefreshing = false;
  function refreshEmptySummaries() {
    const btn = document.getElementById("btnRefreshSummary");
    if (summaryRefreshing) return;

    // 非 CloudFront 部署 / 未配置 Connect: 无法在线获取, 给出提示后复位
    if (typeof window.__CONNECT_FETCH_SUMMARY__ !== "function" ||
        typeof window.__CONNECT_DESCRIBE_CONTACT__ !== "function") {
      if (btn) {
        btn.textContent = t("summaryRefreshNA");
        setTimeout(() => { btn.textContent = t("btnRefreshSummary"); }, 2500);
      }
      return;
    }

    // 找出「通话摘要」为空的真实 Contact
    const targets = contactIds.filter(
      (c) => c !== "(未关联的 Gateway 日志)" &&
             /^[A-Za-z0-9._-]+$/.test(c) &&
             !(ENRICH[c] || {}).summary
    );
    if (!targets.length) {
      if (btn) {
        btn.textContent = t("summaryRefreshNone");
        setTimeout(() => { btn.textContent = t("btnRefreshSummary"); }, 2000);
      }
      return;
    }

    summaryRefreshing = true;
    if (btn) btn.disabled = true;

    let idx = 0, done = 0, updated = 0;
    const CONCURRENCY = 4;

    function setProgress() {
      if (btn) btn.textContent = t("summaryRefreshing", { done: done, total: targets.length });
    }
    setProgress();

    // 取到 Contact 对象后, 调用在线摘要函数(forceRefresh 绕过其内部缓存)
    function fetchSummaryFor(cid, contact) {
      return window.__CONNECT_FETCH_SUMMARY__(contact, true).then((s) => {
        if (s) {
          const e = ENRICH[cid] || (ENRICH[cid] = {});
          e.summary = s;
          updated++;
          patchEnrichCells(cid);
        }
      }).catch(() => { /* 单个失败忽略 */ });
    }

    function worker() {
      if (idx >= targets.length) return Promise.resolve();
      const cid = targets[idx++];
      const instanceId = extractInstanceId(cid) ||
        (window.__AWS_CONFIG__ && window.__AWS_CONFIG__.connectInstanceId) || "";
      const ec = ENRICH[cid] || (ENRICH[cid] = {});
      const cached = ec.describeContact && (ec.describeContact.Contact || ec.describeContact);
      // 已有 DescribeContact 缓存(含录音位置)直接用, 否则强制拉一次以拿到录音位置
      const p = cached
        ? fetchSummaryFor(cid, cached)
        : window.__CONNECT_DESCRIBE_CONTACT__(cid, instanceId, true).then((data) => {
            const contact = data && (data.Contact || data);
            if (contact) {
              ec.describeContact = { Contact: contact };
              return fetchSummaryFor(cid, contact);
            }
          }).catch(() => { /* 忽略 */ });
      return p.then(() => { done++; setProgress(); return worker(); });
    }

    const starters = [];
    for (let w = 0; w < Math.min(CONCURRENCY, targets.length); w++) starters.push(worker());
    Promise.all(starters).then(() => {
      summaryRefreshing = false;
      if (btn) {
        btn.disabled = false;
        btn.textContent = t("summaryRefreshDone", { n: updated });
        setTimeout(() => { btn.textContent = t("btnRefreshSummary"); }, 2500);
      }
    });
  }

  // 更新顶部的事件/Contact 计数(随语言变化)
  function updateGlobalMeta() {
    document.getElementById("globalMeta").textContent =
      t("meta", { n: events.length, m: contactIds.length });
  }

  // 切换界面语言: 保存选择、刷新静态文案并重绘所有动态视图
  function applyLanguage(lang) {
    if (!I18N[lang]) lang = DEFAULT_LANG;
    currentLang = lang;
    try { localStorage.setItem("connectAiUiLang", lang); } catch (e) { /* 忽略 */ }
    applyStaticI18n();
    updateGlobalMeta();
    renderSidebar(searchBox.value);
    renderDashboard();
    // selectedTitle 在选中会话后显示 Contact ID，未选中时显示占位文案
    if (activeCid) {
      selectedTitle.textContent = activeCid;
      renderTimeline(activeCid);
    }
  }

  // ---- 初始化 ----
  function init() {
    applyStaticI18n();
    updateGlobalMeta();
    // 语言下拉框
    const langSelect = document.getElementById("langSelect");
    if (langSelect) {
      langSelect.value = currentLang;
      langSelect.addEventListener("change", () => applyLanguage(langSelect.value));
    }
    renderFilters();
    renderSidebar("");
    renderDashboard();
    searchBox.addEventListener("input", () => renderSidebar(searchBox.value));
    const sortSelect = document.getElementById("sortSelect");
    if (sortSelect) {
      sortSelect.value = currentSort;
      sortSelect.addEventListener("change", () => {
        currentSort = sortSelect.value;
        renderSidebar(searchBox.value);
        renderDashboard();
      });
    }

    // 导航事件
    navDashboard.addEventListener("click", () => showView("dashboard"));
    navLog.addEventListener("click", () => showView("log"));
    navContact.addEventListener("click", () => { if (cdContactId) showView("contact"); });
    cdRefreshBtn.addEventListener("click", () => { if (cdContactId) loadDescribeContact(cdContactId, true); });

    // Dashboard「刷新通话摘要」按钮: 为摘要为空的 Contact 在线补取摘要
    const btnRefreshSummary = document.getElementById("btnRefreshSummary");
    if (btnRefreshSummary) btnRefreshSummary.addEventListener("click", refreshEmptySummaries);

    // Dashboard 表头点击排序
    document.querySelectorAll(".contact-table th.sortable").forEach((th) => {
      th.addEventListener("click", () => setDashSort(th.getAttribute("data-sort")));
    });

    // 通话摘要「展开/收起」按钮(事件委托, 适配重建行/异步补数据)
    if (dashContactRowsEl) {
      dashContactRowsEl.addEventListener("click", (ev) => {
        const btn = ev.target.closest(".summary-toggle");
        if (!btn) return;
        const td = btn.closest(".summary-cell");
        if (!td) return;
        const expanded = td.classList.toggle("expanded");
        btn.textContent = expanded ? t("collapse") : t("expand");
      });
    }
    // 窗口尺寸变化会影响列宽/换行, 需重新评估是否显示「展开」按钮(防抖)
    let _sumResizeTimer = null;
    window.addEventListener("resize", () => {
      clearTimeout(_sumResizeTimer);
      _sumResizeTimer = setTimeout(refreshAllSummaryToggles, 150);
    });

    if (contactIds.length) selectContact(getOrderedContactIds()[0]);
    // 探测翻译能力，成功后重绘侧栏以显示翻译按钮
    loadTranslateConfig().then(() => renderSidebar(searchBox.value));

    // CloudFront 部署: 后台用 Connect API 补全 DID / 挂断方等列
    enrichContactsViaConnect();

    // 默认展示 Dashboard
    showView("dashboard");
  }

  init();
})();
