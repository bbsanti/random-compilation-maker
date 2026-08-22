# Random Compilation Maker

Takes one or more video files (or a whole folder of videos), cuts random clips out of them, and stitches those
clips into a single random "compilation" video.

There are two editions in this repo, and they behave the same way:

| | `random_compilation_maker.py` | the web page |
|---|---|---|
| Interface | tkinter desktop window | any modern browser |
| FFmpeg | must already be on your `PATH` | downloads itself once, on first use |
| Where the video goes | nowhere — local `ffmpeg` | nowhere — local WebAssembly `ffmpeg` |
| Speed | native, fast | WebAssembly, roughly 3–10× slower |

The web edition is a static site, so it can be hosted on GitHub Pages — but **nothing is uploaded**. GitHub Pages
only serves the HTML and JavaScript. Your videos are read straight off your own disk into a copy of FFmpeg running
inside the browser tab, and the finished file is written back to your disk. The page makes exactly one network
request beyond its own files: the one-time FFmpeg download described below.

## How it behaves

* The output is **one** codec, **one** resolution and **one** frame rate. If the sources disagree on any of those,
  a dialog appears that (a) makes you pick which format to render as and (b) lets you include or exclude each
  source individually. A mismatched source you keep is conformed to the pick (scaled, retimed, de/re-interlaced);
  one you uncheck is left out entirely.
* Audio is always removed.
* Each clip is **re-encoded** to the chosen codec, **profile**, resolution, frame rate and field order, so cuts are
  frame-accurate and the result is a clean constant-frame-rate file.
* You can cut by **number of clips** or by **total duration**, set the minimum and maximum clip length, shuffle
  the order, and set a seed to make a run reproducible.

## Codec and profile fidelity

**A clip comes back out as the codec and profile it went in as.** ProRes LT stays ProRes LT; it does not quietly
become ProRes 422. Profiles are matched on the exact string ffprobe reports, per codec:

| codec | profiles preserved |
|---|---|
| ProRes | Proxy, LT, Standard, HQ, 4444, XQ — alpha included |
| DNxHR | LB, SQ, HQ, HQX, 444 |
| DNxHD (VC-3) | reproduced at the nearest legal CID bit rate for the output size |
| H.264 | Constrained Baseline, Main, High, High 10, High 4:2:2, High 4:4:4 |
| HEVC | Main, Main 10, Rext (incl. the intra profiles) |
| MPEG-2 | Simple, Main, High, 4:2:2, and both scalable profiles |
| MPEG-4 Part 2 | all 15 named profiles, Advanced Simple included |
| MPEG-1, MJPEG (Baseline and Lossless), DV, VP8, VP9, AV1 | codec preserved; these have no profile to lose |

Each mapping was established by encoding a real file in that profile, re-encoding it with the candidate
arguments and requiring ffprobe to report the identical codec and profile back — `tests/gen_fixtures.py` and
`test_profiles.html` keep it that way.

A few combinations genuinely cannot be reproduced, and in every one of them the tool picks the nearest
neighbour **and says so in the log** rather than exiting:

* A source conformed to a frame size its codec has no format for — DV away from 720×576, legacy DNxHD away from
  a CID size. DV becomes H.264; DNxHD becomes the matching DNxHR profile.
* H.264 plain Baseline, Extended, and the `… Intra` variants, which x264 cannot signal.
* Interlaced H.264 whose output height is not a multiple of 4 — x264 refuses it, so the clip goes progressive.
* Codecs that cannot be muxed into the source's own container (ProRes in `.mp4`, for one): the output extension
  is changed to one that works.

## Installing FFmpeg

