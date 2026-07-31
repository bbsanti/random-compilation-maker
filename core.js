/*
 * core.js -- pure logic for Random Compilation Maker (web edition).
 *
 * This is a direct port of the format-analysis, conforming and clip-planning
 * functions from random_compilation_maker.py. Nothing in here touches the DOM
 * or FFmpeg, so it can be unit-tested on its own (see test_core.html).
 *
 * The one real departure from the Python original: there is no ffprobe in the
 * WebAssembly FFmpeg build, so probe data is parsed out of `ffmpeg -i` log
 * output instead of ffprobe JSON. parseProbeLog() does that job.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.RCM = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ------------------------------------------------------------------------ //
  // Constants
  // ------------------------------------------------------------------------ //

  var VIDEO_EXTS = [
    '.mp4', '.mov', '.mkv', '.avi', '.m4v', '.wmv', '.flv', '.webm',
    '.mpg', '.mpeg', '.ts', '.mts', '.m2ts', '.mxf', '.vob', '.3gp'
  ];

  var INTERLACED_ORDERS = ['tt', 'tb', 'bt', 'bb'];

  var SCALE_MODES = [
    { value: 'fit', label: 'Fit -- letterbox / pillarbox (no distortion)' },
    { value: 'stretch', label: 'Stretch to fill (ignores aspect ratio)' },
    { value: 'crop', label: 'Crop to fill (fills the frame, trims edges)' }
  ];

  function extOf(name) {
    var s = String(name || '');
    var i = s.lastIndexOf('.');
    return i < 0 ? '' : s.slice(i).toLowerCase();
  }

  function baseName(p) {
    var parts = String(p || '').split(/[\\/]/);
    return parts[parts.length - 1];
  }

  function isVideoName(name) {
    return VIDEO_EXTS.indexOf(extOf(name)) >= 0;
  }

  /**
   * The container the output will most likely end up in, worked out from the
   * source file names alone.
   *
   * The real answer only arrives after probing, because it comes from the
   * codec group the user renders as -- but that group's container is one of
   * these extensions, so the commonest one is right nearly every time. It
   * exists so the save-location picker can offer the correct extension BEFORE
   * the render starts: a handle picked as .mp4 cannot be renamed to .mov
   * afterwards, and would leave a QuickTime file wearing an .mp4 name.
   *
   * Returns null when there is nothing to go on.
   */
  function guessOutputContainer(names) {
    var counts = {};
    (names || []).forEach(function (n) {
      var ext = extOf(n);
      if (VIDEO_EXTS.indexOf(ext) < 0) return;
      counts[ext] = (counts[ext] || 0) + 1;
    });
    var keys = Object.keys(counts);
    if (!keys.length) return null;
    keys.sort(function (a, b) {
      return (counts[b] - counts[a]) || (a < b ? -1 : 1);
    });
    return keys[0];
  }

  /** Swap a file name's extension, keeping the stem. */
  function withExtension(name, ext) {
    var stem = String(name || '').replace(/\.[^.\\/]*$/, '');
    return (stem || 'random_compilation') + ext;
  }

  // ------------------------------------------------------------------------ //
  // Frame-rate helpers
  // ------------------------------------------------------------------------ //

  function parseFraction(text) {
    if (!text || text === '0/0' || text === 'N/A') return null;
    var s = String(text);
    if (s.indexOf('/') >= 0) {
      var bits = s.split('/');
      var num = parseFloat(bits[0]);
      var den = parseFloat(bits[1]);
      if (!isFinite(num) || !isFinite(den) || den === 0) return null;
      return num / den;
    }
    var v = parseFloat(s);
    return isFinite(v) ? v : null;
  }

  /** Round an fps to a stable key so 29.97 != 30 but 29.970 == 29.97. */
  function fpsKey(fps) {
    return Math.round(Number(fps) * 100) / 100;
  }

  /** Human-friendly fps: integers stay integers, else 2 decimals. */
  function formatFps(fps) {
    var f = Number(fps);
    if (Math.abs(f - Math.round(f)) < 0.01) return String(Math.round(f));
    return f.toFixed(2);
  }

  // ffprobe hands the Python version an exact fraction like '30000/1001'.
  // Parsing `ffmpeg -i` only gives us the banner's two-decimal rounding, so
  // recognised rates get snapped back onto their exact fractions: feeding
  // ffmpeg '29.97' instead of '30000/1001' would drift over a long
  // compilation, and a file printed as '29.99' has to land on 30 rather than
  // being treated as its own frame rate.
  var STANDARD_FPS = [
    [12000 / 1001, '12000/1001'], [12, '12/1'],
    [15, '15/1'],
    [24000 / 1001, '24000/1001'], [24, '24/1'],
    [25, '25/1'],
    [30000 / 1001, '30000/1001'], [30, '30/1'],
    [48000 / 1001, '48000/1001'], [48, '48/1'],
    [50, '50/1'],
    [60000 / 1001, '60000/1001'], [60, '60/1'],
    [100, '100/1'],
    [120000 / 1001, '120000/1001'], [120, '120/1']
  ];

  /**
   * Nearest standard frame rate within `tol`, or null. Nearest rather than
   * first-within-tolerance: 29.99 is 0.01 off 30 and 0.02 off 29.97, and
   * picking the wrong one would retime every clip.
   */
  function snapFps(fps, tol) {
    var f = Number(fps);
    if (!isFinite(f) || f <= 0) return null;
    var best = null, bestDiff = Infinity;
    for (var i = 0; i < STANDARD_FPS.length; i++) {
      var diff = Math.abs(f - STANDARD_FPS[i][0]);
      if (diff < bestDiff) { bestDiff = diff; best = STANDARD_FPS[i]; }
    }
    if (best && bestDiff <= tol) return { value: best[0], frac: best[1] };
    return null;
  }

  function fpsFraction(fps) {
    var f = Number(fps);
    if (!isFinite(f) || f <= 0) return null;
    var snapped = snapFps(f, 0.02);
    if (snapped) return snapped.frac;
    if (Math.abs(f - Math.round(f)) < 0.001) return String(Math.round(f)) + '/1';
    return String(Math.round(f * 1000)) + '/1000';
  }

  /** '30000/1001' -> '60000/1001'. Used when re-interlacing. */
  function doubleFraction(frac) {
    var text = frac ? String(frac) : '';
    if (text.indexOf('/') >= 0) {
      var bits = text.split('/');
      var num = parseInt(bits[0], 10);
      var den = parseInt(bits[1], 10);
      if (isFinite(num) && isFinite(den)) return (num * 2) + '/' + den;
    }
    var val = parseFraction(text);
    return val ? (val * 2).toFixed(6) : text;
  }

  // ------------------------------------------------------------------------ //
  // Probe-log parsing (stands in for ffprobe)
  // ------------------------------------------------------------------------ //

  /** Split on `sep`, ignoring separators nested inside (...) or [...]. */
  function splitTopLevel(text, sep) {
    var out = [];
    var depth = 0;
    var cur = '';
    for (var i = 0; i < text.length; i++) {
      var ch = text.charAt(i);
      if (ch === '(' || ch === '[') depth++;
      else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
      if (ch === sep && depth === 0) {
        out.push(cur.trim());
        cur = '';
      } else {
        cur += ch;
      }
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  }

  // ffmpeg prints the field order as words; ffprobe reports the codes the rest
  // of this file speaks. The "(swapped)" spellings have to be tested first
  // because they also contain the short forms.
  var FIELD_ORDER_WORDS = [
    ['top coded first (swapped)', 'tb'],
    ['bottom coded first (swapped)', 'bt'],
    ['top first', 'tt'],
    ['bottom first', 'bb'],
    ['progressive', 'progressive']
  ];

  /**
   * Turn the stderr of `ffmpeg -i <file>` into the same shape of dict that
   * probe_video() returns in the Python version. Returns null if the input
   * has no readable video stream.
   */
  function parseProbeLog(log, name) {
    var text = Array.isArray(log) ? log.join('\n') : String(log || '');

    var duration = null;
    var durM = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(text);
    if (durM) {
      duration = parseInt(durM[1], 10) * 3600 +
                 parseInt(durM[2], 10) * 60 +
                 parseFloat(durM[3]);
    }
    if (duration === null || !(duration > 0)) return null;

    var containerBitRate = null;
    var cbrM = /Duration:[^\n]*?bitrate:\s*(\d+)\s*kb\/s/.exec(text);
    if (cbrM) containerBitRate = String(parseInt(cbrM[1], 10) * 1000);

    var vM = /Stream\s+#\d+:\d+[^\n]*?:\s*Video:\s*([^\n]+)/.exec(text);
    if (!vM) return null;
    var rest = vM[1];
    var fields = splitTopLevel(rest, ',');
    var head = fields[0] || '';

    var codecM = /^([A-Za-z0-9_]+)/.exec(head);
    var codec = codecM ? codecM[1] : 'unknown';

    // Profile is the first parenthesised group that isn't the fourcc tag.
    var profile = null;
    var parens = head.match(/\(([^()]*)\)/g) || [];
    for (var p = 0; p < parens.length; p++) {
      var inner = parens[p].slice(1, -1).trim();
      if (!inner) continue;
      if (/\/\s*0x[0-9a-fA-F]+/.test(inner)) continue;   // e.g. 'avc1 / 0x31637661'
      profile = inner;
      break;
    }

    var width = null, height = null, fps = null, bitRate = null, pixFmt = null;
    for (var i = 1; i < fields.length; i++) {
      var f = fields[i];
      var m;
      if (width === null && (m = /^(\d{2,5})x(\d{2,5})\b/.exec(f))) {
        width = parseInt(m[1], 10);
        height = parseInt(m[2], 10);
        continue;
      }
      if (fps === null && (m = /^([\d.]+)\s*fps\b/.exec(f))) {
        fps = parseFloat(m[1]);
        continue;
      }
      if (bitRate === null && (m = /^(\d+)\s*kb\/s\b/.exec(f))) {
        bitRate = String(parseInt(m[1], 10) * 1000);
        continue;
      }
      if (pixFmt === null && (m = /^([a-z][a-z0-9]*)(?:\(|$)/.exec(f))) {
        pixFmt = m[1];
        continue;
      }
    }

    if (fps === null) {                       // some inputs only report tbr
      var tbrM = /,\s*([\d.]+)\s*tbr\b/.exec(rest);
      if (tbrM) fps = parseFloat(tbrM[1]);
    }
    if (width === null || height === null || !(fps > 0)) return null;
    if (bitRate === null) bitRate = containerBitRate;

    // The banner rounds to two decimals, so a file that is really 29.995 fps
    // prints as "29.99". Pull it back onto the standard rate it plainly is,
    // otherwise near-identical sources look like mixed frame rates.
    var snapped = snapFps(fps, 0.012);
    var frac = snapped ? snapped.frac : fpsFraction(fps);
    if (snapped) fps = snapped.value;

    var fieldOrder = 'unknown';
    var lower = rest.toLowerCase();
    for (var w = 0; w < FIELD_ORDER_WORDS.length; w++) {
      if (lower.indexOf(FIELD_ORDER_WORDS[w][0]) >= 0) {
        fieldOrder = FIELD_ORDER_WORDS[w][1];
        break;
      }
    }

    return {
      path: name,
      duration: duration,
      width: width,
      height: height,
      fps: fps,
      fps_key: fpsKey(fps),
      fps_frac: frac,
      codec: codec,
      field_order: fieldOrder,
      pix_fmt: pixFmt,
      profile: profile,
      bit_rate: bitRate,
      ext: extOf(name) || '.mp4'
    };
  }

  // ------------------------------------------------------------------------ //
  // Format grouping / filtering
  // ------------------------------------------------------------------------ //

  /** Ordered list of {res: [w, h], count}, most common first. */
  function distinctResolutions(sources) {
    var counts = {};
    sources.forEach(function (s) {
      var key = s.width + 'x' + s.height;
      counts[key] = (counts[key] || 0) + 1;
    });
    return Object.keys(counts).map(function (key) {
      var wh = key.split('x');
      return { res: [parseInt(wh[0], 10), parseInt(wh[1], 10)], count: counts[key] };
    }).sort(function (a, b) {
      return (b.count - a.count) || (a.res[0] - b.res[0]) || (a.res[1] - b.res[1]);
    });
  }

  /** Ordered list of {key, count, display}, most common first. */
  function distinctFps(sources) {
    var counts = {};
    var display = {};
    sources.forEach(function (s) {
      var k = s.fps_key;
      counts[k] = (counts[k] || 0) + 1;
      display[k] = formatFps(s.fps);
    });
    return Object.keys(counts).map(function (k) {
      return { key: parseFloat(k), count: counts[k], display: display[k] };
    }).sort(function (a, b) {
      return (b.count - a.count) || (a.key - b.key);
    });
  }

  function isInterlaced(info) {
    var fo = String(info.field_order || 'progressive').toLowerCase();
    return INTERLACED_ORDERS.indexOf(fo) >= 0;
  }

  function isTff(info) {
    var fo = String(info.field_order || '').toLowerCase();
    return fo === 'tt' || fo === 'tb';
  }

  /** Codec-side signature: what the encoder has to be told to produce. */
  function formatSig(s) {
    return [s.codec || 'unknown', s.ext, s.field_order || '', s.profile || ''];
  }

  function sigKey(sig) {
    return sig.join(' ');
  }

  /**
   * Ordered list of {sig, count, rep} for every distinct codec / container /
   * field order / profile combination, most common first.
   */
  function distinctCodecs(sources) {
    var groups = {};
    var order = [];
    sources.forEach(function (s) {
      var k = sigKey(formatSig(s));
      if (!groups[k]) {
        groups[k] = [];
        order.push(k);
      }
      groups[k].push(s);
    });
    return order.map(function (k) {
      return { sig: formatSig(groups[k][0]), count: groups[k].length, rep: groups[k][0] };
    }).sort(function (a, b) {
      return (b.count - a.count) || (sigKey(a.sig) < sigKey(b.sig) ? -1 : 1);
    });
  }

  /** Human label for a signature, e.g. 'h264  High  .mp4  interlaced'. */
  function describeCodecSig(sig) {
    var codec = sig[0], ext = sig[1], field = sig[2], profile = sig[3];
    var bits = [codec || 'unknown'];
    if (profile) bits.push(profile);
    bits.push(ext);
    bits.push(INTERLACED_ORDERS.indexOf(String(field || '').toLowerCase()) >= 0
      ? 'interlaced' : 'progressive');
    return bits.join('  ');
  }

  /** The exact fraction string that goes with a rounded fps key. */
  function fpsFracForKey(sources, fpsk) {
    for (var i = 0; i < sources.length; i++) {
      if (sources[i].fps_key === fpsk) return sources[i].fps_frac;
    }
    return fpsFraction(fpsk);
  }

  /** Assemble the one format everything gets rendered as. */
  function buildTarget(resolution, fpsk, fpsFrac, codecRep, scaleMode) {
    return {
      width: resolution[0],
      height: resolution[1],
      fps: fpsk,
      fps_key: fpsk,
      fps_frac: fpsFrac,
      codec: codecRep.codec,
      ext: codecRep.ext,
      field_order: codecRep.field_order,
      profile: codecRep.profile,
      pix_fmt: codecRep.pix_fmt,
      bit_rate: codecRep.bit_rate,
      scale_mode: scaleMode || 'fit'
    };
  }

  /**
   * Which parts of `src` differ from `target`.
   *
   * Only resolution / frame rate / field order actually change the picture --
   * codec, container and profile differences are absorbed by the re-encode --
   * but every difference is reported so the include/exclude list can explain
   * itself.
   */
  function mismatchReasons(src, target) {
    var reasons = [];
    if (src.width !== target.width || src.height !== target.height) reasons.push('resolution');
    if (src.fps_key !== target.fps_key) reasons.push('frame rate');
    if (isInterlaced(src) !== isInterlaced(target)) reasons.push('field order');
    if ((src.codec || '') !== (target.codec || '')) reasons.push('codec');
    else if ((src.profile || '') !== (target.profile || '')) reasons.push('profile');
    if (src.ext !== target.ext) reasons.push('container');
    return reasons;
  }

  /**
   * The ffmpeg -vf chain that turns `src` into `target`'s geometry and cadence.
   * Returns [] when the source already matches.
   */
  function buildConformFilters(src, target) {
    var srcIl = isInterlaced(src), tgtIl = isInterlaced(target);
    var resDiffers = (src.width !== target.width || src.height !== target.height);
    var fpsDiffers = src.fps_key !== target.fps_key;
    if (!resDiffers && !fpsDiffers && srcIl === tgtIl) return [];

    var filters = [];

    // 1. Interlaced sources have to go progressive before we can retime them
    //    (or if the target is progressive anyway). send_field keeps both fields
    //    as full frames at double rate, which is what re-interlacing later
    //    needs; send_frame is right when we're staying progressive.
    var deinterlaced = false;
    if (srcIl && (!tgtIl || fpsDiffers)) {
      filters.push(tgtIl ? 'yadif=mode=send_field' : 'yadif=mode=send_frame');
      deinterlaced = true;
    }

    // 2. Geometry. Still-interlaced frames must be scaled field-by-field.
    if (resDiffers) {
      var w = target.width, h = target.height;
      var interl = (srcIl && !deinterlaced) ? ':interl=1' : '';
      var mode = target.scale_mode || 'fit';
      if (mode === 'stretch') {
        filters.push('scale=' + w + ':' + h + ':flags=lanczos' + interl);
      } else if (mode === 'crop') {
        filters.push('scale=' + w + ':' + h + ':force_original_aspect_ratio=increase:flags=lanczos' + interl);
        filters.push('crop=' + w + ':' + h);
      } else {
        filters.push('scale=' + w + ':' + h + ':force_original_aspect_ratio=decrease:flags=lanczos' + interl);
        filters.push('pad=' + w + ':' + h + ':(ow-iw)/2:(oh-ih)/2:color=black');
      }
      filters.push('setsar=1');
    }

    // 3. Cadence. The interlace filter halves the frame rate, so feed it twice
    //    the target rate to land exactly on it.
    if (tgtIl) {
      if (fpsDiffers || !srcIl) {
        filters.push('fps=' + doubleFraction(target.fps_frac));
        filters.push('interlace=scan=' + (isTff(target) ? 'tff' : 'bff') + ':lowpass=complex');
      }
    } else if (fpsDiffers) {
      filters.push('fps=' + target.fps_frac);
    }

    return filters;
  }

  // ------------------------------------------------------------------------ //
  // Codec profile fidelity
  //
  // A clip has to come back out as the same codec AND the same profile it went
  // in as -- ProRes LT stays ProRes LT. Every table below is keyed on the EXACT
  // string ffprobe reports, because substring matching gets it wrong: ffprobe
  // calls ProRes 4444 XQ just "XQ", which contains none of "4444", "hq" or
  // "lt". These tables are the same ones random_compilation_maker.py uses, and
  // test_core.html holds the two editions to identical output.
  // ------------------------------------------------------------------------ //

  var PRORES_PROFILES = {
    'proxy': '0', 'lt': '1', 'standard': '2', 'hq': '3',
    '4444': '4', 'xq': '5', '4444 xq': '5', '4444xq': '5'
  };
  var PRORES_NATIVE_PIX = ['yuv422p10le', 'yuv444p10le', 'yuva444p10le'];

  // profile -> [-profile:v value, required pixel format]
  var DNXHR_PROFILES = {
    'dnxhr lb': ['dnxhr_lb', 'yuv422p'],
    'dnxhr sq': ['dnxhr_sq', 'yuv422p'],
    'dnxhr hq': ['dnxhr_hq', 'yuv422p'],
    'dnxhr hqx': ['dnxhr_hqx', 'yuv422p10le'],
    'dnxhr 444': ['dnxhr_444', 'yuv444p10le']
  };

  // Legacy VC-3 only encodes at set bit rates for set geometries.
  // "width,height,interlaced,tenBit" -> the nominal Mbit/s that are legal.
  var DNXHD_CIDS = {
    '1920,1080,false,false': [36, 45, 75, 90, 115, 120, 145, 175, 185, 220, 240, 290, 365, 440],
    '1920,1080,false,true': [175, 185, 365, 440],
    '1920,1080,true,false': [120, 145, 185, 220],
    '1920,1080,true,true': [185, 220],
    '1440,1080,false,false': [63, 84, 100, 110],
    '1440,1080,true,false': [120, 145],
    '1280,720,false,false': [60, 75, 90, 110, 120, 145, 180, 220],
    '1280,720,false,true': [90, 180, 220],
    '960,720,false,false': [42, 60, 75, 115]
  };

  var H264_PROFILES = {
    'constrained baseline': 'baseline',
    'baseline': 'baseline',
    'main': 'main',
    'extended': 'main',
    'high': 'high',
    'high 10': 'high10',
    'high 10 intra': 'high10',
    'high 4:2:2': 'high422',
    'high 4:2:2 intra': 'high422',
    'high 4:4:4 predictive': 'high444',
    'high 4:4:4': 'high444',
    'high 4:4:4 intra': 'high444',
    'cavlc 4:4:4': 'high444'
  };
  // -profile:v is a ceiling: ask for one below what the pixel format needs and
  // ffmpeg exits. Each format therefore has a floor in this ladder.
  var H264_BY_RANK = ['baseline', 'main', 'high', 'high10', 'high422', 'high444'];
  var H264_PIX_FLOOR = {
    'yuv420p': 0, 'yuvj420p': 0, 'nv12': 0, 'nv21': 0,
    'gray': 2,
    'yuv420p10le': 3, 'gray10le': 3,
    'yuv422p': 4, 'yuvj422p': 4, 'nv16': 4, 'yuv422p10le': 4, 'nv20le': 4,
    'yuv444p': 5, 'yuvj444p': 5, 'yuv444p10le': 5
  };

  var HEVC_9BIT = {
    'yuv420p9le': 'yuv420p10le', 'yuv422p9le': 'yuv422p10le',
    'yuv444p9le': 'yuv444p10le', 'gray9le': 'gray10le'
  };

  var MPEG2_PROFILES = {
    '4:2:2': '0', 'high': '1', 'spatially scalable': '2',
    'snr scalable': '3', 'main': '4', 'simple': '5'
  };
  var MPEG2_420_ONLY = ['2', '3', '4', '5'];

  var MPEG4_PROFILES = {
    'simple profile': '0',
    'simple scalable profile': '1',
    'core profile': '2',
    'main profile': '3',
    'n-bit profile': '4',
    'scalable texture profile': '5',
    'simple face animation profile': '6',
    'basic animated texture profile': '7',
    'hybrid profile': '8',
    'advanced real time simple profile': '9',
    'code scalable profile': '10',          // ffmpeg's own spelling
    'advanced coding profile': '11',
    'advanced core profile': '12',
    'advanced scalable texture profile': '13',
    // 14 (Simple Studio) is deliberately absent: it encodes a corrupt,
    // undecodable bitstream. Omitting -profile:v gives a valid file instead.
    'advanced simple profile': '15'
  };

  // The only (width, height, pixel format) triples the DV encoder accepts.
  var DV_GEOMETRY = [
    '720,480,yuv411p', '720,480,yuv422p',
    '720,576,yuv420p', '720,576,yuv411p', '720,576,yuv422p',
    '1280,1080,yuv422p', '1440,1080,yuv422p',
    '960,720,yuv422p'
  ];

  // Encoders that cannot be muxed into some containers at all (ffmpeg exits).
  var ENCODER_BAD_CONTAINERS = {
    'prores_ks': [['.mp4'], '.mov'],
    'ljpeg': [['.mp4'], '.avi'],
    'dvvideo': [['.mp4'], '.avi'],
    'libvpx': [['.mp4'], '.webm']
  };
  var H264_CONTAINERS = ['.mp4', '.mov', '.mkv', '.m4v', '.ts', '.mts', '.m2ts',
    '.flv', '.avi', '.3gp'];
  // Pixel formats the WebAssembly x264 build is guaranteed to accept.
  var SAFE_H264_PIX = ['yuv420p', 'yuvj420p', 'nv12'];

  /** True for any pixel format deeper than 8 bits. */
  function isTenBit(pix) {
    var text = String(pix || '').toLowerCase();
    var markers = ['9le', '10le', '12le', '14le', '16le', '9be', '10be', '12be'];
    for (var i = 0; i < markers.length; i++) {
      if (text.indexOf(markers[i]) >= 0) return true;
    }
    return false;
  }

  /** Pick the legal VC-3 nominal rate closest to the source's own. */
  function dnxhdNominal(cids, bitRate, fps) {
    var br = parseFloat(bitRate);
    var rate = parseFloat(fps);
    if (!isFinite(br)) br = 0;
    if (!isFinite(rate) || rate <= 0) rate = 25;
    if (br <= 0) return Math.max.apply(Math, cids);
    // The CID nominals are quoted at 25 fps.
    var mbit = (br / 1e6) * (25 / rate);
    var best = cids[0];
    var bestDiff = Math.abs(cids[0] - mbit);
    for (var i = 1; i < cids.length; i++) {
      var d = Math.abs(cids[i] - mbit);
      if (d < bestDiff) { bestDiff = d; best = cids[i]; }
    }
    return best;
  }

  function h264Args(interlaced, tff) {
    var args = ['-c:v', 'libx264', '-preset', 'medium', '-crf', '16'];
    if (interlaced) {
      args.push('-x264opts', 'interlaced=1:' + (tff ? 'tff' : 'bff') + '=1');
    }
    return args;
  }

  /**
   * Build the ffmpeg video-encoding arguments that reproduce `rep`'s codec and
   * profile exactly.
   *
   * `rep` is the target dict, so its width/height are the OUTPUT geometry --
   * which matters, because DNxHD and DV only accept particular frame sizes.
   *
   * `available` is an optional Set of encoder names this FFmpeg build can
   * actually use. The WebAssembly build ships fewer encoders than a desktop
   * ffmpeg (and a couple that are present but unusable), so when the right one
   * is missing we fall back to H.264 rather than failing the render outright --
   * that is the one behaviour the browser edition adds on top of the Python
   * original. Called without it, the output is identical to the desktop tool's.
   *
   * Returns {args, name, encoder, interlaced, container, fallback, wanted}.
   */
  function buildVideoEncodeArgs(rep, available) {
    var codec = String(rep.codec || '').toLowerCase();
    var pix = rep.pix_fmt;
    var profile = String(rep.profile || '').trim().toLowerCase();
    var field = String(rep.field_order || 'progressive').toLowerCase();
    var bitRate = rep.bit_rate;
    var width = rep.width;
    var height = rep.height;
    var ext = rep.ext || '.mp4';

    var interlaced = INTERLACED_ORDERS.indexOf(field) >= 0;
    var tff = (field === 'tt' || field === 'tb');

    var args = [];
    var encoder = '';
    var detail = '';
    // How this codec wants its interlacing declared.
    var ilaceFlags = true;      // emit -flags +ilme+ildct
    var fieldMode = 'ttbb';     // 'ttbb' | 'passthrough' | null
    var prof, want;

    if (codec === 'h264') {
      encoder = 'libx264';
      // x264 refuses an interlaced frame whose height isn't a multiple of 4.
      // Losing the interlace flag beats losing the render.
      if (interlaced && height && (height % 4)) {
        interlaced = false;
        detail = 'progressive (x264 cannot interlace a height of ' + height + ')';
      }
      args = h264Args(interlaced, tff);
      want = H264_PROFILES[profile];
      if (want) {
        var floor = pix ? (H264_PIX_FLOOR[pix] === undefined ? 5 : H264_PIX_FLOOR[pix]) : 0;
        var rank = Math.max(H264_BY_RANK.indexOf(want), floor);
        args.push('-profile:v', H264_BY_RANK[rank]);
      }

    } else if (codec === 'hevc' || codec === 'h265') {
      encoder = 'libx265';
      args = ['-c:v', 'libx265', '-preset', 'medium', '-crf', '18'];
      if (HEVC_9BIT[pix]) pix = HEVC_9BIT[pix];   // libx265 has no 9-bit mode
      if (profile === 'main') {
        if (pix !== 'yuv420p' && pix !== 'yuvj420p') pix = 'yuv420p';
      } else if (profile === 'main 10') {
        pix = 'yuv420p10le';
      } else if (profile === 'main still picture') {
        pix = 'yuv420p';
      } else if (profile === 'rext') {
        // "Rext" covers everything exotic, so the pixel format is the only
        // thing that says which one. Never pass "rext" itself: it exits.
        if (pix === 'yuv420p' || pix === 'yuvj420p') {
          args.push('-profile:v', 'main-intra');
        } else if (pix === 'yuv420p10le') {
          args.push('-profile:v', 'main10-intra');
        }
      }

    } else if (codec === 'mpeg2video') {
      encoder = 'mpeg2video';
      args = ['-c:v', 'mpeg2video'];
      prof = MPEG2_PROFILES[profile];
      if (prof) {
        args.push('-profile:v', prof);
        // Only High and 4:2:2 may carry 4:2:2 chroma; the rest exit.
        if (MPEG2_420_ONLY.indexOf(prof) >= 0 && pix !== 'yuv420p') pix = 'yuv420p';
      }
      if (bitRate) {
        args.push('-b:v', bitRate, '-maxrate', bitRate, '-minrate', bitRate, '-bufsize', bitRate);
      } else {
        args.push('-q:v', '2');
      }
      fieldMode = 'passthrough';

    } else if (codec === 'mpeg1video') {
      encoder = 'mpeg1video';
      args = ['-c:v', 'mpeg1video'];
      pix = 'yuv420p';
      if (bitRate) {
        args.push('-b:v', bitRate, '-maxrate', bitRate, '-minrate', bitRate, '-bufsize', bitRate);
      } else {
        args.push('-q:v', '2');
      }
      fieldMode = 'passthrough';

    } else if (codec === 'prores') {
      encoder = 'prores_ks';
      prof = PRORES_PROFILES[profile] || 'auto';
      args = ['-c:v', 'prores_ks', '-profile:v', prof];
      // ProRes decodes to 12-bit, which the encoder does not take. Rewrite to
      // its nearest native format -- keeping alpha, which is otherwise lost.
      if (pix && PRORES_NATIVE_PIX.indexOf(pix) < 0) {
        pix = pix.indexOf('yuva') === 0 ? 'yuva444p10le' : 'yuv444p10le';
      }

    } else if (codec === 'dnxhd') {
      encoder = 'dnxhd';
      if (DNXHR_PROFILES[profile]) {
        var entry = DNXHR_PROFILES[profile];
        var wantPix = entry[1];
        if (profile === 'dnxhr 444' && (pix === 'yuv444p10le' || pix === 'gbrp10le')) {
          wantPix = pix;
        }
        args = ['-c:v', 'dnxhd', '-profile:v', entry[0]];
        pix = wantPix;
        interlaced = false;        // DNxHR refuses interlaced encoding
      } else if (pix === 'yuv444p10le' || pix === 'gbrp10le') {
        // Legacy VC-3 has no 444 variant; DNxHR is the closest that encodes.
        args = ['-c:v', 'dnxhd', '-profile:v', 'dnxhr_444'];
        interlaced = false;
        detail = 'DNxHR 444 (legacy DNxHD has no 4:4:4 variant)';
      } else {
        var tenBit = isTenBit(pix);
        var cids = DNXHD_CIDS[width + ',' + height + ',' + interlaced + ',' + tenBit];
        if (cids) {
          var nominal = dnxhdNominal(cids, bitRate, rep.fps);
          args = ['-c:v', 'dnxhd', '-profile:v', 'dnxhd', '-b:v', nominal + 'M'];
          detail = 'legacy VC-3 at ' + nominal + ' Mbit/s';
        } else {
          // No VC-3 exists at this size/rate, so DNxHR carries it instead.
          prof = tenBit ? 'dnxhr_hqx' : 'dnxhr_hq';
          args = ['-c:v', 'dnxhd', '-profile:v', prof];
          pix = tenBit ? 'yuv422p10le' : 'yuv422p';
          interlaced = false;
          detail = prof + ' -- no legacy DNxHD exists at ' + width + 'x' + height;
        }
      }
      if (!interlaced) {
        ilaceFlags = false;
        fieldMode = null;
      }

    } else if (codec === 'mjpeg') {
      if (profile === 'lossless') {
        encoder = 'ljpeg';
        args = ['-c:v', 'ljpeg', '-strict', '-1'];
        if (pix === 'bgra') pix = 'bgr24';   // 4-component LJPEG is undecodable
      } else {
        encoder = 'mjpeg';
        args = ['-c:v', 'mjpeg', '-q:v', '2'];
        if (pix === 'gray') pix = 'yuvj420p';  // mjpeg would pick yuvj444p for mono
        // Baseline MJPEG cannot be told to interlace at all. The picture is
        // already woven by the filter chain, so only the flags have to go.
        ilaceFlags = false;
      }

    } else if (codec === 'mpeg4') {
      encoder = 'mpeg4';
      args = ['-c:v', 'mpeg4'];
      prof = MPEG4_PROFILES[profile];
      if (prof) args.push('-profile:v', prof);
      args.push('-q:v', '3');
      pix = 'yuv420p';
      fieldMode = 'passthrough';

    } else if (codec === 'dvvideo') {
      if (DV_GEOMETRY.indexOf(width + ',' + height + ',' + pix) >= 0) {
        encoder = 'dvvideo';
        args = ['-c:v', 'dvvideo'];
      } else {
        // DV only exists at a handful of frame sizes. Once a clip has been
        // conformed away from one there is no DV to write, so H.264 keeps
        // the render alive.
        encoder = 'libx264';
        args = ['-c:v', 'libx264', '-preset', 'medium', '-crf', '16'];
        pix = 'yuv420p';
        detail = 'H.264 -- DV has no ' + width + 'x' + height + ' format';
      }

    } else if (codec === 'vp9') {
      encoder = 'libvpx-vp9';
      args = ['-c:v', 'libvpx-vp9', '-crf', '20', '-b:v', '0'];
      ilaceFlags = false; fieldMode = null;
    } else if (codec === 'vp8') {
      encoder = 'libvpx';
      args = ['-c:v', 'libvpx', '-crf', '20', '-b:v', '0'];
      ilaceFlags = false; fieldMode = null;
    } else if (codec === 'av1') {
      encoder = 'libaom-av1';
      args = ['-c:v', 'libaom-av1', '-crf', '30', '-b:v', '0'];
      ilaceFlags = false; fieldMode = null;

    } else {
      // Unknown codec: fall back to high-quality H.264 so we still produce
      // something usable rather than failing outright.
      encoder = 'libx264';
      detail = 'fallback';
      if (interlaced && height && (height % 4)) interlaced = false;
      args = h264Args(interlaced, tff);
    }

    var container = ext;
    var wanted = encoder;
    var fallback = false;

    // Browser-only: this FFmpeg build may not have (or may not survive) the
    // encoder we want. Swap in H.264 instead of letting the render die.
    if (available && available.size && !available.has(encoder)) {
      fallback = true;
      encoder = available.has('libx264') ? 'libx264'
        : (available.has('mpeg4') ? 'mpeg4'
          : (available.has('mjpeg') ? 'mjpeg' : 'libx264'));
      if (encoder === 'libx264') {
        args = h264Args(interlaced && !(height && height % 4), tff);
        if (interlaced && height && height % 4) interlaced = false;
      } else if (encoder === 'mpeg4') {
        args = ['-c:v', 'mpeg4', '-q:v', '3'];
      } else {
        args = ['-c:v', 'mjpeg', '-q:v', '2'];
        ilaceFlags = false;
      }
      if (SAFE_H264_PIX.indexOf(String(pix)) < 0) pix = 'yuv420p';
      ilaceFlags = (encoder !== 'mjpeg');
      fieldMode = 'ttbb';
      detail = 'fallback -- ' + wanted + ' is not usable in this FFmpeg build';
      container = ext;
    }

    if (pix) args.push('-pix_fmt', pix);
    if (interlaced && (ilaceFlags || fieldMode)) {
      if (ilaceFlags) args.push('-flags', '+ilme+ildct');
      if (fieldMode === 'passthrough') args.push('-field_order', field);
      else if (fieldMode === 'ttbb') args.push('-field_order', tff ? 'tt' : 'bb');
    }

    // Some codecs simply cannot live in some containers.
    var bad = ENCODER_BAD_CONTAINERS[encoder];
    if (bad && bad[0].indexOf(container) >= 0) container = bad[1];
    if (encoder === 'libx264' && H264_CONTAINERS.indexOf(container) < 0) container = '.mp4';

    return {
      args: args,
      name: encoder + (detail ? ' (' + detail + ')' : ''),
      encoder: encoder,
      interlaced: interlaced,
      container: container,
      fallback: fallback,
      wanted: wanted
    };
  }

  // ------------------------------------------------------------------------ //
  // Seeded RNG
  // ------------------------------------------------------------------------ //

  // Python seeds a Mersenne Twister; JavaScript has no seedable RNG at all, so
  // this is mulberry32 over an FNV-1a hash of the seed. Same guarantee that
  // matters -- one seed always reproduces one compilation -- but the actual
  // clip picks differ from the desktop version's for the same seed.
  function hashSeed(seed) {
    var s = String(seed);
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function makeRng(seed) {
    var next;
    if (seed === null || seed === undefined || seed === '') {
      next = Math.random;
    } else {
      var a = hashSeed(seed);
      next = function () {
        a |= 0;
        a = (a + 0x6D2B79F5) | 0;
        var t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }
    return {
      random: next,
      uniform: function (lo, hi) { return lo + (hi - lo) * next(); },
      choice: function (arr) { return arr[Math.floor(next() * arr.length)]; },
      shuffle: function (arr) {
        for (var i = arr.length - 1; i > 0; i--) {
          var j = Math.floor(next() * (i + 1));
          var tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
        }
        return arr;
      }
    };
  }

  // ------------------------------------------------------------------------ //
  // Clip planning
  // ------------------------------------------------------------------------ //

  function round3(v) {
    return Math.round(v * 1000) / 1000;
  }

  /**
   * Decide which random segments to cut.
   *
   * `sources` is a list of probe dicts (already filtered to a single format).
   * Returns a list of {path, start, length, vf}.
   */
  function planClips(sources, opts, rng) {
    var minLen = opts.min_len;
    var maxLen = opts.max_len;

    var usable = sources.filter(function (s) { return s.duration >= minLen; });
    if (!usable.length) {
      throw new Error('No source video is long enough for the minimum clip length (' +
        formatFps(minLen) + 's). Lower the minimum or add longer videos.');
    }

    function makeOne() {
      var src = rng.choice(usable);
      var hi = Math.min(maxLen, src.duration);
      var lo = Math.min(minLen, hi);
      var length = rng.uniform(lo, hi);
      var latestStart = Math.max(0, src.duration - length);
      var start = rng.uniform(0, latestStart);
      return {
        path: src.path,
        start: round3(start),
        length: round3(length),
        // Per-source: set when this file has to be conformed to the chosen
        // output format, null when it already matches.
        vf: src.vf || null
      };
    }

    var clips = [];
    if (opts.mode === 'count') {
      for (var i = 0; i < opts.clip_count; i++) clips.push(makeOne());
    } else {
      var target = opts.total_duration;
      var total = 0;
      // Every non-final clip is at least min_len long, so this terminates in
      // at most ~target/min_len iterations -- no risk of a zero-length spin.
      while (total < target) {
        var clip = makeOne();
        var remaining = target - total;
        if (clip.length >= remaining) {
          clip.length = round3(remaining);
          if (clip.length > 0) clips.push(clip);
          break;
        }
        total += clip.length;
        clips.push(clip);
      }
    }

    if (opts.shuffle) rng.shuffle(clips);
    return clips;
  }

  // ------------------------------------------------------------------------ //
  // ffmpeg command lines
  // ------------------------------------------------------------------------ //

  function buildClipArgs(clip, opts, outPath) {
    var args = ['-hide_banner', '-nostdin', '-y',
      '-ss', clip.start.toFixed(3), '-i', clip.path,
      '-t', clip.length.toFixed(3),
      '-map', '0:v:0', '-an'];
    if (clip.vf) args.push('-vf', clip.vf);
    args = args.concat(opts.encode_args);
    args.push('-r', opts.fps_frac, '-fps_mode', 'cfr', outPath);
    return args;
  }

  function buildConcatList(clipPaths) {
    return clipPaths.map(function (p) {
      return "file '" + String(p).replace(/'/g, "'\\''") + "'";
    }).join('\n') + '\n';
  }

  function buildConcatArgs(listPath, outPath) {
    return ['-hide_banner', '-nostdin', '-y',
      '-f', 'concat', '-safe', '0', '-i', listPath,
      '-c', 'copy', '-an', outPath];
  }

  // ------------------------------------------------------------------------ //
  // Log parsing
  // ------------------------------------------------------------------------ //

  function parseFrameCount(line) {
    var m = /frame=\s*(\d+)/.exec(String(line));
    return m ? parseInt(m[1], 10) : null;
  }

  /** Encoder-table line from `ffmpeg -encoders`, e.g. ' V....D prores_ks'. */
  function parseEncoderLine(line) {
    var m = /^\s*V[A-Z.]{5}\s+(\S+)/.exec(String(line));
    return m ? m[1] : null;
  }

  function sanitizeName(s) {
    return String(s).trim()
      .replace(/[^\w.\-]+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '') || 'random_compilation';
  }

  function formatBytes(n) {
    if (!isFinite(n)) return '?';
    var units = ['B', 'KB', 'MB', 'GB', 'TB'];
    var i = 0;
    var v = Number(n);
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return (i === 0 ? v : v.toFixed(v < 10 ? 2 : 1)) + ' ' + units[i];
  }

  function formatDuration(secs) {
    var s = Math.max(0, Math.round(Number(secs) || 0));
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    var r = s % 60;
    var pad = function (n) { return (n < 10 ? '0' : '') + n; };
    return (h ? h + ':' + pad(m) : String(m)) + ':' + pad(r);
  }

  return {
    VIDEO_EXTS: VIDEO_EXTS,
    INTERLACED_ORDERS: INTERLACED_ORDERS,
    SCALE_MODES: SCALE_MODES,
    extOf: extOf,
    baseName: baseName,
    isVideoName: isVideoName,
    guessOutputContainer: guessOutputContainer,
    withExtension: withExtension,
    parseFraction: parseFraction,
    fpsKey: fpsKey,
    formatFps: formatFps,
    fpsFraction: fpsFraction,
    snapFps: snapFps,
    doubleFraction: doubleFraction,
    splitTopLevel: splitTopLevel,
    parseProbeLog: parseProbeLog,
    distinctResolutions: distinctResolutions,
    distinctFps: distinctFps,
    distinctCodecs: distinctCodecs,
    isInterlaced: isInterlaced,
    isTff: isTff,
    formatSig: formatSig,
    describeCodecSig: describeCodecSig,
    fpsFracForKey: fpsFracForKey,
    buildTarget: buildTarget,
    mismatchReasons: mismatchReasons,
    buildConformFilters: buildConformFilters,
    buildVideoEncodeArgs: buildVideoEncodeArgs,
    makeRng: makeRng,
    planClips: planClips,
    buildClipArgs: buildClipArgs,
    buildConcatList: buildConcatList,
    buildConcatArgs: buildConcatArgs,
    parseFrameCount: parseFrameCount,
    parseEncoderLine: parseEncoderLine,
    sanitizeName: sanitizeName,
    formatBytes: formatBytes,
    formatDuration: formatDuration
  };
}));
