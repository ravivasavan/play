/* play.ravivasavan.com — the shared behaviour.
   Four things every page needs and none of them owns: the theme pill, the
   circadian script arriving only when it's wanted, the tools row's sideways
   drag, and the sheet folding into a bottom sheet on a phone. Nothing here
   knows what any experiment does.

   Classic script, loaded with defer, before the page's own scripts. */
(function () {
  'use strict';

  var html = document.documentElement;
  var THEMES = ['day', 'night', 'system', 'circadian'];
  var DAY = '#fff5f5';
  var NIGHT = '#0d1b1e';

  /* ---------------------------------------------------------------- theme -- */

  function themeColour(t) {
    if (t === 'circadian') {
      // circadian.js publishes --bg inline on <html>; before it lands, the
      // cache the head script restored is the same value.
      var live = getComputedStyle(html).getPropertyValue('--bg').trim();
      if (live) return live;
      try {
        var cache = JSON.parse(localStorage.getItem('circadian-cache'));
        if (cache && cache['--bg']) return cache['--bg'];
      } catch (e) {}
      return DAY;
    }
    if (t === 'day') return DAY;
    if (t === 'night') return NIGHT;
    return matchMedia('(prefers-color-scheme: dark)').matches ? NIGHT : DAY;
  }

  function paintThemeColour() {
    var meta = document.getElementById('theme-color');
    if (meta) meta.setAttribute('content', themeColour(html.dataset.theme));
  }

  // The sun palette is 19KB of zone table; it only loads for the people who
  // asked for it, and only once.
  function loadCircadian() {
    if (html.dataset.theme !== 'circadian') return;
    if (document.getElementById('circadian-script')) return;
    var s = document.createElement('script');
    s.id = 'circadian-script';
    s.src = '/assets/circadian.js';
    s.defer = true;
    document.head.appendChild(s);
  }

  function setTheme(t) {
    html.dataset.theme = t;
    try { localStorage.setItem('theme', t); } catch (e) {}
    loadCircadian();
    paintThemeColour();
  }

  document.addEventListener('click', function (e) {
    var pill = e.target.closest && e.target.closest('[data-theme-toggle]');
    if (!pill) return;
    var i = THEMES.indexOf(html.dataset.theme || 'system');
    setTheme(THEMES[(i + 1) % THEMES.length]);
  });

  // Circadian repaints --bg every minute, and the OS can flip under "system":
  // the address bar follows both.
  new MutationObserver(paintThemeColour).observe(html, { attributes: true, attributeFilter: ['data-theme', 'style'] });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', paintThemeColour);

  loadCircadian();
  paintThemeColour();

  /* ---------------------------------------------------------------- dials -- */
  /* WebKit draws no progress on a range, so .dial paints its filled half with a
     gradient sized by --dial-fill. Keeping that in step is chrome, not content,
     so it lives here rather than in five experiments. */

  function paintDial(el) {
    var min = parseFloat(el.min) || 0;
    var max = el.max === '' ? 100 : parseFloat(el.max);
    var span = max - min;
    var pct = span > 0 ? ((parseFloat(el.value) - min) / span) * 100 : 0;
    el.style.setProperty('--dial-fill', Math.max(0, Math.min(100, pct)) + '%');
  }

  function paintDials(root) {
    var list = (root || document).querySelectorAll('input[type="range"].dial');
    for (var i = 0; i < list.length; i++) paintDial(list[i]);
  }

  document.addEventListener('input', function (e) {
    var t = e.target;
    if (t && t.matches && t.matches('input[type="range"].dial')) paintDial(t);
  });

  /* ------------------------------------------------------------ tools row -- */
  /* Folded, the row scrolls sideways rather than dropping its labels. Touch
     pans it natively; this gives a pointer the same, and swallows the click
     that would otherwise fire on whichever pill the drag ended over. */

  function dragRow(row) {
    var down = false, moved = false, sx = 0, sl = 0;
    row.addEventListener('pointerdown', function (e) {
      if (e.pointerType === 'touch') return;             // native panning has it
      if (row.scrollWidth <= row.clientWidth) return;    // nothing to scroll: leave clicks alone
      down = true; moved = false; sx = e.clientX; sl = row.scrollLeft;
    });
    row.addEventListener('pointermove', function (e) {
      if (!down) return;
      var dx = e.clientX - sx;
      if (Math.abs(dx) > 6) { moved = true; row.classList.add('dragging'); }
      if (moved) { row.scrollLeft = sl - dx; e.preventDefault(); }
    });
    // The row is transparent to the pointer (the pills are not), so a release
    // that lands off a pill would never reach a listener on the row itself.
    ['pointerup', 'pointercancel'].forEach(function (type) {
      window.addEventListener(type, function () { down = false; row.classList.remove('dragging'); });
    });
    row.addEventListener('click', function (e) {
      if (moved) { e.preventDefault(); e.stopPropagation(); moved = false; }
    }, true);
  }

  /* ------------------------------------------------------------ the sheet -- */
  /* Above 900 the sheet is a floating pane and always open. Folded it drops to
     the bottom of the screen showing only its head, and the head or the grabber
     opens it to the height of its content, capped at 72vh. */

  var folded = matchMedia('(max-width: 900px)');

  /* --- minimised, and remembered --- */
  /* Minimise is a preference, not a page state: it is one key for the whole
     site, and it is stamped on <html> rather than on the sheet. Both halves
     matter for the flash. The attribute is written here, at script-execution
     time — play.js is deferred, so the document is parsed but nothing has
     painted — and because CSS keys off the root rather than the element, a
     page that builds its sheet in script (metal's DialKit panel) gets the
     minimised geometry on that sheet's first frame too. */

  var SHEET_KEY = 'play.sheet';

  function minimised() { return html.getAttribute('data-play-sheet') === 'min'; }

  function stampMin(min) { html.setAttribute('data-play-sheet', min ? 'min' : 'open'); }

  try { stampMin(localStorage.getItem(SHEET_KEY) === 'min'); } catch (e) { stampMin(false); }

  function fullHeight(sheet) {
    var prevH = sheet.style.height;
    var prevT = sheet.style.transition;
    sheet.style.transition = 'none';
    sheet.style.height = 'auto';
    var h = sheet.scrollHeight;
    sheet.style.height = prevH;
    void sheet.offsetHeight;               // flush, or the reopen won't animate
    sheet.style.transition = prevT;
    return h;
  }

  // Folded and shut, the sheet is 60px of glass clipping a full panel of
  // controls; minimised it is a 64px disc clipping the head as well. They are
  // still in the DOM either way, so without this a keyboard or a screen reader
  // walks straight into thirty invisible fields — and the clip is
  // overflow:hidden, so the browser cannot even scroll them into view. inert
  // takes them out of the tab order and off the a11y tree together.
  function gateBody(sheet) {
    var body = sheet.querySelector('.sheet__body');
    var head = sheet.querySelector('.sheet__head');
    var min = minimised();
    var shut = min || (folded.matches && !sheet.classList.contains('is-open'));
    // Read who has focus before inert takes it away: the browser drops it on
    // <body>, and Escape out of a field would lose the user's place.
    var had = (shut && body && body.contains(document.activeElement)) ||
              (min && head && head.contains(document.activeElement));
    if (body) {
      body.inert = shut;
      // Belt and braces for the engines that ship inert without the a11y half.
      if (shut) body.setAttribute('aria-hidden', 'true');
      else body.removeAttribute('aria-hidden');
    }
    if (head) {
      head.inert = min;
      if (min) head.setAttribute('aria-hidden', 'true');
      else head.removeAttribute('aria-hidden');
    }
    var icon = sheet.querySelector('.sheet__icon');
    if (icon) icon.setAttribute('aria-expanded', min ? 'false' : 'true');
    if (had) {
      var to = min ? icon : head;
      if (to && to.focus) to.focus();
    }
  }

  function openSheet(sheet) {
    sheet.style.setProperty('--sheet-full', fullHeight(sheet) + 'px');
    sheet.classList.add('is-open');
    var head = sheet.querySelector('.sheet__head');
    if (head) head.setAttribute('aria-expanded', 'true');
    gateBody(sheet);
  }

  function closeSheet(sheet) {
    sheet.classList.remove('is-open');
    var head = sheet.querySelector('.sheet__head');
    if (head) head.setAttribute('aria-expanded', 'false');
    gateBody(sheet);
  }

  function toggleSheet(sheet) {
    if (sheet.classList.contains('is-open')) closeSheet(sheet);
    else openSheet(sheet);
  }

  // Lucide, drawn at 24 and scaled by the CSS: minimize-2 for the control in
  // the head, sliders-horizontal for the disc it leaves behind.
  var GLYPH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';
  var MINIMISE = GLYPH + '<path d="M4 14h6v6"/><path d="M20 10h-6V4"/><path d="m14 10 7-7"/><path d="m3 21 7-7"/></svg>';
  var SLIDERS = GLYPH + '<path d="M10 5H3"/><path d="M12 19H3"/><path d="M14 3v4"/><path d="M16 17v4"/><path d="M21 12H12"/><path d="M21 19h-5"/><path d="M21 5h-7"/><path d="M8 10v4"/><path d="M8 12H3"/></svg>';

  function prepareSheet(sheet) {
    if (!sheet.querySelector('.sheet__grab')) {
      var grab = document.createElement('div');
      grab.className = 'sheet__grab';
      grab.setAttribute('aria-hidden', 'true');
      sheet.insertBefore(grab, sheet.firstChild);
    }
    var head = sheet.querySelector('.sheet__head');
    if (head && !head.hasAttribute('role')) {
      head.setAttribute('role', 'button');
      head.setAttribute('tabindex', '0');
      head.setAttribute('aria-expanded', 'false');
    }
    // The minimise control goes last in the head, so it is the hard-right item
    // whatever else the experiment put there.
    if (head && !head.querySelector('.sheet__min')) {
      var min = document.createElement('button');
      min.type = 'button';
      min.className = 'sheet__min';
      min.setAttribute('aria-label', 'Minimise settings');
      min.innerHTML = MINIMISE;
      head.appendChild(min);
    }
    // And the disc's face, which is all that is left of the sheet once it is.
    if (!sheet.querySelector('.sheet__icon')) {
      var icon = document.createElement('button');
      icon.type = 'button';
      icon.className = 'sheet__icon';
      icon.setAttribute('aria-label', 'Show settings');
      icon.setAttribute('aria-expanded', 'false');
      icon.innerHTML = SLIDERS;
      sheet.appendChild(icon);
    }
    gateBody(sheet);
  }

  // One preference for every sheet on the page and every play on the site.
  function setMin(min, from) {
    stampMin(min);
    try { localStorage.setItem(SHEET_KEY, min ? 'min' : 'open'); } catch (e) {}
    document.querySelectorAll('.sheet').forEach(gateBody);
    if (!from) return;
    // Minimising, gateBody has already moved focus from the head to the disc.
    // Restoring, the disc it was on is gone, so hand focus back to the head —
    // to the minimise button in it, which is where the journey started.
    if (!min) {
      var back = from.querySelector('.sheet__min') || from.querySelector('.sheet__head');
      if (back && back.focus) back.focus();
    }
  }

  document.addEventListener('click', function (e) {
    var hit = e.target.closest && e.target.closest('.sheet__min, .sheet__icon');
    if (!hit) return;
    e.preventDefault();
    e.stopPropagation();
    setMin(hit.classList.contains('sheet__min'), hit.closest('.sheet'));
  });

  // Delegated, so a sheet built after load still works.
  document.addEventListener('click', function (e) {
    if (!folded.matches) return;
    var hit = e.target.closest && e.target.closest('.sheet__head, .sheet__grab');
    if (!hit) return;
    // A control that happens to live in the head row keeps its own click.
    var ctl = e.target.closest('button, a, input, select, textarea, label');
    if (ctl && hit.contains(ctl)) return;
    var sheet = hit.closest('.sheet');
    if (sheet) toggleSheet(sheet);
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      var open = document.querySelectorAll('.sheet.is-open');
      for (var i = 0; i < open.length; i++) {
        closeSheet(open[i]);
        // gateBody catches the usual case. A page with its own Escape (atlas
        // blurs its search box) can have dropped focus on <body> before this
        // runs, and a keyboard user should not land back at the top of the
        // document because they shut a sheet.
        var head = open[i].querySelector('.sheet__head');
        if (folded.matches && !minimised() && head &&
            (!document.activeElement || document.activeElement === document.body)) head.focus();
      }
      return;
    }
    if (e.key !== 'Enter' && e.key !== ' ') return;
    var head = e.target.closest && e.target.closest('.sheet__head');
    if (!head || !folded.matches) return;
    // The minimise button lives in the head and is a real button: swallowing
    // the key here would stop the browser turning it into a click.
    if (e.target.closest('.sheet__min')) return;
    e.preventDefault();
    toggleSheet(head.closest('.sheet'));
  });

  // Dragging the grabber: up opens, down closes, past a 24px commitment.
  function dragGrab(sheet) {
    var grab = sheet.querySelector('.sheet__grab');
    if (!grab) return;
    var y0 = null;
    grab.addEventListener('pointerdown', function (e) { y0 = e.clientY; grab.setPointerCapture(e.pointerId); });
    grab.addEventListener('pointerup', function (e) {
      if (y0 === null) return;
      var dy = e.clientY - y0;
      y0 = null;
      if (dy < -24) openSheet(sheet);
      else if (dy > 24) closeSheet(sheet);
    });
    grab.addEventListener('pointercancel', function () { y0 = null; });
  }

  // Unfolding while a bottom sheet is open would leave a stale height on the
  // floating pane; drop it at the boundary.
  folded.addEventListener('change', function () {
    document.querySelectorAll('.sheet').forEach(function (sheet) {
      closeSheet(sheet);
      sheet.style.removeProperty('--sheet-full');
    });
  });

  /* ------------------------------------------------------------------ go -- */

  function start() {
    paintDials(document);
    document.querySelectorAll('.tools').forEach(dragRow);
    document.querySelectorAll('.sheet').forEach(function (sheet) {
      prepareSheet(sheet);
      dragGrab(sheet);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();

  // A page that sets a dial's value in code calls play.dials() to repaint it.
  window.play = {
    dials: paintDials,
    setTheme: setTheme,
    openSheet: openSheet,
    closeSheet: closeSheet,
    minimiseSheet: function (min) { setMin(min !== false); },
    isSheetMinimised: minimised
  };
})();
