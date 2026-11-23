/* EV theme visuals: web background, spider reactor, boot sequence, clock. Visual only: reads state, touches no data. */
(() => { try {
  "use strict";
  const RM = matchMedia("(prefers-reduced-motion: reduce)").matches, TAU = Math.PI * 2;
  const EMBLEM = [[-24.5,-91.1,-30.9,-78.9,-33.9,-71.6,-35.2,-66.1,-36.1,-55.2,-36.1,-44.3,-35.5,-35.0,-35.0,-34.3,-32.7,-34.1,-28.2,-32.5,-22.0,-29.5,-11.8,-23.6,-11.4,-22.5,-12.3,-21.4,-20.5,-22.5,-29.8,-23.2,-49.3,-23.2,-50.2,-25.5,-51.1,-34.5,-50.9,-42.5,-50.0,-48.4,-50.0,-50.2,-50.7,-50.9,-49.5,-54.1,-49.5,-56.1,-54.3,-46.8,-56.1,-40.2,-57.0,-32.3,-56.6,-16.4,-55.9,-16.1,-52.5,-17.0,-43.4,-18.0,-28.9,-18.6,-12.3,-18.4,-11.4,-17.3,-11.4,-16.4,-12.3,-15.7,-27.0,-14.1,-45.0,-10.9,-64.8,-5.7,-70.0,-3.6,-68.2,3.9,-64.8,23.6,-61.8,36.4,-58.0,48.9,-54.1,57.5,-44.5,71.8,-42.3,74.3,-33.9,85.9,-33.6,85.7,-38.2,79.1,-38.4,78.2,-38.0,77.0,-38.2,76.8,-38.9,77.7,-39.5,76.8,-38.6,75.9,-43.6,65.0,-43.6,64.1,-44.5,62.7,-48.2,52.7,-51.4,39.8,-53.6,28.0,-55.9,12.5,-56.8,1.6,-55.0,0.2,-20.9,-11.6,-10.5,-14.1,-9.1,-13.0,-9.1,-12.3,-10.0,-11.4,-30.5,-2.3,-45.5,5.7,-47.7,7.5,-45.7,26.8,-42.7,42.7,-38.9,55.5,-34.8,65.0,-32.5,69.1,-37.0,55.2,-38.4,49.3,-38.2,48.6,-39.3,45.5,-39.5,43.0,-39.1,42.5,-38.6,43.0,-38.0,42.5,-38.0,39.5,-38.9,31.1,-39.8,9.5,-42.3,8.2,-30.0,0.7,-28.4,0.0,-27.3,0.2,-26.8,-0.7,-25.0,-0.5,-17.5,-5.7,-13.0,-8.2,-8.0,-10.2,-7.5,-9.1,-8.4,-8.2,-15.5,-3.4,-23.2,3.2,-23.6,14.3,-23.0,24.3,-21.8,27.3,-19.3,31.4,-14.1,37.5,-6.8,43.9,0.2,48.0,0.7,46.1,1.6,45.2,2.5,45.0,9.3,40.2,15.2,34.5,21.8,25.9,22.7,23.2,23.6,14.5,23.6,3.4,17.7,-2.0,7.5,-9.3,8.2,-10.2,9.1,-10.2,26.1,-0.2,39.8,9.1,38.9,30.0,37.0,47.7,33.9,61.6,31.6,68.6,28.9,75.0,28.4,77.3,31.8,71.6,37.0,57.7,37.7,56.8,37.7,55.5,38.9,54.1,38.9,53.0,40.2,50.7,43.0,42.0,45.7,27.5,47.7,7.5,43.6,4.8,33.2,-0.7,32.5,-0.7,28.9,-3.0,28.0,-3.0,23.4,-5.5,22.5,-5.5,20.7,-6.8,20.0,-6.6,18.2,-8.0,9.3,-11.8,8.9,-12.3,9.1,-13.2,10.0,-14.1,11.4,-14.1,23.9,-11.4,25.9,-10.0,29.3,-9.3,35.9,-6.6,39.5,-5.7,56.4,0.9,57.0,1.6,53.9,28.0,51.1,41.8,47.5,55.5,45.0,62.0,39.3,74.5,34.1,83.4,33.0,84.5,31.6,87.5,26.4,94.8,26.6,95.0,32.0,88.9,40.9,76.1,46.8,66.1,50.9,57.7,54.3,49.3,55.5,44.5,56.4,43.0,56.4,41.6,58.9,33.6,60.0,27.7,60.9,26.1,60.9,24.8,61.6,23.9,62.5,25.7,62.7,23.2,63.6,22.0,64.3,22.7,64.8,22.0,64.5,20.7,65.7,17.5,65.7,15.2,66.8,11.4,68.6,0.5,69.3,-1.1,69.1,-2.0,70.0,-3.6,63.0,-6.1,44.5,-10.9,29.8,-13.6,13.4,-15.5,10.7,-16.4,11.6,-18.6,15.9,-19.1,39.3,-18.4,50.5,-17.5,54.8,-16.6,56.6,-16.8,56.1,-17.7,56.6,-18.2,56.6,-21.4,56.1,-22.5,56.4,-24.5,55.7,-24.5,55.0,-25.2,55.0,-37.5,54.1,-43.6,51.4,-52.7,47.7,-59.5,47.5,-58.6,48.4,-56.4,50.0,-49.1,51.1,-38.6,50.9,-30.9,49.8,-23.6,49.3,-23.2,33.0,-23.2,24.8,-22.7,12.0,-20.9,10.9,-21.8,11.1,-22.3,10.7,-23.2,11.4,-24.1,16.8,-27.5,18.0,-27.7,19.8,-29.1,20.7,-29.1,22.3,-30.5,23.6,-30.5,26.8,-32.3,32.3,-34.1,35.2,-34.5,35.7,-36.1,36.4,-50.5,35.2,-64.8,34.3,-65.2,34.8,-65.7,34.5,-66.8,33.2,-67.3,33.0,-68.9,33.9,-70.2,33.4,-70.9,32.7,-70.2,32.3,-70.7,32.3,-72.5,31.6,-73.2,28.0,-84.5,25.0,-90.9,22.5,-95.0,22.3,-94.5,24.8,-88.2,24.8,-87.0,27.0,-79.8,29.3,-66.8,29.3,-51.6,27.7,-39.1,9.1,-25.5,7.7,-26.6,7.3,-28.0,10.5,-31.1,12.0,-33.4,9.5,-36.4,5.5,-40.0,4.8,-39.8,6.6,-36.6,7.0,-33.6,5.0,-31.1,3.6,-30.5,-3.4,-30.2,-5.7,-31.1,-7.3,-33.2,-7.0,-34.1,-8.2,-35.9,-4.5,-40.0,-5.2,-40.2,-7.0,-39.1,-12.0,-33.9,-12.0,-32.7,-7.7,-28.0,-8.0,-26.8,-8.9,-25.9,-10.7,-26.6,-27.0,-38.4,-28.0,-39.5,-29.5,-56.4,-29.5,-64.5,-28.4,-74.1,-28.9,-74.5,-29.3,-74.1,-29.3,-72.7,-29.8,-72.3,-30.5,-73.4],[-12.0,-3.0,-11.4,-2.5,-15.9,5.2,-15.7,10.2,-14.5,17.7,-13.0,21.1,-9.1,26.1,-5.7,29.3,-1.1,32.3,1.1,32.5,6.4,28.9,7.7,27.0,9.1,26.1,9.5,24.8,10.7,23.9,13.9,18.9,15.5,11.6,16.1,5.0,11.8,-2.5,12.3,-3.0,14.1,-1.6,19.5,4.1,19.1,18.0,18.4,22.5,13.0,30.7,8.0,35.5,0.7,40.9,-0.2,40.9,-2.7,39.3,-10.2,33.2,-15.2,27.5,-18.2,22.0,-19.1,13.0,-19.3,4.5,-18.9,3.6]];
  const $ = s => document.querySelector(s);

  /* ---- background: web + drifting particles ---- */
  document.body.insertAdjacentHTML("afterbegin", '<canvas id="ev-bg" aria-hidden="true"></canvas><div class="ev-vig" aria-hidden="true"></div><div class="ev-scan" aria-hidden="true"></div>');
  const bg = $("#ev-bg"), bx = bg.getContext("2d"), layer = document.createElement("canvas");
  let bw = 0, bh = 0, dots = [];
  function sizeBg() {
    const d = Math.min(devicePixelRatio || 1, 2);
    bw = innerWidth; bh = innerHeight;
    bg.width = layer.width = bw * d; bg.height = layer.height = bh * d;
    bx.setTransform(d, 0, 0, d, 0, 0);
    const lx = layer.getContext("2d"); lx.setTransform(d, 0, 0, d, 0, 0); lx.clearRect(0, 0, bw, bh);
    lx.strokeStyle = "rgba(200,205,235,.075)"; lx.lineWidth = 1;
    [[0, bh, 1], [bw, 0, -1]].forEach(([ox, oy, s]) => {
      const R = Math.max(bw, bh) * .95;
      for (let i = 0; i <= 8; i++) { const a = i / 8 * Math.PI / 2; lx.beginPath(); lx.moveTo(ox, oy); lx.lineTo(ox + s * Math.cos(a) * R, oy - s * Math.sin(a) * R); lx.stroke(); }
      for (let r = 1; r <= 7; r++) { lx.beginPath(); for (let i = 0; i <= 8; i++) { const a = i / 8 * Math.PI / 2, rr = r * R / 7 * (1 - .05 * Math.sin(i * 1.7 + r)); const px = ox + s * Math.cos(a) * rr, py = oy - s * Math.sin(a) * rr; i ? lx.lineTo(px, py) : lx.moveTo(px, py); } lx.stroke(); }
    });
    dots = Array.from({ length: RM ? 0 : Math.round(Math.min(46, bw * bh / 22000)) }, () => ({ x: Math.random() * bw, y: Math.random() * bh, v: .12 + Math.random() * .3, r: .6 + Math.random() * 1.3 }));
    drawBg();
  }
  function drawBg() {
    bx.clearRect(0, 0, bw, bh); bx.drawImage(layer, 0, 0, bw, bh);
    bx.fillStyle = "rgba(255,90,100,.55)";
    for (const d of dots) { d.y -= d.v; if (d.y < -4) { d.y = bh + 4; d.x = Math.random() * bw; } bx.beginPath(); bx.arc(d.x, d.y, d.r, 0, TAU); bx.fill(); }
  }
  addEventListener("resize", sizeBg); sizeBg();

  /* ---- reactor in the welcome orb ---- */
  const orb = $(".welcome-orb");
  let rc = null, label = null;
  if (orb) {
    orb.textContent = "";
    rc = document.createElement("canvas"); rc.width = rc.height = 460; rc.setAttribute("aria-hidden", "true"); orb.appendChild(rc);
    label = document.createElement("p"); label.className = "ev-state"; label.textContent = "STANDBY";
    orb.insertAdjacentElement("afterend", label);
  }
  const STATE_TXT = { standby: "STANDBY", listening: "LISTENING", thinking: "PROCESSING", speaking: "SPEAKING" };
  function evState() {
    const v = window.kalkiVoiceState || {};
    if (window.speechSynthesis && speechSynthesis.speaking) return "speaking";
    if (v.listening) return "listening";
    if (v.processing || window.kalkiAssistantState === "solving") return "thinking";
    return "standby";
  }
  function drawReactor(t, st) {
    const x = rc.getContext("2d"), W = rc.width, cx = W / 2, R = W / 2 - 6;
    const act = { standby: .25, listening: .9, thinking: .7, speaking: 1 }[st], pulse = .5 + .5 * Math.sin(t * (1.6 + act * 3.2));
    x.clearRect(0, 0, W, W);
    const g = x.createRadialGradient(cx, cx, R * .1, cx, cx, R);
    g.addColorStop(0, "rgba(255,59,70," + (.22 + .28 * act * pulse) + ")"); g.addColorStop(1, "rgba(255,59,70,0)");
    x.fillStyle = g; x.beginPath(); x.arc(cx, cx, R, 0, TAU); x.fill();
    // web
    x.strokeStyle = "rgba(205,210,240,.38)"; x.lineWidth = 1.4;
    const N = 12, wr = R * .76;
    for (let i = 0; i < N; i++) { const a = i / N * TAU; x.beginPath(); x.moveTo(cx, cx); x.lineTo(cx + Math.cos(a) * wr, cx + Math.sin(a) * wr); x.stroke(); }
    for (let r = 1; r <= 5; r++) { const rr = wr * r / 5; x.beginPath(); for (let i = 0; i <= N; i++) { const a = i / N * TAU, am = (i + .5) / N * TAU, px = cx + Math.cos(a) * rr, py = cx + Math.sin(a) * rr; if (!i) x.moveTo(px, py); else { x.quadraticCurveTo(cx + Math.cos(am - 0) * rr * .93, cx + Math.sin(am) * rr * .93, px, py); } } x.stroke(); }
    // outer ticks + rotating arcs
    x.strokeStyle = "rgba(79,134,255,.75)"; x.lineWidth = 2;
    const rot = t * (.25 + act * .9);
    for (let i = 0; i < 60; i++) { const a = i / 60 * TAU + rot * .2, r1 = R * .9, r2 = R * (i % 5 ? .93 : .97); x.beginPath(); x.moveTo(cx + Math.cos(a) * r1, cx + Math.sin(a) * r1); x.lineTo(cx + Math.cos(a) * r2, cx + Math.sin(a) * r2); x.stroke(); }
    x.lineWidth = 5; x.strokeStyle = "rgba(79,134,255,.9)";
    for (let k = 0; k < 3; k++) { x.beginPath(); x.arc(cx, cx, R * .86, rot + k * TAU / 3, rot + k * TAU / 3 + .9 + .4 * act); x.stroke(); }
    // emblem
    const s = R * .72 / 100;
    x.save(); x.shadowColor = "rgba(255,59,70,.95)"; x.shadowBlur = 10 + 14 * act * pulse; x.fillStyle = "#ff3b46";
    x.beginPath();
    for (const f of EMBLEM) { for (let i = 0; i < f.length; i += 2) { const px = cx + f[i] * s, py = cx + f[i + 1] * s; i ? x.lineTo(px, py) : x.moveTo(px, py); } x.closePath(); }
    x.fill("evenodd"); x.restore();
  }

  /* ---- loop (24 fps, paused when hidden or reactor off-screen) ---- */
  let last = 0;
  function frame(ts) {
    requestAnimationFrame(frame);
    if (document.hidden || ts - last < 41) return; last = ts;
    if (!RM) drawBg();
    if (rc && rc.offsetParent !== null) {
      const st = evState(); drawReactor(ts / 1000, st);
      if (label && label.textContent !== STATE_TXT[st]) label.textContent = STATE_TXT[st];
    }
  }
  if (rc) drawReactor(0, "standby");
  requestAnimationFrame(frame);

  /* ---- header clock ---- */
  const clear = $("#clear-btn");
  if (clear) {
    const c = document.createElement("div"); c.className = "ev-clock"; c.setAttribute("aria-hidden", "true");
    clear.parentNode.insertBefore(c, clear);
    const tick = () => { const d = new Date(); c.innerHTML = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) + "<small>" + d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" }) + "</small>"; };
    tick(); setInterval(tick, 20000);
  }

  /* ---- boot sequence (once per session, tap to skip) ---- */
  let booted = false; try { booted = !!sessionStorage.getItem("ev_booted"); } catch {}
  if (!booted && !RM) {
    const b = document.createElement("div"); b.id = "ev-boot"; b.setAttribute("role", "status");
    b.innerHTML = '<div class="ev-boot-box"><div class="ev-boot-title">EV</div><pre id="ev-boot-log"></pre><small>TAP TO SKIP</small></div>';
    document.body.appendChild(b);
    const lines = ["EV CORE // BOOT SEQUENCE", "LINKING NEURAL INTERFACE .......... OK", "LOADING VOICE MODULES ............. OK", "CALIBRATING WEB-SHOOTERS .......... OK", "ALL SYSTEMS NOMINAL. WELCOME BACK."];
    let i = 0;
    const done = () => { if (!b.isConnected) return; b.style.opacity = "0"; setTimeout(() => b.remove(), 520); try { sessionStorage.setItem("ev_booted", "1"); } catch {} };
    const step = () => { if (!b.isConnected) return; const log = $("#ev-boot-log"); if (i < lines.length) { log.textContent += lines[i++] + "\n"; setTimeout(step, 340); } else setTimeout(done, 450); };
    b.addEventListener("click", done); step();
  }
} catch (e) { console.warn("EV theme:", e); } })();
