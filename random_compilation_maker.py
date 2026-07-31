#!/usr/bin/env python3
"""
Random Compilation Maker
========================

A small GUI tool that takes one or more video files (or a whole folder of
videos) and cuts random clips out of them, then stitches those clips together
into a single random "compilation" video.

It uses ffmpeg / ffprobe under the hood (no extra Python packages required) and
a built-in tkinter GUI.

Key behaviour
-------------
* The output is ONE codec, ONE resolution and ONE frame rate. If the sources
  disagree on any of those, a dialog pops up that (a) makes you pick which
  format to render as and (b) lets you include or exclude each source
  individually. A mismatched source you keep is conformed to the pick (scaled,
  retimed, de/re-interlaced); one you uncheck is left out entirely.
* Audio is always removed.
* Each clip is RE-ENCODED to the chosen codec, resolution, frame rate and
  field order, so cuts are frame-accurate and the result is a clean
  constant-frame-rate file. It matches the codec type, container, interlacing
  and pixel format -- not the byte-identical encoder settings.

Requires: ffmpeg and ffprobe on PATH.
"""

import os
import sys
import json
import queue
import random
import shutil
import threading
import subprocess
import tempfile
import concurrent.futures
import tkinter as tk
from tkinter import ttk, filedialog, messagebox

# --------------------------------------------------------------------------- #
# Constants
# --------------------------------------------------------------------------- #

VIDEO_EXTS = {
    ".mp4", ".mov", ".mkv", ".avi", ".m4v", ".wmv", ".flv", ".webm",
    ".mpg", ".mpeg", ".ts", ".mts", ".m2ts", ".mxf", ".vob", ".3gp",
}

# Hide the console windows that ffmpeg/ffprobe would otherwise pop up on Windows.
_CREATE_NO_WINDOW = 0x08000000 if os.name == "nt" else 0


def default_workers():
    """A sensible default for how many clips to encode in parallel."""
    cpus = os.cpu_count() or 4
    # ffmpeg is itself multi-threaded, so don't oversubscribe wildly; cap at 8.
    return max(2, min(cpus, 8))


# --------------------------------------------------------------------------- #
# ffmpeg / ffprobe helpers
# --------------------------------------------------------------------------- #

def _run_quiet(cmd):
    """Run a command, capture output, never open a console window."""
    return subprocess.run(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        creationflags=_CREATE_NO_WINDOW,
        text=True,
    )


def tools_available():
    """Return (ok, message). Checks ffmpeg + ffprobe are reachable."""
    missing = [t for t in ("ffmpeg", "ffprobe") if shutil.which(t) is None]
    if missing:
        return False, "Missing required tool(s) on PATH: " + ", ".join(missing)
    return True, ""


def _parse_fraction(text):
    """Parse an ffprobe fraction like '30000/1001' into a float (or None)."""
    if not text or text in ("0/0", "N/A"):
        return None
    try:
        if "/" in text:
            num, den = text.split("/", 1)
            den = float(den)
            if den == 0:
                return None
            return float(num) / den
        return float(text)
    except (ValueError, ZeroDivisionError):
        return None


def fps_key(fps):
    """Round an fps to a stable key so 29.97 != 30 but 29.970 == 29.97."""
    return round(float(fps), 2)


def format_fps(fps):
    """Human-friendly fps: integers stay integers, else 2 decimals."""
    f = float(fps)
    if abs(f - round(f)) < 0.01:
        return str(int(round(f)))
    return f"{f:.2f}"


def probe_video(path):
    """
    Return a dict describing `path`, or None if it can't be read as a video.

    Keys: path, duration, width, height, fps, fps_key, codec, field_order, ext.
    """
    cmd = [
        "ffprobe", "-v", "error", "-print_format", "json",
        "-show_format", "-show_streams", path,
    ]
    res = _run_quiet(cmd)
    if res.returncode != 0:
        return None
    try:
        data = json.loads(res.stdout)
    except json.JSONDecodeError:
        return None

    streams = data.get("streams", [])
    v = next((s for s in streams if s.get("codec_type") == "video"), None)
    if v is None:
        return None

    # Duration: prefer container, fall back to stream.
    duration = None
    for src in (data.get("format", {}).get("duration"), v.get("duration")):
        if src not in (None, "N/A"):
            try:
                duration = float(src)
                break
            except ValueError:
                continue
    if duration is None or duration <= 0:
        return None

    try:
        width = int(v.get("width"))
        height = int(v.get("height"))
    except (TypeError, ValueError):
        return None

    avg_fr, r_fr = v.get("avg_frame_rate"), v.get("r_frame_rate")
    if _parse_fraction(avg_fr):
        fps_frac, fps = avg_fr, _parse_fraction(avg_fr)
    elif _parse_fraction(r_fr):
        fps_frac, fps = r_fr, _parse_fraction(r_fr)
    else:
        return None

    bit_rate = v.get("bit_rate")
    if bit_rate in (None, "N/A", "0"):
        bit_rate = data.get("format", {}).get("bit_rate")
    if bit_rate in (None, "N/A", "0"):
        bit_rate = None

    return {
        "path": path,
        "duration": duration,
        "width": width,
        "height": height,
        "fps": fps,
        "fps_key": fps_key(fps),
        "fps_frac": fps_frac,
        "codec": v.get("codec_name", "unknown"),
        "field_order": v.get("field_order", "unknown"),
        "pix_fmt": v.get("pix_fmt"),
        "profile": v.get("profile"),
        "bit_rate": bit_rate,
        "ext": os.path.splitext(path)[1].lower() or ".mp4",
    }


# --------------------------------------------------------------------------- #
# Format grouping / filtering
# --------------------------------------------------------------------------- #

def distinct_resolutions(sources):
    """Ordered list of ((w, h), count), most common first."""
    counts = {}
    for s in sources:
        key = (s["width"], s["height"])
        counts[key] = counts.get(key, 0) + 1
    return sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))


def distinct_fps(sources):
    """Ordered list of (fps_key, count, display), most common first."""
    counts = {}
    display = {}
    for s in sources:
        k = s["fps_key"]
        counts[k] = counts.get(k, 0) + 1
        display[k] = format_fps(s["fps"])
    items = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))
    return [(k, c, display[k]) for k, c in items]


INTERLACED_ORDERS = {"tt", "tb", "bt", "bb"}


def is_interlaced(info):
    """True if this probe (or target) dict describes interlaced video."""
    return (info.get("field_order")
            or "progressive").lower() in INTERLACED_ORDERS


def is_tff(info):
    """True if the top field comes first."""
    return (info.get("field_order") or "").lower() in ("tt", "tb")


def _format_sig(s):
    """Codec-side signature: what the encoder has to be told to produce."""
    return (s.get("codec") or "unknown", s["ext"],
            s.get("field_order") or "", s.get("profile") or "")


def distinct_codecs(sources):
    """
    Ordered list of (signature, count, representative) for every distinct
    codec / container / field order / profile combination, most common first.
    """
    groups = {}
    for s in sources:
        groups.setdefault(_format_sig(s), []).append(s)
    items = sorted(groups.items(), key=lambda kv: (-len(kv[1]), str(kv[0])))
    return [(sig, len(lst), lst[0]) for sig, lst in items]


def describe_codec_sig(sig):
    """Human label for a signature, e.g. 'h264  High  .mp4  interlaced'."""
    codec, ext, field, profile = sig
    bits = [codec or "unknown"]
    if profile:
        bits.append(profile)
    bits.append(ext)
    bits.append("interlaced" if (field or "").lower() in INTERLACED_ORDERS
                else "progressive")
    return "  ".join(bits)


def fps_frac_for_key(sources, fpsk):
    """The ffprobe fraction string that goes with a rounded fps key."""
    for s in sources:
        if s["fps_key"] == fpsk:
            return s["fps_frac"]
    return None


