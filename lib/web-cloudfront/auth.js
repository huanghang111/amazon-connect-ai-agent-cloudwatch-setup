/* auth.js — CloudFront 部署版的登录门禁与日志加载
 *
 * 职责:
 *   1) 在页面上覆盖一个登录界面(登录 / 首次登录改密 / 忘记密码)。
 *   2) 通过 Amazon Cognito User Pool 完成认证(纯 REST 调用，无需签名):
 *        - InitiateAuth (USER_PASSWORD_AUTH)
 *        - RespondToAuthChallenge (NEW_PASSWORD_REQUIRED) —— 首次用一次性密码登录后强制改密
 *        - ForgotPassword / ConfirmForgotPassword —— 忘记密码，向邮箱发送新的一次性验证码
 *   3) 认证成功后用 Cognito Identity Pool 换取临时 AWS 凭证，
 *      从日志存储桶读取 index.json 与每个 Contact 的 .log 文件，
 *      组装成 window.__CONNECT_AI_LOG_DATA__，再动态加载 app.js 渲染页面。
 *
 * 依赖: aws-sdk (浏览器版) + aws-config.js(部署脚本生成，含各资源 ID)。
 */
(function () {
  "use strict";

  var CFG = window.__AWS_CONFIG__ || {};
  var IDP_ENDPOINT = "https://cognito-idp." + CFG.region + ".amazonaws.com/";
  var idToken = "";
  var pendingEmail = "";
  var pendingSession = "";

  // AWS SDK v3(仅用于 Amazon Connect DescribeContact)通过 ESM 从 CDN 动态加载。
  // 登录与 S3 日志加载仍走已内置的浏览器版 SDK v2。
  //
  // 关键点(规避 "Symbol.for('node-only') is not a function" 报错):
  //   - 只加载 @aws-sdk/client-connect，不引入 @aws-sdk/credential-providers
  //     (后者依赖链庞大，浏览器 CDN 下常被解析成 node 版本而引用 node-only 内部实现)。
  //   - 凭证直接复用 v2 已解析(且会自动续期)的 Cognito 临时凭证。
  //   - 用 jsdelivr 的 /+esm(esm.run，面向浏览器打包)以规避 esm.sh 的 node/browser 条件问题。
  //   - 若 v3 仍加载失败，回退到 v2 的 SigV4 原始请求(见 rawDescribeContact)。
  var CONNECT_V3_CLIENT_URL = "https://cdn.jsdelivr.net/npm/@aws-sdk/client-connect@3/+esm";
  var _connectV3Promise = null;

  // 把 v2 已解析(会自动续期)的 Cognito 临时凭证包装成 v3 的凭证提供器函数
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

  // 懒加载并缓存 v3 的 ConnectClient + DescribeContactCommand。
  function loadConnectV3(region) {
    if (_connectV3Promise) return _connectV3Promise;
    _connectV3Promise = import(CONNECT_V3_CLIENT_URL).then(function (connectMod) {
      var client = new connectMod.ConnectClient({
        region: region,
        credentials: v2CredentialProvider,
      });
      return { client: client, DescribeContactCommand: connectMod.DescribeContactCommand };
    }).catch(function (e) {
      _connectV3Promise = null; // 失败后允许重试
      throw e;
    });
    return _connectV3Promise;
  }

  // 回退方案: v3 从 CDN 加载失败时, 用 v2 的 SigV4 对 DescribeContact 的 REST 端点
  // (GET /contacts/{InstanceId}/{ContactId}) 发起原始签名请求, 自行解析完整 JSON(不丢字段)。
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

  // ---- 简单的双语文案(登录界面独立于 app.js 的 i18n) ----
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
  };

  // ---- Cognito IDP 的无签名 REST 调用 ----
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

  // ---- 覆盖层 UI ----
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
      "#authStatus.ok{color:#3fb950}";
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

  // ---- 视图: 登录 ----
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
          onAuthenticated(data.AuthenticationResult.IdToken);
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

  // ---- 视图: 首次登录改密(NEW_PASSWORD_REQUIRED) ----
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
          onAuthenticated(data.AuthenticationResult.IdToken);
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

  // ---- 视图: 忘记密码 ----
  function showForgot(prefillEmail) {
    var card = clearCard();
    card.appendChild(h("h2", {}, [T.forgotTitle]));
    card.appendChild(h("div", { class: "sub" }, [T.subtitle]));

    var emailInput = h("input", { type: "email", value: prefillEmail || pendingEmail || "", autocomplete: "username" });
    card.appendChild(h("label", {}, [T.email]));
    card.appendChild(emailInput);

    var sendBtn = h("button", { class: "primary" }, [T.sendCode]);
    card.appendChild(sendBtn);

    // 验证码 + 新密码(发送后再显示)
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

  // ---- 认证成功: 换临时凭证 -> 读取日志 -> 启动 app ----
  function onAuthenticated(token) {
    idToken = token;
    setStatus(T.loading, "");
    var card = clearCard();
    card.appendChild(h("h2", {}, [T.title]));
    card.appendChild(h("div", { class: "sub" }, [T.loading]));
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

    // 暴露一个用浏览器 AWS SDK + Cognito 临时凭证调用 Amazon Connect DescribeContact 的方法，
    // 供 app.js 的「Contact 详情」tab 与 DID/挂断方列使用。
    // 需要部署脚本注入 connectInstanceId，并给鉴权角色授予 connect:DescribeContact 权限。
    // 用 AWS SDK v3 的 DescribeContactCommand 获取完整的 Contact(含 DisconnectReason /
    // SystemEndpoint / CustomerEndpoint / Recordings 等新字段)。v3 模型是最新的，不会像
    // v2 全局脚本那样丢字段。v3 经 ESM 从 CDN 动态加载(见 loadConnectV3)。
    //
    // 结果按 Contact 缓存(缓存的是 Promise，同一个 Contact 的并发请求也会复用):
    //   - 后续再需要同一个 Contact 的信息时直接返回缓存，不再调用 API;
    //   - 传 forceRefresh=true 可绕过缓存强制重新拉取(供「刷新」按钮使用);
    //   - 请求失败不写入缓存，以便下次重试。
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
        // v3(CDN/ESM)不可用 -> 回退到 SigV4 原始请求(同样返回完整字段)
        if (window.console) console.warn("AWS SDK v3 不可用，回退到 SigV4 原始请求:", e && e.message);
        return rawDescribeContact(iid, region, contactId);
      });
      p.catch(function () { if (_describeCache[key] === p) delete _describeCache[key]; });
      _describeCache[key] = p;
      return p;
    };

    // 读取生成式"自动交互摘要"(AutomatedInteractionSummary)。
    // DescribeContact 不含摘要, 但会返回录音在 S3 的位置; 分析结果 JSON 与录音同桶,
    // 路径把 .../CallRecordings/<sub>/<date>/ 映射为 Analysis/Voice(或 Chat)/<sub>/<date>/,
    // 文件名形如 <contactId>_analysis_<timestamp>.json, 摘要在
    // ConversationCharacteristics.ContactSummary.AutomatedInteractionSummary.Content。
    // 依赖登录用户临时凭证对录音桶的只读权限(部署脚本已按需授予)。取不到时返回 ""。
    var _summaryCache = {};
    function s3BodyToText(body) {
      if (typeof body === "string") return Promise.resolve(body);
      if (body instanceof Uint8Array) return Promise.resolve(new TextDecoder("utf-8").decode(body));
      return new Response(body).text();
    }
    // forceRefresh=true 时绕过缓存重新拉取(供 Dashboard「刷新通话摘要」按钮使用),
    // 以便对之前取到空摘要的 Contact 再试一次。
    window.__CONNECT_FETCH_SUMMARY__ = function (contact, forceRefresh) {
      try {
        if (!contact || !window.AWS || !AWS.S3) return Promise.resolve("");
        var cid = contact.Id || "";
        if (cid && forceRefresh) delete _summaryCache[cid];
        if (cid && !forceRefresh && _summaryCache[cid]) return _summaryCache[cid];

        var recs = contact.Recordings || [];
        var channel = (contact.Channel || "VOICE").toUpperCase();
        var analysisRoot = channel === "CHAT" ? "Analysis/Chat" : "Analysis/Voice";

        // 选主音频/文字记录(把 AUTOMATED_INTERACTION_LOG 等辅助流排后面)
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
              var sub = rest.slice(idx + markers[m].length); // ivr/2026/07/17/<file>
              var last = sub.lastIndexOf("/");
              if (last > 0) { bucket = b; subdir = sub.slice(0, last); break; }
            }
          }
        }
        // 兜底: 用部署脚本注入的录音桶名 + Connected 时间无法可靠推断, 故仅在能解析出目录时继续
        if (!bucket || !subdir) return Promise.resolve("");

        var prefix = analysisRoot + "/" + subdir + "/" + cid + "_analysis_";
        var region = CFG.connectRegion || CFG.region;
        var s3 = new AWS.S3({ region: region });
        var pr = s3.listObjectsV2({ Bucket: bucket, Prefix: prefix }).promise().then(function (out) {
          var keys = (out.Contents || []).map(function (c) { return c.Key; }).filter(Boolean).sort();
          if (!keys.length) return "";
          var key = keys[keys.length - 1]; // 文件名带时间戳, 取最新
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
          if (cid && _summaryCache[cid] === pr) delete _summaryCache[cid]; // 失败不缓存, 允许重试
          return "";
        });
        if (cid) _summaryCache[cid] = pr;
        return pr;
      } catch (e) {
        return Promise.resolve("");
      }
    };

    AWS.config.credentials.getPromise()
      .then(loadAllLogs)
      .then(function (rows) {
        window.__CONNECT_AI_LOG_DATA__ = rows;
        bootApp();
      })
      .catch(function (e) {
        setStatus("加载日志失败: " + (e.message || e), "err");
      });
  }

  // ---- 从 S3 读取 index.json 与所有 .log 文件 ----
  function loadAllLogs() {
    var s3 = new AWS.S3({ region: CFG.region, params: { Bucket: CFG.logsBucket } });
    var prefix = CFG.logsPrefix || "";

    function getText(key) {
      return s3.getObject({ Key: key }).promise().then(function (data) {
        var body = data.Body;
        if (typeof body === "string") return body;
        if (body instanceof Uint8Array) return new TextDecoder("utf-8").decode(body);
        // 兼容 Blob
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
    });
  }

  // ---- 数据就绪后动态加载 app.js，并移除登录覆盖层 ----
  function bootApp() {
    var s = document.createElement("script");
    s.src = "./app.js";
    s.onload = function () {
      if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    };
    s.onerror = function () { setStatus("加载 app.js 失败。", "err"); };
    document.body.appendChild(s);
  }

  // ---- 初始化 ----
  function init() {
    injectStyles();
    overlay = h("div", { id: "authOverlay" }, [h("div", { id: "authCard" }, [])]);
    document.body.appendChild(overlay);
    if (!CFG.region || !CFG.clientId || !CFG.userPoolId || !CFG.identityPoolId || !CFG.logsBucket) {
      clearCard().appendChild(h("h2", {}, [T.needConfig]));
      return;
    }
    showLogin("");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
