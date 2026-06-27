/*
 * LLM Explorer — an interactive scatter plot comparing language models.
 *
 * Data is a vendored snapshot embedded in the page as JSON (#llmx-data); see
 * tools/build-llm-explorer-dataset.py. This script (d3 v7) wires up the
 * controls and draws/updates the chart. No network calls at runtime.
 */
(function () {
  "use strict";

  var d3 = window.d3;
  var root = document.getElementById("llmx");
  // Data ships as a plain JS file (data.js) that sets this global — no JSON
  // parsing and no host-page templating pipeline.
  var DATA = (window.JXF_EXP_DATA || {})["llm-explorer"];
  if (!root || !DATA || !d3) return;

  var MODELS = DATA.models;
  buildSkeleton(root);

  // ---- Brand colours (distinct hues; the three iconic labs keep their hue) ----
  var BRAND_COLORS = {
    Anthropic: "#d97757",
    Mistral: "#eab308",
    Meta: "#65a30d",
    OpenAI: "#10a37f",
    Qwen: "#0891b2",
    Google: "#4285f4",
    DeepSeek: "#6d28d9",
    Zhipu: "#c026d3",
    Moonshot: "#db2777",
    Cohere: "#e11d48",
    xAI: "#475569"
  };
  function brandColor(b) { return BRAND_COLORS[b] || "#64748b"; }

  // ---- Formatting helpers ----------------------------------------------------
  function fmtTokens(n) {
    if (n == null) return "—";
    if (n >= 1e6) { var m = n / 1e6; return (m >= 10 ? m.toFixed(0) : trim(m, 1)) + "M"; }
    if (n >= 1e3) { var k = n / 1e3; return (k >= 10 ? k.toFixed(0) : trim(k, 1)) + "K"; }
    return String(Math.round(n));
  }
  function trim(v, dp) { return String(+v.toFixed(dp)); }
  function fmtMoneyPerM(v) {
    if (v == null) return "—";
    return v >= 1 ? "$" + v.toFixed(2) : "$" + v.toFixed(3);
  }
  function fmtMoneyReq(v) {
    if (v == null) return "—";
    if (v >= 1) return "$" + v.toFixed(2);
    if (v >= 0.01) return "$" + v.toFixed(3);
    return "$" + v.toPrecision(2);
  }
  function fmtSpeed(v) { return v == null ? "—" : Math.round(v) + " tok/s"; }
  function parseRelease(s) {
    if (!s) return null;
    var t = Date.parse(s.length === 7 ? s + "-01" : s);
    return isNaN(t) ? null : t;
  }
  var fmtMonth = d3.timeFormat("%b %Y");

  function axisMoney(v) {
    if (v >= 1) return "$" + (+v.toFixed(2));
    return "$" + (+v.toFixed(4));
  }
  function axisMoneyReq(v) {
    if (v >= 1) return "$" + (+v.toFixed(2));
    return "$" + (+v.toPrecision(1));
  }

  // ---- Dimensions ------------------------------------------------------------
  // Each dimension knows how to read a value from a model under the current
  // workload (W), how to scale it, and how to format ticks/values.
  var DIMENSIONS = {
    costBlended: {
      label: "Blended cost", unit: "$ / 1M tokens", scale: "log",
      value: function (m, W) { return blendedCostPerM(m, W); },
      tick: axisMoney, fmt: fmtMoneyPerM
    },
    tokensPerSec: {
      label: "Output speed", unit: "tokens / sec", scale: "linear", zero: true,
      value: function (m) { return m.tokensPerSec; },
      tick: function (v) { return Math.round(v); }, fmt: fmtSpeed
    },
    costPerRequest: {
      label: "Cost per request", unit: "$ / request", scale: "log",
      value: function (m, W) { return requestCost(m, W); },
      tick: axisMoneyReq, fmt: fmtMoneyReq
    },
    input: {
      label: "Input price", unit: "$ / 1M tokens", scale: "log",
      value: function (m) { return m.input > 0 ? m.input : null; },
      tick: axisMoney, fmt: fmtMoneyPerM
    },
    output: {
      label: "Output price", unit: "$ / 1M tokens", scale: "log",
      value: function (m) { return m.output > 0 ? m.output : null; },
      tick: axisMoney, fmt: fmtMoneyPerM
    },
    context: {
      label: "Context window", unit: "tokens", scale: "log",
      value: function (m) { return m.context || null; },
      tick: fmtTokens, fmt: fmtTokens
    },
    maxOutput: {
      label: "Max output", unit: "tokens", scale: "log",
      value: function (m) { return m.maxOutput || null; },
      tick: fmtTokens, fmt: fmtTokens
    },
    release: {
      label: "Release date", unit: "", scale: "time",
      value: function (m) { return parseRelease(m.release); },
      tick: fmtMonth, fmt: fmtMonth
    }
  };
  var DIM_ORDER = ["costBlended", "tokensPerSec", "costPerRequest", "input", "output", "context", "maxOutput", "release"];

  // ---- Cost model ------------------------------------------------------------
  function effInputPrice(m, W) {
    // Cached input is billed at the model's cache-read price (full input price
    // if the model exposes none); the rest at the standard input price.
    var cacheRead = (m.cacheRead != null) ? m.cacheRead : m.input;
    return W.cache * cacheRead + (1 - W.cache) * m.input;
  }
  function blendedCostPerM(m, W) {
    var spend = effInputPrice(m, W) * W.inputTokens + m.output * W.outputTokens;
    var total = W.inputTokens + W.outputTokens;
    var v = spend / total;
    return v > 0 ? v : null;
  }
  function requestCost(m, W) {
    var v = (effInputPrice(m, W) * W.inputTokens + m.output * W.outputTokens) / 1e6;
    return v > 0 ? v : null;
  }

  // ---- Slider <-> value mappings (log) ---------------------------------------
  var L0 = Math.log10(1 / 5000), L1 = Math.log10(5000);        // token mix range
  var IN0 = Math.log10(10), IN1 = Math.log10(2e6);             // input-size range
  function ratioFromRaw(raw) { return Math.pow(10, L0 + (raw / 1000) * (L1 - L0)); }
  function rawFromRatio(r) { return Math.round(((Math.log10(r) - L0) / (L1 - L0)) * 1000); }
  function inputFromRaw(raw) { return Math.pow(10, IN0 + (raw / 1000) * (IN1 - IN0)); }
  function rawFromInput(n) { return Math.round(((Math.log10(n) - IN0) / (IN1 - IN0)) * 1000); }

  // ---- Scenarios -------------------------------------------------------------
  // Each preset is expressed in human terms (token mix r = input:output, input
  // tokens, cached fraction) and converted to slider positions.
  var SCENARIOS = [
    { id: "coding", label: "Coding", r: 8, input: 16000, cache: 0.5,
      blurb: "Reads a lot of code, writes a moderate amount; much of the context repeats." },
    { id: "summarize", label: "Summarization", r: 120, input: 60000, cache: 0,
      blurb: "A long document in, a short summary out." },
    { id: "synthesize", label: "Synthesis", r: 0.5, input: 6000, cache: 0.2,
      blurb: "Modest prompt in, a long drafted document out." },
    { id: "qa", label: "Asking questions", r: 0.4, input: 600, cache: 0,
      blurb: "Short questions, somewhat longer answers — chat-shaped." },
    { id: "research", label: "Deep research", r: 5, input: 180000, cache: 0.3,
      blurb: "Many sources read, a substantial report written." }
  ];

  // ---- State -----------------------------------------------------------------
  var state = {
    x: "costBlended",
    y: "tokensPerSec",
    selected: new Set(MODELS.filter(function (m) { return m.featured; }).map(function (m) { return m.id; })),
    hiddenBrands: new Set(),
    ratioRaw: 500,
    inputRaw: 548,   // ~8k tokens
    cacheRaw: 0,
    scenario: null
  };

  function workload() {
    var r = ratioFromRaw(state.ratioRaw);
    var inputTokens = inputFromRaw(state.inputRaw);
    var outputTokens = inputTokens / r;
    return {
      ratio: r,
      inputTokens: inputTokens,
      outputTokens: outputTokens,
      total: inputTokens + outputTokens,
      cache: state.cacheRaw / 100
    };
  }

  // ===========================================================================
  // Controls
  // ===========================================================================
  function el(sel, ctx) { return (ctx || root).querySelector(sel); }
  function els(sel, ctx) { return Array.prototype.slice.call((ctx || root).querySelectorAll(sel)); }

  function buildScenarioButtons() {
    var row = el(".llmx-scenario-row");
    SCENARIOS.forEach(function (s) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "llmx-scenario";
      b.textContent = s.label;
      b.title = s.blurb;
      b.setAttribute("data-scenario", s.id);
      b.addEventListener("click", function () { applyScenario(s); });
      row.appendChild(b);
    });
  }

  function applyScenario(s) {
    state.scenario = s.id;
    state.ratioRaw = clampRaw(rawFromRatio(s.r), 1000);
    state.inputRaw = clampRaw(rawFromInput(s.input), 1000);
    state.cacheRaw = Math.round(s.cache * 100);
    syncRangeInputs();
    refreshScenarioActive();
    update(true);
  }
  function clampRaw(v, max) { return Math.max(0, Math.min(max, v)); }
  function refreshScenarioActive() {
    els(".llmx-scenario").forEach(function (b) {
      b.classList.toggle("is-active", b.getAttribute("data-scenario") === state.scenario);
    });
  }

  function buildAxisSelects() {
    ["x", "y"].forEach(function (axis) {
      var sel = el('.llmx-select[data-axis="' + axis + '"]');
      DIM_ORDER.forEach(function (key) {
        var o = document.createElement("option");
        o.value = key;
        o.textContent = DIMENSIONS[key].label;
        sel.appendChild(o);
      });
      sel.value = state[axis];
      sel.addEventListener("change", function () {
        state[axis] = sel.value;
        update(true);
      });
    });
  }

  function buildModelDropdown() {
    var list = el(".llmx-model-list");
    var byBrand = d3.group(MODELS, function (m) { return m.brand; });
    Array.from(byBrand.keys()).sort().forEach(function (brand) {
      var group = document.createElement("div");
      group.className = "llmx-model-group";
      var h = document.createElement("div");
      h.className = "llmx-model-brand";
      var dot = document.createElement("span");
      dot.className = "llmx-dot";
      dot.style.background = brandColor(brand);
      h.appendChild(dot);
      h.appendChild(document.createTextNode(brand));
      group.appendChild(h);

      byBrand.get(brand).forEach(function (m) {
        var lbl = document.createElement("label");
        lbl.className = "llmx-model-item";
        var cb = document.createElement("input");
        cb.type = "checkbox";
        cb.value = m.id;
        cb.checked = state.selected.has(m.id);
        cb.addEventListener("change", function () {
          if (cb.checked) state.selected.add(m.id); else state.selected.delete(m.id);
          updateDropdownLabel();
          update(true);
        });
        var span = document.createElement("span");
        span.textContent = m.name + (m.host ? " · " + m.host : "");
        lbl.appendChild(cb);
        lbl.appendChild(span);
        group.appendChild(lbl);
      });
      list.appendChild(group);
    });

    els(".llmx-dropdown-actions button").forEach(function (b) {
      b.addEventListener("click", function () {
        var mode = b.getAttribute("data-select");
        state.selected = new Set(
          MODELS.filter(function (m) {
            return mode === "all" || (mode === "featured" && m.featured);
          }).map(function (m) { return m.id; })
        );
        els('.llmx-model-list input[type="checkbox"]').forEach(function (cb) {
          cb.checked = state.selected.has(cb.value);
        });
        updateDropdownLabel();
        update(true);
      });
    });

    var dd = el("[data-dropdown]");
    var toggle = el(".llmx-dropdown-toggle", dd);
    var menu = el(".llmx-dropdown-menu", dd);
    toggle.addEventListener("click", function () {
      var open = menu.hasAttribute("hidden");
      if (open) { menu.removeAttribute("hidden"); } else { menu.setAttribute("hidden", ""); }
      toggle.setAttribute("aria-expanded", String(open));
    });
    document.addEventListener("click", function (e) {
      if (!dd.contains(e.target) && !menu.hasAttribute("hidden")) {
        menu.setAttribute("hidden", "");
        toggle.setAttribute("aria-expanded", "false");
      }
    });
    updateDropdownLabel();
  }
  function updateDropdownLabel() {
    el(".llmx-dropdown-label").textContent = state.selected.size + " model" + (state.selected.size === 1 ? "" : "s");
  }

  function buildSliders() {
    bindRange("ratio", function (raw) { state.ratioRaw = raw; });
    bindRange("inputSize", function (raw) { state.inputRaw = raw; });
    bindRange("cache", function (raw) { state.cacheRaw = raw; });
  }
  function bindRange(name, set) {
    var input = el('.llmx-range[data-range="' + name + '"]');
    input.addEventListener("input", function () {
      set(+input.value);
      state.scenario = null;       // manual edits leave "no preset" state
      refreshScenarioActive();
      update(false);
    });
  }
  function syncRangeInputs() {
    el('.llmx-range[data-range="ratio"]').value = state.ratioRaw;
    el('.llmx-range[data-range="inputSize"]').value = state.inputRaw;
    el('.llmx-range[data-range="cache"]').value = state.cacheRaw;
  }

  function updateReadouts(W) {
    el('[data-value="ratio"]').textContent = describeRatio(W.ratio);
    el('[data-value="inputSize"]').textContent = fmtTokens(W.inputTokens) + " in";
    el('[data-value="cache"]').textContent = state.cacheRaw + "% cached";
    el('[data-readout="workload"]').textContent =
      "Per request: " + fmtTokens(Math.round(W.inputTokens)) + " input + " +
      fmtTokens(Math.round(W.outputTokens)) + " output tokens (" +
      fmtTokens(Math.round(W.total)) + " total).";
  }
  function describeRatio(r) {
    if (Math.abs(Math.log10(r)) < 0.05) return "balanced (1 : 1)";
    if (r >= 1) return Math.round(r) + " : 1 input-heavy";
    return "1 : " + Math.round(1 / r) + " output-heavy";
  }

  function buildProvenance() {
    var p = el('[data-readout="provenance"]');
    var s = DATA.sources;
    p.innerHTML = "";
    p.appendChild(document.createTextNode("Pricing & metadata: "));
    p.appendChild(link(s.pricing_and_metadata.url, s.pricing_and_metadata.name));
    p.appendChild(document.createTextNode(" · Output speed: "));
    p.appendChild(link(s.throughput.url, s.throughput.name));
    p.appendChild(document.createTextNode(" · snapshot " + DATA.generated + ". "));
    var note = document.createElement("span");
    note.className = "llmx-provenance-note";
    note.textContent = s.throughput.note;
    p.appendChild(note);
  }
  function link(href, text) {
    var a = document.createElement("a");
    a.href = href; a.textContent = text; a.target = "_blank"; a.rel = "noopener";
    return a;
  }

  // ===========================================================================
  // Chart
  // ===========================================================================
  var svg = d3.select(el(".llmx-chart"));
  var holder = el(".llmx-chart-holder");
  var tooltip = d3.select(el(".llmx-tooltip"));
  var margin = { top: 18, right: 26, bottom: 56, left: 70 };

  var gGridX, gGridY, gAxisX, gAxisY, gPoints, xTitle, yTitle;
  function initChart() {
    var g = svg.append("g").attr("class", "llmx-plot");
    gGridX = g.append("g").attr("class", "llmx-grid llmx-grid-x");
    gGridY = g.append("g").attr("class", "llmx-grid llmx-grid-y");
    gAxisX = g.append("g").attr("class", "llmx-axis llmx-axis-x");
    gAxisY = g.append("g").attr("class", "llmx-axis llmx-axis-y");
    gPoints = g.append("g").attr("class", "llmx-points");
    xTitle = g.append("text").attr("class", "llmx-axis-title llmx-axis-title-x").attr("text-anchor", "middle");
    yTitle = g.append("text").attr("class", "llmx-axis-title llmx-axis-title-y").attr("text-anchor", "middle");
    svg.select(".llmx-plot").attr("transform", "translate(" + margin.left + "," + margin.top + ")");
  }

  function makeScale(dim, values, range) {
    var vals = values.filter(function (v) { return v != null && (dim.scale !== "log" || v > 0); });
    if (!vals.length) vals = [1, 10];
    var ext = d3.extent(vals);
    if (dim.scale === "log") {
      var lo = ext[0] === ext[1] ? ext[0] / 2 : ext[0] / 1.35;
      var hi = ext[0] === ext[1] ? ext[1] * 2 : ext[1] * 1.35;
      return d3.scaleLog().domain([lo, hi]).range(range).nice();
    }
    if (dim.scale === "time") {
      var pad = Math.max((ext[1] - ext[0]) * 0.05, 2592e6); // >= ~30d
      return d3.scaleTime().domain([ext[0] - pad, ext[1] + pad]).range(range);
    }
    var min = dim.zero ? 0 : ext[0] - (ext[1] - ext[0] || ext[0]) * 0.08;
    var max = ext[1] + (ext[1] - ext[0] || ext[1]) * 0.08;
    return d3.scaleLinear().domain([min, max]).range(range).nice();
  }

  function update(animate) {
    var W = workload();
    updateReadouts(W);

    var xDim = DIMENSIONS[state.x], yDim = DIMENSIONS[state.y];
    var visible = MODELS.filter(function (m) {
      return state.selected.has(m.id) && !state.hiddenBrands.has(m.brand);
    });

    // Compute coordinates; drop points with no value on either axis.
    var pts = [];
    visible.forEach(function (m) {
      var xv = xDim.value(m, W), yv = yDim.value(m, W);
      if (xv == null || yv == null) return;
      pts.push({ m: m, xv: xv, yv: yv });
    });

    var size = sizeChart();
    var innerW = size.w - margin.left - margin.right;
    var innerH = size.h - margin.top - margin.bottom;

    var x = makeScale(xDim, pts.map(function (p) { return p.xv; }), [0, innerW]);
    var y = makeScale(yDim, pts.map(function (p) { return p.yv; }), [innerH, 0]);

    var t = svg.transition().duration(animate ? 600 : 0).ease(d3.easeCubicOut);

    // Axes
    var xAxis = d3.axisBottom(x).ticks(6, null).tickFormat(xDim.tick).tickSizeOuter(0);
    var yAxis = d3.axisLeft(y).ticks(6, null).tickFormat(yDim.tick).tickSizeOuter(0);
    gAxisX.attr("transform", "translate(0," + innerH + ")").transition(t).call(xAxis);
    gAxisY.transition(t).call(yAxis);

    // Gridlines
    gGridX.attr("transform", "translate(0," + innerH + ")").transition(t)
      .call(d3.axisBottom(x).ticks(6, null).tickSize(-innerH).tickFormat(""));
    gGridY.transition(t)
      .call(d3.axisLeft(y).ticks(6, null).tickSize(-innerW).tickFormat(""));

    // Axis titles
    xTitle.attr("x", innerW / 2).attr("y", innerH + 44)
      .text(xDim.label + (xDim.unit ? "  (" + xDim.unit + ")" : ""));
    yTitle.attr("transform", "rotate(-90)").attr("x", -innerH / 2).attr("y", -margin.left + 16)
      .text(yDim.label + (yDim.unit ? "  (" + yDim.unit + ")" : ""));

    // Points (join keyed by model id)
    var groups = gPoints.selectAll("g.llmx-pt").data(pts, function (p) { return p.m.id; });

    var enter = groups.enter().append("g")
      .attr("class", "llmx-pt")
      .attr("transform", function (p) { return "translate(" + x(p.xv) + "," + y(p.yv) + ")"; })
      .style("opacity", 0);
    enter.append("circle").attr("r", 0).attr("fill", function (p) { return brandColor(p.m.brand); });
    enter.append("text").attr("class", "llmx-pt-label").attr("x", 9).attr("dy", "0.32em")
      .text(function (p) { return p.m.name; });

    enter.on("mousemove", function (event, p) { showTip(event, p, W); })
      .on("mouseenter", function (event, p) { showTip(event, p, W); d3.select(this).classed("is-hover", true); })
      .on("mouseleave", function () { hideTip(); d3.select(this).classed("is-hover", false); });

    groups.exit().transition(t).style("opacity", 0).remove();

    var merged = enter.merge(groups);
    merged.transition(t)
      .style("opacity", 1)
      .attr("transform", function (p) { return "translate(" + x(p.xv) + "," + y(p.yv) + ")"; });
    merged.select("circle").transition(t).attr("r", 6).attr("fill", function (p) { return brandColor(p.m.brand); });

    renderLegend(visible);
    renderEmpty(pts.length === 0);
  }

  function renderEmpty(isEmpty) {
    var existing = el(".llmx-empty");
    if (isEmpty && !existing) {
      var d = document.createElement("p");
      d.className = "llmx-empty";
      d.textContent = "No models to plot. Pick some from the Models menu, or check the axes.";
      holder.appendChild(d);
    } else if (!isEmpty && existing) {
      existing.remove();
    }
  }

  function sizeChart() {
    var w = Math.max(holder.clientWidth || root.clientWidth || 640, 320);
    var h = Math.max(Math.min(Math.round(w * 0.6), 560), 360);
    svg.attr("width", w).attr("height", h).attr("viewBox", "0 0 " + w + " " + h);
    return { w: w, h: h };
  }

  // ---- Tooltip ---------------------------------------------------------------
  function showTip(event, p, W) {
    var m = p.m;
    var rows = [
      tipRow("Blended cost", DIMENSIONS.costBlended.fmt(blendedCostPerM(m, W)) + " /M"),
      tipRow("Cost / request", fmtMoneyReq(requestCost(m, W))),
      tipRow("Output speed", fmtSpeed(m.tokensPerSec)),
      tipRow("Input price", fmtMoneyPerM(m.input) + " /M"),
      tipRow("Output price", fmtMoneyPerM(m.output) + " /M"),
      tipRow("Context", fmtTokens(m.context)),
      tipRow("Max output", fmtTokens(m.maxOutput)),
      tipRow("Reasoning", m.reasoning ? "yes" : "no")
    ].join("");
    var sub = m.brand + (m.host ? " · via " + m.host : "") + (m.release ? " · " + m.release : "");
    tooltip.html(
      '<div class="llmx-tip-title"><span class="llmx-dot" style="background:' + brandColor(m.brand) + '"></span>' +
      esc(m.name) + "</div>" +
      '<div class="llmx-tip-sub">' + esc(sub) + "</div>" +
      '<dl class="llmx-tip-grid">' + rows + "</dl>"
    ).attr("hidden", null);

    var pt = d3.pointer(event, holder);
    var tw = tooltip.node().offsetWidth, th = tooltip.node().offsetHeight;
    var left = pt[0] + 16, top = pt[1] + 16;
    if (left + tw > holder.clientWidth) left = pt[0] - tw - 16;
    if (top + th > holder.clientHeight) top = Math.max(8, pt[1] - th - 16);
    tooltip.style("left", left + "px").style("top", top + "px");
  }
  function tipRow(k, v) { return "<dt>" + k + "</dt><dd>" + v + "</dd>"; }
  function hideTip() { tooltip.attr("hidden", ""); }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }

  // ---- Legend (also toggles brand visibility) --------------------------------
  function renderLegend(visible) {
    var legend = d3.select(el(".llmx-legend"));
    var brands = Array.from(new Set(
      MODELS.filter(function (m) { return state.selected.has(m.id); }).map(function (m) { return m.brand; })
    )).sort();

    var items = legend.selectAll("button.llmx-legend-item").data(brands, function (b) { return b; });
    items.exit().remove();
    var enter = items.enter().append("button")
      .attr("type", "button")
      .attr("class", "llmx-legend-item")
      .on("click", function (event, b) {
        if (state.hiddenBrands.has(b)) state.hiddenBrands.delete(b); else state.hiddenBrands.add(b);
        update(true);
      });
    enter.append("span").attr("class", "llmx-dot");
    enter.append("span").attr("class", "llmx-legend-label");
    var merged = enter.merge(items);
    merged.classed("is-off", function (b) { return state.hiddenBrands.has(b); });
    merged.select(".llmx-dot").style("background", function (b) { return brandColor(b); });
    merged.select(".llmx-legend-label").text(function (b) { return b; });
  }

  // Build the full control + chart skeleton inside the mount element, so the
  // host page only needs an empty <div id="llmx">.
  function buildSkeleton(mount) {
    mount.innerHTML = `<div class="llmx-panel">
  <div class="llmx-field llmx-scenarios">
    <span class="llmx-field-label">Scenario</span>
    <div class="llmx-scenario-row" role="group" aria-label="Scenario presets"></div>
  </div>
  <div class="llmx-axes">
    <label class="llmx-field">
      <span class="llmx-field-label">Horizontal axis</span>
      <select class="llmx-select" data-axis="x"></select>
    </label>
    <label class="llmx-field">
      <span class="llmx-field-label">Vertical axis</span>
      <select class="llmx-select" data-axis="y"></select>
    </label>
    <div class="llmx-field">
      <span class="llmx-field-label">Models</span>
      <div class="llmx-dropdown" data-dropdown>
        <button type="button" class="llmx-dropdown-toggle" aria-expanded="false" aria-haspopup="true">
          <span class="llmx-dropdown-label">Models</span>
          <span class="llmx-caret" aria-hidden="true">&#9662;</span>
        </button>
        <div class="llmx-dropdown-menu" hidden>
          <div class="llmx-dropdown-actions">
            <button type="button" data-select="featured">Featured</button>
            <button type="button" data-select="all">All</button>
            <button type="button" data-select="none">None</button>
          </div>
          <div class="llmx-model-list"></div>
        </div>
      </div>
    </div>
  </div>
  <details class="llmx-advanced">
    <summary>
      <span class="llmx-summary-label">Advanced assumptions</span>
      <span class="llmx-summary-hint">workload mix, request size, cache</span>
    </summary>
    <div class="llmx-advanced-body">
      <div class="llmx-control" data-control="ratio">
        <div class="llmx-control-head">
          <label for="llmx-ratio">Token mix</label>
          <span class="llmx-control-value" data-value="ratio"></span>
        </div>
        <input type="range" id="llmx-ratio" class="llmx-range" data-range="ratio" min="0" max="1000" value="500" aria-describedby="llmx-ratio-hint">
        <div class="llmx-scale-labels"><span>5000&times; output</span><span>balanced</span><span>5000&times; input</span></div>
        <div class="llmx-control-hint" id="llmx-ratio-hint">Output-heavy work (drafting) sits left; input-heavy work (summarizing) sits right.</div>
      </div>
      <div class="llmx-control" data-control="inputSize">
        <div class="llmx-control-head">
          <label for="llmx-input">Input size</label>
          <span class="llmx-control-value" data-value="inputSize"></span>
        </div>
        <input type="range" id="llmx-input" class="llmx-range" data-range="inputSize" min="0" max="1000" value="500" aria-describedby="llmx-input-hint">
        <div class="llmx-control-hint" id="llmx-input-hint">Input tokens per request. Output tokens follow from the token mix above.</div>
      </div>
      <div class="llmx-control" data-control="cache">
        <div class="llmx-control-head">
          <label for="llmx-cache">Cached input</label>
          <span class="llmx-control-value" data-value="cache"></span>
        </div>
        <input type="range" id="llmx-cache" class="llmx-range" data-range="cache" min="0" max="100" value="0" aria-describedby="llmx-cache-hint">
        <div class="llmx-control-hint" id="llmx-cache-hint">Share of input served from cache, billed at each model's cache-read price.</div>
      </div>
      <p class="llmx-workload-readout" data-readout="workload" aria-live="polite"></p>
    </div>
  </details>
</div>
<figure class="llmx-figure">
  <div class="llmx-chart-holder">
    <svg class="llmx-chart" role="img" aria-label="Scatter plot comparing language models on the selected dimensions"></svg>
    <div class="llmx-tooltip" role="status" hidden></div>
  </div>
  <div class="llmx-legend" aria-label="Brands"></div>
  <figcaption class="llmx-provenance" data-readout="provenance"></figcaption>
</figure>`;
  }

  // ===========================================================================
  // Boot
  // ===========================================================================
  buildScenarioButtons();
  buildAxisSelects();
  buildModelDropdown();
  buildSliders();
  buildProvenance();
  syncRangeInputs();
  initChart();
  update(false);

  var resizeTimer;
  window.addEventListener("resize", function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () { update(false); }, 150);
  });
})();
