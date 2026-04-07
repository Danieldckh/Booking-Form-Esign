// Frontend for /sign/:token. Handles:
//   - Sign button → modal with a canvas signature + name + email → POST
//   - Request Changes button → modal with a textarea → POST
//
// Both submissions include the full current HTML of the booking form
// root element (with any header/legal-strip edits the client made),
// so the server can snapshot exactly what the client saw and signed.

(function () {
  "use strict";

  var token = window.ESIGN_TOKEN || "";
  if (!token) {
    console.warn("No ESIGN_TOKEN present on page");
  }

  // Grab the actual booking form container so we can snapshot its HTML.
  // base.html wraps everything in .page-wrapper — we use document.documentElement
  // as a fallback so we always capture the full page, headers included.
  function getSnapshotHtml() {
    return "<!doctype html>" + document.documentElement.outerHTML;
  }

  function makeModal(title, subtitle) {
    var backdrop = document.createElement("div");
    backdrop.className = "esign-modal-backdrop";

    var modal = document.createElement("div");
    modal.className = "esign-modal";

    var h = document.createElement("h2");
    h.textContent = title;
    modal.appendChild(h);

    if (subtitle) {
      var p = document.createElement("p");
      p.textContent = subtitle;
      modal.appendChild(p);
    }

    backdrop.appendChild(modal);

    // Click on backdrop (not modal content) closes
    backdrop.addEventListener("click", function (e) {
      if (e.target === backdrop) document.body.removeChild(backdrop);
    });

    return { backdrop: backdrop, modal: modal, close: function () {
      if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
    }};
  }

  function showDone(kind) {
    var overlay = document.createElement("div");
    overlay.className = "esign-done";
    var card = document.createElement("div");
    card.className = "esign-done-card";
    var check = document.createElement("div");
    check.className = "check";
    check.textContent = "\u2713";
    card.appendChild(check);

    var h1 = document.createElement("h1");
    var p = document.createElement("p");
    if (kind === "signed") {
      h1.textContent = "Thank you for signing!";
      p.textContent =
        "Your signed booking form has been submitted to ProAgri. A copy will be " +
        "emailed to you shortly. Your account manager will be in touch to begin onboarding.";
    } else {
      h1.textContent = "Change request received";
      p.textContent =
        "Thanks — we've sent your notes to the ProAgri team. They'll review the changes " +
        "and send you a revised booking form shortly.";
    }
    card.appendChild(h1);
    card.appendChild(p);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
  }

  function setStatus(msg, isError) {
    var el = document.getElementById("esign-status");
    if (!el) return;
    el.textContent = msg || "";
    el.style.color = isError ? "#dc2626" : "#64696e";
  }

  // ────────────────────────────────────────────────────────────────
  //   Signature canvas — pointer events (works for mouse and touch)
  // ────────────────────────────────────────────────────────────────
  function attachCanvasDrawing(canvas) {
    var ctx = canvas.getContext("2d");
    var dpr = window.devicePixelRatio || 1;

    function resize() {
      var rect = canvas.getBoundingClientRect();
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
      ctx.scale(dpr, dpr);
      ctx.lineWidth = 2.2;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.strokeStyle = "#1a1d29";
    }
    resize();

    var drawing = false;
    var strokes = [];
    var currentStroke = null;

    function point(e) {
      var rect = canvas.getBoundingClientRect();
      return {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
      };
    }

    function start(e) {
      e.preventDefault();
      drawing = true;
      currentStroke = [];
      strokes.push(currentStroke);
      var p = point(e);
      currentStroke.push(p);
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
    }

    function move(e) {
      if (!drawing) return;
      e.preventDefault();
      var p = point(e);
      currentStroke.push(p);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
    }

    function end(e) {
      if (!drawing) return;
      drawing = false;
      currentStroke = null;
    }

    canvas.addEventListener("pointerdown", start);
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerup", end);
    canvas.addEventListener("pointercancel", end);
    canvas.addEventListener("pointerleave", end);

    return {
      clear: function () {
        strokes = [];
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      },
      isEmpty: function () {
        return strokes.length === 0 || strokes.every(function (s) { return s.length < 2; });
      },
      toDataUrl: function () {
        return canvas.toDataURL("image/png");
      },
      getStrokes: function () {
        return strokes;
      },
    };
  }

  // ────────────────────────────────────────────────────────────────
  //   Sign flow
  // ────────────────────────────────────────────────────────────────
  function openSignModal() {
    var m = makeModal(
      "Sign this booking form",
      "Draw your signature below, then provide your name to confirm."
    );

    var canvasLabel = document.createElement("label");
    canvasLabel.textContent = "Signature";
    m.modal.appendChild(canvasLabel);

    var canvas = document.createElement("canvas");
    canvas.className = "esign-signature-canvas";
    m.modal.appendChild(canvas);

    var clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.className = "esign-clear-btn";
    clearBtn.textContent = "Clear signature";
    m.modal.appendChild(clearBtn);

    var nameLabel = document.createElement("label");
    nameLabel.textContent = "Full name";
    m.modal.appendChild(nameLabel);
    var nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.placeholder = "e.g. Jane Smith";
    m.modal.appendChild(nameInput);

    var emailLabel = document.createElement("label");
    emailLabel.textContent = "Email (optional)";
    m.modal.appendChild(emailLabel);
    var emailInput = document.createElement("input");
    emailInput.type = "email";
    emailInput.placeholder = "jane@company.com";
    m.modal.appendChild(emailInput);

    var actions = document.createElement("div");
    actions.className = "esign-modal-actions";

    var cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "esign-btn esign-btn-changes";
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", m.close);
    actions.appendChild(cancelBtn);

    var submitBtn = document.createElement("button");
    submitBtn.type = "button";
    submitBtn.className = "esign-btn esign-btn-sign";
    submitBtn.textContent = "Submit signature";
    actions.appendChild(submitBtn);

    m.modal.appendChild(actions);
    document.body.appendChild(m.backdrop);

    // Wire the canvas AFTER it's in the DOM so we get a real getBoundingClientRect
    var pen = attachCanvasDrawing(canvas);
    clearBtn.addEventListener("click", function () { pen.clear(); });

    submitBtn.addEventListener("click", async function () {
      if (pen.isEmpty()) { alert("Please draw your signature first."); return; }
      if (!nameInput.value.trim()) { alert("Please enter your full name."); return; }
      submitBtn.disabled = true;
      cancelBtn.disabled = true;
      submitBtn.textContent = "Submitting...";
      try {
        var payload = {
          htmlSnapshot: getSnapshotHtml(),
          signerName: nameInput.value.trim(),
          signerEmail: emailInput.value.trim() || null,
          signatureData: {
            image: pen.toDataUrl(),
            strokes: pen.getStrokes(),
            signedAt: new Date().toISOString(),
          },
        };
        var res = await fetch("/api/sign/" + encodeURIComponent(token) + "/sign", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          var err = await res.json().catch(function () { return {}; });
          throw new Error(err.error || ("HTTP " + res.status));
        }
        m.close();
        showDone("signed");
      } catch (err) {
        alert("Could not submit: " + err.message);
        submitBtn.disabled = false;
        cancelBtn.disabled = false;
        submitBtn.textContent = "Submit signature";
      }
    });
  }

  // ────────────────────────────────────────────────────────────────
  //   Change-request flow
  // ────────────────────────────────────────────────────────────────
  function openChangeModal() {
    var m = makeModal(
      "Request changes",
      "Tell us what needs to be adjusted. Your account manager will review and send a revised booking form."
    );

    var notesLabel = document.createElement("label");
    notesLabel.textContent = "What would you like changed?";
    m.modal.appendChild(notesLabel);

    var notes = document.createElement("textarea");
    notes.placeholder =
      "e.g. Please move the start date to 1 June, and drop the LinkedIn ads for the first month.";
    m.modal.appendChild(notes);

    var nameLabel = document.createElement("label");
    nameLabel.textContent = "Your name (optional)";
    m.modal.appendChild(nameLabel);
    var nameInput = document.createElement("input");
    nameInput.type = "text";
    m.modal.appendChild(nameInput);

    var actions = document.createElement("div");
    actions.className = "esign-modal-actions";

    var cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "esign-btn esign-btn-changes";
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", m.close);
    actions.appendChild(cancelBtn);

    var submitBtn = document.createElement("button");
    submitBtn.type = "button";
    submitBtn.className = "esign-btn esign-btn-sign";
    submitBtn.textContent = "Send changes";
    actions.appendChild(submitBtn);

    m.modal.appendChild(actions);
    document.body.appendChild(m.backdrop);

    submitBtn.addEventListener("click", async function () {
      var text = notes.value.trim();
      if (!text) { alert("Please describe the changes you'd like."); return; }
      submitBtn.disabled = true;
      cancelBtn.disabled = true;
      submitBtn.textContent = "Sending...";
      try {
        var res = await fetch("/api/sign/" + encodeURIComponent(token) + "/change-request", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            htmlSnapshot: getSnapshotHtml(),
            changeNotes: text,
            signerName: nameInput.value.trim() || null,
          }),
        });
        if (!res.ok) {
          var err = await res.json().catch(function () { return {}; });
          throw new Error(err.error || ("HTTP " + res.status));
        }
        m.close();
        showDone("change_requested");
      } catch (err) {
        alert("Could not submit: " + err.message);
        submitBtn.disabled = false;
        cancelBtn.disabled = false;
        submitBtn.textContent = "Send changes";
      }
    });
  }

  // Wire buttons when DOM is ready
  function ready(fn) {
    if (document.readyState !== "loading") fn();
    else document.addEventListener("DOMContentLoaded", fn);
  }

  ready(function () {
    var signBtn = document.getElementById("esign-sign");
    var changeBtn = document.getElementById("esign-request-changes");
    if (signBtn) signBtn.addEventListener("click", openSignModal);
    if (changeBtn) changeBtn.addEventListener("click", openChangeModal);
  });
})();
