/*
 * app.js -- UI and render pipeline for Random Compilation Maker (web edition).
 *
 * Nothing here talks to a server. Source videos are mounted straight off disk
 * into a local WebAssembly FFmpeg (WORKERFS, so the bytes are read lazily
 * rather than copied into memory), clips are cut and re-encoded locally, and
 * the result is handed back to the file system.
 *
 * The FFmpeg engine itself is downloaded once and kept in Cache Storage, so
 * after the first install the page works with no network at all.
 */
(function () {
  'use strict';

  var C = window.RCM;

  // ------------------------------------------------------------------ dom -- //
  function $(sel) { return document.querySelector(sel); }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ---------------------------------------------------------------- state -- //
  var S = {
    items: [],            // {id, file, label}
    nextId: 1,
    selected: new Set(),
    coreURL: null,
    wasmURL: null,
    encoders: null,       // Set of encoder names from `ffmpeg -encoders`
    pool: [],
    abort: false,
    running: false,
    saveHandle: null,
    lastObjectURL: null
  };

  // --------------------------------------------------------------- engine -- //
  // Same source list and vendor-first order as fabinator-weakframes: a local
  // vendor/ copy wins if you dropped one in, otherwise the pinned core comes
  // off a CDN. The difference here is that the download is kept in Cache
  // Storage, so "installed" survives a browser cache eviction of ordinary
  // HTTP resources and can be reported and removed explicitly.
  var CORE_VERSION = '0.12.6';
  var CORE_CDNS = [
    'https://unpkg.com/@ffmpeg/core@' + CORE_VERSION + '/dist/umd',
    'https://cdn.jsdelivr.net/npm/@ffmpeg/core@' + CORE_VERSION + '/dist/umd'
  ];
  var CACHE_NAME = 'rcm-ffmpeg-core-' + CORE_VERSION;
  var KEY_BASE = 'https://ffmpeg-core.local/' + CORE_VERSION + '/';
  var CORE_FILES = [
    { file: 'ffmpeg-core.js', mime: 'text/javascript' },
    { file: 'ffmpeg-core.wasm', mime: 'application/wasm' }
  ];

  function setEngineStatus(text, cls) {
    var el = $('#engineStatus');
    if (!el) return;
    el.textContent = text;
    el.className = 'chip ' + (cls || '');
  }

  function cachesAvailable() {
    try { return typeof caches !== 'undefined' && !!caches.open; } catch (e) { return false; }
  }

  async function detectVendorBase() {
    try {
      var r = await fetch('vendor/ffmpeg-core.wasm', { method: 'HEAD' });
      if (r.ok) return 'vendor';
    } catch (e) { /* no vendored copy */ }
    return null;
  }

  /** Bytes already installed locally, or null if the engine isn't installed. */
  async function installedBytes() {
    if (!cachesAvailable()) return null;
    var cache = await caches.open(CACHE_NAME);
    var total = 0;
    for (var i = 0; i < CORE_FILES.length; i++) {
      var res = await cache.match(KEY_BASE + CORE_FILES[i].file);
      if (!res) return null;
      var buf = await res.clone().arrayBuffer();
      total += buf.byteLength;
    }
    return total;
  }

  async function refreshEngineChip() {
    if (location.protocol === 'file:') {
      setEngineStatus('Open this page over http:// -- file:// blocks the engine', 'bad');
      return;
    }
    var bytes = await installedBytes();
    var install = $('#btnInstall');
    var uninstall = $('#btnUninstall');
    if (bytes) {
      setEngineStatus('FFmpeg installed locally (' + C.formatBytes(bytes) + ')', 'ok');
      if (install) install.textContent = 'Reinstall FFmpeg';
      if (uninstall) uninstall.hidden = false;
    } else {
      setEngineStatus('FFmpeg not installed yet', 'warn');
      if (install) install.textContent = 'Install FFmpeg';
      if (uninstall) uninstall.hidden = true;
    }
  }

  async function downloadWithProgress(url, onProgress) {
    var res = await fetch(url);
    if (!res.ok) throw new Error(url + ' -> HTTP ' + res.status);
    var total = parseInt(res.headers.get('content-length') || '0', 10);
    if (!res.body || !res.body.getReader) {
      return new Uint8Array(await res.arrayBuffer());
    }
    var reader = res.body.getReader();
    var chunks = [];
    var got = 0;
    for (;;) {
      var step = await reader.read();
      if (step.done) break;
      chunks.push(step.value);
      got += step.value.length;
      if (onProgress) onProgress(got, total);
    }
    var out = new Uint8Array(got);
    var at = 0;
    chunks.forEach(function (ch) { out.set(ch, at); at += ch.length; });
    return out;
  }

  /** Fetch one core file from the first source that has it, and cache it. */
  async function obtainCoreFile(spec, bases, cache) {
    var hit = cache ? await cache.match(KEY_BASE + spec.file) : null;
    if (hit) return new Uint8Array(await hit.arrayBuffer());

    var lastErr = null;
    for (var b = 0; b < bases.length; b++) {
      var where = bases[b] === 'vendor' ? 'local vendor/ folder' : bases[b];
      setEngineStatus('Downloading FFmpeg (' + spec.file + ')…', 'warn');
      log('Fetching ' + spec.file + ' from ' + where);
      try {
        var bytes = await downloadWithProgress(bases[b] + '/' + spec.file, function (got, total) {
          var pct = total ? Math.round((got / total) * 100) + '%' : C.formatBytes(got);
          setEngineStatus('Downloading FFmpeg — ' + spec.file + ' ' + pct, 'warn');
        });
        if (cache) {
          await cache.put(KEY_BASE + spec.file,
            new Response(bytes, { headers: { 'Content-Type': spec.mime } }));
        }
        log('  got ' + spec.file + ' (' + C.formatBytes(bytes.length) + ')' +
          (cache ? ' — stored on this machine' : ''));
        return bytes;
      } catch (e) {
        lastErr = e;
        log('  ' + e.message, 'warnline');
      }
    }
    setEngineStatus('FFmpeg download failed', 'bad');
    throw lastErr || new Error('could not download ' + spec.file);
  }

  /**
   * Make sure the FFmpeg core is on this machine, downloading it once if not.
   * Returns {coreURL, wasmURL} blob URLs ready to hand to FFmpeg.load().
   */
  async function installEngine(force) {
    if (S.coreURL && S.wasmURL && !force) return { coreURL: S.coreURL, wasmURL: S.wasmURL };

    var bases = [];
    var vendor = await detectVendorBase();
    if (vendor) bases.push(vendor);
    bases.push.apply(bases, CORE_CDNS);

    var cache = cachesAvailable() ? await caches.open(CACHE_NAME) : null;
    var i;
    if (cache && force) {
      for (i = 0; i < CORE_FILES.length; i++) await cache.delete(KEY_BASE + CORE_FILES[i].file);
    }

    var urls = {};
    for (i = 0; i < CORE_FILES.length; i++) {
      var spec = CORE_FILES[i];
      var bytes = await obtainCoreFile(spec, bases, cache);
      urls[spec.file] = URL.createObjectURL(new Blob([bytes], { type: spec.mime }));
    }

    S.coreURL = urls['ffmpeg-core.js'];
    S.wasmURL = urls['ffmpeg-core.wasm'];
    await refreshEngineChip();
    return { coreURL: S.coreURL, wasmURL: S.wasmURL };
  }

  /** Spin up one FFmpeg instance (its own Web Worker and its own memory). */
  async function createEngine(tag) {
    if (typeof FFmpegWASM === 'undefined' || typeof FFmpegUtil === 'undefined') {
      throw new Error('FFmpeg scripts did not load -- lib/ffmpeg/ is missing or blocked.');
    }
    var urls = await installEngine(false);
    var ff = new FFmpegWASM.FFmpeg();
    var eng = { ff: ff, tag: tag, tail: [], collect: null, onFrame: null, dead: false };

    ff.on('log', function (ev) {
      var msg = (ev && ev.message !== undefined) ? ev.message : String(ev);
      eng.tail.push(msg);
      if (eng.tail.length > 60) eng.tail.shift();
      if (eng.collect) eng.collect.push(msg);
      var n = C.parseFrameCount(msg);
      if (n !== null && eng.onFrame) eng.onFrame(n);
    });

    await ff.load({ coreURL: urls.coreURL, wasmURL: urls.wasmURL });
    return eng;
  }

  function killEngine(eng) {
    if (!eng || eng.dead) return;
    eng.dead = true;
    try { eng.ff.terminate(); } catch (e) { /* already gone */ }
  }

  function killPool() {
    S.pool.forEach(killEngine);
    S.pool = [];
  }

  // Encoders this build advertises but cannot actually run. Each was found by
  // encoding a short clip in a fresh engine: libx265 never returns, and the
  // other two abort the WebAssembly heap. Treating them as missing turns a
  // hung or dead tab into an honest fallback with a message.
  // (ljpeg, so MJPEG Lossless, is fine -- only baseline mjpeg is broken.)
  var UNUSABLE_ENCODERS = {
    'libx265': 'libx265 never finishes in the WebAssembly build',
    'libvpx-vp9': 'libvpx-vp9 crashes the WebAssembly build',
    'mjpeg': 'the mjpeg encoder crashes the WebAssembly build'
  };

  /** Read `ffmpeg -encoders` once so we know what this build can actually do. */
  async function probeEncoders(eng) {
    if (S.encoders) return S.encoders;
    eng.collect = [];
    try {
      await eng.ff.exec(['-hide_banner', '-encoders']);
    } catch (e) { /* best effort */ }
    var found = new Set();
    (eng.collect || []).forEach(function (line) {
      var name = C.parseEncoderLine(line);
      if (name) found.add(name);
    });
    eng.collect = null;
    if (found.size) {
      Object.keys(UNUSABLE_ENCODERS).forEach(function (enc) { found.delete(enc); });
      S.encoders = found;
    }
    renderEncoderChips();
    return S.encoders;
  }

  function renderEncoderChips() {
    var el = $('#encoderChips');
    if (!el) return;
    if (!S.encoders) { el.innerHTML = ''; return; }
    var interesting = ['libx264', 'prores_ks', 'dnxhd', 'mpeg2video', 'mpeg4', 'mjpeg',
      'dvvideo', 'libx265', 'libvpx-vp9'];
    el.innerHTML = interesting.map(function (enc) {
      var ok = S.encoders.has(enc);
      var why = ok ? 'available'
        : (UNUSABLE_ENCODERS[enc] || 'not in this FFmpeg build');
      return '<span class="chip ' + (ok ? 'ok' : 'bad') + '" title="' + esc(why) + '">' +
        esc(enc) + (ok ? ' ✓' : ' ✗') + '</span>';
    }).join('');
  }

  // ------------------------------------------------------------ source ui -- //
  function addFiles(fileList) {
    var added = 0;
    var recurse = $('#recurse').checked;
    Array.prototype.forEach.call(fileList, function (f) {
      var rel = f.webkitRelativePath || f.name;
      if (!C.isVideoName(f.name)) return;
      // "Include subfolders" off: keep only files sitting directly in the
      // picked folder (webkitRelativePath is "folder/file.mp4" for those).
      if (!recurse && rel.split('/').length > 2) return;
      var dup = S.items.some(function (it) {
        return it.label === rel && it.file.size === f.size && it.file.lastModified === f.lastModified;
      });
      if (dup) return;
      S.items.push({ id: S.nextId++, file: f, label: rel });
      added++;
    });
    renderSources();
    return added;
  }

  function renderSources() {
    var ul = $('#sourceList');
    ul.innerHTML = S.items.map(function (it) {
      return '<li data-id="' + it.id + '" class="' + (S.selected.has(it.id) ? 'sel' : '') + '">' +
        '<span>' + esc(it.label) + '</span></li>';
    }).join('');
    $('#dropHint').hidden = S.items.length > 0;
    $('#countLabel').textContent = S.items.length + ' video' + (S.items.length === 1 ? '' : 's');
    syncOutputExtension();
  }

  /**
   * Keep the output name's extension in step with the sources.
   *
   * The container is only settled once the sources have been probed, but a
   * save location picked before then cannot be renamed afterwards -- so the
   * extension has to be right up front, or a QuickTime file ends up called
   * .mp4. The source extensions predict it, so use them the moment files
   * arrive.
   */
  function syncOutputExtension() {
    var field = $('#outputName');
    if (!field) return;
    var ext = C.guessOutputContainer(S.items.map(function (it) { return it.label; }));
    if (!ext) return;
    var current = field.value.trim();
    if (C.extOf(current) !== ext) field.value = C.withExtension(current, ext);
    checkSaveTarget(ext);
  }

  /** Warn if an already-chosen save file has the wrong extension for these sources. */
  function checkSaveTarget(ext) {
    var note = $('#saveTargetNote');
    if (!note) return;
    if (!S.saveHandle) {
      if (!window.showSaveFilePicker) {
        note.textContent = 'This browser has no save-location picker, so the compilation will arrive ' +
          'as a normal download.';
      }
      return;
    }
    if (ext && C.extOf(S.saveHandle.name) !== ext) {
      note.textContent = 'The file you chose (' + S.saveHandle.name + ') does not end in ' + ext +
        ', which is what these sources will produce. Choose the location again, or the compilation ' +
        'will be offered as a download instead.';
      note.className = 'small warnline';
    } else {
      note.textContent = 'Will be written straight to: ' + S.saveHandle.name;
      note.className = 'dim small';
    }
  }

  function wireSources() {
    $('#btnAddFiles').addEventListener('click', function () { $('#filePicker').click(); });
    $('#btnAddFolder').addEventListener('click', function () { $('#folderPicker').click(); });

    $('#filePicker').addEventListener('change', function (e) {
      var n = addFiles(e.target.files);
      log('Added ' + n + ' file(s).');
      e.target.value = '';
    });
    $('#folderPicker').addEventListener('change', function (e) {
      var n = addFiles(e.target.files);
      if (!n) log('No video files were found in that folder.', 'warnline');
      else log('Added ' + n + ' file(s) from folder.');
      e.target.value = '';
    });

    $('#sourceList').addEventListener('click', function (e) {
      var li = e.target.closest('li');
      if (!li) return;
      var id = parseInt(li.dataset.id, 10);
      if (S.selected.has(id)) S.selected.delete(id); else S.selected.add(id);
      renderSources();
    });

    $('#btnRemove').addEventListener('click', function () {
      if (!S.selected.size) { log('Nothing selected -- click file rows to select them.', 'warnline'); return; }
      S.items = S.items.filter(function (it) { return !S.selected.has(it.id); });
      S.selected.clear();
      renderSources();
    });

    $('#btnClear').addEventListener('click', function () {
      S.items = [];
      S.selected.clear();
      renderSources();
    });

    var dz = $('#dropZone');
    ['dragenter', 'dragover'].forEach(function (ev) {
      dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.add('over'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.remove('over'); });
    });
    dz.addEventListener('drop', async function (e) {
      var items = e.dataTransfer && e.dataTransfer.items;
      var files = [];
      if (items && items.length && items[0].webkitGetAsEntry) {
        var entries = [];
        for (var i = 0; i < items.length; i++) {
          var entry = items[i].webkitGetAsEntry();
          if (entry) entries.push(entry);
        }
        for (var k = 0; k < entries.length; k++) {
          await walkEntry(entries[k], '', files, $('#recurse').checked);
        }
      } else if (e.dataTransfer) {
        files = Array.prototype.slice.call(e.dataTransfer.files);
      }
      var n = addFiles(files);
      log('Added ' + n + ' file(s) by drag and drop.');
    });
  }

  /** Walk a dropped directory entry, collecting video files. */
  function walkEntry(entry, prefix, out, recurse) {
    return new Promise(function (resolve) {
      if (entry.isFile) {
        entry.file(function (f) {
          if (prefix) {
            try {
              Object.defineProperty(f, 'webkitRelativePath', { value: prefix + f.name });
            } catch (e) { /* read-only in some browsers; the name alone will do */ }
          }
          out.push(f);
          resolve();
        }, resolve);
      } else if (entry.isDirectory) {
        if (prefix && !recurse) { resolve(); return; }
        var reader = entry.createReader();
        var all = [];
        var readBatch = function () {
          reader.readEntries(async function (batch) {
            if (!batch.length) {
              for (var i = 0; i < all.length; i++) {
                await walkEntry(all[i], prefix + entry.name + '/', out, recurse);
              }
              resolve();
              return;
            }
            all = all.concat(Array.prototype.slice.call(batch));
            readBatch();
          }, resolve);
        };
        readBatch();
      } else {
        resolve();
      }
    });
  }

  // -------------------------------------------------------------- logging -- //
  function log(text, cls) {
    var el = $('#log');
    if (!el) { if (window.console) console.log(text); return; }
    var line = document.createElement('div');
    if (cls) line.className = cls;
    line.textContent = text;
    el.appendChild(line);
    el.scrollTop = el.scrollHeight;
  }

  function clearLog() {
    var el = $('#log');
    if (el) el.textContent = '';
  }

  function setStage(text) {
    var el = $('#stage');
    if (el) el.textContent = text || '';
  }

  function setProgress(fraction) {
    var pct = Math.max(0, Math.min(100, Math.round(fraction * 100)));
    var bar = $('#progress');
    var label = $('#progressPct');
    if (bar) bar.value = pct;
    if (label) label.textContent = pct + '%';
  }

  // -------------------------------------------------------- format dialog -- //
  function openFormatDialog(sources) {
    return new Promise(function (resolve) {
      var dlg = $('#formatDialog');
      var resItems = C.distinctResolutions(sources);
      var fpsItems = C.distinctFps(sources);
      var codecItems = C.distinctCodecs(sources);
      var manual = {};            // index -> explicit include/exclude
      var state = {
        res: resItems[0].res,
        fps: fpsItems[0].key,
        codec: 0,
        scale: C.SCALE_MODES[0].value
      };

      $('#pickRes').innerHTML = resItems.map(function (r, i) {
        return '<label><input type="radio" name="pickRes" value="' + i + '"' + (i ? '' : ' checked') + '>' +
          '<span>' + r.res[0] + ' × ' + r.res[1] + ' <span class="dim">(' + r.count + ' file' +
          (r.count === 1 ? '' : 's') + ')</span></span></label>';
      }).join('');
      $('#pickFps').innerHTML = fpsItems.map(function (f, i) {
        return '<label><input type="radio" name="pickFps" value="' + i + '"' + (i ? '' : ' checked') + '>' +
          '<span>' + esc(f.display) + ' fps <span class="dim">(' + f.count + ' file' +
          (f.count === 1 ? '' : 's') + ')</span></span></label>';
      }).join('');
      $('#pickCodec').innerHTML = codecItems.map(function (c, i) {
        return '<label><input type="radio" name="pickCodec" value="' + i + '"' + (i ? '' : ' checked') + '>' +
          '<span>' + esc(C.describeCodecSig(c.sig)) + ' <span class="dim">(' + c.count + ' file' +
          (c.count === 1 ? '' : 's') + ')</span></span></label>';
      }).join('');
      $('#scaleMode').innerHTML = C.SCALE_MODES.map(function (m) {
        return '<option value="' + m.value + '">' + esc(m.label) + '</option>';
      }).join('');

      function target() {
        return C.buildTarget(state.res, state.fps,
          C.fpsFracForKey(sources, state.fps), codecItems[state.codec].rep, state.scale);
      }

      function included(i, tgt) {
        if (Object.prototype.hasOwnProperty.call(manual, i)) return manual[i];
        return C.mismatchReasons(sources[i], tgt).length === 0;
      }

      function refresh() {
        var tgt = target();
        var exact = 0, conformed = 0, excluded = 0;
        var rows = sources.map(function (s, i) {
          var reasons = C.mismatchReasons(s, tgt);
          var keep = included(i, tgt);
          var status, cls;
          if (!keep) { status = 'excluded'; cls = 'excluded'; excluded++; }
          else if (reasons.length) { status = 'conform: ' + reasons.join(', '); cls = 'conform'; conformed++; }
          else { status = 'match'; cls = ''; exact++; }
          return '<tr class="' + cls + '" data-i="' + i + '">' +
            '<td class="use">' + (keep ? '☑' : '☐') + '</td>' +
            '<td class="file">' + esc(s.label) + '</td>' +
            '<td>' + s.width + '×' + s.height + '</td>' +
            '<td>' + esc(C.formatFps(s.fps)) + '</td>' +
            '<td>' + esc(C.describeCodecSig(C.formatSig(s))) + '</td>' +
            '<td class="status">' + esc(status) + '</td></tr>';
        }).join('');
        $('#srcTable tbody').innerHTML = rows;

        $('#dlgSummary').textContent =
          'Render as ' + tgt.width + '×' + tgt.height + ' @ ' + C.formatFps(tgt.fps) + ' fps, ' +
          C.describeCodecSig(C.formatSig(tgt)) + '\n' +
          exact + ' exact match, ' + conformed + ' conformed, ' + excluded + ' excluded  --  ' +
          (exact + conformed) + ' of ' + sources.length + ' source(s) will be used.';
        $('#btnDlgOk').disabled = (exact + conformed) === 0;
      }

      function onPick(e) {
        var name = e.target.name;
        var v = parseInt(e.target.value, 10);
        if (name === 'pickRes') state.res = resItems[v].res;
        else if (name === 'pickFps') state.fps = fpsItems[v].key;
        else if (name === 'pickCodec') state.codec = v;
        refresh();
      }

      $('#pickRes').onchange = onPick;
      $('#pickFps').onchange = onPick;
      $('#pickCodec').onchange = onPick;
      $('#scaleMode').onchange = function (e) { state.scale = e.target.value; refresh(); };

      $('#srcTable').onclick = function (e) {
        var cell = e.target.closest('td.use');
        if (!cell) return;
        var i = parseInt(cell.parentNode.dataset.i, 10);
        manual[i] = !included(i, target());
        refresh();
      };

      $('#btnIncludeAll').onclick = function () {
        sources.forEach(function (_s, i) { manual[i] = true; });
        refresh();
      };
      $('#btnExcludeMismatch').onclick = function () {
        // Clearing the overrides restores the default rule, which is exactly
        // "keep it only if it matches" -- and it keeps following the pick.
        manual = {};
        refresh();
      };

      function finish(value) {
        $('#btnDlgOk').onclick = null;
        $('#btnDlgCancel').onclick = null;
        dlg.close();
        resolve(value);
      }

      $('#btnDlgOk').onclick = function () {
        var tgt = target();
        var kept = sources.filter(function (_s, i) { return included(i, tgt); });
        if (!kept.length) return;
        finish({ target: tgt, kept: kept });
      };
      $('#btnDlgCancel').onclick = function () { finish(null); };
      dlg.addEventListener('cancel', function (e) { e.preventDefault(); finish(null); }, { once: true });

      refresh();
      dlg.showModal();
    });
  }

  // --------------------------------------------------------------- params -- //
  function gatherParams() {
    if (!S.items.length) throw new Error('Add at least one source video.');

    var minLen = parseFloat($('#minLen').value);
    var maxLen = parseFloat($('#maxLen').value);
    if (!isFinite(minLen) || !isFinite(maxLen)) throw new Error('Clip lengths must be numbers.');
    if (minLen <= 0 || maxLen <= 0) throw new Error('Clip lengths must be greater than 0.');
    if (minLen > maxLen) throw new Error('Min clip length cannot exceed max clip length.');

    var mode = $('#modeCount').checked ? 'count' : 'duration';
    var clipCount = 0, totalDuration = 0;
    if (mode === 'count') {
      clipCount = parseInt($('#clipCount').value, 10);
      if (!isFinite(clipCount) || clipCount < 1) throw new Error('Number of clips must be at least 1.');
    } else {
      totalDuration = parseFloat($('#totalDuration').value);
      if (!isFinite(totalDuration) || totalDuration <= 0) throw new Error('Total duration must be greater than 0.');
    }

    var workers = parseInt($('#workers').value, 10);
    if (!isFinite(workers) || workers < 1) throw new Error('Parallel encodes must be at least 1.');

    var output = $('#outputName').value.trim();
    if (!output) throw new Error('Choose an output file name.');

    return {
      mode: mode,
      clip_count: clipCount,
      total_duration: totalDuration,
      min_len: minLen,
      max_len: maxLen,
      shuffle: $('#shuffle').checked,
      seed: $('#seed').value.trim() || null,
      workers: workers,
      output: output
    };
  }

  // -------------------------------------------------------------- probing -- //
  function mountName(item) {
    return 'src_' + String(item.id).padStart(4, '0') + (C.extOf(item.label) || '.mp4');
  }

  async function mountSources(eng, items) {
    var files = items.map(function (it) {
      // Renaming keeps mount paths unique and ASCII-safe. Constructing a File
      // from another File references the same bytes -- it does not copy them.
      return new File([it.file], mountName(it), { type: it.file.type });
    });
    try { await eng.ff.createDir('/in'); } catch (e) { /* may already exist */ }
    await eng.ff.mount('WORKERFS', { files: files }, '/in');
  }

  async function probeAll(eng, items) {
    var good = [];
    for (var i = 0; i < items.length; i++) {
      if (S.abort) throw cancelled();
      var it = items[i];
      var path = '/in/' + mountName(it);
      eng.collect = [];
      try {
        // No ffprobe in the WebAssembly build, so read the format banner that
        // `ffmpeg -i` prints and parse that instead. -t 0 makes it a no-op run.
        await eng.ff.exec(['-hide_banner', '-i', path, '-t', '0', '-f', 'null', '-']);
      } catch (e) { /* exit code is irrelevant; the banner is what we want */ }
      var info = C.parseProbeLog(eng.collect, path);
      eng.collect = null;
      if (info) {
        info.label = it.label;
        info.item = it;
        good.push(info);
      } else {
        log('  skipped (unreadable): ' + it.label, 'warnline');
      }
      setProgress(0.02 + 0.08 * ((i + 1) / items.length));
      setStage('Probing source videos… ' + (i + 1) + ' / ' + items.length);
    }
    return good;
  }

  // --------------------------------------------------------------- render -- //
  function cancelled() {
    var e = new Error('Cancelled.');
    e.cancelled = true;
    return e;
  }

  function pad5(n) { return String(n).padStart(5, '0'); }

  async function run() {
    var opts;
    try {
      opts = gatherParams();
    } catch (e) {
      log('ERROR: ' + e.message, 'err');
      window.alert(e.message);
      return;
    }

    setRunning(true);
    clearLog();
    $('#result').hidden = true;
    S.abort = false;
    setProgress(0);

    try {
      await renderPipeline(opts);
    } catch (e) {
      if (e && e.cancelled) {
        log('Cancelled.', 'warnline');
        setStage('Cancelled.');
      } else {
        log('ERROR: ' + (e && e.message ? e.message : String(e)), 'err');
        setStage('Failed.');
        window.alert(e && e.message ? e.message : String(e));
      }
    } finally {
      killPool();
      setRunning(false);
    }
  }

  async function renderPipeline(opts) {
    // -- engine ----------------------------------------------------------- //
    setStage('Starting the local FFmpeg engine…');
    log('Starting FFmpeg (WebAssembly, running on this machine).');
    var lead = await createEngine('e0');
    S.pool = [lead];
    setProgress(0.02);
    await probeEncoders(lead);
    if (S.encoders) log('This FFmpeg build offers ' + S.encoders.size + ' video encoder(s).');
    setEngineStatus('FFmpeg engine ready', 'ok');

    // -- probe ------------------------------------------------------------ //
    log('Probing source videos…');
    await mountSources(lead, S.items);
    var good = await probeAll(lead, S.items);
    if (S.abort) throw cancelled();
    if (!good.length) throw new Error('None of the sources could be read as video.');

    var resItems = C.distinctResolutions(good);
    var fpsItems = C.distinctFps(good);
    var codecItems = C.distinctCodecs(good);
    log(good.length + ' readable source(s). Resolutions found: ' + resItems.length +
      '; frame rates found: ' + fpsItems.length +
      '; codec/container combinations found: ' + codecItems.length + '.');

    // -- target format ----------------------------------------------------- //
    var target, kept;
    if (resItems.length > 1 || fpsItems.length > 1 || codecItems.length > 1) {
      log('Mixed formats detected:');
      resItems.forEach(function (r) { log('   resolution ' + r.res[0] + 'x' + r.res[1] + ': ' + r.count + ' file(s)'); });
      fpsItems.forEach(function (f) { log('   frame rate ' + f.display + ' fps: ' + f.count + ' file(s)'); });
      codecItems.forEach(function (c) { log('   ' + C.describeCodecSig(c.sig) + ': ' + c.count + ' file(s)'); });

      setStage('Waiting for your format choice…');
      var picked = await openFormatDialog(good);
      if (!picked) { log('Cancelled (no format chosen).'); throw cancelled(); }
      target = picked.target;
      kept = picked.kept;
    } else {
      var rep = good[0];
      target = C.buildTarget([rep.width, rep.height], rep.fps_key, rep.fps_frac, rep, 'fit');
      kept = good.slice();
    }
    if (!kept.length) throw new Error('Nothing left to compile after filtering.');

    var keptSet = new Set(kept.map(function (s) { return s.path; }));
    var excluded = good.filter(function (s) { return !keptSet.has(s.path); });

    log('Rendering as ' + target.width + 'x' + target.height + ' @ ' + C.formatFps(target.fps) +
      " fps, codec '" + target.codec + "'" +
      (target.profile ? " profile '" + target.profile + "'" : '') +
      ", field order '" + target.field_order + "', container '" + target.ext + "'.");

    // -- per-source conform filters ---------------------------------------- //
    var conformed = 0;
    kept.forEach(function (s) {
      var filters = C.buildConformFilters(s, target);
      s.vf = filters.length ? filters.join(',') : null;
      if (filters.length) {
        conformed++;
        log('   conforming (' + C.mismatchReasons(s, target).join(', ') + '): ' + s.label +
          ' [' + s.width + 'x' + s.height + ' @ ' + C.formatFps(s.fps) + ', ' +
          C.describeCodecSig(C.formatSig(s)) + ']');
      }
    });
    log('Included: ' + kept.length + ' file(s) -- ' + (kept.length - conformed) + ' exact, ' +
      conformed + ' conformed. Excluded: ' + excluded.length + ' file(s).');
    excluded.forEach(function (s) {
      var why = C.mismatchReasons(s, target).join(', ') || 'user choice';
      log('   excluded (' + why + '): ' + s.label + ' [' + s.width + 'x' + s.height + ' @ ' +
        C.formatFps(s.fps) + ', ' + C.describeCodecSig(C.formatSig(s)) + ']');
    });

    // -- encoder ------------------------------------------------------------ //
    var enc = C.buildVideoEncodeArgs(target, S.encoders);
    if (enc.fallback) {
      var why = UNUSABLE_ENCODERS[enc.wanted] ||
        ("this FFmpeg build has no '" + enc.wanted + "' encoder");
      log("Cannot re-encode as " + target.codec + ' -- ' + why + ". Clips will be encoded with '" +
        enc.encoder + "' instead, so the output will NOT match the source codec.", 'err');
    }
    var ext = enc.container;
    if (ext !== target.ext) {
      log("Container changed from '" + target.ext + "' to '" + ext + "' -- " +
        enc.encoder + " cannot be written into '" + target.ext + "'.", 'warnline');
    }

    var outName = C.sanitizeName($('#outputName').value.replace(/\.[^.]*$/, '')) + ext;
    $('#outputName').value = outName;

    // A save location picked earlier is a file with a fixed name, and there is
    // no way to rename it once the container turns out to be something else.
    // Writing anyway would put a QuickTime file on disk called .mp4, so drop
    // the handle and hand the result over as a correctly named download.
    if (S.saveHandle && C.extOf(S.saveHandle.name) !== ext) {
      log('The save location you chose is "' + S.saveHandle.name + '", but this compilation is ' +
        ext + '. A file cannot be renamed after it has been picked, so it will be offered as a ' +
        'download called ' + outName + ' instead.', 'warnline');
      S.saveHandle = null;
      var note = $('#saveTargetNote');
      if (note) {
        note.textContent = 'Save location cleared -- it did not end in ' + ext + '.';
        note.className = 'small warnline';
      }
    }
    log("Re-encoding with '" + enc.name + "'" + (target.profile ? ' (' + target.profile + ')' : '') +
      ", pix_fmt '" + target.pix_fmt + "', " +
      (enc.interlaced ? 'interlaced (' + target.field_order + ').' : 'progressive.'));

    var runOpts = {
      encode_args: enc.args,
      fps_frac: target.fps_frac,
      min_len: opts.min_len,
      max_len: opts.max_len,
      mode: opts.mode,
      clip_count: opts.clip_count,
      total_duration: opts.total_duration,
      shuffle: opts.shuffle
    };

    // -- plan --------------------------------------------------------------- //
    log('Planning random clips…');
    var rng = C.makeRng(opts.seed);
    var clips = C.planClips(kept, runOpts, rng);
    var totalLen = clips.reduce(function (a, c) { return a + c.length; }, 0);
    var poolSize = Math.max(1, Math.min(opts.workers, clips.length));
    log('Planned ' + clips.length + ' clip(s), ' + C.formatDuration(totalLen) + ' total. Re-encoding to \'' +
      enc.encoder + '\' on ' + poolSize + ' parallel worker(s), audio removed.');
    if (opts.seed) log('Seed "' + opts.seed + '" -- this exact compilation is reproducible in this browser.');

    // -- pool --------------------------------------------------------------- //
    if (poolSize > 1) {
      setStage('Starting ' + poolSize + ' encoders…');
      for (var w = 1; w < poolSize; w++) {
        if (S.abort) throw cancelled();
        var extra = await createEngine('e' + w);
        S.pool.push(extra);          // tracked before mounting, so a failure
        await mountSources(extra, S.items);   // here still gets it torn down
      }
    }

    // -- encode -------------------------------------------------------------- //
    var fpsValue = C.parseFraction(target.fps_frac) || target.fps || 25;
    var totalSteps = clips.length + 1;
    var doneCount = 0;
    var active = {};
    var results = new Array(clips.length);
    var firstError = null;
    var nextIndex = 0;

    function bump() {
      var partial = 0;
      Object.keys(active).forEach(function (k) { partial += active[k]; });
      setProgress(0.1 + 0.85 * ((doneCount + partial) / totalSteps));
    }

    setStage('Encoding clips… this runs locally, so long compilations take a while.');

    async function workerLoop(eng) {
      for (;;) {
        if (S.abort || firstError) return;
        var i = nextIndex++;
        if (i >= clips.length) return;

        var clip = clips[i];
        var out = 'clip_' + pad5(i + 1) + ext;
        var expected = Math.max(1, Math.round(clip.length * fpsValue));
        active[eng.tag] = 0;
        eng.onFrame = function (n) {
          active[eng.tag] = Math.min(1, n / expected);
          bump();
        };
        eng.tail = [];

        var rc;
        try {
          rc = await eng.ff.exec(C.buildClipArgs(clip, runOpts, out));
        } catch (e) {
          eng.onFrame = null;
          delete active[eng.tag];
          if (S.abort) return;
          firstError = new Error('FFmpeg died on clip ' + (i + 1) + ': ' + (e && e.message ? e.message : e));
          return;
        }
        eng.onFrame = null;
        delete active[eng.tag];
        if (S.abort) return;

        if (rc !== 0) {
          var tail = eng.tail.filter(function (l) { return l && l.trim(); }).slice(-6).join('\n');
          firstError = new Error('ffmpeg failed on clip ' + (i + 1) + ' (exit ' + rc + '):\n' + tail);
          return;
        }

        results[i] = { eng: eng, name: out };
        doneCount++;
        log('  encoded ' + doneCount + '/' + clips.length);
        bump();
      }
    }

    await Promise.all(S.pool.slice(0, poolSize).map(workerLoop));
    if (firstError) throw firstError;
    if (S.abort) throw cancelled();

    var produced = results.filter(Boolean);
    if (!produced.length) throw new Error('No clips were produced.');

    // -- concat ------------------------------------------------------------- //
    setStage('Concatenating clips into the final compilation…');
    log('Concatenating clips into the final compilation…');

    var names = [];
    for (var c = 0; c < results.length; c++) {
      var r = results[c];
      if (!r) continue;
      if (r.eng !== lead) {
        // Move the clip into the engine doing the concat, freeing it from the
        // worker that made it so only one copy is ever in memory.
        var data = await r.eng.ff.readFile(r.name);
        await lead.ff.writeFile(r.name, data);
        try { await r.eng.ff.deleteFile(r.name); } catch (e) { /* fine */ }
      }
      names.push('/' + r.name);
    }

    await lead.ff.writeFile('concat_list.txt', new TextEncoder().encode(C.buildConcatList(names)));
    var finalName = 'out' + ext;
    lead.tail = [];
    var crc = await lead.ff.exec(C.buildConcatArgs('/concat_list.txt', finalName));
    if (crc !== 0) {
      var ctail = lead.tail.filter(function (l) { return l && l.trim(); }).slice(-6).join('\n');
      throw new Error('Concatenation failed (exit ' + crc + '):\n' + ctail);
    }
    setProgress(0.97);

    // -- save ---------------------------------------------------------------- //
    setStage('Writing the file…');
    var outData = await lead.ff.readFile(finalName);
    var blob = new Blob([outData], { type: 'video/' + ext.slice(1) });
    log('Compilation is ' + C.formatBytes(blob.size) + '.');
    await saveOutput(blob, outName);
    setProgress(1);
    setStage('Done.');
  }

  async function saveOutput(blob, name) {
    if (S.saveHandle) {
      try {
        var writable = await S.saveHandle.createWritable();
        await writable.write(blob);
        await writable.close();
        log('Done! Saved to ' + S.saveHandle.name);
        showResult(blob, name, S.saveHandle.name);
        return;
      } catch (e) {
        log('Could not write to the chosen file (' + e.message + ') -- offering a download instead.', 'warnline');
      }
    }
    log('Done! Use the download link below to save it.');
    showResult(blob, name, null);
  }

  /** Extension list for the save picker, most likely container first. */
  function saveExtensions(want) {
    var all = ['.mp4', '.mov', '.mkv', '.avi', '.webm', '.ts', '.m4v', '.mxf', '.mpg', '.dv'];
    if (!want) return all;
    return [want].concat(all.filter(function (e) { return e !== want; }));
  }

  function showResult(blob, name, savedAs) {
    if (S.lastObjectURL) URL.revokeObjectURL(S.lastObjectURL);
    S.lastObjectURL = URL.createObjectURL(blob);
    var box = $('#result');
    box.hidden = false;
    var canPick = !!window.showSaveFilePicker;
    box.innerHTML =
      (savedAs ? '<strong>Saved to ' + esc(savedAs) + '</strong> — ' : '<strong>Compilation ready</strong> — ') +
      '<a id="dl" download="' + esc(name) + '">download ' + esc(name) + '</a> (' + C.formatBytes(blob.size) + ')' +
      (!savedAs && canPick ? ' <button type="button" id="btnSaveAs">Save somewhere else…</button>' : '') +
      '<video controls playsinline></video>';
    box.querySelector('#dl').href = S.lastObjectURL;
    box.querySelector('video').src = S.lastObjectURL;

    // Picking a location now works even when it could not before the render,
    // because this click is a fresh user gesture and the name is already final.
    var saveAs = box.querySelector('#btnSaveAs');
    if (saveAs) {
      saveAs.addEventListener('click', async function () {
        try {
          var handle = await window.showSaveFilePicker({
            suggestedName: name,
            types: [{ description: 'Video', accept: { 'video/*': saveExtensions(C.extOf(name)) } }]
          });
          var writable = await handle.createWritable();
          await writable.write(blob);
          await writable.close();
          log('Saved to ' + handle.name);
          saveAs.textContent = 'Saved to ' + handle.name;
          saveAs.disabled = true;
        } catch (e) {
          if (e && e.name !== 'AbortError') log('Could not save: ' + e.message, 'err');
        }
      });
    }
    if (!savedAs) box.querySelector('#dl').click();
  }

  // ------------------------------------------------------------------ ui -- //
  function setRunning(running) {
    S.running = running;
    $('#btnRun').disabled = running;
    $('#btnCancel').disabled = !running;
    $('#btnInstall').disabled = running;
  }

  function syncMode() {
    var byCount = $('#modeCount').checked;
    $('#clipCount').disabled = !byCount;
    $('#totalDuration').disabled = byCount;
  }

  function wireControls() {
    $('#modeCount').addEventListener('change', syncMode);
    $('#modeDuration').addEventListener('change', syncMode);

    $('#btnRun').addEventListener('click', run);

    $('#btnCancel').addEventListener('click', function () {
      S.abort = true;
      log('Cancelling…', 'warnline');
      setStage('Cancelling…');
      killPool();
    });

    $('#btnInstall').addEventListener('click', async function () {
      $('#btnInstall').disabled = true;
      try {
        var already = await installedBytes();
        await installEngine(!!already);
        setStage('Verifying the engine…');
        var eng = await createEngine('probe');
        await probeEncoders(eng);
        killEngine(eng);
        setStage('');
        log('FFmpeg is installed on this machine and ready. It will not be downloaded again.');
        await refreshEngineChip();
      } catch (e) {
        log('Install failed: ' + e.message, 'err');
      } finally {
        $('#btnInstall').disabled = S.running;
      }
    });

    $('#btnUninstall').addEventListener('click', async function () {
      if (cachesAvailable()) await caches.delete(CACHE_NAME);
      S.coreURL = null;
      S.wasmURL = null;
      S.encoders = null;
      renderEncoderChips();
      log('Removed the locally installed FFmpeg engine.');
      await refreshEngineChip();
    });

    $('#btnChooseOut').addEventListener('click', async function () {
      if (!window.showSaveFilePicker) {
        window.alert('This browser cannot pick a save location up front. ' +
          'The finished compilation will be offered as a normal download instead.');
        return;
      }
      try {
        var want = C.guessOutputContainer(S.items.map(function (it) { return it.label; }));
        S.saveHandle = await window.showSaveFilePicker({
          suggestedName: $('#outputName').value.trim() || 'random_compilation.mp4',
          // The likely container goes first so the picker offers that extension
          // rather than silently appending .mp4 to a QuickTime file.
          types: [{ description: 'Video', accept: { 'video/*': saveExtensions(want) } }]
        });
        $('#outputName').value = S.saveHandle.name;
        checkSaveTarget(want);
      } catch (e) { /* user dismissed the picker */ }
    });
  }

  // ---------------------------------------------------------------- init -- //
  function init() {
    var cores = navigator.hardwareConcurrency || 4;
    $('#workers').value = String(Math.max(1, Math.min(4, Math.floor(cores / 2))));
    $('#workersNote').textContent =
      'Each parallel encode is a separate FFmpeg instance (this machine reports ' + cores +
      ' logical core(s)), so more of them means more memory as well as more speed.';

    wireSources();
    wireControls();
    syncMode();
    renderSources();
    refreshEngineChip();

    if (location.protocol === 'file:') {
      log('This page is open from the file system. FFmpeg needs http:// or https:// -- ' +
        'serve the folder (for example: python -m http.server) or use the GitHub Pages URL.', 'err');
    }
    if (!window.showSaveFilePicker) {
      $('#saveTargetNote').textContent =
        'This browser has no save-location picker, so the compilation will arrive as a normal download.';
    }
  }

  // The engine plumbing is exported so test_pipeline.html can drive a real
  // encode without going through the UI. The UI itself only wires up when its
  // markup is present, which lets that page load this file as-is.
  window.RCMApp = {
    state: S,
    addFiles: addFiles,
    renderSources: renderSources,
    syncOutputExtension: syncOutputExtension,
    installEngine: installEngine,
    installedBytes: installedBytes,
    createEngine: createEngine,
    killEngine: killEngine,
    probeEncoders: probeEncoders,
    mountSources: mountSources,
    mountName: mountName,
    probeAll: probeAll,
    CACHE_NAME: CACHE_NAME
  };

  function boot() {
    if (document.getElementById('btnRun')) init();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
}());
