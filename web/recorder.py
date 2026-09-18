"""Drive the dual-source acceptance recorder from the dashboard.

The 录制 button on the debug page records a short clip of whatever the operator
is doing by hand: the physical rig from the camera on top, the live telemetry
scope underneath, both stamped with the same wall clock.  That work is done by
``dualrec.cjs`` (Playwright + ffmpeg), which is *not* part of this project -- it
is shared scratch tooling -- so this module only owns the awkward parts of
launching it from a request handler:

* one recording at a time, since two recorders would fight over the camera and
  the serial ports;
* a detached child, because the take outlives the HTTP request that asked for
  it (a request handler must not block for the length of a clip);
* a place to read progress from.  The recorder rewrites ``state.json`` inside
  its output folder as it moves through starting -> boards -> recording ->
  encoding -> done, and that file is the only interface between the two
  processes.  Scraping stdout would be fragile: the child is spawned through
  cmd/PowerShell on Windows, where a non-UTF-8 console codepage mangles the
  Chinese titles the recorder prints.

Paths are overridable by environment variable so the same code works if the
tooling moves; the defaults are where this machine keeps things.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import threading
import time
from pathlib import Path

WEB_DIR = Path(__file__).resolve().parent
PROJECT = WEB_DIR.parent
EVIDENCE = PROJECT / "evidence" / "recordings"

HOME = Path.home()
WORKSPACE = PROJECT.parent  # the WorkBuddy session folder holding .workbuddy

NODE = Path(os.environ.get("REC_NODE")
            or HOME / ".workbuddy" / "binaries" / "node" / "versions" / "22.22.2-3" / "node.exe")
NODE_MODULES = Path(os.environ.get("REC_NODE_MODULES")
                    or HOME / ".workbuddy" / "binaries" / "node" / "workspace" / "node_modules")
RECORDER = Path(os.environ.get("REC_DUALREC")
                or WORKSPACE / ".workbuddy" / "scratch" / "camera" / "dualrec.cjs")
CHROME = Path(os.environ.get("REC_CHROME")
              or HOME / "AppData" / "Local" / "ms-playwright" / "chromium-1223"
                 / "chrome-win64" / "chrome.exe")
FFMPEG = Path(os.environ.get("REC_FFMPEG")
              or HOME / "AppData" / "Local" / "ms-playwright" / "ffmpeg-1011"
                 / "ffmpeg-win64.exe")
CAM_SRV = os.environ.get("REC_CAM_SRV", "http://127.0.0.1:8791")
DEBUG_URL = os.environ.get("REC_DEBUG_URL", "")
# The recorder's own MJPEG feed, for watching a take while it runs.  The
# recorder owns the camera for the duration, so the dashboard's preview cannot
# see it -- this is how the operator keeps eyes on the rig.  8811 rather than
# 879x, which is where the loose camserve.py viewer instances live.
LIVE_PORT = int(os.environ.get("REC_LIVE_PORT", "8811"))

ALLOWED_SECONDS = (5, 10, 15, 30, 60)
MAX_SECONDS = 300
# A recording heartbeats once a second and an encode every 400 ms, so a phase
# that has written nothing for this long is stuck rather than slow.
IDLE_KILL_S = 75

_lock = threading.Lock()
_current: dict = {}
_history: list = []


def _why_unavailable() -> str:
    """Missing tooling is reported up front: a button that silently does
    nothing is worse than one that says which path is wrong."""
    missing = [str(p) for p in (NODE, RECORDER, CHROME, FFMPEG)
               if not Path(p).exists()]
    if not NODE_MODULES.exists():
        missing.append(str(NODE_MODULES))
    return ("缺少录制依赖：" + "、".join(missing)) if missing else ""


def _read_state(outdir: Path) -> dict:
    try:
        return json.loads((outdir / "state.json").read_text(encoding="utf-8"))
    except Exception:
        return {}


def _read_meta(outdir: Path) -> dict:
    try:
        return json.loads((outdir / "meta.json").read_text(encoding="utf-8"))
    except Exception:
        return {}


def _sweep_frames(outdir) -> None:
    """Best-effort delete of a finished take's intermediate JPEGs, off-thread.

    The recorder already asks a detached child to do this as soon as it
    publishes "done", because deleting a few hundred frames on Windows has
    twice wedged the recorder itself (once blocking the event loop so hard that
    the timeout meant to bound the delete never fired).  This is the net under
    that: a delete that wedged in the child, or a take recorded before the
    hand-off existed, would otherwise sit in evidence/ forever at ~220 KB per
    frame.  Runs in its own thread and ignores every failure -- a stray folder
    is a cosmetic problem, and blocking a status poll over it would not be.
    """
    try:
        frames = (Path(outdir) / "frames").resolve()
        # Refuse anything outside the evidence tree.  A blank outdir resolves to
        # the dashboard's working directory, and deleting a `frames` folder
        # found there is exactly the kind of accident this guard exists for.
        frames.relative_to(EVIDENCE.resolve())
    except Exception:
        return
    if not frames.is_dir():
        return

    def work():
        shutil.rmtree(frames, ignore_errors=True)

    try:
        threading.Thread(target=work, daemon=True).start()
    except Exception:
        pass


def _evidence_complete(outdir: Path) -> bool:
    """True once clip.webm and a successful meta.json are both on disk.

    meta.json is written after the mux, so `ffmpegExit == 0` next to a clip
    means the take is finished regardless of what the process is still doing.
    """
    return (outdir / "clip.webm").is_file() and _read_meta(outdir).get("ffmpegExit") == 0


def _reap(proc, why: str) -> None:
    """Kill a take's whole process tree.

    Only safe once the evidence is on disk, or when the take is visibly stuck --
    a process that is still capturing has not muxed anything yet, and killing it
    loses the entire clip.  ``/T`` matters: the browser the recorder launched is
    a child, and an orphaned browser keeps the camera open, after which every
    later take dies with "no camera available".
    """
    if proc is None:
        return
    try:
        if os.name == "nt":
            subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                           capture_output=True, timeout=15,
                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        else:
            proc.kill()
    except Exception:
        pass
    try:
        proc.wait(timeout=8)
    except Exception:
        pass


def _force_error(outdir: Path, message: str) -> None:
    """Record why a take was cut short, so the page can say something useful."""
    state = _read_state(outdir)
    state.update({"phase": "error", "error": message, "at": time.time() * 1000})
    try:
        (outdir / "state.json").write_text(
            json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception:
        pass


def _watchdog() -> None:
    """Cut loose a take that has stopped making progress.

    Called from every status poll.  Without it the only way back from a stuck
    take is a terminal: the slot stays busy, the process keeps the camera, and
    the operator is left looking at 正在编码 forever.
    """
    with _lock:
        current = dict(_current) if _current else None
    if not current:
        return
    proc = current.get("proc")
    if proc is None or proc.poll() is not None:
        return
    outdir = Path(current["outdir"])
    state = _read_state(outdir)
    if state.get("phase") not in ("recording", "encoding"):
        return
    try:
        quiet = time.time() - float(state.get("at") or 0) / 1000.0
    except (TypeError, ValueError):
        return
    if quiet < IDLE_KILL_S:
        return
    complete = _evidence_complete(outdir)
    _reap(proc, "stalled")
    _sweep_frames(outdir)
    if not complete:
        _force_error(outdir, f"录制进程 {IDLE_KILL_S:.0f} 秒没有进展，已强制收尾"
                             f"（超时前的产物保留在这个目录里）")


def _prune_history(keep: int = 8) -> None:
    while len(_history) > keep:
        _history.pop()


def start(seconds: int = 15, suite: str = "manual", ports=None,
          title: str | None = None) -> dict:
    """Kick off a take and return immediately.

    ``manual`` is the only suite that makes sense from the page: it never sends
    a motion command, so it cannot fight the hand that is turning the shaft.
    It is also run with ``--no-settle`` for the same reason -- the settle phase
    issues ``stop``, which would kill a live force-feedback session the operator
    had already armed.
    """
    reason = _why_unavailable()
    if reason:
        return {"ok": False, "error": reason}

    try:
        seconds = int(seconds)
    except (TypeError, ValueError):
        seconds = 15
    seconds = max(2, min(MAX_SECONDS, seconds))

    with _lock:
        proc = _current.get("proc")
        if proc is not None and proc.poll() is None:
            # A process that outlived its own take still holds the camera and
            # this slot, so reap it and carry on instead of refusing.  Anything
            # genuinely still capturing stays refused: killing it would lose the
            # clip, which has not been muxed yet.
            if _describe(_current).get("phase") in ("done", "error"):
                _reap(proc, "previous take finished")
                _sweep_frames(Path(_current.get("outdir", "")))
            else:
                return {"ok": False, "error": "已经有一段录制在进行中，等它结束再开始",
                        "outdir": str(_current.get("outdir", ""))}

        stamp = time.strftime("%Y%m%d-%H%M%S")
        outdir = EVIDENCE / f"{stamp}-{suite}"
        outdir.mkdir(parents=True, exist_ok=True)
        (outdir / "frames").mkdir(exist_ok=True)

        port_list = [str(p) for p in (ports or []) if p] or ["COM23", "COM4"]
        env = dict(os.environ)
        env.update({
            "NODE_PATH": str(NODE_MODULES),
            "CHROME_PATH": str(CHROME),
            "FFMPEG_PATH": str(FFMPEG),
            "CAM_SRV": CAM_SRV,
            "MOTOR_DEBUG_URL": DEBUG_URL or f"http://127.0.0.1:{os.environ.get('MOTOR_DEBUG_PORT', '8766')}",
            "REC_PORTS": ",".join(port_list),
            "REC_LIVE_PORT": str(LIVE_PORT),
        })
        argv = [str(NODE), str(RECORDER), str(outdir), suite,
                "--fps", "15", "--no-settle", "--max-s", str(seconds)]
        if title:
            argv += ["--title", title]

        log = (outdir / "recorder.log").open("wb")
        creationflags = 0
        if os.name == "nt":
            # No console window: the dashboard is usually the only window the
            # operator wants to see, and a stray cmd box on top of it reads as
            # the app misbehaving.
            creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        proc = subprocess.Popen(argv, cwd=str(RECORDER.parent), env=env,
                                stdout=log, stderr=subprocess.STDOUT,
                                stdin=subprocess.DEVNULL,
                                creationflags=creationflags)
        _current.clear()
        _current.update({"proc": proc, "outdir": outdir, "seconds": seconds,
                         "suite": suite, "ports": port_list,
                         "started_at": time.time()})
        _history.insert(0, {"outdir": str(outdir), "suite": suite,
                            "seconds": seconds, "at": stamp})
        _prune_history()
    return {"ok": True, "outdir": str(outdir), "seconds": seconds,
            "suite": suite, "ports": port_list}


def stop() -> dict:
    """End the take early.

    Deliberately the recorder's own STOP sentinel rather than a kill: the frames
    only become clip.webm after the capture loop finishes, so killing the
    process loses the whole take.
    """
    with _lock:
        outdir = _current.get("outdir")
        proc = _current.get("proc")
    if not outdir:
        return {"ok": False, "error": "当前没有录制"}
    try:
        (Path(outdir) / "STOP").write_text("stop requested from dashboard\n", encoding="ascii")
    except Exception as exc:
        return {"ok": False, "error": f"无法写入停止标记：{exc}"}
    return {"ok": True, "outdir": str(outdir),
            "note": "已请求收尾；录制端会在当前这一步结束后编码"}


def _describe(entry: dict) -> dict:
    outdir = Path(entry["outdir"])
    state = _read_state(outdir)
    proc = entry.get("proc")
    alive = proc is not None and proc.poll() is None
    # "starting" is honest only for a process that is still on its way up; a
    # process that has exited without a phase is a crashed start.
    phase = state.get("phase") or ("starting" if alive else "unknown")
    clip = outdir / "clip.webm"
    meta = _read_meta(outdir)

    # The evidence decides, not the process.  meta.json lands after the mux, so
    # an ffmpegExit of 0 beside a clip means the take is finished whatever the
    # process is still sitting in.  This is the recovery path for a tail that
    # hangs after a successful encode: 246 frames were muxed at 18:59:04 and the
    # dashboard was still reading 正在编码 five minutes later, with the camera
    # locked and the record button dead.
    recovered = False
    if phase != "done" and _evidence_complete(outdir):
        phase, recovered = "done", True

    # A process alive after its take finished is not "running" in any sense the
    # page cares about -- it holds the camera and the slot, nothing more.
    running = alive and phase not in ("done", "error")

    # A process that exited without reaching "done" died on the way -- a wrong
    # path, the camera being busy, boards not enumerating, or a kill during the
    # mux.  Say so instead of leaving the button stuck on "准备中", and do not
    # mistake a half-written clip.webm for a finished one: ffmpeg creates the
    # file at the start of the encode, so its mere existence means nothing.
    if not alive and phase != "done":
        if not (state.get("error") or meta.get("verdictError")):
            tail = ""
            try:
                tail = (outdir / "recorder.log").read_text(encoding="utf-8", errors="replace")
                tail = tail.strip().splitlines()[-1][:300] if tail.strip() else ""
            except Exception:
                pass
            state = {**state, "error": tail or "录制进程提前退出，未生成完整的 clip.webm"}
        phase = "error"

    remaining = state.get("remainingS")
    # The live feed only exists while the recorder does; offering the URL after
    # that would just leave the panel with a broken image.
    live_port = state.get("livePort") or LIVE_PORT
    live_url = (f"http://127.0.0.1:{live_port}/live"
                if alive and phase in ("starting", "boards", "recording") else None)
    info = {
        "outdir": str(outdir),
        "name": outdir.name,
        "suite": entry.get("suite") or state.get("suite") or "manual",
        "phase": phase,
        "running": running,
        "seconds": entry.get("seconds") or state.get("maxS"),
        # Before the take begins -- booting Chromium, waiting for 2/2 boards --
        # there is no honest number yet, so the page shows "准备中" rather than
        # a countdown that starts lying immediately.
        "remainingS": None if remaining is None else round(float(remaining), 1),
        "frames": state.get("frames") or meta.get("frames"),
        "fps": state.get("fps") or meta.get("effectiveFps"),
        "durationS": state.get("durationS") or meta.get("durationS"),
        "title": state.get("title") or meta.get("title"),
        "connection": state.get("connection") or meta.get("connection"),
        "error": state.get("error") or meta.get("verdictError"),
        "verdict": state.get("verdict") or meta.get("verdict"),
        # Encode progress, so "正在编码" becomes a number instead of a wait with
        # no end.  The values come from ffmpeg's own -progress output.
        "encoded": state.get("encoded"),
        "encodePct": state.get("encodePct"),
        "encodeS": state.get("encodeS"),
        "encodeMs": meta.get("encodeMs"),
        "liveUrl": live_url,
        "recovered": recovered,
        "clipReady": clip.is_file(),
        "clipUrl": (f"/api/record/clip?name={outdir.name}" if clip.is_file() else None),
    }
    return info


def status() -> dict:
    # Every poll is a chance to notice a take that has stopped making progress;
    # the page polls about once a second, which is fast enough.
    _watchdog()
    with _lock:
        current = dict(_current) if _current else None
    active = _describe(current) if current else None
    return {"available": not _why_unavailable(),
            "reason": _why_unavailable(),
            "allowedSeconds": list(ALLOWED_SECONDS),
            "livePort": LIVE_PORT,
            "active": active,
            "history": [_describe(e) for e in _history[:6]]}


def clip_path(name: str) -> Path | None:
    """Resolve a clip by folder name, refusing anything outside EVIDENCE."""
    if not name or "/" in name or "\\" in name or name.startswith("."):
        return None
    candidate = (EVIDENCE / name / "clip.webm").resolve()
    try:
        candidate.relative_to(EVIDENCE.resolve())
    except ValueError:
        return None
    return candidate if candidate.is_file() else None
