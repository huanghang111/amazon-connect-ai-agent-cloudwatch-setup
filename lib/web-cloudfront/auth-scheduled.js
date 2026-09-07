/* auth-scheduled.js — CloudFront「定时按天」部署版的登录门禁与按日期加载
 *
 * 在 auth.js 的全部能力(Cognito 登录 / 首次改密 / 忘记密码 / 用临时凭证读 S3 日志 /
 * 浏览器调用 Connect DescribeContact 与自动交互摘要)之上，新增:
 *
 *   1) 按日期分区加载: 数据由定时 Lambda 归档、拆分到
 *        s3://<logsBucket>/<dailyPrefix><date>/index.json 与 .../logs/*.log
 *      登录后先列出 <dailyPrefix> 下已有的日期(YYYY-MM-DD)，默认加载最新一天。
 *   2) 顶部「日期」控件: 选择某一天即加载并展示当天的 Contact 列表与日志。
 *   3) 会话保持: 首次登录成功后把 idToken(及过期时间)与所选日期暂存到 sessionStorage，
 *      切换日期时整页刷新并静默复用会话(免重复登录)，从而完整复用 app.js 的渲染逻辑。
 *
 * 依赖: aws-sdk(浏览器版) + aws-config.js(部署脚本生成，含各资源 ID 与 dailyPrefix)。
 */