def build_target(resolution, fpsk, fps_frac, codec_rep, scale_mode="fit"):
    """
    Assemble the one format everything gets rendered as.

    Resolution and frame rate come from the user's picks; codec, container,
    field order, profile, pixel format and bit rate come from the chosen codec
    group's representative file (so the codec/container pair is always one that
    actually exists and is known to be valid together).
    """
    return {
        "width": resolution[0],
        "height": resolution[1],
        "fps": fpsk,
        "fps_key": fpsk,
        "fps_frac": fps_frac,
        "codec": codec_rep.get("codec"),
        "ext": codec_rep["ext"],
        "field_order": codec_rep.get("field_order"),
        "profile": codec_rep.get("profile"),
        "pix_fmt": codec_rep.get("pix_fmt"),
        "bit_rate": codec_rep.get("bit_rate"),
        "scale_mode": scale_mode,
    }


def mismatch_reasons(src, target):
    """
    Which parts of `src` differ from `target`.

    Only resolution / frame rate / field order actually change the picture --
    codec, container and profile differences are absorbed by the re-encode --
    but every difference is reported so the include/exclude list can explain
    itself.
    """
    reasons = []
    if (src["width"], src["height"]) != (target["width"], target["height"]):
        reasons.append("resolution")
    if src["fps_key"] != target["fps_key"]:
        reasons.append("frame rate")
    if is_interlaced(src) != is_interlaced(target):
        reasons.append("field order")
    if (src.get("codec") or "") != (target.get("codec") or ""):
        reasons.append("codec")
    elif (src.get("profile") or "") != (target.get("profile") or ""):
        reasons.append("profile")
    if src["ext"] != target["ext"]:
        reasons.append("container")
    return reasons


def double_fraction(frac):
    """'30000/1001' -> '60000/1001'. Used when re-interlacing."""
    text = str(frac) if frac else ""
    if "/" in text:
        num, den = text.split("/", 1)
        try:
            return f"{int(num) * 2}/{int(den)}"
        except ValueError:
            pass
    val = _parse_fraction(text)
    return f"{val * 2:.6f}" if val else text


def build_conform_filters(src, target):
    """
    The ffmpeg -vf chain that turns `src` into `target`'s geometry and cadence.

    Returns [] when the source already matches -- the common case -- in which
    case the clip is extracted exactly as it was before.
    """
    src_il, tgt_il = is_interlaced(src), is_interlaced(target)
    res_differs = ((src["width"], src["height"])
                   != (target["width"], target["height"]))
    fps_differs = src["fps_key"] != target["fps_key"]
    if not (res_differs or fps_differs or src_il != tgt_il):
        return []

    filters = []

    # 1. Interlaced sources have to go progressive before we can retime them
    #    (or if the target is progressive anyway). send_field keeps both fields
    #    as full frames at double rate, which is what re-interlacing later
    #    needs; send_frame is right when we're staying progressive.
    deinterlaced = False
    if src_il and (not tgt_il or fps_differs):
        filters.append("yadif=mode=send_field" if tgt_il
                       else "yadif=mode=send_frame")
        deinterlaced = True

    # 2. Geometry. Still-interlaced frames must be scaled field-by-field.
    if res_differs:
        w, h = target["width"], target["height"]
        interl = ":interl=1" if (src_il and not deinterlaced) else ""
        mode = target.get("scale_mode", "fit")
        if mode == "stretch":
            filters.append(f"scale={w}:{h}:flags=lanczos{interl}")
        elif mode == "crop":
            filters.append(f"scale={w}:{h}:force_original_aspect_ratio="
                           f"increase:flags=lanczos{interl}")
            filters.append(f"crop={w}:{h}")
        else:  # fit -- letterbox / pillarbox, no distortion
            filters.append(f"scale={w}:{h}:force_original_aspect_ratio="
                           f"decrease:flags=lanczos{interl}")
            filters.append(f"pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:color=black")
        filters.append("setsar=1")

    # 3. Cadence. The interlace filter halves the frame rate, so feed it twice
    #    the target rate to land exactly on it.
    if tgt_il:
        if fps_differs or not src_il:
            filters.append(f"fps={double_fraction(target['fps_frac'])}")
            filters.append("interlace=scan="
                           + ("tff" if is_tff(target) else "bff")
                           + ":lowpass=complex")
    elif fps_differs:
        filters.append(f"fps={target['fps_frac']}")

    return filters


# --------------------------------------------------------------------------- #
# Codec profile fidelity
#
# A clip has to come back out as the same codec AND the same profile it went in
# as -- ProRes LT stays ProRes LT. Every table below is keyed on the EXACT
# string ffprobe reports, because substring matching gets it wrong: ffprobe
# calls ProRes 4444 XQ just "XQ", which contains none of "4444", "hq" or "lt".
#
# The mappings were established by encoding a file in each profile, re-encoding
# it with the candidate arguments and confirming ffprobe reported the identical
# codec and profile back.
# --------------------------------------------------------------------------- #

PRORES_PROFILES = {
    "proxy": "0", "lt": "1", "standard": "2", "hq": "3",
    "4444": "4", "xq": "5", "4444 xq": "5", "4444xq": "5",
}
PRORES_NATIVE_PIX = {"yuv422p10le", "yuv444p10le", "yuva444p10le"}

# profile -> (-profile:v value, required pixel format)
DNXHR_PROFILES = {
    "dnxhr lb": ("dnxhr_lb", "yuv422p"),
    "dnxhr sq": ("dnxhr_sq", "yuv422p"),
    "dnxhr hq": ("dnxhr_hq", "yuv422p"),
    "dnxhr hqx": ("dnxhr_hqx", "yuv422p10le"),
    "dnxhr 444": ("dnxhr_444", "yuv444p10le"),
}

# Legacy VC-3 only encodes at set bit rates for set geometries.
# (width, height, interlaced, ten_bit) -> the nominal Mbit/s that are legal.
DNXHD_CIDS = {
    (1920, 1080, False, False): [36, 45, 75, 90, 115, 120, 145, 175, 185, 220,
                                 240, 290, 365, 440],
    (1920, 1080, False, True): [175, 185, 365, 440],
    (1920, 1080, True, False): [120, 145, 185, 220],
    (1920, 1080, True, True): [185, 220],
    (1440, 1080, False, False): [63, 84, 100, 110],
    (1440, 1080, True, False): [120, 145],
    (1280, 720, False, False): [60, 75, 90, 110, 120, 145, 180, 220],
    (1280, 720, False, True): [90, 180, 220],
    (960, 720, False, False): [42, 60, 75, 115],
}

H264_PROFILES = {
    "constrained baseline": "baseline",
    "baseline": "baseline",
    "main": "main",
    "extended": "main",
    "high": "high",
    "high 10": "high10",
    "high 10 intra": "high10",
    "high 4:2:2": "high422",
    "high 4:2:2 intra": "high422",
    "high 4:4:4 predictive": "high444",
    "high 4:4:4": "high444",
    "high 4:4:4 intra": "high444",
    "cavlc 4:4:4": "high444",
}
# -profile:v is a ceiling: ask for one below what the pixel format needs and
# ffmpeg exits. Each format therefore has a floor in this ladder.
H264_BY_RANK = ["baseline", "main", "high", "high10", "high422", "high444"]
H264_PIX_FLOOR = {
    "yuv420p": 0, "yuvj420p": 0, "nv12": 0, "nv21": 0,
    "gray": 2,
    "yuv420p10le": 3, "gray10le": 3,
    "yuv422p": 4, "yuvj422p": 4, "nv16": 4, "yuv422p10le": 4, "nv20le": 4,
    "yuv444p": 5, "yuvj444p": 5, "yuv444p10le": 5,
}

HEVC_9BIT = {
    "yuv420p9le": "yuv420p10le", "yuv422p9le": "yuv422p10le",
    "yuv444p9le": "yuv444p10le", "gray9le": "gray10le",
}

MPEG2_PROFILES = {
    "4:2:2": "0", "high": "1", "spatially scalable": "2",
    "snr scalable": "3", "main": "4", "simple": "5",
}
MPEG2_420_ONLY = {"2", "3", "4", "5"}

