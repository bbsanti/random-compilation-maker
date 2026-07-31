"""Generate ground-truth fixtures from the original Python implementation.

core.js is checked against these by test_core.html, so the browser edition is
verified to make the same ffmpeg decisions as the desktop tool.

Run from anywhere:  python tests/gen_fixtures.py
It rewrites tests/fixtures.js in place.
"""
import importlib.util
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SRC = os.path.join(ROOT, "random_compilation_maker.py")

spec = importlib.util.spec_from_file_location("rcm", SRC)
rcm = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rcm)


def src(path, w, h, fps, codec, ext, field="progressive", profile=None,
        pix="yuv420p", bit_rate=None, duration=60.0):
    return {
        "path": path,
        "duration": duration,
        "width": w,
        "height": h,
        "fps": fps,
        "fps_key": rcm.fps_key(fps),
        "fps_frac": FRACS[round(fps, 2)],
        "codec": codec,
        "field_order": field,
        "pix_fmt": pix,
        "profile": profile,
        "bit_rate": bit_rate,
        "ext": ext,
    }


FRACS = {
    23.98: "24000/1001",
    29.97: "30000/1001",
    24.0: "24/1",
    25.0: "25/1",
    29.97: "30000/1001",
    30.0: "30/1",
    50.0: "50/1",
    59.94: "60000/1001",
    60.0: "60/1",
}

SOURCES = [
    src("a_h264_1080p2997.mp4", 1920, 1080, 29.97, "h264", ".mp4",
        profile="High", bit_rate="8000000"),
    src("b_h264_720p30.mp4", 1280, 720, 30.0, "h264", ".mp4",
        profile="High", bit_rate="4000000"),
    src("c_mpeg2_ntsc_tt.mpg", 720, 480, 29.97, "mpeg2video", ".mpg",
        field="tt", profile="Main", pix="yuv420p", bit_rate="6000000"),
    src("d_prores_hq_1080p25.mov", 1920, 1080, 25.0, "prores", ".mov",
        profile="HQ", pix="yuv422p10le", bit_rate="176000000"),
    src("e_hevc_2160p60.mkv", 3840, 2160, 60.0, "hevc", ".mkv",
        profile="Main 10", pix="yuv420p10le", bit_rate="40000000"),
    src("f_vp9_720p30.webm", 1280, 720, 30.0, "vp9", ".webm", pix="yuv420p"),
    src("g_dnxhd_1080i5994.mxf", 1920, 1080, 29.97, "dnxhd", ".mxf",
        field="bb", pix="yuv422p"),
    src("h_mjpeg_pal.avi", 720, 576, 25.0, "mjpeg", ".avi", pix="yuvj420p"),
    src("i_mpeg4_480p.avi", 640, 480, 23.98, "mpeg4", ".avi", pix="yuv420p"),
    src("j_dv_pal.dv", 720, 576, 25.0, "dvvideo", ".dv", field="bb", pix="yuv420p"),
    src("k_av1_1080p24.mkv", 1920, 1080, 24.0, "av1", ".mkv", pix="yuv420p"),
    src("l_weird_1080p50.mov", 1920, 1080, 50.0, "cinepak", ".mov", pix="rgb24"),
    src("m_prores_4444_2160p24.mov", 3840, 2160, 24.0, "prores", ".mov",
        profile="4444", pix="yuva444p10le"),
]

TARGET_SPECS = [
    # (resolution, fps, codec-rep index, scale mode)
    ((1920, 1080), 29.97, 0, "fit"),
    ((1920, 1080), 29.97, 0, "stretch"),
    ((1920, 1080), 29.97, 0, "crop"),
    ((720, 480), 29.97, 2, "fit"),        # interlaced mpeg2 target
    ((1920, 1080), 25.0, 3, "fit"),       # prores target
    ((1920, 1080), 29.97, 6, "crop"),     # interlaced dnxhd target (bff)
    ((1280, 720), 30.0, 1, "fit"),
    ((3840, 2160), 60.0, 4, "stretch"),
]

out = {"sources": SOURCES, "cases": [], "encode": [], "groups": {}, "misc": {}}