(function () {
  "use strict";

  var CFG = window.__AWS_CONFIG__ || {};
  var IDP_ENDPOINT = "https://cognito-idp." + CFG.region + ".amazonaws.com/";
  var DAILY_PREFIX = CFG.dailyPrefix || "daily/";
  var SESSION_KEY = "connectAiAuthSession";
  var DATE_KEY = "connectAiSelectedDate";

  var idToken = "";
  var pendingEmail = "";
  var pendingSession = "";
  var availableDates = [];
  var selectedDate = "";

  var CONNECT_V3_CLIENT_URL = "https://cdn.jsdelivr.net/npm/@aws-sdk/client-connect@3/+esm";
  var _connectV3Promise = null;

  function v2CredentialProvider() {
    return AWS.config.credentials.getPromise().then(function () {
      var c = AWS.config.credentials;
      return {
        accessKeyId: c.accessKeyId,
        secretAccessKey: c.secretAccessKey,
        sessionToken: c.sessionToken,
        expiration: c.expireTime ? new Date(c.expireTime) : undefined,
      };
    });
  }

  function loadConnectV3(region) {
    if (_connectV3Promise) return _connectV3Promise;
    _connectV3Promise = import(CONNECT_V3_CLIENT_URL).then(function (connectMod) {
      var client = new connectMod.ConnectClient({
        region: region,
        credentials: v2CredentialProvider,
      });
      return { client: client, DescribeContactCommand: connectMod.DescribeContactCommand };
    }).catch(function (e) {
      _connectV3Promise = null;
      throw e;
    });
    return _connectV3Promise;
  }

  function rawDescribeContact(iid, region, contactId) {
    return new Promise(function (resolve, reject) {
      if (!window.AWS || !AWS.HttpClient || !AWS.Signers || !AWS.Signers.V4) {
        reject(new Error("AWS SDK 未加载(缺少签名/HTTP 组件)。")); return;
      }
      AWS.config.credentials.get(function (credErr) {
        if (credErr) { reject(credErr); return; }
        try {
          var endpoint = new AWS.Endpoint("https://connect." + region + ".amazonaws.com");
          var req = new AWS.HttpRequest(endpoint, region);
          req.method = "GET";
          req.path = "/contacts/" + encodeURIComponent(iid) + "/" + encodeURIComponent(contactId);
          req.headers["Host"] = endpoint.host;
          req.headers["Content-Type"] = "application/x-amz-json-1.1";
          new AWS.Signers.V4(req, "connect").addAuthorization(AWS.config.credentials, new Date());
          new AWS.HttpClient().handleRequest(req, null, function (resp) {
            var body = "";
            resp.on("data", function (chunk) { body += chunk; });
            resp.on("end", function () {
              var data = {};
              try { data = JSON.parse(body || "{}"); } catch (e) { data = {}; }
              if (resp.statusCode >= 400) {
                reject(new Error((data && (data.message || data.Message || data.__type)) ||
                  ("HTTP " + resp.statusCode)));
                return;
              }
              resolve(data);
            });
          }, function (httpErr) { reject(httpErr); });
        } catch (e) { reject(e); }
      });
    });
  }

  var T = {
    title: "Connect AI Agent 日志排查",
    subtitle: "请登录后查看会话日志 / Sign in to view logs",
    email: "邮箱 Email",
    password: "密码 Password",
    login: "登录 Sign in",
    forgot: "忘记密码？Forgot password?",
    newPassTitle: "首次登录，请设置新密码 / Set a new password",
    newPass: "新密码 New password",
    confirmPass: "确认新密码 Confirm password",
    submit: "提交 Submit",
    back: "返回登录 Back",
    forgotTitle: "忘记密码 / Reset password",
    sendCode: "发送验证码 Send code",
    code: "邮箱收到的验证码 Verification code",
    resetPass: "重置密码 Reset password",
    loading: "正在加载日志… Loading logs…",
    signingIn: "正在登录… Signing in…",
    codeSent: "验证码已发送到你的邮箱，请查收。A code has been sent to your email.",
    pwMismatch: "两次输入的密码不一致。Passwords do not match.",
    needConfig: "缺少部署配置(aws-config.js)，无法登录。",
    dateLabel: "日期 Date",
    noDates: "暂无按天归档的数据。定时任务运行后会自动出现。No daily data yet.",
    loadingDates: "正在获取可选日期… Loading dates…",
  };

  function idp(target, body) {
    return fetch(IDP_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-amz-json-1.1",
        "X-Amz-Target": "AWSCognitoIdentityProviderService." + target,
      },
      body: JSON.stringify(body),
    }).then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok) {
          var msg = data.message || data.Message || data.__type || "请求失败";
          throw new Error(msg);
        }
        return data;
      });
    });
  }

  // ---- 会话暂存(切换日期时整页刷新后免重登) ----
  function saveSession(token, expiresInSec) {
    try {
      var exp = Date.now() + (Number(expiresInSec) || 3600) * 1000;
      sessionStorage.setItem(SESSION_KEY, JSON.stringify({ idToken: token, exp: exp }));
    } catch (e) { /* 忽略(隐私模式等) */ }
  }
  function loadSession() {
    try {
      var raw = sessionStorage.getItem(SESSION_KEY);
      if (!raw) return null;
      var s = JSON.parse(raw);
      if (!s || !s.idToken || !s.exp || Date.now() >= s.exp - 30000) return null;
      return s;
    } catch (e) { return null; }
  }
  function clearSession() {
    try { sessionStorage.removeItem(SESSION_KEY); } catch (e) { /* 忽略 */ }
  }
  function getStoredDate() {
    try { return sessionStorage.getItem(DATE_KEY) || ""; } catch (e) { return ""; }
  }
  function setStoredDate(d) {
    try { sessionStorage.setItem(DATE_KEY, d || ""); } catch (e) { /* 忽略 */ }
  }

  var overlay, statusEl;

  function h(tag, attrs, children) {
    var el = document.createElement(tag);
    attrs = attrs || {};
    for (var k in attrs) {
      if (k === "style") el.style.cssText = attrs[k];
      else if (k === "class") el.className = attrs[k];
      else el.setAttribute(k, attrs[k]);
    }
    (children || []).forEach(function (c) {
      el.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    });
    return el;
  }

  function injectStyles() {
    var css =
      "#authOverlay{position:fixed;inset:0;z-index:99999;background:#0f1117;" +
      "display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'PingFang SC','Microsoft YaHei',sans-serif;color:#e6e8ee}" +
      "#authCard{width:380px;max-width:92vw;background:#171a22;border:1px solid #2a2f3a;border-radius:12px;padding:26px 24px;box-shadow:0 12px 40px rgba(0,0,0,.5)}" +
      "#authCard h2{margin:0 0 4px;font-size:18px}" +
      "#authCard .sub{color:#9aa3b2;font-size:12px;margin-bottom:18px}" +
      "#authCard label{display:block;font-size:12px;color:#9aa3b2;margin:12px 0 5px}" +
      "#authCard input{width:100%;padding:10px 11px;background:#1e222c;border:1px solid #2a2f3a;border-radius:7px;color:#e6e8ee;font-size:14px}" +
      "#authCard input:focus{outline:none;border-color:#4f9cff}" +
      "#authCard button.primary{width:100%;margin-top:18px;padding:11px;background:#4f9cff;color:#fff;border:none;border-radius:7px;font-size:14px;font-weight:600;cursor:pointer}" +
      "#authCard button.primary:hover{background:#3d8bef}" +
      "#authCard button.primary:disabled{opacity:.6;cursor:default}" +
      "#authCard .linkrow{margin-top:14px;text-align:center}" +
      "#authCard a.link{color:#4f9cff;font-size:12px;cursor:pointer;text-decoration:none}" +
      "#authCard a.link:hover{text-decoration:underline}" +
      "#authStatus{margin-top:14px;font-size:12px;min-height:16px;text-align:center;color:#9aa3b2;white-space:pre-wrap}" +
      "#authStatus.err{color:#f85149}" +
      "#authStatus.ok{color:#3fb950}" +
      /* 顶部日期控件 */
      ".date-picker{display:flex;align-items:center;gap:6px;margin-left:16px}" +
      ".date-picker label{font-size:12px;color:#9aa3b2;white-space:nowrap}" +
      ".date-picker select,.date-picker input{padding:5px 8px;background:#1e222c;border:1px solid #2a2f3a;" +
      "border-radius:6px;color:#e6e8ee;font-size:12px;cursor:pointer}";
    document.head.appendChild(h("style", {}, [css]));
  }

  function setStatus(msg, kind) {
    if (!statusEl) return;
    statusEl.textContent = msg || "";
    statusEl.className = kind || "";
  }

  function clearCard() {
    var card = document.getElementById("authCard");
    card.innerHTML = "";
    return card;
  }

  function showLogin(prefillEmail) {
    var card = clearCard();
    card.appendChild(h("h2", {}, [T.title]));
    card.appendChild(h("div", { class: "sub" }, [T.subtitle]));

    var emailInput = h("input", { type: "email", id: "emEmail", value: prefillEmail || pendingEmail || "", autocomplete: "username" });
    var passInput = h("input", { type: "password", id: "emPass", autocomplete: "current-password" });
    card.appendChild(h("label", {}, [T.email]));
    card.appendChild(emailInput);
    card.appendChild(h("label", {}, [T.password]));
    card.appendChild(passInput);

    var btn = h("button", { class: "primary" }, [T.login]);
    card.appendChild(btn);

    var linkRow = h("div", { class: "linkrow" }, []);
    var forgot = h("a", { class: "link" }, [T.forgot]);
    linkRow.appendChild(forgot);
    card.appendChild(linkRow);

    statusEl = h("div", { id: "authStatus" }, []);
    card.appendChild(statusEl);

    function submit() {
      var email = emailInput.value.trim();
      var pass = passInput.value;
      if (!email || !pass) { setStatus("请输入邮箱和密码。", "err"); return; }
      pendingEmail = email;
      btn.disabled = true;
      setStatus(T.signingIn, "");
      idp("InitiateAuth", {
        AuthFlow: "USER_PASSWORD_AUTH",
        ClientId: CFG.clientId,
        AuthParameters: { USERNAME: email, PASSWORD: pass },
      }).then(function (data) {
        if (data.ChallengeName === "NEW_PASSWORD_REQUIRED") {
          pendingSession = data.Session;
          showNewPassword();
          return;
        }
        if (data.AuthenticationResult && data.AuthenticationResult.IdToken) {
          onAuthenticated(data.AuthenticationResult.IdToken, data.AuthenticationResult.ExpiresIn);
          return;
        }
        setStatus("暂不支持的认证流程: " + (data.ChallengeName || "?"), "err");
        btn.disabled = false;
      }).catch(function (e) {
        setStatus(e.message || "登录失败", "err");
        btn.disabled = false;
      });
    }

    btn.addEventListener("click", submit);
    passInput.addEventListener("keydown", function (e) { if (e.key === "Enter") submit(); });
    forgot.addEventListener("click", function () { showForgot(emailInput.value.trim()); });
  }

  function showNewPassword() {
    var card = clearCard();
    card.appendChild(h("h2", {}, [T.newPassTitle]));
    card.appendChild(h("div", { class: "sub" }, [pendingEmail]));

    var p1 = h("input", { type: "password", id: "np1", autocomplete: "new-password" });
    var p2 = h("input", { type: "password", id: "np2", autocomplete: "new-password" });
    card.appendChild(h("label", {}, [T.newPass]));
    card.appendChild(p1);
    card.appendChild(h("label", {}, [T.confirmPass]));
    card.appendChild(p2);

    var btn = h("button", { class: "primary" }, [T.submit]);
    card.appendChild(btn);
    statusEl = h("div", { id: "authStatus" }, []);
    card.appendChild(statusEl);

    btn.addEventListener("click", function () {
      if (p1.value !== p2.value) { setStatus(T.pwMismatch, "err"); return; }
      if (!p1.value) { setStatus("请输入新密码。", "err"); return; }
      btn.disabled = true;
      setStatus(T.signingIn, "");
      idp("RespondToAuthChallenge", {
        ClientId: CFG.clientId,
        ChallengeName: "NEW_PASSWORD_REQUIRED",
        Session: pendingSession,
        ChallengeResponses: { USERNAME: pendingEmail, NEW_PASSWORD: p1.value },
      }).then(function (data) {
        if (data.AuthenticationResult && data.AuthenticationResult.IdToken) {
          onAuthenticated(data.AuthenticationResult.IdToken, data.AuthenticationResult.ExpiresIn);
        } else if (data.ChallengeName) {
          setStatus("暂不支持的后续挑战: " + data.ChallengeName, "err");
          btn.disabled = false;
        }
      }).catch(function (e) {
        setStatus(e.message || "设置新密码失败", "err");
        btn.disabled = false;
      });
    });
  }

  function showForgot(prefillEmail) {
    var card = clearCard();
    card.appendChild(h("h2", {}, [T.forgotTitle]));
    card.appendChild(h("div", { class: "sub" }, [T.subtitle]));

    var emailInput = h("input", { type: "email", value: prefillEmail || pendingEmail || "", autocomplete: "username" });
    card.appendChild(h("label", {}, [T.email]));
    card.appendChild(emailInput);

    var sendBtn = h("button", { class: "primary" }, [T.sendCode]);
    card.appendChild(sendBtn);

    var codeWrap = h("div", { style: "display:none" }, []);
    var codeInput = h("input", { type: "text", autocomplete: "one-time-code" });
    var np1 = h("input", { type: "password", autocomplete: "new-password" });
    codeWrap.appendChild(h("label", {}, [T.code]));
    codeWrap.appendChild(codeInput);
    codeWrap.appendChild(h("label", {}, [T.newPass]));
    codeWrap.appendChild(np1);
    var resetBtn = h("button", { class: "primary" }, [T.resetPass]);
    codeWrap.appendChild(resetBtn);
    card.appendChild(codeWrap);

    var linkRow = h("div", { class: "linkrow" }, []);
    var back = h("a", { class: "link" }, [T.back]);
    linkRow.appendChild(back);
    card.appendChild(linkRow);

    statusEl = h("div", { id: "authStatus" }, []);
    card.appendChild(statusEl);

    sendBtn.addEventListener("click", function () {
      var email = emailInput.value.trim();
      if (!email) { setStatus("请输入邮箱。", "err"); return; }
      pendingEmail = email;
      sendBtn.disabled = true;
      setStatus("发送中… Sending…", "");
      idp("ForgotPassword", { ClientId: CFG.clientId, Username: email })
        .then(function () {
          setStatus(T.codeSent, "ok");
          codeWrap.style.display = "block";
          sendBtn.textContent = "重新发送 Resend";
          sendBtn.disabled = false;
        })
        .catch(function (e) {
          setStatus(e.message || "发送失败", "err");
          sendBtn.disabled = false;
        });
    });

    resetBtn.addEventListener("click", function () {
      var code = codeInput.value.trim();
      if (!code || !np1.value) { setStatus("请输入验证码与新密码。", "err"); return; }
      resetBtn.disabled = true;
      setStatus("提交中… Submitting…", "");
      idp("ConfirmForgotPassword", {
        ClientId: CFG.clientId,
        Username: pendingEmail,
        ConfirmationCode: code,
        Password: np1.value,
      }).then(function () {
        setStatus("密码已重置，请用新密码登录。Password reset. Please sign in.", "ok");
        setTimeout(function () { showLogin(pendingEmail); }, 1200);
      }).catch(function (e) {
        setStatus(e.message || "重置失败", "err");
        resetBtn.disabled = false;
      });
    });

    back.addEventListener("click", function () { showLogin(emailInput.value.trim()); });
  }

  // ---- 认证成功: 换临时凭证 -> 列出日期 -> 读取所选日期日志 -> 启动 app ----
  function onAuthenticated(token, expiresInSec) {
    idToken = token;
    if (expiresInSec) saveSession(token, expiresInSec);
    setStatus(T.loading, "");
    var card = clearCard();
    card.appendChild(h("h2", {}, [T.title]));
    card.appendChild(h("div", { class: "sub" }, [T.loadingDates]));
    statusEl = h("div", { id: "authStatus" }, []);
    card.appendChild(statusEl);

    try {
      AWS.config.region = CFG.region;
      var logins = {};
      logins["cognito-idp." + CFG.region + ".amazonaws.com/" + CFG.userPoolId] = idToken;
      AWS.config.credentials = new AWS.CognitoIdentityCredentials({
        IdentityPoolId: CFG.identityPoolId,
        Logins: logins,
      });
    } catch (e) {
      setStatus("初始化 AWS 凭证失败: " + e.message, "err");
      return;
    }

    var _describeCache = {};
    window.__CONNECT_DESCRIBE_CONTACT__ = function (contactId, instanceId, forceRefresh) {
      var iid = instanceId || CFG.connectInstanceId;
      var region = CFG.connectRegion || CFG.region;
      if (!iid) return Promise.reject(new Error("未配置 Amazon Connect 实例(connectInstanceId)。"));
      var key = region + "|" + iid + "|" + contactId;
      if (!forceRefresh && _describeCache[key]) return _describeCache[key];

      var p = loadConnectV3(region).then(function (v3) {
        return v3.client.send(new v3.DescribeContactCommand({ InstanceId: iid, ContactId: contactId }));
      }).catch(function (e) {
        if (window.console) console.warn("AWS SDK v3 不可用，回退到 SigV4 原始请求:", e && e.message);
        return rawDescribeContact(iid, region, contactId);
      });
      p.catch(function () { if (_describeCache[key] === p) delete _describeCache[key]; });
      _describeCache[key] = p;
      return p;
    };

    var _summaryCache = {};
    function s3BodyToText(body) {
      if (typeof body === "string") return Promise.resolve(body);
      if (body instanceof Uint8Array) return Promise.resolve(new TextDecoder("utf-8").decode(body));
      return new Response(body).text();
    }
    window.__CONNECT_FETCH_SUMMARY__ = function (contact, forceRefresh) {
      try {
        if (!contact || !window.AWS || !AWS.S3) return Promise.resolve("");
        var cid = contact.Id || "";
        if (cid && forceRefresh) delete _summaryCache[cid];
        if (cid && !forceRefresh && _summaryCache[cid]) return _summaryCache[cid];

        var recs = contact.Recordings || [];
        var channel = (contact.Channel || "VOICE").toUpperCase();
        var analysisRoot = channel === "CHAT" ? "Analysis/Chat" : "Analysis/Voice";

        var cands = [];
        recs.forEach(function (r) {
          if (r && r.StorageType === "S3" && r.Location) {
            var mst = r.MediaStreamType || "";
            cands.push({ score: (mst === "AUDIO" || mst === "CHAT" || mst === "") ? 0 : 1, loc: r.Location });
          }
        });
        cands.sort(function (a, b) { return a.score - b.score; });

        var bucket = "", subdir = "";
        var markers = ["CallRecordings/", "ChatTranscripts/"];
        for (var i = 0; i < cands.length && !bucket; i++) {
          var loc = cands[i].loc;
          var slash = loc.indexOf("/");
          if (slash < 0) continue;
          var b = loc.slice(0, slash), rest = loc.slice(slash + 1);
          for (var m = 0; m < markers.length; m++) {
            var idx = rest.indexOf(markers[m]);
            if (idx >= 0) {
              var sub = rest.slice(idx + markers[m].length);
              var last = sub.lastIndexOf("/");
              if (last > 0) { bucket = b; subdir = sub.slice(0, last); break; }
            }
          }
        }
        if (!bucket || !subdir) return Promise.resolve("");

        var prefix = analysisRoot + "/" + subdir + "/" + cid + "_analysis_";
        var region = CFG.connectRegion || CFG.region;
        var s3 = new AWS.S3({ region: region });
        var pr = s3.listObjectsV2({ Bucket: bucket, Prefix: prefix }).promise().then(function (out) {
          var keys = (out.Contents || []).map(function (c) { return c.Key; }).filter(Boolean).sort();
          if (!keys.length) return "";
          var key = keys[keys.length - 1];
          return s3.getObject({ Bucket: bucket, Key: key }).promise().then(function (data) {
            return s3BodyToText(data.Body).then(function (text) {
              if (!text) return "";
              var j;
              try { j = JSON.parse(text); } catch (e) { return ""; }
              var cc = (j && j.ConversationCharacteristics) || {};
              var cs = cc.ContactSummary || {};
              var ais = cs.AutomatedInteractionSummary || {};
              return (typeof ais.Content === "string") ? ais.Content.trim() : "";
            });
          });
        }).catch(function (e) {
          if (window.console) console.warn("获取自动交互摘要失败:", e && e.message);
          if (cid && _summaryCache[cid] === pr) delete _summaryCache[cid];
          return "";
        });
        if (cid) _summaryCache[cid] = pr;
        return pr;
      } catch (e) {
        return Promise.resolve("");
      }
    };

    AWS.config.credentials.getPromise()
      .then(listAvailableDates)
      .then(function (dates) {
        availableDates = dates;
        if (!dates.length) {
          setStatus(T.noDates, "err");
          return null;
        }
        // 选定日期: 优先 sessionStorage(切换日期刷新后), 否则最新一天
        var stored = getStoredDate();
        selectedDate = (stored && dates.indexOf(stored) >= 0) ? stored : dates[0];
        setStoredDate(selectedDate);
        return loadLogsForDate(selectedDate);
      })
      .then(function (rows) {
        if (rows == null) return;
        window.__CONNECT_AI_LOG_DATA__ = rows;
        bootApp();
      })
      .catch(function (e) {
        // 凭证/会话失效: 清掉暂存并回到登录
        if (isAuthError(e)) {
          clearSession();
          showLogin(pendingEmail);
          setStatus("会话已失效，请重新登录。", "err");
          return;
        }
        setStatus("加载日志失败: " + (e.message || e), "err");
      });
  }

  function isAuthError(e) {
    var m = (e && (e.code || e.name || e.message) || "").toString();
    return /ExpiredToken|InvalidIdentityToken|NotAuthorized|AccessDenied|Credentials|Token/i.test(m);
  }

  // ---- 列出 dailyPrefix 下已有的日期(YYYY-MM-DD)，降序(最新在前) ----
  function listAvailableDates() {
    var s3 = new AWS.S3({ region: CFG.region, params: { Bucket: CFG.logsBucket } });
    var dates = [];
    var reDate = /(\d{4}-\d{2}-\d{2})\/$/;

    function page(token) {
      var params = { Prefix: DAILY_PREFIX, Delimiter: "/" };
      if (token) params.ContinuationToken = token;
      return s3.listObjectsV2(params).promise().then(function (out) {
        (out.CommonPrefixes || []).forEach(function (cp) {
          var p = cp.Prefix || "";
          var m = p.slice(DAILY_PREFIX.length).match(reDate);
          if (m) dates.push(m[1]);
        });
        if (out.IsTruncated && out.NextContinuationToken) return page(out.NextContinuationToken);
        return null;
      });
    }

    return page(null).then(function () {
      // 去重 + 降序
      var seen = {};
      var uniq = dates.filter(function (d) {
        if (seen[d]) return false; seen[d] = true; return true;
      });
      uniq.sort(function (a, b) { return a < b ? 1 : (a > b ? -1 : 0); });
      return uniq;
    });
  }

  // ---- 读取某一天的 index.json 与其 logs/*.log ----
  function loadLogsForDate(date) {
    var s3 = new AWS.S3({ region: CFG.region, params: { Bucket: CFG.logsBucket } });
    var prefix = DAILY_PREFIX + date + "/";

    function getText(key) {
      return s3.getObject({ Key: key }).promise().then(function (data) {
        var body = data.Body;
        if (typeof body === "string") return body;
        if (body instanceof Uint8Array) return new TextDecoder("utf-8").decode(body);
        return new Response(body).text();
      });
    }

    return getText(prefix + "index.json").then(function (txt) {
      var manifest = JSON.parse(txt);
      var contacts = (manifest && manifest.contacts) || [];
      if (!contacts.length) return [];

      var rows = [];
      var i = 0;
      var CONCURRENCY = 6;

      function worker() {
        if (i >= contacts.length) return Promise.resolve();
        var c = contacts[i++];
        var key = prefix + c.file;
        return getText(key).then(function (text) {
          text.split(/\r?\n/).forEach(function (line) {
            line = line.trim();
            if (!line) return;
            try { rows.push(JSON.parse(line)); } catch (e) { /* 跳过坏行 */ }
          });
          setStatus(T.loading + " (" + Math.min(i, contacts.length) + "/" + contacts.length + ")", "");
          return worker();
        });
      }

      var starters = [];
      for (var w = 0; w < Math.min(CONCURRENCY, contacts.length); w++) starters.push(worker());
      return Promise.all(starters).then(function () {
        rows.sort(function (a, b) { return a.timestamp - b.timestamp; });
        return rows;
      });
    }).catch(function (e) {
      // 该日期还没有 index.json(拆分 Lambda 尚未完成)时, 返回空数据而非报错
      if (e && /NoSuchKey|NotFound|AccessDenied/i.test((e.code || e.name || e.message || "").toString())) {
        return [];
      }
      throw e;
    });
  }

  // ---- 顶部日期控件: 选择某天即整页刷新加载当天数据 ----
  function injectDatePicker() {
    var header = document.querySelector("header");
    if (!header || document.getElementById("dateSelect")) return;

    var wrap = h("div", { class: "date-picker" }, []);
    wrap.appendChild(h("label", { for: "dateSelect" }, [T.dateLabel]));

    var select = h("select", { id: "dateSelect" }, []);
    availableDates.forEach(function (d) {
      var opt = h("option", { value: d }, [d]);
      if (d === selectedDate) opt.setAttribute("selected", "selected");
      select.appendChild(opt);
    });
    select.value = selectedDate;
    select.addEventListener("change", function () {
      setStoredDate(select.value);
      // 整页刷新: 复用会话免重登, 并让 app.js 用当天数据重新完整渲染
      window.location.reload();
    });
    wrap.appendChild(select);

    // 放在语言选择器之前(语言选择器带 margin-left:auto 会被推到最右)
    var langPicker = header.querySelector(".lang-picker");
    if (langPicker) header.insertBefore(wrap, langPicker);
    else header.appendChild(wrap);
  }

  function bootApp() {
    var s = document.createElement("script");
    s.src = "./app.js";
    s.onload = function () {
      injectDatePicker();
      if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    };
    s.onerror = function () { setStatus("加载 app.js 失败。", "err"); };
    document.body.appendChild(s);
  }

  function init() {
    injectStyles();
    overlay = h("div", { id: "authOverlay" }, [h("div", { id: "authCard" }, [])]);
    document.body.appendChild(overlay);
    if (!CFG.region || !CFG.clientId || !CFG.userPoolId || !CFG.identityPoolId || !CFG.logsBucket) {
      clearCard().appendChild(h("h2", {}, [T.needConfig]));
      return;
    }
    // 有有效会话则静默复用(切换日期整页刷新后免重登)，否则显示登录
    var sess = loadSession();
    if (sess) {
      var card = clearCard();
      card.appendChild(h("h2", {}, [T.title]));
      card.appendChild(h("div", { class: "sub" }, [T.loading]));
      statusEl = h("div", { id: "authStatus" }, []);
      card.appendChild(statusEl);
      onAuthenticated(sess.idToken, null);
    } else {
      showLogin("");
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