MPEG4_PROFILES = {
    "simple profile": "0",
    "simple scalable profile": "1",
    "core profile": "2",
    "main profile": "3",
    "n-bit profile": "4",
    "scalable texture profile": "5",
    "simple face animation profile": "6",
    "basic animated texture profile": "7",
    "hybrid profile": "8",
    "advanced real time simple profile": "9",
    "code scalable profile": "10",          # ffmpeg's own spelling
    "advanced coding profile": "11",
    "advanced core profile": "12",
    "advanced scalable texture profile": "13",
    # 14 (Simple Studio) is deliberately absent: it encodes a corrupt,
    # undecodable bitstream. Omitting -profile:v gives a valid file instead.
    "advanced simple profile": "15",
}

# The only (width, height, pixel format) triples the DV encoder accepts.
DV_GEOMETRY = {
    (720, 480, "yuv411p"), (720, 480, "yuv422p"),
    (720, 576, "yuv420p"), (720, 576, "yuv411p"), (720, 576, "yuv422p"),
    (1280, 1080, "yuv422p"), (1440, 1080, "yuv422p"),
    (960, 720, "yuv422p"),
}

# Encoders that cannot be muxed into some containers at all (ffmpeg exits).
ENCODER_BAD_CONTAINERS = {
    "prores_ks": ({".mp4"}, ".mov"),
    "ljpeg": ({".mp4"}, ".avi"),
    "dvvideo": ({".mp4"}, ".avi"),
    "libvpx": ({".mp4"}, ".webm"),
}
H264_CONTAINERS = {".mp4", ".mov", ".mkv", ".m4v", ".ts", ".mts", ".m2ts",
                   ".flv", ".avi", ".3gp"}


def _is_ten_bit(pix):
    """True for any pixel format deeper than 8 bits."""
    text = (pix or "").lower()
    return any(marker in text for marker in ("9le", "10le", "12le", "14le",
                                             "16le", "9be", "10be", "12be"))


def _dnxhd_nominal(cids, bit_rate, fps):
    """Pick the legal VC-3 nominal rate closest to the source's own."""
    try:
        br = float(bit_rate) if bit_rate else 0.0
        rate = float(fps) if fps else 25.0
    except (TypeError, ValueError):
        br, rate = 0.0, 25.0
    if br <= 0 or rate <= 0:
        return max(cids)
    # The CID nominals are quoted at 25 fps.
    mbit = (br / 1e6) * (25.0 / rate)
    return min(cids, key=lambda c: abs(c - mbit))


def build_video_encode_args(rep):
    """
    Build the ffmpeg video-encoding arguments that reproduce `rep`'s codec and
    profile exactly.

    `rep` is the target dict, so its width/height are the OUTPUT geometry --
    which matters, because DNxHD and DV only accept particular frame sizes.

    Returns a dict with:
      args        the argument list
      name        a human label for the log
      encoder     the encoder actually chosen
      interlaced  whether interlaced flags were emitted
      container   the file extension to use (some codecs cannot go in some
                  containers, and forcing it beats a failed render)
    """
    codec = (rep.get("codec") or "").lower()
    pix = rep.get("pix_fmt")
    profile = (rep.get("profile") or "").strip().lower()
    field = (rep.get("field_order") or "progressive").lower()
    bit_rate = rep.get("bit_rate")
    width = rep.get("width")
    height = rep.get("height")
    ext = rep.get("ext") or ".mp4"

    interlaced = field in INTERLACED_ORDERS
    tff = field in ("tt", "tb")

    args = []
    encoder = ""
    detail = ""
    # How this codec wants its interlacing declared.
    ilace_flags = True          # emit -flags +ilme+ildct
    field_mode = "ttbb"         # "ttbb" | "passthrough" | None

    if codec == "h264":
        encoder = "libx264"
        args += ["-c:v", "libx264", "-preset", "medium", "-crf", "16"]
        # x264 refuses an interlaced frame whose height isn't a multiple of 4.
        # Losing the interlace flag beats losing the render.
        if interlaced and height and height % 4:
            interlaced = False
            detail = "progressive (x264 cannot interlace a height of %d)" % height
        if interlaced:
            args += ["-x264opts",
                     "interlaced=1:" + ("tff" if tff else "bff") + "=1"]
        want = H264_PROFILES.get(profile)
        if want:
            floor = H264_PIX_FLOOR.get(pix, 5) if pix else 0
            rank = max(H264_BY_RANK.index(want), floor)
            args += ["-profile:v", H264_BY_RANK[rank]]

    elif codec in ("hevc", "h265"):
        encoder = "libx265"
        args += ["-c:v", "libx265", "-preset", "medium", "-crf", "18"]
        pix = HEVC_9BIT.get(pix, pix)     # libx265 has no 9-bit mode
        if profile == "main":
            if pix not in ("yuv420p", "yuvj420p"):
                pix = "yuv420p"
        elif profile == "main 10":
            pix = "yuv420p10le"
        elif profile == "main still picture":
            pix = "yuv420p"
        elif profile == "rext":
            # "Rext" covers everything exotic, so the pixel format is the only
            # thing that says which one. Never pass "rext" itself: it exits.
            if pix in ("yuv420p", "yuvj420p"):
                args += ["-profile:v", "main-intra"]
            elif pix == "yuv420p10le":
                args += ["-profile:v", "main10-intra"]

    elif codec == "mpeg2video":
        encoder = "mpeg2video"
        args += ["-c:v", "mpeg2video"]
        prof = MPEG2_PROFILES.get(profile)
        if prof:
            args += ["-profile:v", prof]
            # Only High and 4:2:2 may carry 4:2:2 chroma; the rest exit.
            if prof in MPEG2_420_ONLY and pix != "yuv420p":
                pix = "yuv420p"
        if bit_rate:
            args += ["-b:v", bit_rate, "-maxrate", bit_rate,
                     "-minrate", bit_rate, "-bufsize", bit_rate]
        else:
            args += ["-q:v", "2"]
        field_mode = "passthrough"

    elif codec == "mpeg1video":
        encoder = "mpeg1video"
        args += ["-c:v", "mpeg1video"]
        pix = "yuv420p"
        if bit_rate:
            args += ["-b:v", bit_rate, "-maxrate", bit_rate,
                     "-minrate", bit_rate, "-bufsize", bit_rate]
        else:
            args += ["-q:v", "2"]
        field_mode = "passthrough"

    elif codec == "prores":
        encoder = "prores_ks"
        prof = PRORES_PROFILES.get(profile, "auto")
        args += ["-c:v", "prores_ks", "-profile:v", prof]
        # ProRes decodes to 12-bit, which the encoder does not take. Rewrite to
        # its nearest native format -- keeping alpha, which is otherwise lost.
        if pix and pix not in PRORES_NATIVE_PIX:
            pix = "yuva444p10le" if pix.startswith("yuva") else "yuv444p10le"

    elif codec == "dnxhd":
        encoder = "dnxhd"
        if profile in DNXHR_PROFILES:
            prof, want_pix = DNXHR_PROFILES[profile]
            if profile == "dnxhr 444" and pix in ("yuv444p10le", "gbrp10le"):
                want_pix = pix
            args += ["-c:v", "dnxhd", "-profile:v", prof]
            pix = want_pix
            interlaced = False      # DNxHR refuses interlaced encoding
        elif pix in ("yuv444p10le", "gbrp10le"):
            # Legacy VC-3 has no 444 variant; DNxHR is the closest that encodes.
            args += ["-c:v", "dnxhd", "-profile:v", "dnxhr_444"]
            interlaced = False
            detail = "DNxHR 444 (legacy DNxHD has no 4:4:4 variant)"
        else:
            ten_bit = _is_ten_bit(pix)
            cids = DNXHD_CIDS.get((width, height, interlaced, ten_bit))
            if cids:
                nominal = _dnxhd_nominal(cids, bit_rate, rep.get("fps"))
                args += ["-c:v", "dnxhd", "-profile:v", "dnxhd",
                         "-b:v", "%dM" % nominal]
                detail = "legacy VC-3 at %d Mbit/s" % nominal
            else:
                # No VC-3 exists at this size/rate, so DNxHR carries it instead.
                prof = "dnxhr_hqx" if ten_bit else "dnxhr_hq"
                args += ["-c:v", "dnxhd", "-profile:v", prof]
                pix = "yuv422p10le" if ten_bit else "yuv422p"
                interlaced = False
                detail = ("%s -- no legacy DNxHD exists at %sx%s"
                          % (prof, width, height))
        if not interlaced:
            ilace_flags = False
            field_mode = None

    elif codec == "mjpeg":
        if profile == "lossless":
            encoder = "ljpeg"
            args += ["-c:v", "ljpeg", "-strict", "-1"]
            if pix == "bgra":
                pix = "bgr24"       # 4-component LJPEG is undecodable
        else:
            encoder = "mjpeg"
            args += ["-c:v", "mjpeg", "-q:v", "2"]
            if pix == "gray":
                pix = "yuvj420p"    # mjpeg would pick yuvj444p for mono
            # Baseline MJPEG cannot be told to interlace at all. The picture is
            # already woven by the filter chain, so only the flags have to go.
            ilace_flags = False

    elif codec == "mpeg4":
        encoder = "mpeg4"
        args += ["-c:v", "mpeg4"]
        prof = MPEG4_PROFILES.get(profile)
        if prof:
            args += ["-profile:v", prof]
        args += ["-q:v", "3"]
        pix = "yuv420p"
        field_mode = "passthrough"

    elif codec == "dvvideo":
        if (width, height, pix) in DV_GEOMETRY:
            encoder = "dvvideo"
            args += ["-c:v", "dvvideo"]
        else:
            # DV only exists at a handful of frame sizes. Once a clip has been
            # conformed away from one there is no DV to write, so H.264 keeps
            # the render alive.
            encoder = "libx264"
            args += ["-c:v", "libx264", "-preset", "medium", "-crf", "16"]
            pix = "yuv420p"
            detail = ("H.264 -- DV has no %sx%s format" % (width, height))

    elif codec == "vp9":
        encoder = "libvpx-vp9"
        args += ["-c:v", "libvpx-vp9", "-crf", "20", "-b:v", "0"]
        ilace_flags, field_mode = False, None
    elif codec == "vp8":
        encoder = "libvpx"
        args += ["-c:v", "libvpx", "-crf", "20", "-b:v", "0"]
        ilace_flags, field_mode = False, None
    elif codec == "av1":
        encoder = "libaom-av1"
        args += ["-c:v", "libaom-av1", "-crf", "30", "-b:v", "0"]
        ilace_flags, field_mode = False, None

    else:
        # Unknown codec: fall back to high-quality H.264 so we still produce
        # something usable rather than failing outright.
        encoder = "libx264"
        detail = "fallback"
        args += ["-c:v", "libx264", "-preset", "medium", "-crf", "16"]
        if interlaced and height and height % 4:
            interlaced = False

    if pix:
        args += ["-pix_fmt", pix]
    if interlaced and (ilace_flags or field_mode):
        if ilace_flags:
            args += ["-flags", "+ilme+ildct"]
        if field_mode == "passthrough":
            args += ["-field_order", field]
        elif field_mode == "ttbb":
            args += ["-field_order", ("tt" if tff else "bb")]

    # Some codecs simply cannot live in some containers.
    container = ext
    bad = ENCODER_BAD_CONTAINERS.get(encoder)
    if bad and container in bad[0]:
        container = bad[1]
    if encoder == "libx264" and container not in H264_CONTAINERS:
        container = ".mp4"

    name = encoder + (" (%s)" % detail if detail else "")
    return {"args": args, "name": name, "encoder": encoder,
            "interlaced": interlaced, "container": container}


