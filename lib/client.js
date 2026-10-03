/**
 * dsh-session-purge - client half.
 *
 * Adds ONE additive seat to the sidebar Session list:
 *   sidebar.workspaces.session.menu.item -> a row inside one Session's "..." menu
 * (An earlier revision also used sidebar.workspaces.session.row.action for a hover
 *  button; the user asked for the menu row only, so that seat is no longer used.)
 *
 * It renders only for ARCHIVED Sessions. "Archived" is answered by the Host half
 * (GET <API>/state) so this half never guesses at an undocumented snapshot shape.
 * Deleting is irreversible, so it takes TWO clicks: the first arms, the second deletes.
 *
 * This file follows the shipped client-plugin artifact convention: a plain-JS
 * window.__ModuleLoader__.load({ id, factory }) wrapper, so no build step is needed.
 * Chinese UI text is written as \uXXXX escapes to keep the file pure ASCII.
 */
window.__ModuleLoader__.load({
  id: "dsh-session-purge",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    "use strict";

    // The loader may hand back the ESM namespace ({ default: React }) or React itself.
    var ReactMod = require("react");
    var React = ReactMod && typeof ReactMod.createElement === "function" ? ReactMod : (ReactMod && ReactMod.default) || {};

    var name = "session-purge";
    var inject = ["slots"];

    var API = "/api/dsh-session-purge";
    var STYLE_ID = "dsh-session-purge";
    var CACHE_MS = 4000;

    var T = {
      purge: "\u5F7B\u5E95\u5220\u9664",
      confirm: "\u786E\u8BA4\u5220\u9664\uFF1F",
      deleting: "\u6B63\u5728\u5220\u9664\u2026",
      done: "\u5DF2\u5220\u9664",
      failed: "\u5220\u9664\u5931\u8D25\uFF1A",
      unknown: "\u672A\u77E5\u539F\u56E0",
      tip: "\u4EC5\u5BF9\u5DF2\u5F52\u6863\u4F1A\u8BDD\u53EF\u7528\uFF1B\u5220\u9664\u540E\u4E0D\u53EF\u6062\u590D\uFF0C\u9700\u70B9\u4E24\u6B21"
    };

    var STYLES = [
      ".dsh-session-purge-item{display:block;width:100%;margin-top:4px;padding:6px 10px;border:0;border-top:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.28));background:transparent;color:var(--dsw-alias-label-secondary,inherit);cursor:pointer;font:inherit;text-align:left;border-radius:4px;}",
      ".dsh-session-purge-item:hover{background:var(--dsw-alias-interactive-bg-hover-solid,rgba(127,127,127,.14));color:var(--dsw-alias-label-primary,inherit);}",
      ".dsh-session-purge-item[data-danger]{color:var(--dsw-alias-state-error-primary,#e5484d);}",
      ".dsh-session-purge-item[data-danger]:hover{background:var(--dsw-alias-state-error-primary,#e5484d);color:#fff;}",
      ".dsh-session-purge-item[data-busy]{opacity:.6;cursor:default;}"
    ].join("\n");

    function installStyles() {
      var existing = document.querySelector("style[data-plugin=" + JSON.stringify(STYLE_ID) + "]");
      var tag = document.createElement("style");
      tag.dataset.plugin = STYLE_ID;
      tag.textContent = STYLES;
      if (existing === null) document.head.appendChild(tag);
      else existing.replaceWith(tag);
      return function () {
        tag.remove();
      };
    }

    /**
     * The per-boot token injected by the Host half is a bonus. The route also accepts the
     * static marker "ui": a custom request header forces a CORS preflight that the route
     * never approves, so a cross-origin page cannot reach the route anyway.
     */
    function token() {
      var holder = window.__DSH_SESSION_PURGE__;
      if (holder && typeof holder.token === "string" && holder.token.length > 0) return holder.token;
      return "ui";
    }

    var cache = { at: 0, value: null, inflight: null };

    function loadArchived() {
      var now = Date.now();
      if (cache.value !== null && now - cache.at < CACHE_MS) return Promise.resolve(cache.value);
      if (cache.inflight !== null) return cache.inflight;
      cache.inflight = window
        .fetch(API + "/state", { headers: { "x-dsh-session-purge": token() } })
        .then(function (res) {
          return res.ok ? res.json() : null;
        })
        .then(function (body) {
          var value = body && Array.isArray(body.archived) ? body.archived : [];
          cache.value = value;
          cache.at = Date.now();
          cache.inflight = null;
          return value;
        })
        .catch(function () {
          cache.inflight = null;
          return [];
        });
      return cache.inflight;
    }

    function useArchived(sessionId) {
      var pair = React.useState(cache.value);
      var list = pair[0];
      var setList = pair[1];
      React.useEffect(
        function () {
          var alive = true;
          loadArchived().then(function (value) {
            if (alive) setList(value);
          });
          return function () {
            alive = false;
          };
        },
        [sessionId],
      );
      return Array.isArray(list) && list.indexOf(sessionId) !== -1;
    }

    function sendPurge(sessionId) {
      return window
        .fetch(API + "/delete", {
          method: "POST",
          headers: { "content-type": "application/json", "x-dsh-session-purge": token() },
          body: JSON.stringify({ sessionId: sessionId, confirm: true }),
        })
        .then(function (res) {
          return res.json().catch(function () {
            return null;
          });
        });
    }

    /**
     * Two-click arm/confirm state machine. phase: idle -> confirm -> busy -> done | error.
     * Nothing destructive happens until the second click; the armed state expires after 4s.
     */
    function usePurgeAction(sessionId) {
      var phasePair = React.useState("idle");
      var phase = phasePair[0];
      var setPhase = phasePair[1];
      var msgPair = React.useState("");
      var message = msgPair[0];
      var setMessage = msgPair[1];
      var timer = React.useRef(null);

      function clear() {
        if (timer.current !== null) {
          window.clearTimeout(timer.current);
          timer.current = null;
        }
      }

      function run() {
        clear();
        setPhase("busy");
        sendPurge(sessionId)
          .then(function (body) {
            if (body && body.ok === true) {
              cache.value = null;
              cache.at = 0;
              setPhase("done");
              window.setTimeout(function () {
                window.location.reload();
              }, 900);
              return;
            }
            setPhase("error");
            setMessage(String((body && (body.reason || body.error)) || T.unknown));
          })
          .catch(function (error) {
            setPhase("error");
            setMessage(String((error && error.message) || error));
          });
      }

      function click() {
        if (phase === "idle") {
          setPhase("confirm");
          clear();
          timer.current = window.setTimeout(function () {
            setPhase("idle");
          }, 4000);
          return;
        }
        if (phase === "confirm") run();
      }

      function label(base) {
        if (phase === "confirm") return T.confirm;
        if (phase === "busy") return T.deleting;
        if (phase === "done") return T.done;
        if (phase === "error") return T.failed + message;
        return base;
      }

      React.useEffect(function () {
        return clear;
      }, []);

      return { phase: phase, click: click, label: label };
    }

    /** Row inside one Session's "..." menu. Renders nothing for non-archived rows. */
    function PurgeMenuItem(props) {
      var sessionId = props && props.sessionId;
      var archived = useArchived(sessionId);
      var action = usePurgeAction(sessionId);
      if (archived !== true) return null;
      var danger = action.phase === "confirm" || action.phase === "error";
      return React.createElement(
        "button",
        {
          type: "button",
          role: "menuitem",
          className: "dsh-session-purge-item",
          title: T.tip,
          "data-danger": danger ? "" : undefined,
          "data-busy": action.phase === "busy" ? "" : undefined,
          onClick: function (event) {
            event.preventDefault();
            action.click();
          },
        },
        action.label(T.purge),
      );
    }

    function apply(ctx) {
      ctx.effect(installStyles, "dsh-session-purge: client styles");
      ctx.slots.inject("sidebar.workspaces.session.menu.item", function () {
        return ctx.slots.register(
          { name: "sidebar.workspaces.session.menu.item", id: "session-purge.delete", order: 900 },
          PurgeMenuItem,
        );
      });
    }

    exports.name = name;
    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  },
});