for res, fps, rep_i, mode in TARGET_SPECS:
    rep = SOURCES[rep_i]
    target = rcm.build_target(res, rcm.fps_key(fps), FRACS[round(fps, 2)], rep, mode)
    case = {
        "res": list(res),
        "fps": rcm.fps_key(fps),
        "fps_frac": FRACS[round(fps, 2)],
        "rep": rep_i,
        "scale_mode": mode,
        "target": target,
        "per_source": [],
    }
    for s in SOURCES:
        case["per_source"].append({
            "path": s["path"],
            "reasons": rcm.mismatch_reasons(s, target),
            "filters": rcm.build_conform_filters(s, target),
        })
    out["cases"].append(case)

# Every codec/profile combination the encoder tables know about, so the two
# editions are held to the same ffmpeg arguments for all of them.
PROFILE_SOURCES = [
    # ProRes, all six profiles + an interlaced one
    src("pr_proxy.mov", 1920, 1080, 25.0, "prores", ".mov", profile="Proxy", pix="yuv422p10le"),
    src("pr_lt.mov", 1920, 1080, 25.0, "prores", ".mov", profile="LT", pix="yuv422p10le"),
    src("pr_std.mov", 1920, 1080, 25.0, "prores", ".mov", profile="Standard", pix="yuv422p10le"),
    src("pr_hq.mov", 1920, 1080, 25.0, "prores", ".mov", profile="HQ", pix="yuv422p10le"),
    src("pr_4444.mov", 1920, 1080, 25.0, "prores", ".mov", profile="4444", pix="yuva444p12le"),
    src("pr_xq.mov", 1920, 1080, 25.0, "prores", ".mov", profile="XQ", pix="yuva444p12le"),
    src("pr_4444_noalpha.mov", 1920, 1080, 25.0, "prores", ".mov", profile="4444", pix="yuv444p12le"),
    src("pr_lt_ilace.mov", 720, 576, 25.0, "prores", ".mov", profile="LT",
        pix="yuv422p10le", field="tt"),
    src("pr_unknown.mov", 1920, 1080, 25.0, "prores", ".mov", profile=None, pix="yuv422p10le"),
    src("pr_in_mp4.mp4", 1920, 1080, 25.0, "prores", ".mp4", profile="HQ", pix="yuv422p10le"),

    # DNxHR, all five
    src("dnxhr_lb.mxf", 1920, 1080, 25.0, "dnxhd", ".mxf", profile="DNXHR LB", pix="yuv422p"),
    src("dnxhr_sq.mxf", 1920, 1080, 25.0, "dnxhd", ".mxf", profile="DNXHR SQ", pix="yuv422p"),
    src("dnxhr_hq.mxf", 1920, 1080, 25.0, "dnxhd", ".mxf", profile="DNXHR HQ", pix="yuv422p"),
    src("dnxhr_hqx.mxf", 1920, 1080, 25.0, "dnxhd", ".mxf", profile="DNXHR HQX", pix="yuv422p10le"),
    src("dnxhr_444.mxf", 1920, 1080, 25.0, "dnxhd", ".mxf", profile="DNXHR 444", pix="yuv444p10le"),
    # Legacy VC-3: a valid CID geometry, an interlaced one, and one with none
    src("vc3_1080p.mxf", 1920, 1080, 25.0, "dnxhd", ".mxf", profile="DNXHD",
        pix="yuv422p", bit_rate="185000000"),
    src("vc3_1080i.mxf", 1920, 1080, 25.0, "dnxhd", ".mxf", profile="DNXHD",
        pix="yuv422p", field="tt", bit_rate="185000000"),
    src("vc3_720p.mxf", 1280, 720, 50.0, "dnxhd", ".mxf", profile="DNXHD",
        pix="yuv422p", bit_rate="110000000"),
    src("vc3_odd.mxf", 1024, 576, 25.0, "dnxhd", ".mxf", profile="DNXHD",
        pix="yuv422p", bit_rate="185000000"),
    src("vc3_nobitrate.mxf", 1920, 1080, 25.0, "dnxhd", ".mxf", profile="DNXHD",
        pix="yuv422p", bit_rate=None),

    # H.264 profile ladder, plus the pixel-format floor and the height guard
    src("h264_cb.mp4", 1920, 1080, 25.0, "h264", ".mp4", profile="Constrained Baseline"),
    src("h264_base.mp4", 1920, 1080, 25.0, "h264", ".mp4", profile="Baseline"),
    src("h264_main.mp4", 1920, 1080, 25.0, "h264", ".mp4", profile="Main"),
    src("h264_ext.mp4", 1920, 1080, 25.0, "h264", ".mp4", profile="Extended"),
    src("h264_high.mp4", 1920, 1080, 25.0, "h264", ".mp4", profile="High"),
    src("h264_h10.mp4", 1920, 1080, 25.0, "h264", ".mp4", profile="High 10", pix="yuv420p10le"),
    src("h264_h422.mp4", 1920, 1080, 25.0, "h264", ".mp4", profile="High 4:2:2", pix="yuv422p10le"),
    src("h264_h444.mp4", 1920, 1080, 25.0, "h264", ".mp4", profile="High 4:4:4 Predictive",
        pix="yuv444p"),
    src("h264_intra.mp4", 1920, 1080, 25.0, "h264", ".mp4", profile="High 4:2:2 Intra",
        pix="yuv422p10le"),
    # Baseline claimed but 4:2:2 pixels -> the floor has to raise the ceiling
    src("h264_floor.mp4", 1920, 1080, 25.0, "h264", ".mp4", profile="Baseline", pix="yuv422p"),
    src("h264_gray.mp4", 1920, 1080, 25.0, "h264", ".mp4", profile="Baseline", pix="gray"),
    src("h264_ilace.mp4", 720, 576, 25.0, "h264", ".mp4", profile="Main", field="tt"),
    src("h264_ilace_h362.mp4", 640, 362, 25.0, "h264", ".mp4", profile="Main", field="tt"),
    src("h264_unknown.mp4", 1920, 1080, 25.0, "h264", ".mp4", profile="Weird Profile"),

    # HEVC
    src("hevc_main.mkv", 1920, 1080, 25.0, "hevc", ".mkv", profile="Main"),
    src("hevc_m10.mkv", 1920, 1080, 25.0, "hevc", ".mkv", profile="Main 10", pix="yuv420p10le"),
    src("hevc_m10_8bit.mkv", 1920, 1080, 25.0, "hevc", ".mkv", profile="Main 10", pix="yuv420p"),
    src("hevc_msp.mkv", 1920, 1080, 25.0, "hevc", ".mkv", profile="Main Still Picture",
        pix="yuv420p10le"),
    src("hevc_rext8.mkv", 1920, 1080, 25.0, "hevc", ".mkv", profile="Rext", pix="yuv420p"),
    src("hevc_rext10.mkv", 1920, 1080, 25.0, "hevc", ".mkv", profile="Rext", pix="yuv420p10le"),
    src("hevc_rext422.mkv", 1920, 1080, 25.0, "hevc", ".mkv", profile="Rext", pix="yuv422p"),
    src("hevc_9bit.mkv", 1920, 1080, 25.0, "hevc", ".mkv", profile="Rext", pix="yuv420p9le"),

    # MPEG-2 / MPEG-1
    src("m2_main.mpg", 720, 576, 25.0, "mpeg2video", ".mpg", profile="Main",
        bit_rate="6000000"),
    src("m2_422.mxf", 1920, 1080, 25.0, "mpeg2video", ".mxf", profile="4:2:2",
        pix="yuv422p", bit_rate="50000000"),
    src("m2_high.mpg", 720, 576, 25.0, "mpeg2video", ".mpg", profile="High",
        pix="yuv422p", bit_rate="15000000"),
    src("m2_simple.mpg", 352, 288, 25.0, "mpeg2video", ".mpg", profile="Simple",
        bit_rate="1500000"),
    src("m2_422pix_on_main.mpg", 720, 576, 25.0, "mpeg2video", ".mpg", profile="Main",
        pix="yuv422p", bit_rate="6000000"),
    src("m2_nobitrate.mkv", 720, 576, 25.0, "mpeg2video", ".mkv", profile="Main",
        bit_rate=None),
    src("m2_ilace_bt.mpg", 720, 576, 25.0, "mpeg2video", ".mpg", profile="Main",
        field="bt", bit_rate="6000000"),
    src("m2_ilace_tb.mpg", 720, 576, 25.0, "mpeg2video", ".mpg", profile="Main",
        field="tb", bit_rate="6000000"),
    src("m1.mpg", 352, 288, 25.0, "mpeg1video", ".mpg", profile=None,
        bit_rate="1150000"),

    # MPEG-4
    src("mp4v_simple.avi", 640, 480, 25.0, "mpeg4", ".avi", profile="Simple Profile"),
    src("mp4v_asp.avi", 640, 480, 25.0, "mpeg4", ".avi", profile="Advanced Simple Profile"),
    src("mp4v_studio.avi", 640, 480, 25.0, "mpeg4", ".avi", profile="Simple Studio Profile"),
    src("mp4v_core.avi", 640, 480, 25.0, "mpeg4", ".avi", profile="Core Profile"),

    # MJPEG
    src("mj_base.avi", 720, 576, 25.0, "mjpeg", ".avi", profile="Baseline", pix="yuvj420p"),
    src("mj_gray.avi", 720, 576, 25.0, "mjpeg", ".avi", profile="Baseline", pix="gray"),
    src("mj_lossless.avi", 720, 576, 25.0, "mjpeg", ".avi", profile="Lossless", pix="yuv420p"),
    src("mj_lossless_bgra.mov", 720, 576, 25.0, "mjpeg", ".mov", profile="Lossless", pix="bgra"),
    src("mj_ilace.mov", 720, 576, 25.0, "mjpeg", ".mov", profile="Baseline",
        pix="yuvj420p", field="tt"),

    # DV: a legal geometry and one it has been conformed away from
    src("dv_pal.dv", 720, 576, 25.0, "dvvideo", ".dv", profile=None, pix="yuv420p"),
    src("dv_ntsc.dv", 720, 480, 29.97, "dvvideo", ".dv", profile=None, pix="yuv411p"),
    src("dv_resized.avi", 640, 480, 25.0, "dvvideo", ".avi", profile=None, pix="yuv420p"),

    # VP8 / VP9 / AV1 / unknown
    src("vp9_p0.webm", 1920, 1080, 25.0, "vp9", ".webm", profile="Profile 0"),
    src("vp9_p2.webm", 1920, 1080, 25.0, "vp9", ".webm", profile="Profile 2", pix="yuv420p10le"),
    src("vp8.webm", 1920, 1080, 25.0, "vp8", ".webm", profile="0"),
    src("vp8_in_mp4.mp4", 1920, 1080, 25.0, "vp8", ".mp4", profile="0"),
    src("av1.mkv", 1920, 1080, 25.0, "av1", ".mkv", profile="Main"),
    src("weird.mov", 1920, 1080, 25.0, "cinepak", ".mov", profile=None, pix="rgb24"),
    src("weird_ilace_h362.mov", 640, 362, 25.0, "cinepak", ".mov", profile=None,
        pix="rgb24", field="tt"),
]