The page needs FFmpeg, and installs it for you the first time you use it — the same approach
[fabinator-weakframes](https://github.com/bbsanti/fabinator-weakframes) uses:

1. If a `vendor/` folder sits next to `index.html`, the copy in there wins. Nothing leaves your network.
2. Otherwise the pinned build `@ffmpeg/core@0.12.6` (~31 MB) is fetched from unpkg, falling back to jsDelivr.

The difference from the reference app is what happens next: the download is written into **Cache Storage** under
`rcm-ffmpeg-core-0.12.6`, not just left to the ordinary HTTP cache. That makes "installed" a real, reportable
state — the header shows the installed size, the **Install FFmpeg** button re-downloads on demand, and **Remove**
deletes it. After the first install the page works with no network connection at all.

The FFmpeg *wrapper* (`@ffmpeg/ffmpeg@0.12.10`) is vendored in `lib/ffmpeg/` rather than loaded from a CDN,
because it must be same-origin — its Web Worker chunk cannot be constructed cross-origin.

### Fully offline install

Drop the two core files into a `vendor/` folder and the page will never touch a CDN:

```
vendor/ffmpeg-core.js
vendor/ffmpeg-core.wasm
```

Get them from `https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd/`.

## Publishing to GitHub Pages

The site is the repository root, so there is nothing to build:

1. Push this folder to a GitHub repository.
2. **Settings → Pages → Build and deployment**, set *Source* to **Deploy from a branch**, and pick your branch
   with folder **/ (root)**.
3. Open `https://<user>.github.io/<repo>/`.

`.nojekyll` is present so GitHub serves `lib/` as-is.

## Running it locally

The page needs `http://` or `https://` — opening `index.html` as a `file://` URL will not work, because browsers
block the Web Workers and cross-origin fetches FFmpeg needs. From this folder:

```
python -m http.server 8000
```

then open `http://localhost:8000/`.

## Where the file ends up

The output container follows the sources, so the output **name** does too: add a folder of ProRes `.mov` files and
the name becomes `random_compilation.mov` straight away, before you pick anywhere to save it. That matters because
a save location chosen through *Choose location…* is a file with a fixed name, and the browser cannot rename it
later — pick `.mp4` and you would get a QuickTime file wearing an `.mp4` extension.

If the container still turns out differently once the sources have been probed (mixed formats, or an encoder this
build cannot run), the app refuses to write to the stale location, says so in the log, and hands you the
compilation as a correctly named download with a *Save somewhere else…* button.

* **Chrome / Edge** — everything, including *Choose location…*, which writes the finished file straight to a path
  you pick (File System Access API).
* **Firefox / Safari** — everything except that picker; the compilation arrives as a normal download instead.
* Folder input uses `webkitdirectory`, and dropping a folder onto the page works in Chromium browsers.

## When it will not fit in a tab

The whole compilation is held in memory while it renders, so there is a size ceiling. Rather than refuse, the
app works out what *would* fit and asks. For 90 seconds of 1080p ProRes HQ — about 2 GB, well past the limit —
it offers:

```
Render as ProRes Proxy    (435 MB)  full length and frame size, about 21% of the data rate
Render at 960 x 540       (732 MB)  full length, same codec and profile, half size
Render at 640 x 360       (399 MB)  full length, same codec and profile, a third of the size
Shorten to 39 seconds     (897 MB)  the only option that keeps the codec, profile and frame size exactly
```

Full-length options come first, because the duration is something you typed in while the codec profile and frame
size were derived from your footage automatically — so those are the less presumptuous things to change. Whatever
you pick, the log states plainly what was changed and why; a lighter profile is called out as **deliberately not
the source profile**, since it breaks the fidelity guarantee above.

Measured ProRes data rates, grain-heavy 1080p25 material (consistent with Apple's published figures):

| profile | Mbit/s | 90 seconds | relative to HQ |
|---|---|---|---|
| Proxy | 40 | 431 MB | 0.21× |
| LT | 89 | 956 MB | 0.46× |
| Standard | 128 | 1377 MB | 0.66× |
| HQ | 193 | 2072 MB | 1.00× |

Your own footage may sit well below these — ProRes is content-adaptive, and flat or graphic material compresses
far better than grain. The app always estimates from your sources' actual probed bit rate, so the numbers it
shows are for your files, not this table. Note also that bit rate falls off *sublinearly* with frame size: half
the width and height is roughly a third of the data, not a quarter.

## Things worth knowing

* **It is slower than the desktop tool.** WebAssembly FFmpeg is single-threaded per instance. *Parallel encodes*
  runs several FFmpeg instances at once, which does help, but each one is a separate Web Worker with its own
  memory — 2–4 is a sensible range.
* **Memory is the real limit.** Source files are mounted with WORKERFS and read lazily, so a large *source* is
  fine. The output is the problem: peak usage is about twice the finished file, and a browser tab has no temp
  folder to fall back on. The app estimates the size from the target bit rate before it starts, warns over
  ~300 MB, and over ~900 MB offers you smaller alternatives instead of failing (see below). The desktop version
  has no ceiling at all — it writes clips to a temp folder on disk.
* **Three codecs cannot be re-encoded in the browser at all.** The WebAssembly build lists `libx265`,
  `libvpx-vp9` and `mjpeg`, but none of them actually work in it: libx265 never returns even on a five-frame
  clip, and the other two abort the WebAssembly heap. The page treats them as missing, so an HEVC, VP9 or
  baseline-MJPEG source falls back to H.264 **with a message in the log** instead of hanging the tab. `libaom-av1`
  is genuinely absent, so AV1 falls back too. Everything else — ProRes, DNxHD/DNxHR, H.264, MPEG-1/2/4, DV and
  MJPEG *Lossless* — encodes correctly, at full profile fidelity. The header chips show what the loaded build has.
  The desktop version has none of these limits; it uses your own ffmpeg.
* **Seeds are per-edition.** A seed reproduces the same compilation reliably within the browser, but Python's
  random number generator and JavaScript's are different, so the same seed gives different clips in the two
  editions.

## Layout

```
index.html            the app
core.js               all the format logic, ported from the .py -- no DOM, no FFmpeg
app.js                UI, engine install/load, and the render pipeline
style.css
lib/ffmpeg/           vendored @ffmpeg/ffmpeg 0.12.10 (must be same-origin)
tests/gen_fixtures.py generates ground truth by running the .py's own functions
tests/fixtures.js     that ground truth
test_core.html        core.js vs. the Python original, plus the log parser and clip planner
test_pipeline.html    a real encode: install, probe, conform, cut, concat, verify the output
test_app.html         drives index.html in an iframe, including the multi-worker path and cancelling
test_profiles.html    a real file per codec profile, through the whole pipeline, profile checked on the way out
```

## Tests

Serve the folder and open the four test pages; each prints PASS/FAIL. `test_core.html` is instant; the other
three run real encodes and take a few minutes the first time.

| page | what it proves |
|---|---|
| `test_core.html` | the browser port makes the same decisions as the desktop tool |
| `test_pipeline.html` | install → probe → conform → cut → concat produces a correct file |
| `test_app.html` | the actual UI works, including two parallel encoders and cancelling mid-render |
| `test_profiles.html` | ProRes LT in really does mean ProRes LT out |

`test_core.html` is the interesting one: `tests/fixtures.js` is generated by importing
`random_compilation_maker.py` and calling its own `build_conform_filters`, `build_video_encode_args`,
`mismatch_reasons`, `build_target` and grouping functions over synthetic sources covering 70 codec / profile /
pixel-format / field-order combinations plus 8 conform targets. The browser then runs the JavaScript port over
the same inputs and requires byte-identical ffmpeg arguments, so the two editions cannot drift apart.
Regenerate with `python tests/gen_fixtures.py`.