# --------------------------------------------------------------------------- #
# Clip planning
# --------------------------------------------------------------------------- #

def plan_clips(sources, opts, rng):
    """
    Decide which random segments to cut.

    `sources` is a list of probe dicts (already filtered to a single format).
    Returns a list of dicts: {path, start, length}.
    """
    min_len = opts["min_len"]
    max_len = opts["max_len"]

    usable = [s for s in sources if s["duration"] >= min_len]
    if not usable:
        raise ValueError(
            "No source video is long enough for the minimum clip length "
            f"({min_len:g}s). Lower the minimum or add longer videos."
        )

    def make_one():
        src = rng.choice(usable)
        hi = min(max_len, src["duration"])
        lo = min(min_len, hi)
        length = rng.uniform(lo, hi)
        latest_start = max(0.0, src["duration"] - length)
        start = rng.uniform(0.0, latest_start)
        return {"path": src["path"],
                "start": round(start, 3),
                "length": round(length, 3),
                # Per-source: set when this file has to be conformed to the
                # chosen output format, None when it already matches.
                "vf": src.get("vf")}

    clips = []
    if opts["mode"] == "count":
        for _ in range(opts["clip_count"]):
            clips.append(make_one())
    else:  # mode == "duration"
        target = opts["total_duration"]
        total = 0.0
        # Every non-final clip is at least min_len long, so this terminates in
        # at most ~target/min_len iterations -- no risk of a zero-length spin.
        while total < target:
            clip = make_one()
            remaining = target - total
            if clip["length"] >= remaining:
                # Final clip: trim it to land on the target exactly, then stop.
                clip["length"] = round(remaining, 3)
                if clip["length"] > 0:
                    clips.append(clip)
                break
            total += clip["length"]
            clips.append(clip)

    if opts["shuffle"]:
        rng.shuffle(clips)
    return clips


# --------------------------------------------------------------------------- #
# Rendering (re-encode to the same codec; clips extracted in parallel)
# --------------------------------------------------------------------------- #