out["profile_sources"] = PROFILE_SOURCES

for i, s in enumerate(SOURCES):
    enc = rcm.build_video_encode_args(s)
    out["encode"].append({
        "rep": i,
        "path": s["path"],
        "args": enc["args"],
        "name": enc["name"],
        "interlaced": enc["interlaced"],
        "encoder": enc["encoder"],
        "container": enc["container"],
    })

out["profile_encode"] = []
for i, s in enumerate(PROFILE_SOURCES):
    enc = rcm.build_video_encode_args(s)
    out["profile_encode"].append({
        "rep": i,
        "path": s["path"],
        "args": enc["args"],
        "name": enc["name"],
        "interlaced": enc["interlaced"],
        "encoder": enc["encoder"],
        "container": enc["container"],
    })

out["groups"] = {
    "resolutions": [[list(res), n] for res, n in rcm.distinct_resolutions(SOURCES)],
    "fps": [[k, n, d] for k, n, d in rcm.distinct_fps(SOURCES)],
    "codecs": [[rcm.describe_codec_sig(sig), n] for sig, n, _rep in rcm.distinct_codecs(SOURCES)],
}

out["misc"] = {
    "format_fps": [[v, rcm.format_fps(v)] for v in
                   (23.98, 24.0, 25.0, 29.97, 30.0, 59.94, 60.0, 29.999, 12.5)],
    "fps_key": [[v, rcm.fps_key(v)] for v in
                (23.976, 29.97002997, 30.0, 59.9400599, 25.0)],
    "double_fraction": [[f, rcm.double_fraction(f)] for f in
                        ("30000/1001", "25/1", "24000/1001", "50", "")],
    "describe_codec_sig": [[list(rcm._format_sig(s)), rcm.describe_codec_sig(rcm._format_sig(s))]
                           for s in SOURCES],
}

dest = os.path.join(HERE, "fixtures.js")
with open(dest, "w", encoding="utf-8") as fh:
    fh.write("/* Ground truth generated from random_compilation_maker.py "
             "by tests/gen_fixtures.py. */\n")
    fh.write("window.RCM_FIXTURES = ")
    json.dump(out, fh, indent=1)
    fh.write(";\n")
print("wrote", dest)
print("cases:", len(out["cases"]), "encode:", len(out["encode"]))