class CompilationRenderer:
    """Runs the ffmpeg extraction + concatenation on a background thread."""

    def __init__(self, sources, opts, msg_queue, cancel_event):
        self.sources = sources
        self.opts = opts
        self.q = msg_queue
        self.cancel = cancel_event
        self._procs = set()
        self._proc_lock = threading.Lock()

    def log(self, text):
        self.q.put(("log", text))

    def progress(self, value, maximum):
        self.q.put(("progress", value, maximum))

    def _run_ffmpeg(self, cmd):
        """Run one ffmpeg process, tracked so cancel() can terminate it."""
        proc = subprocess.Popen(
            cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
            creationflags=_CREATE_NO_WINDOW, text=True,
        )
        with self._proc_lock:
            self._procs.add(proc)
        try:
            _, stderr = proc.communicate()
        finally:
            with self._proc_lock:
                self._procs.discard(proc)
        return proc.returncode, stderr

    def stop(self):
        """Terminate every ffmpeg process currently running."""
        with self._proc_lock:
            procs = list(self._procs)
        for p in procs:
            if p.poll() is None:
                try:
                    p.terminate()
                except Exception:
                    pass

    def run(self):
        try:
            self._run()
        except Exception as exc:  # noqa: BLE001
            self.q.put(("error", str(exc)))

    def _extract_one(self, i, clip, ext, tmp_dir):
        """Extract+re-encode a single clip. Returns (i, path or None)."""
        if self.cancel.is_set():
            return (i, None)
        out_clip = os.path.join(tmp_dir, f"clip_{i:05d}{ext}")
        cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
               "-ss", f"{clip['start']:.3f}", "-i", clip["path"],
               "-t", f"{clip['length']:.3f}",
               "-map", "0:v:0", "-an"]
        if clip.get("vf"):
            cmd += ["-vf", clip["vf"]]
        cmd += (self.opts["encode_args"]
                + ["-r", self.opts["fps_frac"], "-vsync", "cfr", out_clip])
        rc, stderr = self._run_ffmpeg(cmd)
        if self.cancel.is_set():
            return (i, None)
        if rc != 0:
            tail = "\n".join(stderr.strip().splitlines()[-6:])
            raise RuntimeError(f"ffmpeg failed on clip {i}:\n{tail}")
        if os.path.exists(out_clip) and os.path.getsize(out_clip) > 0:
            return (i, out_clip)
        return (i, None)

    def _run(self):
        opts = self.opts
        rng = random.Random(opts["seed"]) if opts["seed"] is not None \
            else random.Random()

        self.log("Planning random clips...")
        clips = plan_clips(self.sources, opts, rng)
        workers = max(1, min(int(opts.get("workers", 1)), len(clips)))
        self.log(f"Planned {len(clips)} clip(s). Re-encoding to "
                 f"'{opts['encoder_name']}' on {workers} parallel worker(s), "
                 "audio removed.")

        ext = opts["container_ext"]
        tmp_dir = tempfile.mkdtemp(prefix="rcm_")
        results = {}        # index -> clip path (kept for ordered concat)
        first_error = None
        try:
            total_steps = len(clips) + 1
            done = 0
            with concurrent.futures.ThreadPoolExecutor(
                    max_workers=workers) as pool:
                futures = {
                    pool.submit(self._extract_one, i, clip, ext, tmp_dir): i
                    for i, clip in enumerate(clips, start=1)
                }
                for fut in concurrent.futures.as_completed(futures):
                    try:
                        idx, path = fut.result()
                    except Exception as exc:  # noqa: BLE001
                        # First failure: remember it and stop the rest.
                        if first_error is None:
                            first_error = exc
                            self.cancel.set()
                            self.stop()
                        continue
                    if self.cancel.is_set() and first_error is None:
                        continue  # user cancelled; drain quietly
                    if path:
                        results[idx] = path
                    done += 1
                    self.log(f"  encoded {done}/{len(clips)}")
                    self.progress(done, total_steps)

            if first_error is not None:
                raise first_error
            if self.cancel.is_set():
                self.q.put(("cancelled", None))
                return

            ordered = [results[i] for i in sorted(results)]
            if not ordered:
                raise RuntimeError("No clips were produced.")

            self.log("Concatenating clips into the final compilation...")
            self._concat(ordered, tmp_dir, opts["output"])
            self.progress(total_steps, total_steps)
            self.q.put(("done", opts["output"]))
        finally:
            shutil.rmtree(tmp_dir, ignore_errors=True)

    def _concat(self, clip_files, tmp_dir, output):
        list_path = os.path.join(tmp_dir, "concat_list.txt")
        with open(list_path, "w", encoding="utf-8") as fh:
            for cf in clip_files:
                safe = cf.replace("\\", "/").replace("'", "'\\''")
                fh.write(f"file '{safe}'\n")

        os.makedirs(os.path.dirname(os.path.abspath(output)), exist_ok=True)
        cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
               "-f", "concat", "-safe", "0", "-i", list_path,
               "-c", "copy", "-an", output]
        rc, stderr = self._run_ffmpeg(cmd)
        if rc != 0:
            tail = "\n".join(stderr.strip().splitlines()[-6:])
            raise RuntimeError(f"Concatenation failed:\n{tail}")


# --------------------------------------------------------------------------- #
# Format-picker dialog (shown when sources have mixed codec / res / fps)
# --------------------------------------------------------------------------- #

class FormatDialog(tk.Toplevel):
    """
    Modal dialog shown when the sources don't all share one format.

    It does two jobs:
      1. Pick the codec / container, resolution and frame rate to RENDER AS.
      2. Include or exclude each source individually. Anything left included
         that doesn't match the pick gets conformed to it; anything unchecked
         is left out of the compilation entirely.

    On success, `result` is (target, included_sources).
    """

    SCALE_MODES = [
        ("Fit -- letterbox / pillarbox (no distortion)", "fit"),
        ("Stretch to fill (ignores aspect ratio)", "stretch"),
        ("Crop to fill (fills the frame, trims edges)", "crop"),
    ]

    def __init__(self, parent, sources):
        super().__init__(parent)
        self.title("Mixed source formats -- choose what to render as")
        self.transient(parent)
        self.geometry("1040x680")
        self.minsize(860, 560)
        self.result = None

        self._sources = sources
        # index -> explicit user include/exclude. Anything absent falls back to
        # "included only if it matches the current pick", so changing the pick
        # re-sorts the untouched rows automatically.
        self._manual = {}

        self.res_items = distinct_resolutions(sources)   # [((w,h), count), ...]
        self.fps_items = distinct_fps(sources)           # [(key, count, disp)]
        self.codec_items = distinct_codecs(sources)      # [(sig, count, rep)]

        self.res_var = tk.StringVar(value=self._res_to_str(self.res_items[0][0]))
        self.fps_var = tk.StringVar(value=str(self.fps_items[0][0]))
        self.codec_var = tk.IntVar(value=0)
        self.scale_var = tk.StringVar(value=self.SCALE_MODES[0][0])

        self._build()
        self._refresh()

        self.grab_set()
        self.protocol("WM_DELETE_WINDOW", self._cancel)
        parent.wait_window(self)

    @staticmethod
    def _res_to_str(res):
        return f"{res[0]}x{res[1]}"

    # ----------------------------------------------------------------- UI -- #
    def _build(self):
        self.columnconfigure(0, weight=1)
        self.rowconfigure(4, weight=1)

        msg = ("Your source videos do not all share one codec, resolution and "
               "frame rate.\nPick the format to RENDER AS, then choose which "
               "sources to keep. A kept source that doesn't\nmatch is "
               "conformed to the pick; an unchecked one is excluded from the "
               "compilation.")
        ttk.Label(self, text=msg, justify="left").grid(
            row=0, column=0, sticky="w", padx=12, pady=(12, 8))

        picks = ttk.Frame(self)
        picks.grid(row=1, column=0, sticky="ew", padx=8)
        for c in range(3):
            picks.columnconfigure(c, weight=1)

        res_frame = ttk.LabelFrame(picks, text="Resolution")
        res_frame.grid(row=0, column=0, sticky="nsew", padx=4)
        for (w, h), count in self.res_items:
            ttk.Radiobutton(
                res_frame, text=f"{w} x {h}   ({count} file(s))",
                value=self._res_to_str((w, h)), variable=self.res_var,
                command=self._refresh,
            ).pack(anchor="w", padx=8, pady=2)

        fps_frame = ttk.LabelFrame(picks, text="Frame rate")
        fps_frame.grid(row=0, column=1, sticky="nsew", padx=4)
        for key, count, disp in self.fps_items:
            ttk.Radiobutton(
                fps_frame, text=f"{disp} fps   ({count} file(s))",
                value=str(key), variable=self.fps_var,
                command=self._refresh,
            ).pack(anchor="w", padx=8, pady=2)

        codec_frame = ttk.LabelFrame(picks, text="Codec / container")
        codec_frame.grid(row=0, column=2, sticky="nsew", padx=4)
        for i, (sig, count, _rep) in enumerate(self.codec_items):
            ttk.Radiobutton(
                codec_frame,
                text=f"{describe_codec_sig(sig)}   ({count} file(s))",
                value=i, variable=self.codec_var, command=self._refresh,
            ).pack(anchor="w", padx=8, pady=2)

        scale_row = ttk.Frame(self)
        scale_row.grid(row=2, column=0, sticky="ew", padx=12, pady=(10, 2))
        ttk.Label(scale_row,
                  text="When a kept clip has a different resolution:").pack(
            side="left")
        ttk.Combobox(scale_row, textvariable=self.scale_var, state="readonly",
                     width=44,
                     values=[label for label, _ in self.SCALE_MODES]).pack(
            side="left", padx=8)

        tools = ttk.Frame(self)
        tools.grid(row=3, column=0, sticky="ew", padx=12, pady=(8, 2))
        ttk.Button(tools, text="Exclude every mismatch",
                   command=self._exclude_mismatched).pack(side="left")
        ttk.Button(tools, text="Keep everything (conform)",
                   command=self._include_all).pack(side="left", padx=6)
        ttk.Button(tools, text="Toggle selected",
                   command=self._toggle_selected).pack(side="left")
        ttk.Label(tools, text="(or click the Use column / press Space)",
                  foreground="#666").pack(side="left", padx=10)

        tree_wrap = ttk.Frame(self)
        tree_wrap.grid(row=4, column=0, sticky="nsew", padx=12, pady=4)
        tree_wrap.rowconfigure(0, weight=1)
        tree_wrap.columnconfigure(0, weight=1)

        cols = ("use", "file", "res", "fps", "codec", "status")
        self.tree = ttk.Treeview(tree_wrap, columns=cols, show="headings",
                                 selectmode="extended")
        for col, head, width, anchor in (
                ("use", "Use", 44, "center"),
                ("file", "File", 330, "w"),
                ("res", "Resolution", 88, "w"),
                ("fps", "FPS", 56, "w"),
                ("codec", "Codec / container", 186, "w"),
                ("status", "Status", 210, "w")):
            self.tree.heading(col, text=head)
            self.tree.column(col, width=width, anchor=anchor, minwidth=44,
                             stretch=(col in ("file", "status")))
        self.tree.grid(row=0, column=0, sticky="nsew")
        tsb = ttk.Scrollbar(tree_wrap, orient="vertical",
                            command=self.tree.yview)
        tsb.grid(row=0, column=1, sticky="ns")
        self.tree.config(yscrollcommand=tsb.set)
        self.tree.tag_configure("excluded", foreground="#999999")
        self.tree.tag_configure("conform", foreground="#a05000")
        self.tree.bind("<Button-1>", self._on_click)
        self.tree.bind("<space>", self._on_space)

        for i in range(len(self._sources)):
            self.tree.insert("", "end", iid=str(i))

        self.summary = ttk.Label(self, text="", justify="left",
                                 foreground="#444")
        self.summary.grid(row=5, column=0, sticky="w", padx=12, pady=(4, 4))

        btns = ttk.Frame(self)
        btns.grid(row=6, column=0, sticky="e", padx=12, pady=(0, 12))
        ttk.Button(btns, text="Cancel", command=self._cancel).pack(side="right")
        self.ok_btn = ttk.Button(btns, text="Render with these settings",
                                 command=self._ok)
        self.ok_btn.pack(side="right", padx=6)

    # ------------------------------------------------------------- state -- #
    def _target(self):
        w, h = (int(x) for x in self.res_var.get().split("x"))
        fpsk = float(self.fps_var.get())
        _sig, _count, rep = self.codec_items[self.codec_var.get()]
        mode = next(v for label, v in self.SCALE_MODES
                    if label == self.scale_var.get())
        return build_target((w, h), fpsk,
                            fps_frac_for_key(self._sources, fpsk), rep, mode)

    def _included(self, index, target):
        """Effective include state: the explicit choice, else 'it matches'."""
        if index in self._manual:
            return self._manual[index]
        return not mismatch_reasons(self._sources[index], target)

    def _refresh(self, *_):
        target = self._target()
        exact = conformed = excluded = 0
        for i, s in enumerate(self._sources):
            reasons = mismatch_reasons(s, target)
            keep = self._included(i, target)
            if not keep:
                status, tag = "excluded", "excluded"
                excluded += 1
            elif reasons:
                status, tag = "conform: " + ", ".join(reasons), "conform"
                conformed += 1
            else:
                status, tag = "match", ""
                exact += 1
            self.tree.item(
                str(i),
                values=("[x]" if keep else "[  ]",
                        os.path.basename(s["path"]),
                        f"{s['width']}x{s['height']}",
                        format_fps(s["fps"]),
                        describe_codec_sig(_format_sig(s)),
                        status),
                tags=(tag,) if tag else ())

        self.summary.config(
            text=f"Render as {target['width']}x{target['height']} @ "
                 f"{format_fps(target['fps'])} fps, "
                 f"{describe_codec_sig(_format_sig(target))}\n"
                 f"{exact} exact match, {conformed} conformed, "
                 f"{excluded} excluded  --  "
                 f"{exact + conformed} of {len(self._sources)} source(s) will "
                 f"be used.")
        self.ok_btn.config(
            state="disabled" if (exact + conformed) == 0 else "normal")

    # ---------------------------------------------------------- toggling -- #
    def _on_click(self, event):
        if self.tree.identify_region(event.x, event.y) != "cell":
            return None
        if self.tree.identify_column(event.x) != "#1":
            return None
        row = self.tree.identify_row(event.y)
        if not row:
            return None
        self._set_manual([int(row)])
        return "break"

    def _on_space(self, _event):
        self._toggle_selected()
        return "break"

    def _set_manual(self, indices):
        target = self._target()
        for i in indices:
            self._manual[i] = not self._included(i, target)
        self._refresh()

    def _toggle_selected(self):
        self._set_manual([int(iid) for iid in self.tree.selection()])

    def _include_all(self):
        self._manual = {i: True for i in range(len(self._sources))}
        self._refresh()

    def _exclude_mismatched(self):
        # Clearing the overrides restores the default rule, which is exactly
        # "keep it only if it matches" -- and it keeps following the pick.
        self._manual.clear()
        self._refresh()

    # -------------------------------------------------------------- exit -- #
    def _ok(self):
        target = self._target()
        included = [s for i, s in enumerate(self._sources)
                    if self._included(i, target)]
        if not included:
            messagebox.showwarning(
                "Nothing to render",
                "Every source is excluded -- keep at least one.", parent=self)
            return
        self.result = (target, included)
        self.destroy()

    def _cancel(self):
        self.result = None
        self.destroy()


# --------------------------------------------------------------------------- #
# Main window
# --------------------------------------------------------------------------- #

class App(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("Random Compilation Maker")
        self.geometry("760x660")
        self.minsize(700, 600)

        self.source_paths = []
        self.msg_queue = queue.Queue()
        self.cancel_event = threading.Event()
        self.renderer = None

        self._build_ui()
        self.after(100, self._poll_queue)

        ok, msg = tools_available()
        if not ok:
            messagebox.showerror("Missing dependencies", msg)
            self.run_btn.config(state="disabled")

    # ------------------------------------------------------------------ UI -- #
    def _build_ui(self):
        pad = dict(padx=8, pady=4)

        # ---- Sources --------------------------------------------------- #
        src = ttk.LabelFrame(self, text="1. Source videos")
        src.pack(fill="both", expand=True, padx=10, pady=(10, 4))

        list_wrap = ttk.Frame(src)
        list_wrap.pack(fill="both", expand=True, **pad)
        self.listbox = tk.Listbox(list_wrap, height=8, selectmode="extended")
        self.listbox.pack(side="left", fill="both", expand=True)
        sb = ttk.Scrollbar(list_wrap, orient="vertical",
                           command=self.listbox.yview)
        sb.pack(side="right", fill="y")
        self.listbox.config(yscrollcommand=sb.set)

        btns = ttk.Frame(src)
        btns.pack(fill="x", **pad)
        ttk.Button(btns, text="Add files...",
                   command=self.add_files).pack(side="left")
        ttk.Button(btns, text="Add folder...",
                   command=self.add_folder).pack(side="left", padx=4)
        ttk.Button(btns, text="Remove selected",
                   command=self.remove_selected).pack(side="left")
        ttk.Button(btns, text="Clear",
                   command=self.clear_sources).pack(side="left", padx=4)
        self.recurse_var = tk.BooleanVar(value=True)
        ttk.Checkbutton(btns, text="Include subfolders",
                        variable=self.recurse_var).pack(side="left", padx=12)
        self.count_label = ttk.Label(btns, text="0 videos")
        self.count_label.pack(side="right")

        # ---- Parameters ------------------------------------------------ #
        params = ttk.LabelFrame(self, text="2. Parameters")
        params.pack(fill="x", padx=10, pady=4)
        for c in range(4):
            params.columnconfigure(c, weight=1)

        self.mode_var = tk.StringVar(value="duration")
        ttk.Radiobutton(params, text="By number of clips", value="count",
                        variable=self.mode_var,
                        command=self._sync_mode).grid(row=0, column=0,
                                                      sticky="w", **pad)
        self.count_spin = ttk.Spinbox(params, from_=1, to=100000, width=8)
        self.count_spin.set(10)
        self.count_spin.grid(row=0, column=1, sticky="w", **pad)

        ttk.Radiobutton(params, text="By total duration (s)", value="duration",
                        variable=self.mode_var,
                        command=self._sync_mode).grid(row=0, column=2,
                                                      sticky="w", **pad)
        self.duration_spin = ttk.Spinbox(params, from_=1, to=1000000, width=8)
        self.duration_spin.set(90)
        self.duration_spin.grid(row=0, column=3, sticky="w", **pad)

        ttk.Label(params, text="Min clip length (s):").grid(
            row=1, column=0, sticky="w", **pad)
        self.min_len_spin = ttk.Spinbox(params, from_=0.1, to=3600,
                                         increment=0.5, width=8)
        self.min_len_spin.set(2.0)
        self.min_len_spin.grid(row=1, column=1, sticky="w", **pad)

        ttk.Label(params, text="Max clip length (s):").grid(
            row=1, column=2, sticky="w", **pad)
        self.max_len_spin = ttk.Spinbox(params, from_=0.1, to=3600,
                                         increment=0.5, width=8)
        self.max_len_spin.set(6.0)
        self.max_len_spin.grid(row=1, column=3, sticky="w", **pad)

        self.shuffle_var = tk.BooleanVar(value=True)
        ttk.Checkbutton(params, text="Shuffle clip order",
                        variable=self.shuffle_var).grid(row=2, column=0,
                                                        sticky="w", **pad)
        ttk.Label(params, text="Random seed (optional):").grid(
            row=2, column=2, sticky="w", **pad)
        self.seed_entry = ttk.Entry(params, width=12)
        self.seed_entry.grid(row=2, column=3, sticky="w", **pad)

        ttk.Label(params, text="Parallel encodes:").grid(
            row=3, column=0, sticky="w", **pad)
        self.workers_spin = ttk.Spinbox(params, from_=1, to=64, width=8)
        self.workers_spin.set(default_workers())
        self.workers_spin.grid(row=3, column=1, sticky="w", **pad)
        ttk.Label(params, text="(how many clips to encode at once)",
                  foreground="#666").grid(row=3, column=2, columnspan=2,
                                          sticky="w", **pad)

        note = ("Output keeps the source resolution, frame rate, field order, "
                "codec and file type. If the\nsources disagree on any of "
                "those, you'll be asked which format to render as and which\n"
                "mismatched clips to exclude. Audio is always removed; clips "
                "are re-encoded, so cuts\nare frame-accurate.")
        ttk.Label(params, text=note, justify="left",
                  foreground="#666").grid(row=4, column=0, columnspan=4,
                                          sticky="w", padx=8, pady=(2, 6))

        # ---- Output ---------------------------------------------------- #
        out = ttk.LabelFrame(self, text="3. Output file")
        out.pack(fill="x", padx=10, pady=4)
        self.output_entry = ttk.Entry(out)
        self.output_entry.pack(side="left", fill="x", expand=True,
                               padx=8, pady=8)
        default_out = os.path.join(os.path.expanduser("~"),
                                   "Videos", "random_compilation.mp4")
        self.output_entry.insert(0, default_out)
        ttk.Button(out, text="Browse...",
                   command=self.choose_output).pack(side="left", padx=8)
        ttk.Label(out, text="(extension auto-matches the source container)",
                  foreground="#666").pack(side="left", padx=(0, 8))

        # ---- Run / progress / log ------------------------------------- #
        runbar = ttk.Frame(self)
        runbar.pack(fill="x", padx=10, pady=4)
        self.run_btn = ttk.Button(runbar, text="Create compilation",
                                  command=self.start)
        self.run_btn.pack(side="left")
        self.cancel_btn = ttk.Button(runbar, text="Cancel",
                                     command=self.cancel, state="disabled")
        self.cancel_btn.pack(side="left", padx=6)
        self.progress = ttk.Progressbar(runbar, mode="determinate")
        self.progress.pack(side="left", fill="x", expand=True, padx=8)

        log_frame = ttk.LabelFrame(self, text="Log")
        log_frame.pack(fill="both", expand=True, padx=10, pady=(4, 10))
        self.log_text = tk.Text(log_frame, height=8, wrap="word",
                                state="disabled")
        self.log_text.pack(side="left", fill="both", expand=True,
                           padx=(8, 0), pady=8)
        lsb = ttk.Scrollbar(log_frame, orient="vertical",
                            command=self.log_text.yview)
        lsb.pack(side="right", fill="y", pady=8)
        self.log_text.config(yscrollcommand=lsb.set)

        self._sync_mode()

    # ------------------------------------------------------ source mgmt -- #
    def add_files(self):
        paths = filedialog.askopenfilenames(
            title="Select video files",
            filetypes=[("Video files",
                        " ".join(f"*{e}" for e in sorted(VIDEO_EXTS))),
                       ("All files", "*.*")],
        )
        self._add_paths(paths)

    def add_folder(self):
        folder = filedialog.askdirectory(title="Select a folder of videos")
        if not folder:
            return
        found = []
        if self.recurse_var.get():
            for root, _, files in os.walk(folder):
                for f in files:
                    if os.path.splitext(f)[1].lower() in VIDEO_EXTS:
                        found.append(os.path.join(root, f))
        else:
            for f in os.listdir(folder):
                full = os.path.join(folder, f)
                if (os.path.isfile(full)
                        and os.path.splitext(f)[1].lower() in VIDEO_EXTS):
                    found.append(full)
        if not found:
            messagebox.showinfo("No videos",
                                "No video files were found in that folder.")
            return
        self._add_paths(found)

    def _add_paths(self, paths):
        for p in paths:
            if p not in self.source_paths:
                self.source_paths.append(p)
                self.listbox.insert("end", p)
        self._update_count()

    def remove_selected(self):
        for idx in reversed(self.listbox.curselection()):
            self.listbox.delete(idx)
            del self.source_paths[idx]
        self._update_count()

    def clear_sources(self):
        self.listbox.delete(0, "end")
        self.source_paths.clear()
        self._update_count()

    def _update_count(self):
        n = len(self.source_paths)
        self.count_label.config(text=f"{n} video{'s' if n != 1 else ''}")

    def choose_output(self):
        path = filedialog.asksaveasfilename(
            title="Save compilation as",
            defaultextension=".mp4",
            initialfile="random_compilation.mp4",
            filetypes=[("Video file", "*.*")],
        )
        if path:
            self.output_entry.delete(0, "end")
            self.output_entry.insert(0, path)

    def _sync_mode(self):
        if self.mode_var.get() == "count":
            self.count_spin.config(state="normal")
            self.duration_spin.config(state="disabled")
        else:
            self.count_spin.config(state="disabled")
            self.duration_spin.config(state="normal")

    # --------------------------------------------------------- validate -- #
    def _gather_params(self):
        """Validate the numeric parameters; returns a partial opts dict."""
        if not self.source_paths:
            raise ValueError("Add at least one source video.")
        try:
            min_len = float(self.min_len_spin.get())
            max_len = float(self.max_len_spin.get())
        except ValueError:
            raise ValueError("Clip lengths must be numbers.")
        if min_len <= 0 or max_len <= 0:
            raise ValueError("Clip lengths must be greater than 0.")
        if min_len > max_len:
            raise ValueError("Min clip length cannot exceed max clip length.")

        mode = self.mode_var.get()
        clip_count, total_duration = 0, 0.0
        if mode == "count":
            try:
                clip_count = int(float(self.count_spin.get()))
            except ValueError:
                raise ValueError("Number of clips must be a whole number.")
            if clip_count < 1:
                raise ValueError("Number of clips must be at least 1.")
        else:
            try:
                total_duration = float(self.duration_spin.get())
            except ValueError:
                raise ValueError("Total duration must be a number.")
            if total_duration <= 0:
                raise ValueError("Total duration must be greater than 0.")

        seed_text = self.seed_entry.get().strip()
        seed = None
        if seed_text:
            try:
                seed = int(seed_text)
            except ValueError:
                seed = seed_text

        try:
            workers = int(float(self.workers_spin.get()))
        except ValueError:
            raise ValueError("Parallel encodes must be a whole number.")
        if workers < 1:
            raise ValueError("Parallel encodes must be at least 1.")

        output = self.output_entry.get().strip()
        if not output:
            raise ValueError("Choose an output file.")

        return {
            "mode": mode, "clip_count": clip_count,
            "total_duration": total_duration,
            "min_len": min_len, "max_len": max_len,
            "shuffle": self.shuffle_var.get(), "seed": seed,
            "workers": workers, "output": output,
        }

    # -------------------------------------------------------------- run -- #
    def start(self):
        try:
            self._pending_opts = self._gather_params()
        except ValueError as exc:
            messagebox.showerror("Check your settings", str(exc))
            return

        self._set_running(True)
        self._clear_log()
        self.cancel_event.clear()
        self.progress.config(value=0, maximum=100)

        sources = list(self.source_paths)

        def probe_worker():
            self.msg_queue.put(("log", "Probing source videos..."))
            good, bad = [], []
            for p in sources:
                if self.cancel_event.is_set():
                    self.msg_queue.put(("cancelled", None))
                    return
                info = probe_video(p)
                (good if info else bad).append(info if info else p)
            for p in bad:
                self.msg_queue.put(("log", f"  skipped (unreadable): {p}"))
            if not good:
                self.msg_queue.put(
                    ("error", "None of the sources could be read as video."))
                return
            # Hand back to the main thread (dialogs must run on the GUI thread).
            self.msg_queue.put(("probed", good))

        threading.Thread(target=probe_worker, daemon=True).start()

    def _after_probe(self, good):
        """Runs on the GUI thread: resolve format, maybe ask, then render."""
        res_items = distinct_resolutions(good)
        fps_items = distinct_fps(good)
        codec_items = distinct_codecs(good)

        self._append_log(
            f"{len(good)} readable source(s). "
            f"Resolutions found: {len(res_items)}; frame rates found: "
            f"{len(fps_items)}; codec/container combinations found: "
            f"{len(codec_items)}.")

        if len(res_items) > 1 or len(fps_items) > 1 or len(codec_items) > 1:
            # Call out the mismatch in the log, then ask what to render as.
            self._append_log("Mixed formats detected:")
            for (w, h), c in res_items:
                self._append_log(f"   resolution {w}x{h}: {c} file(s)")
            for _k, c, disp in fps_items:
                self._append_log(f"   frame rate {disp} fps: {c} file(s)")
            for sig, c, _rep in codec_items:
                self._append_log(f"   {describe_codec_sig(sig)}: {c} file(s)")

            dlg = FormatDialog(self, good)
            if dlg.result is None:
                self._append_log("Cancelled (no format chosen).")
                self._set_running(False)
                return
            target, kept = dlg.result
        else:
            rep = good[0]
            target = build_target((rep["width"], rep["height"]),
                                  rep["fps_key"], rep["fps_frac"], rep)
            kept = list(good)

        if not kept:
            self._append_log("Nothing left to compile after filtering.")
            self._set_running(False)
            return

        ext = target["ext"]
        profile = target.get("profile")
        field = target.get("field_order")
        kept_paths = {s["path"] for s in kept}
        excluded = [s for s in good if s["path"] not in kept_paths]

        self._append_log(
            f"Rendering as {target['width']}x{target['height']} @ "
            f"{format_fps(target['fps'])} fps, codec '{target['codec']}'"
            + (f" profile '{profile}'" if profile else "")
            + f", field order '{field}', container '{ext}'.")

        # Work out per source whether it needs conforming to that target.
        conformed = 0
        for s in kept:
            filters = build_conform_filters(s, target)
            s["vf"] = ",".join(filters) if filters else None
            if filters:
                conformed += 1
                self._append_log(
                    f"   conforming ({', '.join(mismatch_reasons(s, target))}): "
                    f"{os.path.basename(s['path'])} "
                    f"[{s['width']}x{s['height']} @ {format_fps(s['fps'])}, "
                    f"{describe_codec_sig(_format_sig(s))}]")

        self._append_log(
            f"Included: {len(kept)} file(s) -- {len(kept) - conformed} exact, "
            f"{conformed} conformed. Excluded: {len(excluded)} file(s).")
        for s in excluded:
            why = ", ".join(mismatch_reasons(s, target)) or "user choice"
            self._append_log(
                f"   excluded ({why}): {os.path.basename(s['path'])} "
                f"[{s['width']}x{s['height']} @ {format_fps(s['fps'])}, "
                f"{describe_codec_sig(_format_sig(s))}]")

        # Resolve the encoder first: a few codecs cannot be muxed into their
        # own source container, and the answer decides the output extension.
        enc = build_video_encode_args(target)
        encode_args = enc["args"]
        encoder_name = enc["name"]
        if enc["container"] != ext:
            self._append_log(
                f"Container changed from '{ext}' to '{enc['container']}' -- "
                f"{enc['encoder']} cannot be written into '{ext}'.")
            ext = enc["container"]

        self._append_log(
            f"Re-encoding with '{encoder_name}'"
            + (f" ({profile})" if profile else "")
            + f", pix_fmt '{target.get('pix_fmt')}', "
            + (f"interlaced ({field})." if enc["interlaced"] else "progressive."))

        # Force the output extension to match the chosen container.
        out = self._pending_opts["output"]
        new_out = os.path.splitext(out)[0] + ext
        if new_out != out:
            self._append_log(f"Output container set to '{ext}': {new_out}")
        self._pending_opts["output"] = new_out
        self.output_entry.delete(0, "end")
        self.output_entry.insert(0, new_out)

        opts = dict(self._pending_opts)
        opts["container_ext"] = ext
        opts["encode_args"] = encode_args
        opts["encoder_name"] = encoder_name
        opts["fps_frac"] = target["fps_frac"]

        def render_worker():
            self.renderer = CompilationRenderer(
                kept, opts, self.msg_queue, self.cancel_event)
            self.renderer.run()

        threading.Thread(target=render_worker, daemon=True).start()

    def cancel(self):
        self.cancel_event.set()
        if self.renderer:
            self.renderer.stop()
        self._append_log("Cancelling...")

    # ----------------------------------------------------- queue/log -- #
    def _poll_queue(self):
        try:
            while True:
                msg = self.msg_queue.get_nowait()
                kind = msg[0]
                if kind == "log":
                    self._append_log(msg[1])
                elif kind == "probed":
                    self._after_probe(msg[1])
                elif kind == "progress":
                    _, value, maximum = msg
                    self.progress.config(maximum=maximum, value=value)
                elif kind == "done":
                    self._append_log(f"Done! Saved to:\n{msg[1]}")
                    self._set_running(False)
                    if messagebox.askyesno(
                            "Compilation ready",
                            f"Saved to:\n{msg[1]}\n\nOpen its folder now?"):
                        self._open_folder(msg[1])
                elif kind == "cancelled":
                    self._append_log("Cancelled.")
                    self._set_running(False)
                elif kind == "error":
                    self._append_log("ERROR: " + msg[1])
                    self._set_running(False)
                    messagebox.showerror("Error", msg[1])
        except queue.Empty:
            pass
        self.after(100, self._poll_queue)

    def _open_folder(self, path):
        folder = os.path.dirname(os.path.abspath(path))
        try:
            if os.name == "nt":
                os.startfile(folder)  # noqa: S606
            elif sys.platform == "darwin":
                subprocess.Popen(["open", folder])
            else:
                subprocess.Popen(["xdg-open", folder])
        except Exception:
            pass

    def _set_running(self, running):
        self.run_btn.config(state="disabled" if running else "normal")
        self.cancel_btn.config(state="normal" if running else "disabled")

    def _append_log(self, text):
        self.log_text.config(state="normal")
        self.log_text.insert("end", text + "\n")
        self.log_text.see("end")
        self.log_text.config(state="disabled")

    def _clear_log(self):
        self.log_text.config(state="normal")
        self.log_text.delete("1.0", "end")
        self.log_text.config(state="disabled")


def main():
    App().mainloop()


if __name__ == "__main__":
    main()
